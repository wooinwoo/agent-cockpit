use super::{control, now, object, uuid, worker_message, Error, Result, Store, V};
use crate::{
    activity,
    terminals::{AgentScreen, Store as Terminals},
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const PROGRESS_DEADLINE: f64 = 300_000.0;
#[derive(Default)]
pub struct Runner {
    idle: HashMap<(String, String), (String, f64)>,
}

fn progress(review: &V, term_id: &V) -> Option<V> {
    review["workerProgress"]
        .array()
        .iter()
        .find(|worker| worker["termId"] == *term_id)
        .cloned()
}
fn save_run(store: &Store, review: &mut V, worker: &mut V, run: V) -> Result<()> {
    let mut rows = review["workerProgress"].clone();
    let row = rows
        .array_mut()
        .iter_mut()
        .find(|row| row["termId"] == worker["termId"])
        .ok_or_else(|| Error(409, "작업자 배정이 변경됐습니다.".into()))?;
    row["run"] = run;
    *review = store.scheduler_update(review, &object([("workerProgress", rows)]))?;
    *worker = progress(review, &worker["termId"]).unwrap();
    Ok(())
}
fn finished(worker: &V) -> bool {
    [V::from("reported"), V::from("complete")].contains(&worker["run"]["status"])
}
fn waiting_for_dependency(run: &V, dependencies: &V) -> bool {
    run["dependencyKey"] == *dependencies
        && (run["status"] == V::from("blocked")
            || (run["status"] == V::from("active")
                && run["blocker"].truthy()
                && !run["remaining"].array().is_empty()
                && run["attempts"].number() > 0.0
                && run["reportedAt"].number() <= run["lastSentAt"].number()
                && !run["lastError"].text().starts_with("목표 전달 실패:")))
}
fn cooldown(worker: &V, dependencies: &V) -> f64 {
    let run = &worker["run"];
    if run["status"] == V::from("blocked") {
        if run["dependencyKey"] == *dependencies {
            120_000.0
        } else {
            0.0
        }
    } else if run["status"] == V::from("active")
        && run["reportedAt"].number() >= run["lastSentAt"].number()
    {
        30_000.0
    } else {
        (30_000.0 * 2.0f64.powf(run["attempts"].number().min(2.0))).min(120_000.0)
    }
}
fn state(screen: Option<&AgentScreen>) -> &'static str {
    screen.map(AgentScreen::state).unwrap_or("offline")
}
fn resumable(screen: &AgentScreen) -> bool {
    !screen.held
        && screen.current
        && screen.agent.as_deref() == Some("codex")
        && screen.state() == "paused"
        && activity::screen_state(&screen.lines, true, "codex", true, false) == "idle"
}
fn resume_composer(screen: &AgentScreen) -> bool {
    !screen.held
        && screen.current
        && activity::resume_composer(&screen.lines, screen.agent.as_deref().unwrap_or(""))
}
fn can_queue_check(screen: &AgentScreen) -> bool {
    let text = screen.lines.join("\n").to_lowercase();
    !screen.held
        && screen.current
        && screen.agent.as_deref() == Some("codex")
        && screen.state() == "busy"
        && ![
            "goal paused",
            "goal blocked",
            "goal budget",
            "goal usage",
            "messages to be submitted",
            "tab to queue",
        ]
        .iter()
        .any(|needle| text.contains(needle))
        && activity::screen_state(&screen.lines, true, "codex", false, true) == "idle"
}

