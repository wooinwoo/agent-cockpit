//! Copy an explicitly closed local jcode session into a new managed home.
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct LocalSession {
    pub pid: u32,
    pub home: PathBuf,
    pub id: String,
}

pub fn identify(pid: u32, home: &Path) -> io::Result<LocalSession> {
    #[cfg(target_os = "linux")]
    {
        linux::identify(pid, home).map_err(|_| invalid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (pid, home);
        Err(invalid())
    }
}

pub fn validate_target(session: &LocalSession, target: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::validate_target(session, target).map_err(|_| invalid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (session, target);
        Err(invalid())
    }
}

pub fn validate_provider(session: &LocalSession, provider: &str) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::validate_provider(session, provider).map_err(|_| invalid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (session, provider);
        Err(invalid())
    }
}

pub fn snapshot_closed(session: &LocalSession, target: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::snapshot_closed(session, target).map_err(|_| invalid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (session, target);
        Err(invalid())
    }
}

/// The caller must own this copied snapshot and must not have attempted a target launch.
pub fn archive_unlaunched(session: &LocalSession, target: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::archive_unlaunched(session, target).map_err(|_| invalid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (session, target);
        Err(invalid())
    }
}

pub fn archive_departed(session: &LocalSession) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::archive_departed(session).map_err(|_| invalid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = session;
        Err(invalid())
    }
}

pub fn copy_settings(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::copy_settings(source, target, None).map_err(|_| invalid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (source, target);
        Err(invalid())
    }
}

pub fn copy_user_settings(home: &Path, target: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::copy_settings(&home.join(".jcode"), target, Some(home)).map_err(|_| invalid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (home, target);
        Err(invalid())
    }
}

