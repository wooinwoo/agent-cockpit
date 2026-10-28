//! Structured agent consultation. The host owns provider credentials and event delivery.
use crate::{
    agent_prompt::{profile, property_string, string},
    agent_routing::{find_common_superior, get_rank_level},
    agent_runtime::{bounded, concat, event, Backend, Events, ModelRequest, ToolRequest},
    ai_transport::Cancel,
    board_value::{object, V},
};
use std::{sync::Arc, time::Duration};

const SYSTEM: &str = "JSON만 출력. 첫 글자 {, 마지막 글자 }.";
const TIMEOUT: Duration = Duration::from_secs(15);

macro_rules! cat {
    ($($part:expr),* $(,)?) => { concat(&[$($part.into()),*]) };
}

fn check_cancel(cancel: &Cancel) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("Agent request cancelled".into())
    } else {
        Ok(())
    }
}

fn publish(
    emit: &Events,
    context: &ToolRequest,
    cancel: &Cancel,
    name: &str,
    data: V,
) -> Result<(), String> {
    check_cancel(cancel)?;
    event(emit, &context.conv_id, name, data);
    // A synchronous event subscriber can stop the parent operation.
    check_cancel(cancel)
}

async fn ask(backend: &dyn Backend, prompt: V, cancel: &Cancel) -> Result<V, String> {
    check_cancel(cancel)?;
    let child = cancel.child();
    let response = bounded(
        backend.model(
            ModelRequest {
                provider: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                system: SYSTEM.into(),
                user: prompt,
                timeout: TIMEOUT,
            },
            &child,
            Arc::new(|_| {}),
        ),
        cancel,
        &child,
        TIMEOUT,
        "CONSULT model request timed out",
    )
    .await;
    check_cancel(cancel)?;
    response
}

fn parse_round(raw: &V, fallback: V) -> Result<V, String> {
    if !raw.is_string() {
        return Err("CONSULT model response must be a string".into());
    }
    let trimmed = raw.trim();
    let mut units = trimmed.units();
    if units.starts_with(&[96, 96, 96, 106, 115, 111, 110]) {
        units = &units[7..];
    } else if units.starts_with(&[96, 96, 96]) {
        units = &units[3..];
    }
    if units.ends_with(&[96, 96, 96]) {
        units = &units[..units.len() - 3];
    }
    let cleaned = V::String(units.to_vec()).trim();
    let parsed = crate::agent_response::json_text(&cleaned)
        .and_then(|json| serde_json::value::RawValue::from_string(json).ok());
    Ok(parsed
        .and_then(|value| V::parse(&value).ok())
        // The original dereferences JSON null and crashes. Treat null as an
        // unusable response, using the same fallback as malformed JSON.
        .filter(|value| *value != V::Null)
        .unwrap_or(fallback))
}

fn fallback(raw: &V, stance: &str, extra: &str) -> V {
    object([
        ("stance", stance.into()),
        ("reasoning", raw.cut(300)),
        (extra, "".into()),
    ])
}

fn alternate_string(value: &V, key: &str, alternate: &str) -> Result<V, String> {
    if value[key].truthy() {
        string(&value[key])
    } else {
        property_string(value, alternate)
    }
}

fn round_event(round: usize, id: V, name: V, response: &V) -> V {
    let mut data = object([
        ("round", (round as f64).into()),
        ("agentId", id),
        ("agentName", name),
    ]);
    for key in ["stance", "reasoning", "suggestion"] {
        if (round == 1 || key != "suggestion") && response.has(key) {
            data[key] = response[key].clone();
        }
    }
    data
}

fn resolve(
    result: V,
    outcome: &str,
    decided_by: V,
    context: &ToolRequest,
    cancel: &Cancel,
    emit: &Events,
) -> Result<V, String> {
    publish(
        emit,
        context,
        cancel,
        "consult:resolved",
        object([
            ("outcome", outcome.into()),
            ("decidedBy", decided_by),
            ("result", result.clone()),
        ]),
    )?;
    Ok(result)
}

