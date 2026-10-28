//! Native solo execution. HTTP routing and collaborative execution are separate
//! integration stages; an unimplemented service tool is never reported as done.
use crate::{
    agent::Run,
    agent_prompt, agent_response,
    ai_transport::{self, Cancel, Delta},
    board_value::{object, V},
};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

pub type Pending<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;
pub type Stream = Arc<dyn Fn(Delta) + Send + Sync>;
pub type Events = Arc<dyn Fn(&str, V) + Send + Sync>;

pub struct ModelRequest {
    pub provider: String,
    pub model: String,
    pub system: V,
    pub user: V,
    pub timeout: Duration,
}
pub struct ToolRequest {
    pub kind: String,
    pub argument: V,
    pub conv_id: String,
    pub agent_id: String,
    pub delegate_depth: usize,
    pub delegate_chain: Vec<String>,
    pub sprint_mode: bool,
}
/// Implementations must own their operations: cancellation or dropping a future
/// must not leave a detached command or a delayed mutation behind.
pub trait Backend: Send + Sync {
    fn model<'a>(
        &'a self,
        request: ModelRequest,
        cancel: &'a Cancel,
        stream: Stream,
    ) -> Pending<'a, V>;
    fn tool<'a>(&'a self, request: ToolRequest, cancel: &'a Cancel) -> Pending<'a, V>;
}

pub struct NativeBackend {
    pub api_key: String,
    pub tools: Arc<crate::agent_tools::Store>,
}
impl Backend for NativeBackend {
    fn model<'a>(
        &'a self,
        request: ModelRequest,
        cancel: &'a Cancel,
        stream: Stream,
    ) -> Pending<'a, V> {
        Box::pin(async move {
            let result = if request.provider == "gemini" {
                ai_transport::gemini_prompts_utf16(
                    &self.api_key,
                    &request.user,
                    &request.system,
                    &ai_transport::GeminiOptions {
                        model: request.model,
                        timeout: request.timeout,
                        ..Default::default()
                    },
                    cancel,
                    move |delta| stream(delta),
                )
                .await
            } else {
                #[cfg(unix)]
                {
                    claude_model(
                        request,
                        cancel,
                        stream,
                        tokio::process::Command::new("claude"),
                    )
                    .await
                }
                #[cfg(not(unix))]
                {
                    Err("Native Claude launcher has not been validated on this platform".into())
                }
            };
            result.map(V::from)
        })
    }
    fn tool<'a>(&'a self, request: ToolRequest, cancel: &'a Cancel) -> Pending<'a, V> {
        Box::pin(async move {
            self.tools
                .execute_core(
                    &request.kind,
                    &request.argument,
                    crate::agent_tools::Context {
                        sprint_mode: request.sprint_mode,
                    },
                    cancel,
                )
                .await
                .unwrap_or_else(|| {
                    Err(format!(
                        "Native {} service tool is not integrated",
                        request.kind
                    ))
                })
        })
    }
}

#[cfg(unix)]
async fn claude_model(
    request: ModelRequest,
    cancel: &Cancel,
    stream: Stream,
    mut command: tokio::process::Command,
) -> Result<String, String> {
    // Cockpit owns tool permissions and history. The model CLI must not continue
    // another conversation or execute tools/hooks/MCP outside that dispatch.
    command.args(["--safe-mode", "--tools", "", "--no-session-persistence"]);
    ai_transport::claude_command(
        command,
        &request.user.text(),
        &ai_transport::ClaudeOptions {
            model: request.model,
            system_prompt: Some(request.system.text()),
            continue_session: false,
            stream: true,
            timeout: request.timeout,
        },
        cancel,
        move |delta| stream(delta),
    )
    .await
}

pub struct SoloContext {
    pub profile: V,
    pub roots: Vec<V>,
    pub project: V,
    pub team: V,
    pub platform: String,
    pub claude_available: bool,
}
pub(crate) fn concat(values: &[V]) -> V {
    V::String(
        values
            .iter()
            .flat_map(|v| v.units().iter().copied())
            .collect(),
    )
}
fn starts(value: &V, prefix: &str) -> bool {
    value
        .units()
        .starts_with(&prefix.encode_utf16().collect::<Vec<_>>())
}
pub(crate) fn event(emit: &Events, id: &str, name: &str, mut data: V) {
    data["convId"] = id.into();
    emit(name, data);
}
pub(crate) fn timeout_for(tool: &str) -> Duration {
    Duration::from_secs(match tool {
        "READ" | "EDIT" | "WRITE" | "WEATHER" => 10,
        "SEARCH" => 30,
        "GLOB" | "JIRA" | "CICD" | "COCKPIT" => 20,
        "GIT_DIFF" | "GIT_LOG" => 15,
        "OPEN" => 5,
        "DELEGATE" | "CONSULT" => 120,
        _ => 60,
    })
}

