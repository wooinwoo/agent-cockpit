use crate::board_value::{object, V};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
};

pub const ROUTES: &[(&str, &str)] = &[
    ("POST", "/api/autopilot/decide"),
    ("GET", "/api/autopilot/status"),
    ("GET", "/api/autopilot/briefing"),
    ("POST", "/api/autopilot/mode"),
    ("GET", "/api/autopilot/mode"),
    ("POST", "/api/autopilot/reset"),
];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, target)| method.as_str() == *verb && path == *target)
}

pub type AskHuman = Arc<
    dyn Fn(String, V) -> Pin<Box<dyn Future<Output = Result<bool, String>> + Send>> + Send + Sync,
>;

const METRICS: [&str; 9] = [
    "total", "auto", "block", "escalate", "review", "asked", "approved", "denied", "timedOut",
];
struct State {
    mode: &'static str,
    started_at: i64,
    metrics: BTreeMap<&'static str, u64>,
    log: VecDeque<V>,
}
impl State {
    fn reset(&mut self) {
        self.started_at = crate::account_usage::now();
        self.metrics = METRICS.into_iter().map(|key| (key, 0)).collect();
        self.log.clear();
    }
    fn count(&mut self, key: &'static str) {
        *self.metrics.get_mut(key).expect("fixed metric name") += 1;
    }
    fn status(&self) -> V {
        object([
            ("mode", self.mode.into()),
            ("startedAt", (self.started_at as f64).into()),
            (
                "metrics",
                V::Object(
                    self.metrics
                        .iter()
                        .map(|(key, count)| (key.to_string(), (*count as f64).into()))
                        .collect(),
                ),
            ),
            (
                "recent",
                V::Array(
                    self.log
                        .iter()
                        .skip(self.log.len().saturating_sub(30))
                        .cloned()
                        .collect(),
                ),
            ),
        ])
    }
    fn briefing(&self) -> V {
        let mut categories: BTreeMap<String, V> = BTreeMap::new();
        let mut notable = Vec::new();
        for entry in &self.log {
            let count = categories
                .entry(entry["category"].text())
                .or_insert(0.0.into());
            *count = (count.number() + 1.0).into();
            if matches!(entry["action"].text().as_str(), "escalate" | "block") {
                notable.push(object([
                    ("decision", entry["decision"].clone()),
                    ("tool", entry["tool"].clone()),
                    ("category", entry["category"].clone()),
                    ("snippet", entry["snippet"].clone()),
                ]));
            }
        }
        let minutes =
            (((crate::account_usage::now() - self.started_at) as f64 / 60000.0) + 0.5).floor();
        let m = &self.metrics;
        let mut summary = V::from(format!(
            "🌅 오토파일럿 브리핑 ({}, {}분 가동)\n• 자동 실행 {} · 검토 위임 {} · 차단 {}\n• 폰 승인요청 {} → 승인 {} / 거부 {} / 무응답 {}",
            self.mode, minutes, m["auto"], m["review"], m["block"], m["asked"], m["approved"], m["denied"], m["timedOut"]
        ));
        if !notable.is_empty() {
            append(&mut summary, &V::from("\n• 주요 결정:"));
            for entry in notable.iter().take(8) {
                let icon = match entry["decision"].text().as_str() {
                    "approve" => "✅",
                    "deny" => "⛔",
                    _ => "⏸",
                };
                append(
                    &mut summary,
                    &V::from(format!("\n   {icon} [{}] ", entry["category"].text())),
                );
                append(&mut summary, &entry["snippet"]);
            }
        }
        object([
            ("summary", summary),
            ("ran", (m["auto"] as f64).into()),
            ("escalations", (m["asked"] as f64).into()),
            ("approved", (m["approved"] as f64).into()),
            ("denied", (m["denied"] as f64).into()),
            ("blocked", (m["block"] as f64).into()),
            ("timedOut", (m["timedOut"] as f64).into()),
            ("byCategory", V::Object(categories)),
            ("notable", V::Array(notable)),
        ])
    }
}

