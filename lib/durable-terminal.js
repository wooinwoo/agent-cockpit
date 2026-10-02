import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { IS_WIN } from './platform.js';

const TMUX_PATHS = ['/usr/bin/tmux', '/bin/tmux'];

export function durableTerminalsAvailable({
  isWin = IS_WIN,
  env = process.env,
  exists = existsSync,
} = {}) {
  return !isWin && env.COCKPIT_DURABLE_TERMINALS !== '0' && TMUX_PATHS.some(exists);
}

function tmuxBin(exists = existsSync) {
  return TMUX_PATHS.find(exists) || 'tmux';
}

function validateId(id) {
  const value = String(id || '');
  if (!/^[a-f0-9]{24}$/.test(value)) throw new Error('Invalid durable terminal id');
  return value;
}

function socketName(id) {
  return `cockpit-${validateId(id)}`;
}

export function durableTerminalExists(id, { exec = execFileSync, exists = existsSync } = {}) {
  try {
    exec(tmuxBin(exists), ['-L', socketName(id), 'has-session', '-t', 'main'], { stdio: 'ignore', timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

export function ensureDurableTerminal({ id, cwd, env, exec = execFileSync, exists = existsSync }) {
  const socket = socketName(id);
  const bin = tmuxBin(exists);
  const resumed = durableTerminalExists(id, { exec, exists });
  if (!resumed) {
    exec(bin, ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'main', '-c', cwd], { stdio: 'ignore', env, timeout: 3000 });
    exec(bin, ['-L', socket, 'set-option', '-g', 'status', 'off'], { stdio: 'ignore', env, timeout: 1000 });
  }
  return {
    id: validateId(id),
    resumed,
    shell: bin,
    args: ['-L', socket, 'attach-session', '-t', 'main'],
    cwd,
    env,
  };
}

export function durableTerminalCwd(id, { exec = execFileSync, exists = existsSync } = {}) {
  try {
    return exec(tmuxBin(exists), ['-L', socketName(id), 'display-message', '-p', '-t', 'main', '#{pane_current_path}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
    }).trim();
  } catch {
    return '';
  }
}

export function durableTerminalProcess(id, { exec = execFileSync, exists = existsSync } = {}) {
  try {
    const [pid, dead] = exec(tmuxBin(exists), ['-L', socketName(id), 'display-message', '-p', '-t', 'main', '#{pane_pid} #{pane_dead}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
    }).trim().split(' ').map(Number);
    return Number.isInteger(pid) && pid > 0 && [0, 1].includes(dead) ? { pid, dead: dead === 1 } : null;
  } catch { return null; }
}

export function durableTerminalScreen(id, { exec = execFileSync, exists = existsSync } = {}) {
  try {
    // Capture the visible pane only; scrollback can contain already-dismissed dialogs.
    return exec(tmuxBin(exists), ['-L', socketName(id), 'capture-pane', '-p', '-J', '-t', 'main'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
    });
  } catch { return null; }
}

export function validateRecoveryCommand(command) {
  // Restart only the selected interactive agent, without adding permission flags.
  if (typeof command !== 'string' || command.length > 500
      || !/^(claude|codex|opencode)(?: --?[A-Za-z0-9][A-Za-z0-9_.=-]*)*$/.test(command)) {
    throw new Error('자동 복구는 기본 AI 실행 명령과 단일 옵션만 지원합니다. 로그인·일회성 명령은 지원하지 않습니다.');
  }
  return command;
}

export function retainDurableTerminal(id, { exec = execFileSync, exists = existsSync } = {}) {
  exec(tmuxBin(exists), ['-L', socketName(id), 'set-option', '-w', '-t', 'main', 'remain-on-exit', 'on'], { stdio: 'ignore', timeout: 1000 });
}

export function restartDurableAgent(id, command, { exec = execFileSync, exists = existsSync, read = readFileSync, allowRunning = false, deadline = 0 } = {}) {
  validateRecoveryCommand(command);
  const pane = durableTerminalProcess(id, { exec, exists });
  if (!pane) throw new Error('감독 터미널 상태를 확인하지 못해 자동 복구를 보류했습니다.');
  if (!pane.dead && !allowRunning) {
    const name = read(`/proc/${pane.pid}/comm`, 'utf8').trim();
    const children = read(`/proc/${pane.pid}/task/${pane.pid}/children`, 'utf8').trim();
    if (!['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'].includes(name) || children) {
      throw new Error('감독 터미널에 실행 중인 프로세스가 있어 자동 복구를 보류했습니다.');
    }
  }
  retainDurableTerminal(id, { exec, exists });
  // A live pane is interrupted only under the user's separate report-deadline setting.
  const bin = tmuxBin(exists);
  const socket = socketName(id);
  const cwd = durableTerminalCwd(id, { exec, exists });
  if (deadline && deadline <= Date.now()) throw new Error('야간 운영 종료 시각이 지나 자동 복구를 취소했습니다.');
  exec(bin, ['-L', socket, 'respawn-pane', '-k', '-t', 'main', ...(cwd ? ['-c', cwd] : [])], { stdio: 'ignore', timeout: 3000 });
  // Start through the normal interactive shell so its PATH matches the original terminal.
  if (deadline && deadline <= Date.now()) throw new Error('야간 운영 종료 시각이 지나 자동 복구를 취소했습니다.');
  exec(bin, ['-L', socket, 'send-keys', '-t', 'main', '-l', '--', command], { stdio: 'ignore', timeout: 1000 });
  if (deadline && deadline <= Date.now()) throw new Error('야간 운영 종료 시각이 지나 자동 복구를 취소했습니다.');
  exec(bin, ['-L', socket, 'send-keys', '-t', 'main', 'Enter'], { stdio: 'ignore', timeout: 1000 });
}

export function killDurableTerminal(id, { exec = execFileSync, exists = existsSync } = {}) {
  exec(tmuxBin(exists), ['-L', socketName(id), 'kill-server'], { stdio: 'ignore', timeout: 1000 });
  return true;
}
