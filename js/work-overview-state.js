import { getSessionActivity } from './agent-wall-state.js';
import { workerAssignment, workerDispatchEnabled } from './worker-settings.js';

// A saved report is evidence of a report, not evidence that a process is still running.
export function workOverviewRows(board, terminals, now = Date.now(), summaries = {}) {
  const reviews = board?.supervisors || (board?.review ? [board.review] : []);
  const known = new Map(terminals.map(term => [term.termId, term]));
  for (const review of reviews) {
    for (const item of [review, ...(review.watched || [])]) {
      if (item.termId && !known.has(item.termId)) known.set(item.termId, { ...item, offline: true });
    }
  }
  return [...known.values()].map(term => {
    const activity = getSessionActivity({ termId: term.termId, board, now, summary: summaries[term.termId] });
    const assigned = workerAssignment(reviews, term.termId, now);
    const target = assigned?.watched.find(w => w.termId === term.termId);
    const worker = assigned?.workerProgress?.find(w => w.termId === term.termId && w.goal === target?.goal);
    const managed = reviews.find(r => r.termId === term.termId);
    const tasks = (board?.tasks || []).filter(task => task.termId === term.termId && task.kind !== 'question');
    const completed = tasks.filter(task => task.done).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const pending = tasks.filter(task => !task.done);
    const nextTask = pending.find(task => task.status === 'running') || pending.find(task => task.status !== 'blocked');
    const queue = { ready: pending.filter(task => !task.status || task.status === 'ready').length,
      running: pending.filter(task => task.status === 'running').length, blocked: pending.filter(task => task.status === 'blocked').length };
    const goalComplete = !pending.length && (worker?.run?.status === 'complete' || (!target && managed?.status === 'complete'));
    let label = activity.label, state = activity.state;
    if (label === '상태 확인 중' && worker?.run?.status === 'active') { label = '작업 진행 보고'; state = 'waiting'; }
    if (managed && !target) {
      label = { running: '감독 운영 중', waiting: '감독 확인 대기', stopped: '감독 중지', complete: '감독 완료' }[managed.status] || '감독 상태 확인';
      state = managed.status === 'complete' ? 'done' : 'waiting';
    }
    if (target?.paused) { label = '자동 지시 정지'; state = 'waiting'; }
    if (term.conversationHeld) { label = '사용자 대화 중'; state = 'waiting'; }
    if (term.offline) { label = '세션 연결 없음'; state = 'waiting'; }
    const runtime = term.activity;
    const fresh = runtime && now - runtime.observedAt <= 15000;
    const runtimeLabels = { busy: '실행 중', idle: '입력 대기', approval: '승인·로그인 대기', offline: 'AI 실행 안 됨', unknown: '실행 상태 확인 불가', paused: '목표 일시정지', limited: '사용량·예산 제한', 'goal-blocked': '목표 막힘', interrupted: '실행 중단', restarting: '재시작 중' };
    if (runtime && !term.offline && !term.conversationHeld) {
      label = fresh ? runtimeLabels[runtime.state] || runtimeLabels.unknown : '관측 오래됨 · 연결 확인';
      state = fresh && runtime.state === 'busy' ? 'busy' : fresh && runtime.state === 'idle' ? (goalComplete ? 'done' : 'idle') : 'waiting';
    }
    if (!runtime && state === 'busy') { state = 'waiting'; label = '진행 보고 · 실행 확인 필요'; }
    const dispatching = assigned ? workerDispatchEnabled(assigned, now) && !target?.paused && !term.conversationHeld : false;
    const attention = Boolean(term.offline || activity.blocker || activity.stalled || worker?.run?.status === 'reported'
      || (fresh ? ['approval', 'offline', 'limited', 'goal-blocked', 'interrupted'].includes(runtime.state) : worker?.run?.observed === 'approval'));
    return { ...activity, termId: term.termId, alias: term.alias || target?.alias || term.projectId || term.termId,
      objective: target?.objective || managed?.objective || activity.goal || '목표를 등록하세요',
      label, state, attention, offline: Boolean(term.offline), priority: target?.priority || 2,
      total: tasks.length, done: completed.length, completed, queue,
      goalComplete, dispatching, supervisorId: assigned?.id || '', runtimeAt: runtime?.observedAt || 0,
      runtimeSource: runtime ? '현재 화면 관측' : '최근 보고 기준',
      artifact: worker?.evidence || '',
      reportLabel: worker?.run?.status === 'blocked' ? nextTask ? '실행 가능한 작업 있음' : worker.run.blockedVerifiedAt ? '대기 근거 검토됨' : '전체 대기 검토 필요'
        : { ready: '착수 대기', active: '진행 보고', reported: '완료 검증 대기', complete: '목표 완료 확인' }[worker?.run?.status] || '',
      next: nextTask?.text || activity.nextAction || '다음 작업 미등록',
    };
  }).sort((a, b) => Number(b.attention) - Number(a.attention) || Number(a.state === 'done') - Number(b.state === 'done')
    || a.priority - b.priority || a.alias.localeCompare(b.alias, 'ko', { numeric: true }));
}
