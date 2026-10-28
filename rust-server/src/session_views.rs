//! Pure projections of Claude JSONL entries used by the session HTTP views.
use crate::board_value::{object, V};
use regex::Regex;
use std::sync::LazyLock;

fn eq(value: &V, text: &str) -> bool {
    value == &V::from(text)
}
fn fallback(value: &V, other: V) -> V {
    if value.truthy() {
        value.clone()
    } else {
        other
    }
}
fn copy_field(target: &mut V, source: &V, key: &str) {
    if source.has(key) {
        target[key] = source[key].clone();
    }
}
fn string(value: &V) -> V {
    match value {
        V::String(_) => value.clone(),
        V::Array(items) => join(items, ","),
        _ => V::from(value.text()),
    }
}
fn join(items: &[V], separator: &str) -> V {
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if index != 0 {
            out.extend(separator.encode_utf16());
        }
        if !matches!(item, V::Null) {
            out.extend(string(item).units());
        }
    }
    V::String(out)
}
fn add(left: V, right: V) -> V {
    let primitive = |v: V| {
        if matches!(v, V::Array(_) | V::Object(_)) {
            string(&v)
        } else {
            v
        }
    };
    let (left, right) = (primitive(left), primitive(right));
    if left.is_string() || right.is_string() {
        V::String([string(&left).units(), string(&right).units()].concat())
    } else {
        V::Number(left.number() + right.number())
    }
}
fn number_text(n: f64) -> String {
    if !n.is_finite() {
        return "null".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    if n.abs() >= 1e21 || n.abs() < 1e-6 {
        let text = format!("{n:e}");
        let (base, exponent) = text.split_once('e').unwrap();
        let exponent: i32 = exponent.parse().unwrap();
        format!("{base}e{exponent:+}")
    } else {
        n.to_string()
    }
}
// V objects have already lost JSON source insertion order. All other JSON
// stringification details here retain UTF-16 strings and JavaScript numbers.
fn stringify(value: &V) -> String {
    match value {
        V::Number(n) => number_text(*n),
        V::Array(items) => format!(
            "[{}]",
            items.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        V::Object(fields) => format!(
            "{{{}}}",
            fields
                .iter()
                .map(|(key, value)| format!(
                    "{}:{}",
                    V::from(key.clone()).raw().get(),
                    stringify(value)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.raw().get().to_owned(),
    }
}
fn input_text(value: &V, limit: usize) -> V {
    V::from(stringify(&fallback(value, V::object()))).cut(limit)
}
fn short_model(value: &V) -> V {
    let mut units = value.units().to_vec();
    let prefix: Vec<_> = "claude-".encode_utf16().collect();
    if let Some(index) = units.windows(prefix.len()).position(|part| part == prefix) {
        units.drain(index..index + prefix.len());
    }
    if units.len() >= 9
        && units[units.len() - 9] == b'-' as u16
        && units[units.len() - 8..]
            .iter()
            .all(|c| (48..=57).contains(c))
    {
        units.truncate(units.len() - 9);
    }
    V::String(units)
}

/// The source readSessionMessages defaults to the last 200 messages.
pub fn messages(entries: impl IntoIterator<Item = impl std::borrow::Borrow<V>>) -> V {
    let mut output = std::collections::VecDeque::new();
    for entry in entries {
        let entry = std::borrow::Borrow::borrow(&entry);
        let message = &entry["message"];
        let content = &message["content"];
        if eq(&entry["type"], "user") {
            let text = if content.is_string() {
                content.clone()
            } else {
                join(
                    &content
                        .array()
                        .iter()
                        .filter(|b| eq(&b["type"], "text"))
                        .map(|b| b["text"].clone())
                        .collect::<Vec<_>>(),
                    "\n",
                )
            };
            if text.truthy() {
                let mut out = object([("role", V::from("user")), ("content", text.cut(3000))]);
                if entry.has("timestamp") {
                    out["ts"] = entry["timestamp"].clone();
                }
                output.push_back(out);
            }
        } else if eq(&entry["type"], "assistant") {
            let mut texts = Vec::new();
            let mut tools = Vec::new();
            if content.is_string() {
                texts.push(content.clone());
            }
            for block in content.array() {
                if eq(&block["type"], "text") && block["text"].truthy() {
                    texts.push(block["text"].clone());
                } else if eq(&block["type"], "tool_use") {
                    let mut tool = object([("input", input_text(&block["input"], 500))]);
                    copy_field(&mut tool, block, "name");
                    tools.push(tool);
                }
            }
            if !texts.is_empty() || !tools.is_empty() {
                let mut out = object([
                    ("role", V::from("assistant")),
                    ("content", join(&texts, "\n").cut(5000)),
                ]);
                if !tools.is_empty() {
                    out["tools"] = V::Array(tools);
                }
                if message["model"] != V::Null {
                    out["model"] = short_model(&message["model"]);
                }
                if entry.has("timestamp") {
                    out["ts"] = entry["timestamp"].clone();
                }
                output.push_back(out);
            }
        }
        if output.len() > 200 {
            output.pop_front();
        }
    }
    V::Array(output.into_iter().collect())
}

fn image(source: &V, label: bool) -> Option<V> {
    let mut part = object([("kind", V::from("image"))]);
    if eq(&source["type"], "base64") {
        copy_field(&mut part, source, "media_type");
        copy_field(&mut part, source, "data");
    } else if eq(&source["type"], "url") {
        copy_field(&mut part, source, "url");
    } else {
        return None;
    }
    if label {
        part["label"] = V::from("tool image");
    }
    Some(part)
}

/// Route projection; the caller adds the chosen file's session and mtime.
pub fn chat(entries: impl IntoIterator<Item = impl std::borrow::Borrow<V>>) -> V {
    let (mut tokens_in, mut tokens_out, mut model) = (V::Number(0.0), V::Number(0.0), V::from(""));
    let mut output = Vec::new();
    for entry in entries {
        let entry = std::borrow::Borrow::borrow(&entry);
        if !eq(&entry["type"], "user") && !eq(&entry["type"], "assistant") {
            continue;
        }
        let message = &entry["message"];
        let usage = &message["usage"];
        if usage.truthy() {
            tokens_in = add(
                tokens_in,
                add(
                    fallback(&usage["input_tokens"], V::Number(0.0)),
                    fallback(&usage["cache_creation_input_tokens"], V::Number(0.0)),
                ),
            );
            tokens_out = add(
                tokens_out,
                fallback(&usage["output_tokens"], V::Number(0.0)),
            );
        }
        if message["model"].truthy() && !model.truthy() {
            model = message["model"].clone();
        }
        let content = &message["content"];
        let mut parts = Vec::new();
        if content.is_string() {
            parts.push(object([
                ("kind", V::from("text")),
                ("text", content.clone()),
            ]));
        }
        for item in content.array() {
            if eq(&item["type"], "text") || eq(&item["type"], "thinking") {
                let thinking = eq(&item["type"], "thinking");
                parts.push(object([
                    ("kind", item["type"].clone()),
                    (
                        "text",
                        fallback(
                            &item[if thinking { "thinking" } else { "text" }],
                            V::from(""),
                        ),
                    ),
                ]));
            } else if eq(&item["type"], "tool_use") {
                let mut part = object([
                    ("kind", V::from("tool_use")),
                    ("input", fallback(&item["input"], V::object())),
                ]);
                copy_field(&mut part, item, "name");
                copy_field(&mut part, item, "id");
                parts.push(part);
            } else if eq(&item["type"], "tool_result") {
                let mut part = object([("kind", V::from("tool_result"))]);
                copy_field(&mut part, item, "tool_use_id");
                if item["content"].is_array() {
                    let mut flat = Vec::new();
                    for sub in item["content"].array() {
                        if eq(&sub["type"], "image") && sub["source"].truthy() {
                            if let Some(part) = image(&sub["source"], true) {
                                parts.push(part);
                            }
                        } else if eq(&sub["type"], "text") {
                            flat.push(fallback(&sub["text"], V::from("")));
                        } else if sub.is_string() && sub.truthy() {
                            flat.push(sub.clone());
                        }
                    }
                    if !flat.is_empty() {
                        part["content"] = join(&flat, "\n");
                        parts.push(part);
                    }
                } else {
                    copy_field(&mut part, item, "content");
                    parts.push(part);
                }
            } else if eq(&item["type"], "image") && item["source"].truthy() {
                if let Some(part) = image(&item["source"], false) {
                    parts.push(part);
                }
            }
        }
        if !parts.is_empty() {
            output.push(object([
                ("role", entry["type"].clone()),
                (
                    "ts",
                    fallback(&entry["timestamp"], fallback(&entry["createdAt"], V::Null)),
                ),
                ("parts", V::Array(parts)),
            ]));
        }
    }
    object([
        ("model", model),
        ("usage", object([("in", tokens_in), ("out", tokens_out)])),
        ("messages", V::Array(output)),
    ])
}

fn whitespace(c: u16) -> bool {
    matches!(c, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
/// Pass entries from only the first 50 physical lines of the file.
pub fn title(entries: impl IntoIterator<Item = impl std::borrow::Borrow<V>>) -> V {
    for entry in entries {
        let entry = std::borrow::Borrow::borrow(&entry);
        if !eq(&entry["type"], "user") {
            continue;
        }
        let content = &entry["message"]["content"];
        let mut text = content.clone();
        if !content.is_string() {
            text = V::from("");
            for block in content.array() {
                // Array.find's property access throws on null and skips this line.
                if *block == V::Null {
                    break;
                }
                if eq(&block["type"], "text") {
                    text = block["text"].clone();
                    break;
                }
            }
        }
        if text.is_string() && text.trim().truthy() {
            let mut units = Vec::new();
            let mut previous_space = false;
            for &unit in text.units() {
                if whitespace(unit) {
                    if !previous_space {
                        units.push(32);
                    }
                    previous_space = true;
                } else {
                    units.push(unit);
                    previous_space = false;
                }
            }
            units.truncate(60);
            return V::String(units);
        }
    }
    V::from("")
}

static COMMIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r#"git commit[^\n\r\x{2028}\x{2029}]*-m[\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+["']([^"']+)"#).unwrap()
});
static DIFF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"[+-][0-9]+[\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+lines?").unwrap()
});

pub fn timeline(entries: impl IntoIterator<Item = impl std::borrow::Borrow<V>>) -> V {
    let mut events = Vec::new();
    let mut files: Vec<(V, V)> = Vec::new();
    let mut tokens = [
        V::Number(0.0),
        V::Number(0.0),
        V::Number(0.0),
        V::Number(0.0),
    ];
    let (mut model, mut start, mut end, mut count) = (V::Null, V::Null, V::Null, 0);
    for entry in entries {
        let entry = std::borrow::Borrow::borrow(&entry);
        let message = &entry["message"];
        let ts = fallback(&entry["timestamp"], message["timestamp"].clone());
        let has_ts = entry["timestamp"].truthy() || message.has("timestamp");
        if ts.truthy() {
            if !start.truthy() {
                start = ts.clone();
            }
            end = ts.clone();
        }
        if message["usage"].truthy() {
            for (i, field) in [
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            ]
            .iter()
            .enumerate()
            {
                tokens[i] = add(
                    tokens[i].clone(),
                    fallback(&message["usage"][field], V::Number(0.0)),
                );
            }
        }
        if message["model"].truthy() && !model.truthy() {
            model = short_model(&message["model"]);
        }
        if eq(&entry["type"], "user") {
            count += 1;
        }
        if eq(&entry["type"], "assistant") {
            for block in message["content"].array() {
                if eq(&block["type"], "tool_use") {
                    let mut event = object([("type", V::from("tool"))]);
                    if has_ts {
                        event["ts"] = ts.clone();
                    }
                    copy_field(&mut event, block, "name");
                    copy_field(&mut event, block, "id");
                    let input = &block["input"];
                    let name = block["name"].text();
                    event["detail"] = match name.as_str() {
                        "Read" | "read_file" | "Edit" | "edit_file" | "Write" | "write_to_file" => {
                            fallback(&input["file_path"], fallback(&input["path"], V::from("")))
                        }
                        "Bash" | "execute_command" => {
                            fallback(&input["command"], V::from("")).cut(120)
                        }
                        "Grep" | "search_files" => {
                            fallback(&input["pattern"], fallback(&input["query"], V::from("")))
                        }
                        "Glob" => fallback(&input["pattern"], V::from("")),
                        "Task" => fallback(&input["description"], V::from("")),
                        _ => input_text(input, 100),
                    };
                    if matches!(name.as_str(), "Edit" | "edit_file") {
                        event["action"] = V::from("edit");
                    }
                    if matches!(name.as_str(), "Write" | "write_to_file") {
                        event["action"] = V::from("write");
                    }
                    events.push(event);
                } else if eq(&block["type"], "text") && block["text"].truthy() {
                    let text = block["text"].text();
                    if let Some(found) = COMMIT.captures(&text).and_then(|c| c.get(1)) {
                        let begin = text[..found.start()].encode_utf16().count();
                        let end = begin + found.as_str().encode_utf16().count();
                        let mut event = object([
                            ("type", V::from("commit")),
                            (
                                "detail",
                                V::String(block["text"].units()[begin..end].to_vec()),
                            ),
                        ]);
                        if has_ts {
                            event["ts"] = ts.clone();
                        }
                        events.push(event);
                    }
                }
            }
        }
        if eq(&entry["type"], "tool_result") || eq(&entry["type"], "user") {
            for block in message["content"].array() {
                if eq(&block["type"], "tool_result")
                    && block["content"].is_string()
                    && DIFF.is_match(&block["content"].text())
                {
                    if let Some(event) = events.iter().rev().find(|event| {
                        eq(&event["type"], "tool")
                            && event["id"] == block["tool_use_id"]
                            && event.has("id") == block.has("tool_use_id")
                    }) {
                        if event["detail"].truthy()
                            && !files.iter().any(|(path, _)| *path == event["detail"])
                        {
                            files.push((
                                event["detail"].clone(),
                                object([("adds", V::Number(0.0)), ("removes", V::Number(0.0))]),
                            ));
                        }
                    }
                }
            }
        }
    }
    for event in &events {
        if (eq(&event["action"], "edit") || eq(&event["action"], "write"))
            && event["detail"].truthy()
            && !files.iter().any(|(path, _)| *path == event["detail"])
        {
            files.push((
                event["detail"].clone(),
                object([("action", event["action"].clone())]),
            ));
        }
    }
    let (price_in, price_out) = match model.text().split('-').next() {
        Some("sonnet") => (3.0, 15.0),
        Some("haiku") => (0.8, 4.0),
        _ => (15.0, 75.0),
    };
    let cost = ((tokens[0].number() / 1_000_000.0 * price_in
        + tokens[1].number() / 1_000_000.0 * price_out)
        * 100.0
        + 0.5)
        .floor()
        / 100.0;
    let files = files
        .into_iter()
        .map(|(path, mut info)| {
            let units = path.units();
            let slash = units.iter().rposition(|c| *c == 47).map_or(0, |i| i + 1);
            let backslash = units.iter().rposition(|c| *c == 92).map_or(0, |i| i + 1);
            info["path"] = if slash < units.len() {
                V::String(units[slash..].to_vec())
            } else if backslash < units.len() {
                V::String(units[backslash..].to_vec())
            } else {
                path.clone()
            };
            info["fullPath"] = path;
            info
        })
        .collect();
    events.truncate(500);
    object([
        ("events", V::Array(events)),
        (
            "summary",
            object([
                ("sessionStart", start),
                ("sessionEnd", end),
                ("model", model),
                ("messageCount", V::Number(count as f64)),
                (
                    "tokens",
                    object([
                        ("input", tokens[0].clone()),
                        ("output", tokens[1].clone()),
                        ("cacheRead", tokens[2].clone()),
                        ("cacheWrite", tokens[3].clone()),
                    ]),
                ),
                ("cost", V::Number(cost)),
                ("filesChanged", V::Array(files)),
            ]),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    #[test]
    fn messages_keep_omissions_utf16_and_default_limit() {
        let input = parse(
            r#"[{"type":"user","message":{"content":[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"\ud800"}]}},{"type":"assistant","timestamp":null,"message":{"model":"claude-sonnet-4-20250101","content":[{"type":"tool_use","input":{"n":1}}]}}]"#,
        );
        let result = messages(input.array());
        assert_eq!(result.array()[0]["content"], parse(r#""a\n\ud800""#));
        assert!(!result.array()[0].has("ts"));
        assert_eq!(result.array()[1]["model"], V::from("sonnet-4"));
        assert!(result.array()[1].has("ts"));
        assert!(!result.array()[1]["tools"].array()[0].has("name"));
        assert_eq!(
            result.array()[1]["tools"].array()[0]["input"],
            V::from("{\"n\":1}")
        );
        assert_eq!(
            messages(&vec![input.array()[0].clone(); 205]).array().len(),
            200
        );
        let long = object([
            ("type", V::from("user")),
            (
                "message",
                object([("content", V::from(format!("{}😀", "a".repeat(2999))))]),
            ),
        ]);
        assert_eq!(
            messages(&[long]).array()[0]["content"].units()[2999],
            0xd83d
        );
    }
    #[test]
    fn chat_preserves_images_thinking_and_token_semantics() {
        let input = parse(
            r#"[{"type":"assistant","createdAt":"t","message":{"model":"claude-opus","usage":{"input_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":99,"output_tokens":4},"content":[{"type":"thinking","thinking":"\ud800"},{"type":"tool_use"},{"type":"tool_result","content":["hi",{"type":"image","source":{"type":"url","url":"x"}},{"type":"text","text":"bye"}]},{"type":"image","source":{"type":"base64","data":"abc"}}]}}]"#,
        );
        let result = chat(input.array());
        assert_eq!(
            result["usage"],
            object([("in", V::Number(5.0)), ("out", V::Number(4.0))])
        );
        let message = &result["messages"].array()[0];
        assert_eq!(message["ts"], V::from("t"));
        let parts = message["parts"].array();
        assert_eq!(parts[0]["text"], parse(r#""\ud800""#));
        assert!(!parts[1].has("id"));
        assert_eq!(parts[2]["label"], V::from("tool image"));
        assert_eq!(parts[3]["content"], V::from("hi\nbye"));
        assert!(!parts[4].has("media_type"));
    }
    #[test]
    fn title_collapses_js_whitespace_without_trimming_and_cuts_utf16() {
        let input = parse(
            r#"[{"type":"user","message":{"content":[{"type":"text","text":" \ufeff  a\ud800\n b "}]}}]"#,
        );
        assert_eq!(title(input.array()), parse(r#"" a\ud800 b ""#));
        let entry = object([
            ("type", V::from("user")),
            (
                "message",
                object([("content", V::from(format!("{}😀", "x".repeat(59))))]),
            ),
        ]);
        assert_eq!(title(&[entry]).units()[59], 0xd83d);
    }
    #[test]
    fn timeline_tracks_all_events_before_cap_and_retains_source_file_order() {
        let input = parse(
            r#"[{"type":"assistant","timestamp":"first","message":{"model":"claude-sonnet-20250101","usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_read_input_tokens":7},"content":[{"type":"tool_use","name":"Edit","id":"a","input":{"file_path":"/tmp/a"}},{"type":"text","text":"git commit -m 'fix \ud800'"}]}},{"type":"user","message":{"timestamp":"last","content":[{"type":"tool_result","tool_use_id":"a","content":"+12 lines"}]}}]"#,
        );
        let result = timeline(input.array());
        assert_eq!(
            result["events"].array()[1]["detail"],
            parse(r#""fix \ud800""#)
        );
        assert_eq!(result["summary"]["cost"], V::Number(18.0));
        assert_eq!(result["summary"]["sessionEnd"], V::from("last"));
        let file = &result["summary"]["filesChanged"].array()[0];
        assert_eq!(file["path"], V::from("a"));
        assert_eq!(file["adds"], V::Number(0.0));
        assert!(!file.has("action"));
        let repeated = vec![input.array()[0].clone(); 300];
        assert_eq!(timeline(&repeated)["events"].array().len(), 500);
        let no_ts = parse(
            r#"[{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}]"#,
        );
        assert!(!timeline(no_ts.array())["events"].array()[0].has("ts"));
    }
}
