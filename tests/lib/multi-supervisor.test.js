import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createBoardService } from '../../lib/board-service.js';
import { createBoardReviewer } from '../../lib/board-review.js';
import { register } from '../../routes/board.js';

function setup(t) {
  const dir = mkdtempSync('/tmp/cockpit-supervisors-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = createBoardService(`${dir}/board.json`);
  service.addBoardTask('기존 질문', undefined, 'question');
  service.updateBoardTask('T-0001', { answer: '보존할 답변', done: true });
  service.updateBoardReview({ termId: 'manager1', objective: '첫 목표', watched: [{ termId: 'worker1', goal: '첫 조건' }], nextDueAt: 0 });
  const second = service.addBoardSupervisor('두 번째 감독').supervisor.id;
  service.updateBoardReview({ termId: 'manager2', objective: '둘째 목표', watched: [{ termId: 'worker2', goal: '둘째 조건' }], nextDueAt: 0 }, undefined, second);
  return { service, second, file: `${dir}/board.json` };
}

test('supervisor questions and checklist ownership survive legacy writers and reload', t => {
  const { service, second, file } = setup(t);
  const question = service.addBoardTask('둘째 감독에게 질문', undefined, 'question', 'supervisor', second).task;
  assert.deepEqual(service.getBoard('S-0001').tasks.map(task => task.id), ['T-0001']);
  assert.deepEqual(service.getBoard(second).tasks.map(task => task.id), [question.id]);
  const legacy = service.getBoard();
  delete legacy.supervisors;
  legacy.checklists.forEach(list => delete list.supervisorId);
  service.replaceBoardIfRevision(legacy, legacy.revision);
  const reloaded = createBoardService(file);
  assert.equal(reloaded.getBoard().supervisors.length, 2);
  assert.equal(reloaded.getBoard(second).tasks[0].questionTo, 'supervisor');
  assert.equal(reloaded.getBoard('S-0001').tasks[0].answer, '보존할 답변');
  assert.equal(reloaded.getBoard('S-0001').tasks[0].done, true);
  assert.throws(() => service.replaceBoardIfRevision(service.getBoard(second), service.getBoard().revision), /전체 보드/);
  assert.throws(() => service.addBoardTask('wrong owner', question.checklistId, 'task', 'user', 'S-0001'), /다른 감독/);
});

test('two supervisors receive independent requests and cannot acknowledge or stop each other', t => {
  const { service, second } = setup(t);
  const messages = [];
  const tick = createBoardReviewer({ ...service, now: () => 1000,
    resolveTerminalRef: id => ({ id, entry: { pty: { write: text => messages.push({ id, text }) } } }), terminalAgent: () => 'codex' });
  tick();
  assert.deepEqual(messages.map(item => item.id), ['manager1', 'manager2']);
  const firstToken = service.getBoard().review.pendingSince;
  const secondToken = service.getBoard(second).review.pendingSince;
  assert.notEqual(firstToken, secondToken);
  assert.ok(messages[1].text.includes(`"supervisorId":"${second}"`));
  assert.throws(() => service.reportBoardReview(secondToken, { report: 'wrong supervisor' }), /현재 점검/);
  service.reportBoardReview(secondToken, { supervisorId: second, report: '둘째 보고' });
  assert.equal(service.getBoard().review.pendingSince, firstToken);
  assert.equal(service.getBoard(second).review.reports.at(-1).text, '둘째 보고');
  service.updateBoardReview({ termId: '', status: 'stopped', pendingSince: 0 }, undefined, second);
  assert.equal(service.getBoard().review.status, 'running');
  assert.equal(service.getBoard().review.pendingSince, firstToken);
  assert.equal(service.getBoard(second).review.status, 'stopped');
});

test('one failed supervisor does not block another, and overlapping active assignments are rejected', t => {
  const { service, second } = setup(t);
  assert.throws(() => service.updateBoardReview({ watched: [{ termId: 'worker1', goal: 'overlap' }] }, undefined, second), /다른 실행 중인 감독/);
  assert.throws(() => service.updateBoardReview({ termId: 'manager1' }, undefined, second), /다른 실행 중인 감독/);
  const messages = [];
  const tick = createBoardReviewer({ ...service, now: () => 1000,
    resolveTerminalRef: id => { if (id === 'manager1') throw new Error('first supervisor unavailable'); return { id, entry: { pty: { write: text => messages.push(text) } } }; },
    terminalAgent: () => 'codex' });
  assert.throws(tick, /first supervisor unavailable/);
  assert.equal(messages.length, 1);
  assert.ok(service.getBoard(second).review.pendingSince);
});

test('scoped HTTP configuration and reports leave the other supervisor unchanged', async t => {
  const { service, second } = setup(t);
  const handlers = {};
  register({ ...service, addRoute: (method, path, handler) => { handlers[`${method} ${path}`] = handler; },
    readBody: async req => req.body, json: (res, body, status = 200) => Object.assign(res, { body, status }),
    isLocalhost: () => true, resolveTerminalRef: id => ({ id, entry: { alias: id } }), terminalAgent: () => 'codex' });
  const first = service.getBoard().review;
  const configured = {};
  await handlers['PUT /api/board/review']({ body: { supervisorId: second, target: 'manager2', objective: 'HTTP에서 변경' } }, configured);
  assert.equal(configured.status, 200);
  assert.equal(service.getBoard(second).review.objective, 'HTTP에서 변경');
  assert.deepEqual(service.getBoard().review, first);
  service.updateBoardReview({ pendingSince: 1234 }, undefined, second);
  const report = {};
  await handlers['POST /api/board/review']({ body: { supervisorId: second, pendingSince: 1234, report: '둘째의 HTTP 보고' } }, report);
  assert.equal(report.status, 200);
  assert.equal(service.getBoard(second).review.reports.at(-1).text, '둘째의 HTTP 보고');
  assert.deepEqual(service.getBoard().review, first);
});

test('server restore admits an active reassigned supervisor after a stopped predecessor', () => {
  const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const expression = server.match(/const canRestoreSupervisor = ([\s\S]*?);/)[1];
  const old = { termId: 'same', autoRecover: true, status: 'stopped', runUntil: 0 };
  const current = { ...old, status: 'running' };
  const allows = supervisors => runInNewContext(expression, { getBoard: () => ({ supervisors }), newTermId: 'same' });
  assert.equal(allows([old, current]), true);
  assert.equal(allows([old]), false);
  assert.equal(allows([old, { ...current, runUntil: 1 }]), false);
  assert.equal(allows([old, { ...current, autoRecover: false }]), false);
});
