import test from 'node:test';
import assert from 'node:assert/strict';
import {
  durableTerminalCwd, durableTerminalExists, durableTerminalsAvailable, durableTerminalScreen, ensureDurableTerminal, killDurableTerminal, restartDurableAgent,
} from '../../lib/durable-terminal.js';

test('durable terminal availability is opt-out and requires tmux on Unix', () => {
  assert.equal(durableTerminalsAvailable({ isWin: true, exists: () => true }), false);
  assert.equal(durableTerminalsAvailable({ isWin: false, env: { COCKPIT_DURABLE_TERMINALS: '0' }, exists: () => true }), false);
  assert.equal(durableTerminalsAvailable({ isWin: false, env: {}, exists: path => path === '/usr/bin/tmux' }), true);
});

test('agent recovery refuses live processes and shell commands, but can restart a dead pane', () => {
  const calls = [];
  let dead = false;
  let children = '22';
  const options = { exists: () => true, exec: (_bin, args) => { calls.push(args); if (args.includes('display-message')) return `20 ${dead ? 1 : 0}`; },
    read: path => path.endsWith('/comm') ? 'bash' : children };
  const id = 'c'.repeat(24);
  assert.throws(() => restartDurableAgent(id, 'codex', options), /실행 중/);
  assert.throws(() => restartDurableAgent(id, 'codex; echo unsafe', options), /기본 AI/);
  assert.throws(() => restartDurableAgent(id, 'codex login', options), /기본 AI/);
  assert.equal(calls.some(args => args.includes('respawn-pane')), false);
  children = '';
  restartDurableAgent(id, 'codex', options);
  dead = true;
  restartDurableAgent(id, 'claude --verbose', options);
  assert.equal(calls.filter(args => args.includes('respawn-pane')).length, 2);
  assert.equal(calls.at(-2).at(-1), 'claude --verbose');
});

test('creates once, then reattaches the same isolated tmux server', () => {
  const calls = [];
  let present = false;
  const exec = (_bin, args) => {
    calls.push(args);
    if (args.includes('has-session') && !present) throw new Error('missing');
    if (args.includes('new-session')) present = true;
    if (args.includes('display-message')) return '/work/project\n';
  };
  const options = { id: 'a'.repeat(24), cwd: '/work/project', env: { TERM: 'xterm-256color' }, exec, exists: () => true };
  const created = ensureDurableTerminal(options);
  const resumed = ensureDurableTerminal(options);
  assert.equal(created.resumed, false);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(created.args, ['-L', `cockpit-${'a'.repeat(24)}`, 'attach-session', '-t', 'main']);
  assert.equal(calls.filter(args => args.includes('new-session')).length, 1);
  assert.equal(durableTerminalExists(options.id, { exec, exists: () => true }), true);
  assert.equal(durableTerminalCwd(options.id, { exec, exists: () => true }), '/work/project');
  assert.equal(killDurableTerminal(options.id, { exec, exists: () => true }), true);
});

test('rejects client-controlled tmux identifiers', () => {
  assert.throws(() => ensureDurableTerminal({ id: 'bad;name', cwd: '/tmp', env: {}, exec() {}, exists: () => true }), /Invalid durable terminal id/);
});

test('current pane capture excludes scrollback and times out without returning stale text', () => {
  assert.equal(durableTerminalScreen('a'.repeat(24), { exists: () => true, exec: (_bin, args, options) => {
    assert.deepEqual(args.slice(2), ['capture-pane', '-p', '-J', '-t', 'main']);
    assert.equal(options.timeout, 1000);
    return 'Ready';
  } }), 'Ready');
  assert.equal(durableTerminalScreen('a'.repeat(24), { exec() { throw new Error('timeout'); } }), null);
});

test('surfaces tmux stop failures instead of orphaning a hidden process', () => {
  assert.throws(
    () => killDurableTerminal('b'.repeat(24), { exec() { throw new Error('denied'); }, exists: () => true }),
    /denied/,
  );
});

test('an expired overnight deadline prevents the actual pane restart', () => {
  const calls = [];
  assert.throws(() => restartDurableAgent('c'.repeat(24), 'codex', {
    deadline: Date.now() - 1, exists: () => true,
    exec: (_bin, args) => { calls.push(args); return args.includes('#{pane_pid} #{pane_dead}') ? '20 1' : '/tmp'; },
  }), /종료 시각/);
  assert.equal(calls.some(args => args.includes('respawn-pane')), false);
});

test('a deadline reached during respawn or command entry prevents launching the agent', () => {
  const originalNow = Date.now;
  try {
    for (const delayedStep of ['respawn-pane', 'send-keys']) {
      let now = 999;
      const calls = [];
      Date.now = () => now;
      assert.throws(() => restartDurableAgent('d'.repeat(24), 'codex', {
        deadline: 1000, exists: () => true,
        exec: (_bin, args) => {
          calls.push(args);
          if (args.includes(delayedStep)) now = 1001;
          return args.includes('#{pane_pid} #{pane_dead}') ? '20 1' : '/tmp';
        },
      }), /종료 시각/);
      assert.equal(calls.some(args => args.includes('Enter')), false);
    }
  } finally { Date.now = originalNow; }
});
