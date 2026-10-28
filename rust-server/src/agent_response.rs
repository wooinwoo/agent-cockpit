//! Response parsing shared by native agent loops. This module never runs tools.
use crate::board_value::{object, V};
use regress::Regex;
use std::sync::OnceLock;

const MAX_TOOLS_PER_TURN: usize = 5;

struct Patterns {
    fence: Regex,
    embedded: Regex,
    tool: Regex,
    thinking: Regex,
    youtube: Regex,
    youtube_punctuation: Regex,
    youtube_words: Regex,
    request_words: Regex,
    google: Regex,
    google_words: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let re = |source, flags| Regex::with_flags(source, flags).expect("agent response regex");
        Patterns {
            fence: re(r"^```(?:json)?\s*\n", ""),
            embedded: re(
                r#"\{[\s\S]*"thinking"\s*:\s*"[\s\S]*"is_final"\s*:\s*(true|false)[\s\S]*\}"#,
                "",
            ),
            tool: re(r"@@TOOL:(\w+)@@([\s\S]+?)@@END@@", ""),
            thinking: re(r"<thinking>([\s\S]*?)</thinking>", ""),
            youtube: re(
                "유튜브|youtube|노래|음악|틀어|재생|play|music|lofi|로파이",
                "i",
            ),
            youtube_punctuation: re(r"[~!?.,…]+", ""),
            youtube_words: re("유튜브에서|유튜브로|유튜브|youtube에서|youtube", "i"),
            request_words: re(
                "에서|에|를|을|좀|해|줘|드릴|께|영|봐|라|한번|좀|틀어|재생|play",
                "",
            ),
            google: re("구글|google|검색해|search", "i"),
            google_words: re("구글|google|검색|search|해|줘|볼|께|영|에서", "i"),
        }
    })
}

fn matches(regex: &Regex, value: &V) -> bool {
    regex.find_from_ucs2(value.units(), 0).next().is_some()
}

fn remove_matches(regex: &Regex, value: &V) -> V {
    let units = value.units();
    let mut result = Vec::with_capacity(units.len());
    let mut end = 0;
    for found in regex.find_from_ucs2(units, 0) {
        result.extend_from_slice(&units[end..found.range.start]);
        end = found.range.end;
    }
    result.extend_from_slice(&units[end..]);
    V::String(result)
}

fn concat(values: &[V]) -> V {
    V::String(
        values
            .iter()
            .flat_map(|v| v.units().iter().copied())
            .collect(),
    )
}

// Unlike String::from_utf16_lossy, JavaScript String() preserves lone surrogates.
fn string(value: &V) -> Result<V, String> {
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
            if exponent >= 0 {
                format!("{digits}e+{exponent}").into()
            } else {
                format!("{digits}e{exponent}").into()
            }
        }
        V::Array(values) => {
            let mut result = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    result.push(44);
                }
                if *value != V::Null {
                    result.extend_from_slice(string(value)?.units());
                }
            }
            V::String(result)
        }
        _ => value.text().into(),
    })
}

fn uppercase(value: &V) -> V {
    let mut result = Vec::new();
    for c in char::decode_utf16(value.units().iter().copied()) {
        match c {
            Ok(c) => {
                for upper in c.to_uppercase() {
                    result.extend(upper.encode_utf16(&mut [0; 2]).iter().copied());
                }
            }
            Err(e) => result.push(e.unpaired_surrogate()),
        }
    }
    V::String(result)
}

/// `None` preserves JavaScript's missing `arg` (`undefined`), distinct from null.
pub fn build_edit_arg(tc: &V) -> Result<Option<V>, String> {
    if *tc == V::Null {
        return Err("Cannot read properties of null (reading 'file')".into());
    }
    if tc["file"].truthy() && tc.has("oldContent") && tc.has("newContent") {
        return Ok(Some(concat(&[
            string(&tc["file"])?,
            "\nOLD_CONTENT\n<<<\n".into(),
            string(&tc["oldContent"])?,
            "\n>>>\nNEW_CONTENT\n<<<\n".into(),
            string(&tc["newContent"])?,
            "\n>>>".into(),
        ])));
    }
    Ok(tc.has("arg").then(|| tc["arg"].clone()))
}

