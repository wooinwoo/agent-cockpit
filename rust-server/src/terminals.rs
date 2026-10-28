use crate::{
    activity,
    ai_transport::Cancel,
    commands, projects,
    terminal_buffer::{Decoder, Replay},
};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{stream, SinkExt, StreamExt};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
#[path = "terminal_account_handoff.rs"]
mod account_handoff;
#[path = "terminal_control.rs"]
mod control;
#[path = "terminal_maintenance.rs"]
mod maintenance;
#[path = "terminal_accounts.rs"]
mod native_accounts;
#[path = "terminal_recovery.rs"]
mod recovery;
pub(crate) use control::control_route;
use control::WriteRequest;

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/terminals"),
    ("GET", "/api/terminals/:ref/screen"),
    ("POST", "/api/terminals/:ref/input"),
    ("PUT", "/api/terminals/:ref/conversation"),
    ("PUT", "/api/terminals/:ref/launcher"),
    ("GET", "/api/terminals/maintenance"),
    ("POST", "/api/terminals/maintenance"),
    ("GET", "/api/terminals/:ref/accounts"),
    ("POST", "/api/terminals/:ref/account"),
    ("POST", "/api/terminals/accounts/prepare"),
];
fn err(message: impl ToString) -> io::Error {
    io::Error::other(message.to_string())
}
fn check_creation_cancel(cancel: Option<&Cancel>) -> io::Result<()> {
    if cancel.is_some_and(Cancel::is_cancelled) {
        Err(err("Agent request cancelled"))
    } else {
        Ok(())
    }
}
struct PendingCreation(Cancel);
impl Drop for PendingCreation {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
async fn create_blocking(
    cancel: &Cancel,
    create: impl FnOnce(Cancel) -> io::Result<String> + Send + 'static,
) -> io::Result<String> {
    check_creation_cancel(Some(cancel))?;
    let child = cancel.child();
    let _pending = PendingCreation(child.clone());
    let task = tokio::task::spawn_blocking(move || create(child));
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(err("Agent request cancelled")),
        result = task => result.map_err(|_| err("Terminal creation task failed"))?,
    }
}
fn now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
}
fn value_text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn valid_size(value: &Value) -> Option<PtySize> {
    let cols = value["cols"].as_u64()?;
    let rows = value["rows"].as_u64()?;
    if !(2..=1000).contains(&cols) || !(1..=500).contains(&rows) {
        return None;
    }
    Some(PtySize {
        cols: cols as u16,
        rows: rows as u16,
        pixel_width: 0,
        pixel_height: 0,
    })
}
fn durable_id(id: &str) -> bool {
    id.len() == 24
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn terminal_id(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.chars().any(char::is_control)
}
fn new_incarnation() -> String {
    format!("{:032x}", rand::random::<u128>())
}
fn require_incarnation(saved: &Value, token: &str) -> io::Result<()> {
    if token.len() != 32
        || !token
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || value_text(saved, "incarnation") != token
    {
        return Err(err(
            "세션 incarnation이 없거나 변경되었습니다. 현재 상태를 다시 확인하세요.",
        ));
    }
    Ok(())
}
fn safe_command(command: &str) -> String {
    const PROGRAMS: &[&str] = &[
        "claude",
        "codex",
        "opencode",
        "jcode",
        "npm",
        "npx",
        "node",
        "git",
        "python",
        "pip",
        "docker",
        "yarn",
        "pnpm",
        "bun",
        "cargo",
        "make",
        "cmake",
        "go",
        "rustc",
        "ruby",
        "java",
        "javac",
        "mvn",
        "gradle",
        "dotnet",
        "terraform",
        "kubectl",
        "helm",
        "ansible",
        "packer",
        "deno",
        "tsx",
        "ts-node",
        "jest",
        "vitest",
        "pytest",
        "eslint",
        "prettier",
        "tsc",
    ];
    if command.encode_utf16().count() >= 500
        || command
            .chars()
            .any(|c| c.is_control() || "&|<>^;`$".contains(c))
        || !PROGRAMS.contains(&command.split_whitespace().next().unwrap_or(""))
    {
        String::new()
    } else {
        command.to_string()
    }
}
fn recovery_command(command: &str) -> bool {
    command.len() <= 500
        && Regex::new(r"^(claude|codex|opencode|jcode)(?: --?[A-Za-z0-9][A-Za-z0-9_.=-]*)*$")
            .unwrap()
            .is_match(command)
}
fn permission_command(command: &str, permissions: &crate::board_value::V) -> String {
    match (command,permissions[command].text().as_str()) {
        ("codex","workspace")=>"codex --no-daemon --sandbox=workspace-write --ask-for-approval=never",
        ("codex","network")=>"codex --no-daemon --sandbox=workspace-write --ask-for-approval=never --config=sandbox_workspace_write.network_access=true --config=check_for_update_on_startup=false",
        ("codex","full")=>"codex --no-daemon --dangerously-bypass-approvals-and-sandbox --config=check_for_update_on_startup=false",
        ("claude","edits")=>"claude --permission-mode=acceptEdits",
        ("claude","auto")=>"claude --permission-mode=auto",
        ("claude","full")=>"claude --dangerously-skip-permissions",
        _=>command,
    }.into()
}

struct Meta {
    saved: Value,
    conversation_dirty: bool,
    replay: Replay,
    output_count: u64,
    owner: Option<u64>,
    agent: Option<String>,
}
pub(crate) struct AgentScreen {
    pub held: bool,
    pub agent: Option<String>,
    pub lines: Vec<String>,
    pub current: bool,
}
impl AgentScreen {
    pub fn state(&self) -> &'static str {
        match self.agent.as_deref() {
            Some("") => "offline",
            Some(agent) => activity::screen_state(&self.lines, self.current, agent, false, false),
            None => "unknown",
        }
    }
}
struct Entry {
    id: String,
    durable: String,
    pid: Option<u32>,
    meta: Mutex<Meta>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: mpsc::SyncSender<WriteRequest>,
    control: Mutex<()>,
    input_generation: std::sync::atomic::AtomicU64,
    exited: std::sync::atomic::AtomicBool,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}
struct State {
    entries: Vec<Arc<Entry>>,
    deferred: Vec<Value>,
    restored: bool,
    closing: bool,
    checkpoint: Value,
}
pub struct Store {
    directory: PathBuf,
    tmux_dir: Option<PathBuf>,
    home: PathBuf,
    durable: bool,
    shell: String,
    accounts: Arc<crate::accounts::Store>,
    state: Mutex<State>,
    operations: Mutex<()>,
    pub events: broadcast::Sender<Value>,
    event_gate: Arc<Mutex<()>>,
    last_mcp_sweep: std::sync::atomic::AtomicU64,
}

struct PendingPane<'a> {
    store: &'a Store,
    id: String,
    armed: bool,
}
impl Drop for PendingPane<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.store.tmux(&self.id, &["kill-server"], None, "");
        }
    }
}

impl Store {
    pub fn durable_enabled(&self) -> bool {
        self.durable
    }

    pub fn new(directory: PathBuf, accounts: Arc<crate::accounts::Store>) -> io::Result<Arc<Self>> {
        let tmux_dir = directory.join("tmux");
        let home = directory.join("home");
        for path in [&tmux_dir, &home] {
            fs::create_dir_all(path)?;
            if fs::symlink_metadata(path)?.file_type().is_symlink() {
                return Err(err("Invalid terminal preview directory"));
            }
        }
        Self::open(directory, accounts, home, Some(tmux_dir))
    }

    /// Reuse Node's data directory, home and inherited tmux socket namespace.
    pub fn new_legacy(
        directory: PathBuf,
        accounts: Arc<crate::accounts::Store>,
        home: PathBuf,
    ) -> io::Result<Arc<Self>> {
        if !home.is_absolute() || !fs::metadata(&home)?.is_dir() {
            return Err(err(
                "Legacy terminal home must be an existing absolute directory",
            ));
        }
        if !fs::metadata(&directory)?.is_dir() {
            return Err(err("Invalid legacy terminal data directory"));
        }
        Self::open(directory, accounts, home, None)
    }

