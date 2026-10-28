import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createBoardService } from '../../lib/board-service.js';
import { register } from '../../routes/board.js';
import { workerSettings } from '../../js/worker-settings.js';
import { createBoardWorkerRunner } from '../../lib/board-workers.js';

function setup(t) {
  const dir = mkdtempSync('/tmp/cockpit-settings-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = `${dir}/board.json`;
  const service = createBoardService(file);
  service.updateBoardReview({ termId: 'manager', watched: [{ termId: 'one', goal: '배포 검증' }, { termId: 'two', goal: '회귀 검증' }] });
  const routes = {};
  const sent = [];
  const resolveTerminalRef = id => ['manager', 'one', 'two'].includes(id) ? { id, entry: { alias: id, pty: { write: text => sent.push({ id, text }) } } } : null;
  register({ ...service, addRoute: (method, path, handler) => { routes[`${method} ${path}`] = handler; },
    json: (res, body, status = 200) => Object.assign(res, { body, status }), readBody: async req => req.body,
    isLocalhost: req => req.local !== false, resolveTerminalRef });
  const current = id => service.getBoard().review.watched.find(w => w.termId === id);
  const patch = async (settings, expected = workerSettings(current('one')), local = true) => {
    const res = {};
    await routes['PATCH /api/board/worker-settings']({ body: { termId: 'one', settings, expected }, local }, res);
    return res;
  };
  return { service, file, current, patch, sent, resolveTerminalRef };
}

test('session settings persist without losing progress; stale edits and invalid input fail closed', async t => {
  const h = setup(t);
  const review = h.service.getBoard().review;
  h.service.updateBoardReview({ workerProgress: review.workerProgress.map(w => ({ ...w, evidence: '검증 기록', run: { status: 'active', token: 'old' } })) });
  const original = workerSettings(h.current('one'));
  h.service.updateBoardReview({ pendingSince: 12345 });
  assert.equal((await h.patch({ ...original, priority: 1, paused: true })).status, 200);
  assert.throws(() => h.service.reportBoardReview(12345, { status: 'complete', report: 'old request' }), /현재 점검 요청/);
  const persisted = createBoardService(h.file).getBoard().review;
  assert.equal(persisted.watched[0].priority, 1);
  assert.equal(persisted.watched[0].paused, true);
  assert.equal(persisted.workerProgress[0].evidence, '검증 기록');
  assert.equal(persisted.workerProgress[1].run.token, 'old');
  assert.equal((await h.patch(original, original)).status, 409);
  assert.equal((await h.patch({ ...workerSettings(h.current('one')), priority: 9 })).status, 400);
  assert.equal((await h.patch(workerSettings(h.current('one')), undefined, false)).status, 403);
  assert.equal((await h.patch({ ...workerSettings(h.current('one')), objective: '새 현재 목표' })).status, 200);
  assert.equal(h.service.getBoard().review.workerProgress[0].run.token, '');
  assert.equal(h.service.getBoard().review.workerProgress[1].run.token, 'old');
});

test('automatic dispatch honors priority and pause while retaining other workers', async t => {
  const h = setup(t);
  let now = Date.now();
  const review = h.service.getBoard().review;
  h.service.updateBoardReview({ watched: review.watched.map(w => ({ ...w, priority: w.termId === 'two' ? 1 : 3 })) });
  const tick = createBoardWorkerRunner({ ...h.service, resolveTerminalRef: h.resolveTerminalRef, terminalAgent: () => 'claude',
    readTerminalScreen: () => ({ current: true, lines: ['❯ ', '⏵⏵ auto mode on'] }), now: () => now });
  tick('S-0001'); now += 15000; tick('S-0001');
  assert.deepEqual(h.sent.map(m => m.id), ['two', 'one']);
  assert.match(h.sent[0].text, /우선순위: 1/);
  await h.patch({ ...workerSettings(h.current('one')), paused: true });
  const beforeResume = h.service.getBoard().review.workerProgress;
  h.sent.length = 0; now += 3600000;
  tick('S-0001'); now += 15000; tick('S-0001');
  assert.ok(h.sent.every(m => m.id !== 'one'));
  await h.patch({ ...workerSettings(h.current('one')), paused: false });
  const resumed = h.service.getBoard().review.workerProgress;
  assert.equal(resumed.find(w => w.termId === 'one').run.token, beforeResume.find(w => w.termId === 'one').run.token);
  assert.equal(resumed.find(w => w.termId === 'one').run.taskDispatchKey, '');
  assert.equal(resumed.find(w => w.termId === 'two').run.taskDispatchKey, beforeResume.find(w => w.termId === 'two').run.taskDispatchKey);
  tick('S-0001'); now += 15000; tick('S-0001');
  const assignments = () => h.sent.filter(m => m.id === 'one' && m.text.includes('[콕핏 작업자 목표 계속 실행]'));
  assert.equal(assignments().length, 1);
  await h.patch(workerSettings(h.current('one')));
  now += 15000; tick('S-0001'); now += 15000; tick('S-0001');
  assert.equal(assignments().length, 1, 'unchanged settings and later ticks never replay the resume assignment');
});
