use crate::{
    ai_transport::{self, Cancel, ClaudeOptions},
    board_value::{object, V},
    project_command,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/projects/:id/git"),
    ("GET", "/api/projects/:id/branches"),
    ("GET", "/api/projects/:id/diff"),
    ("GET", "/api/projects/:id/stash-list"),
    ("GET", "/api/projects/:id/git/log"),
    ("POST", "/api/projects/:id/git/stage"),
    ("POST", "/api/projects/:id/git/unstage"),
    ("POST", "/api/projects/:id/git/discard"),
    ("POST", "/api/projects/:id/git/commit"),
    ("POST", "/api/projects/:id/git/checkout"),
    ("POST", "/api/projects/:id/git/create-branch"),
    ("POST", "/api/projects/:id/git/delete-branch"),
    ("POST", "/api/projects/:id/push"),
    ("POST", "/api/projects/:id/pull"),
    ("POST", "/api/projects/:id/fetch"),
    ("POST", "/api/projects/:id/git/stash"),
    ("POST", "/api/projects/:id/git/stash-pop"),
    ("POST", "/api/projects/:id/git/stash-apply"),
    ("POST", "/api/projects/:id/git/stash-drop"),
    ("POST", "/api/projects/:id/auto-commit/execute"),
    ("POST", "/api/projects/:id/generate-commit-msg"),
    ("POST", "/api/projects/:id/auto-commit/plan"),
];
#[derive(Default)]
pub struct Store {
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    timings: Mutex<HashMap<String, f64>>,
    plan_rate: Mutex<Option<(Instant, u32)>>,
    ai_cancel: Cancel,
}
pub fn route(method: &Method, path: &str) -> Option<(String, String)> {
    let (id, tail) = path.strip_prefix("/api/projects/")?.split_once('/')?;
    ROUTES
        .iter()
        .any(|(verb, template)| {
            *verb == method.as_str() && template.strip_prefix("/api/projects/:id/") == Some(tail)
        })
        .then(|| (id.into(), tail.into()))
}
pub fn project(store: &crate::projects::Store, id: &str) -> Option<V> {
    store
        .list()
        .ok()?
        .into_iter()
        .filter_map(|p| V::parse(&serde_json::value::to_raw_value(&p).ok()?).ok())
        .find(|p| p["id"] == V::from(id))
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).into()).collect()
}
async fn command(p: &V, args: &[String], seconds: u64, limit: usize) -> Result<String, String> {
    project_command::run(p, "git", args, Duration::from_secs(seconds), limit)
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}
fn string_fields(parts: &[&str], keys: &[&str]) -> V {
    V::Object(
        keys.iter()
            .enumerate()
            .map(|(i, key)| {
                (
                    (*key).into(),
                    parts.get(i).unwrap_or(&"").to_string().into(),
                )
            })
            .collect(),
    )
}
fn lines(text: &str) -> Vec<&str> {
    text.split('\n').filter(|s| !s.is_empty()).collect()
}
fn parse_worktrees(text: &str) -> V {
    let mut rows = vec![];
    let mut current = V::object();
    for line in text.split('\n').chain(std::iter::once("")) {
        if let Some(path) = line.strip_prefix("worktree ") {
            current["path"] = path.replace('\\', "/").into();
        } else if let Some(branch) = line.strip_prefix("branch ") {
            current["branch"] = branch.replacen("refs/heads/", "", 1).into();
        } else if line.is_empty() {
            if current["path"].truthy() && current["branch"].truthy() {
                rows.push(current);
            }
            current = V::object();
        }
    }
    V::Array(rows)
}
fn branch(input: &V) -> bool {
    input.is_string()
        && !input.text().is_empty()
        && !input.text().starts_with('-')
        && input
            .text()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
}
fn stash_ref(input: &V) -> bool {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    input.is_string()
        && RE
            .get_or_init(|| regex::Regex::new(r"^stash@\{[0-9]{1,3}\}$").unwrap())
            .is_match(&input.text())
}
fn files(input: &V) -> Option<Vec<String>> {
    let files = input["files"].array();
    if files.is_empty()
        || files
            .iter()
            .any(|f| !f.is_string() || f.text().contains('\0'))
    {
        None
    } else {
        Some(files.iter().map(V::text).collect())
    }
}
fn parse_diff(text: &str) -> Vec<V> {
    static HEADER: OnceLock<regex::Regex> = OnceLock::new();
    let header = HEADER.get_or_init(|| regex::Regex::new(r"^diff --git a/.+ b/(.+)$").unwrap());
    let starts: Vec<_> = text
        .match_indices("diff --git ")
        .filter(|(i, _)| *i == 0 || text.as_bytes()[i - 1] == b'\n')
        .map(|(i, _)| i)
        .chain(std::iter::once(text.len()))
        .collect();
    starts
        .windows(2)
        .filter_map(|range| {
            let chunk = &text[range[0]..range[1]];
            let name = header.captures(chunk.lines().next().unwrap_or(""))?;
            let mut status = "M";
            let mut add = 0;
            let mut delete = 0;
            for line in chunk.split('\n') {
                if line.starts_with("new file mode") {
                    status = "A";
                } else if line.starts_with("deleted file mode") && status != "A" {
                    status = "D";
                } else if line.starts_with("rename from") && status == "M" {
                    status = "R";
                }
                if line.starts_with('+') && !line.starts_with("+++") {
                    add += 1;
                } else if line.starts_with('-') && !line.starts_with("---") {
                    delete += 1;
                }
            }
            Some(object([
                ("file", name[1].into()),
                ("status", status.into()),
                ("additions", (add as f64).into()),
                ("deletions", (delete as f64).into()),
            ]))
        })
        .collect()
}
fn truncated(text: String) -> V {
    let rows: Vec<_> = text.split('\n').collect();
    if rows.len() <= 3000 {
        text.into()
    } else {
        format!(
            "{}\n\n... truncated ({} total lines) ...",
            rows[..3000].join("\n"),
            rows.len()
        )
        .into()
    }
}
impl Store {
    pub fn shutdown(&self) {
        self.ai_cancel.cancel();
    }

