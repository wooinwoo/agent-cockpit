use super::{invalid, object, Error, Result, V};
use crate::{board_model, terminals};
use axum::http::Method;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(super) struct Observations {
    terminals: HashMap<String, (V, Option<String>)>,
    recovery: Option<std::result::Result<V, String>>,
}
impl Observations {
    pub(super) fn validate(&self, store: &terminals::Store) -> Result<()> {
        for (saved, _) in self.terminals.values() {
            let current = store.reference(&saved["termId"].text(), false);
            if !current.is_some_and(|(value, _)| {
                ["command", "conversationHeld", "durableId"]
                    .iter()
                    .all(|key| {
                        serde_json::value::to_raw_value(&value[key])
                            .ok()
                            .and_then(|raw| V::parse(&raw).ok())
                            .is_some_and(|value| value == saved[key])
                    })
            }) {
                return Err(Error(
                    409,
                    "터미널 실행 명령이나 대화 보호 상태가 변경됐습니다. 최신 상태를 확인하세요."
                        .into(),
                ));
            }
        }
        Ok(())
    }
}

// Inspect processes before taking the shared file lock. A stalled tmux query
// must not block unrelated board edits or the CLI's fallback writer.
pub(super) fn observe(
    method: &Method,
    path: &str,
    input: &V,
    store: &terminals::Store,
) -> Observations {
    let mut ids = Vec::new();
    let configure = *method == Method::PUT && path == "/api/board/review";
    if configure {
        ids.push(input["target"].clone());
        ids.extend(
            input["watched"]
                .array()
                .iter()
                .take(12)
                .map(|item| item["target"].clone()),
        );
    } else if path == "/api/board/worker-settings" {
        ids.push(input["termId"].clone());
    }
    let mut seen = HashSet::new();
    ids.retain(|id| id.is_string() && id.truthy() && seen.insert(id.text()));
    let mut result = Observations::default();
    let runtime = tokio::runtime::Handle::current();
    for batch in ids.chunks(8) {
        let rows = std::thread::scope(|scope| {
            let threads: Vec<_> = batch
                .iter()
                .map(|id| {
                    let runtime = &runtime;
                    scope.spawn(move || {
                        let _entered = runtime.enter();
                        let (saved, agent) = store.reference(&id.text(), true)?;
                        let raw = serde_json::value::to_raw_value(&saved).ok()?;
                        Some((id.text(), (V::parse(&raw).ok()?, agent)))
                    })
                })
                .collect();
            threads
                .into_iter()
                .filter_map(|thread| thread.join().ok().flatten())
                .collect::<Vec<_>>()
        });
        result.terminals.extend(rows);
    }
    if configure
        && input["target"].is_string()
        && input["target"].truthy()
        && input["autoRecover"] != V::Bool(false)
    {
        result.recovery = Some(
            store
                .recovery_snapshot(&input["target"].text())
                .map_err(|e| e.to_string())
                .and_then(|saved| {
                    let raw = serde_json::value::to_raw_value(&saved).map_err(|e| e.to_string())?;
                    V::parse(&raw).map_err(|e| e.to_string())
                }),
        );
    }
    result
}

pub(super) fn handles(path: &str) -> bool {
    matches!(
        path,
        "/api/board/permissions"
            | "/api/board/review"
            | "/api/board/worker-settings"
            | "/api/board/worker-dispatch"
            | "/api/board/worker-resume"
            | "/api/board/worker-report"
    )
}
fn is(value: &V, choices: &[&str]) -> bool {
    value.is_string() && choices.contains(&value.text().as_str())
}
fn string(value: &V, max: usize, required: bool) -> bool {
    value.is_string() && value.units().len() <= max && (!required || value.trim().truthy())
}
fn default(value: &V, key: &str, fallback: V) -> V {
    if value.has(key) {
        value[key].clone()
    } else {
        fallback
    }
}
fn nullish(value: &V, key: &str, fallback: V) -> V {
    if value[key] != V::Null {
        value[key].clone()
    } else {
        fallback
    }
}
fn merge(target: &mut V, updates: &V) {
    if let V::Object(fields) = updates {
        for (key, value) in fields {
            target[key] = value.clone();
        }
    }
}
fn selected<'a>(board: &'a V, id: &V) -> Result<&'a V> {
    board["supervisors"]
        .array()
        .iter()
        .find(|review| review["id"] == *id)
        .ok_or_else(|| invalid("감독을 찾지 못했습니다."))
}
fn commit_review(board: &mut V, review: V) {
    let index = board["supervisors"]
        .array()
        .iter()
        .position(|saved| saved["id"] == review["id"])
        .unwrap();
    board["supervisors"].array_mut()[index] = review;
    board["review"] = board["supervisors"].array()[0].clone();
}
pub(super) fn dispatch_enabled(review: &V, time: f64) -> bool {
    if review["runUntil"].truthy() && review["runUntil"].number() <= time {
        return false;
    }
    review["workerDispatch"] == V::from("running")
        || (!is(&review["workerDispatch"], &["paused", "running"])
            && review["termId"].truthy()
            && !is(&review["status"], &["stopped", "complete"]))
}
fn owners(review: &V, time: f64) -> HashSet<String> {
    let running = review["termId"].truthy() && !is(&review["status"], &["stopped", "complete"]);
    let mut ids = HashSet::new();
    if running {
        ids.insert(review["termId"].text());
    }
    if running || dispatch_enabled(review, time) {
        ids.extend(
            review["watched"]
                .array()
                .iter()
                .map(|worker| worker["termId"].text()),
        );
    }
    ids
}

