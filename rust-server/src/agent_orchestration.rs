//! Agent routing, dependency execution, delegation and quality review.
use crate::{
    agent::Run,
    agent_prompt::{self, property_string, string},
    agent_response, agent_routing,
    agent_runtime::{
        self, bounded, concat, event, Backend, Events, ModelRequest, Pending, SoloContext, Stream,
        ToolRequest,
    },
    ai_transport::{Cancel, Delta},
    board_value::{object, V},
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

pub type ContextSource<'a> = dyn Fn(&V) -> Result<SoloContext, String> + Send + Sync + 'a;
pub struct Engine<'a> {
    pub backend: &'a dyn Backend,
    pub context: &'a ContextSource<'a>,
    pub events: Events,
    pub routing: &'a agent_routing::State,
    pub user_name: V,
}
#[derive(Default, Clone)]
pub struct SubOptions {
    pub max_iterations: Option<usize>,
    pub project_context: Option<V>,
    pub delegate_depth: usize,
    pub delegate_chain: Vec<String>,
    pub sprint_mode: bool,
}
#[derive(Default)]
struct ReviewState {
    revised: HashMap<String, V>,
    failed: HashMap<String, String>,
    rerun: HashSet<String>,
    issues_found: bool,
    active_retry: Option<(String, V)>,
}
fn fallback(value: &V, default: &str) -> V {
    if value.truthy() {
        value.clone()
    } else {
        default.into()
    }
}
fn data(text: &str) -> Result<V, String> {
    V::parse(&serde_json::value::RawValue::from_string(text.into()).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn json_response(text: &V) -> Result<V, String> {
    let text = text.trim();
    let units = text.units();
    let start = if units.starts_with(&"```json".encode_utf16().collect::<Vec<_>>()) {
        7
    } else if units.starts_with(&[96, 96, 96]) {
        3
    } else {
        0
    };
    let end = if units[start..].ends_with(&[96, 96, 96]) {
        units.len() - 3
    } else {
        units.len()
    };
    // JSON serialization preserves lone UTF-16 strings; JSON syntax itself is ASCII.
    let raw = agent_response::json_text(&V::String(units[start..end].to_vec()))
        .ok_or("Invalid JSON response")?;
    data(raw.trim())
}
/// One-pass interpolation never treats a user's placeholder text as template code.
fn template(source: &str, values: &[V]) -> Result<V, String> {
    let mut result = Vec::new();
    let mut remaining = source;
    while let Some(start) = remaining.find("{{") {
        result.extend(remaining[..start].encode_utf16());
        let tail = &remaining[start + 2..];
        let end = tail.find("}}").ok_or("Invalid prompt template")?;
        let index = tail[..end]
            .parse::<usize>()
            .map_err(|_| "Invalid prompt placeholder")?;
        result.extend_from_slice(string(values.get(index).ok_or("Missing prompt value")?)?.units());
        remaining = &tail[end + 2..];
    }
    result.extend(remaining.encode_utf16());
    Ok(V::String(result))
}
fn profile(id: &V, default: &str) -> V {
    agent_prompt::profile(&id.text())
        .unwrap_or_else(|| agent_prompt::profile(default).unwrap())
        .clone()
}
fn team_name(team: &V) -> V {
    agent_prompt::catalog()["teams"]
        .array()
        .iter()
        .find(|t| t["id"] == *team)
        .map(|t| t["name"].clone())
        .unwrap_or_else(|| team.clone())
}
fn plan_system(orchestrator: &V) -> Result<V, String> {
    let team = &orchestrator["team"];
    let scoped = team.truthy()
        && ["Team Lead", "Manager", "Asst.Mgr"].contains(&orchestrator["rank"].text().as_str());
    let mut list = String::new();
    if scoped {
        list += &format!("[{}]\n", team_name(team).text());
        list += &agent_routing::get_team_members(team)
            .iter()
            .filter(|m| m["id"] != orchestrator["id"])
            .map(|m| {
                let persona = m["persona"]
                    .text()
                    .split('\n')
                    .next()
                    .unwrap_or("")
                    .to_string();
                format!(
                    "- {} ({}/{}): {}",
                    m["id"].text(),
                    m["name"].text(),
                    m["rank"].text(),
                    V::from(persona).cut(60).text()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        list += "\n\n다른 팀에 위임 필요 시 해당 팀장에게 배정 가능:";
        for other in agent_prompt::catalog()["teams"].array() {
            if other["id"] == *team {
                continue;
            }
            if let Some(lead) = agent_routing::get_team_members(&other["id"])
                .iter()
                .find(|m| ["Team Lead", "VP"].contains(&m["rank"].text().as_str()))
            {
                list += &format!(
                    "\n- {} ({}): {}",
                    lead["id"].text(),
                    lead["name"].text(),
                    other["name"].text()
                );
            }
        }
    } else {
        for team in agent_prompt::catalog()["teams"].array() {
            let members = agent_routing::get_team_members(&team["id"]);
            if members.is_empty() {
                continue;
            }
            list += &format!(
                "[{}]\n{}\n\n",
                team["name"].text(),
                members
                    .iter()
                    .map(|m| format!(
                        "- {} ({}/{})",
                        m["id"].text(),
                        m["name"].text(),
                        m["rank"].text()
                    ))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
    }
    template("너는 콕핏의 \"{{0}}\"이야. {{1}}\n사용자 요청을 분석해서 서브 태스크로 분해하고, 각 태스크에 적절한 에이전트를 배정해.\n\n가용 에이전트:\n{{2}}\n\n반드시 아래 JSON 형식으로만 답변:\n{\n  \"delegation_message\": \"팀에게 전달할 한 줄 메시지 (한국어, {{0}} 말투)\",\n  \"tasks\": [\n    {\"id\": \"t1\", \"description\": \"구체적 작업 내용\", \"assignee\": \"에이전트ID\", \"deps\": []},\n    {\"id\": \"t2\", \"description\": \"구체적 작업 내용\", \"assignee\": \"에이전트ID\", \"deps\": [\"t1\"]}\n  ]\n}\n\n규칙:\n- 태스크는 2~5개. 너무 잘게 쪼개지 마.\n- deps 배열로 의존성 표현. 빈 배열 = 즉시 실행 가능.\n- {{3}}\n- 단순 조회는 사원급, 분석/정리는 대리급, 판단/전략은 팀장급.\n- 너 자신({{4}})은 assignee로 넣지 마. 부하에게 시켜.\n- JSON 밖에 아무 텍스트도 출력하지 마.", &[
        orchestrator["name"].clone(), if scoped { format!("{} 소속으로, 팀 내 작업을 분배한다.", team_name(team).text()).into() } else { "전사 오케스트레이터로, 모든 팀에 작업을 분배한다.".into() }, list.into(),
        if scoped { "팀 내 작업은 팀원에게, 다른 팀 업무는 해당 팀장에게 배정.".into() } else { "각 팀의 전문 분야에 맞게 배정. 코드→개발팀, 문서→기획팀, 스타일→디자인팀, 비용/시스템→경영지원, 카피/마케팅→마케팅팀.".into() }, orchestrator["id"].clone(),
    ])
}
fn plan_prompt(message: &V, project: &V) -> Result<V, String> {
    template("사용자 요청: \"{{0}}\"\n\n{{1}}\n\n위 요청을 서브 태스크로 분해해줘. 각 태스크에 적절한 에이전트를 배정.\nJSON으로만 답변: {\"delegation_message\":\"...\", \"tasks\":[{\"id\":\"t1\",\"description\":\"...\",\"assignee\":\"에이전트ID\",\"deps\":[]}]}", &[message.clone(), project.clone()])
}
fn synthesis_prompt(message: &V, tasks: &[V], results: &HashMap<String, V>) -> Result<V, String> {
    let mut text = template(
        "## 원래 요청\n{{0}}\n\n## 팀 작업 결과\n",
        &[message.clone()],
    )?;
    for task in tasks {
        let name = agent_prompt::profile(&task["assignee"].text())
            .map(|p| p["name"].clone())
            .unwrap_or(task["assignee"].clone());
        let result = results
            .get(&task["id"].text())
            .filter(|v| v.truthy())
            .cloned()
            .unwrap_or("(결과 없음)".into());
        text = concat(&[
            text,
            template(
                "\n### {{0}}: {{1}} ({{2}})\n{{3}}\n",
                &[
                    task["id"].clone(),
                    task["description"].clone(),
                    name,
                    result.cut(3000),
                ],
            )?,
        ]);
    }
    Ok(concat(&[
        text,
        "\n## 지시\n위 결과들을 종합해서 사용자에게 최종 보고해. 핵심 위주로 정리.".into(),
    ]))
}
/// Validate the whole graph before any task runs. Duplicate/cyclic/unknown deps
/// previously produced a successful report with tasks silently left unexecuted.
fn parse_plan(raw: &V) -> Result<Option<V>, String> {
    let Ok(mut plan) = json_response(raw) else {
        return Ok(None);
    };
    if !plan["tasks"].is_array() || plan["tasks"].array().is_empty() {
        return Ok(None);
    }
    if plan["tasks"].array().len() > 5 {
        return Err("계획은 최대 5개 작업까지 실행할 수 있습니다.".into());
    }
    let mut names = HashSet::new();
    for (index, task) in plan["tasks"].array_mut().iter_mut().enumerate() {
        if !task["id"].truthy()
            || !task["description"].is_string()
            || !task["description"].truthy()
            || !task["assignee"].truthy()
        {
            return Ok(None);
        }
        let id: String = string(&task["id"])?
            .text()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .take(20)
            .collect();
        let id = if id.is_empty() {
            format!("t{}", index + 1)
        } else {
            id
        };
        if !names.insert(id.clone()) {
            return Err(format!("계획에 중복 작업 ID가 있습니다: {id}"));
        }
        task["id"] = id.into();
        if !task["deps"].truthy() {
            task["deps"] = V::Array(vec![]);
        }
        if !task["deps"].is_array() || task["deps"].array().iter().any(|v| !v.is_string()) {
            return Err("작업 의존성은 ID 배열이어야 합니다.".into());
        }
        if agent_prompt::profile(&task["assignee"].text()).is_none() {
            task["assignee"] = "dev_sawon".into();
        }
    }
    let mut visited = HashSet::new();
    loop {
        let before = visited.len();
        for task in plan["tasks"].array() {
            if task["deps"]
                .array()
                .iter()
                .all(|d| visited.contains(&d.text()))
            {
                visited.insert(task["id"].text());
            }
        }
        if visited.len() == names.len() {
            return Ok(Some(plan));
        }
        if visited.len() == before {
            return Err("계획에 순환하거나 존재하지 않는 작업 의존성이 있습니다.".into());
        }
    }
}

impl Backend for Engine<'_> {
    fn model<'a>(
        &'a self,
        request: ModelRequest,
        cancel: &'a Cancel,
        stream: Stream,
    ) -> Pending<'a, V> {
        self.backend.model(request, cancel, stream)
    }
    fn tool<'a>(&'a self, request: ToolRequest, cancel: &'a Cancel) -> Pending<'a, V> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err("중단됨".into());
            }
            match request.kind.as_str() {
                "DELEGATE" => self.delegate(&request, cancel).await,
                "CONSULT" => {
                    crate::agent_consult::execute(
                        &request.argument,
                        &request,
                        self.backend,
                        cancel,
                        &self.events,
                    )
                    .await
                }
                _ => self.backend.tool(request, cancel).await,
            }
        })
    }
}
impl Engine<'_> {
    async fn solo(&self, run: Run, profile: &V) -> Result<(), String> {
        match (self.context)(profile) {
            Ok(context) => agent_runtime::run_solo(run, context, self, self.events.clone()).await,
            Err(error) => {
                event(
                    &self.events,
                    &run.id,
                    "agent:error",
                    object([("error", error.clone().into())]),
                );
                Err(error)
            }
        }
    }
    async fn flash(&self, system: V, user: V, seconds: u64, cancel: &Cancel) -> Result<V, String> {
        let child = cancel.child();
        let timeout = Duration::from_secs(seconds);
        let request = ModelRequest {
            provider: "gemini".into(),
            model: "gemini-2.5-flash".into(),
            system,
            user,
            timeout,
        };
        let result = bounded(
            self.backend.model(request, &child, Arc::new(|_| {})),
            cancel,
            &child,
            timeout,
            "Agent model request timed out",
        )
        .await;
        if cancel.is_cancelled() {
            Err("중단됨".into())
        } else {
            result
        }
    }
    pub async fn run(&self, mut run: Run, target: &V) -> Result<(), String> {
        if run.length_warning {
            event(
                &self.events,
                &run.id,
                "agent:warning",
                object([("message", "메시지가 너무 길어서 5000자로 잘렸어영.".into())]),
            );
            run.length_warning = false;
        }
        if run.cancel.is_cancelled() {
            event(&self.events, &run.id, "agent:done", V::object());
            return Ok(());
        }
        let route = if target.truthy()
            && *target != V::from("auto")
            && agent_prompt::profile(&target.text()).is_some()
        {
            object([("mode", "solo".into()), ("agentId", target.clone())])
        } else if run.model == V::from("auto") || *target == V::from("auto") {
            event(
                &self.events,
                &run.id,
                "agent:start",
                object([
                    ("maxIterations", 0.0.into()),
                    ("agentId", V::Null),
                    ("agentName", V::Null),
                    ("agentColor", V::Null),
                ]),
            );
            match agent_routing::detect(&run.message, true, self.routing, self.backend, &run.cancel)
                .await
            {
                Ok(route) => route,
                Err(_) if run.cancel.is_cancelled() => {
                    event(&self.events, &run.id, "agent:done", V::object());
                    return Ok(());
                }
                Err(error) => {
                    event(
                        &self.events,
                        &run.id,
                        "agent:error",
                        object([("error", error.clone().into())]),
                    );
                    return Err(error);
                }
            }
        } else {
            object([
                ("mode", "solo".into()),
                (
                    "agentId",
                    if agent_prompt::profile(&run.model.text()).is_some() {
                        run.model.clone()
                    } else if run.model == V::from("pro") {
                        "dev_daeri".into()
                    } else {
                        "dev_sawon".into()
                    },
                ),
            ])
        };
        if run.cancel.is_cancelled() {
            event(&self.events, &run.id, "agent:done", V::object());
            return Ok(());
        }
        if route["escalation"].truthy() {
            let name = profile(&route["agentId"], "dev_sawon")["name"].clone();
            if let Some(last) = run.messages.last_mut() {
                if last["role"] == V::from("user") {
                    let text=template("[시스템: 사용자가 상급자를 호출해서 {{0}}인 당신이 배정되었습니다. 당신이 바로 호출된 상사입니다. \"네, 제가 왔습니다\" 식으로 자연스럽게 인사하고, 무엇을 도와드릴지 물어보세요. 절대 DELEGATE로 또 다른 상사를 찾지 마세요.]\n\n원래 메시지: {{1}}",&[name,run.message.clone()])?;
                    last["parts"] = V::Array(vec![object([("text", text)])]);
                }
            }
        }
        if route["mode"] == V::from("orchestrated") {
            self.orchestrated(run, &route["agentId"]).await
        } else {
            self.solo(run, &profile(&route["agentId"], "dev_sawon"))
                .await
        }
    }

    pub async fn sub(
        &self,
        id: &str,
        task: &V,
        profile: &V,
        dependency: &V,
        original: &V,
        cancel: &Cancel,
        options: SubOptions,
    ) -> Result<V, String> {
        let initial = (self.context)(profile)?;
        let project = options.project_context.clone().unwrap_or(initial.project);
        let max = options
            .max_iterations
            .filter(|n| *n > 0)
            .unwrap_or(profile["maxIter"].number_or(5.0) as usize);
        let dep = if dependency.truthy() {
            concat(&["\n\n## 선행 작업 결과\n".into(), dependency.clone()])
        } else {
            "".into()
        };
        let messages = vec![object([
            ("role", "user".into()),
            (
                "content",
                template(
                    "## 작업 지시\n{{0}}\n\n## 원래 사용자 요청\n{{1}}{{2}}",
                    &[task["description"].clone(), original.clone(), dep],
                )?,
            ),
        ])];
        let mut log = vec![];
        let mut response = V::from("");
        let model = profile["model"].text();
        let advanced = ["pro", "sonnet", "opus"].iter().any(|s| model.contains(s));
        let allowed = agent_prompt::agent_tools(Some(profile));
        for iteration in 0..max {
            if cancel.is_cancelled() {
                return Err("중단됨".into());
            }
            event(
                &self.events,
                id,
                "orch:sub-thinking",
                object([
                    ("taskId", task["id"].clone()),
                    ("iteration", ((iteration + 1) as f64).into()),
                    ("maxIterations", (max as f64).into()),
                    ("agentId", profile["id"].clone()),
                ]),
            );
            let context = (self.context)(profile)?;
            let system = agent_prompt::build_system_prompt(
                &V::from(if advanced { "pro" } else { "flash" }),
                Some(profile),
                &context.roots,
                &self.user_name,
                &context.platform,
            )?;
            let prompt = agent_prompt::assemble_prompt(
                &project,
                &context.team,
                &messages,
                &log,
                iteration + 1 >= max,
                &system,
            )?;
            let gemini = profile["provider"] == V::from("gemini") || !context.claude_available;
            let request = ModelRequest {
                provider: if gemini { "gemini" } else { "claude" }.into(),
                model: if gemini && profile["provider"] != V::from("gemini") {
                    "gemini-2.5-flash".into()
                } else {
                    model.clone()
                },
                system: prompt["system"].clone(),
                user: prompt["user"].clone(),
                timeout: Duration::from_secs(90),
            };
            let event_id = id.to_string();
            let task_id = task["id"].clone();
            let agent = profile["id"].clone();
            let emit = self.events.clone();
            let parent = cancel.clone();
            let stream: Stream = Arc::new(move |delta| {
                if parent.is_cancelled() {
                    return;
                }
                if let Delta::Text(text) = delta {
                    if !text.is_empty() {
                        event(
                            &emit,
                            &event_id,
                            "orch:sub-streaming",
                            object([
                                ("taskId", task_id.clone()),
                                ("delta", text.into()),
                                ("agentId", agent.clone()),
                            ]),
                        );
                    }
                }
            });
            let child = cancel.child();
            let raw = match bounded(
                self.backend.model(request, &child, stream),
                cancel,
                &child,
                Duration::from_secs(90),
                "Agent model request timed out",
            )
            .await
            {
                Err(_) if cancel.is_cancelled() => return Err("중단됨".into()),
                // A provider failure is a failed task, not a successful result.
                Err(error) => return Err(format!("{} API 에러: {error}", profile["name"].text())),
                Ok(raw) => raw,
            };
            if cancel.is_cancelled() {
                return Err("중단됨".into());
            }
            if !raw.trim().truthy() {
                if response.truthy() {
                    return Ok(response);
                }
                continue;
            }
            let parsed = agent_response::parse(&raw, &V::from(""))?;
            if parsed["toolCalls"].array().is_empty() {
                response = parsed["message"].clone();
                break;
            }
            for call in parsed["toolCalls"].array() {
                if cancel.is_cancelled() {
                    return Err("중단됨".into());
                }
                let kind = call["type"].text();
                if !allowed.contains(&kind) {
                    event(
                        &self.events,
                        id,
                        "orch:sub-tool",
                        object([
                            ("taskId", task["id"].clone()),
                            ("tool", kind.clone().into()),
                            (
                                "arg",
                                format!("[불허] {}은(는) {kind} 사용 불가", profile["name"].text())
                                    .into(),
                            ),
                            ("agentId", profile["id"].clone()),
                        ]),
                    );
                    log.push(object([
                        ("turn", (iteration as f64).into()),
                        ("tool", kind.clone().into()),
                        ("arg", call["arg"].clone()),
                        (
                            "result",
                            format!(
                                "Error: {kind} 도구 사용 불가 ({}팀)",
                                profile["team"].text()
                            )
                            .into(),
                        ),
                    ]));
                    continue;
                }
                let argument = match kind.as_str() {
                    "EDIT" => agent_response::build_edit_arg(call)?.unwrap_or(V::Null),
                    "WRITE" => agent_response::build_write_arg(call)?.unwrap_or(V::Null),
                    _ => call["arg"].clone(),
                };
                let display = if call["file"].truthy() {
                    call["file"].clone()
                } else {
                    fallback(&argument, "")
                };
                event(
                    &self.events,
                    id,
                    "orch:sub-tool",
                    object([
                        ("taskId", task["id"].clone()),
                        ("tool", kind.clone().into()),
                        ("arg", display.cut(200)),
                        ("agentId", profile["id"].clone()),
                    ]),
                );
                let child = cancel.child();
                let timeout = agent_runtime::timeout_for(&kind);
                let result = bounded(
                    self.tool(
                        ToolRequest {
                            kind: kind.clone(),
                            argument: argument.clone(),
                            conv_id: id.into(),
                            agent_id: profile["id"].text(),
                            delegate_depth: options.delegate_depth,
                            delegate_chain: options.delegate_chain.clone(),
                            sprint_mode: options.sprint_mode,
                        },
                        &child,
                    ),
                    cancel,
                    &child,
                    timeout,
                    "timeout",
                )
                .await;
                if cancel.is_cancelled() {
                    return Err("중단됨".into());
                }
                let result = match result {
                    Ok(v) if v.is_string() => v,
                    Ok(_) => return Err("Tool result must be a string".into()),
                    Err(e) => format!("Error: {e}").into(),
                }
                .cut(5000);
                event(
                    &self.events,
                    id,
                    "orch:sub-tool-result",
                    object([
                        ("taskId", task["id"].clone()),
                        ("tool", kind.clone().into()),
                        ("result", result.cut(300)),
                        ("agentId", profile["id"].clone()),
                    ]),
                );
                log.push(object([
                    ("turn", ((iteration + 1) as f64).into()),
                    ("thinking", "".into()),
                    ("tool", kind.into()),
                    ("arg", argument),
                    ("result", result),
                ]));
            }
            agent_prompt::trim_tool_log(&mut log)?;
            if parsed["isFinal"].truthy() || parsed["implicit"].truthy() {
                response = parsed["message"].clone();
                break;
            }
        }
        if response.trim().truthy() {
            Ok(response)
        } else {
            Err("최종 응답 없이 작업 반복 한도에 도달했습니다.".into())
        }
    }

    async fn delegate(&self, request: &ToolRequest, cancel: &Cancel) -> Result<V, String> {
        if request.conv_id.is_empty() {
            return Ok("Error: DELEGATE는 대화 컨텍스트가 필요합니다.".into());
        }
        let depth = request.delegate_depth.saturating_add(1);
        if depth > 3 {
            return Ok("Error: 위임 깊이 제한 초과 (최대 3단계). 직접 처리하세요.".into());
        }
        let mut team = V::Null;
        let mut target = V::Null;
        let mut description = V::from("");
        for units in request.argument.units().split(|u| *u == 10) {
            let line = V::String(units.to_vec()).trim();
            let text = line.text();
            if text.starts_with("team:") {
                team = V::String(line.units()[5..].to_vec()).trim();
            } else if text.starts_with("agent:") {
                target = V::String(line.units()[6..].to_vec()).trim();
            } else if text.starts_with("task:") {
                description = V::String(line.units()[5..].to_vec()).trim();
            } else if !description.truthy() && line.truthy() {
                description = line;
            }
        }
        if !description.truthy() {
            return Ok("Error: DELEGATE에 작업 설명(task:)이 필요합니다.".into());
        }
        let target = if let Some(p) = agent_prompt::profile(&target.text()) {
            p.clone()
        } else if team.truthy() {
            match self.routing.pick(&team,&"low".into()){Some(p)=>p,None=>return Ok(template("Error: \"{{0}}\" 팀을 찾을 수 없습니다. 가능한 팀: dev, plan, design, admin, marketing",&[team])?)}
        } else {
            return Ok(
                "Error: DELEGATE에 대상 팀(team:) 또는 에이전트(agent:)가 필요합니다.".into(),
            );
        };
        if target["id"] == V::from(request.agent_id.clone()) {
            return Ok("Error: 자기 자신에게 위임할 수 없습니다. 직접 처리하세요.".into());
        }
        if request.delegate_chain.contains(&target["id"].text()) {
            let mut chain = request.delegate_chain.clone();
            chain.push(target["id"].text());
            return Ok(format!(
                "Error: 순환 위임 감지 ({}). 직접 처리하세요.",
                chain.join("→")
            )
            .into());
        }
        let caller = agent_prompt::profile(&request.agent_id)
            .map(|p| p["name"].clone())
            .unwrap_or(request.agent_id.clone().into());
        // One ID connects start/thinking/done, including simultaneous delegations.
        let task_id = format!(
            "d-{}-{:016x}",
            crate::account_usage::now(),
            rand::random::<u64>()
        );
        event(
            &self.events,
            &request.conv_id,
            "orch:sub-start",
            object([
                ("taskId", task_id.clone().into()),
                ("taskDesc", description.clone()),
                ("agentId", target["id"].clone()),
                ("agentName", target["name"].clone()),
                ("agentColor", target["color"].clone()),
                ("delegatedBy", caller.clone()),
            ]),
        );
        let task = object([
            ("id", task_id.clone().into()),
            ("description", description.clone()),
            ("assignee", target["id"].clone()),
        ]);
        let mut chain = request.delegate_chain.clone();
        chain.push(request.agent_id.clone());
        let result = self
            .sub(
                &request.conv_id,
                &task,
                &target,
                &template("{{0}}이(가) 위임한 작업입니다.", &[caller])?,
                &description,
                cancel,
                SubOptions {
                    delegate_depth: depth,
                    delegate_chain: chain,
                    ..Default::default()
                },
            )
            .await;
        if cancel.is_cancelled() {
            return Err("중단됨".into());
        }
        match result {
            Ok(result) => {
                event(
                    &self.events,
                    &request.conv_id,
                    "orch:sub-done",
                    object([
                        ("taskId", task["id"].clone()),
                        ("agentId", target["id"].clone()),
                        ("agentName", target["name"].clone()),
                        ("result", result.cut(300)),
                    ]),
                );
                template("[{{0}} 응답]\n{{1}}", &[target["name"].clone(), result])
            }
            Err(error) => {
                event(
                    &self.events,
                    &request.conv_id,
                    "orch:sub-error",
                    object([
                        ("taskId", task_id.into()),
                        ("agentId", target["id"].clone()),
                        ("error", error.clone().into()),
                    ]),
                );
                Ok(format!("Error: {} 위임 실패 — {error}", target["name"].text()).into())
            }
        }
    }

    async fn review(
        &self,
        id: &str,
        orchestrator: &V,
        tasks: &[V],
        results: &HashMap<String, V>,
        completed: &HashSet<String>,
        cancel: &Cancel,
        state: &mut ReviewState,
    ) -> Result<(), String> {
        let done: Vec<_> = tasks
            .iter()
            .filter(|t| completed.contains(&t["id"].text()))
            .collect();
        if done.len() < 2 {
            return Ok(());
        }
        let mut input = V::from("");
        for task in done {
            let agent = profile(&task["assignee"], "dev_sawon");
            input = concat(&[
                input,
                template(
                    "\n### {{0}}: {{1}}\n담당: {{2}} ({{3}})\n결과:\n{{4}}\n",
                    &[
                        task["id"].clone(),
                        task["description"].clone(),
                        agent["name"].clone(),
                        agent["rank"].clone(),
                        results
                            .get(&task["id"].text())
                            .cloned()
                            .unwrap_or("".into())
                            .cut(1500),
                    ],
                )?,
            ]);
        }
        let prompt=template("너는 품질 검토관이야. 아래 팀원들의 작업 결과를 검토해.\n\n{{0}}\n\n아래 관점에서 평가:\n1. 결과 간 모순이 있는가? (A는 X라 하고 B는 Y라 하는 경우)\n2. 명백한 오류나 누락이 있는가?\n3. 품질이 기준 이하인 결과가 있는가?\n\n반드시 아래 JSON으로만 답변:\n{\n  \"has_issues\": true|false,\n  \"conflicts\": [{\"task_a\":\"t1\",\"task_b\":\"t2\",\"description\":\"모순 설명\"}],\n  \"rejections\": [{\"task_id\":\"t1\",\"reason\":\"이유\",\"feedback\":\"이렇게 수정해야 함\"}],\n  \"approved\": [\"t1\",\"t2\"]\n}\n\n문제없으면 has_issues:false, conflicts:[], rejections:[], approved:[모든 task id].",&[input])?;
        let raw = self
            .flash("JSON만 출력.".into(), prompt, 15, cancel)
            .await?;
        let review = json_response(&raw)?;
        if !matches!(review, V::Object(_)) {
            return Ok(());
        }
        if !review["has_issues"].truthy() {
            event(
                &self.events,
                id,
                "orch:review",
                object([
                    ("outcome", "approved".into()),
                    ("agentId", orchestrator["id"].clone()),
                ]),
            );
            return Ok(());
        }
        state.issues_found = true;
        event(
            &self.events,
            id,
            "orch:review",
            object([
                ("outcome", "issues_found".into()),
                (
                    "conflicts",
                    if review["conflicts"].truthy() {
                        review["conflicts"].clone()
                    } else {
                        V::Array(vec![])
                    },
                ),
                (
                    "rejections",
                    if review["rejections"].truthy() {
                        review["rejections"].clone()
                    } else {
                        V::Array(vec![])
                    },
                ),
                ("agentId", orchestrator["id"].clone()),
                ("agentName", orchestrator["name"].clone()),
            ]),
        );
        for conflict in review["conflicts"].array().iter().take(25) {
            if cancel.is_cancelled() {
                return Err("중단됨".into());
            }
            let Some(a) = tasks.iter().find(|t| t["id"] == conflict["task_a"]) else {
                continue;
            };
            let Some(b) = tasks.iter().find(|t| t["id"] == conflict["task_b"]) else {
                continue;
            };
            let aa = profile(&a["assignee"], "dev_sawon");
            let ba = profile(&b["assignee"], "dev_sawon");
            let ar = results.get(&a["id"].text()).cloned().unwrap_or("".into());
            let br = results.get(&b["id"].text()).cloned().unwrap_or("".into());
            event(
                &self.events,
                id,
                "consult:start",
                object([
                    ("callerId", a["assignee"].clone()),
                    ("callerName", aa["name"].clone()),
                    ("targetId", b["assignee"].clone()),
                    ("targetName", ba["name"].clone()),
                    ("topic", conflict["description"].clone()),
                    ("callerView", ar.cut(300)),
                ]),
            );
            let prompt=template("두 작업의 결과가 모순됨:\n\n{{0}}({{1}}): {{2}}\n\n{{3}}({{4}}): {{5}}\n\n모순: {{6}}\n\n어느 쪽이 맞는지, 또는 어떻게 통합할지 판단해.\nJSON: {\"winner\":\"task_a|task_b|merge\",\"reasoning\":\"판단근거\",\"merged_result\":\"통합결과(merge일때만)\"}",&[aa["name"].clone(),aa["rank"].clone(),ar.cut(800),ba["name"].clone(),ba["rank"].clone(),br.cut(800),property_string(conflict,"description")?])?;
            let resolved = self
                .flash("JSON만 출력.".into(), prompt, 15, cancel)
                .await
                .and_then(|raw| json_response(&raw));
            if cancel.is_cancelled() {
                return Err("중단됨".into());
            }
            match resolved {
                Ok(resolved) if matches!(resolved, V::Object(_)) => {
                    if resolved["winner"] == V::from("merge") && resolved["merged_result"].truthy()
                    {
                        state
                            .revised
                            .insert(a["id"].text(), resolved["merged_result"].clone());
                        state
                            .revised
                            .insert(b["id"].text(), resolved["merged_result"].clone());
                    } else if resolved["winner"] == V::from("task_b") {
                        state.revised.insert(
                            a["id"].text(),
                            template(
                                "{{0}}\n[충돌 해소: {{1}} 의견 채택 — {{2}}]",
                                &[
                                    br,
                                    ba["name"].clone(),
                                    property_string(&resolved, "reasoning")?,
                                ],
                            )?,
                        );
                    } else {
                        state.revised.insert(
                            b["id"].text(),
                            template(
                                "{{0}}\n[충돌 해소: {{1}} 의견 채택 — {{2}}]",
                                &[
                                    ar,
                                    aa["name"].clone(),
                                    property_string(&resolved, "reasoning")?,
                                ],
                            )?,
                        );
                    }
                    let mut event_data = object([
                        (
                            "outcome",
                            if resolved["winner"] == V::from("merge") {
                                "compromised".into()
                            } else {
                                "superior_judged".into()
                            },
                        ),
                        ("decidedBy", orchestrator["name"].clone()),
                    ]);
                    if resolved.has("reasoning") {
                        event_data["result"] = resolved["reasoning"].clone();
                    }
                    event(&self.events, id, "consult:resolved", event_data);
                }
                _ => {
                    if agent_routing::get_rank_level(&aa["id"].text())
                        >= agent_routing::get_rank_level(&ba["id"].text())
                    {
                        state.revised.insert(b["id"].text(), ar);
                    } else {
                        state.revised.insert(a["id"].text(), br);
                    }
                }
            }
        }
        let mut retried = HashSet::new();
        for rejection in review["rejections"].array() {
            if cancel.is_cancelled() {
                return Err("중단됨".into());
            }
            let Some(task) = tasks.iter().find(|t| t["id"] == rejection["task_id"]) else {
                continue;
            };
            if !retried.insert(task["id"].text()) {
                continue;
            }
            if !completed.contains(&task["id"].text()) {
                continue;
            }
            let assignee = profile(&task["assignee"], "dev_sawon");
            let retry_id = format!("{}-retry", task["id"].text());
            state.rerun.insert(task["id"].text());
            state
                .failed
                .insert(task["id"].text(), "재검토에서 거절된 결과입니다.".into());
            state.active_retry = Some((retry_id.clone(), assignee["id"].clone()));
            event(
                &self.events,
                id,
                "orch:sub-start",
                object([
                    ("taskId", retry_id.clone().into()),
                    (
                        "description",
                        template("[리뷰 피드백] {{0}}", &[task["description"].clone()])?,
                    ),
                    ("agentId", assignee["id"].clone()),
                    ("agentName", assignee["name"].clone()),
                    ("agentColor", assignee["color"].clone()),
                ]),
            );
            let retry_task=object([("id",retry_id.clone().into()),("description",template("{{0}}\n\n[이전 결과 리뷰 피드백]\n거절 사유: {{1}}\n수정 지시: {{2}}\n\n이전 결과:\n{{3}}",&[task["description"].clone(),property_string(rejection,"reason")?,property_string(rejection,"feedback")?,results.get(&task["id"].text()).cloned().unwrap_or("".into()).cut(1500)])?),("assignee",task["assignee"].clone())]);
            let result = self
                .sub(
                    id,
                    &retry_task,
                    &assignee,
                    &"".into(),
                    &task["description"],
                    cancel,
                    SubOptions::default(),
                )
                .await;
            let result = if cancel.is_cancelled() {
                Err("중단됨".into())
            } else {
                result
            };
            if let Ok(result) = result {
                event(
                    &self.events,
                    id,
                    "orch:sub-done",
                    object([
                        ("taskId", retry_id.into()),
                        ("result", result.cut(500)),
                        ("agentId", assignee["id"].clone()),
                        ("agentName", assignee["name"].clone()),
                    ]),
                );
                state.revised.insert(task["id"].text(), result);
                state.failed.remove(&task["id"].text());
            } else if let Err(error) = result {
                state
                    .failed
                    .insert(task["id"].text(), format!("재검토 후 재실행 실패: {error}"));
                event(
                    &self.events,
                    id,
                    "orch:sub-error",
                    object([
                        ("taskId", retry_id.into()),
                        ("agentId", assignee["id"].clone()),
                        ("error", error.into()),
                        ("retrying", false.into()),
                    ]),
                );
            }
            state.active_retry = None;
            if cancel.is_cancelled() {
                return Err("중단됨".into());
            }
        }
        Ok(())
    }

    async fn perform_task(
        &self,
        id: &str,
        task: &V,
        dependency: V,
        original: &V,
        cancel: &Cancel,
    ) -> Result<V, String> {
        let assignee = profile(&task["assignee"], "sawon");
        event(
            &self.events,
            id,
            "orch:sub-start",
            object([
                ("taskId", task["id"].clone()),
                ("description", task["description"].clone()),
                ("agentId", assignee["id"].clone()),
                ("agentName", assignee["name"].clone()),
                ("agentColor", assignee["color"].clone()),
            ]),
        );
        let first = self
            .sub(
                id,
                task,
                &assignee,
                &dependency,
                original,
                cancel,
                SubOptions::default(),
            )
            .await;
        if cancel.is_cancelled() {
            return Err("중단됨".into());
        }
        let (result, who) = match first {
            Ok(result) => (Ok(result), assignee.clone()),
            Err(error) => {
                let escalated = agent_routing::escalate_agent(&assignee["id"].text());
                event(
                    &self.events,
                    id,
                    "orch:sub-error",
                    object([
                        ("taskId", task["id"].clone()),
                        ("error", error.into()),
                        ("agentId", assignee["id"].clone()),
                        ("retrying", true.into()),
                        ("escalatedTo", escalated["name"].clone()),
                    ]),
                );
                (
                    self.sub(
                        id,
                        task,
                        &escalated,
                        &dependency,
                        original,
                        cancel,
                        SubOptions::default(),
                    )
                    .await,
                    escalated,
                )
            }
        };
        if cancel.is_cancelled() {
            return Err("중단됨".into());
        }
        match &result {
            Ok(result) => event(
                &self.events,
                id,
                "orch:sub-done",
                object([
                    ("taskId", task["id"].clone()),
                    ("result", result.cut(500)),
                    ("agentId", who["id"].clone()),
                    ("agentName", who["name"].clone()),
                ]),
            ),
            Err(error) => event(
                &self.events,
                id,
                "orch:sub-error",
                object([
                    ("taskId", task["id"].clone()),
                    ("error", error.clone().into()),
                    ("agentId", assignee["id"].clone()),
                    ("retrying", false.into()),
                ]),
            ),
        }
        result
    }

    async fn orchestrated_body(&self, run: &Run, orchestrator: &V) -> Result<Option<V>, String> {
        let context = (self.context)(orchestrator)?;
        let raw = self
            .flash(
                plan_system(orchestrator)?,
                plan_prompt(&run.message, &context.project)?,
                30,
                &run.cancel,
            )
            .await?;
        if run.cancel.is_cancelled() {
            return Err("중단됨".into());
        }
        let Some(plan) = parse_plan(&raw)? else {
            return Ok(None);
        };
        let tasks = plan["tasks"].array();
        event(
            &self.events,
            &run.id,
            "orch:plan",
            object([
                ("plan", plan["tasks"].clone()),
                (
                    "delegationMessage",
                    fallback(&plan["delegation_message"], "작업 분배한다."),
                ),
                ("agentId", orchestrator["id"].clone()),
                ("agentName", orchestrator["name"].clone()),
                ("agentColor", orchestrator["color"].clone()),
            ]),
        );
        let mut results: HashMap<String, V> = HashMap::new();
        let mut completed = HashSet::new();
        let mut failed = HashSet::new();
        while completed.len() + failed.len() < tasks.len() {
            if run.cancel.is_cancelled() {
                return Err("중단됨".into());
            }
            let runnable: Vec<_> = tasks
                .iter()
                .filter(|t| {
                    !completed.contains(&t["id"].text())
                        && !failed.contains(&t["id"].text())
                        && t["deps"]
                            .array()
                            .iter()
                            .all(|d| completed.contains(&d.text()))
                })
                .collect();
            if runnable.is_empty() {
                for task in tasks
                    .iter()
                    .filter(|t| {
                        !completed.contains(&t["id"].text()) && !failed.contains(&t["id"].text())
                    })
                    .collect::<Vec<_>>()
                {
                    let message = "선행 작업 실패로 실행하지 못했습니다.";
                    results.insert(task["id"].text(), format!("Error: {message}").into());
                    failed.insert(task["id"].text());
                    event(
                        &self.events,
                        &run.id,
                        "orch:sub-error",
                        object([
                            ("taskId", task["id"].clone()),
                            ("error", message.into()),
                            ("agentId", task["assignee"].clone()),
                            ("retrying", false.into()),
                        ]),
                    );
                }
                break;
            }
            let mut pending = FuturesUnordered::new();
            for task in runnable {
                let mut parts = vec![];
                for dependency in task["deps"].array() {
                    if let Some(result) = results.get(&dependency.text()).filter(|v| v.truthy()) {
                        if !parts.is_empty() {
                            parts.push("\n".into());
                        }
                        parts.push(template(
                            "[{{0}} 결과]: {{1}}",
                            &[dependency.clone(), result.cut(2000)],
                        )?);
                    }
                }
                let dependency = concat(&parts);
                let id = &run.id;
                let original = &run.message;
                let cancel = &run.cancel;
                pending.push(async move {
                    (
                        task["id"].text(),
                        self.perform_task(id, task, dependency, original, cancel)
                            .await,
                    )
                });
            }
            while let Some((id, result)) = pending.next().await {
                if run.cancel.is_cancelled() {
                    return Err("중단됨".into());
                }
                match result {
                    Ok(value) => {
                        results.insert(id.clone(), value);
                        completed.insert(id);
                    }
                    Err(error) => {
                        results.insert(id.clone(), format!("Error: {error}").into());
                        failed.insert(id);
                    }
                }
            }
        }
        if completed.len() >= 2 {
            let child = run.cancel.child();
            // Keep review state outside the timed future so a timeout cannot
            // restore results that the reviewer has already rejected.
            let mut review_state = ReviewState::default();
            let review = bounded(
                Box::pin(self.review(
                    &run.id,
                    orchestrator,
                    tasks,
                    &results,
                    &completed,
                    &child,
                    &mut review_state,
                )),
                &run.cancel,
                &child,
                Duration::from_secs(180),
                "Review timed out",
            )
            .await;
            if let Some((task_id, agent_id)) = review_state.active_retry.take() {
                event(
                    &self.events,
                    &run.id,
                    "orch:sub-error",
                    object([
                        ("taskId", task_id.into()),
                        ("agentId", agent_id),
                        ("error", "재검토 작업이 중단되었습니다.".into()),
                        ("retrying", false.into()),
                    ]),
                );
            }
            if run.cancel.is_cancelled() {
                return Err("중단됨".into());
            }
            if let Err(error) = review {
                if review_state.issues_found {
                    for id in &completed {
                        review_state
                            .failed
                            .entry(id.clone())
                            .or_insert_with(|| format!("재검토를 완료하지 못했습니다: {error}"));
                    }
                }
            }
            // A retry may change files while returning the same summary text.
            let mut changed = review_state.rerun;
            for (id, result) in review_state.revised {
                if results.get(&id) != Some(&result) {
                    changed.insert(id.clone());
                }
                results.insert(id, result);
            }
            changed.extend(review_state.failed.keys().cloned());
            // Downstream results used the old inputs. Do not replay their tools
            // automatically; preserve the result with an explicit recheck status.
            loop {
                let before = changed.len();
                for task in tasks {
                    if completed.contains(&task["id"].text())
                        && task["deps"]
                            .array()
                            .iter()
                            .any(|d| changed.contains(&d.text()))
                    {
                        changed.insert(task["id"].text());
                        review_state
                            .failed
                            .entry(task["id"].text())
                            .or_insert_with(|| {
                                "선행 작업의 결과가 바뀌어 재검증이 필요합니다.".into()
                            });
                    }
                }
                if changed.len() == before {
                    break;
                }
            }
            for task in tasks {
                let id = task["id"].text();
                let Some(error) = review_state.failed.remove(&id) else {
                    continue;
                };
                completed.remove(&id);
                failed.insert(id.clone());
                let previous = results.remove(&id).unwrap_or("".into());
                results.insert(
                    id,
                    concat(&[
                        format!("Error: {error}\n[이전 결과 — 재검증 필요]\n").into(),
                        previous,
                    ]),
                );
                event(
                    &self.events,
                    &run.id,
                    "orch:sub-error",
                    object([
                        ("taskId", task["id"].clone()),
                        ("agentId", task["assignee"].clone()),
                        ("error", error.into()),
                        ("retrying", false.into()),
                    ]),
                );
            }
        }
        event(
            &self.events,
            &run.id,
            "orch:synthesizing",
            object([
                ("agentId", orchestrator["id"].clone()),
                ("agentName", orchestrator["name"].clone()),
            ]),
        );
        let persona = if orchestrator["rank"] == V::from("Director") {
            template("너는 {{0}}이야. 전사 오케스트레이터로서 각 팀 결과를 종합 보고한다.\n전략적 시각으로 핵심 인사이트를 뽑고, 후속 조치(action items)도 제안해.\n대표(사용자)에게 존댓말. 마크다운 사용. JSON 아닌 자연어로 답변.",&[orchestrator["name"].clone()])?
        } else {
            template("너는 {{0}}이야. 팀원들의 작업 결과를 종합해서 사용자에게 최종 보고해.\n직설적이고 간결하게, 핵심 위주. 마크다운 사용 가능. JSON 아닌 자연어로 답변.",&[orchestrator["name"].clone()])?
        };
        let content = self
            .flash(
                persona,
                synthesis_prompt(&run.message, tasks, &results)?,
                30,
                &run.cancel,
            )
            .await?;
        if run.cancel.is_cancelled() {
            return Err("중단됨".into());
        }
        let mut content = fallback(&content, "(종합 결과 없음)");
        if !failed.is_empty() {
            let failed_ids = tasks
                .iter()
                .filter(|t| failed.contains(&t["id"].text()))
                .map(|t| t["id"].text())
                .collect::<Vec<_>>();
            content = concat(&[
                format!("[미완료 작업: {}]\n\n", failed_ids.join(", ")).into(),
                content,
            ]);
        }
        Ok(Some(content))
    }

    pub async fn orchestrated(&self, mut run: Run, orchestrator_id: &V) -> Result<(), String> {
        let orchestrator = profile(orchestrator_id, "dev_bujang");
        event(
            &self.events,
            &run.id,
            "orch:start",
            object([
                ("agentId", orchestrator["id"].clone()),
                ("agentName", orchestrator["name"].clone()),
                ("agentColor", orchestrator["color"].clone()),
            ]),
        );
        let result = self.orchestrated_body(&run, &orchestrator).await;
        if run.cancel.is_cancelled() {
            run.messages.push(object([
                ("role", "assistant".into()),
                ("content", "(오케스트레이션이 중단되었어영)".into()),
                ("ts", (crate::account_usage::now() as f64).into()),
                ("agentId", orchestrator["id"].clone()),
            ]));
            match run.commit() {
                Ok(true) => event(&self.events, &run.id, "orch:done", V::object()),
                Ok(false) => {}
                Err(error) => {
                    event(
                        &self.events,
                        &run.id,
                        "agent:error",
                        object([("error", error.clone().into())]),
                    );
                    return Err(error);
                }
            }
            return Ok(());
        }
        match result {
            Ok(None) => {
                self.solo(run, agent_prompt::profile("dev_bujang").unwrap())
                    .await
            }
            Ok(Some(content)) => {
                run.messages.push(object([
                    ("role", "assistant".into()),
                    ("content", content.clone()),
                    ("ts", (crate::account_usage::now() as f64).into()),
                    ("agentId", orchestrator["id"].clone()),
                ]));
                match run.commit() {
                    Ok(true) => {
                        event(
                            &self.events,
                            &run.id,
                            "orch:response",
                            object([
                                ("content", content),
                                ("agentId", orchestrator["id"].clone()),
                                ("agentName", orchestrator["name"].clone()),
                                ("agentColor", orchestrator["color"].clone()),
                            ]),
                        );
                        event(
                            &self.events,
                            &run.id,
                            "orch:done",
                            object([("agentId", orchestrator["id"].clone())]),
                        );
                        Ok(())
                    }
                    Ok(false) => Ok(()),
                    Err(error) => {
                        event(
                            &self.events,
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
                    &self.events,
                    &run.id,
                    "agent:error",
                    object([("error", format!("오케스트레이션 실패: {error}").into())]),
                );
                run.messages.push(object([
                    ("role", "assistant".into()),
                    (
                        "content",
                        format!("오케스트레이션 중 에러가 났어영.. {error}").into(),
                    ),
                    ("ts", (crate::account_usage::now() as f64).into()),
                    ("agentId", orchestrator["id"].clone()),
                ]));
                if let Err(save) = run.commit() {
                    event(
                        &self.events,
                        &run.id,
                        "agent:error",
                        object([("error", save.clone().into())]),
                    );
                    return Err(save);
                }
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::{BTreeMap, VecDeque},
        fs,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex,
        },
    };
    fn parse(text: &str) -> V {
        data(text).unwrap()
    }
    fn digest(value: &V) -> V {
        let bytes: Vec<_> = value.units().iter().flat_map(|u| u.to_le_bytes()).collect();
        let hash = ring::digest::digest(&ring::digest::SHA256, &bytes)
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        object([
            ("length", (value.units().len() as f64).into()),
            ("hash", hash.into()),
        ])
    }
    struct Script {
        responses: Mutex<VecDeque<V>>,
        results: Mutex<VecDeque<V>>,
        calls: Mutex<Vec<V>>,
        requests: Mutex<Vec<V>>,
    }
    impl Script {
        fn new(input: &V) -> Self {
            Self {
                responses: Mutex::new(input["responses"].array().iter().cloned().collect()),
                results: Mutex::new(input["results"].array().iter().cloned().collect()),
                calls: Mutex::new(vec![]),
                requests: Mutex::new(vec![]),
            }
        }
    }
    impl Backend for Script {
        fn model<'a>(
            &'a self,
            request: ModelRequest,
            _: &'a Cancel,
            stream: Stream,
        ) -> Pending<'a, V> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(object([
                    ("model", request.model.into()),
                    ("timeout", (request.timeout.as_millis() as f64).into()),
                    ("system", digest(&request.system)),
                    ("user", digest(&request.user)),
                ]));
                let response = self
                    .responses
                    .lock()
                    .unwrap()
                    .pop_front()
                    .ok_or("Fixture provider exhausted")?;
                if response.has("error") {
                    return Err(response["error"].text());
                }
                stream(Delta::Text(response.text()));
                tokio::task::yield_now().await;
                Ok(response)
            })
        }
        fn tool<'a>(&'a self, request: ToolRequest, _: &'a Cancel) -> Pending<'a, V> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(object([
                    ("kind", request.kind.into()),
                    ("argument", request.argument),
                    ("convId", request.conv_id.into()),
                    ("agentId", request.agent_id.into()),
                ]));
                let result = self
                    .results
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or("ok".into());
                tokio::task::yield_now().await;
                if result.has("error") {
                    Err(result["error"].text())
                } else {
                    Ok(result)
                }
            })
        }
    }
    fn context(profile: &V, teams: &V) -> Result<SoloContext, String> {
        Ok(SoloContext {
            profile: profile.clone(),
            roots: vec![],
            project: "".into(),
            team: fallback(&teams[&profile["team"].text()], ""),
            platform: "linux".into(),
            claude_available: false,
        })
    }
    fn grouped(events: &[V]) -> BTreeMap<String, Vec<V>> {
        let mut groups = BTreeMap::new();
        for event in events {
            let task = if event["data"].has("taskId") {
                event["data"]["taskId"].text()
            } else {
                "<global>".into()
            };
            groups
                .entry(task)
                .or_insert_with(Vec::new)
                .push(event.clone());
        }
        groups
    }
    fn task(id: &str, deps: Vec<V>) -> V {
        object([
            ("id", id.into()),
            ("description", format!("작업 {id}").into()),
            ("assignee", "dev_sawon".into()),
            ("deps", V::Array(deps)),
        ])
    }
    fn plan(tasks: Vec<V>) -> V {
        V::from(object([("tasks", V::Array(tasks))]).raw().get())
    }
    async fn recorded_run(responses: Vec<V>) -> (V, Vec<V>, usize) {
        let backend = Script::new(&object([("responses", V::Array(responses))]));
        let routing = agent_routing::State::default();
        let build = |p: &V| context(p, &V::Null);
        let records = Arc::new(Mutex::new(vec![]));
        let sink = records.clone();
        let engine = Engine {
            backend: &backend,
            context: &build,
            routing: &routing,
            user_name: "".into(),
            events: Arc::new(move |name, data| {
                sink.lock()
                    .unwrap()
                    .push(object([("name", name.into()), ("data", data)]))
            }),
        };
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::agent::Store::new(directory.path().into()));
        let run = store
            .begin("fixture".into(), &"work".into(), None, true)
            .unwrap();
        engine.orchestrated(run, &"daepyo".into()).await.unwrap();
        let history =
            parse(&fs::read_to_string(directory.path().join("agent-history.json")).unwrap());
        let content = history["fixture"]["messages"].array().last().unwrap()["content"].clone();
        let events = records.lock().unwrap().clone();
        let calls = backend.calls.lock().unwrap().len();
        (content, events, calls)
    }

    #[tokio::test]
    async fn rejected_results_and_changed_dependencies_remain_incomplete() {
        for failed_retry in [false, true] {
            let (content, events, calls) = recorded_run(vec![
                plan(vec![task("a", vec![]), task("b", vec!["a".into()]), task("c", vec!["b".into()])]),
                "old A".into(), "old B".into(), "old C".into(),
                r#"{"has_issues":true,"rejections":[{"task_id":"a","reason":"wrong","feedback":"fix"}]}"#.into(),
                if failed_retry { object([("error", "retry unavailable".into())]) } else { "new A".into() },
                "complete".into(),
            ]).await;
            let missing = if failed_retry { "a, b, c" } else { "b, c" };
            assert_eq!(
                content,
                V::from(format!("[미완료 작업: {missing}]\n\ncomplete"))
            );
            assert_eq!(
                calls, 7,
                "downstream mutations must not be replayed automatically"
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|e| e["data"]["taskId"] == V::from("a-retry")
                        && e["name"]
                            == V::from(if failed_retry {
                                "orch:sub-error"
                            } else {
                                "orch:sub-done"
                            }))
                    .count(),
                1
            );
            for id in missing.split(", ") {
                assert!(events.iter().any(|e| e["name"] == V::from("orch:sub-error")
                    && e["data"]["taskId"] == V::from(id)
                    && e["data"]["retrying"] == V::Bool(false)));
            }
        }
        for revised in ["old A", "new A"] {
            let (content, _, _) = recorded_run(vec![
                plan(vec![task("a", vec![]), task("b", vec!["a".into()])]),
                "old A".into(), "old B".into(),
                r#"{"has_issues":true,"conflicts":[{"task_a":"a","task_b":"b","description":"mismatch"}]}"#.into(),
                V::from(object([("winner", "merge".into()), ("merged_result", revised.into()), ("reasoning", "fixed".into())]).raw().get()),
                "complete".into(),
            ]).await;
            assert_eq!(
                content,
                V::from(if revised == "old A" {
                    "complete"
                } else {
                    "[미완료 작업: b]\n\ncomplete"
                })
            );
        }
    }

    #[tokio::test]
    async fn retry_with_same_summary_still_invalidates_consumers_of_previous_files() {
        let (content, events, calls) = recorded_run(vec![
            plan(vec![task("a", vec![]), task("b", vec!["a".into()])]),
            "done".into(), "used previous file".into(),
            r#"{"has_issues":true,"rejections":[{"task_id":"a","reason":"wrong file","feedback":"rewrite"}]}"#.into(),
            r#"{"thinking":"fix","message":"writing","tool_calls":[{"tool":"WRITE","file":"a.txt","content":"changed"}],"is_final":false}"#.into(),
            "done".into(), "complete".into(),
        ]).await;
        assert_eq!(content, V::from("[미완료 작업: b]\n\ncomplete"));
        assert_eq!(calls, 7);
        assert!(events
            .iter()
            .any(|e| e["name"] == V::from("orch:sub-tool-result")
                && e["data"]["tool"] == V::from("WRITE")
                && e["data"]["result"] == V::from("ok")));
        assert!(events.iter().any(|e| e["name"] == V::from("orch:sub-done")
            && e["data"]["taskId"] == V::from("a-retry")
            && e["data"]["result"] == V::from("done")));
        assert!(
            events
                .iter()
                .any(|e| e["name"] == V::from("orch:sub-error")
                    && e["data"]["taskId"] == V::from("b"))
        );
    }

    #[tokio::test]
    async fn empty_or_tool_only_exhaustion_never_unlocks_dependents() {
        let profile = agent_prompt::profile("dev_sawon").unwrap();
        let escalated = agent_routing::escalate_agent("dev_sawon");
        let attempts =
            (profile["maxIter"].number_or(5.0) + escalated["maxIter"].number_or(5.0)) as usize;
        for response in [
            V::from(""),
            V::from(
                r#"{"thinking":"plan","message":"reading","tool_calls":[{"tool":"READ","argument":"small.md"}],"is_final":false}"#,
            ),
        ] {
            let mut responses = vec![plan(vec![task("a", vec![]), task("b", vec!["a".into()])])];
            responses.extend(std::iter::repeat_n(response, attempts));
            responses.push("complete".into());
            let (content, events, calls) = recorded_run(responses).await;
            assert_eq!(content, V::from("[미완료 작업: a, b]\n\ncomplete"));
            assert_eq!(calls, attempts + 2);
            assert!(!events.iter().any(|e| e["name"] == V::from("orch:sub-done")));
            assert!(!events
                .iter()
                .any(|e| e["name"] == V::from("orch:sub-start")
                    && e["data"]["taskId"] == V::from("b")));
        }
    }

    #[tokio::test]
    async fn parallel_failed_delegations_have_distinct_matching_lifecycle_ids() {
        let backend = Script::new(&object([(
            "responses",
            V::Array(vec![
                object([("error", "first failure".into())]),
                object([("error", "second failure".into())]),
            ]),
        )]));
        let routing = agent_routing::State::default();
        let build = |p: &V| context(p, &V::Null);
        let records = Arc::new(Mutex::new(vec![]));
        let sink = records.clone();
        let engine = Engine {
            backend: &backend,
            context: &build,
            routing: &routing,
            user_name: "".into(),
            events: Arc::new(move |name, data| {
                sink.lock()
                    .unwrap()
                    .push(object([("name", name.into()), ("data", data)]))
            }),
        };
        let request = || ToolRequest {
            kind: "DELEGATE".into(),
            argument: "agent:plan_sawon\ntask:work".into(),
            conv_id: "fixture".into(),
            agent_id: "dev_sawon".into(),
            delegate_depth: 0,
            delegate_chain: vec![],
            sprint_mode: false,
        };
        let cancel = Cancel::default();
        let (a, b) = tokio::join!(
            engine.tool(request(), &cancel),
            engine.tool(request(), &cancel)
        );
        assert!(a.unwrap().text().contains("위임 실패"));
        assert!(b.unwrap().text().contains("위임 실패"));
        let events = records.lock().unwrap();
        let starts: HashSet<_> = events
            .iter()
            .filter(|e| e["name"] == V::from("orch:sub-start"))
            .map(|e| e["data"]["taskId"].text())
            .collect();
        let ends: HashSet<_> = events
            .iter()
            .filter(|e| e["name"] == V::from("orch:sub-error"))
            .map(|e| e["data"]["taskId"].text())
            .collect();
        assert_eq!(starts.len(), 2);
        assert_eq!(starts, ends);
    }

    #[tokio::test]
    async fn timed_out_review_keeps_rejection_and_closes_its_retry() {
        struct ReviewBackend(AtomicUsize);
        impl Backend for ReviewBackend {
            fn model<'a>(
                &'a self,
                _: ModelRequest,
                cancel: &'a Cancel,
                _: Stream,
            ) -> Pending<'a, V> {
                Box::pin(async move {
                    if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                        Ok(r#"{"has_issues":true,"rejections":[{"task_id":"a","reason":"wrong","feedback":"fix"}]}"#.into())
                    } else {
                        cancel.cancelled().await;
                        Err("cancelled provider".into())
                    }
                })
            }
            fn tool<'a>(&'a self, _: ToolRequest, _: &'a Cancel) -> Pending<'a, V> {
                Box::pin(async { panic!("No tool is expected") })
            }
        }
        let backend = ReviewBackend(AtomicUsize::new(0));
        let routing = agent_routing::State::default();
        let build = |p: &V| context(p, &V::Null);
        let records = Arc::new(Mutex::new(vec![]));
        let sink = records.clone();
        let engine = Engine {
            backend: &backend,
            context: &build,
            routing: &routing,
            user_name: "".into(),
            events: Arc::new(move |name, data| {
                sink.lock()
                    .unwrap()
                    .push(object([("name", name.into()), ("data", data)]))
            }),
        };
        let parent = Cancel::default();
        let child = parent.child();
        let mut state = ReviewState::default();
        let tasks = vec![task("a", vec![]), task("b", vec!["a".into()])];
        let results = HashMap::from([("a".into(), "old A".into()), ("b".into(), "old B".into())]);
        let completed = HashSet::from(["a".into(), "b".into()]);
        let review = bounded(
            Box::pin(engine.review(
                "fixture",
                agent_prompt::profile("daepyo").unwrap(),
                &tasks,
                &results,
                &completed,
                &child,
                &mut state,
            )),
            &parent,
            &child,
            Duration::from_millis(20),
            "Review timed out",
        )
        .await;
        assert_eq!(review, Err("Review timed out".into()));
        assert!(!parent.is_cancelled());
        assert!(child.is_cancelled());
        assert!(state.issues_found);
        assert!(state.failed.contains_key("a"));
        assert!(state.revised.is_empty());
        assert!(state.active_retry.is_none());
        let events = records.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| e["data"]["taskId"] == V::from("a-retry")
                    && e["name"] == V::from("orch:sub-error"))
                .count(),
            1
        );
        assert!(!events.iter().any(|e| e["name"] == V::from("orch:sub-done")));
    }
    #[tokio::test]
    async fn original_orchestration_and_subagent_reference_cases() {
        let fixtures = parse(include_str!(
            "../../tests/fixtures/rust-agent-orchestration.json"
        ));
        assert_eq!(fixtures.array().len(), 22);
        for fixture in fixtures.array() {
            let input = &fixture["input"];
            let name = input["name"].text();
            let backend = Script::new(input);
            let state = agent_routing::State::default();
            let events = Arc::new(Mutex::new(vec![]));
            let seen = events.clone();
            let emit: Events = Arc::new(move |name, data| {
                seen.lock()
                    .unwrap()
                    .push(object([("name", name.into()), ("data", data)]))
            });
            let build = |p: &V| context(p, &input["teams"]);
            let engine = Engine {
                backend: &backend,
                context: &build,
                events: emit,
                routing: &state,
                user_name: "".into(),
            };
            let message = fallback(&input["message"], "전체 작업");
            if input["kind"] == V::from("sub") {
                let agent = profile(&fallback(&input["agent"], "dev_sawon"), "dev_sawon");
                let mut subtask = task("sub", vec![]);
                subtask["assignee"] = agent["id"].clone();
                let result = engine
                    .sub(
                        "fixture",
                        &subtask,
                        &agent,
                        &"앞선 결과".into(),
                        &message,
                        &Cancel::default(),
                        SubOptions {
                            max_iterations: if input.has("maxIter") {
                                Some(input["maxIter"].number() as usize)
                            } else {
                                None
                            },
                            ..Default::default()
                        },
                    )
                    .await;
                if name == "sub-limit" {
                    // The original source returns a success placeholder after
                    // exhausting its tools. Native execution must fail instead.
                    assert_eq!(
                        result,
                        Err("최종 응답 없이 작업 반복 한도에 도달했습니다.".into())
                    );
                } else {
                    assert_eq!(
                        result.unwrap(),
                        fixture["expected"]["result"],
                        "result {name}"
                    );
                }
            } else {
                let directory = tempfile::tempdir().unwrap();
                let store = Arc::new(crate::agent::Store::new(directory.path().into()));
                let run = store.begin("fixture".into(), &message, None, true).unwrap();
                let _ = engine
                    .orchestrated(run, &fallback(&input["orchestrator"], "daepyo"))
                    .await;
                assert!(!store.is_running("fixture"));
                let history = parse(
                    &fs::read_to_string(directory.path().join("agent-history.json")).unwrap(),
                );
                let mut messages = history["fixture"]["messages"].clone();
                for m in messages.array_mut() {
                    m["ts"] = 123456.0.into();
                }
                assert_eq!(messages, fixture["expected"]["messages"], "messages {name}");
            }
            assert_eq!(
                grouped(&events.lock().unwrap()),
                grouped(fixture["expected"]["events"].array()),
                "events {name}"
            );
            assert_eq!(
                V::Array(backend.calls.lock().unwrap().clone()),
                fixture["expected"]["calls"],
                "prompts {name}"
            );
            assert_eq!(
                V::Array(backend.requests.lock().unwrap().clone()),
                fixture["expected"]["requests"],
                "tools {name}"
            );
        }
    }
    #[test]
    fn invalid_dependency_graphs_fail_before_dispatch() {
        for tasks in [
            vec![task("a", vec![]), task("a", vec![])],
            vec![task("a", vec!["a".into()])],
            vec![task("a", vec!["b".into()]), task("b", vec!["a".into()])],
            vec![task("a", vec!["missing".into()])],
            (0..6).map(|n| task(&format!("t{n}"), vec![])).collect(),
        ] {
            assert!(parse_plan(&plan(tasks)).is_err());
        }
        let mut invalid = task("a", vec![]);
        invalid["deps"] = "a".into();
        assert!(parse_plan(&plan(vec![invalid])).is_err());
        assert!(
            parse_plan(&plan(vec![task("b", vec!["a".into()]), task("a", vec![])]))
                .unwrap()
                .is_some()
        );
        assert!(parse_plan(&"null".into()).unwrap().is_none());
    }
    #[tokio::test]
    async fn router_handoff_keeps_the_same_conversation_owner_and_explicit_agent_wins() {
        for (target, selected, responses, expected, count) in [
            (
                "auto",
                "auto",
                vec![
                    r#"{"team":"admin","complexity":"low","mode":"solo"}"#,
                    "resolved",
                ],
                "admin_sawon",
                2,
            ),
            ("intern", "dev_daeri", vec!["resolved"], "intern", 1),
            ("", "pro", vec!["resolved"], "dev_daeri", 1),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store = Arc::new(crate::agent::Store::new(directory.path().into()));
            store.handle(
                &axum::http::Method::POST,
                "/api/agent/model",
                &object([("model", selected.into())]),
            );
            let run = store
                .begin("fixture".into(), &"업무 요청".into(), None, true)
                .unwrap();
            let input = object([(
                "responses",
                V::Array(responses.iter().map(|v| V::from(*v)).collect()),
            )]);
            let backend = Script::new(&input);
            let state = agent_routing::State::default();
            let build = |p: &V| {
                assert!(store.is_running("fixture"));
                assert!(store
                    .begin("fixture".into(), &"duplicate".into(), None, true)
                    .is_err());
                context(p, &V::Null)
            };
            let engine = Engine {
                backend: &backend,
                context: &build,
                events: Arc::new(|_, _| {}),
                routing: &state,
                user_name: "".into(),
            };
            engine.run(run, &V::from(target)).await.unwrap();
            assert!(!store.is_running("fixture"));
            let history =
                parse(&fs::read_to_string(directory.path().join("agent-history.json")).unwrap());
            assert_eq!(
                history["fixture"]["messages"].array().last().unwrap()["agentId"],
                V::from(expected)
            );
            assert_eq!(backend.calls.lock().unwrap().len(), count);
        }
    }
    #[tokio::test]
    async fn provider_failure_retries_once_and_does_not_complete_dependents() {
        let input = object([(
            "responses",
            V::Array(vec![
                plan(vec![task("a", vec![]), task("b", vec!["a".into()])]),
                object([("error", "down".into())]),
                object([("error", "still down".into())]),
                "complete".into(),
            ]),
        )]);
        let backend = Script::new(&input);
        let state = agent_routing::State::default();
        let build = |p: &V| context(p, &V::Null);
        let events = Arc::new(Mutex::new(vec![]));
        let seen = events.clone();
        let engine = Engine {
            backend: &backend,
            context: &build,
            events: Arc::new(move |name, data| {
                seen.lock()
                    .unwrap()
                    .push(object([("name", name.into()), ("data", data)]))
            }),
            routing: &state,
            user_name: "".into(),
        };
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::agent::Store::new(directory.path().into()));
        let run = store
            .begin("fixture".into(), &"work".into(), None, true)
            .unwrap();
        engine.orchestrated(run, &"daepyo".into()).await.unwrap();
        let history =
            parse(&fs::read_to_string(directory.path().join("agent-history.json")).unwrap());
        assert_eq!(
            history["fixture"]["messages"].array().last().unwrap()["content"],
            V::from("[미완료 작업: a, b]\n\ncomplete")
        );
        assert_eq!(backend.calls.lock().unwrap().len(), 4);
        let events = events.lock().unwrap();
        assert!(!events.iter().any(|e| e["name"] == V::from("orch:sub-done")));
        assert!(events.iter().any(|e| e["name"] == V::from("orch:sub-error")
            && e["data"]["taskId"] == V::from("b")
            && e["data"]["retrying"] == V::Bool(false)));
    }
    #[tokio::test]
    async fn delegate_state_is_branch_local_and_lifecycle_ids_match() {
        let input = object([("responses", V::Array(vec!["done".into(), "other".into()]))]);
        let backend = Script::new(&input);
        let state = agent_routing::State::default();
        let build = |p: &V| context(p, &V::Null);
        let events = Arc::new(Mutex::new(vec![]));
        let seen = events.clone();
        let engine = Engine {
            backend: &backend,
            context: &build,
            events: Arc::new(move |name, data| {
                seen.lock()
                    .unwrap()
                    .push(object([("name", name.into()), ("data", data)]))
            }),
            routing: &state,
            user_name: "".into(),
        };
        for who in ["plan_sawon", "mkt_sawon"] {
            let request = ToolRequest {
                kind: "DELEGATE".into(),
                argument: format!("agent:{who}\ntask: do work").into(),
                conv_id: "fixture".into(),
                agent_id: "dev_sawon".into(),
                delegate_depth: 0,
                delegate_chain: vec![],
                sprint_mode: false,
            };
            assert!(engine
                .tool(request, &Cancel::default())
                .await
                .unwrap()
                .text()
                .contains("응답"));
        }
        let events = events.lock().unwrap();
        let starts: Vec<_> = events
            .iter()
            .filter(|e| e["name"] == V::from("orch:sub-start"))
            .collect();
        let dones: Vec<_> = events
            .iter()
            .filter(|e| e["name"] == V::from("orch:sub-done"))
            .collect();
        assert_eq!(starts.len(), 2);
        assert_eq!(dones.len(), 2);
        for index in 0..2 {
            assert_eq!(
                starts[index]["data"]["taskId"],
                dones[index]["data"]["taskId"]
            );
        }
        assert_ne!(starts[0]["data"]["taskId"], starts[1]["data"]["taskId"]);
    }
    #[tokio::test]
    async fn self_cycle_and_depth_delegation_never_invoke_model() {
        let backend = Script::new(&V::Null);
        let state = agent_routing::State::default();
        let build = |p: &V| context(p, &V::Null);
        let engine = Engine {
            backend: &backend,
            context: &build,
            events: Arc::new(|_, _| {}),
            routing: &state,
            user_name: "".into(),
        };
        for (agent, depth, chain) in [
            ("dev_sawon", 0, vec![]),
            ("plan_sawon", 3, vec![]),
            ("plan_sawon", 1, vec!["plan_sawon".into()]),
        ] {
            let response = engine
                .tool(
                    ToolRequest {
                        kind: "DELEGATE".into(),
                        argument: format!("agent:{agent}\ntask: do work").into(),
                        conv_id: "fixture".into(),
                        agent_id: "dev_sawon".into(),
                        delegate_depth: depth,
                        delegate_chain: chain,
                        sprint_mode: false,
                    },
                    &Cancel::default(),
                )
                .await
                .unwrap();
            assert!(response.text().starts_with("Error:"));
        }
        assert!(backend.calls.lock().unwrap().is_empty());
    }
    struct Waiting {
        count: AtomicUsize,
        dropped: AtomicUsize,
        entered: tokio::sync::Notify,
    }
    impl Backend for Waiting {
        fn model<'a>(&'a self, _: ModelRequest, cancel: &'a Cancel, _: Stream) -> Pending<'a, V> {
            Box::pin(async move {
                let n = self.count.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    return Ok(plan(vec![task("a", vec![]), task("b", vec![])]));
                }
                struct Guard<'a>(&'a AtomicUsize);
                impl Drop for Guard<'_> {
                    fn drop(&mut self) {
                        self.0.fetch_add(1, Ordering::SeqCst);
                    }
                }
                let _guard = Guard(&self.dropped);
                self.entered.notify_one();
                cancel.cancelled().await;
                Err("cancelled".into())
            })
        }
        fn tool<'a>(&'a self, _: ToolRequest, _: &'a Cancel) -> Pending<'a, V> {
            Box::pin(async { panic!("unexpected tool") })
        }
    }
    #[tokio::test]
    async fn stopping_parallel_work_cancels_all_children_without_retry_or_synthesis() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::agent::Store::new(directory.path().into()));
        let run = store
            .begin("fixture".into(), &"work".into(), None, true)
            .unwrap();
        let backend = Arc::new(Waiting {
            count: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
            entered: tokio::sync::Notify::new(),
        });
        let b = backend.clone();
        let task = tokio::spawn(async move {
            let state = agent_routing::State::default();
            let build = |p: &V| context(p, &V::Null);
            let engine = Engine {
                backend: &*b,
                context: &build,
                events: Arc::new(|_, _| {}),
                routing: &state,
                user_name: "".into(),
            };
            engine.orchestrated(run, &"daepyo".into()).await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while backend.count.load(Ordering::SeqCst) < 3 {
                backend.entered.notified().await;
            }
        })
        .await
        .unwrap();
        store.stop("fixture");
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(backend.dropped.load(Ordering::SeqCst), 2);
        assert_eq!(backend.count.load(Ordering::SeqCst), 3);
        assert!(!store.is_running("fixture"));
        let history =
            parse(&fs::read_to_string(directory.path().join("agent-history.json")).unwrap());
        assert_eq!(
            history["fixture"]["messages"].array().last().unwrap()["content"],
            V::from("(오케스트레이션이 중단되었어영)")
        );
    }
}
