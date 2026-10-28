use crate::{board_model, board_value::V};
use serde_json::value::RawValue;
use std::collections::BTreeMap;

// The overview is a read model. Historical reports and unknown extension fields
// must not be recursively parsed, normalized, cloned, and sent on every poll.
type Fields<'a> = BTreeMap<&'a str, &'a RawValue>;

fn pick(raw: &RawValue, names: &[&str]) -> serde_json::Result<Box<RawValue>> {
    let fields = serde_json::from_str::<Fields<'_>>(raw.get()).unwrap_or_default();
    serde_json::value::to_raw_value(
        &fields
            .into_iter()
            .filter(|(key, _)| names.contains(key))
            .collect::<Fields<'_>>(),
    )
}

fn items(raw: &RawValue) -> Vec<&RawValue> {
    serde_json::from_str(raw.get()).unwrap_or_default()
}

fn worker(raw: &RawValue) -> serde_json::Result<Box<RawValue>> {
    let mut out: BTreeMap<String, Box<RawValue>> = serde_json::from_str(
        pick(
            raw,
            &[
                "termId",
                "goal",
                "evidence",
                "blocker",
                "nextAction",
                "startedAt",
                "lastProgressAt",
            ],
        )?
        .get(),
    )?;
    let fields = serde_json::from_str::<Fields<'_>>(raw.get()).unwrap_or_default();
    if let Some(run) = fields.get("run") {
        out.insert(
            "run".into(),
            pick(
                run,
                &[
                    "status",
                    "summary",
                    "observed",
                    "reportedAt",
                    "progressAt",
                    "blocker",
                    "nextAction",
                    "blockedVerifiedAt",
                    "evidence",
                ],
            )?,
        );
    }
    serde_json::value::to_raw_value(&out)
}

fn supervisor(raw: &RawValue) -> serde_json::Result<Box<RawValue>> {
    let mut out: BTreeMap<String, Box<RawValue>> = serde_json::from_str(
        pick(
            raw,
            &[
                "id",
                "termId",
                "name",
                "alias",
                "objective",
                "status",
                "workerDispatch",
                "runUntil",
            ],
        )?
        .get(),
    )?;
    let fields = serde_json::from_str::<Fields<'_>>(raw.get()).unwrap_or_default();
    if let Some(watched) = fields.get("watched") {
        let values = items(watched)
            .into_iter()
            .take(12)
            .map(|value| {
                pick(
                    value,
                    &["termId", "alias", "goal", "objective", "priority", "paused"],
                )
            })
            .collect::<serde_json::Result<Vec<_>>>()?;
        out.insert("watched".into(), serde_json::value::to_raw_value(&values)?);
    }
    if let Some(progress) = fields.get("workerProgress") {
        let values = items(progress)
            .into_iter()
            .take(12)
            .map(worker)
            .collect::<serde_json::Result<Vec<_>>>()?;
        out.insert(
            "workerProgress".into(),
            serde_json::value::to_raw_value(&values)?,
        );
    }
    if let Some(reports) = fields.get("reports") {
        // The status UI consumes the latest report, never the entire history.
        let values = items(reports)
            .into_iter()
            .rev()
            .take(1)
            .map(|value| pick(value, &["at", "status", "text"]))
            .collect::<serde_json::Result<Vec<_>>>()?;
        out.insert("reports".into(), serde_json::value::to_raw_value(&values)?);
    }
    serde_json::value::to_raw_value(&out)
}

pub(super) fn read(bytes: &[u8], now: f64) -> serde_json::Result<V> {
    let raw: Box<RawValue> = serde_json::from_slice(bytes)?;
    let fields = serde_json::from_str::<Fields<'_>>(raw.get()).unwrap_or_default();
    let mut out = BTreeMap::new();
    for key in ["revision", "updatedAt"] {
        if let Some(value) = fields.get(key) {
            out.insert(key, RawValue::from_string(value.get().into())?);
        }
    }
    if let Some(review) =
        fields
            .get("review")
            .filter(|value| match value.get().as_bytes().first() {
                Some(b'n' | b'f') => false,
                Some(b'"') => value.get() != "\"\"",
                Some(b'{' | b'[' | b't') => true,
                _ => value
                    .get()
                    .parse::<f64>()
                    .is_ok_and(|number| number != 0.0 && !number.is_nan()),
            })
    {
        out.insert("review", supervisor(review)?);
    }
    if let Some(supervisors) = fields.get("supervisors") {
        let values = items(supervisors)
            .into_iter()
            .map(supervisor)
            .collect::<serde_json::Result<Vec<_>>>()?;
        out.insert("supervisors", serde_json::value::to_raw_value(&values)?);
    }
    for (key, names) in [
        (
            "tasks",
            &[
                "id",
                "text",
                "kind",
                "done",
                "termId",
                "status",
                "updatedAt",
                "createdAt",
                "checklistId",
                "waitFor",
                "waitKey",
                "blocker",
                "activation",
                "answer",
                "questionTo",
            ][..],
        ),
        ("checklists", &["id", "supervisorId", "title"][..]),
    ] {
        if let Some(value) = fields.get(key) {
            let values = items(value)
                .into_iter()
                .map(|item| pick(item, names))
                .collect::<serde_json::Result<Vec<_>>>()?;
            out.insert(key, serde_json::value::to_raw_value(&values)?);
        }
    }
    let raw = serde_json::value::to_raw_value(&out)?;
    Ok(project(&board_model::normalize(&V::parse(&raw)?, now)))
}