pub async fn execute(
    argument: &V,
    context: &ToolRequest,
    backend: &dyn Backend,
    cancel: &Cancel,
    emit: &Events,
) -> Result<V, String> {
    check_cancel(cancel)?;
    if context.conv_id.is_empty() {
        return Ok("Error: CONSULT는 대화 컨텍스트가 필요합니다.".into());
    }
    if argument.truthy() && !argument.is_string() {
        return Err("(arg || \"\").split is not a function".into());
    }
    let mut target_id = V::from("");
    let mut topic = V::from("");
    let mut my_view = V::from("");
    let mut background = V::from("");
    for line in argument.units().split(|unit| *unit == 10) {
        let trimmed = V::String(line.to_vec()).trim();
        let mut matched = false;
        for (prefix, output) in [
            ("agent:", &mut target_id),
            ("topic:", &mut topic),
            ("my_view:", &mut my_view),
            ("context:", &mut background),
        ] {
            if trimmed
                .units()
                .starts_with(&prefix.encode_utf16().collect::<Vec<_>>())
            {
                *output = V::String(trimmed.units()[prefix.len()..].to_vec()).trim();
                matched = true;
                break;
            }
        }
        if !matched && !topic.truthy() && trimmed.truthy() {
            topic = trimmed;
        }
    }
    if !topic.truthy() {
        return Ok("Error: CONSULT에 주제(topic:)가 필요합니다.".into());
    }
    let target =
        match profile(&target_id.text()) {
            Some(target) => target,
            None => return Ok(
                "Error: 대상 에이전트를 찾을 수 없습니다. agent:에이전트ID 형식으로 지정하세요."
                    .into(),
            ),
        };
    let caller = profile(&context.agent_id).cloned().unwrap_or(V::Null);
    if target["id"] == caller["id"] {
        return Ok("Error: 자기 자신에게 의견을 구할 수 없습니다.".into());
    }
    let caller_name = if caller["name"].truthy() {
        caller["name"].clone()
    } else {
        context.agent_id.clone().into()
    };
    let caller_rank = if caller["rank"].truthy() {
        caller["rank"].clone()
    } else {
        "?".into()
    };
    let caller_persona = if caller["persona"].truthy() {
        caller["persona"].clone()
    } else {
        "".into()
    };
    let target_name = target["name"].clone();
    publish(
        emit,
        context,
        cancel,
        "consult:start",
        object([
            ("callerId", context.agent_id.clone().into()),
            ("callerName", caller_name.clone()),
            ("targetId", target_id.clone()),
            ("targetName", target_name.clone()),
            ("topic", topic.clone()),
            ("callerView", my_view.clone()),
        ]),
    )?;

    let prompt = cat!(
        "너는 ", target_name.clone(), "(", target["rank"].clone(), ", ",
        if target["team"].truthy() { cat!(target["team"].clone(), "팀") } else { V::from("무소속") },
        ")이야.\n", target["persona"].clone(), "\n\n", caller_name.clone(), "(", caller_rank.clone(),
        ")이(가) 너에게 의견을 구한다:\n\n주제: ", topic.clone(), "\n", caller_name.clone(), "의 견해: ",
        if my_view.truthy() { my_view.clone() } else { V::from("(의견 없이 자문 요청)") }, "\n",
        if background.truthy() { cat!("배경: ", background.clone()) } else { V::from("") },
        "\n\n너의 전문 분야 관점에서 평가해. 반드시 아래 JSON으로만 답변:\n{\"stance\":\"agree|disagree|partial\",\"reasoning\":\"왜 그렇게 생각하는지 2-3문장\",\"suggestion\":\"너의 대안/보완 제안 (동의하면 빈 문자열)\"}",
    );
    let raw = match ask(backend, prompt, cancel).await {
        Ok(raw) => raw,
        Err(error) => {
            check_cancel(cancel)?;
            return Ok(cat!("Error: ", target_name, " 응답 실패 — ", error));
        }
    };
    let round1 = parse_round(&raw, fallback(&raw, "partial", "suggestion"))?;
    publish(
        emit,
        context,
        cancel,
        "consult:round",
        round_event(1, target_id.clone(), target_name.clone(), &round1),
    )?;
    let reasoning1 = property_string(&round1, "reasoning")?;
    let header = cat!(
        "\n참여: ",
        caller_name.clone(),
        ", ",
        target_name.clone(),
        "\n주제: ",
        topic.clone()
    );
    if round1["stance"] == V::from("agree") {
        let result = cat!(
            "[의견 조율 완료 — 합의]",
            header,
            "\n결과: ",
            target_name,
            " 동의\n",
            reasoning1
        );
        return resolve(result, "agreed", V::Null, context, cancel, emit);
    }
    if round1["stance"] == V::from("partial") {
        let suggestion = if round1["suggestion"].truthy() {
            string(&round1["suggestion"])?
        } else {
            "(없음)".into()
        };
        let result = cat!(
            "[의견 조율 완료 — 부분 합의]",
            header,
            "\n",
            target_name,
            " 의견: ",
            reasoning1,
            "\n보완 제안: ",
            suggestion
        );
        return resolve(result, "partial", V::Null, context, cancel, emit);
    }

    let prompt = cat!(
        "너는 ", caller_name.clone(), "(", caller_rank.clone(), ")이야.\n", caller_persona,
        "\n\n네가 \"", topic.clone(), "\"에 대해 \"", my_view.clone(), "\" 의견을 냈는데,\n",
        target_name.clone(), "(", target["rank"].clone(), ")이(가) 반박했다:\n- 입장: 반대\n- 근거: ",
        reasoning1.clone(), "\n- 대안: ",
        if round1["suggestion"].truthy() { string(&round1["suggestion"])? } else { V::from("없음") },
        "\n\n", target_name.clone(), "의 반박을 듣고 나서, 너의 최종 입장을 정해.\n반드시 아래 JSON으로만 답변:\n{\"stance\":\"accept|insist|revise\",\"reasoning\":\"왜 그렇게 결정했는지 2-3문장\",\"revised_view\":\"수정된 의견 (accept/insist면 빈 문자열)\"}",
    );
    let target_view = alternate_string(&round1, "suggestion", "reasoning")?;
    let raw = match ask(backend, prompt, cancel).await {
        Ok(raw) => raw,
        Err(_) => {
            check_cancel(cancel)?;
            let result = cat!(
                "[의견 조율 완료 — ",
                target_name.clone(),
                " 의견 채택]",
                header,
                "\n",
                caller_name.clone(),
                " 원래 의견: ",
                my_view,
                "\n",
                target_name.clone(),
                " 반박: ",
                reasoning1,
                "\n결론: ",
                caller_name,
                " 응답 실패로 ",
                target_name.clone(),
                " 의견 채택\n제안: ",
                target_view
            );
            return resolve(result, "target_wins", target_name, context, cancel, emit);
        }
    };
    let round2 = parse_round(&raw, fallback(&raw, "accept", "revised_view"))?;
    publish(
        emit,
        context,
        cancel,
        "consult:round",
        round_event(
            2,
            context.agent_id.clone().into(),
            caller_name.clone(),
            &round2,
        ),
    )?;
    if round2["stance"] == V::from("accept") {
        let result = cat!(
            "[의견 조율 완료 — ",
            caller_name.clone(),
            " 수용]",
            header,
            "\n",
            caller_name.clone(),
            " 원래 의견: ",
            my_view,
            "\n",
            target_name.clone(),
            " 반박: ",
            reasoning1,
            "\n결론: ",
            caller_name.clone(),
            "이(가) ",
            target_name,
            "의 의견을 수용함\n채택된 방향: ",
            target_view
        );
        return resolve(
            result,
            "caller_accepted",
            caller_name,
            context,
            cancel,
            emit,
        );
    }
    if round2["stance"] == V::from("revise") {
        let result = cat!(
            "[의견 조율 완료 — 절충안 합의]",
            header,
            "\n",
            caller_name.clone(),
            " 원래 의견: ",
            my_view,
            "\n",
            target_name,
            " 반박: ",
            reasoning1,
            "\n",
            caller_name,
            " 수정안: ",
            alternate_string(&round2, "revised_view", "reasoning")?,
            "\n결론: 양측 의견을 반영한 절충안 도출"
        );
        return resolve(result, "compromised", V::Null, context, cancel, emit);
    }

    let superior = find_common_superior(&context.agent_id, &target_id.text());
    let mut escalation = object([
        ("superiorId", superior["id"].clone()),
        ("superiorName", superior["name"].clone()),
        ("callerView", my_view.clone()),
    ]);
    if round1["suggestion"].truthy() {
        escalation["targetView"] = round1["suggestion"].clone();
    } else if round1.has("reasoning") {
        escalation["targetView"] = round1["reasoning"].clone();
    }
    publish(emit, context, cancel, "consult:escalate", escalation)?;
    let prompt = cat!(
        "너는 ", superior["name"].clone(), "(", superior["rank"].clone(), ")이야.\n", superior["persona"].clone(),
        "\n\n부하 직원 2명이 의견 충돌로 너에게 판단을 요청했다:\n\n주제: ", topic.clone(),
        "\n\n", caller_name.clone(), "(", caller_rank, ") 의견: ", my_view.clone(),
        "\n- 고집 근거: ", property_string(&round2, "reasoning")?, "\n\n", target_name.clone(), "(",
        target["rank"].clone(), ") 의견: ", target_view.clone(), "\n- 반박 근거: ", reasoning1,
        "\n\n상급자로서 최종 판단을 내려. 어느 쪽이든 택하거나, 새로운 방향을 제시해도 된다.\n반드시 아래 JSON으로만 답변:\n{\"decision\":\"caller|target|new\",\"reasoning\":\"판단 근거 2-3문장\",\"final_direction\":\"최종 방향/지시사항\"}",
    );
    let raw = match ask(backend, prompt, cancel).await {
        Ok(raw) => raw,
        Err(_) => {
            check_cancel(cancel)?;
            let caller_wins =
                get_rank_level(&context.agent_id) >= get_rank_level(&target_id.text());
            let winner = if caller_wins {
                caller_name
            } else {
                target_name
            };
            let winner_view = if caller_wins { my_view } else { target_view };
            let result = cat!(
                "[의견 조율 완료 — 직급 우선]",
                header,
                "\n상급자(",
                superior["name"].clone(),
                ") 판단 실패로 직급 높은 쪽(",
                winner.clone(),
                ") 의견 채택\n채택된 방향: ",
                winner_view
            );
            return resolve(result, "rank_default", winner, context, cancel, emit);
        }
    };
    let judge = parse_round(
        &raw,
        object([
            ("decision", "new".into()),
            ("reasoning", raw.cut(300)),
            ("final_direction", raw.cut(200)),
        ]),
    )?;
    let decision = match judge["decision"].text().as_str() {
        "caller" if judge["decision"].is_string() => cat!(caller_name.clone(), " 의견 채택"),
        "target" if judge["decision"].is_string() => cat!(target_name.clone(), " 의견 채택"),
        _ => "새로운 방향 제시".into(),
    };
    let result = cat!(
        "[의견 조율 완료 — 상급자(",
        superior["name"].clone(),
        ") 최종 판단]\n참여: ",
        caller_name.clone(),
        ", ",
        target_name.clone(),
        ", ",
        superior["name"].clone(),
        "(심판)\n주제: ",
        topic,
        "\n",
        caller_name,
        " 의견: ",
        my_view,
        "\n",
        target_name,
        " 의견: ",
        target_view,
        "\n\n--- 최종 판단 ---\n판정: ",
        decision,
        "\n근거: ",
        property_string(&judge, "reasoning")?,
        "\n최종 방향: ",
        property_string(&judge, "final_direction")?
    );
    let mut data = object([
        ("outcome", "superior_judged".into()),
        ("decidedBy", superior["name"].clone()),
        ("result", result.clone()),
    ]);
    if judge.has("decision") {
        data["decision"] = judge["decision"].clone();
    }
    publish(emit, context, cancel, "consult:resolved", data)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{Pending, Stream};
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };

    fn parse(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    fn request(argument: V, caller: &str, conversation: &str) -> ToolRequest {
        ToolRequest {
            kind: "CONSULT".into(),
            argument,
            conv_id: conversation.into(),
            agent_id: caller.into(),
            delegate_depth: 0,
            delegate_chain: vec![],
            sprint_mode: false,
        }
    }
    fn events() -> (Arc<Mutex<Vec<V>>>, Events) {
        let records = Arc::new(Mutex::new(vec![]));
        let sink = records.clone();
        let emit: Events = Arc::new(move |name, data| {
            sink.lock()
                .unwrap()
                .push(object([("name", name.into()), ("data", data)]));
        });
        (records, emit)
    }
    struct Scripted {
        replies: Mutex<VecDeque<V>>,
        requests: Mutex<Vec<V>>,
        stop: Option<(usize, Cancel)>,
    }
    impl Scripted {
        fn new(replies: Vec<V>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                requests: Mutex::new(vec![]),
                stop: None,
            }
        }
    }
    impl Backend for Scripted {
        fn model<'a>(&'a self, request: ModelRequest, _: &'a Cancel, _: Stream) -> Pending<'a, V> {
            Box::pin(async move {
                assert_eq!(request.provider, "gemini");
                let index = {
                    let mut requests = self.requests.lock().unwrap();
                    requests.push(object([
                        ("model", request.model.into()),
                        ("system", request.system),
                        ("user", request.user),
                        ("timeoutMs", (request.timeout.as_millis() as f64).into()),
                    ]));
                    requests.len()
                };
                if let Some((stop_at, cancel)) = &self.stop {
                    if index == *stop_at {
                        cancel.cancel();
                    }
                }
                let reply = self
                    .replies
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("script exhausted");
                if reply.has("error") {
                    Err(reply["error"].text())
                } else {
                    Ok(reply)
                }
            })
        }
        fn tool<'a>(&'a self, _: ToolRequest, _: &'a Cancel) -> Pending<'a, V> {
            Box::pin(async { panic!("CONSULT cannot directly run tools") })
        }
    }

    #[tokio::test]
    async fn original_consultation_results_prompts_and_events_match() {
        let fixtures = parse(include_str!("../../tests/fixtures/rust-agent-consult.json"));
        assert!(fixtures.array().len() >= 60);
        for fixture in fixtures.array() {
            let input = &fixture["input"];
            let context = request(
                input["argument"].clone(),
                &input["callerId"].text(),
                &input["convId"].text(),
            );
            let backend = Scripted::new(input["responses"].array().to_vec());
            let (records, emit) = events();
            let mut actual = match execute(
                &context.argument,
                &context,
                &backend,
                &Cancel::default(),
                &emit,
            )
            .await
            {
                Ok(value) => object([("value", value)]),
                Err(error) => object([("error", error.into())]),
            };
            actual["events"] = V::Array(records.lock().unwrap().clone());
            actual["requests"] = V::Array(backend.requests.lock().unwrap().clone());
            assert_eq!(actual, fixture["expected"], "{}", input["name"].text());
        }
    }

    fn argument() -> V {
        "agent:dev_daeri\ntopic:작업 우선순위\nmy_view:검증 먼저".into()
    }

    #[tokio::test]
    async fn aliases_cannot_consult_the_same_profile() {
        for caller in ["sawon", "dev_sawon"] {
            for target in ["sawon", "dev_sawon"] {
                let context = request(
                    format!("agent:{target}\ntopic:검증").into(),
                    caller,
                    "self-alias",
                );
                let backend = Scripted::new(vec![]);
                let (records, emit) = events();
                assert_eq!(
                    execute(
                        &context.argument,
                        &context,
                        &backend,
                        &Cancel::default(),
                        &emit
                    )
                    .await,
                    Ok("Error: 자기 자신에게 의견을 구할 수 없습니다.".into())
                );
                assert!(backend.requests.lock().unwrap().is_empty());
                assert!(records.lock().unwrap().is_empty());
            }
        }
    }
    fn replies() -> Vec<V> {
        vec![
            r#"{"stance":"disagree","reasoning":"다른 근거","suggestion":"대안"}"#.into(),
            r#"{"stance":"insist","reasoning":"반박"}"#.into(),
            r#"{"decision":"new","reasoning":"판단","final_direction":"새 방향"}"#.into(),
        ]
    }
    fn no_resolution(records: &Arc<Mutex<Vec<V>>>) {
        assert!(!records
            .lock()
            .unwrap()
            .iter()
            .any(|record| record["name"] == V::from("consult:resolved")));
    }

    #[tokio::test]
    async fn cancellation_before_or_during_any_round_never_adopts_a_fallback() {
        let context = request(argument(), "dev_sawon", "cancel-consult");
        for round in 0..=3 {
            // Both a late successful reply and a provider error after cancellation
            // must stop before publishing a round, adoption, or judge result.
            for provider_error in [false, true] {
                let cancel = Cancel::default();
                let mut responses = replies();
                if provider_error && round > 0 {
                    responses[round - 1] = object([("error", "provider cancelled".into())]);
                }
                let mut backend = Scripted::new(responses);
                if round == 0 {
                    cancel.cancel();
                } else {
                    backend.stop = Some((round, cancel.clone()));
                }
                let (records, emit) = events();
                let result = execute(&context.argument, &context, &backend, &cancel, &emit).await;
                assert_eq!(result, Err("Agent request cancelled".into()));
                assert_eq!(backend.requests.lock().unwrap().len(), round);
                no_resolution(&records);
                let emitted_rounds = records
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|record| record["name"] == V::from("consult:round"))
                    .count();
                assert_eq!(emitted_rounds, round.saturating_sub(1));
            }
        }
    }

    #[tokio::test]
    async fn cancellation_from_events_prevents_the_next_provider_request() {
        for stop_event in ["consult:start", "consult:round", "consult:escalate"] {
            let cancel = Cancel::default();
            let subscriber_cancel = cancel.clone();
            let records = Arc::new(Mutex::new(vec![]));
            let sink = records.clone();
            let emit: Events = Arc::new(move |name, data| {
                sink.lock()
                    .unwrap()
                    .push(object([("name", name.into()), ("data", data)]));
                if name == stop_event {
                    subscriber_cancel.cancel();
                }
            });
            let backend = Scripted::new(replies());
            let context = request(argument(), "dev_sawon", "event-stop");
            assert_eq!(
                execute(&context.argument, &context, &backend, &cancel, &emit).await,
                Err("Agent request cancelled".into())
            );
            let expected = match stop_event {
                "consult:start" => 0,
                "consult:round" => 1,
                _ => 2,
            };
            assert_eq!(backend.requests.lock().unwrap().len(), expected);
            no_resolution(&records);
        }
    }

    struct PendingProvider {
        entered: tokio::sync::Notify,
        reaped: AtomicBool,
    }
    impl Backend for PendingProvider {
        fn model<'a>(&'a self, _: ModelRequest, cancel: &'a Cancel, _: Stream) -> Pending<'a, V> {
            Box::pin(async move {
                self.entered.notify_one();
                cancel.cancelled().await;
                self.reaped.store(true, Ordering::SeqCst);
                Err("transport cancelled".into())
            })
        }
        fn tool<'a>(&'a self, _: ToolRequest, _: &'a Cancel) -> Pending<'a, V> {
            Box::pin(async { panic!("Unexpected tool call") })
        }
    }
    #[tokio::test]
    async fn stop_cancels_and_drains_an_active_provider_without_resolving() {
        let backend = PendingProvider {
            entered: tokio::sync::Notify::new(),
            reaped: AtomicBool::new(false),
        };
        let cancel = Cancel::default();
        let context = request(argument(), "dev_sawon", "active-stop");
        let (records, emit) = events();
        let run = execute(&context.argument, &context, &backend, &cancel, &emit);
        let stop = async {
            backend.entered.notified().await;
            cancel.cancel();
        };
        let (result, ()) =
            tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(run, stop) })
                .await
                .unwrap();
        assert_eq!(result, Err("Agent request cancelled".into()));
        assert!(backend.reaped.load(Ordering::SeqCst));
        no_resolution(&records);
    }

    #[tokio::test]
    async fn null_json_uses_malformed_response_fallback_and_non_strings_fail() {
        let context = request(argument(), "dev_sawon", "invalid-response");
        for (round, outcome) in [
            (0, "partial"),
            (1, "caller_accepted"),
            (2, "superior_judged"),
        ] {
            let mut responses = replies();
            responses[round] = "null".into();
            let backend = Scripted::new(responses);
            let (records, emit) = events();
            assert!(execute(
                &context.argument,
                &context,
                &backend,
                &Cancel::default(),
                &emit
            )
            .await
            .is_ok());
            let events = records.lock().unwrap();
            let resolution = events.last().unwrap();
            assert_eq!(resolution["name"], V::from("consult:resolved"));
            assert_eq!(resolution["data"]["outcome"], V::from(outcome));
            assert_eq!(backend.requests.lock().unwrap().len(), round + 1);
        }
        for response in [
            V::Null,
            false.into(),
            5.0.into(),
            V::Array(vec![]),
            V::object(),
        ] {
            let backend = Scripted::new(vec![response]);
            let (records, emit) = events();
            assert_eq!(
                execute(
                    &context.argument,
                    &context,
                    &backend,
                    &Cancel::default(),
                    &emit
                )
                .await,
                Err("CONSULT model response must be a string".into())
            );
            no_resolution(&records);
        }
    }
}
