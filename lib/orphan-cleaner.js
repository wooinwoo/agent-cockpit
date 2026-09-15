// ─── 고아 MCP 프로세스 정리 ───
// AI 세션(claude/codex/opencode)이 꺼져도 살아남은 MCP 서버(playwright-mcp 등,
// 세션당 ~100MB)을 주기적으로 찾아 종료한다.
//
// 안전 규칙:
//  1. /proc 기준 MCP 패턴(_npx + mcp 바이너리)만 대상
//  2. 조상 체인에 살아있는 AI/에디터/콕핏 프로세스가 있으면 절대 건드리지 않음
//  3. 실행 후 최소 minAgeSeconds(기본 10분)가 지난 것만 — 세션 기동 직후 경쟁 방지
// Linux 전용(Windows에선 no-op).

import { readdirSync, readFileSync } from 'node:fs';
import { IS_WIN } from './platform.js';

const KEEP_MARKERS = ['claude', 'codex', 'opencode', 'tmux', 'vscode', '/code', 'cursor', 'zed', 'windsurf', 'server.js'];
const MIN_AGE_SECONDS = 10 * 60;

/** @param {string} cmdline */
export function isMcpServerProcess(cmdline) {
  if (typeof cmdline !== 'string') return false;
  if (!cmdline.includes('_npx')) return false;
  const bin = cmdline.split(' ').find(part => part.includes('.bin')) || cmdline;
  return /-?mcp|mcp-server/i.test(bin);
}

/** 조상 cmdlines 중 하나라도 살아있는 부모(AI/에디터/콕핏)를 포함하는지 */
export function hasLivingParentMarker(ancestorCmdlines) {
  return ancestorCmdlines.some(cmd => KEEP_MARKERS.some(marker => cmd.includes(marker)));
}

function readCmdline(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; }
}

function readPpid(pid) {
  try {
    const parts = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    return parseInt(parts[3], 10);
  } catch { return 0; }
}

function elapsedSeconds(pid) {
  try {
    const starttime = parseFloat(readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21]);
    const [uptime] = readFileSync('/proc/uptime', 'utf8').split(' ').map(Number);
    return Math.max(0, Math.round(uptime - starttime / 100));
  } catch { return 0; }
}

/** 고아 MCP 후보 탐색 (나이 필터 없음 — 테스트/점검용) */
export function findOrphanMcpProcesses() {
  if (IS_WIN) return [];
  const found = [];
  let pids;
  try { pids = readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number); } catch { return []; }
  const ownPid = process.pid;
  for (const pid of pids) {
    if (pid === ownPid) continue;
    const cmd = readCmdline(pid);
    if (!isMcpServerProcess(cmd)) continue;
    // 조상 체인 순회 (루프 방어)
    const seen = new Set([pid]);
    let cur = readPpid(pid);
    const ancestors = [];
    while (cur > 1 && !seen.has(cur)) {
      seen.add(cur);
      const ancestorCmd = readCmdline(cur);
      if (!ancestorCmd) break; // 조상이 이미 죽었으면 고아 확정
      ancestors.push(ancestorCmd);
      cur = readPpid(cur);
    }
    if (ancestors.length && hasLivingParentMarker(ancestors)) continue;
    found.push({ pid, rssKb: 0, cmd: cmd.slice(0, 120) });
  }
  return found;
}

/**
 * 고아 MCP 종료. SIGTERM → 짧은 유예 후 SIGKILL.
 * @param {{minAgeSeconds?: number, kill?: (pid:number, signal:string)=>void, logger?: object}} [options]
 * @returns {Array<{pid:number, cmd:string}>} 종료한 프로세스
 */
export function cleanupOrphanMcpProcesses(options = {}) {
  const { minAgeSeconds = MIN_AGE_SECONDS, kill = (pid, signal) => process.kill(pid, signal), logger } = options;
  const killed = [];
  for (const candidate of findOrphanMcpProcesses()) {
    if (elapsedSeconds(candidate.pid) < minAgeSeconds) continue;
    try {
      kill(candidate.pid, 'SIGTERM');
      killed.push(candidate);
      logger?.info?.('cleanup', `고아 MCP 종료 (pid ${candidate.pid}): ${candidate.cmd}`);
    } catch { /* 이미 죽음 — 무시 */ }
  }
  // 5초 후에도 살아있으면 SIGKILL (fire-and-forget)
  if (killed.length) {
    setTimeout(() => {
      for (const { pid } of killed) { try { kill(pid, 'SIGKILL'); } catch { /* already dead */ } }
    }, 5000).unref();
  }
  return killed;
}
