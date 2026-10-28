use axum::{
    body::Body,
    response::{IntoResponse, Response},
};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    convert::Infallible,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{broadcast, oneshot};

pub struct Store {
    sender: broadcast::Sender<String>,
    clients: Mutex<VecDeque<(u64, oneshot::Sender<()>)>>,
    sequence: std::sync::atomic::AtomicU64,
    closing: std::sync::atomic::AtomicBool,
}
struct Client {
    id: u64,
    store: Weak<Store>,
}
impl Drop for Client {
    fn drop(&mut self) {
        if let Some(store) = self.store.upgrade() {
            store
                .clients
                .lock()
                .unwrap()
                .retain(|(id, _)| *id != self.id);
        }
    }
}
impl Store {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sender: broadcast::channel(64).0,
            clients: Mutex::new(VecDeque::new()),
            sequence: std::sync::atomic::AtomicU64::new(0),
            closing: std::sync::atomic::AtomicBool::new(false),
        })
    }
    pub fn publish(&self, name: &str, data: Value) {
        self.publish_raw(name, &data.to_string());
    }
    pub fn publish_raw(&self, name: &str, data: &str) {
        let _ = self.sender.send(format!("event: {name}\ndata: {data}\n\n"));
    }
    pub fn has_clients(&self) -> bool {
        !self.clients.lock().unwrap().is_empty()
    }
    pub fn client_count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }
    pub fn close(&self) {
        self.closing
            .store(true, std::sync::atomic::Ordering::Release);
        self.clients.lock().unwrap().clear();
    }
    #[cfg(test)]
    pub fn connect(self: &Arc<Self>) -> Response {
        self.connect_with_initial(crate::board_value::V::object)
    }
    pub fn connect_with_initial(
        self: &Arc<Self>,
        initial: impl FnOnce() -> crate::board_value::V,
    ) -> Response {
        let receive = self.sender.subscribe();
        // Subscribe before reading caches so a concurrent update is represented
        // either in the snapshot or in the subsequent event stream.
        let initial = initial();
        let (close, closed) = oneshot::channel();
        let id = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        {
            let mut clients = self.clients.lock().unwrap();
            if self.closing.load(std::sync::atomic::Ordering::Acquire) {
                return crate::error(503, "Server is shutting down");
            }
            if clients.len() >= 50 {
                clients.pop_front();
            }
            clients.push_back((id, close));
        }
        let client = Client {
            id,
            store: Arc::downgrade(self),
        };
        let timer = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(15),
            Duration::from_secs(15),
        );
        let initial = format!("event: init\ndata: {}\n\n", initial.raw().get());
        let updates = stream::unfold(
            (receive, closed, client, timer),
            |(mut receive, mut closed, client, mut timer)| async move {
                let frame = tokio::select! {
                    biased;
                    _ = &mut closed => return None,
                    result = receive.recv() => match result {
                        Ok(frame) => frame,
                        Err(broadcast::error::RecvError::Closed) => return None,
                        // EventSource reconnects and receives a fresh snapshot
                        // if this client fell behind any kind of project update.
                        Err(broadcast::error::RecvError::Lagged(_)) => return None,
                    },
                    _ = timer.tick() => ":ping\n\n".into(),
                };
                Some((Ok::<_, Infallible>(frame), (receive, closed, client, timer)))
            },
        );
        let body = Body::from_stream(
            stream::once(async move { Ok::<_, Infallible>(initial) }).chain(updates),
        );
        (
            [
                ("content-type", "text/event-stream"),
                ("cache-control", "no-store"),
                ("connection", "keep-alive"),
            ],
            body,
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn shutdown_ends_existing_streams_and_rejects_new_clients() {
        let store = Store::new();
        let mut stream = store.connect().into_body().into_data_stream();
        assert!(stream
            .next()
            .await
            .unwrap()
            .unwrap()
            .starts_with(b"event: init\n"));
        store.close();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), stream.next())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store.connect().status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(store.clients.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn snapshot_updates_are_not_lost_and_lag_forces_reconnect() {
        let store = Store::new();
        let mut stream = store
            .connect_with_initial(|| {
                store.publish_raw("git:update", "{\"branch\":\"new\"}");
                crate::board_value::V::object()
            })
            .into_body()
            .into_data_stream();
        assert!(stream
            .next()
            .await
            .unwrap()
            .unwrap()
            .starts_with(b"event: init\n"));
        assert!(stream
            .next()
            .await
            .unwrap()
            .unwrap()
            .starts_with(b"event: git:update\n"));
        for _ in 0..100 {
            store.publish_raw("git:update", "{}");
        }
        assert!(stream.next().await.is_none());
        assert!(!store.has_clients());
    }
}

type Stamp = (u64, Option<std::time::SystemTime>, u64);
fn stamps(accounts: &crate::accounts::Store) -> BTreeMap<PathBuf, Option<Stamp>> {
    accounts
        .watch_paths()
        .into_iter()
        .map(|path| {
            let stamp = fs::symlink_metadata(&path).ok().map(|meta| {
                #[cfg(unix)]
                let inode = {
                    use std::os::unix::fs::MetadataExt;
                    meta.ino()
                };
                #[cfg(not(unix))]
                let inode = 0;
                (meta.len(), meta.modified().ok(), inode)
            });
            (path, stamp)
        })
        .collect()
}
pub async fn watch_accounts(accounts: Arc<crate::accounts::Store>, events: Arc<Store>) {
    // ponytail: metadata polling avoids a second filesystem watcher dependency.
    // Only account metadata/credential paths are stat'ed, never transcript trees.
    let mut previous: Option<BTreeMap<PathBuf, Option<Stamp>>> = None;
    loop {
        let store = accounts.clone();
        let Ok(current) = tokio::task::spawn_blocking(move || stamps(&store)).await else {
            break;
        };
        if let Some(old) = &previous {
            if old != &current {
                for path in current.keys().chain(old.keys()) {
                    if current.get(path) != old.get(path) {
                        if let Some(home) = path.parent() {
                            accounts.usage.invalidate(home);
                        }
                    }
                }
                events.publish(
                    "ai-accounts:changed",
                    json!({"at":crate::account_usage::now()}),
                );
            }
        }
        previous = Some(current);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
