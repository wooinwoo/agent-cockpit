use crate::json_values::{raw, truthy, units, Object};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{
    json,
    value::{to_raw_value, RawValue},
};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const FIELDS: &[&str] = &["name", "path", "stack", "color", "devCmd", "github"];
const COLORS: &[&str] = &[
    "#3B82F6", "#10B981", "#8B5CF6", "#F59E0B", "#EF4444", "#EC4899", "#06B6D4", "#84CC16",
    "#F97316", "#6366F1", "#14B8A6", "#E11D48",
];
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/projects"),
    ("POST", "/api/projects"),
    ("PUT", "/api/projects/:id"),
    ("DELETE", "/api/projects/:id"),
    ("GET", "/api/browse"),
    ("GET", "/api/scripts-by-path"),
    ("GET", "/api/projects/:id/scripts"),
    ("GET", "/api/settings/export"),
    ("POST", "/api/settings/import"),
    ("POST", "/api/discover-projects/add"),
];

pub struct Store {
    directory: PathBuf,
    state: Mutex<Object>,
}

fn text(value: Option<&Box<RawValue>>) -> Option<String> {
    serde_json::from_str(value?.get()).ok()
}

fn color(name: &RawValue) -> &'static str {
    let hash = units(name)
        .unwrap_or_default()
        .into_iter()
        .fold(0i32, |hash, c| hash.wrapping_mul(31).wrapping_add(c as i32));
    COLORS[(i64::from(hash).unsigned_abs() % COLORS.len() as u64) as usize]
}

fn clean_fields(input: &Object) -> Object {
    let mut fields: Object = input
        .iter()
        .filter(|(key, _)| FIELDS.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if fields.get("color").is_some_and(|v| truthy(v)) {
        let valid = text(fields.get("color")).is_some_and(|v| {
            v.starts_with('#')
                && (4..=9).contains(&v.len())
                && v[1..].bytes().all(|c| c.is_ascii_hexdigit())
        });
        if !valid {
            fields.remove("color");
        }
    }
    fields
}

fn base36(mut number: u128) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit((number % 36) as u32, 36).unwrap());
        number /= 36;
        if number == 0 {
            break;
        }
    }
    digits.into_iter().rev().collect()
}

fn slug(name: &RawValue) -> String {
    let lower = String::from_utf16_lossy(&units(name).unwrap_or_default()).to_lowercase();
    let mut result = String::new();
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() {
            result.push(c);
        } else if !result.is_empty() && !result.ends_with('-') {
            result.push('-');
        }
    }
    result.trim_end_matches('-').to_string()
}

fn new_project(input: &Object, projects: &[Object]) -> Result<Object, Response> {
    if input.get("name").is_none_or(|v| !truthy(v)) || input.get("path").is_none_or(|v| !truthy(v))
    {
        return Err(super::error(400, "name and path required"));
    }
    if input.get("name").and_then(|v| units(v)).is_none() || text(input.get("path")).is_none() {
        return Err(super::error(400, "name and path must be strings"));
    }
    let mut id = text(input.get("id"))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| slug(&input["name"]));
    if id.is_empty() {
        id = format!(
            "project-{}",
            base36(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            )
        );
    }
    if id.contains('/') || id.chars().any(char::is_control) {
        return Err(super::error(400, "Invalid project ID"));
    }
    let base = id.clone();
    let mut suffix = 2;
    while projects
        .iter()
        .any(|p| text(p.get("id")).as_deref() == Some(&id))
    {
        id = format!("{base}-{suffix}");
        suffix += 1;
    }
    let mut project = clean_fields(input);
    project.insert("id".into(), raw(json!(id)));
    if project.get("color").is_none_or(|v| !truthy(v)) {
        project.insert("color".into(), raw(json!(color(&project["name"]))));
    }
    Ok(project)
}

