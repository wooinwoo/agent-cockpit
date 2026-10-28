//! Telegram's JSONL backlog, with fresh reads and cancellation-aware writes.
//!
//! Unlike the original load/save helpers, damaged records and failed writes are
//! errors. They must never turn a damaged backlog into an empty replacement.
use crate::{
    ai_transport::Cancel,
    board_value::{object, V},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

const FILE: &str = "telegram-todos.jsonl";
const BACKUP: &str = "telegram-todos.jsonl.bak";
const MAX_BYTES: usize = 4 * 1024 * 1024;
const CANCELLED: &str = "Telegram todo request cancelled";

fn check(cancel: &Cancel) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn timestamp(ms: i64) -> Result<V, String> {
    if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&ms) {
        return Err("Invalid time value".into());
    }
    let seconds = ms.div_euclid(1000) as libc::time_t;
    let mut date: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut date) }.is_null() {
        return Err("Invalid time value".into());
    }
    let year = date.tm_year + 1900;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Ok(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.tm_mon + 1,
        date.tm_mday,
        date.tm_hour,
        date.tm_min,
        date.tm_sec,
        ms.rem_euclid(1000)
    )
    .into())
}
#[cfg(not(unix))]
fn timestamp(_ms: i64) -> Result<V, String> {
    Err("Native Telegram todo storage is only validated on Linux".into())
}

struct Storage {
    directory: File,
    path: PathBuf,
}
impl Storage {
    #[cfg(target_os = "linux")]
    fn open(root: &Path, create: bool) -> Result<Option<Self>, String> {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::{ffi::OsStrExt, fs::OpenOptionsExt},
            },
        };
        if !root.is_absolute() {
            return Err("Telegram todo directory must be absolute".into());
        }
        let mut directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open("/")
            .map_err(|error| error.to_string())?;
        // Anchor every component, including ancestors of the supplied root.
        // Later renames cannot redirect reads or commits through a symlink.
        for component in root.components().chain(Path::new("logs").components()) {
            let name = match component {
                Component::RootDir | Component::CurDir => continue,
                Component::Normal(name) => {
                    CString::new(name.as_bytes()).map_err(|_| "Invalid Telegram todo directory")?
                }
                _ => return Err("Invalid Telegram todo directory".into()),
            };
            if create {
                let result = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                if result != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(io::Error::last_os_error().to_string());
                }
            }
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                let error = io::Error::last_os_error();
                if !create && error.kind() == io::ErrorKind::NotFound {
                    return Ok(None);
                }
                return Err(error.to_string());
            }
            directory = unsafe { File::from_raw_fd(fd) };
        }
        let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        Ok(Some(Self { directory, path }))
    }
    #[cfg(not(target_os = "linux"))]
    fn open(_root: &Path, _create: bool) -> Result<Option<Self>, String> {
        Err("Native Telegram todo storage is only validated on Linux".into())
    }
    fn bytes(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = match options.open(self.path.join(name)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if !file
            .metadata()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            return Err("Invalid Telegram todo storage file".into());
        }
        let mut data = Vec::new();
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut data)
            .map_err(|error| error.to_string())?;
        if data.len() > MAX_BYTES {
            return Err("Telegram todo storage exceeds size limit".into());
        }
        Ok(Some(data))
    }
    fn read(&self) -> Result<(Vec<V>, Option<Vec<u8>>), String> {
        let before = self.bytes(FILE)?;
        let mut rows = vec![];
        if let Some(bytes) = &before {
            let text = std::str::from_utf8(bytes).map_err(|_| "Invalid Telegram todo JSONL")?;
            // JavaScript trim removes FEFF but does not remove NEL (U+0085).
            let text = text.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'));
            for line in text.split('\n').filter(|line| !line.is_empty()) {
                let raw = serde_json::value::RawValue::from_string(line.into())
                    .map_err(|_| "Invalid Telegram todo JSONL")?;
                let row = V::parse(&raw).map_err(|_| "Invalid Telegram todo JSONL")?;
                // Malformed IDs are rejected instead of coercing strings or
                // producing null/duplicate IDs through Math.max(NaN).
                if !matches!(&row, V::Object(_))
                    || !matches!(&row["id"], V::Number(id) if id.is_finite())
                {
                    return Err(
                        "Invalid Telegram todo record or ID; original data preserved".into(),
                    );
                }
                rows.push(row);
            }
        }
        Ok((rows, before))
    }
    fn temporary(&self, bytes: &[u8]) -> Result<tempfile::NamedTempFile, String> {
        let mut file = tempfile::NamedTempFile::new_in(&self.path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        Ok(file)
    }
    fn persist(
        &self,
        file: tempfile::NamedTempFile,
        name: &str,
        cancel: &Cancel,
    ) -> Result<(), String> {
        check(cancel)?;
        file.persist(self.path.join(name))
            .map_err(|e| e.error.to_string())?;
        self.directory.sync_all().map_err(|e| e.to_string())
    }
    fn save(&self, rows: &[V], before: Option<Vec<u8>>, cancel: &Cancel) -> Result<(), String> {
        check(cancel)?;
        if self.bytes(FILE)? != before {
            return Err("Telegram todos changed during update".into());
        }
        let mut bytes = Vec::new();
        for row in rows {
            let raw = row.raw();
            if raw.get().len() + 1 > MAX_BYTES.saturating_sub(bytes.len()) {
                return Err("Telegram todo storage exceeds size limit".into());
            }
            bytes.extend_from_slice(raw.get().as_bytes());
            bytes.push(b'\n');
        }
        let file = self.temporary(&bytes)?;
        self.bytes(BACKUP)?; // Refuse existing symlink/nonregular backups as well.
        if let Some(bytes) = &before {
            self.persist(self.temporary(bytes)?, BACKUP, cancel)?;
        }
        if self.bytes(FILE)? != before {
            return Err("Telegram todos changed during update".into());
        }
        self.persist(file, FILE, cancel)
    }
}

