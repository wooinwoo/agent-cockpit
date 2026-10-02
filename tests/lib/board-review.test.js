import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBoardService } from '../../lib/board-service.js';
import { createBoardReviewer } from '../../lib/board-review.js';
import { register } from '../../routes/board.js';
import { agentPermissionCommand } from '../../js/agent-permissions.js';

test('reference paths persist, reach prompts after reload, and overnight configuration validates readiness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-reference-'));
  try {
    const file = join(directory, 'board.json');
    const service = createBoardService(file);
    const handlers = {};
    let command = 'codex';
    const messages = [];
    const resolveTerminalRef = ref => ({ id: ref, entry: { command, pty: { write: value => messages.push(value) } } });
    register({ ...service, addRoute: (method, path, handler) => { handlers[`${method} ${path}`] = handler; },
      json: (res, body, status = 200) => Object.assign(res, { body, status }), readBody: async req => req.body,
      isLocalhost: () => true, resolveTerminalRef, terminalAgent: () => 'codex', prepareBoardRecovery: found => ({ termId: found.id, command }) });
    const configure = async body => { const res = {}; await handlers['PUT /api/board/review']({ body: { target: 'manager', ...body } }, res); return res; };
    assert.equal((await configure({ referencePaths: ['a\nb'] })).status, 400);
    assert.equal((await configure({ referencePaths: Array(31).fill('/tmp/doc') })).status, 400);
    assert.equal((await configure({ runHours: 8, autoRecover: true, stallMinutes: 15 })).status, 400);
    command = agentPermissionCommand('codex', { codex: 'network' });
    const paths = ['/tmp/design notes.md', 'C:\\자료\\설계.pdf', 'https://example.com/spec'];
    const response = await configure({ runHours: 8, autoRecover: true, stallMinutes: 15, referencePaths: paths,
      watched: [{ target: 'worker', goal: '테스트 통과' }] });
    assert.equal(response.status, 200);
    const reloaded = createBoardService(file);
    assert.deepEqual(reloaded.getBoard().review.referencePaths, paths);
    assert.ok(reloaded.getBoard().review.runUntil > Date.now() + 7 * 3_600_000);
    const tick = createBoardReviewer({ ...reloaded, now: () => Date.now() + 1000, resolveTerminalRef, terminalAgent: () => 'codex' });
    tick();
    assert.ok(messages[0].includes(JSON.stringify(paths)));
    assert.match(messages[0], /승인 화면에는 입력을 보내지 마세요/);
    assert.match(messages[0], /"questionTo":"user"/);
    assert.match(messages[0], /questionTo가 supervisor인 항목은 사용자가 감독에게 남긴 질문/);
    assert.match(messages[0], /답변만으로 done 처리하지 말고/);
    await configure({ target: '' });
    assert.deepEqual(reloaded.getBoard().review.referencePaths, paths);
    assert.equal(reloaded.getBoard().review.runUntil, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('overnight retries survive an eight-hour clock run, pause after three failures, and stop at the deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-overnight-'));
  try {
    const service = createBoardService(join(directory, 'board.json'));
    let time = 1000;
    const end = time + 8 * 3_600_000;
    service.updateBoardReview({ termId: 'manager', autoRecover: true, stallMinutes: 15, runHours: 8, runUntil: end });
    const restarts = [];
    const tick = createBoardReviewer({ ...service, now: () => time, resolveTerminalRef: () => null, terminalAgent: () => '',
      recoverSupervisor: () => { restarts.push(time); throw new Error('일시적 제공자 장애'); } });
    for (; time < end; time += 15_000) tick();
    assert.ok(restarts.length > 3);
    assert.ok(restarts.some(at => at > end - 3_600_000), 'retries continue into the final hour');
    assert.ok(service.getBoard().review.reports.some(report => /30분 휴식/.test(report.text)));
    time = end; tick();
    assert.equal(service.getBoard().review.status, 'stopped');
    assert.equal(service.getBoard().review.autoRecover, false);
    const count = restarts.length;
    time += 3_600_000; tick(); assert.equal(restarts.length, count);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('approval dialogs receive no reminder or Enter and still reach the opted-in recovery deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-approval-'));
  try {
    for (const screen of ['Would you like to run the following command?\n1. Yes, proceed\n2. No', 'Do you want to proceed?\n1. Yes\n2. No', 'Update available\n1. Update now\n2. Skip']) {
      const service = createBoardService(join(directory, 'board.json'));
      let time = 1000;
      let writes = 0;
      let recoveries = 0;
      service.updateBoardReview({ termId: 'manager', status: 'running', autoRecover: true, stallMinutes: 5,
        cycleStartedAt: 0, recoveryAfter: 0, recoveryAttempts: 0, pendingSince: 0, nextDueAt: 0, objective: '작업 확인' });
      const tick = createBoardReviewer({ ...service, now: () => time,
        resolveTerminalRef: () => ({ entry: { pty: { write() { writes++; } } } }), terminalAgent: () => 'codex',
        readTerminalScreen: () => ({ lines: screen.split('\n'), current: true }),
        recoverSupervisor: (_review, options) => { assert.equal(options.interrupt, true); recoveries++; } });
      tick();
      time += 299_000; tick();
      assert.equal(writes, 0);
      assert.equal(recoveries, 0);
      assert.match(service.getBoard().review.lastError, /승인 화면/);
      time += 1000; tick();
      assert.equal(recoveries, 1);
      assert.equal(writes, 0);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the overnight deadline can expire during process inspection without a late restart or message', () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-deadline-'));
  try {
    for (const alive of [false, true]) {
      const service = createBoardService(join(directory, 'board.json'));
      let time = 999;
      let actions = 0;
      service.updateBoardReview({ termId: 'manager', status: 'running', autoRecover: true, runUntil: 1000,
        watched: [{ termId: 'worker', goal: '검증' }] });
      createBoardReviewer({ ...service, now: () => time,
        resolveTerminalRef: () => { time = 1001; return alive ? { entry: { pty: { write() { actions++; } } } } : null; },
        terminalAgent: () => 'codex', recoverSupervisor: () => { actions++; } })();
      assert.equal(actions, 0);
      assert.equal(service.getBoard().review.status, 'stopped');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a concurrent stop or supervisor replacement invalidates both delivery and recovery claims', () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-stop-race-'));
  try {
    for (const agent of ['codex', '']) {
      for (const change of [{ termId: '', status: 'stopped' }, { termId: 'replacement', status: 'running' }]) {
        const service = createBoardService(join(directory, 'board.json'));
        service.updateBoardReview({ termId: 'manager', status: 'running', pendingSince: 0, autoRecover: true,
          recoveryAfter: 0, recoveryAttempts: 0, nextDueAt: 0, watched: [{ termId: 'worker', goal: '검증' }] });
        let writes = 0;
        let recoveries = 0;
        let changed = false;
        const tick = createBoardReviewer({ ...service, now: () => 1000,
          resolveTerminalRef: () => {
            if (!changed) { changed = true; service.updateBoardReview(change); }
            return { entry: { pty: { write() { writes++; } } } };
          }, terminalAgent: () => agent, recoverSupervisor: () => { recoveries++; } });
        assert.throws(tick, error => error.code === 'BOARD_CONFLICT');
        assert.equal(writes, 0);
        assert.equal(recoveries, 0);
        assert.equal(service.getBoard().review.pendingSince, 0);
        assert.equal(service.getBoard().review.termId, change.termId);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('report deadline interrupts only opted-in supervisors, preserves evidence and ignores retry timestamp resets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-stalled-'));
  try {
    const service = createBoardService(join(directory, 'board.json'));
    service.updateBoardReview({ termId: 'manager', autoRecover: true, stallMinutes: 10, intervalMinutes: 1,
      watched: [{ termId: 'worker', goal: '검증' }] });
    let time = 1000;
    const messages = [];
    const interruptions = [];
    const tick = createBoardReviewer({ ...service, now: () => time, resolveTerminalRef: () => ({ entry: { pty: { write: value => messages.push(value) } } }),
      terminalAgent: () => 'codex', readTerminalScreen: () => ({ lines: ['ERROR: 작업이 멈춤'] }),
      recoverSupervisor: (_review, options) => interruptions.push(options) });
    tick();
    time += 300_000; tick();
    assert.equal(messages.length, 2);
    assert.equal(service.getBoard().review.cycleStartedAt, 1000);
    time = 600_999; tick(); assert.equal(interruptions.length, 0);
    time++; tick();
    assert.deepEqual(interruptions, [{ interrupt: true }]);
    const recovered = service.getBoard().review;
    assert.equal(recovered.pendingSince, 0);
    assert.match(recovered.reports[0].text, /ERROR: 작업이 멈춤/);
    assert.equal(recovered.cycleStartedAt, 0);
    time = recovered.recoveryAfter; tick();
    assert.equal(messages.length, 3);
    service.reportBoardReview(service.getBoard().review.pendingSince, { report: '멈춘 명령을 수정하고 작업 재개' });
    assert.equal(service.getBoard().review.cycleStartedAt, 0);
    service.updateBoardReview({ stallMinutes: 0 });
    time = service.getBoard().review.nextDueAt; tick();
    time += 3_600_000; tick();
    assert.equal(interruptions.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('launch permission settings require local access, validate both providers and persist independently of supervision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-permissions-'));
  try {
    const file = join(directory, 'board.json');
    const service = createBoardService(file);
    const routes = {};
    register({ ...service, addRoute: (method, path, handler) => { routes[`${method} ${path}`] = handler; },
      json: (res, body, status = 200) => Object.assign(res, { body, status }), readBody: async req => req.body,
      isLocalhost: req => req.local === true });
    const configure = routes['PUT /api/board/permissions'];
    const request = async (body, local = true) => { const res = {}; await configure({ body, local }, res); return res; };
    assert.equal((await request({ codex: 'full', claude: 'full' }, false)).status, 403);
    assert.equal((await request({ codex: 'injected;command', claude: 'full' })).status, 400);
    assert.equal((await request({ codex: 'workspace', claude: 'auto' })).status, 200);
    assert.deepEqual(createBoardService(file).getBoard().review.launchPermissions, { codex: 'workspace', claude: 'auto' });
    assert.equal(service.getBoard().review.status, 'stopped');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('opted-in recovery is bounded, avoids unknown processes, resets after a report and obeys stop', () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-recovery-'));
  try {
    const service = createBoardService(join(directory, 'board.json'));
    service.updateBoardReview({ termId: 'manager', autoRecover: true, watched: [{ termId: 'worker', goal: '검증' }] });
    let time = 1000;
    let agent = null;
    let recoveries = 0;
    const messages = [];
    const tick = createBoardReviewer({ ...service, now: () => time, resolveTerminalRef: () => ({ entry: { pty: { write: value => messages.push(value) } } }),
      terminalAgent: () => agent, recoverSupervisor: () => { recoveries++; } });
    tick(); assert.equal(recoveries, 0);
    agent = '';
    tick(); tick(); assert.equal(recoveries, 1);
    time = service.getBoard().review.recoveryAfter;
    tick(); assert.equal(recoveries, 2);
    time = service.getBoard().review.recoveryAfter;
    tick(); assert.equal(recoveries, 3);
    time = service.getBoard().review.recoveryAfter;
    tick(); assert.equal(recoveries, 3);
    assert.match(service.getBoard().review.lastError, /3회/);
    agent = 'codex'; tick();
    assert.equal(messages.length, 1);
    service.reportBoardReview(service.getBoard().review.pendingSince, { report: '저장된 목표 확인 후 작업 재개' });
    assert.equal(service.getBoard().review.recoveryAttempts, 0);
    service.updateBoardReview({ status: 'stopped' });
    agent = ''; time += 60_000; tick(); assert.equal(recoveries, 3);
    service.updateBoardReview({ status: 'running', autoRecover: false });
    tick(); assert.equal(recoveries, 3);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('supervision pins workers, backs off unanswered checks, persists reports and stops after evidenced completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-supervision-'));
  try {
    const file = join(directory, 'board.json');
    const service = createBoardService(file);
    const messages = [];
    const resolveTerminalRef = ref => ['ai8', 'manager', 'ai2', 'worker'].includes(ref)
      ? { id: ['ai8', 'manager'].includes(ref) ? 'manager' : 'worker', entry: { alias: ['ai8', 'manager'].includes(ref) ? 'ai8' : 'ai2', pty: { write: text => messages.push(text) } } } : null;
    const routes = {};
    register({ ...service, addRoute: (method, path, handler) => { routes[`${method} ${path}`] = handler; },
      json: (res, body, status = 200) => Object.assign(res, { body, status }), readBody: async req => req.body,
      isLocalhost: () => true, resolveTerminalRef, terminalAgent: () => 'codex' });
    const configure = async watched => { const res = {}; await routes['PUT /api/board/review']({ body: { target: 'ai8', intervalMinutes: 1, objective: '밤새 검증', watched } }, res); return res; };
    assert.equal((await configure([{ target: 'ai8', goal: '테스트 통과' }])).status, 400);
    assert.equal((await configure([{ target: 'ai2', goal: '' }])).status, 400);
    assert.equal((await configure([{ target: 'ai2', goal: '테스트 통과' }, { target: 'worker', goal: '중복' }])).status, 400);
    assert.equal((await configure([{ target: 'ai2', goal: '로그인 테스트 통과' }])).status, 200);
    assert.deepEqual(createBoardService(file).getBoard().review.watched, [{ termId: 'worker', alias: 'ai2', goal: '로그인 테스트 통과' }]);
    let time = Date.now() + 1000;
    const reads = [];
    const tick = createBoardReviewer({ ...service, now: () => time, resolveTerminalRef, terminalAgent: () => 'codex',
      readTerminalScreen: id => { reads.push(id); return { lines: ['테스트 실행 중'] }; } });
    tick(); tick();
    assert.equal(messages.length, 1);
    assert.deepEqual(reads, ['manager', 'worker']);
    assert.match(messages[0], /로그인 테스트 통과/);
    const first = service.getBoard().review;
    assert.throws(() => service.reportBoardReview(first.pendingSince), /근거/);
    time = first.retryAt - 1; tick(); assert.equal(messages.length, 1);
    time++; tick(); assert.equal(messages.length, 2);
    const second = service.getBoard().review;
    assert.equal(second.retryAt - second.pendingSince, 600_000);
    assert.throws(() => service.reportBoardReview(first.pendingSince, { report: '옛 보고' }), /현재 점검/);
    service.reportBoardReview(second.pendingSince, { status: 'waiting', report: 'ai2: 테스트 서버 선택 질문 등록. 사용자 답변 대기.' });
    time = service.getBoard().review.nextDueAt;
    tick();
    service.reportBoardReview(service.getBoard().review.pendingSince, { status: 'complete', report: 'ai2: 로그인 회귀 테스트 3개 통과 로그 확인.',
      progress: [{ termId: 'worker', artifact: '/tmp/login-test.log', version: '3-passed', result: '로그인 회귀 테스트 3개 통과' }] });
    time += 86_400_000; tick();
    assert.equal(messages.length, 3);
    assert.equal(createBoardService(file).getBoard().review.reports.length, 2);
    assert.equal(createBoardService(file).getBoard().review.status, 'complete');
    await configure([{ target: 'ai2', goal: '재검증' }]);
    tick();
    const pending = service.getBoard().review.pendingSince;
    const stopped = {};
    await routes['PUT /api/board/review']({ body: { target: '' } }, stopped);
    assert.equal(stopped.status, 200);
    assert.throws(() => service.reportBoardReview(pending, { report: '중지 후 보고' }), /현재 점검/);
    time += 86_400_000; tick(); assert.equal(messages.length, 4);
    service.updateBoardReview({ termId: 'manager' });
    const priorReports = service.getBoard().review.reports.length;
    for (let index = 0; index < 100; index++) {
      service.updateBoardReview({ pendingSince: index + 1 });
      service.reportBoardReview(index + 1, { report: `야간 점검 ${index}` });
    }
    const overnight = createBoardService(file).getBoard().review.reports;
    assert.equal(overnight.length, priorReports + 100);
    assert.match(overnight[0].text, /ai2/);
    assert.equal(overnight.at(-1).text, '야간 점검 99');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('one manager covers every existing and newly added checklist with one pending reminder', () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-review-all-'));
  try {
    const service = createBoardService(join(directory, 'board.json'));
    service.updateBoardReview({ termId: 'manager', intervalMinutes: 5 });
    const messages = [];
    const tick = createBoardReviewer({ ...service, now: () => 1000, terminalAgent: () => 'codex',
      resolveTerminalRef: () => ({ entry: { pty: { write: message => messages.push(message) } } }) });
    tick();
    assert.equal(messages.length, 0);
    const before = service.getBoard();
    service.replaceBoardIfRevision({ ...before, checklists: [
      { id: 'C-0001', title: '첫 프로젝트' }, { id: 'C-0002', title: '다음 프로젝트' },
    ] }, before.revision);
    service.addBoardTask('추가 질문', 'C-0002', 'question');
    tick();
    service.addBoardTask('추가 작업', 'C-0001');
    tick();
    assert.equal(messages.length, 1);
    assert.match(messages[0], /모든 체크리스트/);
    assert.match(messages[0], /새 체크리스트도 확인 대상/);
    assert.equal(service.getBoard().review.termId, 'manager');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('goals and answers survive restart; reminders require acknowledgement and never retarget a missing session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-review-'));
  try {
    const file = join(directory, 'board.json');
    const service = createBoardService(file);
    service.replaceBoard({ checklists: [{ id: 'C-0001', title: '진행 관리', goal: '모든 검증 통과' }] });
    const question = service.addBoardTask('배포 대상?', 'C-0001', 'question').task;
    service.updateBoardTask(question.id, { answer: '스테이징' });
    const restarted = createBoardService(file).getBoard();
    assert.equal(restarted.checklists[0].goal, '모든 검증 통과');
    assert.equal(restarted.tasks[0].answer, '스테이징');
    assert.equal(restarted.tasks[0].done, false);
    service.updateBoardReview({ termId: 'stable-id', intervalMinutes: 5 });
    let time = 1000;
    let running = true;
    const messages = [];
    const resolveTerminalRef = ref => running && ref === 'stable-id' ? { id: ref, entry: { pty: { write: message => messages.push(message) } } } : null;
    const tick = createBoardReviewer({ ...service, resolveTerminalRef, terminalAgent: () => 'codex', now: () => time });
    const beforeReminder = service.getBoard();
    tick();
    assert.equal(service.getBoard().revision, beforeReminder.revision);
    beforeReminder.tasks[0].answer = '스테이징';
    service.replaceBoardIfRevision(beforeReminder, beforeReminder.revision);
    assert.equal(service.getBoard().review.pendingSince, 1000);
    time += 600_000;
    tick();
    assert.equal(messages.length, 1);
    assert.match(messages[0], /"pendingSince":1000/);
    assert.match(messages[0], /Content-Type: application\/json/);
    const snapshot = service.getBoard();
    snapshot.review.pendingSince = 0;
    service.replaceBoardIfRevision(snapshot, snapshot.revision);
    assert.equal(service.getBoard().review.pendingSince, 1000);
    assert.throws(() => service.updateBoardReview({ pendingSince: 0 }, 999), /request changed/);

    const routes = {};
    register({ ...service, addRoute: (method, path, handler) => { routes[`${method} ${path}`] = handler; },
      json: (res, body, status = 200) => Object.assign(res, { body, status }), readBody: async req => req.body,
      isLocalhost: req => req.local === true, resolveTerminalRef, terminalAgent: () => 'codex',
      get terminals() { throw new Error('Terminal registry is not initialized during route registration'); } });
    const ack = routes['POST /api/board/review'];
    const denied = {};
    await ack({ body: { pendingSince: 1000 }, params: { id: 'C-0001' } }, denied);
    assert.equal(denied.status, 403);
    const response = {};
    await ack({ local: true, body: { pendingSince: 1000 }, params: { id: 'C-0001' } }, response);
    assert.equal(response.status, 200);
    const review = service.getBoard().review;
    assert.equal(review.pendingSince, 0);
    assert.equal(review.nextDueAt - review.lastReviewedAt, 300_000);
    time = review.nextDueAt - 1;
    tick();
    assert.equal(messages.length, 1);
    time++;
    running = false;
    tick();
    assert.equal(messages.length, 1);
    running = true;
    tick();
    assert.equal(messages.length, 2);
    const configure = routes['PUT /api/board/review'];
    const invalid = {};
    await configure({ local: true, params: { id: 'C-0001' }, body: { target: 'missing', intervalMinutes: 0 } }, invalid);
    assert.equal(invalid.status, 400);
    const disabled = {};
    await configure({ local: true, params: { id: 'C-0001' }, body: { target: '', intervalMinutes: 5 } }, disabled);
    assert.equal(disabled.status, 200);
    time += 600_000;
    tick();
    assert.equal(messages.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