impl Store {
    pub fn new(directory: PathBuf) -> io::Result<Self> {
        let path = directory.join("projects.json");
        let mut state: Object = match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.is_file() => {
                return Err(io::Error::other("Projects file must be a regular file"))
            }
            Ok(_) => serde_json::from_slice(&fs::read(path)?)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Object::from([("projects".into(), raw(json!([])))])
            }
            Err(e) => return Err(e),
        };
        // Older Node settings can omit IDs. Resolve them before validation and
        // persist once so generated fallback IDs remain stable across restarts.
        let mut migrated = false;
        let value = state
            .get("projects")
            .ok_or_else(|| io::Error::other("Missing projects array"))?;
        let mut projects: Vec<Object> = serde_json::from_str(value.get())?;
        for project in &mut projects {
            if project.get("id").is_none_or(|id| !truthy(id)) {
                let mut id = project
                    .get("name")
                    .map(|name| slug(name))
                    .unwrap_or_default();
                if id.is_empty() {
                    id = format!(
                        "project-{}",
                        base36(
                            SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap()
                                .as_millis()
                        )
                    );
                }
                project.insert("id".into(), raw(json!(id)));
                migrated = true;
            }
        }
        if migrated {
            state.insert("projects".into(), to_raw_value(&projects)?);
        }
        let store = Self {
            directory,
            state: Mutex::new(state),
        };
        // Fail startup on corrupt state instead of overwriting it with an empty list.
        store.list()?;
        if migrated {
            let state = store
                .state
                .lock()
                .map_err(|_| io::Error::other("Projects lock failed"))?;
            store.save(&state)?;
        }
        Ok(store)
    }

    fn decode(state: &Object) -> io::Result<Vec<Object>> {
        let Some(value) = state.get("projects") else {
            return Err(io::Error::other("Missing projects array"));
        };
        let projects: Vec<Object> = serde_json::from_str(value.get())?;
        for project in &projects {
            if text(project.get("id")).is_none() || text(project.get("path")).is_none() {
                return Err(io::Error::other("Invalid saved project identity or path"));
            }
        }
        Ok(projects)
    }

    pub fn list(&self) -> io::Result<Vec<Object>> {
        let state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("Projects lock failed"))?;
        Self::decode(&state)
    }

    fn save(&self, candidate: &Object) -> io::Result<()> {
        let destination = self.directory.join("projects.json");
        let backups = self.directory.join("backups");
        if destination.exists() {
            if !fs::symlink_metadata(&destination)?.is_file() {
                return Err(io::Error::other("Invalid projects file"));
            }
            fs::create_dir_all(&backups)?;
            if fs::symlink_metadata(&backups)?.file_type().is_symlink() {
                return Err(io::Error::other("Invalid backup directory"));
            }
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let mut backup = tempfile::NamedTempFile::new_in(&backups)?;
            backup.write_all(&fs::read(&destination)?)?;
            backup.as_file().sync_all()?;
            backup
                .persist(backups.join(format!(
                    "projects.json.{}-{:06}.bak",
                    stamp / 1_000_000,
                    stamp % 1_000_000
                )))
                .map_err(|e| e.error)?;
        }
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer_pretty(&mut file, candidate)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(destination).map_err(|e| e.error)?;
        #[cfg(unix)]
        File::open(&self.directory)?.sync_all()?;
        // Retention happens after the successful write. Failure to prune cannot
        // turn a committed configuration into a reported failed mutation.
        if let Ok(entries) = fs::read_dir(&backups) {
            let mut entries: Vec<_> = entries
                .flatten()
                .filter(|e| {
                    e.file_name()
                        .to_str()
                        .is_some_and(|n| n.starts_with("projects.json.") && n.ends_with(".bak"))
                })
                .map(|e| e.path())
                .collect();
            entries.sort();
            for old in entries.iter().take(entries.len().saturating_sub(10)) {
                let _ = fs::remove_file(old);
            }
        }
        Ok(())
    }

    fn modify(&self, method: &Method, id: Option<&str>, input: Object) -> io::Result<Response> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("Projects lock failed"))?;
        let mut projects = Self::decode(&state)?;
        let response = match (method, id) {
            (&Method::POST, None) => {
                let project = match new_project(&input, &projects) {
                    Ok(project) => project,
                    Err(response) => return Ok(response),
                };
                projects.push(project.clone());
                (axum::http::StatusCode::CREATED, Json(project)).into_response()
            }
            (&Method::PUT, Some(id)) => {
                let Some(project) = projects
                    .iter_mut()
                    .find(|p| text(p.get("id")).as_deref() == Some(id))
                else {
                    return Ok(super::error(404, "Not found"));
                };
                if input.contains_key("path") && text(input.get("path")).is_none() {
                    return Ok(super::error(400, "path must be a string"));
                }
                project.extend(clean_fields(&input));
                Json(project.clone()).into_response()
            }
            (&Method::DELETE, Some(id)) => {
                let Some(index) = projects
                    .iter()
                    .position(|p| text(p.get("id")).as_deref() == Some(id))
                else {
                    return Ok(super::error(404, "Not found"));
                };
                projects.remove(index);
                Json(json!({"deleted":true})).into_response()
            }
            _ => return Ok((axum::http::StatusCode::NOT_FOUND, "Not Found").into_response()),
        };
        let mut candidate = state.clone();
        candidate.insert("projects".into(), to_raw_value(&projects)?);
        self.save(&candidate)?;
        *state = candidate;
        Ok(response)
    }

    pub fn handles(method: &Method, path: &str) -> bool {
        if path == "/api/settings/export" {
            return *method == Method::GET;
        }
        if matches!(path, "/api/settings/import" | "/api/discover-projects/add") {
            return *method == Method::POST;
        }
        if path == "/api/projects" {
            return matches!(*method, Method::GET | Method::POST);
        }
        if matches!(path, "/api/browse" | "/api/scripts-by-path") {
            return *method == Method::GET;
        }
        let Some(rest) = path.strip_prefix("/api/projects/") else {
            return false;
        };
        if let Some(id) = rest.strip_suffix("/scripts") {
            return *method == Method::GET && !id.is_empty() && !id.contains('/');
        }
        !rest.is_empty() && !rest.contains('/') && matches!(*method, Method::PUT | Method::DELETE)
    }

    pub fn handle(
        &self,
        method: Method,
        path: &str,
        query: &HashMap<String, String>,
        input: Object,
        local: bool,
        polling: &crate::project_polling::Store,
    ) -> Response {
        self.request(method, path, query, input, local, polling)
            .unwrap_or_else(|_| super::error(500, "Project storage operation failed"))
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        query: &HashMap<String, String>,
        input: Object,
        local: bool,
        polling: &crate::project_polling::Store,
    ) -> io::Result<Response> {
        if method == Method::GET && path == "/api/settings/export" {
            return Ok(Json(Object::from([(
                "projects".into(),
                to_raw_value(&self.list()?)?,
            )]))
            .into_response());
        }
        if method == Method::POST
            && matches!(path, "/api/settings/import" | "/api/discover-projects/add")
        {
            return self.import(input, path == "/api/discover-projects/add");
        }
        if method != Method::GET {
            let id = match path.strip_prefix("/api/projects/") {
                Some(segment) => match super::decoded_id(segment) {
                    Some(id) => Some(id),
                    None => return Ok(super::error(400, "Invalid project ID")),
                },
                None => None,
            };
            return self.modify(&method, id.as_deref(), input);
        }
        let projects = self.list()?;
        match path {
            "/api/projects" => {
                let values: Vec<_> = projects
                    .into_iter()
                    .map(|mut p| {
                        let id = text(p.get("id")).unwrap_or_default();
                        for field in ["session", "git", "prs"] {
                            p.insert(field.into(), polling.cached(&id, field).raw());
                        }
                        p
                    })
                    .collect();
                Ok(Json(values).into_response())
            }
            "/api/scripts-by-path" => {
                let Some(path) = query.get("path").filter(|v| !v.is_empty()) else {
                    return Ok(super::error(400, "path required"));
                };
                Ok(scripts(Path::new(path), &projects).into_response())
            }
            "/api/browse" => Ok(browse(
                query.get("dir").map(String::as_str).unwrap_or(""),
                &projects,
                local,
            )),
            _ => {
                let id = path
                    .strip_prefix("/api/projects/")
                    .and_then(|v| v.strip_suffix("/scripts"))
                    .unwrap_or("");
                let Some(id) = super::decoded_id(id) else {
                    return Ok(super::error(400, "Invalid project ID"));
                };
                let Some(project) = projects
                    .iter()
                    .find(|p| text(p.get("id")).as_deref() == Some(id.as_str()))
                else {
                    return Ok(super::error(404, "Not found"));
                };
                let path = text(project.get("path"))
                    .ok_or_else(|| io::Error::other("Invalid project path"))?;
                Ok(scripts(Path::new(&path), &projects).into_response())
            }
        }
    }

    fn import(&self, input: Object, discovered: bool) -> io::Result<Response> {
        let values = input.get("projects");
        let imported: Vec<Box<RawValue>> = if values.is_none_or(|v| !truthy(v)) {
            vec![]
        } else {
            match serde_json::from_str(values.unwrap().get()) {
                Ok(values) => values,
                Err(_) => return Ok(super::error(400, "projects must be an array")),
            }
        };
        if discovered && imported.is_empty() {
            return Ok(super::error(400, "projects required"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("Projects lock failed"))?;
        let mut projects = Self::decode(&state)?;
        let mut paths: std::collections::HashSet<String> = projects
            .iter()
            .filter_map(|p| text(p.get("path")))
            .map(|path| path.replace('\\', "/").to_lowercase())
            .collect();
        let mut added = 0;
        for value in imported {
            let Ok(mut fields) = serde_json::from_str::<Object>(value.get()) else {
                return Ok(super::error(400, "projects must contain objects"));
            };
            if fields.get("name").is_none_or(|v| !truthy(v))
                || fields.get("path").is_none_or(|v| !truthy(v))
            {
                continue;
            }
            let Some(path) = text(fields.get("path")) else {
                return Ok(super::error(400, "name and path must be strings"));
            };
            let path = path.replace('\\', "/");
            if paths.contains(&path.to_lowercase()) {
                continue;
            }
            fields.remove("id");
            if discovered {
                fields.retain(|key, _| matches!(key.as_str(), "name" | "path"));
            }
            fields.insert("path".into(), raw(json!(path)));
            let project = match new_project(&fields, &projects) {
                Ok(project) => project,
                Err(response) => return Ok(response),
            };
            projects.push(project);
            paths.insert(path.to_lowercase());
            added += 1;
        }
        if added > 0 {
            let mut candidate = state.clone();
            candidate.insert("projects".into(), to_raw_value(&projects)?);
            self.save(&candidate)?;
            *state = candidate;
        }
        Ok(Json(if discovered {
            json!({"success":true,"added":added})
        } else {
            json!({"success":true,"imported":added})
        })
        .into_response())
    }
}

pub(crate) fn inside(path: &Path, projects: &[Object]) -> bool {
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    projects
        .iter()
        .filter_map(|p| text(p.get("path")))
        .filter_map(|p| Path::new(&p).canonicalize().ok())
        .any(|root| path.starts_with(root))
}

fn scripts(directory: &Path, projects: &[Object]) -> Json<Object> {
    let file = directory.join("package.json");
    let scripts = if inside(directory, projects) && inside(&file, projects) {
        fs::read(file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Object>(&bytes).ok())
            .and_then(|mut p| p.remove("scripts"))
            .filter(|v| truthy(v))
    } else {
        None
    };
    Json(Object::from([(
        "scripts".into(),
        scripts.unwrap_or_else(|| raw(json!({}))),
    )]))
}

fn browse(dir: &str, projects: &[Object], local: bool) -> Response {
    let dir = dir.replace('\\', "/");
    if dir.is_empty() {
        if !local {
            return super::error(403, "Directory browsing requires localhost");
        }
        let entries: Vec<_> = ('C'..='Z')
            .map(|letter| format!("{letter}:/"))
            .filter(|path| Path::new(path).exists())
            .map(|path| json!({"name":path,"path":path,"isDir":true}))
            .collect();
        return Json(json!({"parent":null,"entries":entries})).into_response();
    }
    if !local && !inside(Path::new(&dir), projects) {
        return super::error(403, "Access denied");
    }
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) => return super::error(400, &e.to_string()),
    };
    let mut names: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.') && name != "node_modules")
        .collect();
    names.sort();
    let entries: Vec<_> = names.into_iter().map(|name| json!({"name":name,"path":format!("{}/{}",dir.trim_end_matches('/'),name),"isDir":true})).collect();
    let trimmed = dir.trim_end_matches('/');
    let parent = trimmed
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .filter(|p| !p.is_empty());
    Json(json!({"current":dir,"parent":parent,"entries":entries})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_legacy_ids_are_migrated_with_original_backup() {
        let directory = tempfile::tempdir().unwrap();
        let original = br#"{"projects":[{"name":"Legacy Demo","path":"/fixture-project","future":"\ud800"},{"name":"\ud83d","path":"/fixture-project"}]}"#;
        fs::write(directory.path().join("projects.json"), original).unwrap();
        let store = Store::new(directory.path().to_path_buf()).unwrap();
        let list = store.list().unwrap();
        assert_eq!(text(list[0].get("id")).as_deref(), Some("legacy-demo"));
        assert_eq!(list[0]["future"].get(), r#""\ud800""#);
        let fallback = text(list[1].get("id")).unwrap();
        assert!(fallback.starts_with("project-"));
        let restarted = Store::new(directory.path().to_path_buf()).unwrap();
        assert_eq!(
            text(restarted.list().unwrap()[1].get("id")).as_deref(),
            Some(fallback.as_str())
        );
        let backup = fs::read_dir(directory.path().join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(backup).unwrap(), original);
    }

    #[test]
    fn legacy_fields_unmounted_paths_and_backup_bytes_survive_updates() {
        let directory = tempfile::tempdir().unwrap();
        let original = br#"{"version":99,"extra":"\ud800","projects":[{"id":"legacy","name":"\ud83d","path":"/fixture-drive-not-mounted","future":{"x":"\udc00"}}]}"#;
        fs::write(directory.path().join("projects.json"), original).unwrap();
        let store = Store::new(directory.path().to_path_buf()).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        let response = store
            .modify(
                &Method::PUT,
                Some("legacy"),
                serde_json::from_str(r##"{"color":"#123"}"##).unwrap(),
            )
            .unwrap();
        assert_eq!(response.status(), 200);
        let persisted: Object =
            serde_json::from_slice(&fs::read(directory.path().join("projects.json")).unwrap())
                .unwrap();
        assert_eq!(persisted["extra"].get(), r#""\ud800""#);
        let project = store.list().unwrap().remove(0);
        assert_eq!(project["name"].get(), r#""\ud83d""#);
        assert_eq!(project["future"].get(), r#"{"x":"\udc00"}"#);
        let backup = fs::read_dir(directory.path().join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(backup).unwrap(), original);
        fs::write(directory.path().join("projects.json"), b"{broken").unwrap();
        assert!(Store::new(directory.path().to_path_buf()).is_err());
        assert_eq!(
            fs::read(directory.path().join("projects.json")).unwrap(),
            b"{broken"
        );
    }
}
