use crate::{
    board_model,
    board_value::{object, V},
    terminals,
};
mod summary;
use axum::{
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use regex::Regex;
#[path = "board_control.rs"]
mod control;
#[path = "board_review_message.rs"]
mod review_message;
#[path = "board_review.rs"]
mod reviewer;
#[path = "board_worker_message.rs"]
mod worker_message;
#[path = "board_workers.rs"]
mod workers;
pub use reviewer::tick as review_tick;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
pub use workers::Runner as WorkerRunner;

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/board"),
    ("PUT", "/api/board"),
    ("POST", "/api/board/supervisors"),
    ("PUT", "/api/board/note"),
    ("POST", "/api/board/note/append"),
    ("POST", "/api/board/tasks"),
    ("PATCH", "/api/board/tasks/:id"),
    ("DELETE", "/api/board/tasks/:id"),
    ("PUT", "/api/board/permissions"),
    ("PUT", "/api/board/review"),
    ("POST", "/api/board/review"),
    ("PATCH", "/api/board/worker-settings"),
    ("PATCH", "/api/board/worker-dispatch"),
    ("POST", "/api/board/worker-resume"),
    ("POST", "/api/board/worker-report"),
];
#[derive(Debug)]
pub(crate) struct Error(u16, String);
type Result<T> = std::result::Result<T, Error>;
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self(500, format!("Unable to access Cockpit board: {error}"))
    }
}
fn invalid(message: impl Into<String>) -> Error {
    Error(400, message.into())
}
fn conflict(id: &str) -> Error {
    Error(
        409,
        format!("{id}: 다른 곳에서도 같은 항목을 수정했습니다. 입력 내용은 이 기기에 보관됩니다."),
    )
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}
fn uuid() -> String {
    let s = format!("{:032x}", rand::random::<u128>());
    format!(
        "{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    )
}

struct Lock {
    path: PathBuf,
    owner: PathBuf,
}
impl Lock {
    fn acquire(file: &Path) -> Result<Self> {
        Self::acquire_with_wait(file, Duration::from_secs(3))
    }
    fn acquire_with_wait(file: &Path, wait: Duration) -> Result<Self> {
        let mut lock = file.as_os_str().to_os_string();
        lock.push(".lock");
        let path = PathBuf::from(lock);
        let owner = path.join(format!("owner-{}-{}", std::process::id(), uuid()));
        let deadline = Instant::now() + wait;
        loop {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => break,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    if Self::release_dead(&path) {
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err(Error(503, "Cockpit board is busy; try again".into()));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => return Err(e.into()),
            }
        }
        if let Err(error) = crate::private_file(&owner) {
            let _ = fs::remove_dir(&path);
            return Err(error.into());
        }
        Ok(Self { path, owner })
    }
    fn release_dead(path: &Path) -> bool {
        #[cfg(unix)]
        {
            static OWNER: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"^owner-([1-9][0-9]*)-[a-f0-9-]{36}$").unwrap());
            let attempt = || -> Option<()> {
                if !fs::symlink_metadata(path).ok()?.is_dir() {
                    return None;
                }
                let entries = fs::read_dir(path)
                    .ok()?
                    .collect::<io::Result<Vec<_>>>()
                    .ok()?;
                if entries.len() != 1 || !entries[0].file_type().ok()?.is_file() {
                    return None;
                }
                let name = entries[0].file_name().into_string().ok()?;
                let captures = OWNER.captures(&name)?;
                let pid = captures[1].parse::<libc::pid_t>().ok()?;
                // Signal zero only checks identity/liveness; it sends no signal.
                if unsafe { libc::kill(pid, 0) } == 0
                    || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                {
                    return None;
                }
                fs::remove_file(entries[0].path()).ok()?;
                fs::remove_dir(path).ok()
            };
            attempt().is_some()
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        if fs::remove_file(&self.owner).is_ok() {
            let _ = fs::remove_dir(&self.path);
        }
    }
}

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
}
pub(crate) enum InputClaim {
    Supervisor(V),
    Worker(V),
    Review(V),
}
impl Store {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(".cockpit-board.json"),
        }
    }
    pub fn new_legacy(directory: &Path) -> std::io::Result<Self> {
        let path = match std::env::var_os("COCKPIT_BOARD_FILE").filter(|v| !v.is_empty()) {
            Some(path) => {
                let path = PathBuf::from(path);
                if path.is_absolute() {
                    path
                } else {
                    std::env::current_dir()?.join(path)
                }
            }
            None => directory.join(".cockpit-board.json"),
        };
        let mut normalized = PathBuf::new();
        for component in path.components() {
            match component {
                std::path::Component::CurDir => continue,
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                _ => normalized.push(component.as_os_str()),
            }
            // Check before resolving a later '..' so a symlink cannot disappear
            // from the validated path through lexical normalization.
            if !crate::account_hub::safe_path(Path::new("/"), &normalized) {
                return Err(std::io::Error::other("Invalid operating board path"));
            }
        }
        Ok(Self { path: normalized })
    }
    pub(crate) fn input_claim(
        &self,
        term_id: &str,
        claim: &InputClaim,
        accept: impl FnOnce() -> bool,
    ) -> std::result::Result<bool, (u16, String)> {
        let run = || -> Result<bool> {
            // Do not queue a delivery behind board writes: its process/screen
            // observation would be stale by the time the lock becomes free.
            let _lock = Lock::acquire_with_wait(&self.path, Duration::ZERO)?;
            let board = self.read()?;
            let watch = match claim {
                InputClaim::Supervisor(watch)
                | InputClaim::Worker(watch)
                | InputClaim::Review(watch) => watch,
            };
            let review = board["supervisors"]
                .array()
                .iter()
                .find(|r| r["id"] == watch["id"]);
            let time = now();
            let valid = review.is_some_and(|r| match claim {
                InputClaim::Review(expected) => {
                    r == expected
                        && r["termId"] == V::from(term_id)
                        && [V::from("running"), V::from("waiting")].contains(&r["status"])
                        && (!r["runUntil"].truthy() || r["runUntil"].number() > time)
                }
                InputClaim::Worker(expected) => {
                    r == expected
                        && control::dispatch_enabled(r, time)
                        && r["watched"].array().iter().any(|w| {
                            w["termId"] == V::from(term_id) && w["paused"] != V::Bool(true)
                        })
                }
                InputClaim::Supervisor(_) => {
                    r["termId"] == V::from(term_id)
                        && [V::from("running"), V::from("waiting")].contains(&r["status"])
                        && matches!(watch["until"], V::Number(n) if n.is_finite() && n > time)
                        && (!r["runUntil"].truthy() || r["runUntil"].number() > time)
                        && r["lastReviewedAt"] == watch["reviewedAt"]
                        && r["pendingSince"] == watch["pendingSince"]
                }
            });
            if !valid {
                return Err(Error(
                    409,
                    "감독 점검 설정이나 보고가 변경되어 이전 재촉 요청을 취소했습니다.".into(),
                ));
            }
            Ok(accept())
        };
        run().map_err(|Error(status, message)| (status, message))
    }
    fn scheduler_update(&self, expected: &V, updates: &V) -> Result<V> {
        let _lock = Lock::acquire(&self.path)?;
        let mut board = self.read()?;
        let time = now();
        control::update_review(&mut board, &expected["id"], updates, Some(expected), time)?;
        board["updatedAt"] = time.into();
        self.save(&board)?;
        Ok(board_model::review(
            board["supervisors"]
                .array()
                .iter()
                .find(|review| review["id"] == expected["id"])
                .unwrap(),
        ))
    }
    pub(crate) fn stop_terminal_reviews(&self, term_id: &str) -> std::result::Result<(), String> {
        let run = || -> Result<()> {
            let _lock = Lock::acquire(&self.path)?;
            let mut board = self.read()?;
            let related: Vec<_> = board["supervisors"]
                .array()
                .iter()
                .filter(|review| review["termId"] == V::from(term_id))
                .cloned()
                .collect();
            if related.is_empty() {
                return Ok(());
            }
            let time = now();
            for review in related {
                control::update_review(
                    &mut board,
                    &review["id"],
                    &object([
                        ("status", "stopped".into()),
                        ("autoRecover", false.into()),
                        ("pendingSince", 0.0.into()),
                        ("recoveryAfter", 0.0.into()),
                    ]),
                    Some(&review),
                    time,
                )?;
            }
            board["updatedAt"] = time.into();
            self.save(&board)
        };
        run().map_err(|error| error.1)
    }
    pub(crate) fn launcher_change<T>(
        &self,
        term_id: &str,
        command: &str,
        save: impl FnOnce() -> io::Result<T>,
    ) -> std::result::Result<T, (u16, String)> {
        let run = || -> Result<T> {
            let _lock = Lock::acquire(&self.path)?;
            let board = self.read()?;
            if board["supervisors"].array().iter().any(|r| {
                r["termId"] == V::from(term_id)
                    && r["autoRecover"] == V::Bool(true)
                    && r["recoveryTerminal"]["command"] != V::from(command)
            }) {
                return Err(Error(409, "자동 복구를 끈 뒤 실행 명령을 저장하고, 새 명령으로 복구 설정을 다시 연결하세요.".into()));
            }
            Ok(save()?)
        };
        run().map_err(|Error(status, message)| (status, message))
    }
    pub(crate) fn conversation_changed(
        &self,
        term_id: &str,
        held: bool,
    ) -> std::result::Result<(), (u16, String)> {
        let run = || -> Result<()> {
            let _lock = Lock::acquire(&self.path)?;
            let mut board = self.read()?;
            let time = now();
            let id = V::from(term_id);
            let related: Vec<_> = board["supervisors"]
                .array()
                .iter()
                .filter(|r| {
                    r["termId"] == id || r["watched"].array().iter().any(|w| w["termId"] == id)
                })
                .cloned()
                .collect();
            if related.is_empty() {
                return Ok(());
            }
            for review in related {
                let mut updates = V::object();
                if ![V::from("stopped"), V::from("complete")].contains(&review["status"]) {
                    updates["nextDueAt"] = time.into();
                    for field in ["retryAt", "pendingSince", "cycleStartedAt", "recoveryAfter"] {
                        updates[field] = 0.0.into();
                    }
                    let mut progress = review["workerProgress"].clone();
                    for worker in progress
                        .array_mut()
                        .iter_mut()
                        .filter(|worker| worker["termId"] == id)
                    {
                        for field in [
                            "lastSentAt",
                            "attempts",
                            "resumeRequestedAt",
                            "resumeSentAt",
                            "resumeSubmittedAt",
                        ] {
                            worker["run"][field] = 0.0.into();
                        }
                    }
                    updates["workerProgress"] = progress;
                }
                if review["termId"] == id && review["recoveryTerminal"].truthy() {
                    updates["recoveryTerminal"] = review["recoveryTerminal"].clone();
                    updates["recoveryTerminal"]["conversationHeld"] = held.into();
                }
                control::update_review(&mut board, &review["id"], &updates, Some(&review), time)?;
            }
            board["updatedAt"] = time.into();
            self.save(&board)
        };
        run().map_err(|Error(status, message)| (status, message))
    }
    pub fn handles(method: &Method, path: &str) -> bool {
        ROUTES.iter().any(|(m, p)| {
            method.as_str() == *m
                && (*p == path
                    || (*p == "/api/board/tasks/:id"
                        && path
                            .strip_prefix("/api/board/tasks/")
                            .is_some_and(|s| !s.is_empty() && !s.contains('/'))))
        })
    }
    pub(crate) fn read(&self) -> Result<V> {
        self.read_view(false)
    }
    fn read_view(&self, overview: bool) -> Result<V> {
        match fs::symlink_metadata(&self.path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Ok(if overview {
                    summary::project(&board_model::empty())
                } else {
                    board_model::empty()
                })
            }
            Ok(meta) if !meta.is_file() => {
                return Err(Error(500, "Invalid board storage file".into()))
            }
            Err(e) => return Err(e.into()),
            _ => {}
        }
        let bytes = fs::read(&self.path)?;
        if overview {
            return summary::read(&bytes, now())
                .map_err(|_| Error(500, "Cockpit board is corrupt JSON".into()));
        }
        let value = serde_json::from_slice::<Box<serde_json::value::RawValue>>(&bytes)
            .and_then(|raw| V::parse(&raw))
            .map_err(|_| Error(500, "Cockpit board is corrupt JSON".into()))?;
        Ok(board_model::normalize(&value, now()))
    }
    fn save(&self, value: &V) -> Result<()> {
        if fs::symlink_metadata(&self.path).is_ok_and(|m| !m.is_file()) {
            return Err(Error(500, "Invalid board storage file".into()));
        }
        let directory = self.path.parent().unwrap();
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(value.raw().get().as_bytes())?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(&self.path).map_err(|e| e.error)?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(())
    }
    pub fn handle(
        &self,
        method: Method,
        path: &str,
        query: &HashMap<String, String>,
        input: crate::json_values::Object,
        local: bool,
        terminals: &terminals::Store,
    ) -> Response {
        let input = match input
            .into_iter()
            .map(|(key, value)| V::parse(&value).map(|v| (key, v)))
            .collect::<serde_json::Result<_>>()
        {
            Ok(value) => V::Object(value),
            Err(_) => return crate::error(400, "Invalid JSON"),
        };
        match self.request(method, path, query, input, local, terminals) {
            Ok((status, value)) => {
                (StatusCode::from_u16(status).unwrap(), Json(value.raw())).into_response()
            }
            Err(Error(status, message)) => crate::error(status, &message),
        }
    }
    fn request(
        &self,
        method: Method,
        path: &str,
        query: &HashMap<String, String>,
        input: V,
        local: bool,
        terminals: &terminals::Store,
    ) -> Result<(u16, V)> {
        if method == Method::GET {
            let overview = match query.get("projection").map(String::as_str) {
                None => false,
                Some("overview") if !query.contains_key("supervisorId") => true,
                _ => return Err(invalid("Invalid board projection")),
            };
            let board = self.read_view(overview)?;
            return Ok((
                200,
                if let Some(id) = query.get("supervisorId").filter(|s| !s.is_empty()) {
                    scoped(&board, &V::from(id.clone()))?
                } else {
                    board
                },
            ));
        }
        if path == "/api/board"
            && (input["board"].has("projection") || input["base"].has("projection"))
        {
            return Err(invalid("A board summary cannot replace the full board"));
        }
        if (path == "/api/board/supervisors" || control::handles(path)) && !local {
            return Err(Error(
                403,
                "감독·작업자 설정과 보고는 로컬에서만 가능합니다.".into(),
            ));
        }
        if path == "/api/board/tasks" && input.has("termId") {
            if !input["termId"].is_string()
                || !input["termId"].trim().truthy()
                || input["termId"].units().len() > 200
            {
                return Err(invalid("세션 고정 ID를 확인하세요."));
            }
            if !terminals.has_id(&input["termId"].text()) {
                return Err(invalid("체크리스트를 등록할 세션의 고정 ID를 확인하세요."));
            }
        }
        let observations = control::observe(&method, path, &input, terminals);
        let _lock = Lock::acquire(&self.path)?;
        let current = self.read()?;
        observations.validate(terminals)?;
        let mut next = current.clone();
        let time = now();
        let mut result_item = None;
        let mut status = 200;
        let metadata = control::handles(path);
        let scope = if metadata {
            control::apply(&mut next, &method, path, &input, &observations, time)?
        } else {
            match (method.as_str(), path) {
                ("PUT", "/api/board") => {
                    next = replace(&current, &input, time)?;
                }
                ("POST", "/api/board/supervisors") => {
                    let name = clean(&input["name"], 80, "name")?;
                    if next["supervisors"].array().len() >= 12 {
                        return Err(invalid("감독은 최대 12개입니다."));
                    }
                    let supervisor = board_model::review(&object([
                        ("id", format!("S-{}", uuid()).into()),
                        ("name", name),
                    ]));
                    next["supervisors"].array_mut().push(supervisor.clone());
                    result_item = Some(("supervisor", supervisor));
                    status = 201;
                }
                ("PUT", "/api/board/note") | ("POST", "/api/board/note/append") => {
                    let append = method == Method::POST;
                    let content = if append {
                        clean(&input["content"], 12000, "content")?
                    } else if input["content"].is_string() {
                        input["content"].cut(12000)
                    } else {
                        return Err(invalid("content must be a string"));
                    };
                    if next["notes"].array().is_empty() {
                        let id = allocate(&mut next, "nextNoteNumber", "N-")?;
                        next["notes"].array_mut().push(object([
                            ("id", id),
                            ("title", "Memo 1".into()),
                            ("content", "".into()),
                            ("createdAt", time.into()),
                            ("updatedAt", 0.0.into()),
                        ]));
                    }
                    let note = &mut next["notes"].array_mut()[0];
                    note["content"] = if append {
                        let mut units = note["content"].units().to_vec();
                        if !units.is_empty() {
                            units.push(10);
                        }
                        units.extend(content.units());
                        if units.len() > 12000 {
                            return Err(invalid("content exceeds the 12000 character note limit"));
                        }
                        V::String(units)
                    } else {
                        content
                    };
                    note["updatedAt"] = time.into();
                    let projection = object([
                        ("content", note["content"].clone()),
                        ("updatedAt", note["updatedAt"].clone()),
                    ]);
                    next["note"] = projection;
                }
                ("POST", "/api/board/tasks") => {
                    let text = clean(&input["text"], 500, "text")?;
                    let kind = if input.has("kind") {
                        input["kind"].clone()
                    } else {
                        "task".into()
                    };
                    let recipient = if input.has("questionTo") {
                        input["questionTo"].clone()
                    } else {
                        "user".into()
                    };
                    if ![V::from("task"), V::from("question")].contains(&kind) {
                        return Err(invalid("Invalid task kind"));
                    }
                    if ![V::from("user"), V::from("supervisor")].contains(&recipient) {
                        return Err(invalid("Invalid question recipient"));
                    }
                    if input.has("termId") && kind != V::from("task") {
                        return Err(invalid("세션 체크리스트의 고정 termId를 확인하세요."));
                    }
                    let mut list = next["checklists"]
                        .array()
                        .iter()
                        .find(|v| v["id"] == input["checklistId"])
                        .cloned();
                    if input["checklistId"].truthy() && list.is_none() {
                        return Err(invalid("checklist not found"));
                    }
                    let owner = if input["supervisorId"].truthy() {
                        input["supervisorId"].clone()
                    } else {
                        list.as_ref()
                            .map(|v| v["supervisorId"].clone())
                            .unwrap_or("S-0001".into())
                    };
                    scoped(&next, &owner)?;
                    if list.as_ref().is_some_and(|v| v["supervisorId"] != owner) {
                        return Err(invalid("다른 감독의 체크리스트입니다."));
                    }
                    if list.is_none() {
                        list = next["checklists"]
                            .array()
                            .iter()
                            .find(|v| v["supervisorId"] == owner)
                            .cloned();
                    }
                    let list = if let Some(list) = list {
                        list
                    } else {
                        let id = allocate(&mut next, "nextChecklistNumber", "C-")?;
                        let list = object([
                            ("id", id),
                            ("supervisorId", owner),
                            ("title", "Checklist 1".into()),
                            ("createdAt", time.into()),
                            ("updatedAt", 0.0.into()),
                        ]);
                        next["checklists"].array_mut().push(list.clone());
                        list
                    };
                    let mut task = object([
                        ("id", allocate(&mut next, "nextTaskNumber", "T-")?),
                        ("text", text),
                        ("done", false.into()),
                        ("kind", kind.clone()),
                        ("answer", "".into()),
                        ("checklistId", list["id"].clone()),
                        ("createdAt", time.into()),
                        ("updatedAt", time.into()),
                    ]);
                    if kind == V::from("question") {
                        task["questionTo"] = recipient;
                    }
                    if input["termId"].truthy() {
                        task["termId"] = input["termId"].clone();
                        task["status"] = "ready".into();
                    }
                    next["tasks"].array_mut().push(task.clone());
                    result_item = Some(("task", task));
                    status = 201;
                }
                ("PATCH" | "DELETE", _) => {
                    let id =
                        crate::decoded_id(path.strip_prefix("/api/board/tasks/").unwrap_or(""))
                            .ok_or_else(|| invalid("Invalid task ID"))?;
                    let Some(index) = next["tasks"]
                        .array()
                        .iter()
                        .position(|task| task["id"] == V::from(id.clone()))
                    else {
                        return Err(Error(404, "Task not found".into()));
                    };
                    let task = if method == Method::DELETE {
                        next["tasks"].array_mut().remove(index)
                    } else {
                        if input.has("expectedUpdatedAt")
                            && next["tasks"].array()[index]["updatedAt"]
                                != input["expectedUpdatedAt"]
                        {
                            return Err(Error(
                                409,
                                "작업이 다른 곳에서 변경됐습니다. 최신 상태를 확인하세요.".into(),
                            ));
                        }
                        if input.has("expectedStatus")
                            && V::from(crate::board_task_state::status(
                                &next["tasks"].array()[index],
                            )) != input["expectedStatus"]
                        {
                            return Err(Error(
                                409,
                                "작업 상태가 다른 곳에서 변경됐습니다. 최신 상태를 확인하세요."
                                    .into(),
                            ));
                        }
                        let state = crate::board_task_state::apply(
                            &next,
                            &next["tasks"].array()[index],
                            &input,
                        )
                        .map_err(|message| invalid(&message))?;
                        let task = &mut next["tasks"].array_mut()[index];
                        if input.has("text") {
                            task["text"] = clean(&input["text"], 500, "text")?;
                        }
                        if input.has("done") {
                            task["done"] = V::Bool(input["done"] == V::Bool(true));
                        }
                        if input.has("answer") {
                            if task["kind"] != V::from("question")
                                || !input["answer"].is_string()
                                || input["answer"].units().len() > 4000
                            {
                                return Err(invalid(
                                    "A question answer must be a string of at most 4000 characters",
                                ));
                            }
                            task["answer"] = input["answer"].clone();
                        }
                        task["updatedAt"] = time.max(task["updatedAt"].number() + 1.0).into();
                        if let V::Object(fields) = state {
                            for (key, value) in fields {
                                task[&key] = value;
                            }
                        }
                        task.clone()
                    };
                    result_item = Some(("task", task));
                }
                _ => {
                    return Err(Error(
                        501,
                        "Board operation migration is not complete".into(),
                    ))
                }
            }
            None
        };
        retain_history(&mut next)?;
        crate::board_task_state::refresh(&mut next);
        next["revision"] = (current["revision"].number() + if metadata { 0.0 } else { 1.0 }).into();
        next["updatedAt"] = time.into();
        self.save(&next)?;
        Ok((
            status,
            if let Some(id) = scope {
                scoped(&next, &id)?
            } else if metadata {
                // Configuration routes return getBoard() in the existing server,
                // including defaults for freshly initialized worker runs.
                board_model::normalize(&next, time)
            } else if let Some((key, value)) = result_item {
                object([("board", next), (key, value)])
            } else {
                next
            },
        ))
    }
}