/// Unlike Promise.race, dropping the losing future also drops its owned work.
/// On a normal stop/timeout, first allow the operation to reap its children.
pub(crate) async fn bounded<T>(
    future: Pending<'_, T>,
    parent: &Cancel,
    child: &Cancel,
    timeout: Duration,
    label: &str,
) -> Result<T, String> {
    tokio::pin!(future);
    let failure = tokio::select! {
        biased;
        _ = parent.cancelled() => "Agent request cancelled".to_string(),
        result = &mut future => return result,
        _ = tokio::time::sleep(timeout) => label.to_string(),
    };
    child.cancel();
    // Cooperative native transports reap immediately. The final drop also owns
    // process cleanup if an adapter fails to acknowledge cancellation.
    let _ = tokio::time::timeout(Duration::from_secs(2), &mut future).await;
    Err(failure)
}

async fn model(
    run: &Run,
    context: &SoloContext,
    backend: &dyn Backend,
    emit: &Events,
    log: &[V],
    iteration: usize,
    finish: bool,
) -> Result<V, String> {
    let profile = &context.profile;
    let model = profile["model"].text();
    let mode = if ["pro", "sonnet", "opus"].iter().any(|s| model.contains(s)) {
        "pro"
    } else {
        "flash"
    };
    let system = agent_prompt::build_system_prompt(
        &mode.into(),
        Some(profile),
        &context.roots,
        &run.user_name,
        &context.platform,
    )?;
    let prompts = agent_prompt::assemble_prompt(
        &context.project,
        &context.team,
        &run.messages,
        log,
        finish,
        &system,
    )?;
    let id = run.id.clone();
    let agent_id = profile["id"].clone();
    let publish = emit.clone();
    let parent = run.cancel.clone();
    let stream: Stream = Arc::new(move |delta| {
        if parent.is_cancelled() {
            return;
        }
        let (kind, delta) = match delta {
            Delta::Text(s) => ("text", s),
            Delta::Thinking(s) => ("thinking", s),
        };
        if !delta.is_empty() {
            event(
                &publish,
                &id,
                "agent:streaming",
                object([
                    ("iteration", (iteration as f64).into()),
                    ("streamType", kind.into()),
                    ("delta", delta.into()),
                    ("agentId", agent_id.clone()),
                ]),
            );
        }
    });
    let gemini = profile["provider"] == V::from("gemini") || !context.claude_available;
    let request = ModelRequest {
        timeout: Duration::from_secs(120),
        provider: if gemini { "gemini" } else { "claude" }.into(),
        model: if gemini && profile["provider"] != V::from("gemini") {
            "gemini-2.5-flash".into()
        } else {
            model
        },
        system: prompts["system"].clone(),
        user: prompts["user"].clone(),
    };
    let child = run.cancel.child();
    bounded(
        backend.model(request, &child, stream),
        &run.cancel,
        &child,
        Duration::from_secs(120),
        "Agent model request timed out",
    )
    .await
}

fn compress_history(run: &mut Run, emit: &Events) {
    if run.messages.len() > 30 {
        let overflow = run.messages.len() - 30;
        let old: Vec<_> = run.messages.drain(..overflow).collect();
        let mut pieces = vec![V::from(format!("[이전 대화 요약: {overflow}개 메시지]\n"))];
        for (index, message) in old.iter().enumerate() {
            if index > 0 {
                pieces.push("\n".into());
            }
            pieces.push(if message["role"] == V::from("user") {
                "[U] ".into()
            } else {
                "[A] ".into()
            });
            pieces.push(message["content"].cut(60));
        }
        let timestamp = old
            .first()
            .map(|m| m["ts"].clone())
            .filter(V::truthy)
            .unwrap_or_else(|| (crate::account_usage::now() as f64).into());
        run.messages.insert(
            0,
            object([
                ("role", "assistant".into()),
                ("content", concat(&pieces)),
                ("ts", timestamp),
            ]),
        );
        event(
            emit,
            &run.id,
            "agent:warning",
            object([(
                "message",
                format!("대화가 길어져서 오래된 메시지 {overflow}개를 요약했어영.").into(),
            )]),
        );
    }
    if run
        .messages
        .iter()
        .map(|m| m["content"].units().len())
        .sum::<usize>()
        > 44_000
    {
        event(
            emit,
            &run.id,
            "agent:warning",
            object([(
                "message",
                "대화가 토큰 예산의 80%를 넘었어영. 새 대화를 시작하는 걸 추천해영.".into(),
            )]),
        );
    }
}

