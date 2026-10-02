import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SCRIPT = '/tmp/approve-cockpit-sessions.sh';
const HEARTBEAT = '/tmp/approve-cockpit-sessions.heartbeat';

// Manage only the existing dedicated watcher. This module never starts it or sends approval keys.
export function createApprovalWatcher({ exec = execFileSync, read = readFileSync, now = Date.now } = {}) {
  const tmux = args => exec('/usr/bin/tmux', ['-L', 'approve-bot', ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] });
  const status = () => {
    let state = 'unknown';
    let canStop = false;
    try {
      const lines = tmux(['list-panes', '-s', '-t', '=approvals', '-F', '#{pane_dead}|#{pane_start_command}']).trim().split('\n');
      canStop = lines.length === 1 && lines[0] === `0|${SCRIPT}`;
      state = canStop ? 'running' : 'unknown';
    } catch (error) {
      if (/can't find session|no server running|No such file or directory/.test(String(error.stderr || ''))) state = 'stopped';
    }
    let heartbeat = null;
    try {
      const [at, ...fields] = read(HEARTBEAT, 'utf8').trim().split(/\s+/);
      const timestamp = Date.parse(at);
      if (Number.isFinite(timestamp)) {
        const values = Object.fromEntries(fields.map(field => field.split('=')));
        const number = key => /^\d+$/.test(values[key] || '') ? Number(values[key]) : null;
        heartbeat = { at: timestamp, stale: now() - timestamp > 15_000, readOk: number('read_ok'), sent: number('sent_total'), cleared: number('cleared_total') };
      }
    } catch { /* An unavailable heartbeat must not be reported as a stopped process. */ }
    return { state, canStop, script: SCRIPT, targets: ['ai1', 'ai4', 'ai6', 'ai7'], intervalSeconds: 3, heartbeat };
  };
  return {
    status,
    stop() {
      if (!status().canStop) throw new Error('승인 스크립트의 전용 세션을 확인하지 못해 중지하지 않았습니다.');
      tmux(['kill-session', '-t', '=approvals']);
      return status();
    },
  };
}
