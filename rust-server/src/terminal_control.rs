use super::{activity, json, recovery_command, Entry, Store};
use crate::{board, board_value::V};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use regex::Regex;
use std::{
    io::{self, Write},
    sync::{atomic::Ordering, mpsc, Arc, LazyLock},
    time::Duration,
};

#[derive(Debug, Clone)]
struct Error {
    status: u16,
    message: String,
    code: Option<&'static str>,
}
type Result<T> = std::result::Result<T, Error>;
fn failure(status: u16, message: impl Into<String>) -> Error {
    Error {
        status,
        message: message.into(),
        code: None,
    }
}
fn not_ready(message: impl Into<String>) -> Error {
    Error {
        status: 409,
        message: message.into(),
        code: Some("AGENT_NOT_READY"),
    }
}
fn board_error((status, message): (u16, String)) -> Error {
    failure(status, message)
}
fn held() -> Error {
    Error { status: 409, code: Some("CONVERSATION_HELD"),
    message: "사용자와 대화 중입니다. 메시지는 전달되지 않았습니다. 결과·막힘은 감독보드에 기록하고 가능한 본인 작업을 계속하세요. 사용자가 대화 보호를 해제한 뒤 최신 상황으로 다시 연결하세요.".into() }
}

pub(super) enum WriteRequest {
    Raw(String),
    Agent(AgentRequest),
    Service(ServiceRequest),
    Handoff(super::account_handoff::HandoffRequest),
}
pub(super) struct ServiceRequest {
    data: String,
    generation: u64,
    cancel: crate::ai_transport::Cancel,
    receipt: tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
}
pub(super) struct AgentRequest {
    data: String,
    controls: bool,
    resume: bool,
    generation: u64,
    board: board::Store,
    claim: Option<board::InputClaim>,
    expected_agent: Option<String>,
    account_switch: Option<(String, String, Option<String>)>,
    accepted: mpsc::SyncSender<Result<()>>,
}

pub(crate) fn control_route(method: &Method, path: &str) -> Option<(String, &'static str)> {
    if path == "/api/terminals/accounts/prepare" && *method == Method::POST {
        return Some(("accounts".into(), "/prepare-accounts"));
    }
    if path == "/api/terminals/maintenance" && [Method::GET, Method::POST].contains(method) {
        return Some((
            "maintenance".into(),
            if *method == Method::GET {
                "/maintenance"
            } else {
                "/maintain"
            },
        ));
    }
    let tail = path.strip_prefix("/api/terminals/")?;
    for (verb, suffix) in [
        (Method::POST, "/input"),
        (Method::PUT, "/conversation"),
        (Method::PUT, "/launcher"),
        (Method::GET, "/accounts"),
        (Method::POST, "/account"),
    ] {
        if *method != verb {
            continue;
        }
        if let Some(id) = tail
            .strip_suffix(suffix)
            .filter(|id| !id.is_empty() && !id.contains('/'))
        {
            return Some((id.into(), suffix));
        }
    }
    None
}

fn input_allowed(lines: &[String], agent: &str, data: &str, controls: bool, resume: bool) -> bool {
    static KEYS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:[\r\t\x03\x04\x1a\x7f1-9yn ]|\x1b(?:\[[ABCD])?){1,8}$").unwrap()
    });
    let state = activity::screen_state(lines, true, agent, false, false);
    let keys = controls && KEYS.is_match(data) && ["idle", "busy", "approval"].contains(&state);
    let resume_command = resume
        && agent == "codex"
        && state == "paused"
        && ((data == "\x1b[200~/goal resume\x1b[201~"
            && activity::screen_state(lines, true, agent, true, false) == "idle")
            || (data == "\r" && activity::resume_composer(lines, agent)));
    keys || resume_command
        || (!controls
            && !resume
            && (state == "idle"
                || (state == "busy"
                    && activity::screen_state(lines, true, agent, false, true) == "idle")))
}

