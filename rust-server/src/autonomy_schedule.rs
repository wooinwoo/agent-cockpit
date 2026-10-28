//! Persisted autonomy schedules and a single-owner execution lease.
use crate::board_value::{object, V};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

const FILE: &str = "scheduled-tasks.json";
const BACKUP: &str = "scheduled-tasks.json.bak";
const MAX_BYTES: usize = 16 * 1024 * 1024;
const DATE_LIMIT: i64 = 8_640_000_000_000_000;

fn string(value: &V) -> Result<V, String> {
    Ok(match value {
        V::String(_) => value.clone(),
        V::Object(_) if value.has("toString") => {
            return Err("Cannot convert object to primitive value".into())
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
        V::Number(n) if *n == 0.0 => "0".into(),
        V::Number(n) if *n == f64::INFINITY => "Infinity".into(),
        V::Number(n) if *n == f64::NEG_INFINITY => "-Infinity".into(),
        V::Number(n) if n.is_finite() && (n.abs() >= 1e21 || n.abs() < 1e-6) => {
            let text = format!("{n:e}");
            let (digits, exponent) = text.split_once('e').unwrap();
            let exponent: i32 = exponent.parse().unwrap();
            format!(
                "{digits}e{}{exponent}",
                if exponent >= 0 { "+" } else { "" }
            )
            .into()
        }
        _ => value.text().into(),
    })
}

fn strict_equal(a: &V, b: &V) -> bool {
    !matches!(a, V::Object(_) | V::Array(_)) && !matches!(b, V::Object(_) | V::Array(_)) && a == b
}

#[cfg(unix)]
fn local(ms: i64) -> Option<libc::tm> {
    if !(-DATE_LIMIT..=DATE_LIMIT).contains(&ms) {
        return None;
    }
    let seconds = ms.div_euclid(1000) as libc::time_t;
    let mut value = unsafe { std::mem::zeroed() };
    (!unsafe { libc::localtime_r(&seconds, &mut value) }.is_null()).then_some(value)
}

#[cfg(unix)]
fn iso(ms: i64) -> Result<V, String> {
    if !(-DATE_LIMIT..=DATE_LIMIT).contains(&ms) {
        return Err("Invalid time value".into());
    }
    let seconds = ms.div_euclid(1000) as libc::time_t;
    let mut value: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut value) }.is_null() {
        return Err("Invalid time value".into());
    }
    let year = value.tm_year + 1900;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!(
            "{}{year:06}",
            if year < 0 { "" } else { "+" },
            year = year.abs()
        )
    };
    // Negative extended years require an explicit sign and six absolute digits.
    let year = if value.tm_year + 1900 < 0 {
        format!("-{year}")
    } else {
        year
    };
    Ok(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.tm_mon + 1,
        value.tm_mday,
        value.tm_hour,
        value.tm_min,
        value.tm_sec,
        ms.rem_euclid(1000)
    )
    .into())
}
#[cfg(not(unix))]
fn iso(_ms: i64) -> Result<V, String> {
    Err("Autonomy schedules require Unix local-time support".into())
}

fn time_clip(number: f64) -> Option<i64> {
    (number.is_finite() && number.abs() <= DATE_LIMIT as f64).then_some(number.trunc() as i64)
}

