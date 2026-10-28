mod account_hub;
mod account_usage;
mod accounts;
mod activity;
mod agent;
mod agent_app;
mod agent_consult;
mod agent_context;
mod agent_monitor;
mod agent_monitor_stats;
mod agent_orchestration;
mod agent_prompt;
mod agent_response;
mod agent_routing;
mod agent_runtime;
mod agent_service_cockpit;
mod agent_service_external;
mod agent_service_jira;
mod agent_tools;
mod ai_config;
mod ai_transport;
mod approval_watcher;
mod autonomy_schedule;
mod autopilot;
mod aws_connect;
mod background_agents;
mod batch;
mod board;
mod board_model;
mod board_task_state;
mod board_value;
mod briefing;
mod cicd;
mod commands;
mod costs;
mod desktop_notify;
mod dev_servers;
mod events;
mod git;
mod github;
mod jcode_accounts;
mod jcode_session;
mod json_values;
mod native_account;
mod network_addresses;
mod notes;
mod operating_storage;
mod ports;
mod process_inventory;
mod process_owned;
mod project_command;
mod project_polling;
mod projects;
mod qr;
mod recovery_history;
mod reports;
mod server_manager;
mod server_restart;
mod session_launch;
mod session_views;
mod session_wakeup;
mod sessions;
mod supervisor;
mod system;
mod system_connections;
mod system_files;
mod telegram;
mod telegram_commands;
mod telegram_text;
mod telegram_todos;
mod terminal_buffer;
mod terminals;
mod tts;
mod usage_costs;
mod workflow_regex;
mod workflow_schedule;
mod workflows;

