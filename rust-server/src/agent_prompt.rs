//! Pure prompt construction. Filesystem and service context belongs to the caller.
use crate::board_value::{object, V};
use std::sync::OnceLock;

const ALL_TOOLS: &[&str] = &[
    "BASH", "READ", "SEARCH", "EDIT", "WRITE", "GLOB", "GIT_DIFF", "GIT_LOG", "JIRA", "CICD",
    "OPEN", "COCKPIT", "WEATHER", "DELEGATE", "CONSULT",
];
const INTERN_TOOLS: &[&str] = &["OPEN", "WEATHER", "COCKPIT", "READ", "DELEGATE", "CONSULT"];
pub const MAX_CONVERSATION_HISTORY_CHARS: usize = 15_000;
const MAX_TOTAL_PROMPT_CHARS: usize = 55_000;
const MAX_TOOL_LOG_CHARS: usize = 25_000;
const KEEP_RECENT_TOOL_ENTRIES: usize = 3;

pub(crate) fn catalog() -> &'static V {
    static CATALOG: OnceLock<V> = OnceLock::new();
    CATALOG.get_or_init(|| {
        V::parse(
            &serde_json::value::RawValue::from_string(include_str!("agent_profiles.json").into())
                .unwrap(),
        )
        .expect("embedded agent profiles")
    })
}

fn prompt_asset() -> &'static V {
    static ASSET: OnceLock<V> = OnceLock::new();
    ASSET.get_or_init(|| {
        V::parse(
            &serde_json::value::RawValue::from_string(
                include_str!("agent_system_prompt.json").into(),
            )
            .unwrap(),
        )
        .expect("embedded agent system prompt")
    })
}

pub fn profile(id: &str) -> Option<&'static V> {
    catalog()["profiles"].array().iter().find_map(|pair| {
        let values = pair.array();
        (values.first() == Some(&V::from(id))).then(|| &values[1])
    })
}

fn team(profile: &V) -> Option<&'static V> {
    if !profile["team"].truthy() {
        return None;
    }
    catalog()["teams"]
        .array()
        .iter()
        .find(|team| team["id"] == profile["team"])
}

pub fn agent_tools(profile: Option<&V>) -> Vec<String> {
    let fixed = match profile.filter(|p| p.truthy()) {
        None => Some(ALL_TOOLS),
        Some(p) if p["id"] == V::from("intern") => Some(INTERN_TOOLS),
        Some(p) if p["id"] == V::from("daepyo") => Some(ALL_TOOLS),
        Some(p) if team(p).is_none() => Some(ALL_TOOLS),
        _ => None,
    };
    if let Some(tools) = fixed {
        return tools.iter().map(|tool| (*tool).into()).collect();
    }
    let mut tools: Vec<String> = team(profile.unwrap()).unwrap()["tools"]
        .array()
        .iter()
        .map(V::text)
        .collect();
    for common in ["WEATHER", "OPEN", "DELEGATE", "CONSULT"] {
        if !tools.iter().any(|tool| tool == common) {
            tools.push(common.into());
        }
    }
    tools
}

fn append(out: &mut Vec<u16>, text: &str) {
    out.extend(text.encode_utf16());
}

// Template interpolation follows JavaScript String(), without losing surrogates.
pub(crate) fn string(value: &V) -> Result<V, String> {
    Ok(match value {
        V::String(_) => value.clone(),
        V::Object(_) if value.has("toString") => {
            return Err("Cannot convert object to primitive value".into());
        }
        V::Number(n) if *n == 0.0 => "0".into(),
        V::Number(n) if *n == f64::INFINITY => "Infinity".into(),
        V::Number(n) if *n == f64::NEG_INFINITY => "-Infinity".into(),
        V::Number(n) if n.is_finite() && (n.abs() >= 1e21 || n.abs() < 1e-6) => {
            let scientific = format!("{n:e}");
            let (digits, exponent) = scientific.split_once('e').unwrap();
            let exponent: i32 = exponent.parse().unwrap();
            format!(
                "{digits}e{}{exponent}",
                if exponent >= 0 { "+" } else { "" }
            )
            .into()
        }
        V::Array(values) => {
            let mut out = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    out.push(44);
                }
                if *value != V::Null {
                    out.extend_from_slice(string(value)?.units());
                }
            }
            V::String(out)
        }
        _ => value.text().into(),
    })
}

