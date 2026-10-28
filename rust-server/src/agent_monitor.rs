//! Pure proactive monitor state. Transport, scheduling and event publication
//! remain owned by the application; scans never start work themselves.
use crate::{
    agent_prompt::{property_string, string},
    board_value::{object, V},
};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

const ALERT_COOLDOWN: i64 = 5 * 60_000;
const IDLE_THRESHOLD: i64 = 10 * 60_000;
const HISTORY_LIFETIME: i64 = 30 * 60_000;
#[derive(Default)]
pub struct Cycle {
    pub events: Vec<(String, V)>,
    pub reviews: Vec<V>,
}
struct History {
    timestamp: i64,
    dismissed: bool,
}
struct GitState {
    count: usize,
    hash: V,
}
struct JiraState {
    status: V,
    updated: V,
}
struct Activity {
    buffer: Vec<u16>,
    timestamp: i64,
}
#[derive(Default)]
pub struct State {
    history: HashMap<Vec<u16>, History>,
    buffers: HashMap<Vec<u16>, Vec<u16>>,
    jira: HashMap<Vec<u16>, JiraState>,
    active: Vec<V>,
    reports: Vec<V>,
    git: HashMap<Vec<u16>, GitState>,
    reviews: HashMap<Vec<u16>, i64>,
    activity: HashMap<Vec<u16>, Activity>,
    last_idle_nag: i64,
}
fn text(template: &str, args: &[V]) -> Result<V, String> {
    let parts: Vec<_> = template.split("{}").collect();
    let mut units = vec![];
    for (index, part) in parts.iter().enumerate() {
        units.extend(part.encode_utf16());
        if let Some(arg) = args.get(index) {
            units.extend_from_slice(string(arg)?.units());
        }
    }
    Ok(V::String(units))
}
macro_rules! t { ($template:expr $(,$value:expr)* $(,)?) => { text($template, &[$($value),*])? }; }
fn or(value: &V, other: &V) -> V {
    if value.truthy() {
        value.clone()
    } else {
        other.clone()
    }
}
fn id(value: &V) -> Vec<u16> {
    string(value)
        .unwrap_or_else(|_| "[invalid]".into())
        .units()
        .to_vec()
}
fn field(value: &V, key: &str) -> Result<V, String> {
    property_string(value, key)
}
fn copy_field(target: &mut V, key: &str, source: &V, source_key: &str) {
    if source.has(source_key) {
        target[key] = source[source_key].clone();
    }
}
fn generated_id(kind: &str, now: i64) -> V {
    format!("{kind}-{now}-{:016x}", rand::random::<u64>()).into()
}
fn alert(
    now: i64,
    key: V,
    source: &str,
    level: &str,
    title: V,
    detail: V,
    context: V,
    action: V,
    prompt: V,
) -> V {
    object([
        ("id", generated_id("alert", now)),
        ("_alertKey", key),
        ("source", source.into()),
        ("level", level.into()),
        ("title", title),
        ("detail", detail),
        ("context", context),
        ("suggestedAction", action),
        ("suggestedPrompt", prompt),
        ("timestamp", (now as f64).into()),
    ])
}
fn patterns() -> &'static Vec<(regress::Regex, &'static str, &'static str)> {
    static PATTERNS: OnceLock<Vec<(regress::Regex, &'static str, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (
                r"\b(ENOENT|EACCES|EPERM|EADDRINUSE)\b",
                "error",
                "node-error",
            ),
            (r"\b(segfault|SIGSEGV|SIGABRT|SIGKILL)\b", "error", "crash"),
            (
                r"\b(FATAL|panic|OOM|OutOfMemory|heap out of memory)\b",
                "error",
                "fatal",
            ),
            (r"npm ERR!", "error", "npm-error"),
            (
                r"\bFAIL\b.*test|Tests?:.*\d+\s+failed",
                "warning",
                "test-fail",
            ),
            (
                r"Traceback \(most recent call last\)",
                "error",
                "python-error",
            ),
            (
                r"Unhandled\s+(promise\s+)?rejection",
                "error",
                "unhandled-rejection",
            ),
            (r"TypeError|ReferenceError|SyntaxError", "error", "js-error"),
            (
                r"BUILD FAILED|Build failed|Compilation failed",
                "error",
                "build-fail",
            ),
            (r"error TS\d+:", "error", "ts-error"),
            (r"\[ERROR\]\s+.{5,}", "warning", "generic-error"),
        ]
        .into_iter()
        .map(|(pattern, level, kind)| {
            (
                regress::Regex::with_flags(pattern, "i").unwrap(),
                level,
                kind,
            )
        })
        .collect()
    })
}
fn strip_ansi(units: &[u16]) -> V {
    static PATTERNS: OnceLock<[regress::Regex; 2]> = OnceLock::new();
    let mut result = units.to_vec();
    for regex in PATTERNS.get_or_init(|| {
        [
            regress::Regex::new(r"\x1B\[[0-9;]*[A-Za-z]").unwrap(),
            regress::Regex::new(r"\x1B\][^\x07]*\x07").unwrap(),
        ]
    }) {
        let ranges: Vec<_> = regex
            .find_from_ucs2(&result, 0)
            .map(|found| found.range)
            .collect();
        for range in ranges.into_iter().rev() {
            result.drain(range);
        }
    }
    V::String(result)
}
// Replay buffers can slide or be cleared without growing. Match the longest
// old suffix/new prefix in linear time, then inspect only the newly added text.
fn new_suffix(previous: &[u16], current: &[u16]) -> usize {
    if current.starts_with(previous) {
        return previous.len();
    }
    if current.is_empty() {
        return 0;
    }
    let mut prefix = vec![0usize; current.len()];
    for index in 1..current.len() {
        let mut matched = prefix[index - 1];
        while matched > 0 && current[index] != current[matched] {
            matched = prefix[matched - 1];
        }
        if current[index] == current[matched] {
            matched += 1;
        }
        prefix[index] = matched;
    }
    let mut matched = 0;
    for unit in previous {
        while matched > 0 && (matched == current.len() || *unit != current[matched]) {
            matched = prefix[matched - 1];
        }
        if *unit == current[matched] {
            matched += 1;
        }
    }
    matched
}
fn date_millis(value: &V) -> Option<f64> {
    if let V::Number(number) = value {
        return number.is_finite().then_some(*number);
    }
    chrono::DateTime::parse_from_rfc3339(&value.text())
        .ok()
        .map(|date| date.timestamp_millis() as f64)
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(&value.text(), "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp_millis() as f64)
        })
}

