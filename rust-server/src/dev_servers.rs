use crate::{
    board_value::{object, V},
    events, projects,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    io::{self, Read},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::Notify;

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/dev-servers"),
    ("POST", "/api/projects/:id/dev-server/start"),
    ("POST", "/api/projects/:id/dev-server/stop"),
];

struct Run {
    project_id: String,
    command: V,
    started_at: i64,
    port: AtomicU16,
    stop: Notify,
    done: AtomicBool,
    finished: Notify,
}
pub struct Store {
    running: Mutex<Vec<Arc<Run>>>,
    events: Arc<events::Store>,
    closing: AtomicBool,
    restart_reserved: AtomicBool,
}
fn operation(path: &str) -> Option<(&str, &str)> {
    let (id, tail) = path.strip_prefix("/api/projects/")?.split_once('/')?;
    (!id.is_empty() && matches!(tail, "dev-server/start" | "dev-server/stop")).then_some((id, tail))
}
pub fn route(method: &Method, path: &str) -> bool {
    (*method == Method::GET && path == "/api/dev-servers")
        || (*method == Method::POST && operation(path).is_some())
}
fn port(text: &str) -> Option<u16> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let found = RE.get_or_init(|| regex::Regex::new(r"(?i)(?:localhost|127\.0\.0\.1|0\.0\.0\.0):([0-9]{4,5})(?-u:\b)|(?:port\s*[=:]?\s*)([0-9]{4,5})(?-u:\b)|https?://[^:/\s]+:([0-9]{4,5})(?-u:\b)").unwrap()).captures(text)?;
    // Match the first candidate exactly as Node does, even if a later one is valid.
    let number = (1..=3)
        .find_map(|i| found.get(i))?
        .as_str()
        .parse::<u16>()
        .ok()?;
    (number >= 1024).then_some(number)
}
fn spawn(project: &V) -> io::Result<Child> {
    if !cfg!(target_os = "linux") {
        return Err(io::Error::other(
            "Owned dev-server process groups require Linux",
        ));
    }
    let path = project["path"].text();
    let normalized = path.replace('\\', "/");
    static WSL: OnceLock<regex::Regex> = OnceLock::new();
    let wsl = WSL
        .get_or_init(|| regex::Regex::new(r"(?i)^//wsl[\$.](?:localhost)?/([^/]+)(/.*)").unwrap())
        .captures(&normalized);
    let mut command = if let Some(wsl) = wsl {
        let mut command = Command::new("wsl");
        command.args([
            "-d",
            &wsl[1],
            "--cd",
            &wsl[2],
            "sh",
            "-c",
            &project["devCmd"].text(),
        ]);
        command.current_dir(std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".into()));
        command
    } else {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", &project["devCmd"].text()])
            .current_dir(path);
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn()
}

// Observe exit without reaping the group leader. Keeping its PID reserved until
// group cleanup prevents a stale exit/stop from signalling a reused process ID.
#[cfg(target_os = "linux")]
fn exited(child: &mut Child) -> io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id(),
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { info.si_pid() } != 0)
}
#[cfg(not(target_os = "linux"))]
fn exited(_child: &mut Child) -> io::Result<bool> {
    Err(io::Error::other("Unsupported process ownership"))
}
#[cfg(unix)]
fn signal_group(child: &Child, signal: i32) {
    unsafe {
        libc::kill(-(child.id() as i32), signal);
    }
}
#[cfg(not(unix))]
fn signal_group(_child: &Child, _signal: i32) {}