pub(crate) fn property_string(value: &V, key: &str) -> Result<V, String> {
    if value.has(key) {
        string(&value[key])
    } else {
        Ok("undefined".into())
    }
}

fn fallback_string(value: &V) -> V {
    if value.truthy() {
        value.clone()
    } else {
        "".into()
    }
}

fn slice(value: &V, end: usize) -> Result<V, String> {
    match value {
        V::String(_) => Ok(value.cut(end)),
        V::Array(items) => Ok(V::Array(items.iter().take(end).cloned().collect())),
        _ => Err("value.slice is not a function".into()),
    }
}

fn text_units<'a>(value: &'a V, operation: &str) -> Result<&'a [u16], String> {
    if let V::String(units) = value {
        Ok(units)
    } else {
        Err(format!("value.{operation} is not a function"))
    }
}

fn replace_unit(value: &V, needle: u16, replacement: &str) -> Result<V, String> {
    let mut out = Vec::new();
    for unit in text_units(value, "replace")? {
        if *unit == needle {
            append(&mut out, replacement);
        } else {
            out.push(*unit);
        }
    }
    Ok(V::String(out))
}

fn escape_xml(value: &V) -> Result<V, String> {
    let value = replace_unit(&fallback_string(value), 38, "&amp;")?;
    let value = replace_unit(&value, 60, "&lt;")?;
    replace_unit(&value, 62, "&gt;")
}

fn is_wsl(root: &V) -> Result<bool, String> {
    let root = fallback_string(root);
    let normalized = replace_unit(&root, 92, "/")?;
    static WSL: OnceLock<regress::Regex> = OnceLock::new();
    let regex = WSL.get_or_init(|| {
        regress::Regex::with_flags(r"^//wsl[\$.](?:localhost)?/([^/]+)(/.*)", "i").unwrap()
    });
    Ok(regex.find_from_ucs2(normalized.units(), 0).next().is_some())
}

/// Roots and user name are snapshots supplied by the owning agent runtime.
pub fn build_system_prompt(
    model: &V,
    profile: Option<&V>,
    roots: &[V],
    user_name: &V,
    platform: &str,
) -> Result<V, String> {
    let profile = profile.filter(|p| p.truthy());
    let cwd = roots.first().cloned().unwrap_or_else(|| "(없음)".into());
    let wsl = match roots.first() {
        Some(root) => is_wsl(root)?,
        None => false,
    };
    let shell = if wsl || platform != "win32" {
        "bash (Linux/WSL)"
    } else {
        "Windows cmd"
    };
    let mut persona = Vec::new();
    if let Some(profile) = profile {
        append(&mut persona, "너는 콕핏 주식회사 ");
        persona.extend_from_slice(property_string(profile, "rank")?.units());
        append(&mut persona, " \"");
        persona.extend_from_slice(property_string(profile, "name")?.units());
        append(&mut persona, "\"이야.");
        if let Some(team) = team(profile) {
            append(&mut persona, "\n소속: ");
            persona.extend_from_slice(string(&team["name"])?.units());
            append(&mut persona, " (");
            persona.extend_from_slice(string(&team["icon"])?.units());
            append(&mut persona, ")\n사용 가능 도구: ");
            append(&mut persona, &agent_tools(Some(profile)).join(", "));
        }
        persona.push(10);
        persona.extend_from_slice(property_string(profile, "persona")?.units());
        append(&mut persona, "\n사용자(대표)의 이름은 \"");
        let boss = if user_name.truthy() {
            string(user_name)?
        } else {
            "대표".into()
        };
        persona.extend_from_slice(boss.units());
        append(&mut persona, "\"이야. \"");
        persona.extend_from_slice(boss.units());
        append(
            &mut persona,
            "님\" 또는 \"대표님\"으로 불러.\nJSON 출력에서 message 필드에만 너의 말투를 적용해.",
        );
    } else {
        append(&mut persona, "너는 콕핏 AI 비서 \"웰시콕이\" (웰시코기 강아지 캐릭터).\n코드 분석, 파일 관리, 유튜브, 웹 검색, 번역, 계산, 일반 지식 등 뭐든 도와줌.");
    }
    let asset = prompt_asset();
    let variant = if *model == V::from("pro") {
        "pro"
    } else {
        "flash"
    };
    let replacements = [
        ("@@COCKPIT_PERSONA@@", V::String(persona)),
        ("@@COCKPIT_SHELL@@", V::from(shell)),
        ("@@COCKPIT_CWD@@", string(&cwd)?),
        ("@@COCKPIT_VARIANT_0@@", asset["thinking"][variant].clone()),
        ("@@COCKPIT_VARIANT_1@@", asset["examples"][variant].clone()),
    ];
    // Read markers from the template once. User text containing a marker remains literal.
    let template = asset["template"].text();
    let mut remaining = template.as_str();
    let mut out = Vec::new();
    while let Some((offset, marker, value)) = replacements
        .iter()
        .filter_map(|(marker, value)| {
            remaining
                .find(marker)
                .map(|offset| (offset, *marker, value))
        })
        .min_by_key(|(offset, _, _)| *offset)
    {
        append(&mut out, &remaining[..offset]);
        out.extend_from_slice(value.units());
        remaining = &remaining[offset + marker.len()..];
    }
    append(&mut out, remaining);
    Ok(V::String(out))
}

