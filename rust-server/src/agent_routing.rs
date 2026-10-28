//! Native routing and profile hierarchy. Provider failures retain the original
//! fallback; cancellation remains an error so a stopped request cannot start work.
use crate::{
    agent_prompt,
    agent_runtime::{bounded, Backend, ModelRequest},
    ai_transport::Cancel,
    board_value::{object, V},
};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};

#[derive(Default)]
pub struct State {
    team_index: AtomicUsize,
    mid_index: AtomicUsize,
}

impl State {
    pub fn pick(&self, team: &V, complexity: &V) -> Option<V> {
        pick_agent_by_complexity(team, complexity, &self.mid_index)
    }
}

pub fn profile(id: &str) -> Option<V> {
    agent_prompt::profile(id).cloned()
}

pub fn get_rank_level(id: &str) -> u8 {
    let Some(profile) = agent_prompt::profile(id) else {
        return 0;
    };
    match profile["rank"].text().as_str() {
        "Staff" => 1,
        "Asst.Mgr" => 2,
        "Manager" => 3,
        "Team Lead" => 4,
        "VP" => 5,
        "Director" => 6,
        _ => 0,
    }
}

pub fn get_team_members(team: &V) -> Vec<V> {
    let mut seen = HashSet::new();
    agent_prompt::catalog()["profiles"]
        .array()
        .iter()
        .filter_map(|entry| {
            let value = &entry.array()[1];
            (value["team"] == *team && seen.insert(value["id"].text())).then(|| value.clone())
        })
        .collect()
}

fn descending_members(team: &V) -> Vec<V> {
    let mut members = get_team_members(team);
    members.sort_by_key(|member| std::cmp::Reverse(get_rank_level(&member["id"].text())));
    members
}

pub fn get_team_lead(team: &V) -> Option<V> {
    descending_members(team).into_iter().next()
}

fn advance(index: &AtomicUsize, count: usize) -> usize {
    let previous = index
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |old| {
            Some((old % count + 1) % count)
        })
        .expect("round-robin update cannot fail");
    (previous % count + 1) % count
}

pub fn pick_agent_by_complexity(team: &V, complexity: &V, index: &AtomicUsize) -> Option<V> {
    let members = descending_members(team);
    if complexity == &V::from("high") {
        return members.first().cloned();
    }
    if complexity == &V::from("mid") {
        if members.len() > 3 {
            return Some(members[1 + advance(index, members.len() - 2)].clone());
        }
        return members.get(1.min(members.len().saturating_sub(1))).cloned();
    }
    members.last().cloned()
}

fn director() -> V {
    profile("daepyo").expect("embedded director profile")
}

pub fn escalate_agent(id: &str) -> V {
    let Some(agent) = profile(id) else {
        return director();
    };
    if agent["rank"] == V::from("Director") || !agent["team"].truthy() {
        return director();
    }
    let mut members = get_team_members(&agent["team"]);
    members.sort_by_key(|member| get_rank_level(&member["id"].text()));
    members
        .iter()
        .position(|member| member["id"] == V::from(id))
        .and_then(|index| members.get(index + 1))
        .cloned()
        .unwrap_or_else(director)
}

pub fn find_common_superior(a_id: &str, b_id: &str) -> V {
    let (Some(a), Some(b)) = (profile(a_id), profile(b_id)) else {
        return director();
    };
    if !a["team"].truthy() || a["team"] != b["team"] {
        return director();
    }
    let rank = get_rank_level(a_id).max(get_rank_level(b_id));
    let mut members = get_team_members(&a["team"]);
    members.retain(|member| {
        let id = member["id"].text();
        get_rank_level(&id) > rank && id != a_id && id != b_id
    });
    members.sort_by_key(|member| get_rank_level(&member["id"].text()));
    members.into_iter().next().unwrap_or_else(director)
}

const ROUTER_PROMPT: &str = "사용자 메시지를 보고 어떤 팀이 처리할지, 난이도, 협업 필요 여부를 판단해.