#[cfg(unix)]
fn civil_timestamp(mut value: libc::tm, utc: bool) -> Option<i64> {
    if utc {
        return (unsafe { libc::timegm(&mut value) } as i64)
            .checked_mul(1000)
            .filter(|ms| ms.abs() <= DATE_LIMIT);
    }
    // Match Date's earlier instant in a repeated hour and forward normalization
    // in a daylight-saving gap, without mutating the process timezone.
    unsafe { libc::timegm(&mut value) };
    let civil = |t: &libc::tm| {
        (
            t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec,
        )
    };
    let wanted = civil(&value);
    let mut exact = Vec::new();
    let mut after = Vec::new();
    let mut fallback = None;
    for dst in [-1, 0, 1] {
        let mut candidate = value;
        candidate.tm_isdst = dst;
        let ms = (unsafe { libc::mktime(&mut candidate) } as i64).checked_mul(1000)?;
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
fn date_text(text: &str) -> Option<i64> {
    static ISO: OnceLock<regex::Regex> = OnceLock::new();
    let iso = ISO.get_or_init(|| regex::Regex::new(r"^([0-9]{4}|[+-][0-9]{6})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:([Tt ])([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?)?$").unwrap());
    let text = text.trim();
    if let Some(parts) = iso.captures(text) {
        let number = |index, default| {
            parts
                .get(index)
                .map(|v| v.as_str().parse::<i32>().ok())
                .unwrap_or(Some(default))
        };
        let year = number(1, 0)?;
        if parts.get(1)?.as_str() == "-000000" {
            return None;
        }
        let month = number(2, 1)?;
        let day = number(3, 1)?;
        let hour = number(5, 0)?;
        let minute = number(6, 0)?;
        let second = number(7, 0)?;
        let millis = parts
            .get(8)
            .map(|v| {
                format!("{:0<3}", v.as_str().chars().take(3).collect::<String>())
                    .parse::<i64>()
                    .ok()
            })
            .unwrap_or(Some(0))?;
        if !(1..=12).contains(&month)
            || !(1..=31).contains(&day)
            || !(0..=24).contains(&hour)
            || !(0..=59).contains(&minute)
            || !(0..=59).contains(&second)
            || (hour == 24 && (minute != 0 || second != 0 || millis != 0))
        {
            return None;
        }
        if parts.get(4).is_some() && (parts.get(2).is_none() || parts.get(3).is_none()) {
            return None;
        }
        let mut value: libc::tm = unsafe { std::mem::zeroed() };
        value.tm_year = year - 1900;
        value.tm_mon = month - 1;
        value.tm_mday = day;
        value.tm_hour = hour;
        value.tm_min = minute;
        value.tm_sec = second;
        let zone = parts.get(9).map(|v| v.as_str());
        let mut ms = civil_timestamp(value, parts.get(4).is_none() || zone.is_some())?
            .checked_add(millis)?;
        if let Some(zone) = zone.filter(|zone| !zone.eq_ignore_ascii_case("z")) {
            let digits = zone[1..].replace(':', "");
            let hours = digits[..2].parse::<i64>().ok()?;
            let minutes = digits[2..].parse::<i64>().ok()?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let offset = (hours * 60 + minutes) * 60_000;
            ms = if zone.starts_with('-') {
                ms.checked_add(offset)?
            } else {
                ms.checked_sub(offset)?
            };
        }
        return time_clip(ms as f64);
    }
    if let Some(ms) = crate::account_usage::date(text) {
        return time_clip(ms as f64);
    }
    // V8's short numeric legacy dates occur when old JSON values contain strings
    // such as "0" or a one-element numeric array rather than ISO timestamps.
    if !text.is_empty() && text.len() <= 3 && text.bytes().all(|byte| byte.is_ascii_digit()) {
        let number = text.parse::<i32>().ok()?;
        let (year, month) = match number {
            0 => (2000, 1),
            1..=12 => (2001, number),
            13..=31 => return None,
            32..=49 => (2000 + number, 1),
            50..=99 => (1900 + number, 1),
            _ => (number, 1),
        };
        let mut value: libc::tm = unsafe { std::mem::zeroed() };
        value.tm_year = year - 1900;
        value.tm_mon = month - 1;
        value.tm_mday = 1;
        return civil_timestamp(value, false);
    }
    None
}

pub(crate) fn date(value: &V) -> Result<Option<i64>, String> {
    match value {
        V::Null => Ok(Some(0)),
        V::Bool(value) => Ok(Some(i64::from(*value))),
        V::Number(number) => Ok(time_clip(*number)),
        _ => {
            let text = string(value)?;
            let Ok(text) = String::from_utf16(text.units()) else {
                return Ok(None);
            };
            #[cfg(unix)]
            {
                Ok(date_text(&text))
            }
            #[cfg(not(unix))]
            {
                let _ = text;
                Err("Autonomy schedules require Unix local-time support".into())
            }
        }
    }
}

/// Match the original scheduler against an explicit JavaScript Date input.
pub fn matches(schedule: &V, now: &V) -> Result<bool, String> {
    if *schedule == V::Null {
        return Err("Cannot read properties of null (reading 'enabled')".into());
    }
    if !schedule["enabled"].truthy() {
        return Ok(false);
    }
    let last = if schedule["lastRun"].truthy() {
        date(&schedule["lastRun"])?
    } else {
        Some(0)
    };
    let now = date(now)?;
    let pattern = &schedule["pattern"];
    if !pattern.is_string() {
        return Err(if *pattern == V::Null {
            format!(
                "Cannot read properties of {} (reading 'match')",
                if schedule.has("pattern") {
                    "null"
                } else {
                    "undefined"
                }
            )
        } else {
            "s.pattern.match is not a function".into()
        });
    }
    static EVERY: OnceLock<regress::Regex> = OnceLock::new();
    static DAILY: OnceLock<regress::Regex> = OnceLock::new();
    let every =
        EVERY.get_or_init(|| regress::Regex::with_flags(r"^every\s+(\d+)\s*(m|h)$", "i").unwrap());
    let daily = DAILY.get_or_init(|| {
        regress::Regex::with_flags(r"^(\d{1,2}):(\d{2})\s+(daily|weekday)$", "i").unwrap()
    });
    if let Some(found) = every.find_from_ucs2(pattern.units(), 0).next() {
        let number = String::from_utf16_lossy(&pattern.units()[found.captures[0].clone().unwrap()])
            .parse::<f64>()
            .unwrap_or(f64::INFINITY);
        let unit = pattern.units()[found.captures[1].clone().unwrap()][0];
        let interval = number
            * if unit == 104 || unit == 72 {
                3_600_000.0
            } else {
                60_000.0
            };
        return Ok(now
            .zip(last)
            .is_some_and(|(now, last)| now as f64 - last as f64 >= interval));
    }
    if let Some(found) = daily.find_from_ucs2(pattern.units(), 0).next() {
        #[cfg(unix)]
        {
            let Some(current) = now.and_then(local) else {
                return Ok(false);
            };
            let number = |index: usize| {
                String::from_utf16_lossy(&pattern.units()[found.captures[index].clone().unwrap()])
                    .parse::<i32>()
                    .unwrap()
            };
            if current.tm_hour != number(0) || current.tm_min != number(1) {
                return Ok(false);
            }
            let mode =
                String::from_utf16_lossy(&pattern.units()[found.captures[2].clone().unwrap()]);
            if mode.eq_ignore_ascii_case("weekday") && matches!(current.tm_wday, 0 | 6) {
                return Ok(false);
            }
            if schedule["lastRun"].truthy() {
                if let Some(last) = last.and_then(local) {
                    if (last.tm_year, last.tm_mon, last.tm_mday)
                        == (current.tm_year, current.tm_mon, current.tm_mday)
                    {
                        return Ok(false);
                    }
                }
            }
            return Ok(true);
        }
        #[cfg(not(unix))]
        {
            let _ = found;
            return Err("Autonomy schedules require Unix local-time support".into());
        }
    }
    Ok(false)
}

struct Storage {
    directory: File,
    path: PathBuf,
}

impl Storage {
    #[cfg(target_os = "linux")]
    fn open(root: &Path, create: bool) -> Result<Option<Self>, String> {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        };
        if !crate::account_hub::safe_path(root, &root.join("logs")) {
            return Err("Unsafe autonomy schedule storage path".into());
        }
        match fs::symlink_metadata(root) {
            Err(error) if error.kind() == io::ErrorKind::NotFound && !create => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(root).map_err(|e| e.to_string())?
            }
            Ok(meta) if meta.is_dir() => {}
            _ => return Err("Invalid autonomy schedule directory".into()),
        }
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(root)
            .map_err(|e| e.to_string())?;
        if create {
            let result = unsafe { libc::mkdirat(root.as_raw_fd(), c"logs".as_ptr(), 0o700) };
            if result != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err(io::Error::last_os_error().to_string());
            }
        }
        let fd = unsafe {
            libc::openat(
                root.as_raw_fd(),
                c"logs".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::NotFound && !create {
                return Ok(None);
            }
            return Err(error.to_string());
        }
        let directory = unsafe { File::from_raw_fd(fd) };
        let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        Ok(Some(Self { directory, path }))
    }
    #[cfg(not(target_os = "linux"))]
    fn open(_root: &Path, _create: bool) -> Result<Option<Self>, String> {
        Err("Native autonomy schedule storage is only validated on Linux".into())
    }

    fn bytes(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = match options.open(self.path.join(name)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
            Ok(file) => file,
        };
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("Invalid autonomy schedule storage file".into());
        }
        let mut data = Vec::new();
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if data.len() > MAX_BYTES {
            return Err("Autonomy schedule storage exceeds size limit".into());
        }
        Ok(Some(data))
    }
    fn read(&self) -> Result<(Vec<V>, Option<Vec<u8>>), String> {
        let bytes = self.bytes(FILE)?;
        let Some(data) = &bytes else {
            return Ok((Vec::new(), None));
        };
        let text = String::from_utf8(data.clone()).map_err(|_| "Invalid autonomy schedule JSON")?;
        let raw = serde_json::value::RawValue::from_string(text)
            .map_err(|_| "Invalid autonomy schedule JSON")?;
        let value = V::parse(&raw).map_err(|_| "Invalid autonomy schedule JSON")?;
        if !value.is_array() || value.array().iter().any(|row| !matches!(row, V::Object(_))) {
            return Err("Invalid autonomy schedule records; original data preserved".into());
        }
        Ok((value.array().to_vec(), bytes))
    }
    fn temporary(&self, bytes: &[u8]) -> Result<tempfile::NamedTempFile, String> {
        let mut file = tempfile::NamedTempFile::new_in(&self.path).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        Ok(file)
    }
    fn save(&self, rows: Vec<V>, before: Option<Vec<u8>>) -> Result<(), String> {
        if self.bytes(FILE)? != before {
            return Err("Autonomy schedules changed during update".into());
        }
        let raw = V::Array(rows).raw();
        if raw.get().len() > MAX_BYTES {
            return Err("Autonomy schedule storage exceeds size limit".into());
        }
        let file = self.temporary(raw.get().as_bytes())?;
        if let Some(before) = &before {
            self.bytes(BACKUP)?; // Refuse a symlink, directory or unreadable backup.
            self.temporary(before)?
                .persist(self.path.join(BACKUP))
                .map_err(|e| e.error.to_string())?;
            self.directory.sync_all().map_err(|e| e.to_string())?;
        }
        if self.bytes(FILE)? != before {
            return Err("Autonomy schedules changed during update".into());
        }
        file.persist(self.path.join(FILE))
            .map_err(|e| e.error.to_string())?;
        self.directory.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Default)]
