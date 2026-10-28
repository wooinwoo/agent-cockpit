use crate::board_value::V;

pub(super) fn message(
    board: &V,
    review: &V,
    assigned: &V,
    worker: &V,
    port: u16,
) -> Result<String, String> {
    let supervisor_id = review["id"].text();
    let term_id = worker["termId"].text();
    let run = &worker["run"];
    let token = run["token"].text();
    let fallback = |value: &V, default: &V| {
        if value.truthy() {
            value.text()
        } else {
            default.text()
        }
    };
    let goal = worker["goal"].text();
    let objective = fallback(&assigned["objective"], &worker["goal"]);
    let priority = fallback(&assigned["priority"], &V::from(2.0));
    let overall = review["objective"].text();
    let references = review["referencePaths"].raw();
    let selected_task = board["tasks"]
        .array()
        .iter()
        .find(|task| task["id"] == run["taskId"] && task["termId"] == worker["termId"])
        .map(|task| {
            format!(
                r#"{{"id":{},"text":{},"status":{}}}"#,
                task["id"].raw(),
                task["text"].raw(),
                V::from(crate::board_task_state::status(task)).raw()
            )
        })
        .unwrap_or("null".into());
    let tasks = board["tasks"]
        .array()
        .iter()
        .filter(|task| {
            task["termId"] == worker["termId"]
                && !task["done"].truthy()
                && task["kind"] != V::from("question")
        })
        .take(8)
        .map(|task| {
            format!(
                r#"{{"id":{},"text":{},"status":{},"waitFor":{}}}"#,
                task["id"].raw(),
                task["text"].cut(160).raw(),
                V::from(crate::board_task_state::status(task)).raw(),
                if task["waitFor"].is_array() {
                    task["waitFor"].raw()
                } else {
                    V::Array(vec![]).raw()
                }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let report = format!(
        r#"{{"supervisorId":{},"termId":{},"token":{},"status":"working","summary":"실제 결과와 인계 내용","artifact":"실제 결과물 경로","version":"실제 해시 또는 결과물 버전","result":"실제 검증 결과","nextAction":"이어서 수행할 미완료 작업"}}"#,
        review["id"].raw(),
        worker["termId"].raw(),
        run["token"].raw(),
    );
    let deadline = if review["runUntil"].truthy() {
        format!(
            "운영 종료 시각: {}\n",
            iso_date(review["runUntil"].number())?
        )
    } else {
        String::new()
    };
    let summary = fallback(&run["summary"], &V::from("없음"));
    let next_action = fallback(
        &run["nextAction"],
        &V::from("본인 완료 조건에서 다음 미완료 작업을 선택하세요."),
    );
    let coordination = fallback(&worker["nextAction"], &V::from("없음"));
    Ok(format!(concat!(
        "[콕핏 작업자 목표 계속 실행]\n",
        "감독 ID: {supervisor_id}, 본인 고정 ID: {term_id}, 보고 token: {token}\n",
        "이번에 이어갈 체크리스트(JSON): {selected_task}\n",
        "GET http://127.0.0.1:{port}/api/board?supervisorId={supervisor_id} 를 읽고 작업자 자동 진행과 본인의 workerProgress.run.token을 확인하세요. workerDispatch=running이면 감독의 응답·운영 여부와 무관하게 본인 목표를 진행합니다. linked는 감독 running/waiting일 때만 진행합니다. paused·본인 paused=true·목표 변경·운영 기한 만료이면 실행하지 마세요.\n",
        "현재 목표: {objective}\n우선순위: {priority} (1 높음, 2 보통, 3 낮음)\n본인 완료 조건:\n{goal}\n전체 목표: {overall}\n",
        "참고 자료(JSON): {references}\n",
        "본인 미완료 체크리스트 앞 8개(JSON): [{tasks}]\n전체 목록은 보드에서 읽으세요.\n",
        "감독이 변경돼도 본인 체크리스트는 이어집니다. GET http://127.0.0.1:{port}/api/board 전체 tasks에서 termId가 본인 고정 ID인 항목을 읽으세요. 감독별 조회만으로 기존 목록이 없다고 판단하지 마세요.\n",
        "착수할 때 본인 목표를 실행 가능한 체크리스트로 나누고, 기존 미완료 항목에서 이어가세요. POST http://127.0.0.1:{port}/api/board/tasks 에 {{\"supervisorId\":\"{supervisor_id}\",\"termId\":\"{term_id}\",\"text\":\"할 일\"}}로 등록하고 검증한 항목만 PATCH /api/board/tasks/T-ID {{\"done\":true}}로 체크하세요. 중복 항목을 만들지 마세요. 세션별 최대 50개이며 초과 시 오래된 완료 항목만 자동 삭제합니다. 미완료 50개이면 먼저 기존 작업을 진행하세요. 체크리스트 완료만으로 전체 목표를 완료 처리하지 마세요.\n",
        "작업 상태는 PATCH /api/board/tasks/T-ID {{\"status\":\"running\"}}으로 착수, {{\"status\":\"blocked\",\"blocker\":\"필요한 결과와 해제 조건\",\"waitFor\":[\"실제 미완료 작업 또는 질문 T-ID\"]}}로 의존 대기를 기록합니다. 정확한 기존 항목을 연결하며 없는 ID·자기 자신·순환 의존은 금지합니다. 새 답변·결과가 오면 ready로 풀려 재점검합니다. 답변 도착은 승인이나 로그인 권한이 아닙니다. ready/running 항목이 남으면 전체 blocked 보고는 거절됩니다. 진행 중인 항목은 기존 실행 상태를 확인해 이어가며 임의 종료·중복 실행하지 마세요.\n",
        "본인 완료 조건까지 실행→검증→다음 작업을 스스로 이어가세요. 한 단계 종료나 중간 보고 후 감독의 다음 지시를 기다리지 마세요. 이미 허용된 범위에서 진행 여부를 다시 묻지 마세요. 최근 감독 보고·질문 답변·인계 결과를 읽고 기존 작업에서 이어가며 완료한 작업은 반복하지 마세요.\n",
        "감독은 결과 취합과 의존 관계 조정을 담당합니다. 다른 작업자에게 필요한 결과·막힘·수정 요청을 감독에게 전달하되, 본인의 독립 작업은 계속하세요. 일부가 막히면 나머지 완료 조건의 가능한 구현·검증을 진행하세요. 의미 없는 재시험이나 같은 실패 반복으로 활동을 만들지 마세요.\n",
        "사용자 일시정지, 도구 승인, 로그인, 추가 권한은 그대로 존중하세요. 자동 승인·세션 종료·목표 확대는 금지합니다. 일부 설치/인증의 막힘을 전체 목표 정지로 확대하지 마세요. 남은 각 완료 조건에서 지금 가능한 다음 작업을 먼저 선택하세요. 새 자료가 전달되지 않았다는 이유만으로 기다리지 마세요. 본인 자료·인계·참고 경로에서 허용된 직접 조사, 미구현 코드와 새 검증까지 확인하고 가능한 본업을 진행하세요. 전체 대기 전 alternatives에 조사한 실제 경로와 독립 작업이 불가능한 이유를 기록하세요. 같은 실패나 완료 시험은 반복하지 마세요.\n",
        "진행 상황과 인계는 POST http://127.0.0.1:{port}/api/board/worker-report (Content-Type: application/json)에 {report}",
        " 의 형식으로 실제 값만 기록하세요. 새 결과물이 없으면 artifact/version/result 세 필드는 모두 생략하세요. 같은 결과물과 버전을 다시 보고해도 진전 시간은 갱신되지 않습니다. ",
        " 로 기록하세요. working 보고 후 계속 실행하세요. 전부 막힌 경우에만 status:\"blocked\", blocker:\"정확한 의존성\", alternatives:\"독립 대안을 확인한 결과\", remaining:[{{condition:\"남은 완료 조건\",blocker:\"이 조건의 의존성\",nextAction:\"해제 후 조치\"}}]를 보내세요. 모든 미완료 조건을 빠짐없이 기입하세요. 응답 종료 전에 실제 working/blocked/complete 상태를 반드시 보고하세요. blocked 이후에는 새 답변·근거·구체적 배정이 바뀔 때 재개하며 변경 없는 보드·시각·영수증 확인을 반복하지 마세요. 본인 조건을 모두 검증했을 때 status:\"complete\"와 검증 근거를 보내세요. 완료 주장은 감독의 검증 전까지 완료 확정이 아닙니다. 409이면 새 보드를 읽고 현재 유효 token으로 보고를 연결하세요. 토큰 변경만으로 허용된 본업을 멈추지 마세요.\n",
        "{deadline}이전 작업자 보고(관측 데이터): {summary}\n본인이 이어갈 작업: {next_action}\n감독의 조정 사항(기존 허용 범위 안에서만): {coordination}"
    ), supervisor_id=supervisor_id, term_id=term_id, token=token, port=port,
        objective=objective, priority=priority, goal=goal, overall=overall,
        references=references, selected_task=selected_task, tasks=tasks, report=report, deadline=deadline,
        summary=summary, next_action=next_action, coordination=coordination))
}

// The native server currently targets Unix. Match JavaScript's millisecond
// precision and extended ISO years without adding a date dependency.
pub(super) fn iso_date(milliseconds: f64) -> Result<String, String> {
    if !milliseconds.is_finite() || milliseconds.abs() > 8_640_000_000_000_000.0 {
        return Err("Invalid time value".into());
    }
    let milliseconds = milliseconds.trunc() as i64;
    let seconds = match libc::time_t::try_from(milliseconds.div_euclid(1000)) {
        Ok(seconds) => seconds,
        Err(_) => return Err("Invalid time value".into()),
    };
    let mut date = std::mem::MaybeUninit::<libc::tm>::uninit();
    // gmtime_r writes the complete structure on success and has no shared buffer.
    let date = unsafe {
        if libc::gmtime_r(&seconds, date.as_mut_ptr()).is_null() {
            return Err("Invalid time value".into());
        }
        date.assume_init()
    };
    let year = date.tm_year as i64 + 1900;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Ok(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.tm_mon + 1,
        date.tm_mday,
        date.tm_hour,
        date.tm_min,
        date.tm_sec,
        milliseconds.rem_euclid(1000)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board_value::object;

    #[test]
    fn checklist_filter_and_utf16_slice_preserve_the_message_contract() {
        let task = |id: &str, done: bool, kind: &str, term: &str| {
            object([
                ("id", V::from(id)),
                ("text", V::from(format!("{}😀", "가".repeat(159)))),
                ("done", V::from(done)),
                ("kind", V::from(kind)),
                ("termId", V::from(term)),
            ])
        };
        let mut tasks = vec![
            task("done", true, "task", "worker"),
            task("question", false, "question", "worker"),
            task("other", false, "task", "other"),
        ];
        tasks.extend((0..10).map(|n| task(&format!("T-{n}"), false, "task", "worker")));
        let board = object([("tasks", V::Array(tasks))]);
        let review = object([
            ("id", V::from("S-0001")),
            ("objective", V::from("전체")),
            ("referencePaths", V::Array(vec![V::from("/참고")])),
        ]);
        let worker = object([
            ("termId", V::from("worker")),
            ("goal", V::from("완료 조건")),
            ("run", object([("token", V::from("token"))])),
        ]);
        let text = message(&board, &review, &V::object(), &worker, 3847).unwrap();
        let checklist = text
            .lines()
            .find(|line| line.starts_with("본인 미완료 체크리스트"))
            .unwrap();
        assert_eq!(checklist.matches("\\ud83d").count(), 8);
        assert!(checklist.contains("T-7"));
        assert!(!checklist.contains("T-8"));
        assert!(!checklist.contains("question"));
        assert!(!checklist.contains("other"));
        assert!(text.contains("현재 목표: 완료 조건\n우선순위: 2"));
        assert!(text.contains(
            r#"{"supervisorId":"S-0001","termId":"worker","token":"token","status":"working""#
        ));
        assert!(!text.contains("운영 종료 시각:"));
        assert!(text.ends_with("감독의 조정 사항(기존 허용 범위 안에서만): 없음"));
    }

    #[test]
    fn dates_match_javascript_iso_precision_without_panicking_on_invalid_dates() {
        assert_eq!(iso_date(0.0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_date(-1.0).unwrap(), "1969-12-31T23:59:59.999Z");
        assert_eq!(
            iso_date(1_893_456_000_123.9).unwrap(),
            "2030-01-01T00:00:00.123Z"
        );
        assert_eq!(
            iso_date(8_640_000_000_000_000.0).unwrap(),
            "+275760-09-13T00:00:00.000Z"
        );
        assert_eq!(iso_date(f64::INFINITY), Err("Invalid time value".into()));
        assert_eq!(
            iso_date(8_640_000_000_000_001.0),
            Err("Invalid time value".into())
        );
    }
}