use axum::{
    body::{to_bytes, Body},
    extract::{ConnectInfo, FromRequestParts, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use fs2::FileExt;
use serde_json::json;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

const MAX_BODY: usize = 10 * 1024 * 1024;
const COOKIE: &str = "cockpit-token";
const NATIVE_ROUTES: &[(&str, &str)] = &[
    ("POST", "/api/server/restart"),
    ("GET", "/api/events"),
    ("GET", "/api/terminals/:ref/wakeup"),
    ("PUT", "/api/terminals/:ref/wakeup"),
    ("POST", "/api/notify/toggle"),
    ("GET", "/"),
    ("GET", "/manifest.json"),
    ("GET", "/sw.js"),
    ("GET", "/js/:filename"),
    ("GET", "/css/:filename"),
    ("GET", "/vendor/:filename"),
    ("GET", "/vendor/fonts/:filename"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/polling-speed"),
    ("GET", "/api/usage"),
    ("GET", "/api/cost/daily"),
    ("GET", "/api/cost/insights"),
    ("GET", "/api/stats"),
    ("GET", "/api/notes"),
    ("POST", "/api/notes"),
    ("GET", "/api/notes/:id"),
    ("PUT", "/api/notes/:id"),
    ("DELETE", "/api/notes/:id"),
];

struct App {
    legacy_layout: bool,
    root: PathBuf,
    token: String,
    notes: notes::Store,
    reports: reports::Store,
    aws_connect: aws_connect::Store,
    projects: projects::Store,
    terminals: Arc<terminals::Store>,
    session_wakeup: session_wakeup::Store,
    board: board::Store,
    recovery_history: recovery_history::Store,
    history_snapshot: Mutex<()>,
    restart: server_restart::Store,
    accounts: Arc<accounts::Store>,
    approval_watcher: approval_watcher::Store,
    events: Arc<events::Store>,
    git: Arc<git::Store>,
    project_polling: Arc<project_polling::Store>,
    sessions: Arc<sessions::Store>,
    costs: Arc<costs::Store>,
    cicd: cicd::Store,
    dev_servers: Arc<dev_servers::Store>,
    system: system::Store,
    connections: system_connections::Store,
    system_files: system_files::Store,
    batch: Arc<batch::Store>,
    briefing: briefing::Store,
    agent: Arc<agent::Store>,
    agent_runtime: agent_app::Store,
    background: background_agents::Store,
    autonomy_schedule: Arc<autonomy_schedule::Store>,
    ai_config: Arc<ai_config::Store>,
    workflow_schedule: workflow_schedule::Store,
    workflows: Arc<workflows::Store>,
    autopilot: autopilot::Store,
    supervisor: Arc<supervisor::Store>,
    telegram: Arc<telegram::Store>,
    telegram_commands: Arc<telegram_commands::Store>,
    closing: std::sync::atomic::AtomicBool,
    schedule_cancel: ai_transport::Cancel,
    schedule_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    summary_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    rates: Mutex<HashMap<(IpAddr, &'static str), (Instant, u32)>>,
    _lock: File,
}

impl App {
    fn save_recovery_history(&self) -> Result<(), String> {
        // Serialize snapshot capture as well as persistence, so a periodic
        // capture cannot overwrite the newer shutdown checkpoint afterward.
        let _snapshot = self
            .history_snapshot
            .lock()
            .map_err(|_| "Recovery snapshot unavailable")?;
        let Some(checkpoint) = self.terminals.checkpoint_snapshot() else {
            return Ok(());
        };
        let board = self
            .board
            .read()
            .map_err(|_| "Recovery board read failed")?;
        let projects = self
            .projects
            .list()
            .map_err(|_| "Recovery projects read failed")?;
        let checkpoint = board_value::V::parse(
            &serde_json::value::to_raw_value(&checkpoint).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let projects = board_value::V::parse(
            &serde_json::value::to_raw_value(&projects).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        self.recovery_history
            .save(&board, &checkpoint, &projects, account_usage::now())
    }
}

fn private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn sandbox(path: &Path) -> io::Result<(File, String)> {
    if !path.is_absolute() {
        return Err(io::Error::other("--sandbox-dir must be an absolute path"));
    }
    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path)?;
    }
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other("Sandbox directory must not be a symlink"));
    }
    let marker = path.join(".cockpit-rust-preview");
    if !marker.exists() {
        if fs::read_dir(path)?.next().is_some() {
            return Err(io::Error::other(
                "Refusing existing data: use an empty preview directory",
            ));
        }
        private_file(&marker)?.write_all(b"cockpit-rust-preview-v1\n")?;
    }
    if fs::symlink_metadata(&marker)?.file_type().is_symlink()
        || fs::read_to_string(&marker)? != "cockpit-rust-preview-v1\n"
    {
        return Err(io::Error::other("Invalid preview directory marker"));
    }
    let lock = OpenOptions::new().read(true).write(true).open(&marker)?;
    lock.try_lock_exclusive()
        .map_err(|_| io::Error::other("Preview directory is already in use"))?;
    Ok((lock, saved_token(path)?))
}

fn saved_token(path: &Path) -> io::Result<String> {
    let token_path = path.join(".cockpit-token");
    let token = if token_path.exists() {
        if fs::symlink_metadata(&token_path)?.file_type().is_symlink() {
            return Err(io::Error::other("Token file must not be a symlink"));
        }
        let token = fs::read_to_string(&token_path)?.trim().to_string();
        if token.len() < 16 || HeaderValue::from_str(&token).is_err() {
            return Err(io::Error::other(
                "Invalid saved token; refusing to rotate it silently",
            ));
        }
        token
    } else {
        let token = format!("{:032x}", rand::random::<u128>());
        let mut file = private_file(&token_path)?;
        file.write_all(token.as_bytes())?;
        file.sync_all()?;
        token
    };
    Ok(token)
}

fn operating_uid() -> String {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() }.to_string()
    }
    #[cfg(not(unix))]
    {
        "user".into()
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // Blocking jobs may run on different threads between polls. glibc's
        // per-arena heaps otherwise retain another copy of their peak working
        // set. Bound arenas before starting Tokio; do not alter child-agent
        // environments or override allocator settings supplied by the operator.
        let arena_override = std::env::var_os("MALLOC_ARENA_MAX").is_some()
            || std::env::var("GLIBC_TUNABLES").is_ok_and(|value| {
                value
                    .split(':')
                    .any(|item| item.starts_with("glibc.malloc.arena_max="))
            });
        if !arena_override {
            // M_ARENA_MAX changes only the allocation policy, not live objects.
            unsafe { libc::mallopt(libc::M_ARENA_MAX, 1) };
        }
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let result = runtime.block_on(run());
    // Finish owned blocking operations and runtime teardown before requesting
    // a replacement. process::exit inside run would skip their cleanup.
    drop(runtime);
    let code = result?;
    if code != 0 {
        std::process::exit(code);
    }
    Ok(())
}

async fn run() -> Result<i32, Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--workflow-regex") {
        return workflow_regex::child().map(|_| 0);
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--managed")) {
        return server_manager::run(std::env::args_os().skip(2).collect())
            .await
            .map(|_| 0);
    }
    let managed = std::env::args().nth(1).as_deref() == Some("--managed-child");
    let manager = if managed {
        #[cfg(target_os = "linux")]
        let manager = unsafe { libc::getppid() }.to_string();
        #[cfg(not(target_os = "linux"))]
        let manager = String::new();
        if manager.is_empty()
            || std::env::var("COCKPIT_MANAGER_PID").ok().as_deref() != Some(manager.as_str())
        {
            return Err("Managed child requires its owning server manager".into());
        }
        Some(manager.parse::<u32>()?)
    } else {
        None
    };
    let mut root = None;
    let mut directory = None;
    let mut data_directory = None;
    let mut state_directory = None;
    let mut home = None;
    let mut bind = None;
    let mut args = std::env::args().skip(if managed { 2 } else { 1 });
    while let Some(arg) = args.next() {
        let value = args
            .next()
            .ok_or("Expected --root PATH --sandbox-dir PATH [--bind IP:PORT]")?;
        match arg.as_str() {
            "--root" => root = Some(PathBuf::from(value)),
            "--sandbox-dir" => directory = Some(PathBuf::from(value)),
            "--data-dir" => data_directory = Some(PathBuf::from(value)),
            "--state-dir" => state_directory = Some(PathBuf::from(value)),
            "--home-dir" => home = Some(PathBuf::from(value)),
            "--bind" => bind = Some(value.parse::<SocketAddr>()?),
            _ => return Err(format!("Unknown option: {arg}").into()),
        }
    }
    if directory.is_some() && data_directory.is_some() {
        return Err("Choose only one of --sandbox-dir and --data-dir".into());
    }
    let legacy = data_directory.is_some();
    if legacy && !cfg!(target_os = "linux") {
        return Err("Legacy operating layout is currently validated only on Linux and WSL".into());
    }
    if !legacy && home.is_some() {
        return Err("--home-dir requires --data-dir; preview home must remain isolated".into());
    }
    if let Some(path) = &state_directory {
        if !legacy {
            return Err(
                "--state-dir requires --data-dir; preview state must remain isolated".into(),
            );
        }
        if !path.is_dir() || !account_hub::safe_path(Path::new("/"), path) {
            return Err(
                "--state-dir must be an existing absolute directory without symlinks".into(),
            );
        }
    }
    let bind = if let Some(bind) = bind {
        bind
    } else if legacy {
        SocketAddr::new(
            std::env::var("COCKPIT_BIND")
                .unwrap_or_else(|_| "0.0.0.0".into())
                .parse()?,
            std::env::var("COCKPIT_PORT")
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
                .filter(|p| *p > 0)
                .unwrap_or(3847),
        )
    } else {
        "127.0.0.1:0".parse()?
    };
    if !legacy && !bind.ip().is_loopback() {
        return Err("Preview server accepts only loopback bind addresses".into());
    }
    let root = root.ok_or("--root is required")?;
    if !root.is_absolute() || !root.join("index.html").is_file() {
        return Err("--root must be an absolute Cockpit source directory".into());
    }
    if legacy && !account_hub::safe_path(Path::new("/"), &root) {
        return Err("Operating source directory must not contain symlinks".into());
    }
    let directory = data_directory
        .or(directory)
        .ok_or("--sandbox-dir or --data-dir is required")?;
    let home = if legacy {
        home.or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .ok_or("--home-dir is required when HOME is unavailable")?
    } else {
        directory.join("home")
    };
    if legacy && (!home.is_dir() || !account_hub::safe_path(Path::new("/"), &home)) {
        return Err("Home must be an existing absolute directory without symlinks".into());
    }
    let install = if legacy {
        state_directory.unwrap_or_else(|| root.clone())
    } else {
        directory.clone()
    };
    let temporary = if legacy {
        std::env::temp_dir()
    } else {
        directory.clone()
    };
    // Reserve the operating port before opening any mutable store. A running
    // Node server remains the writer until the handover stops it.
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let (lock, token) = if legacy {
        operating_storage::open(&root, &directory)?
    } else {
        sandbox(&directory)?
    };
    let accounts = Arc::new(if legacy {
        accounts::Store::new_legacy(&directory, &root, &home)?
    } else {
        accounts::Store::new(&directory, &root)
    });
    let events = events::Store::new();
    let ai_config = Arc::new(ai_config::Store::new(directory.clone()));
    let telegram = telegram::Store::new(install.clone());
    let supervisor = supervisor::Store::new(install.clone(), ai_config.clone());
    supervisor.set_channel(Some(telegram.supervisor_channel()));
    let agent_runtime = agent_app::Store::with_notes(
        directory.clone(),
        install.join("notes"),
        events.clone(),
        telegram.clone(),
    );
    let state = Arc::new(App {
        legacy_layout: legacy,
        root: root.canonicalize()?,
        token,
        notes: notes::Store::new(install.join("notes"))?,
        reports: reports::Store::new(directory.clone()),
        aws_connect: aws_connect::Store::new(directory.clone()),
        projects: projects::Store::new(directory.clone())?,
        terminals: if legacy {
            terminals::Store::new_legacy(directory.clone(), accounts.clone(), home.clone())?
        } else {
            terminals::Store::new(directory.clone(), accounts.clone())?
        },
        accounts,
        session_wakeup: session_wakeup::Store::new(directory.clone())?,
        approval_watcher: if legacy {
            approval_watcher::Store::new_legacy()
        } else {
            approval_watcher::Store::new(&directory)
        },
        events: events.clone(),
        git: Arc::new(git::Store::default()),
        project_polling: Arc::new(project_polling::Store::default()),
        sessions: Arc::new(if legacy {
            sessions::Store::new_legacy(
                directory.clone(),
                home.clone(),
                temporary.join(format!("cockpit-delegates-{}", operating_uid())),
            )
        } else {
            sessions::Store::new(directory.clone())
        }),
        costs: Arc::new(if legacy {
            costs::Store::new_legacy(install.clone(), home.clone())
        } else {
            costs::Store::new(directory.clone())
        }),
        cicd: cicd::Store::default(),
        dev_servers: dev_servers::Store::new(events.clone()),
        system: system::Store::new(&root),
        connections: system_connections::Store::default(),
        system_files: system_files::Store::new(temporary),
        batch: batch::Store::new(events.clone()),
        briefing: briefing::Store::new(directory.clone()),
        agent: Arc::new(agent::Store::new(directory.clone())),
        agent_runtime,
        background: background_agents::Store::new(directory.clone()),
        autonomy_schedule: autonomy_schedule::Store::new(install.clone()),
        ai_config: ai_config.clone(),
        autopilot: autopilot::Store::new(Some(telegram.autopilot_channel())),
        supervisor,
        telegram,
        telegram_commands: telegram_commands::Store::new(install.clone()),
        workflows: workflows::Store::new(root.clone(), install.clone(), events.clone(), ai_config),
        workflow_schedule: workflow_schedule::Store::new(install, events),
        closing: std::sync::atomic::AtomicBool::new(false),
        schedule_cancel: ai_transport::Cancel::default(),
        schedule_task: Mutex::new(None),
        summary_task: Mutex::new(None),
        board: if legacy {
            board::Store::new_legacy(&directory)?
        } else {
            board::Store::new(&directory)
        },
        recovery_history: recovery_history::Store::new(directory.clone()),
        history_snapshot: Mutex::new(()),
        restart: server_restart::Store::new(manager),
        rates: Mutex::new(HashMap::new()),
        _lock: lock,
    });
    telegram_commands::Store::bind(&state);
    if let Err(error) = state.briefing.startup_snapshot(&state.projects) {
        eprintln!("Daily snapshot could not be saved: {error}");
    }
    let app = Router::new()
        .fallback(any(handle))
        .with_state(state.clone());
    let port = listener.local_addr()?.port();
    state.connections.set_port(port);
    if state.connections.refresh_hosts().await.is_err() {
        eprintln!("Network address discovery unavailable; local access remains enabled");
    }
    state.background.start(state.clone());
    let schedules_app = state.clone();
    let workflow_schedules = tokio::spawn(async move {
        let mut timer = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(60),
            Duration::from_secs(60),
        );
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tokio::select! { _ = schedules_app.schedule_cancel.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(5)) => {} }
        loop {
            if schedules_app
                .closing
                .load(std::sync::atomic::Ordering::Acquire)
            {
                break;
            }
            let app = schedules_app.clone();
            match tokio::task::spawn_blocking(move || app.workflow_schedule.due()).await {
                Ok(Ok(schedules)) => {
                    for (index, claim) in schedules.iter().enumerate() {
                        let schedule = &claim.schedule;
                        if schedules_app
                            .closing
                            .load(std::sync::atomic::Ordering::Acquire)
                        {
                            if let Err(error) = schedules_app
                                .workflow_schedule
                                .restore_unstarted(&schedules[index..])
                            {
                                eprintln!(
                                    "Unstarted workflow schedules could not be restored: {error}"
                                );
                            }
                            break;
                        }
                        let result = schedules_app
                            .workflows
                            .start(&schedule["workflowId"].text(), schedule["inputs"].clone())
                            .await;
                        if result
                            .as_ref()
                            .is_err_and(|error| error == "Server is shutting down")
                        {
                            if let Err(error) = schedules_app
                                .workflow_schedule
                                .restore_unstarted(&schedules[index..])
                            {
                                eprintln!(
                                    "Unstarted workflow schedules could not be restored: {error}"
                                );
                            }
                            break;
                        }
                        let (name, data) = match result {
                            Ok(id) => (
                                "schedule:fired",
                                board_value::object([
                                    ("scheduleId", schedule["id"].clone()),
                                    ("runId", id.into()),
                                    ("workflowName", schedule["workflowName"].clone()),
                                ]),
                            ),
                            Err(error) => (
                                "schedule:error",
                                board_value::object([
                                    ("scheduleId", schedule["id"].clone()),
                                    ("error", error.into()),
                                ]),
                            ),
                        };
                        schedules_app.events.publish_raw(name, data.raw().get());
                    }
                }
                _ => eprintln!("Workflow schedule check deferred: storage unavailable"),
            }
            tokio::select! { _ = schedules_app.schedule_cancel.cancelled() => break, _ = timer.tick() => {} }
        }
    });
    *state.schedule_task.lock().unwrap() = Some(workflow_schedules);
    let summary_app = state.clone();
    *state.summary_task.lock().unwrap() = Some(tokio::spawn(async move {
        // 활동 요약은 터미널마다 `claude -p` 프로세스를 띄운다. 아래 루프에는
        // 동시 실행 상한이 없어서, 자격을 만족한 터미널이 많으면 (관측: 10개)
        // 한 패스에 10개가 동시 기동해 CPU 를 포화시킨다. 그러면 WSL 이 새 셸을
        // 못 띄우고 -> 클라이언트가 "WSL startup timed out" -> 5초마다 재연결 ->
        // 붙을 때마다 전체 재요약으로 돌아오는 악순환이 된다 (2026-10-20 장애).
        // 요약 한 줄의 가치보다 비용이 커서 기본 비활성으로 둔다.
        // 되살리려면 COCKPIT_ACTIVITY_SUMMARY=1 (동시 실행 상한을 먼저 넣을 것).
        if std::env::var("COCKPIT_ACTIVITY_SUMMARY").as_deref() != Ok("1") {
            return;
        }
        let mut jobs = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = summary_app.schedule_cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(10)) => {},
            }
            while jobs.try_join_next().is_some() {}
            for (term_id, mark, agent, raw) in summary_app.terminals.summary_candidates() {
                let supervisor = summary_app.supervisor.clone();
                let now = account_usage::now();
                if !supervisor.summary_gate(&term_id, mark, now, 20_000) {
                    continue;
                }
                let Some(text) = summary_text(&agent, &raw) else {
                    continue;
                };
                let generation = supervisor.begin_summary(&term_id, mark, now);
                jobs.spawn(async move {
                    let text = supervisor
                        .summarize_activity(&text, Duration::from_secs(15))
                        .await;
                    supervisor.end_summary_if_current(
                        &term_id,
                        generation,
                        text,
                        account_usage::now(),
                    );
                });
            }
        }
        while jobs.join_next().await.is_some() {}
    }));
    let cleanup_app = state.clone();
    let paste_cleanup = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            let app = cleanup_app.clone();
            let _ = tokio::task::spawn_blocking(move || app.system_files.cleanup()).await;
            tokio::time::sleep(Duration::from_secs(30 * 60)).await;
        }
    });
    let polling_app = state.clone();
    let project_polling = tokio::spawn(async move {
        loop {
            let app = polling_app.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if !app.terminals.is_closing() {
                    app.sessions
                        .consume_delegates(&app.projects, &app.terminals, &app.events);
                    app.project_polling.tick(
                        &app.projects,
                        app.git.clone(),
                        app.events.clone(),
                        app.sessions.clone(),
                        app.costs.clone(),
                    );
                }
            })
            .await;
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    let account_watch = tokio::spawn(events::watch_accounts(
        state.accounts.clone(),
        state.events.clone(),
    ));
    let workers_app = state.clone();
    let workers = tokio::spawn(async move {
        let mut runner = board::WorkerRunner::default();
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let app = workers_app.clone();
            runner = tokio::task::spawn_blocking(move || {
                if !app.terminals.is_closing() {
                    if app.terminals.restore(&app.projects, &app.board).is_err() {
                        eprintln!("Worker terminal restore deferred");
                    }
                    if runner.tick(&app.board, &app.terminals, port).is_err() {
                        eprintln!("Worker supervision check deferred");
                    }
                }
                runner
            })
            .await
            .unwrap_or_default();
        }
    });
    let reviewers_app = state.clone();
    let reviewers = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let app = reviewers_app.clone();
            let result = tokio::task::spawn_blocking(move || {
                board::review_tick(&app.board, &app.terminals, port)
            })
            .await;
            if !matches!(result, Ok(Ok(()))) {
                eprintln!("Supervisor review deferred");
            }
        }
    });
    let maintenance_app = state.clone();
    let maintenance = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let app = maintenance_app.clone();
            let result = tokio::task::spawn_blocking(move || {
                app.terminals
                    .maintain(&app.projects, &app.board)
                    .map_err(|error| error.to_string())?;
                app.save_recovery_history()
            })
            .await;
            if !matches!(result, Ok(Ok(()))) {
                eprintln!("Terminal checkpoint maintenance failed");
            }
        }
    });
    let scan_app = state.clone();
    let agent_scan = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let app = scan_app.clone();
            let _ = tokio::task::spawn_blocking(move || app.terminals.scan_agents()).await;
        }
    });
    let wakeup_app = state.clone();
    let session_wakeup = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = wakeup_app.schedule_cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(5)) => {},
            }
            tokio::select! {
                _ = wakeup_app.schedule_cancel.cancelled() => break,
                _ = wakeup_app.session_wakeup.tick(wakeup_app.terminals.clone()) => {},
            }
        }
    });
    // Install handlers before announcing readiness. The client may immediately
    // stop a ready server, before Axum first polls its shutdown future.
    #[cfg(unix)]
    let shutdown_signal = {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
        async move {
            tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        }
    };
    #[cfg(not(unix))]
    let shutdown_signal = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    println!(
        "{}",
        json!({"listening": listener.local_addr()?.to_string(), "runtime": "rust", "productionReady": false})
    );
    let telegram_app = state.clone();
    let telegram_start = tokio::spawn(async move {
        if telegram_app.telegram.enabled() {
            telegram_app.telegram.start_polling().await;
        }
    });
    let signal = state.restart.signal.clone();
    let combined_shutdown = async move {
        tokio::select! { _ = shutdown_signal => {}, _ = signal.cancelled() => {} }
    };
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown(state.clone(), combined_shutdown))
    .await?;
    let _ = telegram_start.await;
    maintenance.abort();
    agent_scan.abort();
    session_wakeup.abort();
    workers.abort();
    reviewers.abort();
    account_watch.abort();
    project_polling.abort();
    paste_cleanup.abort();
    Ok(if state.restart.committed() { 75 } else { 0 })
}

