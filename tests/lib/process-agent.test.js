import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAgentProcess, detectTerminalAgent } from '../../lib/process-agent.js';

function proc(entries) {
  return path => {
    const match = path.match(/^\/proc\/(\d+)\/(?:task\/\1\/children|(comm|cmdline|stat))$/);
    if (!match || !entries[match[1]]) throw new Error('missing proc entry');
    if (path.endsWith('/children')) return entries[match[1]].children || '';
    if (path.endsWith('/stat')) {
      const entry = entries[match[1]];
      return `${match[1]} (${entry.comm || 'process'}) ${entry.state || 'S'} 1 ${entry.group || 1} 1 1 ${entry.foreground || 1}`;
    }
    return entries[match[1]][match[2]] || '';
  };
}

test('durable terminals scan the tmux pane, including an agent at the pane root', () => {
  const read = proc({ 10: { comm: 'tmux', cmdline: 'tmux\0attach-session\0' }, 20: { comm: 'codex', cmdline: 'codex\0' } });
  const entry = { pty: { pid: 10 }, durableId: 'a'.repeat(24) };
  assert.deepEqual(detectTerminalAgent(entry, read, () => ({ pid: 20, dead: false })), { available: true, kind: 'codex' });
  assert.deepEqual(detectTerminalAgent(entry, read, () => ({ pid: 20, dead: true })), { available: true, kind: null });
  assert.deepEqual(detectTerminalAgent(entry, read, () => null), { available: false, kind: null });
});

test('background or stopped agents do not receive input intended for the foreground program', () => {
  for (const state of ['S', 'T']) {
    const entries = {
      10: { comm: 'bash', cmdline: 'bash\0', children: '11 12', group: 10, foreground: 12 },
      11: { comm: 'codex', cmdline: 'codex\0', state, group: 11, foreground: 12 },
      12: { comm: 'vim', cmdline: 'vim\0notes.txt\0', group: 12, foreground: 12 },
    };
    assert.deepEqual(detectAgentProcess(10, proc(entries)), { available: true, kind: null });
    for (const entry of Object.values(entries)) entry.foreground = 11;
    entries[11].state = 'S';
    assert.deepEqual(detectAgentProcess(10, proc(entries)), { available: true, kind: 'codex' });
    entries[11].state = 'T';
    assert.deepEqual(detectAgentProcess(10, proc(entries)), { available: true, kind: null });
  }
});

test('detectAgentProcess finds Claude and Codex below a PTY shell', () => {
  assert.deepEqual(detectAgentProcess(10, proc({
    10: { comm: 'bash\n', cmdline: 'bash\0', children: '11' },
    11: { comm: 'claude\n', cmdline: 'claude\0--resume\0', children: '' },
  })), { available: true, kind: 'claude' });
  assert.deepEqual(detectAgentProcess(20, proc({
    20: { comm: 'bash\n', cmdline: 'bash\0', children: '21' },
    21: { comm: 'MainThread\n', cmdline: 'node\0/home/u/bin/codex\0', children: '22' },
    22: { comm: 'codex\n', cmdline: '/vendor/codex\0', children: '' },
  })), { available: true, kind: 'codex' });
  assert.deepEqual(detectAgentProcess(30, proc({
    30: { comm: 'bash\n', cmdline: 'bash\0', children: '' },
  })), { available: true, kind: null });
});

test('detectAgentProcess finds opencode below a PTY shell', () => {
  // opencode는 node 래퍼(comm=MainThread) 아래 바이너리로 뜨는 경우도 있다
  assert.deepEqual(detectAgentProcess(40, proc({
    40: { comm: 'bash\n', cmdline: 'bash\0', children: '41' },
    41: { comm: 'opencode\n', cmdline: '/usr/local/bin/opencode\0', children: '' },
  })), { available: true, kind: 'opencode' });
  assert.deepEqual(detectAgentProcess(50, proc({
    50: { comm: 'bash\n', cmdline: 'bash\0', children: '51' },
    51: { comm: 'MainThread\n', cmdline: 'node\0/home/u/.opencode/bin/opencode\0', children: '' },
  })), { available: true, kind: 'opencode' });
});

test('ordinary program arguments are not agent executables', () => {
  for (const executable of ['vim', 'cat', 'less', 'tail', 'rg']) {
    for (const agent of ['codex', 'claude', 'opencode']) {
      assert.deepEqual(detectAgentProcess(10, proc({
        10: { comm: 'bash', cmdline: 'bash\0', children: '11' },
        11: { comm: executable, cmdline: `${executable}\0${agent}\0` },
      })), { available: true, kind: null });
    }
  }
  assert.deepEqual(detectAgentProcess(10, proc({
    10: { comm: 'python3', cmdline: '/usr/bin/python3\0/tmp/codex\0' },
  })), { available: true, kind: 'codex' });
});
