//! Standard API token equivalents. These are not subscription charges or invoices.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct Cached {
    value: Value,
    checked: i64,
    running: bool,
}
#[derive(Default)]
pub struct Store {
    cache: Mutex<Cached>,
}
impl Store {
    pub fn snapshot(self: &Arc<Self>, homes: Vec<PathBuf>, time: i64) -> Value {
        let mut cache = self.cache.lock().unwrap();
        let value = cache.value.clone();
        if cache.running || (cache.checked > 0 && time - cache.checked < 30_000) {
            return value;
        }
        cache.running = true;
        let store = self.clone();
        tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(move || jcode(&homes, time)).await;
            let mut cache = store.cache.lock().unwrap();
            if let Ok(value) = result {
                cache.value = value;
                cache.checked = time;
            }
            cache.running = false;
        });
        value
    }
}

#[derive(Default, Deserialize)]
pub struct Tokens {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
}
impl Tokens {
    pub fn from_value(value: &Value) -> Option<Self> {
        let get = |key: &str| match value.get(key) {
            None => Some(0),
            Some(value) => value
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0. && n.fract() == 0. && *n < u64::MAX as f64)
                .map(|n| n as u64),
        };
        Some(Self {
            input_tokens: get("input_tokens")?,
            output_tokens: get("output_tokens")?,
            cache_read_input_tokens: get("cache_read_input_tokens")?,
            cache_creation_input_tokens: get("cache_creation_input_tokens")?,
        })
    }
}

pub fn estimate(provider: &str, model: &str, tokens: &Tokens) -> Option<f64> {
    // Sources checked 2026-10-16: platform.claude.com/docs/en/about-claude/pricing
    // and developers.openai.com/api/docs/models/gpt-6.1-sol. Unknown models stay unpriced.
    let mut name = model.strip_prefix("claude-").unwrap_or(model);
    if name.len() > 9
        && name.as_bytes()[name.len() - 9] == b'-'
        && name.as_bytes()[name.len() - 8..]
            .iter()
            .all(u8::is_ascii_digit)
    {
        name = &name[..name.len() - 9];
    }
    let [input, output, write, read] = match (provider, name) {
        ("claude", "opus-5-5") => [4., 20., 5., 0.2],
        ("claude", "opus-5" | "opus-4-8" | "opus-4-7" | "opus-4-6" | "opus-4-5") => {
            [5., 25., 6.25, 0.5]
        }
        ("claude", "opus-4" | "opus-4-1") => [15., 75., 18.75, 1.5],
        ("claude", "sonnet-5-5") => [2., 10., 2.5, 0.1],
        ("claude", "sonnet-5") => [2., 10., 2.5, 0.2],
        ("claude", "sonnet-4" | "sonnet-4-5" | "sonnet-4-6") => [3., 15., 3.75, 0.3],
        ("claude", "haiku-4-5") => [1., 5., 1.25, 0.1],
        ("claude", "haiku-3-5" | "3-5-haiku") => [0.8, 4., 1., 0.08],
        ("openai", "gpt-6.1-sol") => [2., 10., 2.5, 0.1],
        _ => return None,
    };
    let cached = tokens.cache_read_input_tokens;
    let written = tokens.cache_creation_input_tokens;
    let uncached = if provider == "openai" {
        if cached.saturating_add(written) > tokens.input_tokens {
            return None;
        }
        tokens.input_tokens - cached - written
    } else {
        tokens.input_tokens
    };
    let long = provider == "openai" && tokens.input_tokens > 272_000;
    let input_factor = if long { 2. } else { 1. };
    let output_factor = if long { 1.5 } else { 1. };
    Some(
        ((uncached as f64 * input + cached as f64 * read + written as f64 * write) * input_factor
            + tokens.output_tokens as f64 * output * output_factor)
            / 1_000_000.,
    )
}

