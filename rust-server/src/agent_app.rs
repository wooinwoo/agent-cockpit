//! Application ownership and native service bindings for agent conversations.
use crate::{
    agent_context,
    agent_orchestration::Engine,
    agent_prompt,
    agent_runtime::{
        Backend, Events, ModelRequest, NativeBackend, Pending, SoloContext, Stream, ToolRequest,
    },
    agent_service_cockpit::{self, Services},
    ai_transport::Cancel,
    board_value::{object, V},
    App,
};
use axum::{body::to_bytes, http::Method, response::Response};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};

pub struct Store {
    notes: PathBuf,
    jobs: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    routing: crate::agent_routing::State,
    tools: Arc<crate::agent_tools::Store>,
}
fn parse(raw: &str) -> Result<V, String> {
    V::parse(&serde_json::value::RawValue::from_string(raw.into()).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn convert(value: &impl serde::Serialize) -> Result<V, String> {
    V::parse(&serde_json::value::to_raw_value(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn check(cancel: &Cancel) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("Agent request cancelled".into())
    } else {
        Ok(())
    }
}
struct CancelOnDrop(Cancel);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
pub(crate) async fn response(value: Response) -> Result<V, String> {
    let status = value.status();
    let body = to_bytes(value.into_body(), 8 * 1024 * 1024)
        .await
        .map_err(|e| e.to_string())?;
    let data = parse(std::str::from_utf8(&body).map_err(|e| e.to_string())?)?;
    if status.as_u16() == 404 {
        return Ok(V::Null);
    }
    if !status.is_success() {
        return Err(data["error"].text());
    }
    Ok(data)
}
fn projects(app: &App) -> Result<Vec<V>, String> {
    app.projects
        .list()
        .map_err(|e| e.to_string())?
        .iter()
        .map(convert)
        .collect()
}
fn path_id(id: &V) -> String {
    url::form_urlencoded::byte_serialize(id.text().as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
fn worktrees(app: &App, projects: &[V]) -> Vec<PathBuf> {
    projects
        .iter()
        .flat_map(|p| {
            app.project_polling.cached(&p["id"].text(), "git")["worktrees"]
                .array()
                .to_vec()
        })
        .filter_map(|t| {
            t["path"]
                .is_string()
                .then(|| PathBuf::from(t["path"].text()))
        })
        .collect()
}

impl Store {
    pub fn with_notes(
        directory: PathBuf,
        notes: PathBuf,
        events: Arc<crate::events::Store>,
        telegram: Arc<crate::telegram::Store>,
    ) -> Self {
        let mut tools = crate::agent_tools::Store::new(directory.clone(), vec![]);
        tools.events = Some(events);
        tools.telegram = Some(telegram);
        Self {
            notes,
            jobs: Mutex::new(vec![]),
            routing: crate::agent_routing::State::default(),
            tools: Arc::new(tools),
        }
    }
    pub fn start(&self, app: Arc<App>, input: &V) -> Result<V, String> {
        self.start_with_report(app, input, None, None)
    }
    pub fn start_with_report(
        &self,
        app: Arc<App>,
        input: &V,
        report: Option<V>,
        admission: Option<Cancel>,
    ) -> Result<V, String> {
        self.start_scoped(app, input, report, admission, None, None)
    }
    pub fn start_owned(&self, app: Arc<App>, input: &V, owner: Cancel) -> Result<V, String> {
        self.start_scoped(app, input, None, Some(owner.clone()), Some(owner), None)
    }
    pub fn start_owned_reply(
        &self,
        app: Arc<App>,
        input: &V,
        owner: Cancel,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<V, String>>, String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.start_scoped(
            app,
            input,
            None,
            Some(owner.clone()),
            Some(owner),
            Some(sender),
        )?;
        Ok(receiver)
    }
    fn start_scoped(
        &self,
        app: Arc<App>,
        input: &V,
        report: Option<V>,
        admission: Option<Cancel>,
        owner: Option<Cancel>,
        reply: Option<tokio::sync::oneshot::Sender<Result<V, String>>>,
    ) -> Result<V, String> {
        if let Some(cancel) = &admission {
            check(cancel)?;
        }
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(cancel) = &admission {
            check(cancel)?;
        }
        if app.closing.load(Ordering::Acquire) {
            return Err("Server is shutting down".into());
        }
        jobs.retain(|job| !job.is_finished());
        let id = agent_prompt::string(&input["convId"])?.text();
        let configured = app
            .ai_config
            .key()
            .map_err(|_| "AI configuration unavailable")?
            .is_some();
        let project = if input["projectId"].truthy() {
            projects(&app)?
                .into_iter()
                .find(|p| p["id"] == input["projectId"])
        } else {
            None
        };
        let run = app.agent.begin_cancellable(
            id.clone(),
            &input["message"],
            project.as_ref(),
            configured,
            admission.as_ref(),
        )?;
        if let Some(cancel) = &admission {
            check(cancel)?;
        }
        let target = input["agentId"].clone();
        if let Some(metadata) = &report {
            let mut event = metadata.clone();
            event["convId"] = id.clone().into();
            event["agentId"] = target.clone();
            app.events
                .publish_raw("monitor:review-start", event.raw().get());
        }
        jobs.push(tokio::spawn(async move {
            let backend = Native { app: &app };
            let context = |p: &V| app.agent_runtime.context(&app, p);
            let events = app.events.clone();
            let captured = Arc::new(Mutex::new((V::Null, false)));
            let capture = captured.clone();
            let conv_id = id.clone();
            let token = run.cancel.clone();
            let emit: Events = Arc::new(move |name, data| {
                if name == "agent:response" && data["convId"] == V::from(conv_id.clone()) {
                    *capture.lock().unwrap() = (data.clone(), token.is_cancelled());
                }
                events.publish_raw(name, data.raw().get());
            });
            let engine = Engine {
                backend: &backend,
                context: &context,
                events: emit,
                routing: &app.agent_runtime.routing,
                user_name: run.user_name.clone(),
            };
            let run_cancel = run.cancel.clone();
            let result = {
                let work = engine.run(run, &target);
                tokio::pin!(work);
                if let Some(owner) = owner {
                    tokio::select! { biased;
                        _ = owner.cancelled() => { run_cancel.cancel(); work.await },
                        result = &mut work => result,
                    }
                } else {
                    work.await
                }
            };
            if let Some(reply) = reply {
                let content = captured.lock().unwrap().0["content"].clone();
                let _ = reply.send(result.clone().map(|()| content));
            }
            if let Some(mut report) = report {
                let (response, stopped) = captured.lock().unwrap().clone();
                report["convId"] = id.into();
                report["agentId"] = target;
                report["content"] = response["content"].clone();
                report["status"] = if stopped {
                    "stopped"
                } else if result.is_err() || !response["content"].truthy() {
                    "error"
                } else {
                    "done"
                }
                .into();
                if let Err(error) = result {
                    report["error"] = error.into();
                }
                let app = app.clone();
                let failure_events = app.events.clone();
                let saved = tokio::task::spawn_blocking(move || {
                    app.background.finish_review(report, &app.events)
                })
                .await;
                if !matches!(saved, Ok(Ok(()))) {
                    failure_events.publish_raw(
                        "monitor:report-error",
                        object([("error", "Monitor report persistence failed".into())])
                            .raw()
                            .get(),
                    );
                }
            }
        }));
        Ok(object([("status", "started".into())]))
    }
    pub async fn shutdown(&self, agent: &crate::agent::Store) {
        let jobs = {
            let mut jobs = self.jobs.lock().unwrap();
            agent.cancel_all();
            std::mem::take(&mut *jobs)
        };
        let until = tokio::time::Instant::now() + Duration::from_secs(5);
        for mut job in jobs {
            if tokio::time::timeout_at(until, &mut job).await.is_err() {
                job.abort();
                let _ = job.await;
            }
        }
    }
    fn context(&self, app: &App, profile: &V) -> Result<SoloContext, String> {
        let rows = projects(app)?;
        let roots: Vec<_> = rows.iter().map(|p| p["path"].clone()).collect();
        let branches = rows
            .iter()
            .map(|p| app.project_polling.cached(&p["id"].text(), "git")["branch"].clone())
            .collect();
        let notes_dir = self.notes.clone();
        let notes = match fs::read_dir(&notes_dir) {
            Ok(entries) => {
                let mut files = entries
                    .filter_map(Result::ok)
                    .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
                    .collect::<Vec<_>>();
                files.sort_by_key(|e| e.file_name());
                let files = files
                    .into_iter()
                    .take(20)
                    .map(|e| {
                        let mut row =
                            object([("name", e.file_name().to_string_lossy().into_owned().into())]);
                        if crate::account_hub::safe_path(&notes_dir, &e.path())
                            && e.file_type().is_ok_and(|t| t.is_file())
                        {
                            if let Ok(text) = fs::read_to_string(e.path()) {
                                if let Ok(note) = parse(&text) {
                                    row["note"] = note;
                                }
                            }
                        }
                        row
                    })
                    .collect();
                object([("files", V::Array(files))])
            }
            Err(_) => object([("error", true.into())]),
        };
        let snapshot = object([
            ("projects", V::Array(rows.clone())),
            ("serviceProjects", V::Array(rows)),
            ("roots", V::Array(roots.clone())),
            ("branches", V::Array(branches)),
            ("notes", notes),
            ("cost", app.project_polling.cached("", "cost")),
        ]);
        Ok(SoloContext {
            profile: profile.clone(),
            roots,
            project: agent_context::project(&snapshot)?,
            team: agent_context::team(profile, &snapshot)?,
            platform: if std::env::var_os("WSL_DISTRO_NAME").is_some() {
                "wsl"
            } else {
                std::env::consts::OS
            }
            .into(),
            claude_available: true,
        })
    }
}
struct Native<'a> {
    app: &'a Arc<App>,
}
impl Backend for Native<'_> {
    fn model<'a>(
        &'a self,
        request: ModelRequest,
        cancel: &'a Cancel,
        stream: Stream,
    ) -> Pending<'a, V> {
        Box::pin(async move {
            let backend = NativeBackend {
                api_key: self
                    .app
                    .ai_config
                    .key()
                    .map_err(|_| "AI configuration unavailable")?
                    .ok_or("Gemini API key not configured")?,
                tools: self.app.agent_runtime.tools.clone(),
            };
            backend.model(request, cancel, stream).await
        })
    }
    fn tool<'a>(&'a self, request: ToolRequest, cancel: &'a Cancel) -> Pending<'a, V> {
        Box::pin(async move {
            check(cancel)?;
            if request.kind == "COCKPIT" {
                // The dispatcher lowercases/trims the command; classify that same
                // operation so uppercase or leading spaces cannot bypass approval.
                let command = request
                    .argument
                    .trim()
                    .text()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split(':')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_lowercase();
                if let Some(risk) = crate::agent_tools::classify_risk("COCKPIT", &command) {
                    let approved = tokio::select! {biased; _=cancel.cancelled()=>return Err("Agent request cancelled".into()),value=self.app.telegram.request_approval(risk.label.clone(),format!("COCKPIT:{}",request.argument.text()),risk.hard)=>value?};
                    if !approved {
                        return Ok(format!(
                            "Error: 사용자가 거부했거나 60초 안에 응답이 없었습니다. ({})",
                            risk.label
                        )
                        .into());
                    }
                }
                check(cancel)?;
                return agent_service_cockpit::execute(
                    &request.argument,
                    self,
                    cancel,
                    crate::account_usage::now(),
                )
                .await;
            }
            match request.kind.as_str() {
                "JIRA" => {
                    crate::agent_service_jira::execute(
                        &request.argument,
                        &self
                            .app
                            .ai_config
                            .jira()
                            .map_err(|_| "Jira configuration unavailable")?,
                        cancel,
                    )
                    .await
                }
                "CICD" => {
                    crate::agent_service_external::cicd(
                        &request.argument,
                        &self.app.cicd,
                        &self.app.projects,
                        cancel,
                    )
                    .await
                }
                "WEATHER" => {
                    crate::agent_service_external::weather(&request.argument, cancel).await
                }
                _ => {
                    let rows = projects(self.app)?;
                    let scope = self.app.agent_runtime.tools.scoped(
                        rows.iter()
                            .map(|p| PathBuf::from(p["path"].text()))
                            .collect(),
                        worktrees(self.app, &rows),
                    );
                    scope
                        .execute_core(
                            &request.kind,
                            &request.argument,
                            crate::agent_tools::Context {
                                sprint_mode: request.sprint_mode,
                            },
                            cancel,
                        )
                        .await
                        .unwrap_or_else(|| Err(format!("Unknown agent tool: {}", request.kind)))
                }
            }
        })
    }
}
impl Services for Native<'_> {
    fn call<'a>(
        &'a self,
        op: &'a str,
        param: &'a V,
        input: &'a V,
        cancel: &'a Cancel,
    ) -> Pending<'a, V> {
        Box::pin(async move {
            check(cancel)?;
            let app = self.app;
            match op {
                "usage" => {
                    let cached = app.project_polling.cached("", "cost");
                    Ok(if cached.truthy() {
                        cached
                    } else {
                        app.costs.compute()
                    })
                }
                "projects" => Ok(V::Array(projects(app)?)),
                "project" => {
                    let p = projects(app)?
                        .into_iter()
                        .find(|p| p["id"] == *param)
                        .unwrap_or(V::Null);
                    let id = param.text();
                    Ok(object([
                        ("project", p),
                        ("session", app.project_polling.cached(&id, "session")),
                        ("git", app.project_polling.cached(&id, "git")),
                        ("prs", app.project_polling.cached(&id, "prs")),
                        ("cicd", app.project_polling.cached(&id, "cicd")),
                    ]))
                }
                "prs" => {
                    let mut all = vec![];
                    for p in projects(app)? {
                        if param.truthy() && p["id"] != *param {
                            continue;
                        }
                        for mut pr in app.project_polling.cached(&p["id"].text(), "prs")["prs"]
                            .array()
                            .to_vec()
                        {
                            pr["project"] = p["name"].clone();
                            all.push(pr);
                        }
                    }
                    Ok(V::Array(all))
                }
                "sessions" => Ok(V::Array(
                    projects(app)?
                        .iter()
                        .map(|p| {
                            object([
                                ("name", p["name"].clone()),
                                (
                                    "session",
                                    app.project_polling.cached(&p["id"].text(), "session"),
                                ),
                            ])
                        })
                        .collect(),
                )),
                "notes" => Ok(response(app.notes.handle(
                    Method::GET,
                    "/api/notes",
                    Default::default(),
                ))
                .await?["notes"]
                    .clone()),
                "note" | "note-create" | "note-update" => {
                    let create = op == "note-create";
                    let path = if create {
                        "/api/notes".into()
                    } else {
                        format!("/api/notes/{}", param.text())
                    };
                    let data = if op == "note" {
                        Default::default()
                    } else {
                        serde_json::from_str(input.raw().get())
                            .map_err(|e| format!("Invalid note input: {e}"))?
                    };
                    let method = if create {
                        Method::POST
                    } else if op == "note-update" {
                        Method::PUT
                    } else {
                        Method::GET
                    };
                    let token = cancel.child();
                    let _guard = CancelOnDrop(token.clone());
                    let app = app.clone();
                    let mut job = tokio::task::spawn_blocking(move || {
                        app.notes.handle_agent(method, &path, data, &token)
                    });
                    let value = tokio::select! {biased; _=cancel.cancelled()=>return Err("Agent request cancelled".into()),value=&mut job=>value.map_err(|_| "Note request failed")?};
                    response(value).await
                }
                "briefing" | "alerts" => {
                    response(app.briefing.handle(
                        &Method::GET,
                        if op == "briefing" {
                            "/api/briefing"
                        } else {
                            "/api/alerts"
                        },
                        V::Null,
                        &app.projects,
                        &app.project_polling,
                    ))
                    .await
                }
                "activity" => {
                    let value = app.project_polling.cached("", "activity");
                    Ok(if value.is_array() {
                        value
                    } else {
                        value["activities"].clone()
                    })
                }
                "system" => crate::agent_monitor_stats::collect(cancel).await,
                "workflows" | "workflow" | "workflow-runs" | "workflow-run" => {
                    let path = match op {
                        "workflows" => "/api/workflows".into(),
                        "workflow" => format!("/api/workflows/{}", path_id(param)),
                        "workflow-runs" => "/api/workflows/runs".into(),
                        _ => format!("/api/workflows/runs/{}", path_id(param)),
                    };
                    let mut result =
                        response(app.workflows.handle(&Method::GET, &path, &V::Null).await).await?;
                    fn aliases(v: &mut V) {
                        if v.has("runId") && !v.has("id") {
                            v["id"] = v["runId"].clone();
                        }
                        if v.has("endedAt") && !v.has("finishedAt") {
                            v["finishedAt"] = v["endedAt"].clone();
                        }
                    }
                    if op == "workflow-runs" {
                        for row in result.array_mut() {
                            aliases(row);
                        }
                    } else if op == "workflow-run" && result.truthy() {
                        aliases(&mut result);
                    }
                    Ok(result)
                }
                "workflow-start" => {
                    let id = app
                        .workflows
                        .start_agent(&param.text(), input.clone(), cancel)
                        .await?;
                    app.events.publish_raw(
                        "agent:service-accepted",
                        object([("operation", op.into()), ("id", id.clone().into())])
                            .raw()
                            .get(),
                    );
                    Ok(object([("id", id.into()), ("status", "running".into())]))
                }
                "terminals" => Ok(object([
                    ("terminals", convert(&app.terminals.active())?),
                    ("projects", V::Array(projects(app)?)),
                ])),
                "terminal-read" => Ok(app
                    .terminals
                    .agent_buffer(&param.text())
                    .map(V::from)
                    .unwrap_or(V::Null)),
                "terminal-input" => {
                    if !app.terminals.has_id(&param.text()) {
                        return Ok(V::Null);
                    }
                    app.terminals
                        .service_input(&param.text(), input.text(), cancel)
                        .await?;
                    app.events.publish_raw(
                        "agent:service-accepted",
                        object([("operation", op.into()), ("id", param.clone())])
                            .raw()
                            .get(),
                    );
                    tokio::select! {biased;_=cancel.cancelled()=>return Err("Agent request cancelled after terminal input was delivered".into()),_=tokio::time::sleep(Duration::from_millis(1500))=>{}}
                    Ok(app
                        .terminals
                        .agent_buffer(&param.text())
                        .unwrap_or_default()
                        .into())
                }
                "terminal-create" => {
                    let message =
                        serde_json::json!({"projectId":param.text(),"command":input.text()});
                    let id = app
                        .terminals
                        .create_agent(app.clone(), &message, cancel)
                        .await
                        .map_err(|e| e.to_string())?;
                    app.events.publish_raw(
                        "agent:service-accepted",
                        object([("operation", op.into()), ("id", id.clone().into())])
                            .raw()
                            .get(),
                    );
                    tokio::select! {biased;_=cancel.cancelled()=>return Err(format!("Agent request cancelled after creating terminal {id}")),_=tokio::time::sleep(Duration::from_millis(2000))=>{}}
                    Ok(object([
                        ("id", id.clone().into()),
                        (
                            "output",
                            app.terminals.agent_buffer(&id).unwrap_or_default().into(),
                        ),
                    ]))
                }
                "git-commit" | "git-push" => {
                    let p = projects(app)?
                        .into_iter()
                        .find(|p| p["id"] == *param)
                        .ok_or("Project not found")?;
                    let project = &p;
                    let run = |args: Vec<String>| async move {
                        crate::project_command::run_owned(
                            project,
                            "git",
                            &args,
                            Duration::from_secs(20),
                            1024 * 1024,
                            cancel,
                        )
                        .await
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                    };
                    if op == "git-commit" {
                        tokio::select! {biased;_=cancel.cancelled()=>return Err("Agent request cancelled".into()),result=run(vec!["add".into(),"-A".into()])=>{result?;}}
                        check(cancel)?;
                    }
                    let args = if op == "git-commit" {
                        vec![
                            "commit".into(),
                            "-m".into(),
                            if input.trim().truthy() {
                                input.trim().text()
                            } else {
                                format!(
                                    "auto-commit by agent at {}",
                                    crate::account_usage::iso(crate::account_usage::now())
                                        .chars()
                                        .take(19)
                                        .collect::<String>()
                                )
                            },
                        ]
                    } else {
                        vec!["push".into()]
                    };
                    tokio::select! {biased;_=cancel.cancelled()=>Err("Agent request cancelled; verify Git state before retrying".into()),result=run(args)=>result.map(V::from)}
                }
                _ => Err(format!("Unknown Cockpit service operation: {op}")),
            }
        })
    }
}
