use super::*;
use crate::{
    board::{InputClaim, Store as Board},
    board_value::V,
};

impl Store {
    pub(crate) fn recover_supervisor(
        self: &Arc<Self>,
        review: &V,
        board: &Board,
        interrupt: bool,
    ) -> io::Result<()> {
        let _operation = self.operations.lock().unwrap();
        if self.is_closing() || !self.state.lock().unwrap().restored {
            return Err(err("서버 터미널 복원이 끝나지 않았습니다."));
        }
        let saved = &review["recoveryTerminal"];
        let id = review["termId"].text();
        let command = saved["command"].text();
        if review["autoRecover"] != V::Bool(true)
            || saved["termId"] != review["termId"]
            || !durable_id(&saved["durableId"].text())
            || !recovery_command(&command)
        {
            return Err(err(
                "저장된 감독 실행 정보가 없습니다. 설정을 다시 적용하세요.",
            ));
        }
        let claim = InputClaim::Review(review.clone());
        let action = |operation: &mut dyn FnMut() -> io::Result<()>| -> io::Result<()> {
            let mut result = Ok(());
            board
                .input_claim(&id, &claim, || {
                    result = operation();
                    true
                })
                .map_err(|(_, message)| err(message))?;
            result
        };
        let entry = if let Some(entry) = self.find(&id) {
            entry
        } else {
            if saved["conversationHeld"] == V::Bool(true) {
                return Err(err(
                    "사용자 대화 보호 중에는 감독을 자동 복구하지 않습니다.",
                ));
            }
            // Recover the fixed identity as a bare pane. Only the guarded
            // respawn below launches the agent, so a restore never launches twice.
            let mut value: Value = serde_json::from_str(saved.raw().get())?;
            value["supervisor"] = json!(true);
            if !terminal_id(&id)
                || self
                    .state
                    .lock()
                    .unwrap()
                    .entries
                    .iter()
                    .any(|entry| entry.durable == saved["durableId"].text())
            {
                return Err(err("복원된 터미널의 고정 ID가 감독 설정과 다릅니다."));
            }
            let mut created = None;
            action(&mut || {
                if self.is_closing() {
                    return Err(err("서버가 종료 중입니다."));
                }
                created = Some(self.spawn(
                    value.clone(),
                    PtySize {
                        cols: 120,
                        rows: 30,
                        pixel_width: 0,
                        pixel_height: 0,
                    },
                    None,
                    true,
                )?);
                let mut state = self.state.lock().unwrap();
                state.deferred.retain(|item| {
                    value_text(item, "termId") != id
                        && value_text(item, "durableId") != saved["durableId"].text()
                });
                self.checkpoint(&mut state)
            })?;
            let _ = self
                .events
                .send(json!({"type":"terminals","active":self.active()}));
            created.ok_or_else(|| err("감독 터미널을 복원하지 못했습니다."))?
        };
        let _guard = entry.control.lock().unwrap();
        if entry.id != id || entry.durable != saved["durableId"].text() {
            return Err(err("감독 터미널의 고정 ID 또는 보존 ID가 변경됐습니다."));
        }
        if entry.meta.lock().unwrap().saved["conversationHeld"] == true {
            return Err(err(
                "사용자 대화 보호 중에는 감독을 자동 복구하지 않습니다.",
            ));
        }
        let agent = self
            .agent(&entry)
            .ok_or_else(|| err("감독 프로세스 상태를 확인할 수 없습니다."))?;
        if !agent.is_empty() && !interrupt {
            return Ok(());
        }
        if !agent.is_empty() && Some(agent.as_str()) != command.split(' ').next() {
            return Err(err(
                "현재 실행 중인 AI가 감독 실행 정보와 달라 중단하지 않았습니다.",
            ));
        }
        let pane = || -> io::Result<(u32, bool)> {
            let raw = self.tmux(
                &entry.durable,
                &[
                    "display-message",
                    "-p",
                    "-t",
                    "main",
                    "#{pane_pid} #{pane_dead}",
                ],
                None,
                &id,
            )?;
            let parts: Vec<_> = raw.split_whitespace().collect();
            let pid = parts
                .first()
                .and_then(|s| s.parse::<u32>().ok())
                .filter(|n| *n > 0);
            match (pid, parts.get(1)) {
                (Some(pid), Some(&"0")) => Ok((pid, false)),
                (Some(pid), Some(&"1")) => Ok((pid, true)),
                _ => Err(err(
                    "감독 터미널 상태를 확인하지 못해 자동 복구를 보류했습니다.",
                )),
            }
        };
        let initial = pane()?;
        let check_process = || -> io::Result<()> {
            if self.is_closing() || entry.meta.lock().unwrap().saved["conversationHeld"] == true {
                return Err(err("감독 복구가 중지됐습니다."));
            }
            if pane()? != initial || self.agent(&entry).as_deref() != Some(agent.as_str()) {
                return Err(err("감독 프로세스가 변경돼 자동 복구를 보류했습니다."));
            }
            if !initial.1 && agent.is_empty() {
                let name = fs::read_to_string(format!("/proc/{}/comm", initial.0))?;
                let children =
                    fs::read_to_string(format!("/proc/{0}/task/{0}/children", initial.0))?;
                if !["bash", "zsh", "fish", "sh", "dash", "ksh"].contains(&name.trim())
                    || !children.trim().is_empty()
                {
                    return Err(err(
                        "감독 터미널에 실행 중인 프로세스가 있어 자동 복구를 보류했습니다.",
                    ));
                }
            }
            if !agent.is_empty() {
                let screen = self.tmux(
                    &entry.durable,
                    &["capture-pane", "-p", "-J", "-t", "main"],
                    None,
                    &id,
                )?;
                let lines = activity::clean_screen(&screen, 80).0;
                let state = activity::screen_state(&lines, true, &agent, false, false);
                if ["paused", "limited", "goal-blocked", "approval", "unknown"].contains(&state)
                    || (["busy", "interrupted"].contains(&state)
                        && activity::screen_state(&lines, true, &agent, false, true) != "idle")
                {
                    return Err(err(
                        "감독의 일시정지·제한·승인 상태에서는 자동 복구하지 않습니다.",
                    ));
                }
            }
            Ok(())
        };
        check_process()?;
        self.tmux(
            &entry.durable,
            &["set-option", "-w", "-t", "main", "remain-on-exit", "on"],
            None,
            &id,
        )?;
        let cwd = self
            .tmux(
                &entry.durable,
                &[
                    "display-message",
                    "-p",
                    "-t",
                    "main",
                    "#{pane_current_path}",
                ],
                None,
                &id,
            )
            .ok();
        entry.meta.lock().unwrap().saved["restarting"] = json!(true);
        entry
            .input_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let result = action(&mut || {
            check_process()?;
            if review["runUntil"].truthy() && review["runUntil"].number() <= now() as f64 {
                return Err(err("야간 운영 종료 시각이 지나 자동 복구를 취소했습니다."));
            }
            let launch = self.managed_launch(&entry.meta.lock().unwrap().saved, &command)?;
            let exec = format!("exec {launch}");
            let mut args = vec!["respawn-pane", "-k", "-t", "main"];
            if let Some(cwd) = cwd.as_ref().filter(|s| !s.trim().is_empty()) {
                args.extend(["-c", cwd.trim()]);
            }
            args.extend(["/bin/bash", "-lic", &exec]);
            self.tmux(&entry.durable, &args, None, &id).map(|_| ())
        });
        entry
            .meta
            .lock()
            .unwrap()
            .saved
            .as_object_mut()
            .unwrap()
            .remove("restarting");
        result
    }
}