// Caller holds the shared board file lock. Full snapshot comparison also protects
// scheduler claims whose pendingSince value can remain zero across a stop.
pub(super) fn update_review(
    board: &mut V,
    id: &V,
    updates: &V,
    expected: Option<&V>,
    time: f64,
) -> Result<()> {
    let previous = selected(board, id)?.clone();
    if expected.is_some_and(|value| {
        if matches!(value, V::Object(_)) {
            *value != previous
        } else {
            *value != previous["pendingSince"]
        }
    }) {
        return Err(Error(
            409,
            "The board review request changed; read the board again".into(),
        ));
    }
    let mut review = previous.clone();
    merge(&mut review, updates);
    review["id"] = id.clone();
    if updates.has("termId") && !updates.has("status") {
        review["status"] = if updates["termId"].truthy() {
            "running"
        } else {
            "stopped"
        }
        .into();
    }
    let mut review = board_model::review(&review);
    let assigned = owners(&review, time);
    if board["supervisors"]
        .array()
        .iter()
        .any(|other| other["id"] != *id && !assigned.is_disjoint(&owners(other, time)))
    {
        return Err(invalid(
            "다른 실행 중인 감독에 배정된 AI입니다. 기존 감독을 중지하거나 다른 AI를 선택하세요.",
        ));
    }
    review["workerProgress"] = V::Array(
        review["watched"]
            .array()
            .iter()
            .map(|worker| {
                let previous_worker = previous["watched"]
                    .array()
                    .iter()
                    .find(|saved| saved["termId"] == worker["termId"]);
                let same_objective =
                    previous_worker.is_some_and(|saved| saved["objective"] == worker["objective"]);
                if same_objective {
                    if let Some(saved) = review["workerProgress"].array().iter().find(|saved| {
                        saved["termId"] == worker["termId"] && saved["goal"] == worker["goal"]
                    }) {
                        let mut saved = saved.clone();
                        if saved["run"].truthy()
                            && !worker["paused"].truthy()
                            && previous_worker.is_some_and(|worker| worker["paused"].truthy())
                        {
                            saved["run"]["taskDispatchKey"] = "".into();
                        }
                        return saved;
                    }
                }
                object([
                    ("termId", worker["termId"].clone()),
                    ("goal", worker["goal"].clone()),
                    ("startedAt", time.into()),
                    ("lastProgressAt", 0.0.into()),
                    ("evidence", "".into()),
                    ("evidenceKeys", V::Array(vec![])),
                    ("blocker", "".into()),
                    ("nextAction", "".into()),
                    ("alertedAt", 0.0.into()),
                ])
            })
            .collect(),
    );
    if !dispatch_enabled(&previous, time) && dispatch_enabled(&review, time) {
        for worker in review["workerProgress"].array_mut() {
            if worker["run"].truthy() {
                worker["run"]["taskDispatchKey"] = "".into();
            }
        }
    }
    if is(&previous["status"], &["stopped", "complete"]) && review["status"] == V::from("running") {
        review["lastReviewKey"] = "".into();
    }
    if !dispatch_enabled(&review, time)
        || (previous["termId"] != review["termId"] && review["workerDispatch"] == V::from("linked"))
    {
        for worker in review["workerProgress"].array_mut() {
            if worker["run"].truthy() {
                worker["run"]["token"] = "".into();
                for key in ["resumeRequestedAt", "resumeSentAt", "resumeSubmittedAt"] {
                    worker["run"][key] = 0.0.into();
                }
            }
        }
    }
    commit_review(board, review);
    Ok(())
}