/// `None` preserves JavaScript's missing `arg` (`undefined`), distinct from null.
pub fn build_write_arg(tc: &V) -> Result<Option<V>, String> {
    if *tc == V::Null {
        return Err("Cannot read properties of null (reading 'file')".into());
    }
    if tc["file"].truthy() && tc.has("content") {
        return Ok(Some(concat(&[
            string(&tc["file"])?,
            "\n".into(),
            string(&tc["content"])?,
        ])));
    }
    Ok(tc.has("arg").then(|| tc["arg"].clone()))
}

// JSON.parse accepts literal lone surrogates inside JSON strings. Escape those
// code units before passing the document to serde, without repairing bad escapes.
pub(crate) fn json_text(value: &V) -> Option<String> {
    let mut result = String::new();
    let mut in_string = false;
    let mut escaped = false;
    for c in char::decode_utf16(value.units().iter().copied()) {
        match c {
            Ok(c) => {
                result.push(c);
                if escaped {
                    escaped = false;
                } else if in_string && c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    in_string = !in_string;
                }
            }
            Err(e) if in_string && !escaped => {
                result.push_str(&format!("\\u{:04x}", e.unpaired_surrogate()));
            }
            Err(_) => return None,
        }
    }
    Some(result)
}

fn structured(text: &V) -> Option<V> {
    let raw = serde_json::value::RawValue::from_string(json_text(text)?).ok()?;
    let parsed = V::parse(&raw).ok()?;
    if !parsed["thinking"].is_string() || !matches!(parsed["is_final"], V::Bool(_)) {
        return None;
    }
    let mut calls = Vec::new();
    for call in parsed["tool_calls"].array() {
        if !call["tool"].is_string() || !call["tool"].trim().truthy() {
            continue;
        }
        let mut result = object([
            ("type", uppercase(&call["tool"])),
            (
                "arg",
                if call["argument"] == V::Null {
                    "".into()
                } else {
                    string(&call["argument"]).ok()?
                },
            ),
        ]);
        for (source, target) in [
            ("file", "file"),
            ("old_content", "oldContent"),
            ("new_content", "newContent"),
            ("content", "content"),
        ] {
            if call.has(source) {
                result[target] = call[source].clone();
            }
        }
        calls.push(result);
        if calls.len() == MAX_TOOLS_PER_TURN {
            break;
        }
    }
    Some(object([
        ("structured", true.into()),
        ("thinking", parsed["thinking"].clone()),
        (
            "message",
            if parsed["message"].is_string() {
                parsed["message"].clone()
            } else {
                "".into()
            },
        ),
        ("toolCalls", V::Array(calls)),
        ("isFinal", parsed["is_final"].clone()),
    ]))
}

fn uri_query(value: &V) -> Result<String, String> {
    let text = String::from_utf16(value.units()).map_err(|_| "URI malformed".to_string())?;
    let mut result = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(byte as char);
        } else if byte == b' ' {
            result.push('+');
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(result)
}

fn implicit_tools(text: &V, user_message: &V) -> Result<Vec<V>, String> {
    let source = if user_message.truthy() {
        user_message
    } else {
        text
    };
    let source_text = string(source)?;
    let regex = patterns();
    if matches(&regex.youtube, &source_text) {
        if !source.is_string() {
            return Err("source.replace is not a function".into());
        }
        let terms = remove_matches(&regex.youtube_punctuation, source);
        let terms = remove_matches(&regex.youtube_words, &terms);
        let terms = remove_matches(&regex.request_words, &terms).trim();
        if terms.truthy() {
            return Ok(vec![object([
                ("type", "OPEN".into()),
                (
                    "arg",
                    format!(
                        "https://www.youtube.com/results?search_query={}",
                        uri_query(&terms)?
                    )
                    .into(),
                ),
            ])]);
        }
    }
    if matches(&regex.google, &source_text) {
        if !source.is_string() {
            return Err("source.replace is not a function".into());
        }
        let terms = remove_matches(&regex.google_words, source).trim();
        if terms.truthy() {
            return Ok(vec![object([
                ("type", "OPEN".into()),
                (
                    "arg",
                    format!("https://www.google.com/search?q={}", uri_query(&terms)?).into(),
                ),
            ])]);
        }
    }
    Ok(Vec::new())
}

