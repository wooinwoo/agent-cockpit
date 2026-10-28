use crate::{
    board_value::{object, V},
    commands,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/ai-accounts"),
    ("POST", "/api/ai-accounts"),
    ("DELETE", "/api/ai-accounts/:id"),
    ("POST", "/api/ai-accounts/:id/test"),
    ("POST", "/api/ai-accounts/:id/usage-refresh"),
    ("POST", "/api/ai-accounts/:id/budget"),
];
pub struct Store {
    directory: PathBuf,
    source: PathBuf,
    legacy_home: Option<PathBuf>,
    writes: Mutex<()>,
    pub usage: Arc<crate::account_usage::Store>,
    costs: Arc<crate::usage_costs::Store>,
}
pub struct Launch {
    pub id: String,
    pub name: V,
    pub provider: String,
    pub home: PathBuf,
}
impl Launch {
    pub fn env_key(&self) -> &'static str {
        if self.provider == "claude" {
            "CLAUDE_CONFIG_DIR"
        } else {
            "CODEX_HOME"
        }
    }
    pub fn display(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"name":self.name.text(),"provider":self.provider})
    }
    pub fn configure(&self, command: &mut tokio::process::Command) {
        command
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDECODE")
            .env(self.env_key(), &self.home);
    }
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}
fn iso_now() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn date(value: &V) -> Option<f64> {
    let text = value.text();
    DateTime::parse_from_rfc3339(&text)
        .or_else(|_| DateTime::parse_from_rfc2822(&text))
        .ok()
        .map(|dt| dt.timestamp_millis() as f64)
}
fn valid_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn supported(provider: &V) -> bool {
    [V::from("claude"), V::from("codex")].contains(provider)
}
fn text(value: &V) -> V {
    if !value.truthy() {
        "".into()
    } else if value.is_string() {
        value.clone()
    } else {
        value.text().into()
    }
}
fn io_error(_: impl std::fmt::Display) -> String {
    "AI 계정 저장소에 접근하지 못했습니다.".into()
}
/// Pin every directory component so credential reads cannot follow replaced links.
#[cfg(target_os = "linux")]
pub(crate) fn account_directory(path: &Path) -> io::Result<File> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
        path::Component,
    };
    if !path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return Err(io::Error::other(io_error("path")));
    }
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::open(c"/".as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::other(io_error("path")));
    }
    let mut directory = unsafe { File::from_raw_fd(fd) };
    for part in path.components() {
        let Component::Normal(name) = part else {
            continue;
        };
        let name = CString::new(name.as_bytes()).map_err(|_| io::Error::other(io_error("path")))?;
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::other(io_error("path")));
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}
fn slug(value: &V) -> String {
    let raw = value.text().to_lowercase();
    let mut output = String::new();
    for c in raw.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || ('가'..='힣').contains(&c) {
            output.push(c);
        } else if !output.ends_with('-') {
            output.push('-');
        }
    }
    let output: String = output.trim_matches('-').chars().take(30).collect();
    if output.is_empty() {
        "account".into()
    } else {
        output
    }
}
fn base36(mut number: u128) -> String {
    let mut output = Vec::new();
    loop {
        output.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(number % 36) as usize]);
        number /= 36;
        if number == 0 {
            break;
        }
    }
    output.reverse();
    String::from_utf8(output).unwrap()
}
fn private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other("Invalid account directory"));
    }
    Ok(())
}
fn copy_toolkit(source: &Path, destination: &Path) -> io::Result<()> {
    if fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Ok(());
    }
    if source.is_dir() {
        private_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_toolkit(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if source.is_file() {
        fs::copy(source, destination)?;
    }
    Ok(())
}
impl Store {
    pub fn new(directory: &Path, source: &Path) -> Self {
        Self {
            directory: directory.into(),
            source: source.into(),
            legacy_home: None,
            writes: Mutex::new(()),
            usage: crate::account_usage::Store::new(),
            costs: Arc::new(crate::usage_costs::Store::default()),
        }
    }
    pub fn new_legacy(directory: &Path, source: &Path, home: &Path) -> io::Result<Self> {
        if !crate::account_hub::safe_legacy_path(home) || !fs::metadata(home)?.is_dir() {
            return Err(io::Error::other(
                "Legacy account home must be an existing absolute directory without symlinks",
            ));
        }
        let mut store = Self::new(directory, source);
        store.legacy_home = Some(home.into());
        Ok(store)
    }

    fn hub_candidates(&self) -> Vec<(PathBuf, String)> {
        match &self.legacy_home {
            Some(home) => crate::account_hub::candidates_legacy(home),
            None => crate::account_hub::candidates(&self.directory),
        }
    }
    fn hub_records(&self) -> (Vec<crate::account_hub::Record>, V) {
        match &self.legacy_home {
            Some(home) => crate::account_hub::load_legacy(home),
            None => crate::account_hub::load(&self.directory),
        }
    }
    fn safe_reference(&self, path: &Path) -> bool {
        if self.legacy_home.is_some() {
            crate::account_hub::safe_legacy_path(path)
        } else {
            crate::account_hub::safe_path(&self.directory, path)
        }
    }
    fn login_bin(&self) -> PathBuf {
        self.legacy_home
            .clone()
            .unwrap_or_else(|| self.directory.join("home"))
            .join(".local/bin")
    }
    pub fn route(method: &Method, path: &str) -> Option<(String, &'static str)> {
        if *method == Method::GET && path == "/api/ai-accounts" {
            return Some((String::new(), "list"));
        }
        if *method == Method::POST && path == "/api/ai-accounts" {
            return Some((String::new(), "create"));
        }
        let tail = path.strip_prefix("/api/ai-accounts/")?;
        for (verb, suffix, operation) in [
            (Method::DELETE, "", "delete"),
            (Method::POST, "/test", "test"),
            (Method::POST, "/usage-refresh", "refresh_usage"),
            (Method::POST, "/budget", "budget"),
        ] {
            if *method == verb {
                if let Some(id) = tail
                    .strip_suffix(suffix)
                    .filter(|id| !id.is_empty() && !id.contains('/'))
                {
                    return Some((id.into(), operation));
                }
            }
        }
        None
    }
    fn root(&self) -> PathBuf {
        self.directory.join("ai-accounts")
    }
    fn load(&self) -> Result<V, String> {
        let path = self.directory.join("ai-accounts.json");
        let raw = match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Ok(object([
                    ("accounts", V::Array(vec![])),
                    ("budgets", V::object()),
                ]))
            }
            Ok(meta) if meta.is_file() => fs::read(&path).map_err(io_error)?,
            _ => return Err(io_error("invalid account file")),
        };
        let raw: Box<serde_json::value::RawValue> =
            serde_json::from_slice(&raw).map_err(io_error)?;
        let source = V::parse(&raw).map_err(io_error)?;
        let accounts = if source.is_array() {
            source.clone()
        } else {
            source["accounts"].clone()
        };
        let mut result = source.object_clone();
        result["accounts"] = V::Array(
            accounts
                .array()
                .iter()
                .filter(|a| {
                    valid_id(&a["id"].text()) && supported(&a["provider"]) && a["homePath"].truthy()
                })
                .cloned()
                .collect(),
        );
        result["budgets"] = source["budgets"].object_clone();
        Ok(result)
    }
    fn save(&self, data: &V) -> Result<(), String> {
        private_dir(&self.root()).map_err(io_error)?;
        let path = self.directory.join("ai-accounts.json");
        if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
            return Err(io_error("invalid account file"));
        }
        let mut file = tempfile::NamedTempFile::new_in(&self.directory).map_err(io_error)?;
        file.write_all(data.raw().get().as_bytes())
            .map_err(io_error)?;
        file.as_file().sync_all().map_err(io_error)?;
        file.persist(path).map_err(io_error)?;
        #[cfg(unix)]
        File::open(&self.directory)
            .and_then(|f| f.sync_all())
            .map_err(io_error)?;
        Ok(())
    }
    fn record(&self, id: &str) -> Result<V, String> {
        if !valid_id(id) {
            return Err("Invalid AI account".into());
        }
        self.load()?["accounts"]
            .array()
            .iter()
            .find(|a| a["id"] == V::from(id))
            .cloned()
            .ok_or("AI account not found".into())
    }
    fn owned_home(&self, record: &V) -> Result<PathBuf, String> {
        // Directory deletion stays inside the owned root in every mode.
        // Preview uses the same boundary for reads and launches.
        let home = PathBuf::from(record["homePath"].text());
        let root = self.root();
        if !home.starts_with(&root)
            || home == root
            || home
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("격리 저장소 밖의 계정 경로는 사용할 수 없습니다.".into());
        }
        let mut cursor = Some(home.as_path());
        while let Some(path) = cursor {
            if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("계정 경로에 심볼릭 링크를 사용할 수 없습니다.".into());
            }
            if path == self.directory {
                break;
            }
            cursor = path.parent();
        }
        Ok(home)
    }
    fn record_home(&self, record: &V) -> Result<PathBuf, String> {
        if self.legacy_home.is_none() {
            return self.owned_home(record);
        }
        let home = PathBuf::from(record["homePath"].text());
        if !self.safe_reference(&home) {
            return Err("계정 경로는 부모 참조나 심볼릭 링크가 없는 절대 경로여야 합니다.".into());
        }
        Ok(home)
    }
    pub fn launch(&self, id: &str) -> Result<Launch, String> {
        self.launch_checked(id, true)
    }
    pub(crate) fn native_profile(
        &self,
        id: &str,
    ) -> Result<crate::native_account::Profile, String> {
        let record = self.record(id)?;
        crate::native_account::Profile::new(
            &self.directory,
            &self.directory.join("jcode-profiles").join(id),
            id,
            &record["provider"].text(),
            &record["email"].text(),
        )
        .map(|profile| {
            profile.with_settings(
                self.legacy_home
                    .as_deref()
                    .unwrap_or(&self.directory.join("home")),
            )
        })
        .map_err(io_error)
    }
    pub(crate) fn has_native_profile(&self, id: &str) -> bool {
        !matches!(fs::symlink_metadata(self.directory.join("jcode-profiles").join(id).join(".jcode")),Err(error) if error.kind()==io::ErrorKind::NotFound)
    }
    pub(crate) fn prepare_native(
        &self,
        id: &str,
    ) -> Result<(crate::native_account::Profile, bool), String> {
        let profile = self.native_profile(id)?;
        tokio::runtime::Handle::current()
            .block_on(profile.check_engine())
            .map_err(|_| {
                "계정용 jcode 엔진을 확인하지 못했습니다. 엔진 설치를 확인하세요.".to_string()
            })?;
        let root = self.directory.join("jcode-profiles");
        private_dir(&root).map_err(io_error)?;
        let pinned = account_directory(&root).map_err(io_error)?;
        #[cfg(unix)]
        {
            use std::{os::fd::AsRawFd, os::unix::fs::DirBuilderExt};
            let path = PathBuf::from(format!("/proc/self/fd/{}", pinned.as_raw_fd())).join(id);
            match fs::DirBuilder::new().mode(0o700).create(path) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(io_error(error)),
            }
        }
        #[cfg(not(unix))]
        private_dir(profile.home.parent().unwrap()).map_err(io_error)?;
        let mut workspace = None;
        #[cfg(target_os = "linux")]
        if profile.provider == "openai" {
            workspace = self
                .oauth_source(id)
                .ok()
                .and_then(|(_, auth)| auth["tokens"]["account_id"].as_str().map(str::to_owned));
        }
        profile.prepare(workspace.as_deref()).map_err(io_error)?;
        let logged_in = profile.credentials().map_err(io_error)?.is_some();
        Ok((profile, logged_in))
    }
    fn launch_checked(&self, id: &str, check_login: bool) -> Result<Launch, String> {
        match self.record(id) {
            Ok(record) => Ok(Launch {
                id: id.into(),
                name: record["name"].clone(),
                provider: record["provider"].text(),
                home: self.record_home(&record)?,
            }),
            Err(e) if e == "AI account not found" => {
                let (records, _) = self.hub_records();
                let record = records
                    .into_iter()
                    .find(|r| r.id == id)
                    .ok_or("AI account not found")?;
                if !self.safe_reference(&record.home) {
                    return Err("격리 저장소 밖의 계정 경로는 사용할 수 없습니다.".into());
                }
                let name = hub_text(
                    &record.profile,
                    &["name", "accountName"],
                    &format!("{} account", record.provider),
                );
                let launch = Launch {
                    id: id.into(),
                    name,
                    provider: record.provider,
                    home: record.home,
                };
                if check_login && !self.credential(&launch)?.0 {
                    return Err("AI account login required".into());
                }
                if check_login
                    && text(&record.profile["lastLimitsError"]).trim().truthy()
                    && self.usage.snapshot(&launch.provider, &launch.home)["query"]["state"]
                        != "ready"
                {
                    return Err("AI account status check required".into());
                }
                Ok(launch)
            }
            Err(e) => Err(e),
        }
    }
    /// Enumerate registered identities without starting usage requests or token refreshes.
    pub(crate) fn registered_accounts(&self) -> Result<Vec<serde_json::Value>, String> {
        let data = self.load()?;
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for record in data["accounts"].array() {
            let id = record["id"].text();
            if seen.insert(id.clone()) {
                result.push(
                    serde_json::json!({"id":id,"provider":record["provider"].text(),
                    "name":record["name"].text(),"email":text(&record["email"]).text()}),
                );
            }
        }
        let (records, sources) = self.hub_records();
        if sources
            .array()
            .iter()
            .any(|source| source["error"].truthy())
        {
            return Err(io_error("Invalid account source"));
        }
        for record in records {
            if seen.insert(record.id.clone()) {
                result.push(serde_json::json!({"id":record.id,"provider":record.provider,
                    "name":hub_text(&record.profile,&["name","accountName"],"").text(),
                    "email":hub_text(&record.profile,&["authenticatedEmail","accountEmail","loginEmail"],"").text()}));
            }
        }
        Ok(result)
    }

    /// Read a registered source only; never call a provider or save rotated credentials.
    #[cfg(target_os = "linux")]
    pub(crate) fn oauth_source(&self, id: &str) -> io::Result<(Launch, serde_json::Value)> {
        use std::{
            ffi::CString,
            io::Read,
            os::fd::{AsRawFd, FromRawFd},
        };
        // The bounded, descriptor-pinned read below replaces launch's legacy login probe.
        let launch = self
            .launch_checked(id, false)
            .map_err(|_| io::Error::other(io_error("account")))?;
        let directory = account_directory(&launch.home)?;
        let name = CString::new(if launch.provider == "claude" {
            ".credentials.json"
        } else {
            "auth.json"
        })
        .unwrap();
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::other(io_error("source")));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let meta = file.metadata()?;
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            return Err(io::Error::other(io_error("source")));
        }
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 1024 * 1024 {
            return Err(io::Error::other(io_error("source")));
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| io::Error::other(io_error("source")))?;
        Ok((launch, value))
    }
    fn list(&self) -> Result<V, String> {
        let data = self.load()?;
        let (hub, sources) = self.hub_records();
        let mut accounts = vec![];
        for record in data["accounts"].array() {
            let launch = Launch {
                id: record["id"].text(),
                name: record["name"].clone(),
                provider: record["provider"].text(),
                home: self.record_home(record)?,
            };
            let native = self.native_profile(&launch.id).ok();
            let native_owned = self.has_native_profile(&launch.id);
            let (exists, warning, note, usage, workspace) = if native_owned {
                match native
                    .as_ref()
                    .map(|profile| (profile, profile.credentials()))
                {
                    Some((profile, Ok(auth))) => {
                        let workspace = auth
                            .as_ref()
                            .and_then(|auth| auth["account_id"].as_str())
                            .unwrap_or("")
                            .to_owned();
                        (
                            auth.is_some(),
                            false,
                            if auth.is_none() {
                                "jcode 로그인 필요".into()
                            } else {
                                String::new()
                            },
                            usage_value(self.usage.snapshot_native(profile.clone())),
                            workspace,
                        )
                    }
                    _ => (
                        false,
                        true,
                        "jcode 계정 정보를 확인하지 못했습니다.".into(),
                        usage_value(
                            serde_json::json!({"query":{"state":"error","code":"credential_unavailable"}}),
                        ),
                        String::new(),
                    ),
                }
            } else {
                let (exists, warning, note) = self.credential(&launch)?;
                (
                    exists,
                    warning,
                    note,
                    usage_value(self.usage.snapshot(&launch.provider, &launch.home)),
                    String::new(),
                )
            };
            let budget = truthy_or(&data["budgets"][&launch.id], V::Null);
            accounts.push(object([
                ("id", record["id"].clone()),
                ("name", record["name"].clone()),
                ("email", truthy_or(&record["email"], "".into())),
                ("provider", record["provider"].clone()),
                ("plan", truthy_or(&record["plan"], "".into())),
                (
                    "state",
                    if !exists {
                        "login"
                    } else if warning {
                        "warning"
                    } else {
                        "ready"
                    }
                    .into(),
                ),
                ("stateNote", note.into()),
                ("weeklyRemaining", remaining(&usage, &budget)),
                (
                    "sessionRemaining",
                    usage["limits"]["session"]["remaining"].clone(),
                ),
                (
                    "weeklyResetAt",
                    truthy_or(
                        &usage["limits"]["weekly"]["resetAt"],
                        truthy_or(&usage["weeklyResetAt"], "".into()),
                    ),
                ),
                (
                    "sessionResetAt",
                    truthy_or(&usage["limits"]["session"]["resetAt"], "".into()),
                ),
                ("lastRefreshedAt", "".into()),
                ("source", "cockpit".into()),
                (
                    "authEngine",
                    if native_owned { "jcode" } else { "cli" }.into(),
                ),
                (
                    "jcodeSupported",
                    native
                        .as_ref()
                        .is_some_and(|profile| profile.binary.is_file())
                        .into(),
                ),
                ("workspaceId", workspace.into()),
                ("bridge", "Cockpit".into()),
                ("weeklyTokenBudget", budget),
                ("usage", usage),
            ]));
        }
        for record in hub {
            if !self.safe_reference(&record.home) {
                continue;
            }
            let profile = &record.profile;
            let launch = Launch {
                id: record.id.clone(),
                name: V::Null,
                provider: record.provider.clone(),
                home: record.home,
            };
            let (exists, warning, note) = self.credential(&launch)?;
            let usage = usage_value(self.usage.snapshot(&launch.provider, &launch.home));
            let budget = truthy_or(&data["budgets"][&record.id], V::Null);
            let fresh = crate::account_usage::date(&profile["lastLimitsRefreshUtc"].text())
                .is_some_and(|t| crate::account_usage::now() - t < 48 * 3_600_000);
            let percent = |key: &str| -> V {
                let n = if profile.has(key) {
                    profile[key].number()
                } else {
                    f64::NAN
                };
                if n.is_finite() {
                    (100.0 - n).clamp(0.0, 100.0).into()
                } else {
                    V::Null
                }
            };
            accounts.push(object([
                ("id", record.id.into()),
                (
                    "name",
                    hub_text(
                        profile,
                        &["name", "accountName"],
                        &format!("{} account", record.provider),
                    ),
                ),
                (
                    "email",
                    hub_text(
                        profile,
                        &["authenticatedEmail", "accountEmail", "loginEmail"],
                        "",
                    ),
                ),
                ("provider", record.provider.into()),
                (
                    "plan",
                    hub_text(profile, &["accountPlan", "accountType"], ""),
                ),
                (
                    "state",
                    if !exists {
                        "login"
                    } else if warning || (profile["lastLimitsError"].truthy() && usage["query"]["state"] != V::from("ready")) {
                        "warning"
                    } else {
                        "ready"
                    }
                    .into(),
                ),
                ("stateNote", note.into()),
                (
                    "weeklyRemaining",
                    if usage["query"]["state"] == V::from("ready") && matches!(usage["limits"]["weekly"]["remaining"],V::Number(n) if n.is_finite()) {
                        remaining(&usage, &budget)
                    } else if fresh {
                        percent("weeklyLimitUsedPercent")
                    } else {
                        remaining(&usage, &budget)
                    },
                ),
                (
                    "sessionRemaining",
                    if usage["query"]["state"] == V::from("ready") && matches!(usage["limits"]["session"]["remaining"],V::Number(n) if n.is_finite()) {
                        usage["limits"]["session"]["remaining"].clone()
                    } else if fresh {
                        percent("shortLimitUsedPercent")
                    } else {
                        usage["limits"]["session"]["remaining"].clone()
                    },
                ),
                (
                    "weeklyResetAt",
                    truthy_or(&usage["limits"]["weekly"]["resetAt"],crate::account_usage::next_week(
                        &profile["weeklyLimitResetUtc"].text(),
                        crate::account_usage::now(),
                    )
                    .into()),
                ),
                ("sessionResetAt", truthy_or(&usage["limits"]["session"]["resetAt"],"".into())),
                (
                    "lastRefreshedAt",
                    hub_text(profile, &["lastLimitsRefreshUtc"], &record.updated_at),
                ),
                (
                    "bridge",
                    if crate::account_hub::runtime() == "WSL" && record.source == "Windows" {
                        "Windows → WSL".into()
                    } else {
                        record.source.clone().into()
                    },
                ),
                ("source", record.source.into()),
                ("weeklyTokenBudget", budget),
                ("usage", usage),
            ]));
        }
        let mut homes = vec![
            self.legacy_home
                .clone()
                .unwrap_or_else(|| self.directory.join("home"))
                .join(".jcode"),
            self.directory.join("jcode-accounts"),
        ];
        homes.extend(
            data["accounts"]
                .array()
                .iter()
                .filter_map(|record| self.native_profile(&record["id"].text()).ok())
                .map(|profile| profile.home),
        );
        let costs = self.costs.snapshot(homes, crate::account_usage::now());
        for index in 0..accounts.len() {
            let provider = if accounts[index]["provider"] == V::from("codex") {
                "openai"
            } else {
                "claude"
            };
            let email = accounts[index]["email"].text().trim().to_lowercase();
            let unique = accounts
                .iter()
                .filter(|a| {
                    a["provider"] == accounts[index]["provider"]
                        && a["email"].text().trim().to_lowercase() == email
                })
                .count()
                == 1;
            let mut account_id = String::new();
            #[cfg(target_os = "linux")]
            if provider == "openai" {
                if accounts[index]["authEngine"] == V::from("jcode") {
                    account_id = accounts[index]["workspaceId"].text();
                } else if let Ok((_, auth)) = self.oauth_source(&accounts[index]["id"].text()) {
                    account_id = auth["tokens"]["account_id"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                }
            }
            if unique && !email.is_empty() {
                if let Some(cost) =
                    costs["accountRecords"]["accounts"]
                        .as_array()
                        .and_then(|rows| {
                            rows.iter().find(|r| {
                                r["provider"] == provider
                                    && r["email"] == email
                                    && r["accountId"] == account_id
                                    && (provider != "openai" || !account_id.is_empty())
                            })
                        })
                {
                    accounts[index]["jcodeCost"] = usage_value(cost["cost"].clone());
                }
            }
        }
        Ok(object([
            ("runtime", crate::account_hub::runtime().into()),
            ("usageRefreshSupported", true.into()),
            (
                "jcodeAccountsSupported",
                self.directory.join("jcode-engine/jcode").is_file().into(),
            ),
            ("jcodeCosts", usage_value(costs)),
            ("sources", sources),
            ("accounts", V::Array(accounts)),
        ]))
    }
    pub fn watch_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![
            self.directory.join("ai-accounts.json"),
            self.root(),
            self.directory.join("jcode-profiles"),
        ];
        if let Ok(data) = self.load() {
            for record in data["accounts"].array() {
                if let Ok(profile) = self.native_profile(&record["id"].text()) {
                    paths.push(profile.home.clone());
                    paths.push(profile.credential_file());
                }
                if let Ok(home) = self.record_home(record) {
                    paths.push(home.join(if record["provider"] == V::from("claude") {
                        ".credentials.json"
                    } else {
                        "auth.json"
                    }));
                }
            }
        }
        paths.extend(
            self.hub_candidates()
                .into_iter()
                .map(|(path, _)| path)
                .filter(|p| self.safe_reference(p)),
        );
        for record in self.hub_records().0 {
            if self.safe_reference(&record.home) {
                paths.push(record.home.join(if record.provider == "claude" {
                    ".credentials.json"
                } else {
                    "auth.json"
                }));
            }
        }
        if self.legacy_home.is_some() {
            paths.retain(|path| self.safe_reference(path));
        }
        paths
    }
    fn create(&self, input: &V) -> Result<V, String> {
        let name = text(&input["name"]).trim().cut(40);
        if !name.truthy() {
            return Err("계정 이름을 입력하세요.".into());
        }
        if !supported(&input["provider"]) {
            return Err("provider는 claude 또는 codex여야 합니다.".into());
        }
        let email = text(&input["email"]).trim().text();
        if input["engine"] == V::from("jcode")
            && (email.len() > 254
                || email.chars().any(char::is_whitespace)
                || !email.split_once('@').is_some_and(|(local, domain)| {
                    !local.is_empty() && !domain.is_empty() && !domain.contains('@')
                }))
        {
            return Err("jcode 로그인에서 확인할 계정 이메일을 입력하세요.".into());
        }
        let _guard = self.writes.lock().unwrap();
        let mut data = self.load()?;
        if data["accounts"]
            .array()
            .iter()
            .any(|a| a["provider"] == input["provider"] && a["name"] == name)
        {
            return Err(format!(
                "같은 이름의 {} 계정이 이미 있습니다.",
                input["provider"].text()
            ));
        }
        private_dir(&self.root()).map_err(io_error)?;
        let mut home = self
            .root()
            .join(format!("{}-{}", input["provider"].text(), slug(&name)));
        if home.exists() {
            home = PathBuf::from(format!("{}-{}", home.display(), base36(now() as u128)));
        }
        // Never share an existing directory after a same-millisecond collision.
        if fs::symlink_metadata(&home).is_ok() {
            return Err("계정 디렉터리가 이미 있습니다. 다시 시도하세요.".into());
        }
        private_dir(&home).map_err(io_error)?;
        let _ = copy_toolkit(
            &self.source.join(".claude/skills/cockpit-session"),
            &home.join("skills/cockpit-session"),
        );
        let hash = format!(
            "{:x}",
            Sha256::digest(format!(
                "{}\0{}",
                input["provider"].text(),
                home.to_string_lossy().to_lowercase()
            ))
        );
        let record = object([
            ("id", hash[..16].into()),
            ("name", name),
            ("email", text(&input["email"]).trim().cut(254)),
            ("provider", input["provider"].clone()),
            ("homePath", home.to_string_lossy().to_string().into()),
            ("createdAt", iso_now().into()),
        ]);
        data["accounts"].array_mut().push(record.clone());
        if let Err(error) = self.save(&data) {
            let _ = fs::remove_dir_all(home);
            return Err(error);
        }
        Ok(record)
    }
    fn delete(&self, id: &str) -> Result<V, String> {
        if !valid_id(id) {
            return Err("Invalid AI account".into());
        }
        let _guard = self.writes.lock().unwrap();
        let mut data = self.load()?;
        let record = data["accounts"]
            .array()
            .iter()
            .find(|a| a["id"] == V::from(id))
            .cloned()
            .ok_or("AI account not found")?;
        let native_parent = self.directory.join("jcode-profiles").join(id);
        if fs::symlink_metadata(&native_parent).is_ok() {
            let pinned = account_directory(&native_parent).map_err(io_error)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if pinned.metadata().map_err(io_error)?.uid() != unsafe { libc::geteuid() } {
                    return Err(io_error("owner"));
                }
            }
        }
        data["accounts"]
            .array_mut()
            .retain(|a| a["id"] != V::from(id));
        data["budgets"].remove(id);
        self.save(&data)?;
        let mut cleanup_failed = fs::symlink_metadata(&native_parent).is_ok()
            && fs::remove_dir_all(&native_parent).is_err();
        if let Ok(home) = self.owned_home(&record) {
            cleanup_failed |=
                fs::symlink_metadata(&home).is_ok() && fs::remove_dir_all(home).is_err();
        }
        let mut result = object([("deleted", true.into())]);
        if cleanup_failed {
            result["cleanupWarning"] =
                "계정 목록에서 삭제했지만 로그인 폴더 정리는 완료하지 못했습니다.".into();
        }
        Ok(result)
    }
    fn budget(&self, id: &str, input: &V) -> Result<V, String> {
        if !valid_id(id) {
            return Err("Invalid AI account".into());
        }
        let n = if input.has("weeklyTokenBudget") {
            input["weeklyTokenBudget"].number()
        } else {
            f64::NAN
        };
        let value = n.floor() + if n - n.floor() >= 0.5 { 1.0 } else { 0.0 };
        if !value.is_finite() || value < 0.0 {
            return Err("예산은 0 이상의 숫자(토큰 수)여야 합니다.".into());
        }
        let _guard = self.writes.lock().unwrap();
        let mut data = self.load()?;
        if value == 0.0 {
            data["budgets"].remove(id);
        } else {
            data["budgets"][id] = value.into();
        }
        self.save(&data)?;
        Ok(object([
            ("id", id.into()),
            (
                "weeklyTokenBudget",
                if value == 0.0 { V::Null } else { value.into() },
            ),
        ]))
    }
    fn credential(&self, launch: &Launch) -> Result<(bool, bool, String), String> {
        let file = launch.home.join(if launch.provider == "claude" {
            ".credentials.json"
        } else {
            "auth.json"
        });
        if fs::symlink_metadata(&file).is_ok_and(|m| !m.is_file()) {
            return Err("계정 로그인 파일이 일반 파일이 아닙니다.".into());
        }
        if !file.exists() {
            return Ok((
                false,
                false,
                "credential 파일 없음 — 로그인 터미널에서 로그인하세요".into(),
            ));
        }
        if let Ok(raw) = fs::read(&file).and_then(|bytes| {
            serde_json::from_slice::<Box<serde_json::value::RawValue>>(&bytes)
                .map_err(io::Error::other)
        }) {
            if let Ok(value) = V::parse(&raw) {
                if launch.provider == "claude" {
                    let expiry = &value["claudeAiOauth"]["expiresAt"];
                    let expiry = if let V::Number(n) = expiry {
                        Some(*n)
                    } else {
                        date(expiry)
                    };
                    if expiry.is_some_and(|t| t < now())
                        && !value["claudeAiOauth"]["refreshToken"].truthy()
                    {
                        return Ok((true,true,"액세스 토큰 만료 — 터미널을 열면 자동 갱신되거나 재로그인이 필요합니다".into()));
                    }
                } else if date(&value["last_refresh"])
                    .is_some_and(|t| now() - t > 30.0 * 86_400_000.0)
                {
                    return Ok((
                        true,
                        true,
                        "토큰 갱신이 30일 이상 됨 — 로그인 상태를 확인하세요".into(),
                    ));
                }
            }
        }
        Ok((true, false, String::new()))
    }
    fn login_test(&self, id: &str) -> Result<V, String> {
        self.record(id)?;
        if self.has_native_profile(id) {
            let profile = self.native_profile(id)?;
            let credentials = profile.credentials().map_err(io_error)?.is_some();
            let engine = tokio::runtime::Handle::current()
                .block_on(profile.check_engine())
                .is_ok();
            let usage = if credentials && engine {
                tokio::runtime::Handle::current().block_on(self.usage.verify_native(profile))
            } else {
                serde_json::json!({"query":{"state":"error","code":"login_required"}})
            };
            let official = usage["query"]["state"] == "ready";
            return Ok(usage_value(
                serde_json::json!({"id":id,"ok":credentials && engine && official,
                "state":if credentials && engine && official {"ready"}else if !credentials{"login"}else{"warning"},
                "checks":[{"label":"jcode 계정 인증","ok":credentials,"detail":if credentials{"이 계정의 전용 인증정보 확인"}else{"브라우저 로그인이 필요합니다."}},
                    {"label":"jcode 엔진","ok":engine,"detail":if engine{"계정 격리·갱신 기능 확인"}else{"계정용 엔진을 확인하지 못했습니다."}},
                    {"label":"공식 사용량 조회","ok":official,"detail":if official{"공급자 응답 확인"}else{"사용량 조회를 완료하지 못했습니다. 계정 상태를 확인하세요."}}]}),
            ));
        }
        let launch = self.launch(id)?;
        let (exists, warning, note) = self.credential(&launch)?;
        let check = |label: &str, ok: bool, detail: String| {
            object([
                ("label", label.into()),
                ("ok", ok.into()),
                ("detail", detail.into()),
            ])
        };
        let mut checks = vec![];
        if !exists {
            checks.push(check(
                "로그인 파일",
                false,
                "없음 — 로그인 터미널에서 먼저 로그인하세요".into(),
            ));
            return Ok(object([
                ("id", id.into()),
                ("ok", false.into()),
                ("state", "login".into()),
                ("checks", V::Array(checks)),
            ]));
        }
        checks.push(check(
            "로그인 파일",
            true,
            if launch.provider == "claude" {
                ".credentials.json 있음"
            } else {
                "auth.json 있음"
            }
            .into(),
        ));
        checks.push(check(
            "토큰 유효성",
            !warning,
            if warning {
                note
            } else {
                "만료 징후 없음".into()
            },
        ));
        let args = if launch.provider == "claude" {
            ["auth", "status"]
        } else {
            ["login", "status"]
        };
        let label = format!("{} {}", launch.provider, args.join(" "));
        let mut command = tokio::process::Command::new(&launch.provider);
        command.args(args);
        launch.configure(&mut command);
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        let paths = std::iter::once(self.login_bin()).chain(std::env::split_paths(&inherited));
        command.env("PATH", std::env::join_paths(paths).map_err(io_error)?);
        let result = tokio::runtime::Handle::current()
            .block_on(commands::capture(command, Duration::from_secs(25)));
        let (ok, detail) = match result {
            Err(e) if e.kind() == io::ErrorKind::NotFound => (
                false,
                format!(
                    "CLI({})를 찾을 수 없음 — 서버 PATH를 확인하세요",
                    launch.provider
                ),
            ),
            Err(e) if e.kind() == io::ErrorKind::TimedOut => (false, "시간 초과 (25초)".into()),
            Err(_) => (false, "CLI 로그인 상태를 확인하지 못했습니다.".into()),
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let status: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_default();
                let ok = output.status.success();
                let detail = if ok {
                    if !status.is_null() {
                        format!(
                            "로그인됨 ({})",
                            status["authMethod"]
                                .as_str()
                                .filter(|s| !s.is_empty())
                                .unwrap_or("ok")
                        )
                    } else {
                        V::from(
                            stdout
                                .trim()
                                .lines()
                                .next()
                                .filter(|s| !s.is_empty())
                                .unwrap_or("OK"),
                        )
                        .cut(120)
                        .text()
                    }
                } else if status["loggedIn"] == false {
                    "로그인 안 됨 — 로그인 터미널에서 로그인하세요".into()
                } else {
                    V::from(
                        stderr
                            .trim()
                            .lines()
                            .last()
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("Command failed: {label}\n{stderr}")),
                    )
                    .cut(160)
                    .text()
                };
                (ok, detail)
            }
        };
        checks.push(check(&label, ok, detail));
        let ok = checks.iter().all(|c| c["ok"] == V::Bool(true));
        Ok(object([
            ("id", id.into()),
            ("ok", ok.into()),
            ("state", if ok { "ready" } else { "warning" }.into()),
            ("checks", V::Array(checks)),
        ]))
    }
    pub fn handle(
        &self,
        raw_id: &str,
        operation: &str,
        raw: crate::json_values::Object,
    ) -> Response {
        let Some(id) = (if matches!(operation, "create" | "list") {
            Some(String::new())
        } else {
            crate::decoded_id(raw_id)
        }) else {
            return crate::error(400, "Invalid AI account");
        };
        let input = match raw
            .into_iter()
            .map(|(k, v)| V::parse(&v).map(|v| (k, v)))
            .collect::<serde_json::Result<_>>()
        {
            Ok(fields) => V::Object(fields),
            Err(_) => return crate::error(400, "Invalid JSON"),
        };
        let result = match operation {
            "list" => self
                .list()
                .map_err(|_| "AI 계정 정보를 불러오지 못했습니다.".into()),
            "create" => self.create(&input),
            "delete" => self.delete(&id),
            "budget" => self.budget(&id, &input),
            "test" => self.login_test(&id),
            "refresh_usage" => self.launch_checked(&id, false).and_then(|launch| {
                if self.has_native_profile(&id) {
                    let profile = self.native_profile(&id)?;
                    self.usage.invalidate(&profile.home);
                    self.usage.snapshot_native(profile);
                } else {
                    self.usage.invalidate(&launch.home);
                    self.usage.snapshot(&launch.provider, &launch.home);
                }
                Ok(object([
                    ("id", id.clone().into()),
                    ("refreshing", true.into()),
                ]))
            }),
            _ => Err("Account migration incomplete".into()),
        };
        match result {
            Ok(data) => (
                axum::http::StatusCode::from_u16(if operation == "create" { 201 } else { 200 })
                    .unwrap(),
                Json(data.raw()),
            )
                .into_response(),
            Err(message) => crate::error(
                if operation == "list" {
                    500
                } else if message == "AI account not found" {
                    404
                } else if operation == "budget" && message != "Invalid AI account" {
                    500
                } else {
                    400
                },
                &message,
            ),
        }
    }
}