async fn shutdown(app: Arc<App>, signal: impl std::future::Future<Output = ()>) {
    signal.await;
    app.closing
        .store(true, std::sync::atomic::Ordering::Release);
    app.connections.stop();
    app.aws_connect.shutdown().await;
    app.project_polling.stop();
    app.telegram.stop_polling().await;
    app.telegram_commands.shutdown().await;
    app.background.shutdown().await;
    app.agent_runtime.shutdown(&app.agent).await;
    app.events.close();
    app.git.shutdown();
    app.supervisor.shutdown();
    app.schedule_cancel.cancel();
    let schedules = app.schedule_task.lock().unwrap().take();
    let summaries = app.summary_task.lock().unwrap().take();
    tokio::join!(
        async {
            if let Some(task) = schedules {
                let _ = task.await;
            }
        },
        async {
            if let Some(task) = summaries {
                let _ = task.await;
            }
        },
        app.workflows.shutdown(),
        app.telegram.shutdown(),
        app.dev_servers.shutdown(),
        app.batch.shutdown()
    );
    let _ = tokio::task::spawn_blocking(move || match app.terminals.shutdown() {
        Err(error) => eprintln!("Terminal shutdown checkpoint failed: {error}"),
        Ok(()) => {
            if let Err(error) = app.save_recovery_history() {
                eprintln!("Recovery history save failed: {error}");
            }
        }
    })
    .await;
}