fn settings(worker: &V) -> V {
    object([
        ("objective", worker["objective"].clone()),
        ("goal", worker["goal"].clone()),
        ("priority", worker["priority"].clone()),
        ("paused", worker["paused"].clone()),
    ])
}
fn terminal(store: &Observations, id: &V) -> Option<(V, Option<String>)> {
    if !id.is_string() {
        return None;
    }
    store.terminals.get(&id.text()).cloned()
}
fn active(agent: &Option<String>) -> bool {
    agent.as_ref().is_some_and(|s| !s.is_empty())
}
fn unattended(command: &V) -> bool {
    is(command, &[
        "codex --no-daemon --sandbox=workspace-write --ask-for-approval=never --config=sandbox_workspace_write.network_access=true --config=check_for_update_on_startup=false",
        "codex --no-daemon --dangerously-bypass-approvals-and-sandbox --config=check_for_update_on_startup=false",
        "claude --dangerously-skip-permissions",
    ])
}
fn configure(board: &mut V, id: &V, input: &V, terminals: &Observations, time: f64) -> Result<()> {
    let minutes = nullish(input, "intervalMinutes", 5.0.into());
    if !minutes.is_integer()
        || !(1.0..=1440.0).contains(&minutes.number())
        || !input["target"].is_string()
    {
        return Err(invalid("관리 세션과 확인 간격(1~1440분)을 확인하세요."));
    }
    let found = if input["target"].truthy() {
        let found = terminal(terminals, &input["target"])
            .filter(|(_, agent)| active(agent))
            .ok_or_else(|| invalid("실행 중인 AI 세션을 선택하세요."))?;
        Some(found.0)
    } else {
        None
    };
    let current = selected(board, id)?.clone();
    let paths = nullish(input, "referencePaths", current["referencePaths"].clone());
    if !paths.is_array()
        || paths.array().len() > 30
        || paths.array().iter().any(|path| {
            !string(path, 2000, true) || path.units().iter().any(|c| *c < 32 || *c == 127)
        })
    {
        return Err(invalid(
            "참고 자료는 한 줄에 경로 하나씩, 최대 30개·각 2000자로 입력하세요.",
        ));
    }
    let keep_deadline = found.is_none() && current["workerDispatch"] == V::from("running");
    let hours = if found.is_some() {
        nullish(input, "runHours", current["runHours"].clone())
    } else if keep_deadline {
        current["runHours"].clone()
    } else {
        0.0.into()
    };
    if !hours.is_integer() || !(0.0..=24.0).contains(&hours.number()) {
        return Err(invalid("야간 운영 시간은 0~24시간으로 지정하세요."));
    }
    if input.has("autoRecover") && !matches!(input["autoRecover"], V::Bool(_)) {
        return Err(invalid("자동 복구 설정을 확인하세요."));
    }
    let recover =
        found.is_some() && nullish(input, "autoRecover", current["autoRecover"].clone()).truthy();
    let stall = if found.is_some() {
        nullish(input, "stallMinutes", current["stallMinutes"].clone())
    } else {
        0.0.into()
    };
    if !stall.is_integer()
        || (stall.number() != 0.0 && (!(5.0..=240.0).contains(&stall.number()) || !recover))
    {
        return Err(invalid("보고 기한은 자동 복구를 켠 상태에서 5~240분으로 지정하세요. 0은 강제 재시작 끄기입니다."));
    }
    let recovery = if recover {
        terminals
            .recovery
            .as_ref()
            .ok_or_else(|| invalid("감독 실행 정보를 읽지 못했습니다."))?
            .clone()
            .map_err(invalid)?
    } else {
        current["recoveryTerminal"].clone()
    };
    if let Some(found) = &found {
        if hours.truthy() && (!recover || !stall.truthy() || !unattended(&found["command"])) {
            return Err(invalid(
                "야간 운영에는 자동 복구·보고 기한과 승인 없는 감독이 필요합니다.",
            ));
        }
    }
    let objective = default(input, "objective", current["objective"].clone());
    if !string(&objective, 4000, false) || (input.has("watched") && !input["watched"].is_array()) {
        return Err(invalid("감독 목표와 감시 대상 목록을 확인하세요."));
    }
    let mut watched = current["watched"].clone();
    if input.has("watched") {
        if input["watched"].array().len() > 12 {
            return Err(invalid("감시 대상은 최대 12개입니다."));
        }
        watched = V::Array(vec![]);
        for item in input["watched"].array() {
            let worker = terminal(terminals, &item["target"]).filter(|(_, agent)| active(agent));
            let Some((worker, _)) = worker else {
                return Err(invalid("감시 대상은 실행 중인 서로 다른 AI여야 합니다."));
            };
            if found
                .as_ref()
                .is_some_and(|f| f["termId"] == worker["termId"])
                || watched
                    .array()
                    .iter()
                    .any(|w| w["termId"] == worker["termId"])
                || !string(&item["goal"], 2000, true)
            {
                return Err(invalid("감시 대상은 실행 중인 서로 다른 AI여야 하며, 각각 완료 조건이 필요합니다. 감독 자신은 제외하세요."));
            }
            let mut updated = current["watched"]
                .array()
                .iter()
                .find(|saved| saved["termId"] == worker["termId"])
                .cloned()
                .unwrap_or_else(V::object);
            updated["termId"] = worker["termId"].clone();
            updated["alias"] = worker["alias"].clone();
            updated["goal"] = item["goal"].trim();
            watched.array_mut().push(updated);
        }
    }
    if found.as_ref().is_some_and(|f| {
        watched
            .array()
            .iter()
            .any(|worker| worker["termId"] == f["termId"])
    }) {
        return Err(invalid("감독 세션 자신은 감시 대상이 될 수 없습니다."));
    }
    let updates = object([
        (
            "termId",
            found.as_ref().map_or(V::from(""), |f| f["termId"].clone()),
        ),
        (
            "alias",
            found.as_ref().map_or(V::from(""), |f| f["alias"].clone()),
        ),
        ("intervalMinutes", minutes),
        ("pendingSince", 0.0.into()),
        ("nextDueAt", time.into()),
        ("objective", objective.trim()),
        (
            "referencePaths",
            V::Array(paths.array().iter().map(V::trim).collect()),
        ),
        ("runHours", hours.clone()),
        (
            "runUntil",
            if keep_deadline {
                current["runUntil"].clone()
            } else if hours.truthy() {
                (time + hours.number() * 3_600_000.0).into()
            } else {
                0.0.into()
            },
        ),
        ("watched", watched),
        (
            "status",
            if found.is_some() {
                "running"
            } else {
                "stopped"
            }
            .into(),
        ),
        ("retryAt", 0.0.into()),
        ("attempts", 0.0.into()),
        ("lastError", "".into()),
        (
            "lastReviewedAt",
            if found.is_some() {
                0.0.into()
            } else {
                current["lastReviewedAt"].clone()
            },
        ),
        ("autoRecover", recover.into()),
        ("recoveryTerminal", recovery),
        ("recoveryAttempts", 0.0.into()),
        ("recoveryAfter", 0.0.into()),
        ("stallMinutes", stall),
        ("cycleStartedAt", 0.0.into()),
    ]);
    update_review(board, id, &updates, None, time)
}

