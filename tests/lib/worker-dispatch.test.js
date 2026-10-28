import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createBoardService } from '../../lib/board-service.js';
import { createBoardWorkerRunner } from '../../lib/board-workers.js';
import { register } from '../../routes/board.js';

test('a pause or deadline crossed while claiming delivery is checked again before input', t => {
  for (const boundary of ['pause', 'deadline']) {
    const dir = mkdtempSync('/tmp/dispatch-boundary-'); t.after(() => rmSync(dir, { recursive: true, force: true }));
    let now = Date.now();
    const deadline = now + 20000;
    const service = createBoardService(`${dir}/board.json`);
    service.updateBoardReview({ workerDispatch: 'running', runUntil: deadline, watched: [{ termId: 'worker', goal: '검증' }] });
    const writes = [];
    const run = createBoardWorkerRunner({ ...service, now: () => now, terminalAgent: () => 'claude',
      updateBoardReview: (...args) => {
        const saved = service.updateBoardReview(...args);
        if (args[0].workerProgress?.some(w => w.run?.lastSentAt)) {
          if (boundary === 'pause') service.updateBoardReview({ workerDispatch: 'paused' });
          else now = deadline + 1;
        }
        return saved;
      },
      resolveTerminalRef: () => ({ entry: { pty: { write: data => writes.push(data) } } }),
      readTerminalScreen: () => ({ current: true, lines: ['❯'] }) });
    run(); now += 15000; run();
    assert.equal(writes.length, 0, boundary);
  }
});

test('explicit independent dispatch survives supervisor stop and restart, while user pause and expiry revoke it', t => {
  const dir = mkdtempSync('/tmp/independent-workers-'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = `${dir}/board.json`;
  let service = createBoardService(file), now = Date.now();
  service.updateBoardReview({ termId: 'supervisor', watched: [{ termId: 'worker', goal: '검증 완료' }], workerDispatch: 'running' });
  const writes = [];
  const makeRunner = () => createBoardWorkerRunner({ ...service, now: () => now, terminalAgent: () => 'claude',
    resolveTerminalRef: id => id === 'worker' ? { id, entry: { pty: { write: data => writes.push(data) } } } : null,
    readTerminalScreen: () => ({ current: true, lines: ['❯', '⏵⏵ auto mode on'] }) });
  service.updateBoardReview({ status: 'stopped', termId: '' });
  service = createBoardService(file);
  let run = makeRunner(); run(); now += 15000; run();
  assert.equal(writes.length, 1);
  const token = service.getBoard().review.workerProgress[0].run.token;
  service.reportBoardWorker({ termId: 'worker', token, status: 'working', summary: '독립 작업 결과' });
  assert.equal(service.getBoard().review.workerProgress[0].run.status, 'active');
  service.updateBoardReview({ workerDispatch: 'paused' });
  assert.throws(() => service.reportBoardWorker({ termId: 'worker', token, status: 'working', summary: '늦은 보고' }), /현재 작업자/);
  now += 3600000; run(); assert.equal(writes.length, 1);
  service.updateBoardReview({ workerDispatch: 'running', runUntil: Date.now() - 1 });
  run(); assert.equal(writes.length, 1);
});

test('independent groups retain exclusive worker ownership when the supervisor is stopped', t => {
  const dir = mkdtempSync('/tmp/independent-owner-'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = createBoardService(`${dir}/board.json`);
  service.updateBoardReview({ workerDispatch: 'running', status: 'stopped', watched: [{ termId: 'one', goal: '첫 목표' }] });
  const second = service.addBoardSupervisor('두 번째').supervisor;
  assert.throws(() => service.updateBoardReview({ termId: 'manager2', watched: [{ termId: 'one', goal: '다른 목표' }] }, undefined, second.id), /다른 실행 중인 감독/);
  service.updateBoardReview({ termId: 'manager1', status: 'running', workerDispatch: 'paused' });
  assert.throws(() => service.updateBoardReview({ termId: 'manager2', watched: [{ termId: 'one', goal: '다른 목표' }] }, undefined, second.id), /다른 실행 중인 감독/);
});

test('dispatch API rejects remote and stale edits and stopping management preserves worker deadline', async t => {
  const dir = mkdtempSync('/tmp/dispatch-route-'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = createBoardService(`${dir}/board.json`);
  const deadline = Date.now() + 3600000;
  service.updateBoardReview({ termId: 'manager', watched: [{ termId: 'one', goal: '검증' }], runHours: 1, runUntil: deadline });
  const routes = {};
  register({ ...service, addRoute: (method, path, fn) => { routes[`${method} ${path}`] = fn; },
    readBody: async req => req.body, isLocalhost: req => req.local,
    json: (res, body, status = 200) => Object.assign(res, { body, status }) });
  const patch = async (mode, expected, local = true) => {
    const res = {}; await routes['PATCH /api/board/worker-dispatch']({ body: { mode, expected }, local }, res); return res;
  };
  assert.equal((await patch('running', 'linked', false)).status, 403);
  assert.equal((await patch('running', 'paused')).status, 409);
  assert.equal((await patch('invalid', 'linked')).status, 400);
  assert.equal((await patch('running', 'linked')).status, 200);
  const res = {};
  await routes['PUT /api/board/review']({ local: true, body: { target: '', intervalMinutes: 5 } }, res);
  assert.equal(res.status, 200);
  assert.equal(service.getBoard().review.status, 'stopped');
  assert.equal(service.getBoard().review.workerDispatch, 'running');
  assert.equal(service.getBoard().review.runUntil, deadline);
  assert.equal((await patch('paused', 'running')).status, 200);
  service.updateBoardReview({ runUntil: Date.now() - 1 });
  assert.equal((await patch('running', 'paused')).status, 400);
});
