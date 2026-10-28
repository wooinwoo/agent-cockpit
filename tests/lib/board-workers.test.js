import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createBoardService } from '../../lib/board-service.js';
import { createBoardReviewer } from '../../lib/board-review.js';
import { workerScreenState } from '../../lib/board-workers.js';
import { register } from '../../routes/board.js';

test('screen states match the shared Rust contract, including jcode busy composer inspection', () => {
  const cases = JSON.parse(readFileSync(new URL('../fixtures/rust-activity.json', import.meta.url), 'utf8'));
  for (const item of cases) assert.equal(workerScreenState({ current: item.current !== false, lines: item.lines }, item.agent, item), item.expected, JSON.stringify(item));
});

test('Claude native composer accepts its footer but never drafts, dialogs or a running turn', () => {
  const footer = ['────────────────────────', '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 …'];
  const check = lines => workerScreenState({ current: true, lines }, 'claude');
  assert.equal(check(['● CLAUDE_READY_ai1', '✻ Crunched for 11s · done 1:05 PM', '❯ ', ...footer]), 'idle');
  assert.equal(check(['✻ Lollygagging…', '❯ ', ...footer]), 'busy');
  assert.equal(check(['❯ 사용자 입력 중', ...footer]), 'unknown');
  assert.equal(check(['❯ ', '두 번째 줄 입력', ...footer]), 'unknown');
  assert.equal(check(['Do you want to proceed?', '1. Yes', '❯ ', ...footer]), 'approval');
  assert.equal(check(['❯ ', ...footer, 'unexpected warning']), 'unknown');
});

test('jcode observes live empty composers and rejects drafts, failures and stale screens', () => {
  const check = lines => workerScreenState({ current: true, lines }, 'jcode');
  assert.equal(check(['GPT-6.1 Sol xhigh', '3>   4.5k/200k ▱▱▱▱▱▱ 2%']), 'idle');
  assert.equal(check(['3>']), 'idle');
  const footer = '    ~/…/demo-repo ▱▱▱▱ 0% Claude Opus 5.5 medium';
  const wideFooter = '       ~/…/demo-repo  merge/dev-rpa ~57 ?117 ↑1 181k/1.0M ▰▰▱▱▱▱▱▱▱▱ 18% OAuth Claude Opus 5.5 xhigh';
  assert.equal(check(['3…                 \u{f059f}', wideFooter]), 'busy');
  assert.equal(check(['3>                 \u{f059f}', wideFooter]), 'idle');
  assert.equal(check(['3> 작성 중           \u{f059f}', wideFooter]), 'unknown');
  assert.equal(check(['3>', '여러 줄 초안', wideFooter]), 'unknown');
  assert.equal(check(['permission required', '3> \u{f059f}', wideFooter]), 'unknown');
  assert.equal(check(['3>', '/tmp ' + '1/1 '.repeat(100) + '0% Claude Opus 5.5 invalid']), 'unknown');
  assert.equal(check(['1>    ', footer, '']), 'idle');
  assert.equal(check(['2>                 \u{f059f}', footer]), 'idle');
  assert.equal(check(['2> 사용자 초안       \u{f059f}', footer]), 'unknown');
  assert.equal(check(['2>', '여러 줄 초안 \u{f059f}', footer]), 'unknown');
  assert.equal(check(['permission required', '2> \u{f059f}', footer]), 'unknown');
  assert.equal(check(['1>', '  ~/…/demo-repo  merge/dev-r… 0% Opus 5.5 medium']), 'idle');
  assert.equal(check(['1> 미전송', '  ~/…/demo-repo  merge/dev-r… 0% Opus 5.5 xhigh']), 'unknown');
  assert.equal(check(['1…', footer]), 'busy');
  assert.equal(check(['1> 사용자 초안', footer]), 'unknown');
  assert.equal(check(['1>', '여러 줄 초안', footer]), 'unknown');
  assert.equal(check(['permission required', '1>', footer]), 'unknown');
  assert.equal(check(['3> 사용자 작성 중']), 'unknown');
  assert.equal(check(['3>', '사용자 작성 중인 둘째 줄']), 'unknown');
  assert.equal(check(['3…']), 'busy');
  assert.equal(check(['invalid_request_error', '3>']), 'unknown');
  assert.equal(check(['Would you like to run this command?', '1. Yes', '3>']), 'approval');
  assert.equal(workerScreenState({ current: false, lines: ['3>'] }, 'jcode'), 'unknown');
});

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
  const held = new Set();
  const failDelivery = new Set();
  let inspect = () => {};
  const options = { ...service, now: () => time,
    sendAgentInput: (id, text) => { if (failDelivery.has(id)) throw new Error('composer changed'); messages.push({ id, text }); },
    resolveTerminalRef: id => ({ id, entry: { conversationHeld: held.has(id), pty: { write: text => messages.push({ id, text }) } } }), terminalAgent: () => 'codex',
    readTerminalScreen: id => { inspect(id); return { current: true, lines: (screens[id] || '').split('\n') }; } };
  let tick = createBoardReviewer(options);
  const worker = id => service.getBoard().review.workerProgress.find(item => item.termId === id);
  const report = (id, status, rest = {}) => service.reportBoardWorker({ termId: id, token: worker(id).run.token, status, summary: '근거와 결과', ...rest });
  const supervisor = progress => {
    service.updateBoardReview({ pendingSince: time });
    service.reportBoardReview(time, { report: '결과 대조', progress });
  };
  return { service, screens, messages, worker, report, supervisor, held, failDelivery,
    tick: () => tick(), advance: (ms = 15_000) => { time += ms; }, inspect: fn => { inspect = fn; },
    restart: () => { tick = createBoardReviewer({ ...options, ...createBoardService(file) }); } };
}