fn validate_blocked(blocker: &V, alternatives: &V, remaining: &V) -> Result<()> {
    if !string(blocker, 1000, true)
        || !string(alternatives, 1000, true)
        || !remaining.is_array()
        || remaining.array().is_empty()
        || remaining.array().len() > 30
        || remaining.array().iter().any(|item| {
            ["condition", "blocker", "nextAction"]
                .iter()
                .any(|key| !string(&item[key], 1000, true))
        })
    {
        return Err(invalid("전체 대기에는 blocker, alternatives와 모든 남은 조건별 remaining[{condition,blocker,nextAction}]이 필요합니다. 가능한 조건은 계속 실행하세요."));
    }
    Ok(())
}
fn hash(value: &V) -> V {
    format!("{:x}", Sha256::digest(value.raw().get().as_bytes())).into()
}
fn artifact_key(artifact: &V, version: &V) -> V {
    hash(&V::Array(vec![artifact.clone(), version.clone()]))
}
fn evidence(artifact: &V, version: &V, result: &V) -> V {
    let mut units = artifact.units().to_vec();
    units.push(10);
    units.extend(version.units());
    units.push(10);
    units.extend(result.units());
    V::String(units).cut(2400)
}
pub(super) fn dependency(board: &V, review: &V, term_id: &V) -> V {
    dependency_key(board, review, term_id, false)
}
pub(super) fn legacy_dependency(board: &V, review: &V, term_id: &V) -> V {
    dependency_key(board, review, term_id, true)
}
fn dependency_key(board: &V, review: &V, term_id: &V, legacy: bool) -> V {
    let tasks = board["tasks"]
        .array()
        .iter()
        .filter(|task| {
            board["checklists"].array().iter().any(|list| {
                list["id"] == task["checklistId"] && list["supervisorId"] == review["id"]
            })
        })
        .map(|task| {
            let mut row = vec![
                task["id"].clone(),
                task["answer"].clone(),
                task["done"].clone(),
                if task["kind"] == V::from("question") && !legacy {
                    "".into()
                } else {
                    task["text"].clone()
                },
            ];
            if legacy {
                row.extend([
                    if task["status"].truthy() {
                        task["status"].clone()
                    } else {
                        "".into()
                    },
                    if task["waitKey"].truthy() {
                        task["waitKey"].clone()
                    } else {
                        "".into()
                    },
                ]);
            }
            V::Array(row)
        })
        .collect();
    let peers = review["workerProgress"]
        .array()
        .iter()
        .filter(|worker| worker["termId"] != *term_id)
        .map(|worker| {
            V::Array(vec![
                worker["termId"].clone(),
                worker["evidence"].clone(),
                if worker["run"]["evidence"].truthy() {
                    worker["run"]["evidence"].clone()
                } else {
                    "".into()
                },
            ])
        })
        .collect();
    hash(&V::Array(vec![
        V::Array(tasks),
        V::Array(peers),
        review["referencePaths"].clone(),
    ]))
}

