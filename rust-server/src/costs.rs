use crate::board_value::{object, V};
#[cfg(not(unix))]
use chrono::Datelike;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::value::RawValue;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MEMORY_TTL_MS: f64 = 30_000.0;
const SAVINGS_NOTE: &str =
    "opus 출력을 sonnet 단가로 환산한 상한(가정). 실제 절감은 작업 난이도에 따라 달라짐";

#[derive(Clone)]
struct Entry {
    date: V,
    model: V,
    usage: V,
    key: Vec<u16>,
    session: V,
    tools: f64,
}

#[derive(Default)]
struct State {
    result: Option<V>,
    timestamp: f64,
    date: String,
    files: HashMap<PathBuf, (u64, Vec<Entry>)>,
    unpriced: Vec<V>,
    model_order: HashMap<String, Vec<V>>,
}

pub struct Store {
    directory: PathBuf,
    home: PathBuf,
    state: Mutex<State>,
}

struct Dates {
    today: String,
    since: String,
    monday: String,
    midnight: f64,
    reset: String,
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64() * 1000.0)
}

fn iso(seconds: i64) -> String {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

#[cfg(unix)]
fn dates(now: f64) -> Dates {
    let timestamp = (now / 1000.0).floor() as libc::time_t;
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    // libc applies the process's local timezone, including DST transitions.
    unsafe { libc::localtime_r(&timestamp, &mut local) };
    let day = if local.tm_wday == 0 { 7 } else { local.tm_wday };
    let date = |value: &libc::tm| {
        format!(
            "{:04}-{:02}-{:02}",
            value.tm_year + 1900,
            value.tm_mon + 1,
            value.tm_mday
        )
    };
    let shift = |days: i32| {
        let mut value = local;
        value.tm_mday += days;
        value.tm_hour = 0;
        value.tm_min = 0;
        value.tm_sec = 0;
        value.tm_isdst = -1;
        let seconds = unsafe { libc::mktime(&mut value) };
        (date(&value), seconds as i64)
    };
    let (today, midnight) = shift(0);
    let (since, _) = shift(-30);
    let (monday, _) = shift(1 - day);
    let (_, reset) = shift(if day == 1 { 7 } else { 8 - day });
    Dates {
        today,
        since,
        monday,
        midnight: midnight as f64 * 1000.0,
        reset: iso(reset),
    }
}

#[cfg(not(unix))]
fn dates(now: f64) -> Dates {
    // Native Windows local-time support belongs to the subsequent platform port.
    let now = DateTime::<Utc>::from_timestamp_millis(now as i64).unwrap_or_default();
    let day = now.date_naive();
    let monday = day - chrono::Duration::days(now.weekday().num_days_from_monday() as i64);
    Dates {
        today: day.to_string(),
        since: (day - chrono::Duration::days(30)).to_string(),
        monday: monday.to_string(),
        midnight: day
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis() as f64,
        reset: iso((monday + chrono::Duration::days(7))
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp()),
    }
}

fn or_zero(value: &V) -> V {
    if value.truthy() {
        value.clone()
    } else {
        V::Number(0.0)
    }
}

fn string_units(value: &V) -> Vec<u16> {
    if value.is_string() {
        value.units().to_vec()
    } else {
        value.text().encode_utf16().collect()
    }
}

fn add(a: &V, b: &V) -> V {
    let primitive = |value: &V| match value {
        V::Array(_) | V::Object(_) => V::from(value.text()),
        _ => value.clone(),
    };
    let a = primitive(a);
    let b = primitive(b);
    if a.is_string() || b.is_string() {
        let mut units = string_units(&a);
        units.extend(string_units(&b));
        V::String(units)
    } else {
        V::Number(a.number() + b.number())
    }
}

fn increment(target: &mut V, key: &str, amount: &V) {
    target[key] = add(&target[key], amount);
}

fn pricing(model: &V, unpriced: &mut Vec<V>) -> ([f64; 4], bool) {
    let name = model.text().to_lowercase();
    if name.contains("haiku") {
        ([0.8, 4.0, 1.0, 0.08], false)
    } else if name.contains("sonnet") {
        ([3.0, 15.0, 3.75, 0.3], false)
    } else if name.contains("opus") {
        ([15.0, 75.0, 18.75, 1.5], false)
    } else {
        if !unpriced.contains(model) {
            unpriced.push(model.clone());
        }
        ([15.0, 75.0, 18.75, 1.5], true)
    }
}

fn cost(model: &V, usage: &V, unpriced: &mut Vec<V>) -> (f64, bool) {
    let (prices, estimated) = pricing(model, unpriced);
    let values = [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ];
    let amount = values
        .iter()
        .zip(prices)
        .map(|(key, price)| or_zero(&usage[key]).number() / 1_000_000.0 * price)
        .sum();
    (amount, estimated)
}

fn model_name(model: &V) -> V {
    let mut units = string_units(model);
    let prefix: Vec<_> = "claude-".encode_utf16().collect();
    if let Some(index) = units
        .windows(prefix.len())
        .position(|window| window == prefix)
    {
        units.drain(index..index + prefix.len());
    }
    let length = units.len();
    if length >= 9
        && units[length - 9] == u16::from(b'-')
        && units[length - 8..]
            .iter()
            .all(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(unit))
    {
        units.truncate(length - 9);
    }
    V::String(units)
}

fn dedupe(entries: Vec<Entry>) -> Vec<Entry> {
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|entry| entry.key.is_empty() || seen.insert(entry.key.clone()))
        .collect()
}

