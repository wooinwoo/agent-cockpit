use crate::board_value::{object, V};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub fn status(task: &V) -> &'static str {
    if task["done"].truthy() {
        "done"
    } else if task["status"] == V::from("running") {
        "running"
    } else if task["status"] == V::from("blocked") {
        "blocked"
    } else {
        "ready"
    }
}

fn wait_key(board: &V, ids: &V) -> V {
    dependency_wait_key(board, ids, false)
}

fn dependency_wait_key(board: &V, ids: &V, legacy: bool) -> V {
    let rows = ids
        .array()
        .iter()
        .map(|id| {
            let Some(task) = board["tasks"].array().iter().find(|task| task["id"] == *id) else {
                return V::Array(vec![id.clone(), V::Null]);
            };
            let reviews: Vec<_> = if board["supervisors"].array().is_empty() {
                vec![&board["review"]]
            } else {
                board["supervisors"].array().iter().collect()
            };
            let fallback = |v: &V| if v.truthy() { v.clone() } else { V::from("") };
            let producers = reviews
                .iter()
                .filter(|review| {
                    ![V::from("stopped"), V::from("complete")].contains(&review["status"])
                        || review["workerDispatch"] == V::from("running")
                })
                .flat_map(|review| {
                    review["workerProgress"]
                        .array()
                        .iter()
                        .filter(|worker| {
                            task["termId"].truthy()
                                && worker["termId"] == task["termId"]
                                && review["watched"].array().iter().any(|assigned| {
                                    assigned["termId"] == worker["termId"]
                                        && assigned["goal"] == worker["goal"]
                                })
                        })
                        .map(|worker| {
                            V::Array(vec![
                                review["id"].clone(),
                                fallback(&worker["evidence"]),
                                fallback(&worker["run"]["evidence"]),
                            ])
                        })
                })
                .collect();
            V::Array(vec![
                id.clone(),
                task["done"].clone(),
                fallback(&task["answer"]),
                if task["kind"] == V::from("question") && !legacy {
                    "".into()
                } else {
                    task["text"].clone()
                },
                V::Array(producers),
            ])
        })
        .collect();
    format!(
        "{:x}",
        Sha256::digest(V::Array(rows).raw().get().as_bytes())
    )
    .into()
}

fn hash(value: V) -> V {
    format!("{:x}", Sha256::digest(value.raw().get().as_bytes())).into()
}

pub fn dispatch_key(
    board: &V,
    review: &V,
    assigned: &V,
    worker: &V,
    task: Option<&V>,
    dependencies: &V,
) -> V {
    hash(V::Array(vec![
        worker["goal"].clone(),
        assigned["objective"].clone(),
        assigned["priority"].number().to_string().into(),
        review["referencePaths"].clone(),
        worker["nextAction"].clone(),
        task.map(|t| {
            V::Array(vec![
                t["id"].clone(),
                t["text"].clone(),
                t["activation"].number().to_string().into(),
                wait_key(board, &t["waitFor"]),
            ])
        })
        .unwrap_or(dependencies.clone()),
    ]))
}

pub fn review_key(board: &V, review: &V) -> V {
    review_input_key(board, review, false)
}

pub fn legacy_review_key(board: &V, review: &V) -> V {
    review_input_key(board, review, true)
}

fn review_input_key(board: &V, review: &V, legacy: bool) -> V {
    let fallback = |v: &V| if v.truthy() { v.clone() } else { V::from("") };
    hash(V::Array(vec![
        review["objective"].clone(),
        review["referencePaths"].clone(),
        V::Array(
            review["watched"]
                .array()
                .iter()
                .map(|w| {
                    V::Array(vec![
                        w["termId"].clone(),
                        w["goal"].clone(),
                        w["objective"].clone(),
                        w["priority"].number().to_string().into(),
                        w["paused"].clone(),
                    ])
                })
                .collect(),
        ),
        V::Array(
            board["checklists"]
                .array()
                .iter()
                .map(|l| V::Array(vec![l["id"].clone(), l["goal"].clone()]))
                .collect(),
        ),
        V::Array(
            board["tasks"]
                .array()
                .iter()
                .map(|t| {
                    let mut row = vec![
                        t["id"].clone(),
                        if t["kind"] == V::from("question") && !legacy {
                            "".into()
                        } else {
                            t["text"].clone()
                        },
                        t["done"].clone(),
                        fallback(&t["answer"]),
                    ];
                    if legacy {
                        row.extend([fallback(&t["status"]), fallback(&t["blocker"])]);
                    } else {
                        row.push((status(t) == "blocked").into());
                    }
                    row.push(if t["waitFor"].is_array() {
                        t["waitFor"].clone()
                    } else {
                        V::Array(vec![])
                    });
                    V::Array(row)
                })
                .collect(),
        ),
        V::Array(
            review["workerProgress"]
                .array()
                .iter()
                .map(|w| {
                    let mut row = vec![
                        w["termId"].clone(),
                        w["goal"].clone(),
                        w["evidence"].clone(),
                        w["run"]["evidence"].clone(),
                    ];
                    if legacy {
                        row.extend([
                            w["run"]["status"].clone(),
                            w["run"]["blocker"].clone(),
                            V::Array(
                                w["run"]["remaining"]
                                    .array()
                                    .iter()
                                    .map(|r| {
                                        V::Array(vec![
                                            r["condition"].clone(),
                                            r["blocker"].clone(),
                                            r["nextAction"].clone(),
                                        ])
                                    })
                                    .collect(),
                            ),
                        ]);
                    } else {
                        row.push(
                            (pending(board, &w["termId"]).is_empty()
                                && w["run"]["status"] == V::from("blocked"))
                            .into(),
                        );
                    }
                    row.push(w["run"]["interventionAt"].number().to_string().into());
                    V::Array(row)
                })
                .collect(),
        ),
    ]))
}