pub struct Store {
    state: Mutex<State>,
    ask_human: Option<AskHuman>,
}
impl Store {
    pub fn new(ask_human: Option<AskHuman>) -> Self {
        let mut state = State {
            mode: "attended",
            started_at: 0,
            metrics: BTreeMap::new(),
            log: VecDeque::new(),
        };
        state.reset();
        Self {
            state: Mutex::new(state),
            ask_human,
        }
    }
    pub async fn handle(&self, method: &Method, path: &str, input: &V) -> Response {
        let result = if method == Method::POST && path == "/api/autopilot/decide" {
            self.decide(input).await
        } else {
            let mut state = self.state.lock().unwrap();
            Ok(match (method.as_str(), path) {
                ("GET", "/api/autopilot/status") => state.status(),
                ("GET", "/api/autopilot/briefing") => state.briefing(),
                ("GET", "/api/autopilot/mode") => object([("mode", state.mode.into())]),
                ("POST", "/api/autopilot/mode") => {
                    state.mode = if input["mode"] == V::from("attended") {
                        "attended"
                    } else if input["mode"] == V::from("unattended") {
                        "unattended"
                    } else {
                        return (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(
                                object([("error", "mode must be attended|unattended".into())])
                                    .raw(),
                            ),
                        )
                            .into_response();
                    };
                    object([("mode", state.mode.into())])
                }
                ("POST", "/api/autopilot/reset") => {
                    state.reset();
                    object([("ok", true.into())])
                }
                _ => return axum::http::StatusCode::NOT_FOUND.into_response(),
            })
        };
        match result {
            Ok(value) => Json(value.raw()).into_response(),
            Err(error) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(object([("error", error.into())]).raw()),
            )
                .into_response(),
        }
    }
    async fn decide(&self, event: &V) -> Result<V, String> {
        let tool = first(&[&event["tool"], &event["tool_name"]], V::from(""));
        let input = first(&[&event["input"], &event["tool_input"]], V::object());
        let (action, category, reason) = classify(&tool, &input)?;
        let attended = {
            let mut state = self.state.lock().unwrap();
            state.count("total");
            state.count(action);
            state.mode == "attended"
        };
        let decision = if action == "auto" {
            "approve"
        } else if action == "block" {
            "deny"
        } else if attended {
            "ask"
        } else if let Some(ask) = &self.ask_human {
            self.state.lock().unwrap().count("asked");
            let mut prompt = V::from(format!("🤖 승인 필요 ({category})\n도구: "));
            append(&mut prompt, &tool);
            append(&mut prompt, &V::from("\n"));
            append(&mut prompt, &snippet(&input));
            append(&mut prompt, &V::from("\n사유: "));
            append(&mut prompt, &reason);
            append(&mut prompt, &V::from("\n→ 진행할까요?"));
            let context = object([
                ("tool", tool.clone()),
                ("input", input.clone()),
                ("action", action.into()),
                ("category", category.into()),
                ("reason", reason.clone()),
            ]);
            let outcome = ask(prompt.text(), context).await;
            let mut state = self.state.lock().unwrap();
            match outcome {
                Ok(true) => {
                    state.count("approved");
                    "approve"
                }
                Ok(false) => {
                    state.count("denied");
                    "deny"
                }
                Err(_) => {
                    state.count("timedOut");
                    "deny"
                }
            }
        } else {
            "deny"
        };
        let entry = object([
            ("ts", first(&[&event["ts"]], V::Null)),
            ("tool", tool),
            ("action", action.into()),
            ("decision", decision.into()),
            ("category", category.into()),
            ("reason", reason.clone()),
            ("snippet", snippet(&input)),
        ]);
        let mut state = self.state.lock().unwrap();
        state.log.push_back(entry);
        if state.log.len() > 500 {
            state.log.pop_front();
        }
        Ok(object([
            ("decision", decision.into()),
            ("action", action.into()),
            ("category", category.into()),
            ("reason", reason),
        ]))
    }
}

