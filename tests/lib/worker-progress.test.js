import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBoardService } from '../../lib/board-service.js';
import { createBoardReviewer } from '../../lib/board-review.js';
import { stalledWorkerProgress } from '../../js/worker-progress.js';
import { register } from '../../routes/board.js';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-progress-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1_800_000;
  t.mock.method(Date, 'now', () => time);
  const file = join(directory, 'board.json');
  const service = createBoardService(file);
  service.updateBoardReview({ termId: 'manager', intervalMinutes: 5,
    watched: [{ termId: 'one', alias: 'ai1', goal: '로그인 검증' }, { termId: 'two', alias: 'ai2', goal: '보고서' }] });
  const messages = [];
  const routes = {};
  register({ ...service, addRoute: (method, path, handler) => { routes[`${method} ${path}`] = handler; },
    readBody: async req => req.body, isLocalhost: () => true,
    json: (res, body, status = 200) => Object.assign(res, { body, status }) });
  const tick = createBoardReviewer({ ...service, now: () => time,
    resolveTerminalRef: () => ({ entry: { pty: { write: value => messages.push(value) } } }), terminalAgent: () => 'codex' });
  const report = async (progress, status = 'running') => {
    const res = {};
    await routes['POST /api/board/review']({ body: { pendingSince: service.getBoard().review.pendingSince,
      status, report: '작업 중', ...(progress === undefined ? {} : { progress }) } }, res);
    return res;
  };
  return { service, file, tick, report, messages, advance: minutes => { time += minutes * 60_000; } };
}

const evidence = (termId, version) => ({ termId, artifact: `/tmp/${termId}.txt`, version, result: '검증 결과' });

test('heartbeat reports do not hide a 30-minute stall; warnings persist once and reach supervisor prompts', async t => {
  const h = setup(t);
  const baseline = h.service.getBoard().review.workerProgress[0].startedAt;
  for (let index = 0; index < 6; index++) {
    h.tick();
    assert.equal((await h.report()).status, 200);
    h.advance(5);
  }
  assert.equal(h.service.getBoard().review.workerProgress[0].startedAt, baseline);
  h.tick();
  let review = h.service.getBoard().review;
  assert.equal(stalledWorkerProgress(review).length, 2);
  assert.ok(review.lastReviewedAt > baseline);
  assert.equal(review.reports.filter(item => item.text.includes('진전 확인 필요')).length, 1);
  assert.match(h.messages.at(-1), /원인과 이전과 다른 다음 조치/);
  await h.report([{ termId: 'one', blocker: '같은 오류 반복', nextAction: '입력 조건을 점검' }], 'waiting');
  h.advance(5); h.tick();
  review = createBoardService(h.file).getBoard().review;
  assert.equal(review.reports.filter(item => item.text.includes('진전 확인 필요')).length, 1);
  assert.equal(review.workerProgress[0].blocker, '같은 오류 반복');
  assert.equal(review.workerProgress[0].lastProgressAt, 0);
  assert.equal(stalledWorkerProgress(review).length, 2);
});

test('only a new artifact version updates one worker; wording and A/B/A replay do not reset progress', async t => {
  const h = setup(t);
  h.tick(); await h.report([evidence('one', 'A')]);
  const firstAt = h.service.getBoard().review.workerProgress[0].lastProgressAt;
  h.advance(5); h.tick(); await h.report([{ ...evidence('one', 'A'), result: '계속 잘 진행 중' }]);
  assert.equal(h.service.getBoard().review.workerProgress[0].lastProgressAt, firstAt);
  h.advance(5); h.tick(); await h.report([evidence('one', 'B')]);
  const secondAt = h.service.getBoard().review.workerProgress[0].lastProgressAt;
  h.advance(5); h.tick(); await h.report([evidence('one', 'A')]);
  assert.equal(h.service.getBoard().review.workerProgress[0].lastProgressAt, secondAt);
  h.advance(25); h.tick();
  assert.equal(stalledWorkerProgress(h.service.getBoard().review).length, 2);
  await h.report([evidence('one', 'C')]);
  assert.deepEqual(stalledWorkerProgress(h.service.getBoard().review).map(worker => worker.termId), ['two']);
  assert.equal(h.service.getBoard().review.workerProgress[0].alertedAt, 0);
  const restored = createBoardService(h.file);
  restored.updateBoardReview({ cycleStartedAt: 0, recoveryAttempts: 1, pendingSince: 0 });
  assert.deepEqual(restored.getBoard().review.workerProgress, h.service.getBoard().review.workerProgress);
  h.advance(30); h.tick();
  assert.equal(h.service.getBoard().review.reports.filter(item => item.text.includes('진전 확인 필요')).length, 2);
});

test('invalid or incomplete completion evidence cannot acknowledge a check or partially update progress', async t => {
  const h = setup(t);
  h.tick();
  const before = h.service.getBoard().review;
  for (const progress of [null, {}, [{ termId: 'unknown' }], [evidence('one', 'A'), evidence('one', 'B')],
    [{ termId: 'one', artifact: '/tmp/file' }], [{ termId: 'one', result: 123 }]]) {
    assert.equal((await h.report(progress)).status, 400);
    assert.deepEqual(h.service.getBoard().review, before);
  }
  assert.equal((await h.report(undefined, 'complete')).status, 400);
  assert.equal((await h.report([evidence('one', 'A')], 'complete')).status, 400);
  assert.deepEqual(h.service.getBoard().review, before);
  assert.equal((await h.report([evidence('one', 'A'), evidence('two', 'B')], 'complete')).status, 200);
  h.advance(60); h.tick();
  assert.equal(h.messages.length, 1);
  assert.equal(h.service.getBoard().review.status, 'complete');
});

test('changing a goal resets only that assignment; ordinary settings, stop and stale reports preserve progress', async t => {
  const h = setup(t);
  h.tick(); await h.report([evidence('one', 'A'), evidence('two', 'B')]);
  const before = h.service.getBoard().review;
  h.advance(5);
  h.service.updateBoardReview({ intervalMinutes: 10, lastReviewedAt: 0 });
  assert.deepEqual(h.service.getBoard().review.workerProgress, before.workerProgress);
  h.service.updateBoardReview({ watched: [{ termId: 'one', goal: '새 목표' }, before.watched[1]] });
  const changed = h.service.getBoard().review;
  assert.equal(changed.workerProgress[0].lastProgressAt, 0);
  assert.deepEqual(changed.workerProgress[1], before.workerProgress[1]);
  h.advance(10); h.tick();
  const pending = h.service.getBoard().review.pendingSince;
  h.service.updateBoardReview({ status: 'stopped', pendingSince: 0 });
  assert.throws(() => h.service.reportBoardReview(pending, { report: 'late', progress: [evidence('one', 'C')] }), /현재 점검/);
  const stopped = h.service.getBoard().review;
  h.advance(60); h.tick();
  assert.deepEqual(h.service.getBoard().review, stopped);
});

test('offline CLI task edits preserve progress and duplicate evidence history', async t => {
  const h = setup(t);
  h.tick(); await h.report([evidence('one', 'A')]);
  const before = h.service.getBoard().review.workerProgress;
  const child = spawnSync(process.execPath, [new URL('../../scripts/cockpit-board.mjs', import.meta.url).pathname, 'task', 'add', '오프라인 작업'], {
    env: { ...process.env, COCKPIT_BOARD_FILE: h.file, COCKPIT_URL: 'http://127.0.0.1:0' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.deepEqual(createBoardService(h.file).getBoard().review.workerProgress, before);
  assert.equal(h.service.getBoard().tasks.at(-1).text, '오프라인 작업');
});
