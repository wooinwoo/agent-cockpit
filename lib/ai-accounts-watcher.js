// ─── AI 계정 credential 파일 감시자 ───
// 계정별 credential 디렉터리(.credentials.json / auth.json)와 허브 profiles.json을
// fs.watch로 감시해 로그인·갱신 순간 SSE(ai-accounts:changed)를 쏘는다.
// 목적: 로그인 터미널에서 로그인을 마쳐도 UI가 "로그인 필요"에 머물던 문제.

import { watch, existsSync, mkdirSync } from 'node:fs';
import { storedAccountDirs, storedAccountsRoot } from './ai-accounts-store.js';
import { aiAccountWatchTargets } from './ai-accounts-service.js';

const AUTH_FILENAMES = new Set(['.credentials.json', 'auth.json', 'profiles.json']);
const DEFAULT_DEBOUNCE_MS = 500;

let active = null;

/** 현재 감시해야 할 디렉터리 목록 — 내장 계정 루트/홈 + 허브 계정/프로필 위치 */
function collectWatchDirs() {
  const dirs = new Set();
  // 루트는 없으면 만든다 — 첫 계정 생성 이벤트를 놓치면 이후 감시 자체가 안 걸림
  try { mkdirSync(storedAccountsRoot(), { recursive: true }); } catch { /* 권한 등 실패 시 스킵 */ }
  dirs.add(storedAccountsRoot());
  for (const homePath of storedAccountDirs()) {
    if (existsSync(homePath)) dirs.add(homePath);
  }
  try { dirs.add(...aiAccountWatchTargets().filter(existsSync)); } catch { /* 허브 조회 실패는 무시 */ }
  return [...dirs];
}

/**
 * 계정 변화 감시 시작 — 이미 실행 중이면 재시작(계정 추가/삭제 반영).
 * @param {import('./poller.js').Poller} poller SSE 브로드캐스터
 * @param {object} [options]
 * @param {number} [options.debounceMs] 이벤트 병합 지연 (테스트용)
 */
export function startAiAccountWatcher(poller, options = {}) {
  stopAiAccountWatcher();
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
  const watched = new Map(); // dir → FSWatcher
  let debounceTimer = null;

  const emit = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try { poller.broadcast('ai-accounts:changed', { at: Date.now() }); } catch { /* poller 죽었으면 무시 */ }
      arm(); // 계정 추가/삭제 후 새 디렉터리도 감시
    }, debounceMs);
  };

  const arm = () => {
    const dirs = collectWatchDirs();
    for (const [dir, watcher] of watched) {
      if (!dirs.includes(dir)) {
        try { watcher.close(); } catch { /* already closed */ }
        watched.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (watched.has(dir)) continue;
      try {
        watched.set(dir, watch(dir, { persistent: false }, (event, filename) => {
          const base = String(filename || '').split(/[\\/]/).pop();
          // 내장 계정 루트는 계정 디렉터리 추가/삭제 자체가 신호, 그 외는 credential 파일만
          if (dir === storedAccountsRoot() || AUTH_FILENAMES.has(base)) emit();
        }));
      } catch { /* 디렉터리가 사라졌거나 권한 없음 — 다음 arm에서 재시도 */ }
    }
  };

  arm();
  active = {
    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const watcher of watched.values()) {
        try { watcher.close(); } catch { /* already closed */ }
      }
      watched.clear();
    },
  };
  return active;
}

export function stopAiAccountWatcher() {
  if (active) {
    active.stop();
    active = null;
  }
}
