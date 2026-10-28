//! Telegram transport and human approvals. Agent command routing is injected separately.
use crate::{
    ai_transport::Cancel,
    board_value::{object, V},
    supervisor::{ChannelFuture, HumanChannel},
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    collections::BTreeMap,
    fs,
    future::Future,
    io::{self, Read, Seek, SeekFrom, Write},
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};
use tokio::{
    sync::{oneshot, Mutex as AsyncMutex},
    task::JoinHandle,
};
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/telegram/status"),
    ("POST", "/api/telegram/config"),
    ("POST", "/api/telegram/start"),
    ("POST", "/api/telegram/stop"),
    ("POST", "/api/telegram/test"),
];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, target)| method.as_str() == *verb && path == *target)
}
pub type UpdateHandler = Arc<
    dyn Fn(V, UpdateContext) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;
#[derive(Clone)]
pub struct UpdateContext {
    pub cancel: Cancel,
    pub generation: u64,
}
const BODY_LIMIT: usize = 4 * 1024 * 1024;
struct Approval {
    sender: oneshot::Sender<bool>,
    label: String,
    detail: String,
    hard: bool,
}
struct Ask {
    sender: oneshot::Sender<Option<String>>,
    message: V,
}
struct Poller {
    cancel: Cancel,
    ready: bool,
    task: Option<JoinHandle<()>>,
}
struct State {
    config: V,
    config_cancel: Cancel,
    generation: u64,
    offset: f64,
    approvals: BTreeMap<String, Approval>,
    asks: BTreeMap<String, Ask>,
    trust_until: i64,
}
pub struct Store {
    directory: PathBuf,
    state: Mutex<State>,
    writes: Mutex<()>,
    control: AsyncMutex<()>,
    stop_generation: AtomicU64,
    poller: Mutex<Option<Poller>>,
    closing: Cancel,
    handler: Mutex<Option<UpdateHandler>>,
}
fn invalid() -> io::Error {
    io::Error::other("Invalid Telegram storage")
}
fn now() -> i64 {
    crate::account_usage::now()
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn or(value: &V, fallback: &str) -> V {
    if value.truthy() {
        value.clone()
    } else {
        fallback.into()
    }
}
fn cut(value: &str, n: usize) -> String {
    V::from(value).cut(n).text()
}
fn enabled(config: &V) -> bool {
    config["token"].truthy() && config["chatId"].truthy() && config["enabled"] != V::Bool(false)
}
fn read_config(directory: &std::path::Path) -> io::Result<V> {
    let path = directory.join("telegram-config.json");
    if !crate::account_hub::safe_path(directory, &path) {
        return Err(invalid());
    }
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(V::Null),
        Ok(m) if m.is_file() && m.len() <= BODY_LIMIT as u64 => {}
        _ => return Err(invalid()),
    }
    let raw = serde_json::value::RawValue::from_string(fs::read_to_string(path)?)
        .map_err(|_| invalid())?;
    let value = V::parse(&raw).map_err(|_| invalid())?;
    if !matches!(value, V::Object(_)) {
        return Err(invalid());
    }
    Ok(value)
}
struct PendingGuard {
    store: Weak<Store>,
    id: String,
    approval: bool,
    cancel: Cancel,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(store) = self.store.upgrade() {
            let mut state = store.state.lock().unwrap();
            if self.approval {
                state.approvals.remove(&self.id);
            } else {
                state.asks.remove(&self.id);
            }
        }
    }
}
struct StartupGuard {
    cancel: Cancel,
    armed: bool,
}
impl Drop for StartupGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancel.cancel();
        }
    }
}
impl Store {
    pub fn new(directory: PathBuf) -> Arc<Self> {
        let config = read_config(&directory).unwrap_or(V::Null);
        Arc::new(Self {
            directory,
            state: Mutex::new(State {
                config,
                config_cancel: Cancel::default(),
                generation: 0,
                offset: 0.0,
                approvals: BTreeMap::new(),
                asks: BTreeMap::new(),
                trust_until: 0,
            }),
            writes: Mutex::new(()),
            control: AsyncMutex::new(()),
            stop_generation: AtomicU64::new(0),
            poller: Mutex::new(None),
            closing: Cancel::default(),
            handler: Mutex::new(None),
        })
    }
    pub fn enabled(&self) -> bool {
        enabled(&self.state.lock().unwrap().config)
    }
    pub fn set_update_handler(&self, handler: Option<UpdateHandler>) {
        *self.handler.lock().unwrap() = handler;
    }
    pub fn config(&self) -> V {
        let mut value = self.state.lock().unwrap().config.clone();
        if value != V::Null {
            value["token"] = if value["token"].truthy() {
                "***".into()
            } else {
                V::Null
            };
        }
        value
    }
    pub fn is_polling(&self) -> bool {
        self.poller.lock().unwrap().as_ref().is_some_and(|p| {
            p.ready && !p.cancel.is_cancelled() && p.task.as_ref().is_some_and(|t| !t.is_finished())
        })
    }
    pub fn diagnostics(&self) -> V {
        let state = self.state.lock().unwrap();
        object([
            ("offset", state.offset.into()),
            ("pendingApprovals", (state.approvals.len() as f64).into()),
        ])
    }
    pub fn command_current(&self, context: &UpdateContext) -> bool {
        !context.cancel.is_cancelled()
            && !self.closing.is_cancelled()
            && self.state.lock().unwrap().generation == context.generation
    }
    pub async fn typing(&self, context: &UpdateContext) -> Result<(), String> {
        if !self.command_current(context) {
            return Err("Telegram command cancelled".into());
        }
        let chat = self.state.lock().unwrap().config["chatId"].clone();
        self.request(
            "sendChatAction",
            object([("chat_id", chat), ("action", "typing".into())]),
            &context.cancel,
        )
        .await?;
        Ok(())
    }
    pub async fn expired_callback(&self, id: &V, context: &UpdateContext) -> Result<(), String> {
        if !self.command_current(context) {
            return Err("Telegram command cancelled".into());
        }
        self.request(
            "answerCallbackQuery",
            object([
                ("callback_query_id", id.clone()),
                ("text", "⌛ 만료되었거나 이미 처리됨".into()),
            ]),
            &context.cancel,
        )
        .await?;
        Ok(())
    }
    async fn save_config(&self, config: V) -> Result<(), String> {
        self.cancel_starts();
        let _control = self.control.lock().await;
        self.stop_inner().await;
        if self.closing.is_cancelled() {
            return Err("Server is shutting down".into());
        }
        let _writes = self.writes.lock().unwrap();
        read_config(&self.directory)
            .map_err(|_| "Telegram configuration storage operation failed")?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|_| "Telegram configuration storage operation failed")?;
        temporary
            .write_all(config.raw().get().as_bytes())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "Telegram configuration storage operation failed")?;
        temporary
            .persist(self.directory.join("telegram-config.json"))
            .map_err(|_| "Telegram configuration storage operation failed")?;
        let mut state = self.state.lock().unwrap();
        state.config_cancel.cancel();
        state.config_cancel = Cancel::default();
        state.generation = state.generation.wrapping_add(1);
        state.config = config;
        state.trust_until = 0;
        state.approvals.clear();
        state.asks.clear();
        Ok(())
    }
    async fn request(&self, method: &str, body: V, cancel: &Cancel) -> Result<V, String> {
        if self.closing.is_cancelled() || cancel.is_cancelled() {
            return Err("Telegram request cancelled".into());
        }
        let (config, config_cancel) = {
            let state = self.state.lock().unwrap();
            (state.config.clone(), state.config_cancel.clone())
        };
        if body.has("chat_id") && body["chat_id"].text() != config["chatId"].text() {
            return Err("Telegram configuration changed".into());
        }
        let token = config["token"].clone();
        if !token.truthy() {
            return Err("telegram not configured".into());
        }
        let token = token.text();
        let mut url = if let Ok(base) = std::env::var("COCKPIT_PREVIEW_TELEGRAM_BASE") {
            let parsed = url::Url::parse(&base).map_err(|_| "Invalid private Telegram endpoint")?;
            if parsed.scheme() != "http"
                || !parsed
                    .host_str()
                    .and_then(|host| host.parse::<IpAddr>().ok())
                    .is_some_and(|ip| ip.is_loopback())
                || parsed.username() != ""
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
                || parsed.path() != "/"
            {
                return Err("Private Telegram endpoint must be a loopback HTTP origin".into());
            }
            parsed
        } else {
            url::Url::parse("https://api.telegram.org").unwrap()
        };
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| "Invalid Telegram endpoint")?;
            path.clear().push(&format!("bot{token}")).push(method);
        }
        let deadline = if method == "getUpdates" && body["timeout"].number() > 0.0 {
            Duration::from_secs_f64(body["timeout"].number().min(25.0) + 5.0)
        } else {
            Duration::from_secs(15)
        };
        for attempt in 0..3 {
            let operation = async {
                let mut builder = reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none());
                if url.host_str() == Some("api.telegram.org") {
                    let addresses = tokio::net::lookup_host(("api.telegram.org", 443))
                        .await
                        .map_err(|_| ("Telegram name resolution failed".to_string(), true))?
                        .filter(|addr| addr.is_ipv4())
                        .collect::<Vec<_>>();
                    if addresses.is_empty() {
                        return Err(("Telegram IPv4 address unavailable".into(), true));
                    }
                    builder = builder
                        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
                        .resolve_to_addrs("api.telegram.org", &addresses);
                }
                let client = builder
                    .build()
                    .map_err(|_| ("Telegram HTTP client setup failed".to_string(), false))?;
                let mut response = client
                    .post(url.clone())
                    .header("content-type", "application/json")
                    .body(body.raw().get().to_string())
                    .send()
                    .await
                    .map_err(|e| {
                        (
                            "Telegram request failed".to_string(),
                            e.is_timeout() || e.is_connect() || e.is_body(),
                        )
                    })?;
                if response
                    .content_length()
                    .is_some_and(|n| n > BODY_LIMIT as u64)
                {
                    return Err(("Telegram response exceeds limit".into(), false));
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| ("Telegram response read failed".to_string(), true))?
                {
                    if bytes.len() + chunk.len() > BODY_LIMIT {
                        return Err(("Telegram response exceeds limit".into(), false));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let raw = serde_json::value::RawValue::from_string(
                    String::from_utf8(bytes)
                        .map_err(|_| ("Invalid Telegram response".to_string(), false))?,
                )
                .map_err(|_| ("Invalid Telegram response".to_string(), false))?;
                V::parse(&raw).map_err(|_| ("Invalid Telegram response".to_string(), false))
            };
            let result = tokio::select! { biased; _=self.closing.cancelled()=>return Err("Telegram request cancelled".into()), _=config_cancel.cancelled()=>return Err("Telegram configuration changed".into()), _=cancel.cancelled()=>return Err("Telegram request cancelled".into()), result=tokio::time::timeout(deadline,operation)=>result.unwrap_or_else(|_|Err(("Telegram request timed out".into(),true))) };
            match result {
                Ok(value) => return Ok(value),
                Err((message, retry)) if !retry || attempt == 2 => return Err(message),
                _ => {
                    tokio::select! { biased; _=self.closing.cancelled()=>return Err("Telegram request cancelled".into()), _=config_cancel.cancelled()=>return Err("Telegram configuration changed".into()), _=cancel.cancelled()=>return Err("Telegram request cancelled".into()), _=tokio::time::sleep(Duration::from_millis(500 << attempt))=>{} }
                }
            }
        }
        unreachable!()
    }
    pub async fn send_message(&self, text: V, options: V) -> Result<V, String> {
        self.send(text, options, &Cancel::default()).await
    }
    pub async fn send_cancellable(
        &self,
        text: V,
        options: V,
        cancel: &Cancel,
    ) -> Result<V, String> {
        self.send(text, options, cancel).await
    }
    async fn send(&self, text: V, options: V, cancel: &Cancel) -> Result<V, String> {
        let (config, config_cancel) = {
            let state = self.state.lock().unwrap();
            (state.config.clone(), state.config_cancel.clone())
        };
        if !enabled(&config) {
            return Ok(object([
                ("ok", false.into()),
                ("skipped", "telegram disabled".into()),
            ]));
        }
        let mut last = V::Null;
        for chunk in split_text(&text) {
            let mut body = object([
                ("chat_id", config["chatId"].clone()),
                ("text", chunk),
                ("disable_notification", options["silent"].truthy().into()),
            ]);
            if options["parseMode"].truthy() {
                body["parse_mode"] = options["parseMode"].clone();
            }
            last = tokio::select! {
                biased;
                _ = config_cancel.cancelled() => return Err("Telegram configuration changed".into()),
                result = self.request("sendMessage", body, cancel) => result?,
            };
        }
        Ok(last)
    }
    pub async fn start_polling(self: &Arc<Self>) -> bool {
        let generation = self.stop_generation.load(Ordering::Acquire);
        let _control = self.control.lock().await;
        if generation != self.stop_generation.load(Ordering::Acquire) {
            return false;
        }
        if self.closing.is_cancelled() || !self.enabled() {
            return false;
        }
        if self.is_polling() {
            return true;
        }
        self.stop_inner().await;
        let cancel = Cancel::default();
        *self.poller.lock().unwrap() = Some(Poller {
            cancel: cancel.clone(),
            ready: false,
            task: None,
        });
        // A stop may arrive between the first generation check and publishing
        // this cancellation token. After publication, stop can see the token.
        if generation != self.stop_generation.load(Ordering::Acquire) {
            cancel.cancel();
            self.poller.lock().unwrap().take();
            return false;
        }
        let mut guard = StartupGuard {
            cancel: cancel.clone(),
            armed: true,
        };
        let mut offset = 0.0;
        self.state.lock().unwrap().offset = offset;
        if let Ok(initial) = self
            .request(
                "getUpdates",
                object([("timeout", 0.0.into()), ("limit", 100.0.into())]),
                &cancel,
            )
            .await
        {
            if let Some(last) = initial["result"].array().last() {
                offset = last["update_id"].number() + 1.0;
            }
        }
        if cancel.is_cancelled() || self.closing.is_cancelled() {
            self.poller.lock().unwrap().take();
            return false;
        }
        self.state.lock().unwrap().offset = offset;
        let store = self.clone();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            store.poll_loop(offset, task_cancel).await;
        });
        *self.poller.lock().unwrap() = Some(Poller {
            cancel,
            ready: true,
            task: Some(task),
        });
        guard.armed = false;
        true
    }
    async fn poll_loop(self: Arc<Self>, mut offset: f64, cancel: Cancel) {
        let mut workers = tokio::task::JoinSet::new();
        {
            let store = self.clone();
            let cancel = cancel.clone();
            workers.spawn(async move {
                let _ = store
                    .send(
                        "🤖 Cockpit 봇 연결됨. /help".into(),
                        object([("silent", true.into())]),
                        &cancel,
                    )
                    .await;
            });
        }
        loop {
            if cancel.is_cancelled() || self.closing.is_cancelled() {
                break;
            }
            let get = self.request(
                "getUpdates",
                object([("offset", offset.into()), ("timeout", 25.0.into())]),
                &cancel,
            );
            tokio::pin!(get);
            let result = loop {
                tokio::select! { biased; _=self.closing.cancelled()=>break None, _=cancel.cancelled()=>break None, _=workers.join_next(), if !workers.is_empty()=>{}, result=&mut get=>break Some(result) }
            };
            match result {
                None => break,
                Some(Ok(result)) => {
                    if result["ok"] == V::Bool(false) {
                        tokio::select! { _=cancel.cancelled()=>break, _=self.closing.cancelled()=>break, _=tokio::time::sleep(Duration::from_secs(2))=>{} }
                        continue;
                    }
                    for update in result["result"].array() {
                        let id = update["update_id"].number();
                        if !id.is_finite() || id < offset {
                            continue;
                        }
                        offset = id + 1.0;
                        self.state.lock().unwrap().offset = offset;
                        let store = self.clone();
                        let update = update.clone();
                        let child_cancel = cancel.clone();
                        while workers.len() >= 32 {
                            tokio::select! { biased; _=cancel.cancelled()=>break, _=self.closing.cancelled()=>break, _=workers.join_next()=>{} }
                        }
                        if cancel.is_cancelled() || self.closing.is_cancelled() {
                            break;
                        }
                        workers.spawn(async move {
                            let _ = store.dispatch(update, &child_cancel).await;
                        });
                    }
                    if result["result"].array().is_empty() {
                        tokio::select! { _=cancel.cancelled()=>break, _=self.closing.cancelled()=>break, _=tokio::time::sleep(Duration::from_millis(25))=>{} }
                    }
                }
                Some(Err(_)) => {
                    tokio::select! { _=cancel.cancelled()=>break, _=self.closing.cancelled()=>break, _=tokio::time::sleep(Duration::from_secs(2))=>{} }
                }
            }
        }
        workers.abort_all();
        while workers.join_next().await.is_some() {}
    }
    async fn stop_inner(&self) {
        let poller = self.poller.lock().unwrap().take();
        if let Some(poller) = poller {
            poller.cancel.cancel();
            if let Some(task) = poller.task {
                let _ = task.await;
            }
        }
    }
    fn cancel_starts(&self) {
        self.stop_generation.fetch_add(1, Ordering::AcqRel);
        if let Some(poller) = self.poller.lock().unwrap().as_ref() {
            poller.cancel.cancel();
        }
    }
    pub async fn stop_polling(&self) {
        self.cancel_starts();
        let _control = self.control.lock().await;
        self.stop_inner().await;
    }
    pub async fn shutdown(&self) {
        self.closing.cancel();
        {
            let mut state = self.state.lock().unwrap();
            state.config_cancel.cancel();
            state.approvals.clear();
            state.asks.clear();
        }
        self.stop_polling().await;
    }
    fn audit(&self, mut record: V) -> io::Result<()> {
        let _writes = self.writes.lock().unwrap();
        let directory = self.directory.join("logs");
        let path = directory.join("approvals.jsonl");
        if !crate::account_hub::safe_path(&self.directory, &path) {
            return Err(invalid());
        }
        fs::create_dir_all(&directory)?;
        let mut options = fs::OpenOptions::new();
        options.read(true).append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options.open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(invalid());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        let mut needs_newline = false;
        if metadata.len() > 0 {
            file.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            file.read_exact(&mut last)?;
            needs_newline = last[0] != b'\n';
        }
        record["ts"] = chrono::DateTime::from_timestamp_millis(now())
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            .into();
        let mut row = Vec::new();
        if needs_newline {
            row.push(b'\n');
        }
        row.extend_from_slice(record.raw().get().as_bytes());
        row.push(b'\n');
        file.write_all(&row)?;
        file.sync_data()
    }
    pub fn trust_state(&self) -> V {
        let remaining = (self.state.lock().unwrap().trust_until - now()).max(0);
        object([
            ("active", (remaining > 0).into()),
            ("remainingMs", (remaining as f64).into()),
        ])
    }
    pub fn set_trust_window(&self, milliseconds: i64) -> V {
        self.state.lock().unwrap().trust_until = if milliseconds > 0 {
            now().saturating_add(milliseconds)
        } else {
            0
        };
        self.trust_state()
    }

    pub async fn request_approval(
        self: &Arc<Self>,
        label: String,
        detail: String,
        hard: bool,
    ) -> Result<bool, String> {
        if self.closing.is_cancelled() {
            return Ok(false);
        }
        let trust = self.trust_state();
        let decision = if !hard && trust["active"].truthy() {
            Some("trust-auto")
        } else if !self.enabled() {
            Some("deny-no-telegram")
        } else {
            None
        };
        if let Some(decision) = decision {
            let mut record = object([
                ("label", label.into()),
                ("detail", detail.into()),
                ("decision", decision.into()),
            ]);
            if decision == "trust-auto" {
                record["remainingMs"] = trust["remainingMs"].clone();
            } else {
                record["hard"] = hard.into();
            }
            self.audit(record)
                .map_err(|_| "Telegram approval audit storage operation failed")?;
            return Ok(decision == "trust-auto");
        }
        let id = format!("{:016x}", rand::random::<u64>());
        let (sender, receiver) = oneshot::channel();
        let cancel = Cancel::default();
        self.state.lock().unwrap().approvals.insert(
            id.clone(),
            Approval {
                sender,
                label: label.clone(),
                detail: detail.clone(),
                hard,
            },
        );
        let _guard = PendingGuard {
            store: Arc::downgrade(self),
            id: id.clone(),
            approval: true,
            cancel: cancel.clone(),
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let note = if hard && trust["active"].truthy() {
            "\n⚠️ <i>신뢰 모드 활성 중이지만 hard-risk 라 확인 필요.</i>"
        } else {
            ""
        };
        let text = format!(
            "🤖 <b>도구 실행 승인 요청{}</b>\n{}\n\n<code>{}</code>{note}",
            if hard { " (HARD)" } else { "" },
            escape(&label),
            escape(&cut(&detail, 500))
        );
        let body = object([
            (
                "chat_id",
                self.state.lock().unwrap().config["chatId"].clone(),
            ),
            ("text", text.into()),
            ("parse_mode", "HTML".into()),
            (
                "reply_markup",
                keyboard(&[
                    ("✅ 승인", format!("apr:{id}:y")),
                    ("❌ 거부", format!("apr:{id}:n")),
                ]),
            ),
        ]);
        let send = self.request("sendMessage", body, &cancel);
        tokio::pin!(send);
        tokio::pin!(receiver);
        let mut sent = false;
        loop {
            tokio::select! { biased;
                _=self.closing.cancelled()=>return Ok(false),
                answer=&mut receiver=>return Ok(answer.unwrap_or(false)),
                _=tokio::time::sleep_until(deadline)=>break,
                result=&mut send, if !sent=>{
                sent=true;
                if result.as_ref().is_err() || result.as_ref().is_ok_and(|v|v["ok"]==V::Bool(false)) {
                    let entry=self.state.lock().unwrap().approvals.remove(&id);
                    if let Some(entry)=entry {
                        self.audit(object([("label",entry.label.into()),("detail",entry.detail.into()),("decision","deny-send-error".into()),("hard",entry.hard.into())]))
                            .map_err(|_|"Telegram approval audit storage operation failed")?;
                        return Ok(false);
                    }
                }
            },
            }
        }
        let entry = self.state.lock().unwrap().approvals.remove(&id);
        if let Some(entry) = entry {
            self.audit(object([
                ("label", entry.label.into()),
                ("detail", entry.detail.into()),
                ("decision", "timeout".into()),
                ("hard", entry.hard.into()),
            ]))
            .map_err(|_| "Telegram approval audit storage operation failed")?;
        }
        Ok(false)
    }
    pub async fn ask_text(
        self: &Arc<Self>,
        id: String,
        question: String,
        record: V,
    ) -> Result<Option<String>, String> {
        if self.closing.is_cancelled() || !self.enabled() {
            return Ok(None);
        }
        let (sender, receiver) = oneshot::channel();
        let cancel = Cancel::default();
        {
            let mut state = self.state.lock().unwrap();
            if state.asks.contains_key(&id) {
                return Err("Duplicate Telegram question".into());
            }
            state.asks.insert(
                id.clone(),
                Ask {
                    sender,
                    message: V::Null,
                },
            );
        }
        let _guard = PendingGuard {
            store: Arc::downgrade(self),
            id: id.clone(),
            approval: false,
            cancel: cancel.clone(),
        };
        let body = if record["tool"].truthy() {
            format!("\n\n{}", describe_tool(&record))
        } else {
            String::new()
        };
        let text=format!("⏸ <b>결정 필요</b>  <code>{}</code>\n\n{}{body}\n\n<i>버튼 누르거나 메시지에 reply 로 자유 답변 — 여러 ask 동시면 reply 로 정확히 매칭됩니다.</i>",escape(&id),escape(&question));
        let request = object([
            (
                "chat_id",
                self.state.lock().unwrap().config["chatId"].clone(),
            ),
            ("text", text.into()),
            ("parse_mode", "HTML".into()),
            (
                "reply_markup",
                keyboard(&[
                    ("✅ 승인", format!("ask:{id}:approve")),
                    ("❌ 거부", format!("ask:{id}:deny")),
                    ("💬 더 묻기", format!("ask:{id}:more")),
                ]),
            ),
        ]);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(100);
        let send = self.request("sendMessage", request, &cancel);
        tokio::pin!(send);
        tokio::pin!(receiver);
        let mut sent = false;
        loop {
            tokio::select! { biased;
                _=self.closing.cancelled()=>return Ok(None),
                result=&mut receiver=>return Ok(result.unwrap_or(None)),
                _=tokio::time::sleep_until(deadline)=>return Ok(None),
                result=&mut send, if !sent=>{ sent=true; match result { Ok(result) if result["ok"] != V::Bool(false)=>{ if let Some(ask)=self.state.lock().unwrap().asks.get_mut(&id) { ask.message=result["result"]["message_id"].clone(); } }, _=>return Ok(None) } },
            }
        }
    }
    async fn dispatch(self: &Arc<Self>, update: V, cancel: &Cancel) -> Result<(), String> {
        let chat = self.state.lock().unwrap().config["chatId"].text();
        if update["callback_query"] != V::Null {
            let cb = &update["callback_query"];
            if !cb["message"]["chat"]["id"].truthy() || cb["message"]["chat"]["id"].text() != chat {
                return Ok(());
            }
            let data = cb["data"].text();
            let fields = data.split(':').collect::<Vec<_>>();
            let mut answer = "처리됨";
            if fields.len() == 3 && fields[0] == "apr" && matches!(fields[2], "y" | "n") {
                let entry = self.state.lock().unwrap().approvals.remove(fields[1]);
                if let Some(entry) = entry {
                    let approved = fields[2] == "y";
                    let audited = self
                        .audit(object([
                            ("label", entry.label.into()),
                            ("detail", entry.detail.into()),
                            (
                                "decision",
                                if approved {
                                    "user-approve"
                                } else {
                                    "user-deny"
                                }
                                .into(),
                            ),
                            ("hard", entry.hard.into()),
                        ]))
                        .is_ok();
                    let _ = entry.sender.send(approved && audited);
                    answer = if approved && audited {
                        "✅ 승인"
                    } else {
                        "❌ 거부"
                    };
                } else {
                    answer = "⌛ 만료되었거나 이미 처리됨";
                }
            } else if fields.len() == 3
                && fields[0] == "ask"
                && matches!(fields[2], "approve" | "deny" | "more")
            {
                if fields[2] == "more" {
                    answer = if self.state.lock().unwrap().asks.contains_key(fields[1]) {
                        "💬 자유롭게 답해주세요 (답장 또는 reply)"
                    } else {
                        "⌛ 만료되었거나 이미 처리됨"
                    };
                } else {
                    let entry = self.state.lock().unwrap().asks.remove(fields[1]);
                    if let Some(entry) = entry {
                        let approve = fields[2] == "approve";
                        let _ = entry
                            .sender
                            .send(Some(if approve { "진행해" } else { "하지 마" }.into()));
                        answer = if approve {
                            "✅ 승인 처리 중"
                        } else {
                            "❌ 거부 처리 중"
                        };
                    } else {
                        answer = "⌛ 만료되었거나 이미 처리됨";
                    }
                }
            } else if fields.first() == Some(&"dec") {
                return self.forward(update, cancel).await;
            }
            // Resolve before optional ACK: a failed ACK cannot erase a decision.
            let _ = self
                .request(
                    "answerCallbackQuery",
                    object([
                        ("callback_query_id", cb["id"].clone()),
                        ("text", answer.into()),
                    ]),
                    cancel,
                )
                .await;
            return Ok(());
        }
        let msg = &update["message"];
        if !msg["chat"]["id"].truthy() || msg["chat"]["id"].text() != chat {
            return Ok(());
        }
        let text = or(&msg["text"], "").trim();
        if !text.truthy() {
            return Ok(());
        }
        if crate::telegram_text::presence(&text.text()).is_some()
            && self.handler.lock().unwrap().is_some()
        {
            return self.forward(update, cancel).await;
        }
        if !text.text().starts_with('/') {
            let (entry, ambiguous) = {
                let mut state = self.state.lock().unwrap();
                let reply = &msg["reply_to_message"]["message_id"];
                let id = if reply.truthy() {
                    state
                        .asks
                        .iter()
                        .find(|(_, ask)| ask.message == *reply)
                        .map(|(id, _)| id.clone())
                } else if state.asks.len() == 1 {
                    state.asks.keys().next().cloned()
                } else {
                    None
                };
                let ambiguous = !state.asks.is_empty() && id.is_none();
                (
                    id.and_then(|id| state.asks.remove(&id).map(|entry| (id, entry))),
                    ambiguous,
                )
            };
            if let Some((id, entry)) = entry {
                let _ = entry.sender.send(Some(text.text()));
                let _ = self
                    .send(
                        format!("🤖 답변 받음 <code>{}</code>, LLM이 해석 중…", escape(&id)).into(),
                        object([("parseMode", "HTML".into()), ("silent", true.into())]),
                        cancel,
                    )
                    .await;
                return Ok(());
            }
            if ambiguous {
                let _ = self
                    .send(
                        "⚠️ 답변할 질문 메시지에 reply 하거나 해당 질문의 버튼을 눌러주세요."
                            .into(),
                        object([("silent", true.into())]),
                        cancel,
                    )
                    .await;
                return Ok(());
            }
        }
        self.forward(update, cancel).await
    }
    async fn forward(&self, update: V, cancel: &Cancel) -> Result<(), String> {
        let handler = self.handler.lock().unwrap().clone();
        if let Some(handler) = handler {
            let (configuration, generation) = {
                let state = self.state.lock().unwrap();
                (state.config_cancel.clone(), state.generation)
            };
            let mut guard = StartupGuard {
                cancel: cancel.child(),
                armed: true,
            };
            let context = UpdateContext {
                cancel: guard.cancel.clone(),
                generation,
            };
            tokio::select! { biased;
                _=guard.cancel.cancelled()=>Ok(()),
                _=configuration.cancelled()=>Ok(()),
                _=self.closing.cancelled()=>Ok(()),
                result=handler(update, context)=>{ guard.armed=false; result },
            }
        } else {
            Ok(())
        }
    }
    pub fn autopilot_channel(self: &Arc<Self>) -> crate::autopilot::AskHuman {
        let store = self.clone();
        Arc::new(move |prompt, context| {
            let store = store.clone();
            Box::pin(async move {
                let category = context["category"].text();
                store
                    .request_approval(
                        format!("오토파일럿: {category}"),
                        prompt,
                        matches!(category.as_str(), "production" | "destructive"),
                    )
                    .await
            })
        })
    }
    pub fn supervisor_channel(self: &Arc<Self>) -> Arc<dyn HumanChannel> {
        Arc::new(Channel(self.clone()))
    }
    pub async fn handle(self: &Arc<Self>, method: &Method, path: &str, input: &V) -> Response {
        let result = match (method.as_str(), path) {
            ("GET", "/api/telegram/status") => Ok(object([
                ("configured", self.enabled().into()),
                ("polling", self.is_polling().into()),
                ("config", self.config()),
            ])),
            ("POST", "/api/telegram/config") => {
                if !input["token"].truthy() || !input["chatId"].truthy() {
                    return crate::error(400, "token and chatId required");
                }
                if !input["token"].is_string() {
                    return crate::error(400, "token must be a string");
                }
                self.save_config(object([
                    ("token", input["token"].clone()),
                    ("chatId", input["chatId"].text().into()),
                    ("enabled", (input["enabled"] != V::Bool(false)).into()),
                ]))
                .await
                .map(|_| object([("ok", true.into()), ("configured", self.enabled().into())]))
            }
            ("POST", "/api/telegram/start") => {
                let ok = self.start_polling().await;
                Ok(object([
                    ("ok", ok.into()),
                    ("polling", self.is_polling().into()),
                ]))
            }
            ("POST", "/api/telegram/stop") => {
                self.stop_polling().await;
                Ok(object([
                    ("ok", true.into()),
                    ("polling", self.is_polling().into()),
                ]))
            }
            ("POST", "/api/telegram/test") => self
                .send_message(
                    or(&input["text"], "🤖 Cockpit 테스트 메시지"),
                    object([("silent", true.into())]),
                )
                .await
                .map(|value| object([("ok", value["ok"].truthy().into()), ("result", value)])),
            _ => return crate::error(404, "Not found"),
        };
        match result {
            Ok(value) => Json(value.raw()).into_response(),
            Err(error) => crate::error(500, &error),
        }
    }
}
struct Channel(Arc<Store>);
impl HumanChannel for Channel {
    fn ask_text(&self, id: String, message: String, record: V) -> ChannelFuture<Option<String>> {
        let store = self.0.clone();
        Box::pin(async move { store.ask_text(id, message, record).await })
    }
    fn send_message(&self, text: String, options: V) -> ChannelFuture<()> {
        let store = self.0.clone();
        Box::pin(async move { store.send_message(text.into(), options).await.map(|_| ()) })
    }
    fn notify_decision(&self, record: V) -> ChannelFuture<()> {
        let store = self.0.clone();
        Box::pin(async move {
            if !store.enabled() {
                return Ok(());
            }
            let body = object([
                (
                    "chat_id",
                    store.state.lock().unwrap().config["chatId"].clone(),
                ),
                ("text", format_decision(&record).into()),
                ("parse_mode", "HTML".into()),
                (
                    "disable_notification",
                    (record["decision"] != V::from("ask")).into(),
                ),
            ]);
            store
                .request("sendMessage", body, &Cancel::default())
                .await
                .map(|_| ())
        })
    }
}
fn keyboard(buttons: &[(&str, String)]) -> V {
    object([(
        "inline_keyboard",
        V::Array(vec![V::Array(
            buttons
                .iter()
                .map(|(text, data)| {
                    object([
                        ("text", (*text).into()),
                        ("callback_data", data.clone().into()),
                    ])
                })
                .collect(),
        )]),
    )])
}
fn split_text(text: &V) -> Vec<V> {
    let mut remaining = if text.truthy() {
        if text.is_string() {
            text.clone()
        } else {
            text.text().into()
        }
    } else {
        "".into()
    };
    let mut result = vec![];
    while remaining.units().len() > 3800 {
        let cut = remaining.units()[..=3800]
            .iter()
            .rposition(|unit| *unit == 10)
            .filter(|n| *n >= 1900)
            .unwrap_or(3800);
        result.push(V::String(remaining.units()[..cut].to_vec()));
        let tail = &remaining.units()[cut..];
        let first = tail
            .iter()
            .position(|u| !V::String(vec![*u]).trim().units().is_empty())
            .unwrap_or(tail.len());
        remaining = V::String(tail[first..].to_vec());
    }
    if remaining.truthy() {
        result.push(remaining);
    }
    result
}
fn describe_tool(record: &V) -> String {
    let tool = or(&record["tool"], "?").text();
    let input = &record["input"];
    let string = |key: &str| or(&input[key], "").text();
    let path = |file: &str| {
        let parts = file.split('/').collect::<Vec<_>>();
        (
            if parts.len() > 1 {
                let dir = parts[..parts.len() - 1].join("/");
                if dir.is_empty() {
                    "/".into()
                } else {
                    dir
                }
            } else {
                "/".into()
            },
            parts
                .last()
                .filter(|s| !s.is_empty())
                .copied()
                .unwrap_or(file)
                .to_string(),
        )
    };
    match tool.as_str() {
        "Bash" => {
            let cmd = string("command");
            let desc = string("description");
            let len = cmd.encode_utf16().count();
            format!(
                "⚙️ <b>Bash 명령</b>{}\n<pre>{}{}</pre>",
                if desc.is_empty() {
                    String::new()
                } else {
                    format!("\n<i>의도</i> · {}", escape(&desc))
                },
                escape(&cut(&cmd, 800)),
                if len > 800 {
                    format!("\n… (총 {len}자)")
                } else {
                    String::new()
                }
            )
        }
        "Write" => {
            let file = string("file_path");
            let content = string("content");
            let lines = content.split('\n').collect::<Vec<_>>();
            let preview = cut(
                &lines
                    .iter()
                    .take(10)
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n"),
                600,
            );
            let truncated =
                content.encode_utf16().count() > preview.encode_utf16().count() || lines.len() > 10;
            let (dir, name) = path(&file);
            format!("📝 <b>새 파일 생성</b>\n<i>경로</i> · <code>{}/</code><b>{}</b>\n<i>크기</i> · {}자 / {}줄\n\n<i>미리보기</i>\n<pre>{}{}</pre>",escape(&dir),escape(&name),content.encode_utf16().count(),lines.len(),escape(&preview),if truncated{"\n…"}else{""})
        }
        "Edit" => {
            let file = string("file_path");
            let (dir, name) = path(&file);
            format!("✏️ <b>파일 수정</b>\n<i>경로</i> · <code>{}/</code><b>{}</b>\n\n<i>이전</i>\n<pre>{}</pre>\n<i>이후</i>\n<pre>{}</pre>",escape(&dir),escape(&name),escape(&cut(&string("old_string"),280)),escape(&cut(&string("new_string"),280)))
        }
        "MultiEdit" => {
            let file = string("file_path");
            let (dir, name) = path(&file);
            let edits = input["edits"].array();
            let mut lines = vec![
                "✏️✏️ <b>여러 수정</b>".to_string(),
                format!(
                    "<i>경로</i> · <code>{}/</code><b>{}</b>",
                    escape(&dir),
                    escape(&name)
                ),
                format!("<i>변경 수</i> · <b>{}건</b>", edits.len()),
            ];
            if let Some(edit) = edits.first() {
                lines.push(format!(
                    "\n<i>첫 변경</i>\n<pre>{}</pre>\n↓\n<pre>{}</pre>",
                    escape(&cut(&or(&edit["old_string"], "").text(), 180)),
                    escape(&cut(&or(&edit["new_string"], "").text(), 180))
                ));
            }
            if edits.len() > 1 {
                lines.push(format!("<i>+ {}건 더</i>", edits.len() - 1));
            }
            lines.join("\n")
        }
        "AskUserQuestion" => format!(
            "❓ <b>Claude가 사용자에게 질문 요청</b>\n{}",
            escape(&cut(&or(&input["question"], &string("prompt")).text(), 400))
        ),
        "WebSearch" | "WebFetch" => format!(
            "🔧 <b>{tool}</b>\n{}",
            escape(&cut(&or(&input["url"], &string("query")).text(), 300))
        ),
        "Task" | "Agent" => format!(
            "🔧 <b>서브에이전트 실행</b>\n{}",
            escape(&cut(
                &or(&input["description"], &string("prompt")).text(),
                400
            ))
        ),
        _ => {
            let value = if input.truthy() {
                input.clone()
            } else {
                V::object()
            };
            let parsed: serde_json::Value =
                serde_json::from_str(value.raw().get()).unwrap_or(serde_json::Value::Null);
            format!(
                "🔧 <b>{}</b>\n<pre>{}</pre>",
                escape(&tool),
                escape(&cut(
                    &serde_json::to_string_pretty(&parsed).unwrap_or_default(),
                    600
                ))
            )
        }
    }
}
fn format_decision(record: &V) -> String {
    let dec = or(&record["decision"], "unknown").text();
    let (emoji, label, tone) = match dec.as_str() {
        "approve" => ("✅", "APPROVED".into(), "진행"),
        "block" => ("🚫", "BLOCKED".into(), "차단"),
        "deny" => ("🚫", "DENIED".into(), "거부"),
        "ask" => ("❓", "ASKING".into(), "확인 필요"),
        _ => ("⚪", dec.to_uppercase(), ""),
    };
    let policy = or(&record["policy"], "?").text();
    let policy_label = match policy.as_str() {
        "safelist" => "안전 룰",
        "blacklist" => "위험 패턴",
        "danger-path" => "위험 경로",
        "llm" => "AI 판단",
        "llm-resolved" => "AI + 너 답변",
        "llm-fail-deny" => "AI 실패 → 보수적 거부",
        "no-llm" => "AI 미연결",
        "no-channel" => "채널 없음",
        "timeout-deny" => "응답 없음 → 거부",
        "keyword-fallback" => "키워드 매칭",
        "human-button" => "버튼 응답",
        "rule-fallthrough" => "룰 없음",
        _ => &policy,
    };
    let mut ctx = vec![];
    let cwd = record["cwd"].text();
    if record["cwd"].truthy() {
        if let Some(project) = cwd.split('/').filter(|p| !p.is_empty()).next_back() {
            ctx.push(format!("📂 {}", escape(project)));
        }
    }
    if record["sessionId"].truthy() {
        ctx.push(format!(
            "<code>{}</code>",
            escape(&record["sessionId"].cut(8).text())
        ));
    }
    #[cfg(unix)]
    {
        let seconds = (now() / 1000) as libc::time_t;
        let mut tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&seconds, &mut tm) };
        ctx.push(format!(
            "🕐 {:02}:{:02}:{:02}",
            tm.tm_hour, tm.tm_min, tm.tm_sec
        ));
    }
    #[cfg(not(unix))]
    {
        ctx.push("🕐 --:--:--".into());
    }
    let conf = if let V::Number(n) = record["confidence"] {
        format!("{}%", (n * 100.0 + 0.5).floor())
    } else {
        "–".into()
    };
    let reason = if record["reasoning"].truthy() {
        format!(
            "\n<b>💭 사유</b>\n<blockquote>{}</blockquote>",
            escape(&record["reasoning"].text())
        )
    } else {
        String::new()
    };
    let hint=match dec.as_str(){"block"|"deny"=>"\n<i>⛔ 이 도구 호출은 이미 차단됐어요. 답장으로는 되돌릴 수 없고, 다시 하려면 해당 세션(터미널)에서 재시도하세요. · \"왜 막혔어?\" 는 물어보셔도 됩니다.</i>","ask"=>"\n<i>💬 버튼을 누르거나 자유롭게 답해주세요 (100초 내)</i>",_=>""};
    format!("{emoji} <b>{label}</b> · {}\n{}\n━━━━━━━━━━━━━━━━━━━\n{}\n━━━━━━━━━━━━━━━━━━━\n📋 {} · 신뢰도 <b>{conf}</b>{reason}{hint}",escape(tone),ctx.join(" · "),describe_tool(record),escape(policy_label))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn local() -> (tempfile::TempDir, Arc<Store>) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        store.state.lock().unwrap().config = object([("chatId", "authorized".into())]);
        (directory, store)
    }
    fn callback(chat: &str, data: &str) -> V {
        object([(
            "callback_query",
            object([
                ("id", "fixture-callback".into()),
                ("data", data.into()),
                (
                    "message",
                    object([
                        ("chat", object([("id", chat.into())])),
                        ("message_id", 42.0.into()),
                    ]),
                ),
            ]),
        )])
    }
    fn message(chat: &str, text: &str, reply: V) -> V {
        object([(
            "message",
            object([
                ("chat", object([("id", chat.into())])),
                ("text", text.into()),
                ("reply_to_message", object([("message_id", reply)])),
            ]),
        )])
    }
    #[tokio::test]
    async fn approval_chat_validation_duplicate_delivery_and_audit_fail_closed() {
        let (directory, store) = local();
        let (tx, mut rx) = oneshot::channel();
        store.state.lock().unwrap().approvals.insert(
            "id".into(),
            Approval {
                sender: tx,
                label: "fixture".into(),
                detail: "private synthetic detail".into(),
                hard: true,
            },
        );
        store
            .dispatch(callback("foreign", "apr:id:y"), &Cancel::default())
            .await
            .unwrap();
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(!directory.path().join("logs/approvals.jsonl").exists());
        store
            .dispatch(callback("authorized", "apr:id:unknown"), &Cancel::default())
            .await
            .unwrap();
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        store
            .dispatch(callback("authorized", "apr:id:y"), &Cancel::default())
            .await
            .unwrap();
        assert!(rx.await.unwrap());
        store
            .dispatch(callback("authorized", "apr:id:n"), &Cancel::default())
            .await
            .unwrap();
        let log = fs::read_to_string(directory.path().join("logs/approvals.jsonl")).unwrap();
        assert_eq!(log.lines().count(), 1);
        assert!(log.contains("user-approve"));
        #[cfg(unix)]
        {
            let path = directory.path().join("logs/approvals.jsonl");
            let outside = directory.path().join("outside");
            fs::write(&outside, "untouched").unwrap();
            fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&outside, &path).unwrap();
            let (tx, rx) = oneshot::channel();
            store.state.lock().unwrap().approvals.insert(
                "fail".into(),
                Approval {
                    sender: tx,
                    label: "fixture".into(),
                    detail: "audit failure".into(),
                    hard: false,
                },
            );
            store
                .dispatch(callback("authorized", "apr:fail:y"), &Cancel::default())
                .await
                .unwrap();
            assert!(!rx.await.unwrap());
            assert_eq!(fs::read_to_string(outside).unwrap(), "untouched");
        }
    }
    #[tokio::test]
    async fn questions_require_exact_reply_when_multiple_and_never_accept_foreign_messages() {
        let (_directory, store) = local();
        let (tx1, mut rx1) = oneshot::channel();
        let (tx2, mut rx2) = oneshot::channel();
        store.state.lock().unwrap().asks.insert(
            "one".into(),
            Ask {
                sender: tx1,
                message: 41.0.into(),
            },
        );
        store.state.lock().unwrap().asks.insert(
            "two".into(),
            Ask {
                sender: tx2,
                message: 42.0.into(),
            },
        );
        for event in [
            message("foreign", "yes", 42.0.into()),
            message("authorized", "yes", V::Null),
            message("authorized", "yes", 99.0.into()),
        ] {
            store.dispatch(event, &Cancel::default()).await.unwrap();
        }
        assert!(matches!(
            rx1.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            rx2.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        store
            .dispatch(callback("authorized", "ask:two:more"), &Cancel::default())
            .await
            .unwrap();
        assert_eq!(store.state.lock().unwrap().asks.len(), 2);
        store
            .dispatch(
                message("authorized", "second answer", 42.0.into()),
                &Cancel::default(),
            )
            .await
            .unwrap();
        assert_eq!(rx2.await.unwrap(), Some("second answer".into()));
        assert_eq!(store.state.lock().unwrap().asks.len(), 1);
        store
            .dispatch(
                message("authorized", "single answer", V::Null),
                &Cancel::default(),
            )
            .await
            .unwrap();
        assert_eq!(rx1.await.unwrap(), Some("single answer".into()));
        assert!(store.state.lock().unwrap().asks.is_empty());
    }
    #[tokio::test]
    async fn dropped_question_cleans_mapping_and_callback_more_never_approves() {
        let (_directory, store) = local();
        let (tx, mut rx) = oneshot::channel();
        let cancel = Cancel::default();
        store.state.lock().unwrap().asks.insert(
            "question".into(),
            Ask {
                sender: tx,
                message: 42.0.into(),
            },
        );
        let guard = PendingGuard {
            store: Arc::downgrade(&store),
            id: "question".into(),
            approval: false,
            cancel: cancel.clone(),
        };
        store
            .dispatch(
                callback("authorized", "ask:question:more"),
                &Cancel::default(),
            )
            .await
            .unwrap();
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        drop(guard);
        assert!(cancel.is_cancelled());
        assert!(rx.await.is_err());
        assert!(store.state.lock().unwrap().asks.is_empty());
    }
    #[tokio::test]
    async fn trust_never_skips_hard_requests_and_shutdown_never_approves() {
        let (_directory, store) = local();
        assert!(!store
            .request_approval("fixture".into(), "disabled".into(), false)
            .await
            .unwrap());
        assert_eq!(store.set_trust_window(30_000)["active"], V::Bool(true));
        assert!(store
            .request_approval("fixture".into(), "trusted".into(), false)
            .await
            .unwrap());
        assert!(!store
            .request_approval("fixture".into(), "hard disabled".into(), true)
            .await
            .unwrap());
        store.shutdown().await;
        assert!(!store
            .request_approval("fixture".into(), "shutdown".into(), false)
            .await
            .unwrap());
    }
    #[tokio::test]
    async fn unhandled_updates_forward_only_after_chat_validation() {
        let (_directory, store) = local();
        let received = Arc::new(Mutex::new(vec![]));
        let target = received.clone();
        store.set_update_handler(Some(Arc::new(move |update, _context| {
            target.lock().unwrap().push(update);
            Box::pin(async { Ok(()) })
        })));
        store
            .dispatch(message("foreign", "/command", V::Null), &Cancel::default())
            .await
            .unwrap();
        store
            .dispatch(callback("foreign", "dec:id:approve"), &Cancel::default())
            .await
            .unwrap();
        assert!(received.lock().unwrap().is_empty());
        store
            .dispatch(
                message("authorized", "/command", V::Null),
                &Cancel::default(),
            )
            .await
            .unwrap();
        assert_eq!(received.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn forwarded_work_is_cancelled_on_stop_config_change_and_future_drop() {
        for cause in ["stop", "configuration", "drop"] {
            let (_directory, store) = local();
            let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
            store.set_update_handler(Some(Arc::new(move |_, context| {
                sent.send(context).unwrap();
                Box::pin(std::future::pending())
            })));
            let owner = Cancel::default();
            let worker_owner = owner.clone();
            let target = store.clone();
            let task = tokio::spawn(async move {
                target
                    .dispatch(message("authorized", "/command", V::Null), &worker_owner)
                    .await
            });
            let context = received.recv().await.unwrap();
            assert!(store.command_current(&context));
            match cause {
                "stop" => owner.cancel(),
                "configuration" => store
                    .save_config(object([("chatId", "replacement".into())]))
                    .await
                    .unwrap(),
                _ => task.abort(),
            }
            let result = tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .unwrap();
            if cause == "drop" {
                assert!(result.unwrap_err().is_cancelled());
            } else {
                result.unwrap().unwrap();
            }
            assert!(context.cancel.is_cancelled());
            assert!(!store.command_current(&context));
        }
    }
    #[tokio::test]
    async fn completed_handler_keeps_its_run_scope_until_the_polling_owner_stops() {
        let (_directory, store) = local();
        let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
        store.set_update_handler(Some(Arc::new(move |_, context| {
            sent.send(context).unwrap();
            Box::pin(async { Ok(()) })
        })));
        let owner = Cancel::default();
        store
            .dispatch(message("authorized", "/command", V::Null), &owner)
            .await
            .unwrap();
        let context = received.recv().await.unwrap();
        assert!(store.command_current(&context));
        owner.cancel();
        assert!(context.cancel.is_cancelled());
        assert!(!store.command_current(&context));
    }
    #[test]
    fn split_preserves_utf16_boundaries_newline_and_trailing_spaces() {
        let mut text = vec![b'a' as u16; 3799];
        text.extend([0xd83d, 0xde00, 0xd800]);
        let result = split_text(&V::String(text));
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].units().last(), Some(&0xd83d));
        assert_eq!(result[1].units(), &[0xde00, 0xd800]);
        let text = format!("{}\n  {}  ", "a".repeat(2500), "b".repeat(2500));
        assert_eq!(
            split_text(&text.into()),
            vec![
                "a".repeat(2500).into(),
                format!("{}  ", "b".repeat(2500)).into()
            ]
        );
        assert!(split_text(&V::Array(vec![])).is_empty());
    }
}
