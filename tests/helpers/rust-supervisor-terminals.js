import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Exercise the actual timer and respawn-pane command in private tmux servers.
// Export only a fixture-local Bash function so login-shell PATH changes can
// never select an installed AI executable during recovery.
export async function verifySupervisorTerminals({ api, check, until, observed, directory, fixture, checkpoint, tmux, restart, connect, url }) {
  const folder = join(fixture.project, 'supervisors');
  await mkdir(folder);
  const eventsPath = join(folder, 'events');
  await writeFile(eventsPath, '');
  for (const label of ['one', 'two', 'held', 'worker']) await writeFile(join(folder, `mode-${label}`), 'idle');
  const fake = join(fixture.project, 'codex');
  await writeFile(fake, `#!${process.execPath}
import fs from 'node:fs';
const label=process.argv.find(s=>s.startsWith('--label=')).slice(8),folder=${JSON.stringify(folder)};
const screens={idle:['› Ask Codex to do anything','GPT-6.1-Sol xhigh'],busy:['Working (esc to interrupt)','›'],busyDraft:['Working (esc to interrupt)','› 사용자가 작성 중인 초안'],interruptedDraft:['Conversation interrupted','› 사용자가 작성 중인 초안'],paused:['›','GPT-6.1-Sol Goal paused'],approval:['Do you want to proceed?','1. Yes','2. No'],unknown:['›','사용자 작성 중인 둘째 줄']};
let current='',buffer='';
function render(mode){process.stdout.write('\\x1b[2J\\x1b[H'+screens[mode].join('\\r\\n'));}
function poll(){const next=fs.readFileSync(folder+'/mode-'+label,'utf8');if(next!==current){current=next;render(next.split('\\n')[0]);}}
function record(kind,data){fs.appendFileSync(folder+'/events',JSON.stringify({label,kind,data,pid:process.pid,at:Date.now()})+'\\n');}
record('start',process.argv);process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();process.stdout.write('\\x1b[?2004h');poll();setInterval(poll,20);
process.stdin.on('data',data=>{buffer+=data;if(buffer.endsWith('\\x1b[201~\\r')){record('reminder',buffer);buffer='';render('busy');}});
`, { mode: 0o700 });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await restart({ 'BASH_FUNC_codex%%': `() { exec ${quote(process.execPath)} ${quote(fake)} "$@"; }` });
  let monitor = await connect();
  const boardPath = join(directory, '.cockpit-board.json');
  const original = (await api('/api/board')).data;
  const readBoard = async () => (await api('/api/board')).data;
  const saveBoard = async board => {
    board.review = board.supervisors[0];
    await writeFile(boardPath + '.next', JSON.stringify(board)); await rename(boardPath + '.next', boardPath);
  };
  const patch = async (id, updates) => {
    const board = await readBoard(); Object.assign(board.supervisors.find(r => r.id === id), updates); await saveBoard(board);
  };
  const send = (method, route, body) => api(`/api/board/${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const events = async () => (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const count = async (label, kind) => (await events()).filter(e => e.label === label && e.kind === kind).length;
  const wait = (fn, label) => until(fn, label, 50_000);
  const terms = {};
  const reviews = {};
  const pane = label => tmux(terms[label].durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid} #{pane_dead}']);
  const mode = async (label, state) => {
    const path = join(folder, `mode-${label}`); await writeFile(path + '.next', `${state}\n${Date.now()}`); await rename(path + '.next', path);
    await observed(terms[label].termId, state === 'busyDraft' ? 'busy' : state === 'interruptedDraft' ? 'interrupted' : state);
  };
  const held = async (label, value) => check((await api(`/api/terminals/${terms[label].termId}/conversation`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ held: value }) })).status, 200, 'Change conversation protection');
  try {
    for (const label of ['one', 'two', 'held', 'worker']) {
      const cursor = monitor.messages.length;
      monitor.send({ type: 'create', projectId: 'sample', command: `codex --no-daemon --label=${label}`, cols: 160, rows: 35 });
      const created = await until(() => monitor.messages.slice(cursor).find(m => m.type === 'created'), 'Create fake supervisor');
      await observed(created.termId, 'idle');
      terms[label] = (await checkpoint()).terminals.find(t => t.termId === created.termId);
      check((await count(label, 'start')), 1, 'Launch one fake executable');
    }
    for (const label of ['one', 'two', 'held']) {
      if (label === 'one') reviews[label] = 'S-0001';
      else { const response = await send('POST', 'supervisors', { name: label }); check(response.status, 201, 'Create separate manager'); reviews[label] = response.data.supervisor.id; }
      check((await send('PUT', 'review', { supervisorId: reviews[label], target: terms[label].termId, autoRecover: true, stallMinutes: 5, intervalMinutes: 1,
        objective: `${label} 보존 목표`, referencePaths: ['/fixture/참고 자료'], watched: label === 'one' ? [{ target: terms.worker.termId, goal: '작업 결과 검증' }] : [] })).status, 200, 'Configure recovery with exact launcher');
      const previousDispatch = (await readBoard()).supervisors.find(review => review.id === reviews[label]).workerDispatch;
      check((await send('PATCH', 'worker-dispatch', { supervisorId: reviews[label], mode: 'paused', expected: previousDispatch })).status, 200, 'Keep fixture worker dispatch paused');
      check(tmux(terms[label].durableId, ['show-options', '-wv', 'remain-on-exit']), 'on', 'Retain opted-in pane on agent exit');
    }
    await held('held', true); await mode('two', 'approval');
    await patch(reviews.two, { cycleStartedAt: Date.now() - 360_000 });
    const initial = await readBoard();
    const firstPid = pane('one');
    await wait(async () => await count('one', 'reminder') === 1, 'First supervisor reminder');
    await wait(async () => (await readBoard()).supervisors.find(r => r.id === reviews.two).cycleStartedAt === 0, 'Approval clears recovery cycle');
    check(await count('two', 'reminder'), 0, 'Approval dialog receives no reminder');
    check(await count('held', 'reminder'), 0, 'Held supervisor receives no reminder');
    check(await count('two', 'start'), 1, 'Approval is not forcibly restarted');
    check(pane('one'), firstPid, 'Healthy manager process is preserved');
    const first = (await events()).find(e => e.label === 'one' && e.kind === 'reminder');
    let current = (await readBoard()).review;
    check(first.data.includes(`"pendingSince":${current.pendingSince}`), true, 'Persist reminder claim before delivery');

    const oracle = join(folder, 'oracle.mjs'); const input = join(folder, 'oracle.json');
    await writeFile(input, JSON.stringify({ board: initial, time: current.pendingSince, port: Number(new URL(url()).port), terms, reviews }));
    await writeFile(oracle, `import fs from 'node:fs';
import {createBoardReviewer} from ${JSON.stringify('file://' + join(fixture.directory, 'app/lib/board-review.js'))};
const input=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'));let board=input.board;const writes=[];
createBoardReviewer({getBoard:()=>board,updateBoardReview:(updates,_expected,id)=>{const review={...board.supervisors.find(r=>r.id===id),...updates};board.supervisors=board.supervisors.map(r=>r.id===id?review:r);board.review=board.supervisors[0];return {...board,review};},
resolveTerminalRef:id=>({id,entry:{durableId:'fixture',conversationHeld:id===input.terms.held.termId}}),terminalAgent:()=> 'codex',readTerminalScreen:id=>({current:true,lines:id===input.terms.two.termId?['Do you want to proceed?','1. Yes','2. No']:['› Ask Codex to do anything','GPT-6.1-Sol xhigh']}),sendAgentInput:(id,data)=>writes.push({id,data}),PORT:input.port,now:()=>input.time})();process.stdout.write(JSON.stringify(writes));
`);
    const expected = JSON.parse(execFileSync(process.execPath, ['--import', join(fixture.directory, 'isolate-home.mjs'), oracle], { env: fixture.env, encoding: 'utf8', timeout: 5000 }));
    check(first.data, expected.find(e => e.id === terms.one.termId).data, 'Complete supervisor wire message matches original Node');
    check((await send('POST', 'review', { supervisorId: reviews.one, pendingSince: current.pendingSince, status: 'running', report: '재시작 후 보존할 검증 기록' })).status, 200, 'Manager acknowledges persisted request');
    current = (await readBoard()).review;
    check(current.pendingSince, 0, 'Acknowledgment clears outstanding reminder');
    check(current.recoveryAttempts, 0, 'Acknowledgment resets recovery attempts');
    console.log(JSON.stringify({ phase: 'supervisor-reminder-and-guards', status: 'passed' }));

    await mode('two', 'paused'); await patch(reviews.two, { cycleStartedAt: Date.now() - 360_000 });
    const deadPid = Number(firstPid.split(' ')[0]); process.kill(deadPid, 'SIGKILL');
    await until(() => pane('one').endsWith(' 1'), 'Retained dead pane');
    await wait(async () => await count('one', 'start') === 2, 'Automatic dead supervisor recovery');
    await observed(terms.one.termId, 'idle');
    const recoveredPid = pane('one');
    check(recoveredPid !== firstPid, true, 'Recovery replaces dead process');
    check((await events()).filter(e => e.label === 'one' && e.kind === 'start').every(e => e.data.includes(fake)), true, 'All recovery launches use isolated fake AI');
    check((await readBoard()).review.reports.some(r => r.text === '재시작 후 보존할 검증 기록'), true, 'Recovery preserves reports');
    check((await readBoard()).review.objective, 'one 보존 목표', 'Recovery preserves goal');
    check(await count('two', 'start'), 1, 'Paused supervisor is not restarted');
    check(await count('two', 'reminder'), 0, 'Paused supervisor is not resumed');

    await mode('two', 'busyDraft'); await patch(reviews.two, { cycleStartedAt: Date.now() - 360_000 });
    await wait(async () => (await readBoard()).supervisors.find(r => r.id === reviews.two).lastError.includes('불명확'), 'Busy composer draft blocks recovery');
    check(await count('two', 'start'), 1, 'Busy supervisor draft is never discarded by automatic recovery');
    check(await count('two', 'reminder'), 0, 'Busy supervisor draft receives no automatic text');
    await mode('two', 'interruptedDraft'); await patch(reviews.two, { lastError: '', cycleStartedAt: Date.now() - 360_000 });
    await wait(async () => (await readBoard()).supervisors.find(r => r.id === reviews.two).lastError.includes('불명확'), 'Interrupted composer draft blocks recovery');
    check(await count('two', 'start'), 1, 'Interrupted supervisor draft is never discarded by automatic recovery');
    await mode('two', 'unknown'); await patch(reviews.two, { lastError: '', cycleStartedAt: Date.now() - 360_000 });
    await mode('one', 'busy'); await patch(reviews.one, { recoveryAfter: 0, cycleStartedAt: Date.now() - 360_000 });
    await wait(async () => await count('one', 'start') === 3, 'Report deadline restarts stalled manager');
    check(pane('one') !== recoveredPid, true, 'Stalled process is replaced');
    check((await readBoard()).review.reports.some(r => r.status === 'interrupted' && r.text.includes('관측 데이터')), true, 'Stall recovery retains observation report');
    await wait(async () => (await readBoard()).supervisors.find(r => r.id === reviews.two).lastError.includes('불명확'), 'Unknown screen blocks recovery');
    check(await count('two', 'start'), 1, 'User draft is preserved after report deadline');
    check(await count('two', 'reminder'), 0, 'User draft receives no automatic text');
    await mode('two', 'paused');
    await mode('one', 'idle');
    // Explicitly request a fresh review; an unchanged acknowledged mission stays quiet.
    await patch(reviews.one, { recoveryAfter: 0, nextDueAt: 0, cycleStartedAt: 0, lastReviewKey: '' });
    await wait(async () => await count('one', 'reminder') === 2, 'Recovered manager receives saved mission');
    current = (await readBoard()).review;
    check((await send('POST', 'review', { supervisorId: reviews.one, pendingSince: current.pendingSince, status: 'running', report: '복구 후 재개 확인' })).status, 200, 'Recovered manager reports normally');
    console.log(JSON.stringify({ phase: 'supervisor-dead-and-stall-recovery', status: 'passed' }));

    // Three failed cycles rest rather than hammering the launcher; the deadline
    // bounds the rest and a fresh configuration cannot be overwritten.
    await mode('one', 'busy');
    await patch(reviews.one, { recoveryAttempts: 3, recoveryAfter: 0, cycleStartedAt: Date.now() - 360_000, runUntil: Date.now() + 120_000 });
    await wait(async () => (await readBoard()).review.lastError.includes('5분 뒤'), 'Three-attempt cooldown');
    current = (await readBoard()).review;
    check(current.recoveryAttempts, 0, 'Recovery attempts reset after rest');
    check(current.recoveryAfter, current.runUntil, 'Rest is capped by configured deadline');
    check(await count('one', 'start'), 3, 'Cooldown does not launch again');
    await patch(reviews.one, { runUntil: Date.now() - 1 });
    await wait(async () => (await readBoard()).review.status === 'stopped', 'Deadline stops manager');
    current = (await readBoard()).review;
    check(current.autoRecover, false, 'Deadline disables recovery');
    check(current.pendingSince, 0, 'Deadline clears reminder');
    check(current.reports.at(-1).status, 'stopped', 'Deadline persists stopped report');

    await mode('one', 'idle');
    await patch(reviews.one, { status: 'running', autoRecover: true, runUntil: 0, recoveryAfter: 0, nextDueAt: 0 });
    tmux(terms.one.durableId, ['kill-server']);
    await until(async () => !(await api('/api/terminals')).data.terminals.some(t => t.termId === terms.one.termId), 'Missing supervisor attachment');
    await wait(async () => await count('one', 'start') === 4, 'Recover missing tmux supervisor');
    check((await checkpoint()).terminals.find(t => t.termId === terms.one.termId).durableId, terms.one.durableId, 'Missing-pane recovery keeps durable and fixed IDs');
    await observed(terms.one.termId, 'idle');

    // A live pane survives headless server restart without re-execution.
    const preservedPid = pane('two');
    await restart();
    await wait(async () => (await api('/api/terminals')).data.terminals.some(t => t.termId === terms.two.termId), 'Headless supervisor restore');
    check(pane('two'), preservedPid, 'Headless restore keeps manager PID');
    check(await count('two', 'start'), 1, 'Headless restore avoids duplicate launcher');
    check((await readBoard()).supervisors.find(r => r.id === reviews.held).recoveryTerminal.conversationHeld, true, 'Conversation protection survives server restart');
    monitor = await connect();
    await held('held', false);
    tmux(terms.held.durableId, ['kill-server']);
    await until(async () => !(await api('/api/terminals')).data.terminals.some(t => t.termId === terms.held.termId), 'Protected manager attachment has exited');
    for (const label of ['two', 'held']) {
      monitor.send({ type: 'kill', termId: terms[label].termId, confirm: true });
      const receipt = await monitor.wait(m => m.type === 'kill-result' && m.termId === terms[label].termId);
      check(receipt.accepted, true, 'Private supervisor close is acknowledged');
      const review = (await readBoard()).supervisors.find(r => r.id === reviews[label]);
      check(review.status, 'stopped', 'Explicit terminal close stops related manager');
      check(review.autoRecover, false, 'Explicit terminal close disables recovery');
    }
    await new Promise(resolve => setTimeout(resolve, 17_000));
    check(await count('two', 'start'), 1, 'Closed manager is not resurrected');
    check(await count('held', 'start'), 1, 'Closed protected manager is not resurrected');
    check(await count('one', 'start'), 4, 'Missing-pane recovery launches exactly once across headless restore');
    console.log(JSON.stringify({ phase: 'supervisor-deadline-headless-and-close', status: 'passed' }));
  } finally {
    await saveBoard(original);
    monitor = await connect();
    for (const term of Object.values(terms)) {
      monitor.send({ type: 'kill', termId: term.termId, confirm: true });
      const receipt = await monitor.wait(m => m.type === 'kill-result' && m.termId === term.termId);
      check(receipt.accepted, true, 'Private terminal cleanup is acknowledged');
    }
  }
}
