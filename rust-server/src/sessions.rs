use crate::{
    account_hub::safe_path,
    account_usage::{date, iso, now},
    board_value::{object, V},
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/claude-sessions"),
    ("GET", "/api/claude-session"),
    ("GET", "/api/projects/:id/sessions"),
    ("GET", "/api/projects/:id/sessions/:sessionId/messages"),
    ("GET", "/api/projects/:id/sessions/:sessionId/timeline"),
    ("GET", "/api/activity"),
    ("POST", "/api/agent/delegate-status"),
    ("GET", "/api/discover-projects"),
];
pub fn route(method: &Method, path: &str) -> bool {
    if *method == Method::POST {
        return path == "/api/agent/delegate-status";
    }
    if *method != Method::GET {
        return false;
    }
    if matches!(
        path,
        "/api/claude-sessions" | "/api/claude-session" | "/api/activity" | "/api/discover-projects"
    ) {
        return true;
    }
    let Some((_, rest)) = path
        .strip_prefix("/api/projects/")
        .and_then(|s| s.split_once('/'))
    else {
        return false;
    };
    let parts: Vec<_> = rest.split('/').collect();
    matches!(
        parts.as_slice(),
        ["sessions"] | ["sessions", _, "messages" | "timeline"]
    )
}
struct SessionFile {
    path: PathBuf,
    name: String,
    mtime: f64,
    size: u64,
}
pub struct Store {
    directory: PathBuf,
    home: PathBuf,
    delegate_directory: PathBuf,
    titles: Mutex<Vec<(PathBuf, f64, u64, V)>>,
    delegates: Mutex<HashMap<String, V>>,
}
fn parse(text: &str) -> Option<V> {
    V::parse(&serde_json::value::RawValue::from_string(text.into()).ok()?).ok()
}
fn model(value: &V) -> V {
    if !value.is_string() {
        return V::Null;
    }
    let mut units = value.units().to_vec();
    let prefix: Vec<_> = "claude-".encode_utf16().collect();
    if let Some(at) = units.windows(prefix.len()).position(|part| part == prefix) {
        units.drain(at..at + prefix.len());
    }
    if units.len() >= 9
        && units[units.len() - 9] == 45
        && units[units.len() - 8..]
            .iter()
            .all(|c| (48..=57).contains(c))
    {
        units.truncate(units.len() - 9);
    }
    V::String(units)
}
fn time(value: &V) -> Option<i64> {
    if value.is_string() {
        date(&value.text())
    } else {
        let number = value.number();
        (number.is_finite() && number.abs() <= 8.64e15).then_some(number as i64)
    }
}
fn names(path: &Path) -> io::Result<Vec<String>> {
    let mut result = fs::read_dir(path)?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<io::Result<Vec<_>>>()?;
    result.sort();
    Ok(result)
}
fn tail(path: &Path, count: usize) -> Vec<String> {
    let read = || -> io::Result<String> {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(
            file.metadata()?.len().saturating_sub(16384),
        ))?;
        let mut bytes = Vec::new();
        file.take(16384).read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    };
    let text = read().unwrap_or_default();
    let lines: Vec<_> = text
        .split('\n')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    lines[lines.len().saturating_sub(count)..].to_vec()
}
fn read_view(
    path: &Path,
    limit: usize,
    view: impl FnOnce(&mut dyn Iterator<Item = V>) -> V,
) -> io::Result<V> {
    project_records(BufReader::new(File::open(path)?), limit, view)
}
fn project_records(
    reader: impl BufRead,
    limit: usize,
    view: impl FnOnce(&mut dyn Iterator<Item = V>) -> V,
) -> io::Result<V> {
    let mut failure = None;
    let mut rows = reader
        .split(b'\n')
        .take(limit)
        .map_while(|line| match line {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                failure = Some(e);
                None
            }
        })
        .filter_map(|bytes| parse(&String::from_utf8_lossy(&bytes)));
    let result = view(&mut rows);
    drop(rows);
    if let Some(error) = failure {
        Err(error)
    } else {
        Ok(result)
    }
}
impl Store {
    pub fn new(directory: PathBuf) -> Self {
        let home = directory.join("home");
        let delegate_directory = directory.join("delegate-status");
        Self::new_legacy(directory, home, delegate_directory)
    }
    pub fn new_legacy(directory: PathBuf, home: PathBuf, delegate_directory: PathBuf) -> Self {
        Self {
            directory,
            home,
            delegate_directory,
            titles: Mutex::new(vec![]),
            delegates: Mutex::new(HashMap::new()),
        }
    }
    fn safe(&self, path: &Path) -> bool {
        safe_path(&self.directory, path) || safe_path(&self.home, path)
    }
    pub fn handle(
        &self,
        path: &str,
        query: &HashMap<String, String>,
        projects: &crate::projects::Store,
    ) -> Response {
        if path == "/api/discover-projects" {
            return match projects.list() {
                Ok(projects) => Json(self.discover(&projects).raw()).into_response(),
                Err(_) => crate::error(500, "Project storage operation failed"),
            };
        }
        let result = if matches!(path, "/api/claude-sessions" | "/api/claude-session") {
            let Some(project) = query.get("projectPath").filter(|s| !s.is_empty()) else {
                return if path == "/api/claude-sessions" {
                    (
                        axum::http::StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({})),
                    )
                        .into_response()
                } else {
                    crate::error(400, "projectPath required")
                };
            };
            self.chat(
                project,
                query.get("sessionId"),
                path == "/api/claude-sessions",
            )
        } else {
            let Some((id, operation)) = path
                .strip_prefix("/api/projects/")
                .and_then(|s| s.split_once('/'))
            else {
                return crate::error(404, "Not found");
            };
            let Some(id) = crate::decoded_id(id) else {
                return crate::error(400, "Invalid project ID");
            };
            let Some(project) = crate::git::project(projects, &id) else {
                return crate::error(404, "Not found");
            };
            let parts: Vec<_> = operation.split('/').collect();
            if parts.len() == 1 {
                Ok(self.list(&project))
            } else {
                let id = parts[1];
                if id.is_empty() || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
                    return crate::error(400, "Invalid sessionId");
                }
                self.project_view(&project, id, parts[2] == "timeline")
            }
        };
        match result {
            Ok(value) => Json(value.raw()).into_response(),
            Err(_) => crate::error(500, "Failed to read session data"),
        }
    }
    fn root(&self) -> PathBuf {
        self.home.join(".claude/projects")
    }

    fn discover(&self, registered: &[crate::json_values::Object]) -> V {
        use std::collections::HashSet;
        let mut seen: HashSet<String> = registered
            .iter()
            .filter_map(|p| {
                p.get("path")
                    .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
            })
            .map(|path| path.replace('\\', "/").to_lowercase())
            .collect();
        let mut found: Vec<(String, usize)> = vec![];
        fn insert(
            path: String,
            count: usize,
            seen: &mut HashSet<String>,
            found: &mut Vec<(String, usize)>,
        ) {
            let path = path.replace('\\', "/");
            if seen.insert(path.to_lowercase()) {
                found.push((path, count));
            }
        }
        fn scan(
            dir: &Path,
            depth: usize,
            seen: &mut HashSet<String>,
            found: &mut Vec<(String, usize)>,
        ) {
            if depth > 4 {
                return;
            }
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            if entries.iter().any(|e| e.file_name() == ".git") {
                insert(dir.to_string_lossy().into_owned(), 0, seen, found);
                return;
            }
            for entry in entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.')
                    || [
                        "node_modules",
                        "dist",
                        "build",
                        "target",
                        "venv",
                        "__pycache__",
                    ]
                    .contains(&name.as_str())
                {
                    continue;
                }
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    scan(&entry.path(), depth + 1, seen, found);
                }
            }
        }
        let home = &self.home;
        let mut roots: Vec<_> = [
            "projects",
            "Projects",
            "code",
            "Code",
            "dev",
            "Dev",
            "repos",
            "workspace",
            "Workspace",
            "src",
            "work",
            "git",
        ]
        .iter()
        .map(|name| home.join(name))
        .collect();
        if let Some(extra) = std::env::var_os("COCKPIT_PROJECT_ROOTS") {
            roots.extend(std::env::split_paths(&extra));
        }
        for root in roots {
            // Native home discovery remains inside the configured home. Additional
            // roots are explicit operator configuration, like registered projects.
            if root.starts_with(home) && !self.safe(&root) {
                continue;
            }
            scan(&root, 0, &mut seen, &mut found);
        }
        let history = home.join(".claude/history.jsonl");
        if self.safe(&history) {
            let _ = read_view(&history, usize::MAX, |rows| {
                for row in rows {
                    if row["project"].is_string() && row["project"].truthy() {
                        insert(row["project"].text(), 0, &mut seen, &mut found);
                    }
                }
                V::Null
            });
        }
        let encoded = |path: &str| {
            path.encode_utf16()
                .map(|c| {
                    if c < 128 && (c as u8).is_ascii_alphanumeric() {
                        c as u8 as char
                    } else {
                        '-'
                    }
                })
                .collect::<String>()
                .to_lowercase()
        };
        let mut encoded_seen: HashSet<_> = seen.iter().map(|path| encoded(path)).collect();
        let root = self.root();
        if self.safe(&root) {
            for name in names(&root).unwrap_or_default() {
                let dir = root.join(&name);
                if !self.safe(&dir) || !dir.is_dir() || encoded_seen.contains(&name.to_lowercase())
                {
                    continue;
                }
                let Ok(files) = self.files(&dir) else {
                    continue;
                };
                let Some(latest) = files.first() else {
                    continue;
                };
                let cwd = tail(&latest.path, 20)
                    .iter()
                    .filter_map(|line| parse(line))
                    .find(|row| row["cwd"].is_string() && row["cwd"].truthy())
                    .map(|row| row["cwd"].clone())
                    .or_else(|| {
                        read_view(&latest.path, 20, |rows| {
                            for row in rows {
                                if row["cwd"].is_string() && row["cwd"].truthy() {
                                    return row["cwd"].clone();
                                }
                            }
                            V::Null
                        })
                        .ok()
                        .filter(V::truthy)
                    });
                if let Some(cwd) = cwd {
                    let path = cwd.text().replace('\\', "/");
                    encoded_seen.insert(encoded(&path));
                    insert(path, files.len(), &mut seen, &mut found);
                }
            }
        }
        let mut results = vec![];
        for (path, mut count) in found {
            if !Path::new(&path).exists() || !Path::new(&path).join(".git").exists() {
                continue;
            }
            let mut last = V::Null;
            if let Some(files) = self
                .project_dir(&path, false)
                .and_then(|dir| self.files(&dir).ok())
            {
                if count == 0 {
                    count = files.len();
                }
                if let Some(file) = files.first() {
                    last = iso(file.mtime as i64).into();
                }
            }
            results.push(object([
                ("name", path.rsplit('/').next().unwrap_or("").into()),
                ("path", path.into()),
                ("hasGit", true.into()),
                ("sessionCount", V::Number(count as f64)),
                ("lastActivity", last),
            ]));
        }
        let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .filter_map(|key| std::env::var(key).ok())
            .find(|value| !value.is_empty())
            .unwrap_or_default();
        let locale = locale
            .split(['.', '@'])
            .next()
            .unwrap_or("")
            .replace('_', "-");
        let locale = if matches!(locale.as_str(), "C" | "POSIX" | "") {
            "en-US"
        } else {
            &locale
        };
        let locale = locale
            .parse::<icu_locale::Locale>()
            .unwrap_or_else(|_| "en-US".parse().expect("valid built-in locale"));
        let collator = icu_collator::Collator::try_new(locale.into(), Default::default())
            .or_else(|_| icu_collator::Collator::try_new(Default::default(), Default::default()))
            .expect("compiled default collation data");
        results.sort_by(
            |a, b| match (a["lastActivity"].truthy(), b["lastActivity"].truthy()) {
                (true, true) => b["lastActivity"].text().cmp(&a["lastActivity"].text()),
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => collator.compare(&a["name"].text(), &b["name"].text()),
            },
        );
        V::Array(results)
    }
    fn project_dir(&self, path: &str, exact: bool) -> Option<PathBuf> {
        let encoded: String = if exact {
            path.replace(['/', '\\'], "-")
        } else {
            path.encode_utf16()
                .map(|c| {
                    if c < 128 && (c as u8).is_ascii_alphanumeric() {
                        c as u8 as char
                    } else {
                        '-'
                    }
                })
                .collect()
        };
        let root = self.root();
        let target = root.join(&encoded);
        if self.safe(&target) && target.is_dir() {
            return Some(target);
        }
        if exact || !self.safe(&root) {
            return None;
        }
        let dirs = names(&root).ok()?;
        let name = dirs
            .iter()
            .find(|name| name.to_lowercase() == encoded.to_lowercase())
            .or_else(|| {
                dirs.iter().find(|name| {
                    name.to_lowercase()
                        .ends_with(&path.rsplit('/').next().unwrap_or("").to_lowercase())
                })
            })?;
        let target = root.join(name);
        (self.safe(&target) && target.is_dir()).then_some(target)
    }
    fn files(&self, dir: &Path) -> io::Result<Vec<SessionFile>> {
        let mut files = vec![];
        for name in names(dir)?
            .into_iter()
            .filter(|name| name.ends_with(".jsonl"))
        {
            let path = dir.join(&name);
            if !self.safe(&path) {
                continue;
            }
            let metadata = fs::metadata(&path)?;
            if !metadata.is_file() {
                continue;
            }
            let stamp = metadata
                .modified()?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            files.push(SessionFile {
                path,
                name,
                size: metadata.len(),
                mtime: stamp.as_secs() as f64 * 1000.0 + stamp.subsec_nanos() as f64 / 1_000_000.0,
            });
        }
        files.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
        Ok(files)
    }
    fn claude_state(&self, project: &V) -> V {
        let mut result = object([
            ("projectId", project["id"].clone()),
            ("state", "no_data".into()),
            ("sessionId", V::Null),
            ("lastActivity", V::Null),
            ("model", V::Null),
        ]);
        let Some(dir) = self.project_dir(&project["path"].text(), false) else {
            return result;
        };
        let Ok(files) = self.files(&dir) else {
            return result;
        };
        let Some(latest) = files.first() else {
            result["state"] = "no_sessions".into();
            return result;
        };
        let last = tail(&latest.path, 3)
            .iter()
            .rev()
            .find_map(|line| parse(line).filter(V::truthy))
            .unwrap_or(V::Null);
        let age = now() as f64 - latest.mtime;
        result["state"] = if age < 15000.0 {
            "busy"
        } else if age < 300000.0 && last["type"] == V::from("assistant") {
            "waiting"
        } else {
            "idle"
        }
        .into();
        result["sessionId"] = latest.name.replacen(".jsonl", "", 1).into();
        result["lastActivity"] = iso(latest.mtime as i64).into();
        result["model"] = model(&last["message"]["model"]);
        result["sessionCount"] = (files.len() as f64).into();
        result
    }
    fn db(&self) -> Option<Connection> {
        let path = std::env::var_os("COCKPIT_OPENCODE_DB")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join(".local/share/opencode/opencode.db"));
        if !self.safe(&path) || !path.is_file() {
            return None;
        }
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()?;
        db.busy_timeout(std::time::Duration::ZERO).ok()?;
        Some(db)
    }
    fn opencode_state(&self, project: &V) -> Option<V> {
        let read = || -> rusqlite::Result<Option<V>> {
            let Some(db) = self.db() else {
                return Ok(None);
            };
            let path = project["path"].text();
            let row = |r: &rusqlite::Row<'_>| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, f64>(2)?,
                ))
            };
            let found = db.query_row("SELECT id, model, time_updated FROM session WHERE directory = ? AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 1", [&path], row).optional()?;
            let found = match found { Some(v) => Some(v), None => db.query_row("SELECT id, model, time_updated FROM session WHERE directory LIKE ? AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 5", [format!("{path}/%")], row).optional()? };
            let Some((id, raw_model, updated)) = found else {
                return Ok(None);
            };
            let age = now() as f64 - updated;
            if age >= 300000.0 || !updated.is_finite() {
                return Ok(None);
            }
            let state = if age < 15000.0 {
                "busy"
            } else {
                let last = db.query_row("SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1", [&id], |r| r.get::<_,String>(0)).optional()?;
                if last
                    .as_deref()
                    .and_then(parse)
                    .is_some_and(|v| v["role"] == V::from("assistant"))
                {
                    "waiting"
                } else {
                    "idle"
                }
            };
            let parsed = raw_model.as_deref().and_then(parse).unwrap_or(V::Null);
            Ok(Some(object([
                ("projectId", project["id"].clone()),
                ("state", state.into()),
                ("sessionId", id.into()),
                ("lastActivity", iso(updated as i64).into()),
                (
                    "model",
                    if parsed["id"].truthy() {
                        parsed["id"].clone()
                    } else {
                        V::Null
                    },
                ),
            ])))
        };
        read().ok().flatten()
    }
    pub fn state(&self, project: &V) -> V {
        let mut result = self.claude_state(project);
        if let Some(other) = self.opencode_state(project) {
            let rank = |v: &V| match v["state"].text().as_str() {
                "busy" => 3,
                "waiting" => 2,
                "idle" => 1,
                _ => 0,
            };
            if rank(&other) > rank(&result)
                || (rank(&other) == rank(&result)
                    && result["state"] != V::from("idle")
                    && time(&other["lastActivity"]) > time(&result["lastActivity"]))
            {
                result = other;
            }
        }
        let mut runs = self.delegates.lock().unwrap();
        runs.retain(|_, run| now() as f64 - run["updatedAt"].number() <= 15000.0);
        if let Some(run) = runs
            .values()
            .filter(|r| r["projectId"] == project["id"])
            .max_by(|a, b| a["updatedAt"].number().total_cmp(&b["updatedAt"].number()))
        {
            result["state"] = "busy".into();
            result["model"] = run["model"].clone();
            result["delegated"] = true.into();
            result["delegateRunId"] = run["runId"].clone();
        }
        result
    }
    pub fn list(&self, project: &V) -> V {
        let mut result = self
            .project_dir(&project["path"].text(), false)
            .and_then(|dir| self.files(&dir).ok())
            .unwrap_or_default()
            .into_iter()
            .take(10)
            .map(|f| {
                object([
                    ("sessionId", f.name.replacen(".jsonl", "", 1).into()),
                    ("lastModified", iso(f.mtime as i64).into()),
                    ("sizeKB", (f.size as f64 / 1024.0).round().into()),
                ])
            })
            .collect::<Vec<_>>();
        let read = || -> rusqlite::Result<Vec<V>> {
            let Some(db) = self.db() else {
                return Ok(vec![]);
            };
            let path = project["path"].text();
            let mut statement = db.prepare("SELECT id, title, time_updated FROM session WHERE (directory = ? OR directory LIKE ?) AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?")?;
            let rows =
                statement.query_map(rusqlite::params![path, format!("{path}/%"), 10], |r| {
                    let id: String = r.get(0)?;
                    let title: Option<String> = r.get(1)?;
                    let updated: f64 = r.get(2)?;
                    Ok(object([
                        ("sessionId", format!("oc:{id}").into()),
                        ("lastModified", iso(updated as i64).into()),
                        ("sizeKB", 0.0.into()),
                        ("source", "opencode".into()),
                        ("model", "OpenCode".into()),
                        ("title", V::from(title.unwrap_or_default()).cut(80)),
                    ]))
                })?;
            rows.collect()
        };
        result.extend(read().unwrap_or_default());
        result.sort_by(|a, b| time(&b["lastModified"]).cmp(&time(&a["lastModified"])));
        result.truncate(10);
        V::Array(result)
    }
    pub fn project_view(&self, project: &V, id: &str, timeline: bool) -> io::Result<V> {
        let empty = || {
            if timeline {
                object([("events", V::Array(vec![])), ("summary", V::Null)])
            } else {
                V::Array(vec![])
            }
        };
        let Some(dir) = self.project_dir(&project["path"].text(), false) else {
            return Ok(empty());
        };
        let path = dir.join(format!("{id}.jsonl"));
        if !self.safe(&path) || !path.is_file() {
            return Ok(empty());
        }
        read_view(&path, usize::MAX, |values| {
            if timeline {
                crate::session_views::timeline(values)
            } else {
                crate::session_views::messages(values)
            }
        })
    }
    pub fn chat(&self, project_path: &str, session: Option<&String>, list: bool) -> io::Result<V> {
        let empty = || {
            if list {
                object([("sessions", V::Array(vec![]))])
            } else {
                object([("messages", V::Array(vec![])), ("session", V::Null)])
            }
        };
        let Some(dir) = self.project_dir(project_path, true) else {
            return Ok(empty());
        };
        let files = self.files(&dir)?;
        let Some(first) = files.first() else {
            return Ok(empty());
        };
        if list {
            let mut cache = self.titles.lock().unwrap();
            let mut sessions = vec![];
            for f in files {
                let title = if let Some(entry) = cache
                    .iter()
                    .find(|c| c.0 == f.path && c.1 == f.mtime && c.2 == f.size)
                {
                    entry.3.clone()
                } else {
                    let title =
                        read_view(&f.path, 50, |values| crate::session_views::title(values))
                            .unwrap_or_else(|_| "".into());
                    if let Some(entry) = cache.iter_mut().find(|c| c.0 == f.path) {
                        *entry = (f.path.clone(), f.mtime, f.size, title.clone());
                    } else {
                        cache.push((f.path.clone(), f.mtime, f.size, title.clone()));
                    }
                    if cache.len() > 500 {
                        cache.remove(0);
                    }
                    title
                };
                sessions.push(object([
                    (
                        "id",
                        f.name.strip_suffix(".jsonl").unwrap_or(&f.name).into(),
                    ),
                    ("file", f.name.into()),
                    ("mtime", f.mtime.into()),
                    ("size", (f.size as f64).into()),
                    ("title", title),
                ]));
            }
            return Ok(object([("sessions", V::Array(sessions))]));
        }
        let selected = session
            .filter(|s| !s.is_empty())
            .and_then(|id| {
                files
                    .iter()
                    .filter(|f| f.name == format!("{id}.jsonl") || f.name.starts_with(id.as_str()))
                    .min_by(|a, b| a.name.cmp(&b.name))
            })
            .unwrap_or(first);
        let mut result = read_view(&selected.path, usize::MAX, |values| {
            crate::session_views::chat(values)
        })?;
        result["session"] = selected.name.clone().into();
        result["mtime"] = selected.mtime.into();
        Ok(result)
    }
    pub fn activity(&self) -> V {
        let path = self.home.join(".claude/history.jsonl");
        if !self.safe(&path) || !path.is_file() {
            return V::Array(vec![]);
        }
        V::Array(
            tail(&path, 90)
                .iter()
                .rev()
                .filter_map(|line| {
                    let v = parse(line)?;
                    if !v["project"].is_string() || !v["project"].truthy() {
                        return None;
                    }
                    let path = v["project"].text().replace('\\', "/");
                    let mut result = object([
                        (
                            "command",
                            if v["display"].truthy() {
                                v["display"].clone()
                            } else {
                                "".into()
                            },
                        ),
                        ("project", path.rsplit('/').next().unwrap_or("").into()),
                        ("projectPath", path.into()),
                        ("timestamp", iso(time(&v["timestamp"])?).into()),
                    ]);
                    if v.has("sessionId") {
                        result["sessionId"] = v["sessionId"].clone();
                    }
                    Some(result)
                })
                .take(30)
                .collect(),
        )
    }
    pub fn delegate(
        &self,
        event: &V,
        projects: &crate::projects::Store,
        terminals: &crate::terminals::Store,
    ) -> Option<V> {
        if !valid_delegate(event) {
            return None;
        }
        let term = event["termId"].text();
        let linked = terminals
            .reference(&term, false)
            .and_then(|(v, _)| v["projectId"].as_str().map(String::from));
        let project = if let Some(id) = linked {
            crate::git::project(projects, &id)
        } else {
            let cwd = normalized(&event["cwd"].text());
            if !event["cwd"].truthy() {
                return None;
            }
            projects
                .list()
                .ok()?
                .iter()
                .filter_map(|p| V::parse(&serde_json::value::to_raw_value(p).ok()?).ok())
                .filter(|p| {
                    let path = normalized(&p["path"].text());
                    cwd == path || cwd.starts_with(&format!("{path}/"))
                })
                .max_by_key(|p| normalized(&p["path"].text()).len())
        }?;
        let mut runs = self.delegates.lock().unwrap();
        if event["state"] == V::from("done") {
            runs.remove(&event["runId"].text());
        } else {
            runs.insert(
                event["runId"].text(),
                object([
                    ("runId", event["runId"].clone()),
                    ("projectId", project["id"].clone()),
                    (
                        "model",
                        if event["model"].truthy() {
                            event["model"].clone()
                        } else {
                            "sonnet".into()
                        },
                    ),
                    ("updatedAt", (now() as f64).into()),
                ]),
            );
        }
        drop(runs);
        Some(self.state(&project))
    }
    pub fn consume_delegates(
        &self,
        projects: &crate::projects::Store,
        terminals: &crate::terminals::Store,
        events: &crate::events::Store,
    ) {
        let dir = &self.delegate_directory;
        let Some(parent) = dir.parent() else {
            return;
        };
        if !safe_path(parent, dir) {
            return;
        }
        for name in names(dir).unwrap_or_default() {
            let Some(stem) = name.strip_suffix(".json") else {
                continue;
            };
            if !ascii_id(stem, 180, false) {
                continue;
            }
            let path = dir.join(name);
            if !safe_path(dir, &path) || !path.is_file() {
                continue;
            }
            let value = fs::metadata(&path)
                .ok()
                .filter(|m| m.len() <= 16_384)
                .and_then(|_| fs::read_to_string(&path).ok())
                .and_then(|s| parse(&s));
            if let Some(event) = value.filter(|e| {
                e["updatedAt"].truthy() && (now() as f64 - e["updatedAt"].number()).abs() <= 15000.0
            }) {
                if let Some(state) = self.delegate(&event, projects, terminals) {
                    events.publish_raw("session:status", state.raw().get());
                }
            }
            let _ = fs::remove_file(path);
        }
    }
}
fn normalized(path: &str) -> String {
    let mut result = if Path::new(path).is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    for component in Path::new(path).components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(component),
        }
    }
    let value = result
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}
fn ascii_id(value: &str, max: usize, extra: bool) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || (extra && b"._".contains(&c)))
}
pub fn valid_delegate(event: &V) -> bool {
    matches!(event, V::Object(_))
        && event["runId"].truthy()
        && ascii_id(&event["runId"].text(), 80, false)
        && event["state"].is_string()
        && ["running", "heartbeat", "done"].contains(&event["state"].text().as_str())
        && (!event["model"].truthy()
            || (event["model"].is_string() && ascii_id(&event["model"].text(), 64, true)))
        && (!event["termId"].truthy()
            || (event["termId"].is_string() && ascii_id(&event["termId"].text(), 100, false)))
        && (!event["cwd"].truthy()
            || (event["cwd"].is_string() && event["cwd"].units().len() <= 2000))
        && (!event.has("updatedAt")
            || matches!(event["updatedAt"], V::Number(n) if n.is_finite() && n > 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_home_reads_sessions_and_history_without_changing_preview_roots() {
        let directory = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let delegates = tempfile::tempdir().unwrap();
        let preview = Store::new(directory.path().into());
        let legacy = Store::new_legacy(
            directory.path().into(),
            home.path().into(),
            delegates.path().into(),
        );
        let folder = home.path().join(".claude/projects/-fixture-project");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("abcd.jsonl"), "{\"type\":\"assistant\"}\n").unwrap();
        fs::write(
            home.path().join(".claude/history.jsonl"),
            "{\"project\":\"/fixture/project\",\"display\":\"legacy fixture\",\"timestamp\":1}\n",
        )
        .unwrap();
        assert_eq!(
            preview.root(),
            directory.path().join("home/.claude/projects")
        );
        assert_eq!(
            preview.delegate_directory,
            directory.path().join("delegate-status")
        );
        assert_eq!(legacy.delegate_directory, delegates.path());
        assert!(preview.project_dir("/fixture/project", true).is_none());
        assert!(preview.activity().array().is_empty());
        assert_eq!(
            legacy.project_dir("/fixture/project", true),
            Some(folder.clone())
        );
        assert_eq!(legacy.files(&folder).unwrap().len(), 1);
        assert_eq!(
            legacy.activity().array()[0]["command"],
            V::from("legacy fixture")
        );
        assert!(legacy.safe(&directory.path().join("fixture")));
        assert!(!legacy.safe(&delegates.path().join("unrelated.jsonl")));
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("escape.jsonl"), "{}\n").unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("escape.jsonl"),
                folder.join("escape.jsonl"),
            )
            .unwrap();
            assert_eq!(legacy.files(&folder).unwrap().len(), 1);
            fs::remove_file(home.path().join(".claude/history.jsonl")).unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("escape.jsonl"),
                home.path().join(".claude/history.jsonl"),
            )
            .unwrap();
            assert!(legacy.activity().array().is_empty());
        }
    }

    #[test]
    fn persistent_read_errors_end_the_projection_after_one_attempt() {
        struct Broken {
            calls: usize,
        }
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                self.calls += 1;
                assert_eq!(
                    self.calls, 1,
                    "An I/O error must not be retried by the JSONL iterator"
                );
                Err(io::Error::from_raw_os_error(libc::EIO))
            }
        }
        let result = project_records(BufReader::new(Broken { calls: 0 }), usize::MAX, |rows| {
            crate::session_views::messages(rows)
        });
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EIO));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn image_heavy_previews_stream_without_retaining_source_records() {
        use std::io::Write;
        // Peak RSS is process-wide, so tests running on other threads would
        // inflate or mask it. Measure in a fresh test process running only this.
        const NAME: &str =
            "sessions::tests::image_heavy_previews_stream_without_retaining_source_records";
        if std::env::var_os("COCKPIT_ISOLATED_RSS_TEST").is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", NAME, "--test-threads=1"])
                .env("COCKPIT_ISOLATED_RSS_TEST", "1")
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success() && stdout.contains(" 1 passed"),
                "{stdout}{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("images.jsonl");
        let image = "A".repeat(256 * 1024);
        let mut output = File::create(&file).unwrap();
        for _ in 0..128 {
            writeln!(output, "{{\"type\":\"user\",\"message\":{{\"content\":[{{\"type\":\"image\",\"source\":{{\"type\":\"base64\",\"data\":\"{image}\"}}}}]}}}}").unwrap();
        }
        drop(output);
        let peak = || {
            let mut value: libc::rusage = unsafe { std::mem::zeroed() };
            assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut value) }, 0);
            value.ru_maxrss
        };
        let before = peak();
        let messages = read_view(&file, usize::MAX, |rows| {
            crate::session_views::messages(rows)
        })
        .unwrap();
        assert!(messages.array().is_empty());
        let timeline = read_view(&file, usize::MAX, |rows| {
            crate::session_views::timeline(rows)
        })
        .unwrap();
        assert_eq!(timeline["summary"]["messageCount"], V::Number(128.0));
        assert!(
            peak() - before < 48 * 1024,
            "32 MiB source records must not accumulate as UTF-16 values"
        );
    }

    #[test]
    fn claude_activity_and_readonly_opencode_precedence() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().to_path_buf());
        let project = object([
            ("id", "fixture".into()),
            ("path", "/fixture/project".into()),
        ]);
        assert_eq!(store.state(&project)["state"], V::from("no_data"));
        let folder = store.root().join("-fixture-project");
        fs::create_dir_all(&folder).unwrap();
        assert_eq!(store.state(&project)["state"], V::from("no_sessions"));
        let file = folder.join("abcd.jsonl");
        fs::write(&file, "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4\\ud800-20260101\"}}\n{bad\nfalse\n").unwrap();
        let set_age = |ms| {
            File::options()
                .write(true)
                .open(&file)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(
                    UNIX_EPOCH + std::time::Duration::from_millis((now() - ms) as u64),
                ))
                .unwrap()
        };
        assert_eq!(store.state(&project)["state"], V::from("busy"));
        set_age(30_000);
        let waiting = store.state(&project);
        assert_eq!(waiting["state"], V::from("waiting"));
        assert_eq!(waiting["model"].units().last(), Some(&0xd800));
        set_age(600_000);
        assert_eq!(store.state(&project)["state"], V::from("idle"));
        let db_path = directory
            .path()
            .join("home/.local/share/opencode/opencode.db");
        assert!(!db_path.exists());
        fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch("CREATE TABLE session (id TEXT, directory TEXT, model TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER); CREATE TABLE message (session_id TEXT, data TEXT, time_created INTEGER)").unwrap();
        db.execute("INSERT INTO session VALUES ('oc-a','/fixture/project','{\"id\":\"native\"}','title',?,NULL)", [now()-30_000]).unwrap();
        db.execute(
            "INSERT INTO message VALUES ('oc-a','{\"role\":\"assistant\"}',?)",
            [now() - 30_000],
        )
        .unwrap();
        drop(db);
        let original = fs::read(&db_path).unwrap();
        let active = store.state(&project);
        assert_eq!(active["state"], V::from("waiting"));
        assert_eq!(active["sessionId"], V::from("oc-a"));
        assert_eq!(fs::read(&db_path).unwrap(), original);
        set_age(0);
        assert_eq!(store.state(&project)["sessionId"], V::from("abcd"));
        assert!(store.project_dir("../../outside", true).is_none());
    }
    #[test]
    fn delegate_validation_requires_supported_state_and_finite_timestamp() {
        for text in [
            r#"{"runId":false,"state":"running"}"#,
            r#"{"runId":"ok","state":["running"]}"#,
            r#"{"runId":"ok","state":"done","updatedAt":null}"#,
            r#"{"runId":"ok","state":"running","model":"--invalid/arg"}"#,
        ] {
            assert!(!valid_delegate(&parse(text).unwrap()));
        }
        assert!(valid_delegate(
            &parse(r#"{"runId":"ok","state":"heartbeat","model":"sonnet-4.6","updatedAt":42}"#)
                .unwrap()
        ));
    }
}
