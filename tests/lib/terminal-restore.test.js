import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { agentPermissionCommand } from '../../js/agent-permissions.js';

// Exercise the real restore entry point without starting the application or an AI.
const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const restoreSource = server.slice(server.indexOf('function tryRestoreTerminal('), server.indexOf('\nfunction restoreTerminals('));
const flushSource = server.slice(server.indexOf('function flushDeferredTerminalRestores('), server.indexOf('\nfunction activeTerminalsPayload('));

test('checkpoint replay reuses a supervisor already restored by the watchdog', () => {
  const terminals = new Map([['manager', { projectId: '__home__', durableId: 'a'.repeat(24) }]]);
  let spawns = 0;
  const restore = runInNewContext(`${restoreSource}; tryRestoreTerminal`, {
    terminals, DURABLE_TERMINALS: true, durableTerminalExists: () => true,
    homedir: () => '/tmp', IS_WIN: false, existsSync: () => true,
    randomBytes: () => ({ toString: () => 'duplicate' }),
    terminalSpawnSpec: () => ({ durableId: 'a'.repeat(24), resumed: true }),
    pty: { spawn: () => { spawns++; return { onData() {}, onExit() {} }; } },
    nextTerminalAlias: () => 'ai1',
  });
  for (const termId of ['manager', 'stale-id']) {
    const result = restore({ termId, projectId: '__home__', durableId: 'a'.repeat(24), alias: 'ai1' });
    assert.equal(result.ok, true);
    assert.equal(result.termId, 'manager');
    assert.equal(result.resumed, true);
  }
  assert.equal(spawns, 0);
  assert.equal(terminals.size, 1);
});

test('a deferred recovery that wins first preserves the configured supervisor ID', () => {
  const terminals = new Map();
  const saved = { termId: 'manager', projectId: '__home__', durableId: 'a'.repeat(24), command: 'codex --no-daemon' };
  let spawns = 0;
  const runtime = runInNewContext(`${restoreSource}\n${flushSource}\n({ tryRestoreTerminal, flushDeferredTerminalRestores })`, {
    terminals, deferredTerminalRestores: [saved], DURABLE_TERMINALS: true, durableTerminalExists: () => false,
    getBoard: () => ({ review: { autoRecover: true, termId: 'manager', status: 'running' } }),
    homedir: () => '/tmp', IS_WIN: false, existsSync: () => true,
    randomBytes: () => ({ toString: () => 'duplicate' }),
    terminalSpawnSpec: () => ({ durableId: saved.durableId, resumed: false }),
    pty: { spawn: () => { spawns++; return { onData() {}, onExit() {} }; } },
    nextTerminalAlias: () => 'ai1', setTimeout() {}, logger: { info() {} },
    saveTerminalState() {}, activeTerminalsPayload: () => [], wss: { clients: [] },
  });
  assert.equal(runtime.flushDeferredTerminalRestores(), 1);
  assert.ok(terminals.has('manager'));
  assert.equal(runtime.tryRestoreTerminal(saved, true).termId, 'manager');
  assert.equal(spawns, 1);
  assert.equal(terminals.size, 1);
});

test('a corrupt board cannot crash startup or a delayed supervisor launch', () => {
  const startup = server.slice(server.indexOf('// An opted-in supervisor must resume'), server.indexOf("  logger.info('server', `Claude Code Dashboard"));
  const getBoard = () => { throw new Error('corrupt JSON'); };
  const errors = [];
  assert.doesNotThrow(() => runInNewContext(startup, { getBoard, logger: { error: (...args) => errors.push(args) } }));
  assert.equal(errors.length, 1);

  let delayed;
  let writes = 0;
  const restore = runInNewContext(`${restoreSource}\ntryRestoreTerminal`, {
    terminals: new Map(), DURABLE_TERMINALS: true, durableTerminalExists: () => false,
    getBoard, homedir: () => '/tmp', IS_WIN: false, existsSync: () => true,
    terminalSpawnSpec: () => ({ durableId: 'a'.repeat(24), resumed: false }),
    pty: { spawn: () => ({ onData() {}, onExit() {}, write() { writes++; } }) },
    nextTerminalAlias: () => 'ai1', setTimeout: callback => { delayed = callback; }, logger: { warn() {} },
  });
  restore({ termId: 'manager', projectId: '__home__', durableId: 'a'.repeat(24), command: 'codex --no-daemon' }, true);
  assert.doesNotThrow(() => delayed());
  assert.equal(writes, 0);
});