    async fn generate(&self, id: &str, p: &V, route: &str, input: &V) -> Response {
        if self.ai_cancel.is_cancelled() {
            return crate::error(503, "Server is shutting down");
        }
        let plan = route == "auto-commit/plan";
        if plan {
            let mut rate = self.plan_rate.lock().unwrap();
            if rate
                .as_ref()
                .is_some_and(|(start, _)| start.elapsed() > Duration::from_secs(60))
            {
                *rate = None;
            }
            let entry = rate.get_or_insert((Instant::now(), 0));
            entry.1 += 1;
            if entry.1 > 5 {
                return crate::error(429, "Too many requests — please wait");
            }
        }
        let snapshot = async {
            let lock = self
                .locks
                .lock()
                .unwrap()
                .entry(id.into())
                .or_default()
                .clone();
            let _guard = lock.lock().await;
            let status_args = if plan {
                strings(&["status", "--porcelain"])
            } else {
                strings(&["diff", "--cached", "--stat"])
            };
            let staged_args = strings(&["diff", "--cached", "-U2"]);
            let unstaged_args = strings(&["diff", "-U2"]);
            let timeout = if plan { 15 } else { 10 };
            let (status, staged, unstaged) = tokio::join!(
                command(p, &status_args, timeout, 5_242_880),
                command(p, &staged_args, timeout, 5_242_880),
                async {
                    if plan {
                        command(p, &unstaged_args, timeout, 5_242_880).await
                    } else {
                        Ok(String::new())
                    }
                }
            );
            Ok::<_, String>((V::from(status?).trim(), staged?, unstaged?))
        }
        .await;
        let (status, staged, unstaged) = match snapshot {
            Ok(value) => value,
            Err(message) => return crate::error(500, &message),
        };
        if !status.truthy() {
            return if plan {
                Json(
                    object([
                        ("commits", V::Array(vec![])),
                        ("message", "No changes to commit".into()),
                    ])
                    .raw(),
                )
                .into_response()
            } else {
                crate::error(400, "No staged changes")
            };
        }
        let diff = if plan {
            V::from(format!("{staged}\n{unstaged}")).trim()
        } else {
            staged.into()
        };
        let limit = if plan { 20000 } else { 15000 };
        let truncated = diff.units().len() > limit;
        let diff = if truncated {
            format!("{}\n...(truncated)", diff.cut(limit).text())
        } else {
            diff.text()
        };
        let prompt = if plan {
            format!(
                "{}[GIT_STATUS]\n{}\n[/GIT_STATUS]\n\n[DIFF]\n{diff}\n[/DIFF]",
                if truncated {
                    "NOTE: Diff was truncated. Rely on git status for the full file list. Group unknown files by directory/purpose.\n\n"
                } else {
                    ""
                },
                status.text()
            )
        } else {
            format!(
                "[STAGED_CHANGES]\nStat:\n{}\n\nDiff:\n{diff}\n[/STAGED_CHANGES]",
                status.text()
            )
        };
        let options = ClaudeOptions {
            model: if plan && input["model"].truthy() {
                input["model"].text()
            } else {
                "haiku".into()
            },
            system_prompt: Some(if plan { PLAN_SYSTEM } else { COMMIT_SYSTEM }.into()),
            ..Default::default()
        };
        let text = match ai_transport::claude(&prompt, &options, &self.ai_cancel, |_| {}).await {
            Ok(value) => value,
            Err(message) => return crate::error(500, &message),
        };
        if !plan {
            let clean = text.trim_matches(['"', '\'', '`']).trim();
            return Json(object([("message", clean.into())]).raw()).into_response();
        }
        let raw_error = |message: &str, raw: V| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(object([("error", message.into()), ("raw", raw)]).raw()),
            )
                .into_response()
        };
        let Some(raw) = text
            .find('{')
            .zip(text.rfind('}'))
            .filter(|(start, end)| start <= end)
            .map(|(start, end)| &text[start..=end])
        else {
            return raw_error("Failed to parse AI response", text.into());
        };
        let Ok(raw_value) = serde_json::value::RawValue::from_string(raw.into()) else {
            return raw_error("Failed to parse commit plan JSON", V::from(raw).cut(500));
        };
        let Ok(mut value) = V::parse(&raw_value) else {
            return raw_error("Failed to parse commit plan JSON", V::from(raw).cut(500));
        };
        if truncated {
            value["truncated"] = true.into();
        }
        Json(value.raw()).into_response()
    }
    async fn adaptive(&self, p: &V, args: &[&str]) -> String {
        let path = p["path"].text();
        let timeout = self
            .timings
            .lock()
            .unwrap()
            .get(&path)
            .map(|n| (n * 2.5 + 1000.0).round().clamp(5000.0, 30000.0) as u64)
            .unwrap_or(10000);
        let start = Instant::now();
        let result = project_command::run(
            p,
            "git",
            &strings(args),
            Duration::from_millis(timeout),
            1_048_576,
        )
        .await;
        let mut timings = self.timings.lock().unwrap();
        let entry = timings.entry(path).or_insert(5000.0);
        match result {
            Ok(out) => {
                *entry = (*entry * 0.7 + start.elapsed().as_millis() as f64 * 0.3).round();
                String::from_utf8_lossy(&out.stdout).trim().into()
            }
            Err(e) => {
                if e.ends_with("operation timed out") {
                    *entry = (*entry * 1.5).round().min(30000.0);
                }
                String::new()
            }
        }
    }
    pub async fn status(&self, p: &V) -> V {
        let (branch, status, log, worktrees, stash) = tokio::join!(
            self.adaptive(p, &["branch", "--show-current"]),
            self.adaptive(p, &["status", "--porcelain"]),
            self.adaptive(p, &["log", "--oneline", "-5", "--format=%h|%s|%cr"]),
            self.adaptive(p, &["worktree", "list", "--porcelain"]),
            self.adaptive(p, &["stash", "list", "--format=%h"])
        );
        let remote = self.adaptive(p, &["remote", "get-url", "origin"]).await;
        let remote = remote.strip_suffix(".git").unwrap_or(&remote);
        let remote = if let Some(tail) = remote
            .strip_prefix("git@github.com:")
            .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        {
            format!("https://github.com/{tail}")
        } else {
            remote.into()
        };
        let changed = lines(&status);
        let files = changed
            .iter()
            .take(10)
            .map(|line| {
                let raw = V::from(*line);
                object([
                    ("status", raw.cut(2).trim()),
                    (
                        "file",
                        V::String(raw.units().get(3..).unwrap_or(&[]).to_vec()),
                    ),
                ])
            })
            .collect();
        object([
            ("projectId", p["id"].clone()),
            (
                "branch",
                if branch.is_empty() {
                    "unknown".into()
                } else {
                    branch.into()
                },
            ),
            ("uncommittedCount", (changed.len() as f64).into()),
            ("uncommittedTotal", (changed.len() as f64).into()),
            ("uncommittedFiles", V::Array(files)),
            (
                "recentCommits",
                V::Array(
                    lines(&log)
                        .iter()
                        .map(|l| {
                            string_fields(
                                &l.split('|').collect::<Vec<_>>(),
                                &["hash", "message", "ago"],
                            )
                        })
                        .collect(),
                ),
            ),
            ("worktrees", parse_worktrees(&worktrees)),
            ("remoteUrl", remote.into()),
            ("stashCount", (lines(&stash).len() as f64).into()),
        ])
    }
    pub async fn branches(&self, p: &V, worktrees: V) -> V {
        let (local, remote, current) = tokio::join!(
            self.adaptive(p, &["branch", "--format=%(refname:short)"]),
            self.adaptive(p, &["branch", "-r", "--format=%(refname:short)"]),
            self.adaptive(p, &["branch", "--show-current"])
        );
        object([
            ("current", current.into()),
            (
                "local",
                V::Array(lines(&local).iter().map(|s| V::from(*s)).collect()),
            ),
            (
                "remote",
                V::Array(
                    lines(&remote)
                        .iter()
                        .filter(|s| !s.contains("/HEAD"))
                        .map(|s| V::from(*s))
                        .collect(),
                ),
            ),
            ("worktrees", worktrees),
        ])
    }
    async fn diff(&self, p: &V) -> V {
        let staged_args = strings(&["diff", "--cached", "-U3"]);
        let unstaged_args = strings(&["diff", "-U3"]);
        let status_args = strings(&["status", "--porcelain"]);
        let (staged, unstaged, status) = tokio::join!(
            command(p, &staged_args, 10, 5_242_880),
            command(p, &unstaged_args, 10, 5_242_880),
            command(p, &status_args, 10, 5_242_880)
        );
        let (staged, unstaged, status) = match (staged, unstaged, status) {
            (Ok(a), Ok(b), Ok(c)) => (a, b, c),
            _ => (String::new(), String::new(), String::new()),
        };
        let staged_files = parse_diff(&staged);
        let mut unstaged_files = parse_diff(&unstaged);
        let tracked: std::collections::HashSet<_> = staged_files
            .iter()
            .chain(&unstaged_files)
            .map(|f| f["file"].text())
            .collect();
        for line in lines(&status) {
            let raw = V::from(line);
            let code = raw.cut(2);
            let file = V::String(raw.units().get(3..).unwrap_or(&[]).to_vec());
            if !file.truthy() || tracked.contains(&file.text()) {
                continue;
            }
            let status = if code == V::from("??") {
                "?".into()
            } else if code.trim().truthy() {
                let units = code.units();
                let c = if units.first().is_some_and(|c| *c != 32 && *c != 63) {
                    units.first()
                } else {
                    units.get(1)
                };
                c.map(|c| V::String(vec![*c])).unwrap_or_else(|| "M".into())
            } else {
                continue;
            };
            unstaged_files.push(object([
                ("file", file),
                ("status", status),
                ("additions", 0.0.into()),
                ("deletions", 0.0.into()),
            ]));
        }
        object([
            ("projectId", p["id"].clone()),
            (
                "staged",
                object([
                    ("diff", truncated(staged)),
                    ("files", V::Array(staged_files)),
                ]),
            ),
            (
                "unstaged",
                object([
                    ("diff", truncated(unstaged)),
                    ("files", V::Array(unstaged_files)),
                ]),
            ),
        ])
    }
    pub async fn handle(
        &self,
        projects: &crate::projects::Store,
        raw_id: &str,
        route: &str,
        query: &HashMap<String, String>,
        input: V,
        worktrees: V,
    ) -> Response {
        let Some(id) = crate::decoded_id(raw_id) else {
            return crate::error(400, "Invalid project ID");
        };
        let Some(p) = project(projects, &id) else {
            return crate::error(404, "Not found");
        };
        if matches!(route, "generate-commit-msg" | "auto-commit/plan") {
            return self.generate(&id, &p, route, &input).await;
        }
        let result = match route {
            "git" => Ok(self.status(&p).await),
            "branches" => Ok(self.branches(&p, worktrees).await),
            "diff" => Ok(self.diff(&p).await),
            "stash-list" => {
                let out = command(
                    &p,
                    &strings(&["stash", "list", "--format=%gd|%s|%cr"]),
                    5,
                    1_048_576,
                )
                .await
                .unwrap_or_default();
                Ok(object([
                    ("projectId", p["id"].clone()),
                    (
                        "stashes",
                        V::Array(
                            lines(out.trim())
                                .iter()
                                .map(|l| {
                                    string_fields(
                                        &l.split('|').collect::<Vec<_>>(),
                                        &["ref", "message", "ago"],
                                    )
                                })
                                .collect(),
                        ),
                    ),
                ]))
            }
            "git/log" => {
                let limit = query
                    .get("limit")
                    .filter(|s| !s.is_empty())
                    .map(String::as_str)
                    .unwrap_or("30");
                let limit = parse_int(limit)
                    .map(|n| n.min(100).to_string())
                    .unwrap_or_else(|| "NaN".into());
                let out = command(
                    &p,
                    &strings(&[
                        "log",
                        &format!("--max-count={limit}"),
                        "--format=%H|%h|%an|%ae|%ar|%s",
                    ]),
                    10,
                    524288,
                )
                .await
                .unwrap_or_default();
                let commits = lines(out.trim())
                    .iter()
                    .map(|line| {
                        let fields: Vec<_> = line.split('|').collect();
                        let mut value =
                            string_fields(&fields, &["hash", "short", "author", "email", "ago"]);
                        value["message"] = fields.get(5..).unwrap_or(&[]).join("|").into();
                        value
                    })
                    .collect();
                Ok(object([
                    ("projectId", p["id"].clone()),
                    ("commits", V::Array(commits)),
                ]))
            }
            _ => {
                let lock = self.locks.lock().unwrap().entry(id).or_default().clone();
                let _guard = lock.lock().await;
                self.mutate(&p, route, &input).await
            }
        };
        match result {
            Ok(value) => Json(value.raw()).into_response(),
            Err((status, message)) => crate::error(status, &message),
        }
    }
    async fn mutate(&self, p: &V, route: &str, input: &V) -> Result<V, (u16, String)> {
        let run = |args: Vec<String>, secs| async move {
            command(p, &args, secs, 1_048_576)
                .await
                .map_err(|e| (500, e))
        };
        let mut result = object([("success", true.into())]);
        match route {
            "git/stage" | "git/unstage" | "git/discard" | "auto-commit/execute" => {
                let files = files(input).ok_or_else(|| {
                    (
                        400,
                        if route == "auto-commit/execute" {
                            "message and files required"
                        } else {
                            "files required"
                        }
                        .into(),
                    )
                })?;
                let all = files[0] == "--all";
                match route {
                    "git/stage" => {
                        run(
                            if all {
                                strings(&["add", "-A"])
                            } else {
                                strings(&["add", "--"]).into_iter().chain(files).collect()
                            },
                            10,
                        )
                        .await?;
                    }
                    "git/unstage" => {
                        run(
                            if all {
                                strings(&["reset", "HEAD"])
                            } else {
                                strings(&["reset", "HEAD", "--"])
                                    .into_iter()
                                    .chain(files)
                                    .collect()
                            },
                            10,
                        )
                        .await?;
                    }
                    "git/discard" => {
                        let _ = run(
                            strings(&["checkout", "--"])
                                .into_iter()
                                .chain(files.clone())
                                .collect(),
                            10,
                        )
                        .await;
                        let _ = run(
                            strings(&["clean", "-f", "--"])
                                .into_iter()
                                .chain(files)
                                .collect(),
                            10,
                        )
                        .await;
                    }
                    _ => {
                        if !input["message"].is_string() || !input["message"].truthy() {
                            return Err((400, "message and files required".into()));
                        }
                        let _ = run(strings(&["reset", "HEAD"]), 10).await;
                        run(
                            strings(&["add", "--"]).into_iter().chain(files).collect(),
                            10,
                        )
                        .await?;
                        run(strings(&["commit", "-m", &input["message"].text()]), 10).await?;
                        let status = run(strings(&["status", "--porcelain"]), 10)
                            .await
                            .unwrap_or_default();
                        result["message"] = input["message"].clone();
                        result["files"] = input["files"].clone();
                        result["remaining"] = (lines(status.trim()).len() as f64).into();
                    }
                }
            }
            "git/commit" => {
                if !input["message"].is_string() || !input["message"].truthy() {
                    return Err((400, "message required".into()));
                }
                run(strings(&["commit", "-m", &input["message"].text()]), 10).await?;
            }
            "git/checkout" | "git/create-branch" | "git/delete-branch" => {
                if !branch(&input["branch"]) {
                    return Err((400, "Invalid branch name".into()));
                }
                let name = input["branch"].text();
                if route == "git/delete-branch" && ["main", "master"].contains(&name.as_str()) {
                    return Err((400, "Cannot delete main/master".into()));
                }
                if route == "git/checkout" {
                    if run(strings(&["switch", &name]), 15).await.is_err() {
                        run(strings(&["checkout", &name]), 15).await?;
                    }
                } else {
                    run(
                        strings(&[
                            if route == "git/create-branch" {
                                "checkout"
                            } else {
                                "branch"
                            },
                            if route == "git/create-branch" {
                                "-b"
                            } else {
                                "-D"
                            },
                            &name,
                        ]),
                        10,
                    )
                    .await?;
                }
                result["branch"] = input["branch"].clone();
            }
            "push" | "pull" | "fetch" => {
                let args = if route == "fetch" {
                    strings(&["fetch", "--all", "--prune"])
                } else {
                    strings(&[route])
                };
                let out = project_command::run(p, "git", &args, Duration::from_secs(30), 1_048_576)
                    .await
                    .map_err(|e| (500, e))?;
                result["output"] = format!(
                    "{} {}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                )
                .trim()
                .to_string()
                .into();
            }
            "git/stash" => {
                let message = if input["message"].truthy() {
                    input["message"].text()
                } else {
                    format!(
                        "Cockpit stash {}",
                        crate::account_usage::iso(crate::account_usage::now())
                    )
                };
                let mut args = strings(&["stash", "push", "-m", &message]);
                if input["includeUntracked"].truthy() {
                    args.push("-u".into());
                }
                run(args, 10).await?;
            }
            "git/stash-pop" | "git/stash-apply" | "git/stash-drop" => {
                let reference = if input["ref"].truthy() {
                    input["ref"].clone()
                } else if route == "git/stash-pop" {
                    V::Null
                } else {
                    "stash@{0}".into()
                };
                if reference.truthy() && !stash_ref(&reference) {
                    return Err((400, "Invalid stash ref".into()));
                }
                let mut args = strings(&["stash", route.strip_prefix("git/stash-").unwrap()]);
                if reference.truthy() {
                    args.push(reference.text());
                }
                run(args, 10).await?;
            }
            _ => return Err((501, "Git migration incomplete".into())),
        }
        Ok(result)
    }
}
pub(crate) fn parse_int(input: &str) -> Option<i64> {
    let s = input.trim_start();
    let (negative, s) = if let Some(s) = s.strip_prefix('-') {
        (true, s)
    } else {
        (false, s.strip_prefix('+').unwrap_or(s))
    };
    let (radix, s) = if s.starts_with("0x") || s.starts_with("0X") {
        (16, &s[2..])
    } else {
        (10, s)
    };
    let digits: String = s.chars().take_while(|c| c.is_digit(radix)).collect();
    let n = i64::from_str_radix(&digits, radix).ok()?;
    Some(if negative { -n } else { n })
}

