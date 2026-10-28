//! Owned monitoring and scheduled conversations. No work depends on a browser.
use crate::{
    agent_monitor,
    ai_transport::Cancel,
    board_value::{object, V},
    App,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/agent/alerts"),
    ("POST", "/api/agent/alerts/dismiss"),
    ("POST", "/api/agent/alerts/clear"),
    ("POST", "/api/agent/alerts/act"),
    ("GET", "/api/agent/reports"),
    ("POST", "/api/agent/reports/dismiss"),
];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(m, p)| method.as_str() == *m && path == *p)
}
struct State {
    monitor: agent_monitor::State,
}
pub struct Store {
    directory: PathBuf,
    state: Mutex<State>,
    cancel: Cancel,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    project_cache: Mutex<(V, V)>,
    jira_pending: Mutex<Option<V>>,
}
fn cancelled(cancel: &Cancel) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("Background work cancelled".into())
    } else {
        Ok(())
    }
}
fn converted(value: &impl serde::Serialize) -> Result<V, String> {
    V::parse(&serde_json::value::to_raw_value(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn interval(name: &str, default: u64) -> Duration {
    // The binary currently requires a private preview directory. These controls
    // allow isolated integration tests to exercise real background loops quickly.
    Duration::from_millis(
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
            .clamp(50, default),
    )
}
impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            state: Mutex::new(State {
                monitor: Default::default(),
            }),
            cancel: Cancel::default(),
            tasks: Mutex::new(vec![]),
            project_cache: Mutex::new((V::object(), V::object())),
            jira_pending: Mutex::new(None),
        }
    }
    fn load_reports(&self, state: &mut State) -> Result<(), String> {
        let path = self.directory.join("monitor-reports.json");
        if !crate::account_hub::safe_path(&self.directory, &path) {
            return Err("Invalid monitor report storage".into());
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let rows = match options.open(&path) {
            Ok(file) => {
                if !file
                    .metadata()
                    .map_err(|_| "Invalid monitor report storage")?
                    .is_file()
                {
                    return Err("Invalid monitor report storage".into());
                }
                let mut bytes = vec![];
                file.take(16 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Monitor report storage unavailable")?;
                if bytes.len() > 16 * 1024 * 1024 {
                    return Err("Monitor report storage exceeds limit".into());
                }
                let raw = serde_json::from_slice::<Box<serde_json::value::RawValue>>(&bytes)
                    .map_err(|_| "Invalid monitor report storage")?;
                V::parse(&raw).map_err(|_| "Invalid monitor report storage")?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => V::Array(vec![]),
            Err(_) => return Err("Monitor report storage unavailable".into()),
        };
        state.monitor.restore_reports(&rows)?;
        Ok(())
    }
    fn save_reports(&self, rows: &V) -> Result<(), String> {
        let path = self.directory.join("monitor-reports.json");
        if !crate::account_hub::safe_path(&self.directory, &path) {
            return Err("Invalid monitor report storage".into());
        }
        if rows.raw().get().len() > 16 * 1024 * 1024 {
            return Err("Monitor report storage exceeds limit".into());
        }
        let result = (|| -> std::io::Result<()> {
            let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
            file.write_all(rows.raw().get().as_bytes())?;
            file.as_file().sync_all()?;
            file.persist(&path).map_err(|e| e.error)?;
            Ok(())
        })();
        result.map_err(|_| "Monitor report storage unavailable".into())
    }
    pub fn finish_review(&self, report: V, events: &crate::events::Store) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        self.load_reports(&mut state)?;
        let before = state.monitor.all_reports();
        let entry = state
            .monitor
            .add_report(&report, crate::account_usage::now());
        if let Err(error) = self.save_reports(&state.monitor.all_reports()) {
            state.monitor.restore_reports(&before)?;
            return Err(error);
        }
        events.publish_raw("monitor:report", entry.raw().get());
        Ok(())
    }
    pub async fn handle(&self, app: Arc<App>, method: &Method, path: &str, input: &V) -> Response {
        if path == "/api/agent/alerts/act" {
            if !input["alertId"].truthy() || !input["convId"].truthy() || !input["prompt"].truthy()
            {
                return crate::error(400, "alertId, convId, prompt required");
            }
            self.state
                .lock()
                .unwrap()
                .monitor
                .dismiss_alert(&input["alertId"], crate::account_usage::now());
            let input = object([
                ("convId", input["convId"].clone()),
                ("message", input["prompt"].clone()),
            ]);
            return match tokio::task::spawn_blocking(move || {
                app.agent_runtime.start(app.clone(), &input)
            })
            .await
            {
                Ok(Ok(value)) => Json(value.raw()).into_response(),
                Ok(Err(e)) => crate::error(500, &e),
                Err(_) => crate::error(500, "Agent request failed"),
            };
        }
        let method = method.clone();
        let path = path.to_owned();
        let input = input.clone();
        tokio::task::spawn_blocking(move || app.background.request(&method, &path, &input))
            .await
            .unwrap_or_else(|_| crate::error(500, "Monitor request failed"))
    }
    fn request(&self, method: &Method, path: &str, input: &V) -> Response {
        let mut state = self.state.lock().unwrap();
        let value = match (method.as_str(), path) {
            ("GET", "/api/agent/alerts") => state.monitor.alerts(),
            ("POST", "/api/agent/alerts/dismiss") => {
                if !input["alertId"].truthy() {
                    return crate::error(400, "alertId required");
                }
                state
                    .monitor
                    .dismiss_alert(&input["alertId"], crate::account_usage::now())
            }
            ("POST", "/api/agent/alerts/clear") => state.monitor.clear_alerts(),
            ("GET", "/api/agent/reports") => {
                if let Err(e) = self.load_reports(&mut state) {
                    return crate::error(500, &e);
                }
                state.monitor.reports()
            }
            ("POST", "/api/agent/reports/dismiss") => {
                if !input["reportId"].truthy() {
                    return crate::error(400, "reportId required");
                }
                if let Err(e) = self.load_reports(&mut state) {
                    return crate::error(500, &e);
                }
                let before = state.monitor.all_reports();
                let result = state.monitor.dismiss_report(&input["reportId"]);
                if result["dismissed"].truthy() {
                    if let Err(e) = self.save_reports(&state.monitor.all_reports()) {
                        let _ = state.monitor.restore_reports(&before);
                        return crate::error(500, &e);
                    }
                }
                result
            }
            _ => return crate::error(404, "Not found"),
        };
        Json(value.raw()).into_response()
    }
    pub fn start(&self, app: Arc<App>) {
        if std::env::var("COCKPIT_PREVIEW_BACKGROUND_AGENTS").as_deref() == Ok("0") {
            return;
        }
        let mut tasks = self.tasks.lock().unwrap();
        if !tasks.is_empty() || self.cancel.is_cancelled() || app.closing.load(Ordering::Acquire) {
            return;
        }
        let monitor = app.clone();
        tasks.push(tokio::spawn(async move { monitor_loop(monitor).await }));
        // Slow remote CI requests must not postpone local Git observations.
        for ci in [false, true] {
            let projects = app.clone();
            tasks.push(tokio::spawn(
                async move { project_loop(projects, ci).await },
            ));
        }
        let jira = app.clone();
        tasks.push(tokio::spawn(async move { jira_loop(jira).await }));
        tasks.push(tokio::spawn(async move { schedule_loop(app).await }));
    }
    pub async fn shutdown(&self) {
        self.cancel.cancel();
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        let until = tokio::time::Instant::now() + Duration::from_secs(3);
        for mut task in tasks {
            if tokio::time::timeout_at(until, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
    }
}

async fn start_conversation(
    app: Arc<App>,
    prompt: V,
    agent: V,
    metadata: Option<V>,
    owner: Option<Cancel>,
) -> Result<V, String> {
    struct Admission(Cancel, bool);
    impl Drop for Admission {
        fn drop(&mut self) {
            if self.1 {
                self.0.cancel();
            }
        }
    }
    let mut admission = Admission(
        owner.as_ref().unwrap_or(&app.background.cancel).child(),
        true,
    );
    // Creating a conversation is itself a durable change. Gate before creating
    // it, and let the normal admission lock reject shutdown/duplicate starts.
    if app.closing.load(Ordering::Acquire) || app.background.cancel.is_cancelled() {
        return Err("Server is shutting down".into());
    }
    if app
        .ai_config
        .key()
        .map_err(|_| "AI configuration unavailable")?
        .is_none()
    {
        return Err("Gemini API key not configured".into());
    }
    let target = app.clone();
    let cancel = admission.0.clone();
    let created = tokio::task::spawn_blocking(move || target.agent.create_background(&cancel))
        .await
        .map_err(|_| "Conversation creation failed")?;
    let conversation = crate::agent_app::response(created).await?;
    let id = conversation["id"].clone();
    let input = object([
        ("convId", id.clone()),
        ("message", prompt),
        ("agentId", agent),
    ]);
    let cancel = admission.0.clone();
    let owned = owner.is_some();
    let started = tokio::task::spawn_blocking(move || {
        if owned {
            app.agent_runtime.start_owned(app.clone(), &input, cancel)
        } else {
            app.agent_runtime
                .start_with_report(app.clone(), &input, metadata, Some(cancel))
        }
    })
    .await
    .map_err(|_| "Agent start failed")?;
    started?;
    if owned {
        admission.1 = false;
    }
    Ok(id)
}
async fn monitor_loop(app: Arc<App>) {
    let cancel = &app.background.cancel;
    let first = interval("COCKPIT_PREVIEW_MONITOR_FIRST_MS", 10_000);
    let period = interval("COCKPIT_PREVIEW_MONITOR_INTERVAL_MS", 30_000);
    let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + first, period);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {biased;_=cancel.cancelled()=>break,_=timer.tick()=>{}}
        let mut snapshot = object([]);
        let projects = match app.projects.list() {
            Ok(rows) => match converted(&rows) {
                Ok(rows) => rows,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        snapshot["projects"] = projects.clone();
        snapshot["reviewReady"] = app.ai_config.key().ok().flatten().is_some().into();
        let mut terms = vec![];
        for row in app.terminals.active() {
            if let Ok(mut row) = converted(&row) {
                row["buffer"] = app
                    .terminals
                    .agent_buffer(&row["termId"].text())
                    .map(V::from)
                    .unwrap_or(V::Null);
                terms.push(row)
            }
        }
        snapshot["terminals"] = V::Array(terms);
        let (mut git, cicd) = app.background.project_cache.lock().unwrap().clone();
        for project in projects.array() {
            let id = project["id"].text();
            if !git.has(&id) {
                git[&id] = app.project_polling.cached(&id, "git");
            }
        }
        snapshot["git"] = git;
        snapshot["cicd"] = cicd;
        if let Some(jira) = app.background.jira_pending.lock().unwrap().take() {
            snapshot["jira"] = jira;
        }
        if cancel.is_cancelled() {
            break;
        }
        let cycle = app
            .background
            .state
            .lock()
            .unwrap()
            .monitor
            .scan(&snapshot, crate::account_usage::now());
        for (name, data) in cycle.events {
            app.events.publish_raw(&name, data.raw().get());
        }
        for review in cycle.reviews {
            if cancel.is_cancelled() {
                return;
            }
            if let Err(error) = start_conversation(
                app.clone(),
                review["prompt"].clone(),
                review["agentId"].clone(),
                Some(review["metadata"].clone()),
                None,
            )
            .await
            {
                app.events.publish_raw(
                    "monitor:review-error",
                    object([
                        ("agentId", review["agentId"].clone()),
                        ("error", error.into()),
                    ])
                    .raw()
                    .get(),
                );
            }
        }
    }
}
async fn project_loop(app: Arc<App>, ci: bool) {
    use futures_util::{stream, StreamExt};
    let cancel = &app.background.cancel;
    let mut timer = tokio::time::interval(interval("COCKPIT_PREVIEW_MONITOR_INTERVAL_MS", 30_000));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {biased;_=cancel.cancelled()=>break,_=timer.tick()=>{}}
        let Ok(projects) = app
            .projects
            .list()
            .and_then(|rows| serde_json::value::to_raw_value(&rows).map_err(std::io::Error::other))
        else {
            continue;
        };
        let Ok(projects) = V::parse(&projects) else {
            continue;
        };
        let ids = projects
            .array()
            .iter()
            .map(|p| p["id"].text())
            .collect::<std::collections::HashSet<_>>();
        {
            let mut cache = app.background.project_cache.lock().unwrap();
            let group = if ci { &mut cache.1 } else { &mut cache.0 };
            if let V::Object(rows) = group {
                rows.retain(|id, _| ids.contains(id));
            }
        }
        let work=stream::iter(projects.array().iter().cloned()).map(|project|{
            let app=app.clone();let cancel=cancel.clone();async move{
                let id=project["id"].text();
                let value = if ci {
                    if !project["github"].truthy(){
                        app.background.project_cache.lock().unwrap().1.remove(&id);
                        return
                    }
                    let id_path=url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>();
                    let query=std::collections::HashMap::from([("limit".into(),"10".into())]);
                    let response=app.cicd.handle_agent(&format!("/api/cicd/runs/{id_path}"),&query,V::object(),&app.projects,&cancel).await;
                    let Ok(value) = crate::agent_app::response(response).await else {return};
                    let runs = value.array().iter().map(|run| {
                        let mut run = run.clone();
                        for (target, source) in [("id","databaseId"),("head_branch","headBranch"),("html_url","url")] {
                            if !run.has(target) && run.has(source) { run[target] = run[source].clone(); }
                        }
                        run
                    }).collect();
                    object([("runs",V::Array(runs))])
                } else {
                    tokio::select!{biased;_=cancel.cancelled()=>return,value=app.git.status(&project)=>value}
                };
                // Results collected for a removed or edited project are stale.
                if cancel.is_cancelled() || crate::git::project(&app.projects,&id).as_ref()!=Some(&project){return}
                let mut cache=app.background.project_cache.lock().unwrap();
                let group=if ci {&mut cache.1} else {&mut cache.0};
                group[&id]=value;
            }
        }).buffer_unordered(4).collect::<Vec<_>>();
        tokio::select! {biased;_=cancel.cancelled()=>break,_=work=>{}}
    }
}
async fn jira_loop(app: Arc<App>) {
    let cancel = &app.background.cancel;
    let mut timer = tokio::time::interval(Duration::from_secs(120));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {biased;_=cancel.cancelled()=>break,_=timer.tick()=>{}}
        let Ok(config) = app.ai_config.jira() else {
            continue;
        };
        if !config["url"].truthy() || !config["email"].truthy() || !config["token"].truthy() {
            continue;
        }
        let child = cancel.child();
        let result = tokio::select! {biased;_=cancel.cancelled()=>return,result=crate::agent_service_jira::monitor_snapshot(&config,&child)=>result};
        child.cancel();
        if let Ok(value) = result {
            if !cancel.is_cancelled() {
                *app.background.jira_pending.lock().unwrap() = Some(value);
            }
        }
    }
}
async fn schedule_loop(app: Arc<App>) {
    let cancel = &app.background.cancel;
    let mut jobs = tokio::task::JoinSet::new();
    let mut pending = std::collections::VecDeque::<(V, i64)>::new();
    let mut timer = tokio::time::interval_at(
        tokio::time::Instant::now() + interval("COCKPIT_PREVIEW_AUTONOMY_FIRST_MS", 5_000),
        interval("COCKPIT_PREVIEW_AUTONOMY_INTERVAL_MS", 60_000),
    );
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _=cancel.cancelled()=>break,
            _=jobs.join_next(), if !jobs.is_empty()=>{},
            _=timer.tick()=>{
                // Keep the observed occurrence when all four execution slots are
                // occupied. A later minute must not erase a daily trigger.
                let now = crate::account_usage::now();
                if let Ok(rows) = app.autonomy_schedule.due(now) {
                    for row in rows {
                        if !pending.iter().any(|(old,_)| old["id"]==row["id"]) {
                            pending.push_back((row,now));
                        }
                    }
                }
            }
        }
        // Missing configuration must not consume a due occurrence or write empty history.
        while jobs.len() < 4
            && !cancel.is_cancelled()
            && app.ai_config.key().ok().flatten().is_some()
        {
            let Some((row, due_at)) = pending.pop_front() else {
                break;
            };
            let Ok(Some(lease)) =
                app.autonomy_schedule
                    .claim_occurrence(&row, due_at, crate::account_usage::now())
            else {
                continue;
            };
            let app = app.clone();
            let cancel = cancel.clone();
            jobs.spawn(async move {
                let _ = execute_schedule(app, &lease.schedule, &cancel).await;
                drop(lease);
            });
        }
    }
    while jobs.join_next().await.is_some() {}
}
pub async fn execute_schedule(app: Arc<App>, schedule: &V, cancel: &Cancel) -> Result<(), String> {
    let text = |key| {
        crate::agent_prompt::property_string(schedule, key).unwrap_or_else(|_| "undefined".into())
    };
    let id = text("id");
    let pattern = text("pattern");
    let prompt = text("prompt");
    let escape = |value: &V| {
        value
            .text()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let header = format!(
        "⏰ <b>자율 트리거</b>\n📋 {} · #{}\n🎯 {}",
        escape(&pattern),
        id.text(),
        escape(&prompt)
    );
    let _ = app
        .telegram
        .send_cancellable(
            header.into(),
            object([("parseMode", "HTML".into()), ("silent", true.into())]),
            cancel,
        )
        .await;
    cancelled(cancel)?;
    let hint = if schedule["project"].truthy() {
        format!("\n\n[프로젝트 hint] {}", text("project").text())
    } else {
        String::new()
    };
    let message = crate::agent_runtime::concat(&[
        "[자율 스케줄 실행 — pattern: ".into(),
        pattern,
        "]\n".into(),
        prompt,
        hint.into(),
    ]);
    let result =
        start_conversation(app.clone(), message, V::Null, None, Some(cancel.clone())).await;
    let conv_id = match result {
        Ok(id) => id,
        Err(error) => {
            let _ = app
                .telegram
                .send_cancellable(
                    format!("❌ 스케줄 #{} 실행 실패: {error}", id.text()).into(),
                    V::Null,
                    cancel,
                )
                .await;
            return Err(error);
        }
    };
    let until = tokio::time::Instant::now() + Duration::from_secs(300);
    let mut notified = false;
    while app.agent.is_running(&conv_id.text()) {
        tokio::select! {biased;_=cancel.cancelled()=>{
            // Keep the schedule lease until the owned conversation has stopped;
            // a new Telegram configuration must not overlap this occurrence.
            app.agent.stop(&conv_id.text());
            while app.agent.is_running(&conv_id.text()) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            return Err("Background work cancelled".into());
        },_=tokio::time::sleep_until(until), if !notified=>{
            let _=app.telegram.send_cancellable(format!("⌛ 스케줄 #{} 5분 초과. 백그라운드 진행 중일 수 있음.",id.text()).into(),V::Null,cancel).await;notified=true;
        },_=tokio::time::sleep(Duration::from_secs(1))=>{}}
    }
    let conversation = crate::agent_app::response(app.agent.handle(
        &Method::GET,
        &format!("/api/agent/conversations/{}", conv_id.text()),
        &V::Null,
    ))
    .await?;
    if let Some(message) = conversation["messages"]
        .array()
        .iter()
        .rev()
        .find(|m| m["role"] != V::from("user"))
    {
        let output = if message["content"].truthy() {
            message["content"].clone()
        } else if message["text"].truthy() {
            message["text"].clone()
        } else {
            "(빈 응답)".into()
        };
        let _ = app.telegram.send_cancellable(output, V::Null, cancel).await;
    }
    Ok(())
}