    fn open(
        directory: PathBuf,
        accounts: Arc<crate::accounts::Store>,
        home: PathBuf,
        tmux_dir: Option<PathBuf>,
    ) -> io::Result<Arc<Self>> {
        let checkpoint_path = directory.join("session-state.json");
        let mut checkpoint: Value = match fs::symlink_metadata(&checkpoint_path) {
            Ok(meta) if !meta.is_file() => return Err(err("Invalid terminal checkpoint file")),
            Ok(_) => serde_json::from_slice(&fs::read(checkpoint_path)?)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                json!({"terminals":[],"timestamp":now()})
            }
            Err(error) => return Err(error),
        };
        let saved = checkpoint["terminals"]
            .as_array()
            .ok_or_else(|| err("Invalid terminal checkpoint"))?
            .clone();
        for value in &saved {
            if !value.is_object()
                || !terminal_id(value_text(value, "termId"))
                || !value["projectId"].is_string()
                || (!value_text(value, "durableId").is_empty()
                    && !durable_id(value_text(value, "durableId")))
            {
                return Err(err("Invalid saved terminal identity"));
            }
        }
        // Legacy history predates incarnation tokens. Issue one in this Store;
        // never accept an unbound resume or disable otherwise valid old history.
        if let Some(items) = checkpoint
            .get_mut("archivedTerminals")
            .and_then(Value::as_array_mut)
        {
            for item in items {
                let saved = &mut item["saved"];
                if saved.is_object()
                    && terminal_id(value_text(saved, "termId"))
                    && require_incarnation(saved, value_text(saved, "incarnation")).is_err()
                {
                    saved["incarnation"] = json!(new_incarnation());
                }
            }
        }
        let (events, _) = broadcast::channel(256);
        Ok(Arc::new(Self {
            directory,
            tmux_dir,
            home,
            accounts,
            durable: cfg!(unix)
                && std::env::var("COCKPIT_DURABLE_TERMINALS").as_deref() != Ok("0")
                && Path::new("/usr/bin/tmux").is_file(),
            shell: std::env::var("SHELL").unwrap_or_else(|_| {
                if cfg!(windows) {
                    "powershell.exe"
                } else {
                    "/bin/bash"
                }
                .into()
            }),
            state: Mutex::new(State {
                entries: Vec::new(),
                deferred: saved,
                restored: false,
                closing: false,
                checkpoint,
            }),
            operations: Mutex::new(()),
            events,
            event_gate: Arc::new(Mutex::new(())),
            last_mcp_sweep: std::sync::atomic::AtomicU64::new(
                (now() as u64).saturating_sub(25 * 60 * 1000),
            ),
        }))
    }

    fn tmux(
        &self,
        id: &str,
        args: &[&str],
        cwd: Option<&Path>,
        term_id: &str,
    ) -> io::Result<String> {
        if args.first() == Some(&"respawn-pane") {
            // Both manual resume and supervisor recovery pass this boundary
            // under operations/control. Invalidate before a possibly partial
            // respawn, including an uncertain command failure.
            let entry = self.find(term_id).ok_or_else(|| err("Terminal changed"))?;
            if entry.id != term_id || entry.durable != id || !durable_id(id) {
                return Err(err("Terminal changed"));
            }
            let _gate = self.event_gate.lock().unwrap();
            entry.meta.lock().unwrap().saved["incarnation"] = json!(new_incarnation());
            self.checkpoint(&mut self.state.lock().unwrap())?;
            self.publish_created(&entry);
        }
        self.tmux_with_account(id, args, cwd, term_id, None)
    }
    fn tmux_with_account(
        &self,
        id: &str,
        args: &[&str],
        cwd: Option<&Path>,
        term_id: &str,
        account: Option<&crate::accounts::Launch>,
    ) -> io::Result<String> {
        if !durable_id(id) {
            return Err(err("Invalid durable terminal id"));
        }
        let mut command = tokio::process::Command::new("/usr/bin/tmux");
        command
            .arg("-L")
            .arg(format!("cockpit-{id}"))
            .args(args)
            .env("COCKPIT_TERM_ID", term_id)
            .env_remove("CLAUDECODE");
        if let Some(tmux_dir) = &self.tmux_dir {
            command.env("TMUX_TMPDIR", tmux_dir);
        }
        if let Some(account) = account {
            account.configure(&mut command);
        }
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let seconds = if matches!(args.first(), Some(&"display-message" | &"capture-pane")) {
            1
        } else {
            3
        };
        tokio::runtime::Handle::current()
            .block_on(commands::output(command, Duration::from_secs(seconds)))
    }

    fn exists(&self, id: &str) -> io::Result<bool> {
        if !durable_id(id) {
            return Err(err("Invalid durable terminal id"));
        }
        let mut command = tokio::process::Command::new("/usr/bin/tmux");
        command
            .args(["-L", &format!("cockpit-{id}"), "has-session", "-t", "main"])
            .env("LC_ALL", "C");
        if let Some(tmux_dir) = &self.tmux_dir {
            command.env("TMUX_TMPDIR", tmux_dir);
        }
        let result = tokio::runtime::Handle::current()
            .block_on(commands::capture(command, Duration::from_secs(3)))?;
        if result.status.success() {
            return Ok(true);
        }
        let message = String::from_utf8_lossy(&result.stderr);
        if message.contains("No such file or directory")
            || message.contains("Connection refused")
            || message.contains("no server running")
        {
            Ok(false)
        } else {
            Err(err("Existing tmux state could not be verified"))
        }
    }

    fn spawn(
        self: &Arc<Self>,
        saved: Value,
        size: PtySize,
        owner: Option<u64>,
        restore: bool,
    ) -> io::Result<Arc<Entry>> {
        self.spawn_cancellable(saved, size, owner, restore, None, None)
    }
    fn spawn_cancellable(
        self: &Arc<Self>,
        mut saved: Value,
        size: PtySize,
        owner: Option<u64>,
        restore: bool,
        cancel: Option<&Cancel>,
        create_request_id: Option<&str>,
    ) -> io::Result<Arc<Entry>> {
        check_creation_cancel(cancel)?;
        let id = value_text(&saved, "termId").to_string();
        let cwd = PathBuf::from(value_text(&saved, "cwd"));
        if !cwd.is_dir() {
            return Err(err("Terminal working directory is unavailable"));
        }
        let mut durable = value_text(&saved, "durableId").to_string();
        if self.durable && durable.is_empty() {
            durable = format!("{:024x}", rand::random::<u128>() & ((1u128 << 96) - 1));
        }
        let resumed = self.durable && self.exists(&durable)?;
        let account = if !value_text(&saved, "accountId").is_empty()
            && !resumed
            && saved["accountEngine"] != "jcode"
        {
            Some(
                self.accounts
                    .launch(value_text(&saved, "accountId"))
                    .map_err(err)?,
            )
        } else {
            None
        };
        if let Some(account) = &account {
            saved["account"] = account.display();
        }
        let mut command;
        let pair = native_pty_system().openpty(size).map_err(err)?;
        let reader = pair.master.try_clone_reader().map_err(err)?;
        let writer = pair.master.take_writer().map_err(err)?;
        let mut pending = PendingPane {
            store: self,
            id: durable.clone(),
            armed: false,
        };
        if self.durable {
            if !resumed {
                check_creation_cancel(cancel)?;
                pending.armed = true;
                let result = self.tmux_with_account(
                    &durable,
                    &[
                        "-f",
                        "/dev/null",
                        "new-session",
                        "-d",
                        "-s",
                        "main",
                        "-c",
                        cwd.to_str().ok_or_else(|| err("Invalid cwd"))?,
                    ],
                    Some(&cwd),
                    &id,
                    account.as_ref(),
                );
                result?;
            }
            self.tmux(&durable, &["set-option", "-g", "status", "off"], None, &id)?;
            self.tmux(&durable, &["set-option", "-g", "mouse", "on"], None, &id)?;
            for (key, page, fallback) in [
                ("WheelUpPane", "PPage", "copy-mode -e"),
                ("WheelDownPane", "NPage", "send-keys -M"),
            ] {
                self.tmux(&durable,&["bind-key","-T","root",key,"if-shell","-F","#{||:#{pane_in_mode},#{mouse_any_flag}}","send-keys -M",&format!("if-shell -F '#{{&&:#{{alternate_on}},#{{==:#{{pane_current_command}},codex}}}}' 'send-keys {page}' '{fallback}'")],None,&id)?;
            }
            command = CommandBuilder::new("/usr/bin/tmux");
            command.args([
                "-L",
                &format!("cockpit-{durable}"),
                "attach-session",
                "-t",
                "main",
            ]);
            if let Some(tmux_dir) = &self.tmux_dir {
                command.env("TMUX_TMPDIR", tmux_dir);
            }
        } else {
            durable.clear();
            command = CommandBuilder::new(&self.shell);
        }
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COCKPIT_TERM_ID", &id);
        command.env_remove("CLAUDECODE");
        if let Some(account) = &account {
            command.env_remove("CLAUDE_CONFIG_DIR");
            command.env_remove("CODEX_HOME");
            command.env(account.env_key(), &account.home);
        }
        check_creation_cancel(cancel)?;
        let mut child = pair.slave.spawn_command(command).map_err(err)?;
        drop(pair.slave);
        let killer = child.clone_killer();
        saved["durableId"] = json!(durable);
        // Never reuse archived/checkpoint tokens, even after server restart.
        saved["incarnation"] = json!(new_incarnation());
        let (tx, rx) = mpsc::sync_channel::<WriteRequest>(32);
        let entry = Arc::new(Entry {
            id: id.clone(),
            durable,
            pid: child.process_id(),
            meta: Mutex::new(Meta {
                saved,
                conversation_dirty: false,
                replay: Replay::default(),
                output_count: 0,
                owner,
                agent: None,
            }),
            master: Mutex::new(pair.master),
            writer: tx,
            control: Mutex::new(()),
            input_generation: std::sync::atomic::AtomicU64::new(0),
            exited: std::sync::atomic::AtomicBool::new(false),
            killer: Mutex::new(killer),
        });
        {
            let _gate = self.event_gate.lock().unwrap();
            self.state.lock().unwrap().entries.push(entry.clone());
            if !restore {
                self.publish_created_correlated(
                    &entry,
                    if resumed { None } else { create_request_id },
                );
            }
        }
        pending.armed = false;
        let writer_events = self.events.clone();
        let writer_id = id.clone();
        let writer_entry = Arc::downgrade(&entry);
        let writer_store = Arc::downgrade(self);
        let writer_runtime = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            let _runtime = writer_runtime.enter();
            let mut writer = writer;
            for request in rx {
                let result = match request {
                    WriteRequest::Raw(data) => writer
                        .write_all(data.as_bytes())
                        .and_then(|_| writer.flush()),
                    WriteRequest::Agent(request) => {
                        let (Some(store), Some(entry)) =
                            (writer_store.upgrade(), writer_entry.upgrade())
                        else {
                            break;
                        };
                        store.deliver_agent_input(&entry, request, &mut writer)
                    }
                    WriteRequest::Service(request) => {
                        let (Some(store), Some(entry)) =
                            (writer_store.upgrade(), writer_entry.upgrade())
                        else {
                            break;
                        };
                        store.deliver_service_input(&entry, request, &mut writer)
                    }
                    WriteRequest::Handoff(request) => {
                        let (Some(store), Some(entry)) =
                            (writer_store.upgrade(), writer_entry.upgrade())
                        else {
                            break;
                        };
                        store.perform_account_handoff(&entry, request, &mut writer)
                    }
                };
                if result.is_err() {
                    let _=writer_events.send(json!({"type":"error","termId":writer_id,"message":"터미널 입력 채널이 닫혔습니다."}));
                    break;
                }
            }
        });
        let output_entry = entry.clone();
        let output_events = self.events.clone();
        let output_gate = self.event_gate.clone();
        let (output_done, output_finished) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut bytes = [0; 8192];
            let mut decoder = Decoder::default();
            while let Ok(length) = reader.read(&mut bytes) {
                if length == 0 {
                    break;
                }
                let data = decoder.push(&bytes[..length]);
                if data.is_empty() {
                    continue;
                }
                let _gate = output_gate.lock().unwrap();
                {
                    let mut meta = output_entry.meta.lock().unwrap();
                    meta.output_count = meta
                        .output_count
                        .saturating_add(data.encode_utf16().count() as u64);
                    meta.replay.push(&data);
                    meta.saved["lastOutputAt"] = json!(now());
                }
                let _ = output_events
                    .send(json!({"type":"output","termId":output_entry.id,"data":data}));
            }
            let _ = output_done.send(());
        });
        let weak = Arc::downgrade(self);
        let completed_entry = entry.clone();
        std::thread::spawn(move || {
            // Serialize try_wait with kill: a reaped PID must never be signalled again.
            let code = loop {
                let _killer = completed_entry.killer.lock().unwrap();
                match child.try_wait() {
                    Ok(Some(status)) => {
                        completed_entry
                            .exited
                            .store(true, std::sync::atomic::Ordering::SeqCst);
                        break status.exit_code();
                    }
                    Err(_) => {
                        completed_entry
                            .exited
                            .store(true, std::sync::atomic::Ordering::SeqCst);
                        break 1;
                    }
                    Ok(None) => {}
                }
                drop(_killer);
                std::thread::sleep(Duration::from_millis(100));
            };
            let _ = output_finished.recv_timeout(Duration::from_secs(1));
            if let Some(store) = weak.upgrade() {
                let _operation = store.operations.lock().unwrap();
                let _gate = store.event_gate.lock().unwrap();
                let mut state = store.state.lock().unwrap();
                if !state.closing
                    && state
                        .entries
                        .iter()
                        .any(|e| Arc::ptr_eq(e, &completed_entry))
                {
                    completed_entry.meta.lock().unwrap().saved["processExited"] = json!(true);
                    store.record_archive(&mut state, &completed_entry, "exited", Some(code));
                    state.entries.retain(|e| !Arc::ptr_eq(e, &completed_entry));
                    if store.checkpoint(&mut state).is_err() {
                        state.entries.push(completed_entry.clone());
                    }
                    let _ = store
                        .events
                        .send(json!({"type":"exit","termId":id,"exitCode":code}));
                }
            }
        });
        if !resumed {
            let meta = entry.meta.lock().unwrap();
            let saved_command = value_text(&meta.saved, "command");
            let launch = if restore
                && meta.saved["accountEngine"] == "jcode"
                && meta.saved["accountLogin"] == true
            {
                ""
            } else if restore
                && [
                    "claude login",
                    "claude auth login --claudeai",
                    "codex login",
                    "",
                ]
                .contains(&saved_command)
            {
                account.as_ref().map(|a| a.provider.as_str()).unwrap_or("")
            } else {
                saved_command
            };
            if !launch.is_empty()
                && (!restore || (recovery_command(launch) && meta.saved["supervisor"] != true))
            {
                let command = if meta.saved["accountEngine"] == "jcode" {
                    let profile = self
                        .accounts
                        .native_profile(value_text(&meta.saved, "accountId"))
                        .map_err(err)?;
                    if restore && profile.credentials()?.is_none() {
                        return Ok(entry.clone());
                    }
                    profile.command(launch)?
                } else {
                    self.managed_launch(&meta.saved, launch)?
                };
                entry
                    .writer
                    .try_send(WriteRequest::Raw(format!("{command}\r")))
                    .map_err(err)?;
            }
        }
        Ok(entry)
    }

    fn checkpoint(&self, state: &mut State) -> io::Result<()> {
        if !state.restored {
            return Ok(());
        }
        let mut saved = state.deferred.clone();
        saved.extend(
            state
                .entries
                .iter()
                .map(|e| e.meta.lock().unwrap().saved.clone()),
        );
        let mut value = state.checkpoint.clone();
        value["terminals"] = json!(saved);
        value["timestamp"] = json!(now());
        let path = self.directory.join("session-state.json");
        if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
            return Err(err("Invalid checkpoint target"));
        }
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
        {
            let mut output = io::BufWriter::new(&mut file);
            serde_json::to_writer(&mut output, &value)?;
            output.flush()?;
        }
        file.as_file().sync_all()?;
        file.persist(path).map_err(|e| e.error)?;
        #[cfg(unix)]
        File::open(&self.directory)?.sync_all()?;
        state.checkpoint = value;
        Ok(())
    }

    pub fn restore(
        self: &Arc<Self>,
        projects: &projects::Store,
        board: &crate::board::Store,
    ) -> io::Result<HashMap<String, String>> {
        let _operation = self.operations.lock().unwrap();
        {
            let state = self.state.lock().unwrap();
            if state.closing {
                return Err(err("Server is shutting down"));
            }
            if state.restored && state.deferred.is_empty() {
                return Ok(HashMap::new());
            }
        }
        let pending = self.state.lock().unwrap().deferred.clone();
        let projects = projects.list()?;
        let reviews = board
            .read()
            .map_err(|_| err("Unable to read supervisor recovery settings"))?;
        let mut deferred = Vec::new();
        let mut ids = HashMap::new();
        for mut saved in pending {
            if saved["processExited"] == true {
                continue;
            }
            if reviews["supervisors"].array().iter().any(|review| {
                review["termId"].text() == value_text(&saved, "termId")
                    || review["recoveryTerminal"]["termId"].text() == value_text(&saved, "termId")
            }) {
                saved["supervisor"] = json!(true);
            }
            let existing = self
                .state
                .lock()
                .unwrap()
                .entries
                .iter()
                .find(|entry| {
                    entry.id == value_text(&saved, "termId")
                        || (!entry.durable.is_empty()
                            && entry.durable == value_text(&saved, "durableId"))
                })
                .cloned();
            if let Some(existing) = existing {
                ids.insert(value_text(&saved, "termId").into(), existing.id.clone());
                continue;
            }
            let project_id = value_text(&saved, "projectId");
            let project = projects.iter().find(|p| {
                p.get("id")
                    .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
                    .as_deref()
                    == Some(project_id)
            });
            let base = if project_id == "__home__" {
                Some(self.home.clone())
            } else {
                project
                    .and_then(|p| p.get("path"))
                    .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
                    .map(PathBuf::from)
            };
            if base.is_none()
                && !(self.durable
                    && !value_text(&saved, "durableId").is_empty()
                    && self
                        .exists(value_text(&saved, "durableId"))
                        .unwrap_or(false))
            {
                deferred.push(saved);
                continue;
            }
            if !Path::new(value_text(&saved, "cwd")).is_dir() {
                if let Some(base) = base {
                    saved["cwd"] = json!(base);
                } else {
                    deferred.push(saved);
                    continue;
                }
            }
            let id = value_text(&saved, "termId").to_string();
            if saved["alias"].as_str().unwrap_or("").is_empty() {
                saved["alias"] = json!(self.next_alias());
            }
            match self.spawn(
                saved.clone(),
                PtySize {
                    cols: 120,
                    rows: 30,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                None,
                true,
            ) {
                Ok(_) => {
                    ids.insert(id.clone(), id);
                }
                Err(_) => deferred.push(saved),
            }
        }
        let mut state = self.state.lock().unwrap();
        state.deferred = deferred;
        state.restored = true;
        self.checkpoint(&mut state)?;
        drop(state);
        if !ids.is_empty() {
            let _gate = self.event_gate.lock().unwrap();
            let _ = self
                .events
                .send(json!({"type":"terminals","active":self.active(),"idMap":ids}));
        }
        Ok(ids)
    }

    fn next_alias(&self) -> String {
        let state = self.state.lock().unwrap();
        let max = state
            .entries
            .iter()
            .map(|e| e.meta.lock().unwrap().saved.clone())
            .chain(state.deferred.clone())
            .filter_map(|s| {
                s["alias"]
                    .as_str()
                    .and_then(|a| a.strip_prefix("ai"))
                    .and_then(|a| a.parse::<u64>().ok())
            })
            .max()
            .unwrap_or(0);
        format!("ai{}", max + 1)
    }

    fn publish_created(&self, entry: &Entry) {
        self.publish_created_correlated(entry, None);
    }
    fn publish_created_correlated(&self, entry: &Entry, create_request_id: Option<&str>) {
        let meta = entry.meta.lock().unwrap();
        let s = &meta.saved;
        let mut event = json!({"type":"created","termId":entry.id,"incarnation":s["incarnation"],"projectId":s["projectId"],"command":s["command"],"durable":!entry.durable.is_empty(),"alias":s["alias"],"account":s.get("account").unwrap_or(&Value::Null)});
        if let Some(id) = create_request_id {
            event["createRequestId"] = json!(id);
        }
        let _ = self.events.send(event);
    }

    pub fn create(
        self: &Arc<Self>,
        projects: &projects::Store,
        board: &crate::board::Store,
        message: &Value,
        owner: u64,
    ) -> io::Result<()> {
        self.create_owned(projects, board, message, Some(owner), None)
            .map(|_| ())
    }
    pub(crate) async fn create_agent(
        self: &Arc<Self>,
        app: Arc<crate::App>,
        message: &Value,
        cancel: &Cancel,
    ) -> io::Result<String> {
        let store = self.clone();
        let message = message.clone();
        create_blocking(cancel, move |cancel| {
            store.create_owned(&app.projects, &app.board, &message, None, Some(&cancel))
        })
        .await
    }
    fn create_owned(
        self: &Arc<Self>,
        projects: &projects::Store,
        board: &crate::board::Store,
        message: &Value,
        owner: Option<u64>,
        cancel: Option<&Cancel>,
    ) -> io::Result<String> {
        let _operation = self.operations.lock().unwrap();
        check_creation_cancel(cancel)?;
        if self.state.lock().unwrap().closing {
            return Err(err("Server is shutting down"));
        }
        let project_id = value_text(message, "projectId");
        let cwd = if project_id == "__home__" {
            self.home.clone()
        } else {
            let projects = projects.list()?;
            let project = projects
                .iter()
                .find(|p| {
                    p.get("id")
                        .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
                        .as_deref()
                        == Some(project_id)
                })
                .ok_or_else(|| err("Unknown project"))?;
            let root = project
                .get("path")
                .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
                .ok_or_else(|| err("Invalid project path"))?;
            let root = Path::new(&root).canonicalize()?;
            let custom = value_text(message, "cwd");
            if custom.is_empty() {
                root
            } else {
                let cwd = Path::new(custom).canonicalize()?;
                if !cwd.starts_with(&root) {
                    return Err(err("cwd must be inside project directory"));
                }
                cwd
            }
        };
        let account_id = value_text(message, "accountId");
        let account = if account_id.is_empty() {
            None
        } else {
            Some(self.accounts.launch(account_id).map_err(err)?)
        };
        let mut command = account
            .as_ref()
            .map(|a| a.provider.clone())
            .unwrap_or_else(|| safe_command(value_text(message, "command")));
        let mut native_login = false;
        let native = if message["engine"] == "jcode" {
            if account.is_none() {
                return Err(err("jcode 계정을 선택하세요."));
            }
            let (profile, logged_in) = self.accounts.prepare_native(account_id).map_err(err)?;
            native_login = message["loginMode"] == true || !logged_in;
            command = if native_login {
                profile.login_command()
            } else {
                profile.worker_command()
            };
            Some(profile)
        } else {
            None
        };
        if native.is_none() && message["loginMode"] == true {
            if let Some(account) = &account {
                command = if account.provider == "claude" {
                    "claude auth login --claudeai".into()
                } else {
                    "codex login".into()
                };
            }
        }
        if ["claude", "codex"].contains(&command.as_str()) {
            let settings = board
                .read()
                .map_err(|_| err("실행 권한 설정을 읽지 못했습니다."))?;
            command = permission_command(&command, &settings["review"]["launchPermissions"]);
        }
        let id = format!(
            "{project_id}-{:012x}",
            rand::random::<u64>() & ((1u64 << 48) - 1)
        );
        if !terminal_id(&id) {
            return Err(err("Invalid project terminal identity"));
        }
        let mut saved = json!({"termId":id,"alias":self.next_alias(),"projectId":project_id,"command":command,"cwd":cwd,"accountId":account_id,"account":account.as_ref().map(|a|a.display()),"durableId":"","supervisor":false,"conversationHeld":false});
        if native.is_some() {
            saved["accountEngine"] = json!("jcode");
            saved["accountLogin"] = json!(native_login);
        }
        let size = valid_size(message).unwrap_or(PtySize {
            cols: 120,
            rows: 30,
            pixel_width: 0,
            pixel_height: 0,
        });
        check_creation_cancel(cancel)?;
        // Ephemeral correlation, not authority or saved launch ownership. Never
        // pass arbitrary request fields into persistence or restore/respawn.
        let create_request_id = message
            .get("createRequestId")
            .and_then(Value::as_str)
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b":_-".contains(&c))
            });
        let entry = self.spawn_cancellable(saved, size, owner, false, cancel, create_request_id)?;
        if let Err(error) = self.checkpoint(&mut self.state.lock().unwrap()) {
            // The process is already visible; report persistence failure rather
            // than silently discarding or rerunning the user's command.
            let _=self.events.send(json!({"type":"error","termId":entry.id,"message":format!("터미널 상태 저장 실패: {error}")}));
        }
        Ok(entry.id.clone())
    }

    pub fn has_id(&self, id: &str) -> bool {
        self.find(id).is_some_and(|entry| entry.id == id)
    }
    pub fn is_closing(&self) -> bool {
        self.state.lock().unwrap().closing
    }
    pub fn is_restored(&self) -> bool {
        self.state.lock().unwrap().restored
    }
    pub fn automation_snapshot(&self, id: &str) -> Option<AgentScreen> {
        let entry = self.find(id)?;
        let held = entry.meta.lock().unwrap().saved["conversationHeld"] == true;
        if held {
            return Some(AgentScreen {
                held,
                agent: None,
                lines: vec![],
                current: false,
            });
        }
        let agent = self.agent(&entry);
        let screen = if !entry.durable.is_empty() && agent.as_ref().is_some_and(|a| !a.is_empty()) {
            self.capture_screen(&entry).ok()
        } else {
            None
        };
        Some(AgentScreen {
            held,
            agent,
            current: screen.is_some(),
            lines: screen
                .map(|raw| activity::clean_screen(&raw, 80).0)
                .unwrap_or_default(),
        })
    }
    pub fn reference(&self, id: &str, observe_agent: bool) -> Option<(Value, Option<String>)> {
        let entry = self.find(id)?;
        let saved = entry.meta.lock().unwrap().saved.clone();
        let agent = if observe_agent {
            self.agent(&entry)
        } else {
            None
        };
        Some((saved, agent))
    }
    pub fn recovery_snapshot(&self, id: &str) -> io::Result<Value> {
        let entry = self
            .find(id)
            .ok_or_else(|| err("감독 세션을 찾지 못했습니다."))?;
        if entry.durable.is_empty() {
            return Err(err(
                "자동 복구는 tmux로 보존되는 터미널에서 사용할 수 있습니다.",
            ));
        }
        let mut saved = entry.meta.lock().unwrap().saved.clone();
        let agent = self.agent(&entry);
        if value_text(&saved, "command").is_empty() {
            // A manually launched agent has no saved permission policy. Preserve
            // only its known default launcher, as agentRestoreCommand does.
            saved["command"] = json!(match agent.as_deref() {
                Some("codex") => "codex --no-daemon",
                Some("claude") => "claude",
                Some("opencode") => "opencode",
                Some("jcode") => "jcode",
                _ => "",
            });
        }
        let command = value_text(&saved, "command");
        if !recovery_command(command) {
            return Err(err("자동 복구할 AI 실행 명령을 확인하세요."));
        }
        if command.starts_with("codex") && !command.split(' ').any(|s| s == "--no-daemon") {
            return Err(err(
                "Codex 자동 복구는 --no-daemon으로 실행한 세션에서 지원합니다.",
            ));
        }
        if agent.as_deref() != command.split(' ').next() {
            return Err(err("초기 실행 명령과 현재 AI가 다릅니다. 해당 AI를 콕핏에서 새로 실행한 뒤 지정하세요."));
        }
        self.tmux(
            &entry.durable,
            &["set-option", "-w", "-t", "main", "remain-on-exit", "on"],
            None,
            &entry.id,
        )?;
        if let Ok(cwd) = self.tmux(
            &entry.durable,
            &[
                "display-message",
                "-p",
                "-t",
                "main",
                "#{pane_current_path}",
            ],
            None,
            &entry.id,
        ) {
            saved["cwd"] = json!(cwd.trim());
        }
        Ok(saved)
    }
    fn find(&self, id: &str) -> Option<Arc<Entry>> {
        self.state
            .lock()
            .unwrap()
            .entries
            .iter()
            .find(|e| {
                e.id == id
                    || e.meta.lock().unwrap().saved["alias"]
                        .as_str()
                        .is_some_and(|a| a.eq_ignore_ascii_case(id.trim()))
            })
            .cloned()
    }
    pub fn active(&self) -> Vec<Value> {
        self.state.lock().unwrap().entries.iter().map(|entry|{
            let meta=entry.meta.lock().unwrap();let s=&meta.saved;
            let mut value=json!({"termId":entry.id,"incarnation":s["incarnation"],"projectId":s["projectId"],"command":s["command"],"buffer":meta.replay.read(),"alias":s["alias"],"account":s.get("account").unwrap_or(&Value::Null),"durable":!entry.durable.is_empty()});
            if let Some(agent)=&meta.agent {value["agentCommand"]=json!(agent);}
            value
        }).collect()
    }
    pub fn summary_candidates(&self) -> Vec<(String, u64, String, String)> {
        self.state
            .lock()
            .unwrap()
            .entries
            .iter()
            .filter_map(|entry| {
                let meta = entry.meta.lock().unwrap();
                (meta.output_count > 0).then(|| {
                    (
                        entry.id.clone(),
                        meta.output_count,
                        meta.agent.clone().unwrap_or_default(),
                        meta.replay.read(),
                    )
                })
            })
            .collect()
    }
    fn snapshot(&self) -> (Vec<Value>, broadcast::Receiver<Value>) {
        self.snapshot_with_boundary(|| {})
    }
    // Test synchronization seam at the actual active-copy/subscribe boundary.
    fn snapshot_with_boundary(
        &self,
        before_subscribe: impl FnOnce(),
    ) -> (Vec<Value>, broadcast::Receiver<Value>) {
        let _gate = self.event_gate.lock().unwrap();
        let active = self.active();
        before_subscribe();
        (active, self.events.subscribe())
    }
    pub fn summary(self: &Arc<Self>, activity: bool) -> Value {
        let entries = self.state.lock().unwrap().entries.clone();
        let mut values: Vec<_>=entries.iter().map(|entry|{
            let meta=entry.meta.lock().unwrap();let s=&meta.saved;
            let mut value=json!({"termId":entry.id,"incarnation":s["incarnation"],"alias":s["alias"],"projectId":s["projectId"],"command":s["command"],"account":s.get("account").unwrap_or(&Value::Null),"durable":!entry.durable.is_empty(),"conversationHeld":s["conversationHeld"]==true});
            if activity {value["activity"]=json!({"agent":"","state":"unknown","observedAt":now()});}
            value
        }).collect();
        if activity {
            // Keep the response inside the UI's three-second request deadline.
            // A stalled pane must not consume every other session's observation budget.
            tokio::runtime::Handle::current().block_on(async {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
                let mut pending = stream::iter(entries.into_iter().enumerate())
                    .map(|(index, entry)| {
                        let store = self.clone();
                        tokio::task::spawn_blocking(move || (index, store.observe(&entry)))
                    })
                    .buffer_unordered(8);
                loop {
                    match tokio::time::timeout_at(deadline, pending.next()).await {
                        Ok(Some(Ok((index, observation)))) => {
                            values[index]["activity"] = observation
                        }
                        Ok(Some(Err(_))) => continue,
                        _ => break,
                    }
                }
            });
        }
        json!({"terminals":values})
    }
    pub fn screen(&self, id: &str, lines: usize, prefer_current: bool) -> Option<Value> {
        let entry = self.find(id)?;
        if prefer_current && !entry.durable.is_empty() {
            if let Ok(raw) = self.capture_screen(&entry) {
                let (result, truncated) = activity::clean_screen(&raw, lines);
                let alias = entry.meta.lock().unwrap().saved["alias"].clone();
                return Some(
                    json!({"termId":entry.id,"alias":alias,"lines":result,"truncated":truncated,"current":true}),
                );
            }
        }
        let meta = entry.meta.lock().unwrap();
        let raw = meta.replay.read();
        let (result, truncated) = activity::clean_screen(&raw, lines);
        Some(
            json!({"termId":entry.id,"alias":meta.saved["alias"],"lines":result,"truncated":truncated,"current":false}),
        )
    }
    fn capture_screen(&self, entry: &Entry) -> io::Result<String> {
        self.tmux(
            &entry.durable,
            &["capture-pane", "-p", "-t", "main"],
            None,
            &entry.id,
        )
    }
    pub(crate) fn agent_buffer(&self, id: &str) -> Option<String> {
        let entry = self.find(id)?;
        let text = entry.meta.lock().unwrap().replay.read();
        Some(text)
    }
    fn agent(&self, entry: &Entry) -> Option<String> {
        if entry.exited.load(std::sync::atomic::Ordering::SeqCst) {
            return Some(String::new());
        }
        let pid = if entry.durable.is_empty() {
            entry.pid
        } else {
            let text = self
                .tmux(
                    &entry.durable,
                    &[
                        "display-message",
                        "-p",
                        "-t",
                        "main",
                        "#{pane_pid} #{pane_dead}",
                    ],
                    None,
                    &entry.id,
                )
                .ok()?;
            let fields: Vec<_> = text.split_whitespace().collect();
            if fields.len() != 2 {
                return None;
            }
            let pid = fields[0].parse::<u32>().ok().filter(|pid| *pid > 0)?;
            match fields[1] {
                "1" => return Some(String::new()),
                "0" => Some(pid),
                _ => return None,
            }
        };
        activity::detect(pid)
            .ok()
            .map(|agent| agent.unwrap_or("").to_string())
    }
    fn observe(&self, entry: &Entry) -> Value {
        let agent = self.agent(entry);
        let state = match agent.as_deref() {
            Some("") => "offline",
            Some(agent) if !entry.durable.is_empty() => match self.capture_screen(entry) {
                Ok(raw) => activity::display_state(
                    &activity::clean_screen(&raw, 80).0,
                    true,
                    agent,
                ),
                Err(_) => "unknown",
            },
            _ => "unknown",
        };
        json!({"agent":agent.unwrap_or_default(),"state":state,"observedAt":now()})
    }
    pub(crate) fn wakeup_observation(&self, id: &str) -> Option<Value> {
        let entry = self.find(id)?;
        let mut activity = self.observe(&entry);
        let meta = entry.meta.lock().unwrap();
        activity["termId"] = json!(entry.id);
        activity["incarnation"] = meta.saved["incarnation"].clone();
        activity["alias"] = meta.saved["alias"].clone();
        activity["projectId"] = meta.saved["projectId"].clone();
        Some(activity)
    }
    pub fn scan_agents(self: &Arc<Self>) {
        let entries = {
            let state = self.state.lock().unwrap();
            if state.closing {
                return;
            }
            state.entries.clone()
        };
        tokio::runtime::Handle::current().block_on(stream::iter(entries).for_each_concurrent(8,|entry| {
            let store=self.clone();
            async move {
                let _=tokio::task::spawn_blocking(move || {
                    let agent=store.agent(&entry);
                    let mut meta=entry.meta.lock().unwrap();
                    if meta.agent!=agent {
                        meta.agent=agent.clone();
                        if let Some(agent)=agent {
                            let _=store.events.send(json!({"type":"agent-status","termId":entry.id,"agentCommand":agent}));
                        }
                    }
                }).await;
            }
        }));
    }
    fn resize(entry: &Entry, owner: u64, message: &Value, claim: bool) -> io::Result<()> {
        let Some(size) = valid_size(message) else {
            return Ok(());
        };
        let mut meta = entry.meta.lock().unwrap();
        if claim || meta.owner.is_none() || meta.owner == Some(owner) {
            entry.master.lock().unwrap().resize(size).map_err(err)?;
            meta.owner = Some(owner);
        }
        Ok(())
    }
    pub fn input(&self, message: &Value, owner: u64) -> io::Result<()> {
        let entry = self
            .find(value_text(message, "termId"))
            .ok_or_else(|| err("터미널 세션을 찾지 못했습니다. 입력 내용은 보존했습니다."))?;
        if entry.meta.lock().unwrap().saved["restarting"] == true {
            return Err(err("세션 연결 중입니다. 입력은 전송하지 않았습니다."));
        }
        let _guard = entry.control.lock().unwrap();
        if entry.meta.lock().unwrap().saved["restarting"] == true {
            return Err(err("세션 연결 중입니다. 입력은 전송하지 않았습니다."));
        }
        let data = message["data"]
            .as_str()
            .filter(|s| s.encode_utf16().count() <= 1_000_000)
            .ok_or_else(|| err("메시지가 비어 있거나 허용 크기를 초과했습니다."))?;
        Self::resize(&entry, owner, message, true)?;
        entry
            .input_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        entry
            .writer
            .try_send(WriteRequest::Raw(data.to_string()))
            .map_err(|_| err("터미널 입력 대기열이 가득 찼거나 닫혔습니다."))
    }
    pub fn focus(&self, message: &Value, owner: u64, claim: bool) -> io::Result<()> {
        if let Some(entry) = self.find(value_text(message, "termId")) {
            Self::resize(&entry, owner, message, claim)?;
        }
        Ok(())
    }
    pub fn disconnected(&self, owner: u64) {
        for entry in &self.state.lock().unwrap().entries {
            let mut meta = entry.meta.lock().unwrap();
            if meta.owner == Some(owner) {
                meta.owner = None;
            }
        }
    }
    pub fn kill(&self, message: &Value, board: &crate::board::Store) -> io::Result<()> {
        let id = value_text(message, "termId");
        let token = value_text(message, "incarnation");
        let _operation = self.operations.lock().unwrap();
        let Some(entry) = self.find(id) else {
            // Known closed incarnation: idempotent, no review/deferred mutation.
            let state = self.state.lock().unwrap();
            let archived = state.checkpoint["archivedTerminals"]
                .as_array()
                .and_then(|items| items.iter().find(|v| v["saved"]["termId"] == id))
                .ok_or_else(|| err("닫을 세션 incarnation을 찾지 못했습니다."))?;
            return require_incarnation(&archived["saved"], token);
        };
        let _guard = entry.control.lock().unwrap();
        if entry.id != id {
            return Err(err(
                "터미널 닫기는 재사용 별칭 대신 전체 termId가 필요합니다.",
            ));
        }
        require_incarnation(&entry.meta.lock().unwrap().saved, token)?;
        if entry.meta.lock().unwrap().saved["conversationHeld"] == true {
            return Err(err("사용자 대화 중인 세션은 닫지 않습니다."));
        }
        self.preserve_archive(&entry, "closed")?;
        board.stop_terminal_reviews(&entry.id).map_err(err)?;
        self.close_entry(&entry)
    }
    fn close_entry(&self, entry: &Arc<Entry>) -> io::Result<()> {
        // Removal, rollback and closed share snapshot's gate -> state order.
        let _gate = self.event_gate.lock().unwrap();
        // Persist removal before terminating. A crash after termination cannot reopen it.
        let mut state = self.state.lock().unwrap();
        let position = state
            .entries
            .iter()
            .position(|e| Arc::ptr_eq(e, entry))
            .ok_or_else(|| err("Terminal changed"))?;
        state.entries.remove(position);
        if let Err(error) = self.checkpoint(&mut state) {
            state.entries.insert(position, entry.clone());
            return Err(error);
        }
        drop(state);
        let result = (|| {
            if !entry.durable.is_empty() && self.exists(&entry.durable)? {
                self.tmux(&entry.durable, &["kill-server"], None, &entry.id)?;
            }
            let mut killer = entry.killer.lock().unwrap();
            if !entry.exited.load(std::sync::atomic::Ordering::SeqCst) {
                if let Err(error) = killer.kill() {
                    if error.raw_os_error() != Some(libc::ESRCH) {
                        return Err(error);
                    }
                }
            }
            Ok(())
        })();
        if result.is_err() {
            let mut state = self.state.lock().unwrap();
            state.entries.push(entry.clone());
            let _ = self.checkpoint(&mut state);
        } else {
            // This confirms Cockpit removal, NOT native Codex archive or RAM release.
            // No native root/first-session-meta/current ownership binding is stored.
            let _ = self.events.send(json!({
                "type":"closed", "termId":entry.id, "incarnation":entry.meta.lock().unwrap().saved["incarnation"],
                "nativeCleanup":{"status":"not_attempted","reason":"exact_native_ownership_unavailable"}
            }));
        }
        result
    }
    fn refresh_cwds(&self, entries: &[Arc<Entry>]) {
        for entry in entries {
            if !entry.durable.is_empty() {
                if let Ok(cwd) = self.tmux(
                    &entry.durable,
                    &[
                        "display-message",
                        "-p",
                        "-t",
                        "main",
                        "#{pane_current_path}",
                    ],
                    None,
                    &entry.id,
                ) {
                    entry.meta.lock().unwrap().saved["cwd"] = json!(cwd.trim());
                }
            } else if let Some(pid) = entry.pid {
                if let Ok(cwd) = fs::read_link(format!("/proc/{pid}/cwd")) {
                    entry.meta.lock().unwrap().saved["cwd"] = json!(cwd);
                }
            }
        }
    }
    pub fn maintain(
        self: &Arc<Self>,
        projects: &projects::Store,
        board: &crate::board::Store,
    ) -> io::Result<()> {
        {
            let state = self.state.lock().unwrap();
            if !state.restored || state.closing {
                return Ok(());
            }
        }
        self.restore(projects, board)?;
        let _operation = self.operations.lock().unwrap();
        if self.state.lock().unwrap().closing {
            return Ok(());
        }
        let entries = self.state.lock().unwrap().entries.clone();
        self.refresh_cwds(&entries);
        self.checkpoint(&mut self.state.lock().unwrap())?;
        self.sweep_orphan_mcp();
        Ok(())
    }
    /// Return the last saved checkpoint only after restoration has run.
    pub fn checkpoint_snapshot(&self) -> Option<Value> {
        let state = self.state.lock().unwrap();
        state.restored.then(|| state.checkpoint.clone())
    }

    /// Validate and save all sessions before committing to a managed restart.
    pub fn prepare_restart(&self, commit: bool) -> io::Result<usize> {
        self.prepare_restart_checked(commit, || Ok(()))
    }

    pub fn prepare_restart_checked(
        &self,
        commit: bool,
        before_commit: impl FnOnce() -> io::Result<()>,
    ) -> io::Result<usize> {
        let _operation = self.operations.lock().unwrap();
        let entries = {
            let state = self.state.lock().unwrap();
            if state.closing {
                return Err(err("서버 종료가 이미 진행 중입니다."));
            }
            if !self.durable {
                return Err(err("이 환경에서는 터미널 세션 보존을 지원하지 않습니다."));
            }
            if !state.restored || !state.deferred.is_empty() {
                return Err(err(
                    "터미널 복원이 아직 완료되지 않아 재시작을 취소했습니다.",
                ));
            }
            state.entries.clone()
        };
        let unprotected = entries
            .iter()
            .filter(|entry| entry.durable.is_empty())
            .count();
        if unprotected > 0 {
            return Err(err(format!("현재 터미널 {unprotected}개는 아직 세션 보존 대상이 아닙니다. 작업을 마친 뒤 처음 한 번만 수동 재시작해 주세요.")));
        }
        let unavailable = entries
            .iter()
            .filter(|entry| !self.exists(&entry.durable).unwrap_or(false))
            .count();
        if unavailable > 0 {
            return Err(err(format!("현재 터미널 {unavailable}개의 tmux 연결을 찾지 못해 재시작을 중단했습니다. 기존 세션 연결을 먼저 복구해 주세요.")));
        }
        self.refresh_cwds(&entries);
        let mut state = self.state.lock().unwrap();
        // Signal shutdown marks closing before waiting for the operations lock.
        if state.closing {
            return Err(err("서버 종료가 이미 진행 중입니다."));
        }
        self.checkpoint(&mut state).map_err(|error| {
            err(format!(
                "터미널 체크포인트를 저장하지 못해 재시작을 취소했습니다: {error}"
            ))
        })?;
        if commit {
            // Recheck the manager after every blocking operation, while the
            // operations and state locks still make this the final commit.
            before_commit()?;
            state.closing = true;
        }
        Ok(entries.len())
    }

    pub fn shutdown(&self) -> io::Result<()> {
        self.state.lock().unwrap().closing = true;
        let _operation = self.operations.lock().unwrap();
        let entries = self.state.lock().unwrap().entries.clone();
        self.refresh_cwds(&entries);
        let result = {
            let mut state = self.state.lock().unwrap();
            self.checkpoint(&mut state)
        };
        let _ = self.events.send(json!({"type":"server-shutdown"}));
        for entry in entries {
            let mut killer = entry.killer.lock().unwrap();
            if !entry.exited.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = killer.kill();
            }
        }
        result
    }
}

