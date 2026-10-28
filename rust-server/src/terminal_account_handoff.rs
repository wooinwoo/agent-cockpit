//! Move an idle local jcode client between credential homes without sending a work prompt.
use super::*;
use std::{sync::atomic::Ordering, time::Instant};

pub(super) struct HandoffRequest {
    pub(super) account_id: String,
    pub(super) generation: u64,
    pub(super) deadline: Instant,
    pub(super) reply: mpsc::SyncSender<io::Result<Value>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    started: u64,
}

fn identity(pid: u32) -> io::Result<Option<ProcessIdentity>> {
    let file = match File::open(format!("/proc/{pid}/stat")) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(err("프로세스 상태를 확인하지 못했습니다.")),
    };
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(err("프로세스 상태를 확인하지 못했습니다."));
    }
    let text =
        std::str::from_utf8(&bytes).map_err(|_| err("프로세스 상태를 확인하지 못했습니다."))?;
    let (_, fields) = text
        .rsplit_once(") ")
        .ok_or_else(|| err("프로세스 상태를 확인하지 못했습니다."))?;
    let fields: Vec<_> = fields.split_whitespace().collect();
    let started = fields
        .get(19)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| err("프로세스 상태를 확인하지 못했습니다."))?;
    if matches!(fields.first(), Some(&"Z" | &"X")) {
        return Ok(None);
    }
    Ok(Some(ProcessIdentity { pid, started }))
}

fn safe_path(path: &Path, maximum: usize) -> io::Result<&str> {
    let text = path
        .to_str()
        .ok_or_else(|| err("대화 복원 경로를 확인하지 못했습니다."))?;
    if !path.is_absolute()
        || text.len() > maximum
        || text.chars().any(char::is_control)
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(err("대화 복원 경로를 확인하지 못했습니다."));
    }
    Ok(text)
}

struct SourceConnection {
    socket: PathBuf,
    debug: PathBuf,
    runtime: Option<PathBuf>,
    home_explicit: bool,
}

fn resume_command(home: &Path, connection: &SourceConnection, id: &str) -> io::Result<String> {
    let command = format!("jcode --resume={id}");
    if !recovery_command(&command) {
        return Err(err("대화 복원 정보를 확인하지 못했습니다."));
    }
    let runtime = connection
        .runtime
        .as_deref()
        .map(|path| {
            safe_path(path, 4096)
                .map(|path| format!(" JCODE_RUNTIME_DIR={}", native_accounts::shell_quote(path)))
        })
        .transpose()?
        .unwrap_or_default();
    let home = safe_path(home, 4096)?;
    let home = if connection.home_explicit {
        format!("JCODE_HOME={}", native_accounts::shell_quote(home))
    } else {
        "-u JCODE_HOME".into()
    };
    Ok(format!(
        "/usr/bin/env -u JCODE_DEBUG_SOCKET -u JCODE_RUNTIME_DIR {home} JCODE_SOCKET={}{runtime} {command}\r",
        native_accounts::shell_quote(safe_path(&connection.socket, 107)?)
    ))
}

fn send(writer: &mut dyn Write, data: &str) -> io::Result<()> {
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
}

fn source_connection(pid: u32) -> io::Result<SourceConnection> {
    let mut env = Vec::new();
    File::open(format!("/proc/{pid}/environ"))?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut env)?;
    if env.len() > 1024 * 1024 {
        return Err(err("jcode 연결 경로를 확인할 수 없습니다."));
    }
    connection_from_env(&env, std::env::var("HOME").ok().as_deref())
}

