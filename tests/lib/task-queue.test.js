import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createBoardService, workerDependencyKey } from '../../lib/board-service.js';
import { reviewInputKey, taskDispatchKey } from '../../lib/board-task-state.js';
import { createBoardWorkerRunner } from '../../lib/board-workers.js';
import { createBoardReviewer } from '../../lib/board-review.js';

function setup(t) {
  const dir = mkdtempSync('/tmp/cockpit-task-queue-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = `${dir}/board.json`, service = createBoardService(file);
  service.updateBoardReview({ workerDispatch: 'running', watched: [{ termId: 'worker', goal: '구현·검증' }] });
  const review = service.getBoard().review;
  service.updateBoardReview({ workerProgress: review.workerProgress.map(w => ({ ...w, run: { ...w.run, token: 'token' } })) });
  const task = service.addBoardTask('허용된 원전을 직접 조사', undefined, 'task', 'user', 'S-0001', 'worker').task;
  const question = service.addBoardTask('외부 조건 확인', undefined, 'question').task;
  const report = () => service.reportBoardWorker({ termId: 'worker', token: 'token', status: 'blocked', summary: '대기 주장',
    blocker: '외부 조건', alternatives: '독립 작업 확인', remaining: [{ condition: '구현·검증', blocker: '외부 조건', nextAction: '원전 적용' }] });
  return { ...service, file, task, question, report, restart: () => createBoardService(file) };
}

test('an unfinished runnable item prevents whole-worker waiting and unearned completion', t => {
  const h = setup(t);
  assert.throws(h.report, /실행 가능한.*T-/);
  h.updateBoardTask(h.task.id, { status: 'running' });
  assert.throws(h.report, /실행 가능한.*T-/);
  assert.throws(() => h.reportBoardWorker({ termId: 'worker', token: 'token', status: 'complete', summary: '완료 주장',
    artifact: '/result', version: 'v1', result: 'PASS' }), /미완료.*T-/);
});

test('blocked tasks need an unresolved real dependency and cannot form a cycle', t => {
  const h = setup(t);
  assert.throws(() => h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '자료 없음' }), /대기 항목/);
  assert.throws(() => h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '자료 없음', waitFor: ['T-9999'] }), /대기 항목/);
  const other = h.addBoardTask('공급할 원전', undefined, 'task', 'user', 'S-0001', 'supplier').task;
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '정확한 원전 공급 필요', waitFor: [other.id] });
  assert.throws(() => h.updateBoardTask(other.id, { status: 'blocked', blocker: '결과 대기', waitFor: [h.task.id] }), /순환/);
  h.updateBoardTask(other.id, { done: true });
  assert.equal(h.getBoard().tasks.find(x => x.id === h.task.id).status, 'ready');
  assert.throws(() => h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '결과 대기', waitFor: [other.id] }), /완료/);
});

test('dependency answers release a task once, survive restart, and never count as goal progress', t => {
  const h = setup(t);
  const block = () => h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '답변 검토 필요', waitFor: [h.question.id] });
  block(); h.report();
  assert.equal(h.restart().getBoard().tasks.find(x => x.id === h.task.id).status, 'blocked');
  h.updateBoardTask(h.question.id, { text: h.question.text });
  assert.equal(h.getBoard().tasks.find(x => x.id === h.task.id).status, 'blocked', 'timestamp-only updates remain quiet');
  h.updateBoardTask(h.question.id, { answer: '기존 허용 경로에 새 원전 있음' });
  assert.equal(h.restart().getBoard().tasks.find(x => x.id === h.task.id).status, 'ready');
  assert.throws(h.report, /실행 가능한/);
  block(); h.report();
  h.updateBoardTask(h.question.id, { answer: '기존 허용 경로에 새 원전 있음' });
  assert.equal(h.getBoard().tasks.find(x => x.id === h.task.id).status, 'blocked', 'the same answer does not wake it twice');
  assert.equal(h.getBoard().review.workerProgress[0].run.progressAt, 0);
  h.deleteBoardTask(h.question.id);
  assert.equal(h.getBoard().tasks.find(x => x.id === h.task.id).status, 'ready', 'deleted dependency requires reassessment');
});

