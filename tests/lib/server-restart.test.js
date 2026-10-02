import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const source = server.slice(server.indexOf('async function requestServerRestart('), server.indexOf('// Track active PTY processes:'));
function harness() {
  const helper = new EventEmitter();
  const timers = new Map();
  const terminals = new Map([['ai1', { durableId: 'a'.repeat(24) }]]);
  const devServers = new Map();
  const counts = { spawn: 0, checkpoint: 0, shutdown: 0, killed: 0 };
  Object.assign(helper, { kill() { counts.killed++; }, disconnect() {}, unref() {} });
  const request = runInNewContext(`${source}; requestServerRestart`, {
    _restartRequested: false, _shuttingDown: false, _terminalsRestored: true, DURABLE_TERMINALS: true,
    terminals, devServers, durableTerminalExists: () => true,
    saveTerminalStateNow: () => { counts.checkpoint++; return terminals.size; },
    spawn: () => { counts.spawn++; return helper; }, process: { execPath: '/node', pid: 123, env: {} }, join, __dirname: '/app',
    setTimeout: (callback, milliseconds) => { const timer = { callback, unref() {} }; timers.set(milliseconds, timer); return timer; },
    clearTimeout: timer => { for (const [key, value] of timers) if (value === timer) timers.delete(key); },
    onShutdown: () => { counts.shutdown++; },
    logger: { warn() {} },
  });
  return { request, helper, timers, terminals, devServers, counts };
}

test('restart never schedules shutdown before helper readiness and checkpoints after preparation', async () => {
  const h = harness();
  const pending = h.request();
  assert.equal(h.timers.has(250), false);
  h.helper.emit('message', { type: 'ready' });
  assert.equal((await pending).terminalCount, 1);
  assert.equal(h.counts.checkpoint, 2);
  assert.equal(h.counts.shutdown, 0);
  h.timers.get(250).callback();
  assert.equal(h.counts.shutdown, 1);
});

test('helper failure, early exit, and timeout leave the existing server running', async () => {
  for (const failure of ['error', 'exit', 'timeout']) {
    const h = harness();
    const pending = h.request();
    if (failure === 'timeout') h.timers.get(7000).callback();
    else h.helper.emit(failure, new Error('failed'));
    await assert.rejects(pending);
    assert.equal(h.timers.has(250), false);
    assert.equal(h.counts.shutdown, 0);
    assert.ok(h.counts.killed);
    const retry = h.request();
    h.helper.emit('message', { type: 'ready' });
    await retry;
  }
});

test('active development servers and sessions added during preparation prevent restart', async () => {
  const busy = harness();
  busy.devServers.set('project', {});
  await assert.rejects(busy.request(), /개발 서버/);
  assert.equal(busy.counts.spawn, 0);
  const changed = harness();
  const pending = changed.request();
  changed.terminals.set('new', { durableId: '' });
  changed.helper.emit('message', { type: 'ready' });
  await assert.rejects(pending, /보존 대상/);
  assert.equal(changed.timers.has(250), false);
  assert.ok(changed.counts.killed);
  const late = harness();
  const accepted = late.request();
  late.helper.emit('message', { type: 'ready' });
  await accepted;
  late.terminals.set('new', { durableId: '' });
  late.timers.get(250).callback();
  assert.equal(late.counts.shutdown, 0);
  assert.ok(late.counts.killed);
});

test('the real helper rejects invalid replacement syntax without claiming readiness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cockpit-restart-syntax-'));
  try {
    const replacement = join(directory, 'invalid.mjs');
    writeFileSync(replacement, 'const broken = ;');
    const helper = spawn(process.execPath, [new URL('../../scripts/restart-server.mjs', import.meta.url).pathname, String(process.pid), replacement], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 7000,
    });
    const messages = [];
    helper.on('message', message => messages.push(message));
    const code = await new Promise((resolve, reject) => { helper.once('error', reject); helper.once('exit', resolve); });
    assert.equal(code, 1);
    assert.equal(messages.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
