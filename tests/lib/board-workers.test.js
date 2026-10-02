import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createBoardService } from '../../lib/board-service.js';
import { createBoardReviewer } from '../../lib/board-review.js';
import { workerScreenState } from '../../lib/board-workers.js';
import { register } from '../../routes/board.js';

function setup(t) {
  const dir = mkdtempSync('/tmp/cockpit-worker-test-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = 1_800_000;
  t.mock.method(Date, 'now', () => time);
  const file = `${dir}/board.json`;
  const service = createBoardService(file);
  service.updateBoardReview({ termId: 'manager', objective: '두 목표 달성', nextDueAt: time + 3_600_000,
    watched: [{ termId: 'one', goal: '첫 목표 완료' }, { termId: 'two', goal: '둘째 목표 완료' }] });
  const screens = { one: '› Ask Codex to do anything', two: '› Ask Codex to do anything' };
  const messages = [];
  let inspect = () => {};
  const options = { ...service, now: () => time,
    resolveTerminalRef: id => ({ id, entry: { pty: { write: text => messages.push({ id, text }) } } }), terminalAgent: () => 'codex',
    readTerminalScreen: id => { inspect(id); return { current: true, lines: (screens[id] || '').split('\n') }; } };
  let tick = createBoardReviewer(options);
  const worker = id => service.getBoard().review.workerProgress.find(item => item.termId === id);
  const report = (id, status, rest = {}) => service.reportBoardWorker({ termId: id, token: worker(id).run.token, status, summary: '근거와 결과', ...rest });
  const supervisor = progress => {
    service.updateBoardReview({ pendingSince: time });
    service.reportBoardReview(time, { report: '결과 대조', progress });
  };
  return { service, screens, messages, worker, report, supervisor,
    tick: () => tick(), advance: (ms = 15_000) => { time += ms; }, inspect: fn => { inspect = fn; },
    restart: () => { tick = createBoardReviewer({ ...options, ...createBoardService(file) }); } };
}

test('each idle worker receives its own full goal without waiting for the supervisor, then continues after a partial result', t => {
  const h = setup(t);
  h.tick(); assert.equal(h.messages.length, 0);
  h.advance(); h.tick();
  assert.deepEqual(h.messages.map(item => item.id), ['one', 'two']);
  assert.match(h.messages[0].text, /첫 목표 완료/);
  assert.match(h.messages[1].text, /둘째 목표 완료/);
  assert.match(h.messages[0].text, /한 단계 종료나 중간 보고 후 감독의 다음 지시를 기다리지/);
  h.screens.one = 'Working (5s • esc to interrupt)\n› Ask Codex to do anything';
  h.advance(180_000); h.tick();
  assert.equal(h.messages.filter(item => item.id === 'one').length, 1);
  h.report('one', 'working', { summary: '첫 단계 검증 완료, 최종 조건 미완료' });
  assert.equal(h.worker('one').lastProgressAt, 0, 'self reports are not verified progress');
  assert.equal(h.service.getBoard().review.nextDueAt, Date.now());
  h.screens.one = '첫 단계 종료\n› Ask Codex to do anything';
  h.tick(); h.advance(); h.tick();
  assert.equal(h.messages.filter(item => item.id === 'one').length, 2);
});

test('busy, approval, paused, typed input, unknown and stale screens never receive continuation input', t => {
  const h = setup(t);
  for (const screen of [
    'Working (2m • esc to interrupt)\n› Ask Codex to do anything',
    'Would you like to run the following command?\n1. Yes\n› Ask Codex to do anything',
    'Goal paused (/goal resume)\n› Ask Codex to do anything',
    'Goal budget limit reached\n› Ask Codex to do anything',
    '› 사용자 작성 중인 메시지', '쉘 $',
    '›\n  아직 작성 중인 명령\n  ? for shortcuts',
    'Conversation interrupted – tell the model what to do differently.\n› Ask Codex to do anything',
  ]) {
    h.screens.one = screen; h.screens.two = screen;
    h.tick(); h.advance(700_000); h.tick();
    assert.equal(h.messages.filter(item => item.id !== 'manager').length, 0, screen);
  }
  assert.equal(workerScreenState({ current: false, lines: ['› Ask Codex to do anything'] }, 'codex'), 'unknown');
  assert.equal(workerScreenState({ current: true, lines: ['❯'] }, 'claude'), 'idle');
  assert.equal(workerScreenState({ current: true, lines: ['사용자 일시정지, 도구 승인, 로그인, 추가 권한은 그대로 존중하세요.',
    'Tool output: Sign in page detected', '단계 완료', '› Ask Codex to do anything', ' GPT-6-Astra high… Goal paused (/goal resume)'] }, 'codex'), 'paused');
  assert.equal(workerScreenState({ current: true, lines: ['사용자 일시정지, 도구 승인, 로그인, 추가 권한은 그대로 존중하세요.',
    'Tool output: Sign in page detected', '단계 완료', '› Ask Codex to do anything', ' GPT-6-Astra high fast · ~/project', '← for agents · ? for shortcuts'] }, 'codex'), 'idle');
});

test('unchanged blockers sleep; a new answer wakes only eligible workers and preserves a user pause', t => {
  const h = setup(t);
  const question = h.service.addBoardTask('필요한 정보', undefined, 'question').task;
  h.tick(); h.advance(); h.tick();
  h.report('one', 'blocked', { blocker: '사용자 정보 필요', alternatives: '다른 남은 조건도 같은 정보에 의존함', remaining: [{ condition: '첫 목표 완료', blocker: '사용자 정보 필요', nextAction: '정보를 반영해 구현' }] });
  h.screens.two = 'Goal paused (/goal resume)\n› Ask Codex to do anything';
  h.advance(700_000); h.tick(); h.advance(); h.tick();
  assert.equal(h.messages.filter(item => item.id === 'one').length, 1);
  h.service.updateBoardTask(question.id, { answer: '결정 완료' });
  h.tick();
  assert.equal(h.messages.filter(item => item.id === 'one').length, 2);
  assert.equal(h.messages.filter(item => item.id === 'two').length, 1);
});

test('worker completion requires supervisor verification and incomplete claims return to that worker goal', t => {
  const h = setup(t);
  h.tick(); h.advance(); h.tick();
  h.report('one', 'complete', { summary: '검증 로그 /tmp/one.log, SHA abc' });
  assert.equal(h.worker('one').run.status, 'reported');
  h.advance(700_000); h.tick(); h.advance(); h.tick();
  assert.equal(h.messages.filter(item => item.id === 'one').length, 1);
  assert.throws(() => h.supervisor([{ termId: 'one', workState: 'complete' }]), /검증한 결과물/);
  h.supervisor([{ termId: 'one', workState: 'ready', nextAction: '남은 두 번째 조건 검증' }]);
  h.tick(); h.advance(); h.tick();
  assert.equal(h.messages.filter(item => item.id === 'one').length, 2);
  h.report('one', 'complete');
  h.supervisor([{ termId: 'one', workState: 'complete', artifact: '/tmp/one.log', version: 'abc', result: '모든 조건 대조 완료' }]);
  h.advance(700_000); h.tick(); h.advance(); h.tick();
  assert.equal(h.messages.filter(item => item.id === 'one').length, 2);
  assert.ok(h.messages.filter(item => item.id === 'two').length > 1);
});

test('restart preserves delivery cooldown and stop, expiry, reassignment reject late reports', t => {
  const h = setup(t);
  h.tick(); h.advance(); h.tick();
  const token = h.worker('one').run.token;
  h.restart(); h.tick(); h.advance(); h.tick();
  assert.equal(h.messages.filter(item => item.id === 'one').length, 1);
  h.service.updateBoardReview({ status: 'stopped' });
  assert.throws(() => h.service.reportBoardWorker({ termId: 'one', token, status: 'working', summary: '옛 보고' }), /현재 작업자/);
  h.advance(700_000); h.tick();
  assert.equal(h.messages.filter(item => item.id !== 'manager').length, 2);
  h.service.updateBoardReview({ status: 'running', runUntil: Date.now() - 1 });
  h.tick(); assert.equal(h.service.getBoard().review.status, 'stopped');
  h.service.updateBoardReview({ status: 'running', runUntil: 0, watched: [{ termId: 'one', goal: '변경된 목표' }] });
  assert.throws(() => h.service.reportBoardWorker({ termId: 'one', token, status: 'complete', summary: '옛 완료' }), /현재 작업자/);
});

test('stop or approval appearing during the final screen check prevents Enter', t => {
  for (const action of ['stop', 'approval']) {
    const h = setup(t);
    h.tick(); h.advance();
    let reads = 0;
    h.inspect(id => {
      if (id === 'one' && ++reads === 2) {
        if (action === 'stop') h.service.updateBoardReview({ status: 'stopped' });
        else h.screens.one = 'Do you want to proceed?\n1. Yes\n› Ask Codex to do anything';
      }
    });
    h.tick();
    assert.equal(h.messages.filter(item => item.id === 'one').length, 0);
  }
});

test('worker report HTTP endpoint enforces local access, token identity and blocked alternatives', async t => {
  const h = setup(t);
  const handlers = {};
  register({ ...h.service, addRoute: (method, path, fn) => { handlers[`${method} ${path}`] = fn; },
    readBody: async req => req.body, isLocalhost: req => req.local,
    json: (res, body, status = 200) => Object.assign(res, { body, status }) });
  h.tick(); h.advance(); h.tick();
  const body = { termId: 'one', token: h.worker('one').run.token, status: 'blocked', summary: '진행 불가' };
  const call = async (data, local = true) => { const res = {}; await handlers['POST /api/board/worker-report']({ body: data, local }, res); return res; };
  assert.equal((await call(body, false)).status, 403);
  assert.equal((await call(body)).status, 400);
  assert.equal((await call({ ...body, status: 'working', token: 'old' })).status, 409);
  assert.equal((await call({ ...body, status: 'working' })).status, 200);
});


test('explicit resume reconciles native goal state once and waits for confirmation; passive polling preserves pauses', t => {
  const h = setup(t);
  h.screens.one = '› Ask Codex to do anything\nGPT-6-Astra high Goal paused (/goal resume)';
  h.tick(); h.advance(); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 0);
  h.service.resumeBoardWorker({ termId: 'one' });
  h.tick();
  assert.deepEqual(h.messages.filter(m => m.id === 'one').map(m => m.text), ['/goal resume\r']);
  assert.ok(h.worker('one').run.resumeSentAt);
  h.restart(); h.advance(); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
  h.screens.one = '› Ask Codex to do anything\nGPT-6-Astra high';
  h.tick(); h.advance(); h.tick();
  assert.equal(h.worker('one').run.resumeSentAt, 0);
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2);
  h.screens.one = '› Ask Codex to do anything\nGPT-6-Astra high Goal paused (/goal resume)';
  h.advance(900_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2, 'a later user pause is not overridden');
});

