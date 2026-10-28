use crate::{
    ai_transport::Cancel,
    board_value::{object, V},
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::value::RawValue;
use std::{
    collections::{HashMap, HashSet},
    fmt, fs,
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

pub const ROUTES: &[(&str, &str)] = &[
    ("POST", "/api/agent/chat"),
    ("POST", "/api/agent/stop"),
    ("GET", "/api/agent/conversations"),
    ("POST", "/api/agent/conversations"),
    ("GET", "/api/agent/conversations/:id"),
    ("DELETE", "/api/agent/conversations/:id"),
    ("GET", "/api/agent/model"),
    ("POST", "/api/agent/model"),
    ("GET", "/api/agent/agents"),
    ("GET", "/api/agent/teams"),
    ("GET", "/api/agent/company"),
    ("GET", "/api/agent/username"),
    ("POST", "/api/agent/username"),
];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, target)| method.as_str() == *verb && *target == path)
        || (matches!(*method, Method::GET | Method::DELETE) && conversation_id(path).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_retains_history_order_unknown_fields_and_utf16_after_truncation() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let content = V::String(vec![0xd83d, 0xde00, 0xd800]);
        let record = object([
            ("createdAt", (crate::account_usage::now() as f64).into()),
            ("extra", "kept".into()),
            (
                "messages",
                V::Array(
                    (0..105)
                        .map(|_| {
                            object([("role", "assistant".into()), ("content", content.clone())])
                        })
                        .collect(),
                ),
            ),
        ]);
        store
            .save(&vec![
                ("z".into(), record.clone()),
                ("a".into(), record.clone()),
            ])
            .unwrap();
        let restored = Store::new(directory.path().into()).load().unwrap();
        assert_eq!(
            restored
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            ["z", "a"]
        );
        assert_eq!(restored[0].1["messages"].array().len(), 100);
        assert_eq!(restored[0].1["messages"].array()[0]["content"], content);
        assert_eq!(restored[0].1["extra"], V::from("kept"));
        fs::write(directory.path().join("agent-history.json"), "{broken").unwrap();
        assert!(store.save(&vec![]).is_err());
        assert_eq!(
            fs::read_to_string(directory.path().join("agent-history.json")).unwrap(),
            "{broken"
        );
    }

    #[test]
    fn cancelled_history_lock_waiters_do_not_append_evict_or_cancel_existing_work() {
        for create in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let store = Arc::new(Store::new(directory.path().into()));
            let now = crate::account_usage::now() as f64;
            let history: History = (0..50)
                .map(|index| {
                    (
                        format!("conv-{index}"),
                        object([
                            ("createdAt", (now - ((50 - index) * 1000) as f64).into()),
                            ("extra", "preserved".into()),
                            (
                                "messages",
                                V::Array(vec![object([
                                    ("role", "assistant".into()),
                                    ("content", V::String(vec![0xd800, 0xd83d, 0xde00])),
                                ])]),
                            ),
                        ]),
                    )
                })
                .collect();
            store.save(&history).unwrap();
            let path = directory.path().join("agent-history.json");
            let before = fs::read(&path).unwrap();
            let active = Arc::new(Cancel::default());
            let mut state = store.state.lock().unwrap();
            state.history = Some(history.clone());
            state.running.insert("conv-0".into(), active.clone());
            let parent = Cancel::default();
            let admission = parent.child();
            let (checked, waiting) = std::sync::mpsc::channel();
            *store.admission_checked.lock().unwrap() = Some(checked);
            let worker_store = store.clone();
            let worker = std::thread::spawn(move || {
                if create {
                    assert_eq!(
                        worker_store.create_background(&admission).status().as_u16(),
                        409
                    );
                } else {
                    let result = worker_store.begin_cancellable(
                        "conv-1".into(),
                        &"new turn".into(),
                        None,
                        true,
                        Some(&admission),
                    );
                    assert_eq!(result.err().as_deref(), Some("Agent request cancelled"));
                }
            });
            // The first admission check has passed, but the held history lock
            // prevents mutation until after its parent's cancellation arrives.
            waiting
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            parent.cancel();
            drop(state);
            worker.join().unwrap();
            assert_eq!(fs::read(&path).unwrap(), before);
            let state = store.state.lock().unwrap();
            assert_eq!(state.history.as_ref(), Some(&history));
            assert_eq!(state.running.len(), 1);
            assert!(Arc::ptr_eq(state.running.get("conv-0").unwrap(), &active));
            assert!(!active.is_cancelled());
            assert!(!state.running.contains_key("conv-1"));
        }
    }

    #[test]
    fn already_cancelled_admission_preserves_unloaded_and_corrupt_history() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-history.json");
        fs::write(&path, "{broken").unwrap();
        let store = Arc::new(Store::new(directory.path().into()));
        let cancel = Cancel::default();
        cancel.cancel();
        assert_eq!(store.create_background(&cancel).status().as_u16(), 409);
        assert_eq!(
            store
                .begin_cancellable("new".into(), &"message".into(), None, true, Some(&cancel))
                .err()
                .as_deref(),
            Some("Agent request cancelled")
        );
        assert!(store.state.lock().unwrap().history.is_none());
        assert!(store.state.lock().unwrap().running.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
    }
}
fn conversation_id(path: &str) -> Option<&str> {
    path.strip_prefix("/api/agent/conversations/")
        .filter(|s| !s.is_empty() && !s.contains('/'))
}
fn catalog() -> &'static V {
    static CATALOG: OnceLock<V> = OnceLock::new();
    CATALOG.get_or_init(|| {
        V::parse(&RawValue::from_string(include_str!("agent_profiles.json").into()).unwrap())
            .unwrap()
    })
}
fn profiles() -> V {
    let mut seen = HashSet::new();
    V::Array(
        catalog()["profiles"]
            .array()
            .iter()
            .filter_map(|entry| {
                let profile = &entry.array()[1];
                if !seen.insert(profile["id"].text()) {
                    return None;
                }
                let mut item = V::object();
                for field in [
                    "id", "name", "rank", "team", "color", "emoji", "provider", "model", "maxIter",
                ] {
                    if profile.has(field) {
                        item[field] = profile[field].clone();
                    }
                }
                // Like Node, this field describes the CLI adapter, not login status.
                // The chat route is registered separately when orchestration is ready.
                item["claudeAvailable"] = true.into();
                Some(item)
            })
            .collect(),
    )
}