struct State {
    in_flight: Vec<V>,
}
pub struct Store {
    directory: PathBuf,
    state: Mutex<State>,
}
pub struct Lease {
    pub schedule: V,
    id: V,
    store: Weak<Store>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(store) = self.store.upgrade() {
            if let Ok(mut state) = store.state.lock() {
                state.in_flight.retain(|id| !strict_equal(id, &self.id));
            }
        }
    }
}
impl Store {
    pub fn new(directory: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            directory,
            state: Mutex::new(State::default()),
        })
    }
    pub fn list(&self) -> Result<V, String> {
        let _state = self
            .state
            .lock()
            .map_err(|_| "Autonomy schedule lock unavailable")?;
        Ok(V::Array(match Storage::open(&self.directory, false)? {
            Some(storage) => storage.read()?.0,
            None => Vec::new(),
        }))
    }
    pub fn add(&self, pattern: &V, prompt: &V, opts: &V, now: i64) -> Result<V, String> {
        let pattern = string(pattern)?.trim();
        let prompt = string(prompt)?.trim();
        if *opts == V::Null {
            return Err("Cannot read properties of null (reading 'project')".into());
        }
        let project = if opts["project"].truthy() {
            opts["project"].clone()
        } else {
            V::Null
        };
        let created = iso(now)?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Autonomy schedule lock unavailable")?;
        let storage = Storage::open(&self.directory, true)?.unwrap();
        let (mut rows, before) = storage.read()?;
        let mut id = None;
        for _ in 0..128 {
            let bytes: [u8; 3] = rand::random();
            let candidate = V::from(format!("{:02x}{:02x}{:02x}", bytes[0], bytes[1], bytes[2]));
            if !rows
                .iter()
                .any(|row| row.has("id") && strict_equal(&row["id"], &candidate))
                && !state
                    .in_flight
                    .iter()
                    .any(|id| strict_equal(id, &candidate))
            {
                id = Some(candidate);
                break;
            }
        }
        let schedule = object([
            ("id", id.ok_or("Cannot allocate an autonomy schedule ID")?),
            ("pattern", pattern),
            ("prompt", prompt),
            ("project", project),
            ("enabled", true.into()),
            ("lastRun", V::Null),
            ("created", created),
        ]);
        rows.push(schedule.clone());
        storage.save(rows, before)?;
        Ok(schedule)
    }
    pub fn remove(&self, id: &V) -> Result<bool, String> {
        let _state = self
            .state
            .lock()
            .map_err(|_| "Autonomy schedule lock unavailable")?;
        let Some(storage) = Storage::open(&self.directory, false)? else {
            return Ok(false);
        };
        let (mut rows, before) = storage.read()?;
        let count = rows.len();
        rows.retain(|row| !row.has("id") || !strict_equal(&row["id"], id));
        if rows.len() == count {
            return Ok(false);
        }
        storage.save(rows, before)?;
        Ok(true)
    }
    pub fn toggle(&self, id: &V) -> Result<V, String> {
        let _state = self
            .state
            .lock()
            .map_err(|_| "Autonomy schedule lock unavailable")?;
        let Some(storage) = Storage::open(&self.directory, false)? else {
            return Ok(V::Null);
        };
        let (mut rows, before) = storage.read()?;
        let Some(index) = rows
            .iter()
            .position(|row| row.has("id") && strict_equal(&row["id"], id))
        else {
            return Ok(V::Null);
        };
        rows[index]["enabled"] = (!rows[index]["enabled"].truthy()).into();
        let schedule = rows[index].clone();
        storage.save(rows, before)?;
        Ok(schedule)
    }
    pub fn due(&self, now: i64) -> Result<Vec<V>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Autonomy schedule lock unavailable")?;
        let Some(storage) = Storage::open(&self.directory, false)? else {
            return Ok(Vec::new());
        };
        let (rows, _) = storage.read()?;
        Ok(rows
            .into_iter()
            .filter(|row| {
                !state
                    .in_flight
                    .iter()
                    .any(|id| row.has("id") && strict_equal(id, &row["id"]))
                    && matches(row, &(now as f64).into()).unwrap_or(false)
            })
            .collect())
    }
    pub fn claim(
        self: &Arc<Self>,
        id: &V,
        now: i64,
        automatic: bool,
    ) -> Result<Option<Lease>, String> {
        self.claim_checked(id, now, now, automatic, None)
    }

    /// Dispatch an occurrence that was due earlier but waited for a worker slot.
    /// Any intervening edit or run invalidates the exact queued snapshot.
    pub fn claim_occurrence(
        self: &Arc<Self>,
        snapshot: &V,
        due_at: i64,
        started_at: i64,
    ) -> Result<Option<Lease>, String> {
        if !snapshot.has("id") {
            return Ok(None);
        }
        self.claim_checked(&snapshot["id"], due_at, started_at, true, Some(snapshot))
    }

    fn claim_checked(
        self: &Arc<Self>,
        id: &V,
        due_at: i64,
        started_at: i64,
        automatic: bool,
        snapshot: Option<&V>,
    ) -> Result<Option<Lease>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Autonomy schedule lock unavailable")?;
        if state
            .in_flight
            .iter()
            .any(|current| strict_equal(current, id))
        {
            return Ok(None);
        }
        let Some(storage) = Storage::open(&self.directory, false)? else {
            return Ok(None);
        };
        let (mut rows, before) = storage.read()?;
        let Some(index) = rows
            .iter()
            .position(|row| row.has("id") && strict_equal(&row["id"], id))
        else {
            return Ok(None);
        };
        if snapshot.is_some_and(|snapshot| rows[index] != *snapshot) {
            return Ok(None);
        }
        if automatic && !matches(&rows[index], &(due_at as f64).into()).unwrap_or(false) {
            return Ok(None);
        }
        rows[index]["lastRun"] = iso(started_at)?;
        let schedule = rows[index].clone();
        storage.save(rows, before)?;
        state.in_flight.push(id.clone());
        Ok(Some(Lease {
            schedule,
            id: id.clone(),
            store: Arc::downgrade(self),
        }))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    fn json(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    fn write_rows(directory: &Path, rows: &V) {
        fs::create_dir_all(directory.join("logs")).unwrap();
        fs::write(directory.join("logs").join(FILE), rows.raw().get()).unwrap();
    }

    #[test]
    fn source_fixtures_match_original_patterns_coercion_and_store_operations() {
        let fixtures = json(include_str!(
            "../../tests/fixtures/rust-autonomy-schedule.json"
        ));
        assert_eq!(fixtures.array().len(), 293);
        for (index, fixture) in fixtures.array().iter().enumerate() {
            let input = &fixture["input"];
            let result = if input["action"] == V::from("matches") {
                matches(&input["schedule"], &input["now"])
                    .map(|value| object([("value", value.into())]))
            } else {
                let directory = tempfile::tempdir().unwrap();
                let rows = if input.has("rows") {
                    input["rows"].clone()
                } else {
                    V::Array(Vec::new())
                };
                write_rows(directory.path(), &rows);
                let store = Store::new(directory.path().into());
                let value = match input["action"].text().as_str() {
                    "add" => {
                        let opts = if input.has("opts") {
                            input["opts"].clone()
                        } else {
                            V::object()
                        };
                        store.add(
                            &input["pattern"],
                            &input["prompt"],
                            &opts,
                            input["now"].number() as i64,
                        )
                    }
                    "remove" => store.remove(&input["id"]).map(V::from),
                    "toggle" => store.toggle(&input["id"]),
                    "list" => store.list(),
                    _ => panic!("unknown fixture action"),
                };
                value.map(|mut value| {
                    let mut rows = store.list().unwrap();
                    if input["action"] == V::from("add") {
                        let id = value["id"].text();
                        assert!(id.len() == 6 && id.bytes().all(|byte| byte.is_ascii_hexdigit()));
                        value["id"] = "112233".into();
                        rows.array_mut().last_mut().unwrap()["id"] = "112233".into();
                    }
                    object([("value", value), ("rows", rows)])
                })
            };
            let actual = result.unwrap_or_else(|error| object([("error", error.into())]));
            assert_eq!(
                actual,
                fixture["expected"],
                "autonomy schedule source fixture {index}: {}",
                input.raw().get()
            );
        }
    }

    #[test]
    fn failed_claim_persistence_never_reserves_or_advances_the_schedule() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let row = store
            .add(&"every 0m".into(), &"work".into(), &V::object(), 0)
            .unwrap();
        let target = outside.path().join("target");
        fs::write(&target, "sentinel").unwrap();
        let backup = directory.path().join("logs").join(BACKUP);
        symlink(&target, &backup).unwrap();
        assert!(store.claim(&row["id"], 60_000, true).is_err());
        assert_eq!(store.list().unwrap().array()[0]["lastRun"], V::Null);
        assert_eq!(fs::read_to_string(&target).unwrap(), "sentinel");
        fs::remove_file(backup).unwrap();
        assert!(store.claim(&row["id"], 60_000, true).unwrap().is_some());
    }

    #[test]
    fn dropping_one_lease_does_not_release_another_schedule() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let first = store
            .add(&"every 0m".into(), &"first".into(), &V::object(), 0)
            .unwrap();
        let second = store
            .add(&"every 0m".into(), &"second".into(), &V::object(), 0)
            .unwrap();
        let first_lease = store.claim(&first["id"], 0, true).unwrap().unwrap();
        let second_lease = store.claim(&second["id"], 0, true).unwrap().unwrap();
        drop(first_lease);
        assert!(store.claim(&second["id"], 0, false).unwrap().is_none());
        assert!(store.claim(&first["id"], 0, false).unwrap().is_some());
        drop(second_lease);
    }

    #[test]
    fn persisted_claim_rechecks_state_and_manual_disabled_run_is_allowed() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let row = store
            .add(&"every 1m".into(), &"work".into(), &V::object(), 0)
            .unwrap();
        assert_eq!(store.due(60_000).unwrap().len(), 1);
        let lease = store.claim(&row["id"], 60_000, true).unwrap().unwrap();
        assert_eq!(
            lease.schedule["lastRun"],
            V::from("1970-01-01T00:01:00.000Z")
        );
        assert!(store.claim(&row["id"], 120_000, false).unwrap().is_none());
        assert!(store.due(120_000).unwrap().is_empty());
        drop(lease);
        assert!(Store::new(directory.path().into())
            .due(60_001)
            .unwrap()
            .is_empty());
        store.toggle(&row["id"]).unwrap();
        assert!(store.claim(&row["id"], 120_000, true).unwrap().is_none());
        assert!(store.claim(&row["id"], 120_000, false).unwrap().is_some());
        store.remove(&row["id"]).unwrap();
        assert!(store.claim(&row["id"], 180_000, false).unwrap().is_none());
    }

    #[test]
    fn queued_daily_occurrence_can_start_after_its_matching_minute() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let due_at = date(&"2026-10-08T09:00:00".into()).unwrap().unwrap();
        let started_at = due_at + 60_000;
        let row = store
            .add(
                &"09:00 daily".into(),
                &"work".into(),
                &V::object(),
                due_at - 1,
            )
            .unwrap();
        let snapshot = store.due(due_at).unwrap().pop().unwrap();
        assert!(store.claim(&row["id"], started_at, true).unwrap().is_none());
        let lease = store
            .claim_occurrence(&snapshot, due_at, started_at)
            .unwrap()
            .unwrap();
        assert_eq!(lease.schedule["lastRun"], iso(started_at).unwrap());
        assert_eq!(store.list().unwrap().array()[0], lease.schedule);
        assert!(store
            .claim_occurrence(&snapshot, due_at, started_at + 1)
            .unwrap()
            .is_none());
        drop(lease);
        // Once completed or cancelled, the old occurrence still stays consumed.
        assert!(store
            .claim_occurrence(&snapshot, due_at, started_at + 2)
            .unwrap()
            .is_none());
    }

    #[test]
    fn queued_occurrence_rejects_changed_deleted_disabled_or_nonmatching_rows() {
        for change in [
            "disabled", "prompt", "project", "unknown", "lastRun", "deleted", "not-due",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store = Store::new(directory.path().into());
            let due_at = date(&"2026-10-08T09:00:00".into()).unwrap().unwrap();
            let snapshot = store
                .add(
                    &"09:00 daily".into(),
                    &"work".into(),
                    &V::object(),
                    due_at - 1,
                )
                .unwrap();
            match change {
                "disabled" => {
                    store.toggle(&snapshot["id"]).unwrap();
                }
                "deleted" => {
                    store.remove(&snapshot["id"]).unwrap();
                }
                "not-due" => {}
                field => {
                    let mut changed = snapshot.clone();
                    changed[field] = if field == "lastRun" {
                        iso(due_at - 1000).unwrap()
                    } else {
                        "edited".into()
                    };
                    write_rows(directory.path(), &V::Array(vec![changed]));
                }
            }
            let before = fs::read(directory.path().join("logs").join(FILE)).unwrap();
            let due_at = if change == "not-due" {
                due_at - 60_000
            } else {
                due_at
            };
            assert!(
                store
                    .claim_occurrence(&snapshot, due_at, due_at + 60_000)
                    .unwrap()
                    .is_none(),
                "{change}"
            );
            assert_eq!(
                fs::read(directory.path().join("logs").join(FILE)).unwrap(),
                before,
                "{change}"
            );
        }
    }

    #[test]
    fn queued_and_manual_claims_share_the_same_in_flight_lease() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let snapshot = store
            .add(&"every 0m".into(), &"work".into(), &V::object(), 0)
            .unwrap();
        let lease = store
            .claim_occurrence(&snapshot, 0, 60_000)
            .unwrap()
            .unwrap();
        assert!(store
            .claim(&snapshot["id"], 60_001, false)
            .unwrap()
            .is_none());
        let current = store.list().unwrap().array()[0].clone();
        assert!(store
            .claim_occurrence(&current, 60_000, 60_001)
            .unwrap()
            .is_none());
        drop(lease);
        let lease = store
            .claim(&snapshot["id"], 60_001, false)
            .unwrap()
            .unwrap();
        let current = store.list().unwrap().array()[0].clone();
        assert!(store
            .claim_occurrence(&current, 60_001, 60_002)
            .unwrap()
            .is_none());
        drop(lease);
        assert!(store
            .claim_occurrence(&current, 60_001, 60_002)
            .unwrap()
            .is_some());
    }

    #[test]
    fn concurrent_zero_interval_claims_have_one_owner_until_lease_drops() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let row = store
            .add(&"every 0m".into(), &"work".into(), &V::object(), 0)
            .unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(9));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                let barrier = barrier.clone();
                let id = row["id"].clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.claim(&id, 0, true).unwrap()
                })
            })
            .collect();
        barrier.wait();
        let leases: Vec<_> = threads
            .into_iter()
            .filter_map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(leases.len(), 1);
        assert!(store.due(0).unwrap().is_empty());
        drop(leases);
        assert!(store.claim(&row["id"], 0, true).unwrap().is_some());
    }

    #[test]
    fn unknown_utf16_fields_and_previous_bytes_survive_atomic_updates() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let rows = json(
            r#"[{"id":"a","pattern":"every 0m","prompt":"\ud800","enabled":true,"future":{"value":"\udc00"}}]"#,
        );
        write_rows(directory.path(), &rows);
        let before = fs::read(directory.path().join("logs").join(FILE)).unwrap();
        let toggled = store.toggle(&"a".into()).unwrap();
        assert_eq!(toggled["future"], rows.array()[0]["future"]);
        assert_eq!(
            fs::read(directory.path().join("logs").join(BACKUP)).unwrap(),
            before
        );
        for name in [FILE, BACKUP] {
            assert_eq!(
                fs::metadata(directory.path().join("logs").join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let restored = Store::new(directory.path().into()).list().unwrap();
        assert_eq!(restored.array()[0], toggled);
    }

    #[test]
    fn corrupt_source_and_symlink_source_backup_or_directory_are_preserved() {
        use std::os::unix::fs::symlink;
        for failure in [
            "corrupt",
            "shape",
            "source-link",
            "backup-link",
            "logs-link",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let target = outside.path().join("target");
            fs::write(&target, "outside sentinel").unwrap();
            let store = Store::new(directory.path().into());
            let logs = directory.path().join("logs");
            if failure == "logs-link" {
                symlink(outside.path(), &logs).unwrap();
            } else {
                fs::create_dir(&logs).unwrap();
                match failure {
                    "corrupt" => fs::write(logs.join(FILE), "{broken").unwrap(),
                    "shape" => fs::write(logs.join(FILE), "[null]").unwrap(),
                    "source-link" => symlink(&target, logs.join(FILE)).unwrap(),
                    _ => {
                        fs::write(logs.join(FILE), "[]").unwrap();
                        symlink(&target, logs.join(BACKUP)).unwrap();
                    }
                }
            }
            let before = fs::read(logs.join(FILE)).ok();
            assert!(
                store
                    .add(&"every 1m".into(), &"work".into(), &V::object(), 0)
                    .is_err(),
                "{failure}"
            );
            assert_eq!(fs::read(logs.join(FILE)).ok(), before);
            assert_eq!(fs::read_to_string(&target).unwrap(), "outside sentinel");
        }
    }

    #[test]
    fn matching_keeps_invalid_last_dates_zero_interval_and_local_daily_rules() {
        let mut schedule = object([("enabled", true.into()), ("pattern", "every 0m".into())]);
        assert!(matches(&schedule, &0.0.into()).unwrap());
        schedule["lastRun"] = "invalid".into();
        assert!(!matches(&schedule, &0.0.into()).unwrap());
        schedule["pattern"] = "09:30 weekday".into();
        assert!(matches(&schedule, &"2026-10-08T09:30:00".into()).unwrap());
        assert!(!matches(&schedule, &"2026-10-10T09:30:00".into()).unwrap());
        schedule["lastRun"] = "2026-10-08T01:00:00".into();
        assert!(!matches(&schedule, &"2026-10-08T09:30:00".into()).unwrap());
        assert_eq!(iso(-1).unwrap(), V::from("1969-12-31T23:59:59.999Z"));
        assert_eq!(
            iso(DATE_LIMIT).unwrap(),
            V::from("+275760-09-13T00:00:00.000Z")
        );
        assert_eq!(
            iso(-DATE_LIMIT).unwrap(),
            V::from("-271821-04-20T00:00:00.000Z")
        );
    }
}
