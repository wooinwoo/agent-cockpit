use crate::{
    ai_config,
    ai_transport::{self, Cancel, ClaudeOptions, GeminiOptions},
    board_value::{object, V},
    events,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    io::{self, Read, Write},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/workflows"),
    ("GET", "/api/workflows/:id"),
    ("GET", "/api/workflows/runs"),
    ("GET", "/api/workflows/runs/:id"),
    ("POST", "/api/workflows/run"),
    ("POST", "/api/workflows/runs/:id/stop"),
];
fn run_path(path: &str) -> Option<(&str, bool)> {
    let tail = path.strip_prefix("/api/workflows/runs/")?;
    let (id, stop) = tail
        .strip_suffix("/stop")
        .map(|id| (id, true))
        .unwrap_or((tail, false));
    (!id.is_empty() && !id.contains('/')).then_some((id, stop))
}
fn definition_path(path: &str) -> Option<&str> {
    path.strip_prefix("/api/workflows/").filter(|id| {
        !id.is_empty() && !id.contains('/') && !matches!(*id, "runs" | "run" | "schedules")
    })
}
pub fn route(method: &Method, path: &str) -> bool {
    (*method == Method::GET
        && (matches!(path, "/api/workflows" | "/api/workflows/runs")
            || definition_path(path).is_some()
            || run_path(path).is_some_and(|(_, stop)| !stop)))
        || (*method == Method::POST
            && (path == "/api/workflows/run" || run_path(path).is_some_and(|(_, stop)| stop)))
}
fn now() -> V {
    (crate::account_usage::now() as f64).into()
}
fn or(value: &V, fallback: V) -> V {
    if value.truthy() {
        value.clone()
    } else {
        fallback
    }
}
fn project(value: &V, keys: &[&str]) -> V {
    let mut result = V::object();
    for key in keys {
        if value.has(key) {
            result[key] = value[key].clone();
        }
    }
    result
}
fn parse(bytes: Vec<u8>) -> io::Result<V> {
    let raw = serde_json::value::RawValue::from_string(
        String::from_utf8(bytes).map_err(io::Error::other)?,
    )
    .map_err(io::Error::other)?;
    V::parse(&raw).map_err(io::Error::other)
}
fn checked_read(root: &Path, path: &Path) -> io::Result<Option<Vec<u8>>> {
    if !crate::account_hub::safe_path(root, path) {
        return Err(io::Error::other("Unsafe workflow storage path"));
    }
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Ok(meta) if meta.is_file() => {}
        _ => return Err(io::Error::other("Invalid workflow storage file")),
    }
    fs::read(path).map(Some)
}
struct Job {
    cancel: Cancel,
    done: AtomicBool,
    finished: Notify,
}
impl Job {
    async fn wait(&self) {
        loop {
            let notified = self.finished.notified();
            if self.done.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}
struct State {
    loaded: bool,
    runs: Vec<V>,
    jobs: HashMap<String, Arc<Job>>,
    closing: bool,
}
pub struct Store {
    root: PathBuf,
    directory: PathBuf,
    events: Arc<events::Store>,
    ai: Arc<ai_config::Store>,
    state: Mutex<State>,
}
struct Finished {
    store: Arc<Store>,
    id: String,
    job: Arc<Job>,
}
impl Drop for Finished {
    fn drop(&mut self) {
        self.job.done.store(true, Ordering::Release);
        self.job.finished.notify_waiters();
        self.store.state.lock().unwrap().jobs.remove(&self.id);
    }
}
impl Store {
    pub fn new(
        root: PathBuf,
        directory: PathBuf,
        events: Arc<events::Store>,
        ai_config: Arc<ai_config::Store>,
    ) -> Arc<Self> {
        Arc::new(Self {
            root,
            directory,
            events,
            ai: ai_config,
            state: Mutex::new(State {
                loaded: false,
                runs: vec![],
                jobs: HashMap::new(),
                closing: false,
            }),
        })
    }
    fn definition(&self, id: &str) -> Option<V> {
        if id.is_empty()
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        {
            return None;
        }
        checked_read(
            &self.root,
            &self.root.join("workflows").join(format!("{id}.json")),
        )
        .ok()
        .flatten()
        .and_then(|bytes| parse(bytes).ok())
    }
    fn definitions(&self) -> io::Result<V> {
        let directory = self.root.join("workflows");
        if !crate::account_hub::safe_path(&self.root, &directory) {
            return Err(io::Error::other("Unsafe workflow definition path"));
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(V::Array(vec![])),
            Err(e) => return Err(e),
        };
        let mut files = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .collect::<Vec<_>>();
        files.sort();
        let mut rows = vec![];
        for path in files {
            let Some(def) = checked_read(&self.root, &path)
                .ok()
                .flatten()
                .and_then(|v| parse(v).ok())
            else {
                continue;
            };
            if !matches!(def, V::Object(_)) || (def["steps"].truthy() && !def["steps"].is_array()) {
                continue;
            }
            let mut row = project(&def, &["id", "name", "description"]);
            row["inputs"] = or(&def["inputs"], V::Array(vec![]));
            row["stepCount"] = (def["steps"].array().len() as f64).into();
            row["maxIterations"] = or(&def["maxIterations"], 0.0.into());
            row["hasCycles"] = def["edges"]
                .array()
                .iter()
                .any(|edge| edge["condition"].truthy())
                .into();
            let mut models = vec![];
            for step in def["steps"].array() {
                if step["provider"].truthy() && step["model"].truthy() {
                    let name: V =
                        format!("{}:{}", step["provider"].text(), step["model"].text()).into();
                    if !models.contains(&name) {
                        models.push(name);
                    }
                }
            }
            row["models"] = V::Array(models);
            rows.push(row);
        }
        Ok(V::Array(rows))
    }
    fn disk_runs(&self) -> io::Result<Vec<V>> {
        let Some(bytes) =
            checked_read(&self.directory, &self.directory.join("workflow-runs.json"))?
        else {
            return Ok(vec![]);
        };
        let value = parse(bytes)?;
        if !value.is_array()
            || value
                .array()
                .iter()
                .any(|run| !run["runId"].is_string() || !run["steps"].is_array())
        {
            return Err(io::Error::other("Invalid workflow run history"));
        }
        Ok(value.array().to_vec())
    }
    fn load(&self, state: &mut State) -> Result<(), String> {
        if !state.loaded {
            state.runs = self
                .disk_runs()
                .map_err(|_| "Workflow run history unavailable; saved data preserved")?;
            for run in &mut state.runs {
                run.remove("_abort");
                if run["status"] == V::from("running") {
                    run["status"] = "error".into();
                }
            }
            state.loaded = true;
        }
        Ok(())
    }
    fn persist(&self, runs: &[V]) -> Result<(), String> {
        let write = || -> io::Result<()> {
            self.disk_runs()?;
            // Include active runs as restart evidence. Never silently rerun them.
            let mut terminal = runs
                .iter()
                .filter(|r| r["status"] != V::from("running"))
                .cloned()
                .collect::<Vec<_>>();
            terminal.sort_by(|a, b| b["startedAt"].number().total_cmp(&a["startedAt"].number()));
            terminal.truncate(50);
            let mut rows = runs
                .iter()
                .filter(|r| r["status"] == V::from("running"))
                .cloned()
                .collect::<Vec<_>>();
            rows.extend(terminal);
            let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
            file.write_all(V::Array(rows).raw().get().as_bytes())?;
            file.as_file().sync_all()?;
            file.persist(self.directory.join("workflow-runs.json"))
                .map_err(|e| e.error)?;
            Ok(())
        };
        write().map_err(|_| "Workflow run persistence failed; saved data preserved".into())
    }
    fn change(
        &self,
        id: &str,
        update: impl FnOnce(&mut V) -> Result<(), String>,
    ) -> Result<V, String> {
        let mut state = self.state.lock().unwrap();
        self.load(&mut state)?;
        let mut rows = state.runs.clone();
        let run = rows
            .iter_mut()
            .find(|r| r["runId"] == V::from(id))
            .ok_or("Run not found")?;
        update(run)?;
        let result = run.clone();
        self.persist(&rows)?;
        state.runs = rows;
        Ok(result)
    }
    fn publish(&self, event: &str, data: V) {
        self.events.publish_raw(event, data.raw().get());
    }
    pub async fn start(self: &Arc<Self>, workflow_id: &str, inputs: V) -> Result<String, String> {
        self.start_owned(workflow_id, inputs, None)
    }
    pub async fn start_agent(
        self: &Arc<Self>,
        workflow_id: &str,
        inputs: V,
        cancel: &Cancel,
    ) -> Result<String, String> {
        struct CancelOnDrop(Cancel);
        impl Drop for CancelOnDrop {
            fn drop(&mut self) {
                self.0.cancel();
            }
        }
        let token = cancel.child();
        let _guard = CancelOnDrop(token.clone());
        let store = self.clone();
        let id = workflow_id.to_owned();
        let mut job =
            tokio::task::spawn_blocking(move || store.start_owned(&id, inputs, Some(&token)));
        tokio::select! {biased; _=cancel.cancelled()=>Err("Agent request cancelled".into()),result=&mut job=>result.map_err(|_| "Workflow start failed")?}
    }
    fn start_owned(
        self: &Arc<Self>,
        workflow_id: &str,
        inputs: V,
        cancel: Option<&Cancel>,
    ) -> Result<String, String> {
        let check = || {
            if cancel.is_some_and(|cancel| cancel.is_cancelled()) {
                Err("Agent request cancelled".to_string())
            } else {
                Ok(())
            }
        };
        check()?;
        let def = self
            .definition(workflow_id)
            .ok_or_else(|| format!("Workflow not found: {workflow_id}"))?;
        if !def["steps"].is_array() {
            return Err("Workflow steps must be an array".into());
        }
        let mut state = self.state.lock().unwrap();
        check()?;
        self.load(&mut state)?;
        if state.closing {
            return Err("Server is shutting down".into());
        }
        let id = loop {
            let id = rand::random::<[u8; 8]>()
                .iter()
                .map(|v| format!("{v:02x}"))
                .collect::<String>();
            if !state.runs.iter().any(|r| r["runId"] == V::from(id.clone())) {
                break id;
            }
        };
        let mut run = object([
            ("runId", id.clone().into()),
            ("workflowId", workflow_id.into()),
            ("status", "running".into()),
            ("startedAt", now()),
            ("endedAt", V::Null),
            ("inputs", or(&inputs, V::object())),
            ("error", V::Null),
        ]);
        if def.has("name") {
            run["workflowName"] = def["name"].clone();
        }
        run["steps"] = V::Array(
            def["steps"]
                .array()
                .iter()
                .map(|step| {
                    let mut row = project(step, &["id", "name", "type"]);
                    for (key, value) in [
                        ("role", or(&step["role"], "".into())),
                        ("provider", or(&step["provider"], "claude".into())),
                        ("model", or(&step["model"], "auto".into())),
                        ("status", "pending".into()),
                        ("iterations", 0.0.into()),
                        ("startedAt", V::Null),
                        ("endedAt", V::Null),
                        ("output", V::Null),
                        ("error", V::Null),
                    ] {
                        row[key] = value;
                    }
                    row
                })
                .collect(),
        );
        let mut rows = state.runs.clone();
        rows.push(run.clone());
        check()?;
        self.persist(&rows)?;
        let job = Arc::new(Job {
            cancel: Cancel::default(),
            done: AtomicBool::new(false),
            finished: Notify::new(),
        });
        state.runs = rows;
        state.jobs.insert(id.clone(), job.clone());
        drop(state);
        self.publish(
            "workflow:update",
            project(&run, &["runId", "status", "workflowId", "workflowName"]),
        );
        let store = self.clone();
        let run_id = id.clone();
        tokio::spawn(async move {
            let _finished = Finished {
                store: store.clone(),
                id: run_id.clone(),
                job: job.clone(),
            };
            let result = store
                .clone()
                .execute(&run_id, &def, &run["inputs"], job.clone())
                .await;
            let event = match &result {
                Ok(_) => "workflow:complete",
                Err(_) => "workflow:error",
            };
            let finished = store.change(&run_id, |run| {
                if run["status"] == V::from("stopped") {
                    return Ok(());
                }
                run["status"] = if result.is_ok() { "done" } else { "error" }.into();
                run["endedAt"] = now();
                if let Err(error) = &result {
                    run["error"] = error.clone().into();
                }
                Ok(())
            });
            match finished {
                Ok(run) if run["status"] != V::from("stopped") => store.publish(
                    event,
                    project(
                        &run,
                        if result.is_ok() {
                            &["runId", "status", "endedAt"]
                        } else {
                            &["runId", "error", "endedAt"]
                        },
                    ),
                ),
                Err(error) => {
                    store.publish(
                        "workflow:error",
                        object([
                            ("runId", run_id.clone().into()),
                            ("error", error.clone().into()),
                            ("endedAt", now()),
                        ]),
                    );
                    let mut state = store.state.lock().unwrap();
                    if let Some(run) = state
                        .runs
                        .iter_mut()
                        .find(|r| r["runId"] == V::from(run_id.clone()))
                    {
                        run["status"] = "error".into();
                        run["error"] = error.into();
                        run["endedAt"] = now();
                    }
                }
                _ => {}
            }
        });
        Ok(id)
    }
    fn stop(&self, id: &str) -> Result<bool, String> {
        let mut state = self.state.lock().unwrap();
        self.load(&mut state)?;
        let Some(index) = state
            .runs
            .iter()
            .position(|r| r["runId"] == V::from(id) && r["status"] == V::from("running"))
        else {
            return Ok(false);
        };
        if let Some(job) = state.jobs.get(id) {
            job.cancel.cancel();
        }
        let mut rows = state.runs.clone();
        rows[index]["status"] = "stopped".into();
        rows[index]["endedAt"] = now();
        let run = rows[index].clone();
        self.persist(&rows)?;
        state.runs = rows;
        drop(state);
        self.publish(
            "workflow:update",
            project(&run, &["runId", "status", "endedAt"]),
        );
        Ok(true)
    }
    pub async fn shutdown(&self) {
        let jobs = {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            state
                .jobs
                .iter()
                .map(|(id, job)| (id.clone(), job.clone()))
                .collect::<Vec<_>>()
        };
        for (id, job) in &jobs {
            job.cancel.cancel();
            let _ = self.stop(id);
        }
        for (_, job) in jobs {
            job.wait().await;
        }
    }
    pub async fn handle(self: &Arc<Self>, method: &Method, path: &str, input: &V) -> Response {
        if *method == Method::GET && path == "/api/workflows" {
            return match self.definitions() {
                Ok(value) => Json(value.raw()).into_response(),
                Err(_) => crate::error(500, "Workflow definitions unavailable"),
            };
        }
        if *method == Method::GET {
            if let Some(id) = definition_path(path) {
                return self
                    .definition(id)
                    .map(|value| Json(value.raw()).into_response())
                    .unwrap_or_else(|| crate::error(404, "Not found"));
            }
        }
        if *method == Method::POST && path == "/api/workflows/run" {
            if !input["workflowId"].truthy() {
                return crate::error(400, "workflowId required");
            }
            if !input["workflowId"].is_string() {
                return crate::error(
                    500,
                    &format!("Workflow not found: {}", input["workflowId"].text()),
                );
            }
            return match self
                .start(&input["workflowId"].text(), input["inputs"].clone())
                .await
            {
                Ok(id) => (
                    axum::http::StatusCode::ACCEPTED,
                    Json(object([("runId", id.into())]).raw()),
                )
                    .into_response(),
                Err(error) => crate::error(500, &error),
            };
        }
        if let Some((id, true)) = run_path(path) {
            if *method == Method::POST {
                return match self.stop(id) {
                    Ok(stopped) => {
                        // Returning success is the cancellation boundary: no
                        // owned node or final persistence may continue afterward.
                        let job = self.state.lock().unwrap().jobs.get(id).cloned();
                        if let Some(job) = job {
                            job.wait().await;
                        }
                        Json(object([("stopped", stopped.into())]).raw()).into_response()
                    }
                    Err(error) => crate::error(500, &error),
                };
            }
        }
        let mut state = self.state.lock().unwrap();
        if let Err(error) = self.load(&mut state) {
            return crate::error(500, &error);
        }
        if *method == Method::GET && path == "/api/workflows/runs" {
            let mut runs = state
                .runs
                .iter()
                .map(|r| {
                    project(
                        r,
                        &[
                            "runId",
                            "workflowId",
                            "workflowName",
                            "status",
                            "startedAt",
                            "endedAt",
                            "error",
                        ],
                    )
                })
                .collect::<Vec<_>>();
            runs.sort_by(|a, b| b["startedAt"].number().total_cmp(&a["startedAt"].number()));
            runs.truncate(50);
            return Json(V::Array(runs).raw()).into_response();
        }
        if let Some((id, false)) = run_path(path) {
            if *method == Method::GET {
                if let Some(run) = state.runs.iter().find(|r| r["runId"] == V::from(id)) {
                    return Json(
                        project(
                            run,
                            &[
                                "runId",
                                "workflowId",
                                "workflowName",
                                "status",
                                "startedAt",
                                "endedAt",
                                "inputs",
                                "steps",
                                "error",
                            ],
                        )
                        .raw(),
                    )
                    .into_response();
                }
            }
        }
        crate::error(404, "Not found")
    }
}

fn resolve(template: &V, context: &V) -> V {
    if !template.is_string() {
        return or(template, "".into());
    }
    let units = template.units();
    let mut result = vec![];
    let mut index = 0;
    while index < units.len() {
        if units.get(index..index + 2) == Some(&[123, 123]) {
            let start = index + 2;
            let mut end = start;
            while end < units.len()
                && (matches!(units[end], 48..=57 | 65..=90 | 97..=122) || units[end] == 95)
            {
                end += 1;
            }
            if end > start && units.get(end..end + 2) == Some(&[125, 125]) {
                let key = String::from_utf16_lossy(&units[start..end]);
                if context.has(&key) {
                    let value = &context[&key];
                    if value.is_string() {
                        result.extend(value.units());
                    } else {
                        result.extend(value.text().encode_utf16());
                    }
                }
                index = end + 2;
                continue;
            }
        }
        result.push(units[index]);
        index += 1;
    }
    V::String(result)
}
fn context(state: &V, inputs: &V) -> V {
    let mut plain = inputs.object_clone();
    if let V::Object(fields) = state {
        for (key, value) in fields {
            if key != "_lastOutput" && value.truthy() {
                plain[key] = value.clone();
            }
        }
    }
    plain
}
async fn matches_pattern(pattern: &V, value: &V) -> Result<bool, String> {
    crate::workflow_regex::is_match(pattern, value).await
}
fn targets(value: &V) -> Vec<String> {
    if value.is_array() {
        value.array().iter().map(V::text).collect()
    } else {
        vec![value.text()]
    }
}
async fn condition(step: &V, ctx: &V, legacy: bool) -> bool {
    let pattern = resolve(
        &or(&step["pattern"], or(&step["expression"], "".into())),
        ctx,
    );
    let target = or(&step["target"], "_lastOutput".into());
    let target = if legacy {
        target.text()
    } else {
        resolve(&target, ctx).text()
    };
    matches_pattern(&pattern, &or(&ctx[&target], "".into()))
        .await
        .unwrap_or(false)
}
impl Store {
    async fn outgoing(
        &self,
        run_id: &str,
        def: &V,
        from: &str,
        state: &V,
        inputs: &V,
        cycles: &mut [usize],
    ) -> Result<Vec<String>, String> {
        let mut out = vec![];
        for (index, edge) in def["edges"].array().iter().enumerate() {
            if !targets(&edge["from"]).iter().any(|id| id == from) {
                continue;
            }
            if edge["condition"].truthy() {
                cycles[index] += 1;
                let max = or(&def["maxIterations"], 5.0.into());
                let pass = if cycles[index] as f64 > max.number() {
                    self.publish(
                        "workflow:update",
                        object([
                            ("runId", run_id.into()),
                            (
                                "info",
                                format!("Max iterations ({}) reached, forcing pass", max.text())
                                    .into(),
                            ),
                        ]),
                    );
                    true
                } else {
                    let matched =
                        matches_pattern(&edge["condition"]["pattern"], &state["_lastOutput"])
                            .await?;
                    self.publish(
                        "workflow:update",
                        object([
                            ("runId", run_id.into()),
                            (
                                "routing",
                                object([
                                    ("from", edge["from"].clone()),
                                    ("matched", matched.into()),
                                    ("iteration", (cycles[index] as f64).into()),
                                    ("maxIterations", max),
                                ]),
                            ),
                        ]),
                    );
                    matched
                };
                out.extend(targets(
                    &edge["condition"][if pass { "true" } else { "false" }],
                ));
            } else if edge["branches"].truthy() {
                let step = def["steps"]
                    .array()
                    .iter()
                    .find(|step| step["id"].text() == from)
                    .ok_or("Conditional source node not found")?;
                let branch = if condition(step, &context(state, inputs), true).await {
                    "true"
                } else {
                    "false"
                };
                if !edge["branches"].has(branch) {
                    return Err("Branch did not return a valid destination".into());
                }
                out.extend(targets(&edge["branches"][branch]));
            } else {
                out.extend(targets(&edge["to"]));
            }
        }
        Ok(out)
    }
    async fn execute(
        self: Arc<Self>,
        run_id: &str,
        def: &V,
        inputs: &V,
        job: Arc<Job>,
    ) -> Result<(), String> {
        if !def["edges"].is_array() {
            return Err("Workflow edges must be an array".into());
        }
        let mut ids = HashSet::new();
        let mut state = object([("_lastOutput", "".into())]);
        for step in def["steps"].array() {
            if !step["id"].is_string() || !ids.insert(step["id"].text()) {
                return Err("Invalid or duplicate workflow node".into());
            }
            if step["outputKey"].truthy() {
                state[&step["outputKey"].text()] = "".into();
            }
        }
        let mut entry = false;
        for edge in def["edges"].array() {
            for from in targets(&edge["from"]) {
                if from == "START" {
                    entry = true;
                } else if !ids.contains(&from) {
                    return Err(format!("Found edge starting at unknown node n_{from}"));
                }
            }
            let destinations = if edge["condition"].truthy() {
                if !edge["condition"]["pattern"].is_string() {
                    return Err("Unsafe regex pattern detected".into());
                }
                matches_pattern(&edge["condition"]["pattern"], &"".into()).await?;
                let mut to = targets(&edge["condition"]["true"]);
                to.extend(targets(&edge["condition"]["false"]));
                to
            } else if let V::Object(branches) = &edge["branches"] {
                branches.values().flat_map(targets).collect()
            } else {
                targets(&edge["to"])
            };
            for to in destinations {
                if to != "END" && !ids.contains(&to) {
                    return Err(format!("Found edge ending at unknown node n_{to}"));
                }
            }
        }
        if !entry {
            return Err(
                "Graph must have an entrypoint: add at least one edge from START to another node"
                    .into(),
            );
        }
        let mut cycles = vec![0; def["edges"].array().len()];
        let mut active = self
            .outgoing(run_id, def, "START", &state, inputs, &mut cycles)
            .await?;
        for round in 0..=25 {
            active.retain(|id| id != "END");
            active.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            active.dedup();
            if active.is_empty() {
                return Ok(());
            }
            if job.cancel.is_cancelled() {
                return Err("Run stopped".into());
            }
            if round == 25 {
                return Err("Recursion limit of 25 reached without hitting a stop condition. You can increase the limit by setting the `recursionLimit` config key.".into());
            }
            let mut tasks = tokio::task::JoinSet::new();
            for id in &active {
                let step = def["steps"]
                    .array()
                    .iter()
                    .find(|step| step["id"].text() == *id)
                    .unwrap()
                    .clone();
                let store = self.clone();
                let run_id = run_id.to_owned();
                let ctx = context(&state, inputs);
                let job = job.clone();
                tasks.spawn(async move {
                    let result = store.run_step(&run_id, &step, &ctx, &job.cancel).await;
                    (step, result)
                });
            }
            let mut results = vec![];
            let mut failure = None;
            while let Some(result) = tasks.join_next().await {
                match result {
                    Ok((step, Ok(output))) => results.push((step, output)),
                    Ok((_, Err(error))) => {
                        if failure.is_none() {
                            failure = Some(error);
                            job.cancel.cancel();
                        }
                    }
                    Err(_) => {
                        failure.get_or_insert("Workflow node task interrupted".into());
                        job.cancel.cancel();
                    }
                }
            }
            if let Some(error) = failure {
                return Err(error);
            }
            results.sort_by(|(a, _), (b, _)| a["id"].units().cmp(b["id"].units()));
            let mut next = BTreeSet::new();
            let previous = state.clone();
            for (step, output) in results {
                let mut local = previous.clone();
                local["_lastOutput"] = output.clone();
                if step["outputKey"].truthy() {
                    local[&step["outputKey"].text()] = output.clone();
                    state[&step["outputKey"].text()] = output.clone();
                }
                state["_lastOutput"] = output;
                next.extend(
                    self.outgoing(run_id, def, &step["id"].text(), &local, inputs, &mut cycles)
                        .await?,
                );
            }
            active = next.into_iter().collect();
        }
        unreachable!()
    }
    async fn run_step(
        &self,
        run_id: &str,
        step: &V,
        ctx: &V,
        cancel: &Cancel,
    ) -> Result<V, String> {
        if cancel.is_cancelled() {
            return Err("Run stopped".into());
        }
        let run = self.change(run_id, |run| {
            if run["status"] != V::from("running") {
                return Err("Run stopped".into());
            }
            let row = run["steps"]
                .array_mut()
                .iter_mut()
                .find(|row| row["id"] == step["id"])
                .ok_or("Node not found")?;
            row["status"] = "running".into();
            row["iterations"] = (row["iterations"].number() + 1.0).into();
            row["startedAt"] = now();
            row["output"] = V::Null;
            row["error"] = V::Null;
            Ok(())
        })?;
        let row = run["steps"]
            .array()
            .iter()
            .find(|row| row["id"] == step["id"])
            .unwrap();
        let mut event = project(row, &["status", "startedAt", "role", "provider", "model"]);
        event["iteration"] = row["iterations"].clone();
        event["stepId"] = step["id"].clone();
        event["runId"] = run_id.into();
        self.publish("workflow:update", event);
        let result = match step["type"].text().as_str() {
            "condition" => Ok(V::from(if condition(step, ctx, false).await {
                "true"
            } else {
                "false"
            })),
            "shell" => shell(step, ctx, cancel.clone()).await.map(V::from),
            "http" => http(step, ctx, cancel).await.map(V::from),
            "llm" => self.llm(step, ctx, cancel).await.map(V::from),
            kind => Err(format!("Unknown node type: {kind}")),
        };
        let run = self.change(run_id, |run| {
            let row = run["steps"]
                .array_mut()
                .iter_mut()
                .find(|row| row["id"] == step["id"])
                .ok_or("Node not found")?;
            row["endedAt"] = now();
            match &result {
                Ok(output) => {
                    row["status"] = "done".into();
                    row["output"] = output.clone();
                }
                Err(error) => {
                    row["status"] = "error".into();
                    row["error"] = error.clone().into();
                }
            }
            Ok(())
        })?;
        let row = run["steps"]
            .array()
            .iter()
            .find(|row| row["id"] == step["id"])
            .unwrap();
        let mut event = project(row, &["status", "error", "endedAt"]);
        event["runId"] = run_id.into();
        event["stepId"] = step["id"].clone();
        event["iteration"] = row["iterations"].clone();
        event["output"] = or(&row["output"], "".into()).cut(2000);
        self.publish("workflow:update", event);
        result
    }
    async fn llm(&self, step: &V, ctx: &V, cancel: &Cancel) -> Result<String, String> {
        let provider = resolve(&or(&step["provider"], "claude".into()), ctx).text();
        let model = resolve(&or(&step["model"], "auto".into()), ctx).text();
        let raw = resolve(&step["prompt"], ctx).text();
        let role = resolve(&or(&step["role"], "".into()), ctx).text();
        let prompt = if role.is_empty() {
            raw
        } else {
            format!("[System Instructions]\n{role}\n\n[Task]\n{raw}")
        };
        if provider == "gemini" {
            let key = self
                .ai
                .key()
                .map_err(|_| "AI configuration storage operation failed")?
                .ok_or("Gemini API key not configured. Settings에서 API 키를 입력하세요.")?;
            let options = GeminiOptions {
                model: if model == "auto" {
                    "gemini-2.0-flash".into()
                } else {
                    model
                },
                stream: false,
                max_tokens: or(&step["maxTokens"], 4096.0.into())
                    .number()
                    .clamp(1.0, u32::MAX as f64) as u32,
                google_search: step["tools"].array().contains(&V::from("WebSearch")),
                ..Default::default()
            };
            ai_transport::gemini(&key, &prompt, &options, cancel, |_| {}).await
        } else {
            let options = ClaudeOptions {
                model: if model == "auto" {
                    "sonnet".into()
                } else {
                    model
                },
                timeout: timeout(step, 120_000),
                ..Default::default()
            };
            ai_transport::claude(&prompt, &options, cancel, |_| {}).await
        }
    }
}

fn timeout(step: &V, fallback: u64) -> Duration {
    Duration::from_millis(
        or(&step["timeout"], (fallback as f64).into())
            .number()
            .clamp(1.0, 86_400_000.0) as u64,
    )
}
fn allowed_shell(command: &str) -> bool {
    if command.chars().any(|c| {
        matches!(
            c,
            '`' | '$' | ';' | '|' | '&' | '<' | '>' | '\n' | '\r' | '\0'
        )
    }) {
        return false;
    }
    matches!(
        command
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "ls" | "dir"
            | "cat"
            | "type"
            | "head"
            | "tail"
            | "wc"
            | "find"
            | "grep"
            | "rg"
            | "git"
            | "npm"
            | "node"
            | "python"
            | "python3"
            | "pip"
            | "docker"
            | "make"
            | "echo"
            | "pwd"
            | "date"
            | "which"
            | "where"
            | "file"
            | "stat"
            | "du"
            | "df"
    )
}
struct Owned(Child, bool);
impl Drop for Owned {
    fn drop(&mut self) {
        if self.1 {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
async fn shell(step: &V, ctx: &V, cancel: Cancel) -> Result<String, String> {
    let command = resolve(&step["command"], ctx);
    if !command.is_string() || !allowed_shell(&command.text()) {
        return Err(format!(
            "Blocked shell command (not in whitelist): {}",
            command.cut(80).text()
        ));
    }
    let cwd = step["cwd"]
        .truthy()
        .then(|| resolve(&step["cwd"], ctx).text());
    let limit = timeout(step, 30_000);
    let command = command.text();
    tokio::task::spawn_blocking(move || shell_owned(&command, cwd.as_deref(), limit, &cancel))
        .await
        .map_err(|_| "Shell worker interrupted".to_owned())?
}
fn shell_owned(
    command: &str,
    cwd: Option<&str>,
    limit: Duration,
    cancel: &Cancel,
) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (command, cwd, limit, cancel);
        return Err("Owned workflow shell processes require Linux".into());
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        if cancel.is_cancelled() {
            return Err("Run stopped".into());
        }
        let mut process = Command::new("sh");
        process.args(["-c", command]);
        if let Some(cwd) = cwd {
            process.current_dir(cwd);
        }
        process
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = Owned(
            process
                .spawn()
                .map_err(|error| format!("Shell spawn failed: {error}"))?,
            true,
        );
        let stdout = child.0.stdout.take().unwrap();
        let stderr = child.0.stderr.take().unwrap();
        let exceeded = Arc::new(AtomicBool::new(false));
        let read = |reader: Box<dyn Read + Send>, exceeded: Arc<AtomicBool>| {
            std::thread::spawn(move || {
                let mut bytes = vec![];
                let result = reader.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes);
                if bytes.len() > 2 * 1024 * 1024 {
                    exceeded.store(true, Ordering::Release);
                }
                result.map(|_| bytes)
            })
        };
        let out = read(Box::new(stdout), exceeded.clone());
        let err = read(Box::new(stderr), exceeded.clone());
        let started = Instant::now();
        let result = loop {
            if cancel.is_cancelled() {
                break Err("Run stopped".to_owned());
            }
            if started.elapsed() >= limit {
                break Err("Shell command timed out".to_owned());
            }
            if exceeded.load(Ordering::Acquire) {
                break Err("Shell output exceeded limit".to_owned());
            }
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    child.0.id(),
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            } != 0
            {
                break Err("Shell wait failed".to_owned());
            }
            if unsafe { info.si_pid() } != 0 {
                break Ok(());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        // The unreaped group leader reserves the PGID until every owned group
        // member has been signalled, including descendants after shell exit.
        unsafe {
            libc::kill(-(child.0.id() as i32), libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(50));
        unsafe {
            libc::kill(-(child.0.id() as i32), libc::SIGKILL);
        }
        let status = child.0.wait().map_err(|e| e.to_string())?;
        child.1 = false;
        // Do not signal a group again after reaping its identity.
        let out = out
            .join()
            .map_err(|_| "Shell stdout reader interrupted")?
            .map_err(|e| e.to_string())?;
        let err = err
            .join()
            .map_err(|_| "Shell stderr reader interrupted")?
            .map_err(|e| e.to_string())?;
        result?;
        if out.len() > 2 * 1024 * 1024 || err.len() > 2 * 1024 * 1024 {
            return Err("Shell output exceeded limit".into());
        }
        let mut combined = String::from_utf8_lossy(&out).into_owned();
        combined.push_str(&String::from_utf8_lossy(&err));
        if !status.success() && combined.is_empty() {
            return Err(format!("Command failed: sh -c {command}"));
        }
        Ok(V::from(combined).trim().text())
    }
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && !ip.is_unspecified()
                && a != 0
                && a < 240
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0 && matches!(c, 0 | 2))
                && !(a == 192 && b == 88 && c == 99)
                && !(a == 198 && matches!(b, 18 | 19))
                && !(a == 198 && b == 51 && c == 100)
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(ip));
            }
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !matches!(s[0], 0x2002 | 0x3fff)
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
        }
    }
}
async fn http(step: &V, ctx: &V, cancel: &Cancel) -> Result<String, String> {
    let raw = resolve(&step["url"], ctx).text();
    let blocked = || {
        format!(
            "Blocked URL (private/internal): {}",
            V::from(raw.clone()).cut(120).text()
        )
    };
    let mut url = reqwest::Url::parse(&raw).map_err(|_| blocked())?;
    let mut method =
        reqwest::Method::from_bytes(or(&step["method"], "GET".into()).text().as_bytes())
            .map_err(|_| "Invalid HTTP method")?;
    let mut body = step["body"]
        .truthy()
        .then(|| resolve(&step["body"], ctx).text());
    let mut headers = reqwest::header::HeaderMap::new();
    if let V::Object(fields) = &step["headers"] {
        for (name, value) in fields {
            let key = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "Invalid HTTP header")?;
            if matches!(
                key.as_str(),
                "host" | "proxy-authorization" | "proxy-connection"
            ) {
                return Err("Blocked HTTP routing header".into());
            }
            headers.insert(
                key,
                reqwest::header::HeaderValue::from_str(&resolve(value, ctx).text())
                    .map_err(|_| "Invalid HTTP header")?,
            );
        }
    }
    let operation = async {
        for redirect in 0..=20 {
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(blocked());
            }
            let host = url
                .host_str()
                .ok_or_else(blocked)?
                .trim_matches(['[', ']'])
                .to_owned();
            let port = url.port_or_known_default().ok_or_else(blocked)?;
            let mock = if url.scheme() == "http"
                && host == "workflow-fixture.invalid"
                && url.port().is_none()
            {
                match std::env::var("COCKPIT_PREVIEW_WORKFLOW_HTTP_BASE") {
                    Ok(value) => {
                        let base = reqwest::Url::parse(&value)
                            .map_err(|_| "Invalid private workflow HTTP endpoint")?;
                        if base.scheme() != "http"
                            || !base
                                .host_str()
                                .and_then(|h| h.trim_matches(['[', ']']).parse::<IpAddr>().ok())
                                .is_some_and(|ip| ip.is_loopback())
                            || !base.username().is_empty()
                            || base.password().is_some()
                            || base.path() != "/"
                            || base.query().is_some()
                            || base.fragment().is_some()
                        {
                            return Err("Invalid private workflow HTTP endpoint".into());
                        }
                        Some(base)
                    }
                    Err(std::env::VarError::NotPresent) => None,
                    Err(_) => return Err("Invalid private workflow HTTP endpoint".into()),
                }
            } else {
                None
            };
            let mut builder = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none());
            let request_url = if let Some(mut base) = mock {
                base.set_path(url.path());
                base.set_query(url.query());
                base
            } else {
                let addresses: Vec<SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
                    vec![SocketAddr::new(ip, port)]
                } else {
                    tokio::net::lookup_host((host.as_str(), port))
                        .await
                        .map_err(|_| "HTTP DNS lookup failed")?
                        .collect()
                };
                if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
                    return Err(blocked());
                }
                builder = builder.resolve_to_addrs(&host, &addresses);
                url.clone()
            };
            let client = builder.build().map_err(|_| "HTTP client failed")?;
            if matches!(method, reqwest::Method::GET | reqwest::Method::HEAD) && body.is_some() {
                return Err("Request with GET/HEAD method cannot have body".into());
            }
            let mut request = client
                .request(method.clone(), request_url)
                .headers(headers.clone());
            if let Some(body) = &body {
                request = request.body(body.clone());
            }
            let mut response = request.send().await.map_err(|_| "HTTP request failed")?;
            if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                if let Some(location) = response.headers().get(reqwest::header::LOCATION) {
                    if redirect == 20 {
                        return Err("HTTP redirect limit exceeded".into());
                    }
                    let next = url
                        .join(location.to_str().map_err(|_| "Invalid HTTP redirect")?)
                        .map_err(|_| "Invalid HTTP redirect")?;
                    if next.origin() != url.origin() {
                        headers.remove(reqwest::header::AUTHORIZATION);
                        headers.remove(reqwest::header::COOKIE);
                    }
                    if response.status().as_u16() == 303 && method != reqwest::Method::HEAD
                        || matches!(response.status().as_u16(), 301 | 302)
                            && method == reqwest::Method::POST
                    {
                        method = reqwest::Method::GET;
                        body = None;
                        headers.remove(reqwest::header::CONTENT_TYPE);
                        headers.remove(reqwest::header::CONTENT_LENGTH);
                    }
                    url = next;
                    continue;
                }
            }
            let mut bytes = vec![];
            while let Some(chunk) = response.chunk().await.map_err(|_| "HTTP response failed")? {
                if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
                    return Err("HTTP response exceeded output limit".into());
                }
                bytes.extend(chunk);
            }
            return Ok(String::from_utf8_lossy(&bytes).into_owned());
        }
        Err("HTTP redirect limit exceeded".into())
    };
    tokio::select! { biased; _ = cancel.cancelled() => Err("Run stopped".into()), result = tokio::time::timeout(timeout(step,15_000), operation) => result.unwrap_or_else(|_| Err("HTTP request timed out".into())) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_agent_start_waiting_for_state_does_not_persist_or_spawn() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("workflows")).unwrap();
        fs::write(
            directory.path().join("workflows/empty.json"),
            r#"{"id":"empty","steps":[]}"#,
        )
        .unwrap();
        let store = Store::new(
            directory.path().into(),
            directory.path().into(),
            events::Store::new(),
            Arc::new(ai_config::Store::new(directory.path().into())),
        );
        let lock = store.state.lock().unwrap();
        let cancel = Cancel::default();
        let mut pending = Box::pin(store.start_agent("empty", V::object(), &cancel));
        assert!(futures_util::poll!(&mut pending).is_pending());
        cancel.cancel();
        assert!(tokio::time::timeout(Duration::from_secs(1), &mut pending)
            .await
            .unwrap()
            .is_err());
        drop(pending);
        drop(lock);
        // Join the blocking pool before checking that the abandoned waiter stayed inert.
        tokio::task::spawn_blocking({
            let store = store.clone();
            move || {
                let _lock = store.state.lock().unwrap();
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(!directory.path().join("workflow-runs.json").exists());
        assert!(store.state.lock().unwrap().jobs.is_empty());
    }
    fn value(json: serde_json::Value) -> V {
        parse(serde_json::to_vec(&json).unwrap()).unwrap()
    }
    async fn terminal(store: &Arc<Store>, id: &str) -> V {
        let job = store.state.lock().unwrap().jobs.get(id).cloned();
        if let Some(job) = job {
            tokio::time::timeout(Duration::from_secs(5), job.wait())
                .await
                .unwrap();
        }
        store
            .state
            .lock()
            .unwrap()
            .runs
            .iter()
            .find(|r| r["runId"] == V::from(id))
            .unwrap()
            .clone()
    }
    #[tokio::test]
    async fn parallel_snapshot_merge_cycles_and_durable_restore() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("workflows")).unwrap();
        let events = events::Store::new();
        let ai = Arc::new(ai_config::Store::new(directory.path().into()));
        let store = Store::new(
            directory.path().into(),
            directory.path().into(),
            events.clone(),
            ai.clone(),
        );
        let parallel = serde_json::json!({"id":"parallel","name":"Private graph","steps":[
            {"id":"b","type":"condition","target":"text","pattern":"no","outputKey":"b"},
            {"id":"a","type":"condition","target":"text","pattern":"^ok$","outputKey":"a"},
            {"id":"join","type":"condition","target":"expected","pattern":"^{{a}}/{{b}}$","outputKey":"joined"}
        ],"edges":[{"from":"START","to":["b","a"]},{"from":["a","b"],"to":"join"},{"from":"join","to":"END"}]});
        fs::write(
            directory.path().join("workflows/parallel.json"),
            serde_json::to_vec(&parallel).unwrap(),
        )
        .unwrap();
        let id = store
            .start(
                "parallel",
                value(serde_json::json!({"text":"ok","expected":"true/false"})),
            )
            .await
            .unwrap();
        let run = terminal(&store, &id).await;
        assert_eq!(run["status"], V::from("done"));
        assert_eq!(run["steps"].array()[2]["output"], V::from("true"));
        assert!(run["steps"]
            .array()
            .iter()
            .all(|s| s["iterations"] == V::Number(1.0)));
        let cycle = serde_json::json!({"id":"cycle","name":"Private cycle","maxIterations":2,"steps":[{"id":"again","type":"condition","pattern":"x"}],"edges":[{"from":"START","to":"again"},{"from":"again","condition":{"pattern":"true","true":"END","false":"again"}}]});
        fs::write(
            directory.path().join("workflows/cycle.json"),
            serde_json::to_vec(&cycle).unwrap(),
        )
        .unwrap();
        let id = store.start("cycle", V::object()).await.unwrap();
        let run = terminal(&store, &id).await;
        assert_eq!(run["status"], V::from("done"));
        assert_eq!(run["steps"].array()[0]["iterations"], V::Number(3.0));
        let restored = Store::new(directory.path().into(), directory.path().into(), events, ai);
        {
            let mut state = restored.state.lock().unwrap();
            restored.load(&mut state).unwrap();
            assert_eq!(state.runs.len(), 2);
            assert!(state.runs.iter().all(|r| r["status"] == V::from("done")));
        }
        fs::write(directory.path().join("workflow-runs.json"), "{broken").unwrap();
        assert!(restored.start("parallel", V::object()).await.is_err());
        assert_eq!(
            fs::read_to_string(directory.path().join("workflow-runs.json")).unwrap(),
            "{broken"
        );
    }
    #[tokio::test]
    async fn interpolation_and_conditions_preserve_original_context_boundary() {
        let mut state = object([
            ("_lastOutput", "hidden".into()),
            ("result", "visible".into()),
            ("empty", "".into()),
        ]);
        let inputs = object([("empty", "input".into())]);
        let ctx = context(&state, &inputs);
        assert_eq!(
            resolve(&"{{result}}/{{empty}}/{{_lastOutput}}".into(), &ctx),
            V::from("visible/input/")
        );
        state["surrogate"] = V::String(vec![0xd800]);
        assert_eq!(
            resolve(&"{{surrogate}}".into(), &state),
            V::String(vec![0xd800])
        );
        assert!(matches_pattern(&"^VISIBLE$".into(), &"visible".into())
            .await
            .unwrap());
        assert!(matches_pattern(&"(a+)+".into(), &"a".into()).await.is_err());
    }
    #[test]
    fn command_injection_and_private_routes_are_blocked() {
        assert!(allowed_shell("echo fixture"));
        for command in [
            "echo ok\nnode exploit",
            "echo ok\rnode exploit",
            "echo $(pwd)",
            "cat a;node b",
            "/bin/sh x",
        ] {
            assert!(!allowed_shell(command));
        }
        for ip in [
            "127.0.0.2",
            "10.1.2.3",
            "100.64.1.1",
            "169.254.169.254",
            "192.168.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2002:7f00:1::",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700::1111".parse().unwrap()));
        assert!(!route(&Method::GET, "/api/workflows/schedules"));
    }
}