impl Store {
    pub(crate) async fn service_input(
        &self,
        id: &str,
        data: String,
        cancel: &crate::ai_transport::Cancel,
    ) -> std::result::Result<(), String> {
        if cancel.is_cancelled() {
            return Err("Agent request cancelled".into());
        }
        let entry = self.find(id).ok_or("Terminal not found")?;
        if data.encode_utf16().count() > 100_000 {
            return Err("Terminal input too large".into());
        }
        let child = cancel.child();
        struct Guard(crate::ai_transport::Cancel);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.cancel();
            }
        }
        let _guard = Guard(child.clone());
        let (receipt, reply) = tokio::sync::oneshot::channel();
        entry
            .writer
            .try_send(WriteRequest::Service(ServiceRequest {
                data,
                generation: entry.input_generation.load(Ordering::SeqCst),
                cancel: child,
                receipt,
            }))
            .map_err(|_| "Terminal input queue unavailable")?;
        tokio::select! {biased; _=cancel.cancelled()=>Err("Agent request cancelled".into()), value=reply=>value.map_err(|_|"Terminal input receipt unavailable")?}
    }
    pub(super) fn deliver_service_input(
        &self,
        entry: &Entry,
        request: ServiceRequest,
        writer: &mut dyn Write,
    ) -> io::Result<()> {
        let _guard = entry.control.lock().unwrap();
        let denied = if request.cancel.is_cancelled() || request.receipt.is_closed() {
            Some("Agent request cancelled")
        } else if entry.meta.lock().unwrap().saved["conversationHeld"] == true {
            Some("사용자 대화 보호 중입니다.")
        } else if {
            let meta = entry.meta.lock().unwrap();
            meta.saved["restarting"] == true || meta.saved["accountHandoffError"].is_string()
        } {
            Some("계정 연결 또는 복구 중에는 자동 입력하지 않습니다.")
        } else if entry.input_generation.load(Ordering::SeqCst) != request.generation {
            Some("Terminal input changed before delivery")
        } else {
            None
        };
        if let Some(error) = denied {
            let _ = request.receipt.send(Err(error.into()));
            return Ok(());
        }
        let result = writer
            .write_all(request.data.as_bytes())
            .and_then(|_| writer.flush());
        let _ = request
            .receipt
            .send(result.as_ref().map(|_| ()).map_err(|e| e.to_string()));
        result
    }
    pub(crate) fn handle_control(
        self: &Arc<Self>,
        raw_id: &str,
        route: &str,
        raw: crate::json_values::Object,
        local: bool,
        board: &board::Store,
    ) -> Response {
        if route != "/conversation" && !local {
            return crate::error(403, "로컬에서만 세션을 제어할 수 있습니다.");
        }
        let Some(id) = crate::decoded_id(raw_id) else {
            return crate::error(400, "Invalid terminal ID");
        };
        let input = match raw
            .into_iter()
            .map(|(k, v)| V::parse(&v).map(|value| (k, value)))
            .collect::<serde_json::Result<_>>()
        {
            Ok(fields) => V::Object(fields),
            Err(_) => return crate::error(400, "Invalid JSON"),
        };
        let result = self.control_request(&id, route, &input, board);
        match result {
            Ok(value) => Json(value).into_response(),
            Err(error) => {
                let mut value = json!({"error":error.message});
                if let Some(code) = error.code {
                    value["code"] = json!(code);
                }
                if error.code == Some("CONVERSATION_HELD") {
                    if let Some(entry) = self.find(&id) {
                        value["termId"] = json!(entry.id);
                    }
                }
                (
                    axum::http::StatusCode::from_u16(error.status).unwrap(),
                    Json(value),
                )
                    .into_response()
            }
        }
    }
    fn control_request(
        self: &Arc<Self>,
        id: &str,
        route: &str,
        input: &V,
        board: &board::Store,
    ) -> Result<serde_json::Value> {
        if route == "/prepare-accounts" {
            return crate::jcode_accounts::prepare(
                &self.accounts,
                &self.directory.join("jcode-accounts"),
            )
            .map_err(|error| failure(409, error.to_string()));
        }
        if route == "/maintenance" || route == "/maintain" {
            return self
                .maintenance_request(route == "/maintain", input, board)
                .map_err(|error| {
                    failure(
                        if error.kind() == io::ErrorKind::NotFound {
                            404
                        } else {
                            409
                        },
                        error.to_string(),
                    )
                });
        }
        if route == "/input"
            && (!input["data"].is_string()
                || !input["data"].truthy()
                || input["data"].units().len() > 100_000)
        {
            return Err(failure(400, "data 필드(1~100000자 문자열)가 필요합니다."));
        }
        if route == "/conversation" && !matches!(input["held"], V::Bool(_)) {
            return Err(failure(400, "held는 true 또는 false여야 합니다."));
        }
        let entry = self
            .find(id)
            .ok_or_else(|| failure(404, "Terminal not found"))?;
        match route {
            "/accounts" => self
                .selectable_accounts(&entry)
                .map_err(|error| failure(409, error.to_string())),
            "/account" => {
                let (provider, label) = if input["accountId"].is_string() {
                    let account_id = input["accountId"].text();
                    let (_, home) = self
                        .process_home(&entry)
                        .map_err(|error| failure(409, error.to_string()))?;
                    if home != self.directory.join("jcode-accounts")
                        || self
                            .accounts
                            .native_profile(&account_id)
                            .is_ok_and(|profile| profile.exists() || profile.binary.is_file())
                    {
                        let (reply, receiver) = mpsc::sync_channel(1);
                        entry
                            .writer
                            .try_send(WriteRequest::Handoff(
                                super::account_handoff::HandoffRequest {
                                    account_id,
                                    generation: entry.input_generation.load(Ordering::SeqCst),
                                    reply,
                                    deadline: std::time::Instant::now() + Duration::from_secs(40),
                                },
                            ))
                            .map_err(|_| {
                                not_ready("터미널 입력 대기열이 가득 찼거나 닫혔습니다.")
                            })?;
                        return receiver.recv_timeout(Duration::from_secs(45))
                            .map_err(|_|not_ready("계정 연결 응답을 확인하지 못했습니다. 터미널 상태를 확인하세요."))?
                            .map_err(|error|failure(409,error.to_string()));
                    }
                    let pool = crate::jcode_accounts::metadata(&home)
                        .map_err(|error| failure(409, error.to_string()))?;
                    let account = pool["accounts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|item| item["id"] == account_id)
                        .ok_or_else(|| {
                            failure(409, "연결된 계정 목록에서 계정을 찾지 못했습니다.")
                        })?;
                    (
                        account["provider"].as_str().unwrap().to_string(),
                        account["label"].as_str().unwrap().to_string(),
                    )
                } else {
                    (input["provider"].text(), input["label"].text())
                };
                let selection = input["selectionKey"]
                    .is_string()
                    .then(|| input["selectionKey"].text());
                self.check_account_selection(&entry, &provider, &label, selection.as_deref())
                    .map_err(|error| failure(409, error.to_string()))?;
                let data = super::native_accounts::switch_command(&provider, &label)
                    .map_err(|error| failure(400, error.to_string()))?;
                self.send_agent_input(
                    &entry,
                    data,
                    false,
                    false,
                    None,
                    board,
                    Some("jcode"),
                    Some((provider, label, selection)),
                )?;
                entry
                    .meta
                    .lock()
                    .unwrap()
                    .saved
                    .as_object_mut()
                    .unwrap()
                    .remove("accountHandoffError");
                self.checkpoint(&mut self.state.lock().unwrap()).map_err(|_|failure(409,"전환 명령을 전달했지만 복구 상태 저장에 실패했습니다. 터미널 결과를 확인하세요."))?;
                Ok(json!({"accepted":true,"termId":entry.id}))
            }
            "/input" => {
                let data = input["data"].text();
                let payload = if data.contains('\n') {
                    format!("\x1b[200~{data}\x1b[201~")
                } else {
                    data
                };
                let controls = input["enter"] == V::Bool(false);
                self.send_agent_input(
                    &entry,
                    if controls { payload } else { payload + "\r" },
                    controls,
                    false,
                    input
                        .has("supervision")
                        .then(|| board::InputClaim::Supervisor(input["supervision"].clone())),
                    board,
                    None,
                    None,
                )?;
                Ok(
                    json!({"ok":true,"termId":entry.id,"alias":entry.meta.lock().unwrap().saved["alias"]}),
                )
            }
            "/conversation" => {
                self.conversation(&entry, input["held"] == V::Bool(true), board)?;
                Ok(
                    json!({"ok":true,"termId":entry.id,"conversationHeld":input["held"] == V::Bool(true)}),
                )
            }
            "/launcher" => {
                self.launcher(&entry, input, board)?;
                Ok(json!({"ok":true,"termId":entry.id,"command":input["command"].text()}))
            }
            _ => Err(failure(501, "Terminal control migration incomplete")),
        }
    }
    fn send_agent_input(
        &self,
        entry: &Arc<Entry>,
        data: String,
        controls: bool,
        resume: bool,
        claim: Option<board::InputClaim>,
        board: &board::Store,
        expected_agent: Option<&str>,
        account_switch: Option<(String, String, Option<String>)>,
    ) -> Result<()> {
        if entry.meta.lock().unwrap().saved["conversationHeld"] == true {
            return Err(held());
        }
        // A rendezvous receipt cancels queued input when the caller times out:
        // the writer cannot start sending unless a waiting caller accepts it.
        let (accepted, receiver) = mpsc::sync_channel(0);
        let request = AgentRequest {
            data,
            controls,
            resume,
            claim,
            expected_agent: expected_agent.map(str::to_string),
            account_switch,
            board: board.clone(),
            accepted,
            generation: entry.input_generation.load(Ordering::SeqCst),
        };
        entry
            .writer
            .try_send(WriteRequest::Agent(request))
            .map_err(|_| not_ready("터미널 입력 대기열이 가득 찼거나 닫혔습니다."))?;
        receiver.recv_timeout(Duration::from_secs(8)).map_err(|_| {
            not_ready("입력 접수 기한이 지나 전달을 취소했습니다. 현재 상태를 다시 확인하세요.")
        })?
    }
    pub(crate) fn send_worker_input(
        &self,
        id: &str,
        data: String,
        resume: bool,
        review: &V,
        board: &board::Store,
        agent: &str,
    ) -> std::result::Result<(), String> {
        let entry = self
            .find(id)
            .ok_or_else(|| "작업자 세션을 찾지 못했습니다.".to_string())?;
        self.send_agent_input(
            &entry,
            data,
            false,
            resume,
            Some(board::InputClaim::Worker(review.clone())),
            board,
            Some(agent),
            None,
        )
        .map_err(|error| error.message)
    }
    pub(crate) fn send_review_input(
        &self,
        review: &V,
        data: String,
        board: &board::Store,
        agent: &str,
    ) -> std::result::Result<(), String> {
        let entry = self
            .find(&review["termId"].text())
            .ok_or("감독 세션을 찾지 못했습니다.")?;
        self.send_agent_input(
            &entry,
            data,
            false,
            false,
            Some(board::InputClaim::Review(review.clone())),
            board,
            Some(agent),
            None,
        )
        .map_err(|error| error.message)
    }
    fn check_agent_input(&self, entry: &Arc<Entry>, request: &AgentRequest) -> Result<()> {
        if self.is_closing() {
            return Err(not_ready("서버가 종료 중입니다."));
        }
        let meta = entry.meta.lock().unwrap();
        if meta.saved["conversationHeld"] == true {
            return Err(held());
        }
        if meta.saved["restarting"] == true {
            return Err(not_ready(
                "세션이 재시작 중입니다. 자동 입력을 전달하지 않았습니다.",
            ));
        }
        if meta.saved["accountHandoffError"].is_string() && request.account_switch.is_none() {
            return Err(not_ready(
                "계정 연결 복구가 필요합니다. 터미널에서 실행 상태를 확인하세요.",
            ));
        }
        drop(meta);
        if !self
            .find(&entry.id)
            .is_some_and(|found| Arc::ptr_eq(&found, entry))
        {
            return Err(not_ready("입력 대상 세션이 변경됐습니다."));
        }
        let agent = self
            .agent(entry)
            .filter(|agent| !agent.is_empty())
            .ok_or_else(|| {
                not_ready(
                    "실행 중인 AI를 확인하지 못했습니다. 쉘에는 자동 입력을 전달하지 않습니다.",
                )
            })?;
        if request
            .expected_agent
            .as_ref()
            .is_some_and(|expected| expected != &agent)
        {
            return Err(not_ready(
                "AI 입력 대상이 변경됐습니다. 다음 점검에서 다시 확인합니다.",
            ));
        }
        if entry.durable.is_empty() {
            return Err(not_ready(
                "현재 AI 화면을 확인하지 못해 입력을 보류했습니다.",
            ));
        }
        let screen = self
            .capture_screen(entry)
            .map_err(|_| not_ready("현재 AI 화면을 확인하지 못해 입력을 보류했습니다."))?;
        let lines = activity::clean_screen(&screen, 80).0;
        let allowed = if let Some((provider, label, selection)) = &request.account_switch {
            self.check_account_selection(entry, provider, label, selection.as_deref())
                .map_err(|error| not_ready(error.to_string()))?;
            agent == "jcode" && super::native_accounts::switch_input_allowed(&lines)
        } else {
            input_allowed(
                &lines,
                &agent,
                &request.data,
                request.controls,
                request.resume,
            )
        };
        if !allowed {
            return Err(not_ready(
                "AI가 입력 가능한 상태가 아닙니다. 승인·초기화·작성 중인 입력을 확인하세요.",
            ));
        }
        if self.agent(entry).as_deref() != Some(agent.as_str())
            || entry.input_generation.load(Ordering::SeqCst) != request.generation
        {
            return Err(not_ready(
                "입력 직전 AI나 사용자 입력 상태가 변경돼 전달을 취소했습니다.",
            ));
        }
        Ok(())
    }
    pub(super) fn deliver_agent_input(
        &self,
        entry: &Arc<Entry>,
        request: AgentRequest,
        writer: &mut Box<dyn Write + Send>,
    ) -> io::Result<()> {
        let _guard = entry.control.lock().unwrap();
        if let Err(error) = self.check_agent_input(entry, &request) {
            let _ = request.accepted.send(Err(error));
            return Ok(());
        }
        let accept = || {
            if self.is_closing() {
                let _ = request
                    .accepted
                    .send(Err(not_ready("서버가 종료 중입니다.")));
                return false;
            }
            if entry.meta.lock().unwrap().saved["conversationHeld"] == true {
                let _ = request.accepted.send(Err(held()));
                return false;
            }
            if entry.input_generation.load(Ordering::SeqCst) != request.generation {
                let _ = request.accepted.send(Err(not_ready(
                    "사용자 입력이 시작돼 자동 전달을 취소했습니다.",
                )));
                false
            } else {
                request.accepted.send(Ok(())).is_ok()
            }
        };
        let accepted = if let Some(claim) = &request.claim {
            match request.board.input_claim(&entry.id, claim, accept) {
                Ok(accepted) => accepted,
                Err(error) => {
                    let _ = request.accepted.send(Err(board_error(error)));
                    false
                }
            }
        } else {
            accept()
        };
        // Acceptance is serialized with guard changes. The OS write may block
        // when a PTY stops consuming input; it must not block guard persistence.
        drop(_guard);
        if accepted {
            writer.write_all(request.data.as_bytes())?;
            writer.flush()?;
        }
        Ok(())
    }
    fn persist_entry(
        &self,
        entry: &Arc<Entry>,
        field: &str,
        value: serde_json::Value,
    ) -> io::Result<()> {
        entry.meta.lock().unwrap().saved[field] = value;
        self.checkpoint(&mut self.state.lock().unwrap())
    }
    fn conversation(&self, entry: &Arc<Entry>, held: bool, board: &board::Store) -> Result<()> {
        let _operation = self.operations.lock().unwrap();
        if !self
            .find(&entry.id)
            .is_some_and(|found| Arc::ptr_eq(&found, entry))
        {
            return Err(failure(404, "Terminal not found"));
        }
        {
            let mut meta = entry.meta.lock().unwrap();
            let previous = meta.saved["conversationHeld"] == true;
            if previous == held && !meta.conversation_dirty {
                return Ok(());
            }
            meta.conversation_dirty = true;
            if held {
                meta.saved["conversationHeld"] = json!(true);
            }
        }
        let _guard = entry.control.lock().unwrap();
        // Commit the closed guard first. A failed release stays protected across
        // a restart; background metadata never opens the terminal prematurely.
        self.persist_entry(entry, "conversationHeld", json!(true))
            .map_err(|e| failure(500, format!("대화 보호 저장 실패: {e}")))?;
        board
            .conversation_changed(&entry.id, held)
            .map_err(|(_, message)| failure(500, format!("대화 보호 저장 실패: {message}")))?;
        if !held {
            if let Err(error) = self.persist_entry(entry, "conversationHeld", json!(false)) {
                let _ = self.persist_entry(entry, "conversationHeld", json!(true));
                return Err(failure(500, format!("대화 보호 저장 실패: {error}")));
            }
        }
        entry.meta.lock().unwrap().conversation_dirty = false;
        Ok(())
    }
    fn launcher(&self, entry: &Arc<Entry>, input: &V, board: &board::Store) -> Result<()> {
        let _operation = self.operations.lock().unwrap();
        let _guard = entry.control.lock().unwrap();
        if !self
            .find(&entry.id)
            .is_some_and(|found| Arc::ptr_eq(&found, entry))
        {
            return Err(failure(404, "Terminal not found"));
        }
        if entry.meta.lock().unwrap().saved["conversationHeld"] == true {
            return Err(failure(409, "사용자 대화 보호 중입니다."));
        }
        let command = input["command"].text();
        if !input["command"].is_string() || !recovery_command(&command) {
            return Err(failure(400, "자동 복구는 기본 AI 실행 명령과 단일 옵션만 지원합니다. 로그인·일회성 명령은 지원하지 않습니다."));
        }
        let previous = entry.meta.lock().unwrap().saved["command"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if input["expected"] != V::from(previous.clone())
            || self.agent(entry).as_deref() != command.split(' ').next()
        {
            return Err(failure(
                409,
                "현재 실행 중인 AI와 기존 실행 명령을 다시 확인하세요.",
            ));
        }
        let result = board.launcher_change(&entry.id, &command, || {
            self.persist_entry(entry, "command", json!(command))
        });
        if result.is_err() {
            entry.meta.lock().unwrap().saved["command"] = json!(previous);
        }
        result.map_err(board_error)
    }
}