#[cfg(test)]
mod dependency_tests {
    use super::*;

    #[test]
    fn source_text_and_reference_updates_wake_workers_but_timestamps_do_not() {
        let mut board = object([
            (
                "checklists",
                V::Array(vec![object([
                    ("id", "C-1".into()),
                    ("supervisorId", "S-0001".into()),
                ])]),
            ),
            (
                "tasks",
                V::Array(vec![object([
                    ("id", "T-1".into()),
                    ("checklistId", "C-1".into()),
                    ("text", "source needed".into()),
                    ("answer", "".into()),
                    ("done", false.into()),
                ])]),
            ),
        ]);
        let mut review = object([
            ("id", "S-0001".into()),
            ("referencePaths", V::Array(vec![])),
            ("workerProgress", V::Array(vec![])),
        ]);
        let term_id = V::from("worker");
        let before = dependency(&board, &review, &term_id);
        board["tasks"].array_mut()[0]["updatedAt"] = 123.0.into();
        assert_eq!(dependency(&board, &review, &term_id), before);
        board["tasks"].array_mut()[0]["text"] = "FILE /results/source.js SHA source-A".into();
        let source = dependency(&board, &review, &term_id);
        assert_ne!(source, before);
        review["referencePaths"] = V::Array(vec!["/results/source-B.js".into()]);
        assert_ne!(dependency(&board, &review, &term_id), source);
    }
}