fn summary_text(agent: &str, raw: &str) -> Option<String> {
    static ANSI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static AGENT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let ansi = ANSI.get_or_init(|| regex::Regex::new(
        r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][0-9A-B]|[\r\x00-\x08\x0b\x0c\x0e-\x1f]"
    ).unwrap());
    let cleaned = ansi.replace_all(raw, "");
    let units: Vec<_> = cleaned.encode_utf16().collect();
    let text = String::from_utf16_lossy(&units[units.len().saturating_sub(3500)..]);
    let agents = AGENT
        .get_or_init(|| regex::Regex::new(r"(?i-u)\b(claude|codex|opencode|jcode)\b").unwrap());
    agents.is_match(&format!("{agent} {text}")).then_some(text)
}

#[cfg(test)]
mod summary_tests {
    use super::summary_text;

    #[test]
    fn activity_summary_strips_terminal_controls_and_requires_agent_context() {
        assert_eq!(summary_text("", "ordinary shell output"), None);
        assert_eq!(summary_text("", "myjcodehelper"), None);
        assert_eq!(
            summary_text("", "\x1b[32mJCODE\x1b[0m\r\n작업 중\x1b]0;title\x07"),
            Some("JCODE\n작업 중".into())
        );
        assert_eq!(
            summary_text("claude", "결제 테스트 수정 중"),
            Some("결제 테스트 수정 중".into())
        );
        assert_eq!(
            summary_text("codex", &"😀".repeat(2000))
                .unwrap()
                .encode_utf16()
                .count(),
            3500
        );
        assert_eq!(
            summary_text("", &format!("claude{}", "x".repeat(4000))),
            None
        );
    }
}