fn clean(value: &V, limit: usize, field: &str) -> Result<V> {
    if !value.is_string() {
        return Err(invalid(format!("{field} must be a string")));
    }
    let value = value.trim();
    if !value.truthy() {
        return Err(invalid(format!("{field} is required")));
    }
    Ok(value.cut(limit))
}
fn allocate(board: &mut V, counter: &str, prefix: &str) -> Result<V> {
    let n = board[counter].number();
    if !board[counter].is_integer() || !(1.0..9_007_199_254_740_991.0).contains(&n) {
        return Err(invalid("Invalid board ID counter"));
    }
    board[counter] = (n + 1.0).into();
    Ok(format!("{prefix}{:04}", n as u64).into())
}
pub(crate) fn refresh_waits(board: &mut V) {
    // Preserve acknowledged legacy inputs before dependency hashes are upgraded.
    let migrations: Vec<_> = board["supervisors"]
        .array()
        .iter()
        .enumerate()
        .map(|(index, review)| {
            let local = scoped(board, &review["id"]).expect("normalized supervisor");
            let reviewed = review["lastReviewKey"].truthy()
                && review["lastReviewKey"] != crate::board_task_state::review_key(&local, review)
                && review["lastReviewKey"]
                    == crate::board_task_state::legacy_review_key(&local, review);
            let workers: Vec<_> = review["workerProgress"]
                .array()
                .iter()
                .enumerate()
                .filter_map(|(index, worker)| {
                    let key = &worker["run"]["dependencyKey"];
                    if !key.truthy()
                        || *key == control::dependency(board, review, &worker["termId"])
                        || *key != control::legacy_dependency(board, review, &worker["termId"])
                    {
                        return None;
                    }
                    let dispatched = crate::board_task_state::next(&local, &worker["termId"])
                        .is_none()
                        && review["watched"]
                            .array()
                            .iter()
                            .find(|w| w["termId"] == worker["termId"])
                            .is_some_and(|assigned| {
                                worker["run"]["taskDispatchKey"]
                                    == crate::board_task_state::dispatch_key(
                                        &local, review, assigned, worker, None, key,
                                    )
                            });
                    Some((index, dispatched))
                })
                .collect();
            (index, reviewed, workers)
        })
        .collect();
    crate::board_task_state::refresh(board);
    for (index, reviewed, workers) in migrations {
        let mut review = board["supervisors"].array()[index].clone();
        for (index, dispatched) in workers {
            let worker = &review["workerProgress"].array()[index];
            let key = control::dependency(board, &review, &worker["termId"]);
            let dispatch = dispatched.then(|| {
                crate::board_task_state::dispatch_key(
                    board,
                    &review,
                    review["watched"]
                        .array()
                        .iter()
                        .find(|w| w["termId"] == worker["termId"])
                        .unwrap(),
                    worker,
                    None,
                    &key,
                )
            });
            review["workerProgress"].array_mut()[index]["run"]["dependencyKey"] = key;
            if let Some(key) = dispatch {
                review["workerProgress"].array_mut()[index]["run"]["taskDispatchKey"] = key;
            }
        }
        if reviewed {
            let local = scoped(board, &review["id"]).expect("normalized supervisor");
            review["lastReviewKey"] = crate::board_task_state::review_key(&local, &review);
        }
        board["supervisors"].array_mut()[index] = review;
    }
    if let Some(review) = board["supervisors"].array().first() {
        board["review"] = review.clone();
    }
}

