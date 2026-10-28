import { mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Exercise delivery against a real private PTY. The executable only records
// bytes and renders fixture screens; it never contacts an AI provider.
export async function verifyInputTerminals({ api, check, monitor, until, observed, directory, project, checkpoint, input, url, tmux }) {
  const folder = join(project, 'input');
  await mkdir(folder);
  const mode = join(folder, 'mode');
  const log = join(folder, 'received');
  const setMode = async value => { await writeFile(mode + '.next', value); await rename(mode + '.next', mode); };
  const screens = {
    idle: ['❯', '? for shortcuts'], busy: ['✻ Working…', '❯'],
    busyComposer: ['Working (esc to interrupt)', '❯'], paused: ['❯', 'Goal paused'],
    approval: ['Do you want to proceed?', '1. Yes', '2. No'],
    draft: ['❯', '사용자가 작성 중인 초안'], unknown: ['Initializing…'],
  };
  await writeFile(mode, 'idle');
  await writeFile(log, '');
  await writeFile(join(folder, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
const screens=${JSON.stringify(screens)};
const mode=${JSON.stringify(mode)}, log=${JSON.stringify(log)};
let current='';
function render(){const next=fs.readFileSync(mode,'utf8');if(next==='exit')process.exit(0);if(next!==current){current=next;process.stdout.write('\\x1b[2J\\x1b[H'+screens[next].join('\\r\\n'));}}
process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?2004h');render();setInterval(render,20);
process.stdin.on('data',chunk=>fs.appendFileSync(log,chunk));
`, { mode: 0o700 });
  const cursor = monitor.messages.length;
  monitor.send({ type: 'create', projectId: 'sample', command: 'node input/claude', cols: 100, rows: 30 });
  const terminal = await until(() => monitor.messages.slice(cursor).find(m => m.type === 'created'), 'Input fixture terminal');
  const id = terminal.termId;
  const boardPath = join(directory, '.cockpit-board.json');
  const initialBoard = await readFile(boardPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return api('/api/board').then(response => Buffer.from(JSON.stringify(response.data)));
  });
  await writeFile(boardPath, initialBoard);
  const request = (suffix, body, ref = id, headers = {}) => api(`/api/terminals/${ref}/${suffix}`, {
    method: suffix === 'input' ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const readBoard = async () => (await api('/api/board')).data;
  const saveBoard = board => { board.review = board.supervisors[0]; return writeFile(boardPath, JSON.stringify(board)); };
  const readLog = () => readFile(log, 'utf8');
  const state = async value => { await setMode(value); await observed(id, value === 'draft' ? 'unknown' : value === 'busyComposer' ? 'busy' : value); };
  const denied = async (body, status = 409, code) => {
    const before = await readLog();
    const response = await request('input', body);
    check(response.status, status, 'Reject unsafe automatic input');
    if (code) check(response.data.code, code, 'Input rejection code');
    check(await readLog(), before, 'Rejected input sends no PTY bytes');
  };
  const delivered = async (body, expected) => {
    const before = await readLog();
    const response = await request('input', body, terminal.alias);
    check(response.status, 200, `Deliver through fixed alias: ${JSON.stringify(response.data)}`);
    await until(async () => (await readLog()) === before + expected, 'Exact automatic PTY bytes')
      .catch(async error => { throw new Error(`${error.message}: expected=${JSON.stringify(before + expected)} received=${JSON.stringify(await readLog())}`); });
    check(await readLog(), before + expected, 'Deliver exactly the requested bytes');
  };
  const closeFixture = async termId => {
    if (!(await api('/api/terminals')).data.terminals.some(t => t.termId === termId)) return;
    monitor.send({ type: 'kill', termId });
    await until(async () => !(await api('/api/terminals')).data.terminals.some(t => t.termId === termId), 'Input fixture cleanup');
  };
  try {
    await observed(id, 'idle');
    for (const body of [{}, { data: '' }, { data: 1 }, { data: '😀'.repeat(50_001) }]) await denied(body, 400);
    check((await request('input', { data: 'fixture' }, 'missing')).status, 404, 'Missing input target');
    await delivered({ data: '한글😀' }, '한글😀\r');
    await delivered({ data: 'first\nsecond' }, '\x1b[200~first\nsecond\x1b[201~\r');
    await denied({ data: 'unsubmitted message', enter: false }, 409, 'AGENT_NOT_READY');
    await state('busy');
    await denied({ data: 'next task' }, 409, 'AGENT_NOT_READY');
    await state('idle');
    await state('busyComposer');
    await delivered({ data: 'next task' }, 'next task\r');
    await state('approval');
    await denied({ data: 'next task' }, 409, 'AGENT_NOT_READY');
    await delivered({ data: '\r', enter: false }, '\r');
    await denied({ data: 'shell command', enter: false }, 409, 'AGENT_NOT_READY');
    await state('draft');
    await denied({ data: 'overwrite draft' }, 409, 'AGENT_NOT_READY');
    await state('unknown');
    await denied({ data: '\r', enter: false }, 409, 'AGENT_NOT_READY');
    await state('paused');
    await denied({ data: '\r', enter: false }, 409, 'AGENT_NOT_READY');
    await state('idle');

    const token = (await readFile(join(directory, '.cockpit-token'), 'utf8')).trim();
    const remote = { 'x-forwarded-for': '100.64.2.1', cookie: `cockpit-token=${token}`, origin: url };
    check((await request('input', { data: 'remote' }, id, remote)).status, 403, 'Remote input blocked');
    check((await request('launcher', { command: 'claude', expected: 'node input/claude' }, id, remote)).status, 403, 'Remote launcher blocked');
    check((await request('conversation', { held: 'yes' })).status, 400, 'Conversation requires a boolean');
    check((await request('conversation', { held: true }, terminal.alias, remote)).status, 200, 'Authenticated remote conversation guard');
    await denied({ data: 'held' }, 409, 'CONVERSATION_HELD');
    await denied({ data: '\r', enter: false }, 409, 'CONVERSATION_HELD');
    const beforeKeys = await readLog();
    await input(monitor, id, 'USER', 'held-user-keyboard');
    await until(async () => (await readLog()) === beforeKeys + 'USER', 'User keyboard remains available');
    check((await checkpoint()).terminals.find(t => t.termId === id).conversationHeld, true, 'Conversation guard persisted');
    check((await request('launcher', { command: 'claude', expected: 'node input/claude' })).status, 409, 'Held launcher registration denied');
    check((await request('conversation', { held: false })).status, 200, 'Release conversation guard');

    const socket = (await checkpoint()).terminals.find(t => t.termId === id).durableId;
    const tmuxPid = Number(tmux(socket, ['display-message', '-p', '-t', 'main', '#{pid}']));
    check(Number.isInteger(tmuxPid) && tmuxPid > 0, true, 'Private fixture tmux PID');
    for (const action of ['keyboard', 'guard']) {
      const before = await readLog();
      let pending, protection;
      process.kill(tmuxPid, 'SIGSTOP');
      try {
        pending = request('input', { data: 'cancel concurrent automation' });
        await new Promise(resolve => setTimeout(resolve, 100));
        if (action === 'keyboard') await input(monitor, id, 'TYPING', 'concurrent-user-keyboard');
        else protection = request('conversation', { held: true });
        await new Promise(resolve => setTimeout(resolve, 100));
      } finally { process.kill(tmuxPid, 'SIGCONT'); }
      check((await pending).status, 409, 'User activity during observation cancels automation');
      if (protection) {
        check((await protection).status, 200, 'Concurrent conversation guard saved');
        check((await request('conversation', { held: false })).status, 200, 'Release concurrent guard');
      }
      await until(async () => (await readLog()) === before + (action === 'keyboard' ? 'TYPING' : ''), 'Only user input reaches PTY');
      check(await readLog(), before + (action === 'keyboard' ? 'TYPING' : ''), 'Concurrent automatic input was discarded');
    }

    const beforeLauncher = await readLog();
    check((await request('launcher', { command: 'claude; echo bad', expected: 'node input/claude' })).status, 400, 'Reject one-shot launcher');
    check((await request('launcher', { command: 'codex', expected: 'node input/claude' })).status, 409, 'Launcher must match current agent');
    check((await request('launcher', { command: 'claude', expected: 'stale' })).status, 409, 'Launcher compare-and-swap');
    check((await request('launcher', { command: 'claude', expected: 'node input/claude' })).status, 200, 'Register running replacement launcher');
    check((await checkpoint()).terminals.find(t => t.termId === id).command, 'claude', 'Launcher checkpoint');
    check(await readLog(), beforeLauncher, 'Registration never executes the launcher');

    let board = await readBoard();
    const review = board.supervisors[0];
    Object.assign(review, { termId: id, status: 'running', watched: [], workerProgress: [],
      autoRecover: true, recoveryTerminal: { ...(await checkpoint()).terminals.find(t => t.termId === id) },
      lastReviewedAt: 120, pendingSince: 240, runUntil: Date.now() + 60_000 });
    await saveBoard(board);
    check((await request('launcher', { command: 'claude --dangerously-skip-permissions', expected: 'claude' })).status, 409, 'Registered recovery command cannot silently change');
    const watch = { id: review.id, reviewedAt: 120, pendingSince: 240, until: Date.now() + 60_000 };
    await delivered({ data: 'supervision', supervision: watch }, 'supervision\r');
    for (const change of [{ reviewedAt: 119 }, { pendingSince: 239 }, { until: 0 }, { until: 'future' }, { id: 'missing' }]) {
      await denied({ data: 'stale supervision', supervision: { ...watch, ...change } });
    }
    await denied({ data: 'stale supervision', supervision: null });
    const lock = `${boardPath}.lock`;
    const owner = join(lock, `owner-${process.pid}-00000000-0000-0000-0000-000000000000`);
    await mkdir(lock); await writeFile(owner, '');
    try { await denied({ data: 'queued supervision', supervision: watch }, 503); }
    finally { await unlink(owner); await rmdir(lock); }
    const deadPid = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', timeout: 3000 });
    await mkdir(lock);
    await writeFile(join(lock, `owner-${deadPid}-00000000-0000-0000-0000-000000000000`), '');
    await delivered({ data: 'recovered supervision', supervision: watch }, 'recovered supervision\r');
    check((await request('conversation', { held: true })).status, 200, 'Hold active manager');
    board = await readBoard();
    check(board.review.pendingSince, 0, 'Conversation change invalidates outstanding dispatch');
    check(board.review.recoveryTerminal.conversationHeld, true, 'Recovery retains conversation guard');
    check(board.revision, JSON.parse(initialBoard).revision || 0, 'Guard does not edit board content revision');
    check((await request('conversation', { held: false })).status, 200, 'Release active manager');
    await denied({ data: 'invalidated supervision', supervision: watch });

    board = await readBoard();
    Object.assign(board.supervisors[0], { status: 'stopped', autoRecover: false, pendingSince: 777, nextDueAt: 888 });
    await saveBoard(board);
    check((await request('conversation', { held: true })).status, 200, 'Hold stopped manager');
    check((await request('conversation', { held: false })).status, 200, 'Release stopped manager');
    board = await readBoard();
    check(board.review.status, 'stopped', 'Guard release does not start stopped manager');
    check(board.review.pendingSince, 777, 'Stopped manager scheduling preserved');
    check(board.review.recoveryTerminal.conversationHeld, false, 'Stopped recovery guard released');

    Object.assign(board.supervisors[0], { termId: 'fixture-other-manager', status: 'running', workerDispatch: 'linked', recoveryTerminal: null,
      watched: [{ termId: id, goal: '완료 조건', objective: '독립 작업', priority: 1, paused: false }],
      workerProgress: [{ termId: id, goal: '완료 조건', objective: '독립 작업', run: { token: 'keep-token', status: 'running',
        lastSentAt: 123, attempts: 2, resumeRequestedAt: 124, resumeSentAt: 125, resumeSubmittedAt: 126 } }] });
    const unrelated = { ...board.supervisors[0], id: 'S-0999', termId: 'unrelated-manager', watched: [], workerProgress: [], pendingSince: 999 };
    board.supervisors.push(unrelated);
    await saveBoard(board);
    check((await request('conversation', { held: true })).status, 200, 'Hold watched worker');
    board = await readBoard();
    const run = board.review.workerProgress[0].run;
    check(run.token, 'keep-token', 'Worker guard keeps assignment token');
    check([run.lastSentAt, run.attempts, run.resumeRequestedAt, run.resumeSentAt, run.resumeSubmittedAt], [0, 0, 0, 0, 0], 'Worker guard resets delivery and resume scheduling');
    check(board.supervisors.find(r => r.id === 'S-0999').pendingSince, 999, 'Unrelated manager unchanged');
    check((await request('conversation', { held: false })).status, 200, 'Release watched worker');

    const statePath = join(directory, 'session-state.json');
    await rename(statePath, statePath + '.fixture-backup'); await mkdir(statePath);
    try {
      check((await request('launcher', { command: 'claude --verbose', expected: 'claude' })).status, 500, 'Failed launcher checkpoint is reported');
      check((await api('/api/terminals')).data.terminals.find(t => t.termId === id).command, 'claude', 'Failed launcher registration restores memory');
      check((await request('conversation', { held: true })).status, 500, 'Failed guard checkpoint is reported');
      check((await request('conversation', { held: true })).status, 500, 'Repeated hold cannot falsely acknowledge failed persistence');
    } finally { await rmdir(statePath); await rename(statePath + '.fixture-backup', statePath); }
    check((await request('conversation', { held: true })).status, 200, 'Close guard before persistence failure');
    const goodBoard = await readFile(boardPath);
    await writeFile(boardPath, '{broken');
    try {
      check((await request('conversation', { held: false })).status, 500, 'Failed guard release is reported');
      await denied({ data: 'failed release' }, 409, 'CONVERSATION_HELD');
      check((await checkpoint()).terminals.find(t => t.termId === id).conversationHeld, true, 'Failed release remains protected on restart');
      check(await readFile(boardPath, 'utf8'), '{broken', 'Corrupt board preserved');
    } finally { await writeFile(boardPath, goodBoard); }
    check((await request('conversation', { held: false })).status, 200, 'Release succeeds after storage recovery');
    await setMode('exit'); await observed(id, 'offline');
    await denied({ data: 'never execute in shell' }, 409, 'AGENT_NOT_READY');
    await writeFile(boardPath, initialBoard);

    const jcodeMode = join(folder, 'jcode-mode'), jcodeLog = join(folder, 'jcode-received');
    const footer = '~ merge/dev-rpa ~57 ?136 ↑1 196k/1.0M ▰▰▱▱▱▱▱▱▱▱ 20% OAuth OpenAI GPT-6.1 Sol xhigh';
    const jcodeScreens = {
      busy: ['running batch', '41… 󰌘', footer], draft: ['41… typed draft 󰌘', footer],
      multiline: ['41… 󰌘', 'second draft line', footer],
      approval: ['Do you want to proceed?', '1. Yes', '41… 󰌘', footer],
      permission: ['permission required', '41… 󰌘', footer],
      picker: ['▸ GPT-6.1 current', '↑↓ choose · Enter select · Esc cancel', '41… 󰌘', footer],
    };
    await writeFile(jcodeMode, 'busy'); await writeFile(jcodeLog, '');
    await writeFile(join(folder, 'jcode'), `#!${process.execPath}
import fs from 'node:fs';
const screens=${JSON.stringify(jcodeScreens)}, mode=${JSON.stringify(jcodeMode)}, log=${JSON.stringify(jcodeLog)};
let current='';
function render(){const next=fs.readFileSync(mode,'utf8');if(next!==current){current=next;process.stdout.write('\\x1b[2J\\x1b[H'+screens[next].join('\\r\\n'));}}
process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?2004h');render();setInterval(render,20);
process.stdin.on('data',chunk=>fs.appendFileSync(log,chunk));
`, { mode: 0o700 });
    const jcodeCursor = monitor.messages.length;
    monitor.send({ type: 'create', projectId: 'sample', command: 'node input/jcode', cols: 120, rows: 30 });
    const jcode = await until(() => monitor.messages.slice(jcodeCursor).find(m => m.type === 'created'), 'Jcode peer input fixture');
    try {
      await observed(jcode.termId, 'busy');
      const live = (await api(`/api/terminals/${jcode.termId}/screen?lines=10&current=1`)).data;
      check(live.current, true, 'Peer read requests the current pane');
      check(live.lines.some(line => line.trim() === '41… 󰌘'), true, 'Current pane preserves composer row boundaries');
      check((await api(`/api/terminals/${jcode.termId}/screen?lines=500`)).data.current, false, 'Historical screen API remains compatible');
      const message = '[콕핏 세션 메시지 | 보낸 세션: fixture]\nnext assignment';
      check((await request('input', { data: message }, jcode.alias)).status, 200, 'Jcode accepts a peer message while its running composer is empty');
      const expected = `\x1b[200~${message}\x1b[201~\r`;
      await until(async () => await readFile(jcodeLog, 'utf8') === expected, 'One exact interleave message');
      for (const [name, state] of [['draft', 'busy'], ['multiline', 'unknown'], ['approval', 'approval'], ['permission', 'busy'], ['picker', 'busy']]) {
        await writeFile(jcodeMode + '.next', name); await rename(jcodeMode + '.next', jcodeMode);
        await observed(jcode.termId, state);
        check((await request('input', { data: 'blocked peer' }, jcode.alias)).status, 409, `Jcode ${name} remains protected`);
        check(await readFile(jcodeLog, 'utf8'), expected, 'Refused peer message sends no bytes');
      }
      await writeFile(jcodeMode + '.next', 'busy'); await rename(jcodeMode + '.next', jcodeMode);
      await observed(jcode.termId, 'busy');
      check((await request('conversation', { held: true }, jcode.alias)).status, 200, 'Protect jcode user conversation');
      check((await request('input', { data: 'held peer' }, jcode.alias)).data.code, 'CONVERSATION_HELD', 'Held jcode rejects a peer message');
      check(await readFile(jcodeLog, 'utf8'), expected, 'Protected conversation receives no bytes');
      check((await request('conversation', { held: false }, jcode.alias)).status, 200, 'Release private fixture protection');
      const socket = (await checkpoint()).terminals.find(t => t.termId === jcode.termId).durableId;
      tmux(socket, ['rename-session', '-t', 'main', 'observation-unavailable']);
      try {
        check((await api(`/api/terminals/${jcode.termId}/screen?lines=10&current=1`)).data.current, false, 'A failed live read is explicitly historical');
        check((await request('input', { data: 'stale peer' }, jcode.alias)).status, 409, 'Missing current pane rejects peer input');
        check(await readFile(jcodeLog, 'utf8'), expected, 'No historical screen is used to send input');
      } finally { tmux(socket, ['rename-session', '-t', 'observation-unavailable', 'main']); }
    } finally {
      await closeFixture(jcode.termId);
    }
  } finally {
    await writeFile(boardPath, initialBoard);
    await closeFixture(id);
  }
}