test('resume never types into approvals, drafts, limits or a stopped/reassigned supervisor', t => {
  for (const screen of [
    'Would you like to run the following command?\n1. Yes\n› Ask Codex to do anything\nGPT-6-Astra Goal paused',
    '› unfinished draft\nGPT-6-Astra Goal paused',
    '›\nGoal paused (/goal resume)\nGPT-6-Astra high',
    '› Ask Codex to do anything\nGPT-6-Astra Goal budget limit reached',
  ]) {
    const h = setup(t);
    h.screens.one = screen;
    h.service.resumeBoardWorker({ termId: 'one' });
    h.tick(); h.advance(61_000); h.tick();
    assert.equal(h.messages.filter(m => m.id === 'one').length, 0);
    assert.equal(h.worker('one').run.resumeRequestedAt, 0);
  }
  const h = setup(t);
  h.screens.one = '› Ask Codex to do anything\nGPT-6-Astra Goal paused';
  h.service.resumeBoardWorker({ termId: 'one' });
  let reads = 0;
  h.inspect(id => { if (id === 'one' && ++reads === 2) h.service.updateBoardReview({ status: 'stopped' }); });
  h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 0);
  assert.throws(() => h.service.resumeBoardWorker({ termId: 'one' }), /실행 중인 감독/);
});

