//! Native supervisor policy, human handoff and dashboard activity state.
use crate::{
    ai_config,
    ai_transport::{self, Cancel, GeminiOptions},
    board_value::{object, V},
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    fs,
    future::Future,
    io::{self, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

pub const ROUTES: &[(&str, &str)] = &[
    ("POST", "/api/supervisor/decide"),
    ("POST", "/api/supervisor/event"),
    ("GET", "/api/supervisor/recent"),
    ("GET", "/api/supervisor/status"),
    ("GET", "/api/supervisor/agents"),
    ("GET", "/api/supervisor/summaries"),
];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, target)| method.as_str() == *verb && path == *target)
}

pub type ChannelFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;
/// The Telegram adapter owns pending-reply registration and removes it when this
/// future completes or is dropped. An absent adapter must never grant permission.
pub trait HumanChannel: Send + Sync {
    fn ask_text(&self, id: String, message: String, record: V) -> ChannelFuture<Option<String>>;
    fn send_message(&self, text: String, options: V) -> ChannelFuture<()>;
    fn notify_decision(&self, record: V) -> ChannelFuture<()>;
}
const DANGER_PATHS: &[(&str, &str)] = &[
    (r#"^\/etc\/"#, ""),
    (r#"^\/usr\/"#, ""),
    (r#"^\/boot\/"#, ""),
    (r#"^\/bin\/"#, ""),
    (r#"^\/sbin\/"#, ""),
    (r#"^\/var\/lib\/"#, ""),
    (r#"^\/root\/"#, ""),
    (r#"\/\.ssh\/"#, ""),
    (r#"\/\.aws\/"#, ""),
    (r#"\/\.gnupg\/"#, ""),
    (r#"\/\.docker\/config\.json$"#, ""),
    (r#"\/id_rsa(\.pub)?$"#, ""),
    (r#"\/id_ed25519(\.pub)?$"#, ""),
    (r#"\/\.bash_history$"#, ""),
    (r#"\.env(\.|$)"#, ""),
    (r#"\/credentials(\.json)?$"#, ""),
    (r#"\.pem$"#, ""),
    (r#"\.key$"#, ""),
    (r#"\.crt$"#, ""),
];
const DANGER_PATTERNS: &[(&str, &str)] = &[
    (r#"\brm\s+-rf?\s+\/"#, ""),
    (r#"\brm\s+-rf?\s+~"#, ""),
    (r#"\brm\s+-rf?\s+\$HOME"#, ""),
    (r#":\(\)\s*\{\s*:\|:&\s*\}"#, ""),
    (r#"\bmkfs\."#, ""),
    (r#"\bdd\s+if=.*of=\/dev"#, ""),
    (r#">\s*\/dev\/sd[a-z]"#, ""),
    (
        r#"\bsudo\s+(rm|chmod|chown|dd|mkfs|systemctl|service|reboot|shutdown|halt|poweroff|kill)"#,
        "",
    ),
    (r#"\bsudo\s+-(i|s)\b"#, ""),
    (r#"\bchmod\s+-?R?\s*[0-7]{3,4}\s+\/"#, ""),
    (r#"\bchown\s+-?R?\s*root\b"#, ""),
    (r#"\bshutdown\b"#, ""),
    (r#"\breboot\b"#, ""),
    (r#"\bhalt\b"#, ""),
    (r#"\bpoweroff\b"#, ""),
    (r#"\bkill\s+-9\s+1\b"#, ""),
    (r#"\binit\s+[06]\b"#, ""),
    (r#"\biptables\s+.*-j\s+DROP"#, "i"),
    (r#"\bufw\s+(disable|delete)\b"#, "i"),
    (r#"\bcrontab\s+-r\b"#, ""),
    (r#"\bsystemctl\s+(stop|disable|mask)\b"#, ""),
    (r#"\bservice\s+\S+\s+(stop|disable)\b"#, ""),
    (r#"\bgit\s+push\s+--force(?!-with-lease)"#, ""),
    (r#"\bgit\s+push\s+-f\b"#, ""),
    (
        r#"\bgit\s+reset\s+--hard\s+(origin|HEAD~|[0-9a-f]{7,})"#,
        "",
    ),
    (r#"\bgit\s+clean\s+-[fdx]+"#, ""),
    (r#"\bgit\s+filter-(branch|repo)"#, ""),
    (r#"\bnpm\s+publish\b"#, ""),
    (r#"\bnpm\s+unpublish\b"#, ""),
    (r#"\bnpm\s+install\s+(-g|--global)\b"#, ""),
    (r#"\bnpm\s+uninstall\b"#, ""),
    (r#"\bpnpm\s+(publish|unpublish)\b"#, ""),
    (r#"\byarn\s+publish\b"#, ""),
    (r#"\bpip\s+install\s+--user\b"#, ""),
    (r#"\bcurl\s+[^|]*\|\s*(bash|sh|zsh)\b"#, ""),
    (r#"\bwget\s+[^|]*\|\s*(bash|sh|zsh)\b"#, ""),
    (r#"\bDROP\s+(TABLE|DATABASE|SCHEMA)"#, "i"),
    (r#"\bTRUNCATE\s+TABLE"#, "i"),
    (r#"\bDELETE\s+FROM\s+\w+\s*;?\s*$"#, "i"),
];
const SAFE_BASH: &str = r#"^(ls|pwd|cat|head|tail|echo|jq|find|grep|rg|wc|stat|file|which|env|date|whoami|hostname|uname|tree|du|df|ps|node\s+--version|npm\s+(test|run|ls|outdated|view|info|whoami)|pnpm\s+(test|run|ls|outdated|view|info|why)|yarn\s+(test|run|info|why)|git\s+(status|log|diff|branch|show|fetch|remote))(\s|$)"#;
const DECIDE_SYSTEM: &str = r#"너는 Claude Code 도구 호출 supervisor. **기본은 approve**. 사용자가 시킨 작업으로 가정해.

ask 는 **사용자만이 답할 수 있는** 진짜 의사결정일 때만:
- prod DB 마이그레이션 / 데이터 손실 가능
- prod 배포 / 외부 결제·API 키 발급
- 비밀번호·키 변경

거의 모든 dev 작업은 approve. 단순 서버 재시작, 로컬 파일 작업, 빌드, git 작업 (force-push 빼고) 등 다.

출력 JSON 한 개:
{
  "decision": "approve" | "deny" | "ask",
  "confidence": 0.0~1.0,
  "reasoning": "왜 이 결정인지 한국어 한 문장",
  "ask_message": "decision이 ask일 때만"
}

기준:
- approve: dev 작업 일체 (편집/생성/조회/빌드/테스트/재시작/일반 Bash)
- deny: 명백히 파괴 (rm -rf /, force push to main, drop table, prod 데이터 삭제)
- ask: prod 영향 + 복원 불가 + 사용자 결정이 본질인 거"#;
const RESOLVE_SYSTEM: &str = r#"너는 supervisor. 도구 호출에 대해 사용자에게 질문했고, 답변을 받았어. 그 답을 해석해 최종 결정.

출력 JSON 한 개:
{
  "decision": "approve" | "deny",
  "reasoning": "사용자 답변 요약 + 결정 근거 한국어 한 문장"
}

사용자가 "그냥 해", "OK", "응" 등 동의 → approve
사용자가 "안 돼", "ㄴㄴ", "그만" 등 거부 → deny
조건 답변 ("Y는 빼고 해", "A 먼저 확인") → 의도를 reasoning에 적고 decision 결정 (확실치 않으면 deny가 안전)"#;
const SUMMARY_SYSTEM: &str = r#"너는 개발 관제 대시보드의 상태 요약기다. AI 코딩 에이전트가 돌아가는 터미널 출력의 마지막 부분을 받는다.
에이전트가 지금 무슨 작업을 하는 중인지 한국어 한 문장, 40자 이내로 요약해라.
파일명·기능명·에러명 같은 구체 맥락을 담고 "~중" 으로 끝내라 (예: "결제 라우트 테스트 실패 원인 수정 중").
판단할 맥락이 없으면 "대기 중" 이라고만 해라. 요약 문장만 출력하고 따옴표·마크다운·설명 금지."#;

fn truthy_or<'a>(a: &'a V, b: &'a V) -> &'a V {
    if a.truthy() {
        a
    } else {
        b
    }
}
fn chosen(event: &V, first: &str, second: &str, default: V) -> V {
    let value = truthy_or(&event[first], &event[second]);
    if value.truthy() {
        value.clone()
    } else {
        default
    }
}
fn compiled(source: &[(&str, &str)]) -> Vec<regress::Regex> {
    source
        .iter()
        .map(|(pattern, flags)| {
            regress::Regex::with_flags(pattern, *flags).expect("static supervisor policy regex")
        })
        .collect()
}
fn matched(regex: &regress::Regex, value: &V) -> bool {
    let text = js_string(value);
    regex.find_from_ucs2(text.units(), 0).next().is_some()
}
fn js_string(value: &V) -> V {
    match value {
        V::String(_) => value.clone(),
        V::Number(n) if *n == 0.0 => "0".into(),
        V::Number(n) if n.is_finite() && (n.abs() >= 1e21 || n.abs() < 1e-6) => {
            let scientific = format!("{n:e}");
            let (digits, exponent) = scientific.split_once('e').unwrap();
            let exponent: i32 = exponent.parse().unwrap();
            format!("{digits}e{exponent:+}").into()
        }
        V::Array(values) => {
            let mut units = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    units.push(44);
                }
                if *value != V::Null {
                    units.extend_from_slice(js_string(value).units());
                }
            }
            V::String(units)
        }
        _ => value.text().into(),
    }
}
fn rule(event: &V) -> V {
    static PATHS: OnceLock<Vec<regress::Regex>> = OnceLock::new();
    static COMMANDS: OnceLock<Vec<regress::Regex>> = OnceLock::new();
    static SAFE: OnceLock<regress::Regex> = OnceLock::new();
    let tool = chosen(event, "tool_name", "tool", "Unknown".into());
    let input = chosen(event, "tool_input", "input", V::object());
    let decision = |decision: &str, confidence: f64, reasoning: V, policy: &str| {
        object([
            ("decision", decision.into()),
            ("confidence", confidence.into()),
            ("reasoning", reasoning),
            ("policy", policy.into()),
        ])
    };
    if [
        "Read",
        "Glob",
        "Grep",
        "NotebookRead",
        "WebFetch",
        "WebSearch",
        "TodoWrite",
        "AskUserQuestion",
    ]
    .iter()
    .any(|t| tool == V::from(*t))
    {
        return decision(
            "approve",
            0.99,
            format!("{} is read-only/safe", tool.text()).into(),
            "safelist",
        );
    }
    if ["Edit", "Write", "MultiEdit", "NotebookEdit"]
        .iter()
        .any(|t| tool == V::from(*t))
    {
        let path = chosen(&input, "file_path", "notebook_path", "".into());
        if path.truthy()
            && PATHS
                .get_or_init(|| compiled(DANGER_PATHS))
                .iter()
                .any(|r| matched(r, &path))
        {
            let mut reasoning: Vec<u16> = "dangerous path: ".encode_utf16().collect();
            reasoning.extend_from_slice(js_string(&path).units());
            return decision("block", 0.99, V::String(reasoning), "danger-path");
        }
        return decision(
            "approve",
            0.95,
            format!("{} on safe path", tool.text()).into(),
            "safelist",
        );
    }
    if tool == V::from("Bash") {
        let command = if input["command"].truthy() {
            input["command"].clone()
        } else {
            "".into()
        };
        for (i, regex) in COMMANDS
            .get_or_init(|| compiled(DANGER_PATTERNS))
            .iter()
            .enumerate()
        {
            if matched(regex, &command) {
                let (source, flags) = DANGER_PATTERNS[i];
                return decision(
                    "block",
                    0.99,
                    format!("danger pattern: /{source}/{flags}").into(),
                    "blacklist",
                );
            }
        }
        if matched(
            SAFE.get_or_init(|| regress::Regex::new(SAFE_BASH).unwrap()),
            &command,
        ) {
            return decision("approve", 0.9, "common safe bash".into(), "safelist");
        }
    }
    decision("unsure", 0.0, "no rule matched".into(), "rule-fallthrough")
}
fn merge(target: &mut V, extra: &V) {
    if let V::Object(fields) = extra {
        for (key, value) in fields {
            target[key] = value.clone();
        }
    }
}
fn parse_json(text: &str) -> Option<V> {
    static CODE: OnceLock<regex::Regex> = OnceLock::new();
    let captures = CODE
        .get_or_init(|| regex::Regex::new(r"```(?:json)?\s*([\s\S]*?)```").unwrap())
        .captures(text);
    let candidate = captures
        .as_ref()
        .and_then(|c| c.get(1))
        .map_or(text, |m| m.as_str());
    let start = candidate.find('{')?;
    let end = candidate.rfind('}')?;
    if start > end {
        return None;
    }
    let raw = serde_json::value::RawValue::from_string(candidate[start..=end].into()).ok()?;
    V::parse(&raw).ok()
}
fn pretty(value: &V, limit: usize) -> V {
    fn json(value: &V, depth: usize) -> String {
        let indent = "  ".repeat(depth + 1);
        let close_indent = "  ".repeat(depth);
        match value {
            V::Array(values) if !values.is_empty() => format!(
                "[\n{indent}{}\n{close_indent}]",
                values
                    .iter()
                    .map(|value| json(value, depth + 1))
                    .collect::<Vec<_>>()
                    .join(&format!(",\n{indent}"))
            ),
            V::Object(fields) if !fields.is_empty() => format!(
                "{{\n{indent}{}\n{close_indent}}}",
                fields
                    .iter()
                    .map(|(key, value)| format!(
                        "{}: {}",
                        V::from(key.clone()).raw().get(),
                        json(value, depth + 1)
                    ))
                    .collect::<Vec<_>>()
                    .join(&format!(",\n{indent}"))
            ),
            V::Number(number) if number.is_finite() => js_string(value).text(),
            _ => value.raw().get().into(),
        }
    }
    V::from(json(value, 0)).cut(limit)
}
fn pretty_raw(value: &serde_json::value::RawValue) -> Option<V> {
    struct Fields(Vec<(String, Box<serde_json::value::RawValue>)>);
    impl<'de> serde::Deserialize<'de> for Fields {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Fields;
                fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                    formatter.write_str("an ordered JSON object")
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> Result<Fields, A::Error> {
                    let mut fields: Vec<(String, Box<serde_json::value::RawValue>)> = Vec::new();
                    while let Some((key, value)) =
                        map.next_entry::<String, Box<serde_json::value::RawValue>>()?
                    {
                        if let Some((_, previous)) =
                            fields.iter_mut().find(|(existing, _)| *existing == key)
                        {
                            *previous = value;
                        } else {
                            fields.push((key, value));
                        }
                    }
                    Ok(Fields(fields))
                }
            }
            deserializer.deserialize_map(Visitor)
        }
    }
    fn array_index(key: &str) -> Option<u32> {
        key.parse::<u32>()
            .ok()
            .filter(|value| *value != u32::MAX && value.to_string() == key)
    }
    fn json(raw: &serde_json::value::RawValue, depth: usize) -> Option<String> {
        let indent = "  ".repeat(depth + 1);
        let close_indent = "  ".repeat(depth);
        match raw.get().trim_start().as_bytes().first() {
            Some(b'{') => {
                let Fields(mut fields) = serde_json::from_str::<Fields>(raw.get()).ok()?;
                // JavaScript enumerates array-index keys numerically, followed
                // by other keys in their original insertion order.
                fields.sort_by(|(a, _), (b, _)| match (array_index(a), array_index(b)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    _ => std::cmp::Ordering::Equal,
                });
                if fields.is_empty() {
                    return Some("{}".into());
                }
                let contents = fields
                    .into_iter()
                    .map(|(key, value)| {
                        Some(format!(
                            "{}: {}",
                            V::from(key).raw().get(),
                            json(&value, depth + 1)?
                        ))
                    })
                    .collect::<Option<Vec<_>>>()?;
                Some(format!(
                    "{{\n{indent}{}\n{close_indent}}}",
                    contents.join(&format!(",\n{indent}"))
                ))
            }
            Some(b'[') => {
                let values =
                    serde_json::from_str::<Vec<Box<serde_json::value::RawValue>>>(raw.get())
                        .ok()?;
                if values.is_empty() {
                    return Some("[]".into());
                }
                let contents = values
                    .iter()
                    .map(|value| json(value, depth + 1))
                    .collect::<Option<Vec<_>>>()?;
                Some(format!(
                    "[\n{indent}{}\n{close_indent}]",
                    contents.join(&format!(",\n{indent}"))
                ))
            }
            _ => Some(pretty(&V::parse(raw).ok()?, usize::MAX).text()),
        }
    }
    json(value, 0).map(V::from)
}
fn concat(parts: &[V]) -> V {
    V::String(
        parts
            .iter()
            .flat_map(|part| part.units().iter().copied())
            .collect(),
    )
}
fn compact(value: &V, limit: usize) -> V {
    // ECMAScript whitespace includes BOM and excludes several Unicode controls.
    let space = |c: u16| matches!(c, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff);
    let mut out = vec![];
    let mut pending = false;
    for unit in value.units() {
        if space(*unit) {
            pending = !out.is_empty();
        } else {
            if pending {
                out.push(32);
                pending = false;
            }
            out.push(*unit);
        }
    }
    V::String(out).cut(limit)
}
fn now() -> i64 {
    crate::account_usage::now()
}
fn invalid() -> io::Error {
    io::Error::other("Invalid supervisor decision storage")
}

#[derive(Clone)]
struct Summary {
    text: V,
    at: i64,
    mark: u64,
    pending: bool,
    generation: u64,
}
#[derive(Default)]
struct State {
    away: bool,
    events: Vec<(V, V)>,
    contexts: Vec<(String, V, i64)>,
    summaries: Vec<(String, Summary)>,
    summary_generation: u64,
    notifications: Vec<(V, i64)>,
    counts: Vec<(V, u64, i64)>,
}
pub struct Store {
    directory: PathBuf,
    ai: Arc<ai_config::Store>,
    key: Mutex<Option<String>>,
    state: Mutex<State>,
    writes: Mutex<()>,
    channel: Mutex<Option<Arc<dyn HumanChannel>>>,
    cancel: Cancel,
}
impl Store {
    pub fn new(directory: PathBuf, ai: Arc<ai_config::Store>) -> Arc<Self> {
        let key = ai.key().ok().flatten();
        Arc::new(Self {
            directory,
            ai,
            key: Mutex::new(key),
            state: Mutex::new(State::default()),
            writes: Mutex::new(()),
            channel: Mutex::new(None),
            cancel: Cancel::default(),
        })
    }
    pub fn set_channel(&self, channel: Option<Arc<dyn HumanChannel>>) {
        *self.channel.lock().unwrap() = channel;
    }
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
    pub fn mode(&self) -> &'static str {
        if self.state.lock().unwrap().away {
            "away"
        } else {
            "here"
        }
    }
    pub fn set_mode(&self, mode: &str) -> &'static str {
        self.state.lock().unwrap().away = mode == "away";
        self.mode()
    }
    pub fn is_ready(&self) -> bool {
        self.key.lock().unwrap().is_some()
    }
    pub fn refresh_client(&self) -> bool {
        *self.key.lock().unwrap() = self.ai.key().ok().flatten();
        self.is_ready()
    }
    fn channel(&self) -> Option<Arc<dyn HumanChannel>> {
        self.channel.lock().unwrap().clone()
    }
    fn checked_log(&self) -> io::Result<PathBuf> {
        let path = self.directory.join("logs/decisions.jsonl");
        if !crate::account_hub::safe_path(&self.directory, &path) {
            return Err(invalid());
        }
        match fs::symlink_metadata(&path) {
            Ok(meta) if !meta.is_file() => Err(invalid()),
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(path),
        }
    }
    fn read_log(&self) -> io::Result<Vec<u8>> {
        let path = self.checked_log()?;
        match fs::read(path) {
            Ok(bytes) => Ok(bytes),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e),
        }
    }
    fn log(&self, record: &V) -> io::Result<()> {
        let _guard = self.writes.lock().unwrap();
        let path = self.checked_log()?;
        let parent = path.parent().ok_or_else(invalid)?;
        fs::create_dir_all(parent)?;
        let mut options = fs::OpenOptions::new();
        options.create(true).read(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        self.checked_log()?;
        let mut file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(invalid());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        // Append a single record without reading or rewriting historical data.
        // A malformed legacy tail remains byte-for-byte and gets a separator.
        let mut bytes = Vec::new();
        if metadata.len() != 0 {
            file.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            file.read_exact(&mut last)?;
            if last[0] != b'\n' {
                bytes.push(b'\n');
            }
        }
        bytes.extend_from_slice(record.raw().get().as_bytes());
        bytes.push(b'\n');
        file.write_all(&bytes)
    }
    pub fn recent(&self, n: i64) -> io::Result<V> {
        let _guard = self.writes.lock().unwrap();
        let bytes = self.read_log()?;
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<_> = text.split('\n').filter(|s| !s.is_empty()).collect();
        let start = if n > 0 {
            lines.len().saturating_sub(n as usize)
        } else {
            n.unsigned_abs().min(lines.len() as u64) as usize
        };
        Ok(V::Array(
            lines[start..]
                .iter()
                .filter_map(|line| {
                    let raw = serde_json::value::RawValue::from_string((*line).into()).ok()?;
                    V::parse(&raw).ok().filter(V::truthy)
                })
                .collect(),
        ))
    }
    async fn gemini(&self, system: &str, prompt: &str, timeout: Duration) -> Option<String> {
        self.gemini_utf16(system, &prompt.into(), timeout).await
    }
    async fn gemini_utf16(&self, system: &str, prompt: &V, timeout: Duration) -> Option<String> {
        if !self.is_ready() {
            self.refresh_client();
        }
        let key = self.key.lock().unwrap().clone()?;
        let options = GeminiOptions {
            system_prompt: Some(system.into()),
            timeout,
            ..Default::default()
        };
        ai_transport::gemini_utf16(&key, prompt, &options, &self.cancel, |_| {})
            .await
            .ok()
    }
    async fn decide_llm(&self, record: &V) -> Option<V> {
        let tool = if record["tool"].truthy() {
            js_string(&record["tool"])
        } else {
            "?".into()
        };
        let input = if record["input"].truthy() {
            record["input"].clone()
        } else {
            V::object()
        };
        let session = if record["sessionId"].truthy() {
            concat(&["\n세션: ".into(), js_string(&record["sessionId"])])
        } else {
            "".into()
        };
        let prompt = concat(&[
            "도구: ".into(),
            tool,
            session,
            "\n\n입력:\n".into(),
            if record["__inputJson"].is_string() {
                record["__inputJson"].cut(1500)
            } else {
                pretty(&input, 1500)
            },
            "\n\n결정 JSON으로 응답.".into(),
        ]);
        parse_json(
            &self
                .gemini_utf16(DECIDE_SYSTEM, &prompt, Duration::from_secs(25))
                .await?,
        )
    }
    async fn resolve_llm(&self, record: &V, question: &str, answer: &str) -> Option<V> {
        let tool = if record["tool"].truthy() {
            js_string(&record["tool"])
        } else {
            "?".into()
        };
        let input = if record["input"].truthy() {
            record["input"].clone()
        } else {
            V::object()
        };
        let prompt = concat(&[
            "원래 도구: ".into(),
            tool,
            "\n입력: ".into(),
            if record["__inputJson"].is_string() {
                record["__inputJson"].cut(800)
            } else {
                pretty(&input, 800)
            },
            "\n\n내가 사용자에게 물어본 것:\n".into(),
            question.into(),
            "\n\n사용자 답변:\n".into(),
            answer.into(),
            "\n\n최종 결정 JSON.".into(),
        ]);
        parse_json(
            &self
                .gemini_utf16(RESOLVE_SYSTEM, &prompt, Duration::from_secs(15))
                .await?,
        )
    }
    async fn ask_human(&self, mut record: V) -> V {
        let Some(channel) = self.channel() else {
            record["decision"] = "deny".into();
            record["reasoning"] = "no human channel — deny".into();
            record["policy"] = "no-channel".into();
            return record;
        };
        let message = chosen(
            &record,
            "askMessage",
            "reasoning",
            "결정이 필요해요. 어떻게 할까요?".into(),
        )
        .text();
        let id = format!("{:08x}", rand::random::<u32>());
        let reply = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => None,
            result = tokio::time::timeout(Duration::from_secs(100), channel.ask_text(id, message.clone(), record.clone())) => result.ok().and_then(Result::ok).flatten(),
        };
        let Some(answer) = reply else {
            record["decision"] = "deny".into();
            record["reasoning"] = "no human answer in 100s".into();
            record["policy"] = "timeout-deny".into();
            return record;
        };
        let result = self.resolve_llm(&record, &message, &answer).await;
        let (decision, reasoning, policy, notification) = if let Some(result) = result {
            let decision = if result["decision"] == V::from("approve") {
                "approve"
            } else {
                "deny"
            };
            let notification = format!(
                "결정: {}\n사유: {}",
                if decision == "approve" {
                    "✅ 진행"
                } else {
                    "❌ 중단"
                },
                if result.has("reasoning") {
                    result["reasoning"].text()
                } else {
                    "undefined".into()
                }
            );
            (
                decision,
                result["reasoning"].clone(),
                "llm-resolved",
                notification,
            )
        } else {
            static YES: OnceLock<regress::Regex> = OnceLock::new();
            let answer = V::from(answer.to_lowercase()).trim();
            let yes = answer == V::from("y")
                || matched(
                    YES.get_or_init(|| {
                        regress::Regex::new(r"\b(yes|ok|응|네|그래|진행|해|hae|go|approve|승인)\b")
                            .unwrap()
                    }),
                    &answer,
                );
            let decision = if yes { "approve" } else { "deny" };
            (
                decision,
                format!("keyword fallback: {}", answer.cut(80).text()).into(),
                "keyword-fallback",
                format!(
                    "결정: {} (LLM 해석 실패, 단어 매칭)",
                    if yes { "✅ 진행" } else { "❌ 중단" }
                ),
            )
        };
        let _ = channel.send_message(notification, V::object()).await;
        record["decision"] = decision.into();
        record["reasoning"] = reasoning;
        record["policy"] = policy.into();
        record["userAnswer"] = answer.into();
        record
    }
    pub async fn decide(&self, event: &V) -> V {
        self.decide_with_raw(event, None).await
    }
    async fn decide_with_raw(
        &self,
        event: &V,
        raw_input: Option<&serde_json::value::RawValue>,
    ) -> V {
        let mut record = object([
            ("ts", crate::account_usage::iso(now()).into()),
            ("tool", chosen(event, "tool_name", "tool", V::Null)),
            ("input", chosen(event, "tool_input", "input", V::Null)),
            (
                "sessionId",
                if event["session_id"].truthy() {
                    event["session_id"].clone()
                } else {
                    V::Null
                },
            ),
            (
                "cwd",
                if event["cwd"].truthy() {
                    event["cwd"].clone()
                } else {
                    V::Null
                },
            ),
        ]);
        if record["input"].truthy() {
            if let Some(input) = raw_input.and_then(pretty_raw) {
                record["__inputJson"] = input;
            }
        }
        let ruled = rule(event);
        if matches!(ruled["decision"].text().as_str(), "approve" | "block") {
            merge(&mut record, &ruled);
        } else {
            if self.is_ready() {
                if let Some(result) = self.decide_llm(&record).await {
                    if result.has("decision") {
                        record["decision"] = result["decision"].clone();
                    }
                    record["confidence"] = if result["confidence"] == V::Null {
                        0.5.into()
                    } else {
                        result["confidence"].clone()
                    };
                    record["reasoning"] = if result["reasoning"].truthy() {
                        result["reasoning"].clone()
                    } else {
                        "llm decided".into()
                    };
                    record["askMessage"] = if result["ask_message"].truthy() {
                        result["ask_message"].clone()
                    } else {
                        V::Null
                    };
                    record["policy"] = "llm".into();
                } else {
                    merge(
                        &mut record,
                        &object([
                            ("decision", "deny".into()),
                            ("reasoning", "LLM unavailable, conservative deny".into()),
                            ("policy", "llm-fail-deny".into()),
                        ]),
                    );
                }
            } else {
                merge(
                    &mut record,
                    &object([
                        ("decision", "deny".into()),
                        ("reasoning", "no LLM, no rule match".into()),
                        ("policy", "no-llm".into()),
                    ]),
                );
            }
            if record["decision"] == V::from("ask") {
                if self.mode() == "away" {
                    record = self.ask_human(record).await;
                } else {
                    record["policy"] = "here-passthrough".into();
                    record["reasoning"] = concat(&[
                        js_string(&record["reasoning"]),
                        " (HERE: 화면 프롬프트로 위임)".into(),
                    ])
                    .trim();
                }
                record["ts"] = crate::account_usage::iso(now()).into();
            }
        }
        record.remove("__inputJson");
        if self.log(&record).is_err() {
            eprintln!("supervisor: decision log write failed");
        }
        if record["decision"] == V::from("block") || record["decision"] == V::from("deny") {
            if let Some(channel) = self.channel() {
                let cloned = record.clone();
                tokio::spawn(async move {
                    let _ = channel.notify_decision(cloned).await;
                });
            }
        }
        let decision =
            if record["decision"] == V::from("deny") || record["decision"] == V::from("block") {
                "block"
            } else if record["decision"] == V::from("approve") {
                "approve"
            } else {
                "ask"
            };
        let mut result = object([
            ("decision", decision.into()),
            ("policy", record["policy"].clone()),
            (
                "userAnswer",
                if record["userAnswer"].truthy() {
                    record["userAnswer"].clone()
                } else {
                    V::Null
                },
            ),
        ]);
        for key in ["confidence", "reasoning"] {
            if record.has(key) {
                result[key] = record[key].clone();
            }
        }
        result
    }
    pub async fn summarize_activity(&self, terminal_text: &str, timeout: Duration) -> Option<V> {
        if let Some(text) = self.gemini(SUMMARY_SYSTEM, terminal_text, timeout).await {
            let result = compact(&text.into(), 80);
            if result.truthy() {
                return Some(result);
            }
        }
        if self.cancel.is_cancelled() {
            return None;
        }
        let prompt = format!("{SUMMARY_SYSTEM}\n\n최근 터미널 출력:\n{terminal_text}");
        let output = ai_transport::claude_summary(&prompt, timeout, &self.cancel)
            .await
            .ok()?;
        let result = compact(&output.into(), 80);
        result.truthy().then_some(result)
    }
    pub fn summary_gate(&self, term_id: &str, mark: u64, now: i64, min_interval_ms: i64) -> bool {
        let state = self.state.lock().unwrap();
        let Some((_, summary)) = state.summaries.iter().find(|(key, _)| key == term_id) else {
            return true;
        };
        !(summary.pending && now - summary.at < 60_000)
            && summary.mark != mark
            && now - summary.at >= min_interval_ms
    }
    pub fn begin_summary(&self, term_id: &str, mark: u64, now: i64) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.summary_generation = state.summary_generation.wrapping_add(1);
        let generation = state.summary_generation;
        if let Some((_, summary)) = state.summaries.iter_mut().find(|(key, _)| key == term_id) {
            summary.mark = mark;
            summary.at = now;
            summary.pending = true;
            summary.generation = generation;
        } else {
            state.summaries.push((
                term_id.into(),
                Summary {
                    text: V::Null,
                    mark,
                    pending: true,
                    at: now,
                    generation,
                },
            ));
        }
        generation
    }
    /// A timeout retry or SessionStart can replace a summary while its model
    /// request is still running. Only the request that began this generation
    /// may finish it; stale responses must not change text, time or pending.
    pub fn end_summary_if_current(
        &self,
        term_id: &str,
        generation: u64,
        text: Option<V>,
        now: i64,
    ) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some((_, summary)) = state.summaries.iter_mut().find(|(key, _)| key == term_id) else {
            return false;
        };
        if summary.generation != generation {
            return false;
        }
        if let Some(text) = text.filter(V::truthy) {
            summary.text = text;
        }
        summary.pending = false;
        summary.at = now;
        true
    }
    #[cfg(test)]
    pub fn end_summary(&self, term_id: &str, text: Option<V>, now: i64) {
        let mut state = self.state.lock().unwrap();
        if let Some((_, summary)) = state.summaries.iter_mut().find(|(key, _)| key == term_id) {
            if let Some(text) = text.filter(V::truthy) {
                summary.text = text;
            }
            summary.pending = false;
            summary.at = now;
        }
    }
    pub fn record_agent_event(&self, event: &V, now: i64) -> Option<V> {
        let session = if event["session_id"].truthy() {
            event["session_id"].clone()
        } else {
            V::Null
        };
        let term = if event["term_id"].truthy() {
            event["term_id"].clone()
        } else {
            V::Null
        };
        if !session.truthy() && !term.truthy() {
            return None;
        }
        let key = truthy_or(&term, &session).clone();
        let kind = chosen(event, "hook_event_name", "type", "Event".into());
        let mut state = self.state.lock().unwrap();
        if kind == V::from("SessionStart") {
            state.contexts.retain(|(k, _, _)| *k != key.text());
            state.summaries.retain(|(k, _)| *k != key.text());
        }
        if kind == V::from("UserPromptSubmit") {
            let value = if event["prompt"] != V::Null {
                &event["prompt"]
            } else if event["message"] != V::Null {
                &event["message"]
            } else {
                &event["input"]["prompt"]
            };
            let prompt = compact(value, 240);
            if prompt.truthy() {
                if let Some((_, goal, at)) =
                    state.contexts.iter_mut().find(|(k, _, _)| *k == key.text())
                {
                    if !goal.truthy() {
                        *goal = prompt;
                    }
                    *at = now;
                } else {
                    state.contexts.push((key.text(), prompt, now));
                }
            }
        }
        let status = match kind.text().as_str() {
            "PermissionRequest" | "Notification" => "waiting",
            "Stop" | "SessionEnd" => "done",
            "SessionStart" | "TeammateIdle" => "idle",
            _ => "busy",
        };
        let record = object([
            ("sessionId", session),
            ("termId", term),
            ("type", kind),
            ("state", status.into()),
            (
                "kind",
                if event["agent_kind"].truthy() {
                    event["agent_kind"].clone()
                } else {
                    V::Null
                },
            ),
            (
                "cwd",
                if event["cwd"].truthy() {
                    event["cwd"].clone()
                } else {
                    V::Null
                },
            ),
            (
                "reason",
                if event["tool_input"]["description"].truthy() {
                    event["tool_input"]["description"].clone()
                } else {
                    chosen(event, "message", "tool_name", V::Null)
                },
            ),
            ("updatedAt", (now as f64).into()),
        ]);
        if let Some((_, old)) = state.events.iter_mut().find(|(k, _)| *k == key) {
            *old = record.clone();
        } else {
            state.events.push((key, record.clone()));
        }
        Some(record)
    }
    pub fn agent_events(&self, now: i64) -> V {
        let mut state = self.state.lock().unwrap();
        state
            .events
            .retain(|(_, event)| now - event["updatedAt"].number() as i64 <= 86_400_000);
        V::Array(state.events.iter().map(|(_, v)| v.clone()).collect())
    }
    pub fn summaries(&self, now: i64) -> V {
        let mut state = self.state.lock().unwrap();
        state
            .summaries
            .retain(|(_, summary)| now - summary.at <= 1_800_000);
        state.contexts.retain(|(_, _, at)| now - *at <= 86_400_000);
        let mut result = V::object();
        for (key, summary) in &state.summaries {
            if summary.text.truthy() {
                result[key] = object([
                    ("text", summary.text.clone()),
                    ("goal", V::Null),
                    ("at", (summary.at.max(0) as f64).into()),
                ]);
            }
        }
        for (key, goal, at) in &state.contexts {
            let summary = state
                .summaries
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, s)| s);
            result[key] = object([
                ("text", summary.map(|s| s.text.clone()).unwrap_or(V::Null)),
                ("goal", goal.clone()),
                ("at", ((*at).max(summary.map_or(0, |s| s.at)) as f64).into()),
            ]);
        }
        result
    }
    pub fn bump_tool_use(&self, session_id: &V, now: i64) {
        if !session_id.truthy() {
            return;
        }
        let mut state = self.state.lock().unwrap();
        if let Some((_, count, _)) = state
            .counts
            .iter_mut()
            .find(|(key, _, _)| key == session_id)
        {
            *count += 1;
        } else {
            state.counts.push((session_id.clone(), 1, now));
        }
    }
    pub async fn notify_event(&self, event: &V) {
        let now = now();
        self.record_agent_event(event, now);
        let kind = chosen(event, "hook_event_name", "type", "Event".into()).text();
        let session = if event["session_id"].truthy() {
            event["session_id"].clone()
        } else {
            V::Null
        };
        {
            let mut state = self.state.lock().unwrap();
            match kind.as_str() {
                "UserPromptSubmit" | "PreCompact" => return,
                "SessionStart" => {
                    state.counts.retain(|(key, _, _)| *key != session);
                    state.counts.push((session, 0, now));
                    return;
                }
                "Stop" | "SubagentStop" => {
                    state.counts.retain(|(key, _, _)| *key != session);
                    state.notifications.retain(|(key, _)| *key != session);
                    return;
                }
                "Notification" => {
                    if !state.away {
                        return;
                    }
                    if let Some((_, at)) = state
                        .notifications
                        .iter_mut()
                        .find(|(key, _)| *key == session)
                    {
                        if now - *at < 900_000 {
                            return;
                        }
                        *at = now;
                    } else {
                        state.notifications.push((session.clone(), now));
                    }
                }
                _ => {}
            }
        }
        let Some(channel) = self.channel() else {
            return;
        };
        let cwd = event["cwd"].text();
        let project = if event["cwd"].truthy() {
            cwd.split('/').filter(|s| !s.is_empty()).next_back()
        } else {
            None
        };
        let header_session = if session.truthy() {
            format!(" · <code>{}</code>", session.cut(8).text())
        } else {
            String::new()
        };
        let header = if let Some(project) = project {
            format!("\n📂 {project}{header_session}")
        } else if !header_session.is_empty() {
            format!("\n{header_session}")
        } else {
            String::new()
        };
        let emoji = match kind.as_str() {
            "Notification" => "🔔",
            _ => "•",
        };
        let body = if kind == "Notification" {
            let text = if event["message"].truthy() {
                V::from(event["message"].text()).cut(280).text()
            } else {
                String::new()
            };
            if text.is_empty() {
                text
            } else {
                format!("\n{}", escape(&text))
            }
        } else {
            String::new()
        };
        let text = format!("{emoji} <b>{}</b>{header}{body}", escape(&kind));
        let _ = channel
            .send_message(
                text,
                object([
                    ("parseMode", "HTML".into()),
                    ("silent", (kind != "Notification").into()),
                ]),
            )
            .await;
    }
    pub async fn handle(
        &self,
        method: &Method,
        path: &str,
        query: &str,
        input: &V,
        raw_input: Option<&serde_json::value::RawValue>,
    ) -> Response {
        if method == Method::POST && *input == V::Null {
            let key = if path == "/api/supervisor/decide" {
                "tool_name"
            } else {
                "session_id"
            };
            return crate::error(
                500,
                &format!("Cannot read properties of null (reading '{key}')"),
            );
        }
        let value = match (method.as_str(), path) {
            ("POST", "/api/supervisor/decide") => self.decide_with_raw(input, raw_input).await,
            ("POST", "/api/supervisor/event") => {
                // Node records activity before formatting notification context.
                // Keep that side effect even when malformed context then fails.
                let context_error = if input["cwd"].truthy() && !input["cwd"].is_string() {
                    Some("cwd.split is not a function")
                } else if input["session_id"].truthy()
                    && !input["session_id"].is_string()
                    && !input["session_id"].is_array()
                {
                    Some("sessionId.slice is not a function")
                } else {
                    None
                };
                if let Some(message) = context_error {
                    self.record_agent_event(input, now());
                    return crate::error(500, message);
                }
                self.notify_event(input).await;
                object([("ok", true.into())])
            }
            ("GET", "/api/supervisor/recent") => {
                let n = url::form_urlencoded::parse(query.as_bytes())
                    .filter(|(key, _)| key == "n")
                    .last()
                    .map(|(_, value)| parse_n(&value))
                    .unwrap_or(20);
                match self.recent(n) {
                    Ok(value) => value,
                    Err(_) => {
                        return crate::error(500, "Supervisor decision storage operation failed")
                    }
                }
            }
            // Original status counts legacy inline-button requests only. The
            // current natural-language flow does not populate that collection.
            ("GET", "/api/supervisor/status") => object([("pending", 0.0.into())]),
            ("GET", "/api/supervisor/agents") => self.agent_events(now()),
            ("GET", "/api/supervisor/summaries") => self.summaries(now()),
            _ => return crate::error(404, "Not found"),
        };
        Json(value.raw()).into_response()
    }
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn parse_n(value: &str) -> i64 {
    let text = V::from(value).trim().text();
    let negative = text.starts_with('-');
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(&text);
    let digits: String = unsigned.chars().take_while(char::is_ascii_digit).collect();
    let value = digits
        .parse::<u64>()
        .unwrap_or(if digits.is_empty() {
            0
        } else {
            i64::MAX as u64
        })
        .min(i64::MAX as u64) as i64;
    if value == 0 {
        20
    } else if negative {
        -value
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store(directory: &std::path::Path) -> Arc<Store> {
        Store::new(
            directory.into(),
            Arc::new(ai_config::Store::new(directory.into())),
        )
    }
    fn event(tool: &str, input: V) -> V {
        object([("tool_name", tool.into()), ("tool_input", input)])
    }

    #[test]
    fn original_rules_preserve_force_with_lease_lookahead_and_javascript_boundaries() {
        for (command, decision, policy) in [
            ("git push --force", "block", "blacklist"),
            ("git push --force-with-lease", "unsure", "rule-fallthrough"),
            (
                "git push --force-with-lease --force",
                "unsure",
                "rule-fallthrough",
            ),
            ("git status && npm publish", "block", "blacklist"),
            ("iptables -A INPUT -j drop", "block", "blacklist"),
            ("DELETE FROM users;", "block", "blacklist"),
            ("DELETE FROM users WHERE id=1", "unsure", "rule-fallthrough"),
            ("git status", "approve", "safelist"),
            ("éshutdown", "block", "blacklist"),
            ("npm install local-package", "unsure", "rule-fallthrough"),
        ] {
            let result = rule(&event("Bash", object([("command", command.into())])));
            assert_eq!(result["decision"], V::from(decision), "{command}");
            assert_eq!(result["policy"], V::from(policy), "{command}");
        }
        assert_eq!(
            rule(&event(
                "Bash",
                object([("command", "git push --force".into())])
            ))["reasoning"],
            V::from(r"danger pattern: /\bgit\s+push\s+--force(?!-with-lease)/")
        );
        for path in [
            "/etc/passwd",
            "/project/.env",
            "/project/.env.local",
            "/home/user/.ssh/config",
            "/secret.key",
        ] {
            assert_eq!(
                rule(&event("Write", object([("file_path", path.into())])))["decision"],
                V::from("block")
            );
        }
        assert_eq!(
            rule(&event(
                "NotebookEdit",
                object([("notebook_path", "/project/readme.ipynb".into())])
            ))["confidence"],
            V::from(0.95)
        );
        for value in ["0", "invalid", "--2", "+-2", "+0xFF"] {
            assert_eq!(parse_n(value), 20);
        }
        assert_eq!(parse_n("\u{feff} -2items"), -2);
    }

    #[tokio::test]
    async fn no_llm_omits_confidence_and_logs_are_private_atomic_and_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path());
        assert!(!store.is_ready());
        let unknown = store.decide(&event("Unknown", V::object())).await;
        assert_eq!(
            unknown,
            object([
                ("decision", "block".into()),
                ("reasoning", "no LLM, no rule match".into()),
                ("policy", "no-llm".into()),
                ("userAnswer", V::Null)
            ])
        );
        let file = directory.path().join("logs/decisions.jsonl");
        let broken =
            b"{broken\n{\"fixture\":true,\"text\":\"\\ud800\"}\nfalse\nnull\n\n{unfinished";
        fs::write(&file, broken).unwrap();
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(&file).unwrap().ino()
        };
        let record = object([("preserved", true.into())]);
        store.log(&record).unwrap();
        assert!(fs::read(&file).unwrap().starts_with(broken));
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                fs::metadata(&file).unwrap().ino(),
                inode,
                "logging must append to the existing file"
            );
        }
        assert_eq!(store.recent(1).unwrap(), V::Array(vec![record.clone()]));
        assert_eq!(store.recent(0).unwrap().array().len(), 2);
        assert_eq!(store.recent(-2).unwrap(), V::Array(vec![record]));
        #[cfg(unix)]
        {
            use std::os::unix::{fs::symlink, fs::PermissionsExt};
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let outside = directory.path().join("outside.jsonl");
            fs::write(&outside, b"outside").unwrap();
            fs::remove_file(&file).unwrap();
            symlink(&outside, &file).unwrap();
            assert!(store.log(&V::object()).is_err());
            assert!(store.recent(20).is_err());
            assert_eq!(fs::read(&outside).unwrap(), b"outside");
        }
    }

    #[test]
    fn activity_goals_summary_gate_expiration_and_session_restart_match_source() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path());
        let event = |kind: &str, prompt: V| {
            object([
                ("term_id", "terminal".into()),
                ("session_id", "session".into()),
                ("type", kind.into()),
                ("prompt", prompt),
            ])
        };
        store.record_agent_event(
            &event("UserPromptSubmit", " first\n goal \u{feff}".into()),
            10,
        );
        store.record_agent_event(&event("UserPromptSubmit", "second goal".into()), 20);
        assert_eq!(
            store.summaries(20)["terminal"]["goal"],
            V::from("first goal")
        );
        assert_eq!(store.summaries(20)["terminal"]["at"], V::from(20.0));
        assert!(store.summary_gate("terminal", 1, 100, 20_000));
        store.begin_summary("terminal", 1, 100);
        assert!(!store.summary_gate("terminal", 2, 60_099, 20_000));
        assert!(store.summary_gate("terminal", 2, 60_100, 20_000));
        assert!(!store.summary_gate("terminal", 1, 100_000, 20_000));
        store.end_summary("terminal", Some("doing work".into()), 200);
        assert!(!store.summary_gate("terminal", 2, 20_199, 20_000));
        assert!(store.summary_gate("terminal", 2, 20_200, 20_000));
        store.begin_summary("terminal", 2, 30_000);
        store.end_summary("terminal", None, 30_100);
        assert_eq!(
            store.summaries(30_100)["terminal"]["text"],
            V::from("doing work")
        );
        assert_eq!(store.summaries(1_830_101)["terminal"]["text"], V::Null);
        assert!(store.summaries(86_400_021)["terminal"] == V::Null);
        store.record_agent_event(&event("Notification", V::Null), 50);
        assert_eq!(
            store.agent_events(50).array()[0]["state"],
            V::from("waiting")
        );
        store.record_agent_event(&event("Stop", V::Null), 60);
        assert_eq!(store.agent_events(60).array()[0]["state"], V::from("done"));
        assert_eq!(store.agent_events(86_400_061), V::Array(vec![]));
        store.record_agent_event(&event("UserPromptSubmit", "new goal".into()), 70);
        store.begin_summary("terminal", 3, 80);
        store.end_summary("terminal", Some("work".into()), 90);
        store.record_agent_event(&event("SessionStart", V::Null), 100);
        assert_eq!(store.summaries(100), V::object());
        assert_eq!(
            compact(&V::String(vec![32, 0xfeff, 65, 10, 66, 0xd83d, 0xde00]), 4).units(),
            &[65, 32, 66, 0xd83d]
        );
    }

    #[test]
    fn stale_summary_cannot_overwrite_a_restarted_session_or_timeout_retry() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path());
        let old = store.begin_summary("terminal", 1, 100);
        store.record_agent_event(
            &object([
                ("term_id", "terminal".into()),
                ("type", "SessionStart".into()),
            ]),
            101,
        );
        assert!(!store.end_summary_if_current("terminal", old, Some("old session".into()), 102));
        let current = store.begin_summary("terminal", 1, 103);
        assert!(!store.end_summary_if_current("terminal", old, Some("stale result".into()), 104));
        assert!(store.summaries(104).object_clone() == V::object());
        assert!(!store.summary_gate("terminal", 2, 105, 0));
        assert!(store.end_summary_if_current(
            "terminal",
            current,
            Some("current session".into()),
            106
        ));
        assert_eq!(
            store.summaries(106)["terminal"]["text"],
            V::from("current session")
        );
        let slow = store.begin_summary("terminal", 2, 200);
        assert!(store.summary_gate("terminal", 3, 60_200, 20_000));
        let retry = store.begin_summary("terminal", 3, 60_200);
        assert!(!store.end_summary_if_current(
            "terminal",
            slow,
            Some("slow old result".into()),
            60_201
        ));
        assert_eq!(
            store.summaries(60_201)["terminal"]["text"],
            V::from("current session")
        );
        assert!(!store.summary_gate("terminal", 4, 60_202, 0));
        assert!(store.end_summary_if_current(
            "terminal",
            retry,
            Some("retry result".into()),
            60_203
        ));
        assert_eq!(
            store.summaries(60_203)["terminal"]["text"],
            V::from("retry result")
        );
    }

    #[derive(Default)]
    struct FakeChannel {
        sent: Mutex<Vec<(String, V)>>,
    }
    impl HumanChannel for FakeChannel {
        fn ask_text(&self, _: String, _: String, _: V) -> ChannelFuture<Option<String>> {
            Box::pin(async { Ok(None) })
        }
        fn send_message(&self, text: String, options: V) -> ChannelFuture<()> {
            self.sent.lock().unwrap().push((text, options));
            Box::pin(async { Ok(()) })
        }
        fn notify_decision(&self, _: V) -> ChannelFuture<()> {
            Box::pin(async { Ok(()) })
        }
    }
    #[tokio::test]
    async fn human_channel_absence_never_approves_and_notification_cooldown_resets() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path());
        let ask = object([
            ("decision", "ask".into()),
            ("reasoning", "human only".into()),
        ]);
        assert_eq!(
            store.ask_human(ask.clone()).await["policy"],
            V::from("no-channel")
        );
        let channel = Arc::new(FakeChannel::default());
        store.set_channel(Some(channel.clone()));
        assert_eq!(store.ask_human(ask).await["decision"], V::from("deny"));
        let event = |kind: &str| {
            object([
                ("session_id", "1234567890".into()),
                ("cwd", "/project/fixture".into()),
                ("type", kind.into()),
                ("message", "<input> & needed".into()),
            ])
        };
        store.notify_event(&event("Notification")).await;
        assert!(channel.sent.lock().unwrap().is_empty());
        store.set_mode("away");
        store.notify_event(&event("Notification")).await;
        store.notify_event(&event("Notification")).await;
        assert_eq!(channel.sent.lock().unwrap().len(), 1);
        assert_eq!(channel.sent.lock().unwrap()[0], ("🔔 <b>Notification</b>\n📂 fixture · <code>12345678</code>\n&lt;input&gt; &amp; needed".into(), object([("parseMode", "HTML".into()), ("silent", false.into())])));
        store.notify_event(&event("Stop")).await;
        store.notify_event(&event("Notification")).await;
        assert_eq!(channel.sent.lock().unwrap().len(), 2);
        assert_eq!(store.set_mode("invalid"), "here");
    }

    #[test]
    fn model_json_fences_and_invalid_outputs_match_original() {
        assert_eq!(
            parse_json("prefix ```json\n{\"decision\":\"ask\",\"reasoning\":\"한글\"}\n``` tail")
                .unwrap()["decision"],
            V::from("ask")
        );
        assert!(parse_json("before {bad} after").is_none());
        assert!(parse_json("{} {}").is_none());
        assert!(parse_json("```nonsense``` {\"decision\":\"approve\"}").is_none());
        assert_eq!(parse_json("[{}]"), Some(V::object()));
    }

    #[tokio::test]
    async fn model_input_keeps_json_order_numeric_keys_and_utf16_budget_without_private_log_fields()
    {
        let raw = serde_json::value::RawValue::from_string(r#"{"z":"first","10":"ten","2":"two","a":{"z":1,"a":"\ud800"},"z":"last","01":"non-index"}"#.into()).unwrap();
        assert_eq!(pretty_raw(&raw).unwrap().text(), "{\n  \"2\": \"two\",\n  \"10\": \"ten\",\n  \"z\": \"last\",\n  \"a\": {\n    \"z\": 1,\n    \"a\": \"\\ud800\"\n  },\n  \"01\": \"non-index\"\n}");
        let raw = serde_json::value::RawValue::from_string(format!(
            r#"{{"url":"https://fixture.invalid","body":"{}"}}"#,
            "B".repeat(2000)
        ))
        .unwrap();
        let ordered = pretty_raw(&raw).unwrap().cut(1500);
        assert!(ordered
            .text()
            .starts_with("{\n  \"url\": \"https://fixture.invalid\",\n  \"body\":"));
        assert_eq!(ordered.units().len(), 1500);
        let text = V::String([vec![65; 1499], vec![0xd83d, 0xde00]].concat());
        let prompt = concat(&["prefix".into(), text.cut(1500), "suffix".into()]);
        assert_eq!(prompt.units()[6 + 1499], 0xd83d);
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path());
        store
            .decide_with_raw(&event("Read", V::parse(&raw).unwrap()), Some(&raw))
            .await;
        let recent = store.recent(1).unwrap();
        assert!(!recent.array()[0].has("__inputJson"));
        assert_eq!(
            recent.array()[0]["input"]["url"],
            V::from("https://fixture.invalid")
        );
    }
}