fn report_worker(board: &mut V, id: &V, input: &V, time: f64) -> Result<()> {
    let status = &input["status"];
    let summary = &input["summary"];
    let blocker = default(input, "blocker", "".into());
    let alternatives = default(input, "alternatives", "".into());
    let remaining = default(input, "remaining", V::Array(vec![]));
    if !is(status, &["working", "blocked", "complete"])
        || !string(summary, 2000, true)
        || !string(&blocker, 1000, false)
        || !string(&alternatives, 1000, false)
        || (*status == V::from("blocked")
            && (!blocker.trim().truthy() || !alternatives.trim().truthy()))
    {
        return Err(invalid("작업자 보고에는 상태와 근거가 필요하며, blocked에는 원인과 독립 대안 검토 결과가 필요합니다."));
    }
    if *status == V::from("blocked") {
        validate_blocked(&blocker, &alternatives, &remaining)?;
    }
    let artifact = default(input, "artifact", "".into());
    let version = default(input, "version", "".into());
    let result = default(input, "result", "".into());
    if [
        &artifact,
        &version,
        &result,
        &nullish(input, "nextAction", "".into()),
    ]
    .iter()
    .any(|v| !string(v, 1000, false))
        || ([&artifact, &version, &result]
            .iter()
            .any(|v| v.trim().truthy())
            && ![&artifact, &version, &result]
                .iter()
                .all(|v| v.trim().truthy()))
    {
        return Err(invalid("진전 근거는 artifact, version, result를 함께 기록하세요. 근거와 nextAction은 각각 1000자 이하입니다."));
    }
    // A present null nextAction cannot be trimmed; reject it before touching disk.
    if input.has("nextAction") && !input["nextAction"].is_string() {
        return Err(invalid("nextAction must be a string"));
    }
    let mut review = selected(board, id)?.clone();
    let index = review["workerProgress"]
        .array()
        .iter()
        .position(|worker| worker["termId"] == input["termId"]);
    if !dispatch_enabled(&review, time)
        || !input["token"].truthy()
        || index.is_none()
        || review["workerProgress"].array()[index.unwrap()]["run"]["token"] != input["token"]
        || !review["watched"].array().iter().any(|worker| {
            worker["termId"] == input["termId"]
                && worker["goal"] == review["workerProgress"].array()[index.unwrap()]["goal"]
        })
    {
        return Err(Error(
            409,
            "현재 작업자 요청이 아닙니다. 보드를 다시 조회하세요.".into(),
        ));
    }
    crate::board_task_state::validate_worker(board, &input["termId"], status)
        .map_err(|message| invalid(&message))?;
    let key = dependency(board, &review, &input["termId"]);
    let worker = &mut review["workerProgress"].array_mut()[index.unwrap()];
    let run = &mut worker["run"];
    run["status"] = match status.text().as_str() {
        "complete" => "reported",
        "working" => "active",
        _ => "blocked",
    }
    .into();
    run["summary"] = summary.trim();
    run["blocker"] = blocker.trim();
    run["alternatives"] = alternatives.trim();
    run["remaining"] = if *status == V::from("blocked") {
        board_model::remaining(&remaining)
    } else {
        V::Array(vec![])
    };
    if input.has("nextAction") {
        run["nextAction"] = input["nextAction"].trim();
    }
    run["reportedAt"] = time.into();
    run["attempts"] = 0.0.into();
    run["blockedVerifiedAt"] = 0.0.into();
    run["dependencyKey"] = key;
    if artifact.trim().truthy() {
        let key = artifact_key(&artifact.trim(), &version.trim());
        if !run["evidenceKeys"].array().contains(&key) {
            run["evidenceKeys"].array_mut().push(key);
            run["progressAt"] = time.into();
            run["evidence"] = evidence(&artifact.trim(), &version.trim(), &result.trim());
            run["lastError"] = "".into();
        }
    }
    review["nextDueAt"] = time.into();
    commit_review(board, review);
    Ok(())
}
fn report_review(board: &mut V, id: &V, input: &V, time: f64) -> Result<()> {
    let status = default(input, "status", "running".into());
    let report = default(input, "report", "".into());
    let progress = default(input, "progress", V::Array(vec![]));
    if !is(&status, &["running", "waiting", "complete"]) || !string(&report, 4000, false) {
        return Err(invalid("점검 상태와 보고 내용(4000자 이하)을 확인하세요."));
    }
    let mut review = selected(board, id)?.clone();
    if !input["pendingSince"].truthy()
        || input["pendingSince"] != review["pendingSince"]
        || !review["termId"].truthy()
    {
        return Err(Error(
            409,
            "현재 점검 요청이 아닙니다. 보드를 다시 조회하세요.".into(),
        ));
    }
    if (!review["watched"].array().is_empty() || status == V::from("complete"))
        && !report.trim().truthy()
    {
        return Err(invalid("점검 결과와 완료 판단의 근거를 기록하세요."));
    }
    if !progress.is_array() || progress.array().len() > 12 {
        return Err(invalid("대상별 진전 기록은 최대 12개입니다."));
    }
    let mut seen = HashSet::new();
    for item in progress.array() {
        let index = review["workerProgress"]
            .array()
            .iter()
            .position(|worker| worker["termId"] == item["termId"]);
        if index.is_none()
            || !seen.insert(item["termId"].text())
            || ["artifact", "version", "result", "blocker", "nextAction"]
                .iter()
                .any(|key| item.has(key) && !string(&item[key], 1000, false))
        {
            return Err(invalid(
                "진전 기록의 대상과 근거·원인·다음 조치(각 1000자 이하)를 확인하세요.",
            ));
        }
        let artifact = default(item, "artifact", "".into()).trim();
        let version = default(item, "version", "".into()).trim();
        let result = default(item, "result", "".into()).trim();
        let state = &item["workState"];
        if item.has("workState") && !is(state, &["ready", "blocked", "complete"]) {
            return Err(invalid(
                "작업자 상태는 ready, blocked, complete 중 하나입니다.",
            ));
        }
        let has_evidence = artifact.truthy() && version.truthy() && result.truthy();
        if *state == V::from("complete") && !has_evidence {
            return Err(invalid(
                "작업자 완료 확정에는 검증한 결과물과 버전, 결과가 필요합니다.",
            ));
        }
        if *state == V::from("blocked") {
            validate_blocked(&item["blocker"], &item["alternatives"], &item["remaining"])?;
        }
        if *state == V::from("blocked") || *state == V::from("complete") {
            crate::board_task_state::validate_worker(board, &item["termId"], state)
                .map_err(|message| invalid(&message))?;
        }
        if (artifact.truthy() || version.truthy() || result.truthy()) && !has_evidence {
            return Err(invalid(
                "새 결과 근거에는 artifact, version, result가 모두 필요합니다.",
            ));
        }
        let worker = &mut review["workerProgress"].array_mut()[index.unwrap()];
        if artifact.truthy() {
            let key = artifact_key(&artifact, &version);
            if !worker["evidenceKeys"].array().contains(&key) {
                worker["evidenceKeys"].array_mut().push(key);
                worker["lastProgressAt"] = time.into();
                worker["alertedAt"] = 0.0.into();
                worker["evidence"] = evidence(&artifact, &version, &result);
            }
        }
        worker["blocker"] = default(item, "blocker", "".into()).trim();
        if item.has("nextAction") {
            worker["nextAction"] = item["nextAction"].trim();
        }
        if state.truthy() {
            let run = &mut worker["run"];
            run["status"] = state.clone();
            if *state != V::from("ready") {
                run["token"] = "".into();
            }
            if *state == V::from("blocked") {
                run["blocker"] = item["blocker"].clone();
                run["alternatives"] = item["alternatives"].clone();
                run["remaining"] = board_model::remaining(&item["remaining"]);
                run["reportedAt"] = time.into();
                run["blockedVerifiedAt"] = time.into();
            } else if *state == V::from("ready") {
                run["blocker"] = "".into();
                run["alternatives"] = "".into();
                run["remaining"] = V::Array(vec![]);
            }
            let key = dependency(board, &review, &item["termId"]);
            review["workerProgress"].array_mut()[index.unwrap()]["run"]["dependencyKey"] = key;
        }
    }
    if status == V::from("complete") {
        for worker in review["watched"].array() {
            crate::board_task_state::validate_worker(board, &worker["termId"], &status)
                .map_err(|message| invalid(&message))?;
        }
    }
    if status == V::from("complete")
        && review["watched"].array().iter().any(|worker| {
            !progress.array().iter().any(|item| {
                item["termId"] == worker["termId"]
                    && ["artifact", "version", "result"]
                        .iter()
                        .all(|key| item[key].trim().truthy())
            })
        })
    {
        return Err(invalid(
            "완료 보고에는 모든 대상의 결과물과 검증 근거를 포함하세요.",
        ));
    }
    if report.trim().truthy() {
        review["reports"].array_mut().push(object([
            ("at", time.into()),
            ("status", status.clone()),
            ("text", report.trim()),
        ]));
    }
    review["status"] = status;
    for key in [
        "pendingSince",
        "retryAt",
        "attempts",
        "recoveryAttempts",
        "recoveryAfter",
        "cycleStartedAt",
    ] {
        review[key] = 0.0.into();
    }
    review["lastError"] = "".into();
    review["lastReviewedAt"] = time.into();
    review["nextDueAt"] = (time + review["intervalMinutes"].number() * 60_000.0).into();
    commit_review(board, review);
    crate::board_task_state::refresh(board);
    let mut review = selected(board, id)?.clone();
    review["lastReviewKey"] =
        crate::board_task_state::review_key(&super::scoped(board, id)?, &review);
    commit_review(board, review);
    Ok(())
}