fn aggregate(entries: Vec<Entry>, unpriced: &mut Vec<V>) -> (V, HashMap<String, Vec<V>>) {
    let mut daily = V::object();
    let mut model_order: HashMap<String, Vec<V>> = HashMap::new();
    let mut sessions: HashMap<String, HashSet<Vec<u16>>> = HashMap::new();
    for entry in dedupe(entries) {
        let date = entry.date.text();
        if !daily.has(&date) {
            let mut day = V::object();
            for key in [
                "cost",
                "inputTokens",
                "outputTokens",
                "cacheRead",
                "cacheWrite",
                "messages",
                "toolCalls",
                "sessions",
            ] {
                day[key] = V::Number(0.0);
            }
            day["estimated"] = V::Bool(false);
            day["models"] = V::object();
            daily[&date] = day;
        }
        let day = &mut daily[&date];
        let (amount, estimated) = cost(&entry.model, &entry.usage, unpriced);
        increment(day, "cost", &V::Number(amount));
        for (source, target) in [
            ("input_tokens", "inputTokens"),
            ("output_tokens", "outputTokens"),
            ("cache_read_input_tokens", "cacheRead"),
            ("cache_creation_input_tokens", "cacheWrite"),
        ] {
            increment(day, target, &or_zero(&entry.usage[source]));
        }
        increment(day, "messages", &V::Number(1.0));
        increment(day, "toolCalls", &V::Number(entry.tools));
        if estimated {
            day["estimated"] = V::Bool(true);
        }
        if entry.session.truthy() {
            sessions
                .entry(date.clone())
                .or_default()
                .insert(string_units(&entry.session));
        }
        let display_name = model_name(&entry.model);
        let name = display_name.text();
        let models = &mut day["models"];
        if !models.has(&name) {
            model_order
                .entry(date.clone())
                .or_default()
                .push(display_name);
            models[&name] = object([
                ("cost", V::Number(0.0)),
                ("outputTokens", V::Number(0.0)),
                ("estimated", V::Bool(estimated)),
            ]);
        }
        increment(&mut models[&name], "cost", &V::Number(amount));
        increment(
            &mut models[&name],
            "outputTokens",
            &or_zero(&entry.usage["output_tokens"]),
        );
    }
    for (date, values) in sessions {
        daily[&date]["sessions"] = V::Number(values.len() as f64);
    }
    (daily, model_order)
}

fn fields(value: &V) -> Vec<(&str, &V)> {
    match value {
        V::Object(map) => map
            .iter()
            .map(|(key, value)| (key.as_str(), value))
            .collect(),
        _ => vec![],
    }
}

