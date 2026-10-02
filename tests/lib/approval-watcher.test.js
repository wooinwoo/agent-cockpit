import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalWatcher } from '../../lib/approval-watcher.js';

test('watcher status distinguishes stale heartbeat, missing session and inaccessible state', () => {
  const read = () => '2026-10-02T00:00:00Z read_ok=4 sent_total=12 cleared_total=10 version=2';
  const watcher = createApprovalWatcher({ read, now: () => Date.parse('2026-10-02T00:01:00Z'), exec: () => '0|/tmp/approve-cockpit-sessions.sh\n' });
  assert.equal(watcher.status().state, 'running');
  assert.equal(watcher.status().heartbeat.stale, true);
  assert.equal(watcher.status().heartbeat.sent, 12);
  for (const [stderr, state] of [['no server running', 'stopped'], ['Permission denied', 'unknown']]) {
    const checked = createApprovalWatcher({ read, exec: () => { throw Object.assign(new Error('tmux failed'), { stderr }); } }).status();
    assert.equal(checked.state, state);
    assert.equal(checked.canStop, false);
  }
});

test('stop targets only the known dedicated script and exposes no approval or start operation', () => {
  const calls = [];
  let stopped = false;
  const watcher = createApprovalWatcher({ read: () => '', exec: (file, args) => {
    calls.push([file, args]);
    if (stopped) throw Object.assign(new Error('missing'), { stderr: 'no server running' });
    if (args.includes('kill-session')) { stopped = true; return ''; }
    return '0|/tmp/approve-cockpit-sessions.sh\n';
  } });
  assert.equal(watcher.stop().state, 'stopped');
  assert.deepEqual(calls[1], ['/usr/bin/tmux', ['-L', 'approve-bot', 'kill-session', '-t', '=approvals']]);
  const unrelated = createApprovalWatcher({ read: () => '', exec: () => '0|codex\n' });
  assert.throws(() => unrelated.stop(), /전용 세션/);
  assert.deepEqual(Object.keys(watcher), ['status', 'stop']);
});