fn usage_value(value: serde_json::Value) -> V {
    V::parse(&serde_json::value::to_raw_value(&value).unwrap()).unwrap_or(V::Null)
}
fn truthy_or(value: &V, fallback: V) -> V {
    if value.truthy() {
        value.clone()
    } else {
        fallback
    }
}
fn hub_text(profile: &V, keys: &[&str], fallback: &str) -> V {
    keys.iter()
        .map(|k| &profile[*k])
        .find(|v| v.truthy())
        .map(text)
        .unwrap_or_else(|| fallback.into())
}
fn remaining(usage: &V, budget: &V) -> V {
    let official = &usage["limits"]["weekly"]["remaining"];
    if *official != V::Null {
        return official.clone();
    }
    if !usage.truthy() || !budget.truthy() || usage["provider"] != V::from("claude") {
        return V::Null;
    }
    let n = 100.0 - usage["weeklyTokens"].number() / budget.number() * 100.0;
    if n.is_nan() {
        V::Null
    } else {
        n.clamp(0.0, 100.0).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hub_requery_recovers_old_errors_and_prefers_live_limits() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        let data = fixture.path().join("data");
        let account = home.join("hub-claude");
        fs::create_dir_all(&account).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::create_dir(home.join(".codex-account-launcher")).unwrap();
        fs::write(account.join(".credentials.json"), "{}").unwrap();
        fs::write(home.join(".codex-account-launcher/profiles.json"),serde_json::json!({"profiles":[{
            "provider":"claude","claudeConfigDir":account,"name":"hub fixture","lastLimitsError":"old temporary error",
            "lastLimitsRefreshUtc":iso_now(),"weeklyLimitUsedPercent":95,"shortLimitUsedPercent":90}]}).to_string()).unwrap();
        let store = Store::new_legacy(&data, fixture.path(), &home).unwrap();
        let records = store.hub_records().0;
        let id = &records[0].id;
        assert!(
            store.launch_checked(id, false).is_ok(),
            "Stored query errors cannot prevent querying the safe account path"
        );
        store.usage.seed("claude",&account,serde_json::json!({"provider":"claude","query":{"state":"ready"},"limits":{
            "weekly":{"remaining":80,"resetAt":"2030-01-01T00:00:00Z"},"session":{"remaining":70,"resetAt":"2030-01-02T00:00:00Z"}}}));
        let list = store.list().unwrap();
        let row = &list["accounts"].array()[0];
        assert_eq!(row["weeklyRemaining"], V::Number(80.));
        assert_eq!(row["sessionRemaining"], V::Number(70.));
        assert_eq!(row["sessionResetAt"], V::from("2030-01-02T00:00:00Z"));
        assert_eq!(row["state"], V::from("ready"));
        assert!(
            store.launch(id).is_ok(),
            "A verified recovery cannot remain blocked by the old saved query error"
        );
    }

    #[test]
    fn legacy_registered_home_and_login_path_do_not_widen_directory_deletion() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("data");
        let home = fixture.path().join("home");
        let external = fixture.path().join("explicit-account");
        for path in [&data, &home, &external] {
            fs::create_dir(path).unwrap();
        }
        fs::write(external.join("keep"), "synthetic sentinel").unwrap();
        let id = "0123456789abcdef";
        let record = object([
            ("id", id.into()),
            ("name", "synthetic account".into()),
            ("provider", "claude".into()),
            ("homePath", external.to_string_lossy().into_owned().into()),
        ]);
        fs::write(
            data.join("ai-accounts.json"),
            object([
                ("accounts", V::Array(vec![record.clone()])),
                ("future", "preserve".into()),
            ])
            .raw()
            .get(),
        )
        .unwrap();
        let preview = Store::new(&data, fixture.path());
        let legacy = Store::new_legacy(&data, fixture.path(), &home).unwrap();
        assert_eq!(preview.login_bin(), data.join("home/.local/bin"));
        assert_eq!(legacy.login_bin(), home.join(".local/bin"));
        assert_eq!(legacy.root(), data.join("ai-accounts"));
        assert!(preview.launch(id).is_err());
        assert_eq!(legacy.launch(id).unwrap().home, external);
        assert!(legacy.owned_home(&record).is_err());
        legacy.delete(id).unwrap();
        assert!(legacy.load().unwrap()["accounts"].array().is_empty());
        assert_eq!(legacy.load().unwrap()["future"], V::from("preserve"));
        assert_eq!(
            fs::read_to_string(external.join("keep")).unwrap(),
            "synthetic sentinel"
        );
        assert!(!home.join("ai-accounts.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn legacy_home_and_record_paths_reject_relative_parents_and_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("data");
        let home = fixture.path().join("home");
        fs::create_dir(&data).unwrap();
        fs::create_dir(&home).unwrap();
        let linked = fixture.path().join("linked-home");
        symlink(&home, &linked).unwrap();
        assert!(Store::new_legacy(&data, fixture.path(), Path::new("relative")).is_err());
        assert!(Store::new_legacy(&data, fixture.path(), &linked).is_err());
        assert!(
            Store::new_legacy(&data, fixture.path(), &fixture.path().join("child/../home"))
                .is_err()
        );
        let legacy = Store::new_legacy(&data, fixture.path(), &home).unwrap();
        for invalid in [
            PathBuf::from("relative"),
            linked,
            fixture.path().join("child/../home"),
        ] {
            let record = object([("homePath", invalid.to_string_lossy().into_owned().into())]);
            assert!(legacy.record_home(&record).is_err());
        }
    }
}
