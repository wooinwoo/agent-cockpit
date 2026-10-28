use crate::{json_values::Object, projects, system_files};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/reports"),
    ("POST", "/api/reports"),
    ("DELETE", "/api/reports/:id"),
];

pub fn route(method: &Method, path: &str) -> bool {
    (path == "/api/reports" && matches!(*method, Method::GET | Method::POST))
        || (*method == Method::DELETE
            && path
                .strip_prefix("/api/reports/")
                .is_some_and(|id| !id.is_empty() && !id.contains('/')))
}

pub struct Store {
    directory: PathBuf,
    writer: Mutex<()>,
}
type Result<T> = std::result::Result<T, (u16, String)>;
fn failure(error: impl ToString) -> (u16, String) {
    (
        500,
        format!(
            "보고서 목록을 저장하거나 읽지 못했습니다. {}",
            error.to_string()
        ),
    )
}
fn time(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn text<'a>(body: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    let value = match body.get(key) {
        None => "",
        Some(Value::String(value)) => value.trim(),
        _ => return Err((400, format!("{key}는 문자열이어야 합니다."))),
    };
    if value.chars().count() > limit || value.chars().any(char::is_control) {
        return Err((
            400,
            format!("{key}는 제어 문자 없이 {limit}자 이하로 입력하세요."),
        ));
    }
    Ok(value)
}

fn file_path(value: &str) -> PathBuf {
    let value = value.trim_matches('"');
    #[cfg(target_os = "linux")]
    if value.as_bytes().get(1) == Some(&b':')
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        && matches!(value.as_bytes().get(2), Some(b'\\' | b'/'))
    {
        return PathBuf::from(format!(
            "/mnt/{}/{}",
            value[..1].to_ascii_lowercase(),
            value[3..].replace('\\', "/")
        ));
    }
    PathBuf::from(value)
}

fn kind(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "md" | "markdown" => Some("md"),
        "html" | "htm" => Some("html"),
        _ => None,
    }
}

impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            writer: Mutex::new(()),
        }
    }
    fn read(&self) -> io::Result<Vec<Value>> {
        let path = self.directory.join("reports.json");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Ok(metadata) if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 => {
                return Err(io::Error::other("Invalid report registry"))
            }
            Err(error) => return Err(error),
            _ => (),
        }
        let reports: Vec<Value> = serde_json::from_slice(&fs::read(path)?)?;
        if reports.len() > 500
            || reports.iter().any(|report| {
                ["id", "path", "title", "session"]
                    .iter()
                    .any(|key| !report[key].is_string())
                    || !report["registeredAt"].is_u64()
            })
        {
            return Err(io::Error::other("Invalid report registry"));
        }
        Ok(reports)
    }
    fn save(&self, reports: &[Value]) -> io::Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer_pretty(&mut file, reports)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(self.directory.join("reports.json"))
            .map_err(|error| error.error)?;
        #[cfg(unix)]
        fs::File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
    fn metadata(report: &Value, registered: &[Object]) -> Value {
        let path = Path::new(report["path"].as_str().unwrap());
        let mut row = report.clone();
        row["name"] = json!(path.file_name().unwrap_or_default().to_string_lossy());
        row["kind"] = json!(kind(path).unwrap_or("md"));
        let project = registered
            .iter()
            .find(|project| projects::inside(path, std::slice::from_ref(*project)));
        row["project"] = project
            .and_then(|project| project.get("name"))
            .and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok())
            .unwrap_or(json!(""));
        let metadata = system_files::allowed_path(path, registered)
            .then(|| fs::metadata(path).ok())
            .flatten()
            .filter(|metadata| metadata.is_file());
        row["available"] = json!(metadata.is_some());
        row["size"] = json!(metadata.as_ref().map(|metadata| metadata.len()));
        row["modifiedAt"] = json!(metadata
            .and_then(|metadata| metadata.modified().ok())
            .map(time));
        row
    }
    fn request(
        &self,
        method: &Method,
        path: &str,
        body: &Value,
        registered: &[Object],
    ) -> Result<Value> {
        let _lock = self.writer.lock().map_err(failure)?;
        let mut reports = self.read().map_err(failure)?;
        if *method == Method::POST {
            let raw = text(body, "path", 4096)?;
            let input = file_path(raw);
            if !input.is_absolute() || kind(&input).is_none() {
                return Err((400, "HTML·MD 파일의 전체 경로를 입력하세요.".into()));
            }
            if !system_files::allowed_path(&input, registered) {
                return Err((
                    403,
                    "등록된 프로젝트 폴더 안의 보고서만 열 수 있습니다.".into(),
                ));
            }
            let canonical = fs::canonicalize(&input)
                .map_err(|_| (404, "파일을 찾지 못했습니다. 경로를 확인하세요.".into()))?;
            if !projects::inside(&canonical, registered) {
                return Err((403, "프로젝트 밖의 파일은 등록할 수 없습니다.".into()));
            }
            let metadata = fs::metadata(&canonical).map_err(failure)?;
            if !metadata.is_file() || kind(&canonical).is_none() {
                return Err((400, "HTML·MD 일반 파일을 선택하세요.".into()));
            }
            if metadata.len() > 2 * 1024 * 1024 {
                return Err((413, "미리보기는 2MB 이하 보고서를 지원합니다.".into()));
            }
            let title = text(body, "title", 200)?;
            let session = text(body, "session", 80)?;
            let canonical = canonical.to_string_lossy().into_owned();
            let existing = reports
                .iter()
                .position(|report| report["path"] == canonical);
            if existing.is_none() && reports.len() >= 500 {
                return Err((
                    409,
                    "보고서 목록이 500개입니다. 필요 없는 항목을 목록에서 제거하세요.".into(),
                ));
            }
            let report = json!({
                "id": existing.map(|index| reports[index]["id"].as_str().unwrap().to_owned()).unwrap_or_else(|| format!("R-{:032x}", rand::random::<u128>())),
                "path": canonical,
                "title": if title.is_empty() { existing.map(|index| reports[index]["title"].as_str().unwrap().to_owned()).unwrap_or_else(|| input.file_stem().unwrap_or_default().to_string_lossy().into_owned()) } else { title.into() },
                "session": if session.is_empty() { existing.map(|index| reports[index]["session"].as_str().unwrap()).unwrap_or("") } else { session },
                "registeredAt": existing.map(|index| reports[index]["registeredAt"].as_u64().unwrap()).unwrap_or_else(|| time(SystemTime::now())),
            });
            let row = Self::metadata(&report, registered);
            if let Some(index) = existing {
                reports[index] = report;
            } else {
                reports.push(report);
            }
            self.save(&reports).map_err(failure)?;
            return Ok(json!({"report":row}));
        }
        if *method == Method::DELETE {
            let id = path.strip_prefix("/api/reports/").unwrap_or("");
            let index = reports
                .iter()
                .position(|report| report["id"] == id)
                .ok_or((
                    404,
                    "보고서를 찾지 못했습니다. 목록을 새로고침하세요.".into(),
                ))?;
            reports.remove(index);
            self.save(&reports).map_err(failure)?;
            return Ok(json!({"removed":true}));
        }
        let mut rows: Vec<_> = reports
            .iter()
            .map(|report| Self::metadata(report, registered))
            .collect();
        rows.sort_by_key(|row| {
            std::cmp::Reverse(
                row["modifiedAt"]
                    .as_u64()
                    .unwrap_or(row["registeredAt"].as_u64().unwrap_or(0)),
            )
        });
        Ok(json!({"reports":rows}))
    }
    pub fn handle(
        &self,
        method: &Method,
        path: &str,
        body: &Value,
        projects: &projects::Store,
    ) -> Response {
        let result = projects
            .list()
            .map_err(failure)
            .and_then(|registered| self.request(method, path, body, &registered));
        match result {
            Ok(value) => Json(value).into_response(),
            Err((status, message)) => super::error(status, &message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_values::raw;
    fn roots(path: &Path) -> Vec<Object> {
        vec![Object::from([
            ("name".into(), raw(json!("시험 프로젝트"))),
            ("path".into(), raw(json!(path))),
        ])]
    }
    #[test]
    fn registry_retains_source_updates_metadata_and_survives_restart() {
        let folder = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let file = folder.path().join("주간 보고.md");
        fs::write(&file, "# 최초 보고").unwrap();
        let registered = roots(folder.path());
        let store = Store::new(data.path().into());
        let body = json!({"path":file,"title":"주간 진행","session":"ai7"});
        let added = store
            .request(&Method::POST, "/api/reports", &body, &registered)
            .unwrap();
        let again = store
            .request(&Method::POST, "/api/reports", &body, &registered)
            .unwrap();
        assert_eq!(added["report"]["id"], again["report"]["id"]);
        fs::write(&file, "# 다음 보고\n새 근거 추가").unwrap();
        let reloaded = Store::new(data.path().into());
        let rows = reloaded
            .request(&Method::GET, "/api/reports", &json!({}), &registered)
            .unwrap();
        assert_eq!(rows["reports"].as_array().unwrap().len(), 1);
        assert_eq!(
            rows["reports"][0]["size"],
            fs::metadata(&file).unwrap().len()
        );
        assert_eq!(rows["reports"][0]["session"], "ai7");
        let url = format!("/api/reports/{}", added["report"]["id"].as_str().unwrap());
        reloaded
            .request(&Method::DELETE, &url, &json!({}), &registered)
            .unwrap();
        assert!(file.is_file());
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "# 다음 보고\n새 근거 추가"
        );
    }
    #[test]
    fn missing_invalid_outside_and_corrupt_files_do_not_change_registry() {
        let folder = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let store = Store::new(data.path().into());
        let registered = roots(folder.path());
        for (path, status) in [
            (folder.path().join("absent.md"), 404),
            (folder.path().join("secret.xlsx"), 400),
            (data.path().join("outside.md"), 403),
        ] {
            let error = store
                .request(
                    &Method::POST,
                    "/api/reports",
                    &json!({"path":path}),
                    &registered,
                )
                .unwrap_err();
            assert_eq!(error.0, status);
        }
        let file = folder.path().join("report.html");
        fs::write(&file, "<h1>보고</h1>").unwrap();
        store
            .request(
                &Method::POST,
                "/api/reports",
                &json!({"path":file}),
                &registered,
            )
            .unwrap();
        fs::remove_file(&file).unwrap();
        let rows = store
            .request(&Method::GET, "/api/reports", &json!({}), &registered)
            .unwrap();
        assert_eq!(rows["reports"][0]["available"], false);
        fs::write(data.path().join("reports.json"), "{broken").unwrap();
        assert!(store
            .request(
                &Method::DELETE,
                "/api/reports/missing",
                &json!({}),
                &registered
            )
            .is_err());
        assert_eq!(
            fs::read_to_string(data.path().join("reports.json")).unwrap(),
            "{broken"
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlink_cannot_register_an_outside_report() {
        let folder = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        fs::write(data.path().join("secret.md"), "private").unwrap();
        let alias = folder.path().join("report.md");
        std::os::unix::fs::symlink(data.path().join("secret.md"), &alias).unwrap();
        let store = Store::new(data.path().into());
        assert_eq!(
            store
                .request(
                    &Method::POST,
                    "/api/reports",
                    &json!({"path":alias}),
                    &roots(folder.path())
                )
                .unwrap_err()
                .0,
            403
        );
    }
}