fn error(status: u16, message: &str) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        Json(json!({"error":message})),
    )
        .into_response()
}

fn decoded_id(segment: &str) -> Option<String> {
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .ok()
        .filter(|id| !id.is_empty() && !id.contains('/') && !id.chars().any(char::is_control))
        .map(|id| id.into_owned())
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

fn local(ip: IpAddr, headers: &HeaderMap) -> bool {
    let loopback = match ip {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => {
            ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback())
        }
    };
    loopback
        && !["x-forwarded-for", "forwarded", "tailscale-user-login"]
            .iter()
            .any(|name| headers.contains_key(*name))
}

fn host_allowed(headers: &HeaderMap, connections: &system_connections::Store) -> bool {
    let raw = header(headers, "host");
    let Ok(authority) = raw.parse::<axum::http::uri::Authority>() else {
        return false;
    };
    let host = authority
        .host()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || host.ends_with(".ts.net")
        || connections.host_allowed(&host)
}

fn same_origin(headers: &HeaderMap, is_local: bool) -> bool {
    let source = if !header(headers, "origin").is_empty() {
        header(headers, "origin")
    } else {
        header(headers, "referer")
    };
    if source.is_empty() {
        return is_local;
    }
    let Ok(url) = url::Url::parse(source) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    &url[url::Position::BeforeHost..url::Position::AfterPort] == header(headers, "host")
}

fn token_matches(candidate: &str, token: &str) -> bool {
    !candidate.is_empty() && candidate.as_bytes().ct_eq(token.as_bytes()).into()
}

fn cookie_token(headers: &HeaderMap) -> &str {
    header(headers, "cookie")
        .split(';')
        .filter_map(|entry| entry.trim().split_once('='))
        .filter(|(key, _)| *key == COOKIE)
        .map(|(_, value)| value.trim())
        .next_back()
        .unwrap_or("")
}

fn set_cookie(response: &mut Response, headers: &HeaderMap, token: &str) {
    let secure = if header(headers, "x-forwarded-proto") == "https" {
        ";Secure"
    } else {
        ""
    };
    let cookie =
        format!("{COOKIE}={token};path=/;max-age=31536000;SameSite=Strict;HttpOnly{secure}");
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&cookie).expect("validated token"),
    );
}

fn limited(app: &App, ip: IpAddr, kind: &'static str, limit: u32) -> bool {
    let mut rates = app.rates.lock().unwrap();
    rates.retain(|_, (start, _)| start.elapsed() < Duration::from_secs(60));
    if rates.len() >= 4096 && !rates.contains_key(&(ip, kind)) {
        return false;
    }
    let entry = rates.entry((ip, kind)).or_insert((Instant::now(), 0));
    entry.1 += 1;
    entry.1 <= limit
}

async fn handle(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request<Body>,
) -> Response {
    let mut response = dispatch(app, peer, request).await;
    for (key, value) in [
        ("x-content-type-options", "nosniff"), ("x-frame-options", "DENY"),
        ("x-xss-protection", "0"), ("referrer-policy", "strict-origin-when-cross-origin"),
        ("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self' ws://localhost:* http://localhost:*; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net"),
    ] { response.headers_mut().insert(key, HeaderValue::from_static(value)); }
    response
}