/// Parse the existing JSON, embedded JSON, legacy marker and plain-text formats.
/// Errors match source coercion/URI failures; no tool execution happens here.
pub fn parse(text: &V, user_message: &V) -> Result<V, String> {
    if !text.is_string() {
        return Err(if *text == V::Null {
            "Cannot read properties of null (reading 'trim')".into()
        } else {
            "text.trim is not a function".into()
        });
    }
    let regex = patterns();
    let mut cleaned = text.trim();
    let fence = V::from("```");
    let json_fence = V::from("```json");
    if matches(&regex.fence, &cleaned) && cleaned.units().ends_with(fence.units()) {
        let newline = cleaned.units().iter().position(|c| *c == 10).unwrap();
        // JS slice clamps an end before the start to an empty string.
        let end = cleaned.units().len() - 3;
        cleaned = V::String(cleaned.units()[newline + 1..end.max(newline + 1)].to_vec()).trim();
    } else {
        if cleaned.units().starts_with(json_fence.units()) {
            cleaned = V::String(cleaned.units()[7..].to_vec());
        } else if cleaned.units().starts_with(fence.units()) {
            cleaned = V::String(cleaned.units()[3..].to_vec());
        }
        if cleaned.units().ends_with(fence.units()) {
            cleaned = V::String(cleaned.units()[..cleaned.units().len() - 3].to_vec());
        }
        cleaned = cleaned.trim();
    }
    if let Some(result) = structured(&cleaned) {
        return Ok(result);
    }
    if let Some(found) = regex.embedded.find_from_ucs2(text.units(), 0).next() {
        if let Some(result) = structured(&V::String(text.units()[found.range].to_vec())) {
            return Ok(result);
        }
    }
    let mut calls = Vec::new();
    let mut first = None;
    for found in regex
        .tool
        .find_from_ucs2(text.units(), 0)
        .take(MAX_TOOLS_PER_TURN)
    {
        first.get_or_insert(found.range.start);
        calls.push(object([
            (
                "type",
                V::String(text.units()[found.group(1).unwrap()].to_vec()),
            ),
            (
                "arg",
                V::String(text.units()[found.group(2).unwrap()].to_vec()).trim(),
            ),
        ]));
    }
    if let Some(first) = first {
        let before = V::String(text.units()[..first].to_vec()).trim();
        let thinking = regex
            .thinking
            .find_from_ucs2(before.units(), 0)
            .next()
            .map(|found| V::String(before.units()[found.group(1).unwrap()].to_vec()).trim())
            .unwrap_or_else(|| "".into());
        return Ok(object([
            ("structured", false.into()),
            ("thinking", thinking),
            ("message", remove_matches(&regex.thinking, &before).trim()),
            ("toolCalls", V::Array(calls)),
            ("isFinal", false.into()),
        ]));
    }
    let message = remove_matches(&regex.thinking, text).trim();
    let calls = implicit_tools(&message, user_message)?;
    let implicit = !calls.is_empty();
    Ok(object([
        ("structured", false.into()),
        ("thinking", "".into()),
        ("message", message),
        ("toolCalls", V::Array(calls)),
        ("isFinal", (!implicit).into()),
        ("implicit", implicit.into()),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }

    #[test]
    fn reference_fixtures_match_original_javascript_parser() {
        let fixtures = json(include_str!(
            "../../tests/fixtures/rust-agent-response.json"
        ));
        assert_eq!(fixtures.array().len(), 416);
        for (index, fixture) in fixtures.array().iter().enumerate() {
            let input = &fixture["input"];
            let result = match input["action"].text().as_str() {
                "parse" => parse(&input["text"], &input["userMessage"]).map(Some),
                "edit" => build_edit_arg(&input["value"]),
                "write" => build_write_arg(&input["value"]),
                _ => panic!("unexpected fixture action"),
            };
            let actual = match result {
                Ok(Some(value)) => object([("defined", true.into()), ("value", value)]),
                Ok(None) => object([("defined", false.into())]),
                Err(error) => object([("error", error.into())]),
            };
            assert_eq!(actual, fixture["expected"], "reference fixture {index}");
        }
    }

    #[test]
    fn structured_optional_fields_coercion_and_call_limit() {
        let text = r#"{"thinking":"ok","is_final":false,"tool_calls":[null,{"tool":" "},{"tool":" read ","argument":[null,1e21,[true,null]],"file":null},{"tool":"ß"},{"tool":"a"},{"tool":"b"},{"tool":"c"},{"tool":"d"}]}"#;
        let result = parse(&text.into(), &"".into()).unwrap();
        assert_eq!(result["toolCalls"].array().len(), 5);
        assert_eq!(
            result["toolCalls"].array()[0],
            json(r#"{"type":" READ ","arg":",1e+21,true,","file":null}"#)
        );
        assert_eq!(result["toolCalls"].array()[1]["type"], V::from("SS"));
        assert!(!result["toolCalls"].array()[1].has("file"));
    }

    #[test]
    fn fences_embedded_json_and_legacy_utf16() {
        let expected = json(
            r#"{"structured":true,"thinking":"x","message":"","toolCalls":[],"isFinal":true}"#,
        );
        for text in [
            "```json\n{\"thinking\":\"x\",\"is_final\":true}\n```",
            "prefix {\"thinking\":\"x\",\"is_final\":true} suffix",
            "```{\"thinking\":\"x\",\"is_final\":true}```",
        ] {
            assert_eq!(parse(&text.into(), &"".into()).unwrap(), expected);
        }
        let text = json(
            r#""😀\ud800 <thinking> a </thinking>\nhello @@TOOL:read@@ \udc00 @@END@@ignored""#,
        );
        let result = parse(&text, &"".into()).unwrap();
        assert_eq!(result["thinking"], V::from("a"));
        assert_eq!(result["message"], json(r#""😀\ud800 \nhello""#));
        assert_eq!(
            result["toolCalls"].array()[0],
            json(r#"{"type":"read","arg":"\udc00"}"#)
        );
    }

    #[test]
    fn literal_surrogates_are_preserved_without_repairing_bad_json_escapes() {
        let text = concat(&[
            "{\"thinking\":\"".into(),
            V::String(vec![0xd800]),
            "\",\"is_final\":true}".into(),
        ]);
        assert_eq!(
            parse(&text, &"".into()).unwrap()["thinking"],
            V::String(vec![0xd800])
        );
        let bad = concat(&[
            "{\"thinking\":\"\\".into(),
            V::String(vec![0xd800]),
            "\",\"is_final\":true}".into(),
        ]);
        assert_eq!(
            parse(&bad, &"".into()).unwrap()["structured"],
            V::Bool(false)
        );
    }

    #[test]
    fn implicit_search_preserves_case_rules_and_rejects_bad_uri() {
        let result = parse(&"done".into(), &"YouTube PLAY lofi A B!".into()).unwrap();
        assert_eq!(
            result["toolCalls"].array()[0]["arg"],
            V::from("https://www.youtube.com/results?search_query=PLAY+lofi+A+B")
        );
        assert_eq!(
            parse(&"done".into(), &json(r#""google \ud800""#)),
            Err("URI malformed".into())
        );
        assert_eq!(
            parse(&"done".into(), &json(r#"["youtube"]"#)),
            Err("source.replace is not a function".into())
        );
    }

    #[test]
    fn helper_missing_null_and_coercion_errors_remain_distinct() {
        assert_eq!(build_edit_arg(&json("{}")), Ok(None));
        assert_eq!(build_write_arg(&json(r#"{"arg":null}"#)), Ok(Some(V::Null)));
        assert!(build_write_arg(&V::Null).is_err());
        assert_eq!(
            build_write_arg(&json(r#"{"file":["x",null],"content":false}"#)),
            Ok(Some("x,\nfalse".into()))
        );
        assert_eq!(
            build_edit_arg(&json(r#"{"file":"x","oldContent":null,"newContent":0}"#)),
            Ok(Some(
                "x\nOLD_CONTENT\n<<<\nnull\n>>>\nNEW_CONTENT\n<<<\n0\n>>>".into()
            ))
        );
        assert_eq!(
            build_write_arg(&json(r#"{"file":"x","content":{"toString":false}}"#)),
            Err("Cannot convert object to primitive value".into())
        );
    }
}
