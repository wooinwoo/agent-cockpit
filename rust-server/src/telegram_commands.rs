//! Telegram commands use the same application services as HTTP and automation.
use crate::{
    ai_transport::Cancel,
    board_value::{object, V},
    telegram::UpdateContext,
    telegram_text as text, App,
};
use axum::http::Method;
use std::{
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{sync::Mutex as AsyncMutex, task::JoinHandle};

struct State {
    generation: u64,
    conversation: Option<String>,
    reply_cancel: Cancel,
    focus: V,
}
pub struct Store {
    state: AsyncMutex<State>,
    todos: crate::telegram_todos::Store,
    trust_timer: Mutex<Option<JoinHandle<()>>>,
    jobs: Mutex<Vec<JoinHandle<()>>>,
    started: Instant,
}
struct Admission {
    cancel: Cancel,
    armed: bool,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if self.armed {
            self.cancel.cancel();
        }
    }
}
fn now() -> i64 {
    crate::account_usage::now()
}
fn escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn masked(value: &V) -> String {
    text::mask(value).text()
}
fn enriched(prefix: V, question: V) -> V {
    let question = crate::agent_runtime::concat(&["[사용자 질문]\n".into(), question]).cut(5000);
    let room = 5000usize.saturating_sub(question.units().len());
    if room < 2 || !prefix.truthy() {
        return question;
    }
    crate::agent_runtime::concat(&[prefix.cut(room - 2), "\n\n".into(), question])
}
fn convert(value: &impl serde::Serialize) -> Result<V, String> {
    V::parse(&serde_json::value::to_raw_value(value).map_err(|_| "Invalid application data")?)
        .map_err(|_| "Invalid application data".into())
}
fn count(arg: &str, default: usize, maximum: usize) -> usize {
    let prefix: String = arg
        .trim()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    prefix
        .parse::<usize>()
        .ok()
        .filter(|n| *n > 0)
        .unwrap_or(default)
        .min(maximum)
}
fn escaped_units(value: &V) -> V {
    let mut units = Vec::new();
    for unit in value.units() {
        match *unit {
            38 => units.extend("&amp;".encode_utf16()),
            60 => units.extend("&lt;".encode_utf16()),
            62 => units.extend("&gt;".encode_utf16()),
            unit => units.push(unit),
        }
    }
    V::String(units)
}
fn diagnostic_log(content: &str) -> (usize, String, V) {
    static GEMINI: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = GEMINI.get_or_init(|| regex::Regex::new(r"Gemini response in (\d+)ms").unwrap());
    // split rather than lines preserves the source's trailing empty log line.
    let mut lines = content.rsplit('\n').take(500).collect::<Vec<_>>();
    lines.reverse();
    let errors = lines.iter().filter(|line| line.contains("[ERROR]")).count();
    let times = lines.iter().filter_map(|line| {
        pattern.captures(line)?[1]
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
    });
    let (total, count) = times.fold((0.0, 0usize), |(total, count), value| {
        (total + value as f64, count + 1)
    });
    let average = if count == 0 {
        "?".into()
    } else {
        format!("{:.0}", (total / count as f64).round())
    };
    let mut recent = lines
        .iter()
        .rev()
        .filter(|line| line.contains("ETIMEDOUT") || line.contains("ECONNRESET"))
        .take(3)
        .collect::<Vec<_>>();
    recent.reverse();
    let mut network = Vec::new();
    for line in recent {
        if !network.is_empty() {
            network.push("\n".into());
        }
        // Mask before truncation so a secret crossing the boundary cannot leak.
        network.push(escaped_units(&text::mask(&V::from(*line)).cut(80)));
    }
    (errors, average, crate::agent_runtime::concat(&network))
}
fn diagnostic_rss() -> Option<u64> {
    let mut bytes = Vec::new();
    std::fs::File::open("/proc/self/status")
        .ok()?
        .take(65_537)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 65_536 {
        return None;
    }
    let content = std::str::from_utf8(&bytes).ok()?;
    let mut value = content
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))?
        .split_whitespace();
    let kibibytes = value.next()?.parse::<u64>().ok()?;
    (value.next()? == "kB").then(|| kibibytes.saturating_add(512) / 1024)
}
impl Store {
    pub fn new(directory: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            todos: crate::telegram_todos::Store::new(directory),
            state: AsyncMutex::new(State {
                generation: 0,
                conversation: None,
                reply_cancel: Cancel::default(),
                focus: V::Null,
            }),
            trust_timer: Mutex::new(None),
            jobs: Mutex::new(vec![]),
            started: Instant::now(),
        })
    }
    pub fn bind(app: &Arc<App>) {
        let weak = Arc::downgrade(app);
        app.telegram
            .set_update_handler(Some(Arc::new(move |update, context| {
                let weak = weak.clone();
                Box::pin(async move {
                    let Some(app) = weak.upgrade() else {
                        return Ok(());
                    };
                    app.telegram_commands
                        .clone()
                        .handle(app, update, context)
                        .await
                })
            })));
    }
    pub async fn shutdown(&self) {
        let timer = self.trust_timer.lock().unwrap().take();
        let jobs = std::mem::take(&mut *self.jobs.lock().unwrap());
        for job in timer.into_iter().chain(jobs) {
            job.abort();
            let _ = job.await;
        }
    }
    async fn reply(
        &self,
        app: &App,
        context: &UpdateContext,
        message: impl Into<V>,
        html: bool,
    ) -> Result<(), String> {
        if !app.telegram.command_current(context) {
            return Err("Telegram command cancelled".into());
        }
        let mut options = object([("silent", true.into())]);
        if html {
            options["parseMode"] = "HTML".into();
        }
        self.deliver(app, context, message.into(), options).await
    }
    async fn deliver(
        &self,
        app: &App,
        context: &UpdateContext,
        message: V,
        options: V,
    ) -> Result<(), String> {
        if !app.telegram.command_current(context) {
            return Err("Telegram command cancelled".into());
        }
        let result = app
            .telegram
            .send_cancellable(message, options, &context.cancel)
            .await?;
        if result["ok"] == V::Bool(false) {
            return Err("Telegram delivery failed".into());
        }
        Ok(())
    }
    async fn reset_generation(&self, context: &UpdateContext) {
        let mut state = self.state.lock().await;
        if state.generation != context.generation {
            state.generation = context.generation;
            state.conversation = None;
            state.reply_cancel.cancel();
            state.reply_cancel = Cancel::default();
            state.focus = V::Null;
            if let Some(timer) = self.trust_timer.lock().unwrap().take() {
                timer.abort();
            }
        }
    }
    async fn snapshot(&self, app: &App) -> Result<V, String> {
        let focus = self.state.lock().await.focus.clone();
        let mut projects = convert(
            &app.projects
                .list()
                .map_err(|_| "Project storage unavailable")?,
        )?;
        for project in projects.array_mut() {
            project["session"] = app.project_polling.cached(&project["id"].text(), "session");
            project["git"] = app.project_polling.cached(&project["id"].text(), "git");
        }
        Ok(object([
            ("focus", focus),
            ("todos", self.todos.list(false)?),
            ("projects", projects),
            ("mode", app.supervisor.mode().into()),
            (
                "decisions",
                app.supervisor
                    .recent(100)
                    .map_err(|_| "Supervisor storage unavailable")?,
            ),
            ("pending", 0.0.into()),
            ("terminals", convert(&app.terminals.active())?),
        ]))
    }
    async fn create(app: Arc<App>, cancel: &Cancel) -> Result<String, String> {
        let token = cancel.clone();
        let response = tokio::task::spawn_blocking(move || app.agent.create_background(&token))
            .await
            .map_err(|_| "Conversation creation failed")?;
        let value = crate::agent_app::response(response).await?;
        if !value["id"].truthy() {
            return Err("Conversation creation failed".into());
        }
        Ok(value["id"].text())
    }
    async fn chat(
        &self,
        app: Arc<App>,
        context: &UpdateContext,
        question: V,
        todo: Option<V>,
    ) -> Result<(), String> {
        if app
            .ai_config
            .key()
            .map_err(|_| "AI configuration unavailable")?
            .is_none()
        {
            return Err("Gemini API key not configured".into());
        }
        let mut admission = Admission {
            cancel: context.cancel.child(),
            armed: true,
        };
        let mut state = self.state.lock().await;
        if !app.telegram.command_current(context) {
            return Err("Telegram command cancelled".into());
        }
        let id = match state.conversation.clone() {
            Some(id) => id,
            None => {
                let id = Self::create(app.clone(), &admission.cancel).await?;
                state.conversation = Some(id.clone());
                id
            }
        };
        let reply_cancel = state.reply_cancel.clone();
        drop(state);
        let snapshot = self.snapshot(&app).await?;
        let prefix = text::context(&snapshot, now());
        let mut parts = vec![];
        if prefix.truthy() {
            parts.extend([prefix, "\n\n".into()]);
        }
        // A declined tool call cannot be retroactively executed by replying here.
        if let Some(denied) = snapshot["decisions"].array().iter().rev().find(|d| {
            matches!(d["decision"].text().as_str(), "block" | "deny")
                && crate::autonomy_schedule::date(&d["ts"])
                    .ok()
                    .flatten()
                    .is_some_and(|stamp| now() - stamp < 300_000)
        }) {
            let detail = ["command", "file_path", "path"]
                .iter()
                .map(|key| &denied["input"][key])
                .find(|v| v.truthy())
                .unwrap_or(&denied["tool"]);
            parts.push(format!("[방금 거부된 작업 — 참고]\n도구: {}\n내용: {}\n이 호출은 이미 차단되었습니다. 이 대화의 답변으로 재실행했다고 주장하지 말고 해당 세션에서 다시 실행하도록 안내하세요.\n\n",masked(&denied["tool"]),masked(detail)).into());
        }
        let input = object([
            ("convId", id.clone().into()),
            (
                "message",
                enriched(crate::agent_runtime::concat(&parts), question),
            ),
        ]);
        let target = app.clone();
        let owner = admission.cancel.clone();
        let response = tokio::task::spawn_blocking(move || {
            target
                .agent_runtime
                .start_owned_reply(target.clone(), &input, owner)
        })
        .await
        .map_err(|_| "Agent start failed")??;
        admission.armed = false;
        if let Some(todo) = todo {
            self.reply(
                &app,
                context,
                format!(
                    "▶️ #{} 처리 시작: {}",
                    todo["id"].text(),
                    escaped(&masked(&todo["text"]))
                ),
                true,
            )
            .await?;
        }
        let _ = app.telegram.typing(context).await;
        // Each request owns its result even if another turn starts immediately.
        // Resetting the conversation also cancels an in-flight split delivery.
        let delivery = async {
            let answer = match tokio::time::timeout(Duration::from_secs(60), response).await {
                Ok(result) => result.map_err(|_| "Agent response unavailable")??,
                Err(_) => "⌛ Agent 응답 60초 초과. 백그라운드에서 진행 중일 수 있어요.".into(),
            };
            let answer = if answer.truthy() {
                answer
            } else {
                "(빈 응답)".into()
            };
            self.deliver(&app, context, answer, V::Null).await
        };
        tokio::select! { biased;
            _ = context.cancel.cancelled() => Ok(()),
            _ = reply_cancel.cancelled() => Ok(()),
            result = delivery => result,
        }
    }
    pub async fn handle(
        self: Arc<Self>,
        app: Arc<App>,
        update: V,
        context: UpdateContext,
    ) -> Result<(), String> {
        if !app.telegram.command_current(&context) {
            return Ok(());
        }
        self.reset_generation(&context).await;
        let result = self.dispatch(app.clone(), &update, &context).await;
        if let Err(error) = result {
            if app.telegram.command_current(&context) {
                self.reply(
                    &app,
                    &context,
                    format!("❌ 명령 실행 실패: {}", masked(&error.into())),
                    false,
                )
                .await?;
            }
        }
        Ok(())
    }
    async fn dispatch(
        self: &Arc<Self>,
        app: Arc<App>,
        update: &V,
        context: &UpdateContext,
    ) -> Result<(), String> {
        if update["callback_query"] != V::Null {
            return app
                .telegram
                .expired_callback(&update["callback_query"]["id"], context)
                .await;
        }
        let message = update["message"]["text"].trim();
        let value = message.text();
        let command = value.split_whitespace().next().unwrap_or("");
        let arg = value.strip_prefix(command).unwrap_or("").trim();
        let reply = match command {
            "/help" | "/start" => (text::help(), true),
            "/here" | "/away" => {
                let away =
                    app.supervisor
                        .set_mode(if command == "/away" { "away" } else { "here" })
                        == "away";
                (
                    if away {
                        "🚶 AWAY 모드로 전환됨\n모호한 결정은 너한테 물어봐."
                    } else {
                        "🏠 HERE 모드로 전환됨\n알림 최소화. 위험한 거만 알림."
                    }
                    .into(),
                    false,
                )
            }
            "/clear" => {
                let mut state = self.state.lock().await;
                state.conversation = None;
                state.reply_cancel.cancel();
                state.reply_cancel = Cancel::default();
                (
                    "🧹 현재 대화 컨텍스트 초기화됨. 새 대화 시작.".into(),
                    false,
                )
            }
            "/new" => {
                let mut guard = Admission {
                    cancel: context.cancel.child(),
                    armed: true,
                };
                let mut state = self.state.lock().await;
                let id = Self::create(app.clone(), &guard.cancel).await?;
                state.conversation = Some(id.clone());
                state.reply_cancel.cancel();
                state.reply_cancel = Cancel::default();
                guard.armed = false;
                (format!("🔄 새 대화 시작: {id}"), false)
            }
            "/focus" => {
                let mut state = self.state.lock().await;
                if arg.is_empty() {
                    (
                        if state.focus.truthy() {
                            format!(
                                "🎯 현재 focus: <b>{}</b>\n해제: /unfocus",
                                escaped(&masked(&state.focus))
                            )
                        } else {
                            "focus 설정 안 됨.\n사용법: <code>/focus tire-auction</code>".into()
                        },
                        true,
                    )
                } else {
                    state.focus = arg.into();
                    let safe = escaped(&masked(&state.focus));
                    (format!("🎯 focus 설정: <b>{safe}</b>\n이후 \"그거\", \"그 프로젝트\" 는 {safe} 로 해석.\n해제: /unfocus"),true)
                }
            }
            "/unfocus" => {
                let mut state = self.state.lock().await;
                let previous = std::mem::replace(&mut state.focus, V::Null);
                (
                    if previous.truthy() {
                        format!("🎯 focus 해제됨 (이전: {})", escaped(&masked(&previous)))
                    } else {
                        "focus 설정 안 돼있었음.".into()
                    },
                    true,
                )
            }
            "/status" => {
                let state = self.state.lock().await;
                let trust = app.telegram.trust_state();
                let todos = self.todos.list(false)?.array().len();
                (format!("📊 Cockpit 상태\n모드: {}\n신뢰: {}\nFocus: {}\nTodo: {}\n사람 결정 대기: 0건\n대화 id: {}",
                    if app.supervisor.mode()=="away"{"🚶 AWAY (적극 ask)"}else{"🏠 HERE (알림 최소)"},
                    if trust["active"].truthy(){format!("🟢 ON · 남음 {}",text::remaining(trust["remainingMs"].number()))}else{"🔴 OFF (위험 도구 확인)".into()},
                    if state.focus.truthy(){format!("🎯 {}",masked(&state.focus))}else{"없음".into()},
                    if todos>0{format!("📋 {todos}건")}else{"비어있음".into()},state.conversation.as_deref().unwrap_or("없음")),false)
            }
            "/trust" | "/untrust" => {
                let duration = if command == "/untrust" {
                    0.0
                } else {
                    text::duration(arg)
                };
                if command == "/trust"
                    && (!duration.is_finite() || duration <= 0.0 || duration > i64::MAX as f64)
                {
                    ("사용법: <code>/trust 30m</code> 또는 <code>/trust 1h30m</code>\n중단: <code>/untrust</code>\nhard-risk (rm -rf, force push, publish) 는 trust 중에도 항상 확인합니다.".into(),true)
                } else {
                    let trust = app.telegram.set_trust_window(duration as i64);
                    if let Some(timer) = self.trust_timer.lock().unwrap().take() {
                        timer.abort();
                    }
                    if duration > 300_000.0 {
                        let app = app.clone();
                        let context = context.clone();
                        let store = Arc::downgrade(self);
                        let timer = tokio::spawn(async move {
                            tokio::select! {biased;_=context.cancel.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis((duration-300_000.0) as u64))=>{}}
                            let trust = app.telegram.trust_state();
                            if trust["active"].truthy()
                                && trust["remainingMs"].number() <= 360_000.0
                            {
                                if let Some(store) = store.upgrade() {
                                    let _=store.reply(&app,&context,"⏰ 신뢰 모드 만료 5분 전입니다.\n연장: <code>/trust 30m</code>  ·  종료: <code>/untrust</code>",true).await;
                                }
                            }
                        });
                        *self.trust_timer.lock().unwrap() = Some(timer);
                    }
                    if duration > 0.0 {
                        (format!("🟢 신뢰 모드 {} 동안 활성.\nhard-risk 외 자동 승인 + audit 로그.\n중단: <code>/untrust</code>",text::remaining(trust["remainingMs"].number())),true)
                    } else {
                        (
                            "🔴 신뢰 모드 OFF. 모든 위험 도구 다시 확인 받음.".into(),
                            false,
                        )
                    }
                }
            }
            "/todo" => return self.todo(app, context, arg).await,
            "/schedule" => return self.schedule(app, context, arg).await,
            "/history" | "/find" => self.history(&app, command, arg).await?,
            "/projects" | "/terminals" | "/decisions" | "/agents" => {
                self.query(&app, command, arg).await?
            }
            "/approvals" | "/log" => self.log(command, arg)?,
            "/diag" => {
                let message = self.diagnostic(&app).await?;
                return self.reply(&app, context, message, true).await;
            }
            "/restart" => {
                let prepared = crate::server_restart::prepare(app.clone()).await?;
                self.reply(
                    &app,
                    context,
                    format!(
                        "터미널 {}개를 보존하며 콕핏 서버를 재시작합니다.",
                        prepared.terminal_count
                    ),
                    false,
                )
                .await?;
                prepared.schedule();
                return Ok(());
            }
            _ => {
                if !command.starts_with('/') {
                    if text::presence(&value) == Some("away") {
                        app.supervisor.set_mode("away");
                        return self
                            .reply(
                                &app,
                                context,
                                "🚶 자리 비움 인지, AWAY 모드 전환됨\n모호한 결정 너한테 물어볼게.",
                                false,
                            )
                            .await;
                    }
                    if text::presence(&value) == Some("here") {
                        app.supervisor.set_mode("here");
                        return self
                            .reply(
                                &app,
                                context,
                                "🏠 자리 복귀 인지, HERE 모드 전환됨\n알림 최소화.",
                                false,
                            )
                            .await;
                    }
                }
                return self.chat(app, context, message, None).await;
            }
        };
        self.reply(&app, context, reply.0, reply.1).await
    }
    async fn todo(
        self: &Arc<Self>,
        app: Arc<App>,
        context: &UpdateContext,
        arg: &str,
    ) -> Result<(), String> {
        let mut words = arg.split_whitespace();
        let sub = words.next().unwrap_or("");
        let rest = words.collect::<Vec<_>>().join(" ");
        let reply = match sub {
            "" | "list" => {
                let todos = self.todos.list(false)?;
                if todos.array().is_empty() {
                    (
                        "미완료 todo 없음.\n추가: <code>/todo add 작업 내용</code>".into(),
                        true,
                    )
                } else {
                    (format!("<b>미완료 todo {}건</b>\n{}\n\n다음: <code>/todo next</code>  ·  완료: <code>/todo done N</code>",todos.array().len(),todos.array().iter().map(|t|format!("{}. {}",t["id"].text(),escaped(&masked(&t["text"])))).collect::<Vec<_>>().join("\n")),true)
                }
            }
            "add" if !rest.is_empty() => {
                let row = self.todos.add(&rest.into(), now(), &context.cancel)?;
                (
                    format!(
                        "📝 추가됨 (#{}): {}",
                        row["id"].text(),
                        escaped(&masked(&row["text"]))
                    ),
                    true,
                )
            }
            "add" => ("사용법: <code>/todo add 작업 내용</code>".into(), true),
            "done" => {
                let digits: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '+' || *c == '-')
                    .collect();
                let id = digits.parse::<f64>().unwrap_or(0.0);
                if id == 0.0 || !id.is_finite() {
                    ("사용법: <code>/todo done 3</code>".into(), true)
                } else {
                    let row = self.todos.done(id, now(), &context.cancel)?;
                    if row == V::Null {
                        (format!("#{id} todo 없음."), false)
                    } else {
                        (
                            format!(
                                "✅ 완료 처리 (#{}): {}",
                                row["id"].text(),
                                escaped(&masked(&row["text"]))
                            ),
                            true,
                        )
                    }
                }
            }
            "next" => {
                let todo = self.todos.next()?;
                if todo == V::Null {
                    ("미완료 todo 없음.".into(), false)
                } else {
                    return self
                        .chat(
                            app,
                            context,
                            crate::agent_runtime::concat(&[
                                "다음 todo 처리해줘: ".into(),
                                todo["text"].clone(),
                            ]),
                            Some(todo),
                        )
                        .await;
                }
            }
            _ => (
                "사용법: /todo [list | add <text> | done <N> | next]".into(),
                false,
            ),
        };
        self.reply(&app, context, reply.0, reply.1).await
    }
    async fn schedule(
        self: &Arc<Self>,
        app: Arc<App>,
        context: &UpdateContext,
        arg: &str,
    ) -> Result<(), String> {
        let mut words = arg.split_whitespace();
        let sub = words.next().unwrap_or("");
        let id = words.next().unwrap_or("");
        let reply = match sub {
            "" | "list" => {
                let schedules = app.autonomy_schedule.list()?;
                if schedules.array().is_empty() {
                    ("<b>스케줄 없음</b>\n\n추가: <code>/schedule add \"pattern\" \"prompt\"</code>\n\n패턴: <code>09:00 daily</code>, <code>09:00 weekday</code>, <code>every 30m</code>, <code>every 2h</code>".into(),true)
                } else {
                    let rows = schedules
                        .array()
                        .iter()
                        .map(|s| {
                            let last = crate::autonomy_schedule::date(&s["lastRun"])
                                .ok()
                                .flatten()
                                .and_then(chrono::DateTime::from_timestamp_millis)
                                .filter(|_| s["lastRun"].truthy())
                                .map(|date| format!(" (마지막 {})", date.format("%H:%M")))
                                .unwrap_or_default();
                            format!(
                                "{} <code>{}</code>: <b>{}</b>\n   {}{last}",
                                if s["enabled"].truthy() { "🟢" } else { "⚪" },
                                escaped(&s["id"].text()),
                                escaped(&masked(&s["pattern"])),
                                escaped(&text::mask(&s["prompt"]).cut(80).text())
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    (format!("<b>스케줄 {}건</b>\n\n{rows}\n\n제거: <code>/schedule remove ID</code>\n즉시 실행: <code>/schedule run ID</code>",schedules.array().len()),true)
                }
            }
            "add" => {
                let parser = regex::Regex::new(r#"^add\s+"([^"]+)"\s+"([^"]+)"$"#).unwrap();
                if let Some(parts) = parser.captures(arg) {
                    let row = app.autonomy_schedule.add(
                        &parts[1].into(),
                        &parts[2].into(),
                        &V::object(),
                        now(),
                    )?;
                    (
                        format!(
                            "📅 등록됨 <code>{}</code>\n패턴: {}\n작업: {}",
                            escaped(&row["id"].text()),
                            escaped(&masked(&row["pattern"])),
                            escaped(&masked(&row["prompt"]))
                        ),
                        true,
                    )
                } else {
                    ("사용법: <code>/schedule add \"pattern\" \"prompt\"</code>\n예: <code>/schedule add \"09:00 weekday\" \"오늘 할 일 정리\"</code>".into(),true)
                }
            }
            "remove" if !id.is_empty() => {
                let removed = app.autonomy_schedule.remove(&id.into())?;
                (
                    if removed {
                        format!("🗑 제거됨: {id}")
                    } else {
                        format!("{id} 없음.")
                    },
                    false,
                )
            }
            "remove" => ("사용법: <code>/schedule remove ID</code>".into(), true),
            "toggle" => {
                let row = app.autonomy_schedule.toggle(&id.into())?;
                (
                    if row == V::Null {
                        format!("{id} 없음.")
                    } else {
                        format!(
                            "{} {id} 토글됨",
                            if row["enabled"].truthy() {
                                "🟢"
                            } else {
                                "⚪"
                            }
                        )
                    },
                    false,
                )
            }
            "run" if !id.is_empty() => {
                if app
                    .ai_config
                    .key()
                    .map_err(|_| "AI configuration unavailable")?
                    .is_none()
                {
                    return Err("Gemini API key not configured".into());
                }
                if let Some(lease) = app.autonomy_schedule.claim(&id.into(), now(), false)? {
                    let target = app.clone();
                    let cancel = context.cancel.child();
                    let job = tokio::spawn(async move {
                        let guard = Admission {
                            cancel,
                            armed: true,
                        };
                        let _ = crate::background_agents::execute_schedule(
                            target,
                            &lease.schedule,
                            &guard.cancel,
                        )
                        .await;
                        drop(lease);
                    });
                    let mut jobs = self.jobs.lock().unwrap();
                    jobs.retain(|job| !job.is_finished());
                    jobs.push(job);
                    (format!("▶️ 즉시 실행: {id}"), false)
                } else {
                    (format!("{id} 없음 또는 이미 실행 중."), false)
                }
            }
            "run" => ("사용법: <code>/schedule run ID</code>".into(), true),
            _ => (
                "사용법: /schedule [list | add | remove | run | toggle]".into(),
                false,
            ),
        };
        self.reply(&app, context, reply.0, reply.1).await
    }
    async fn history(&self, app: &App, command: &str, arg: &str) -> Result<(String, bool), String> {
        let history = app.agent.history()?;
        if command == "/history" {
            let current = self.state.lock().await.conversation.clone();
            let conversation = current
                .and_then(|id| history.iter().find(|(key, _)| *key == id))
                .or_else(|| {
                    history
                        .iter()
                        .rev()
                        .find(|(_, c)| !c["messages"].array().is_empty())
                });
            let Some((id, conversation)) = conversation else {
                return Ok(("현재 대화에 메시지 없음.".into(), false));
            };
            let messages = conversation["messages"].array();
            let n = count(arg, 10, 1000);
            let messages = &messages[messages.len().saturating_sub(n)..];
            let json = regex::Regex::new(r"(?s)```json.*?```").unwrap();
            let lines = messages
                .iter()
                .map(|message| {
                    let content = json
                        .replace_all(&masked(&message["content"]), "")
                        .trim()
                        .to_string();
                    format!(
                        "{} {}",
                        if message["role"] == V::from("user") {
                            "👤"
                        } else {
                            "🤖"
                        },
                        V::from(content).cut(200).text()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            return Ok((
                format!(
                    "<b>최근 {}건 ({})</b>\n\n{}",
                    messages.len(),
                    escaped(&V::from(id.clone()).cut(16).text()),
                    escaped(&lines)
                ),
                true,
            ));
        }
        if arg.is_empty() {
            return Ok(("사용법: <code>/find &lt;검색어&gt;</code>".into(), true));
        }
        let needle = arg.to_lowercase();
        let mut matches = vec![];
        for (id, conversation) in &history {
            for message in conversation["messages"].array() {
                if message["content"].text().to_lowercase().contains(&needle) {
                    let content = masked(&message["content"]);
                    let lower = content.to_lowercase();
                    let index = lower
                        .find(&needle)
                        .map(|byte| lower[..byte].chars().count())
                        .unwrap_or(0);
                    let snippet = content
                        .chars()
                        .skip(index.saturating_sub(30))
                        .take(needle.chars().count() + 60)
                        .collect::<String>()
                        .replace('\n', " ");
                    let stamp = crate::autonomy_schedule::date(&conversation["createdAt"])
                        .ok()
                        .flatten()
                        .and_then(chrono::DateTime::from_timestamp_millis)
                        .map(|d| d.format("%Y-%m-%dT%H:%M").to_string())
                        .unwrap_or_default();
                    let idtail = id
                        .chars()
                        .rev()
                        .take(6)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>();
                    matches.push(format!(
                        "{}. {} {stamp} ({idtail})\n   …{}…",
                        matches.len() + 1,
                        if message["role"] == V::from("user") {
                            "👤"
                        } else {
                            "🤖"
                        },
                        V::from(snippet).cut(100).text()
                    ));
                    if matches.len() == 10 {
                        break;
                    }
                }
            }
            if matches.len() == 10 {
                break;
            }
        }
        Ok((
            if matches.is_empty() {
                format!("\"{}\" 검색 결과 없음.", escaped(&masked(&arg.into())))
            } else {
                format!(
                    "<b>\"{}\" 검색 결과 {}건</b>\n\n{}",
                    escaped(&masked(&arg.into())),
                    matches.len(),
                    escaped(&matches.join("\n\n"))
                )
            },
            true,
        ))
    }
    async fn query(&self, app: &App, command: &str, arg: &str) -> Result<(String, bool), String> {
        if command == "/agents" {
            let company = crate::agent_app::response(app.agent.handle(
                &Method::GET,
                "/api/agent/company",
                &V::Null,
            ))
            .await?;
            let mut lines = vec![];
            if let Some(ceo) = company["agents"]
                .array()
                .iter()
                .find(|a| a["id"] == V::from("daepyo"))
            {
                lines.push(format!(
                    "{} <b>{}</b> ({})",
                    ceo["emoji"].text(),
                    escaped(&ceo["name"].text()),
                    escaped(&ceo["rank"].text())
                ));
            }
            for team in company["teams"].array() {
                let members = company["agents"]
                    .array()
                    .iter()
                    .filter(|a| a["team"] == team["id"])
                    .map(|m| {
                        format!(
                            "{} {}({})",
                            m["emoji"].text(),
                            m["name"].text(),
                            m["rank"].text()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                lines.push(format!(
                    "{} <b>{}</b>: {}",
                    team["icon"].text(),
                    escaped(&team["name"].text()),
                    escaped(&members)
                ));
            }
            return Ok((
                format!(
                    "<b>에이전트 목록</b>\n{}\n\n사용: 채팅에서 원하는 에이전트를 호출하세요.",
                    lines.join("\n")
                ),
                true,
            ));
        }
        let snapshot = self.snapshot(app).await?;
        let projects = snapshot["projects"].array();
        let (title, rows, empty) = match command {
            "/projects" => (
                format!("프로젝트 {}개", projects.len()),
                projects
                    .iter()
                    .map(|p| {
                        let icon = match p["session"]["state"].text().as_str() {
                            "busy" | "active" => "🟢",
                            "waiting" => "🟠",
                            "idle" => "⚪",
                            _ => "·",
                        };
                        format!(
                            "{icon} {}{}{}",
                            masked(&p["name"]),
                            if p["git"]["branch"].truthy() {
                                format!(" · {}", masked(&p["git"]["branch"]))
                            } else {
                                String::new()
                            },
                            if p["git"]["uncommittedCount"].truthy() {
                                format!(" · uncommitted {}", p["git"]["uncommittedCount"].text())
                            } else {
                                String::new()
                            }
                        )
                    })
                    .collect::<Vec<_>>(),
                "등록된 프로젝트 없음.",
            ),
            "/terminals" => {
                let terms = snapshot["terminals"].array();
                (
                    format!("활성 터미널 {}개", terms.len()),
                    terms
                        .iter()
                        .enumerate()
                        .map(|(i, t)| {
                            let name = projects
                                .iter()
                                .find(|p| p["id"] == t["projectId"])
                                .map(|p| masked(&p["name"]))
                                .unwrap_or_else(|| t["projectId"].text());
                            format!(
                                "{}. [{}] {name} · {}",
                                i + 1,
                                t["termId"].text(),
                                if t["command"].truthy() {
                                    masked(&t["command"])
                                } else {
                                    "(shell)".into()
                                }
                            )
                        })
                        .collect(),
                    "활성 터미널 없음.",
                )
            }
            _ => {
                let decisions = &snapshot["decisions"].array();
                let n = count(arg, 10, 100);
                let rows = &decisions[decisions.len().saturating_sub(n)..];
                (
                    format!("최근 supervisor 결정 {}건", rows.len()),
                    rows.iter()
                        .map(|d| {
                            let icon = match d["decision"].text().as_str() {
                                "approve" => "🟢",
                                "block" | "deny" => "🔴",
                                "ask" => "🟡",
                                _ => "·",
                            };
                            let input = if d["input"]["command"].truthy() {
                                &d["input"]["command"]
                            } else {
                                &d["input"]["file_path"]
                            };
                            let stamp = d["ts"].text().chars().skip(11).take(8).collect::<String>();
                            let cwd = d["cwd"].text();
                            let project = cwd
                                .split('/')
                                .filter(|p| !p.is_empty())
                                .next_back()
                                .unwrap_or("?");
                            format!(
                                "{icon} {stamp} [{project}] {}: {}",
                                d["tool"].text(),
                                text::mask(input).cut(60).text()
                            )
                        })
                        .collect(),
                    "supervisor 결정 없음.",
                )
            }
        };
        if rows.is_empty() {
            Ok((empty.into(), false))
        } else {
            Ok((
                format!(
                    "<b>{title}</b>\n{}",
                    escaped(&masked(&rows.join("\n").into()))
                ),
                true,
            ))
        }
    }
    async fn diagnostic(self: &Arc<Self>, app: &App) -> Result<V, String> {
        let focus = self.state.lock().await.focus.clone();
        let store = self.clone();
        let (rss, todo_count, log) = tokio::task::spawn_blocking(move || {
            // A rejected log must not hide independent process and bridge state.
            let log = store
                .todos
                .read_log("server.log")
                .map(|content| diagnostic_log(&content.unwrap_or_default()))
                .ok();
            Ok::<_, String>((
                diagnostic_rss(),
                store.todos.list(false)?.array().len(),
                log,
            ))
        })
        .await
        .map_err(|_| "Diagnostic storage unavailable")??;
        let seconds = self.started.elapsed().as_secs_f64().round() as u64;
        let uptime = if seconds < 60 {
            format!("{seconds}초")
        } else if seconds < 3600 {
            format!("{}분", (seconds + 30) / 60)
        } else {
            format!("{}시간", (seconds + 1800) / 3600)
        };
        let diagnostics = app.telegram.diagnostics();
        let trust = app.telegram.trust_state();
        let trust = if trust["active"].truthy() {
            format!("🟢 {} 남음", text::remaining(trust["remainingMs"].number()))
        } else {
            "🔴 OFF".into()
        };
        let memory = rss
            .map(|value| format!("{value}MB"))
            .unwrap_or_else(|| "확인 불가".into());
        let log_unavailable = log.is_none();
        let (errors, average, network) = match log {
            Some((errors, average, network)) => {
                (format!("{errors}건"), format!("{average}ms"), network)
            }
            None => ("확인 불가".into(), "확인 불가".into(), "".into()),
        };
        let mut parts = vec![format!(
            "<b>🩺 자기진단</b>\n\n런타임: Rust\nuptime: {uptime}\n메모리: RSS {memory} · Heap 해당 없음 (Rust, V8 미사용)\n텔레그램: {} (offset={})\n최근 500줄 에러: {errors}\nGemini 평균 응답: {average}\n신뢰 모드: {trust}\nFocus: ",
            if app.telegram.is_polling() { "🟢 polling 중" } else { "🔴 미동작" }, diagnostics["offset"].number()
        ).into(), escaped_units(&text::mask(&if focus.truthy() { focus } else { "없음".into() })),
            format!("\n미완료 todo: {todo_count}건\npending approvals: {}건", diagnostics["pendingApprovals"].number()).into()];
        if log_unavailable {
            parts.push("\n\n<b>최근 네트워크 에러:</b>\n확인 불가".into());
        } else if !network.units().is_empty() {
            parts.extend([
                "\n\n<b>최근 네트워크 에러:</b>\n<code>".into(),
                network,
                "</code>".into(),
            ]);
        }
        Ok(crate::agent_runtime::concat(&parts))
    }
    fn log(&self, command: &str, arg: &str) -> Result<(String, bool), String> {
        let name = if command == "/log" {
            "server.log"
        } else {
            "approvals.jsonl"
        };
        let Some(content) = self.todos.read_log(name)? else {
            return Ok((
                if command == "/log" {
                    "서버 로그 파일 없음."
                } else {
                    "승인 audit 로그 없음."
                }
                .into(),
                false,
            ));
        };
        let lines = content.trim().lines().collect::<Vec<_>>();
        let n = if command == "/log" {
            count(arg, 20, 50)
        } else {
            10
        };
        let tail = &lines[lines.len().saturating_sub(n)..];
        let rendered = if command == "/log" {
            tail.join("\n")
        } else {
            tail.iter()
                .map(|line| {
                    let row = serde_json::value::RawValue::from_string((*line).into())
                        .ok()
                        .and_then(|raw| V::parse(&raw).ok());
                    if let Some(row) = row {
                        let icon = match row["decision"].text().as_str() {
                            "user-approve" => "✅",
                            "user-deny" => "❌",
                            "timeout" => "⏱",
                            "trust-auto" => "🟢",
                            "deny-no-telegram" => "🚫",
                            _ => "·",
                        };
                        format!(
                            "{icon} {} {}{}",
                            row["ts"]
                                .text()
                                .chars()
                                .skip(11)
                                .take(8)
                                .collect::<String>(),
                            row["label"].text(),
                            if row["hard"].truthy() { " [HARD]" } else { "" }
                        )
                    } else {
                        V::from(masked(&(*line).into())).cut(80).text()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let masked = text::mask(&rendered.into());
        let units = masked.units();
        let limited = V::String(units[units.len().saturating_sub(3000)..].to_vec()).text();
        Ok((
            format!(
                "<b>{}</b>\n<code>{}</code>",
                if command == "/log" {
                    format!("서버 로그 (마지막 {n}줄)")
                } else {
                    "최근 승인 10건".into()
                },
                escaped(&limited)
            ),
            true,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_log_keeps_source_tail_counts_and_masks_before_utf16_truncation() {
        let boundary = format!("ETIMEDOUT {}😀", "x".repeat(69));
        let log = format!(
            "[ERROR] ETIMEDOUT outside\n{}[ERROR] ETIMEDOUT old\nGemini response in 100ms\nGemini response in 300ms\nGemini response in 0ms\n[ERROR] ETIMEDOUT <safe>& TOKEN=private-secret\nECONNRESET next\n{boundary}\n",
            "filler\n".repeat(501)
        );
        let (errors, average, network) = diagnostic_log(&log);
        assert_eq!(errors, 2);
        assert_eq!(average, "200");
        assert_eq!(
            network,
            crate::agent_runtime::concat(&[
                "[ERROR] ETIMEDOUT &lt;safe&gt;&amp; TOKEN=***\nECONNRESET next\n".into(),
                V::from(boundary).cut(80),
            ])
        );
        assert_eq!(network.units().last(), Some(&0xd83d));
    }
    #[test]
    fn diagnostic_log_empty_or_zero_duration_does_not_invent_measurements() {
        assert_eq!(diagnostic_log(""), (0, "?".into(), "".into()));
        assert_eq!(
            diagnostic_log("Gemini response in 0ms\n"),
            (0, "?".into(), "".into())
        );
    }
    #[test]
    fn long_project_context_cannot_remove_the_actual_question() {
        let question = V::from("사용자 질문 끝 😀");
        let message = enriched(
            "오래된 프로젝트 문맥\n".repeat(1000).into(),
            question.clone(),
        );
        assert_eq!(message.units().len(), 5000);
        assert!(message.units().ends_with(question.units()));
        assert!(message.text().contains("\n\n[사용자 질문]\n"));
        let message = enriched("private context".into(), "a".repeat(6000).into());
        assert_eq!(message.units().len(), 5000);
        assert!(message.text().starts_with("[사용자 질문]\n"));
        assert!(!message.text().contains("private context"));
    }
}
