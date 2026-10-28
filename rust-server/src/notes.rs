use axum::{
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{
    json,
    value::{to_raw_value, RawValue},
};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Write},
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::json_values::{blank, raw, slice, truthy, Object};
#[cfg(test)]
use crate::json_values::{string, units};

pub struct Store {
    directory: PathBuf,
    writer: Mutex<()>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn tags(value: Option<&RawValue>) -> Option<Box<RawValue>> {
    let values: Vec<Box<RawValue>> = serde_json::from_str(value?.get()).ok()?;
    to_raw_value(
        &values
            .into_iter()
            .filter(|v| v.get().starts_with('"'))
            .take(20)
            .collect::<Vec<_>>(),
    )
    .ok()
}

impl Store {
    pub fn new(directory: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&directory)?;
        if fs::symlink_metadata(&directory)?.file_type().is_symlink() {
            return Err(io::Error::other("Notes directory must not be a symlink"));
        }
        Ok(Self {
            directory,
            writer: Mutex::new(()),
        })
    }

    fn exists(&self, id: &str) -> io::Result<bool> {
        if !valid_id(id) {
            return Ok(false);
        }
        match fs::symlink_metadata(self.directory.join(format!("{id}.json"))) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
            Ok(meta) if !meta.file_type().is_file() => Err(io::Error::other("Invalid note file")),
            Ok(_) => Ok(true),
        }
    }

    fn read(&self, id: &str) -> io::Result<Option<Object>> {
        if !self.exists(id)? {
            return Ok(None);
        }
        Ok(Some(serde_json::from_slice(&fs::read(
            self.directory.join(format!("{id}.json")),
        )?)?))
    }

    fn save(&self, id: &str, value: &Object) -> io::Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(self.directory.join(format!("{id}.json")))
            .map_err(|error| error.error)?;
        self.sync_directory()
    }

    fn sync_directory(&self) -> io::Result<()> {
        #[cfg(unix)]
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }

    fn list(&self) -> io::Result<Object> {
        let mut notes = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json") else {
                continue;
            };
            let Ok(Some(note)) = self.read(id) else {
                continue;
            };
            let mut summary = Object::new();
            for key in ["id", "title", "createdAt", "updatedAt"] {
                if let Some(value) = note.get(key) {
                    summary.insert(key.to_string(), value.clone());
                }
            }
            for (key, default) in [("project", json!("")), ("tags", json!([]))] {
                summary.insert(
                    key.to_string(),
                    note.get(key)
                        .filter(|v| truthy(v))
                        .cloned()
                        .unwrap_or_else(|| raw(default)),
                );
            }
            summary.insert(
                "preview".into(),
                note.get("content")
                    .and_then(|v| slice(v, 120))
                    .unwrap_or_else(|| raw(json!(""))),
            );
            notes.push(summary);
        }
        notes.sort_by_key(|note| {
            std::cmp::Reverse(
                note.get("updatedAt")
                    .and_then(|v| v.get().parse::<u64>().ok())
                    .unwrap_or(0),
            )
        });
        Ok(BTreeMap::from([("notes".into(), to_raw_value(&notes)?)]))
    }

    pub fn handle(&self, method: Method, path: &str, data: Object) -> Response {
        match self.request(method, path, data, None) {
            Ok(response) => response,
            Err(_) => super::error(500, "Note storage operation failed"),
        }
    }

    pub fn handle_agent(
        &self,
        method: Method,
        path: &str,
        data: Object,
        cancel: &crate::ai_transport::Cancel,
    ) -> Response {
        match self.request(method, path, data, Some(cancel)) {
            Ok(response) => response,
            Err(_) => super::error(500, "Note storage operation failed or cancelled"),
        }
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        data: Object,
        cancel: Option<&crate::ai_transport::Cancel>,
    ) -> io::Result<Response> {
        // The process owns the directory lock. Serialize partial field updates.
        let _guard = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("Note storage lock failed"))?;
        let check = || {
            if cancel.is_some_and(|cancel| cancel.is_cancelled()) {
                Err(io::Error::other("Agent request cancelled"))
            } else {
                Ok(())
            }
        };
        check()?;
        let id = path.strip_prefix("/api/notes/");
        if id.is_none() {
            return match method {
                Method::GET => Ok(Json(self.list()?).into_response()),
                Method::POST => {
                    let title = data
                        .get("title")
                        .and_then(|v| slice(v, 200))
                        .unwrap_or_else(|| raw(json!("")));
                    if blank(&title) {
                        return Ok(super::error(400, "title required"));
                    }
                    let id = loop {
                        let id = format!("{:016x}", rand::random::<u64>());
                        if !self.directory.join(format!("{id}.json")).exists() {
                            break id;
                        }
                    };
                    let time = now();
                    let note = BTreeMap::from([
                        ("id".into(), raw(json!(id))),
                        ("title".into(), title),
                        (
                            "content".into(),
                            data.get("content")
                                .and_then(|v| slice(v, 500_000))
                                .unwrap_or_else(|| raw(json!(""))),
                        ),
                        (
                            "project".into(),
                            data.get("project")
                                .filter(|v| truthy(v))
                                .cloned()
                                .unwrap_or_else(|| raw(json!(""))),
                        ),
                        (
                            "tags".into(),
                            tags(data.get("tags").map(|v| &**v)).unwrap_or_else(|| raw(json!([]))),
                        ),
                        ("createdAt".into(), raw(json!(time))),
                        ("updatedAt".into(), raw(json!(time))),
                    ]);
                    check()?;
                    self.save(&id, &note)?;
                    Ok((StatusCode::CREATED, Json(note)).into_response())
                }
                _ => Ok((StatusCode::NOT_FOUND, "Not Found").into_response()),
            };
        }
        let id = id.unwrap();
        if !matches!(method, Method::GET | Method::PUT | Method::DELETE) {
            return Ok((StatusCode::NOT_FOUND, "Not Found").into_response());
        }
        if method == Method::DELETE {
            if !self.exists(id)? {
                return Ok(super::error(404, "Not found"));
            }
            check()?;
            fs::remove_file(self.directory.join(format!("{id}.json")))?;
            self.sync_directory()?;
            return Ok(Json(json!({"deleted":true})).into_response());
        }
        let mut updates = Object::new();
        if method == Method::PUT {
            for key in ["title", "content", "project"] {
                if let Some(value) = data
                    .get(key)
                    .and_then(|v| slice(v, if key == "content" { 500_000 } else { 200 }))
                {
                    updates.insert(key.to_string(), value);
                }
            }
            if let Some(tags) = tags(data.get("tags").map(|v| &**v)) {
                updates.insert("tags".into(), tags);
            }
            if updates.is_empty() {
                return Ok(super::error(400, "no updatable fields"));
            }
        }
        let Some(mut note) = self.read(id)? else {
            return Ok(super::error(404, "Not found"));
        };
        if method == Method::PUT {
            note.extend(updates);
            note.insert("updatedAt".into(), raw(json!(now())));
            check()?;
            self.save(id, &note)?;
        }
        Ok(Json(note).into_response())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_roundtrip_including_unpaired_surrogates_and_escapes() {
        // Cover every UTF-16 code unit, including both surrogate ranges.
        for unit in 0..=u16::MAX {
            assert_eq!(units(&string(&[unit])).unwrap(), [unit]);
        }
        let value = raw(json!("한😀글\n\t\\\""));
        assert_eq!(slice(&value, 3).unwrap().get(), "\"한😀\"");
        assert_eq!(slice(&value, 2).unwrap().get(), "\"한\\ud83d\"");
        let escaped = RawValue::from_string(r#""\b\f\n\r\t\/\\\"\u0061\ud83d""#.into()).unwrap();
        assert_eq!(units(&string(&units(&escaped).unwrap())), units(&escaped));
    }

    #[test]
    fn corrupt_updates_are_preserved_and_legacy_fields_survive_update() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf()).unwrap();
        fs::write(dir.path().join("ab.json"), "{broken").unwrap();
        let update = || serde_json::from_str(r#"{"title":"after"}"#).unwrap();
        assert!(store
            .request(Method::PUT, "/api/notes/ab", update(), None)
            .is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("ab.json")).unwrap(),
            "{broken"
        );
        let note =
            serde_json::from_str(r#"{"id":"ac","content":"a\ud83d","future":{"keep":"\udc00"}}"#)
                .unwrap();
        store.save("ac", &note).unwrap();
        assert_eq!(
            store
                .request(Method::PUT, "/api/notes/ac", update(), None)
                .unwrap()
                .status(),
            200
        );
        let note = store.read("ac").unwrap().unwrap();
        assert_eq!(note["content"].get(), r#""a\ud83d""#);
        assert_eq!(note["future"].get(), r#"{"keep":"\udc00"}"#);
        assert_eq!(
            store
                .request(Method::DELETE, "/api/notes/ab", Object::new(), None)
                .unwrap()
                .status(),
            200
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cancelled_agent_waiting_for_writer_cannot_create_update_or_delete_notes() {
        use crate::ai_transport::Cancel;
        use std::{
            sync::{mpsc, Arc},
            thread,
            time::{Duration, Instant},
        };

        fn snapshot(directory: &std::path::Path) -> BTreeMap<String, Vec<u8>> {
            fs::read_dir(directory)
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    (
                        entry.file_name().into_string().unwrap(),
                        fs::read(entry.path()).unwrap(),
                    )
                })
                .collect()
        }
        for (method, path) in [
            (Method::POST, "/api/notes"),
            (Method::PUT, "/api/notes/aa"),
            (Method::DELETE, "/api/notes/aa"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store = Arc::new(Store::new(directory.path().into()).unwrap());
            let original: Object = serde_json::from_str(r#"{"id":"aa","title":"original","content":"keep\ud800","createdAt":1,"updatedAt":2,"future":{"keep":true}}"#).unwrap();
            store.save("aa", &original).unwrap();
            let before = snapshot(directory.path());
            let writer = store.writer.lock().unwrap();
            let cancel = Cancel::default();
            let worker_store = store.clone();
            let worker_cancel = cancel.clone();
            let (ready_tx, ready_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            let worker = thread::spawn(move || {
                // Linux's wait channel proves the request really reached the
                // contended writer lock, instead of relying on a scheduling delay.
                let tid = unsafe { libc::syscall(libc::SYS_gettid) };
                ready_tx.send(tid).unwrap();
                let changes =
                    serde_json::from_str(r#"{"title":"changed","content":"must not write"}"#)
                        .unwrap();
                let status = worker_store
                    .handle_agent(method, path, changes, &worker_cancel)
                    .status();
                done_tx.send(status).unwrap();
            });
            let tid = ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            let wait_channel = format!("/proc/self/task/{tid}/wchan");
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut waiting = false;
            while Instant::now() < deadline {
                if fs::read_to_string(&wait_channel)
                    .unwrap_or_default()
                    .contains("futex")
                {
                    waiting = true;
                    break;
                }
                thread::sleep(Duration::from_millis(1));
            }
            let completed_while_locked = done_rx.try_recv().ok();
            cancel.cancel();
            drop(writer);
            worker.join().unwrap();
            assert!(waiting, "agent request did not reach the writer lock");
            assert!(
                completed_while_locked.is_none(),
                "agent request bypassed the writer lock"
            );
            assert_eq!(
                done_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
                StatusCode::INTERNAL_SERVER_ERROR
            );
            assert_eq!(
                snapshot(directory.path()),
                before,
                "cancelled operation changed note files"
            );
            assert_eq!(
                store.read("aa").unwrap().unwrap()["content"].get(),
                r#""keep\ud800""#
            );
        }
    }
}