test('workers retain their work across manager context changes and report evidence without manager approval', t => {
  const h = setup(t);
  h.service.updateBoardReview({ workerDispatch: 'running', status: 'stopped' });
  h.tick(); h.advance(); h.tick();
  const token = h.worker('one').run.token;
  h.service.updateBoardReview({ objective: '관리자는 이제 결과 취합만 수행' });
  assert.equal(h.worker('one').run.token, token);
  h.advance(300_000);
  h.report('one', 'working', { artifact: '/results/test.log', version: 'sha-A', result: '12 PASS', nextAction: '두 번째 조건 구현' });
  const first = h.worker('one').run.progressAt;
  assert.equal(first, Date.now());
  assert.equal(h.worker('one').lastProgressAt, 0);
  assert.equal(h.worker('one').run.nextAction, '두 번째 조건 구현');
  h.screens.one = 'Working (1m • esc to interrupt)\n› Ask Codex to do anything';
  h.tick();
  assert.equal(h.worker('one').run.interventionAt, 0);
  h.advance(1000);
  h.report('one', 'working', { artifact: '/results/test.log', version: 'sha-B', result: '13 PASS' });
  const second = h.worker('one').run.progressAt;
  h.restart(); h.advance(1000);
  h.report('one', 'working', { artifact: '/results/test.log', version: 'sha-A', result: '문구만 바뀐 결과' });
  h.report('one', 'working', { summary: '아직 작업 중' });
  assert.equal(h.worker('one').run.progressAt, second, 'repeated A → B → A and status-only reports cannot refresh progress');
  assert.throws(() => h.report('one', 'working', { artifact: '/results/partial' }), /artifact/);
  assert.equal(h.service.getBoard().review.status, 'stopped');
  const prior = h.service.getBoard().review;
  h.service.updateBoardReview({ watched: prior.watched.map(w => w.termId === 'one' ? { ...w, goal: '새 작업 조건' } : w) });
  assert.equal(h.worker('one').run.progressAt, 0);
  assert.equal(h.worker('one').run.token, '');
});