async fn dispatch(app: Arc<App>, peer: SocketAddr, request: Request<Body>) -> Response {
    let (mut parts, body) = request.into_parts();
    let path = parts.uri.path();
    let headers = &parts.headers;
    if !host_allowed(headers, &app.connections) {
        return (StatusCode::FORBIDDEN, "Forbidden: host not allowed").into_response();
    }
    let is_local = local(peer.ip(), headers);
    let query_token = url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes())
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    if header(headers, "upgrade").eq_ignore_ascii_case("websocket") {
        if !is_local
            && !token_matches(&query_token, &app.token)
            && !token_matches(cookie_token(headers), &app.token)
        {
            return error(403, "WebSocket authentication failed");
        }
        if headers.contains_key("origin") && !same_origin(headers, false) {
            return error(403, "WebSocket origin rejected");
        }
        let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(upgrade) => upgrade,
            Err(error) => return error.into_response(),
        };
        return upgrade
            .max_message_size(8 * 1024 * 1024)
            .max_frame_size(8 * 1024 * 1024)
            .on_upgrade(move |socket| terminals::connection(socket, app));
    }
    if !is_local && token_matches(&query_token, &app.token) {
        let mut response = html("<html><head><meta http-equiv=\"refresh\" content=\"0;url=/\"></head><body>Redirecting...</body></html>");
        set_cookie(&mut response, headers, &app.token);
        return response;
    }
    if !is_local && !token_matches(cookie_token(headers), &app.token) && path != "/api/auth/login" {
        if aws_connect::route(&parts.method, path) {
            return error(
                401,
                "콕핏 로그인이 필요합니다. 페이지를 새로고침해 로그인하세요.",
            );
        }
        return html(include_str!("login.html"));
    }
    if !matches!(parts.method, Method::GET | Method::HEAD | Method::OPTIONS)
        && !same_origin(headers, is_local)
    {
        return error(403, "CSRF check failed");
    }
    if path == "/api/migration/status" && parts.method == Method::GET {
        let native_routes: Vec<_> = NATIVE_ROUTES
            .iter()
            .chain(projects::ROUTES)
            .chain(terminals::ROUTES)
            .chain(board::ROUTES)
            .chain(accounts::ROUTES)
            .chain(approval_watcher::ROUTES)
            .chain(git::ROUTES)
            .chain(github::ROUTES)
            .chain(sessions::ROUTES)
            .chain(cicd::ROUTES)
            .chain(dev_servers::ROUTES)
            .chain(system_files::ROUTES)
            .chain(reports::ROUTES)
            .chain(aws_connect::ROUTES)
            .chain(system::ROUTES)
            .chain(system_connections::ROUTES)
            .chain(batch::ROUTES)
            .chain(briefing::ROUTES)
            .chain(agent::ROUTES)
            .chain(background_agents::ROUTES)
            .chain(ai_config::ROUTES)
            .chain(ports::ROUTES)
            .chain(workflow_schedule::ROUTES)
            .chain(workflows::ROUTES)
            .chain(autopilot::ROUTES)
            .chain(supervisor::ROUTES)
            .chain(telegram::ROUTES)
            .collect();
        return Json(
            json!({"runtime":"rust", "productionReady":false, "nativeRoutes":native_routes,
            "remaining":["production handover", "launcher and platform parity"],
            "storage":if app.legacy_layout {"legacy-operating-layout"} else {"isolated-preview"}}),
        )
        .into_response();
    }
    if path == "/api/events" && parts.method == Method::GET {
        return app.events.connect_with_initial(|| {
            let mut initial = app.project_polling.initial();
            initial["devServers"] = app.dev_servers.snapshot();
            initial
        });
    }
    if path == "/api/server/restart" && parts.method == Method::POST {
        return match server_restart::prepare(app.clone()).await {
            Ok(prepared) => {
                let terminal_count = prepared.terminal_count;
                prepared.schedule();
                Json(json!({"restarting":true, "terminalCount":terminal_count})).into_response()
            }
            Err(message) => error(409, &message),
        };
    }
    if let Some(id) = session_wakeup::route(&parts.method, path) {
        return session_wakeup::handle(app.clone(), &parts.method, id, body, is_local).await;
    }
    if aws_connect::route(&parts.method, path) {
        return app.aws_connect.handle(&parts.method, path, body).await;
    }
    let files_route = system_files::route(&parts.method, path);
    let reports_route = reports::route(&parts.method, path);
    if files_route && parts.method == Method::POST {
        let content_type = header(headers, "content-type").to_owned();
        if let Some(response) = system_files::upload_header_error(path, &content_type) {
            return response;
        }
        let bytes =
            match tokio::time::timeout(Duration::from_secs(10), to_bytes(body, MAX_BODY)).await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(_)) => {
                    return error(
                        413,
                        if path == "/api/uploads" {
                            "file too large (>10MB)"
                        } else {
                            "File too large (max 10 MB)"
                        },
                    )
                }
                Err(_) => return error(408, "Request body timeout"),
            };
        let path = path.to_owned();
        return tokio::task::spawn_blocking(move || {
            app.system_files
                .handle(&path, &HashMap::new(), &content_type, &bytes, &app.projects)
        })
        .await
        .unwrap_or_else(|_| error(500, "File storage operation failed"));
    }
    let login = path == "/api/auth/login" && parts.method == Method::POST;
    if reports_route && parts.method != Method::GET && !is_local {
        return error(403, "보고서 등록과 목록 제거는 로컬에서 가능합니다.");
    }
    let notes = path == "/api/notes"
        || path
            .strip_prefix("/api/notes/")
            .is_some_and(|id| !id.is_empty() && !id.contains('/'));
    let project = projects::Store::handles(&parts.method, path);
    let board = board::Store::handles(&parts.method, path);
    let account = accounts::Store::route(&parts.method, path);
    let git_route = git::route(&parts.method, path);
    let session_route = sessions::route(&parts.method, path);
    let cicd_route = cicd::route(&parts.method, path);
    let system_route = system::route(&parts.method, path);
    let connections_route = system_connections::route(&parts.method, path);
    let notify_toggle = parts.method == Method::POST && path == "/api/notify/toggle";
    if parts.method == Method::POST
        && path == "/api/agent/tts"
        && !limited(&app, peer.ip(), "tts", 15)
    {
        return error(429, "Too many TTS requests");
    }
    let batch_route = batch::route(&parts.method, path);
    let briefing_route = briefing::route(&parts.method, path);
    let agent_route = agent::route(&parts.method, path);
    let monitor_route = background_agents::route(&parts.method, path);
    if parts.method == Method::POST
        && path == "/api/agent/chat"
        && !limited(&app, peer.ip(), "agent-chat", 30)
    {
        return error(429, "Too many requests — please wait");
    }
    let ai_config_route = ai_config::route(&parts.method, path);
    let schedule_route = workflow_schedule::route(&parts.method, path);
    let workflow_route = workflows::route(&parts.method, path);
    let autopilot_route = autopilot::route(&parts.method, path);
    let supervisor_route = supervisor::route(&parts.method, path);
    let telegram_route = telegram::route(&parts.method, path);
    let ports_route = ports::route(&parts.method, path);
    if ports_route && parts.method == Method::POST && !is_local {
        return error(403, "Forbidden");
    }
    if dev_servers::route(&parts.method, path) {
        return app
            .dev_servers
            .handle(&parts.method, path, &app.projects)
            .await;
    }
    let delegate = parts.method == Method::POST && path == "/api/agent/delegate-status";
    if delegate {
        if !is_local {
            return error(403, "Forbidden");
        }
        if !limited(&app, peer.ip(), "delegate", 120) {
            return error(429, "Too many requests");
        }
    }
    let github_route = github::route(&parts.method, path);
    let polling_speed = parts.method == Method::POST && path == "/api/polling-speed";
    if approval_watcher::ROUTES
        .iter()
        .any(|(method, route)| parts.method.as_str() == *method && path == *route)
    {
        if !is_local {
            return error(403, "승인 스크립트 관리는 로컬에서만 가능합니다.");
        }
        return match app
            .approval_watcher
            .handle(parts.method == Method::POST)
            .await
        {
            Ok(value) => Json(value).into_response(),
            Err(message) => error(500, &message),
        };
    }
    let terminal_control = terminals::control_route(&parts.method, path);
    if terminal_control
        .as_ref()
        .is_some_and(|(_, route)| *route != "/conversation")
        && !is_local
    {
        return error(403, "로컬에서만 세션을 제어할 수 있습니다.");
    }
    if terminal_control
        .as_ref()
        .is_some_and(|(_, route)| *route == "/input")
        && !limited(&app, peer.ip(), "term-input", 60)
    {
        return error(429, "Too many requests");
    }
    if login && !limited(&app, peer.ip(), "auth", 10) {
        let mut response = error(429, "Too many login attempts. Try again in 1 minute.");
        response
            .headers_mut()
            .insert("retry-after", HeaderValue::from_static("60"));
        return response;
    }
    if path == "/api/notes"
        && parts.method == Method::POST
        && !limited(&app, peer.ip(), "notes", 30)
    {
        return error(429, "Too many requests");
    }
    let data = if login
        || ((notes
            || reports_route
            || project
            || board
            || account.is_some()
            || terminal_control.is_some()
            || git_route.is_some()
            || delegate
            || github_route.is_some()
            || cicd_route
            || system_route
            || connections_route
            || notify_toggle
            || batch_route
            || briefing_route
            || agent_route
            || monitor_route
            || ai_config_route
            || schedule_route
            || workflow_route
            || autopilot_route
            || supervisor_route
            || telegram_route
            || ports_route
            || polling_speed)
            && matches!(parts.method, Method::POST | Method::PUT | Method::PATCH))
    {
        match tokio::time::timeout(Duration::from_secs(10), to_bytes(body, MAX_BODY)).await {
            Ok(Ok(bytes)) if bytes.is_empty() => json_values::Object::new(),
            Ok(Ok(bytes)) => match serde_json::from_slice::<json_values::Object>(&bytes) {
                Ok(data) => data,
                Err(_) => return error(400, "Invalid JSON"),
            },
            Ok(Err(_)) => return error(413, "Request body too large"),
            Err(_) => return error(408, "Request body timeout"),
        }
    } else {
        json_values::Object::new()
    };
    if login {
        let token = data
            .get("token")
            .and_then(|value| serde_json::from_str::<String>(value.get()).ok());
        if !token_matches(token.as_deref().unwrap_or(""), &app.token) {
            return error(401, "Invalid token");
        }
        let mut response = Json(json!({"success":true})).into_response();
        set_cookie(&mut response, headers, &app.token);
        return response;
    }
    let path = path.to_string();
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    if git_route.is_some()
        || github_route.is_some()
        || polling_speed
        || cicd_route
        || batch_route
        || ai_config_route
        || ports_route
        || workflow_route
        || autopilot_route
        || supervisor_route
        || telegram_route
        || monitor_route
        || connections_route
        || notify_toggle
    {
        let input = match board_value::V::parse(&serde_json::value::to_raw_value(&data).unwrap()) {
            Ok(input) => input,
            Err(_) => return error(400, "Invalid JSON"),
        };
        if polling_speed {
            return Json(json!({"speed":app.project_polling.set_speed(&input["multiplier"])}))
                .into_response();
        }
        if notify_toggle {
            return Json(
                json!({"enabled":app.project_polling.set_notifications(&input["enabled"])}),
            )
            .into_response();
        }
        if connections_route {
            return app
                .connections
                .handle(&app, &path, &input, &query, is_local)
                .await;
        }
        if ai_config_route {
            return app.ai_config.handle(&parts.method, &path, &input).await;
        }
        if monitor_route {
            return app
                .background
                .handle(app.clone(), &parts.method, &path, &input)
                .await;
        }
        if ports_route {
            return ports::handle(&parts.method, &path, &input, &app.dev_servers).await;
        }
        if workflow_route {
            return app.workflows.handle(&parts.method, &path, &input).await;
        }
        if autopilot_route {
            return app.autopilot.handle(&parts.method, &path, &input).await;
        }
        if supervisor_route {
            let raw_input = data.get(if input["tool_input"].truthy() {
                "tool_input"
            } else {
                "input"
            });
            return app
                .supervisor
                .handle(
                    &parts.method,
                    &path,
                    parts.uri.query().unwrap_or(""),
                    &input,
                    raw_input.map(Box::as_ref),
                )
                .await;
        }
        if telegram_route {
            return app.telegram.handle(&parts.method, &path, &input).await;
        }
        if cicd_route {
            return app.cicd.handle(&path, &query, input, &app.projects).await;
        }
        if batch_route {
            return app
                .batch
                .handle(&parts.method, &path, input, &app.projects)
                .await;
        }
        if let Some((id, route)) = git_route {
            let worktrees = decoded_id(&id)
                .map(|id| app.project_polling.cached(&id, "git")["worktrees"].clone())
                .filter(|v| v.is_array())
                .unwrap_or(board_value::V::Array(vec![]));
            return app
                .git
                .handle(&app.projects, &id, &route, &query, input, worktrees)
                .await;
        }
        if let Some((id, route)) = github_route {
            return github::handle(&app.projects, &id, &route, &query, input).await;
        }
    }
    tokio::task::spawn_blocking(move || {
        if reports_route {
            return app.reports.handle(
                &parts.method,
                &path,
                &serde_json::to_value(&data).unwrap(),
                &app.projects,
            );
        }
        if schedule_route {
            let input =
                match board_value::V::parse(&serde_json::value::to_raw_value(&data).unwrap()) {
                    Ok(input) => input,
                    Err(_) => return error(400, "Invalid JSON"),
                };
            return app.workflow_schedule.handle(&parts.method, &path, &input);
        }
        if agent_route {
            let input =
                match board_value::V::parse(&serde_json::value::to_raw_value(&data).unwrap()) {
                    Ok(input) => input,
                    Err(_) => return error(400, "Invalid JSON"),
                };
            if path == "/api/agent/chat" {
                if !input["convId"].truthy() || !input["message"].truthy() {
                    return error(400, "convId and message required");
                }
                return match app.agent_runtime.start(app.clone(), &input) {
                    Ok(value) => Json(value.raw()).into_response(),
                    Err(message) => error(500, &message),
                };
            }
            if path == "/api/agent/stop" {
                if !input["convId"].truthy() {
                    return error(400, "convId required");
                }
                return match agent_prompt::string(&input["convId"]) {
                    Ok(id) => Json(app.agent.stop(&id.text()).raw()).into_response(),
                    Err(e) => error(500, &e),
                };
            }
            return app.agent.handle(&parts.method, &path, &input);
        }
        if briefing_route {
            let input =
                match board_value::V::parse(&serde_json::value::to_raw_value(&data).unwrap()) {
                    Ok(input) => input,
                    Err(_) => return error(400, "Invalid JSON"),
                };
            return app.briefing.handle(
                &parts.method,
                &path,
                input,
                &app.projects,
                &app.project_polling,
            );
        }
        if files_route {
            return app
                .system_files
                .handle(&path, &query, "", &[], &app.projects);
        }
        if system_route {
            if path == "/api/health" {
                return app.system.health(&app);
            }
            let input =
                match board_value::V::parse(&serde_json::value::to_raw_value(&data).unwrap()) {
                    Ok(input) => input,
                    Err(_) => return error(400, "Invalid JSON"),
                };
            return system::open(&path, input, &app.projects);
        }
        if delegate {
            let input =
                board_value::V::parse(&serde_json::value::to_raw_value(&data).unwrap()).unwrap();
            if !sessions::valid_delegate(&input) {
                return error(400, "Invalid delegate status");
            }
            let Some(state) = app.sessions.delegate(&input, &app.projects, &app.terminals) else {
                return error(404, "Project not found");
            };
            app.events.publish_raw("session:status", state.raw().get());
            return Json(
                board_value::object([
                    ("projectId", state["projectId"].clone()),
                    ("state", state["state"].clone()),
                ])
                .raw(),
            )
            .into_response();
        }
        if parts.method == Method::GET {
            let cached = |kind| app.project_polling.cached("", kind);
            let value = match path.as_str() {
                "/api/usage" => Some(app.costs.compute()),
                "/api/cost/daily" => Some({
                    let value = cached("cost");
                    if value == board_value::V::Null {
                        app.costs.compute()
                    } else {
                        value
                    }
                }),
                "/api/cost/insights" => Some(app.costs.insights()),
                "/api/stats" => Some({
                    let value = app.costs.stats();
                    if value.truthy() {
                        value
                    } else {
                        board_value::V::object()
                    }
                }),
                "/api/activity" => Some({
                    let value = cached("activity");
                    if value == board_value::V::Null {
                        app.sessions.activity()
                    } else {
                        value
                    }
                }),
                _ => None,
            };
            if let Some(value) = value {
                return Json(value.raw()).into_response();
            }
            if session_route {
                return app.sessions.handle(&path, &query, &app.projects);
            }
        }
        if let Some((id, route)) = account {
            return app.accounts.handle(&id, route, data);
        }
        if let Some((id, route)) = terminal_control {
            return app
                .terminals
                .handle_control(&id, route, data, is_local, &app.board);
        }
        if board {
            return app
                .board
                .handle(parts.method, &path, &query, data, is_local, &app.terminals);
        }
        if parts.method == Method::GET && path == "/api/terminals" {
            return Json(
                app.terminals
                    .summary(query.get("activity").is_some_and(|value| value == "1")),
            )
            .into_response();
        }
        if parts.method == Method::GET {
            if let Some(id) = path
                .strip_prefix("/api/terminals/")
                .and_then(|path| path.strip_suffix("/screen"))
                .filter(|id| !id.is_empty() && !id.contains('/'))
            {
                if !is_local {
                    return error(403, "Forbidden — 로컬에서만 읽을 수 있습니다.");
                }
                let Some(id) = decoded_id(id) else {
                    return error(400, "Invalid terminal ID");
                };
                let lines = query
                    .get("lines")
                    .and_then(|v| v.parse::<i64>().ok())
                    .filter(|n| *n != 0)
                    .unwrap_or(50)
                    .clamp(1, 500) as usize;
                let prefer_current = query.get("current").is_some_and(|value| value == "1");
                return app
                    .terminals
                    .screen(&id, lines, prefer_current)
                    .map(|value| Json(value).into_response())
                    .unwrap_or_else(|| error(404, "Terminal not found"));
            }
        }
        if project {
            let response = app.projects.handle(
                parts.method,
                &path,
                &query,
                data,
                is_local,
                &app.project_polling,
            );
            if response.status().is_success() {
                app.project_polling.tick(
                    &app.projects,
                    app.git.clone(),
                    app.events.clone(),
                    app.sessions.clone(),
                    app.costs.clone(),
                );
            }
            return response;
        }
        if notes {
            return app.notes.handle(parts.method, &path, data);
        }
        if parts.method == Method::GET {
            if let Some(response) = static_file(&app.root, &path) {
                return response;
            }
        }
        if path.starts_with("/api/") {
            return error(
                501,
                "Rust migration incomplete: this endpoint is not implemented",
            );
        }
        (StatusCode::NOT_FOUND, "Not Found").into_response()
    })
    .await
    .unwrap_or_else(|_| error(500, "Request handler failed"))
}