fn first(values: &[&V], fallback: V) -> V {
    values
        .iter()
        .find(|value| value.truthy())
        .map_or(fallback, |value| (*value).clone())
}
fn append(target: &mut V, suffix: &V) {
    let V::String(units) = target else {
        unreachable!()
    };
    units.extend_from_slice(suffix.units());
}
fn string(value: &V) -> V {
    match value {
        V::String(_) => value.clone(),
        V::Number(n) if *n == 0.0 => V::from("0"),
        V::Number(n) if n.is_finite() && (n.abs() >= 1e21 || n.abs() < 1e-6) => {
            let scientific = format!("{n:e}");
            let (digits, exponent) = scientific.split_once('e').unwrap();
            let exponent: i32 = exponent.parse().unwrap();
            V::from(format!("{digits}e{exponent:+}"))
        }
        V::Array(values) => {
            let mut result = V::from("");
            for (i, value) in values.iter().enumerate() {
                if i != 0 {
                    append(&mut result, &V::from(","));
                }
                if *value != V::Null {
                    append(&mut result, &string(value));
                }
            }
            result
        }
        _ => value.text().into(),
    }
}
fn replace_home(value: &V, users: bool) -> V {
    let mut result = string(value);
    for pattern in policy().redactions.iter().take(if users { 2 } else { 1 }) {
        if let Some(found) = pattern.find_from_ucs2(result.units(), 0).next() {
            let mut units = result.units().to_vec();
            units.splice(found.range, [b'~' as u16]);
            result = V::String(units);
        }
    }
    result
}
fn snippet(input: &V) -> V {
    replace_home(
        &first(
            &[&input["command"], &input["file_path"], &input["url"]],
            V::from(""),
        ),
        false,
    )
    .cut(100)
}

