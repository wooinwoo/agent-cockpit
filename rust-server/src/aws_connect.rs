//! Local AWS authentication and explicitly owned database tunnel processes.
use crate::ai_transport::Cancel;
use axum::{
    body::{to_bytes, Body},
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs,
    io::Write,
    net::{Ipv4Addr, TcpListener},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Mutex as AsyncMutex,
};
#[path = "aws_connect_legacy.rs"]
mod legacy;

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/aws-connect"),
    ("POST", "/api/aws-connect/auth"),
    ("POST", "/api/aws-connect/logout"),
    ("POST", "/api/aws-connect/start"),
    ("POST", "/api/aws-connect/stop"),
    ("POST", "/api/aws-connect/stop-external"),
    ("POST", "/api/aws-connect/save"),
    ("POST", "/api/aws-connect/delete"),
];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, endpoint)| method.as_str() == *verb && path == *endpoint)
}
type Result<T> = std::result::Result<T, (u16, String)>;
fn invalid(message: &str) -> (u16, String) {
    (400, message.into())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn matches(pattern: &str, text: &str) -> bool {
    regex::Regex::new(pattern).unwrap().is_match(text)
}

#[derive(Clone)]
struct Target {
    id: String,
    label: String,
    profile: String,
    region: String,
    rds_instance: String,
    local_port: u16,
    custom_target: Option<CustomTarget>,
    databases: Vec<String>,
}
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CustomTarget {
    vpc_id: String,
    host: String,
    port: u16,
}
impl Target {
    fn from_value(value: &Value) -> Result<Self> {
        let object = value
            .as_object()
            .ok_or(invalid("연결 설정은 객체여야 합니다."))?;
        let keys = [
            "id",
            "label",
            "profile",
            "region",
            "rdsInstance",
            "localPort",
            "customTarget",
            "databases",
        ];
        if !(6..=8).contains(&object.len())
            || object.keys().any(|key| !keys.contains(&key.as_str()))
        {
            return Err(invalid(
                "지원하지 않는 연결 설정입니다. 비밀번호는 저장하지 않습니다.",
            ));
        }
        let text = |key: &str| {
            value[key]
                .as_str()
                .map(str::to_owned)
                .ok_or(invalid("연결 설정 문자열을 확인하세요."))
        };
        let port = value["localPort"]
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .ok_or(invalid("로컬 포트를 확인하세요."))?;
        let target = Self {
            id: text("id")?,
            label: text("label")?,
            profile: text("profile")?,
            region: text("region")?,
            rds_instance: text("rdsInstance")?,
            local_port: port,
            custom_target: object
                .get("customTarget")
                .map(|value| {
                    serde_json::from_value(value.clone())
                        .map_err(|_| invalid("직접 연결의 VPC·호스트·포트를 확인하세요."))
                })
                .transpose()?,
            databases: object
                .get("databases")
                .map(|value| {
                    serde_json::from_value(value.clone())
                        .map_err(|_| invalid("DB 목록은 이름 배열이어야 합니다."))
                })
                .transpose()?
                .unwrap_or_default(),
        };
        target.validate()?;
        Ok(target)
    }
    fn value(&self) -> Value {
        let mut value = json!({"id":self.id,"label":self.label,"profile":self.profile,"region":self.region,"rdsInstance":self.rds_instance,"localPort":self.local_port});
        if let Some(custom) = &self.custom_target {
            value["customTarget"] = json!(custom);
        }
        if !self.databases.is_empty() {
            value["databases"] = json!(self.databases);
        }
        value
    }
    fn validate(&self) -> Result<()> {
        let unique: HashSet<_> = self.databases.iter().collect();
        if self.databases.len() > 100
            || unique.len() != self.databases.len()
            || self
                .databases
                .iter()
                .any(|name| !matches(r"^[a-zA-Z0-9_][a-zA-Z0-9_$-]{0,63}$", name))
        {
            return Err(invalid(
                "DB 이름은 영문·숫자·_·$·- 64자 이내이며 중복 없이 최대 100개입니다.",
            ));
        }
        if let Some(custom) = &self.custom_target {
            if !matches(r"^vpc-(?:[0-9a-f]{8}|[0-9a-f]{17})$", &custom.vpc_id)
                || !matches(
                    r"^[a-zA-Z0-9][a-zA-Z0-9.-]{0,251}[a-zA-Z0-9]$",
                    &custom.host,
                )
                || custom.host.contains("..")
                || custom.port == 0
            {
                return Err(invalid(
                    "직접 연결의 VPC ID·DNS 호스트·포트(1~65535)를 확인하세요.",
                ));
            }
        }
        if !matches(r"^[a-zA-Z0-9_-]{1,64}$", &self.id)
            || self.label.trim().is_empty()
            || self.label.chars().count() > 80
            || self.label.chars().any(char::is_control)
            || !matches(r"^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,127}$", &self.profile)
            || !matches(r"^[a-z]{2}(?:-[a-z]+){1,3}-[0-9]$", &self.region)
            || !matches(r"^[a-zA-Z][a-zA-Z0-9-]{0,62}$", &self.rds_instance)
            || self.local_port < 1024
        {
            return Err(invalid(
                "이름·프로필·리전·RDS ID·로컬 포트(1024~65535)를 확인하세요.",
            ));
        }
        Ok(())
    }
}
fn presets() -> Vec<Target> {
    [
        (
            "example-prod",
            "예시 운영 DB",
            "example",
            "example-prod-instance-1",
            13307,
        ),
        (
            "example-stg",
            "예시 스테이징 DB",
            "example",
            "example-stg",
            13306,
        ),
        (
            "example-dev",
            "예시 개발 DB",
            "example",
            "example-dev",
            13316,
        ),
    ]
    .into_iter()
    .map(|(id, label, profile, rds, port)| Target {
        id: id.into(),
        label: label.into(),
        profile: profile.into(),
        region: "ap-northeast-2".into(),
        rds_instance: rds.into(),
        local_port: port,
        custom_target: None,
        databases: Vec::new(),
    })
    .collect()
}
#[derive(Clone)]
struct Auth {
    keys: Option<[String; 3]>,
    expires: Option<u64>,
    identity: String,
}
impl Auth {
    fn expired(&self) -> bool {
        self.expires.is_some_and(|at| at <= now())
    }
}
#[derive(Default)]
struct Progress {
    phase: String,
    message: String,
    attempts: u32,
    pid: Option<u32>,
    logs: VecDeque<String>,
    auth_failed: bool,
}
struct Running {
    cancel: Cancel,
    task: tokio::task::JoinHandle<()>,
    progress: Arc<Mutex<Progress>>,
    profile: String,
}
struct State {
    targets: Vec<Target>,
    auth: BTreeMap<String, Auth>,
    running: BTreeMap<String, Running>,
}
pub struct Store {
    directory: PathBuf,
    load_error: Option<String>,
    state: AsyncMutex<State>,
    actions: AsyncMutex<()>,
    closing: AtomicBool,
    cancel: Cancel,
}

fn executable(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}
// Read only named profile metadata. Keys and credential_process values never enter API responses.
fn profiles() -> Vec<Value> {
    let mut entries: BTreeMap<String, Value> = BTreeMap::new();
    for (file, config) in [
        (
            std::env::var_os("AWS_SHARED_CREDENTIALS_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| home().join(".aws/credentials")),
            false,
        ),
        (
            std::env::var_os("AWS_CONFIG_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| home().join(".aws/config")),
            true,
        ),
    ] {
        let text = fs::read_to_string(file).unwrap_or_default();
        let mut current = None;
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') && line.ends_with(']') {
                let section = &line[1..line.len() - 1];
                let name = if config {
                    section
                        .strip_prefix("profile ")
                        .or_else(|| (section == "default").then_some(section))
                } else {
                    Some(section)
                };
                current = name
                    .filter(|name| matches(r"^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,127}$", name))
                    .map(str::to_owned);
                if let Some(name) = &current {
                    entries.entry(name.clone()).or_insert_with(
                        || json!({"name":name,"region":"ap-northeast-2","mfaArn":""}),
                    );
                }
            } else if config {
                if let (Some(name), Some((key, value))) = (&current, line.split_once('=')) {
                    if let Some(entry) = entries.get_mut(name) {
                        match key.trim() {
                            "region" => entry["region"] = value.trim().into(),
                            "mfa_serial" => entry["mfaArn"] = value.trim().into(),
                            _ => {}
                        }
                    }
                }
            }
        }
    }
    entries.into_values().collect()
}
fn clean_environment(command: &mut Command) {
    for key in [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SECURITY_TOKEN",
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_ENDPOINT_URL",
        "AWS_ENDPOINT_URL_STS",
        "MYSQL_PWD",
    ] {
        command.env_remove(key);
    }
    command
        .env("AWS_PAGER", "")
        .env("AWS_CLI_AUTO_PROMPT", "off")
        .env("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", "true");
}
fn apply_auth(command: &mut Command, profile: &str, auth: Option<&Auth>, basti: bool) {
    clean_environment(command);
    if let Some(keys) = auth.and_then(|auth| auth.keys.as_ref()) {
        command
            .env("AWS_ACCESS_KEY_ID", &keys[0])
            .env("AWS_SECRET_ACCESS_KEY", &keys[1])
            .env("AWS_SESSION_TOKEN", &keys[2]);
    } else {
        command
            .arg(if basti { "--aws-profile" } else { "--profile" })
            .arg(profile);
    }
}
// Binding tests availability without opening a database connection or generating failed DB handshakes.
fn port_occupied(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_err()
}
#[derive(Debug, PartialEq)]
enum PortOwner {
    Managed,
    External,
    Unknown,
}
#[cfg(target_os = "linux")]
fn port_owner(port: u16, group: u32) -> PortOwner {
    let sockets: HashSet<_> = ["/proc/net/tcp"]
        .iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .flat_map(|text| {
            text.lines()
                .skip(1)
                .filter_map(|line| {
                    let fields: Vec<_> = line.split_whitespace().collect();
                    let (address, value) = fields.get(1)?.rsplit_once(':')?;
                    (fields.get(3) == Some(&"0A")
                        && matches!(address, "0100007F" | "00000000")
                        && u16::from_str_radix(value, 16).ok() == Some(port))
                    .then(|| format!("socket:[{}]", fields.get(9).unwrap_or(&"")))
                })
                .collect::<Vec<_>>()
        })
        .collect();
    if sockets.is_empty() {
        return PortOwner::Unknown;
    }
    let Ok(processes) = fs::read_dir("/proc") else {
        return PortOwner::Unknown;
    };
    let mut foreign = Vec::new();
    let owns_socket = |process: &std::path::Path| {
        fs::read_dir(process.join("fd")).is_ok_and(|fds| {
            fds.flatten().any(|fd| {
                fs::read_link(fd.path())
                    .is_ok_and(|path| sockets.contains(path.to_string_lossy().as_ref()))
            })
        })
    };
    for process in processes.flatten() {
        let Some(pid) = process
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        if unsafe { libc::getpgid(pid) } != group as i32 {
            foreign.push(process.path());
            continue;
        }
        if owns_socket(&process.path()) {
            return PortOwner::Managed;
        }
    }
    if foreign.iter().any(|process| owns_socket(process)) {
        PortOwner::External
    } else {
        PortOwner::Unknown
    }
}
#[cfg(not(target_os = "linux"))]
fn port_owner(_port: u16, _group: u32) -> PortOwner {
    PortOwner::Unknown
}
fn safe_log(text: &str, auth: Option<&Auth>) -> String {
    let mut text = text.to_owned();
    if let Some(keys) = auth.and_then(|auth| auth.keys.as_ref()) {
        for key in keys {
            if !key.is_empty() {
                text = text.replace(key, "[비밀값 숨김]");
            }
        }
    }
    let sensitive = regex::Regex::new(
        r"(?i)(password|mysql_pwd|secret.?access.?key|session.?token|access.?key.?id).{0,4}[=:]",
    )
    .unwrap();
    if sensitive.is_match(&text) {
        return "[인증정보가 포함된 로그 줄 숨김]".into();
    }
    let text = regex::Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")
        .unwrap()
        .replace_all(&text, "[키 숨김]")
        .into_owned();
    regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]")
        .unwrap()
        .replace_all(&text, "")
        .chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .take(1200)
        .collect()
}
fn auth_error(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "expiredtoken",
        "invalidclienttoken",
        "accessdenied",
        "access denied",
        "unauthorized",
        "security token",
        "unable to locate credentials",
        "could not load credentials",
        "missing credentials",
        "credentialsprovidererror",
        "invalid mfa",
        "mfa code is invalid",
        "mfa token is invalid",
        "mfa required",
        "sso session",
    ]
    .iter()
    .any(|word| text.contains(word))
}
async fn read_log(
    reader: impl AsyncRead + Unpin,
    progress: Arc<Mutex<Progress>>,
    auth: Option<Auth>,
) {
    let mut reader = reader;
    let mut decoder = crate::terminal_buffer::Decoder::default();
    let mut bytes = [0; 2048];
    let mut pending = String::new();
    let mut oversized = false;
    loop {
        let Ok(count) = reader.read(&mut bytes).await else {
            break;
        };
        if count == 0 {
            if !pending.is_empty() && !oversized {
                let mut state = progress.lock().unwrap();
                state.auth_failed |= auth_error(&pending);
                state.logs.push_back(safe_log(&pending, auth.as_ref()));
                while state.logs.len() > 60 {
                    state.logs.pop_front();
                }
            }
            break;
        }
        for c in decoder.push(&bytes[..count]).chars() {
            if c == '\n' {
                let line = if oversized {
                    "[긴 로그 줄 생략]".into()
                } else {
                    safe_log(&pending, auth.as_ref())
                };
                let mut state = progress.lock().unwrap();
                state.auth_failed |= auth_error(&pending);
                state.logs.push_back(line);
                while state.logs.len() > 60 {
                    state.logs.pop_front();
                }
                pending.clear();
                oversized = false;
            } else if !oversized {
                pending.push(c);
                if pending.len() > 8192 {
                    progress.lock().unwrap().auth_failed |= auth_error(&pending);
                    pending.clear();
                    oversized = true;
                }
            }
        }
    }
}
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
async fn tunnel(
    _target: Target,
    _program: PathBuf,
    _auth: Option<Auth>,
    _cancel: Cancel,
    progress: Arc<Mutex<Progress>>,
) {
    let mut state = progress.lock().unwrap();
    state.phase = "error".into();
    state.message = "이 연결 관리 기능은 Linux/WSL에서 지원합니다.".into();
}
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
async fn tunnel(
    target: Target,
    program: PathBuf,
    auth: Option<Auth>,
    cancel: Cancel,
    progress: Arc<Mutex<Progress>>,
) {
    let mut failures = 0;
    loop {
        if cancel.is_cancelled() {
            break;
        }
        if auth.as_ref().is_some_and(Auth::expired) {
            let mut state = progress.lock().unwrap();
            state.phase = "auth-required".into();
            state.message = "MFA가 만료됐습니다. 다시 인증한 뒤 시작하세요.".into();
            break;
        }
        if port_occupied(target.local_port) {
            let mut state = progress.lock().unwrap();
            state.phase = "blocked".into();
            state.message = "로컬 포트가 사용 중입니다. 기존 터널을 먼저 종료하세요.".into();
            break;
        }
        let mut command = Command::new(&program);
        command.arg("connect");
        if let Some(custom) = &target.custom_target {
            command.args([
                "--custom-target-vpc",
                &custom.vpc_id,
                "--custom-target-host",
                &custom.host,
                "--custom-target-port",
                &custom.port.to_string(),
            ]);
        } else {
            command.args(["--rds-instance", &target.rds_instance]);
        }
        command.args([
            "--local-port",
            &target.local_port.to_string(),
            "--aws-region",
            &target.region,
        ]);
        apply_auth(&mut command, &target.profile, auth.as_ref(), true);
        let mut child = match crate::process_owned::spawn_owned(command) {
            Ok(child) => child,
            Err(_) => {
                let mut state = progress.lock().unwrap();
                state.phase = "error".into();
                state.message =
                    "basti를 실행하지 못했습니다. 설치와 실행 권한을 확인하세요.".into();
                break;
            }
        };
        let group = child.child_mut().id().unwrap();
        {
            let mut state = progress.lock().unwrap();
            state.pid = Some(group);
            state.phase = "running".into();
            state.message = "터널 프로세스가 실행 중입니다. DB 쿼리는 검사하지 않습니다.".into();
            state.attempts += 1;
            state.auth_failed = false;
        }
        let mut out = tokio::spawn(read_log(
            child.child_mut().stdout.take().unwrap(),
            progress.clone(),
            auth.clone(),
        ));
        let mut err = tokio::spawn(read_log(
            child.child_mut().stderr.take().unwrap(),
            progress.clone(),
            auth.clone(),
        ));
        let started = now();
        let expires = auth.as_ref().and_then(|auth| auth.expires);
        tokio::select! {
            _ = cancel.cancelled() => { child.terminate().await; }
            _ = async { if let Some(at)=expires { tokio::time::sleep(Duration::from_secs(at.saturating_sub(now()))).await; } else { std::future::pending::<()>().await; } } => {
                child.terminate().await;
                let mut state=progress.lock().unwrap(); state.phase="auth-required".into(); state.message="MFA가 만료됐습니다. 다시 인증하고 시작하세요.".into();
            }
            _ = child.wait_and_clean() => {}
            foreign = async {
                let mut opened=false;
                let mut missing=0;
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    match port_owner(target.local_port, group) {
                        PortOwner::Managed => {opened=true; missing=0;}
                        PortOwner::External => break true,
                        PortOwner::Unknown => missing+=5,
                    }
                    if missing >= if opened {20} else {90} {break false;}
                }
            } => {
                child.terminate().await;
                let mut state=progress.lock().unwrap();
                if foreign {
                    state.phase="blocked".into();
                    state.message="다른 프로세스가 로컬 포트를 사용 중입니다. 해당 실행을 확인하세요.".into();
                } else { state.logs.push_back("로컬 포트가 열리지 않거나 닫힌 상태가 지속돼 재연결합니다.".into()); }
            }
        }
        if tokio::time::timeout(Duration::from_secs(2), async {
            let _ = tokio::join!(&mut out, &mut err);
        })
        .await
        .is_err()
        {
            out.abort();
            err.abort();
        }
        let stop = {
            let mut state = progress.lock().unwrap();
            state.pid = None;
            if cancel.is_cancelled() {
                state.phase = "stopped".into();
                state.message = "종료했습니다.".into();
                true
            } else if state.phase == "auth-required" || state.phase == "blocked" {
                true
            } else if state.auth_failed {
                state.phase = "auth-required".into();
                state.message = "AWS 인증·접속 권한을 확인한 뒤 다시 시작하세요.".into();
                true
            } else {
                false
            }
        };
        if stop {
            break;
        }
        if now().saturating_sub(started) > 120 {
            failures = 0;
        }
        failures += 1;
        if failures > 5 {
            let mut state = progress.lock().unwrap();
            state.phase = "error".into();
            state.message = "5회 재연결에 실패했습니다. 로그를 확인한 뒤 다시 시작하세요.".into();
            break;
        }
        let delay = 5u64 * (1u64 << (failures - 1)).min(12);
        {
            let mut state = progress.lock().unwrap();
            state.phase = "retrying".into();
            state.message =
                format!("프로세스 종료를 감지했습니다. {delay}초 뒤 재연결합니다 ({failures}/5).");
        }
        tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
    }
}