fn length(value: &V) -> usize {
    match value {
        V::String(s) => s.len(),
        V::Array(a) => a.len(),
        _ => 0,
    }
}

fn property_length(value: &V) -> V {
    match value {
        V::String(_) | V::Array(_) => V::Number(length(value) as f64),
        _ => value["length"].clone(),
    }
}

fn join(parts: &[V], delimiter: &str) -> Result<V, String> {
    let mut out = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            append(&mut out, delimiter);
        }
        out.extend_from_slice(string(part)?.units());
    }
    Ok(V::String(out))
}

pub fn build_conversation_history(messages: &[V], max_chars: usize) -> Result<V, String> {
    let recent = &messages[messages.len().saturating_sub(15)..];
    if recent.is_empty() {
        return Ok("".into());
    }
    let mut parts = Vec::new();
    for message in recent {
        if *message == V::Null {
            return Err("Cannot read properties of null (reading 'role')".into());
        }
        let human = message["role"] == V::from("user");
        let content = slice(&fallback_string(&message["content"]), 3000)?;
        let safe = if human {
            escape_xml(&content)?
        } else {
            string(&content)?
        };
        let mut entry = Vec::new();
        append(
            &mut entry,
            if human { "[Human]\n" } else { "[Assistant]\n" },
        );
        entry.extend_from_slice(safe.units());
        let summary = &message["toolSummary"];
        if summary.truthy() && property_length(summary).truthy() {
            let V::Array(tools) = summary else {
                return Err("m.toolSummary.map is not a function".into());
            };
            append(&mut entry, "\n[사용한 도구]\n");
            for (index, tool) in tools.iter().enumerate() {
                if *tool == V::Null {
                    return Err("Cannot read properties of null (reading 'tool')".into());
                }
                if index > 0 {
                    entry.push(10);
                }
                append(&mut entry, "  ");
                entry.extend_from_slice(property_string(tool, "tool")?.units());
                append(&mut entry, ": ");
                entry.extend_from_slice(
                    string(&slice(&fallback_string(&tool["arg"]), 80)?)?.units(),
                );
            }
        }
        parts.push(V::String(entry));
    }
    let mut result = join(&parts, "\n\n")?;
    while result.units().len() > max_chars && parts.len() > 2 {
        parts.remove(0);
        result = join(&parts, "\n\n")?;
    }
    let mut out = Vec::new();
    append(&mut out, "\n\n---\n## Conversation History\n");
    out.extend_from_slice(result.units());
    append(&mut out, "\n---");
    Ok(V::String(out))
}

fn strict_equal(a: &V, b: &V) -> bool {
    match (a, b) {
        (V::Object(_), V::Object(_)) | (V::Array(_), V::Array(_)) => std::ptr::eq(a, b),
        _ => a == b,
    }
}