pub struct Report {
    time: i64,
    today: String,
    today_usd: f64,
    week_usd: f64,
    priced: u64,
    unpriced: u64,
    models: HashSet<String>,
}
impl Report {
    pub fn new(time: i64) -> Self {
        Self {
            time,
            today: DateTime::<Utc>::from_timestamp_millis(time)
                .unwrap_or_default()
                .format("%Y-%m-%d")
                .to_string(),
            today_usd: 0.,
            week_usd: 0.,
            priced: 0,
            unpriced: 0,
            models: HashSet::new(),
        }
    }
    pub fn add(&mut self, provider: &str, model: &str, timestamp: &str, tokens: &Tokens) {
        let Ok(date) = DateTime::parse_from_rfc3339(timestamp) else {
            return;
        };
        let ms = date.timestamp_millis();
        if ms < self.time - 7 * 86_400_000 || ms > self.time {
            return;
        }
        if tokens.input_tokens == 0
            && tokens.output_tokens == 0
            && tokens.cache_read_input_tokens == 0
            && tokens.cache_creation_input_tokens == 0
        {
            return;
        }
        if let Some(usd) = estimate(provider, model, tokens) {
            self.priced += 1;
            self.week_usd += usd;
            if date.with_timezone(&Utc).format("%Y-%m-%d").to_string() == self.today {
                self.today_usd += usd;
            }
        } else {
            self.unpriced += 1;
            self.models.insert(model.chars().take(100).collect());
        }
    }
    pub fn value(&self) -> Value {
        let mut models: Vec<_> = self.models.iter().cloned().collect();
        models.sort();
        json!({"basis":"standard_api_equivalent", "currency":"USD", "timezone":"UTC",
            "todayUsd":if self.priced > 0 {Some(self.today_usd)} else {None},
            "weekUsd":if self.priced > 0 {Some(self.week_usd)} else {None},
            "pricedRequests":self.priced,"unpricedRequests":self.unpriced,"unpricedModels":models,
            "checkedAt":DateTime::<Utc>::from_timestamp_millis(self.time).unwrap_or_default().to_rfc3339_opts(SecondsFormat::Millis,true)})
    }
}

#[derive(Default, Deserialize)]
struct Meta {
    #[serde(default)]
    model: String,
    #[serde(default)]
    provider_key: String,
}
#[derive(Deserialize)]
struct Message {
    id: String,
    role: String,
    timestamp: String,
    token_usage: Option<Tokens>,
}
#[derive(Default, Deserialize)]
struct Journal {
    #[serde(default)]
    meta: Meta,
    #[serde(default)]
    append_messages: Vec<Message>,
}

pub fn jcode(homes: &[std::path::PathBuf], time: i64) -> Value {
    let mut report = Report::new(time);
    let mut seen = HashSet::new();
    let mut unreadable = 0u64;
    for home in homes {
        let root = home.join("sessions");
        if !root.exists() {
            continue;
        }
        let Ok(files) = fs::read_dir(&root) else {
            unreadable += 1;
            continue;
        };
        for entry in files.flatten() {
            let path = entry.path();
            if !path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.ends_with(".journal.jsonl"))
            {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else {
                unreadable += 1;
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            if meta
                .modified()
                .ok()
                .and_then(|d| d.duration_since(std::time::UNIX_EPOCH).ok())
                .is_some_and(|d| (d.as_millis() as i64) < time - 7 * 86_400_000)
            {
                continue;
            }
            let Ok(file) = File::open(&path) else {
                unreadable += 1;
                continue;
            };
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else {
                    unreadable += 1;
                    break;
                };
                let Ok(record) = serde_json::from_str::<Journal>(&line) else {
                    unreadable += 1;
                    continue;
                };
                let provider = match record.meta.provider_key.as_str() {
                    "openai-oauth" | "openai" => "openai",
                    "anthropic" | "anthropic-oauth" | "claude" => "claude",
                    _ => "unknown",
                };
                for message in record.append_messages {
                    if message.role != "assistant"
                        || !seen.insert((path.file_name().unwrap().to_owned(), message.id))
                    {
                        continue;
                    }
                    if let Some(tokens) = message.token_usage {
                        report.add(provider, &record.meta.model, &message.timestamp, &tokens);
                    }
                }
            }
        }
    }
    let mut result = report.value();
    result["source"] = "jcode_journals".into();
    result["coverage"] = "retained_journals_only".into();
    result["accountAttribution"] = "unavailable".into();
    result["unreadableRecords"] = unreadable.into();
    // Separate views: request records and retained journals overlap and must not be summed.
    result["accountRecords"] = account_records(homes, time);
    result
}