fn connection_from_env(env: &[u8], server_home: Option<&str>) -> io::Result<SourceConnection> {
    let variable = |key: &[u8]| -> io::Result<Option<&str>> {
        env.split(|b| *b == 0)
            .find_map(|entry| entry.strip_prefix(key))
            .map(|value| {
                std::str::from_utf8(value).map_err(|_| err("jcode 연결 경로를 확인할 수 없습니다."))
            })
            .transpose()
    };
    let home_explicit = if let Some(home) = variable(b"JCODE_HOME=")? {
        safe_path(Path::new(home), 4096)?;
        true
    } else {
        let home = variable(b"HOME=")?
            .ok_or_else(|| err("원래 HOME을 확인하지 못해 계정 연결을 보류했습니다."))?;
        safe_path(Path::new(home), 4096)?;
        if Some(home) != server_home {
            return Err(err(
                "서버와 다른 HOME으로 실행한 jcode는 계정 연결을 지원하지 않습니다.",
            ));
        }
        false
    };
    let runtime = variable(b"JCODE_RUNTIME_DIR=")?.map(PathBuf::from);
    if let Some(runtime) = &runtime {
        safe_path(runtime, 4096)?;
    }
    let socket = if let Some(socket) = variable(b"JCODE_SOCKET=")? {
        PathBuf::from(socket)
    } else {
        let resolved_runtime = if let Some(runtime) = &runtime {
            runtime.clone()
        } else if let Some(runtime) = variable(b"XDG_RUNTIME_DIR=")? {
            PathBuf::from(runtime)
        } else {
            PathBuf::from(variable(b"TMPDIR=")?.unwrap_or("/tmp"))
                .join(format!("jcode-{}", unsafe { libc::geteuid() }))
        };
        resolved_runtime.join("jcode.sock")
    };
    safe_path(&socket, 107)?;
    let name = socket
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| err("jcode 연결 경로를 확인할 수 없습니다."))?;
    let debug = socket.with_file_name(name.replace(".sock", "-debug.sock"));
    safe_path(&debug, 107)?;
    Ok(SourceConnection {
        socket,
        debug,
        runtime,
        home_explicit,
    })
}

fn detachable(session: &crate::jcode_session::LocalSession, deadline: Instant) -> io::Result<()> {
    use std::os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let socket = source_connection(session.pid)?.debug;
    let directory = crate::accounts::account_directory(
        socket
            .parent()
            .ok_or_else(|| err("jcode 연결 경로를 확인할 수 없습니다."))?,
    )?;
    let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
        .join(socket.file_name().unwrap());
    let meta =
        fs::symlink_metadata(&path).map_err(|_| err("jcode 연결 상태를 확인할 수 없습니다."))?;
    if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(err("jcode 연결 상태를 확인할 수 없습니다."));
    }
    let read = async {
        let mut values = Vec::new();
        for command in ["clients:map", "sessions"] {
            let mut socket = tokio::net::UnixStream::connect(&path).await?;
            if socket.peer_cred()?.uid() != unsafe { libc::geteuid() } {
                return Err(err("jcode 연결 소유자가 다릅니다."));
            }
            let request = json!({"type":"debug_command","id":1,"command":command,"session_id":null})
                .to_string() + "\n";
            socket.write_all(request.as_bytes()).await?;
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 4096];
                let read = socket.read(&mut chunk).await?;
                if read == 0 {
                    return Err(err("jcode 연결 상태 응답이 끊겼습니다."));
                }
                bytes.extend_from_slice(&chunk[..read]);
                if bytes.len() > 1024 * 1024 {
                    return Err(err("jcode 연결 상태 응답이 너무 큽니다."));
                }
                if let Some(end) = bytes.iter().position(|b| *b == b'\n') {
                    let envelope: Value = serde_json::from_slice(&bytes[..end])
                        .map_err(|_| err("jcode 연결 상태 응답이 올바르지 않습니다."))?;
                    if envelope["type"] != "debug_response"
                        || envelope["id"] != 1
                        || envelope["ok"] != true
                    {
                        return Err(err("jcode 연결 상태를 확인할 수 없습니다."));
                    }
                    let output = envelope["output"]
                        .as_str()
                        .ok_or_else(|| err("jcode 연결 상태를 확인할 수 없습니다."))?;
                    values.push(
                        serde_json::from_str::<Value>(output)
                            .map_err(|_| err("jcode 연결 상태를 확인할 수 없습니다."))?,
                    );
                    break;
                }
            }
        }
        let clients = values[0]["clients"]
            .as_array()
            .ok_or_else(|| err("jcode 연결 목록을 확인할 수 없습니다."))?;
        if clients
            .iter()
            .filter(|client| client["session_id"] == session.id)
            .count()
            != 1
        {
            return Err(err(
                "같은 대화에 연결된 다른 클라이언트가 있어 계정 연결을 보류했습니다.",
            ));
        }
        let sessions = values[1]
            .as_array()
            .ok_or_else(|| err("jcode 작업 상태를 확인할 수 없습니다."))?;
        let active = sessions
            .iter()
            .filter(|item| item["session_id"] == session.id)
            .collect::<Vec<_>>();
        if active.len() != 1 || active[0]["is_processing"] != false {
            return Err(err(
                "jcode 작업이 진행 중이거나 상태가 불명확해 계정 연결을 보류했습니다.",
            ));
        }
        Ok(())
    };
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .min(Duration::from_secs(3));
    tokio::runtime::Handle::current().block_on(async {
        tokio::time::timeout(remaining, read)
            .await
            .map_err(|_| err("jcode 연결 상태 확인 시간이 초과됐습니다."))?
    })
}

