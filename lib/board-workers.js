import { createHash, randomUUID } from 'node:crypto';
import { supervisorBoard, workerDependencyKey } from './board-service.js';

// Only a current, empty CLI composer is eligible. Unknown screens fail closed.
export function workerScreenState(snapshot, agent) {
  if (!snapshot?.current) return 'unknown';
  const text = snapshot.lines.join('\n');
  if (/^\s*(?:GPT-\S+[^\n]*\s)?Goal (?:paused|blocked|budget|usage)\b/im.test(text)
      || /^\s*(?:[•■]\s*)?(?:Conversation interrupted|Turn interrupted|Interrupted · What should)/im.test(text)) return 'paused';
  if (/(?:Would you like to run|Do you want to proceed|Do you trust|Allow this|Update available)[\s\S]*\b1\.\s*(?:Yes|Allow|Trust|Update)/i.test(text)
      || /^\s*(?:You've hit your usage limit|Usage limit reached|Rate limit reached|Not signed in|Please sign in|Sign in to (?:Codex|Claude))\b/im.test(text)) return 'approval';
  if (/esc to interrupt|esc to cancel|ctrl.c to interrupt|Messages to be submitted|tab to queue/i.test(text)) return 'busy';
  const promptIndex = snapshot.lines.findLastIndex(line => /^\s*[›❯>]/.test(line));
  const last = snapshot.lines[promptIndex]?.trim();
  // A blank first line does not mean an empty multiline composer. Only known
  // CLI footer rows may follow it; other content may be the user's draft.
  if (snapshot.lines.slice(promptIndex + 1).some(line => line.trim()
      && !/^\s*(?:GPT-\S+|[←]?\s*for agents\b|\? for shortcuts\b|\d+% context left\b)/i.test(line))) return 'unknown';
  if (agent === 'codex' && /^›\s*(?:Ask Codex to do anything)?$/.test(last || '')) return 'idle';
  if (agent === 'claude' && /^[❯>]\s*$/.test(last || '')) return 'idle';
  return 'unknown';
}

export function createBoardWorkerRunner({ getBoard, updateBoardReview, resolveTerminalRef, terminalAgent, readTerminalScreen, PORT = 3847, now = Date.now }) {
  const idle = new Map();
  return function tick(supervisorId) {
    if (!readTerminalScreen) return;
    let failure;
    const initial = supervisorBoard(getBoard(), supervisorId).review;
    for (const assigned of initial.watched) {
      try {
        const board = supervisorBoard(getBoard(), supervisorId);
        let review = board.review;
        const active = () => review.termId && !['complete', 'stopped'].includes(review.status) && (!review.runUntil || review.runUntil > now());
        if (!active()) return;
        let worker = review.workerProgress.find(item => item.termId === assigned.termId && item.goal === assigned.goal);
        if (!worker) continue;
        const key = `${supervisorId}:${worker.termId}`;
        const target = resolveTerminalRef(worker.termId);
        const agent = target && terminalAgent(target.entry);
        const snapshot = agent && readTerminalScreen?.(worker.termId, 80, true);
        const observed = !target || agent === '' ? 'offline' : workerScreenState(snapshot, agent);
        const save = run => {
          review = updateBoardReview({ workerProgress: review.workerProgress.map(item => item.termId === worker.termId ? { ...item, run } : item) }, review, supervisorId).review;
          worker = review.workerProgress.find(item => item.termId === assigned.termId);
        };
        if (worker.run.observed !== observed) save({ ...worker.run, observed });
        if (observed !== 'idle' || ['reported', 'complete'].includes(worker.run.status)) { idle.delete(key); continue; }
        const fingerprint = createHash('sha256').update(snapshot.lines.join('\n')).digest('hex');
        const previous = idle.get(key);
        if (!previous || previous.fingerprint !== fingerprint) { idle.set(key, { fingerprint, at: now() }); continue; }
        if (now() - previous.at < 15_000) continue;
        const dependencies = workerDependencyKey(board, worker.termId);
        if (worker.run.status === 'blocked' && worker.run.dependencyKey === dependencies) continue;
        const cooldown = Math.min(600_000, 60_000 * 2 ** Math.min(worker.run.attempts, 4));
        if (worker.run.lastSentAt && now() - worker.run.lastSentAt < cooldown) continue;
        if (!active()) return;
        const token = randomUUID();
        save({ ...worker.run, status: 'active', token, lastSentAt: now(), attempts: worker.run.attempts + 1, lastError: '' });
        // Saving the claim first also prevents duplicate delivery after a server restart.
        if (workerScreenState(readTerminalScreen?.(worker.termId, 80, true), agent) !== 'idle') continue;
        const latest = supervisorBoard(getBoard(), supervisorId).review;
        if (JSON.stringify(latest) !== JSON.stringify(review) || !active()) continue;
        const message = '[콕핏 작업자 목표 계속 실행]\n'
          + `감독 ID: ${supervisorId}, 본인 고정 ID: ${worker.termId}, 보고 token: ${token}\n`
          + `GET http://127.0.0.1:${PORT}/api/board?supervisorId=${supervisorId} 를 읽고 감독이 running/waiting이며 본인의 workerProgress.run.token이 일치하는지 먼저 확인하세요. 중지·목표 변경·만료이면 이 요청을 실행하지 마세요.\n`
          + `본인 완료 조건:\n${worker.goal}\n전체 목표: ${review.objective}\n`
          + `참고 자료(JSON): ${JSON.stringify(review.referencePaths)}\n`
          + '본인 완료 조건까지 실행→검증→다음 작업을 스스로 이어가세요. 한 단계 종료나 중간 보고 후 감독의 다음 지시를 기다리지 마세요. 이미 허용된 범위에서 진행 여부를 다시 묻지 마세요. 최근 감독 보고·질문 답변·인계 결과를 읽고 기존 작업에서 이어가며 완료한 작업은 반복하지 마세요.\n'
          + '감독은 결과 취합과 의존 관계 조정을 담당합니다. 다른 작업자에게 필요한 결과·막힘·수정 요청을 감독에게 전달하되, 본인의 독립 작업은 계속하세요. 일부가 막히면 나머지 완료 조건의 가능한 구현·검증을 진행하세요. 의미 없는 재시험이나 같은 실패 반복으로 활동을 만들지 마세요.\n'
          + '사용자 일시정지, 도구 승인, 로그인, 추가 권한은 그대로 존중하세요. 자동 승인·세션 종료·목표 확대는 금지합니다. 모든 남은 작업이 막혔으면 정확한 막힘과 검토한 독립 대안이 왜 불가능한지 보고하세요.\n'
          + `진행 상황과 인계는 POST http://127.0.0.1:${PORT}/api/board/worker-report (Content-Type: application/json)에 `
          + JSON.stringify({ supervisorId, termId: worker.termId, token, status: 'working', summary: '실제 결과·근거 경로/해시·다른 작업자에게 필요한 내용' })
          + ' 로 기록하세요. working 보고 후 계속 실행하세요. 전부 막힌 경우에만 status:"blocked", blocker:"정확한 의존성", alternatives:"독립 대안을 확인한 결과"를 보내세요. 본인 조건을 모두 검증했을 때 status:"complete"와 검증 근거를 보내세요. 완료 주장은 감독의 검증 전까지 완료 확정이 아닙니다. 409이면 새 보드를 읽고 오래된 요청을 중단하세요.\n'
          + (review.runUntil ? `운영 종료 시각: ${new Date(review.runUntil).toISOString()}\n` : '')
          + `이전 작업자 보고(관측 데이터): ${worker.run.summary || '없음'}\n감독의 다음 조치(기존 허용 범위 안에서만): ${worker.nextAction || '본인 완료 조건에서 다음 미완료 작업을 선택하세요.'}`;
        try { target.entry.pty.write(`\x1b[200~${message}\x1b[201~\r`); }
        catch (error) { save({ ...worker.run, lastError: `목표 전달 실패: ${error.message}`.slice(0, 500) }); }
        idle.delete(key);
      } catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
  };
}