pub(super) fn project(board: &V) -> V {
    // Normalize the same task/dependency semantics as the full board, then keep
    // only fields used by the overview and Agent Wall. Editors fetch full data.
    let mut out = crate::board_value::object([
        ("projection", "overview".into()),
        ("revision", board["revision"].clone()),
        ("updatedAt", board["updatedAt"].clone()),
        ("tasks", board["tasks"].clone()),
        ("supervisors", board["supervisors"].clone()),
    ]);
    for review in out["supervisors"].array_mut() {
        let keys = [
            "id",
            "termId",
            "name",
            "alias",
            "objective",
            "status",
            "workerDispatch",
            "runUntil",
            "watched",
            "workerProgress",
            "reports",
        ];
        if let V::Object(fields) = review {
            fields.retain(|key, _| keys.contains(&key.as_str()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_keep_live_rows_without_history_or_extension_payloads() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "revision": 7, "updatedAt": 123,
            "review": {"termId":"pm", "objective":"goal", "extra":"x".repeat(1_000_000),
                "reports":[{"at":1,"text":"old"},{"at":2,"text":"latest"}],
                "watched":[{"termId":"a","goal":"finish","priority":1}],
                "workerProgress":[{"termId":"a","goal":"finish","extra":"secret",
                    "run":{"status":"blocked","blocker":"waiting","extra":"secret"}}]},
            "tasks":[{"id":"T-0001","text":"A","termId":"a","status":"running"},
                {"id":"T-0002","text":"B","termId":"b","status":"blocked","waitFor":["T-0001"]}]
        }))
        .unwrap();
        let full = board_model::normalize(
            &V::parse(&RawValue::from_string(String::from_utf8(bytes.clone()).unwrap()).unwrap())
                .unwrap(),
            1000.0,
        );
        let summary = read(&bytes, 1000.0).unwrap();
        assert_eq!(summary["revision"], full["revision"]);
        assert_eq!(summary["tasks"], full["tasks"]);
        assert_eq!(
            summary["supervisors"].array()[0]["reports"].array().len(),
            1
        );
        assert_eq!(
            summary["supervisors"].array()[0]["reports"].array()[0]["text"],
            V::from("latest")
        );
        assert!(!summary.has("review"));
        assert!(!summary["supervisors"].array()[0].has("extra"));
        assert!(!summary.raw().get().contains("secret"));
        assert!(summary.raw().get().len() < 5000);
    }

    #[test]
    fn legacy_boards_and_utf16_are_preserved_without_writing_storage() {
        let summary = read(br#"{"review":{"objective":"\ud800","reports":[]},"tasks":[{"id":"T-0001","text":"\udc00","done":true,"termId":"a"}]}"#, 1000.0).unwrap();
        assert_eq!(
            summary["supervisors"].array()[0]["objective"].raw().get(),
            r#""\ud800""#
        );
        assert_eq!(summary["tasks"].array()[0]["done"], V::Bool(true));
        assert_eq!(
            summary["tasks"].array()[0]["text"].raw().get(),
            r#""\udc00""#
        );
        assert!(read(b"{broken", 1000.0).is_err());
    }

    #[test]
    fn overview_get_is_read_only_and_projected_put_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::board::Store::new(directory.path());
        let raw = br#"{"review":{"reports":[{"at":1,"text":"keep this history"}]},"tasks":[]}"#;
        std::fs::write(directory.path().join(".cockpit-board.json"), raw).unwrap();
        let accounts = std::sync::Arc::new(crate::accounts::Store::new(
            directory.path(),
            directory.path(),
        ));
        let terminals =
            crate::terminals::Store::new(directory.path().join("terminals"), accounts).unwrap();
        let query = std::collections::HashMap::from([("projection".into(), "overview".into())]);
        let (_, summary) = store
            .request(
                axum::http::Method::GET,
                "/api/board",
                &query,
                V::object(),
                true,
                &terminals,
            )
            .unwrap();
        let input = crate::board_value::object([("board", summary), ("revision", 0.0.into())]);
        let error = store
            .request(
                axum::http::Method::PUT,
                "/api/board",
                &std::collections::HashMap::new(),
                input,
                true,
                &terminals,
            )
            .unwrap_err();
        assert_eq!(error.0, 400);
        let invalid_query = std::collections::HashMap::from([
            ("projection".into(), "overview".into()),
            ("supervisorId".into(), "S-0001".into()),
        ]);
        assert!(store
            .request(
                axum::http::Method::GET,
                "/api/board",
                &invalid_query,
                V::object(),
                true,
                &terminals
            )
            .is_err());
        assert_eq!(
            std::fs::read(directory.path().join(".cockpit-board.json")).unwrap(),
            raw
        );
        assert_eq!(store.read().unwrap()["review"]["reports"].array().len(), 1);
    }

    #[test]
    fn answer_and_worker_evidence_keep_valid_dependency_waits_blocked() {
        let raw = RawValue::from_string(r#"{"review":{"status":"running","watched":[{"termId":"a","goal":"A"}],"workerProgress":[{"termId":"a","goal":"A","evidence":"verified","run":{"evidence":"candidate"}}]},"tasks":[{"id":"T-0001","text":"A","termId":"a","activation":7},{"id":"T-0002","text":"B","termId":"b"},{"id":"T-0003","text":"question","kind":"question","questionTo":"supervisor","answer":"known"}]}"#.into()).unwrap();
        let mut board = board_model::normalize(&V::parse(&raw).unwrap(), 1000.0);
        let input = crate::board_value::object([
            ("status", "blocked".into()),
            ("blocker", "dependency".into()),
            ("waitFor", V::Array(vec!["T-0001".into(), "T-0003".into()])),
        ]);
        let updates =
            crate::board_task_state::apply(&board, &board["tasks"].array()[1], &input).unwrap();
        if let V::Object(fields) = updates {
            for (key, value) in fields {
                board["tasks"].array_mut()[1][&key] = value;
            }
        }
        let summary = read(board.raw().get().as_bytes(), 1000.0).unwrap();
        assert_eq!(summary["tasks"].array()[1]["status"], V::from("blocked"));
        assert_eq!(summary["tasks"].array()[0]["activation"], V::from(7.0));
        assert_eq!(summary["tasks"].array()[2]["answer"], V::from("known"));
        board["tasks"].array_mut()[2]["answer"] = "changed".into();
        let summary = read(board.raw().get().as_bytes(), 1000.0).unwrap();
        assert_eq!(summary["tasks"].array()[1]["status"], V::from("ready"));
    }

    #[test]
    #[ignore = "manual read-only benchmark of an explicitly supplied fixture"]
    fn overview_fixture_benchmark() {
        let path =
            std::env::var("COCKPIT_TEST_BOARD_FIXTURE").expect("explicit fixture path required");
        let bytes = std::fs::read(path).unwrap();
        let raw: Box<RawValue> = serde_json::from_slice(&bytes).unwrap();
        let start = std::time::Instant::now();
        let full = board_model::normalize(&V::parse(&raw).unwrap(), 1000.0);
        let full_bytes = full.raw();
        let full_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = std::time::Instant::now();
        let summary = read(&bytes, 1000.0).unwrap();
        let summary_bytes = summary.raw();
        let summary_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(summary["tasks"].array().len(), full["tasks"].array().len());
        for (actual, expected) in summary["tasks"].array().iter().zip(full["tasks"].array()) {
            for field in [
                "id",
                "termId",
                "done",
                "status",
                "text",
                "waitKey",
                "answer",
                "activation",
            ] {
                assert_eq!(
                    actual[field],
                    expected[field],
                    "task {} field {field}",
                    expected["id"].text()
                );
            }
        }
        println!("{{\"full_bytes\":{},\"summary_bytes\":{},\"full_ms\":{full_ms:.3},\"summary_ms\":{summary_ms:.3},\"tasks\":{}}}", full_bytes.get().len(), summary_bytes.get().len(), full["tasks"].array().len());
    }
}