pub fn build_tool_log_string(tool_log: &[V]) -> Result<V, String> {
    if tool_log.is_empty() {
        return Ok("".into());
    }
    let mut out = Vec::new();
    append(&mut out, "\n\n## Tool Execution Log");
    let initial_turn = V::Number(-1.0);
    let mut last_turn = &initial_turn;
    let mut errors = 0;
    for entry in tool_log {
        if *entry == V::Null {
            return Err("Cannot read properties of null (reading 'turn')".into());
        }
        if entry.has("turn") && !strict_equal(&entry["turn"], last_turn) {
            last_turn = &entry["turn"];
            append(&mut out, "\n\n### Turn ");
            out.extend_from_slice(string(last_turn)?.units());
            if entry["thinking"].truthy() {
                append(&mut out, "\n> ");
                out.extend_from_slice(
                    replace_unit(&slice(&entry["thinking"], 500)?, 10, "\n> ")?.units(),
                );
            }
        }
        let result = fallback_string(&entry["result"]);
        let failed = text_units(&result, "startsWith")?.starts_with(&[69, 114, 114, 111, 114, 58]);
        if failed {
            errors += 1;
        }
        append(
            &mut out,
            if failed {
                "\n- [FAILED] **"
            } else {
                "\n- [OK] **"
            },
        );
        out.extend_from_slice(property_string(entry, "tool")?.units());
        append(&mut out, "**: ");
        out.extend_from_slice(string(&slice(&fallback_string(&entry["arg"]), 200)?)?.units());
        append(&mut out, "\n  Result: ");
        out.extend_from_slice(replace_unit(&entry["result"], 10, "\n  ")?.units());
    }
    append(
        &mut out,
        &format!(
            "\n\n**Summary**: {} tool calls ({} OK, {} failed). Turns completed: ",
            tool_log.len(),
            tool_log.len() - errors,
            errors
        ),
    );
    out.extend_from_slice(string(last_turn)?.units());
    out.push(46);
    Ok(V::String(out))
}

/// `system` is built once by `build_system_prompt`; team/project I/O stays outside.
pub fn assemble_prompt(
    project_context: &V,
    team_context: &V,
    messages: &[V],
    tool_log: &[V],
    force_finish: bool,
    system: &V,
) -> Result<V, String> {
    let tool_log = build_tool_log_string(tool_log)?;
    for value in [project_context, team_context, system] {
        text_units(value, "length")?;
    }
    let fixed_len = system
        .units()
        .len()
        .saturating_add(project_context.units().len())
        .saturating_add(team_context.units().len())
        .saturating_add(tool_log.units().len())
        .saturating_add(300);
    let budget = MAX_TOTAL_PROMPT_CHARS.saturating_sub(fixed_len).max(3000);
    let history = build_conversation_history(messages, budget)?;
    let mut user = Vec::new();
    for value in [project_context, team_context, &history, &tool_log] {
        user.extend_from_slice(value.units());
    }
    append(
        &mut user,
        if force_finish {
            "\n\n---\n**INSTRUCTION**: 최대 반복 횟수 도달. 도구 없이 JSON 최종 답변:\n{\"thinking\":\"[상황] ...\\n[결과] ...\",\"message\":\"1. 수행 작업 요약\\n2. 발견 내용\\n3. 미완료 항목\",\"tool_calls\":[],\"is_final\":true}"
        } else {
            "\n\n---\n**INSTRUCTION**: 위 대화/도구결과 기반으로 답변. 출력: JSON 객체 1개만 (첫 글자 {, 마지막 }). thinking에서 [상황][판단][계획] 구조로 추론 후 행동 결정."
        },
    );
    Ok(object([
        ("system", system.clone()),
        ("user", V::String(user)),
    ]))
}

