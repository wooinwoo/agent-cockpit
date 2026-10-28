use crate::{
    board_value::{object, V},
    project_polling, projects,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/briefing"),
    ("GET", "/api/alerts"),
    ("GET", "/api/alerts/prefs"),
    ("POST", "/api/alerts/prefs"),
];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, target)| method.as_str() == *verb && path == *target)
}
pub struct Store {
    directory: PathBuf,
    writes: Mutex<()>,
}
fn or(value: &V, fallback: V) -> V {
    if value.truthy() {
        value.clone()
    } else {
        fallback
    }
}
fn text(parts: &[V]) -> V {
    V::String(
        parts
            .iter()
            .flat_map(|v| {
                if v.is_string() {
                    v.units().to_vec()
                } else {
                    v.text().encode_utf16().collect()
                }
            })
            .collect(),
    )
}
fn local_date(now: i64) -> String {
    #[cfg(unix)]
    {
        let seconds = now.div_euclid(1000) as libc::time_t;
        let mut local: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&seconds, &mut local) };
        format!(
            "{:04}-{:02}-{:02}",
            local.tm_year + 1900,
            local.tm_mon + 1,
            local.tm_mday
        )
    }
    #[cfg(not(unix))]
    {
        crate::account_usage::iso(now).chars().take(10).collect()
    }
}
fn age(now: i64, value: &V) -> f64 {
    let time = if value.is_string() {
        crate::account_usage::date(&value.text()).map(|n| n as f64)
    } else {
        Some(value.number())
    };
    time.map(|n| now as f64 - n).unwrap_or(f64::NAN)
}
fn ordered(mut states: Vec<(String, V)>) -> Vec<(String, V)> {
    // Object.entries enumerates integer-index keys before the other inserted keys.
    let index = |s: &str| {
        s.parse::<u32>()
            .ok()
            .filter(|n| *n != u32::MAX && n.to_string() == s)
    };
    states.sort_by(|a, b| match (index(&a.0), index(&b.0)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });
    states
}
fn fixed_two(n: f64) -> String {
    // JS toFixed chooses the larger integer at exact ties; format! uses even ties.
    if !n.is_finite() {
        return "Infinity".into();
    }
    if n >= 1e21 {
        return format!("{n:e}").replace('e', "e+");
    }
    let bits = n.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32 - 1023 - 52;
    let scaled = ((bits & ((1u64 << 52) - 1)) | (1u64 << 52)) as u128 * 100;
    let cents = if exponent >= 0 {
        scaled << exponent
    } else {
        let divisor = 1u128 << -exponent;
        scaled / divisor + u128::from(scaled % divisor >= divisor / 2)
    };
    format!("{}.{:02}", cents / 100, cents % 100)
}
fn alerts(states: &[(String, V)], cost: &V, now: i64) -> V {
    let mut out = vec![];
    for (id, state) in states {
        let session = &state["session"];
        if session["state"] == V::from("busy") && session["lastActivity"].truthy() {
            let elapsed = age(now, &session["lastActivity"]);
            if elapsed > 300_000.0 && elapsed < 360_000.0 {
                out.push(alert(
                    id,
                    "session_stuck",
                    format!(
                        "{id}: Session busy for {}min — may be stuck",
                        (elapsed / 60_000.0 + 0.5).floor()
                    )
                    .into(),
                ));
            }
        }
        if let Some(run) = state["cicd"]["runs"]
            .array()
            .iter()
            .find(|r| r["conclusion"] == V::from("failure") && r["status"] == V::from("completed"))
        {
            if age(now, &or(&run["updated_at"], run["created_at"].clone())) < 600_000.0 {
                out.push(alert(
                    id,
                    "ci_failure",
                    text(&[
                        format!("{id}: CI failed — ").into(),
                        or(&run["name"], "workflow".into()),
                    ]),
                ));
            }
        }
    }
    if cost["today"]["apiEquivCost"].number() > 10.0 {
        out.push(alert(
            "_global",
            "cost_exceeded",
            format!(
                "Daily cost ${} exceeded $10 budget",
                fixed_two(cost["today"]["apiEquivCost"].number())
            )
            .into(),
        ));
    }
    V::Array(out)
}
fn alert(id: &str, kind: &str, message: V) -> V {
    object([
        ("level", "urgent".into()),
        ("projectId", id.into()),
        ("type", kind.into()),
        ("message", message),
    ])
}
fn briefing(states: &[(String, V)], cost: &V, previous: &V, now: i64) -> V {
    let mut items = vec![];
    let mut attention_count = 0;
    for (id, state) in states {
        let prev = &previous["projects"][id.as_str()];
        let mut changes = vec![];
        let mut attention = false;
        if let Some(commit) = state["git"]["recentCommits"].array().first() {
            if !prev.truthy()
                || prev["lastCommit"] != commit["message"]
                || prev.has("lastCommit") != commit.has("message")
            {
                changes.push(text(&[
                    "new commits (latest: ".into(),
                    if commit.has("message") {
                        commit["message"].clone()
                    } else {
                        "undefined".into()
                    },
                    ")".into(),
                ]));
            }
        }
        if let Some(run) = state["cicd"]["runs"].array().first() {
            if run["conclusion"] == V::from("failure") {
                attention = true;
                changes.push(text(&[
                    "CI FAILED: ".into(),
                    or(&run["name"], "workflow".into()),
                ]));
            } else if run["conclusion"] == V::from("success") {
                changes.push("CI passed".into());
            }
        }
        let prs = V::Number(state["prs"]["prs"].array().len() as f64);
        let prev_prs = or(&prev["prCount"], 0.0.into());
        if prs != prev_prs {
            changes.push(text(&["PRs: ".into(), prev_prs, " → ".into(), prs]));
        }
        let uncommitted = or(&state["git"]["uncommittedCount"], 0.0.into());
        if uncommitted.number() > 5.0 {
            attention = true;
            changes.push(text(&[uncommitted, " uncommitted files".into()]));
        }
        if state["session"]["state"] == V::from("busy") {
            attention = true;
            changes.push("Session currently active".into());
        }
        if attention {
            attention_count += 1;
        }
        if !changes.is_empty() {
            items.push(object([
                ("projectId", id.clone().into()),
                ("changes", V::Array(changes)),
                ("needsAttention", attention.into()),
            ]));
        }
    }
    items.sort_by_key(|item| !item["needsAttention"].truthy());
    object([
        ("date", local_date(now).into()),
        ("items", V::Array(items)),
        (
            "cost",
            object([
                ("yesterday", or(&previous["cost"]["daily"], 0.0.into())),
                ("today", or(&cost["today"]["apiEquivCost"], 0.0.into())),
                ("weekly", or(&cost["week"]["apiEquivCost"], 0.0.into())),
            ]),
        ),
        ("attentionCount", V::Number(attention_count as f64)),
        ("totalProjects", V::Number(states.len() as f64)),
        ("hasPreviousSnapshot", previous.truthy().into()),
    ])
}
impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            writes: Mutex::new(()),
        }
    }
    fn read(&self, path: &Path) -> Option<V> {
        if !crate::account_hub::safe_path(&self.directory, path)
            || !fs::symlink_metadata(path).ok()?.is_file()
        {
            return None;
        }
        let raw = serde_json::value::RawValue::from_string(
            String::from_utf8_lossy(&fs::read(path).ok()?).into_owned(),
        )
        .ok()?;
        V::parse(&raw).ok()
    }
    fn save(&self, path: &Path, value: &V, once: bool) -> io::Result<()> {
        if !crate::account_hub::safe_path(&self.directory, path) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Unsafe briefing storage path",
            ));
        }
        if once && path.try_exists()? {
            return Ok(());
        }
        let parent = path.parent().unwrap();
        fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(value.raw().get().as_bytes())?;
        file.as_file().sync_all()?;
        if once {
            match file.persist_noclobber(path) {
                Ok(_) => {}
                Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.error),
            }
        } else {
            file.persist(path).map_err(|e| e.error)?;
        }
        Ok(())
    }
    pub fn startup_snapshot(&self, projects: &projects::Store) -> io::Result<()> {
        let _guard = self.writes.lock().unwrap();
        let now = crate::account_usage::now();
        let date = local_date(now);
        let mut rows = V::object();
        for p in projects.list()? {
            if let Some(id) = p
                .get("id")
                .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
            {
                rows[&id] = object([
                    ("session", "no_data".into()),
                    ("branch", V::Null),
                    ("uncommitted", 0.0.into()),
                    ("lastCommit", V::Null),
                    ("prCount", 0.0.into()),
                ]);
            }
        }
        let snapshot = object([
            ("date", date.clone().into()),
            ("timestamp", crate::account_usage::iso(now).into()),
            ("projects", rows),
            (
                "cost",
                object([("daily", 0.0.into()), ("weekly", 0.0.into())]),
            ),
        ]);
        self.save(
            &self
                .directory
                .join("snapshots")
                .join(format!("{date}.json")),
            &snapshot,
            true,
        )
    }
    pub fn handle(
        &self,
        method: &Method,
        path: &str,
        input: V,
        projects: &projects::Store,
        polling: &project_polling::Store,
    ) -> Response {
        if path == "/api/alerts/prefs" {
            let target = self.directory.join("alerts.json");
            if *method == Method::POST {
                let _guard = self.writes.lock().unwrap();
                if self.save(&target, &input, false).is_err() {
                    return crate::error(500, "Alert preferences storage operation failed");
                }
                return Json(object([("ok", true.into())]).raw()).into_response();
            }
            return Json(
                self.read(&target)
                    .unwrap_or_else(|| {
                        object([
                            ("enabled", true.into()),
                            ("disabledProjects", V::Array(vec![])),
                        ])
                    })
                    .raw(),
            )
            .into_response();
        }
        let rows = match projects.list() {
            Ok(rows) => rows,
            Err(_) => return crate::error(500, "Project storage operation failed"),
        };
        let states = ordered(
            rows.iter()
                .filter_map(|p| {
                    let id = serde_json::from_str::<String>(p.get("id")?.get()).ok()?;
                    let state = object([
                        ("session", polling.cached(&id, "session")),
                        ("git", polling.cached(&id, "git")),
                        // Use the actual PR cache; Node's route mistakenly asks for `prs:` instead of `pr:`.
                        ("prs", polling.cached(&id, "prs")),
                        ("cicd", polling.cached(&id, "cicd")),
                    ]);
                    Some((id, state))
                })
                .collect(),
        );
        let cost = polling.cached("", "cost");
        let now = crate::account_usage::now();
        let result = if path == "/api/alerts" {
            alerts(&states, &cost, now)
        } else {
            let previous = self
                .read(
                    &self
                        .directory
                        .join("snapshots")
                        .join(format!("{}.json", local_date(now - 86_400_000))),
                )
                .unwrap_or(V::Null);
            briefing(&states, &cost, &previous, now)
        };
        Json(result.raw()).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(s: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(s.into()).unwrap()).unwrap()
    }
    #[test]
    fn ordering_changes_attention_and_utf16() {
        let states = ordered(vec![
            (
                "b".into(),
                parse(r#"{"git":{"recentCommits":[{"message":"new\ud800"}]}}"#),
            ),
            (
                "10".into(),
                parse(
                    r#"{"session":{"state":"busy"},"git":{"uncommittedCount":6},"cicd":{"runs":[{"conclusion":"failure"}]},"prs":{"prs":[{}]}}"#,
                ),
            ),
            ("2".into(), V::Null),
        ]);
        let result = briefing(
            &states,
            &parse(r#"{"today":{"apiEquivCost":11},"week":{"apiEquivCost":20}}"#),
            &parse(r#"{"projects":{"10":{"prCount":2}},"cost":{"daily":3}}"#),
            1_770_000_000_000,
        );
        assert_eq!(result["attentionCount"], 1.0.into());
        assert_eq!(result["totalProjects"], 3.0.into());
        assert_eq!(result["items"].array()[0]["projectId"], V::from("10"));
        assert_eq!(result["items"].array()[0]["changes"].array().len(), 4);
        assert!(result["items"].array()[1]["changes"].array()[0]
            .units()
            .contains(&0xd800));
        assert_eq!(result["cost"]["yesterday"], 3.0.into());
        assert!(result["hasPreviousSnapshot"].truthy());
    }
    #[test]
    fn strict_alert_boundaries_and_first_failure() {
        assert_eq!(fixed_two(10.125), "10.13");
        assert_eq!(fixed_two(10.135), "10.13");
        let now = 1_770_000_000_000;
        for (elapsed, count) in [(300_000, 0), (300_001, 1), (359_999, 1), (360_000, 0)] {
            let states = vec![(
                "p".into(),
                object([(
                    "session",
                    object([
                        ("state", "busy".into()),
                        (
                            "lastActivity",
                            crate::account_usage::iso(now - elapsed).into(),
                        ),
                    ]),
                )]),
            )];
            assert_eq!(alerts(&states, &V::Null, now).array().len(), count);
        }
        let state = parse(
            r#"{"cicd":{"runs":[{"conclusion":"failure","status":"completed","updated_at":"2000-01-01T00:00:00Z"},{"conclusion":"failure","status":"completed","updated_at":"2099-01-01T00:00:00Z"}]}}"#,
        );
        assert!(alerts(
            &[("p".into(), state)],
            &parse(r#"{"today":{"apiEquivCost":10}}"#),
            now
        )
        .array()
        .is_empty());
        assert_eq!(
            alerts(&[], &parse(r#"{"today":{"apiEquivCost":10.25}}"#), now).array()[0]["message"],
            V::from("Daily cost $10.25 exceeded $10 budget")
        );
    }
    #[test]
    fn private_atomic_preferences_and_snapshot_no_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().into());
        let path = temp.path().join("alerts.json");
        let value = parse(r#"{"enabled":false,"future":"\ud800","disabledProjects":["p"]}"#);
        store.save(&path, &value, false).unwrap();
        assert_eq!(store.read(&path), Some(value));
        store.save(&path, &V::Null, true).unwrap();
        assert!(store.read(&path).unwrap()["future"].is_string());
        #[cfg(unix)]
        {
            fs::remove_file(&path).unwrap();
            let other = tempfile::tempdir().unwrap();
            let target = other.path().join("sentinel");
            fs::write(&target, "keep").unwrap();
            std::os::unix::fs::symlink(&target, &path).unwrap();
            assert!(store.save(&path, &V::Null, false).is_err());
            assert_eq!(fs::read_to_string(target).unwrap(), "keep");
        }
    }

    #[test]
    fn startup_snapshot_uses_empty_states_and_preserves_existing_day() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("projects.json"),
            r#"{"projects":[{"id":"p","name":"Fixture","path":"/fixture"}]}"#,
        )
        .unwrap();
        let projects = projects::Store::new(temp.path().into()).unwrap();
        let store = Store::new(temp.path().into());
        store.startup_snapshot(&projects).unwrap();
        let files = fs::read_dir(temp.path().join("snapshots"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(files.len(), 1);
        let path = files[0].path();
        let initial = store.read(&path).unwrap();
        assert_eq!(
            initial["projects"]["p"],
            parse(
                r#"{"session":"no_data","branch":null,"uncommitted":0,"lastCommit":null,"prCount":0}"#
            )
        );
        assert_eq!(initial["cost"], parse(r#"{"daily":0,"weekly":0}"#));
        let original = fs::read(&path).unwrap();
        store.startup_snapshot(&projects).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
    }
}
