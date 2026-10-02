import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { durableTerminalProcess } from './durable-terminal.js';

export function detectTerminalAgent(entry, read = readFileSync, getPane = durableTerminalProcess) {
  if (!entry.durableId) return detectAgentProcess(entry.pty?.pid, read);
  const pane = getPane(entry.durableId);
  if (!pane) return { available: false, kind: null };
  return pane.dead ? { available: true, kind: null } : detectAgentProcess(pane.pid, read);
}

function kindOf(comm, cmdline) {
  const args = cmdline.split('\0').filter(Boolean);
  const executable = basename(args[0] || '');
  // Only interpreter launchers execute argv[1]. Editors and search tools merely
  // consume it as data, even when the file happens to be named "codex".
  const script = /^(node|nodejs|bun|python(?:\d+(?:\.\d+)*)?)$/.test(executable) ? args[1] : '';
  const names = [comm, executable, basename(script || '')]
    .map(value => String(value || '').toLowerCase());
  if (names.includes('claude')) return 'claude';
  if (names.includes('codex')) return 'codex';
  if (names.includes('opencode')) return 'opencode';
  return null;
}

export function detectAgentProcess(rootPid, read = readFileSync) {
  // ponytail: Linux /proc fast path; add a native Windows process-tree adapter
  // only when Cockpit needs to detect manually typed agents outside WSL.
  if (!Number.isInteger(rootPid) || rootPid <= 0) return { available: false, kind: null };
  const queue = [rootPid];
  const seen = new Set();
  try {
    const stateOf = pid => {
      const stat = String(read(`/proc/${pid}/stat`, 'utf8'));
      return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    };
    const rootState = stateOf(rootPid);
    const foreground = Number(rootState[5]);
    if (!Number.isInteger(foreground) || foreground <= 0) return { available: false, kind: null };
    while (queue.length && seen.size < 128) {
      const pid = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const comm = String(read(`/proc/${pid}/comm`, 'utf8')).trim();
      const cmdline = String(read(`/proc/${pid}/cmdline`, 'utf8'));
      const state = pid === rootPid ? rootState : stateOf(pid);
      // A suspended/background AI does not own terminal input. Never inject
      // prompts into, or interrupt, the editor currently in the foreground.
      const kind = Number(state[2]) === foreground && !['T', 't', 'Z', 'X'].includes(state[0]) ? kindOf(comm, cmdline) : null;
      if (kind) return { available: true, kind };
      const children = String(read(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
      if (children) queue.push(...children.split(/\s+/).map(Number).filter(Number.isInteger));
    }
    return { available: true, kind: null };
  } catch {
    return { available: false, kind: null };
  }
}