pub fn summarize_tool_result(tool: &V, result: &V) -> Result<V, String> {
    if !result.truthy() {
        return Ok("(빈 결과)".into());
    }
    if *tool == V::from("READ") {
        let lines: Vec<V> = text_units(result, "split")?
            .split(|unit| *unit == 10)
            .map(|line| V::String(line.to_vec()))
            .collect();
        if lines.len() <= 8 {
            return slice(result, 200);
        }
        let mut out = Vec::new();
        append(&mut out, &format!("({}줄)\n", lines.len()));
        out.extend_from_slice(join(&lines[..3], "\n")?.units());
        append(&mut out, "\n...\n");
        out.extend_from_slice(join(&lines[lines.len() - 3..], "\n")?.units());
        return Ok(V::String(out));
    }
    if *tool == V::from("SEARCH") || *tool == V::from("GLOB") {
        let items: Vec<V> = text_units(result, "split")?
            .split(|unit| *unit == 10)
            .filter(|item| !item.is_empty())
            .map(|item| V::String(item.to_vec()))
            .collect();
        if items.len() <= 5 {
            return slice(result, 200);
        }
        let mut out = Vec::new();
        append(&mut out, &format!("({}건)\n", items.len()));
        out.extend_from_slice(join(&items[..5], "\n")?.units());
        append(&mut out, "\n...");
        return Ok(V::String(out));
    }
    let result_slice = slice(result, 200)?;
    if *tool == V::from("EDIT") {
        return Ok(result_slice);
    }
    let mut out = string(&result_slice)?.units().to_vec();
    if length(result) > 200 {
        append(&mut out, "...");
    }
    Ok(V::String(out))
}

fn add(a: &V, b: &V) -> Result<V, String> {
    let primitive = |value: &V| match value {
        V::Object(_) | V::Array(_) => string(value),
        _ => Ok(value.clone()),
    };
    let a = primitive(a)?;
    let b = primitive(b)?;
    if a.is_string() || b.is_string() {
        let mut out = string(&a)?.units().to_vec();
        out.extend_from_slice(string(&b)?.units());
        Ok(V::String(out))
    } else {
        Ok(V::Number(a.number() + b.number()))
    }
}

fn log_chars(log: &[V]) -> Result<f64, String> {
    let total = log.iter().try_fold(V::Number(0.0), |mut sum, entry| {
        if *entry == V::Null {
            return Err("Cannot read properties of null (reading 'thinking')".into());
        }
        for field in ["thinking", "arg", "result"] {
            let length = property_length(&entry[field]);
            sum = add(
                &sum,
                &if length.truthy() {
                    length
                } else {
                    V::Number(0.0)
                },
            )?;
        }
        add(&sum, &V::Number(50.0))
    })?;
    Ok(total.number())
}