fn daily_entry(date: &str, day: &V, order: Option<&Vec<V>>) -> V {
    let mut result = object([
        ("date", V::from(date)),
        ("estimated", V::Bool(day["estimated"].truthy())),
    ]);
    for (source, target) in [
        ("cost", "totalCost"),
        ("inputTokens", "inputTokens"),
        ("outputTokens", "outputTokens"),
        ("cacheRead", "cacheReadTokens"),
        ("cacheWrite", "cacheCreationTokens"),
        ("messages", "messages"),
        ("sessions", "sessions"),
        ("toolCalls", "toolCalls"),
    ] {
        result[target] = or_zero(&day[source]);
    }
    result["totalTokens"] = ["inputTokens", "outputTokens", "cacheRead", "cacheWrite"]
        .iter()
        .map(|key| or_zero(&day[key]))
        .reduce(|a, b| add(&a, &b))
        .unwrap();
    let mut names = order.cloned().unwrap_or_default();
    for (name, _) in fields(&day["models"]) {
        if !names.iter().any(|existing| existing.text() == name) {
            names.push(V::from(name));
        }
    }
    result["modelBreakdowns"] = V::Array(
        names
            .into_iter()
            .filter(|name| day["models"].has(&name.text()))
            .map(|name| {
                let model = &day["models"][&name.text()];
                object([
                    ("modelName", name),
                    ("cost", or_zero(&model["cost"])),
                    ("outputTokens", or_zero(&model["outputTokens"])),
                    ("estimated", V::Bool(model["estimated"].truthy())),
                ])
            })
            .collect(),
    );
    result
}

fn result(cache: &V, dates: &Dates, unpriced: &[V], model_order: &HashMap<String, Vec<V>>) -> V {
    let daily: Vec<_> = fields(&cache["daily"])
        .into_iter()
        .filter(|(date, _)| *date >= dates.since.as_str())
        .map(|(date, day)| daily_entry(date, day, model_order.get(date)))
        .collect();
    let today_entry = daily
        .iter()
        .find(|entry| entry["date"] == V::from(dates.today.as_str()));
    let mut today = object([
        ("date", V::from(dates.today.clone())),
        ("models", V::object()),
    ]);
    for key in [
        "outputTokens",
        "inputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
        "messages",
        "sessions",
        "toolCalls",
    ] {
        today[key] = today_entry.map_or(V::Number(0.0), |entry| entry[key].clone());
    }
    today["apiEquivCost"] = today_entry.map_or(V::Number(0.0), |entry| entry["totalCost"].clone());
    today["estimated"] = today_entry.map_or(V::Bool(false), |entry| entry["estimated"].clone());
    if let Some(entry) = today_entry {
        for model in entry["modelBreakdowns"].array() {
            today["models"][&model["modelName"].text()] = object([
                ("outputTokens", model["outputTokens"].clone()),
                ("apiCost", model["cost"].clone()),
            ]);
        }
    }
    let mut week = object([
        ("outputTokens", V::Number(0.0)),
        ("messages", V::Number(0.0)),
        ("apiEquivCost", V::Number(0.0)),
        ("models", V::object()),
        ("resetAt", V::from(dates.reset.clone())),
    ]);
    for entry in daily
        .iter()
        .filter(|entry| entry["date"].text() >= dates.monday)
    {
        for (source, target) in [
            ("outputTokens", "outputTokens"),
            ("messages", "messages"),
            ("totalCost", "apiEquivCost"),
        ] {
            increment(&mut week, target, &entry[source]);
        }
        for model in entry["modelBreakdowns"].array() {
            let name = model["modelName"].text();
            if !week["models"].has(&name) {
                week["models"][&name] = object([
                    ("outputTokens", V::Number(0.0)),
                    ("apiCost", V::Number(0.0)),
                ]);
            }
            increment(
                &mut week["models"][&name],
                "outputTokens",
                &model["outputTokens"],
            );
            increment(&mut week["models"][&name], "apiCost", &model["cost"]);
        }
    }
    object([
        ("today", today),
        ("week", week),
        ("daily", V::Array(daily)),
        ("unpricedModels", V::Array(unpriced.to_vec())),
    ])
}

