import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function supervisorWatchDecision(review, terminal, termId, now, lastSentAt) {
  if (!review || review.termId !== termId || !['running', 'waiting'].includes(review.status)
      || (review.runUntil && review.runUntil <= now)) return 'inactive';
  if (!terminal) return 'offline';
  if (terminal.conversationHeld) return 'conversation-held';
  if (!terminal.activity || now - terminal.activity.observedAt > 15000) return 'stale-observation';
  if (terminal.activity.state !== 'idle') return terminal.activity.state || 'unknown';
  if (now - Math.max(lastSentAt, review.lastReviewedAt || 0, review.pendingSince || 0) < 300000) return 'cooldown';
  return 'nudge';
}

async function main() {
  const [supervisorId, termId, until, log] = process.argv.slice(2);
  const deadline = Date.parse(until);
  if (!/^S-[\w-]+$/.test(supervisorId || '') || !/^[\w.-]+$/.test(termId || '') || !isAbsolute(log || '')
      || !Number.isFinite(deadline) || deadline <= Date.now() || deadline - Date.now() > 86400000) {
    throw new Error('감독 ID, 고정 세션 ID, 24시간 이내 종료 ISO 시각, 로그 절대경로가 필요합니다.');
  }
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const record = action => appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), supervisorId, termId, action })}\n`, { mode: 0o600 });
  const request = async (path, data) => {
    const response = await fetch(`http://127.0.0.1:${process.env.COCKPIT_PORT || 3847}${path}`, { signal: AbortSignal.timeout(8000),
      ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  let lastSentAt = 0;
  record('started');
  while (Date.now() < deadline) {
    try {
      const [board, live] = await Promise.all([request(`/api/board?supervisorId=${supervisorId}`), request('/api/terminals?activity=1')]);
      const action = supervisorWatchDecision(board.review, live.terminals.find(term => term.termId === termId), termId, Date.now(), lastSentAt);
      if (action === 'nudge' && Date.now() < deadline) {
        await request(`/api/terminals/${termId}/input`, {
          supervision: { id: supervisorId, until: deadline, reviewedAt: board.review.lastReviewedAt, pendingSince: board.review.pendingSince },
          data: '[사용자 요청 지속 감독 점검]\n저장된 담당 목표와 미완료 조건을 확인하고 결과 취합·의존성 해소를 계속하세요. 작업자들은 감독 응답을 기다리지 않고 독립 작업을 이어가게 하세요. 완료한 검증을 반복하지 말고 새 결과·막힌 조건·다음 담당과 조치를 보드에 보고하세요. 중간 보고로 전체 업무를 끝내지 마세요. 실제 완료 조건을 모두 검증했을 때만 완료 처리하세요. 실행 중 외부 작업을 중복 실행하거나 사용자 정지·승인을 우회하지 마세요.' });
        lastSentAt = Date.now();
      }
      record(action);
    } catch (error) { record(`check-failed: ${error.message}`); }
    await delay(Math.max(0, Math.min(60000, deadline - Date.now())));
  }
  record('deadline-reached');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