pub(super) fn apply(
    board: &mut V,
    method: &Method,
    path: &str,
    input: &V,
    terminals: &Observations,
    time: f64,
) -> Result<Option<V>> {
    let reporting = method == Method::POST;
    let id = if reporting {
        default(input, "supervisorId", "S-0001".into())
    } else if input["supervisorId"].truthy() {
        input["supervisorId"].clone()
    } else {
        "S-0001".into()
    };
    match path {
        "/api/board/permissions" => {
            if !is(
                &input["codex"],
                &["default", "workspace", "network", "full"],
            ) || !is(&input["claude"], &["default", "edits", "auto", "full"])
            {
                return Err(invalid("지원하는 Codex·Claude 권한 모드를 선택하세요."));
            }
            update_review(
                board,
                &V::from("S-0001"),
                &object([(
                    "launchPermissions",
                    object([
                        ("codex", input["codex"].clone()),
                        ("claude", input["claude"].clone()),
                    ]),
                )]),
                None,
                time,
            )?;
        }
        "/api/board/review" if *method == Method::PUT => {
            configure(board, &id, input, terminals, time)?
        }
        "/api/board/review" => {
            // The HTTP route validates the pending claim before report fields.
            let review = selected(board, &id)?;
            if !input["pendingSince"].truthy() || input["pendingSince"] != review["pendingSince"] {
                return Err(Error(
                    409,
                    "현재 확인 요청의 번호가 아닙니다. 보드를 다시 조회하세요.".into(),
                ));
            }
            report_review(board, &id, input, time)?;
        }
        "/api/board/worker-settings" => {
            let review = selected(board, &id)?.clone();
            let current = review["watched"]
                .array()
                .iter()
                .find(|worker| worker["termId"] == input["termId"]);
            let expected = current.map(settings).unwrap_or(V::Null);
            if !input.has("expected") || expected != input["expected"] {
                return Err(Error(409, "다른 곳에서 목표나 우선순위를 변경했습니다. 입력은 유지했습니다. 최신 설정을 불러온 뒤 다시 저장하세요.".into()));
            }
            let value = &input["settings"];
            if !string(&value["goal"], 2000, true)
                || !string(&value["objective"], 2000, false)
                || ![V::Number(1.0), V::Number(2.0), V::Number(3.0)].contains(&value["priority"])
                || !matches!(value["paused"], V::Bool(_))
            {
                return Err(invalid(
                    "목표·완료 조건은 각각 2000자 이하, 우선순위와 일시정지를 확인하세요.",
                ));
            }
            let found = terminal(terminals, &input["termId"]);
            let Some((found, agent)) = found else {
                return Err(invalid("실행 중인 작업 세션을 선택하세요."));
            };
            if found["termId"] != input["termId"]
                || (current.is_none() && !active(&agent))
                || found["termId"] == review["termId"]
                || (current.is_none() && review["watched"].array().len() >= 12)
            {
                return Err(invalid("실행 중인 작업 세션을 선택하세요. 감독 자신은 배정할 수 없고 작업자는 최대 12개입니다."));
            }
            let mut updated = current.cloned().unwrap_or_else(V::object);
            merge(&mut updated, &settings(value));
            updated["termId"] = found["termId"].clone();
            updated["alias"] = found["alias"].clone();
            updated["goal"] = value["goal"].trim();
            updated["objective"] = value["objective"].trim();
            let mut watched = review["watched"].clone();
            if let Some(index) = watched
                .array()
                .iter()
                .position(|w| w["termId"] == found["termId"])
            {
                watched.array_mut()[index] = updated;
            } else {
                watched.array_mut().push(updated);
            }
            update_review(
                board,
                &id,
                &object([
                    ("watched", watched),
                    ("nextDueAt", time.into()),
                    ("retryAt", 0.0.into()),
                    ("pendingSince", 0.0.into()),
                    ("cycleStartedAt", 0.0.into()),
                ]),
                Some(&review),
                time,
            )?;
        }
        "/api/board/worker-dispatch" => {
            let review = selected(board, &id)?.clone();
            if !is(&input["mode"], &["linked", "running", "paused"]) {
                return Err(invalid("자동 진행 모드를 확인하세요."));
            }
            if input["expected"] != review["workerDispatch"] {
                return Err(Error(
                    409,
                    "자동 진행 설정이 바뀌었습니다. 최신 상태를 확인하세요.".into(),
                ));
            }
            if input["mode"] == V::from("running")
                && (review["watched"].array().is_empty()
                    || (review["runUntil"].truthy() && review["runUntil"].number() <= time))
            {
                return Err(invalid("배정된 작업자와 운영 종료 시각을 확인하세요."));
            }
            update_review(
                board,
                &id,
                &object([("workerDispatch", input["mode"].clone())]),
                Some(&review),
                time,
            )?;
        }
        "/api/board/worker-resume" => {
            let mut review = selected(board, &id)?.clone();
            let index = review["workerProgress"]
                .array()
                .iter()
                .position(|worker| worker["termId"] == input["termId"]);
            if index.is_none() || !dispatch_enabled(&review, time) {
                return Err(Error(
                    409,
                    "자동 진행이 켜진 작업자만 재개할 수 있습니다.".into(),
                ));
            }
            let run = &mut review["workerProgress"].array_mut()[index.unwrap()]["run"];
            run["resumeRequestedAt"] = time.into();
            run["resumeSentAt"] = 0.0.into();
            run["resumeSubmittedAt"] = 0.0.into();
            run["lastError"] = "".into();
            review["nextDueAt"] = time.into();
            commit_review(board, review);
        }
        "/api/board/worker-report" => report_worker(board, &id, input, time)?,
        _ => return Err(Error(501, "Board control migration is not complete".into())),
    }
    Ok(if path == "/api/board/permissions" {
        Some(V::from("S-0001"))
    } else if reporting {
        Some(id)
    } else {
        None
    })
}