async fn iterations(
    run: &mut Run,
    context: &SoloContext,
    backend: &dyn Backend,
    emit: &Events,
) -> Result<(V, Vec<V>, usize), String> {
    let profile = &context.profile;
    let max_iter = profile["maxIter"].number_or(25.0) as usize;
    let allowed = agent_prompt::agent_tools(Some(profile));
    let mut log = vec![];
    let mut response = V::from("");
    let mut iteration = 0usize;
    let mut last_error = V::Null;
    let mut error_streak = 0;
    let mut repeated_error = false;
    while iteration < max_iter {
        if run.cancel.is_cancelled() {
            event(
                emit,
                &run.id,
                "agent:step",
                object([
                    ("iteration", (iteration as f64).into()),
                    ("text", "(중단됨)".into()),
                    ("hasTool", false.into()),
                ]),
            );
            break;
        }
        iteration += 1;
        event(
            emit,
            &run.id,
            "agent:thinking",
            object([
                ("iteration", (iteration as f64).into()),
                ("maxIterations", (max_iter as f64).into()),
                ("agentId", profile["id"].clone()),
            ]),
        );
        let raw = match model(run, context, backend, emit, &log, iteration, false).await {
            Err(_) if run.cancel.is_cancelled() => break,
            other => other?,
        };
        if run.cancel.is_cancelled() {
            break;
        }
        let user = run
            .messages
            .iter()
            .rev()
            .find(|m| m["role"] == V::from("user"))
            .map(|m| &m["content"])
            .unwrap_or(&run.message);
        let parsed = agent_response::parse(&raw, user)?;
        if parsed["thinking"].truthy() {
            event(
                emit,
                &run.id,
                "agent:thinking-text",
                object([
                    ("iteration", (iteration as f64).into()),
                    ("thinking", parsed["thinking"].clone()),
                ]),
            );
        }
        let calls = parsed["toolCalls"].array();
        event(
            emit,
            &run.id,
            "agent:step",
            object([
                ("iteration", (iteration as f64).into()),
                ("text", parsed["message"].clone()),
                ("hasTool", (!calls.is_empty()).into()),
            ]),
        );
        if calls.is_empty() {
            response = parsed["message"].clone();
            break;
        }
        for (index, call) in calls.iter().take(5).enumerate() {
            if run.cancel.is_cancelled() {
                break;
            }
            let kind = call["type"].text();
            let thinking = if index == 0 && parsed["thinking"].truthy() {
                parsed["thinking"].clone()
            } else {
                "".into()
            };
            let mut info = object([
                ("iteration", (iteration as f64).into()),
                ("tool", kind.clone().into()),
                ("toolIndex", (index as f64).into()),
            ]);
            if !allowed.contains(&kind) {
                let arg = if call["arg"].truthy() {
                    call["arg"].clone()
                } else {
                    "".into()
                };
                let team = if profile["team"].truthy() {
                    profile["team"].text()
                } else {
                    "no-team".into()
                };
                let result = V::from(format!(
                    "Error: \"{}\"({team})은(는) {kind} 도구를 사용할 수 없습니다. 사용 가능: {}",
                    profile["name"].text(),
                    allowed.join(", ")
                ));
                info["arg"] = arg.clone();
                event(emit, &run.id, "agent:tool", info.clone());
                info.remove("arg");
                info["result"] = result.clone();
                event(emit, &run.id, "agent:tool-result", info);
                log.push(object([
                    ("turn", (iteration as f64).into()),
                    ("thinking", thinking),
                    ("tool", kind.into()),
                    ("arg", arg),
                    ("result", result),
                ]));
                continue;
            }
            let argument = match kind.as_str() {
                "EDIT" => agent_response::build_edit_arg(call)?.unwrap_or(V::Null),
                "WRITE" => agent_response::build_write_arg(call)?.unwrap_or(V::Null),
                _ => call["arg"].clone(),
            };
            let display = if (kind == "EDIT" || kind == "WRITE") && call["file"].truthy() {
                call["file"].clone()
            } else {
                argument.clone()
            };
            if display != V::Null || call.has("arg") {
                info["arg"] = display.clone();
            }
            info["agentId"] = profile["id"].clone();
            if kind == "DELEGATE" {
                for line in argument.text().lines().map(str::trim) {
                    if let Some(id) = line.strip_prefix("agent:") {
                        info["targetAgentId"] = id.trim().into();
                    } else if let Some(team) = line.strip_prefix("team:") {
                        info["targetTeam"] = team.trim().into();
                    }
                }
            }
            event(emit, &run.id, "agent:tool", info.clone());
            let timeout = timeout_for(&kind);
            let child = run.cancel.child();
            let result = bounded(
                backend.tool(
                    ToolRequest {
                        kind: kind.clone(),
                        argument,
                        conv_id: run.id.clone(),
                        agent_id: profile["id"].text(),
                        delegate_depth: 0,
                        delegate_chain: vec![],
                        sprint_mode: false,
                    },
                    &child,
                ),
                &run.cancel,
                &child,
                timeout,
                &format!("{kind} 도구가 {}초 타임아웃됐어영.", timeout.as_secs()),
            )
            .await;
            let result = match result {
                Ok(value) if value.is_string() => value,
                Ok(_) => return Err("Tool result must be a string".into()),
                Err(error) => format!("Error: {error}").into(),
            };
            let result = if result.text().contains("not a git repository") {
                V::from("Error: 이 디렉토리는 git 저장소가 아니에영. git init을 먼저 해야 해영.")
            } else {
                result.cut(5000)
            };
            // No late success is emitted after a user stop or conversation deletion.
            if run.cancel.is_cancelled() {
                break;
            }
            info.remove("arg");
            info.remove("agentId");
            info.remove("targetAgentId");
            info.remove("targetTeam");
            info["result"] = result.clone();
            event(emit, &run.id, "agent:tool-result", info);
            log.push(object([
                ("turn", (iteration as f64).into()),
                ("thinking", thinking),
                ("tool", kind.clone().into()),
                ("arg", display),
                ("result", result.clone()),
            ]));
            if starts(&result, "Error:") {
                let key = concat(&[format!("{kind}:").into(), result.cut(100)]);
                error_streak = if key == last_error {
                    error_streak + 1
                } else {
                    1
                };
                last_error = key;
                if error_streak >= 3 {
                    response = concat(&[
                        "같은 에러가 3번 연속 발생해서 자동 중단했어영: ".into(),
                        result.cut(200),
                    ]);
                    event(
                        emit,
                        &run.id,
                        "agent:step",
                        object([
                            ("iteration", (iteration as f64).into()),
                            ("text", response.clone()),
                            ("hasTool", false.into()),
                        ]),
                    );
                    repeated_error = true;
                    break;
                }
            } else {
                error_streak = 0;
                last_error = V::Null;
            }
        }
        if repeated_error || run.cancel.is_cancelled() {
            break;
        }
        agent_prompt::trim_tool_log(&mut log)?;
        if parsed["isFinal"].truthy() || parsed["implicit"].truthy() {
            response = parsed["message"].clone();
            for entry in &log {
                if entry["turn"].number() == iteration as f64
                    && starts(&entry["result"], "@@EMBED:")
                {
                    response = concat(&[response, "\n".into(), entry["result"].clone()]);
                }
            }
            break;
        }
        if iteration >= max_iter {
            let summary = match model(run, context, backend, emit, &log, iteration, true).await {
                Err(_) if run.cancel.is_cancelled() => break,
                result => result?,
            };
            if run.cancel.is_cancelled() {
                break;
            }
            let parsed = agent_response::parse(&summary, &V::from(""))?;
            response = if parsed["message"].truthy() {
                parsed["message"].clone()
            } else {
                strip_legacy(&summary)
            };
            event(
                emit,
                &run.id,
                "agent:step",
                object([
                    ("iteration", (iteration as f64).into()),
                    ("text", response.clone()),
                    ("hasTool", false.into()),
                ]),
            );
        }
    }
    if !response.truthy() && run.cancel.is_cancelled() {
        response = "(작업이 중단되었어영)".into();
    }
    Ok((response, log, iteration))
}
fn strip_legacy(text: &V) -> V {
    // Preserve lone UTF-16 units outside removed legacy tool blocks.
    let expression = regress::Regex::new(r"@@TOOL:\w+@@[\s\S]*?@@END@@").unwrap();
    let units = text.units();
    let mut result = vec![];
    let mut offset = 0;
    for found in expression.find_from_ucs2(units, 0) {
        result.extend_from_slice(&units[offset..found.range.start]);
        offset = found.range.end;
    }
    result.extend_from_slice(&units[offset..]);
    V::String(result).trim()
}

