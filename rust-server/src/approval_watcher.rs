use chrono::DateTime;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/board/approval-watcher"),
    ("POST", "/api/board/approval-watcher/stop"),
];
const SCRIPT: &str = "/tmp/approve-cockpit-sessions.sh";
const STATUS_ARGS: &[&str] = &[
    "-L",
    "approve-bot",
    "list-panes",
    "-s",
    "-t",
    "=approvals",
    "-F",
    "#{pane_dead}|#{pane_start_command}",
];
const STOP_ARGS: &[&str] = &["-L", "approve-bot", "kill-session", "-t", "=approvals"];

pub struct Store {
    tmux_directory: Option<PathBuf>,
    heartbeat: PathBuf,
}

struct ExecError {
    message: String,
    stderr: String,
}

impl Store {
    pub fn new(directory: &Path) -> Self {
        Self {
            tmux_directory: Some(directory.join("tmux")),
            heartbeat: directory.join("approve-cockpit-sessions.heartbeat"),
        }
    }

    pub fn new_legacy() -> Self {
        Self {
            tmux_directory: None,
            heartbeat: "/tmp/approve-cockpit-sessions.heartbeat".into(),
        }
    }

    pub async fn handle(&self, stop: bool) -> Result<Value, String> {
        self.handle_with(stop, |args| self.execute(args)).await
    }

    async fn execute(&self, args: &'static [&'static str]) -> Result<String, ExecError> {
        let mut command = tokio::process::Command::new("/usr/bin/tmux");
        command.args(args).kill_on_drop(true);
        if let Some(directory) = &self.tmux_directory {
            command.env("TMUX_TMPDIR", directory);
        }
        match crate::commands::capture(command, Duration::from_secs(2)).await {
            Ok(output) if output.status.success() => {
                Ok(String::from_utf8_lossy(&output.stdout).into_owned())
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                Err(ExecError {
                    message: format!(
                        "Command failed: /usr/bin/tmux {}\n{}",
                        args.join(" "),
                        stderr
                    ),
                    stderr,
                })
            }
            Err(error) => Err(ExecError {
                message: error.to_string(),
                stderr: String::new(),
            }),
        }
    }

    async fn handle_with<F, Fut>(&self, stop: bool, mut execute: F) -> Result<Value, String>
    where
        F: FnMut(&'static [&'static str]) -> Fut,
        Fut: Future<Output = Result<String, ExecError>>,
    {
        let status = self.status(execute(STATUS_ARGS).await);
        if !stop {
            return Ok(status);
        }
        if status["canStop"] != true {
            return Err("승인 스크립트의 전용 세션을 확인하지 못해 중지하지 않았습니다.".into());
        }
        execute(STOP_ARGS).await.map_err(|error| error.message)?;
        Ok(self.status(execute(STATUS_ARGS).await))
    }

    fn status(&self, output: Result<String, ExecError>) -> Value {
        let (state, can_stop) = match output {
            Ok(output) if output.trim() == format!("0|{SCRIPT}") => ("running", true),
            Err(error)
                if [
                    "can't find session",
                    "no server running",
                    "No such file or directory",
                ]
                .iter()
                .any(|text| error.stderr.contains(text)) =>
            {
                ("stopped", false)
            }
            _ => ("unknown", false),
        };
        let text = if std::fs::symlink_metadata(&self.heartbeat)
            .is_ok_and(|m| m.is_file() && m.len() <= 65_536)
        {
            std::fs::read_to_string(&self.heartbeat).unwrap_or_default()
        } else {
            String::new()
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_millis() as i64);
        json!({ "state": state, "canStop": can_stop, "script": SCRIPT,
            "targets": ["ai1", "ai4", "ai6", "ai7"], "intervalSeconds": 3,
            "heartbeat": heartbeat(&text, now) })
    }
}

fn timestamp(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .or_else(|_| DateTime::parse_from_rfc2822(text))
        .ok()
        .map(|date| date.timestamp_millis())
}

