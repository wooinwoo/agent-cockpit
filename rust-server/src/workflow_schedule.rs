use crate::{
    board_value::{object, V},
    events,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    fs,
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/workflows/schedules"),
    ("POST", "/api/workflows/schedules"),
    ("PUT", "/api/workflows/schedules/:id"),
    ("DELETE", "/api/workflows/schedules/:id"),
];
fn id(path: &str) -> Option<&str> {
    path.strip_prefix("/api/workflows/schedules/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
}
pub fn route(method: &Method, path: &str) -> bool {
    (path == "/api/workflows/schedules" && matches!(*method, Method::GET | Method::POST))
        || (id(path).is_some() && matches!(*method, Method::PUT | Method::DELETE))
}
fn invalid() -> io::Error {
    io::Error::other("Invalid workflow schedule storage")
}
fn default(value: &V, fallback: V) -> V {
    if *value == V::Null {
        fallback
    } else {
        value.clone()
    }
}
fn or(value: &V, fallback: V) -> V {
    if value.truthy() {
        value.clone()
    } else {
        fallback
    }
}

#[cfg(unix)]
fn local(ms: i64) -> Option<libc::tm> {
    let seconds = ms.div_euclid(1000) as libc::time_t;
    let mut value = unsafe { std::mem::zeroed() };
    (!unsafe { libc::localtime_r(&seconds, &mut value) }.is_null()).then_some(value)
}
#[cfg(unix)]
fn civil(value: &libc::tm) -> (i32, i32, i32, i32, i32, i32) {
    (
        value.tm_year,
        value.tm_mon,
        value.tm_mday,
        value.tm_hour,
        value.tm_min,
        value.tm_sec,
    )
}
#[cfg(unix)]
fn timestamp(mut value: libc::tm) -> Option<i64> {
    // Normalize civil overflow without changing the process timezone. JavaScript
    // chooses the earlier instant in a fold and moves forward through a gap.
    unsafe { libc::timegm(&mut value) };
    let wanted = civil(&value);
    let mut exact = vec![];
    let mut after = vec![];
    let mut fallback = None;
    for dst in [-1, 0, 1] {
        let mut candidate = value;
        candidate.tm_isdst = dst;
        let seconds = unsafe { libc::mktime(&mut candidate) };
        let ms = (seconds as i64).checked_mul(1000)?;
        if ms.abs() > 8_640_000_000_000_000 {
            continue;
        }
        let actual = local(ms)?;
        if dst == -1 {
            fallback = Some(ms);
        }
        if civil(&actual) == wanted {
            exact.push(ms);
        } else if civil(&actual) > wanted {
            after.push((civil(&actual), ms));
        }
    }
    exact
        .into_iter()
        .min()
        .or_else(|| after.into_iter().min().map(|(_, ms)| ms))
        .or(fallback)
}
#[cfg(unix)]
fn integer(value: f64) -> Option<i32> {
    (value.is_finite() && value.trunc() >= i32::MIN as f64 && value.trunc() <= i32::MAX as f64)
        .then_some(value.trunc() as i32)
}

/// JavaScript local-Date scheduling, with an explicit clock for boundary tests.
pub fn next_run(schedule: &V, now: i64) -> V {
    if !schedule["enabled"].truthy() {
        return V::Null;
    }
    #[cfg(unix)]
    {
        let compute = || -> Option<i64> {
            let current = local(now)?;
            let mut next = current;
            next.tm_hour = integer(default(&schedule["hour"], 9.0.into()).number())?;
            next.tm_min = 0;
            next.tm_sec = 0;
            let day = default(&schedule["day"], 1.0.into()).number();
            if schedule["preset"] == V::from("monthly") {
                next.tm_mday = integer(if day.is_nan() { day } else { day.min(28.0) })?;
                let first = timestamp(next)?;
                if first > now {
                    return Some(first);
                }
                next.tm_mon = current.tm_mon + 1;
                return timestamp(next);
            }
            let first = timestamp(next)?;
            next = local(first)?;
            if schedule["preset"] == V::from("weekly") {
                let mut ahead = day - next.tm_wday as f64;
                if ahead < 0.0 {
                    ahead += 7.0;
                }
                if ahead == 0.0 && first <= now {
                    ahead = 7.0;
                }
                next.tm_mday = integer(next.tm_mday as f64 + ahead)?;
                timestamp(next)
            } else if first <= now {
                next.tm_mday += 1;
                timestamp(next)
            } else {
                Some(first)
            }
        };
        compute().map(|ms| V::Number(ms as f64)).unwrap_or(V::Null)
    }
    #[cfg(not(unix))]
    {
        let _ = now;
        V::Null
    }
}

pub struct Store {
    directory: PathBuf,
    events: Arc<events::Store>,
    writes: Mutex<()>,
}
pub struct Claim {
    pub schedule: V,
    previous: V,
}
impl Store {
    pub fn new(directory: PathBuf, events: Arc<events::Store>) -> Self {
        Self {
            directory,
            events,
            writes: Mutex::new(()),
        }
    }
    fn read(&self) -> io::Result<Vec<V>> {
        let path = self.directory.join("workflow-schedules.json");
        if !crate::account_hub::safe_path(&self.directory, &path) {
            return Err(invalid());
        }
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Ok(meta) if meta.is_file() => {}
            _ => return Err(invalid()),
        }
        let raw = serde_json::value::RawValue::from_string(fs::read_to_string(path)?)
            .map_err(|_| invalid())?;
        let value = V::parse(&raw).map_err(|_| invalid())?;
        if !value.is_array() || value.array().iter().any(|row| !matches!(row, V::Object(_))) {
            return Err(invalid());
        }
        Ok(value.array().to_vec())
    }
    fn save(&self, schedules: &[V]) -> io::Result<()> {
        self.read()?;
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
        file.write_all(V::Array(schedules.to_vec()).raw().get().as_bytes())?;
        file.as_file().sync_all()?;
        file.persist(self.directory.join("workflow-schedules.json"))
            .map_err(|error| error.error)?;
        Ok(())
    }
    fn publish(&self, value: V) {
        self.events
            .publish_raw("schedule:update", value.raw().get());
    }
    fn due_at(&self, now: i64) -> io::Result<Vec<Claim>> {
        let _guard = self.writes.lock().unwrap();
        let mut schedules = self.read()?;
        let mut due = vec![];
        let mut changed = false;
        for schedule in &mut schedules {
            if !schedule["enabled"].truthy() {
                continue;
            }
            if !schedule["nextRunAt"].truthy() {
                let next = next_run(schedule, now);
                if !schedule.has("nextRunAt") || schedule["nextRunAt"] != next {
                    schedule["nextRunAt"] = next;
                    changed = true;
                }
                continue;
            }
            if schedule["nextRunAt"].number() > now as f64 {
                continue;
            }
            let previous = schedule.clone();
            schedule["lastRunAt"] = (now as f64).into();
            schedule["nextRunAt"] = next_run(schedule, now);
            due.push(Claim {
                schedule: schedule.clone(),
                previous,
            });
            changed = true;
        }
        if changed {
            self.save(&schedules)?;
        }
        Ok(due)
    }
    pub fn restore_unstarted(&self, claims: &[Claim]) -> io::Result<()> {
        let _guard = self.writes.lock().unwrap();
        let mut schedules = self.read()?;
        let mut changed = false;
        for claim in claims {
            if let Some(row) = schedules.iter_mut().find(|row| **row == claim.schedule) {
                *row = claim.previous.clone();
                changed = true;
            }
        }
        if changed {
            self.save(&schedules)?;
        }
        Ok(())
    }
    pub fn due(&self) -> io::Result<Vec<Claim>> {
        #[cfg(unix)]
        {
            self.due_at(crate::account_usage::now())
        }
        #[cfg(not(unix))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Local workflow scheduling requires Unix",
            ))
        }
    }
    fn request(&self, method: &Method, path: &str, input: &V) -> io::Result<Response> {
        let _guard = self.writes.lock().unwrap();
        let mut schedules = self.read()?;
        if path == "/api/workflows/schedules" && *method == Method::GET {
            return Ok(Json(V::Array(schedules).raw()).into_response());
        }
        let now = crate::account_usage::now();
        if path == "/api/workflows/schedules" && *method == Method::POST {
            if !input["workflowId"].truthy() {
                return Ok(crate::error(400, "workflowId required"));
            }
            let id = loop {
                let id = rand::random::<[u8; 6]>()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                if !schedules.iter().any(|row| row["id"] == V::from(id.clone())) {
                    break id;
                }
            };
            let mut row = object([
                ("id", id.into()),
                ("workflowId", input["workflowId"].clone()),
                (
                    "workflowName",
                    or(&input["workflowName"], input["workflowId"].clone()),
                ),
                ("inputs", or(&input["inputs"], V::object())),
                ("preset", or(&input["preset"], "weekly".into())),
                ("hour", default(&input["hour"], 9.0.into())),
                ("day", default(&input["day"], 1.0.into())),
                ("enabled", true.into()),
                ("lastRunAt", V::Null),
                ("nextRunAt", V::Null),
                ("createdAt", (now as f64).into()),
            ]);
            row["nextRunAt"] = next_run(&row, now);
            schedules.push(row.clone());
            self.save(&schedules)?;
            self.publish(object([
                ("action", "added".into()),
                ("schedule", row.clone()),
            ]));
            return Ok((axum::http::StatusCode::CREATED, Json(row.raw())).into_response());
        }
        let Some(id) = id(path) else {
            return Ok(crate::error(404, "Not found"));
        };
        let Some(index) = schedules.iter().position(|row| row["id"] == V::from(id)) else {
            return Ok(crate::error(404, "Not found"));
        };
        if *method == Method::DELETE {
            let removed = schedules.remove(index);
            self.save(&schedules)?;
            self.publish(object([
                ("action", "removed".into()),
                ("id", removed["id"].clone()),
            ]));
            return Ok(Json(object([("deleted", true.into())]).raw()).into_response());
        }
        if *method != Method::PUT {
            return Ok(crate::error(404, "Not found"));
        }
        for key in ["preset", "hour", "day", "enabled", "inputs"] {
            if input.has(key) {
                schedules[index][key] = input[key].clone();
            }
        }
        schedules[index]["nextRunAt"] = next_run(&schedules[index], now);
        self.save(&schedules)?;
        let row = schedules[index].clone();
        self.publish(object([
            ("action", "updated".into()),
            ("schedule", row.clone()),
        ]));
        Ok(Json(row.raw()).into_response())
    }
    pub fn handle(&self, method: &Method, path: &str, input: &V) -> Response {
        #[cfg(unix)]
        {
            self.request(method, path, input)
                .unwrap_or_else(|_| crate::error(500, "Workflow schedule storage operation failed"))
        }
        #[cfg(not(unix))]
        {
            let _ = (method, path, input);
            crate::error(501, "Local workflow scheduling requires Unix")
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn schedule(preset: &str, hour: f64, day: f64) -> V {
        object([
            ("enabled", true.into()),
            ("preset", preset.into()),
            ("hour", hour.into()),
            ("day", day.into()),
        ])
    }
    fn clock(year: i32, month: i32, day: i32, hour: i32) -> i64 {
        let mut value: libc::tm = unsafe { std::mem::zeroed() };
        value.tm_year = year - 1900;
        value.tm_mon = month - 1;
        value.tm_mday = day;
        value.tm_hour = hour;
        timestamp(value).unwrap()
    }
    #[test]
    fn daily_weekly_monthly_boundaries_and_overflow() {
        let now = clock(2026, 1, 31, 9);
        assert_eq!(
            next_run(&schedule("daily", 9.0, 1.0), now),
            V::Number(clock(2026, 2, 1, 9) as f64)
        );
        assert_eq!(
            next_run(&schedule("fallback", 25.0, 1.0), now),
            V::Number(clock(2026, 2, 1, 1) as f64)
        );
        assert_eq!(
            next_run(&schedule("monthly", 9.0, 31.0), now),
            V::Number(clock(2026, 2, 28, 9) as f64)
        );
        assert_eq!(
            next_run(&schedule("weekly", 9.0, 6.0), now),
            V::Number(clock(2026, 2, 7, 9) as f64)
        );
        assert_eq!(
            next_run(&schedule("monthly", 9.0, 0.0), now),
            V::Number(now as f64)
        );
        assert_eq!(
            next_run(&schedule("daily", f64::INFINITY, 1.0), now),
            V::Null
        );
    }
    #[test]
    fn due_once_missing_disabled_future_and_cold_restore() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into(), events::Store::new());
        let now = clock(2026, 1, 31, 8);
        let mut rows = vec![];
        for (id, next, enabled) in [
            ("past", Some(now - 1), true),
            ("future", Some(now + 60_000), true),
            ("missing", None, true),
            ("disabled", Some(now - 1), false),
        ] {
            let mut row = schedule("daily", 9.0, 1.0);
            row["id"] = id.into();
            row["enabled"] = enabled.into();
            row["unknown"] = "preserve".into();
            if let Some(next) = next {
                row["nextRunAt"] = (next as f64).into();
            }
            rows.push(row);
        }
        store.save(&rows).unwrap();
        let due = store.due_at(now).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].schedule["id"], V::from("past"));
        assert_eq!(due[0].schedule["lastRunAt"], V::Number(now as f64));
        let restored = Store::new(directory.path().into(), events::Store::new());
        assert!(restored.due_at(now).unwrap().is_empty());
        let rows = restored.read().unwrap();
        assert!(rows[2]["nextRunAt"].number() > now as f64);
        assert_eq!(rows[3]["nextRunAt"], V::Number((now - 1) as f64));
        assert!(rows.iter().all(|row| row["unknown"] == V::from("preserve")));
        restored.restore_unstarted(&due).unwrap();
        assert_eq!(restored.read().unwrap()[0]["lastRunAt"], V::Null);
        let reclaimed = restored.due_at(now).unwrap();
        assert_eq!(reclaimed.len(), 1);
        let mut edited = restored.read().unwrap();
        edited[0]["inputs"] = object([("new", true.into())]);
        restored.save(&edited).unwrap();
        restored.restore_unstarted(&reclaimed).unwrap();
        assert_eq!(restored.read().unwrap(), edited);
        fs::write(directory.path().join("workflow-schedules.json"), "{broken").unwrap();
        assert!(restored.due_at(now).is_err());
        assert_eq!(
            fs::read_to_string(directory.path().join("workflow-schedules.json")).unwrap(),
            "{broken"
        );
    }
}