impl Store {
    pub fn new(directory: PathBuf) -> Self {
        let home = directory.join("home");
        Self::new_legacy(directory, home)
    }

    pub fn new_legacy(directory: PathBuf, home: PathBuf) -> Self {
        Self {
            directory,
            home,
            state: Mutex::new(State::default()),
        }
    }

    fn safe(&self, path: &Path) -> bool {
        crate::account_hub::safe_path(&self.directory, path)
            || crate::account_hub::safe_path(&self.home, path)
    }

    fn read_json(&self, path: &Path) -> Option<V> {
        if !self.safe(path) || !fs::symlink_metadata(path).ok()?.is_file() {
            return None;
        }
        let raw =
            RawValue::from_string(String::from_utf8_lossy(&fs::read(path).ok()?).into_owned())
                .ok()?;
        V::parse(&raw).ok()
    }

    fn load_cache(&self) -> V {
        let mut cache = self
            .read_json(&self.directory.join("cost-cache.json"))
            .unwrap_or_else(V::object);
        if !matches!(cache["daily"], V::Object(_)) {
            cache["daily"] = V::object();
        }
        cache
    }

    fn save_cache(&self, cache: &V) {
        let path = self.directory.join("cost-cache.json");
        if !self.safe(&path)
            || fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.is_file())
        {
            return;
        }
        let save = || -> std::io::Result<()> {
            let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
            file.write_all(cache.raw().get().as_bytes())?;
            file.flush()?;
            file.persist(&path).map_err(|error| error.error)?;
            Ok(())
        };
        let _ = save();
    }

    fn files(&self, since: f64) -> Vec<PathBuf> {
        let root = self.home.join(".claude/projects");
        if !self.safe(&root) {
            return vec![];
        }
        let mut projects: Vec<_> = fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        projects.sort();
        let mut files = vec![];
        for project in projects {
            if !self.safe(&project)
                || !fs::symlink_metadata(&project).is_ok_and(|meta| meta.is_dir())
            {
                continue;
            }
            let mut children: Vec<_> = fs::read_dir(project)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
                .collect();
            children.sort();
            for path in children {
                if path.extension().is_none_or(|ext| ext != "jsonl") || !self.safe(&path) {
                    continue;
                }
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if !metadata.is_file() {
                    continue;
                }
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs_f64() * 1000.0);
                if modified.is_some_and(|modified| modified >= since) {
                    files.push(path);
                }
            }
        }
        files
    }

    fn parse(&self, path: &Path, since: Option<&str>) -> Vec<Entry> {
        if !self.safe(path) || !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file()) {
            return vec![];
        }
        let Ok(file) = File::open(path) else {
            return vec![];
        };
        let session = V::from(
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        );
        let mut entries = vec![];
        for bytes in BufReader::new(file).split(b'\n') {
            let Ok(bytes) = bytes else {
                break;
            };
            let line = String::from_utf8_lossy(&bytes);
            if !line.contains("\"usage\"") {
                continue;
            }
            let Ok(raw) = RawValue::from_string(line.into_owned()) else {
                continue;
            };
            let Ok(value) = V::parse(&raw) else {
                continue;
            };
            let message = &value["message"];
            if !message["usage"].truthy()
                || !message["model"].truthy()
                || message["model"].text().starts_with('<')
            {
                continue;
            }
            let timestamp = if value["timestamp"].truthy() {
                &value["timestamp"]
            } else {
                &message["timestamp"]
            };
            if !timestamp.is_string() || !timestamp.truthy() {
                continue;
            }
            let date = timestamp.cut(10);
            if since.is_some_and(|since| {
                date.units()
                    .iter()
                    .copied()
                    .cmp(since.encode_utf16())
                    .is_lt()
            }) {
                continue;
            }
            let key = if message["id"].truthy() {
                let mut key = string_units(&message["id"]);
                key.push(u16::from(b':'));
                if value["requestId"].truthy() {
                    key.extend(string_units(&value["requestId"]));
                }
                key
            } else {
                format!("{}#{}", path.display(), entries.len())
                    .encode_utf16()
                    .collect()
            };
            let tools = message["content"]
                .array()
                .iter()
                .filter(|content| content["type"] == V::from("tool_use"))
                .count() as f64;
            entries.push(Entry {
                date,
                model: message["model"].clone(),
                usage: message["usage"].clone(),
                key,
                session: session.clone(),
                tools,
            });
        }
        entries
    }

    fn compute_at(&self, now: f64) -> V {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if now - state.timestamp < MEMORY_TTL_MS {
            if let Some(result) = &state.result {
                return result.clone();
            }
        }
        let dates = dates(now);
        if state.date != dates.today {
            state.files.clear();
            state.date = dates.today.clone();
        }
        let mut cache = self.load_cache();
        let mut entries = vec![];
        for path in self.files(dates.midnight) {
            let size = fs::symlink_metadata(&path).map(|metadata| metadata.len());
            if let Ok(size) = size {
                if let Some((cached_size, cached_entries)) = state.files.get(&path) {
                    // Preserve Node's size-only reuse: same-size rewrites remain stale.
                    if *cached_size == size {
                        entries.extend(cached_entries.clone());
                        continue;
                    }
                }
                let parsed = self.parse(&path, Some(&dates.today));
                state.files.insert(path, (size, parsed.clone()));
                entries.extend(parsed);
            } else {
                entries.extend(self.parse(&path, Some(&dates.today)));
            }
        }
        let (today, model_order) = aggregate(entries, &mut state.unpriced);
        state.model_order.extend(model_order);
        // Node leaves persisted history intact when no surviving entry describes today.
        if today.has(&dates.today) {
            cache["daily"][&dates.today] = today[&dates.today].clone();
            self.save_cache(&cache);
        }
        let value = result(&cache, &dates, &state.unpriced, &state.model_order);
        state.result = Some(value.clone());
        state.timestamp = now;
        value
    }

    pub fn compute(&self) -> V {
        self.compute_at(now_ms())
    }

    pub fn insights(&self) -> V {
        self.insights_at(now_ms())
    }

    fn insights_at(&self, now: f64) -> V {
        let dates = dates(now);
        let entries = dedupe(
            self.files(dates.midnight)
                .into_iter()
                .flat_map(|path| self.parse(&path, Some(&dates.today)))
                .collect(),
        );
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let mut sessions: Vec<(V, V)> = vec![];
        let mut models: Vec<(V, V)> = vec![];
        let mut today_cost = 0.0;
        let mut opus_out = V::Number(0.0);
        for entry in entries
            .into_iter()
            .filter(|entry| entry.date == V::from(dates.today.as_str()))
        {
            let (amount, _) = cost(&entry.model, &entry.usage, &mut state.unpriced);
            let output = or_zero(&entry.usage["output_tokens"]);
            today_cost += amount;
            let name = model_name(&entry.model);
            if name.text().to_lowercase().contains("opus") {
                opus_out = add(&opus_out, &output);
            }
            for (items, key, field, messages) in [
                (&mut sessions, entry.session, "sessionId", true),
                (&mut models, name, "model", false),
            ] {
                let index = items
                    .iter()
                    .position(|(existing, _)| existing == &key)
                    .unwrap_or_else(|| {
                        let mut value = object([
                            (field, key.clone()),
                            ("cost", V::Number(0.0)),
                            ("outputTokens", V::Number(0.0)),
                        ]);
                        if messages {
                            value["messages"] = V::Number(0.0);
                        }
                        items.push((key, value));
                        items.len() - 1
                    });
                increment(&mut items[index].1, "cost", &V::Number(amount));
                increment(&mut items[index].1, "outputTokens", &output);
                if messages {
                    increment(&mut items[index].1, "messages", &V::Number(1.0));
                }
            }
        }
        for items in [&mut sessions, &mut models] {
            items.sort_by(|a, b| {
                b.1["cost"]
                    .number()
                    .partial_cmp(&a.1["cost"].number())
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        object([
            ("date", V::from(dates.today)),
            ("todayCost", V::Number(today_cost)),
            (
                "burnPerHour",
                V::Number(today_cost / ((now - dates.midnight) / 3_600_000.0).max(0.1)),
            ),
            (
                "bySession",
                V::Array(
                    sessions
                        .into_iter()
                        .take(10)
                        .map(|(_, value)| value)
                        .collect(),
                ),
            ),
            (
                "byModel",
                V::Array(models.into_iter().map(|(_, value)| value).collect()),
            ),
            (
                "savingsCeiling",
                V::Number(opus_out.number() / 1_000_000.0 * 60.0),
            ),
            ("opusOutputTokens", opus_out),
            ("savingsNote", V::from(SAVINGS_NOTE)),
        ])
    }

    pub fn stats(&self) -> V {
        self.read_json(&self.home.join(".claude/stats-cache.json"))
            .unwrap_or(V::Null)
    }

    // Used by the cache-rebuild parity test; no production HTTP route invokes it.
    #[cfg(test)]
    pub fn recompute_all(&self) -> V {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let files = self.files(0.0);
        let entries = files
            .iter()
            .flat_map(|path| self.parse(path, None))
            .collect();
        let (daily, model_order) = aggregate(entries, &mut state.unpriced);
        state.model_order = model_order;
        let days = fields(&daily).len();
        self.save_cache(&object([("daily", daily)]));
        state.result = None;
        state.timestamp = 0.0;
        object([
            ("days", V::Number(days as f64)),
            ("files", V::Number(files.len() as f64)),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(date: &str, id: &str, model: &str, output: u64) -> String {
        serde_json::json!({"timestamp":format!("{date}T12:00:00Z"),"requestId":"request","message":{"id":id,"model":model,"usage":{"input_tokens":100,"output_tokens":output},"content":[{"type":"tool_use"}]}}).to_string() + "\n"
    }

    #[test]
    fn legacy_home_reads_usage_and_stats_while_cache_stays_in_directory() {
        let directory = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let preview = Store::new(directory.path().into());
        let legacy = Store::new_legacy(directory.path().into(), home.path().into());
        let project = home.path().join(".claude/projects/demo");
        fs::create_dir_all(&project).unwrap();
        let date = dates(now_ms()).today;
        fs::write(
            project.join("session.jsonl"),
            line(&date, "legacy", "claude-sonnet-4-9", 20),
        )
        .unwrap();
        let stats = home.path().join(".claude/stats-cache.json");
        fs::write(&stats, "{\"totalSessions\":7}").unwrap();
        assert!(preview.files(0.0).is_empty());
        assert_eq!(preview.stats(), V::Null);
        assert_eq!(legacy.stats()["totalSessions"], V::Number(7.0));
        assert_eq!(legacy.recompute_all()["files"], V::Number(1.0));
        assert!(directory.path().join("cost-cache.json").is_file());
        assert!(!home.path().join("cost-cache.json").exists());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            let target = outside.path().join("outside.json");
            fs::write(&target, "{\"totalSessions\":99}").unwrap();
            fs::remove_file(&stats).unwrap();
            std::os::unix::fs::symlink(&target, &stats).unwrap();
            std::os::unix::fs::symlink(&target, project.join("escape.jsonl")).unwrap();
            assert_eq!(legacy.stats(), V::Null);
            assert_eq!(legacy.files(0.0).len(), 1);
            assert!(!legacy.safe(&target));
        }
    }

    #[test]
    fn pricing_families_unknowns_and_utf16_are_preserved() {
        let mut unpriced = vec![];
        let usage = object([("output_tokens", V::Number(1_000_000.0))]);
        assert_eq!(
            cost(&V::from("claude-sonnet-4-9"), &usage, &mut unpriced),
            (15.0, false)
        );
        assert_eq!(cost(&V::from("HAIKU"), &usage, &mut unpriced), (4.0, false));
        let model = V::String(vec![0xd800]);
        assert_eq!(cost(&model, &usage, &mut unpriced), (75.0, true));
        cost(&model, &usage, &mut unpriced);
        assert_eq!(unpriced, vec![model]);
        assert_eq!(
            model_name(&V::from("claude-opus-4-6-20260101")),
            V::from("opus-4-6")
        );
        assert_eq!(add(&V::Number(0.0), &V::from("10")), V::from("010"));
    }

    #[test]
    fn model_breakdown_values_retain_first_seen_order_and_utf16() {
        let model = V::String(vec![0xd800]);
        let entries = [
            V::from("claude-sonnet-4-9"),
            V::from("claude-haiku-4-5"),
            model.clone(),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, model)| Entry {
            date: V::from("2026-10-07"),
            model,
            usage: object([("output_tokens", V::Number(100.0))]),
            key: vec![index as u16],
            session: V::from("session"),
            tools: 0.0,
        })
        .collect();
        let (daily, order) = aggregate(entries, &mut vec![]);
        let value = daily_entry("2026-10-07", &daily["2026-10-07"], order.get("2026-10-07"));
        let names: Vec<_> = value["modelBreakdowns"]
            .array()
            .iter()
            .map(|item| item["modelName"].clone())
            .collect();
        assert_eq!(
            names,
            vec![V::from("sonnet-4-9"), V::from("haiku-4-5"), model]
        );
    }

    #[test]
    fn fixture_dedup_truncation_cache_history_and_insights() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let project = directory.path().join("home/.claude/projects/demo");
        fs::create_dir_all(&project).unwrap();
        let path = project.join("session.jsonl");
        let now = dates(now_ms()).midnight + 12.0 * 3_600_000.0;
        let date = dates(now).today;
        let first = line(&date, "first", "claude-opus-4-6", 100);
        let second = line(&date, "second", "claude-sonnet-4-9", 20);
        fs::write(
            &path,
            format!(
                "{first}{first}{second}{{broken\n{}",
                line(&date, "synthetic", "<synthetic>", 999)
            ),
        )
        .unwrap();
        let usage = store.compute_at(now);
        assert_eq!(usage["today"]["messages"], V::Number(2.0));
        assert_eq!(usage["today"]["sessions"], V::Number(1.0));
        assert_eq!(usage["today"]["toolCalls"], V::Number(2.0));
        assert_eq!(usage["today"]["outputTokens"], V::Number(120.0));
        assert!(usage["unpricedModels"].array().is_empty());
        fs::write(&path, &first).unwrap();
        assert_eq!(store.compute_at(now + 1000.0), usage);
        let truncated = store.compute_at(now + MEMORY_TTL_MS);
        assert_eq!(truncated["today"]["messages"], V::Number(1.0));
        assert_eq!(truncated["today"]["outputTokens"], V::Number(100.0));
        let insight = store.insights_at(now);
        assert_eq!(
            insight["bySession"].array()[0]["sessionId"],
            V::from("session")
        );
        assert_eq!(insight["opusOutputTokens"], V::Number(100.0));
        assert!((insight["savingsCeiling"].number() - 0.006).abs() < 1e-12);
        assert_eq!(store.recompute_all()["files"], V::Number(1.0));
        assert!(directory.path().join("cost-cache.json").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn private_stats_and_sessions_reject_symlink_escapes() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let home = directory.path().join("home/.claude");
        fs::create_dir_all(&home).unwrap();
        fs::write(outside.path().join("stats"), r#"{"secret":"untouched"}"#).unwrap();
        std::os::unix::fs::symlink(outside.path().join("stats"), home.join("stats-cache.json"))
            .unwrap();
        std::os::unix::fs::symlink(outside.path(), home.join("projects")).unwrap();
        assert_eq!(store.stats(), V::Null);
        assert!(store.files(0.0).is_empty());
        fs::remove_file(home.join("stats-cache.json")).unwrap();
        fs::write(home.join("stats-cache.json"), r#"{"display":"\ud800"}"#).unwrap();
        assert_eq!(store.stats()["display"].units(), &[0xd800]);
    }
}