struct Policy {
    safe_tools: Vec<V>,
    edit_tools: Vec<V>,
    danger_paths: Vec<regress::Regex>,
    config_paths: Vec<regress::Regex>,
    danger_commands: Vec<regress::Regex>,
    escalate_commands: Vec<regress::Regex>,
    safe_command: regress::Regex,
    redactions: Vec<regress::Regex>,
}
fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        let source: serde_json::Value = serde_json::from_str(POLICY_SOURCE).unwrap();
        let compile = |value: &serde_json::Value| {
            regress::Regex::with_flags(value[0].as_str().unwrap(), value[1].as_str().unwrap())
                .expect("source-owned JavaScript policy regex")
        };
        let patterns = |key: &str| {
            source[key]
                .as_array()
                .unwrap()
                .iter()
                .map(compile)
                .collect()
        };
        let tools = |key: &str| {
            source[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| V::from(value.as_str().unwrap()))
                .collect()
        };
        Policy {
            safe_tools: tools("SAFE_TOOLS"),
            edit_tools: tools("EDIT_TOOLS"),
            danger_paths: patterns("DANGER_PATHS"),
            config_paths: patterns("CONFIG_PATHS"),
            danger_commands: patterns("DANGER_PATTERNS"),
            escalate_commands: patterns("ESCALATE_PATTERNS"),
            safe_command: compile(&source["SAFE_BASH"]),
            redactions: [r"/home/[^/]+", r"/Users/[^/]+"]
                .iter()
                .map(|source| regress::Regex::new(source).unwrap())
                .collect(),
        }
    })
}
fn matches_any(patterns: &[regress::Regex], value: &V) -> bool {
    let text = string(value);
    patterns
        .iter()
        .any(|pattern| pattern.find_from_ucs2(text.units(), 0).next().is_some())
}
fn classify(tool: &V, input: &V) -> Result<(&'static str, &'static str, V), String> {
    static NATIVE_POLICY: OnceLock<regress::Regex> = OnceLock::new();
    let p = policy();
    let result = if p.safe_tools.contains(tool) {
        let mut reason = tool.clone();
        append(&mut reason, &V::from(" is read-only/inert"));
        ("auto", "read-only", reason)
    } else if !tool.is_string() {
        return Err("tool.startsWith is not a function".into());
    } else if tool.text().starts_with("mcp__") {
        let risky = tool.text().contains("run_code_unsafe") || tool.text().contains("file_upload");
        let mut reason = tool.clone();
        append(
            &mut reason,
            &V::from(if risky {
                " can execute arbitrary code"
            } else {
                " is dev-scoped automation"
            }),
        );
        if risky {
            ("review", "mcp-risky", reason)
        } else {
            ("auto", "mcp", reason)
        }
    } else if p.edit_tools.contains(tool) {
        let path = first(
            &[&input["file_path"], &input["path"], &input["notebook_path"]],
            V::from(""),
        );
        if matches_any(&p.danger_paths, &path) {
            let mut reason = V::from("edit to protected path: ");
            append(&mut reason, &replace_home(&path, true));
            ("block", "secret-path", reason)
        } else if matches_any(&p.config_paths, &path)
            || matches_any(
                std::slice::from_ref(NATIVE_POLICY.get_or_init(|| {
                    regress::Regex::new(
                        r"(^|[/\\])rust-server[/\\]src[/\\](autopilot|supervisor)\.rs$",
                    )
                    .unwrap()
                })),
                &path,
            )
        {
            let mut reason = V::from("edit to sensitive config: ");
            append(&mut reason, &replace_home(&path, true));
            ("escalate", "config", reason)
        } else {
            ("auto", "edit-safe", "edit on ordinary path".into())
        }
    } else if *tool == V::from("Bash") {
        let command = first(&[&input["command"]], V::from(""));
        if matches_any(&p.danger_commands, &command) {
            (
                "block",
                "destructive",
                "matches irreversible-danger pattern".into(),
            )
        } else if matches_any(&p.escalate_commands, &command) {
            (
                "escalate",
                "production",
                "production / cloud / deploy impact".into(),
            )
        } else if matches_any(std::slice::from_ref(&p.safe_command), &command) {
            ("auto", "bash-safe", "common read-only shell command".into())
        } else {
            (
                "review",
                "bash-unknown",
                "no rule matched — needs judgment".into(),
            )
        }
    } else {
        let mut reason = V::from("unclassified tool: ");
        append(&mut reason, tool);
        ("review", "unknown-tool", reason)
    };
    Ok(result)
}

