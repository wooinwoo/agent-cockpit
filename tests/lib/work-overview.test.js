import test from 'node:test';
import assert from 'node:assert/strict';
import { workOverviewRows } from '../../js/work-overview-state.js';

test('independent current assignments outrank stopped history and expose worker-owned next actions', () => {
  const board = { supervisors: [
    { id: 'old', status: 'stopped', watched: [{ termId: 'one', goal: 'old' }], workerProgress: [] },
    { id: 'current', status: 'stopped', workerDispatch: 'running', watched: [{ termId: 'one', goal: 'current' }],
      workerProgress: [{ termId: 'one', goal: 'current', startedAt: 1, nextAction: '옛 감독 지시', run: { status: 'active', progressAt: 399000, nextAction: '작업자가 정한 다음 단계' } }] },
  ] };
  const row = workOverviewRows(board, [{ termId: 'one' }], 400000)[0];
  assert.equal(row.supervisorId, 'current'); assert.equal(row.goal, 'current');
  assert.equal(row.dispatching, true); assert.equal(row.stalled, false);
  assert.equal(row.next, '작업자가 정한 다음 단계');
  assert.equal(workOverviewRows(board, [{ termId: 'one', conversationHeld: true }], 400000)[0].dispatching, false);
  assert.equal(workOverviewRows(board, [{ termId: 'one' }], 700000)[0].stalled, true);
});

test('overview includes missing sessions, isolates checklists, and never treats checked items as verified goals', () => {
  const board = { supervisors: [{ termId: 'manager', name: '출시', status: 'running', watched: [
    { termId: 'one', goal: '목표', objective: '실제 업무', priority: 3 }, { termId: 'missing', goal: '미연결 목표' },
  ], workerProgress: [{ termId: 'one', goal: '목표', run: { status: 'reported', reportedAt: 1000 } }] }], tasks: [
    { termId: 'one', done: true, text: '이전 완료', updatedAt: 10 }, { termId: 'one', done: true, text: '최근 완료', updatedAt: 20 },
    { termId: 'one', done: false, text: '진행 중' }, { termId: 'one', done: true, kind: 'question' }, { termId: 'other', done: true },
  ] };
  const rows = workOverviewRows(board, [{ termId: 'one', alias: 'ai1' }, { termId: 'manager' }], 2000);
  const one = rows.find(row => row.termId === 'one');
  assert.equal(one.objective, '실제 업무');
  assert.equal(one.done, 2); assert.equal(one.total, 3);
  assert.deepEqual(one.completed.map(task => task.text), ['최근 완료', '이전 완료']);
  assert.equal(one.label, '완료 검증 대기'); assert.notEqual(one.state, 'done');
  assert.equal(one.attention, true);
  assert.equal(rows.find(row => row.termId === 'missing').label, '세션 연결 없음');
  assert.equal(rows.at(-1).termId, 'manager');
});

test('pause and conversation take precedence over old reports; priority orders equivalent states', () => {
  const board = { supervisors: [{ status: 'running', watched: [
    { termId: 'one', priority: 3, goal: 'new', paused: true }, { termId: 'two', priority: 1, goal: 'two' },
  ], workerProgress: [{ termId: 'one', goal: 'old', run: { status: 'complete' } },
    { termId: 'two', goal: 'two', run: { status: 'active' } }] }] };
  const rows = workOverviewRows(board, [{ termId: 'one' }, { termId: 'two', conversationHeld: true }]);
  assert.equal(rows[0].termId, 'two'); assert.equal(rows[0].label, '사용자 대화 중');
  assert.equal(rows[1].label, '자동 지시 정지'); assert.notEqual(rows[1].state, 'done');
});

test('unassigned sessions show available summaries without inventing verified progress', () => {
  const [row] = workOverviewRows({}, [{ termId: 'solo' }], 2000, { solo: { text: '테스트 실패 원인 조사', goal: '테스트 복구', at: 1000 } });
  assert.equal(row.task, '테스트 실패 원인 조사'); assert.equal(row.objective, '테스트 복구');
  assert.equal(row.reportedAt, 1000); assert.notEqual(row.state, 'done');
});

test('current observations override saved activity, but never overwrite verified completion', () => {
  const board = { supervisors: [{ id: 'S-0001', status: 'stopped', workerDispatch: 'running', watched: [{ termId: 'one', goal: 'goal' }],
    workerProgress: [{ termId: 'one', goal: 'goal', run: { status: 'complete', reportedAt: 1000 } }] }] };
  const row = (state, observedAt = 1900) => workOverviewRows(board, [{ termId: 'one', activity: { state, observedAt } }], 2000)[0];
  assert.equal(row('busy').state, 'busy');
  assert.equal(row('busy').goalComplete, true);
  assert.equal(row('offline').label, 'AI 실행 안 됨');
  assert.equal(row('offline').goalComplete, true);
  assert.equal(row('approval').attention, true);
  assert.equal(row('idle').dispatching, true);
  assert.notEqual(row('busy', -20000).state, 'busy');
  board.supervisors[0].workerProgress[0].run.status = 'active';
  assert.notEqual(workOverviewRows(board, [{ termId: 'one' }], 2000)[0].state, 'busy');
});