fn account_records(homes: &[PathBuf], time: i64) -> Value {
    let mut reports: HashMap<(String, String, String), Report> = HashMap::new();
    let mut seen = HashSet::new();
    let mut unreadable = 0u64;
    let mut unassigned = 0u64;
    for home in homes {
        let path = home.join("account_usage.jsonl");
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            unreadable += 1;
            continue;
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let Ok(file) = options.open(&path) else {
            unreadable += 1;
            continue;
        };
        if !file.metadata().is_ok_and(|m| m.is_file()) {
            unreadable += 1;
            continue;
        }
        // Each producer row is bounded to 4 KiB; never allocate an unbounded corrupt line.
        let mut reader = BufReader::new(file);
        loop {
            let mut bytes = Vec::new();
            let mut bounded = std::io::Read::take(&mut reader, 4097);
            match bounded.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) if bytes.len() <= 4096 && bytes.last() == Some(&b'\n') => {}
                _ => {
                    unreadable += 1;
                    break;
                }
            }
            let Ok(row) = serde_json::from_slice::<Value>(&bytes) else {
                unreadable += 1;
                continue;
            };
            let Some(id) = row["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128)
            else {
                unreadable += 1;
                continue;
            };
            if row["schema"] != 1 || !seen.insert(id.to_owned()) {
                continue;
            }
            let provider = row["provider"].as_str().unwrap_or("");
            if !matches!(provider, "claude" | "openai") {
                unreadable += 1;
                continue;
            }
            let timestamp = row["timestamp"].as_str().unwrap_or("");
            let Ok(date) = DateTime::parse_from_rfc3339(timestamp) else {
                unreadable += 1;
                continue;
            };
            if date.timestamp_millis() < time - 7 * 86_400_000 || date.timestamp_millis() > time {
                continue;
            }
            let Some(email) = row["email"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.len() <= 320)
            else {
                unassigned += 1;
                continue;
            };
            let account_id = if provider == "openai" {
                let Some(id) = row["account_id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                else {
                    unassigned += 1;
                    continue;
                };
                id
            } else {
                ""
            };
            let report = reports
                .entry((
                    provider.into(),
                    email.trim().to_lowercase(),
                    account_id.into(),
                ))
                .or_insert_with(|| Report::new(time));
            let model = row["model"]
                .as_str()
                .or_else(|| row["requested_model"].as_str())
                .unwrap_or("");
            // Missing terminal counts are unknown, not a zero-cost request.
            if row["input_tokens"].as_u64().is_none() || row["output_tokens"].as_u64().is_none() {
                report.unpriced += 1;
                continue;
            }
            if row["cache_read_input_tokens"].as_u64().is_none()
                || row["cache_creation_input_tokens"].as_u64().is_none()
            {
                report.unpriced += 1;
                continue;
            }
            let counts = json!({"input_tokens":row["input_tokens"],"output_tokens":row["output_tokens"],
                "cache_read_input_tokens":row["cache_read_input_tokens"].as_u64().unwrap_or(0),
                "cache_creation_input_tokens":row["cache_creation_input_tokens"].as_u64().unwrap_or(0)});
            let Some(tokens) = Tokens::from_value(&counts) else {
                report.unpriced += 1;
                continue;
            };
            if let Some(mut usd) = estimate(provider, model, &tokens) {
                // Anthropic's 1h write cache is 2x base input versus 1.25x for 5m.
                if provider == "claude"
                    && row["cache_ttl"] == "1h"
                    && tokens.cache_creation_input_tokens > 0
                {
                    let write_only = Tokens {
                        cache_creation_input_tokens: tokens.cache_creation_input_tokens,
                        ..Default::default()
                    };
                    usd += estimate(provider, model, &write_only).unwrap_or(0.) * 0.6;
                }
                report.priced += 1;
                report.week_usd += usd;
                if date.with_timezone(&Utc).format("%Y-%m-%d").to_string() == report.today {
                    report.today_usd += usd;
                }
            } else {
                report.unpriced += 1;
                report.models.insert(model.chars().take(100).collect());
            }
        }
    }
    let mut accounts: Vec<_> = reports.into_iter().map(|((provider,email,account_id),report)| json!({"provider":provider,"email":email,"accountId":account_id,"cost":report.value()})).collect();
    accounts.sort_by(|a, b| {
        (a["provider"].as_str(), a["email"].as_str())
            .cmp(&(b["provider"].as_str(), b["email"].as_str()))
    });
    json!({"source":"jcode_request_records","coverage":"recorded_terminal_responses_only", "accounts":accounts,"unassignedRequests":unassigned,"unreadableRecords":unreadable})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_models_cache_semantics_and_missing_prices() {
        let tokens = Tokens {
            input_tokens: 1_000_000,
            output_tokens: 100_000,
            cache_read_input_tokens: 900_000,
            ..Default::default()
        };
        assert!((estimate("openai", "gpt-6.1-sol", &tokens).unwrap() - 2.08).abs() < 0.00001);
        assert!((estimate("claude", "claude-opus-5-5", &tokens).unwrap() - 6.18).abs() < 0.00001);
        assert!(estimate("openai", "gpt-6.1-sol-fast", &tokens).is_none());
        assert!(estimate("claude", "new-opus-unknown", &tokens).is_none());
        let mut report = Report::new(1_792_108_800_000);
        assert!(report.value()["weekUsd"].is_null());
        report.add("unknown", "unknown", "2026-10-16T00:00:00Z", &tokens);
        assert!(report.value()["weekUsd"].is_null());
    }
    #[test]
    fn journals_ignore_prompts_and_deduplicate_replayed_messages() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("sessions")).unwrap();
        let line = json!({"meta":{"provider_key":"openai-oauth","model":"gpt-6.1-sol"},"append_messages":[{"id":"one","role":"assistant","content":"private prompt must not escape","timestamp":"2026-10-16T00:00:00Z","token_usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":900}}]}).to_string();
        fs::write(
            home.path().join("sessions/one.journal.jsonl"),
            format!("{line}\n{line}\n"),
        )
        .unwrap();
        let value = jcode(&[home.path().into()], 1_792_108_800_000);
        assert_eq!(value["pricedRequests"], 1);
        assert!((value["weekUsd"].as_f64().unwrap() - 0.00129).abs() < 0.00001);
        assert!(!value.to_string().contains("private"));
    }

    #[test]
    fn request_records_preserve_identity_and_never_sum_replayed_or_unassigned_usage() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        let now = 1_792_108_800_000;
        let mut row = json!({"schema":1,"id":"request-one","timestamp":"2026-10-16T00:00:00Z","provider":"openai","account_id":"one-workspace","email":"ONE@example.com","model":"gpt-6.1-sol","input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":900,"cache_creation_input_tokens":0});
        let first = row.to_string();
        let mut missing_cache = row.clone();
        missing_cache["id"] = "missing-cache-count".into();
        missing_cache["cache_read_input_tokens"] = Value::Null;
        row["id"] = "request-two".into();
        row["provider"] = "claude".into();
        row["model"] = "claude-opus-5-5".into();
        row["email"] = "two@example.com".into();
        row["cache_ttl"] = "1h".into();
        row["cache_creation_input_tokens"] = 100.into();
        let second = row.to_string();
        row["id"] = "unassigned".into();
        row["email"] = Value::Null;
        let unassigned = row.to_string();
        row["id"] = "incomplete".into();
        row["email"] = "two@example.com".into();
        row["output_tokens"] = Value::Null;
        fs::write(
            one.path().join("account_usage.jsonl"),
            format!("{{partial\n{first}\n{missing_cache}\n{second}\n{unassigned}\n{row}\n"),
        )
        .unwrap();
        fs::write(two.path().join("account_usage.jsonl"), format!("{first}\n")).unwrap();
        let value = jcode(&[one.path().into(), two.path().into()], now);
        assert!(
            value["weekUsd"].is_null(),
            "request ledger is separate from legacy journal subtotal"
        );
        let records = &value["accountRecords"];
        assert_eq!(records["unassignedRequests"], 1);
        assert_eq!(records["unreadableRecords"], 1);
        let rows = records["accounts"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let openai = rows
            .iter()
            .find(|r| r["email"] == "one@example.com")
            .unwrap();
        assert_eq!(openai["cost"]["pricedRequests"], 1);
        assert_eq!(openai["cost"]["unpricedRequests"], 1);
        assert!((openai["cost"]["weekUsd"].as_f64().unwrap() - 0.00129).abs() < 1e-10);
        let claude = rows
            .iter()
            .find(|r| r["email"] == "two@example.com")
            .unwrap();
        assert_eq!(claude["cost"]["pricedRequests"], 1);
        assert_eq!(claude["cost"]["unpricedRequests"], 1);
        assert!((claude["cost"]["weekUsd"].as_f64().unwrap() - 0.00698).abs() < 1e-10);
    }
}