fn heartbeat(text: &str, now: i64) -> Value {
    let mut fields = text.split_whitespace();
    let Some(at) = fields.next().and_then(timestamp) else {
        return Value::Null;
    };
    let values: HashMap<_, _> = fields
        .map(|field| {
            let mut parts = field.split('=');
            (
                parts.next().unwrap_or_default(),
                parts.next().unwrap_or_default(),
            )
        })
        .collect();
    let number = |key| {
        values
            .get(key)
            .filter(|value| !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()))
            .and_then(|value| value.parse::<f64>().ok())
            .map_or(Value::Null, |value| json!(value))
    };
    json!({ "at": at, "stale": now as i128 - at as i128 > 15_000,
        "readOk": number("read_ok"), "sent": number("sent_total"), "cleared": number("cleared_total") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::ready;

    fn failure(stderr: &str) -> Result<String, ExecError> {
        Err(ExecError {
            message: "tmux failed".into(),
            stderr: stderr.into(),
        })
    }

    #[test]
    fn heartbeat_preserves_dates_staleness_and_javascript_number_counters() {
        let at = timestamp("2026-10-02T00:00:00Z").unwrap();
        assert_eq!(timestamp("2026-10-02T09:00:00+09:00"), Some(at));
        assert_eq!(timestamp("Fri, 02 Oct 2026 00:00:00 +0000"), Some(at));
        let text = "2026-10-02T00:00:00Z read_ok=4 sent_total=9007199254740993 cleared_total=-1";
        let exact = heartbeat(text, at + 15_000);
        assert_eq!(exact["stale"], false);
        assert_eq!(heartbeat(text, at + 15_001)["stale"], true);
        assert_eq!(exact["readOk"].as_f64(), Some(4.0));
        assert_eq!(exact["sent"].as_f64(), Some(9_007_199_254_740_992.0));
        assert_eq!(exact["cleared"], Value::Null);
        assert_eq!(heartbeat("not-a-date read_ok=1", at), Value::Null);
        assert_eq!(heartbeat("", at), Value::Null);
        let text = format!(
            "2026-10-02T00:00:00Z sent_total={} read_ok=1 read_ok=2",
            "9".repeat(400)
        );
        assert_eq!(heartbeat(&text, at)["sent"], Value::Null);
        assert_eq!(heartbeat(&text, at)["readOk"].as_f64(), Some(2.0));
    }

    #[tokio::test]
    async fn status_and_guarded_stop_only_use_the_exact_dedicated_session() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path());
        assert_eq!(
            STATUS_ARGS,
            [
                "-L",
                "approve-bot",
                "list-panes",
                "-s",
                "-t",
                "=approvals",
                "-F",
                "#{pane_dead}|#{pane_start_command}"
            ]
        );
        assert_eq!(
            STOP_ARGS,
            ["-L", "approve-bot", "kill-session", "-t", "=approvals"]
        );
        assert_eq!(store.tmux_directory, Some(directory.path().join("tmux")));
        assert_eq!(store.heartbeat.parent(), Some(directory.path()));
        for (output, state) in [
            (Ok(format!("0|{SCRIPT}\n")), "running"),
            (Ok(format!("0|{SCRIPT}\n0|{SCRIPT}\n")), "unknown"),
            (Ok(format!("1|{SCRIPT}\n")), "unknown"),
            (Ok("0|codex\n".into()), "unknown"),
            (failure("can't find session: approvals"), "stopped"),
            (failure("no server running"), "stopped"),
            (failure("No such file or directory"), "stopped"),
            (failure("Permission denied"), "unknown"),
        ] {
            let mut output = Some(output);
            let result = store
                .handle_with(false, |args| {
                    assert_eq!(args, STATUS_ARGS);
                    ready(output.take().unwrap())
                })
                .await
                .unwrap();
            assert_eq!(result["state"], state);
            assert_eq!(result["canStop"], state == "running");
            assert_eq!(result["heartbeat"], Value::Null);
        }
        std::fs::write(&store.heartbeat, "bad-heartbeat").unwrap();
        assert_eq!(
            store.status(Ok(format!("0|{SCRIPT}")))["heartbeat"],
            Value::Null
        );
        let mut calls = Vec::new();
        let result = store
            .handle_with(true, |args| {
                calls.push(args);
                ready(match calls.len() {
                    1 => Ok(format!("0|{SCRIPT}\n")),
                    2 => Ok(String::new()),
                    _ => failure("no server running"),
                })
            })
            .await
            .unwrap();
        assert_eq!(calls, [STATUS_ARGS, STOP_ARGS, STATUS_ARGS]);
        assert_eq!(result["state"], "stopped");
        calls.clear();
        assert!(store
            .handle_with(true, |args| {
                calls.push(args);
                ready(Ok(format!("0|{SCRIPT}\n0|codex\n")))
            })
            .await
            .unwrap_err()
            .contains("전용 세션"));
        assert_eq!(calls, [STATUS_ARGS]);
        calls.clear();
        assert_eq!(
            store
                .handle_with(true, |args| {
                    calls.push(args);
                    ready(if calls.len() == 1 {
                        Ok(format!("0|{SCRIPT}"))
                    } else {
                        failure("Permission denied")
                    })
                })
                .await
                .unwrap_err(),
            "tmux failed"
        );
        assert_eq!(calls, [STATUS_ARGS, STOP_ARGS]);
    }
}
