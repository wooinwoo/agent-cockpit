use crate::{board_value::V, projects};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Instant,
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/health"),
    ("POST", "/api/open-in-ide"),
    ("POST", "/api/open-url"),
    ("POST", "/api/open-folder"),
    ("POST", "/api/projects/:id/open-ide"),
];

pub struct Store {
    started: Instant,
    version: String,
}
impl Store {
    pub fn new(root: &Path) -> Self {
        let package: serde_json::Value = fs::read(root.join("package.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            started: Instant::now(),
            version: package["version"]
                .as_str()
                .unwrap_or(env!("CARGO_PKG_VERSION"))
                .into(),
        }
    }
    pub fn health(&self, app: &crate::App) -> Response {
        let rss = fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|text| {
                text.lines().find_map(|line| {
                    line.strip_prefix("VmRSS:")
                        .and_then(|v| v.split_whitespace().next())
                        .and_then(|v| v.parse::<u64>().ok())
                })
            });
        let Some(rss) = rss else {
            return crate::error(
                500,
                "Process memory measurement is unavailable on this platform",
            );
        };
        let projects = match app.projects.list() {
            Ok(projects) => projects.len(),
            Err(_) => return crate::error(500, "Project storage operation failed"),
        };
        Json(json!({ "status":"ok", "version":self.version, "uptime":self.started.elapsed().as_secs_f64().round(), "memory":(rss as f64 / 1024.0).round(), "projects":projects, "terminals":app.terminals.active().len(), "durableTerminals":app.terminals.durable_enabled(), "sseClients":app.events.client_count() })).into_response()
    }
}

pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, target)| path == *target && method.as_str() == *verb)
        || (*method == Method::POST
            && path
                .strip_prefix("/api/projects/")
                .and_then(|rest| rest.strip_suffix("/open-ide"))
                .is_some_and(|id| !id.is_empty() && !id.contains('/')))
}

fn detached(program: &str, args: &[String]) -> bool {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    command.process_group(0);
    match command.spawn() {
        Ok(mut child) => {
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            true
        }
        Err(_) => false,
    }
}

fn opener(argument: String) {
    if cfg!(target_os = "macos") {
        detached("open", &[argument]);
    } else if std::env::var_os("WSL_DISTRO_NAME").is_some() {
        if !detached("wslview", &[argument.clone()]) {
            detached("xdg-open", &[argument]);
        }
    } else {
        detached("xdg-open", &[argument]);
    }
}

fn ide_binary(ide: &str) -> &str {
    if ide == "zed" && cfg!(target_os = "macos") {
        "/Applications/Zed.app/Contents/MacOS/cli"
    } else {
        ide
    }
}

pub fn open(path: &str, input: V, projects: &projects::Store) -> Response {
    // Windows shell wrappers need a separate verified quoting path. Never feed
    // untrusted paths or URLs to cmd.exe while that migration is incomplete.
    if cfg!(windows) {
        return crate::error(501, "Desktop launchers are not migrated on Windows");
    }
    if path == "/api/open-url" {
        if !input["url"].truthy() || !input["url"].is_string() {
            return crate::error(400, "Missing url");
        }
        let url = input["url"].text();
        if !["http://", "https://"]
            .iter()
            .any(|prefix| url.to_ascii_lowercase().starts_with(prefix))
        {
            return crate::error(400, "Only http/https URLs allowed");
        }
        if input["browser"] == V::from("firefox-dev") {
            detached(
                if cfg!(target_os = "macos") {
                    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"
                } else {
                    "firefox-developer-edition"
                },
                &[url],
            );
        } else {
            opener(url);
        }
        return Json(json!({"opened":true})).into_response();
    }
    let list = match projects.list() {
        Ok(list) => list,
        Err(_) => return crate::error(500, "Project storage operation failed"),
    };
    let find = |id: &str| {
        list.iter().find(|p| {
            p.get("id")
                .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
                .as_deref()
                == Some(id)
        })
    };
    let project_path = |p: &crate::json_values::Object| {
        p.get("path")
            .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
            .unwrap_or_default()
    };
    let ide = if input["ide"].truthy() {
        input["ide"].text()
    } else {
        "code".into()
    };
    if let Some(id) = path
        .strip_prefix("/api/projects/")
        .and_then(|rest| rest.strip_suffix("/open-ide"))
    {
        let Some(id) = crate::decoded_id(id) else {
            return crate::error(400, "Invalid project ID");
        };
        let Some(project) = find(&id) else {
            return crate::error(404, "Not found");
        };
        if !["code", "cursor", "windsurf", "antigravity", "zed"].contains(&ide.as_str())
            || (input["ide"].truthy() && !input["ide"].is_string())
        {
            return crate::error(400, "Unknown IDE");
        }
        detached(ide_binary(&ide), &[project_path(project)]);
        return Json(json!({"opened":true,"ide":ide,"projectId":id})).into_response();
    }
    if !input["path"].truthy() {
        return crate::error(400, "Missing path");
    }
    if !input["path"].is_string() {
        return crate::error(400, "path must be a string");
    }
    let mut file_path = PathBuf::from(input["path"].text());
    if path == "/api/open-in-ide"
        && input["projectId"].truthy()
        && !file_path.is_absolute()
        && !file_path
            .to_string_lossy()
            .as_bytes()
            .get(1)
            .is_some_and(|c| *c == b':')
    {
        if let Some(project) = find(&input["projectId"].text()) {
            file_path = PathBuf::from(project_path(project)).join(file_path);
        }
    }
    if !crate::system_files::allowed_path(&file_path, &list) {
        return crate::error(403, "Path outside project directories");
    }
    let file_path = file_path.to_string_lossy().into_owned();
    if path == "/api/open-folder" {
        if cfg!(target_os = "macos") {
            detached("open", &["-R".into(), file_path]);
        } else {
            opener(
                file_path
                    .rsplit_once('/')
                    .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
                    .unwrap_or("/")
                    .into(),
            );
        }
    } else {
        if !["code", "cursor", "windsurf", "antigravity", "zed"].contains(&ide.as_str())
            || (input["ide"].truthy() && !input["ide"].is_string())
        {
            return crate::error(400, "Unknown IDE");
        }
        let line = crate::git::parse_int(&input["line"].text()).unwrap_or(0);
        let column = crate::git::parse_int(&input["column"].text()).unwrap_or(0);
        let args = if line <= 0 {
            vec![file_path]
        } else if ide == "zed" {
            vec![format!("{file_path}:{line}")]
        } else {
            vec![
                "--goto".into(),
                format!(
                    "{file_path}:{line}{}",
                    if column > 0 {
                        format!(":{column}")
                    } else {
                        String::new()
                    }
                ),
            ]
        };
        detached(ide_binary(&ide), &args);
    }
    Json(json!({"opened":true})).into_response()
}