fn kill_reply(message: &Value, result: io::Result<()>) -> Value {
    let receipt = value_text(message, "requestId");
    let valid = !receipt.is_empty()
        && receipt.len() <= 128
        && receipt
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b":_-".contains(&c));
    let mut value = json!({"type":"kill-result","termId":message["termId"],"incarnation":message["incarnation"],"requestId":if valid {json!(receipt)} else {Value::Null},"accepted":result.is_ok()});
    if let Err(error) = result {
        value["error"] = json!(error.to_string());
    }
    value
}

// Immutable authority from THIS socket's original gated snapshot only. Later
// created/restore/respawn events must never refresh an old connection's intent.
struct ConnectionClose(HashMap<String, String>);
impl ConnectionClose {
    fn from_initial(active: &[Value]) -> Self {
        Self(
            active
                .iter()
                .filter_map(|saved| {
                    let id = value_text(saved, "termId");
                    let token = value_text(saved, "incarnation");
                    (terminal_id(id) && require_incarnation(saved, token).is_ok())
                        .then(|| (id.to_owned(), token.to_owned()))
                })
                .collect(),
        )
    }
    fn kill(&self, store: &Store, message: &Value, board: &crate::board::Store) -> io::Result<()> {
        // Explicit tokens, even malformed/null/empty/stale ones, never fall back.
        if message.get("incarnation").is_some() {
            return store.kill(message, board);
        }
        if message["confirm"] != true {
            return Err(err("기존 클라이언트의 닫기는 confirm:true가 필요합니다."));
        }
        let token = self
            .0
            .get(value_text(message, "termId"))
            .ok_or_else(|| err("원래 연결 snapshot에 없는 전체 termId입니다."))?;
        let mut bound = message.clone();
        bound["incarnation"] = json!(token);
        store.kill(&bound, board)
    }
}