test('peer evidence releases dependency waits without a supervisor report', t => {
  const h = setup(t);
  h.tick(); h.advance(); h.tick();
  h.report('one', 'blocked', { blocker: 'two 결과 필요', alternatives: '모든 조건이 같은 결과 필요',
    remaining: [{ condition: '첫 목표', blocker: 'two 결과 필요', nextAction: '결과 연결' }] });
  h.tick(); h.advance(); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
  h.report('two', 'working', { artifact: '/results/peer.json', version: 'sha-1', result: '연결 준비 완료' });
  h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2);
});

test('unchanged idle assignments are not periodically repeated even after unanswered prompts', t => {
  const h = setup(t);
  h.tick(); h.advance(); h.tick();
  const before = h.service.getBoard().review;
  h.service.updateBoardReview({ workerProgress: before.workerProgress.map(w => ({ ...w, run: { ...w.run, attempts: 10 } })) });
  h.tick(); h.advance(119_999); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
  h.advance(1); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
});

test('conversation protection isolates a worker, suppresses stall and resume input, and resumes current goals after release', t => {
  const h = setup(t);
  h.held.add('one');
  h.tick(); h.advance(900_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 0);
  assert.equal(h.messages.filter(m => m.id === 'two').length, 1);
  assert.equal(h.worker('one').run.interventionAt, 0);
  h.screens.one = '› Ask Codex to do anything\nGPT-6-Astra Goal paused';
  h.service.resumeBoardWorker({ termId: 'one' }); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 0);
  h.service.updateBoardReview({ watched: [{ termId: 'one', goal: '사용자와 정한 새 목표' }, { termId: 'two', goal: '둘째 목표 완료' }] });
  h.screens.one = '› Ask Codex to do anything';
  h.held.delete('one'); h.tick(); h.advance(); h.tick();
  assert.match(h.messages.find(m => m.id === 'one').text, /사용자와 정한 새 목표/);
});

test('a protected supervisor receives no reminder or recovery while independent workers continue', t => {
  const h = setup(t);
  h.screens.manager = '› Ask Codex to do anything';
  h.held.add('manager');
  h.service.updateBoardReview({ nextDueAt: 0, autoRecover: true, stallMinutes: 5, cycleStartedAt: 1 });
  h.tick(); h.advance(600_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'manager').length, 0);
  assert.equal(h.messages.filter(m => m.id !== 'manager').length, 2);
  assert.equal(h.service.getBoard().review.recoveryAttempts, 0);
  h.service.updateBoardReview({ cycleStartedAt: 0 });
  h.held.delete('manager'); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'manager').length, 1);
});

test('saved supervisor protection survives normalization and restart even when its terminal is missing', t => {
  const h = setup(t);
  h.service.updateBoardReview({ termId: 'manager', nextDueAt: 0, autoRecover: true,
    recoveryTerminal: { termId: 'manager', command: 'codex --no-daemon', durableId: 'saved', conversationHeld: true } });
  h.restart();
  assert.equal(h.service.getBoard().review.recoveryTerminal.conversationHeld, true);
  let recovered = 0;
  createBoardReviewer({ ...h.service, resolveTerminalRef: () => null, terminalAgent: () => '', recoverSupervisor: () => recovered++ })();
  assert.equal(recovered, 0);
  assert.equal(h.service.getBoard().review.recoveryAttempts, 0);
});

test('each worker receives its full goal once; a partial report does not replay the same instructions', t => {
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
  assert.equal(h.messages.filter(item => item.id === 'one').length, 1);
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
    h.tick(); h.advance(120_000); h.tick();
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
  h.advance(15_000); h.tick(); h.advance(); h.tick();
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
  assert.deepEqual(h.messages.filter(m => m.id === 'one').map(m => m.text), ['\x1b[200~/goal resume\x1b[201~']);
  assert.ok(h.worker('one').run.resumeSentAt);
  h.screens.one = '› /goal resume\nGPT-6-Astra high Goal paused (/goal resume)';
  h.restart(); h.advance(); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2);
  assert.equal(h.messages.filter(m => m.id === 'one')[1].text, '\r');
  h.screens.one = '› Ask Codex to do anything\nGPT-6-Astra high';
  h.tick(); h.advance(); h.tick();
  assert.equal(h.worker('one').run.resumeSentAt, 0);
  assert.equal(h.messages.filter(m => m.id === 'one').length, 3);
  h.screens.one = '› Ask Codex to do anything\nGPT-6-Astra high Goal paused (/goal resume)';
  h.advance(900_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 3, 'a later user pause is not overridden');
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
  assert.throws(() => h.service.resumeBoardWorker({ termId: 'one' }), /자동 진행이 켜진/);
});