fn html(content: &str) -> Response {
    let mut response = content.to_string().into_response();
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

fn static_file(root: &Path, path: &str) -> Option<Response> {
    let (relative, mime) = match path {
        "/" => ("index.html", "text/html; charset=utf-8"),
        "/manifest.json" => ("manifest.json", "application/manifest+json; charset=utf-8"),
        "/sw.js" => ("sw.js", "text/javascript; charset=utf-8"),
        _ => {
            let relative = path.strip_prefix('/')?;
            let (directory, name) = relative.rsplit_once('/')?;
            if name.contains("..")
                || name.is_empty()
                || !name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            {
                return None;
            }
            let mime = match directory {
                "js" if name.ends_with(".js") => "text/javascript; charset=utf-8",
                "css" if name.ends_with(".css") => "text/css; charset=utf-8",
                "vendor/fonts" => {
                    if name.ends_with(".woff2") {
                        "font/woff2"
                    } else if name.ends_with(".woff") {
                        "font/woff"
                    } else if name.ends_with(".ttf") {
                        "font/ttf"
                    } else {
                        "application/octet-stream"
                    }
                }
                "vendor" => {
                    if name.ends_with(".css") {
                        "text/css; charset=utf-8"
                    } else {
                        "text/javascript; charset=utf-8"
                    }
                }
                _ => return None,
            };
            (relative, mime)
        }
    };
    // A symlink can expose private files even when its target is inside the app.
    let expected = root.join(relative);
    let file = expected.canonicalize().ok()?;
    if file != expected {
        return None;
    }
    let mut response = fs::read(file).ok()?.into_response();
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static(mime));
    if path != "/manifest.json" && path != "/sw.js" {
        response.headers_mut().insert(
            "cache-control",
            HeaderValue::from_static(if path.starts_with("/vendor/fonts/") {
                "public, max-age=31536000"
            } else {
                "no-store"
            }),
        );
    }
    if path == "/sw.js" {
        response
            .headers_mut()
            .insert("service-worker-allowed", HeaderValue::from_static("/"));
    }
    Some(response)
}
