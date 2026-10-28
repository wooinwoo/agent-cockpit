use crate::{json_values::Object, projects};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/file"),
    ("POST", "/api/upload-image"),
    ("POST", "/api/uploads"),
];
const UPLOAD_LIMIT: usize = 10 * 1024 * 1024;
const PREVIEW_LIMIT: u64 = 2 * 1024 * 1024;

pub struct Store {
    directory: PathBuf,
}

pub fn route(method: &Method, path: &str) -> bool {
    (*method == Method::GET && path == "/api/file")
        || (*method == Method::POST && matches!(path, "/api/upload-image" | "/api/uploads"))
}

fn error(status: u16, message: impl Into<String>) -> Response {
    (
        axum::http::StatusCode::from_u16(status).unwrap(),
        Json(json!({"error":message.into()})),
    )
        .into_response()
}

fn normalized(path: &Path) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

pub(crate) fn allowed_path(path: &Path, projects: &[Object]) -> bool {
    // Check filesystem and lexical semantics: neither a symlink followed by
    // `..` nor missing components followed by `..` may escape the project.
    ancestor_inside(path, projects) && ancestor_inside(&normalized(path), projects)
}

fn ancestor_inside(path: &Path, projects: &[Object]) -> bool {
    let mut ancestor = path;
    loop {
        if fs::symlink_metadata(ancestor).is_ok() {
            return projects::inside(ancestor, projects);
        }
        let Some(parent) = ancestor.parent() else {
            return false;
        };
        ancestor = parent;
    }
}

fn io_message(error: &io::Error, operation: &str, path: &Path) -> String {
    let (code, description) = match error.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        _ => return error.to_string(),
    };
    if operation == "read" && error.kind() == io::ErrorKind::IsADirectory {
        format!("{code}: {description}, read")
    } else {
        format!("{code}: {description}, {operation} '{}'", path.display())
    }
}

fn open_preview(path: &Path, roots: &[PathBuf]) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("File preview requires a regular file"));
    }
    // Check the opened descriptor, not the name checked before open. A parent
    // directory can be replaced with a symlink between those operations.
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let opened = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        if !roots.iter().any(|root| opened.starts_with(root)) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Opened file is outside project directories",
            ));
        }
        Ok(file)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = roots;
        Err(io::Error::other(
            "Opened-file path verification is not implemented on this platform",
        ))
    }
}

fn find(bytes: &[u8], needle: &[u8]) -> Option<usize> {
    bytes
        .windows(needle.len())
        .position(|window| window == needle)
}