type History = Vec<(String, V)>;
struct Ordered(Vec<(String, Box<RawValue>)>);
impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Ordered;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a conversation object")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Ordered, M::Error> {
                let mut fields: Vec<(String, Box<RawValue>)> = vec![];
                while let Some((key, value)) = map.next_entry()? {
                    if let Some(old) = fields.iter_mut().find(|(id, _)| *id == key) {
                        old.1 = value;
                    } else {
                        fields.push((key, value));
                    }
                }
                // JSON.parse + Object.entries enumerate array-index keys first.
                let index = |key: &str| {
                    key.parse::<u32>()
                        .ok()
                        .filter(|n| *n < u32::MAX && n.to_string() == key)
                };
                fields.sort_by_key(|(key, _)| index(key).map_or((1, 0), |n| (0, n)));
                Ok(Ordered(fields))
            }
        }
        deserializer.deserialize_map(Fields)
    }
}
struct State {
    history: Option<History>,
    model: V,
    name: V,
    running: HashMap<String, Arc<crate::ai_transport::Cancel>>,
}
pub struct Store {
    directory: PathBuf,
    state: Mutex<State>,
    #[cfg(test)]
    admission_checked: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

/// One owner covers routing, execution, cancellation and the final history write.
/// Dropping the owner cancels outstanding work and releases only its own slot.
pub struct Run {
    store: Arc<Store>,
    pub id: String,
    pub cancel: Arc<crate::ai_transport::Cancel>,
    pub messages: Vec<V>,
    pub message: V,
    pub model: V,
    pub user_name: V,
    pub length_warning: bool,
}
impl Run {
    pub fn commit(&self) -> Result<bool, String> {
        let mut state = self.store.state.lock().unwrap();
        if !state
            .running
            .get(&self.id)
            .is_some_and(|c| Arc::ptr_eq(c, &self.cancel))
        {
            return Ok(false);
        }
        let mut next = state.history.clone().unwrap_or_default();
        let Some((_, conv)) = next.iter_mut().find(|(id, _)| *id == self.id) else {
            // Deletion or eviction must not resurrect a conversation.
            return Ok(false);
        };
        conv["messages"] = V::Array(self.messages.clone());
        self.store
            .save(&next)
            .map_err(|_| HISTORY_ERROR.to_string())?;
        state.history = Some(next);
        Ok(true)
    }
}
impl Drop for Run {
    fn drop(&mut self) {
        self.cancel.cancel();
        let mut state = self.store.state.lock().unwrap();
        if state
            .running
            .get(&self.id)
            .is_some_and(|c| Arc::ptr_eq(c, &self.cancel))
        {
            state.running.remove(&self.id);
        }
    }
}
const HISTORY_ERROR: &str = "Agent history unavailable; saved data preserved";
fn check_admission(cancel: Option<&Cancel>) -> io::Result<()> {
    if cancel.is_some_and(Cancel::is_cancelled) {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Agent request cancelled",
        ))
    } else {
        Ok(())
    }
}
impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            state: Mutex::new(State {
                history: None,
                model: "auto".into(),
                name: "".into(),
                running: HashMap::new(),
            }),
            #[cfg(test)]
            admission_checked: Mutex::new(None),
        }
    }
    /// Persist the accepted user turn before any model call or tool execution.
    pub fn begin(
        self: &Arc<Self>,
        id: String,
        message: &V,
        project: Option<&V>,
        configured: bool,
    ) -> Result<Run, String> {
        self.begin_cancellable(id, message, project, configured, None)
    }
    pub fn begin_cancellable(
        self: &Arc<Self>,
        id: String,
        message: &V,
        project: Option<&V>,
        configured: bool,
        admission: Option<&Cancel>,
    ) -> Result<Run, String> {
        check_admission(admission).map_err(|error| error.to_string())?;
        if !configured {
            return Err("Gemini API key not configured".into());
        }
        #[cfg(test)]
        self.notify_admission_checked();
        let mut state = self.state.lock().unwrap();
        check_admission(admission).map_err(|error| error.to_string())?;
        if state.running.contains_key(&id) {
            return Err(
                "이미 실행 중인 작업이 있어영. 완료되거나 중단된 후 다시 시도해주세영.".into(),
            );
        }
        if !message.is_string() || !message.trim().truthy() {
            return Err("메시지가 비어있어영. 내용을 입력해주세영.".into());
        }
        let mut message = message.trim();
        if let Some(project) = project {
            let stack = if project["stack"].truthy() {
                project["stack"].text()
            } else {
                "미정".into()
            };
            let prefix = format!(
                "[대상 프로젝트: {} | 경로: {} | 스택: {}]\n\n",
                project["name"].text(),
                project["path"].text(),
                stack
            );
            message = V::String(
                prefix
                    .encode_utf16()
                    .chain(message.units().iter().copied())
                    .collect(),
            );
        }
        let length_warning = message.units().len() > 5000;
        message = message.cut(5000);
        if state.history.is_none() {
            state.history = Some(self.load().map_err(|_| HISTORY_ERROR.to_string())?);
        }
        let mut next = state.history.clone().unwrap();
        let now = crate::account_usage::now() as f64;
        let index = if let Some(index) = next.iter().position(|(key, _)| *key == id) {
            index
        } else {
            next.push((
                id.clone(),
                object([("messages", V::Array(vec![])), ("createdAt", now.into())]),
            ));
            next.len() - 1
        };
        let messages = next[index].1["messages"].array_mut();
        messages.push(object([
            ("role", "user".into()),
            ("content", message.clone()),
            ("ts", now.into()),
        ]));
        let messages = messages.clone();
        check_admission(admission).map_err(|error| error.to_string())?;
        self.save_cancellable(&next, admission).map_err(|error| {
            if error.kind() == io::ErrorKind::Interrupted {
                error.to_string()
            } else {
                HISTORY_ERROR.to_string()
            }
        })?;
        state.history = Some(next);
        let cancel = Arc::new(crate::ai_transport::Cancel::default());
        state.running.insert(id.clone(), cancel.clone());
        Ok(Run {
            store: self.clone(),
            id,
            cancel,
            messages,
            message,
            model: state.model.clone(),
            user_name: state.name.clone(),
            length_warning,
        })
    }
    pub fn stop(&self, id: &str) -> V {
        let state = self.state.lock().unwrap();
        if let Some(cancel) = state.running.get(id) {
            cancel.cancel();
            object([("stopped", true.into())])
        } else {
            object([
                ("stopped", false.into()),
                ("reason", "no running loop".into()),
            ])
        }
    }
    pub fn is_running(&self, id: &str) -> bool {
        self.state.lock().unwrap().running.contains_key(id)
    }
    pub fn cancel_all(&self) {
        for cancel in self.state.lock().unwrap().running.values() {
            cancel.cancel();
        }
    }
    fn load(&self) -> io::Result<History> {
        let path = self.directory.join("agent-history.json");
        if !crate::account_hub::safe_path(&self.directory, &path) {
            return Err(io::Error::other("Invalid agent history path"));
        }
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(error) => return Err(error),
        };
        let Ordered(fields) = serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::other("Invalid agent history"))?;
        fields
            .into_iter()
            .map(|(id, value)| {
                let value =
                    V::parse(&value).map_err(|_| io::Error::other("Invalid agent history"))?;
                if !value["messages"].is_array()
                    || value["messages"]
                        .array()
                        .iter()
                        .any(|m| !m["content"].is_string())
                {
                    return Err(io::Error::other("Invalid agent messages"));
                }
                Ok((id, value))
            })
            .collect()
    }
    fn save(&self, history: &History) -> io::Result<()> {
        self.save_cancellable(history, None)
    }
    fn save_cancellable(&self, history: &History, admission: Option<&Cancel>) -> io::Result<()> {
        check_admission(admission)?;
        // Do not replace a corrupt or symlinked file even if it changed after load.
        self.load()?;
        let mut encoded = String::from("{");
        for (index, (id, value)) in history.iter().enumerate() {
            if index != 0 {
                encoded.push(',');
            }
            encoded.push_str(&serde_json::to_string(id).unwrap());
            encoded.push(':');
            let mut value = value.clone();
            let messages = value["messages"].array();
            value["messages"] = V::Array(messages[messages.len().saturating_sub(100)..].to_vec());
            encoded.push_str(value.raw().get());
        }
        encoded.push('}');
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
        file.write_all(encoded.as_bytes())?;
        file.as_file().sync_all()?;
        check_admission(admission)?;
        file.persist(self.directory.join("agent-history.json"))
            .map_err(|e| e.error)?;
        Ok(())
    }
    fn request(
        &self,
        method: &Method,
        path: &str,
        input: &V,
        admission: Option<&Cancel>,
    ) -> io::Result<Response> {
        check_admission(admission)?;
        #[cfg(test)]
        self.notify_admission_checked();
        let mut state = self.state.lock().unwrap();
        check_admission(admission)?;
        let value = match path {
            "/api/agent/model" => {
                if *method == Method::POST {
                    if !input["model"].truthy() {
                        return Ok(crate::error(400, "model required"));
                    }
                    if [V::from("auto"), "flash".into(), "pro".into()].contains(&input["model"])
                        || catalog()["profiles"]
                            .array()
                            .iter()
                            .any(|p| p.array()[0] == input["model"])
                    {
                        state.model = input["model"].clone();
                    }
                }
                object([("model", state.model.clone())])
            }
            "/api/agent/username" => {
                if *method == Method::POST && input["name"].truthy() {
                    if !input["name"].is_string() {
                        return Ok(crate::error(400, "name must be a string"));
                    }
                    state.name = input["name"].trim();
                }
                object([("name", state.name.clone())])
            }
            "/api/agent/agents" => profiles(),
            "/api/agent/teams" => catalog()["teams"].clone(),
            "/api/agent/company" => object([
                ("teams", catalog()["teams"].clone()),
                ("agents", profiles()),
            ]),
            _ => {
                if state.history.is_none() {
                    state.history = Some(self.load()?);
                }
                let history = state.history.as_ref().unwrap();
                if path == "/api/agent/conversations" && *method == Method::GET {
                    let mut list = history
                        .iter()
                        .map(|(id, c)| {
                            let mut item = object([
                                ("id", id.clone().into()),
                                ("messageCount", (c["messages"].array().len() as f64).into()),
                                (
                                    "lastMessage",
                                    c["messages"]
                                        .array()
                                        .last()
                                        .map(|m| m["content"].cut(80))
                                        .unwrap_or("".into()),
                                ),
                            ]);
                            if c.has("createdAt") {
                                item["createdAt"] = c["createdAt"].clone();
                            }
                            item
                        })
                        .collect::<Vec<_>>();
                    list.sort_by(|a, b| {
                        b["createdAt"]
                            .number()
                            .partial_cmp(&a["createdAt"].number())
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
                    V::Array(list)
                } else if path == "/api/agent/conversations" && *method == Method::POST {
                    let now = crate::account_usage::now();
                    let mut next = history.clone();
                    next.retain(|(_, c)| {
                        !((now as f64) - c["createdAt"].number() > 7.0 * 86_400_000.0)
                    });
                    while next.len() >= 50 {
                        let oldest = next
                            .iter()
                            .enumerate()
                            .min_by(|(_, a), (_, b)| {
                                a.1["createdAt"]
                                    .number()
                                    .partial_cmp(&b.1["createdAt"].number())
                                    .unwrap_or(std::cmp::Ordering::Equal)
                            })
                            .unwrap()
                            .0;
                        next.remove(oldest);
                    }
                    let id = loop {
                        let id = format!("conv-{now}-{:04x}", rand::random::<u16>());
                        if !next.iter().any(|(old, _)| *old == id)
                            && !state.running.contains_key(&id)
                        {
                            break id;
                        }
                    };
                    next.push((
                        id.clone(),
                        object([
                            ("messages", V::Array(vec![])),
                            ("createdAt", (now as f64).into()),
                        ]),
                    ));
                    check_admission(admission)?;
                    self.save_cancellable(&next, admission)?;
                    for (id, cancel) in &state.running {
                        if !next.iter().any(|(key, _)| key == id) {
                            cancel.cancel();
                        }
                    }
                    state.history = Some(next);
                    return Ok((
                        axum::http::StatusCode::CREATED,
                        Json(object([("id", id.into())]).raw()),
                    )
                        .into_response());
                } else if let Some(id) = conversation_id(path) {
                    if *method == Method::DELETE {
                        let next = history
                            .iter()
                            .filter(|(key, _)| key != id)
                            .cloned()
                            .collect();
                        self.save(&next)?;
                        if let Some(cancel) = state.running.get(id) {
                            cancel.cancel();
                        }
                        state.history = Some(next);
                        object([("deleted", true.into())])
                    } else {
                        let Some((_, conv)) = history.iter().find(|(key, _)| key == id) else {
                            return Ok(crate::error(404, "Not found"));
                        };
                        let mut value =
                            object([("id", id.into()), ("messages", conv["messages"].clone())]);
                        if conv.has("createdAt") {
                            value["createdAt"] = conv["createdAt"].clone();
                        }
                        value
                    }
                } else {
                    return Ok(crate::error(404, "Not found"));
                }
            }
        };
        Ok(Json(value.raw()).into_response())
    }
    pub fn handle(&self, method: &Method, path: &str, input: &V) -> Response {
        self.request(method, path, input, None)
            .unwrap_or_else(|_| crate::error(500, HISTORY_ERROR))
    }
    pub fn history(&self) -> Result<Vec<(String, V)>, String> {
        let mut state = self.state.lock().unwrap();
        if state.history.is_none() {
            state.history = Some(self.load().map_err(|_| HISTORY_ERROR.to_string())?);
        }
        Ok(state.history.clone().unwrap())
    }
    pub fn create_background(&self, cancel: &Cancel) -> Response {
        self.request(
            &Method::POST,
            "/api/agent/conversations",
            &V::object(),
            Some(cancel),
        )
        .unwrap_or_else(|error| {
            if error.kind() == io::ErrorKind::Interrupted {
                crate::error(409, "Agent request cancelled")
            } else {
                crate::error(500, HISTORY_ERROR)
            }
        })
    }
    #[cfg(test)]
    fn notify_admission_checked(&self) {
        if let Some(sender) = self.admission_checked.lock().unwrap().as_ref() {
            let _ = sender.send(());
        }
    }
}