impl State {
    fn claim(
        &mut self,
        source: &str,
        kind: &str,
        identity: &V,
        now: i64,
    ) -> Result<Option<V>, String> {
        let key = t!("{}:{}:{}", source.into(), kind.into(), identity.clone());
        if self.history.get(key.units()).is_some_and(|previous| {
            previous.dismissed || now.saturating_sub(previous.timestamp) < ALERT_COOLDOWN
        }) {
            return Ok(None);
        }
        self.history.insert(
            key.units().to_vec(),
            History {
                timestamp: now,
                dismissed: false,
            },
        );
        Ok(Some(key))
    }
    fn terminals(&mut self, snapshot: &V, now: i64) -> Result<Vec<V>, String> {
        let mut result = vec![];
        let names: HashMap<_, _> = snapshot["projects"]
            .array()
            .iter()
            .map(|project| (id(&project["id"]), project["name"].clone()))
            .collect();
        let terms = snapshot["terminals"].array();
        for term in terms {
            let raw = &term["buffer"];
            let key = id(&term["termId"]);
            if !raw.truthy() {
                if raw.is_string() {
                    self.buffers.insert(key, vec![]);
                }
                continue;
            }
            if !raw.is_string() {
                return Err("buf.slice is not a function".into());
            }
            let start = self
                .buffers
                .get(&key)
                .map_or(0, |old| new_suffix(old, raw.units()));
            self.buffers.insert(key, raw.units().to_vec());
            if start == raw.units().len() {
                continue;
            }
            let new_data = strip_ansi(&raw.units()[start..]);
            for (regex, level, kind) in patterns() {
                let Some(found) = regex.find_from_ucs2(new_data.units(), 0).next() else {
                    continue;
                };
                let Some(key) = self.claim("terminal", kind, &field(term, "termId")?, now)? else {
                    continue;
                };
                let range = found.range;
                let context = V::String(
                    new_data.units()[range.start.saturating_sub(100)
                        ..(range.end + 200).min(new_data.units().len())]
                        .to_vec(),
                )
                .trim();
                let project_name = names
                    .get(&id(&term["projectId"]))
                    .filter(|name| name.truthy())
                    .cloned()
                    .unwrap_or(field(term, "projectId")?);
                let mut details = object([
                    ("projectName", project_name.clone()),
                    ("command", or(&term["command"], &"(shell)".into())),
                ]);
                copy_field(&mut details, "termId", term, "termId");
                copy_field(&mut details, "projectId", term, "projectId");
                result.push(alert(now,key,"terminal",level,t!("터미널 {} 감지",(*kind).into()),context.cut(300),details,
                    t!("터미널에서 {} 에러가 감지됐어영. 분석할까여?",(*kind).into()),
                    t!("Terminal {} (project: {}) has a {} error:\n\n{}\n\nAnalyze this error and suggest a fix.",field(term,"termId")?,project_name,(*kind).into(),context.cut(500))));
                break;
            }
        }
        let active: HashSet<_> = terms.iter().map(|term| id(&term["termId"])).collect();
        self.buffers.retain(|key, _| active.contains(key));
        Ok(result)
    }
    fn cicd(&mut self, snapshot: &V, now: i64) -> Result<Vec<V>, String> {
        let mut result = vec![];
        for project in snapshot["projects"].array() {
            if !project["github"].truthy() {
                continue;
            }
            let project_id = field(project, "id")?;
            let cached = &snapshot["cicd"][&project_id.text()];
            let Some(run) = cached["runs"].array().first() else {
                continue;
            };
            if run["conclusion"] != V::from("failure") {
                continue;
            }
            let Some(key) = self.claim(
                "cicd",
                "failure",
                &t!("{}:{}", project_id.clone(), field(run, "id")?),
                now,
            )?
            else {
                continue;
            };
            let name = field(project, "name")?;
            let mut context = object([("url", or(&run["html_url"], &"".into()))]);
            for (key, source, field) in [
                ("projectId", project, "id"),
                ("projectName", project, "name"),
                ("runId", run, "id"),
                ("workflow", run, "name"),
                ("branch", run, "head_branch"),
            ] {
                copy_field(&mut context, key, source, field);
            }
            result.push(alert(now,key,"cicd","error",t!("CI/CD 실패: {}",name.clone()),
                t!("{} — {} ({})",or(&run["name"],&"workflow".into()),field(run,"conclusion")?,or(&run["head_branch"],&"?".into())),context,
                t!("{}의 CI/CD가 실패했어영. 로그 분석할까여?",name.clone()),
                t!("CI/CD pipeline \"{}\" failed for project {} (branch: {}). Run ID: {}. Analyze the failure using the CICD tool and suggest fixes.",field(run,"name")?,name,field(run,"head_branch")?,field(run,"id")?)));
        }
        Ok(result)
    }
    fn jira(&mut self, snapshot: &V, now: i64) -> Result<Vec<V>, String> {
        let mut result = vec![];
        if !snapshot.has("jira") || snapshot["jira"] == V::Null {
            return Ok(result);
        }
        for issue in snapshot["jira"]["issues"].array() {
            let key = field(issue, "key")?;
            // jira-service simplifies issues; support both its actual return
            // value and the older raw.fields shape used by the source monitor.
            let fields = if issue["fields"].truthy() {
                &issue["fields"]
            } else {
                issue
            };
            let status = or(&fields["status"]["name"], &"".into());
            let updated = or(&fields["updated"], &"".into());
            if let Some(previous) = self.jira.get(&id(&key)) {
                let from = previous.status.clone();
                let previous_updated = previous.updated.clone();
                if from != status {
                    if let Some(alert_key) = self.claim(
                        "jira",
                        "status-change",
                        &t!("{}:{}", key.clone(), status.clone()),
                        now,
                    )? {
                        result.push(alert(now,alert_key,"jira","info",t!("Jira 상태 변경: {}",key.clone()),
                            t!("{}: {} → {}",or(&fields["summary"],&key),from.clone(),status.clone()),
                            object([("issueKey",key.clone()),("from",from.clone()),("to",status.clone())]),
                            t!("{} 이슈 상태가 바뀌었어영 ({} → {}). 확인할까여?",key.clone(),from.clone(),status.clone()),
                            t!("Jira issue {} \"{}\" status changed from \"{}\" to \"{}\". Show me the issue details using the JIRA tool.",key.clone(),field(fields,"summary")?,from,status.clone())));
                    }
                } else if previous_updated != updated {
                    if let Some(alert_key) = self.claim(
                        "jira",
                        "updated",
                        &t!("{}:{}", key.clone(), updated.clone()),
                        now,
                    )? {
                        result.push(alert(now,alert_key,"jira","info",t!("Jira 업데이트: {}",key.clone()),
                            t!("{} — 새 업데이트 있음",or(&fields["summary"],&key)),object([("issueKey",key.clone())]),
                            t!("{} 이슈에 업데이트가 있어영. 확인할까여?",key.clone()),
                            t!("Jira issue {} \"{}\" was updated. Show me the latest details using the JIRA tool.",key.clone(),field(fields,"summary")?)));
                    }
                }
            }
            self.jira.insert(id(&key), JiraState { status, updated });
        }
        for sprint in snapshot["jira"]["sprints"].array() {
            if !sprint["endDate"].truthy() {
                continue;
            }
            let Some(end) = date_millis(&sprint["endDate"]) else {
                continue;
            };
            let hours = (end - now as f64) / 3_600_000.0;
            if !(hours > 0.0 && hours < 24.0) {
                continue;
            }
            let Some(key) = self.claim("jira", "sprint-deadline", &field(sprint, "id")?, now)?
            else {
                continue;
            };
            let hours = V::Number((hours + 0.5).floor());
            let name = field(sprint, "name")?;
            let mut context = object([("hoursLeft", hours.clone())]);
            copy_field(&mut context, "sprintId", sprint, "id");
            copy_field(&mut context, "sprintName", sprint, "name");
            result.push(alert(now,key,"jira","warning","스프린트 마감 임박".into(),t!("\"{}\" — {}시간 남음",name.clone(),hours.clone()),context,
                t!("스프린트 \"{}\"이 {}시간 뒤 마감이에영! 현황 확인할까여?",name.clone(),hours.clone()),
                t!("Sprint \"{}\" ends in {} hours. Show me the sprint status and remaining issues using the JIRA tool.",name,hours)));
        }
        Ok(result)
    }
    fn review(
        &mut self,
        ready: bool,
        project: &V,
        agent: &str,
        metadata: V,
        now: i64,
        output: &mut Vec<V>,
    ) {
        if !ready {
            return;
        }
        let key = id(&project["id"]);
        if now.saturating_sub(*self.reviews.get(&key).unwrap_or(&0)) < ALERT_COOLDOWN {
            return;
        }
        self.reviews.insert(key, now);
        output.push(object([
            ("agentId", agent.into()),
            ("prompt", metadata["prompt"].clone()),
            ("metadata", metadata),
        ]));
    }
    fn git(&mut self, snapshot: &V, now: i64, reviews: &mut Vec<V>) -> Result<Vec<V>, String> {
        let mut result = vec![];
        for project in snapshot["projects"].array() {
            let project_id = field(project, "id")?;
            let cached = &snapshot["git"][&project_id.text()];
            if !cached.truthy() {
                continue;
            }
            let count = cached["stagedFiles"].array().len() + cached["unstagedFiles"].array().len();
            let last = cached["recentCommits"]
                .array()
                .first()
                .cloned()
                .unwrap_or(V::Null);
            let hash = or(&last["hash"], &"".into());
            let previous = self
                .git
                .get(&id(&project_id))
                .map(|previous| (previous.count, previous.hash.clone()));
            if let Some((previous_count, previous_hash)) = previous {
                let name = field(project, "name")?;
                if hash.truthy() && hash != previous_hash {
                    if !hash.is_string() {
                        return Err("currentHash.slice is not a function".into());
                    }
                    if let Some(key) = self.claim(
                        "git",
                        "new-commit",
                        &t!("{}:{}", project_id.clone(), hash.clone()),
                        now,
                    )? {
                        let message = or(&last["message"], &"".into());
                        if !message.is_string() {
                            return Err("commitMsg.slice is not a function".into());
                        }
                        result.push(alert(now,key,"git","info",t!("새 커밋: {}",name.clone()),t!("{} — {}",hash.cut(7),message.cut(80)),
                            object([("projectId",project_id.clone()),("projectName",name.clone()),("hash",hash.clone()),("message",message.clone())]),
                            t!("{}에 새 커밋이 올라왔어영. 리뷰할까여?",name.clone()),
                            t!("Review the latest commit in {}: {} \"{}\". Use GIT_LOG and GIT_DIFF to analyze the changes and give feedback.",name.clone(),hash.cut(7),message.clone())));
                        let metadata = object([("type","commit-review".into()),("prompt",t!("{} 프로젝트에 새 커밋이 올라왔어. 커밋 해시: {}, 메시지: \"{}\". GIT_DIFF로 변경 내용을 확인하고 코드 리뷰를 간결하게 해줘. 문제 있으면 지적하고, 괜찮으면 짧게 칭찬해.",name.clone(),hash.cut(7),message)),("projectId",project_id.clone()),("projectName",name.clone())]);
                        self.review(
                            snapshot["reviewReady"].truthy(),
                            project,
                            "dev_gwajang",
                            metadata,
                            now,
                            reviews,
                        );
                    }
                }
                if count >= 3 && count > previous_count + 2 {
                    if let Some(key) = self.claim(
                        "git",
                        "uncommitted",
                        &t!("{}:{}", project_id.clone(), (count as f64).into()),
                        now,
                    )? {
                        let mut names = vec![];
                        for file in cached["stagedFiles"]
                            .array()
                            .iter()
                            .chain(cached["unstagedFiles"].array())
                            .take(5)
                        {
                            names.push(string(&or(&file["file"], &or(&file["name"], file)))?);
                        }
                        let files = V::String(
                            names
                                .iter()
                                .enumerate()
                                .flat_map(|(i, name)| {
                                    let mut value = if i == 0 { vec![] } else { vec![44, 32] };
                                    value.extend_from_slice(name.units());
                                    value
                                })
                                .collect(),
                        );
                        result.push(alert(now,key,"git","info",t!("변경사항 증가: {}",name.clone()),t!("{}개 파일 변경 — {}",(count as f64).into(),files.clone()),
                            object([("projectId",project_id.clone()),("projectName",name.clone()),("fileCount",(count as f64).into())]),
                            t!("{}에 {}개 파일 변경됐어영. 확인해볼까여?",name.clone(),(count as f64).into()),
                            t!("{} has {} uncommitted changes. Files: {}. Use GIT_DIFF to review the changes and suggest if they should be committed.",name.clone(),(count as f64).into(),files)));
                        let metadata = object([("type","diff-review".into()),("prompt",t!("{} 프로젝트에 {}개 파일이 변경되었어. GIT_DIFF:{}로 변경 내용 확인하고 간결하게 리뷰해줘. 잘한 부분, 주의할 부분, 개선 제안 각각 1-2줄.",name.clone(),(count as f64).into(),field(project,"path")?)),("projectId",project_id.clone()),("projectName",name)]);
                        self.review(
                            snapshot["reviewReady"].truthy(),
                            project,
                            "dev_bujang",
                            metadata,
                            now,
                            reviews,
                        );
                    }
                }
            }
            self.git.insert(id(&project_id), GitState { count, hash });
        }
        Ok(result)
    }
    fn idle(&mut self, snapshot: &V, now: i64) -> Result<Vec<V>, String> {
        let terms = snapshot["terminals"].array();
        for term in terms {
            let buffer = &term["buffer"];
            if !buffer.truthy() {
                continue;
            }
            let key = id(&term["termId"]);
            if self
                .activity
                .get(&key)
                .is_none_or(|old| old.buffer != buffer.units())
            {
                self.activity.insert(
                    key,
                    Activity {
                        buffer: buffer.units().to_vec(),
                        timestamp: now,
                    },
                );
            }
        }
        let all_idle = !terms.is_empty()
            && terms.iter().all(|term| {
                self.activity
                    .get(&id(&term["termId"]))
                    .is_some_and(|old| now.saturating_sub(old.timestamp) > IDLE_THRESHOLD)
            });
        let mut alerts = vec![];
        if all_idle && now.saturating_sub(self.last_idle_nag) > HISTORY_LIFETIME {
            self.last_idle_nag = now;
            let titles = [
                "뭐해 일해.",
                "터미널이 멈춰있는뎅.. 쉬는 거야?",
                "혹시 퇴근한 거 아니지?",
                "코드 한 줄이라도 써봐.",
                "자리 비운 거면 잠금이라도 걸어둬.",
            ];
            alerts.push(alert(
                now,
                "idle:nag:global".into(),
                "idle",
                "warning",
                titles[rand::random::<u64>() as usize % titles.len()].into(),
                "10분 이상 터미널 활동 없음".into(),
                V::object(),
                "".into(),
                "".into(),
            ));
        }
        let active: HashSet<_> = terms.iter().map(|term| id(&term["termId"])).collect();
        self.activity.retain(|key, _| active.contains(key));
        Ok(alerts)
    }
    pub fn scan(&mut self, snapshot: &V, now: i64) -> Cycle {
        let mut cycle = Cycle::default();
        let result = (|| -> Result<Vec<V>, String> {
            let mut alerts = self.terminals(snapshot, now)?;
            alerts.extend(self.cicd(snapshot, now)?);
            alerts.extend(self.jira(snapshot, now)?);
            alerts.extend(self.git(snapshot, now, &mut cycle.reviews)?);
            alerts.extend(self.idle(snapshot, now)?);
            Ok(alerts)
        })();
        if let Ok(alerts) = result {
            for alert in alerts {
                self.active.push(alert.clone());
                cycle.events.push(("agent:proactive".into(), alert));
            }
            self.history
                .retain(|_, history| history.timestamp >= now.saturating_sub(HISTORY_LIFETIME));
            self.active.retain(|alert| {
                alert["timestamp"].number() >= now.saturating_sub(IDLE_THRESHOLD) as f64
            });
        }
        cycle
    }
    pub fn alerts(&self) -> V {
        let mut active = self.active.clone();
        active.sort_by(|a, b| b["timestamp"].number().total_cmp(&a["timestamp"].number()));
        V::Array(active)
    }
    pub fn reports(&self) -> V {
        V::Array(
            self.reports
                .iter()
                .filter(|report| !report["dismissed"].truthy())
                .cloned()
                .collect(),
        )
    }
    pub fn all_reports(&self) -> V {
        V::Array(self.reports.clone())
    }
    pub fn restore_reports(&mut self, rows: &V) -> Result<(), String> {
        let V::Array(rows) = rows else {
            return Err("Monitor reports must be an array".into());
        };
        for row in rows {
            if !matches!(row, V::Object(_))
                || !row["id"].is_string()
                || !row["id"].truthy()
                || !matches!(&row["timestamp"],V::Number(timestamp) if timestamp.is_finite() && timestamp.fract()==0.0 && *timestamp>=0.0)
                || !matches!(row["dismissed"], V::Bool(_))
            {
                return Err("Invalid saved monitor report".into());
            }
        }
        let mut restored = rows.clone();
        restored.sort_by(|a, b| b["timestamp"].number().total_cmp(&a["timestamp"].number()));
        restored.truncate(50);
        self.reports = restored;
        Ok(())
    }
    pub fn dismiss_alert(&mut self, alert_id: &V, now: i64) -> V {
        let found = self
            .active
            .iter()
            .position(|alert| alert["id"] == *alert_id);
        if let Some(index) = found {
            let alert = self.active.remove(index);
            if alert["_alertKey"].truthy() {
                self.history.insert(
                    id(&alert["_alertKey"]),
                    History {
                        timestamp: now,
                        dismissed: true,
                    },
                );
            }
        }
        object([("dismissed", found.is_some().into())])
    }
    pub fn clear_alerts(&mut self) -> V {
        self.active.clear();
        object([("cleared", true.into())])
    }
    pub fn dismiss_report(&mut self, report_id: &V) -> V {
        let found = self
            .reports
            .iter_mut()
            .find(|report| report["id"] == *report_id);
        let exists = found.is_some();
        if let Some(report) = found {
            report["dismissed"] = true.into();
        }
        object([("dismissed", exists.into())])
    }
    pub fn add_report(&mut self, report: &V, now: i64) -> V {
        let mut entry = object([("id", generated_id("report", now))]);
        match report {
            V::Object(values) => {
                for (key, value) in values {
                    entry[key] = value.clone();
                }
            }
            V::Array(values) => {
                for (index, value) in values.iter().enumerate() {
                    entry[&index.to_string()] = value.clone();
                }
            }
            V::String(units) => {
                for (index, unit) in units.iter().enumerate() {
                    entry[&index.to_string()] = V::String(vec![*unit]);
                }
            }
            _ => {}
        }
        entry["timestamp"] = (now as f64).into();
        entry["dismissed"] = false.into();
        self.reports.insert(0, entry.clone());
        self.reports.truncate(50);
        entry
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn normalize(value: &mut V) {
        match value {
            V::Array(values) => {
                for value in values {
                    normalize(value);
                }
            }
            V::Object(values) => {
                let idle = values.get("source") == Some(&V::from("idle"));
                for value in values.values_mut() {
                    normalize(value);
                }
                if idle {
                    values.insert("title".into(), "[idle nag]".into());
                }
                if let Some(id) = values.get("id").filter(|id| id.is_string()) {
                    static GENERATED: OnceLock<regex::Regex> = OnceLock::new();
                    if GENERATED
                        .get_or_init(|| {
                            regex::Regex::new(r"^(alert|report)-\d+-[a-z0-9]+$").unwrap()
                        })
                        .is_match(&id.text())
                    {
                        let text = id.text();
                        let prefix = text.rsplit_once('-').unwrap().0;
                        values.insert("id".into(), format!("{prefix}-ID").into());
                    }
                }
            }
            _ => {}
        }
    }
    fn json(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    #[test]
    fn original_monitor_state_and_corrected_provider_fixtures() {
        let fixtures = json(include_str!("../../tests/fixtures/rust-monitor.json"));
        let mut differences = vec![];
        for fixture in fixtures.array() {
            let mut state = State::default();
            for (index, step) in fixture["steps"].array().iter().enumerate() {
                let input = &step["input"];
                let now = input["now"].number() as i64;
                let mut cycle = Cycle::default();
                let result = match input["operation"].text().as_str() {
                    "scan" => {
                        cycle = state.scan(&input["snapshot"], now);
                        V::Null
                    }
                    "clearAlerts" => state.clear_alerts(),
                    "dismissAlert" => {
                        let alert_id = if input["key"].truthy() {
                            state
                                .alerts()
                                .array()
                                .iter()
                                .find(|alert| alert["_alertKey"] == input["key"])
                                .map(|alert| alert["id"].clone())
                                .unwrap_or_else(|| "missing".into())
                        } else {
                            or(&input["id"], &"missing".into())
                        };
                        state.dismiss_alert(&alert_id, now)
                    }
                    "addReport" => {
                        let result = state.add_report(&input["report"], now);
                        cycle.events.push(("monitor:report".into(), result.clone()));
                        result
                    }
                    "dismissReport" => {
                        let report_id = if input.has("index") {
                            state
                                .all_reports()
                                .array()
                                .get(input["index"].number() as usize)
                                .map(|report| report["id"].clone())
                                .unwrap_or_else(|| "missing".into())
                        } else {
                            or(&input["id"], &"missing".into())
                        };
                        state.dismiss_report(&report_id)
                    }
                    _ => panic!("unknown monitor fixture operation"),
                };
                let mut actual = object([
                    ("result", result),
                    (
                        "events",
                        V::Array(
                            cycle
                                .events
                                .into_iter()
                                .map(|(name, value)| V::Array(vec![name.into(), value]))
                                .collect(),
                        ),
                    ),
                    ("reviews", V::Array(cycle.reviews)),
                    ("alerts", state.alerts()),
                    ("reports", state.reports()),
                    ("allReports", state.all_reports()),
                ]);
                normalize(&mut actual);
                if actual != step["expected"] {
                    differences.push(format!(
                        "{} step {index}\nexpected: {}\nactual: {}",
                        fixture["label"].text(),
                        step["expected"].raw(),
                        actual.raw()
                    ));
                }
            }
        }
        assert!(
            differences.is_empty(),
            "{} monitor differences:\n{}",
            differences.len(),
            differences
                .iter()
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n\n")
        );
    }
    #[test]
    fn suffix_detection_handles_reset_overlap_and_repeated_text() {
        for (old, new, expected) in [
            ("abc", "abcdef", 3),
            ("ready-prefix-tail", "tail error", 4),
            ("same", "same", 4),
            ("longer", "new", 0),
            ("abc", "", 0),
            ("aaaaab", "aaberror", 3),
            ("abc-tail", "tail", 4),
        ] {
            assert_eq!(
                new_suffix(
                    &old.encode_utf16().collect::<Vec<_>>(),
                    &new.encode_utf16().collect::<Vec<_>>()
                ),
                expected,
                "{old} -> {new}"
            );
        }
        let old = vec![65; 100_000];
        let mut new = old.clone();
        new.push(66);
        assert_eq!(new_suffix(&old, &new), 100_000);
    }
    #[test]
    fn report_restore_validates_before_replacing_and_keeps_fifty_newest() {
        let mut state = State::default();
        let rows = V::Array(
            (0..55)
                .map(|index| {
                    object([
                        ("id", format!("report-{index}").into()),
                        ("timestamp", (index as f64).into()),
                        ("dismissed", (index % 2 == 0).into()),
                        ("custom", object([("preserved", true.into())])),
                    ])
                })
                .collect(),
        );
        state.restore_reports(&rows).unwrap();
        assert_eq!(state.all_reports().array().len(), 50);
        assert_eq!(state.all_reports().array()[0]["id"], V::from("report-54"));
        assert_eq!(state.all_reports().array()[49]["id"], V::from("report-5"));
        assert!(state
            .all_reports()
            .array()
            .iter()
            .all(|row| row["custom"]["preserved"] == V::Bool(true)));
        let saved = state.all_reports();
        for invalid in [
            V::Null,
            V::Array(vec![V::Null]),
            json(r#"[{"id":"","timestamp":1,"dismissed":false}]"#),
            json(r#"[{"id":"x","timestamp":"1","dismissed":false}]"#),
            json(r#"[{"id":"x","timestamp":1,"dismissed":null}]"#),
        ] {
            assert!(state.restore_reports(&invalid).is_err());
            assert_eq!(state.all_reports(), saved);
        }
        let mut invalid = rows.clone();
        invalid.array_mut().push(V::Null);
        assert!(state.restore_reports(&invalid).is_err());
        assert_eq!(state.all_reports(), saved);
    }
}