fn boundary(content_type: &str) -> Result<String, (u16, String)> {
    if !content_type.starts_with("multipart/form-data") {
        return Err((400, "expected multipart/form-data".into()));
    }
    static BOUNDARY: OnceLock<regex::Regex> = OnceLock::new();
    let captures = BOUNDARY
        .get_or_init(|| regex::Regex::new(r#"boundary=(?:"([^"]+)"|([^;\s]+))"#).unwrap())
        .captures(content_type)
        .ok_or_else(|| (400, "no boundary in content-type".into()))?;
    Ok(format!(
        "--{}",
        captures
            .get(1)
            .or_else(|| captures.get(2))
            .unwrap()
            .as_str()
    ))
}

pub fn upload_header_error(path: &str, content_type: &str) -> Option<Response> {
    if path != "/api/uploads" {
        return None;
    }
    boundary(content_type)
        .err()
        .map(|(status, message)| error(status, message))
}

fn multipart<'a>(content_type: &str, body: &'a [u8]) -> Result<(&'a [u8], String), (u16, String)> {
    let boundary = boundary(content_type)?;
    if body.len() > UPLOAD_LIMIT {
        return Err((413, "file too large (>10MB)".into()));
    }
    let mut remaining = body;
    loop {
        let next = find(remaining, boundary.as_bytes());
        let part = &remaining[..next.unwrap_or(remaining.len())];
        if find(part, b"Content-Disposition").is_some() {
            if let Some(header_end) = find(part, b"\r\n\r\n") {
                let headers = &part[..header_end];
                if let Some(start) = find(headers, b"filename=\"") {
                    let tail = &headers[start + 10..];
                    if let Some(end) = tail
                        .iter()
                        .position(|byte| *byte == b'"')
                        .filter(|end| *end > 0)
                    {
                        let name = &tail[..end];
                        let suffix = name.rsplit(|byte| *byte == b'.').next().unwrap_or_default();
                        let suffix = if suffix.is_empty() {
                            b"bin".as_slice()
                        } else {
                            suffix
                        };
                        // Node's binary string maps each byte to the same Latin-1 code point.
                        let extension: String = suffix
                            .iter()
                            .map(|byte| char::from(*byte))
                            .collect::<String>()
                            .to_lowercase()
                            .chars()
                            .take(8)
                            .collect();
                        if extension
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                        {
                            if !["png", "jpg", "jpeg", "gif", "webp", "svg"]
                                .contains(&extension.as_str())
                            {
                                return Err((400, format!("extension .{extension} not allowed")));
                            }
                            let start = header_end + 4;
                            let end = part
                                .windows(2)
                                .rposition(|bytes| bytes == b"\r\n")
                                .unwrap_or_else(|| part.len().saturating_sub(1));
                            let data = if end < start {
                                &part[start..start]
                            } else {
                                &part[start..end]
                            };
                            return Ok((data, extension));
                        }
                    }
                }
            }
        }
        match next {
            Some(index) => remaining = &remaining[index + boundary.len()..],
            None => break,
        }
    }
    Err((400, "no file found in upload".into()))
}

fn base36(mut value: u128) -> String {
    let mut bytes = Vec::new();
    loop {
        bytes.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    bytes.reverse();
    String::from_utf8(bytes).unwrap()
}

impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub fn handle(
        &self,
        path: &str,
        query: &HashMap<String, String>,
        content_type: &str,
        body: &[u8],
        projects: &projects::Store,
    ) -> Response {
        if path == "/api/file" {
            return self.preview(query, projects);
        }
        let (data, extension, paste) = if path == "/api/upload-image" {
            if body.len() > UPLOAD_LIMIT {
                return error(413, "File too large (max 10 MB)");
            }
            if body.is_empty() {
                return error(400, "empty body");
            }
            (
                body,
                if content_type.contains("png") {
                    "png".to_owned()
                } else {
                    "jpg".to_owned()
                },
                true,
            )
        } else if path == "/api/uploads" {
            match multipart(content_type, body) {
                Ok((data, extension)) => (data, extension, false),
                Err((status, message)) => return error(status, message),
            }
        } else {
            return error(404, "Not found");
        };
        match self.save(data, &extension, paste) {
            Ok((path, _)) if paste => Json(json!({"path":path})).into_response(),
            Ok((path, name)) => {
                Json(json!({"path":path,"name":name,"size":data.len()})).into_response()
            }
            Err(error_value) => error(500, error_value.to_string()),
        }
    }

    fn preview(&self, query: &HashMap<String, String>, projects: &projects::Store) -> Response {
        let Some(path) = query.get("path").filter(|path| !path.is_empty()) else {
            return error(400, "Missing path");
        };
        let registered = match projects.list() {
            Ok(projects) => projects,
            Err(value) => return error(500, value.to_string()),
        };
        let roots: Vec<_> = registered
            .iter()
            .filter_map(|p| {
                p.get("path")
                    .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
            })
            .filter_map(|path| fs::canonicalize(path).ok())
            .collect();
        let resolved = normalized(Path::new(path));
        if !allowed_path(Path::new(path), &registered) {
            return error(403, "Access denied: path outside project directories");
        }
        let metadata = match fs::metadata(&resolved) {
            Ok(metadata) => metadata,
            Err(value) => return error(404, io_message(&value, "stat", &resolved)),
        };
        if metadata.len() > PREVIEW_LIMIT {
            return error(413, "File too large (>2MB)");
        }
        if !metadata.is_file() {
            return error(
                404,
                if metadata.is_dir() {
                    "EISDIR: illegal operation on a directory, read"
                } else {
                    "File preview requires a regular file"
                },
            );
        }
        // Resolve the expected target, then verify the actual opened descriptor.
        let canonical = match resolved.canonicalize() {
            Ok(canonical) if projects::inside(&canonical, &registered) => canonical,
            _ => return error(403, "Access denied: path outside project directories"),
        };
        let read = || -> io::Result<Vec<u8>> {
            let file = open_preview(&canonical, &roots)?;
            let mut bytes = Vec::new();
            file.take(PREVIEW_LIMIT + 1).read_to_end(&mut bytes)?;
            Ok(bytes)
        };
        match read() {
            Ok(bytes) if bytes.len() as u64 > PREVIEW_LIMIT => error(413, "File too large (>2MB)"),
            Ok(bytes) => Json(json!({"path":path,"name":path.replace('\\',"/").split('/').next_back().unwrap_or(""),"size":metadata.len(),"content":String::from_utf8_lossy(&bytes)})).into_response(),
            Err(value) => error(404, io_message(&value, "open", &resolved)),
        }
    }

    fn save(&self, bytes: &[u8], extension: &str, paste: bool) -> io::Result<(PathBuf, String)> {
        let directory = self.directory.join(if paste {
            "cockpit-paste"
        } else {
            "cockpit-uploads"
        });
        if !crate::account_hub::safe_path(&self.directory, &directory) {
            return Err(io::Error::other("Unsafe upload directory"));
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?;
        if !crate::account_hub::safe_path(&self.directory, &directory) {
            return Err(io::Error::other("Unsafe upload directory"));
        }
        for _ in 0..8 {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let random = rand::random::<[u8; 4]>();
            let name = if paste {
                format!(
                    "paste-{timestamp}-{:02x}{:02x}{:02x}{:02x}.{extension}",
                    random[0], random[1], random[2], random[3]
                )
            } else {
                format!(
                    "img-{}-{:02x}{:02x}{:02x}.{extension}",
                    base36(timestamp),
                    random[0],
                    random[1],
                    random[2]
                )
            };
            let path = directory.join(&name);
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut file = match options.open(&path) {
                Ok(file) => file,
                Err(value) if value.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(value) => return Err(value),
            };
            if let Err(value) = file.write_all(bytes) {
                let _ = fs::remove_file(&path);
                return Err(value);
            }
            return Ok((path, name));
        }
        Err(io::Error::other("Could not allocate an upload filename"))
    }

    // The parent schedules this after five seconds, then every thirty minutes.
    pub fn cleanup(&self) {
        let directory = self.directory.join("cockpit-paste");
        if !crate::account_hub::safe_path(&self.directory, &directory) {
            return;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        let now = SystemTime::now();
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with("paste-") {
                continue;
            }
            let path = entry.path();
            if !crate::account_hub::safe_path(&self.directory, &path) {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.is_file()
                && metadata
                    .modified()
                    .ok()
                    .and_then(|time| now.duration_since(time).ok())
                    .is_some_and(|age| age > Duration::from_secs(3600))
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn opened_descriptor_rejects_a_parent_replaced_after_validation() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("project");
        let parent = root.join("sub");
        let outside = temporary.path().join("outside");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(parent.join("data.txt"), "allowed").unwrap();
        fs::write(outside.join("data.txt"), "private outside bytes").unwrap();
        let roots = vec![root.canonicalize().unwrap()];
        let checked = parent.join("data.txt").canonicalize().unwrap();
        assert!(open_preview(&checked, &roots).is_ok());
        fs::rename(&parent, root.join("old-sub")).unwrap();
        symlink(&outside, &parent).unwrap();
        assert_eq!(
            open_preview(&checked, &roots).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn multipart_preserves_binary_and_original_extension_rules() {
        let body = b"--abc\r\nContent-Disposition: form-data; name=\"file\"; filename=\"../x.PNG\"\r\n\r\n\x00\xff\r\n--abc--\r\n";
        assert_eq!(
            multipart("multipart/form-data; boundary=\"abc\"", body).unwrap(),
            (&b"\x00\xff"[..], "png".into())
        );
        assert_eq!(
            multipart("image/png", body).unwrap_err(),
            (400, "expected multipart/form-data".into())
        );
        assert_eq!(
            multipart("multipart/form-data", body).unwrap_err(),
            (400, "no boundary in content-type".into())
        );
        assert_eq!(
            multipart("multipart/form-data; boundary=abc", b"none").unwrap_err(),
            (400, "no file found in upload".into())
        );
        let body = String::from_utf8_lossy(body).replace("x.PNG", "x.exe");
        assert_eq!(
            multipart("multipart/form-data; boundary=abc", body.as_bytes()).unwrap_err(),
            (400, "extension .exe not allowed".into())
        );
    }

    #[test]
    fn uploads_are_private_and_cleanup_only_removes_old_paste_files() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let (old, _) = store.save(b"bytes", "png", true).unwrap();
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(3601)),
            )
            .unwrap();
        let (fresh, _) = store.save(b"new", "jpg", true).unwrap();
        let keep = old.parent().unwrap().join("keep.txt");
        fs::write(&keep, "keep").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        store.cleanup();
        assert!(!old.exists());
        assert_eq!(fs::read(fresh).unwrap(), b"new");
        assert!(keep.exists());
    }

    #[cfg(unix)]
    #[test]
    fn shared_guard_checks_missing_components_and_symlink_parent_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        let outside = directory.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(outside.join("child")).unwrap();
        let projects = vec![Object::from([(
            "path".into(),
            serde_json::value::to_raw_value(&root).unwrap(),
        )])];
        assert!(allowed_path(&root.join("new/file.txt"), &projects));
        assert!(!allowed_path(
            &root.join("new/../../outside/file.txt"),
            &projects
        ));
        std::os::unix::fs::symlink(outside.join("child"), root.join("link")).unwrap();
        assert!(!allowed_path(&root.join("link/../file.txt"), &projects));
    }
}
