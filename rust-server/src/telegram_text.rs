//! Pure Telegram text formatting over caller-provided snapshots.
use crate::{agent_prompt, autonomy_schedule, board_value::V};
use std::sync::OnceLock;

fn string(value: &V) -> V {
    // Malformed objects with an unusable toString cannot become useful context.
    agent_prompt::string(value).unwrap_or_else(|_| "***".into())
}
fn property(value: &V, key: &str) -> V {
    agent_prompt::property_string(value, key).unwrap_or_else(|_| "***".into())
}
fn fallback(value: &V, otherwise: &str) -> V {
    if value.truthy() {
        string(value)
    } else {
        otherwise.into()
    }
}
fn join(values: &[V], separator: &str) -> V {
    let mut out = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.extend(separator.encode_utf16());
        }
        out.extend_from_slice(string(value).units());
    }
    V::String(out)
}
fn cat(values: &[V]) -> V {
    join(values, "")
}
fn slice(value: &V, start: usize, end: usize) -> V {
    let value = string(value);
    let start = start.min(value.units().len());
    let end = end.min(value.units().len()).max(start);
    V::String(value.units()[start..end].to_vec())
}

fn replace(input: &[u16], regex: &regress::Regex, replacement: &str) -> Vec<u16> {
    let mut out = Vec::new();
    let mut end = 0;
    for found in regex.find_from_ucs2(input, 0) {
        out.extend_from_slice(&input[end..found.range.start]);
        let bytes = replacement.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'$' && index + 1 < bytes.len() && bytes[index + 1].is_ascii_digit()
            {
                if let Some(Some(range)) = found.captures.get((bytes[index + 1] - b'1') as usize) {
                    out.extend_from_slice(&input[range.clone()]);
                }
                index += 2;
            } else {
                out.push(bytes[index] as u16);
                index += 1;
            }
        }
        end = found.range.end;
    }
    out.extend_from_slice(&input[end..]);
    out
}