impl Run {
    fn value(&self) -> V {
        let port = self.port.load(Ordering::Acquire);
        object([
            ("projectId", self.project_id.clone().into()),
            ("command", self.command.clone()),
            ("startedAt", V::Number(self.started_at as f64)),
            (
                "port",
                if port == 0 {
                    V::Null
                } else {
                    V::Number(port as f64)
                },
            ),
        ])
    }
    async fn wait(&self) {
        loop {
            let notified = self.finished.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.done.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}
impl Store {
    pub fn new(events: Arc<events::Store>) -> Arc<Self> {
        Arc::new(Self {
            running: Mutex::new(vec![]),
            events,
            closing: AtomicBool::new(false),
            restart_reserved: AtomicBool::new(false),
        })
    }
    pub fn snapshot(&self) -> V {
        V::Array(
            self.running
                .lock()
                .unwrap()
                .iter()
                .map(|run| run.value())
                .collect(),
        )
    }
    pub fn reserve_restart(&self) -> Result<(), String> {
        let running = self.running.lock().unwrap();
        if self.closing.load(Ordering::Acquire) || !running.is_empty() {
            return Err("개발 서버 실행 상태가 바뀌어 기존 서버를 유지합니다.".into());
        }
        self.restart_reserved.store(true, Ordering::Release);
        self.closing.store(true, Ordering::Release);
        Ok(())
    }
    pub fn cancel_restart(&self) {
        let _running = self.running.lock().unwrap();
        if self.restart_reserved.swap(false, Ordering::AcqRel) {
            self.closing.store(false, Ordering::Release);
        }
    }
    fn broadcast(&self) {
        self.events.publish_raw(
            "dev:status",
            object([("running", self.snapshot())]).raw().get(),
        );
    }
    fn read_output(self: &Arc<Self>, run: Arc<Run>, mut pipe: impl Read + Send + 'static) {
        let store = Arc::downgrade(self);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(count) = pipe.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                if run.port.load(Ordering::Acquire) != 0 {
                    continue;
                }
                if let Some(port) = port(&String::from_utf8_lossy(&buffer[..count])) {
                    let Some(store) = store.upgrade() else {
                        break;
                    };
                    if store
                        .running
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|current| Arc::ptr_eq(current, &run))
                        && run
                            .port
                            .compare_exchange(0, port, Ordering::AcqRel, Ordering::Acquire)
                            .is_ok()
                    {
                        store.broadcast();
                    }
                }
            }
        });
    }
    async fn monitor(self: Arc<Self>, run: Arc<Run>, mut child: Child) {
        let mut owned = true;
        loop {
            match exited(&mut child) {
                Ok(true) => break,
                Ok(false) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                // Another reaper would invalidate PID ownership. Never signal a
                // possibly reused PID in that case.
                Err(_) => {
                    owned = false;
                    break;
                }
            }
            tokio::select! {
                _ = run.stop.notified() => break,
                _ = tokio::time::sleep(Duration::from_millis(25)) => {},
            }
        }
        if owned {
            signal_group(&child, libc::SIGTERM);
            tokio::time::sleep(Duration::from_millis(250)).await;
            signal_group(&child, libc::SIGKILL);
            let _ = tokio::task::spawn_blocking(move || child.wait()).await;
        }
        let removed = {
            let mut running = self.running.lock().unwrap();
            let before = running.len();
            running.retain(|current| !Arc::ptr_eq(current, &run));
            before != running.len()
        };
        if removed {
            self.broadcast();
        }
        run.done.store(true, Ordering::Release);
        run.finished.notify_waiters();
    }
    pub async fn handle(
        self: &Arc<Self>,
        method: &Method,
        path: &str,
        projects: &projects::Store,
    ) -> Response {
        if *method == Method::GET && path == "/api/dev-servers" {
            let mut snapshot = self.snapshot();
            for run in snapshot.array_mut() {
                let name = crate::git::project(projects, &run["projectId"].text())
                    .map(|p| p["name"].clone())
                    .filter(V::truthy)
                    .unwrap_or_else(|| run["projectId"].clone());
                run["name"] = name;
            }
            return Json(object([("running", snapshot)]).raw()).into_response();
        }
        let Some((id, action)) = operation(path).filter(|_| *method == Method::POST) else {
            return crate::error(404, "Not found");
        };
        let Some(project) = crate::git::project(projects, id) else {
            return crate::error(404, "Not found");
        };
        if action == "dev-server/stop" {
            let run = self
                .running
                .lock()
                .unwrap()
                .iter()
                .find(|run| run.project_id == id)
                .cloned();
            let Some(run) = run else {
                return crate::error(404, "Not running");
            };
            run.stop.notify_one();
            run.wait().await;
            return Json(object([("stopped", true.into()), ("projectId", id.into())]).raw())
                .into_response();
        }
        let (run, mut child) = {
            let mut running = self.running.lock().unwrap();
            if self.closing.load(Ordering::Acquire) {
                return crate::error(503, "Server is shutting down");
            }
            if running.iter().any(|run| run.project_id == id) {
                return crate::error(409, "Already running");
            }
            if !project["devCmd"].truthy() {
                return crate::error(400, "No devCmd configured");
            }
            if !project["devCmd"].is_string() {
                return crate::error(400, "devCmd must be a string");
            }
            let child = match spawn(&project) {
                Ok(child) => child,
                Err(error) => return crate::error(500, &error.to_string()),
            };
            let run = Arc::new(Run {
                project_id: id.into(),
                command: project["devCmd"].clone(),
                started_at: crate::account_usage::now(),
                port: AtomicU16::new(0),
                stop: Notify::new(),
                done: AtomicBool::new(false),
                finished: Notify::new(),
            });
            running.push(run.clone());
            (run, child)
        };
        self.broadcast();
        if let Some(stdout) = child.stdout.take() {
            self.read_output(run.clone(), stdout);
        }
        if let Some(stderr) = child.stderr.take() {
            self.read_output(run.clone(), stderr);
        }
        tokio::spawn(self.clone().monitor(run, child));
        Json(object([("started", true.into()), ("projectId", id.into())]).raw()).into_response()
    }
    pub async fn shutdown(&self) {
        let runs = {
            let running = self.running.lock().unwrap();
            self.restart_reserved.store(false, Ordering::Release);
            self.closing.store(true, Ordering::Release);
            running.clone()
        };
        for run in &runs {
            run.stop.notify_one();
        }
        for run in runs {
            run.wait().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelling_restart_cannot_reopen_a_store_that_has_shut_down() {
        let store = Store::new(events::Store::new());
        store.reserve_restart().unwrap();
        assert!(store.reserve_restart().is_err());
        store.cancel_restart();
        store.reserve_restart().unwrap();
        store.shutdown().await;
        store.cancel_restart();
        assert!(store.reserve_restart().is_err());
    }

    #[test]
    fn port_matches_first_candidate_and_original_boundaries() {
        for text in [
            "localhost:5173",
            "http://example.invalid:5173/",
            "port = 5173",
            "127.0.0.1:5173",
        ] {
            assert_eq!(port(text), Some(5173));
        }
        assert_eq!(port("localhost:1000 port 8080"), None);
        assert_eq!(port("port 65536"), None);
        assert_eq!(port("localhost:808012"), None);
        assert_eq!(port("port 123"), None);
        assert_eq!(
            port("https://example.invalid:8080 then port 9000"),
            Some(8080)
        );
    }
    #[test]
    fn route_and_snapshot_contracts() {
        assert!(route(&Method::GET, "/api/dev-servers"));
        assert!(route(&Method::POST, "/api/projects/a/dev-server/start"));
        assert!(!route(&Method::GET, "/api/projects/a/dev-server/start"));
        let store = Store::new(events::Store::new());
        let run = Arc::new(Run {
            project_id: "a".into(),
            command: "echo test".into(),
            started_at: 123,
            port: AtomicU16::new(0),
            stop: Notify::new(),
            done: AtomicBool::new(false),
            finished: Notify::new(),
        });
        store.running.lock().unwrap().push(run);
        let snapshot = store.snapshot();
        assert_eq!(snapshot.array()[0]["port"], V::Null);
        assert!(!snapshot.array()[0].has("name"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn shutdown_reaps_owned_leader_and_terminates_its_descendant() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        let project = object([
            (
                "path",
                directory.path().to_string_lossy().to_string().into(),
            ),
            (
                "devCmd",
                format!(
                    "trap '' TERM; sleep 30 & echo $! > '{}'; wait",
                    pid_file.display()
                )
                .into(),
            ),
        ]);
        let child = spawn(&project).unwrap();
        let leader = child.id();
        let store = Store::new(events::Store::new());
        let run = Arc::new(Run {
            project_id: "private-shutdown".into(),
            command: project["devCmd"].clone(),
            started_at: 0,
            port: AtomicU16::new(0),
            stop: Notify::new(),
            done: AtomicBool::new(false),
            finished: Notify::new(),
        });
        store.running.lock().unwrap().push(run.clone());
        tokio::spawn(store.clone().monitor(run, child));
        for _ in 0..100 {
            if pid_file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let descendant: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), store.shutdown())
            .await
            .unwrap();
        assert!(store.snapshot().array().is_empty());
        assert!(!std::path::Path::new(&format!("/proc/{leader}")).exists());
        // Reaping the leader does not synchronize the kernel's delivery of
        // SIGKILL to every descendant. Require termination within a deadline.
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match std::fs::read_to_string(format!("/proc/{descendant}/stat")) {
                    // A descendant being torn down can briefly report ESRCH instead of disappearing.
                    Err(error)
                        if error.kind() == io::ErrorKind::NotFound
                            || error.raw_os_error() == Some(libc::ESRCH) =>
                    {
                        break
                    }
                    Ok(stat)
                        if matches!(
                            stat.rsplit_once(") ").unwrap().1.chars().next(),
                            Some('Z' | 'X')
                        ) =>
                    {
                        break
                    }
                    Err(error) => panic!("Cannot inspect fixture descendant: {error}"),
                    _ => tokio::time::sleep(Duration::from_millis(10)).await,
                }
            }
        })
        .await
        .expect("Owned descendant must terminate after shutdown");
    }
}