impl Store {
    pub fn new(directory: PathBuf) -> Self {
        legacy::configure(&directory);
        let loaded = match fs::read(directory.join("aws-connections.json")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(presets()),
            Err(_) => Err(()),
            Ok(data) => serde_json::from_slice::<Vec<Value>>(&data)
                .ok()
                .and_then(|rows| {
                    rows.iter()
                        .map(Target::from_value)
                        .collect::<Result<Vec<_>>>()
                        .ok()
                })
                .filter(|rows| {
                    let mut ids = HashSet::new();
                    let mut ports = HashSet::new();
                    rows.len() <= 30
                        && rows
                            .iter()
                            .all(|row| ids.insert(&row.id) && ports.insert(row.local_port))
                })
                .ok_or(()),
        };
        let (targets, load_error) = match loaded {
            Ok(rows) => (rows, None),
            Err(()) => (vec![], Some("저장된 AWS 연결 설정을 읽지 못했습니다. aws-connections.json의 형식·중복 ID·포트·파일 권한을 확인한 뒤 서버를 다시 시작하세요. 원본 파일은 유지했습니다.".into())),
        };
        Self {
            directory,
            load_error,
            state: AsyncMutex::new(State {
                targets,
                auth: BTreeMap::new(),
                running: BTreeMap::new(),
            }),
            actions: AsyncMutex::new(()),
            closing: AtomicBool::new(false),
            cancel: Cancel::default(),
        }
    }
    async fn snapshot(&self) -> Value {
        let state = self.state.lock().await;
        let needs_legacy = state.targets.iter().any(|target| {
            port_occupied(target.local_port)
                && !state
                    .running
                    .get(&target.id)
                    .is_some_and(|run| !run.task.is_finished())
        });
        let inventory = if needs_legacy {
            legacy::inventory()
        } else {
            Vec::new()
        };
        let targets: Vec<_> = state.targets.iter().map(|target| {
            let occupied = port_occupied(target.local_port);
            let runtime = state.running.get(&target.id).map(|running| {
                let p=running.progress.lock().unwrap();
                let managed=!running.task.is_finished();
                let owner=if managed && occupied {p.pid.map(|pid| port_owner(target.local_port,pid)).unwrap_or(PortOwner::Unknown)} else {PortOwner::Unknown};
                let owned=owner==PortOwner::Managed;
                let foreign=owner==PortOwner::External;
                json!({"phase":if foreign {"blocked"} else {&p.phase},"message":if foreign {"포트를 사용하는 프로세스를 확인 중입니다. 연결 완료로 처리하지 않습니다."} else {&p.message},"attempts":p.attempts,"pid":p.pid,"logs":p.logs,"managed":managed,"portOpen":if managed {owned} else {occupied}})
            }).unwrap_or_else(|| json!({"phase":if occupied {"external"} else {"stopped"},"managed":false,"portOpen":occupied,"message":if occupied {"다른 실행이 이 포트를 사용 중입니다. 중복 실행하지 않습니다."} else {"시작 버튼으로 연결하세요."},"logs":[]}));
            let mut runtime=runtime;
            runtime["canStopExternal"]=(occupied && runtime["managed"]!=true && legacy::count(target,&inventory)>0).into();
            json!({"config":target.value(),"runtime":runtime})
        }).collect();
        let sessions: Vec<_> = state.auth.iter().map(|(profile,auth)| json!({"profile":profile,"active":!auth.expired(),"expiresAt":auth.expires.map(|at|at*1000),"identity":auth.identity,"mfa":auth.keys.is_some()})).collect();
        json!({"targets":targets,"profiles":profiles(),"sessions":sessions,"dependencies":{"aws":executable("aws").is_some(),"basti":executable("basti").is_some(),"sessionManager":executable("session-manager-plugin").is_some()}})
    }
    fn persist(&self, targets: &[Target]) -> Result<()> {
        fs::create_dir_all(&self.directory)
            .map_err(|_| (500, "연결 설정 폴더를 만들지 못했습니다.".into()))?;
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|_| (500, "연결 설정을 저장하지 못했습니다.".into()))?;
        file.write_all(
            &serde_json::to_vec_pretty(&targets.iter().map(Target::value).collect::<Vec<_>>())
                .unwrap(),
        )
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| (500, "연결 설정을 저장하지 못했습니다.".into()))?;
        file.persist(self.directory.join("aws-connections.json"))
            .map_err(|_| (500, "연결 설정을 교체하지 못했습니다.".into()))?;
        Ok(())
    }
    async fn authenticate(&self, input: &Value) -> Result<Value> {
        if input.as_object().is_none_or(|fields| {
            fields
                .keys()
                .any(|key| !["profile", "region", "code", "mfaArn"].contains(&key.as_str()))
        }) || ["code", "mfaArn"]
            .iter()
            .any(|key| input.get(key).is_some_and(|value| !value.is_string()))
        {
            return Err(invalid("AWS 인증 입력 형식을 확인하세요."));
        }
        let profile = input["profile"].as_str().unwrap_or("");
        let region = input["region"].as_str().unwrap_or("");
        if !profiles().iter().any(|p| p["name"] == profile)
            || !matches(r"^[a-z]{2}(?:-[a-z]+){1,3}-[0-9]$", region)
        {
            return Err(invalid("로컬 AWS 프로필과 리전을 선택하세요."));
        }
        let code = input["code"].as_str().unwrap_or("");
        let arn = input["mfaArn"].as_str().unwrap_or("");
        if self
            .state
            .lock()
            .await
            .running
            .values()
            .any(|run| run.profile == profile && !run.task.is_finished())
        {
            return Err((
                409,
                "실행 중인 이 프로필의 터널을 종료한 뒤 인증을 변경하세요.".into(),
            ));
        }
        let mut command = Command::new(
            executable("aws").ok_or((503, "AWS CLI를 설치한 뒤 다시 시도하세요.".into()))?,
        );
        command.args([
            "sts",
            if code.is_empty() {
                "get-caller-identity"
            } else {
                "get-session-token"
            },
            "--region",
            region,
            "--output",
            "json",
            "--cli-connect-timeout",
            "5",
            "--cli-read-timeout",
            "15",
        ]);
        apply_auth(&mut command, profile, None, false);
        if !code.is_empty() {
            if !matches(r"^[0-9]{6}$", code)
                || !matches(
                    r"^arn:aws(?:-us-gov|-cn)?:iam::[0-9]{12}:mfa/[a-zA-Z0-9_+=,.@/-]{1,128}$",
                    arn,
                )
            {
                return Err(invalid("MFA 기기 ARN과 6자리 코드를 확인하세요."));
            }
            command.args([
                "--serial-number",
                arn,
                "--token-code",
                code,
                "--duration-seconds",
                "28800",
            ]);
        }
        let output =
            crate::process_owned::run(command, Duration::from_secs(25), 1_048_576, &self.cancel)
                .await
                .map_err(|_| {
                    (
                        504,
                        "AWS 응답 시간이 초과됐습니다. 네트워크와 인증 상태를 확인하세요.".into(),
                    )
                })?;
        if !output.status.success() {
            return Err((401,"AWS 인증에 실패했습니다. 프로필·MFA 코드·권한을 확인하세요. SSO 프로필은 터미널에서 aws sso login을 먼저 실행하세요.".into()));
        }
        let data: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| (502, "AWS 인증 응답 형식을 확인하지 못했습니다.".into()))?;
        let auth = if code.is_empty() {
            let identity = data["Arn"]
                .as_str()
                .ok_or((502, "AWS 사용자 확인에 실패했습니다.".into()))?;
            Auth {
                keys: None,
                expires: None,
                identity: identity.into(),
            }
        } else {
            let c = &data["Credentials"];
            let keys = ["AccessKeyId", "SecretAccessKey", "SessionToken"]
                .map(|key| c[key].as_str().unwrap_or("").to_owned());
            let expires = c["Expiration"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|at| at.timestamp().max(0) as u64)
                .filter(|at| *at > now());
            if keys.iter().any(String::is_empty) || expires.is_none() {
                return Err((502, "AWS 임시 인증 응답이 올바르지 않습니다.".into()));
            }
            Auth {
                keys: Some(keys),
                expires,
                identity: "MFA 임시 세션".into(),
            }
        };
        let mut state = self.state.lock().await;
        if state
            .running
            .values()
            .any(|run| run.profile == profile && !run.task.is_finished())
        {
            return Err((
                409,
                "실행 중인 이 프로필의 터널을 종료한 뒤 인증을 변경하세요.".into(),
            ));
        }
        state.auth.insert(profile.into(), auth);
        Ok(json!({"ok":true}))
    }
    async fn action(&self, path: &str, input: Value) -> Result<Value> {
        if let Some(message) = &self.load_error {
            return Err((500, message.clone()));
        }
        let _action = self.actions.try_lock().map_err(|_| {
            (
                409,
                "다른 AWS 연결 요청을 처리 중입니다. 잠시 후 다시 시도하세요.".into(),
            )
        })?;
        if self.closing.load(Ordering::Acquire) {
            return Err((503, "서버 종료 중입니다.".into()));
        }
        if path.ends_with("/auth") {
            return self.authenticate(&input).await;
        }
        let mut state = self.state.lock().await;
        let id = input["id"].as_str().unwrap_or("").to_owned();
        match path {
            "/api/aws-connect/stop-external" => {
                let target = state
                    .targets
                    .iter()
                    .find(|row| row.id == id)
                    .cloned()
                    .ok_or(invalid("연결 대상을 찾지 못했습니다."))?;
                if state
                    .running
                    .get(&id)
                    .is_some_and(|run| !run.task.is_finished())
                {
                    return Err((409, "콕핏 실행은 일반 종료 버튼을 사용하세요.".into()));
                }
                if legacy::stop(&target).await == 0 {
                    return Err((
                        409,
                        "정확히 일치하는 기존 터널을 찾지 못했거나 종료 권한이 없습니다.".into(),
                    ));
                }
            }
            "/api/aws-connect/start" => {
                let target = state
                    .targets
                    .iter()
                    .find(|row| row.id == id)
                    .cloned()
                    .ok_or(invalid("연결 대상을 찾지 못했습니다."))?;
                if state
                    .running
                    .get(&id)
                    .is_some_and(|run| !run.task.is_finished())
                {
                    return Err((409, "이미 실행 중입니다.".into()));
                }
                if port_occupied(target.local_port) {
                    return Err((
                        409,
                        "로컬 포트가 이미 사용 중입니다. 기존 터널을 종료한 뒤 시작하세요.".into(),
                    ));
                }
                if executable("session-manager-plugin").is_none() {
                    return Err((503, "session-manager-plugin을 설치하세요.".into()));
                }
                let program = executable("basti")
                    .ok_or((503, "basti를 설치한 뒤 다시 시도하세요.".into()))?;
                let auth = state.auth.get(&target.profile).cloned();
                if auth.as_ref().is_some_and(Auth::expired) {
                    return Err((401, "MFA가 만료됐습니다. 다시 인증하세요.".into()));
                }
                let cancel = Cancel::default();
                let progress = Arc::new(Mutex::new(Progress {
                    phase: "starting".into(),
                    message: "시작 중…".into(),
                    ..Default::default()
                }));
                let task = tokio::spawn(tunnel(
                    target.clone(),
                    program,
                    auth,
                    cancel.clone(),
                    progress.clone(),
                ));
                state.running.insert(
                    id,
                    Running {
                        cancel,
                        task,
                        progress,
                        profile: target.profile,
                    },
                );
            }
            "/api/aws-connect/stop" => {
                if let Some(run) = state.running.remove(&id) {
                    run.cancel.cancel();
                    let _ = run.task.await;
                } else {
                    return Err((409, "콕핏에서 시작한 연결만 종료할 수 있습니다.".into()));
                }
            }
            "/api/aws-connect/logout" => {
                let profile = input["profile"].as_str().unwrap_or("");
                let ids: Vec<_> = state
                    .running
                    .iter()
                    .filter(|(_, run)| run.profile == profile)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    if let Some(run) = state.running.remove(&id) {
                        run.cancel.cancel();
                        let _ = run.task.await;
                    }
                }
                state.auth.remove(profile);
            }
            "/api/aws-connect/save" => {
                let mut target = Target::from_value(&input)?;
                if input.get("databases").is_none() {
                    if let Some(existing) = state.targets.iter().find(|row| row.id == target.id) {
                        target.databases = existing.databases.clone();
                    }
                }
                target.validate()?;
                if state
                    .running
                    .get(&target.id)
                    .is_some_and(|run| !run.task.is_finished())
                {
                    return Err((409, "연결을 종료한 뒤 설정을 변경하세요.".into()));
                }
                if state
                    .targets
                    .iter()
                    .any(|row| row.id != target.id && row.local_port == target.local_port)
                {
                    return Err(invalid("다른 연결에서 사용하는 로컬 포트입니다."));
                }
                let mut targets = state.targets.clone();
                if let Some(row) = targets.iter_mut().find(|row| row.id == target.id) {
                    *row = target;
                } else {
                    if targets.len() >= 30 {
                        return Err(invalid("연결은 최대 30개입니다."));
                    }
                    targets.push(target);
                }
                self.persist(&targets)?;
                state.targets = targets;
            }
            "/api/aws-connect/delete" => {
                if state
                    .running
                    .get(&id)
                    .is_some_and(|run| !run.task.is_finished())
                {
                    return Err((409, "연결을 종료한 뒤 삭제하세요.".into()));
                }
                let targets: Vec<_> = state
                    .targets
                    .iter()
                    .filter(|row| row.id != id)
                    .cloned()
                    .collect();
                if targets.len() == state.targets.len() {
                    return Err(invalid("연결 대상을 찾지 못했습니다."));
                }
                self.persist(&targets)?;
                state.targets = targets;
                state.running.remove(&id);
            }
            _ => return Err((404, "Not found".into())),
        }
        Ok(json!({"ok":true}))
    }
    pub async fn handle(&self, method: &Method, path: &str, body: Body) -> Response {
        if let Some(message) = &self.load_error {
            return crate::error(500, message);
        }
        if *method == Method::GET {
            return Json(self.snapshot().await).into_response();
        }
        let bytes = match tokio::time::timeout(Duration::from_secs(5), to_bytes(body, 16384)).await
        {
            Ok(Ok(bytes)) => bytes,
            _ => return crate::error(400, "요청이 너무 크거나 읽기 시간이 초과됐습니다."),
        };
        let input = match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(input)) => Value::Object(input),
            _ => return crate::error(400, "올바른 JSON 객체가 필요합니다."),
        };
        match self.action(path, input).await {
            Ok(data) => Json(data).into_response(),
            Err((status, message)) => crate::error(status, &message),
        }
    }
    pub async fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        self.cancel.cancel();
        let _action = self.actions.lock().await;
        let mut state = self.state.lock().await;
        for run in state.running.values() {
            run.cancel.cancel();
        }
        for (_, run) in std::mem::take(&mut state.running) {
            let _ = run.task.await;
        }
        state.auth.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presets_match_existing_commands_and_reject_shell_inputs() {
        let mut rows = presets();
        assert_eq!(
            rows.iter().map(|row| row.local_port).collect::<Vec<_>>(),
            [13307, 13306, 13316]
        );
        for row in &rows {
            row.validate().unwrap();
        }
        rows[0].profile = "example; touch /tmp/pwn".into();
        assert!(rows[0].validate().is_err());
        assert!(Target::from_value(&json!({"id":"x","password":"do-not-store"})).is_err());
    }
    #[test]
    fn logs_mask_keys_and_do_not_probe_databases() {
        let auth = Auth {
            keys: Some([
                "KEYVALUE".into(),
                "SECRETEXAMPLE".into(),
                "TOKENVALUE".into(),
            ]),
            expires: None,
            identity: String::new(),
        };
        let log = safe_log(
            "SECRETEXAMPLE mysql_pwd=supersecret AKIA0123456789ABCDEF",
            Some(&auth),
        );
        for value in ["SECRETEXAMPLE", "supersecret", "AKIA0123456789ABCDEF"] {
            assert!(!log.contains(value));
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        assert!(port_occupied(listener.local_addr().unwrap().port()));
        listener.set_nonblocking(true).unwrap();
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    #[tokio::test]
    async fn damaged_settings_are_reported_and_preserved() {
        let row = presets().remove(0).value();
        let mut same_port = row.clone();
        same_port["id"] = "other".into();
        let cases = [
            b"{broken".to_vec(),
            serde_json::to_vec(&json!([row.clone(), row.clone()])).unwrap(),
            serde_json::to_vec(&json!([row.clone(), same_port])).unwrap(),
        ];
        for bytes in cases {
            let directory = tempfile::tempdir().unwrap();
            let file = directory.path().join("aws-connections.json");
            fs::write(&file, &bytes).unwrap();
            let store = Store::new(directory.path().into());
            let response = store
                .handle(&Method::GET, "/api/aws-connect", Body::empty())
                .await;
            assert_eq!(response.status(), 500);
            assert!(store
                .action("/api/aws-connect/save", row.clone())
                .await
                .is_err());
            assert_eq!(fs::read(file).unwrap(), bytes);
        }
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn listener_ownership_distinguishes_foreign_and_disappeared_ports() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(
            port_owner(port, unsafe { libc::getpgrp() } as u32),
            PortOwner::Managed
        );
        assert_eq!(port_owner(port, 0), PortOwner::External);
        drop(listener);
        assert_eq!(port_owner(port, 0), PortOwner::Unknown);
    }
    #[test]
    fn normal_credential_messages_are_not_authentication_failures() {
        for line in [
            "AWS credentials loaded",
            "MFA not required",
            "Using cached credentials",
        ] {
            assert!(!auth_error(line), "{line}");
        }
        for line in [
            "AccessDenied",
            "ExpiredToken",
            "Unable to locate credentials",
            "CredentialsProviderError",
        ] {
            assert!(auth_error(line), "{line}");
        }
    }
    #[tokio::test]
    async fn settings_are_atomic_and_credentials_are_not_persisted() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let mut row = presets().remove(0);
        row.label = "새 이름".into();
        store
            .action("/api/aws-connect/save", row.value())
            .await
            .unwrap();
        let next = Store::new(directory.path().into());
        assert_eq!(next.state.lock().await.targets[0].label, "새 이름");
        assert!(next.snapshot().await["sessions"]
            .as_array()
            .unwrap()
            .is_empty());
        store.shutdown().await;
    }
}
