use crate::{
    board_value::{object, V},
    events, project_command, projects,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, Notify};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/batch/whitelist"),
    ("GET", "/api/batch/status"),
    ("POST", "/api/batch/execute"),
    ("POST", "/api/batch/stop"),
];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, endpoint)| method.as_str() == *verb && path == *endpoint)
}
struct Command {
    id: &'static str,
    label: &'static str,
    program: &'static str,
    args: &'static [&'static str],
    category: &'static str,
}
const COMMANDS: &[Command] = &[
    Command {
        id: "git-pull",
        label: "Git Pull",
        program: "git",
        args: &["pull"],
        category: "git",
    },
    Command {
        id: "git-status",
        label: "Git Status",
        program: "git",
        args: &["status", "--short"],
        category: "git",
    },
    Command {
        id: "git-fetch",
        label: "Git Fetch",
        program: "git",
        args: &["fetch", "--all"],
        category: "git",
    },
    Command {
        id: "git-stash",
        label: "Git Stash",
        program: "git",
        args: &["stash"],
        category: "git",
    },
    Command {
        id: "git-stash-pop",
        label: "Git Stash Pop",
        program: "git",
        args: &["stash", "pop"],
        category: "git",
    },
    Command {
        id: "npm-audit",
        label: "NPM Audit",
        program: "npm",
        args: &["audit", "--omit=dev"],
        category: "npm",
    },
    Command {
        id: "npm-outdated",
        label: "NPM Outdated",
        program: "npm",
        args: &["outdated"],
        category: "npm",
    },
    Command {
        id: "npm-install",
        label: "NPM Install",
        program: "npm",
        args: &["install"],
        category: "npm",
    },
    Command {
        id: "npm-test",
        label: "NPM Test",
        program: "npm",
        args: &["test"],
        category: "npm",
    },
    Command {
        id: "npm-lint",
        label: "NPM Lint",
        program: "npm",
        args: &["run", "lint"],
        category: "npm",
    },
    Command {
        id: "npm-build",
        label: "NPM Build",
        program: "npm",
        args: &["run", "build"],
        category: "npm",
    },
    Command {
        id: "disk-usage",
        label: "Disk Usage",
        program: "du",
        args: &["-sh", "."],
        category: "info",
    },
];
struct Work {
    next: usize,
    stopped: bool,
    results: Vec<V>,
}
struct Job {
    id: String,
    command: &'static Command,
    projects: Vec<V>,
    work: Mutex<Work>,
    done: AtomicBool,
    finished: Notify,
}
pub struct Store {
    events: Arc<events::Store>,
    current: Mutex<Option<Arc<Job>>>,
    closing: AtomicBool,
}
struct Guard {
    store: Arc<Store>,
    job: Arc<Job>,
}
impl Drop for Guard {
    fn drop(&mut self) {
        let mut current = self.store.current.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|job| Arc::ptr_eq(job, &self.job))
        {
            *current = None;
        }
        self.job.done.store(true, Ordering::Release);
        self.job.finished.notify_waiters();
    }
}
fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut result = Vec::new();
    while value != 0 {
        result.push(char::from_digit((value % 36) as u32, 36).unwrap());
        value /= 36;
    }
    result.into_iter().rev().collect()
}
fn concurrency(input: &V) -> usize {
    if !input["parallel"].truthy() {
        return 1;
    }
    let count = if input["maxConcurrent"].truthy() {
        input["maxConcurrent"].number()
    } else {
        3.0
    };
    if count.is_nan() || count <= 0.0 {
        0
    } else {
        count.min(5.0).floor() as usize
    }
}
impl Job {
    fn status(&self) -> V {
        object([
            ("batchId", self.id.clone().into()),
            ("commandId", self.command.id.into()),
            ("total", (self.projects.len() as f64).into()),
            (
                "completed",
                (self.work.lock().unwrap().results.len() as f64).into(),
            ),
        ])
    }
    fn summary(&self) -> V {
        let results = self.work.lock().unwrap().results.clone();
        object([
            ("batchId", self.id.clone().into()),
            ("commandId", self.command.id.into()),
            ("command", self.command.label.into()),
            ("total", (self.projects.len() as f64).into()),
            (
                "success",
                (results
                    .iter()
                    .filter(|r| r["status"] == V::from("success"))
                    .count() as f64)
                    .into(),
            ),
            (
                "error",
                (results
                    .iter()
                    .filter(|r| r["status"] == V::from("error"))
                    .count() as f64)
                    .into(),
            ),
            ("results", V::Array(results)),
        ])
    }
    async fn wait(&self) {
        loop {
            let notified = self.finished.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.done.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}
impl Store {
    pub fn new(events: Arc<events::Store>) -> Arc<Self> {
        Arc::new(Self {
            events,
            current: Mutex::new(None),
            closing: AtomicBool::new(false),
        })
    }
    fn publish(&self, name: &str, value: V) {
        self.events.publish_raw(name, value.raw().get());
    }
    fn stop(&self) -> bool {
        let job = self.current.lock().unwrap().clone();
        let Some(job) = job else {
            return false;
        };
        let results = {
            let mut work = job.work.lock().unwrap();
            work.stopped = true;
            work.results.clone()
        };
        self.publish(
            "batch:done",
            object([
                ("batchId", job.id.clone().into()),
                ("stopped", true.into()),
                ("results", V::Array(results)),
            ]),
        );
        true
    }
    async fn worker(self: Arc<Self>, job: Arc<Job>) {
        loop {
            let (project, index) = {
                let mut work = job.work.lock().unwrap();
                if work.stopped || work.next >= job.projects.len() {
                    return;
                }
                let project = job.projects[work.next].clone();
                work.next += 1;
                (project, work.results.len())
            };
            let started = Instant::now();
            let mut progress = object([
                ("batchId", job.id.clone().into()),
                ("projectId", project["id"].clone()),
                ("status", "running".into()),
                ("index", (index as f64).into()),
            ]);
            if project.has("name") {
                progress["projectName"] = project["name"].clone();
            }
            self.publish("batch:progress", progress);
            let command = job.command;
            let args = command
                .args
                .iter()
                .map(|s| (*s).to_owned())
                .collect::<Vec<_>>();
            let mut cancelled = false;
            let execution = project_command::run_with_spawn(
                &project,
                command.program,
                &args,
                Duration::from_secs(if command.program == "git" { 60 } else { 120 }),
                1024 * 1024,
                |command| {
                    // Check after the global execution slot is acquired. Stop
                    // and spawn share this lock, so queued work cannot start
                    // after stop while an already spawned child can finish.
                    let work = job.work.lock().unwrap();
                    if work.stopped {
                        cancelled = true;
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "Batch stopped before command spawn",
                        ));
                    }
                    command.spawn()
                },
            )
            .await;
            if cancelled {
                return;
            }
            let (status, output) = match execution {
                // The old Node implementation calls .slice on {stdout,stderr}.
                // Successful commands intentionally use their actual stdout here.
                Ok(output) => (
                    "success",
                    V::from(String::from_utf8_lossy(&output.stdout).into_owned()).cut(5000),
                ),
                Err(error) => {
                    let error = if command.program != "git"
                        && !project["path"]
                            .text()
                            .replace('\\', "/")
                            .starts_with("//wsl")
                    {
                        error.replacen(
                            &format!("Command failed: {}", command.program),
                            &format!("Command failed: sh -c {}", command.program),
                            1,
                        )
                    } else {
                        error
                    };
                    ("error", V::from(error).cut(2000))
                }
            };
            let mut result = object([
                ("projectId", project["id"].clone()),
                ("status", status.into()),
                ("output", output),
                ("duration", (started.elapsed().as_millis() as f64).into()),
            ]);
            if project.has("name") {
                result["projectName"] = project["name"].clone();
            }
            let index = {
                let mut work = job.work.lock().unwrap();
                work.results.push(result.clone());
                work.results.len() - 1
            };
            result["batchId"] = job.id.clone().into();
            result["index"] = (index as f64).into();
            self.publish("batch:progress", result);
        }
    }
    async fn execute(self: Arc<Self>, job: Arc<Job>, count: usize, reply: oneshot::Sender<V>) {
        let guard = Guard {
            store: self.clone(),
            job: job.clone(),
        };
        self.publish(
            "batch:start",
            object([
                ("batchId", job.id.clone().into()),
                ("commandId", job.command.id.into()),
                ("command", job.command.label.into()),
                ("total", (job.projects.len() as f64).into()),
            ]),
        );
        let mut workers = tokio::task::JoinSet::new();
        for _ in 0..count.min(job.projects.len()) {
            workers.spawn(self.clone().worker(job.clone()));
        }
        while workers.join_next().await.is_some() {}
        let summary = job.summary();
        drop(guard);
        self.publish("batch:done", summary.clone());
        let _ = reply.send(summary);
    }
    pub async fn handle(
        self: &Arc<Self>,
        method: &Method,
        path: &str,
        input: V,
        projects: &projects::Store,
    ) -> Response {
        match (method.as_str(), path) {
            ("GET", "/api/batch/whitelist") => Json(
                V::Array(
                    COMMANDS
                        .iter()
                        .map(|c| {
                            object([
                                ("id", c.id.into()),
                                ("label", c.label.into()),
                                ("category", c.category.into()),
                            ])
                        })
                        .collect(),
                )
                .raw(),
            )
            .into_response(),
            ("GET", "/api/batch/status") => Json(
                self.current
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|job| job.status())
                    .unwrap_or(V::Null)
                    .raw(),
            )
            .into_response(),
            ("POST", "/api/batch/stop") => {
                Json(object([("stopped", self.stop().into())]).raw()).into_response()
            }
            ("POST", "/api/batch/execute") => {
                if !input["commandId"].truthy() || !input["projectIds"].is_array() {
                    return crate::error(400, "commandId and projectIds required");
                }
                let targets: Vec<_> = input["projectIds"]
                    .array()
                    .iter()
                    .filter(|id| id.is_string())
                    .filter_map(|id| crate::git::project(projects, &id.text()))
                    .collect();
                if targets.is_empty() {
                    return crate::error(400, "No valid projects");
                }
                let Some(command) = COMMANDS
                    .iter()
                    .find(|command| input["commandId"] == V::from(command.id))
                else {
                    return crate::error(
                        400,
                        &format!("Unknown command: {}", input["commandId"].text()),
                    );
                };
                let job = {
                    let mut current = self.current.lock().unwrap();
                    if self.closing.load(Ordering::Acquire) {
                        return crate::error(503, "Server is shutting down");
                    }
                    if current.is_some() {
                        return crate::error(400, "Another batch is already running");
                    }
                    let job = Arc::new(Job {
                        id: base36(crate::account_usage::now() as u64),
                        command,
                        projects: targets,
                        work: Mutex::new(Work {
                            next: 0,
                            stopped: false,
                            results: vec![],
                        }),
                        done: AtomicBool::new(false),
                        finished: Notify::new(),
                    });
                    *current = Some(job.clone());
                    job
                };
                let (send, receive) = oneshot::channel();
                tokio::spawn(self.clone().execute(job, concurrency(&input), send));
                match receive.await {
                    Ok(result) => Json(result.raw()).into_response(),
                    Err(_) => crate::error(500, "Batch execution interrupted"),
                }
            }
            _ => crate::error(404, "Not found"),
        }
    }
    pub async fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        let job = self.current.lock().unwrap().clone();
        if let Some(job) = job {
            job.work.lock().unwrap().stopped = true;
            job.wait().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn whitelist_and_concurrency_are_closed_and_bounded() {
        assert_eq!(COMMANDS.len(), 12);
        assert!(COMMANDS
            .iter()
            .all(|c| matches!(c.program, "git" | "npm" | "du")));
        assert_eq!(concurrency(&object([("parallel", true.into())])), 3);
        assert_eq!(
            concurrency(&object([
                ("parallel", true.into()),
                ("maxConcurrent", 99.0.into())
            ])),
            5
        );
        assert_eq!(
            concurrency(&object([
                ("parallel", true.into()),
                ("maxConcurrent", (-1.0).into())
            ])),
            0
        );
        assert_eq!(concurrency(&V::Null), 1);
        assert_eq!(base36(36), "10");
    }
    #[test]
    fn guard_releases_status_on_early_exit() {
        let store = Store::new(events::Store::new());
        let job = Arc::new(Job {
            id: "test".into(),
            command: &COMMANDS[0],
            projects: vec![],
            work: Mutex::new(Work {
                next: 0,
                stopped: false,
                results: vec![],
            }),
            done: AtomicBool::new(false),
            finished: Notify::new(),
        });
        *store.current.lock().unwrap() = Some(job.clone());
        drop(Guard {
            store: store.clone(),
            job: job.clone(),
        });
        assert!(store.current.lock().unwrap().is_none());
        assert!(job.done.load(Ordering::Acquire));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disconnected_reply_keeps_job_owned_and_shutdown_finishes_only_current_command() {
        static FIXTURE: Command = Command {
            id: "fixture",
            label: "Fixture",
            program: "/bin/sh",
            args: &["-c", "printf started > started; sleep 0.15; printf fixture"],
            category: "info",
        };
        let directory = tempfile::tempdir().unwrap();
        let project = object([
            ("id", "fixture".into()),
            (
                "path",
                directory.path().to_string_lossy().to_string().into(),
            ),
        ]);
        let store = Store::new(events::Store::new());
        let job = Arc::new(Job {
            id: "fixture".into(),
            command: &FIXTURE,
            projects: vec![project.clone(), project],
            work: Mutex::new(Work {
                next: 0,
                stopped: false,
                results: vec![],
            }),
            done: AtomicBool::new(false),
            finished: Notify::new(),
        });
        *store.current.lock().unwrap() = Some(job.clone());
        let (send, receive) = oneshot::channel();
        drop(receive);
        let task = tokio::spawn(store.clone().execute(job.clone(), 1, send));
        tokio::time::timeout(Duration::from_secs(3), async {
            while !directory.path().join("started").exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(3), store.shutdown())
            .await
            .unwrap();
        task.await.unwrap();
        let summary = job.summary();
        assert_eq!(summary["results"].array().len(), 1);
        assert_eq!(summary["results"].array()[0]["output"], V::from("fixture"));
        assert_eq!(summary["success"], V::Number(1.0));
        assert!(store.current.lock().unwrap().is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopped_or_shutdown_batch_never_spawns_after_waiting_for_a_global_slot() {
        static FIXTURE: Command = Command {
            id: "never-spawn",
            label: "Never spawn",
            program: "/bin/sh",
            args: &["-c", "printf forbidden > spawned"],
            category: "info",
        };
        for shutdown in [false, true] {
            let slots = project_command::hold_all_slots().await;
            let directory = tempfile::tempdir().unwrap();
            let project = object([
                ("id", "fixture".into()),
                (
                    "path",
                    directory.path().to_string_lossy().to_string().into(),
                ),
            ]);
            let store = Store::new(events::Store::new());
            let job = Arc::new(Job {
                id: "queued".into(),
                command: &FIXTURE,
                projects: vec![project.clone(), project],
                work: Mutex::new(Work {
                    next: 0,
                    stopped: false,
                    results: vec![],
                }),
                done: AtomicBool::new(false),
                finished: Notify::new(),
            });
            *store.current.lock().unwrap() = Some(job.clone());
            let (send, receive) = oneshot::channel();
            let task = tokio::spawn(store.clone().execute(job.clone(), 1, send));
            tokio::time::timeout(Duration::from_secs(3), async {
                while job.work.lock().unwrap().next == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let shutdown_task = if shutdown {
                let store = store.clone();
                Some(tokio::spawn(async move { store.shutdown().await }))
            } else {
                assert!(store.stop());
                None
            };
            tokio::time::timeout(Duration::from_secs(3), async {
                while !job.work.lock().unwrap().stopped {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(!directory.path().join("spawned").exists());
            drop(slots);
            let summary = tokio::time::timeout(Duration::from_secs(3), receive)
                .await
                .unwrap()
                .unwrap();
            task.await.unwrap();
            if let Some(task) = shutdown_task {
                task.await.unwrap();
            }
            assert!(!directory.path().join("spawned").exists());
            assert!(summary["results"].array().is_empty());
            assert_eq!(summary["success"], V::Number(0.0));
            assert_eq!(summary["error"], V::Number(0.0));
            assert_eq!(job.work.lock().unwrap().next, 1);
            assert!(store.current.lock().unwrap().is_none());
        }
    }
}