fn invalid() -> io::Error {
    // Source paths, conversation content and parser errors must not reach the API.
    io::Error::other("jcode 대화 또는 설정을 안전하게 옮길 조건을 확인하지 못했습니다. 원본은 변경하지 않았습니다.")
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use crate::accounts::account_directory;
    use serde_json::{json, Value};
    use std::{
        ffi::CString,
        fs::{self, File},
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        },
        time::{Duration, SystemTime},
    };

    const MAX_SESSION: u64 = 32 * 1024 * 1024;
    const MAX_SETTINGS: u64 = 2 * 1024 * 1024;

    fn owned(meta: &fs::Metadata, dir: bool) -> io::Result<()> {
        if meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o022 != 0
            || (dir && !meta.is_dir())
            || (!dir && (!meta.is_file() || meta.nlink() != 1))
        {
            return Err(invalid());
        }
        Ok(())
    }

    fn directory(path: &Path) -> io::Result<File> {
        let dir = account_directory(path)?;
        owned(&dir.metadata()?, true)?;
        Ok(dir)
    }

    fn child(dir: &File, name: &str, create: bool) -> io::Result<File> {
        let name = CString::new(name).map_err(|_| invalid())?;
        if create {
            let result = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) };
            if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err(io::Error::last_os_error());
            }
        }
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let result = unsafe { File::from_raw_fd(fd) };
        owned(&result.metadata()?, true)?;
        Ok(result)
    }

    fn stamp(meta: &fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
        (
            meta.dev(),
            meta.ino(),
            meta.len(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec(),
        )
    }

    fn read(dir: &File, name: &str, limit: u64) -> io::Result<(Vec<u8>, fs::Metadata)> {
        let name = CString::new(name).map_err(|_| invalid())?;
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let meta = file.metadata()?;
        owned(&meta, false)?;
        if meta.len() > limit {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit || stamp(&meta) != stamp(&file.metadata()?) {
            return Err(invalid());
        }
        Ok((bytes, meta))
    }

    fn absent(dir: &File, name: &str) -> io::Result<()> {
        let name = CString::new(name).map_err(|_| invalid())?;
        let mut meta = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                name.as_ptr(),
                meta.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(invalid())
        }
    }

    fn create_new(dir: &File, name: &str, bytes: &[u8]) -> io::Result<()> {
        let name = CString::new(name).map_err(|_| invalid())?;
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        file.sync_all()?;
        dir.sync_all()
    }

    fn valid_id(value: &str) -> bool {
        if value.len() > 256 {
            return false;
        }
        let Some(rest) = value.strip_prefix("session_") else {
            return false;
        };
        let mut parts = rest.split('_');
        let (Some(name), Some(time)) = (parts.next(), parts.next()) else {
            return false;
        };
        if name.is_empty()
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || time.len() < 10
            || !time.bytes().all(|c| c.is_ascii_digit())
        {
            return false;
        }
        match (parts.next(), parts.next()) {
            (None, _) => true,
            (Some(random), None) => {
                !random.is_empty() && random.bytes().all(|c| c.is_ascii_hexdigit())
            }
            _ => false,
        }
    }

    fn start_ticks(pid: u32) -> io::Result<u64> {
        if pid == 0 {
            return Err(invalid());
        }
        let dir = directory(&PathBuf::from(format!("/proc/{pid}")))?;
        let (raw, _) = read(&dir, "stat", 8192)?;
        let text = std::str::from_utf8(&raw).map_err(|_| invalid())?;
        let tail: Vec<_> = text
            .rsplit_once(") ")
            .ok_or_else(invalid)?
            .1
            .split_whitespace()
            .collect();
        if tail.len() < 20 || matches!(tail[0], "Z" | "X" | "x") {
            return Err(invalid());
        }
        tail[19].parse().map_err(|_| invalid())
    }

    fn process_start(ticks: u64) -> io::Result<SystemTime> {
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        let mut now = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        if hz <= 0 || unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut now) } != 0 {
            return Err(invalid());
        }
        let uptime = Duration::new(now.tv_sec as u64, now.tv_nsec as u32);
        let since_boot = Duration::from_secs_f64(ticks as f64 / hz as f64);
        // /proc starttime has one clock-tick precision.
        SystemTime::now()
            .checked_sub(
                uptime.checked_sub(since_boot).ok_or_else(invalid)?
                    + Duration::from_secs_f64(1.0 / hz as f64),
            )
            .ok_or_else(invalid)
    }

    pub(super) fn identify(pid: u32, home: &Path) -> io::Result<LocalSession> {
        let ticks = start_ticks(pid)?;
        let root = directory(home)?;
        let mappings = child(&root, "client_sessions", false)?;
        let (raw, meta) = read(&mappings, &pid.to_string(), 256)?;
        let id = std::str::from_utf8(&raw).map_err(|_| invalid())?.trim();
        if !valid_id(id) || meta.modified()? < process_start(ticks)? || start_ticks(pid)? != ticks {
            return Err(invalid());
        }
        Ok(LocalSession {
            pid,
            home: home.into(),
            id: id.into(),
        })
    }

    fn snapshot(dir: &File, id: &str, closed: bool) -> io::Result<(Vec<u8>, fs::Metadata)> {
        if !valid_id(id) {
            return Err(invalid());
        }
        let result = read(dir, &format!("{id}.json"), MAX_SESSION)?;
        let value: Value = serde_json::from_slice(&result.0).map_err(|_| invalid())?;
        if value["id"] != id || !value["messages"].is_array() {
            return Err(invalid());
        }
        if closed {
            if value["status"] != "Closed" {
                return Err(invalid());
            }
            let last = value["messages"]
                .as_array()
                .and_then(|messages| messages.last());
            let content = last
                .map(|message| message["content"].to_string())
                .unwrap_or_default();
            if [
                "[generation interrupted - server reloading]",
                "Reload initiated. Process restarting...",
                "interrupted by server reload",
                "Skipped - server reloading",
            ]
            .iter()
            .any(|marker| content.contains(marker))
            {
                return Err(invalid());
            }
        }
        Ok(result)
    }

    pub(super) fn validate_provider(session: &LocalSession, provider: &str) -> io::Result<()> {
        let source = child(&directory(&session.home)?, "sessions", false)?;
        let (bytes, _) = snapshot(&source, &session.id, false)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let stored = value["provider_key"]
            .as_str()
            .or_else(|| value["provider"].as_str());
        let matches = match provider {
            "claude" => matches!(stored, Some("anthropic" | "claude")),
            "openai" => matches!(stored, Some("openai" | "openai-oauth" | "codex")),
            _ => false,
        };
        if matches {
            Ok(())
        } else {
            Err(invalid())
        }
    }

    pub(super) fn validate_target(session: &LocalSession, target: &Path) -> io::Result<()> {
        let source = child(&directory(&session.home)?, "sessions", false)?;
        snapshot(&source, &session.id, false)?;
        let target = directory(target)?;
        match child(&target, "sessions", false) {
            Ok(sessions) => {
                absent(&sessions, &format!("{}.json", session.id))?;
                absent(&sessions, &format!("{}.journal.jsonl", session.id))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub(super) fn snapshot_closed(session: &LocalSession, target: &Path) -> io::Result<()> {
        // A local /quit must finish before trusting the daemon's final snapshot.
        match fs::symlink_metadata(format!("/proc/{}", session.pid)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            _ => return Err(invalid()),
        }
        let source = child(&directory(&session.home)?, "sessions", false)?;
        let name = format!("{}.json", session.id);
        let journal = format!("{}.journal.jsonl", session.id);
        absent(&source, &journal)?;
        let (bytes, meta) = snapshot(&source, &session.id, true)?;
        let (again, after) = read(&source, &name, MAX_SESSION)?;
        absent(&source, &journal)?;
        if bytes != again || stamp(&meta) != stamp(&after) {
            return Err(invalid());
        }
        let destination = child(&directory(target)?, "sessions", true)?;
        absent(&destination, &journal)?;
        create_new(&destination, &name, &bytes)
    }

    pub(super) fn archive_unlaunched(session: &LocalSession, target: &Path) -> io::Result<()> {
        match fs::symlink_metadata(format!("/proc/{}", session.pid)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            _ => return Err(invalid()),
        }
        let home = directory(target)?;
        let source = child(&directory(&session.home)?, "sessions", false)?;
        let destination = child(&home, "sessions", false)?;
        let source_meta = source.metadata()?;
        let target_meta = destination.metadata()?;
        if (source_meta.dev(), source_meta.ino()) == (target_meta.dev(), target_meta.ino()) {
            return Err(invalid());
        }
        match child(&home, "active_pids", false) {
            Ok(markers) => absent(&markers, &session.id)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        let name = format!("{}.json", session.id);
        let journal = format!("{}.journal.jsonl", session.id);
        absent(&source, &journal)?;
        absent(&destination, &journal)?;
        let (bytes, source_before) = snapshot(&source, &session.id, true)?;
        let (copied, target_before) = snapshot(&destination, &session.id, true)?;
        if bytes != copied {
            return Err(invalid());
        }
        let (again, source_after) = read(&source, &name, MAX_SESSION)?;
        if bytes != again || stamp(&source_before) != stamp(&source_after) {
            return Err(invalid());
        }
        let (again, target_after) = read(&destination, &name, MAX_SESSION)?;
        if copied != again || stamp(&target_before) != stamp(&target_after) {
            return Err(invalid());
        }
        absent(&source, &journal)?;
        absent(&destination, &journal)?;
        archive_snapshot(&home, &destination, &name, "failed-connections")
    }

    pub(super) fn archive_departed(session: &LocalSession) -> io::Result<()> {
        match fs::symlink_metadata(format!("/proc/{}", session.pid)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            _ => return Err(invalid()),
        }
        let home = directory(&session.home)?;
        match child(&home, "active_pids", false) {
            Ok(markers) => absent(&markers, &session.id)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        let source = child(&home, "sessions", false)?;
        let name = format!("{}.json", session.id);
        absent(&source, &format!("{}.journal.jsonl", session.id))?;
        let (before, meta) = snapshot(&source, &session.id, true)?;
        let (after, current) = read(&source, &name, MAX_SESSION)?;
        if before != after || stamp(&meta) != stamp(&current) {
            return Err(invalid());
        }
        archive_snapshot(&home, &source, &name, "moved-sessions")
    }

    fn archive_snapshot(
        home: &File,
        destination: &File,
        name: &str,
        archive_name: &str,
    ) -> io::Result<()> {
        let archive = child(home, archive_name, true)?;
        if archive.metadata()?.mode() & 0o077 != 0 {
            return Err(invalid());
        }
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|_| invalid())?
            .as_nanos();
        let archived = CString::new(format!(
            "{}-{unique}.json",
            name.strip_suffix(".json").ok_or_else(invalid)?
        ))
        .map_err(|_| invalid())?;
        let name = CString::new(name).map_err(|_| invalid())?;
        let result = unsafe {
            libc::renameat2(
                destination.as_raw_fd(),
                name.as_ptr(),
                archive.as_raw_fd(),
                archived.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        archive.sync_all()?;
        destination.sync_all()
    }

    fn optional(dir: &File, name: &str) -> io::Result<Option<Vec<u8>>> {
        match read(dir, name, MAX_SETTINGS) {
            Ok((bytes, _)) => Ok(Some(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn mcp_only(bytes: &[u8], projects: bool) -> io::Result<Vec<u8>> {
        let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if !value.is_object() {
            return Err(invalid());
        }
        let mut result = json!({});
        if let Some(servers) = value.get("mcpServers") {
            result["mcpServers"] = servers.clone();
        }
        if projects {
            if let Some(entries) = value["projects"].as_object() {
                for (path, project) in entries {
                    if let Some(servers) = project.get("mcpServers") {
                        result["projects"][path] = json!({"mcpServers": servers});
                    }
                }
            }
        }
        serde_json::to_vec(&result).map_err(|_| invalid())
    }

    pub(super) fn copy_settings(
        source: &Path,
        target: &Path,
        user_home: Option<&Path>,
    ) -> io::Result<()> {
        let from = directory(source)?;
        let to = directory(target)?;
        let mut files: Vec<(Vec<&str>, Vec<u8>)> = Vec::new();
        for name in ["config.toml", "mcp.json"] {
            if let Some(bytes) = optional(&from, name)? {
                files.push((vec![name], bytes));
            }
        }
        let external = match child(&from, "external", false) {
            Ok(directory) => Some(directory),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let home = user_home
                    .map(PathBuf::from)
                    .or_else(|| std::env::var_os("HOME").map(PathBuf::from));
                if home
                    .as_ref()
                    .is_some_and(|home| home.join(".jcode") == source)
                {
                    Some(directory(home.as_ref().unwrap())?)
                } else {
                    None
                }
            }
            Err(error) => return Err(error),
        };
        if let Some(external) = external {
            if let Some(bytes) = optional(&external, ".claude.json")? {
                files.push((vec!["external", ".claude.json"], mcp_only(&bytes, true)?));
            }
            match child(&external, ".claude", false) {
                Ok(claude) => {
                    if let Some(bytes) = optional(&claude, "mcp.json")? {
                        files.push((
                            vec!["external", ".claude", "mcp.json"],
                            mcp_only(&bytes, false)?,
                        ));
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error),
            }
        }
        // Validate all destinations before writing settings into the new home.
        let mut destinations = Vec::new();
        for (parts, bytes) in files {
            let mut parent = to.try_clone()?;
            for part in &parts[..parts.len() - 1] {
                parent = child(&parent, part, true)?;
            }
            let name = parts[parts.len() - 1];
            match optional(&parent, name)? {
                Some(existing) if existing == bytes => (),
                Some(_) => return Err(invalid()),
                None => destinations.push((parent, name, bytes)),
            }
        }
        for (parent, name, bytes) in destinations {
            create_new(&parent, name, &bytes)?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            os::unix::fs::{symlink, DirBuilderExt, OpenOptionsExt, PermissionsExt},
            time::UNIX_EPOCH,
        };

        fn write_fixture(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
            fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(path)?
                .write_all(bytes.as_ref())
        }
        const ID: &str = "session_blue-whale_1790191044353_621ff7b98fbf962b";
        fn fixture() -> (tempfile::TempDir, tempfile::TempDir, LocalSession) {
            let source = tempfile::Builder::new()
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            let target = tempfile::Builder::new()
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            fs::DirBuilder::new()
                .mode(0o700)
                .create(source.path().join("sessions"))
                .unwrap();
            let session = LocalSession {
                pid: u32::MAX,
                home: source.path().into(),
                id: ID.into(),
            };
            save(
                &session,
                json!({"id":ID,"status":"Closed","messages":[],"custom":{"kept":true}}),
            );
            (source, target, session)
        }
        fn save(session: &LocalSession, value: Value) {
            write_fixture(
                session.home.join("sessions").join(format!("{ID}.json")),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }
        #[test]
        fn handoff_requires_the_same_stored_provider_before_quitting() {
            let (_source, _target, session) = fixture();
            save(
                &session,
                json!({"id":ID,"status":"Active","messages":[],"provider_key":"claude","model":"claude-opus-5-5"}),
            );
            assert!(validate_provider(&session, "claude").is_ok());
            assert!(validate_provider(&session, "openai").is_err());
            save(
                &session,
                json!({"id":ID,"status":"Active","messages":[],"provider_key":"openai","model":"gpt-6.1-sol"}),
            );
            assert!(validate_provider(&session, "openai").is_ok());
            assert!(validate_provider(&session, "claude").is_err());
        }
        #[test]
        fn departed_snapshot_moves_only_after_exit_and_closed_flush() {
            let (_source, _target, mut session) = fixture();
            session.pid = std::process::id();
            assert!(archive_departed(&session).is_err());
            session.pid = u32::MAX;
            save(&session, json!({"id":ID,"status":"Active","messages":[]}));
            assert!(archive_departed(&session).is_err());
            save(
                &session,
                json!({"id":ID,"status":"Closed","messages":[{"content":"preserved fixture"}]}),
            );
            let original = session.home.join("sessions").join(format!("{ID}.json"));
            let bytes = fs::read(&original).unwrap();
            let meta = fs::metadata(&original).unwrap();
            archive_departed(&session).unwrap();
            assert!(!original.exists());
            let archived = fs::read_dir(session.home.join("moved-sessions"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            assert_eq!(fs::read(&archived).unwrap(), bytes);
            assert_eq!(fs::metadata(archived).unwrap().ino(), meta.ino());
        }
        #[test]
        fn exact_ids_and_process_marker() {
            for good in [ID, "session_fox_1790191044353"] {
                assert!(valid_id(good));
            }
            for bad in [
                "../session_fox_1790191044353",
                "session_foo_123",
                "session_foo_bar_1234567890",
                "session_fox_1790191044353_zz",
            ] {
                assert!(!valid_id(bad));
            }
            let home = tempfile::Builder::new()
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            fs::DirBuilder::new()
                .mode(0o700)
                .create(home.path().join("client_sessions"))
                .unwrap();
            let pid = std::process::id();
            let path = home.path().join("client_sessions").join(pid.to_string());
            write_fixture(&path, ID).unwrap();
            assert_eq!(identify(pid, home.path()).unwrap().id, ID);
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(UNIX_EPOCH)
                .unwrap();
            assert!(identify(pid, home.path()).is_err());
            fs::remove_file(&path).unwrap();
            let other = home.path().join("other");
            write_fixture(&other, ID).unwrap();
            symlink(other, path).unwrap();
            assert!(identify(pid, home.path()).is_err());
        }
        #[test]
        fn closed_snapshot_preserves_bytes_and_never_overwrites() {
            let (source, target, session) = fixture();
            validate_target(&session, target.path()).unwrap();
            snapshot_closed(&session, target.path()).unwrap();
            let path = PathBuf::from("sessions").join(format!("{ID}.json"));
            assert_eq!(
                fs::read(source.path().join(&path)).unwrap(),
                fs::read(target.path().join(&path)).unwrap()
            );
            assert_eq!(
                fs::metadata(target.path().join(&path))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert!(validate_target(&session, target.path()).is_err());
            assert!(snapshot_closed(&session, target.path()).is_err());
        }
        #[test]
        fn unlaunched_archive_preserves_copy_and_allows_retry() {
            let (source, target, session) = fixture();
            snapshot_closed(&session, target.path()).unwrap();
            let name = format!("{ID}.json");
            let copied = target.path().join("sessions").join(&name);
            let before = fs::metadata(&copied).unwrap();
            let bytes = fs::read(&copied).unwrap();
            archive_unlaunched(&session, target.path()).unwrap();
            assert!(!copied.exists());
            let archive = target.path().join("failed-connections");
            assert_eq!(fs::metadata(&archive).unwrap().mode() & 0o777, 0o700);
            let entries: Vec<_> = fs::read_dir(archive).unwrap().collect();
            assert_eq!(entries.len(), 1);
            let archived = entries[0].as_ref().unwrap().path();
            let after = fs::metadata(&archived).unwrap();
            assert_eq!(fs::read(archived).unwrap(), bytes);
            assert_eq!((before.ino(), before.mode()), (after.ino(), after.mode()));
            assert_eq!(
                fs::read(source.path().join("sessions").join(name)).unwrap(),
                bytes
            );
            validate_target(&session, target.path()).unwrap();
            snapshot_closed(&session, target.path()).unwrap();
        }
        #[test]
        fn unlaunched_archive_rejects_changed_copy_and_active_marker() {
            let (_source, target, session) = fixture();
            snapshot_closed(&session, target.path()).unwrap();
            let copied = target.path().join("sessions").join(format!("{ID}.json"));
            let original = fs::read(&copied).unwrap();
            let changed = serde_json::to_vec(
                &json!({"id":ID,"status":"Closed","messages":[],"changed":true}),
            )
            .unwrap();
            write_fixture(&copied, &changed).unwrap();
            assert!(archive_unlaunched(&session, target.path()).is_err());
            assert_eq!(fs::read(&copied).unwrap(), changed);
            assert!(!target.path().join("failed-connections").exists());
            write_fixture(&copied, &original).unwrap();
            fs::DirBuilder::new()
                .mode(0o700)
                .create(target.path().join("active_pids"))
                .unwrap();
            write_fixture(target.path().join("active_pids").join(ID), b"999999999").unwrap();
            assert!(archive_unlaunched(&session, target.path()).is_err());
            assert_eq!(fs::read(&copied).unwrap(), original);
            assert!(archive_unlaunched(&session, &session.home).is_err());
        }
        #[test]
        fn unfinished_invalid_and_reload_snapshots_are_rejected() {
            for value in [
                json!({"id":ID,"status":"Active","messages":[]}),
                json!({"id":ID,"status":"closed","messages":[]}),
                json!({"id":"different","status":"Closed","messages":[]}),
                json!({"id":ID,"status":"Closed","messages":[{"content":[{"type":"text","text":"[generation interrupted - server reloading]"}]}]}),
                json!({"id":ID,"status":"Closed","messages":[{"content":[{"type":"tool_result","content":"Reload initiated. Process restarting..."}]}]}),
            ] {
                let (_source, target, session) = fixture();
                save(&session, value);
                assert!(snapshot_closed(&session, target.path()).is_err());
                assert!(!target.path().join("sessions").exists());
            }
            let (_source, target, mut session) = fixture();
            session.pid = std::process::id();
            assert!(snapshot_closed(&session, target.path()).is_err());
        }
        #[test]
        fn journals_and_symlinks_are_rejected() {
            let (source, target, session) = fixture();
            let journal = source
                .path()
                .join("sessions")
                .join(format!("{ID}.journal.jsonl"));
            write_fixture(&journal, b"").unwrap();
            assert!(snapshot_closed(&session, target.path()).is_err());
            fs::remove_file(journal).unwrap();
            symlink(
                source.path().join("sessions"),
                target.path().join("sessions"),
            )
            .unwrap();
            assert!(snapshot_closed(&session, target.path()).is_err());
        }
        #[test]
        fn settings_copy_is_idempotent_with_normalized_external_mcp() {
            let source = tempfile::Builder::new()
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            let target = tempfile::Builder::new()
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            write_fixture(
                source.path().join("config.toml"),
                b"[display]\ncompact = true\n",
            )
            .unwrap();
            write_fixture(source.path().join("mcp.json"), b"{\"mcpServers\":{}}").unwrap();
            write_fixture(source.path().join("auth.json"), b"never copy").unwrap();
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(source.path().join("external/.claude"))
                .unwrap();
            write_fixture(source.path().join("external/.claude.json"), br#"{"oauthAccount":"excluded","mcpServers":{"foo":{}},"projects":{"/work":{"mcpServers":{"bar":{}},"history":"excluded"}}}"#).unwrap();
            write_fixture(
                source.path().join("external/.claude/mcp.json"),
                br#"{"mcpServers":{"baz":{}},"unrelated":"excluded"}"#,
            )
            .unwrap();
            copy_settings(source.path(), target.path(), None).unwrap();
            let value: Value = serde_json::from_slice(
                &fs::read(target.path().join("external/.claude.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                value,
                json!({"mcpServers":{"foo":{}},"projects":{"/work":{"mcpServers":{"bar":{}}}}})
            );
            assert!(!target.path().join("auth.json").exists());
            let before = stamp(&fs::metadata(target.path().join("config.toml")).unwrap());
            write_fixture(source.path().join("external/.claude.json"), br#"{"projects":{"/work":{"history":"changed","mcpServers":{"bar":{}}}},"mcpServers":{"foo":{}},"oauthAccount":"changed"}"#).unwrap();
            copy_settings(source.path(), target.path(), None).unwrap();
            assert_eq!(
                before,
                stamp(&fs::metadata(target.path().join("config.toml")).unwrap())
            );
            assert_eq!(
                fs::read(target.path().join("config.toml")).unwrap(),
                b"[display]\ncompact = true\n"
            );
        }

        #[test]
        fn conflicting_settings_are_not_overwritten_or_partially_copied() {
            let source = tempfile::Builder::new()
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            let target = tempfile::Builder::new()
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            write_fixture(source.path().join("config.toml"), b"new setting").unwrap();
            write_fixture(source.path().join("mcp.json"), b"{\"mcpServers\":{}}").unwrap();
            let existing = b"{\"mcpServers\":{\"kept\":{}}}";
            write_fixture(target.path().join("mcp.json"), existing).unwrap();
            assert!(copy_settings(source.path(), target.path(), None).is_err());
            assert_eq!(fs::read(target.path().join("mcp.json")).unwrap(), existing);
            assert!(!target.path().join("config.toml").exists());
        }

        #[test]
        fn identical_settings_symlink_is_rejected() {
            let source = tempfile::Builder::new()
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            let target = tempfile::Builder::new()
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            write_fixture(source.path().join("config.toml"), b"same setting").unwrap();
            symlink(
                source.path().join("config.toml"),
                target.path().join("config.toml"),
            )
            .unwrap();
            assert!(copy_settings(source.path(), target.path(), None).is_err());
            assert!(fs::symlink_metadata(target.path().join("config.toml"))
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(
                fs::read(source.path().join("config.toml")).unwrap(),
                b"same setting"
            );
        }
    }
}