pub fn trim_tool_log(tool_log: &mut Vec<V>) -> Result<(), String> {
    let mut total_chars = log_chars(tool_log)?;
    while total_chars > MAX_TOOL_LOG_CHARS as f64 && tool_log.len() > KEEP_RECENT_TOOL_ENTRIES + 1 {
        let entry = &tool_log[0];
        let mut summarized = object([
            ("thinking", "".into()),
            ("arg", slice(&entry["arg"], 100)?),
            (
                "result",
                summarize_tool_result(&entry["tool"], &entry["result"])?,
            ),
        ]);
        if entry.has("tool") {
            summarized["tool"] = entry["tool"].clone();
        }
        tool_log[0] = summarized;
        total_chars = log_chars(tool_log)?;
        if total_chars > MAX_TOOL_LOG_CHARS as f64 && tool_log.len() > KEEP_RECENT_TOOL_ENTRIES + 1
        {
            tool_log.remove(0);
            total_chars = log_chars(tool_log)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_aliases_and_ordered_tools() {
        assert_eq!(profile("sawon"), profile("dev_sawon"));
        assert_eq!(agent_tools(profile("intern")), INTERN_TOOLS);
        assert_eq!(agent_tools(profile("daepyo")), ALL_TOOLS);
        let tools = agent_tools(profile("design_daeri"));
        assert_eq!(tools.iter().filter(|tool| *tool == "OPEN").count(), 1);
        assert_eq!(
            &tools[tools.len() - 3..],
            ["WEATHER", "DELEGATE", "CONSULT"]
        );
    }

    #[test]
    fn system_prompt_platform_variants_and_literal_markers() {
        let name = V::String(vec![0xd800, 65]);
        let system = build_system_prompt(
            &"pro".into(),
            profile("dev_sawon"),
            &["/tmp/@@COCKPIT_VARIANT_1@@".into()],
            &name,
            "linux",
        )
        .unwrap();
        assert!(system.text().contains("# 9. EXAMPLES"));
        assert!(system.text().contains("cwd: /tmp/@@COCKPIT_VARIANT_1@@"));
        assert!(system.units().windows(2).any(|units| units == [0xd800, 65]));
        let windows = build_system_prompt(
            &"flash".into(),
            None,
            &["C:\\project".into()],
            &"".into(),
            "win32",
        )
        .unwrap();
        assert!(windows
            .text()
            .contains("환경: Windows cmd, cwd: C:\\project"));
        let wsl = build_system_prompt(
            &"flash".into(),
            None,
            &["\\\\wsl$\\Ubuntu\\project".into()],
            &"".into(),
            "win32",
        )
        .unwrap();
        assert!(wsl.text().contains("환경: bash (Linux/WSL)"));
    }

    #[test]
    fn history_escapes_users_and_keeps_two_messages_over_budget() {
        let messages: Vec<V> = (0..16)
            .map(|i| {
                object([
                    (
                        "role",
                        if i % 2 == 0 {
                            "user".into()
                        } else {
                            "assistant".into()
                        },
                    ),
                    ("content", format!("{i}<&>").into()),
                ])
            })
            .collect();
        let history = build_conversation_history(&messages, 0).unwrap().text();
        assert!(history.contains("14&lt;&amp;&gt;"));
        assert!(history.contains("15<&>"));
        assert!(!history.contains("13"));
        let long = object([
            ("role", "assistant".into()),
            (
                "content",
                V::String([vec![65; 2999], vec![0xd83d, 0xde00]].concat()),
            ),
        ]);
        let result = build_conversation_history(&[long], 15000).unwrap();
        assert!(result.units().contains(&0xd83d));
        assert!(!result.units().contains(&0xde00));
    }

    #[test]
    fn log_turns_failures_and_utf16_summary() {
        let log = vec![
            object([
                ("turn", 1.0.into()),
                ("tool", "READ".into()),
                ("arg", "a".into()),
                ("result", "first\nsecond".into()),
                ("thinking", "a\nb".into()),
            ]),
            object([
                ("turn", 1.0.into()),
                ("tool", "READ".into()),
                ("arg", "b".into()),
                ("result", "Error: missing".into()),
            ]),
        ];
        let result = build_tool_log_string(&log).unwrap().text();
        assert_eq!(result.matches("### Turn 1").count(), 1);
        assert!(result.contains("> a\n> b"));
        assert!(result.contains("Result: first\n  second"));
        assert!(result.ends_with("2 tool calls (1 OK, 1 failed). Turns completed: 1."));
        let units = V::String([vec![65; 199], vec![0xd83d, 0xde00]].concat());
        let summary = summarize_tool_result(&"BASH".into(), &units).unwrap();
        assert_eq!(&summary.units()[199..], &[0xd83d, 46, 46, 46]);
    }

    #[test]
    fn trimming_matches_keep_recent_and_drops_old_turn() {
        let mut log: Vec<V> = (0..6)
            .map(|i| {
                object([
                    ("turn", (i as f64).into()),
                    ("thinking", "think".into()),
                    ("tool", "BASH".into()),
                    ("arg", "a".repeat(200).into()),
                    ("result", "r".repeat(5000).into()),
                ])
            })
            .collect();
        let recent = log[3..].to_vec();
        trim_tool_log(&mut log).unwrap();
        assert_eq!(&log[log.len() - 3..], &recent);
        assert!(!log[0].has("turn"));
        assert!(log_chars(&log).unwrap() <= 25000.0);
    }

    #[test]
    fn assembly_keeps_minimum_history_budget_and_force_instruction() {
        let system = V::from("s".repeat(55000));
        let messages: Vec<V> = (0..4)
            .map(|_| {
                object([
                    ("role", "user".into()),
                    ("content", "m".repeat(3000).into()),
                ])
            })
            .collect();
        let prompt = assemble_prompt(
            &"project".into(),
            &"team".into(),
            &messages,
            &[],
            true,
            &system,
        )
        .unwrap();
        assert_eq!(prompt["system"], system);
        assert!(prompt["user"]
            .text()
            .starts_with("projectteam\n\n---\n## Conversation History"));
        assert_eq!(prompt["user"].text().matches("[Human]").count(), 2);
        assert!(prompt["user"].text().ends_with("\"is_final\":true}"));
        assert!(build_conversation_history(&[object([("content", true.into())])], 15_000).is_err());
    }
}