impl Runner {
    pub fn tick(
        &mut self,
        store: &Store,
        terminals: &Terminals,
        port: u16,
    ) -> std::result::Result<(), String> {
        self.tick_inner(store, terminals, port)
            .map_err(|error| error.1)
    }
    fn tick_inner(&mut self, store: &Store, terminals: &Terminals, port: u16) -> Result<()> {
        if terminals.is_closing() {
            return Ok(());
        }
        let board = store.read()?;
        let time = now();
        let mut targets = Vec::new();
        let mut keys = HashSet::new();
        for review in board["supervisors"]
            .array()
            .iter()
            .filter(|review| control::dispatch_enabled(review, time))
        {
            let mut workers = review["watched"].array().to_vec();
            workers.sort_by(|a, b| a["priority"].number().total_cmp(&b["priority"].number()));
            for worker in workers
                .into_iter()
                .filter(|worker| worker["paused"] != V::Bool(true))
            {
                keys.insert((review["id"].text(), worker["termId"].text()));
                targets.push((review["id"].clone(), worker["termId"].clone()));
            }
        }
        self.idle.retain(|key, _| keys.contains(key));
        // Observe in bounded batches outside the file lock. One unresponsive
        // pane must not impose a timeout for every healthy worker after it.
        let runtime = tokio::runtime::Handle::current();
        let mut snapshots = HashMap::new();
        let mut seen = HashSet::new();
        let ids: Vec<_> = targets
            .iter()
            .map(|(_, id)| id.text())
            .filter(|id| seen.insert(id.clone()))
            .collect();
        for batch in ids.chunks(8) {
            let rows = std::thread::scope(|scope| {
                let threads: Vec<_> = batch
                    .iter()
                    .map(|id| {
                        let runtime = &runtime;
                        scope.spawn(move || {
                            let _entered = runtime.enter();
                            (id.clone(), terminals.automation_snapshot(id))
                        })
                    })
                    .collect();
                threads
                    .into_iter()
                    .filter_map(|thread| thread.join().ok())
                    .collect::<Vec<_>>()
            });
            snapshots.extend(rows);
        }
        let mut failure = None;
        for (id, term_id) in targets {
            if terminals.is_closing() {
                break;
            }
            if let Err(error) = self.worker(
                store,
                terminals,
                port,
                &id,
                &term_id,
                snapshots.get(&term_id.text()).and_then(Option::as_ref),
            ) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
    fn worker(
        &mut self,
        store: &Store,
        terminals: &Terminals,
        port: u16,
        id: &V,
        term_id: &V,
        screen: Option<&AgentScreen>,
    ) -> Result<()> {
        let board = store.read()?;
        let Some(mut review) = board["supervisors"]
            .array()
            .iter()
            .find(|review| review["id"] == *id)
            .cloned()
        else {
            return Ok(());
        };
        if !control::dispatch_enabled(&review, now()) {
            return Ok(());
        }
        let Some(assigned) = review["watched"]
            .array()
            .iter()
            .find(|worker| worker["termId"] == *term_id)
            .cloned()
        else {
            return Ok(());
        };
        let key = (id.text(), term_id.text());
        if assigned["paused"] == V::Bool(true) || screen.is_some_and(|screen| screen.held) {
            self.idle.remove(&key);
            return Ok(());
        }
        if !review["workerProgress"]
            .array()
            .iter()
            .any(|worker| worker["termId"] == *term_id && worker["goal"] == assigned["goal"])
        {
            review = store.scheduler_update(&review, &V::object())?;
        }
        let Some(mut worker) = progress(&review, term_id) else {
            return Ok(());
        };
        let observed = state(screen);
        if worker["run"]["observed"] != V::from(observed) {
            let mut run = worker["run"].clone();
            run["observed"] = observed.into();
            save_run(store, &mut review, &mut worker, run)?;
        }
        let agent = screen
            .and_then(|screen| screen.agent.as_deref())
            .unwrap_or("");
        if worker["run"]["resumeRequestedAt"].truthy() {
            if now() - worker["run"]["resumeRequestedAt"].number() > 60_000.0 {
                let mut run = worker["run"].clone();
                run["resumeRequestedAt"] = 0.0.into();
                run["lastError"] =
                    "재개 요청 만료: 승인·입력·실행 상태를 확인한 뒤 다시 재개하세요.".into();
                save_run(store, &mut review, &mut worker, run)?;
            } else if screen.is_some_and(resumable) {
                if !terminals
                    .automation_snapshot(&term_id.text())
                    .as_ref()
                    .is_some_and(resumable)
                {
                    return Ok(());
                }
                let mut run = worker["run"].clone();
                run["resumeRequestedAt"] = 0.0.into();
                run["resumeSentAt"] = now().into();
                run["resumeSubmittedAt"] = 0.0.into();
                run["lastError"] = "목표 재개 명령 전달됨 · 실제 상태 확인 중".into();
                save_run(store, &mut review, &mut worker, run)?;
                self.deliver(
                    store,
                    terminals,
                    &mut review,
                    &mut worker,
                    "\x1b[200~/goal resume\x1b[201~".into(),
                    true,
                    agent,
                )?;
                return Ok(());
            } else if observed == "idle" {
                let mut run = worker["run"].clone();
                run["resumeRequestedAt"] = 0.0.into();
                ready(&mut run);
                save_run(store, &mut review, &mut worker, run)?;
            }
        }
        if worker["run"]["resumeSentAt"].truthy() {
            if !worker["run"]["resumeSubmittedAt"].truthy()
                && now() - worker["run"]["resumeSentAt"].number() < 30_000.0
                && screen.is_some_and(resume_composer)
                && terminals
                    .automation_snapshot(&term_id.text())
                    .as_ref()
                    .is_some_and(resume_composer)
            {
                let mut run = worker["run"].clone();
                run["resumeSubmittedAt"] = now().into();
                save_run(store, &mut review, &mut worker, run)?;
                self.deliver(
                    store,
                    terminals,
                    &mut review,
                    &mut worker,
                    "\r".into(),
                    true,
                    agent,
                )?;
                return Ok(());
            }
            if observed == "idle"
                || (observed == "busy"
                    && screen
                        .is_some_and(|screen| !screen.lines.join("\n").contains("Goal paused")))
            {
                let mut run = worker["run"].clone();
                run["resumeSentAt"] = 0.0.into();
                run["resumeSubmittedAt"] = 0.0.into();
                ready(&mut run);
                save_run(store, &mut review, &mut worker, run)?;
            } else {
                let since = if worker["run"]["resumeSubmittedAt"].truthy() {
                    worker["run"]["resumeSubmittedAt"].number()
                } else {
                    worker["run"]["resumeSentAt"].number()
                };
                if now() - since >= 30_000.0 {
                    let mut run = worker["run"].clone();
                    run["resumeSentAt"] = 0.0.into();
                    run["resumeSubmittedAt"] = 0.0.into();
                    run["lastError"] = "목표 재개가 확인되지 않았습니다. 현재 터미널의 오류·승인 상태를 확인하세요.".into();
                    save_run(store, &mut review, &mut worker, run)?;
                }
            }
        }
        let dependencies = control::dependency(&board, &review, term_id);
        let queued = crate::board_task_state::pending(&board, term_id);
        let next_task = crate::board_task_state::next(&board, term_id);
        let dispatch_key = crate::board_task_state::dispatch_key(
            &board,
            &review,
            &assigned,
            &worker,
            next_task.as_ref(),
            &dependencies,
        );
        let complete = finished(&worker) && next_task.is_none();
        let run = &worker["run"];
        let waiting = next_task.is_none()
            && ((!queued.is_empty() && run["status"] == V::from("blocked"))
                || waiting_for_dependency(run, &dependencies)
                || (!queued.is_empty()
                    && run["status"] == V::from("active")
                    && !run["taskId"].truthy()
                    && run["attempts"].number() > 0.0
                    && run["reportedAt"].number() <= run["lastSentAt"].number()
                    && run["dependencyKey"] == dependencies
                    && !run["lastError"].text().starts_with("목표 전달 실패:")));
        let mut progress_at = worker["lastProgressAt"]
            .number()
            .max(worker["run"]["progressAt"].number());
        if progress_at == 0.0 {
            progress_at = worker["startedAt"].number();
        }
        let evidence_interval = progress_at.max(worker["run"]["lastSentAt"].number());
        if now() - evidence_interval >= PROGRESS_DEADLINE
            && !(waiting && (worker["run"]["status"] == V::from("blocked") || observed == "idle"))
            && !complete
            && (!worker["run"]["interventionAt"].truthy()
                || worker["run"]["interventionAt"].number() < evidence_interval)
        {
            let mut run = worker["run"].clone();
            run["interventionAt"] = now().into();
            if !run["lastError"].text().starts_with("목표 전달 실패:") {
                run["lastError"] = "5분간 새 근거 없음 · 작업자 자체 점검 및 감독 확인 요청".into();
            }
            save_run(store, &mut review, &mut worker, run)?;
            review = store.scheduler_update(
                &review,
                &object([("nextDueAt", now().into()), ("retryAt", 0.0.into())]),
            )?;
        }
        if now() - evidence_interval >= PROGRESS_DEADLINE
            && !complete
            && !waiting
            && worker["run"]["interventionAt"].number() >= evidence_interval
        {
            if worker["run"]["checkQueuedAt"].number() < evidence_interval
                && screen.is_some_and(can_queue_check)
                && terminals
                    .automation_snapshot(&term_id.text())
                    .as_ref()
                    .is_some_and(can_queue_check)
            {
                let mut run = worker["run"].clone();
                run["checkQueuedAt"] = now().into();
                save_run(store, &mut review, &mut worker, run)?;
                self.deliver(store, terminals, &mut review, &mut worker,
                    "\x1b[200~[콕핏 작업자 정체 점검]\n5분간 새 검증 근거가 없습니다. 현재 도구가 돌아오면 이번 작업의 실제 결과·실행 중 외부 작업·예상 종료·막힌 조건을 보고하세요. 검토자 대기만 반복하지 말고 남은 독립 작업을 진행하세요. 외부 작업은 임의 종료·중복 실행하지 마세요. 모든 조건이 막히면 조건별 blocker와 해제 후 nextAction을 보고하세요. 감독에게 재배정을 요청하고 같은 실패나 시험을 반복하지 마세요.\x1b[201~\r".into(), false, agent)?;
            }
        }
        if observed != "idle" || complete {
            self.idle.remove(&key);
            return Ok(());
        }
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(screen.unwrap().lines.join("\n").as_bytes())
        );
        let time = now();
        let previous = self
            .idle
            .entry(key.clone())
            .or_insert_with(|| (fingerprint.clone(), time));
        if previous.0 != fingerprint {
            *previous = (fingerprint, time);
        }
        if time - previous.1 < 15_000.0 {
            return Ok(());
        }
        let run = &worker["run"];
        if waiting {
            return Ok(());
        }
        if run["taskDispatchKey"] == dispatch_key
            && !run["lastError"].text().starts_with("목표 전달 실패:")
        {
            if let Some(task) = next_task.as_ref().filter(|_| {
                now() - evidence_interval >= PROGRESS_DEADLINE
                    && run["interventionAt"].number() >= evidence_interval
                    && run["checkQueuedAt"].number() < evidence_interval
            }) {
                let current = terminals.automation_snapshot(&term_id.text());
                if state(current.as_ref()) == "idle"
                    && !current.as_ref().is_some_and(|screen| screen.held)
                {
                    let mut run = worker["run"].clone();
                    run["checkQueuedAt"] = now().into();
                    save_run(store, &mut review, &mut worker, run)?;
                    self.deliver(store, terminals, &mut review, &mut worker,
                        format!("\x1b[200~[콕핏 작업자 정체 점검]\n{}: {}\n5분간 새 검증 근거가 없습니다. 현재 보드와 실제 실행 결과·오류를 확인하세요. 이미 허용된 독립 작업은 감독의 답변을 기다리지 말고 이어가고, 실제 working/blocked/complete 상태를 보고하세요. 외부 작업은 임의 종료하거나 중복 실행하지 마세요. 모든 조건이 막히면 실제 작업·질문 ID에 의존성을 연결하세요. 변경 없는 상태 확인을 반복하지 마세요.\x1b[201~\r", task["id"].text(), task["text"].text()), false, agent)?;
                }
            }
            return Ok(());
        }
        if !(next_task.is_some() && run["status"] == V::from("blocked"))
            && run["lastSentAt"].truthy()
            && time - run["lastSentAt"].number() < cooldown(&worker, &dependencies)
        {
            return Ok(());
        }
        if !control::dispatch_enabled(&review, now()) {
            return Ok(());
        }
        let latest = terminals.automation_snapshot(&term_id.text());
        if state(latest.as_ref()) != "idle" || latest.as_ref().is_some_and(|screen| screen.held) {
            return Ok(());
        }
        let mut run = worker["run"].clone();
        run["status"] = "active".into();
        run["token"] = uuid().into();
        run["taskId"] = next_task
            .map(|task| task["id"].clone())
            .unwrap_or("".into());
        run["taskDispatchKey"] = dispatch_key;
        run["interventionAt"] = 0.0.into();
        run["checkQueuedAt"] = 0.0.into();
        run["blockedVerifiedAt"] = 0.0.into();
        run["dependencyKey"] = dependencies;
        run["lastSentAt"] = now().into();
        run["attempts"] = (run["attempts"].number() + 1.0).into();
        run["lastError"] = "".into();
        let mut planned = worker.clone();
        planned["run"] = run.clone();
        let message = worker_message::message(&board, &review, &assigned, &planned, port)
            .map_err(|message| Error(400, message))?;
        save_run(store, &mut review, &mut worker, run)?;
        self.deliver(
            store,
            terminals,
            &mut review,
            &mut worker,
            format!("\x1b[200~{message}\x1b[201~\r"),
            false,
            agent,
        )?;
        self.idle.remove(&key);
        Ok(())
    }
    fn deliver(
        &self,
        store: &Store,
        terminals: &Terminals,
        review: &mut V,
        worker: &mut V,
        data: String,
        resume: bool,
        agent: &str,
    ) -> Result<()> {
        let diagnostic = data.starts_with("\x1b[200~[콕핏 작업자 정체 점검]\n");
        if let Err(error) = terminals.send_worker_input(
            &worker["termId"].text(),
            data,
            resume,
            review,
            store,
            agent,
        ) {
            let latest = super::scoped(&store.read()?, &review["id"])?["review"].clone();
            let Some(current) = progress(&latest, &worker["termId"]).filter(|current| {
                current["goal"] == worker["goal"]
                    && current["run"]["token"] == worker["run"]["token"]
            }) else {
                return Ok(());
            };
            if diagnostic && current["run"]["checkQueuedAt"] != worker["run"]["checkQueuedAt"] {
                return Ok(());
            }
            *review = latest;
            *worker = current;
            let mut run = worker["run"].clone();
            if diagnostic {
                run["checkQueuedAt"] = 0.0.into();
            } else {
                run["taskDispatchKey"] = "".into();
            }
            run["lastError"] = V::from(format!(
                "{} 전달 실패: {error}",
                if diagnostic {
                    "정체 점검"
                } else {
                    "목표"
                }
            ))
            .cut(500);
            save_run(store, review, worker, run)?;
        }
        Ok(())
    }
}
fn ready(run: &mut V) {
    run["status"] = "ready".into();
    run["taskDispatchKey"] = "".into();
    run["blocker"] = "".into();
    run["alternatives"] = "".into();
    run["remaining"] = V::Array(vec![]);
    run["lastError"] = "".into();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_wakes_once_per_dependency_but_ready_work_and_failed_delivery_continue() {
        let dependencies = V::from("source-A");
        let mut run = object([
            ("status", V::from("blocked")),
            ("dependencyKey", dependencies.clone()),
            ("blocker", V::from("source required")),
            ("remaining", V::Array(vec![V::from("condition")])),
            ("attempts", 0.0.into()),
            ("reportedAt", 100.0.into()),
            ("lastSentAt", 50.0.into()),
        ]);
        assert!(waiting_for_dependency(&run, &dependencies));
        assert!(!waiting_for_dependency(&run, &V::from("source-B")));
        run["status"] = "active".into();
        run["attempts"] = 1.0.into();
        run["lastSentAt"] = 200.0.into();
        assert!(waiting_for_dependency(&run, &dependencies));
        run["reportedAt"] = 200.0.into();
        assert!(waiting_for_dependency(&run, &dependencies));
        run["lastError"] = "목표 전달 실패: changed composer".into();
        assert!(!waiting_for_dependency(&run, &dependencies));
        run["lastError"] = "".into();
        run["reportedAt"] = 300.0.into();
        assert!(!waiting_for_dependency(&run, &dependencies));
        run["reportedAt"] = 100.0.into();
        ready(&mut run);
        assert!(!waiting_for_dependency(&run, &dependencies));
    }
}