test('running with a paused native goal is observed as busy without automatically unpausing it', t => {
  const h = setup(t);
  h.screens.one = 'Working (4s • esc to interrupt)\n› Ask Codex to do anything\nGPT-6-Astra Goal paused';
  h.tick(); h.advance(1_900_000); h.tick();
  assert.equal(h.worker('one').run.observed, 'busy');
  assert.equal(h.messages.filter(m => m.id === 'one').length, 0);
});

test('busy stall queues one check and one supervisor intervention across restart without claiming progress', t => {
  const h = setup(t);
  h.screens.one = 'Waiting for agents\nWorking (30m • esc to interrupt)\n› Ask Codex to do anything\nGPT-6-Astra high';
  h.tick(); h.advance(300_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
  assert.match(h.messages.find(m => m.id === 'one').text, /정체 점검/);
  assert.equal(h.worker('one').lastProgressAt, 0);
  assert.equal(h.service.getBoard().review.nextDueAt, Date.now());
  const interventionAt = h.worker('one').run.interventionAt;
  h.restart(); h.advance(300_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
  assert.equal(h.worker('one').run.interventionAt, interventionAt);
});

test('stall checks never submit a draft or an approval, including a last-moment dialog', t => {
  for (const mode of ['draft', 'approval', 'race']) {
    const h = setup(t);
    h.screens.one = 'Working (30m • esc to interrupt)\n› ' + (mode === 'draft' ? 'user draft' : 'Ask Codex to do anything');
    if (mode === 'approval') h.screens.one = 'Would you like to run the following command?\n1. Yes\n› Ask Codex to do anything';
    h.tick(); h.advance(300_000);
    let reads = 0;
    h.inspect(id => { if (mode === 'race' && id === 'one' && ++reads === 2) h.screens.one = 'Would you like to run the following command?\n1. Yes'; });
    h.tick();
    assert.equal(h.messages.filter(m => m.id === 'one').length, 0, mode);
  }
});

test('whole-worker blocking waits for changed evidence instead of polling unchanged dependencies', t => {
  const h = setup(t);
  h.tick(); h.advance(); h.tick();
  assert.throws(() => h.report('one', 'blocked', { blocker: '한 설치 승인', alternatives: '대기' }), /remaining/);
  assert.throws(() => h.supervisor([{ termId: 'one', workState: 'blocked', blocker: '한 설치 승인' }]), /remaining/);
  h.report('one', 'blocked', { blocker: '정보 필요', alternatives: '남은 조건 전부 같은 정보 필요', remaining: [{ condition: '첫 목표', blocker: '정보 필요', nextAction: '정보 반영' }] });
  const review = h.service.getBoard().review;
  h.service.updateBoardReview({ workerProgress: review.workerProgress.map(w => w.termId === 'one' ? { ...w, run: { ...w.run, attempts: 4 } } : w) });
  h.tick(); h.advance(3_600_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
  assert.equal(h.worker('one').run.interventionAt, 0, 'known unchanged blockers do not repeatedly request stall reviews');
  h.restart(); h.tick(); h.advance(3_600_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 1, 'waiting survives restart');
  h.report('two', 'working', { artifact: '/results/peer.json', version: 'source-1', result: '새 입력' });
  h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2);
  assert.match(h.messages.filter(m => m.id === 'one')[1].text, /직접 조사/);
  h.tick(); h.advance(3_600_000); h.tick();
  h.restart(); h.tick(); h.advance(3_600_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2, 'one changed input is not redispatched while its worker report is missing');
  h.report('one', 'working', { nextAction: '연결한 원전으로 구현' });
  h.tick(); h.advance(30_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2, 'a working acknowledgement does not need another goal replay');
});

test('a concrete ready action releases an unchanged blocked dependency', t => {
  const h = setup(t);
  h.tick(); h.advance(); h.tick();
  h.report('one', 'blocked', { blocker: '원전 전달 대기', alternatives: '직접 조사하지 않았음',
    remaining: [{ condition: '첫 목표', blocker: '원전 필요', nextAction: '원전 연결' }] });
  h.supervisor([{ termId: 'one', workState: 'ready', nextAction: '기존 허용 경로에서 원전을 직접 조사하고 미구현 단위를 구현' }]);
  h.tick(); h.advance(120_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2);
  assert.match(h.messages.filter(m => m.id === 'one')[1].text, /기존 허용 경로에서 원전을 직접 조사/);
});

test('editing an existing source task or reference path wakes a blocked worker once', t => {
  for (const source of ['task', 'reference']) {
    const h = setup(t);
    const task = h.service.addBoardTask('기존 원전 지원 요청').task;
    h.tick(); h.advance(); h.tick();
    h.report('one', 'blocked', { blocker: '원전 필요', alternatives: '남은 조건 모두 의존',
      remaining: [{ condition: '첫 목표', blocker: '원전 필요', nextAction: '원전 연결' }] });
    h.tick(); h.advance(3_600_000); h.tick();
    assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
    if (source === 'task') h.service.updateBoardTask(task.id, { text: '원전 FILE /results/new-source.js SHA source-1' });
    else h.service.updateBoardReview({ referencePaths: ['/results/new-source.js'] });
    h.tick();
    assert.equal(h.messages.filter(m => m.id === 'one').length, 2, source);
    h.service.updateBoardTask(task.id, { text: h.service.getBoard().tasks.find(item => item.id === task.id).text });
    h.tick(); h.advance(3_600_000); h.tick();
    h.restart(); h.tick(); h.advance(3_600_000); h.tick();
    assert.equal(h.messages.filter(m => m.id === 'one').length, 2, 'timestamps and restart do not duplicate a source update');
  }
});

test('a failed dependency wake is retried rather than parked as a delivered input', t => {
  const h = setup(t);
  h.tick(); h.advance(); h.tick();
  h.report('one', 'blocked', { blocker: '원전 필요', alternatives: '남은 조건 모두 의존',
    remaining: [{ condition: '첫 목표', blocker: '원전 필요', nextAction: '원전 연결' }] });
  h.tick(); h.advance();
  h.report('two', 'working', { artifact: '/results/peer.json', version: 'source-1', result: '새 입력' });
  h.failDelivery.add('one');
  h.tick();
  assert.match(h.worker('one').run.lastError, /목표 전달 실패/);
  h.failDelivery.delete('one');
  h.tick(); h.advance(3_600_000); h.tick();
  assert.equal(h.messages.filter(m => m.id === 'one').length, 2, 'failed delivery remains retryable after the stall deadline');
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
  h.tick(); h.advance(300_000); h.tick();
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


test('two-phase resume never submits a changed draft or a dialog on the next tick', t => {
  for (const changed of ['› /goal resume plus user text\nGPT-6-Astra Goal paused', 'Would you like to run the following command?\n1. Yes\n› /goal resume\nGPT-6-Astra Goal paused']) {
    const h = setup(t);
    h.screens.one = '› Ask Codex to do anything\nGPT-6-Astra Goal paused';
    h.service.resumeBoardWorker({ termId: 'one' }); h.tick();
    h.screens.one = changed;
    h.advance(); h.tick(); h.advance(31_000); h.tick();
    assert.equal(h.messages.filter(m => m.id === 'one').length, 1);
    assert.equal(h.worker('one').run.resumeSentAt, 0);
    assert.match(h.worker('one').run.lastError, /재개가 확인되지/);
  }
});