/// Keep the original patterns, replacement order, UTF-16 and falsy semantics.
pub fn mask(value: &V) -> V {
    if !value.truthy() {
        return value.clone();
    }
    static RULES: OnceLock<Vec<(regress::Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| [
        (r#"([A-Z_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|KEY|PWD|API_KEY)[A-Z_]*\s*[:=]\s*)['"]?([^'"\s]{4,})"#, "i", "$1***"),
        (r"AKIA[A-Z0-9]{16,}", "", "AKIA***"),
        (r"aws_secret_access_key\s*=\s*\S+", "i", "aws_secret_access_key=***"),
        (r"sk-ant-[A-Za-z0-9_-]{20,}", "", "sk-ant-***"),
        (r"sk-[A-Za-z0-9_-]{20,}", "", "sk-***"),
        (r"AIza[A-Za-z0-9_-]{20,}", "", "AIza***"),
        (r"ya29\.[A-Za-z0-9_-]+", "", "ya29.***"),
        (r"gh[pousr]_[A-Za-z0-9]{20,}", "", "gh*_***"),
        (r"glpat-[A-Za-z0-9_-]{20,}", "", "glpat-***"),
        (r"Bearer\s+[A-Za-z0-9._-]{20,}", "i", "Bearer ***"),
        (r"eyJ[A-Za-z0-9._-]{20,}", "", "eyJ***"),
        (r"(postgres(?:ql)?|mysql|mongodb)(\+srv)?://[^:]+:[^@]+@", "i", "$1$2://***:***@"),
    ].into_iter().map(|(pattern, flags, replacement)| (regress::Regex::with_flags(pattern, flags).unwrap(), replacement)).collect());
    let mut out = string(value).units().to_vec();
    for (regex, replacement) in rules {
        out = replace(&out, regex, replacement);
    }
    V::String(out)
}

pub fn time_ago(value: &V, now: i64) -> String {
    if !value.truthy() {
        return "?".into();
    }
    let Some(timestamp) = autonomy_schedule::date(value).ok().flatten() else {
        return "?".into();
    };
    let minutes = ((now as f64 - timestamp as f64) / 60_000.0).floor();
    if minutes < 1.0 {
        return "방금".into();
    }
    if minutes < 60.0 {
        return format!("{minutes}분 전");
    }
    let hours = (minutes / 60.0).floor();
    if hours < 24.0 {
        return format!("{hours}시간 전");
    }
    format!("{}일 전", (hours / 24.0).floor())
}

pub fn duration(text: &str) -> f64 {
    static DURATION: OnceLock<regress::Regex> = OnceLock::new();
    let regex = DURATION.get_or_init(|| regress::Regex::new(r"(\d+)\s*(h|m|s)").unwrap());
    let units: Vec<u16> = text.encode_utf16().collect();
    regex
        .find_from_ucs2(&units, 0)
        .map(|found| {
            let amount = String::from_utf16_lossy(&units[found.captures[0].clone().unwrap()])
                .parse::<f64>()
                .unwrap_or(f64::INFINITY);
            let unit = units[found.captures[1].clone().unwrap()][0];
            amount
                * match unit {
                    104 => 3_600_000.0,
                    109 => 60_000.0,
                    _ => 1000.0,
                }
        })
        .sum()
}

fn round(number: f64) -> f64 {
    let floor = number.floor();
    if number - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}
fn number(value: f64) -> String {
    string(&value.into()).text()
}
pub fn remaining(ms: f64) -> String {
    if ms < 60_000.0 {
        return format!("{}초", number(round(ms / 1000.0)));
    }
    if ms < 3_600_000.0 {
        return format!("{}분", number(round(ms / 60_000.0)));
    }
    let hours = (ms / 3_600_000.0).floor();
    let minutes = round((ms % 3_600_000.0) / 60_000.0);
    if minutes != 0.0 && !minutes.is_nan() {
        format!("{}시간 {}분", number(hours), number(minutes))
    } else {
        format!("{}시간", number(hours))
    }
}

pub fn help() -> String {
    [
        "🤖 <b>Cockpit 봇</b>",
        "",
        "<b>━ 모드 ━</b>",
        "/status — 모드 + 신뢰 + focus + todo 상태",
        "/here /away — 자리 모드",
        "/trust 30m /untrust — 신뢰 모드 (위험 자동, hard 만 묻기)",
        "",
        "<b>━ Sticky ━</b>",
        "/focus &lt;project&gt; — 이후 \"그거\" = focus 프로젝트",
        "/unfocus — 해제",
        "",
        "<b>━ Backlog ━</b>",
        "/todo add &lt;text&gt; — 추가",
        "/todo list — 미완료 목록",
        "/todo done N — 완료 처리",
        "/todo next — 다음 거 바로 콕사원에 위임",
        "",
        "<b>━ 자율 스케줄 ━</b>",
        "/schedule add \"09:00 daily\" \"프롬프트\"",
        "/schedule list /remove ID /run ID /toggle ID",
        "",
        "<b>━ 조회 (즉답, 토큰 0) ━</b>",
        "/history [N] /decisions [N] /approvals [N]",
        "/terminals /projects /log [N] /agents /diag",
        "",
        "<b>━ 기타 ━</b>",
        "/new /help",
        "",
        "그 외 자유 텍스트 → 콕사원 (Gemini Flash) 가 처리.",
        "예: \"기획팀 박기리 불러\", \"tire-auction 푸시해\", \"그거 어떻게 됐어?\"",
    ]
    .join("\n")
}

/// Snapshot arrays contain projects with cached session/git, todos, decisions and
/// terminals with their buffers. Missing decisions means no supervisor service;
/// an empty decisions array still renders its mode and pending state.
pub fn context(snapshot: &V, now: i64) -> V {
    let mut lines = Vec::<V>::new();
    let focus = &snapshot["focus"];
    let todos: Vec<_> = snapshot["todos"]
        .array()
        .iter()
        .filter(|todo| todo["status"] == V::from("pending"))
        .collect();
    if focus.truthy() || !todos.is_empty() {
        lines.push("[현재 sticky 상태]".into());
        if focus.truthy() {
            lines.push(cat(&["🎯 현재 focus: ".into(), string(focus)]));
        }
        if let Some(todo) = todos.first() {
            lines.push(cat(&[
                format!("📋 미완료 todo {}건 (next: \"", todos.len()).into(),
                mask(&todo["text"]).cut(60),
                "\")".into(),
            ]));
        }
        if focus.truthy() {
            lines.push(cat(&[
                "참고: \"그거\", \"그 프로젝트\" 등 모호한 표현은 우선적으로 \"".into(),
                string(focus),
                "\" 로 해석.".into(),
            ]));
        }
        lines.push("".into());
    }
    let projects = snapshot["projects"].array();
    if !projects.is_empty() {
        lines.push("[Cockpit 프로젝트]".into());
        for project in projects {
            let session = &project["session"];
            let git = &project["git"];
            let state = if session["state"].is_string() {
                session["state"].text()
            } else {
                String::new()
            };
            let icon = match state.as_str() {
                "active" | "busy" => "🟢",
                "waiting" => "🟠",
                "idle" => "⚪",
                "paused" => "⏸",
                _ => "·",
            };
            let mut parts = vec![cat(&[format!("{icon} ").into(), property(project, "name")])];
            if session["state"].truthy() {
                parts.push(string(&session["state"]));
            }
            if session["sessionCount"] != V::Null {
                parts.push(cat(&["세션 ".into(), string(&session["sessionCount"])]));
            }
            if session["lastActivity"].truthy() {
                parts.push(format!("최근 {}", time_ago(&session["lastActivity"], now)).into());
            }
            if git["branch"].truthy() {
                parts.push(cat(&["branch ".into(), string(&git["branch"])]));
            }
            if git["uncommittedCount"].truthy() {
                parts.push(cat(&[
                    "uncommitted ".into(),
                    string(&git["uncommittedCount"]),
                ]));
            }
            lines.push(cat(&["- ".into(), join(&parts, " · ")]));
        }
    }
    if snapshot.has("decisions") {
        let recent = snapshot["decisions"].array();
        let last_hour: Vec<_> = recent[recent.len().saturating_sub(100)..]
            .iter()
            .filter(|decision| {
                let timestamp = if decision["ts"].truthy() {
                    decision["ts"].clone()
                } else {
                    0.0.into()
                };
                autonomy_schedule::date(&timestamp)
                    .ok()
                    .flatten()
                    .is_some_and(|timestamp| now as f64 - (timestamp as f64) < 3_600_000.0)
            })
            .collect();
        let blocked: Vec<_> = last_hour
            .iter()
            .copied()
            .filter(|d| d["decision"] == V::from("block") || d["decision"] == V::from("deny"))
            .collect();
        let asked: Vec<_> = last_hour
            .iter()
            .copied()
            .filter(|d| d["decision"] == V::from("ask"))
            .collect();
        let approved = last_hour
            .iter()
            .filter(|d| d["decision"] == V::from("approve"))
            .count();
        let pending = fallback(&snapshot["pending"], "0");
        lines.push("".into());
        lines.push(
            format!(
                "[Supervisor — 모드: {}]",
                if snapshot["mode"] == V::from("away") {
                    "🚶 AWAY"
                } else {
                    "🏠 HERE"
                }
            )
            .into(),
        );
        lines.push(cat(&[
            format!(
                "최근 1시간: 자동 {approved}건 통과, 차단 {}건, 사람 대기 ",
                blocked.len()
            )
            .into(),
            pending.clone(),
            "건".into(),
        ]));
        if pending.number() > 0.0 {
            lines.extend(["".into(), "⚠️ 사용자 답변 대기 중 — 답해주세요.".into()]);
        }
        for (decisions, limit, heading, reasons) in [
            (&blocked, 5, "🔴 차단된 작업 (사용자 알 가치 있음):", true),
            (&asked, 3, "🟡 사람 결정 거친 작업:", false),
        ] {
            if decisions.is_empty() {
                continue;
            }
            lines.extend(["".into(), heading.into()]);
            for decision in decisions.iter().rev().take(limit) {
                let input = &decision["input"];
                let what = if input["command"].truthy() {
                    &input["command"]
                } else {
                    &input["file_path"]
                };
                let what = mask(&fallback(what, "")).cut(80);
                let timestamp = slice(&fallback(&decision["ts"], ""), 11, 19);
                lines.push(cat(&[
                    "  ".into(),
                    timestamp,
                    " ".into(),
                    fallback(&decision["tool"], "?"),
                    ": ".into(),
                    what,
                ]));
                let reason = mask(&fallback(&decision["reasoning"], "")).cut(100);
                if reasons && reason.truthy() {
                    lines.push(cat(&["     이유: ".into(), reason]));
                }
            }
        }
        lines.extend([
            "".into(),
            "※ approve는 통상 사용자가 시킨 일이라 상세 생략. 위 차단/대기가 중요.".into(),
        ]);
    }
    let terminals = snapshot["terminals"].array();
    if !terminals.is_empty() {
        lines.extend(["".into(), "[터미널 작업판]".into()]);
        static CSI: OnceLock<regress::Regex> = OnceLock::new();
        static OSC: OnceLock<regress::Regex> = OnceLock::new();
        let csi = CSI.get_or_init(|| regress::Regex::new(r"\x1B\[[0-9;]*[A-Za-z]").unwrap());
        let osc = OSC.get_or_init(|| regress::Regex::new(r"\x1B\][^\x07]*\x07").unwrap());
        for terminal in terminals {
            let project = projects
                .iter()
                .rev()
                .find(|project| property(project, "id") == property(terminal, "projectId"));
            let name = project
                .map(|project| &project["name"])
                .filter(|name| name.truthy())
                .map(string)
                .unwrap_or_else(|| fallback(&terminal["projectId"], "?"));
            lines.push(cat(&[
                "- [".into(),
                property(terminal, "termId"),
                "] ".into(),
                name,
                " · cmd: ".into(),
                mask(&fallback(&terminal["command"], "(shell)")),
            ]));
            if terminal["buffer"].truthy() {
                let buffer = string(&terminal["buffer"]);
                let clean = V::String(replace(&replace(buffer.units(), csi, ""), osc, "")).trim();
                let masked = mask(&clean);
                let split: Vec<_> = masked.units().split(|unit| *unit == 10).collect();
                let last_lines: Vec<_> = split[split.len().saturating_sub(6)..]
                    .iter()
                    .map(|line| V::String(line.to_vec()))
                    .collect();
                let tail = join(&last_lines, "\n");
                let tail = slice(
                    &tail,
                    tail.units().len().saturating_sub(400),
                    tail.units().len(),
                );
                if tail.truthy() {
                    lines.push("  최근 출력:".into());
                    for line in tail.units().split(|unit| *unit == 10) {
                        lines.push(cat(&["    ".into(), V::String(line.to_vec())]));
                    }
                }
            }
        }
    }
    if lines.is_empty() {
        return V::Null;
    }
    lines.extend(["".into(), "위 현황을 참고해 답하세요. \"그 세션\", \"방금 거\" 같은 표현은 작업판에서 매핑. 정보 없으면 모른다고 말하고 추측 금지.".into()]);
    mask(&join(&lines, "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board_value::object;

    #[test]
    fn source_fixtures_preserve_formatting_and_document_context_corrections() {
        let raw = serde_json::value::RawValue::from_string(
            include_str!("../../tests/fixtures/rust-telegram-text.json").into(),
        )
        .unwrap();
        let fixtures = V::parse(&raw).unwrap();
        assert_eq!(fixtures.array().len(), 194);
        for (index, fixture) in fixtures.array().iter().enumerate() {
            let input = &fixture["input"];
            let now = input["now"].number() as i64;
            let actual = match input["action"].text().as_str() {
                "mask" => mask(&input["value"]),
                "duration" => {
                    let value = duration(&input["value"].text());
                    if value.is_finite() {
                        value.into()
                    } else {
                        object([("nonFinite", number(value).into())])
                    }
                }
                "remaining" => remaining(input["value"].number()).into(),
                "timeAgo" => time_ago(&input["value"], now).into(),
                "help" => help().into(),
                "context" => context(&input["snapshot"], now),
                _ => panic!("unknown fixture action"),
            };
            assert_eq!(actual, fixture["expected"], "Telegram text fixture {index}");
        }
    }

    #[test]
    fn preserves_falsy_values_and_lone_surrogates_during_masking() {
        for value in [V::Null, false.into(), 0.0.into(), "".into()] {
            assert_eq!(mask(&value), value);
        }
        let mut units = vec![0xd800];
        units.extend(" TOKEN=synthetic-secret ".encode_utf16());
        units.push(0xdc00);
        let masked = mask(&V::String(units));
        assert_eq!(masked.units().first(), Some(&0xd800));
        assert_eq!(masked.units().last(), Some(&0xdc00));
        assert!(masked.text().contains("TOKEN=***"));
    }

    #[test]
    fn context_masks_before_truncation_and_marks_busy_waiting() {
        let token = format!("sk-{}", "a".repeat(30));
        let snapshot = object([
            (
                "todos",
                V::Array(vec![object([
                    ("status", "pending".into()),
                    ("text", format!("{} {token}", "x".repeat(55)).into()),
                ])]),
            ),
            (
                "projects",
                V::Array(vec![
                    object([
                        ("name", "busy project".into()),
                        ("session", object([("state", "busy".into())])),
                    ]),
                    object([
                        ("name", "waiting project".into()),
                        ("session", object([("state", "waiting".into())])),
                    ]),
                ]),
            ),
        ]);
        let text = context(&snapshot, 0).text();
        assert!(text.contains("🟢 busy project · busy"));
        assert!(text.contains("🟠 waiting project · waiting"));
        assert!(!text.contains("sk-a"));
        assert!(!text.contains(&token));
    }
}
/// Presence phrases take precedence over replies to pending questions.
pub fn presence(message: &str) -> Option<&'static str> {
    use std::sync::LazyLock;
    static AWAY: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)(자리\s*비움|자리\s*비울|나갔|밖에|밖\s*나|away|회의|잘게|잘\s*거|자러|밤이|퇴근|외출)").unwrap()
    });
    static HERE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)(왔어|돌아왔|돌아옴|복귀|일어났|기상|here\b|자리\s*있|작업\s*시작|시작할|이제\s*있)").unwrap()
    });
    if message.starts_with('/') {
        None
    } else if AWAY.is_match(message) {
        Some("away")
    } else if HERE.is_match(message) {
        Some("here")
    } else {
        None
    }
}