test('rewriting an unanswered question never releases or redispatches blocked work', t => {
  const h = setup(t);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '답변 필요', waitFor: [h.question.id] });
  h.report();
  h.updateBoardReview({ termId: 'manager', workerDispatch: 'linked', pendingSince: 9, intervalMinutes: 1 });
  h.reportBoardReview(9, { status: 'waiting', report: '실제 답변 대기 확인' });
  const before = h.getBoard();
  h.updateBoardTask(h.question.id, { text: '외부 조건을 선택해서 답변해 주세요.' });
  const after = h.restart().getBoard();
  assert.equal(after.tasks.find(x => x.id === h.task.id).status, 'blocked');
  assert.equal(workerDependencyKey(after, 'worker'), workerDependencyKey(before, 'worker'));
  assert.equal(reviewInputKey(after, after.review), before.review.lastReviewKey);
  let now = Date.now() + 3_600_000, writes = [];
  const tick = createBoardReviewer({ ...h.restart(), now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: id => ({ entry: { pty: { write: data => writes.push({ id, data }) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  tick(); now += 15_000; tick();
  assert.equal(writes.length, 0);
});

test('legacy question dependency hashes migrate without releasing valid waits', t => {
  const h = setup(t);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '답변 필요', waitFor: [h.question.id] });
  const board = h.getBoard();
  const legacy = createHash('sha256').update(JSON.stringify([[h.question.id, false, '', h.question.text, []]])).digest('hex');
  board.tasks.find(x => x.id === h.task.id).waitKey = legacy;
  h.replaceBoard(board);
  const migrated = h.restart().getBoard().tasks.find(x => x.id === h.task.id);
  assert.equal(migrated.status, 'blocked');
  assert.notEqual(migrated.waitKey, legacy);
  h.updateBoardTask(h.question.id, { text: '답변 요청 문구만 수정' });
  assert.equal(h.restart().getBoard().tasks.find(x => x.id === h.task.id).status, 'blocked');
  h.updateBoardTask(h.question.id, { answer: '새 원전 공급됨' });
  assert.equal(h.restart().getBoard().tasks.find(x => x.id === h.task.id).status, 'ready');
});

test('routine task acknowledgements and worker status corrections do not recall the supervisor', t => {
  const h = setup(t);
  h.updateBoardReview({ termId: 'manager', workerDispatch: 'paused', pendingSince: 10, intervalMinutes: 1 });
  h.reportBoardReview(10, { report: '현재 작업과 목표 확인' });
  const before = h.getBoard();
  h.updateBoardTask(h.task.id, { status: 'running' });
  h.updateBoardReview({ workerProgress: before.review.workerProgress.map(w => ({ ...w, run: { ...w.run,
    status: 'active', blocker: '표현 정리', remaining: [{ condition: '검증', blocker: '표현 정리', nextAction: '계속' }] } })) });
  let now = Date.now() + 120_000, writes = [];
  const tick = createBoardReviewer({ ...h, now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: id => ({ entry: { pty: { write: data => writes.push({ id, data }) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  tick(); tick();
  assert.equal(writes.length, 0);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '실제 원전 미공급', waitFor: [h.question.id] });
  tick();
  assert.equal(writes.filter(x => x.id === 'manager').length, 1, 'a newly blocked task still reaches the supervisor');
});

test('a worker without a checklist still alerts its supervisor on a new blocked state', t => {
  const h = setup(t);
  h.deleteBoardTask(h.task.id);
  const before = h.getBoard();
  const key = reviewInputKey(before, before.review);
  h.report();
  const blocked = h.getBoard();
  assert.notEqual(reviewInputKey(blocked, blocked.review), key);
  h.reportBoardWorker({ termId: 'worker', token: 'token', status: 'blocked', summary: '같은 상태의 표현 정리',
    blocker: '같은 미공급 조건', alternatives: '독립 작업 없음', remaining: [{ condition: '검증', blocker: '미공급', nextAction: '답변 적용' }] });
  const repeated = h.getBoard();
  assert.equal(reviewInputKey(repeated, repeated.review), reviewInputKey(blocked, blocked.review));
});

test('legacy whole-goal waits and acknowledged supervisors stay quiet across an upgrade', t => {
  const h = setup(t);
  h.deleteBoardTask(h.task.id); h.report();
  h.updateBoardReview({ termId: 'manager', workerDispatch: 'linked', pendingSince: 11, intervalMinutes: 1 });
  h.reportBoardReview(11, { status: 'waiting', report: '실제 외부 조건 대기' });
  const old = h.getBoard(), worker = old.review.workerProgress[0];
  const legacy = createHash('sha256').update(JSON.stringify([
    old.tasks.map(task => [task.id, task.answer || '', task.done, task.text, task.status || '', task.waitKey || '']),
    [], old.review.referencePaths])).digest('hex');
  worker.run.dependencyKey = legacy;
  worker.run.taskDispatchKey = taskDispatchKey(old, old.review, old.review.watched[0], worker, undefined, legacy);
  old.review.lastReviewKey = reviewInputKey(old, old.review, true);
  old.supervisors[0] = old.review;
  writeFileSync(h.file, JSON.stringify(old));
  const restarted = h.restart(), migrated = restarted.getBoard();
  assert.equal(migrated.review.workerProgress[0].run.status, 'blocked');
  assert.notEqual(migrated.review.workerProgress[0].run.dependencyKey, legacy);
  assert.equal(migrated.review.lastReviewKey, reviewInputKey(migrated, migrated.review));
  let now = Date.now() + 3_600_000, writes = [];
  const tick = createBoardReviewer({ ...restarted, now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: id => ({ entry: { pty: { write: data => writes.push({ id, data }) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  tick(); now += 15_000; tick();
  assert.equal(writes.length, 0);
  restarted.updateBoardTask(h.question.id, { text: '같은 질문의 문구 정리' });
  tick(); now += 15_000; tick();
  assert.equal(writes.length, 0);
  restarted.updateBoardTask(h.question.id, { answer: '새 원전 도착' });
  tick(); now += 15_000; tick();
  assert.equal(writes.filter(x => x.id === 'manager').length, 1);
  assert.equal(writes.filter(x => x.id === 'worker').length, 1);
});

test('a browser kept open before upgrade cannot release a wait by editing question wording', t => {
  const h = setup(t);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '답변 필요', waitFor: [h.question.id] });
  const old = h.getBoard();
  old.tasks.find(x => x.id === h.task.id).waitKey = createHash('sha256').update(JSON.stringify([
    [h.question.id, false, '', h.question.text, []]])).digest('hex');
  writeFileSync(h.file, JSON.stringify(old));
  const restarted = h.restart();
  assert.equal(restarted.getBoard().tasks.find(x => x.id === h.task.id).status, 'blocked');
  const edited = structuredClone(old);
  edited.tasks.find(x => x.id === h.question.id).text = '문구만 수정한 기존 브라우저';
  restarted.replaceBoardIfRevision(edited, old.revision, old);
  assert.equal(restarted.getBoard().tasks.find(x => x.id === h.task.id).status, 'blocked');
  edited.tasks.find(x => x.id === h.question.id).answer = '실제 새 답변';
  restarted.replaceBoardIfRevision(edited, old.revision, old);
  assert.equal(restarted.getBoard().tasks.find(x => x.id === h.task.id).status, 'ready');
});

test('an independent ready item is dispatched despite an older whole-worker block', t => {
  const h = setup(t);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '외부 조건', waitFor: [h.question.id] });
  h.report();
  const independent = h.addBoardTask('독립적인 collector 구현', undefined, 'task', 'user', 'S-0001', 'worker').task;
  let now = Date.now(), writes = [];
  const tick = createBoardWorkerRunner({ ...h, now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: () => ({ entry: { pty: { write: data => writes.push(data) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  tick('S-0001'); now += 15000; tick('S-0001');
  assert.equal(writes.length, 1);
  assert.equal(h.getBoard().review.workerProgress[0].run.taskId, independent.id);
  assert.match(writes[0], /이번에 이어갈 체크리스트.*독립적인 collector 구현/);
  h.updateBoardReview({ watched: [{ termId: 'worker', goal: '구현·검증', paused: true }] });
  now += 3_600_000; tick('S-0001');
  assert.equal(writes.length, 1, 'a runnable item never overrides a user pause');
});

test('old note editors preserve dependency state and checkbox reopening still works', t => {
  const h = setup(t);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '외부 조건', waitFor: [h.question.id] });
  const base = h.getBoard(), edited = structuredClone(base);
  for (const task of edited.tasks) for (const key of ['status', 'blocker', 'waitFor', 'waitKey']) delete task[key];
  edited.note.content = '다른 메모 수정';
  h.replaceBoardIfRevision(edited, base.revision, base);
  assert.equal(h.getBoard().tasks.find(task => task.id === h.task.id).status, 'blocked');
  h.updateBoardTask(h.task.id, { done: true });
  const completed = h.getBoard(), reopen = structuredClone(completed);
  reopen.tasks.find(task => task.id === h.task.id).done = false;
  h.replaceBoardIfRevision(reopen, completed.revision, completed);
  assert.equal(h.getBoard().tasks.find(task => task.id === h.task.id).status, 'ready');
});

test('a changed dependency rejects a stale blocking form without losing the ready state', t => {
  const h = setup(t);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '외부 조건', waitFor: [h.question.id] });
  const before = h.getBoard().tasks.find(task => task.id === h.task.id);
  h.updateBoardTask(h.question.id, { answer: '새 원전 전달됨' });
  assert.throws(() => h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '오래된 대기 조건', waitFor: [h.question.id],
    expectedUpdatedAt: before.updatedAt, expectedStatus: before.status }), /작업 상태가 다른 곳/);
  assert.equal(h.getBoard().tasks.find(task => task.id === h.task.id).status, 'ready');
});

test('a task is delivered once across unchanged reports and restart; new work and answers wake it', t => {
  const h = setup(t);
  let now = Date.now(), writes = [], diagnostics = [];
  const options = { ...h, now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: () => ({ entry: { pty: { write: data => (data.includes('[콕핏 작업자 정체 점검]') ? diagnostics : writes).push(data) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) };
  let tick = createBoardWorkerRunner(options);
  const step = () => { tick('S-0001'); now += 15_000; tick('S-0001'); };
  step();
  const token = h.getBoard().review.workerProgress[0].run.token;
  h.updateBoardTask(h.task.id, { status: 'running' });
  h.reportBoardWorker({ termId: 'worker', token, status: 'working', summary: '같은 단계', nextAction: '계속 구현' });
  now += 3_600_000; step();
  tick = createBoardWorkerRunner({ ...options, ...h.restart() }); step();
  assert.equal(writes.length, 1, 'state acknowledgements, time and restart do not replay a task');
  assert.equal(diagnostics.length, 1, 'an idle unfinished queue receives one diagnosis without depending on a manager');
  assert.match(diagnostics[0], new RegExp(h.task.id));
  const next = h.addBoardTask('다음 독립 작업', undefined, 'task', 'user', 'S-0001', 'worker').task;
  h.updateBoardTask(h.task.id, { done: true }); step();
  assert.equal(writes.length, 2);
  assert.equal(h.getBoard().review.workerProgress[0].run.taskId, next.id);
  h.updateBoardTask(next.id, { status: 'blocked', blocker: '새 원전 필요', waitFor: [h.question.id] });
  h.updateBoardTask(h.question.id, { answer: '새 원전 도착' }); now += 120_000; step();
  assert.equal(writes.length, 3);
  now += 3_600_000; step();
  assert.equal(writes.length, 3, 'one changed answer creates one delivery');
  tick = createBoardWorkerRunner({ ...options, ...h.restart() }); step();
  assert.equal(diagnostics.length, 2, 'the new evidence interval permits one new diagnosis; restart cannot repeat it');
});

test('supervisor completion cannot omit workState to bypass pending checklist validation', t => {
  const h = setup(t);
  h.updateBoardReview({ termId: 'manager', pendingSince: 7 });
  assert.throws(() => h.reportBoardReview(7, { status: 'complete', report: '완료 주장',
    progress: [{ termId: 'worker', artifact: '/result', version: 'v1', result: 'PASS' }] }), /미완료.*T-/);
  assert.equal(h.getBoard().review.pendingSince, 7);
});

test('verified all-blocked supervision stays quiet until a relevant answer changes', t => {
  const h = setup(t);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '외부 조건', waitFor: [h.question.id] });
  h.updateBoardReview({ termId: 'manager', workerDispatch: 'linked', pendingSince: 8, intervalMinutes: 1 });
  h.reportBoardReview(8, { status: 'waiting', report: '대기 항목 검증', progress: [{ termId: 'worker', workState: 'blocked',
    blocker: '외부 조건', alternatives: '독립 작업 확인', remaining: [{ condition: '구현·검증', blocker: '외부 조건', nextAction: '원전 적용' }] }] });
  let now = Date.now(), writes = [];
  const tick = createBoardReviewer({ ...h, now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: id => ({ entry: { pty: { write: data => writes.push({ id, data }) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  const prior = h.getBoard().review;
  h.updateBoardReview({ workerProgress: prior.workerProgress.map(w => ({ ...w, run: { ...w.run,
    summary: '00:01 같은 상태, 새로운 결과 없음', reportedAt: now + 1 } })) });
  now += 3_600_000; tick(); tick();
  assert.equal(writes.length, 0);
  h.updateBoardTask(h.question.id, { answer: '새 조건 도착' }); tick();
  assert.equal(writes.filter(write => write.id === 'manager').length, 1);
  now += 3_600_000; tick();
  assert.equal(writes.filter(write => write.id === 'manager').length, 1, 'an outstanding request is never repeated');
});

test('dependency evidence follows the current supplier after supervisor reassignment', t => {
  const h = setup(t);
  h.updateBoardReview({ watched: [{ termId: 'worker', goal: '구현·검증' }, { termId: 'supplier', goal: '원전 공급' }] });
  const source = h.addBoardTask('공급 결과', undefined, 'task', 'user', 'S-0001', 'supplier').task;
  h.updateBoardReview({ workerDispatch: 'paused', status: 'stopped' });
  const { supervisor } = h.addBoardSupervisor('새 감독');
  h.updateBoardReview({ workerDispatch: 'running', watched: [{ termId: 'supplier', goal: '원전 공급' }] }, undefined, supervisor.id);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '공급 결과', waitFor: [source.id] });
  const review = h.getBoard(supervisor.id).review;
  h.updateBoardReview({ workerProgress: review.workerProgress.map(w => ({ ...w, run: { ...w.run, evidence: '새 공급 결과' } })) }, undefined, supervisor.id);
  assert.equal(h.restart().getBoard().tasks.find(t => t.id === h.task.id).status, 'ready');
});

test('reopening a completed task and explicitly releasing a blocker create new deliveries', t => {
  const h = setup(t);
  let now = Date.now(), writes = [];
  const tick = createBoardWorkerRunner({ ...h, now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: () => ({ entry: { pty: { write: data => writes.push(data) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  const step = () => { now += 120_000; tick('S-0001'); now += 15_000; tick('S-0001'); };
  step(); h.updateBoardTask(h.task.id, { done: true });
  h.updateBoardTask(h.task.id, { done: false }); step(); assert.equal(writes.length, 2);
  h.updateBoardTask(h.task.id, { status: 'blocked', blocker: '외부 조건', waitFor: [h.question.id] });
  h.updateBoardTask(h.task.id, { status: 'ready' }); step(); assert.equal(writes.length, 3);
  step(); assert.equal(writes.length, 3);
});

test('a cancelled delivery claim remains retryable without overwriting a newer assignment', t => {
  const h = setup(t);
  let now = Date.now(), writes = [], cancel = true;
  const update = (...args) => {
    const result = h.updateBoardReview(...args);
    if (cancel && args[0].workerProgress?.some(w => w.run.taskDispatchKey)) {
      cancel = false; h.updateBoardReview({ nextDueAt: now + 1 });
    }
    return result;
  };
  const tick = createBoardWorkerRunner({ ...h, updateBoardReview: update, now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: () => ({ entry: { pty: { write: data => writes.push(data) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  tick('S-0001'); now += 15_000; tick('S-0001');
  assert.equal(writes.length, 0); assert.match(h.getBoard().review.workerProgress[0].run.lastError, /목표 전달 실패/);
  now += 120_000; tick('S-0001'); assert.equal(writes.length, 1);
  now += 120_000; tick('S-0001'); assert.equal(writes.length, 1);
});

test('supervisor evidence without a new nextAction cannot replay the current task', t => {
  const h = setup(t);
  let review = h.getBoard().review;
  h.updateBoardReview({ termId: 'manager', workerProgress: review.workerProgress.map(w => ({ ...w, nextAction: '현재 구현을 이어서 검증' })) });
  let now = Date.now(), writes = [];
  const tick = createBoardWorkerRunner({ ...h, now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: () => ({ entry: { pty: { write: data => writes.push(data) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  tick('S-0001'); now += 15_000; tick('S-0001');
  h.updateBoardReview({ pendingSince: 20 });
  h.reportBoardReview(20, { report: '중간 산출물 확인', progress: [{ termId: 'worker', artifact: '/result', version: 'v1', result: 'PASS' }] });
  now += 120_000; tick('S-0001'); now += 15_000; tick('S-0001');
  assert.equal(h.getBoard().review.workerProgress[0].nextAction, '현재 구현을 이어서 검증');
  assert.equal(writes.length, 1);
});

test('an idle diagnostic never crosses a user stop at its final delivery boundary', t => {
  const h = setup(t);
  let now = Date.now(), writes = [];
  const tick = createBoardWorkerRunner({ ...h, now: () => now, terminalAgent: () => 'claude',
    updateBoardReview: (...args) => {
      const result = h.updateBoardReview(...args);
      if (args[0].workerProgress?.some(w => w.run.checkQueuedAt)) h.updateBoardReview({ workerDispatch: 'paused' });
      return result;
    },
    resolveTerminalRef: () => ({ entry: { pty: { write: data => writes.push(data) } } }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  tick('S-0001'); now += 15_000; tick('S-0001');
  now += 300_000; tick('S-0001'); now += 15_000; tick('S-0001');
  assert.equal(writes.length, 1);
  assert.equal(h.getBoard().review.workerDispatch, 'paused');
});

test('a refused diagnosis retries only that diagnosis and never the full assignment', t => {
  const h = setup(t);
  let now = Date.now(), writes = [], attempts = 0;
  const tick = createBoardWorkerRunner({ ...h, now: () => now, terminalAgent: () => 'claude',
    sendAgentInput: (_id, data) => {
      if (data.includes('[콕핏 작업자 정체 점검]') && ++attempts === 1) throw new Error('AGENT_NOT_READY');
      writes.push(data);
    }, resolveTerminalRef: () => ({ entry: {} }),
    readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
  tick('S-0001'); now += 15_000; tick('S-0001');
  const key = h.getBoard().review.workerProgress[0].run.taskDispatchKey;
  now += 300_000; tick('S-0001'); now += 15_000; tick('S-0001');
  assert.equal(attempts, 1); assert.equal(h.getBoard().review.workerProgress[0].run.checkQueuedAt, 0);
  assert.equal(h.getBoard().review.workerProgress[0].run.taskDispatchKey, key);
  now += 15_000; tick('S-0001');
  assert.equal(attempts, 2); assert.equal(writes.filter(data => data.includes('[콕핏 작업자 목표 계속 실행]')).length, 1);
  now += 3_600_000; tick('S-0001'); assert.equal(attempts, 2);
});