impl Store {
    pub(super) fn perform_account_handoff(
        &self,
        entry: &Arc<Entry>,
        request: HandoffRequest,
        writer: &mut dyn Write,
    ) -> io::Result<()> {
        // Semantic failures belong in the receipt, not the PTY writer's fatal path.
        let result = self.account_handoff(entry, &request, writer);
        let _ = request.reply.send(result);
        Ok(())
    }

    fn account_handoff(
        &self,
        entry: &Arc<Entry>,
        request: &HandoffRequest,
        writer: &mut dyn Write,
    ) -> io::Result<Value> {
        let _control = loop {
            self.handoff_current(entry, request.generation, request.deadline)?;
            match entry.control.try_lock() {
                Ok(lock) => break lock,
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(_) => return Err(err("터미널 제어 상태를 확인하지 못했습니다.")),
            }
        };
        self.handoff_current(entry, request.generation, request.deadline)?;
        if entry.meta.lock().unwrap().saved["restarting"] == true {
            return Err(err("이미 세션 연결을 변경 중입니다."));
        }
        let original_saved = entry.meta.lock().unwrap().saved.clone();
        let use_native = original_saved["accountEngine"] == "jcode"
            || self.directory.join("jcode-engine/jcode").is_file()
            || self.accounts.has_native_profile(&request.account_id);
        let native = use_native
            .then(|| {
                self.accounts
                    .prepare_native(&request.account_id)
                    .map_err(err)
            })
            .transpose()?;
        if native.as_ref().is_some_and(|(_, logged_in)| !*logged_in) {
            return Err(err(
                "AI 계정 탭에서 해당 계정의 jcode 로그인을 먼저 완료하세요.",
            ));
        }
        let target_profile = native.as_ref().map(|(profile, _)| profile);
        if let Some(profile) = target_profile {
            if self.accounts.usage.native_login_rejected(profile) {
                return Err(err("대상 계정의 인증이 거절됐습니다. AI 계정 탭에서 다시 로그인하세요. 현재 대화는 유지했습니다."));
            }
            let refreshed = tokio::runtime::Handle::current().block_on(profile.refresh(false));
            if refreshed["ok"] != true {
                return Err(err("대상 계정 인증을 준비하지 못했습니다. AI 계정 탭에서 확인하세요. 현재 대화는 유지했습니다."));
            }
        }
        let target = target_profile
            .map(|profile| profile.home.clone())
            .unwrap_or_else(|| self.directory.join("jcode-accounts"));
        let pool = if let Some(profile) = target_profile {
            json!({"accounts":[{"id":request.account_id,"provider":profile.provider,"label":profile.label}]})
        } else {
            crate::jcode_accounts::prepare(&self.accounts, &target)?
        };
        let selected = pool["accounts"]
            .as_array()
            .and_then(|items| items.iter().find(|a| a["id"] == request.account_id))
            .ok_or_else(|| err("등록된 계정을 찾지 못했습니다."))?;
        let provider = selected["provider"]
            .as_str()
            .ok_or_else(|| err("등록 계정 정보가 올바르지 않습니다."))?;
        let label = selected["label"]
            .as_str()
            .ok_or_else(|| err("등록 계정 정보가 올바르지 않습니다."))?;
        let switch = native_accounts::switch_command(provider, label)?;
        let (old_pid, source_home) = self.process_home(entry)?;
        if source_home == target {
            if target_profile.is_some() {
                return Ok(
                    json!({"connected":true,"accepted":true,"termId":entry.id,"accountId":request.account_id,"message":"이미 선택한 계정에 연결되어 있습니다."}),
                );
            }
            return Err(err(
                "이미 연결된 계정 저장소입니다. 계정 목록을 새로고침하세요.",
            ));
        }
        let source = crate::jcode_session::identify(old_pid, &source_home)?;
        if target_profile.is_some() {
            crate::jcode_session::validate_provider(&source, provider)?;
        }
        let old_process =
            identity(old_pid)?.ok_or_else(|| err("원래 jcode 프로세스가 종료됐습니다."))?;
        let (root, dead) = self.pane_identity(entry)?;
        if dead || root == old_pid {
            return Err(err(
                "jcode 종료 뒤 유지되는 셸이 없어 계정 연결을 보류했습니다.",
            ));
        }
        let shell = identity(root)?.ok_or_else(|| err("원래 셸 상태를 확인하지 못했습니다."))?;
        self.handoff_shell(entry, shell, false)?;
        let connection = source_connection(old_pid)?;
        let logical_resume = format!("jcode --resume={}", source.id);
        let original_command = if original_saved["accountEngine"] == "jcode" {
            let profile = self
                .accounts
                .native_profile(value_text(&original_saved, "accountId"))
                .map_err(err)?;
            if profile.home != source_home {
                return Err(err("현재 계정 경로가 저장한 계정과 다릅니다."));
            }
            profile.command(&logical_resume)? + "\r"
        } else {
            resume_command(&source_home, &connection, &source.id)?
        };
        let target_command = if let Some(profile) = target_profile {
            profile.command(&logical_resume)?
        } else {
            self.managed_launch(&json!({"jcodeHomeManaged":true}), &logical_resume)?
        } + "\r";
        let mut target_saved = original_saved.clone();
        if target_profile.is_some() {
            target_saved["accountEngine"] = json!("jcode");
            target_saved["accountLogin"] = json!(false);
            target_saved["accountId"] = json!(request.account_id);
            if let Some(account) = self
                .accounts
                .registered_accounts()
                .map_err(err)?
                .into_iter()
                .find(|account| account["id"] == request.account_id)
            {
                target_saved["accountDisplay"] = account;
            }
        }
        crate::jcode_session::validate_target(&source, &target)?;
        detachable(&source, request.deadline)?;
        if !native_accounts::switch_input_allowed(&self.handoff_screen(entry)?) {
            return Err(err("빈 입력창에서 작업을 마친 뒤 계정을 연결하세요."));
        }
        if target_profile.is_none() {
            crate::jcode_session::copy_settings(&source_home, &target)?;
        }
        self.handoff_current(entry, request.generation, request.deadline)?;
        let current = self.process_home(entry)?;
        if current != (old_pid, source_home.clone())
            || identity(old_pid)? != Some(old_process)
            || crate::jcode_session::identify(old_pid, &source_home)?.id != source.id
        {
            return Err(err("연결할 대화가 변경돼 계정 연결을 보류했습니다."));
        }
        // Recheck immediately before the only graceful stop command.
        detachable(&source, request.deadline)?;
        if !native_accounts::switch_input_allowed(&self.handoff_screen(entry)?) {
            return Err(err(
                "작업 또는 입력 상태가 변경돼 계정 연결을 보류했습니다.",
            ));
        }
        self.handoff_current(entry, request.generation, request.deadline)?;
        if request.deadline.saturating_duration_since(Instant::now()) < Duration::from_secs(20) {
            return Err(err(
                "안전한 종료와 복구를 위한 시간이 부족해 계정 연결을 시작하지 않았습니다.",
            ));
        }
        entry.meta.lock().unwrap().saved["restarting"] = json!(true);
        let mut quit_sent = false;
        let mut copied = false;
        let mut launch_attempted = false;
        let mut launched_target = false;
        let result = (|| -> io::Result<Value> {
            // A crash after /quit must resume this exact original conversation,
            // even before its closed snapshot has reached the destination.
            self.handoff_checkpoint(entry, false, &source, &connection, &original_saved)?;
            self.handoff_current(entry, request.generation, request.deadline)?;
            if self.process_home(entry)? != (old_pid, source_home.clone())
                || identity(old_pid)? != Some(old_process)
                || !native_accounts::switch_input_allowed(&self.handoff_screen(entry)?)
            {
                return Err(err("종료 직전 대화 상태가 변경됐습니다."));
            }
            send(writer, "/quit\r")?;
            quit_sent = true;
            let close_deadline = (Instant::now() + Duration::from_secs(15))
                .min(request.deadline - Duration::from_secs(8));
            loop {
                self.handoff_current(entry, request.generation, close_deadline)?;
                self.handoff_shell(entry, shell, false)?;
                if identity(old_pid)? != Some(old_process) {
                    self.handoff_shell(entry, shell, true)?;
                    if crate::jcode_session::snapshot_closed(&source, &target).is_ok() {
                        copied = true;
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            self.handoff_current(entry, request.generation, request.deadline)?;
            self.handoff_shell(entry, shell, true)?;
            self.handoff_checkpoint(
                entry,
                target_profile.is_none(),
                &source,
                &connection,
                &target_saved,
            )?;
            self.handoff_current(entry, request.generation, request.deadline)?;
            self.handoff_shell(entry, shell, true)?;
            launch_attempted = true;
            send(writer, &target_command)?;
            launched_target = true;
            let launch_deadline = (Instant::now() + Duration::from_secs(12))
                .min(request.deadline - Duration::from_secs(3));
            loop {
                self.handoff_current(entry, request.generation, launch_deadline)?;
                self.handoff_shell(entry, shell, false)?;
                if let Ok((pid, home)) = self.process_home(entry) {
                    if home != target || identity(pid)? == Some(old_process) {
                        return Err(err(
                            "새로 연결된 AI의 계정 경로가 달라 전환 명령을 보내지 않았습니다.",
                        ));
                    }
                    if crate::jcode_session::identify(pid, &home)
                        .is_ok_and(|session| session.id == source.id)
                        && native_accounts::switch_input_allowed(&self.handoff_screen(entry)?)
                    {
                        self.handoff_current(entry, request.generation, request.deadline)?;
                        self.check_native_account(entry, provider, label)?;
                        if self.process_home(entry)? != (pid, target.clone()) {
                            return Err(err("계정 전환 직전 AI 연결이 변경됐습니다."));
                        }
                        if target_profile.is_none() {
                            send(writer, &switch)?;
                        }
                        let archive_failed = original_saved["accountEngine"] == "jcode"
                            && crate::jcode_session::archive_departed(&source).is_err();
                        return Ok(
                            json!({"connected":true,"accepted":true,"termId":entry.id,"accountId":request.account_id,
                            "message":if archive_failed {"계정 연결은 완료했지만 이전 닫힌 기록을 이동하지 못했습니다. 원본은 보존했으며 돌아가는 전환은 보류될 수 있습니다."}
                            else if target_profile.is_some() {"기존 대화를 선택한 계정에 다시 연결했습니다."}else{"기존 대화에 다시 연결했고 계정 전환 명령을 전달했습니다. 터미널 결과를 확인하세요."}}),
                        );
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })();
        let mut recovered_source = false;
        let result = match result {
            Ok(value) => Ok(value),
            Err(_) if quit_sent => {
                let rollback = (|| -> io::Result<()> {
                    if launch_attempted {
                        return Err(err(
                            "대상 실행을 요청한 뒤에는 같은 대화를 중복 실행하지 않습니다.",
                        ));
                    }
                    self.handoff_current(entry, request.generation, request.deadline)?;
                    if identity(old_pid)? == Some(old_process) {
                        return Err(err("원래 jcode가 아직 종료되지 않았습니다."));
                    }
                    self.handoff_shell(entry, shell, true)?;
                    if copied { crate::jcode_session::archive_unlaunched(&source, &target)?; }
                    self.handoff_checkpoint(entry, false, &source, &connection, &original_saved)?;
                    send(writer, &original_command)?;
                    let until = (Instant::now() + Duration::from_secs(3)).min(request.deadline);
                    loop {
                        self.handoff_current(entry, request.generation, until)?;
                        if let Ok((pid, home)) = self.process_home(entry) {
                            if home == source_home
                                && crate::jcode_session::identify(pid, &home)
                                    .is_ok_and(|session| session.id == source.id)
                            {
                                return Ok(());
                            }
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                })();
                recovered_source = rollback.is_ok();
                Err(err(if recovered_source {
                    "계정 연결을 완료하지 못해 원래 계정 경로의 같은 대화로 복구했습니다. 복사본은 보존했습니다."
                } else if launched_target {
                    "새 연결 또는 계정 전환을 확인하지 못했습니다. 다른 AI를 종료하거나 재실행하지 않았습니다. 터미널을 확인하세요."
                } else {
                    "대화 종료 후 계정 연결을 완료하지 못했습니다. 대화 기록은 보존했고 자동 재실행을 중단했습니다. 터미널에서 복구하세요."
                }))
            }
            Err(_) => Err(err(
                "계정 연결 준비 또는 종료 명령 전달을 완료하지 못했습니다. 터미널 상태를 확인하세요.",
            )),
        };
        {
            let mut meta = entry.meta.lock().unwrap();
            meta.saved.as_object_mut().unwrap().remove("restarting");
            if let Some(error) = result.as_ref().err().filter(|_| !recovered_source) {
                meta.saved["accountHandoffError"] = json!(error.to_string());
            } else {
                meta.saved
                    .as_object_mut()
                    .unwrap()
                    .remove("accountHandoffError");
            }
        }
        self.checkpoint(&mut self.state.lock().unwrap())
            .map_err(|_| {
                err("연결 결과를 저장하지 못했습니다. 터미널에서 현재 대화를 확인하세요.")
            })?;
        result
    }

    fn handoff_current(
        &self,
        entry: &Arc<Entry>,
        generation: u64,
        deadline: Instant,
    ) -> io::Result<()> {
        if Instant::now() >= deadline {
            return Err(err("계정 연결 시간이 초과됐습니다."));
        }
        let state = self.state.lock().unwrap();
        if state.closing
            || !state.restored
            || !state.entries.iter().any(|found| Arc::ptr_eq(found, entry))
        {
            return Err(err(
                "서버 또는 터미널 상태가 변경돼 계정 연결을 중단했습니다.",
            ));
        }
        drop(state);
        if entry.input_generation.load(Ordering::SeqCst) != generation {
            return Err(err("사용자 입력이 변경돼 계정 연결을 중단했습니다."));
        }
        if entry.meta.lock().unwrap().saved["conversationHeld"] == true {
            return Err(err("사용자 대화 보호 중에는 계정을 연결하지 않습니다."));
        }
        Ok(())
    }

    fn handoff_screen(&self, entry: &Entry) -> io::Result<Vec<String>> {
        if entry.durable.is_empty() {
            return Err(err("현재 화면을 확인할 수 없어 계정 연결을 보류했습니다."));
        }
        let screen = self.tmux(
            &entry.durable,
            &["capture-pane", "-p", "-J", "-t", "main"],
            None,
            &entry.id,
        )?;
        Ok(activity::clean_screen(&screen, 80).0)
    }

    fn handoff_shell(&self, entry: &Entry, shell: ProcessIdentity, empty: bool) -> io::Result<()> {
        if self.pane_identity(entry)? != (shell.pid, false) || identity(shell.pid)? != Some(shell) {
            return Err(err("원래 셸이 종료되거나 변경돼 자동 입력하지 않았습니다."));
        }
        let name = fs::read_to_string(format!("/proc/{}/comm", shell.pid))?;
        if !["bash", "zsh", "sh", "dash", "ksh"].contains(&name.trim()) {
            return Err(err("안전하게 재개할 수 있는 셸이 아닙니다."));
        }
        if empty {
            let children = fs::read_to_string(format!("/proc/{0}/task/{0}/children", shell.pid))?;
            if !children.trim().is_empty() || activity::detect_process(Some(shell.pid))?.is_some() {
                return Err(err(
                    "셸에서 다른 프로세스가 실행 중이어서 자동 입력하지 않았습니다.",
                ));
            }
        }
        Ok(())
    }

    fn handoff_checkpoint(
        &self,
        entry: &Entry,
        managed: bool,
        source: &crate::jcode_session::LocalSession,
        connection: &SourceConnection,
        account: &Value,
    ) -> io::Result<()> {
        let home = safe_path(&source.home, 4096)?;
        let socket = safe_path(&connection.socket, 107)?;
        let runtime = connection
            .runtime
            .as_deref()
            .map(|path| safe_path(path, 4096))
            .transpose()?;
        let id = &source.id;
        let previous = {
            let mut meta = entry.meta.lock().unwrap();
            let previous = meta.saved.clone();
            meta.saved["jcodeHomeManaged"] = json!(managed);
            meta.saved["jcodeSessionId"] = json!(id);
            meta.saved["command"] = json!(format!("jcode --resume={id}"));
            meta.saved["jcodeSourceHome"] = json!(home);
            meta.saved["jcodeSourceSocket"] = json!(socket);
            meta.saved["jcodeSourceRuntime"] = json!(runtime);
            meta.saved["jcodeSourceHomeImplicit"] = json!(!connection.home_explicit);
            for key in [
                "accountEngine",
                "accountLogin",
                "accountId",
                "accountDisplay",
            ] {
                if let Some(value) = account.get(key) {
                    meta.saved[key] = value.clone();
                } else {
                    meta.saved.as_object_mut().unwrap().remove(key);
                }
            }
            previous
        };
        if let Err(error) = self.checkpoint(&mut self.state.lock().unwrap()) {
            let mut meta = entry.meta.lock().unwrap();
            for key in [
                "jcodeHomeManaged",
                "jcodeSessionId",
                "command",
                "jcodeSourceHome",
                "jcodeSourceSocket",
                "jcodeSourceRuntime",
                "jcodeSourceHomeImplicit",
                "accountEngine",
                "accountLogin",
                "accountId",
                "accountDisplay",
            ] {
                if let Some(value) = previous.get(key) {
                    meta.saved[key] = value.clone();
                } else {
                    meta.saved.as_object_mut().unwrap().remove(key);
                }
            }
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_connection(env: &[u8]) -> io::Result<SourceConnection> {
        let mut env = env.to_vec();
        env.extend_from_slice(b"HOME=/synthetic\0");
        connection_from_env(&env, Some("/synthetic"))
    }

    #[test]
    fn resume_is_an_exact_argument_without_shell_interpolation() {
        let connection = fixture_connection(
            b"JCODE_HOME=/synthetic/source\0JCODE_SOCKET=/synthetic/main.sock\0",
        )
        .unwrap();
        let command = resume_command(
            Path::new("/synthetic/has space'and$symbols"),
            &connection,
            "session-abc_12",
        )
        .unwrap();
        assert_eq!(command, "/usr/bin/env -u JCODE_DEBUG_SOCKET -u JCODE_RUNTIME_DIR JCODE_HOME='/synthetic/has space'\\''and$symbols' JCODE_SOCKET='/synthetic/main.sock' jcode --resume=session-abc_12\r");
        for id in ["x;touch-x", "x\r", "$(id)", "x y"] {
            assert!(resume_command(Path::new("/synthetic"), &connection, id).is_err());
        }
        for home in ["relative", "/safe/../unsafe", "/safe\nline"] {
            assert!(resume_command(Path::new(home), &connection, "abc").is_err());
        }
    }

    #[test]
    fn socket_resolution_preserves_the_original_runtime_contract() {
        let connection = fixture_connection(b"JCODE_SOCKET=/sample/a.sock.b.sock\0JCODE_RUNTIME_DIR=/private/runtime\0JCODE_DEBUG_SOCKET=true\0XDG_RUNTIME_DIR=/ignored\0").unwrap();
        assert_eq!(connection.socket, Path::new("/sample/a.sock.b.sock"));
        assert_eq!(
            connection.debug,
            Path::new("/sample/a-debug.sock.b-debug.sock")
        );
        assert_eq!(
            connection.runtime.as_deref(),
            Some(Path::new("/private/runtime"))
        );
        assert!(
            resume_command(Path::new("/home/source"), &connection, "session_123")
                .unwrap()
                .contains(" JCODE_RUNTIME_DIR='/private/runtime' jcode")
        );
        let connection =
            fixture_connection(b"JCODE_RUNTIME_DIR=/private/runtime\0XDG_RUNTIME_DIR=/ignored\0")
                .unwrap();
        assert_eq!(connection.socket, Path::new("/private/runtime/jcode.sock"));
        let connection = fixture_connection(b"XDG_RUNTIME_DIR=/runtime/user\0").unwrap();
        assert_eq!(connection.socket, Path::new("/runtime/user/jcode.sock"));
        assert!(connection.runtime.is_none());
        let connection = fixture_connection(b"TMPDIR=/temporary\0").unwrap();
        assert_eq!(
            connection.socket,
            PathBuf::from(format!("/temporary/jcode-{}/jcode.sock", unsafe {
                libc::geteuid()
            }))
        );
    }

    #[test]
    fn invalid_or_unbindable_socket_paths_are_refused_before_quit() {
        for env in [
            b"JCODE_SOCKET=relative\0".as_slice(),
            b"JCODE_SOCKET=/safe/../socket\0".as_slice(),
            b"JCODE_SOCKET=/safe\nsocket\0".as_slice(),
            b"JCODE_SOCKET=/\xff\0".as_slice(),
            b"JCODE_SOCKET=/socket\0JCODE_RUNTIME_DIR=\0".as_slice(),
            b"XDG_RUNTIME_DIR=\0".as_slice(),
        ] {
            assert!(fixture_connection(env).is_err());
        }
        let oversized = format!("JCODE_SOCKET=/{}.sock\0", "a".repeat(102));
        assert!(fixture_connection(oversized.as_bytes()).is_err());
        // The derived debug socket also has to fit Linux sockaddr_un.sun_path.
        let oversized_debug = format!("JCODE_SOCKET=/{}.sock\0", "a".repeat(100));
        assert!(fixture_connection(oversized_debug.as_bytes()).is_err());
    }

    #[test]
    fn implicit_home_stays_implicit_and_custom_source_home_is_refused() {
        let connection = fixture_connection(b"JCODE_SOCKET=/synthetic/main.sock\0").unwrap();
        assert!(!connection.home_explicit);
        let command =
            resume_command(Path::new("/synthetic/.jcode"), &connection, "session_123").unwrap();
        assert_eq!(command, "/usr/bin/env -u JCODE_DEBUG_SOCKET -u JCODE_RUNTIME_DIR -u JCODE_HOME JCODE_SOCKET='/synthetic/main.sock' jcode --resume=session_123\r");
        assert!(connection_from_env(b"HOME=/different\0", Some("/synthetic")).is_err());
        assert!(connection_from_env(b"HOME=/synthetic\0", None).is_err());
        assert!(connection_from_env(b"", Some("/synthetic")).is_err());
        let explicit = connection_from_env(
            b"JCODE_HOME=/source/pool\0HOME=/different\0",
            Some("/synthetic"),
        )
        .unwrap();
        assert!(explicit.home_explicit);
        assert!(
            resume_command(Path::new("/source/pool"), &explicit, "session_123")
                .unwrap()
                .contains(" JCODE_HOME='/source/pool' ")
        );
    }
}