const COMMIT_SYSTEM: &str = r#"You are a precise git commit message generator. Output ONLY the commit message — no quotes, no markdown fences, no explanation.
Rules:
- Conventional commits: feat:, fix:, refactor:, docs:, style:, chore:, test:
- First line: type(scope): description (max 72 chars)
- Scope = primary module or directory affected
- Describe WHY the change was made, not WHAT changed (the diff shows what)
- If multiple unrelated changes are staged, use the dominant change type
- For complex changes, add a blank line then bullet points for details"#;

const PLAN_SYSTEM: &str = r#"You are a git commit planner. Analyze changed files and group them into logical, atomic commits. Output ONLY valid JSON, no markdown fences.

Rules:
- Group related changes: same feature, same bug fix, same refactor
- Conventional commits: feat: (new feature), fix: (bug fix), refactor: (restructure), docs:, style: (formatting), chore: (deps/config/build), test:
- Concise but descriptive messages in English
- Include ALL files from git status (use file paths from status, not diff headers)
- File paths from status are in column 4+ (after the 2-char status and a space)
- For renamed files (R status), use the new path
- Order: dependencies/config first, then core logic, then UI, then tests
- Prefer fewer commits (2-5) with clear logical grouping over many tiny commits
- If unsure about a file's purpose, group it with nearby directory siblings

Output schema: {"commits":[{"message":"type(scope): description","files":["file1","file2"],"reasoning":"why grouped"}]}

Example:
{"commits":[
  {"message":"feat(auth): add user authentication middleware","files":["src/middleware/auth.ts","src/types/auth.ts"],"reasoning":"All related to the new auth feature"},
  {"message":"chore(deps): update dependencies and config","files":["package.json","package-lock.json"],"reasoning":"Dependency updates"}
]}"#;