fn scoped(board: &V, id: &V) -> Result<V> {
    let selected = board["supervisors"]
        .array()
        .iter()
        .find(|v| v["id"] == *id)
        .ok_or_else(|| invalid("감독을 찾지 못했습니다."))?;
    let mut out = board.clone();
    out["scopeSupervisorId"] = id.clone();
    out["review"] = selected.clone();
    out["checklists"] = V::Array(
        board["checklists"]
            .array()
            .iter()
            .filter(|v| v["supervisorId"] == *id)
            .cloned()
            .collect(),
    );
    out["tasks"] = V::Array(
        board["tasks"]
            .array()
            .iter()
            .filter(|t| {
                out["checklists"]
                    .array()
                    .iter()
                    .any(|l| l["id"] == t["checklistId"])
            })
            .cloned()
            .collect(),
    );
    Ok(out)
}
#[cfg(test)]
mod review_claim_tests {
    use super::*;

    #[test]
    fn recovery_and_reminders_reject_changes_at_the_final_action_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path());
        let mut board = board_model::normalize(&V::object(), now());
        let id = V::from("S-0001");
        control::update_review(
            &mut board,
            &id,
            &object([
                ("termId", "manager".into()),
                ("status", "running".into()),
                ("autoRecover", true.into()),
                ("pendingSince", 0.0.into()),
            ]),
            None,
            now(),
        )
        .unwrap();
        store.save(&board).unwrap();
        let expected = store.read().unwrap()["review"].clone();
        let claim = InputClaim::Review(expected.clone());
        assert!(store.input_claim("manager", &claim, || true).unwrap());
        for (key, value) in [
            ("status", "stopped".into()),
            ("termId", "replacement".into()),
            ("autoRecover", false.into()),
            ("objective", "changed mission".into()),
            ("lastReviewedAt", now().into()),
            ("pendingSince", 123.0.into()),
        ] {
            store.save(&board).unwrap();
            store
                .scheduler_update(&expected, &object([(key, value)]))
                .unwrap();
            let mut executed = false;
            assert!(
                store
                    .input_claim("manager", &claim, || {
                        executed = true;
                        true
                    })
                    .is_err(),
                "changed {key}"
            );
            assert!(!executed, "stale action ran after changed {key}");
        }
        store.save(&board).unwrap();
        let expired = store
            .scheduler_update(&expected, &object([("runUntil", (now() - 1.0).into())]))
            .unwrap();
        assert!(store
            .input_claim("manager", &InputClaim::Review(expired), || panic!(
                "expired action ran"
            ))
            .is_err());
        store.save(&board).unwrap();
        let _lock = Lock::acquire(&store.path).unwrap();
        assert!(store
            .input_claim("manager", &claim, || panic!("action queued behind writer"))
            .is_err());
    }
}