test('running with a paused native goal is observed as busy without automatically unpausing it', t => {
  const h = setup(t);
  h.screens.one = 'Working (4s • esc to interrupt)\n› Ask Codex to do anything\nGPT-6-Astra Goal paused';
  h.tick(); h.advance(1_900_000); h.tick();
  assert.equal(h.worker('one').run.observed, 'busy');
  assert.equal(h.messages.filter(m => m.id === 'one').length, 0);
});

test('busy stall queues one check, wakes supervisor repeatedly, survives restart and never counts as progress', t => {
  const h = setup(t);
  h.screens.one = 'Waiting for agents\nWorking (30m • esc to interrupt)\n› Ask Codex to do anything\nGPT-6-Astra high';
  h.tick(); h.advance(1_800_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
  assert.match(h.messages.find(m => m.id === 'one').text, /정체 점검/);
  assert.equal(h.worker('one').lastProgressAt, 0);
  assert.equal(h.service.getBoard().review.nextDueAt, Date.now());
  h.restart(); h.advance(300_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
  assert.equal(h.worker('one').run.interventionAt, Date.now());
});

test('stall checks never submit a draft or an approval, including a last-moment dialog', t => {
  for (const mode of ['draft', 'approval', 'race']) {
    const h = setup(t);
    h.screens.one = 'Working (30m • esc to interrupt)\n› ' + (mode === 'draft' ? 'user draft' : 'Ask Codex to do anything');
    if (mode === 'approval') h.screens.one = 'Would you like to run the following command?\n1. Yes\n› Ask Codex to do anything';
    h.tick(); h.advance(1_800_000);
    let reads = 0;
    h.inspect(id => { if (mode === 'race' && id === 'one' && ++reads === 2) h.screens.one = 'Would you like to run the following command?\n1. Yes'; });
    h.tick();
    assert.equal(h.messages.filter(m => m.id === 'one').length, 0, mode);
  }
});

test('whole-worker blocking requires every remaining condition and gets a bounded dependency reassessment', t => {
  const h = setup(t);
  h.tick(); h.advance(); h.tick();
  assert.throws(() => h.report('one', 'blocked', { blocker: '한 설치 승인', alternatives: '대기' }), /remaining/);
  assert.throws(() => h.supervisor([{ termId: 'one', workState: 'blocked', blocker: '한 설치 승인' }]), /remaining/);
  h.report('one', 'blocked', { blocker: '정보 필요', alternatives: '남은 조건 전부 같은 정보 필요', remaining: [{ condition: '첫 목표', blocker: '정보 필요', nextAction: '정보 반영' }] });
  h.advance(899_000); h.tick(); h.advance(15_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2);
  assert.match(h.messages.filter(m => m.id === 'one')[1].text, /같은 외부 실패나 시험을 다시 실행하라는 뜻이 아닙니다/);
});

test('supervisor ready updates preserve in-flight worker reporting identity', t => {
  const h = setup(t);
  h.tick(); h.advance(); h.tick();
  const before = h.worker('one').run;
  h.supervisor([{ termId: 'one', workState: 'ready', nextAction: '다음 조건 계속' }]);
  assert.equal(h.worker('one').run.token, before.token);
  assert.equal(h.worker('one').run.lastSentAt, before.lastSentAt);
  h.report('one', 'working');
  assert.equal(h.worker('one').run.status, 'active');
});


test('a stall check deferred for a draft is delivered once the busy composer becomes empty', t => {
  const h = setup(t);
  h.screens.one = 'Working (30m • esc to interrupt)\n› user draft';
  h.tick(); h.advance(1_800_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 0);
  h.screens.one = 'Working (35m • esc to interrupt)\n› Ask Codex to do anything';
  h.advance(300_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
  h.restart(); h.advance(300_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
});

test('worker resume API is local and scoped to an assigned worker on an active supervisor', async t => {
  const h = setup(t); const handlers = {};
  register({ ...h.service, addRoute: (method, path, fn) => { handlers[`${method} ${path}`] = fn; },
    readBody: async req => req.body, isLocalhost: req => req.local,
    json: (res, body, status = 200) => Object.assign(res, { body, status }) });
  const call = async (body, local = true) => { const res = {}; await handlers['POST /api/board/worker-resume']({ body, local }, res); return res; };
  assert.equal((await call({ termId: 'one' }, false)).status, 403);
  assert.equal((await call({ termId: 'other' })).status, 409);
  assert.equal((await call({ termId: 'one' })).status, 200);
  h.service.updateBoardReview({ status: 'stopped' });
  assert.equal(h.worker('one').run.resumeRequestedAt, 0);
  assert.equal((await call({ termId: 'one' })).status, 409);
});