pub fn refresh(board: &mut V) {
    let mut tasks = board["tasks"].clone();
    for task in tasks.array_mut() {
        if !task["termId"].truthy()
            || task["kind"] == V::from("question")
            || status(task) != "blocked"
        {
            continue;
        }
        let ids = task["waitFor"].clone();
        let key = wait_key(board, &ids);
        // Upgrade an unchanged legacy dependency without waking work on deployment.
        if task["waitKey"] != key && task["waitKey"] == dependency_wait_key(board, &ids, true) {
            task["waitKey"] = key.clone();
        }
        if ids.array().is_empty()
            || !task["blocker"].trim().truthy()
            || task["waitKey"] != key
            || ids
                .array()
                .iter()
                .any(|id| !board["tasks"].array().iter().any(|t| t["id"] == *id))
            || ids
                .array()
                .iter()
                .any(|id| reaches(board, id, &task["id"], &mut HashSet::new()))
            || ids.array().iter().all(|id| {
                board["tasks"]
                    .array()
                    .iter()
                    .find(|t| t["id"] == *id)
                    .is_some_and(|t| t["done"].truthy())
            })
        {
            task["status"] = "ready".into();
        }
    }
    board["tasks"] = tasks;
}

pub fn pending(board: &V, term_id: &V) -> Vec<V> {
    board["tasks"]
        .array()
        .iter()
        .filter(|task| {
            task["termId"] == *term_id
                && task["kind"] != V::from("question")
                && !task["done"].truthy()
        })
        .cloned()
        .collect()
}
pub fn next(board: &V, term_id: &V) -> Option<V> {
    let tasks = pending(board, term_id);
    tasks
        .iter()
        .find(|task| status(task) == "running")
        .or_else(|| tasks.iter().find(|task| status(task) == "ready"))
        .cloned()
}
pub fn validate_worker(board: &V, term_id: &V, state: &V) -> Result<(), String> {
    let tasks = pending(board, term_id);
    if *state == V::from("complete") && !tasks.is_empty() {
        return Err(format!(
            "미완료 체크리스트가 남아 있습니다: {}. 검증 후 체크하세요.",
            tasks
                .iter()
                .map(|t| t["id"].text())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if *state == V::from("blocked") {
        if let Some(task) = next(board, term_id) {
            return Err(format!("실행 가능한 체크리스트가 남아 있습니다: {} {}. 전체 대기 대신 이 작업을 진행하세요.", task["id"].text(), task["text"].text()));
        }
    }
    Ok(())
}

fn reaches(board: &V, id: &V, target: &V, seen: &mut HashSet<String>) -> bool {
    if id == target {
        return true;
    }
    if !seen.insert(id.text()) {
        return false;
    }
    board["tasks"]
        .array()
        .iter()
        .find(|t| t["id"] == *id)
        .is_some_and(|task| {
            task["kind"] != V::from("question")
                && status(task) == "blocked"
                && task["waitFor"]
                    .array()
                    .iter()
                    .any(|next| reaches(board, next, target, seen))
        })
}

pub fn apply(board: &V, task: &V, input: &V) -> Result<V, String> {
    if !["status", "done", "blocker", "waitFor"]
        .iter()
        .any(|key| input.has(key))
    {
        return Ok(V::object());
    }
    if !task["termId"].truthy() || task["kind"] == V::from("question") {
        if ["status", "blocker", "waitFor"]
            .iter()
            .any(|key| input.has(key))
        {
            return Err("작업 상태는 세션 체크리스트에서만 변경할 수 있습니다.".into());
        }
        return Ok(V::object());
    }
    let state = if input.has("status") {
        input["status"].clone()
    } else if input.has("done") {
        if input["done"] == V::Bool(true) {
            "done".into()
        } else {
            "ready".into()
        }
    } else {
        status(task).into()
    };
    if !["ready", "running", "blocked", "done"]
        .iter()
        .any(|s| state == V::from(*s))
    {
        return Err("작업 상태는 ready, running, blocked, done 중 하나입니다.".into());
    }
    if input.has("status")
        && input.has("done")
        && (input["done"] == V::Bool(true)) != (state == V::from("done"))
    {
        return Err("작업 상태와 완료 체크가 일치하지 않습니다.".into());
    }
    if state != V::from("blocked") {
        return Ok(object([
            ("status", state.clone()),
            ("done", (state == V::from("done")).into()),
            ("blocker", "".into()),
            ("waitFor", V::Array(vec![])),
            ("waitKey", "".into()),
            (
                "activation",
                (task["activation"].number()
                    + if state == V::from("ready") && status(task) != "ready" {
                        1.0
                    } else {
                        0.0
                    })
                .into(),
            ),
        ]));
    }
    let blocker = if input.has("blocker") {
        &input["blocker"]
    } else {
        &task["blocker"]
    };
    let ids = if input.has("waitFor") {
        &input["waitFor"]
    } else {
        &task["waitFor"]
    };
    let unique: HashSet<_> = ids.array().iter().map(V::text).collect();
    if !blocker.is_string()
        || !blocker.trim().truthy()
        || blocker.units().len() > 1000
        || !ids.is_array()
        || ids.array().is_empty()
        || ids.array().len() > 10
        || unique.len() != ids.array().len()
        || ids.array().iter().any(|id| {
            !id.is_string()
                || !id
                    .text()
                    .strip_prefix("T-")
                    .is_some_and(|s| s.len() >= 4 && s.bytes().all(|b| b.is_ascii_digit()))
                || *id == task["id"]
                || !board["tasks"].array().iter().any(|t| t["id"] == *id)
        })
    {
        return Err("막힘에는 이유와 실제 대기 항목 ID(waitFor, 최대 10개)가 필요합니다.".into());
    }
    if ids.array().iter().all(|id| {
        board["tasks"]
            .array()
            .iter()
            .find(|t| t["id"] == *id)
            .unwrap()["done"]
            .truthy()
    }) {
        return Err(
            "대기 항목이 이미 완료됐습니다. 결과를 확인하고 실행 가능한 상태로 바꾸세요.".into(),
        );
    }
    if ids
        .array()
        .iter()
        .any(|id| reaches(board, id, &task["id"], &mut HashSet::new()))
    {
        return Err("작업 대기 조건이 순환합니다. 먼저 실행할 작업을 정하세요.".into());
    }
    Ok(object([
        ("status", state),
        ("done", false.into()),
        ("blocker", blocker.trim()),
        ("waitFor", ids.clone()),
        ("waitKey", wait_key(board, ids)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn value(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    fn board() -> V {
        crate::board_model::normalize(
            &value(
                r#"{"review":{"workerDispatch":"running","watched":[{"termId":"worker","goal":"검증"}],"workerProgress":[{"termId":"worker","goal":"검증"}]},"tasks":[{"id":"T-0001","termId":"worker","text":"구현","done":false},{"id":"T-0002","kind":"question","text":"원전 위치","done":false}]}"#,
            ),
            1.0,
        )
    }
    fn patch(board: &mut V, index: usize, input: V) {
        let fields = apply(board, &board["tasks"].array()[index], &input).unwrap();
        if let V::Object(fields) = fields {
            for (key, value) in fields {
                board["tasks"].array_mut()[index][&key] = value;
            }
        }
        refresh(board);
    }
    #[test]
    fn pending_queue_rejects_waiting_completion_and_bad_dependencies() {
        let mut b = board();
        assert!(validate_worker(&b, &"worker".into(), &"blocked".into()).is_err());
        assert!(validate_worker(&b, &"worker".into(), &"complete".into()).is_err());
        assert!(apply(
            &b,
            &b["tasks"].array()[0],
            &value(r#"{"status":"blocked","blocker":"원전","waitFor":["T-9999"]}"#)
        )
        .is_err());
        assert!(apply(
            &b,
            &b["tasks"].array()[0],
            &value(r#"{"status":"blocked","blocker":"원전","waitFor":["T-0001"]}"#)
        )
        .is_err());
        patch(
            &mut b,
            0,
            value(r#"{"status":"blocked","blocker":"원전","waitFor":["T-0002"]}"#),
        );
        assert!(validate_worker(&b, &"worker".into(), &"blocked".into()).is_ok());
        b["tasks"].array_mut()[1]["answer"] = "새 경로".into();
        refresh(&mut b);
        assert_eq!(status(&b["tasks"].array()[0]), "ready");
        assert!(validate_worker(&b, &"worker".into(), &"blocked".into()).is_err());
    }
    #[test]
    fn question_wording_does_not_release_a_wait_or_change_review_identity() {
        let mut b = board();
        patch(
            &mut b,
            0,
            value(r#"{"status":"blocked","blocker":"원전","waitFor":["T-0002"]}"#),
        );
        let reviewed = review_key(&b, &b["review"]);
        b["tasks"].array_mut()[1]["text"] = "원전 위치를 답변해 주세요".into();
        refresh(&mut b);
        assert_eq!(status(&b["tasks"].array()[0]), "blocked");
        assert_eq!(review_key(&b, &b["review"]), reviewed);
        b["tasks"].array_mut()[1]["answer"] = "새 원전".into();
        refresh(&mut b);
        assert_eq!(status(&b["tasks"].array()[0]), "ready");
        assert_ne!(review_key(&b, &b["review"]), reviewed);
    }
    #[test]
    fn legacy_wait_hash_migrates_without_unblocking() {
        let mut b = board();
        patch(
            &mut b,
            0,
            value(r#"{"status":"blocked","blocker":"원전","waitFor":["T-0002"]}"#),
        );
        let question = &b["tasks"].array()[1];
        let legacy = hash(V::Array(vec![V::Array(vec![
            question["id"].clone(),
            question["done"].clone(),
            "".into(),
            question["text"].clone(),
            V::Array(vec![]),
        ])]));
        b["tasks"].array_mut()[0]["waitKey"] = legacy.clone();
        refresh(&mut b);
        assert_eq!(status(&b["tasks"].array()[0]), "blocked");
        assert_ne!(b["tasks"].array()[0]["waitKey"], legacy);
        b["tasks"].array_mut()[1]["text"] = "문구만 변경".into();
        refresh(&mut b);
        assert_eq!(status(&b["tasks"].array()[0]), "blocked");
    }
    #[test]
    fn review_identity_ignores_routine_statuses_but_tracks_new_blockers_and_evidence() {
        let mut b = board();
        let initial = review_key(&b, &b["review"]);
        patch(&mut b, 0, value(r#"{"status":"running"}"#));
        let run = &mut b["review"]["workerProgress"].array_mut()[0]["run"];
        run["status"] = "active".into();
        run["blocker"] = "표현 정리".into();
        run["remaining"] =
            value(r#"[{"condition":"검증","blocker":"표현 정리","nextAction":"계속"}]"#);
        assert_eq!(review_key(&b, &b["review"]), initial);
        patch(
            &mut b,
            0,
            value(r#"{"status":"blocked","blocker":"원전","waitFor":["T-0002"]}"#),
        );
        assert_ne!(review_key(&b, &b["review"]), initial);
        let blocked = review_key(&b, &b["review"]);
        b["review"]["workerProgress"].array_mut()[0]["run"]["evidence"] = "새 산출물".into();
        assert_ne!(review_key(&b, &b["review"]), blocked);
    }
    #[test]
    fn dispatch_identity_ignores_acknowledgements_but_tracks_reopen_and_new_inputs() {
        let mut b = board();
        let key = |b: &V| {
            dispatch_key(
                b,
                &b["review"],
                &b["review"]["watched"].array()[0],
                &b["review"]["workerProgress"].array()[0],
                Some(&b["tasks"].array()[0]),
                &"legacy".into(),
            )
        };
        let initial = key(&b);
        assert_eq!(
            initial,
            V::from("5455de9b16502e1f2ca8f0ef98e85842386f0c9d18aae04adf47184e8e213526"),
            "Node JSON identity including numeric priority and activation"
        );
        patch(&mut b, 0, value(r#"{"status":"running"}"#));
        assert_eq!(key(&b), initial);
        patch(&mut b, 0, value(r#"{"done":true}"#));
        patch(&mut b, 0, value(r#"{"done":false}"#));
        assert_ne!(key(&b), initial);
        patch(
            &mut b,
            0,
            value(r#"{"status":"blocked","blocker":"원전","waitFor":["T-0002"]}"#),
        );
        let waiting = key(&b);
        b["tasks"].array_mut()[1]["answer"] = "새 경로".into();
        refresh(&mut b);
        assert_ne!(key(&b), waiting);
        let reviewed = review_key(&b, &b["review"]);
        b["review"]["lastReviewedAt"] = 999.0.into();
        b["review"]["workerProgress"].array_mut()[0]["run"]["reportedAt"] = 999.0.into();
        b["review"]["workerProgress"].array_mut()[0]["run"]["summary"] =
            "시각과 표현만 바뀐 같은 상태".into();
        assert_eq!(review_key(&b, &b["review"]), reviewed);
    }
}
