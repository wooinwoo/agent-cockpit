import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { saveRecoveryHistory, exportRecovery, writeCheckpoint } from '../../lib/recovery-history.js';
import { validateRecoveryCommand } from '../../lib/durable-terminal.js';
import { agentRestoreCommand } from '../../js/agent-permissions.js';

const sample = now => ({ now,
  board: { supervisors: [{ id: 'S-0001', status: 'stopped', workerDispatch: 'running', watched: [{ termId: 'worker', alias: 'ai1', goal: '검증 완료' }],
    workerProgress: [{ termId: 'worker', goal: '검증 완료', run: { status: 'active', summary: '첫 조건 통과', nextAction: '두 번째 조건 검증' } }] }],
    tasks: [{ id: 'T-0001', termId: 'worker', text: '성공 경로 검증', done: true }] },
  sessionState: { timestamp: now, terminals: [{ termId: 'worker', alias: 'ai1', projectId: '__home__', cwd: '/tmp', command: 'claude', conversationHeld: true }] },
  projects: [{ id: 'project', name: '프로젝트', path: '/tmp', secret: 'never-copy-me' }],
});

test('latest checkpoint advances, hourly history is immutable, retention is bounded, export never overwrites existing data', t => {
  const root = mkdtempSync('/tmp/cockpit-history-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = `${root}/history`, now = Date.UTC(2026, 9, 6, 1);
  const latest = saveRecoveryHistory(directory, sample(now));
  const original = readFileSync(`${directory}/2026-10-06_01.json`, 'utf8');
  const updated = sample(now + 30000); updated.board.tasks[0].done = false;
  saveRecoveryHistory(directory, updated);
  assert.equal(readFileSync(`${directory}/2026-10-06_01.json`, 'utf8'), original);
  assert.equal(JSON.parse(readFileSync(latest)).board.tasks[0].done, false);
  assert.match(readFileSync(`${directory}/작업요약.txt`, 'utf8'), /두 번째 조건 검증/);
  assert.doesNotMatch(readFileSync(latest, 'utf8'), /never-copy-me/);
  assert.equal(statSync(latest).mode & 0o777, 0o600);
  const exported = exportRecovery(latest, `${root}/export`);
  assert.deepEqual(JSON.parse(readFileSync(`${exported}/session-state.json`)), updated.sessionState);
  assert.deepEqual(JSON.parse(readFileSync(`${exported}/.cockpit-board.json`)), updated.board);
  assert.throws(() => exportRecovery(latest, exported), /EEXIST/);
  assert.equal(readFileSync(latest, 'utf8').includes('never-copy-me'), false);
  writeFileSync(`${directory}/keep.json`, '{}');
  for (let hour = 1; hour <= 50; hour++) saveRecoveryHistory(directory, sample(now + hour * 3600000));
  assert.equal(readdirSync(directory).filter(name => /^\d{4}-/.test(name)).length, 50);
  assert.equal(existsSync(`${directory}/2026-10-06_01.json`), false);
  assert.equal(existsSync(`${directory}/keep.json`), true);
  writeFileSync(`${root}/bad.json`, '{}');
  assert.throws(() => exportRecovery(`${root}/bad.json`, `${root}/bad-export`), /복구본/);
  assert.equal(existsSync(`${root}/bad-export`), false);
});

test('atomic writes preserve the previous checkpoint when writing fails', t => {
  const root = mkdtempSync('/tmp/cockpit-checkpoint-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = `${root}/state.json`;
  writeCheckpoint(file, '{"valid":true}');
  assert.throws(() => writeCheckpoint(file, Symbol('invalid')));
  assert.deepEqual(JSON.parse(readFileSync(file)), { valid: true });
  assert.deepEqual(readdirSync(root), ['state.json']);
});

test('board history is saved even before the first terminal has been opened', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function saveTerminalStateNow('), source.indexOf('function saveTerminalState()'));
  const writes = [], history = [];
  const board = sample(Date.now()).board;
  const result = runInNewContext(`${functions}\nsaveTerminalStateNow()`, {
    _terminalsRestored: false, STATE_FILE: '/data/session-state.json', DATA_DIR: '/data', existsSync: () => false,
    terminalStateEntries: () => [], writeCheckpoint: (...args) => writes.push(args),
    saveRecoveryHistory: (...args) => history.push(args), getBoard: () => board, getProjects: () => [], join,
    logger: { debug() {}, error() {} },
  });
  assert.equal(result, 0); assert.equal(writes.length, 1); assert.equal(history.length, 1);
  assert.equal(history[0][1].board, board);
  assert.equal(history[0][1].sessionState.terminals.length, 0);
});

test('a failed board read cannot interrupt the terminal checkpoint or expand restore permissions', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function terminalStateEntries()'), source.indexOf('function saveTerminalState()'));
  const writes = [], errors = [];
  const result = runInNewContext(`${functions}\nsaveTerminalStateNow()`, {
    _terminalsRestored: true, STATE_FILE: '/data/session-state.json', DATA_DIR: '/data',
    deferredTerminalRestores: [], terminals: new Map([['worker', { command: '', projectId: '__home__' }]]),
    terminalAgent: () => 'codex', agentRestoreCommand,
    writeCheckpoint: (file, value) => writes.push(JSON.parse(value)),
    saveRecoveryHistory() {}, getBoard: () => { throw new Error('BOARD_CORRUPT'); }, getProjects: () => [], join,
    logger: { debug() {}, error: (...args) => errors.push(args) },
  });
  assert.equal(result, 1);
  assert.equal(writes[0].terminals[0].command, 'codex --no-daemon');
  assert.equal(errors[0][2], 'BOARD_CORRUPT');
});

test('cold restore keeps assignments and fixed session IDs after more than a day without tmux', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function loadTerminalState()'), source.indexOf('// 프로젝트 등록/account 복구'));
  const state = sample(Date.now() - 7 * 86400000).sessionState;
  const terminals = new Map(), scheduled = [], writes = [];
  const context = { terminals, deferredTerminalRestores: [], STATE_FILE: '/saved/session-state.json',
    readFileSync: () => JSON.stringify(state), existsSync: () => true, DURABLE_TERMINALS: false,
    getBoard: () => ({ supervisors: [] }), getProjectById: () => null, homedir: () => '/tmp', IS_WIN: false,
    terminalSpawnSpec: () => ({ shell: '/bin/bash', args: [], cwd: '/tmp', env: {}, resumed: false, durableId: '' }),
    pty: { spawn: () => ({ onData() {}, onExit() {}, write: text => writes.push(text) }) }, wss: { clients: [] },
    setTimeout: fn => scheduled.push(fn), validateRecoveryCommand, logger: { info() {}, warn() {} }, saveTerminalState() {},
  };
  const result = runInNewContext(`${functions}\nrestoreTerminals()`, context);
  assert.equal(result.idMap.worker, 'worker');
  assert.equal(terminals.get('worker').alias, 'ai1');
  assert.equal(terminals.get('worker').conversationHeld, true);
  assert.equal(terminals.get('worker').command, 'claude');
  scheduled.forEach(fn => fn());
  assert.deepEqual(writes, ['claude\r']);
  runInNewContext(`${functions}\nrestoreTerminals()`, context);
  assert.equal(scheduled.length, 1, 'a second restore does not launch duplicate agents');
  terminals.clear(); scheduled.length = 0; writes.length = 0;
  state.terminals[0].command = 'npm run deploy';
  runInNewContext(`${functions}\nrestoreTerminals()`, context);
  scheduled.forEach(fn => fn());
  assert.equal(terminals.size, 1);
  assert.equal(writes.length, 0, 'cold boot never replays an old one-shot deployment');
  terminals.clear(); scheduled.length = 0;
  state.terminals[0].command = 'jcode';
  runInNewContext(`${functions}\nrestoreTerminals()`, context);
  scheduled.forEach(fn => fn());
  assert.deepEqual(writes, ['jcode\r']);
});