팀 목록:
- dev: 코드 작성, 디버깅, 리뷰, Git, CI/CD, 터미널, 빌드 — 개발 관련 전부
- plan: Jira 이슈, 노트/문서 작성, PRD, 스프린트, 일정, 회의록 — 기획/관리
- design: UI/UX 가이드, 스타일링, CSS, 디자인 피드백, 레이아웃 — 디자인
- admin: 토큰/비용 추적, 시스템 모니터링, CPU/메모리, 리포트 — 경영/인프라
- marketing: 카피라이팅, 콘텐츠 생성, SEO, 랜딩페이지 문구 — 마케팅
- intern: 웹서치, 번역, 날씨, 계산, 단위변환, 유튜브, 간단 요약 — 잡무

난이도:
- low: 조회, 검색, 간단 질문, 인사, 잡담 (사원급)
- mid: 분석, 중급 작업 (대리/과장급)
- high: 설계, 복잡한 판단, 전략 (팀장/부장급)

모드:
- solo: 한 명이 혼자 처리 (대부분의 요청)
- orchestrated: 2개 이상 팀이 반드시 협업 필요 (예: \"코드 리팩토링하고 Jira 이슈 만들어줘\" = dev+plan, \"전체 현황 보고\" = 여러 팀)

기본값: 명확한 팀이 없으면 dev, 명확한 난이도가 없으면 low.
한 팀으로 처리 가능한 건 solo. 인사, 잡담, 일반 대화 → dev팀 low.
\"인턴\" → intern. orchestrated는 정말 여러 팀 필요할 때만.

JSON만 출력: {\"team\":\"팀ID\",\"complexity\":\"low|mid|high\",\"mode\":\"solo|orchestrated\"}";

const NAMES: &[(&str, &str)] = &[
    ("콕핏이사", "daepyo"),
    ("김부장", "dev_bujang"),
    ("핏대리", "dev_daeri"),
    ("원과장", "dev_gwajang"),
    ("콕사원", "dev_sawon"),
    ("한기장", "plan_teamlead"),
    ("박기리", "plan_daeri"),
    ("이기원", "plan_sawon"),
    ("최디장", "design_teamlead"),
    ("정디리", "design_daeri"),
    ("강경장", "admin_teamlead"),
    ("차경리", "admin_daeri"),
    ("윤경원", "admin_sawon"),
    ("오마장", "mkt_teamlead"),
    ("류마리", "mkt_daeri"),
    ("신마원", "mkt_sawon"),
    ("막내", "intern"),
];

fn contains(value: &V, needle: &V) -> bool {
    let needle = needle.units();
    needle.is_empty()
        || value
            .units()
            .windows(needle.len())
            .any(|part| part == needle)
}

fn route(mode: &str, id: &str, escalation: Option<bool>) -> V {
    let mut result = object([("mode", mode.into()), ("agentId", id.into())]);
    if let Some(escalation) = escalation {
        result["escalation"] = V::Bool(escalation);
    }
    result
}

fn preflight(message: &V, state: &State) -> Option<V> {
    static NAMES_REGEX: OnceLock<regress::Regex> = OnceLock::new();
    static ESCALATE: OnceLock<regress::Regex> = OnceLock::new();
    static TEAM: OnceLock<regress::Regex> = OnceLock::new();
    static RANK: OnceLock<regress::Regex> = OnceLock::new();
    static GREETING: OnceLock<regress::Regex> = OnceLock::new();
    // The source lowercases before these Korean-only expressions. Matching the
    // original UTF-16 is equivalent and also preserves unpaired surrogates.
    let names = NAMES_REGEX.get_or_init(|| regress::Regex::new(
        "(?:콕핏이사|김부장|핏대리|원과장|콕사원|한기장|박기리|이기원|최디장|정디리|강경장|차경리|윤경원|오마장|류마리|신마원|막내)"
    ).unwrap());
    if let Some(found) = names.find_from_ucs2(message.units(), 0).next() {
        let name = V::String(message.units()[found.range].to_vec());
        let id = NAMES
            .iter()
            .find(|(text, _)| name == V::from(*text))
            .unwrap()
            .1;
        let escalation =
            ESCALATE.get_or_init(|| regress::Regex::new("불러|데려|호출|찾아|와봐").unwrap());
        return Some(route(
            "solo",
            id,
            Some(
                escalation
                    .find_from_ucs2(message.units(), 0)
                    .next()
                    .is_some(),
            ),
        ));
    }
    let team = TEAM.get_or_init(|| {
        regress::Regex::new(
            r"(개발|기획|디자인|경영|마케팅)팀?\s*(?:불러|데려|호출|찾아|시켜|맡겨)",
        )
        .unwrap()
    });
    if let Some(found) = team.find_from_ucs2(message.units(), 0).next() {
        let matched = V::String(message.units()[found.range].to_vec()).text();
        let id = [
            ("개발", "dev_bujang"),
            ("기획", "plan_teamlead"),
            ("디자인", "design_teamlead"),
            ("경영", "admin_teamlead"),
            ("마케팅", "mkt_teamlead"),
        ]
        .iter()
        .find(|(team, _)| matched.starts_with(team))
        .unwrap()
        .1;
        return Some(route("solo", id, Some(true)));
    }
    let rank = RANK.get_or_init(|| {
        regress::Regex::new("(?:상사|윗사람|부장|팀장|이사|과장|대리).*(?:불러|데려|호출|찾아)")
            .unwrap()
    });
    if let Some(found) = rank.find_from_ucs2(message.units(), 0).next() {
        let matched = V::String(message.units()[found.range].to_vec()).text();
        let id = if matched.contains("이사") {
            "daepyo"
        } else if matched.contains("부장") {
            "dev_bujang"
        } else if ["팀장", "상사", "윗사람"]
            .iter()
            .any(|word| matched.contains(word))
        {
            [
                "dev_bujang",
                "plan_teamlead",
                "design_teamlead",
                "admin_teamlead",
                "mkt_teamlead",
            ][advance(&state.team_index, 5)]
        } else if matched.contains("과장") {
            "dev_gwajang"
        } else {
            "dev_daeri"
        };
        return Some(route("solo", id, Some(true)));
    }
    let greeting = GREETING.get_or_init(|| {
        regress::Regex::new(r"^(하이|안녕|헬로|ㅎㅇ|게\s*누구|여기\s*누구|아무나)").unwrap()
    });
    if greeting.find_from_ucs2(message.units(), 0).next().is_some() {
        return Some(route("solo", "dev_sawon", None));
    }
    None
}

fn parse_route(raw: &V, message: &V, state: &State) -> Result<V, String> {
    if !raw.is_string() {
        return Err("Router response is not a string".into());
    }
    let mut clean = raw.trim().units().to_vec();
    if clean.starts_with(&"```json".encode_utf16().collect::<Vec<_>>()) {
        clean.drain(..7);
    } else if clean.starts_with(&[96, 96, 96]) {
        clean.drain(..3);
    }
    if clean.ends_with(&[96, 96, 96]) {
        clean.truncate(clean.len() - 3);
    }
    let clean = V::String(clean).trim();
    let parsed = V::parse(
        &serde_json::value::RawValue::from_string(clean.text()).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if parsed == V::Null {
        return Err("Router response is null".into());
    }
    let mode = if parsed["mode"] == V::from("orchestrated") {
        "orchestrated"
    } else {
        "solo"
    };
    // Object.values first adds names in profile order; aliases then add their
    // keys. Keep that insertion order rather than matching the earliest word.
    let entries = agent_prompt::catalog()["profiles"].array();
    let mut seen = HashSet::new();
    for entry in entries {
        let p = &entry.array()[1];
        if seen.insert(p["name"].text()) && contains(message, &p["name"]) {
            return Ok(route(mode, &p["id"].text(), None));
        }
    }
    for entry in entries {
        let pair = entry.array();
        if contains(message, &pair[0]) {
            return Ok(route(mode, &pair[1]["id"].text(), None));
        }
    }
    if parsed["team"] == V::from("intern") {
        return Ok(route("solo", "intern", None));
    }
    let team = if agent_prompt::catalog()["teams"]
        .array()
        .iter()
        .any(|team| team["id"] == parsed["team"])
    {
        parsed["team"].clone()
    } else {
        "dev".into()
    };
    let complexity = if ["low", "mid", "high"]
        .iter()
        .any(|c| parsed["complexity"] == V::from(*c))
    {
        parsed["complexity"].clone()
    } else {
        "low".into()
    };
    if mode == "orchestrated" {
        return Ok(route(mode, "daepyo", None));
    }
    let agent = pick_agent_by_complexity(&team, &complexity, &state.mid_index);
    Ok(route(
        mode,
        &agent.map_or_else(|| "dev_sawon".to_string(), |agent| agent["id"].text()),
        None,
    ))
}

pub async fn detect(
    message: &V,
    configured: bool,
    state: &State,
    backend: &dyn Backend,
    cancel: &Cancel,
) -> Result<V, String> {
    if cancel.is_cancelled() {
        return Err("Agent request cancelled".into());
    }
    if !configured {
        return Ok(route("solo", "dev_sawon", None));
    }
    if *message == V::Null {
        return Err("Cannot read properties of null (reading 'toLowerCase')".into());
    }
    if !message.is_string() {
        return Err("userMessage.toLowerCase is not a function".into());
    }
    if let Some(route) = preflight(message, state) {
        return Ok(route);
    }
    let child = cancel.child();
    let timeout = Duration::from_secs(8);
    let result = bounded(
        backend.model(
            ModelRequest {
                provider: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                system: ROUTER_PROMPT.into(),
                user: message.clone(),
                timeout,
            },
            &child,
            Arc::new(|_| {}),
        ),
        cancel,
        &child,
        timeout,
        "Router request timed out",
    )
    .await;
    if cancel.is_cancelled() {
        return Err("Agent request cancelled".into());
    }
    Ok(result
        .and_then(|raw| parse_route(&raw, message, state))
        .unwrap_or_else(|_| route("solo", "dev_sawon", None)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{Pending, Stream, ToolRequest};
    use std::sync::Mutex;

    struct Fake {
        result: Result<V, String>,
        requests: Mutex<Vec<V>>,
    }
    impl Backend for Fake {
        fn model<'a>(&'a self, request: ModelRequest, _: &'a Cancel, _: Stream) -> Pending<'a, V> {
            self.requests.lock().unwrap().push(object([
                ("system", request.system),
                ("user", request.user),
                ("model", request.model.into()),
                ("provider", request.provider.into()),
                ("timeoutMs", (request.timeout.as_millis() as f64).into()),
            ]));
            Box::pin(async { self.result.clone() })
        }
        fn tool<'a>(&'a self, _: ToolRequest, _: &'a Cancel) -> Pending<'a, V> {
            panic!("routing must not execute a tool")
        }
    }

    fn fixtures() -> V {
        V::parse(
            &serde_json::value::RawValue::from_string(
                include_str!("../../tests/fixtures/rust-agent-routing.json").into(),
            )
            .unwrap(),
        )
        .unwrap()
    }

    fn helper(input: &V, index: &AtomicUsize) -> V {
        let id = input["id"].text();
        match input["action"].text().as_str() {
            "rank" => (get_rank_level(&id) as f64).into(),
            "members" => V::Array(
                get_team_members(&input["team"])
                    .iter()
                    .map(|p| p["id"].clone())
                    .collect(),
            ),
            "lead" => get_team_lead(&input["team"]).map_or(V::Null, |p| p["id"].clone()),
            "pick" => pick_agent_by_complexity(&input["team"], &input["complexity"], index)
                .map_or(V::Null, |p| p["id"].clone()),
            "escalate" => escalate_agent(&id)["id"].clone(),
            "superior" => find_common_superior(&id, &input["other"].text())["id"].clone(),
            _ => panic!("unknown helper fixture"),
        }
    }

    #[test]
    fn profile_helpers_match_original_source() {
        let fixtures = fixtures();
        let index = AtomicUsize::new(0);
        for case in fixtures["helperCases"].array() {
            assert_eq!(
                helper(&case["input"], &index),
                case["expected"],
                "{}",
                case["input"].raw()
            );
        }
    }

    #[tokio::test]
    async fn routing_matches_original_source_and_provider_contract() {
        let fixtures = fixtures();
        assert_eq!(V::from(ROUTER_PROMPT), fixtures["routerPrompt"]);
        for case in fixtures["routingCases"].array() {
            let state = State::default();
            for step in case["steps"].array() {
                let input = &step["input"];
                let backend = Fake {
                    result: if input.has("error") {
                        Err(input["error"].text())
                    } else {
                        Ok(input["raw"].clone())
                    },
                    requests: Mutex::new(vec![]),
                };
                let result = detect(
                    &input["message"],
                    input["configured"].truthy(),
                    &state,
                    &backend,
                    &Cancel::default(),
                )
                .await;
                let value = match result {
                    Ok(value) => object([("value", value)]),
                    Err(error) => object([("error", error.into())]),
                };
                assert_eq!(value, step["expected"], "{}", input.raw());
                assert_eq!(
                    V::Array(backend.requests.into_inner().unwrap()),
                    step["calls"],
                    "provider contract: {}",
                    input.raw()
                );
            }
        }
    }

    #[tokio::test]
    async fn cancellation_does_not_fallback_or_advance_routing() {
        let state = State::default();
        let cancel = Cancel::default();
        cancel.cancel();
        let backend = Fake {
            result: Ok("{}".into()),
            requests: Mutex::new(vec![]),
        };
        for configured in [false, true] {
            assert_eq!(
                detect(&"상사 불러".into(), configured, &state, &backend, &cancel).await,
                Err("Agent request cancelled".into())
            );
        }
        assert_eq!(state.team_index.load(Ordering::Relaxed), 0);
        assert!(backend.requests.lock().unwrap().is_empty());

        struct Waiting;
        impl Backend for Waiting {
            fn model<'a>(
                &'a self,
                _: ModelRequest,
                cancel: &'a Cancel,
                _: Stream,
            ) -> Pending<'a, V> {
                Box::pin(async {
                    cancel.cancelled().await;
                    Err("cancelled".into())
                })
            }
            fn tool<'a>(&'a self, _: ToolRequest, _: &'a Cancel) -> Pending<'a, V> {
                panic!("unexpected tool")
            }
        }
        let cancel = Cancel::default();
        let message = "일반 요청".into();
        let result = detect(&message, true, &state, &Waiting, &cancel);
        let stop = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel.cancel();
        };
        let (result, _) = tokio::join!(result, stop);
        assert_eq!(result, Err("Agent request cancelled".into()));
    }

    #[test]
    fn independent_round_robin_counters_remain_bounded() {
        let state = State::default();
        let without_team_calls = State::default();
        let middle_count = get_team_members(&"dev".into()).len() - 2;
        let mut visited = HashSet::new();
        for index in 0..100 {
            let called = preflight(&"상사 불러".into(), &state).unwrap();
            assert_eq!(
                called["agentId"],
                V::from(
                    [
                        "plan_teamlead",
                        "design_teamlead",
                        "admin_teamlead",
                        "mkt_teamlead",
                        "dev_bujang"
                    ][index % 5]
                )
            );
            let agent =
                pick_agent_by_complexity(&"dev".into(), &"mid".into(), &state.mid_index).unwrap();
            assert_eq!(
                agent["id"],
                without_team_calls
                    .pick(&"dev".into(), &"mid".into())
                    .unwrap()["id"],
                "team calls must not advance middle-rank assignment"
            );
            assert!(state.mid_index.load(Ordering::Relaxed) < middle_count);
            visited.insert(agent["id"].text());
        }
        assert_eq!(
            visited.len(),
            middle_count,
            "every middle-rank agent receives work"
        );
        let index = AtomicUsize::new(usize::MAX);
        assert!(advance(&index, 5) < 5);
    }
}
