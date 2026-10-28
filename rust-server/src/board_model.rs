use crate::board_value::{object, V};
use std::collections::HashSet;

fn text(value: &V, limit: usize, coerce: bool, trim: bool, default: &str) -> V {
    let value = if value.is_string() {
        value.clone()
    } else if coerce && value.truthy() {
        V::from(value.text())
    } else {
        V::from(default)
    };
    let value = if trim { value.trim() } else { value };
    value.cut(limit)
}
fn strings(out: &mut V, source: &V, fields: &[(&str, usize)], coerce: bool) {
    for (key, limit) in fields {
        out[key] = text(&source[key], *limit, coerce, false, "");
    }
}
fn numbers(out: &mut V, source: &V, fields: &[&str]) {
    for key in fields {
        out[key] = source[key].number_or(0.0).into();
    }
}
fn choice(value: &V, values: &[&str], default: &str) -> V {
    if value.is_string() && values.contains(&value.text().as_str()) {
        value.clone()
    } else {
        default.into()
    }
}
fn integer(value: &V, min: f64, max: f64, default: f64) -> V {
    let n = value.number();
    if value.is_integer() && n >= min && n <= max {
        value.clone()
    } else {
        default.into()
    }
}
fn positive_count(value: &V) -> V {
    value.number_or(0.0).max(0.0).into()
}
fn supervisor_id(value: &V) -> bool {
    value.is_string()
        && value.text().strip_prefix("S-").is_some_and(|s| {
            !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}
fn numbered_id(value: &V, prefix: &str) -> Option<f64> {
    if !value.is_string() {
        return None;
    }
    let id = value.text();
    let digits = id.strip_prefix(prefix)?;
    (digits.len() >= 4 && digits.bytes().all(|c| c.is_ascii_digit()))
        .then(|| digits.parse().unwrap_or(f64::INFINITY))
}
fn keys(value: &V) -> V {
    V::Array(
        value
            .array()
            .iter()
            .filter(|v| {
                v.is_string()
                    && v.text().len() == 64
                    && v.text()
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
            .cloned()
            .collect(),
    )
}
pub fn remaining(value: &V) -> V {
    V::Array(
        value
            .array()
            .iter()
            .take(30)
            .map(|v| {
                let mut out = v.object_clone();
                strings(
                    &mut out,
                    v,
                    &[("condition", 1000), ("blocker", 1000), ("nextAction", 1000)],
                    true,
                );
                out
            })
            .collect(),
    )
}

pub fn review(source: &V) -> V {
    let mut out = source.object_clone();
    out["id"] = if supervisor_id(&source["id"]) {
        source["id"].clone()
    } else {
        "S-0001".into()
    };
    out["name"] = if source["name"].is_string() && source["name"].trim().truthy() {
        source["name"].trim().cut(80)
    } else {
        "감독 1".into()
    };
    strings(
        &mut out,
        source,
        &[
            ("termId", 200),
            ("alias", 80),
            ("objective", 4000),
            ("lastError", 500),
            ("lastReviewKey", 64),
        ],
        false,
    );
    for (key, min, max, default) in [
        ("intervalMinutes", 1.0, 1440.0, 5.0),
        ("runHours", 1.0, 24.0, 0.0),
        ("stallMinutes", 5.0, 240.0, 0.0),
    ] {
        out[key] = integer(&source[key], min, max, default);
    }
    numbers(
        &mut out,
        source,
        &[
            "pendingSince",
            "lastReviewedAt",
            "nextDueAt",
            "retryAt",
            "recoveryAfter",
            "cycleStartedAt",
        ],
    );
    out["runUntil"] = if matches!(source["runUntil"],V::Number(n) if n.is_finite()&&n>0.0) {
        source["runUntil"].clone()
    } else {
        0.0.into()
    };
    out["referencePaths"] = V::Array(
        source["referencePaths"]
            .array()
            .iter()
            .filter(|v| v.is_string())
            .take(30)
            .map(|v| v.trim().cut(2000))
            .filter(V::truthy)
            .collect(),
    );
    out["workerDispatch"] = choice(&source["workerDispatch"], &["running", "paused"], "linked");
    out["watched"] = V::Array(
        source["watched"]
            .array()
            .iter()
            .take(12)
            .filter(|v| v["termId"].is_string())
            .map(|v| {
                let mut item = v.object_clone();
                item["termId"] = v["termId"].cut(200);
                strings(
                    &mut item,
                    v,
                    &[("alias", 80), ("goal", 2000), ("objective", 2000)],
                    true,
                );
                item["priority"] = integer(&v["priority"], 1.0, 3.0, 2.0);
                item["paused"] = V::Bool(v["paused"] == V::Bool(true));
                item
            })
            .collect(),
    );
    out["workerProgress"] = V::Array(
        source["workerProgress"]
            .array()
            .iter()
            .take(12)
            .filter(|v| v["termId"].is_string())
            .map(|v| {
                let mut item = v.object_clone();
                item["termId"] = v["termId"].cut(200);
                strings(
                    &mut item,
                    v,
                    &[
                        ("goal", 2000),
                        ("evidence", 2400),
                        ("blocker", 1000),
                        ("nextAction", 1000),
                    ],
                    true,
                );
                numbers(&mut item, v, &["startedAt", "lastProgressAt", "alertedAt"]);
                item["evidenceKeys"] = keys(&v["evidenceKeys"]);
                let r = &v["run"];
                let mut run = r.object_clone();
                run["status"] = choice(
                    &r["status"],
                    &["ready", "active", "blocked", "reported", "complete"],
                    "ready",
                );
                strings(
                    &mut run,
                    r,
                    &[
                        ("token", 80),
                        ("summary", 2000),
                        ("nextAction", 1000),
                        ("evidence", 2400),
                        ("blocker", 1000),
                        ("alternatives", 1000),
                        ("dependencyKey", 64),
                        ("taskId", 80),
                        ("taskDispatchKey", 64),
                        ("lastError", 500),
                    ],
                    true,
                );
                run["observed"] = text(&r["observed"], 20, true, false, "unknown");
                if !r["observed"].truthy() {
                    run["observed"] = "unknown".into();
                }
                numbers(
                    &mut run,
                    r,
                    &[
                        "resumeRequestedAt",
                        "resumeSentAt",
                        "resumeSubmittedAt",
                        "interventionAt",
                        "checkQueuedAt",
                        "lastSentAt",
                        "reportedAt",
                        "progressAt",
                        "blockedVerifiedAt",
                    ],
                );
                run["attempts"] = positive_count(&r["attempts"]);
                run["remaining"] = remaining(&r["remaining"]);
                run["evidenceKeys"] = keys(&r["evidenceKeys"]);
                item["run"] = run;
                item
            })
            .collect(),
    );
    out["status"] = choice(
        &source["status"],
        &["running", "waiting", "complete", "stopped"],
        if source["termId"].truthy() {
            "running"
        } else {
            "stopped"
        },
    );
    out["attempts"] = positive_count(&source["attempts"]);
    out["recoveryAttempts"] = positive_count(&source["recoveryAttempts"]);
    out["autoRecover"] = V::Bool(source["autoRecover"] == V::Bool(true));
    let mut permissions = source["launchPermissions"].object_clone();
    permissions["codex"] = choice(
        &source["launchPermissions"]["codex"],
        &["default", "workspace", "network", "full"],
        "default",
    );
    permissions["claude"] = choice(
        &source["launchPermissions"]["claude"],
        &["default", "edits", "auto", "full"],
        "default",
    );
    out["launchPermissions"] = permissions;
    out["recoveryTerminal"] = if matches!(source["recoveryTerminal"], V::Object(_) | V::Array(_)) {
        let v = &source["recoveryTerminal"];
        let mut item = v.object_clone();
        strings(
            &mut item,
            v,
            &[
                ("termId", 4000),
                ("alias", 4000),
                ("projectId", 4000),
                ("command", 4000),
                ("cwd", 4000),
                ("accountId", 4000),
                ("durableId", 4000),
            ],
            true,
        );
        item["conversationHeld"] = V::Bool(v["conversationHeld"] == V::Bool(true));
        item
    } else {
        V::Null
    };
    out["reports"] = V::Array(
        source["reports"]
            .array()
            .iter()
            .map(|v| {
                let mut item = v.object_clone();
                numbers(&mut item, v, &["at"]);
                strings(&mut item, v, &[("status", 40), ("text", 4000)], true);
                item
            })
            .collect(),
    );
    out
}

pub fn normalize(source: &V, now: f64) -> V {
    let first = source["supervisors"].array().first().unwrap_or(&V::Null);
    let mut primary = if source["review"].truthy() {
        source["review"].object_clone()
    } else {
        first.object_clone()
    };
    primary["id"] = "S-0001".into();
    let primary = review(&primary);
    let mut supervisors = vec![primary.clone()];
    let mut supervisor_ids = HashSet::from(["S-0001".to_string()]);
    for v in source["supervisors"].array() {
        if supervisor_id(&v["id"]) && supervisor_ids.insert(v["id"].text()) {
            supervisors.push(review(v));
        }
    }
    let mut out = source.object_clone();
    out["review"] = primary;
    out["supervisors"] = V::Array(supervisors);
    let legacy = object([
        ("id", "N-0001".into()),
        ("title", "Memo 1".into()),
        (
            "content",
            text(&source["note"]["content"], 12000, false, false, ""),
        ),
        (
            "createdAt",
            source["note"]["updatedAt"].number_or(now).into(),
        ),
        (
            "updatedAt",
            source["note"]["updatedAt"].number_or(0.0).into(),
        ),
    ]);
    let default_list = object([
        ("id", "C-0001".into()),
        ("title", "Checklist 1".into()),
        ("createdAt", now.into()),
        ("updatedAt", 0.0.into()),
    ]);
    for (collection, prefix, counter, label, legacy) in [
        ("notes", "N-", "nextNoteNumber", "Memo", legacy),
        (
            "checklists",
            "C-",
            "nextChecklistNumber",
            "Checklist",
            default_list,
        ),
    ] {
        let items = if source[collection].is_array() {
            source[collection].array().to_vec()
        } else {
            vec![legacy]
        };
        let mut seen = HashSet::new();
        let mut highest: f64 = 0.0;
        let mut normalized = Vec::new();
        for item in items {
            let Some(number) = numbered_id(&item["id"], prefix) else {
                continue;
            };
            if !seen.insert(item["id"].text()) {
                continue;
            }
            highest = highest.max(number);
            let mut value = item.object_clone();
            value["title"] = if item["title"].is_string() && item["title"].trim().truthy() {
                item["title"].trim().cut(80)
            } else {
                V::from(format!("{label} {number}")).cut(80)
            };
            value["createdAt"] = item["createdAt"].number_or(now).into();
            value["updatedAt"] = item["updatedAt"].number_or(0.0).into();
            if collection == "notes" {
                value["content"] = text(&item["content"], 12000, false, false, "");
            } else {
                value["goal"] = text(&item["goal"], 4000, false, false, "");
                value["supervisorId"] = if supervisor_ids.contains(&item["supervisorId"].text()) {
                    item["supervisorId"].clone()
                } else {
                    "S-0001".into()
                };
            }
            normalized.push(value);
        }
        if collection == "checklists"
            && normalized.is_empty()
            && source["tasks"]
                .array()
                .iter()
                .any(|item| item["text"].truthy())
        {
            normalized.push(object([
                ("id", "C-0001".into()),
                ("supervisorId", "S-0001".into()),
                ("title", "Checklist 1".into()),
                ("createdAt", now.into()),
                ("updatedAt", 0.0.into()),
            ]));
            highest = 1.0;
        }
        out[collection] = V::Array(normalized);
        out[counter] = (highest + 1.0).max(source[counter].number_or(1.0)).into();
    }
    let list_ids: HashSet<_> = out["checklists"]
        .array()
        .iter()
        .map(|v| v["id"].text())
        .collect();
    let default_id = out["checklists"]
        .array()
        .first()
        .map(|v| v["id"].clone())
        .unwrap_or(V::from(""));
    let mut seen = HashSet::new();
    let mut highest: f64 = 0.0;
    let mut tasks = Vec::new();
    for item in source["tasks"].array() {
        let Some(number) = numbered_id(&item["id"], "T-") else {
            continue;
        };
        let content = text(&item["text"], 500, false, true, "");
        if !content.truthy() || !seen.insert(item["id"].text()) {
            continue;
        }
        highest = highest.max(number);
        let mut task = item.object_clone();
        task["text"] = content;
        task["done"] = V::Bool(item["done"] == V::Bool(true));
        let question = item["kind"] == V::from("question");
        task["kind"] = if question {
            "question".into()
        } else {
            "task".into()
        };
        task.remove("termId");
        task.remove("questionTo");
        if question {
            task["questionTo"] = choice(&item["questionTo"], &["supervisor"], "user");
        } else if item["termId"].is_string() && item["termId"].truthy() {
            task["termId"] = item["termId"].cut(200);
            task["activation"] = (item["activation"].number().max(0.0)
                + if item["done"] != V::Bool(true) && item["status"] == V::from("done") {
                    1.0
                } else {
                    0.0
                })
            .into();
            task["status"] = if item["done"] == V::Bool(true) {
                "done".into()
            } else {
                choice(&item["status"], &["running", "blocked"], "ready")
            };
            if item.has("waitFor") {
                task["waitFor"] = V::Array(
                    item["waitFor"]
                        .array()
                        .iter()
                        .filter(|id| id.is_string())
                        .take(10)
                        .cloned()
                        .collect(),
                );
                task["waitKey"] = text(&item["waitKey"], 64, true, false, "");
                task["blocker"] = text(&item["blocker"], 1000, true, false, "");
            }
        }
        task["answer"] = text(&item["answer"], 4000, false, false, "");
        task["checklistId"] = if list_ids.contains(&item["checklistId"].text()) {
            item["checklistId"].clone()
        } else {
            default_id.clone()
        };
        task["createdAt"] = item["createdAt"].number_or(now).into();
        task["updatedAt"] = item["updatedAt"].number_or(now).into();
        tasks.push(task);
    }
    out["tasks"] = V::Array(tasks);
    crate::board::refresh_waits(&mut out);
    out["nextTaskNumber"] = (highest + 1.0)
        .max(source["nextTaskNumber"].number_or(1.0))
        .into();
    out["note"] = out["notes"]
        .array()
        .first()
        .map(|v| {
            object([
                ("content", v["content"].clone()),
                ("updatedAt", v["updatedAt"].clone()),
            ])
        })
        .unwrap_or_else(|| object([("content", "".into()), ("updatedAt", 0.0.into())]));
    for (field, value) in [
        ("schemaVersion", 2.0),
        ("reviewVersion", 1.0),
        ("supervisionVersion", 9.0),
    ] {
        out[field] = value.into();
    }
    out["revision"] = source["revision"].number_or(0.0).max(0.0).into();
    out["updatedAt"] = source["updatedAt"].number_or(0.0).into();
    out
}

pub fn empty() -> V {
    normalize(
        &object([
            ("notes", V::Array(vec![])),
            ("checklists", V::Array(vec![])),
            ("tasks", V::Array(vec![])),
        ]),
        0.0,
    )
}