pub async fn connection(mut socket: WebSocket, app: Arc<crate::App>) {
    let owner = rand::random::<u64>();
    let store = app.terminals.clone();
    let restore_app = app.clone();
    let restored = tokio::task::spawn_blocking(move || {
        let result = restore_app
            .terminals
            .restore(&restore_app.projects, &restore_app.board);
        if result.is_ok() {
            restore_app.terminals.scan_agents();
        }
        result
    })
    .await;
    let (active, mut events) = store.snapshot();
    let closes = Arc::new(ConnectionClose::from_initial(&active));
    match restored {
        Ok(Ok(ids)) => {
            let message = json!({"type":"terminals","active":active,"idMap":ids,"closeReceipts":true,"closeIncarnations":true});
            if socket
                .send(Message::Text(message.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
        }
        _ => {
            let _ = socket
                .send(Message::Text(
                    json!({"type":"error","message":"터미널 복원 실패. 저장 상태를 유지합니다."})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    }
    loop {
        tokio::select! {
            event=events.recv()=>{
                let Ok(event)=event else {break;};
                if event["type"]=="server-shutdown" {break;}
                if socket.send(Message::Text(event.to_string().into())).await.is_err() {break;}
            },
            frame=socket.recv()=>{
                let Some(Ok(frame))=frame else {break;};
                let text=match frame {Message::Text(text)=>text.to_string(),Message::Binary(bytes)=>String::from_utf8_lossy(&bytes).into_owned(),Message::Close(_)=>break,_=>continue};
                let Ok(message)=serde_json::from_str::<Value>(&text) else {continue;};
                let task_app=app.clone();let task_message=message.clone();let task_closes=closes.clone();
                let result=tokio::task::spawn_blocking(move||match value_text(&task_message,"type") {
                    "create"=>task_app.terminals.create(&task_app.projects,&task_app.board,&task_message,owner),
                    "input"=>task_app.terminals.input(&task_message,owner),
                    "focus"=>task_app.terminals.focus(&task_message,owner,true),
                    "resize"=>task_app.terminals.focus(&task_message,owner,false),
                    "kill"=>task_closes.kill(&task_app.terminals, &task_message, &task_app.board),
                    "chat-watch"|"chat-unwatch"=>Err(err("Chat file watcher migration is not complete")),
                    _=>Ok(()),
                }).await.unwrap_or_else(|_|Err(err("Terminal request failed")));
                let receipt=value_text(&message,"requestId");
                let receipt_valid=!receipt.is_empty()&&receipt.len()<=128&&receipt.bytes().all(|c|c.is_ascii_alphanumeric()||b":_-".contains(&c));
                let reply=if message["type"]=="input"&&receipt_valid {
                    let mut value=json!({"type":"input-result","termId":message["termId"],"requestId":receipt,"accepted":result.is_ok()});
                    if let Err(error)=result {value["error"]=json!(error.to_string());} Some(value)
                } else if message["type"]=="kill" && message["confirm"]==true {
                    Some(kill_reply(&message, result))
                } else {result.err().map(|e|json!({"type":"error","message":e.to_string()}))};
                if let Some(reply)=reply {if socket.send(Message::Text(reply.to_string().into())).await.is_err(){break;}}
            }
        }
    }
    store.disconnected(owner);
    let _ = socket.close().await;
}

#[cfg(test)]
mod restart_tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn store(saved: &Value) -> (tempfile::TempDir, Arc<Store>) {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("session-state.json"),
            serde_json::to_vec(saved).unwrap(),
        )
        .unwrap();
        let accounts = Arc::new(crate::accounts::Store::new(
            directory.path(),
            directory.path(),
        ));
        let mut store = Store::new(directory.path().to_path_buf(), accounts).unwrap();
        Arc::get_mut(&mut store).unwrap().durable = true;
        (directory, store)
    }

    #[test]
    fn restart_preconditions_preserve_unrestored_and_deferred_checkpoints() {
        let saved = json!({"terminals":[{"termId":"home-0123456789ab","projectId":"__home__","durableId":"","conversationHeld":true}],"timestamp":1,"retained":true});
        let (directory, mut store) = store(&saved);
        let before = fs::read(directory.path().join("session-state.json")).unwrap();
        assert!(store.checkpoint_snapshot().is_none());
        for restored in [false, true] {
            store.state.lock().unwrap().restored = restored;
            for commit in [false, true] {
                assert_eq!(
                    store.prepare_restart(commit).unwrap_err().to_string(),
                    "터미널 복원이 아직 완료되지 않아 재시작을 취소했습니다."
                );
                assert!(!store.is_closing());
                assert_eq!(store.state.lock().unwrap().checkpoint, saved);
                assert_eq!(
                    fs::read(directory.path().join("session-state.json")).unwrap(),
                    before
                );
            }
        }
        Arc::get_mut(&mut store).unwrap().durable = false;
        assert_eq!(
            store.prepare_restart(true).unwrap_err().to_string(),
            "이 환경에서는 터미널 세션 보존을 지원하지 않습니다."
        );
        assert!(!store.is_closing());
    }

    #[test]
    fn restart_commit_follows_persistence_and_blocks_create_and_restore() {
        let (directory, mut store) =
            store(&json!({"terminals":[],"timestamp":1,"retained":{"v":7}}));
        store.state.lock().unwrap().restored = true;
        assert_eq!(store.prepare_restart(false).unwrap(), 0);
        assert!(!store.is_closing());
        let snapshot = store.checkpoint_snapshot().unwrap();
        assert_eq!(snapshot["retained"], json!({"v":7}));
        assert_eq!(
            snapshot,
            serde_json::from_slice::<Value>(
                &fs::read(directory.path().join("session-state.json")).unwrap()
            )
            .unwrap()
        );
        assert_eq!(store.prepare_restart(true).unwrap(), 0);
        assert!(store.is_closing());
        assert_eq!(
            store.prepare_restart(true).unwrap_err().to_string(),
            "서버 종료가 이미 진행 중입니다."
        );
        // A broken closing guard must fail without launching a shell or tmux.
        let mutable = Arc::get_mut(&mut store).unwrap();
        mutable.durable = false;
        mutable.shell = directory
            .path()
            .join("missing-shell")
            .to_string_lossy()
            .into_owned();
        let projects = projects::Store::new(directory.path().to_path_buf()).unwrap();
        let board = crate::board::Store::new(directory.path());
        assert_eq!(
            store
                .create_owned(
                    &projects,
                    &board,
                    &json!({"projectId":"__home__"}),
                    None,
                    None
                )
                .unwrap_err()
                .to_string(),
            "Server is shutting down"
        );
        assert_eq!(
            store.restore(&projects, &board).unwrap_err().to_string(),
            "Server is shutting down"
        );
    }

    #[test]
    fn restart_lost_manager_during_operations_wait_keeps_server_open() {
        let (directory, store) = store(&json!({"terminals":[],"timestamp":1}));
        store.state.lock().unwrap().restored = true;
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let operation = store.operations.lock().unwrap();
        let (started, waiting) = std::sync::mpsc::channel();
        let task_store = store.clone();
        let task_alive = alive.clone();
        let path = directory.path().join("session-state.json");
        let task = std::thread::spawn(move || {
            assert!(task_alive.load(Ordering::Acquire));
            started.send(()).unwrap();
            task_store.prepare_restart_checked(true, || {
                let saved: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                assert_ne!(saved["timestamp"], json!(1));
                if !task_alive.load(Ordering::Acquire) {
                    return Err(err("manager disconnected during checkpoint"));
                }
                Ok(())
            })
        });
        waiting.recv().unwrap();
        alive.store(false, Ordering::Release);
        drop(operation);
        assert_eq!(
            task.join().unwrap().unwrap_err().to_string(),
            "manager disconnected during checkpoint"
        );
        assert!(!store.is_closing());
        assert_eq!(store.prepare_restart_checked(true, || Ok(())).unwrap(), 0);
        assert!(store.is_closing());
    }

    #[test]
    fn restart_checkpoint_failure_keeps_server_open_and_last_saved_snapshot() {
        let saved = json!({"terminals":[],"timestamp":1,"retained":true});
        let (directory, store) = store(&saved);
        store.state.lock().unwrap().restored = true;
        let path = directory.path().join("session-state.json");
        fs::rename(&path, directory.path().join("preserved.json")).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store
            .prepare_restart(true)
            .unwrap_err()
            .to_string()
            .starts_with("터미널 체크포인트를 저장하지 못해 재시작을 취소했습니다:"));
        assert!(!store.is_closing());
        assert_eq!(store.checkpoint_snapshot(), Some(saved.clone()));
        assert_eq!(
            serde_json::from_slice::<Value>(
                &fs::read(directory.path().join("preserved.json")).unwrap()
            )
            .unwrap(),
            saved
        );
        assert!(path.is_dir());
    }
}

#[cfg(test)]
mod creation_tests {
    use super::*;

    #[tokio::test]
    async fn agent_creation_runs_outside_async_runtime_workers() {
        let result = create_blocking(&Cancel::default(), |_| {
            // The durable terminal path uses this same block_on bridge.
            tokio::runtime::Handle::current().block_on(async { Ok("created".into()) })
        })
        .await
        .unwrap();
        assert_eq!(result, "created");
    }

    #[tokio::test]
    async fn cancelled_or_dropped_lock_waiter_cannot_create_a_terminal() {
        for drop_request in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let accounts = Arc::new(crate::accounts::Store::new(
                directory.path(),
                directory.path(),
            ));
            let mut store = Store::new(directory.path().to_path_buf(), accounts).unwrap();
            // A regression may reach PTY setup, but it must never start a real
            // shell or a tmux server during this cancellation test.
            Arc::get_mut(&mut store).unwrap().durable = false;
            Arc::get_mut(&mut store).unwrap().shell = directory
                .path()
                .join("missing-shell")
                .to_string_lossy()
                .into_owned();
            let projects = projects::Store::new(directory.path().to_path_buf()).unwrap();
            let board = crate::board::Store::new(directory.path());
            let operation = store.operations.lock().unwrap();
            let cancel = Cancel::default();
            let request_cancel = cancel.clone();
            let waiting_store = store.clone();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
            let request = tokio::spawn(async move {
                create_blocking(&request_cancel, move |child| {
                    let _ = started_tx.send(());
                    let result = waiting_store.create_owned(
                        &projects,
                        &board,
                        &json!({"projectId":"__home__"}),
                        None,
                        Some(&child),
                    );
                    let _ = finished_tx.send(result.as_ref().err().map(ToString::to_string));
                    result
                })
                .await
            });
            tokio::time::timeout(Duration::from_secs(5), started_rx)
                .await
                .unwrap()
                .unwrap();
            if drop_request {
                request.abort();
                assert!(request.await.unwrap_err().is_cancelled());
            } else {
                cancel.cancel();
                assert_eq!(
                    request.await.unwrap().unwrap_err().to_string(),
                    "Agent request cancelled"
                );
            }
            drop(operation);
            let error = tokio::time::timeout(Duration::from_secs(5), finished_rx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(error.as_deref(), Some("Agent request cancelled"));
            assert!(store.active().is_empty());
        }
    }

    #[tokio::test]
    async fn pre_cancelled_creation_does_not_enter_blocking_work() {
        let cancel = Cancel::default();
        cancel.cancel();
        let error = create_blocking(&cancel, |_| panic!("cancelled creation must not run"))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Agent request cancelled");
    }
}
