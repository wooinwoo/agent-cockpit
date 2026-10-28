use crate::{
    ai_transport::Cancel,
    board_value::{object, V},
    costs, desktop_notify, events, git, github, projects, sessions,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

struct Entry {
    project: V,
    data: V,
    initialized: bool,
    errors: u8,
    next: Instant,
}
#[derive(Default)]
pub struct Store {
    entries: Mutex<HashMap<(String, &'static str), Entry>>,
    jobs: Mutex<HashMap<(String, &'static str), tokio::task::JoinHandle<()>>>,
    speed: Mutex<Option<f64>>,
    closing: AtomicBool,
    notifications_disabled: AtomicBool,
    cancel: Cancel,
}
impl Store {
    pub fn cached(&self, id: &str, kind: &str) -> V {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|((key, part), _)| key == id && *part == kind)
            .map(|(_, entry)| entry.data.clone())
            .unwrap_or(V::Null)
    }
    pub fn initial(&self) -> V {
        let entries = self.entries.lock().unwrap();
        let group = |kind| {
            V::Object(
                entries
                    .iter()
                    .filter(|((_, part), entry)| *part == kind && entry.initialized)
                    .map(|((id, _), entry)| (id.clone(), entry.data.clone()))
                    .collect(),
            )
        };
        object([
            ("sessions", group("session")),
            ("git", group("git")),
            ("prs", group("prs")),
            (
                "costs",
                entries
                    .get(&(String::new(), "cost"))
                    .map(|e| e.data.clone())
                    .unwrap_or(V::Null),
            ),
            (
                "activity",
                entries
                    .get(&(String::new(), "activity"))
                    .map(|e| e.data.clone())
                    .unwrap_or(V::Null),
            ),
            ("devServers", V::Array(vec![])),
            ("nodeVersion", V::Null),
        ])
    }
    pub fn set_speed(&self, value: &V) -> f64 {
        static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let text = value.text();
        let parsed = RE
            .get_or_init(|| {
                regex::Regex::new(
                    r"^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)",
                )
                .unwrap()
            })
            .find(text.trim_start())
            .and_then(|m| m.as_str().parse::<f64>().ok())
            .filter(|n| *n != 0.0 && !n.is_nan())
            .unwrap_or(1.0)
            .clamp(1.0, 10.0);
        *self.speed.lock().unwrap() = Some(parsed);
        parsed
    }
    pub fn stop(&self) {
        self.closing.store(true, Ordering::Release);
        self.cancel.cancel();
        for (_, job) in self.jobs.lock().unwrap().drain() {
            job.abort();
        }
    }
    pub fn set_notifications(&self, value: &V) -> bool {
        let enabled = *value != V::Bool(false);
        self.notifications_disabled
            .store(!enabled, Ordering::Release);
        enabled
    }
    fn complete(
        &self,
        key: &(String, &'static str),
        project: &V,
        result: Result<V, String>,
        interval: f64,
        event: &str,
        events: &events::Store,
    ) -> Option<String> {
        let speed = self.speed.lock().unwrap().unwrap_or(1.0);
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.get_mut(key)?;
        if entry.project != *project || self.closing.load(Ordering::Acquire) {
            return None;
        }
        // Failed observations retain their cache and ordinary retry interval.
        entry.next = Instant::now() + Duration::from_millis((interval * speed).round() as u64);
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                entry.errors = entry.errors.saturating_add(1);
                if entry.errors <= 3 {
                    eprintln!("[Poller] {}:{}: {error} ({}/3)", key.1, key.0, entry.errors);
                } else if entry.errors == 4 {
                    eprintln!("[Poller] {}:{}: suppressing further errors", key.1, key.0);
                }
                return None;
            }
        };
        entry.errors = 0;
        let notify = key.1 == "session"
            && entry.initialized
            && matches!(entry.data["state"].text().as_str(), "busy" | "waiting")
            && value["state"].text() == "idle"
            && !self.notifications_disabled.load(Ordering::Acquire);
        if !entry.initialized || entry.data != value {
            entry.initialized = true;
            entry.data = value.clone();
            events.publish_raw(event, value.raw().get());
        }
        notify.then(|| format!("{} — Session Complete", project["name"].text()))
    }
    pub fn tick(
        self: &Arc<Self>,
        projects: &projects::Store,
        git: Arc<git::Store>,
        events: Arc<events::Store>,
        sessions: Arc<sessions::Store>,
        costs: Arc<costs::Store>,
    ) {
        if self.closing.load(Ordering::Acquire) {
            return;
        }
        let mut jobs = self.jobs.lock().unwrap();
        if self.closing.load(Ordering::Acquire) {
            return;
        }
        let Ok(projects) = projects.list() else {
            return;
        };
        let mut projects: Vec<V> = projects
            .into_iter()
            .filter_map(|p| {
                serde_json::value::to_raw_value(&p)
                    .ok()
                    .and_then(|r| V::parse(&r).ok())
            })
            .collect();
        projects.push(V::Null);
        let ids: HashSet<_> = projects
            .iter()
            .map(|p| {
                if *p == V::Null {
                    String::new()
                } else {
                    p["id"].text()
                }
            })
            .collect();
        let speed = self.speed.lock().unwrap().unwrap_or(1.0);
        jobs.retain(|(id, _), job| {
            let keep = ids.contains(id);
            if !keep {
                job.abort();
            }
            keep && !job.is_finished()
        });
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|(id, _), _| ids.contains(id));
        for project in projects {
            let kinds: &[(&'static str, f64, &'static str)] = if project == V::Null {
                &[
                    ("cost", 60_000.0, "cost:update"),
                    ("activity", 10_000.0, "activity:new"),
                ]
            } else {
                &[
                    ("session", 5_000.0, "session:status"),
                    ("git", 30_000.0, "git:update"),
                    ("prs", 120_000.0, "pr:update"),
                ]
            };
            for &(kind, interval, event) in kinds {
                let key = (
                    if project == V::Null {
                        String::new()
                    } else {
                        project["id"].text()
                    },
                    kind,
                );
                let entry = entries.entry(key.clone()).or_insert_with(|| Entry {
                    project: project.clone(),
                    data: V::Null,
                    initialized: false,
                    errors: 0,
                    next: Instant::now(),
                });
                if entry.project != project {
                    if let Some(job) = jobs.remove(&key) {
                        job.abort();
                    }
                    *entry = Entry {
                        project: project.clone(),
                        data: V::Null,
                        initialized: false,
                        errors: 0,
                        next: Instant::now(),
                    };
                }
                if jobs.contains_key(&key) || entry.next > Instant::now() {
                    continue;
                }
                if !events.has_clients() && entry.initialized {
                    entry.next =
                        Instant::now() + Duration::from_millis((interval * speed).round() as u64);
                    continue;
                }
                let store = self.clone();
                let git = git.clone();
                let events = events.clone();
                let project = project.clone();
                let sessions = sessions.clone();
                let costs = costs.clone();
                let job_key = key.clone();
                jobs.insert(
                    key,
                    tokio::spawn(async move {
                        let value = if kind == "git" {
                            Ok(git.status(&project).await)
                        } else if kind == "prs" {
                            Ok(github::list(&project, "open").await)
                        } else {
                            let p = project.clone();
                            tokio::task::spawn_blocking(move || match kind {
                                "session" => sessions.state(&p),
                                "cost" => costs.compute(),
                                _ => sessions.activity(),
                            })
                            .await
                            .map_err(|_| "Observation task failed".to_string())
                        };
                        if let Some(title) =
                            store.complete(&job_key, &project, value, interval, event, &events)
                        {
                            if !store.notifications_disabled.load(Ordering::Acquire) {
                                if let Err(error) = desktop_notify::show(
                                    &title,
                                    "Claude session finished.",
                                    &store.cancel,
                                )
                                .await
                                {
                                    if !store.closing.load(Ordering::Acquire) {
                                        eprintln!("[Notify] {error}");
                                    }
                                }
                            }
                        }
                    }),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_entry(project: &V, data: V, initialized: bool) -> Entry {
        Entry {
            project: project.clone(),
            data,
            initialized,
            errors: 0,
            next: Instant::now(),
        }
    }

    #[tokio::test]
    async fn completion_requires_observed_active_state_and_respects_toggle() {
        let store = Store::default();
        let events = events::Store::new();
        let project = object([("id", "fixture".into()), ("name", "Private project".into())]);
        let key = ("fixture".to_string(), "session");
        for before in [
            None,
            Some("busy"),
            Some("waiting"),
            Some("idle"),
            Some("no_data"),
            Some("no_sessions"),
        ] {
            for after in ["busy", "waiting", "idle", "no_data", "no_sessions"] {
                let previous = before
                    .map(|state| object([("state", state.into())]))
                    .unwrap_or(V::Null);
                store.entries.lock().unwrap().insert(
                    key.clone(),
                    fixture_entry(&project, previous, before.is_some()),
                );
                let title = store.complete(
                    &key,
                    &project,
                    Ok(object([("state", after.into())])),
                    5000.0,
                    "session:status",
                    &events,
                );
                assert_eq!(
                    title.is_some(),
                    matches!(before, Some("busy" | "waiting")) && after == "idle"
                );
                if let Some(title) = title {
                    assert_eq!(title, "Private project — Session Complete");
                }
            }
        }
        let observe = |state: &str| {
            store.complete(
                &key,
                &project,
                Ok(object([("state", state.into())])),
                5000.0,
                "session:status",
                &events,
            )
        };
        assert_eq!(observe("busy"), None);
        assert!(!store.set_notifications(&V::Bool(false)));
        assert_eq!(observe("idle"), None);
        for value in [
            V::Null,
            V::Bool(true),
            0.0.into(),
            "false".into(),
            V::object(),
        ] {
            assert!(store.set_notifications(&value));
            assert_eq!(
                observe("idle"),
                None,
                "Re-enabling must not replay an old completion"
            );
        }
        assert_eq!(observe("waiting"), None);
        assert!(observe("idle").is_some());
        assert_eq!(observe("idle"), None);
    }

    #[tokio::test]
    async fn failures_keep_cache_and_retry_delay_and_stale_results_do_not_commit() {
        let store = Store::default();
        let events = events::Store::new();
        let project = object([("id", "fixture".into()), ("name", "Private project".into())]);
        let key = ("fixture".to_string(), "session");
        let busy = object([("state", "busy".into())]);
        store
            .entries
            .lock()
            .unwrap()
            .insert(key.clone(), fixture_entry(&project, busy.clone(), true));
        store.set_speed(&2.0.into());
        for _ in 0..5 {
            assert!(store
                .complete(
                    &key,
                    &project,
                    Err("fixture failure".into()),
                    5000.0,
                    "session:status",
                    &events
                )
                .is_none());
        }
        {
            let entries = store.entries.lock().unwrap();
            let entry = &entries[&key];
            assert_eq!(entry.data, busy);
            assert!(entry.initialized);
            assert_eq!(entry.errors, 5);
            assert!(entry.next.duration_since(Instant::now()) > Duration::from_secs(9));
        }
        let idle = object([("state", "idle".into())]);
        assert!(store
            .complete(&key, &project, Ok(idle), 5000.0, "session:status", &events)
            .is_some());
        assert_eq!(store.entries.lock().unwrap()[&key].errors, 0);
        let mut changed = project.clone();
        changed["path"] = "/private/new-project".into();
        store
            .entries
            .lock()
            .unwrap()
            .insert(key.clone(), fixture_entry(&changed, busy.clone(), true));
        assert!(store
            .complete(
                &key,
                &project,
                Ok(V::Null),
                5000.0,
                "session:status",
                &events
            )
            .is_none());
        assert_eq!(store.cached("fixture", "session"), busy);
        store.stop();
        assert!(store
            .complete(
                &key,
                &changed,
                Ok(V::Null),
                5000.0,
                "session:status",
                &events
            )
            .is_none());
        assert_eq!(store.cached("fixture", "session"), busy);
        store.entries.lock().unwrap().remove(&key);
        assert!(store
            .complete(
                &key,
                &project,
                Ok(V::Null),
                5000.0,
                "session:status",
                &events
            )
            .is_none());
        assert!(store.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn first_null_is_cached_and_identical_values_do_not_publish_again() {
        use futures_util::StreamExt;
        let store = Store::default();
        let events = events::Store::new();
        let mut stream = events.connect().into_body().into_data_stream();
        stream.next().await.unwrap().unwrap();
        let key = (String::new(), "cost");
        store
            .entries
            .lock()
            .unwrap()
            .insert(key.clone(), fixture_entry(&V::Null, V::Null, false));
        store.complete(&key, &V::Null, Ok(V::Null), 60000.0, "cost:update", &events);
        assert_eq!(
            stream.next().await.unwrap().unwrap().as_ref(),
            b"event: cost:update\ndata: null\n\n"
        );
        assert!(store.entries.lock().unwrap()[&key].initialized);
        store.complete(&key, &V::Null, Ok(V::Null), 60000.0, "cost:update", &events);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), stream.next())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cached_projects_skip_commands_without_clients_and_after_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let project = object([("id", "fixture".into()), ("path", "/unused-fixture".into())]);
        std::fs::write(
            directory.path().join("projects.json"),
            object([("projects", V::Array(vec![project.clone()]))])
                .raw()
                .get(),
        )
        .unwrap();
        let projects = projects::Store::new(directory.path().to_path_buf()).unwrap();
        let store = Arc::new(Store::default());
        let events = events::Store::new();
        let git = Arc::new(git::Store::default());
        let sessions = Arc::new(sessions::Store::new(directory.path().to_path_buf()));
        let costs = Arc::new(costs::Store::new(directory.path().to_path_buf()));
        for kind in ["session", "git", "prs", "cost", "activity"] {
            let global = matches!(kind, "cost" | "activity");
            store.entries.lock().unwrap().insert(
                (
                    if global {
                        String::new()
                    } else {
                        "fixture".into()
                    },
                    kind,
                ),
                Entry {
                    project: if global { V::Null } else { project.clone() },
                    data: V::object(),
                    initialized: true,
                    errors: 0,
                    next: Instant::now(),
                },
            );
        }
        store.tick(
            &projects,
            git.clone(),
            events.clone(),
            sessions.clone(),
            costs.clone(),
        );
        assert!(store.jobs.lock().unwrap().is_empty());
        assert!(store
            .entries
            .lock()
            .unwrap()
            .values()
            .all(|entry| entry.next > Instant::now()));
        let _client = events.connect_with_initial(V::object);
        assert!(events.has_clients());
        for entry in store.entries.lock().unwrap().values_mut() {
            entry.next = Instant::now();
        }
        store.stop();
        store.tick(&projects, git, events, sessions, costs);
        assert!(store.jobs.lock().unwrap().is_empty());
    }

    #[test]
    fn speed_matches_parse_float_and_clamp() {
        let store = Store::default();
        for (value, expected) in [
            (V::Null, 1.0),
            ("2.5slow".into(), 2.5),
            ("0x10".into(), 1.0),
            ("Infinity".into(), 10.0),
            ((-3.0).into(), 1.0),
            ("+.5".into(), 1.0),
            ("1e2x".into(), 10.0),
        ] {
            assert_eq!(store.set_speed(&value), expected);
        }
    }
}