pub struct Store {
    directory: PathBuf,
    writer: Mutex<()>,
}
impl Store {
    pub fn read_log(&self, name: &str) -> Result<Option<String>, String> {
        if !matches!(name, "approvals.jsonl" | "server.log") {
            return Err("Unsupported Telegram log".into());
        }
        let Some(storage) = Storage::open(&self.directory, false)? else {
            return Ok(None);
        };
        storage
            .bytes(name)?
            .map(|data| String::from_utf8(data).map_err(|_| "Invalid log encoding".into()))
            .transpose()
    }
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            writer: Mutex::new(()),
        }
    }
    pub fn list(&self, include_done: bool) -> Result<V, String> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "Telegram todo lock unavailable")?;
        let rows = match Storage::open(&self.directory, false)? {
            Some(storage) => storage.read()?.0,
            None => vec![],
        };
        Ok(V::Array(
            rows.into_iter()
                .filter(|row| include_done || row["status"] == V::from("pending"))
                .collect(),
        ))
    }
    pub fn add(&self, text: &V, now: i64, cancel: &Cancel) -> Result<V, String> {
        check(cancel)?;
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "Telegram todo lock unavailable")?;
        check(cancel)?;
        let timestamp = timestamp(now)?;
        let storage = Storage::open(&self.directory, true)?.unwrap();
        let (mut rows, before) = storage.read()?;
        let id = if rows.is_empty() {
            1.0
        } else {
            let maximum = rows
                .iter()
                .map(|row| row["id"].number())
                .fold(f64::NEG_INFINITY, f64::max);
            let next = maximum + 1.0;
            if !next.is_finite() || next <= maximum {
                return Err("Telegram todo ID cannot be incremented safely".into());
            }
            next
        };
        let row = object([
            ("id", id.into()),
            ("ts", timestamp),
            ("text", text.clone()),
            ("status", "pending".into()),
        ]);
        rows.push(row.clone());
        storage.save(&rows, before, cancel)?;
        Ok(row)
    }
    pub fn done(&self, id: f64, now: i64, cancel: &Cancel) -> Result<V, String> {
        check(cancel)?;
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "Telegram todo lock unavailable")?;
        check(cancel)?;
        let Some(storage) = Storage::open(&self.directory, false)? else {
            return Ok(V::Null);
        };
        let (mut rows, before) = storage.read()?;
        let Some(row) = rows.iter_mut().find(|row| row["id"].number() == id) else {
            return Ok(V::Null);
        };
        row["status"] = "done".into();
        row["doneAt"] = timestamp(now)?;
        let result = row.clone();
        storage.save(&rows, before, cancel)?;
        Ok(result)
    }
    pub fn next(&self) -> Result<V, String> {
        Ok(self
            .list(false)?
            .array()
            .first()
            .cloned()
            .unwrap_or(V::Null))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        sync::Arc,
    };
    fn json(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    fn seed(directory: &Path, bytes: &[u8]) {
        fs::create_dir_all(directory.join("logs")).unwrap();
        fs::write(directory.join("logs").join(FILE), bytes).unwrap();
    }
    #[test]
    fn source_fixtures_preserve_fresh_jsonl_order_ids_timestamps_and_utf16() {
        let fixtures = json(include_str!("../../tests/fixtures/rust-telegram-todo.json"));
        assert!(fixtures.array().len() >= 30);
        for (index, fixture) in fixtures.array().iter().enumerate() {
            let input = &fixture["input"];
            let directory = tempfile::tempdir().unwrap();
            if input.has("raw") {
                seed(directory.path(), input["raw"].text().as_bytes());
            }
            let store = Store::new(directory.path().into());
            let cancel = Cancel::default();
            let now = input["now"].number() as i64;
            let actual = match input["action"].text().as_str() {
                "list" => store.list(input["includeDone"].truthy()),
                "add" => store.add(&input["text"], now, &cancel),
                "done" => store.done(input["id"].number(), now, &cancel),
                "next" => store.next(),
                _ => panic!("Unknown fixture action"),
            }
            .map(|value| object([("value", value), ("rows", store.list(true).unwrap())]))
            .unwrap_or_else(|error| object([("error", error.into())]));
            assert_eq!(
                actual,
                fixture["expected"],
                "Telegram todo source fixture {index}: {}",
                input.raw().get()
            );
        }
    }
    #[test]
    fn fresh_reads_backup_exact_original_bytes_and_private_modes() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let cancel = Cancel::default();
        assert_eq!(store.list(false).unwrap(), V::Array(vec![]));
        assert!(!directory.path().join("logs").exists());
        let original = b" {\"id\":7,\"status\":\"pending\",\"text\":\"keep\\ud800\",\"future\":{\"v\":\"\\udc00\"}} \n\n";
        seed(directory.path(), original);
        assert_eq!(store.next().unwrap()["id"], 7.0.into());
        let added = store
            .add(
                &json(r#"["new\ud800",null,{"nested":"\udc00"}]"#),
                -1,
                &cancel,
            )
            .unwrap();
        assert_eq!(added["id"], 8.0.into());
        assert_eq!(added["ts"], "1969-12-31T23:59:59.999Z".into());
        let file = directory.path().join("logs").join(FILE);
        let backup = directory.path().join("logs").join(BACKUP);
        assert_eq!(fs::read(&backup).unwrap(), original);
        for path in [&file, &backup] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let before_done = fs::read(&file).unwrap();
        let done = store.done(7.0, 0, &cancel).unwrap();
        assert_eq!(done["future"], json(r#"{"v":"\udc00"}"#));
        assert_eq!(done["doneAt"], "1970-01-01T00:00:00.000Z".into());
        assert_eq!(fs::read(&backup).unwrap(), before_done);
        assert_eq!(store.next().unwrap(), added);
        seed(
            directory.path(),
            b"{\"id\":20,\"status\":\"pending\",\"text\":\"external\"}\n",
        );
        assert_eq!(store.next().unwrap()["id"], 20.0.into());
        assert_eq!(
            store.add(&"fresh".into(), 0, &cancel).unwrap()["id"],
            21.0.into()
        );
    }
    #[test]
    fn malformed_records_and_oversized_files_are_preserved() {
        for bytes in [
            b"{broken".as_slice(),
            b"[]",
            b"null",
            b"{}",
            b"{\"id\":\"1\"}",
            b"{\"id\":null}",
            b"{\"id\":true}",
            b"{\"id\":1e999}",
            b"\xff",
            b"{\"id\":1}\n \n{\"id\":2}",
        ] {
            let directory = tempfile::tempdir().unwrap();
            seed(directory.path(), bytes);
            let store = Store::new(directory.path().into());
            assert!(store.list(true).is_err());
            assert!(store.next().is_err());
            assert!(store
                .add(&"must not replace".into(), 0, &Cancel::default())
                .is_err());
            assert!(store.done(1.0, 0, &Cancel::default()).is_err());
            assert_eq!(
                fs::read(directory.path().join("logs").join(FILE)).unwrap(),
                bytes
            );
            assert!(!directory.path().join("logs").join(BACKUP).exists());
        }
        let directory = tempfile::tempdir().unwrap();
        let large = vec![b' '; MAX_BYTES + 1];
        seed(directory.path(), &large);
        let store = Store::new(directory.path().into());
        assert!(store.add(&"x".into(), 0, &Cancel::default()).is_err());
        assert_eq!(
            fs::read(directory.path().join("logs").join(FILE)).unwrap(),
            large
        );
        let original = b"{\"id\":9007199254740992}\n";
        seed(directory.path(), original);
        assert!(store
            .add(&"overflow".into(), 0, &Cancel::default())
            .is_err());
        assert_eq!(
            fs::read(directory.path().join("logs").join(FILE)).unwrap(),
            original
        );
        assert!(!directory.path().join("logs").join(BACKUP).exists());
        assert_eq!(
            store.list(true).unwrap().array()[0]["id"],
            9007199254740992.0.into()
        );
        seed(directory.path(), b"{\"id\":1}\n");
        assert!(store
            .add(&"x".repeat(MAX_BYTES).into(), 0, &Cancel::default())
            .is_err());
        assert_eq!(
            fs::read(directory.path().join("logs").join(FILE)).unwrap(),
            b"{\"id\":1}\n"
        );
        assert!(!directory.path().join("logs").join(BACKUP).exists());
    }
    #[test]
    fn symlink_nonregular_files_and_ancestor_links_cannot_redirect_storage() {
        for name in [FILE, BACKUP] {
            for kind in ["symlink", "directory", "fifo"] {
                let directory = tempfile::tempdir().unwrap();
                let outside = tempfile::tempdir().unwrap();
                let target = outside.path().join("target");
                fs::write(&target, b"untouched").unwrap();
                fs::create_dir(directory.path().join("logs")).unwrap();
                let path = directory.path().join("logs").join(name);
                match kind {
                    "symlink" => symlink(&target, &path).unwrap(),
                    "directory" => fs::create_dir(&path).unwrap(),
                    _ => {
                        use std::os::unix::ffi::OsStrExt;
                        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                    }
                }
                let store = Store::new(directory.path().into());
                assert!(store.add(&"blocked".into(), 0, &Cancel::default()).is_err());
                assert_eq!(fs::read(&target).unwrap(), b"untouched");
                assert!(fs::symlink_metadata(&path).is_ok());
                if name == BACKUP {
                    assert!(!directory.path().join("logs").join(FILE).exists());
                }
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), directory.path().join("linked")).unwrap();
        let store = Store::new(directory.path().join("linked/nested"));
        assert!(store.add(&"blocked".into(), 0, &Cancel::default()).is_err());
        assert!(!outside.path().join("nested").exists());
        symlink(outside.path(), directory.path().join("logs")).unwrap();
        assert!(Store::new(directory.path().into()).list(true).is_err());
    }
    #[test]
    fn pinned_directory_and_changed_source_checks_preserve_other_files() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        seed(directory.path(), b"{\"id\":1}\n");
        fs::write(outside.path().join(FILE), b"outside").unwrap();
        let storage = Storage::open(directory.path(), false).unwrap().unwrap();
        let (mut rows, before) = storage.read().unwrap();
        fs::rename(
            directory.path().join("logs"),
            directory.path().join("moved"),
        )
        .unwrap();
        symlink(outside.path(), directory.path().join("logs")).unwrap();
        rows[0]["status"] = "done".into();
        storage.save(&rows, before, &Cancel::default()).unwrap();
        assert_eq!(fs::read(outside.path().join(FILE)).unwrap(), b"outside");
        assert!(!outside.path().join(BACKUP).exists());
        let (_, old) = storage.read().unwrap();
        fs::write(directory.path().join("moved").join(FILE), b"{\"id\":2}\n").unwrap();
        assert!(storage.save(&rows, old, &Cancel::default()).is_err());
        assert_eq!(
            fs::read(directory.path().join("moved").join(FILE)).unwrap(),
            b"{\"id\":2}\n"
        );
    }
    #[test]
    fn cancellation_before_lock_after_lock_and_before_commit_never_changes_todos() {
        use std::{
            sync::mpsc,
            thread,
            time::{Duration, Instant},
        };
        for adding in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            seed(directory.path(), b"{\"id\":1,\"status\":\"pending\"}\n");
            let store = Arc::new(Store::new(directory.path().into()));
            let before = fs::read(directory.path().join("logs").join(FILE)).unwrap();
            let cancelled = Cancel::default();
            cancelled.cancel();
            let locked = store.writer.lock().unwrap();
            assert_eq!(
                store.add(&"x".into(), 0, &cancelled).unwrap_err(),
                CANCELLED
            );
            let worker_store = store.clone();
            let cancel = Cancel::default();
            let worker_cancel = cancel.clone();
            let (send, receive) = mpsc::channel();
            let worker = thread::spawn(move || {
                send.send(unsafe { libc::syscall(libc::SYS_gettid) })
                    .unwrap();
                if adding {
                    worker_store.add(&"blocked".into(), 0, &worker_cancel)
                } else {
                    worker_store.done(1.0, 0, &worker_cancel)
                }
            });
            let tid = receive.recv_timeout(Duration::from_secs(2)).unwrap();
            let until = Instant::now() + Duration::from_secs(2);
            let mut waiting = false;
            while Instant::now() < until {
                if fs::read_to_string(format!("/proc/self/task/{tid}/wchan"))
                    .unwrap_or_default()
                    .contains("futex")
                {
                    waiting = true;
                    break;
                }
                thread::sleep(Duration::from_millis(1));
            }
            cancel.cancel();
            drop(locked);
            assert_eq!(worker.join().unwrap().unwrap_err(), CANCELLED);
            assert!(waiting, "Writer did not reach the contended lock");
            let storage = Storage::open(directory.path(), false).unwrap().unwrap();
            let temporary = storage.temporary(b"must never commit").unwrap();
            assert_eq!(
                storage.persist(temporary, FILE, &cancel).unwrap_err(),
                CANCELLED
            );
            assert_eq!(
                fs::read(directory.path().join("logs").join(FILE)).unwrap(),
                before
            );
            assert_eq!(
                fs::read_dir(directory.path().join("logs")).unwrap().count(),
                1
            );
        }
    }
    #[test]
    fn concurrent_adds_serialize_and_missing_done_does_not_write() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::new(directory.path().into()));
        assert_eq!(store.done(10.0, 0, &Cancel::default()).unwrap(), V::Null);
        assert!(!directory.path().join("logs").exists());
        let barrier = Arc::new(std::sync::Barrier::new(9));
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let store = store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store
                        .add(&(index as f64).into(), index, &Cancel::default())
                        .unwrap()
                })
            })
            .collect();
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        let rows = store.list(true).unwrap();
        assert_eq!(
            rows.array()
                .iter()
                .map(|row| row["id"].number())
                .collect::<Vec<_>>(),
            (1..=8).map(f64::from).collect::<Vec<_>>()
        );
        let before = fs::read(directory.path().join("logs").join(FILE)).unwrap();
        let backup = fs::read(directory.path().join("logs").join(BACKUP)).unwrap();
        assert_eq!(
            store.done(f64::NAN, 0, &Cancel::default()).unwrap(),
            V::Null
        );
        assert_eq!(
            fs::read(directory.path().join("logs").join(FILE)).unwrap(),
            before
        );
        assert_eq!(
            fs::read(directory.path().join("logs").join(BACKUP)).unwrap(),
            backup
        );
    }
}