pub async fn run_solo(
    mut run: Run,
    context: SoloContext,
    backend: &dyn Backend,
    emit: Events,
) -> Result<(), String> {
    let profile = &context.profile;
    if run.length_warning {
        event(
            &emit,
            &run.id,
            "agent:warning",
            object([("message", "메시지가 너무 길어서 5000자로 잘렸어영.".into())]),
        );
    }
    event(
        &emit,
        &run.id,
        "agent:start",
        object([
            ("maxIterations", profile["maxIter"].number_or(25.0).into()),
            ("model", profile["model"].clone()),
            ("agentId", profile["id"].clone()),
            ("agentName", profile["name"].clone()),
            ("agentColor", profile["color"].clone()),
        ]),
    );
    if !context.claude_available && profile["provider"] == V::from("claude") {
        event(
            &emit,
            &run.id,
            "agent:warning",
            object([(
                "message",
                format!(
                    "{}은 Claude 모델이지만 사용할 수 없어서 Gemini로 대체했어영.",
                    profile["name"].text()
                )
                .into(),
            )]),
        );
    }
    compress_history(&mut run, &emit);
    match iterations(&mut run, &context, backend, &emit).await {
        Ok((response, log, iteration)) => {
            let summary = log
                .iter()
                .map(|t| object([("tool", t["tool"].clone()), ("arg", t["arg"].cut(100))]))
                .collect();
            run.messages.push(object([
                ("role", "assistant".into()),
                ("content", response.clone()),
                ("ts", (crate::account_usage::now() as f64).into()),
                ("toolSummary", V::Array(summary)),
                ("agentId", profile["id"].clone()),
            ]));
            match run.commit() {
                Ok(true) => {
                    event(
                        &emit,
                        &run.id,
                        "agent:response",
                        object([
                            ("content", response),
                            ("agentId", profile["id"].clone()),
                            ("agentName", profile["name"].clone()),
                            ("agentColor", profile["color"].clone()),
                        ]),
                    );
                    event(
                        &emit,
                        &run.id,
                        "agent:done",
                        object([
                            ("iterations", (iteration as f64).into()),
                            ("agentId", profile["id"].clone()),
                        ]),
                    );
                    Ok(())
                }
                Ok(false) => Ok(()),
                Err(error) => {
                    event(
                        &emit,
                        &run.id,
                        "agent:error",
                        object([("error", error.clone().into())]),
                    );
                    Err(error)
                }
            }
        }
        Err(error) => {
            event(
                &emit,
                &run.id,
                "agent:error",
                object([("error", error.clone().into())]),
            );
            run.messages.push(object([
                ("role", "assistant".into()),
                ("content", format!("앗 에러가 났어영.. {error}").into()),
                ("ts", (crate::account_usage::now() as f64).into()),
                ("toolSummary", V::Array(vec![])),
                ("agentId", profile["id"].clone()),
            ]));
            if let Err(save_error) = run.commit() {
                event(
                    &emit,
                    &run.id,
                    "agent:error",
                    object([("error", save_error.clone().into())]),
                );
                return Err(save_error);
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        fs,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };
    fn parse(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    fn digest(value: &V) -> V {
        let bytes: Vec<_> = value
            .units()
            .iter()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        let hash = ring::digest::digest(&ring::digest::SHA256, &bytes)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        object([
            ("length", (value.units().len() as f64).into()),
            ("hash", hash.into()),
        ])
    }
    fn context(profile: V, team: V) -> SoloContext {
        SoloContext {
            profile,
            roots: vec![],
            project: "".into(),
            team,
            platform: "linux".into(),
            claude_available: false,
        }
    }
    fn quiet() -> Events {
        Arc::new(|_, _| {})
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn claude_model_requests_are_stateless_and_cannot_run_builtin_tools() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("cli.sh");
        fs::write(&script, "printf '%s\\0' \"$@\" > \"$FIXTURE_ARGS\"\n/bin/cat > \"$FIXTURE_INPUT\"\nprintf '%s\\n' '{\"type\":\"result\",\"result\":\"done\"}'\n").unwrap();
        let mut tasks = vec![];
        for id in ["first", "second"] {
            let mut command = tokio::process::Command::new("/bin/sh");
            command
                .arg(&script)
                .current_dir(directory.path())
                .env("FIXTURE_ARGS", directory.path().join(format!("{id}.args")))
                .env(
                    "FIXTURE_INPUT",
                    directory.path().join(format!("{id}.input")),
                );
            tasks.push(tokio::spawn(async move {
                claude_model(
                    ModelRequest {
                        timeout: Duration::from_secs(120),
                        provider: "claude".into(),
                        model: "fixture-model".into(),
                        system: format!("role-{id}").into(),
                        user: format!("history-{id}").into(),
                    },
                    &Cancel::default(),
                    Arc::new(|_| {}),
                    command,
                )
                .await
            }));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap().unwrap(), "done");
        }
        for id in ["first", "second"] {
            let args = fs::read_to_string(directory.path().join(format!("{id}.args"))).unwrap();
            let args: Vec<_> = args.trim_end_matches('\0').split('\0').collect();
            assert!(!args.contains(&"--continue"));
            assert!(!args.contains(&"--resume"));
            assert!(args.contains(&"--safe-mode"));
            assert!(args.contains(&"--no-session-persistence"));
            assert!(args.windows(2).any(|args| args == ["--tools", ""]));
            assert!(args
                .windows(2)
                .any(|args| args == ["--system-prompt", &format!("role-{id}")]));
            assert_eq!(
                fs::read_to_string(directory.path().join(format!("{id}.input"))).unwrap(),
                format!("history-{id}")
            );
        }
    }
    struct Fixture {
        responses: Mutex<VecDeque<V>>,
        results: Mutex<VecDeque<V>>,
        calls: Mutex<Vec<V>>,
        requests: Mutex<Vec<V>>,
    }
    impl Fixture {
        fn new(input: &V) -> Self {
            Self {
                responses: Mutex::new(input["responses"].array().iter().cloned().collect()),
                results: Mutex::new(input["results"].array().iter().cloned().collect()),
                calls: Mutex::new(vec![]),
                requests: Mutex::new(vec![]),
            }
        }
    }
    impl Backend for Fixture {
        fn model<'a>(
            &'a self,
            request: ModelRequest,
            _cancel: &'a Cancel,
            stream: Stream,
        ) -> Pending<'a, V> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(object([
                    ("model", request.model.into()),
                    ("timeout", 120000.0.into()),
                    ("system", digest(&request.system)),
                    ("user", digest(&request.user)),
                ]));
                let value = self
                    .responses
                    .lock()
                    .unwrap()
                    .pop_front()
                    .ok_or("Fixture provider exhausted")?;
                if value.has("error") {
                    return Err(value["error"].text());
                }
                stream(Delta::Text(value.text()));
                Ok(value)
            })
        }
        fn tool<'a>(&'a self, request: ToolRequest, _cancel: &'a Cancel) -> Pending<'a, V> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(object([
                    ("kind", request.kind.into()),
                    ("argument", request.argument),
                    ("convId", request.conv_id.into()),
                    ("agentId", request.agent_id.into()),
                ]));
                let value = self
                    .results
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or("ok".into());
                if value.has("error") {
                    Err(value["error"].text())
                } else {
                    Ok(value)
                }
            })
        }
    }
    #[test]
    fn prompts_match_original_javascript() {
        let fixtures = parse(include_str!("../../tests/fixtures/rust-agent-prompt.json"));
        assert_eq!(fixtures.array().len(), 190);
        for (index, fixture) in fixtures.array().iter().enumerate() {
            let input = &fixture["input"];
            let result = match input["action"].text().as_str() {
                "system" => agent_prompt::build_system_prompt(
                    &input["model"],
                    agent_prompt::profile(&input["agent"].text()),
                    input["roots"].array(),
                    &input["userName"],
                    &input["platform"].text(),
                )
                .map(|s| digest(&s)),
                "history" => agent_prompt::build_conversation_history(
                    input["messages"].array(),
                    input["maxChars"].number() as usize,
                ),
                "summary" => agent_prompt::summarize_tool_result(&input["tool"], &input["result"]),
                "log" => agent_prompt::build_tool_log_string(input["log"].array()),
                "trim" => {
                    let mut log = input["log"].array().to_vec();
                    agent_prompt::trim_tool_log(&mut log).map(|_| V::Array(log))
                }
                _ => panic!("unknown fixture"),
            };
            if fixture["expected"]["error"].truthy() {
                assert!(result.is_err(), "fixture {index}");
            } else {
                let expected = if input["action"] == V::from("system") {
                    &fixture["expected"]
                } else {
                    &fixture["expected"]["value"]
                };
                assert_eq!(
                    &result.unwrap(),
                    expected,
                    "fixture {index}: {}",
                    input["action"].text()
                );
            }
        }
    }
    #[tokio::test]
    async fn solo_events_calls_and_history_match_original_javascript() {
        let fixtures = parse(include_str!("../../tests/fixtures/rust-agent-runtime.json"));
        assert_eq!(fixtures.array().len(), 16);
        for fixture in fixtures.array() {
            let input = &fixture["input"];
            let name = input["name"].text();
            let temp = tempfile::tempdir().unwrap();
            let store = Arc::new(crate::agent::Store::new(temp.path().into()));
            let message = if input["message"].truthy() {
                input["message"].clone()
            } else {
                "작업".into()
            };
            let run = store.begin("fixture".into(), &message, None, true).unwrap();
            let backend = Fixture::new(input);
            let events = Arc::new(Mutex::new(vec![]));
            let seen = events.clone();
            let emit: Events = Arc::new(move |name, data| {
                seen.lock()
                    .unwrap()
                    .push(object([("name", name.into()), ("data", data)]))
            });
            let _ = run_solo(
                run,
                context(input["profile"].clone(), input["team"].clone()),
                &backend,
                emit,
            )
            .await;
            assert_eq!(
                V::Array(events.lock().unwrap().clone()),
                fixture["expected"]["events"],
                "events: {name}"
            );
            assert_eq!(
                V::Array(backend.calls.lock().unwrap().clone()),
                fixture["expected"]["calls"],
                "calls: {name}"
            );
            assert_eq!(
                V::Array(backend.requests.lock().unwrap().clone()),
                fixture["expected"]["requests"],
                "requests: {name}"
            );
            let history =
                parse(&fs::read_to_string(temp.path().join("agent-history.json")).unwrap());
            let mut messages = history["fixture"]["messages"].clone();
            for message in messages.array_mut() {
                message["ts"] = 123456.0.into();
            }
            assert_eq!(messages, fixture["expected"]["messages"], "history: {name}");
            assert!(!store.is_running("fixture"), "lease: {name}");
        }
    }
    #[test]
    fn begin_is_atomic_and_rejects_duplicates_until_owner_exits() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::agent::Store::new(temp.path().into()));
        let winners = Mutex::new(vec![]);
        std::thread::scope(|scope| {
            for _ in 0..24 {
                let store = &store;
                let winners = &winners;
                scope.spawn(move || {
                    if let Ok(run) = store.begin("one".into(), &"work".into(), None, true) {
                        winners.lock().unwrap().push(run);
                    }
                });
            }
        });
        assert_eq!(winners.lock().unwrap().len(), 1);
        assert_eq!(store.stop("one")["stopped"], true.into());
        assert!(store
            .begin("one".into(), &"next".into(), None, true)
            .is_err());
        winners.lock().unwrap().clear();
        assert!(!store.is_running("one"));
        let run = store
            .begin("one".into(), &"next".into(), None, true)
            .unwrap();
        assert_eq!(run.messages.len(), 2);
        drop(run);
        assert_eq!(store.stop("one")["stopped"], false.into());
    }
    #[test]
    fn deleted_and_evicted_runs_do_not_resurrect_history() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::agent::Store::new(temp.path().into()));
        let mut run = store
            .begin("one".into(), &"work".into(), None, true)
            .unwrap();
        let response = store.handle(
            &axum::http::Method::DELETE,
            "/api/agent/conversations/one",
            &V::Null,
        );
        assert!(response.status().is_success());
        assert!(run.cancel.is_cancelled());
        run.messages.push(object([
            ("role", "assistant".into()),
            ("content", "late".into()),
        ]));
        assert!(!run.commit().unwrap());
        assert!(store
            .begin("one".into(), &"next".into(), None, true)
            .is_err());
        drop(run);
        let run = store
            .begin("one".into(), &"new".into(), None, true)
            .unwrap();
        assert_eq!(run.messages.len(), 1);
        for _ in 0..50 {
            assert!(store
                .handle(
                    &axum::http::Method::POST,
                    "/api/agent/conversations",
                    &V::Null
                )
                .status()
                .is_success());
        }
        assert!(run.cancel.is_cancelled());
        assert!(!run.commit().unwrap());
        let history = parse(&fs::read_to_string(temp.path().join("agent-history.json")).unwrap());
        assert!(!history.has("one"));
    }
    #[test]
    fn accepted_message_is_durable_but_corrupt_history_is_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::agent::Store::new(temp.path().into()));
        let mut run = store
            .begin("one".into(), &V::from("😀".repeat(2501)), None, true)
            .unwrap();
        assert!(run.length_warning);
        assert_eq!(run.message.units().len(), 5000);
        let path = temp.path().join("agent-history.json");
        assert_eq!(
            parse(&fs::read_to_string(&path).unwrap())["one"]["messages"]
                .array()
                .len(),
            1
        );
        let old = fs::read(&path).unwrap();
        fs::write(&path, "{broken").unwrap();
        run.messages.push(object([
            ("role", "assistant".into()),
            ("content", "answer".into()),
        ]));
        assert!(run.commit().is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
        drop(run);
        assert!(!store.is_running("one"));
        assert!(store
            .begin("two".into(), &"next".into(), None, true)
            .is_err());
        assert!(!store.is_running("two"));
        fs::write(&path, old).unwrap();
        assert!(store
            .begin("two".into(), &"next".into(), None, true)
            .is_ok());
    }
    struct Waiting {
        entered: tokio::sync::Notify,
        dropped: AtomicBool,
    }
    impl Backend for Waiting {
        fn model<'a>(&'a self, _: ModelRequest, cancel: &'a Cancel, _: Stream) -> Pending<'a, V> {
            Box::pin(async move {
                struct Guard<'a>(&'a AtomicBool);
                impl Drop for Guard<'_> {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::SeqCst);
                    }
                }
                let _guard = Guard(&self.dropped);
                self.entered.notify_one();
                cancel.cancelled().await;
                Err("cancelled".into())
            })
        }
        fn tool<'a>(&'a self, _: ToolRequest, _: &'a Cancel) -> Pending<'a, V> {
            Box::pin(async { panic!("no tool after cancellation") })
        }
    }
    #[tokio::test]
    async fn stop_during_model_is_prompt_and_drops_owned_request() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::agent::Store::new(temp.path().into()));
        let run = store
            .begin("one".into(), &"work".into(), None, true)
            .unwrap();
        let backend = Arc::new(Waiting {
            entered: tokio::sync::Notify::new(),
            dropped: AtomicBool::new(false),
        });
        let b = backend.clone();
        let task = tokio::spawn(async move {
            run_solo(
                run,
                context(
                    agent_prompt::profile("dev_sawon").unwrap().clone(),
                    "".into(),
                ),
                &*b,
                quiet(),
            )
            .await
        });
        backend.entered.notified().await;
        store.stop("one");
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(backend.dropped.load(Ordering::SeqCst));
        assert!(!store.is_running("one"));
        let history = parse(&fs::read_to_string(temp.path().join("agent-history.json")).unwrap());
        assert_eq!(
            history["one"]["messages"].array().last().unwrap()["content"],
            V::from("(작업이 중단되었어영)")
        );
    }
    #[tokio::test]
    async fn aborting_runtime_task_releases_lease_and_preserves_user_turn() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::agent::Store::new(temp.path().into()));
        let run = store
            .begin("one".into(), &"work".into(), None, true)
            .unwrap();
        let backend = Arc::new(Waiting {
            entered: tokio::sync::Notify::new(),
            dropped: AtomicBool::new(false),
        });
        let b = backend.clone();
        let task = tokio::spawn(async move {
            run_solo(
                run,
                context(
                    agent_prompt::profile("dev_sawon").unwrap().clone(),
                    "".into(),
                ),
                &*b,
                quiet(),
            )
            .await
        });
        backend.entered.notified().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(backend.dropped.load(Ordering::SeqCst));
        assert!(!store.is_running("one"));
        let run = store
            .begin("one".into(), &"continue".into(), None, true)
            .unwrap();
        assert_eq!(run.messages.len(), 2);
    }
    #[tokio::test]
    async fn timed_out_operation_cannot_write_after_return() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("late");
        let parent = Cancel::default();
        let child = Cancel::default();
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "sleep 0.3; printf late > \"$1\"", "fixture"])
            .arg(&marker);
        let pending = Box::pin(async {
            crate::process_owned::run(command, Duration::from_secs(5), 1024, &child).await
        });
        assert!(bounded(
            pending,
            &parent,
            &child,
            Duration::from_millis(30),
            "fixture timeout"
        )
        .await
        .is_err());
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!marker.exists());
    }
}