fn retain_history(board: &mut V) -> Result<()> {
    let owners: HashSet<_> = board["tasks"]
        .array()
        .iter()
        .filter(|t| t["termId"].truthy())
        .map(|t| t["termId"].text())
        .collect();
    let mut expired = HashSet::new();
    for owner in owners {
        let owned: Vec<_> = board["tasks"]
            .array()
            .iter()
            .filter(|t| t["termId"].text() == owner)
            .collect();
        let excess = owned.len().saturating_sub(50);
        if excess == 0 {
            continue;
        }
        let mut done: Vec<_> = owned
            .iter()
            .filter(|t| t["done"] == V::Bool(true))
            .collect();
        if done.len() < excess {
            return Err(invalid(
                "미완료 작업이 50개입니다. 기존 항목을 완료하거나 정리한 뒤 추가하세요.",
            ));
        }
        done.sort_by(|a, b| {
            a["updatedAt"]
                .number()
                .total_cmp(&b["updatedAt"].number())
                .then(a["createdAt"].number().total_cmp(&b["createdAt"].number()))
                .then(a["id"].text().cmp(&b["id"].text()))
        });
        for task in done.into_iter().take(excess) {
            expired.insert(task["id"].text());
        }
    }
    board["tasks"]
        .array_mut()
        .retain(|t| !expired.contains(&t["id"].text()));
    Ok(())
}
fn retain_recipients(value: &V, current: &V) -> V {
    let mut value = value.object_clone();
    if value["tasks"].is_array() {
        for task in value["tasks"].array_mut() {
            if let Some(saved) = current["tasks"]
                .array()
                .iter()
                .find(|v| v["id"] == task["id"])
            {
                if saved["termId"].truthy() {
                    task["termId"] = saved["termId"].clone();
                    task["kind"] = "task".into();
                    for key in ["status", "blocker", "waitFor", "waitKey", "activation"] {
                        if !task.has(key) && saved.has(key) {
                            task[key] = saved[key].clone();
                        }
                    }
                    if ["status", "blocker", "waitFor"]
                        .iter()
                        .all(|key| task[*key] == saved[*key])
                    {
                        task["waitKey"] = saved["waitKey"].clone();
                    }
                }
                if task["kind"] == V::from("question") && !task.has("questionTo") {
                    task["questionTo"] = saved["questionTo"].clone();
                }
            }
        }
    }
    value
}
fn replace(current: &V, input: &V, time: f64) -> Result<V> {
    let value = &input["board"];
    let base = &input["base"];
    let expected = &input["revision"];
    if value["scopeSupervisorId"].truthy() || base["scopeSupervisorId"].truthy() {
        return Err(invalid(
            "감독별 조회 결과로 전체 보드를 덮어쓸 수 없습니다. 항목별 API를 사용하세요.",
        ));
    }
    if !expected.is_integer() || expected.number() < 0.0 {
        return Err(invalid("revision must be a non-negative integer"));
    }
    if current["revision"] != *expected && (!base.truthy() || base["revision"] != *expected) {
        return Err(Error(409, "Cockpit board changed on another client".into()));
    }
    let local = board_model::normalize(&retain_recipients(value, current), time);
    let mut next = if current["revision"] == *expected {
        local
    } else {
        board_model::normalize(
            &merge(
                &board_model::normalize(&retain_recipients(base, current), time),
                &local,
                current,
            )?,
            time,
        )
    };
    // The current browser projects known fields before saving. Carry forward
    // server fields it cannot represent, without reviving deleted rows or known
    // task fields intentionally removed by a kind change.
    if let V::Object(fields) = current {
        for (key, value) in fields {
            if !next.has(key) {
                next[key] = value.clone();
            }
        }
    }
    for collection in ["notes", "checklists", "tasks"] {
        for item in next[collection].array_mut() {
            if let Some(V::Object(fields)) = current[collection]
                .array()
                .iter()
                .find(|saved| saved["id"] == item["id"])
            {
                for (key, value) in fields {
                    if !item.has(key)
                        && !(collection == "tasks"
                            && ["termId", "questionTo"].contains(&key.as_str()))
                    {
                        item[key] = value.clone();
                    }
                }
            }
        }
    }
    next["review"] = current["review"].clone();
    next["supervisors"] = current["supervisors"].clone();
    for list in next["checklists"].array_mut() {
        if let Some(saved) = current["checklists"]
            .array()
            .iter()
            .find(|v| v["id"] == list["id"])
        {
            list["supervisorId"] = saved["supervisorId"].clone();
        }
    }
    Ok(next)
}
fn merge(base: &V, local: &V, remote: &V) -> Result<V> {
    let mut out = remote.clone();
    for (collection, fields) in [
        ("notes", &["title", "content"][..]),
        ("checklists", &["title", "goal", "supervisorId"][..]),
        (
            "tasks",
            &[
                "text",
                "done",
                "kind",
                "questionTo",
                "answer",
                "checklistId",
                "termId",
                "status",
                "blocker",
                "waitFor",
                "waitKey",
                "activation",
            ][..],
        ),
    ] {
        let changed = |a: &V, b: &V| fields.iter().any(|key| a[key] != b[key]);
        let mut current = remote[collection].array().to_vec();
        for previous in base[collection].array() {
            let id = &previous["id"];
            if local[collection].array().iter().any(|v| v["id"] == *id) {
                continue;
            }
            if current
                .iter()
                .any(|v| v["id"] == *id && changed(previous, v))
            {
                return Err(conflict(&id.text()));
            }
            if collection == "checklists"
                && remote["tasks"].array().iter().any(|t| {
                    t["checklistId"] == *id
                        && !base["tasks"].array().iter().any(|old| old["id"] == t["id"])
                })
            {
                return Err(conflict(&id.text()));
            }
            current.retain(|v| v["id"] != *id);
        }
        for item in local[collection].array() {
            let id = &item["id"];
            let previous = base[collection].array().iter().find(|v| v["id"] == *id);
            let existing = current.iter().position(|v| v["id"] == *id);
            let Some(previous) = previous else {
                if let Some(index) = existing {
                    if changed(item, &current[index])
                        || item["createdAt"] != current[index]["createdAt"]
                    {
                        return Err(conflict(&id.text()));
                    }
                } else {
                    current.push(item.clone());
                }
                continue;
            };
            if !changed(previous, item) {
                continue;
            }
            let Some(index) = existing else {
                return Err(conflict(&id.text()));
            };
            if collection == "tasks" && item["termId"].truthy() {
                let state_fields = [
                    "done",
                    "status",
                    "blocker",
                    "waitFor",
                    "waitKey",
                    "activation",
                ];
                if state_fields.iter().any(|key| previous[key] != item[key])
                    && state_fields
                        .iter()
                        .any(|key| previous[key] != current[index][key])
                    && state_fields
                        .iter()
                        .any(|key| item[key] != current[index][key])
                {
                    return Err(conflict(&id.text()));
                }
            }
            for key in fields {
                if previous[key] == item[key] {
                    continue;
                }
                if current[index][key] != previous[key] && current[index][key] != item[key] {
                    return Err(conflict(&id.text()));
                }
                if item.has(key) {
                    current[index][key] = item[key].clone();
                } else {
                    current[index].remove(key);
                }
            }
            current[index]["updatedAt"] = item["updatedAt"]
                .number_or(0.0)
                .max(current[index]["updatedAt"].number_or(0.0))
                .into();
        }
        out[collection] = V::Array(current);
    }
    for key in ["nextTaskNumber", "nextNoteNumber", "nextChecklistNumber"] {
        out[key] = local[key].number().max(remote[key].number()).into();
    }
    if out["tasks"].array().iter().any(|t| {
        !out["checklists"]
            .array()
            .iter()
            .any(|l| l["id"] == t["checklistId"])
    }) {
        return Err(conflict("체크리스트"));
    }
    Ok(out)
}