// Exact RegExp.source/flags and tool sets from lib/autopilot-policy.js.
// The HTTP compatibility check rejects any drift from that source.
const POLICY_SOURCE: &str = r###"{
  "SAFE_TOOLS": ["Read","Glob","Grep","NotebookRead","WebFetch","WebSearch","TodoWrite","TaskCreate","TaskUpdate","AskUserQuestion","ToolSearch"],
  "EDIT_TOOLS": ["Edit","Write","MultiEdit","NotebookEdit"],
  "DANGER_PATHS": [["^\\/etc\\/",""],["^\\/usr\\/",""],["^\\/boot\\/",""],["^\\/bin\\/",""],["^\\/sbin\\/",""],["^\\/var\\/lib\\/",""],["^\\/root\\/",""],["\\/\\.ssh\\/",""],["\\/\\.aws\\/",""],["\\/\\.gnupg\\/",""],["\\/\\.docker\\/config\\.json$",""],["\\/id_rsa(\\.pub)?$",""],["\\/id_ed25519(\\.pub)?$",""],["\\/\\.bash_history$",""],["\\.env(\\.|$)",""],["\\/credentials(\\.json)?$",""],["\\.pem$",""],["\\.key$",""],["\\.crt$",""]],
  "CONFIG_PATHS": [["\\/\\.claude\\/settings(\\.local)?\\.json$",""],["\\/\\.claude\\/.*\\.(json|md)$",""],["\\/lib\\/supervisor-service\\.js$",""],["\\/lib\\/autopilot-policy\\.js$",""]],
  "DANGER_PATTERNS": [["\\brm\\s+-rf?\\s+\\/",""],["\\brm\\s+-rf?\\s+~",""],["\\brm\\s+-rf?\\s+\\$HOME",""],[":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\}",""],["\\bmkfs\\.",""],["\\bdd\\s+if=.*of=\\/dev",""],[">\\s*\\/dev\\/sd[a-z]",""],["\\bsudo\\s+(rm|chmod|chown|dd|mkfs|systemctl|service|reboot|shutdown|halt|poweroff|kill)",""],["\\bsudo\\s+-(i|s)\\b",""],["\\bchmod\\s+-?R?\\s*[0-7]{3,4}\\s+\\/",""],["\\bchown\\s+-?R?\\s*root\\b",""],["\\bshutdown\\b",""],["\\breboot\\b",""],["\\bhalt\\b",""],["\\bpoweroff\\b",""],["\\bkill\\s+-9\\s+1\\b",""],["\\binit\\s+[06]\\b",""],["\\biptables\\s+.*-j\\s+DROP","i"],["\\bufw\\s+(disable|delete)\\b","i"],["\\bcrontab\\s+-r\\b",""],["\\bgit\\s+push\\s+--force(?!-with-lease)",""],["\\bgit\\s+push\\s+-f\\b",""],["\\bgit\\s+reset\\s+--hard\\s+(origin|HEAD~|[0-9a-f]{7,})",""],["\\bgit\\s+clean\\s+-[fdx]+",""],["\\bgit\\s+filter-(branch|repo)",""],["\\bnpm\\s+publish\\b",""],["\\bnpm\\s+unpublish\\b",""],["\\bnpm\\s+install\\s+(-g|--global)\\b",""],["\\bpnpm\\s+(publish|unpublish)\\b",""],["\\byarn\\s+publish\\b",""],["\\bcurl\\s+[^|]*\\|\\s*(bash|sh|zsh)\\b",""],["\\bwget\\s+[^|]*\\|\\s*(bash|sh|zsh)\\b",""],["\\bDROP\\s+(TABLE|DATABASE|SCHEMA)","i"],["\\bTRUNCATE\\s+TABLE","i"],["\\bDELETE\\s+FROM\\s+\\w+\\s*;?\\s*$","i"]],
  "ESCALATE_PATTERNS": [["\\baws\\s+s3\\s+rm\\b",""],["\\baws\\s+s3\\s+(cp|sync)\\b[^|]*--delete\\b",""],["\\baws\\s+\\S+\\s+(delete|remove|rm|modify|create|put|update|start|stop|terminate|reboot|deregister|disable|detach|revoke|associate|disassociate|rb)\\b","i"],["\\bgcloud\\s+\\S+.*\\s(delete|create|update|remove|set)\\b","i"],["\\baz\\s+\\S+\\s+(delete|create|update)\\b","i"],["\\bkubectl\\s+(delete|apply|scale|drain|cordon|uncordon|patch|replace|rollout|set)\\b",""],["\\bterraform\\s+(destroy|apply)\\b",""],["\\beksctl\\s+(delete|create)\\b",""],["\\bhelm\\s+(install|upgrade|uninstall|delete|rollback)\\b",""],["\\bdoctl\\s+\\S+\\s+delete\\b",""],["\\bflyctl?\\s+(deploy|destroy|scale)\\b",""],["\\bvercel\\s+(deploy|--prod|rm|remove)\\b",""],["boto3[\\s\\S]*\\.\\s*(delete|create|modify|put|update|terminate|stop|disable|remove|reboot|associate|revoke)_?\\w*\\s*\\(",""],["NODE_ENV=production",""],["--to=production\\b",""],["--env[= ]prod(uction)?\\b",""],["\\bnpm\\s+run\\s+deploy\\b",""],["\\byarn\\s+deploy\\b",""],["\\bpnpm\\s+(run\\s+)?deploy\\b",""],["\\bdrizzle-kit\\s+(migrate|push)\\b",""],["\\bprisma\\s+migrate\\s+deploy\\b",""],["\\bknex\\s+migrate",""],["\\bserverless\\s+deploy\\b",""],["\\bsls\\s+deploy\\b",""],["\\bcdk\\s+(deploy|destroy)\\b",""],["\\bsam\\s+deploy\\b",""],["\\bgit\\s+push\\b[^\\n]*\\b(prod|production|release|main|master)\\b",""],["\\bgit\\s+push\\s+\\S+\\s+\\S+:(prod|production|release|main|master)\\b",""],["\\b(mysql|psql|mongo|mongosh|redis-cli|mysqldump|pg_dump|pg_restore)\\b[^|]*\\s-h\\s",""],["\\bMYSQL_PWD=",""],["\\bPGPASSWORD=",""],["\\bsystemctl\\s+(--user\\s+)?(restart|start|stop|reload)\\b",""],["\\brestart[-_].*prod|prod.*restart","i"],["\\bpm2\\s+(restart|reload|stop|delete)\\b",""],["\\bdocker\\s+(rm|rmi|prune|stop|kill|system\\s+prune)\\b",""],["\\bdocker\\s+compose\\s+(down|rm)\\b",""]],
  "SAFE_BASH": ["^(ls|pwd|cat|head|tail|echo|jq|find|grep|rg|wc|stat|file|which|env|date|whoami|hostname|uname|tree|du|df|ps|node\\s+--version|npm\\s+(test|run|ls|outdated|view|info|whoami)|pnpm\\s+(test|run|ls|outdated|view|info|why)|yarn\\s+(test|run|info|why)|git\\s+(status|log|diff|branch|show|fetch|remote))(\\s|$)",""]
}"###;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_policy_edits_keep_the_original_self_modification_guard() {
        for path in [
            "rust-server/src/autopilot.rs",
            "/fixture/rust-server/src/supervisor.rs",
            r"C:\fixture\rust-server\src\autopilot.rs",
        ] {
            let (action, category, _) =
                classify(&V::from("Edit"), &object([("file_path", path.into())])).unwrap();
            assert_eq!((action, category), ("escalate", "config"));
        }
        for path in [
            "/fixture/rust-server/src/notes.rs",
            "/fixture/rust-server/src/autopilot.rs.bak",
        ] {
            assert_eq!(
                classify(&V::from("Edit"), &object([("file_path", path.into())]))
                    .unwrap()
                    .0,
                "auto"
            );
        }
    }
    fn event(command: &str) -> V {
        object([
            ("tool", "Bash".into()),
            ("input", object([("command", command.into())])),
        ])
    }
    #[test]
    fn javascript_regex_precedence_and_utf16_are_preserved() {
        for (command, action) in [
            ("git push --force origin main", "block"),
            ("git push --force-with-lease origin feature", "review"),
            ("git push --force-with-lease origin main", "escalate"),
            ("git status; npm publish", "block"),
            ("éshutdown", "block"),
            ("ſhutdown", "review"),
            ("aws\u{feff}ec2 delete-instances", "escalate"),
            ("AWS EC2 DELETE-INSTANCES", "escalate"),
            ("npm run deploy", "escalate"),
        ] {
            assert_eq!(
                classify(&V::from("Bash"), &event(command)["input"])
                    .unwrap()
                    .0,
                action,
                "{command}"
            );
        }
        let units = [vec![b'x' as u16; 99], vec![0xd83d, 0xde00, 0xd800]].concat();
        let result = snippet(&object([("command", V::String(units))]));
        assert_eq!(result.units().len(), 100);
        assert_eq!(result.units()[99], 0xd83d);
        assert_eq!(
            replace_home(&V::from("/home/user/a /Users/user/b"), true),
            V::from("~/a ~/b")
        );
    }
    #[tokio::test]
    async fn callbacks_metrics_reset_and_log_cap_match_source() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let store = Store::new(Some(Arc::new(move |prompt, context| {
            captured.lock().unwrap().push((prompt, context.clone()));
            Box::pin(async move {
                match context["input"]["command"].text().as_str() {
                    "git pull" => Ok(true),
                    "terraform apply" => Err("fake channel failure".into()),
                    _ => Ok(false),
                }
            })
        })));
        assert_eq!(
            store.decide(&event("git pull")).await.unwrap()["decision"],
            V::from("ask")
        );
        assert!(seen.lock().unwrap().is_empty());
        store.state.lock().unwrap().mode = "unattended";
        for command in [
            "ls",
            "rm -rf /",
            "git pull",
            "git push origin main",
            "terraform apply",
        ] {
            store.decide(&event(command)).await.unwrap();
        }
        let metrics = store.state.lock().unwrap().status()["metrics"].clone();
        for (name, count) in [
            ("total", 6),
            ("auto", 1),
            ("block", 1),
            ("review", 2),
            ("escalate", 2),
            ("asked", 3),
            ("approved", 1),
            ("denied", 1),
            ("timedOut", 1),
        ] {
            assert_eq!(metrics[name], (count as f64).into(), "{name}");
        }
        assert_eq!(seen.lock().unwrap()[0].0, "🤖 승인 필요 (bash-unknown)\n도구: Bash\ngit pull\n사유: no rule matched — needs judgment\n→ 진행할까요?");
        store.state.lock().unwrap().reset();
        assert_eq!(store.state.lock().unwrap().mode, "unattended");
        for n in 0..505 {
            let mut entry = event(if n < 5 { "rm -rf /" } else { "ls" });
            entry["ts"] = (n as f64).into();
            store.decide(&entry).await.unwrap();
        }
        let state = store.state.lock().unwrap();
        assert_eq!(state.log.len(), 500);
        assert_eq!(state.status()["recent"].array().len(), 30);
        assert_eq!(state.status()["recent"].array()[0]["ts"], V::from(475.0));
        assert_eq!(state.briefing()["blocked"], V::from(5.0));
        assert!(state.briefing()["notable"].array().is_empty());
        assert_eq!(state.briefing()["byCategory"]["bash-safe"], V::from(500.0));
        drop(state);
        let absent = Store::new(None);
        absent.state.lock().unwrap().mode = "unattended";
        assert_eq!(
            absent.decide(&event("git pull")).await.unwrap()["decision"],
            V::from("deny")
        );
        assert_eq!(
            absent.state.lock().unwrap().status()["metrics"]["asked"],
            V::from(0.0)
        );
    }
    #[tokio::test]
    async fn reset_during_approval_keeps_original_completion_order() {
        let barrier = Arc::new(tokio::sync::Notify::new());
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let gate = barrier.clone();
        let store = Arc::new(Store::new(Some(Arc::new(move |_, _| {
            let gate = gate.clone();
            let sender = sender.clone();
            Box::pin(async move {
                sender.send(()).unwrap();
                gate.notified().await;
                Ok(false)
            })
        }))));
        store.state.lock().unwrap().mode = "unattended";
        let running = store.clone();
        let task = tokio::spawn(async move { running.decide(&event("git pull")).await });
        receiver.recv().await.unwrap();
        store.state.lock().unwrap().reset();
        store.decide(&event("ls")).await.unwrap();
        barrier.notify_one();
        task.await.unwrap().unwrap();
        let state = store.state.lock().unwrap();
        assert_eq!(state.metrics["asked"], 0);
        assert_eq!(state.metrics["denied"], 1);
        assert_eq!(state.metrics["total"], 1);
        assert_eq!(state.log.len(), 2);
        assert_eq!(state.log[1]["snippet"], V::from("git pull"));
    }
}