test('an active supervisor restores without a browser even when automatic agent restart is disabled', () => {
  const startup = server.slice(server.indexOf('// An opted-in supervisor must resume'), server.indexOf("  logger.info('server', `Claude Code Dashboard"));
  for (const autoRecover of [false, true]) {
    let restores = 0;
    let checkpoints = 0;
    runInNewContext(startup, {
      getBoard: () => ({ review: { termId: 'manager', status: 'running', autoRecover } }),
      _terminalsRestored: false, restoreTerminals: () => { restores++; },
      saveTerminalStateNow: () => { checkpoints++; }, logger: { error() {} },
    });
    assert.equal(restores, 1);
    assert.equal(checkpoints, 1);
  }
});

test('durable screen reads omit dismissed dialogs and do not fall back to stale output', () => {
  const source = server.slice(server.indexOf('const SCREEN_JUNK_LINE'), server.indexOf('// Optimized buffer:'));
  let current = 'Ready for the next task';
  const read = runInNewContext(`${source}; readTerminalScreen`, {
    resolveTerminalRef: () => ({ id: 'manager', entry: { durableId: 'a'.repeat(24) } }),
    durableTerminalScreen: () => current,
    bufRead: () => 'Previous approval dialog', stripAnsi: value => value,
  });
  assert.equal(read('manager', 50, true).current, true);
  assert.equal(read('manager', 50, true).lines.join('\n'), current);
  assert.equal(read('manager').lines.join('\n'), 'Previous approval dialog');
  current = null;
  assert.equal(read('manager', 50, true), null);
});

test('unreadable permission settings reject both launch paths before spawning a terminal', () => {
  let spawns = 0;
  const messages = [];
  const context = {
    getBoard: () => { throw new Error('corrupt JSON'); },
    getProjectById: () => ({ path: '/tmp' }), homedir: () => '/tmp', parseWslPath: () => null,
    randomBytes: () => ({ toString: () => 'new' }),
    terminalSpawnSpec: () => { spawns++; return {}; },
    pty: { spawn: () => ({ onData() {}, onExit() {} }) }, agentPermissionCommand,
    ws: { send: message => messages.push(JSON.parse(message)) },
  };
  const agentStart = server.indexOf('createTerminal: (projectId, command) => {');
  const agentEnd = server.indexOf('\n      },', agentStart);
  const agentCreate = runInNewContext(`({ ${server.slice(agentStart, agentEnd)} }).createTerminal`, context);
  assert.throws(() => agentCreate('project', 'codex'), /corrupt JSON/);
  const createCase = server.slice(server.indexOf("case 'create':"), server.indexOf("case 'input':"));
  const wsCreate = runInNewContext(`(msg) => { switch (msg.type) { ${createCase} } }`, context);
  assert.doesNotThrow(() => wsCreate({ type: 'create', projectId: '__home__', command: 'codex' }));
  assert.equal(spawns, 0);
  assert.match(messages[0].message, /실행 권한을 읽지 못했습니다/);
});

test('deferred stopped supervisors stay stopped and restored workers retain watched IDs', () => {
  const terminals = new Map();
  const supervisor = { termId: 'manager', projectId: '__home__', durableId: 'a'.repeat(24), command: 'codex --no-daemon', supervisor: true };
  const worker = { termId: 'worker', projectId: '__home__', durableId: 'b'.repeat(24), command: 'claude' };
  const callbacks = [];
  const writes = [];
  const runtime = runInNewContext(`${restoreSource}\n${flushSource}\n({ tryRestoreTerminal, flushDeferredTerminalRestores })`, {
    terminals, deferredTerminalRestores: [supervisor, worker], DURABLE_TERMINALS: true, durableTerminalExists: () => false,
    // The user may have stopped supervision or replaced its manager while restore was deferred.
    getBoard: () => ({ review: { autoRecover: false, termId: '', status: 'stopped', watched: [{ termId: 'worker' }] } }),
    homedir: () => '/tmp', IS_WIN: false, existsSync: () => true,
    randomBytes: () => ({ toString: () => 'new' }),
    terminalSpawnSpec: (id, _cwd, _account, durableId) => ({ durableId, resumed: false }),
    pty: { spawn: () => ({ onData() {}, onExit() {}, write: value => writes.push(value) }) },
    nextTerminalAlias: () => 'ai1', setTimeout: callback => callbacks.push(callback), logger: { info() {}, warn() {} },
    saveTerminalState() {}, activeTerminalsPayload: () => [], wss: { clients: [] },
  });
  runtime.flushDeferredTerminalRestores();
  for (const callback of callbacks) callback();
  assert.deepEqual(writes, ['claude\r']);
  assert.ok(terminals.has('worker'));
});
