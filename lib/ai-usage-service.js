// ─── 계정별 로컬 사용량 계산 (어카운트 허브의 claude-code-jsonl 방식 채용) ───
// Claude: 계정 설정 디렉터리의 projects/**/*.jsonl 에서 message.usage 토큰 합산.
// 허브처럼 OAuth 호출 없이 로컬 데이터만 사용 — 외부 의존·크리덴셜 무관.
//
// 무거운 /mnt/c 스캔이 이벤트 루프를 막지 않도록:
//  - 스캔은 비동기(fs/promises)
//  - stale-while-revalidate: 목록 요청은 캐시 즉시 반환, 갱신은 백그라운드

import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_TTL = 5 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const _cache = new Map(); // configDir → { usage, refreshedAt, refreshing }

async function* walkJsonl(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.name.endsWith('.jsonl')) yield full;
  }
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function scanClaudeUsage(configDir, now) {
  const daily = new Map(); // dateKey → { tokens, firstTs }
  let sessionTokens = 0;
  let lastActive = 0;

  const projectsDir = join(configDir, 'projects');
  for await (const file of walkJsonl(projectsDir)) {
    // 7일 넘게 안 변한 파일은 주간/세션 집계 대상 밖 — stat으로 걸러 읽기 비용 절감
    try { if ((await stat(file)).mtimeMs < now - WEEK_MS) continue; } catch { continue; }
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const u = entry?.message?.usage;
      const ts = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (!u || !Number.isFinite(ts)) continue;
      const tokens = (u.input_tokens || 0) + (u.output_tokens || 0);
      if (!tokens) continue;
      if (ts < now - WEEK_MS) continue;
      const key = dayKey(ts);
      const bucket = daily.get(key) || { tokens: 0, firstTs: ts };
      bucket.tokens += tokens;
      if (ts < bucket.firstTs) bucket.firstTs = ts;
      daily.set(key, bucket);
      if (ts > now - SESSION_WINDOW_MS) sessionTokens += tokens;
      if (ts > lastActive) lastActive = ts;
    }
  }

  const dailyList = [...daily.entries()]
    .map(([date, bucket]) => ({ date, tokens: bucket.tokens }))
    .sort((a, b) => a.date.localeCompare(b.date));
  // 주간 풀림(추정): 가장 오래된 사용일의 첫 사용 시각 + 7일 — 그때부터 롤링 윈도에서 빠져나감
  const oldestFirstTs = daily.size ? Math.min(...[...daily.values()].map(b => b.firstTs)) : 0;
  return {
    provider: 'claude',
    weeklyTokens: dailyList.reduce((sum, d) => sum + d.tokens, 0),
    sessionTokens,
    lastActiveAt: lastActive ? new Date(lastActive).toISOString() : '',
    weeklyResetAt: oldestFirstTs ? new Date(oldestFirstTs + WEEK_MS).toISOString() : '',
    daily: dailyList,
  };
}

/**
 * 계정 고정 주간 리셋 주기 이어가기 — 허브가 마지막으로 기록한 리셋 시각에서
 * 매주 같은 시각대를 유지하며 now 이후 첫 시점으로 진행.
 * @param {string} lastResetUtc
 * @param {number} [now]
 * @returns {string} ISO or ''
 */
export function nextWeeklyResetFrom(lastResetUtc, now = Date.now()) {
  const t = Date.parse(lastResetUtc || '');
  if (!Number.isFinite(t)) return '';
  let next = t;
  while (next <= now) next += WEEK_MS;
  return new Date(next).toISOString();
}

/** 캐시에서 즉시 꺼내기 (스캔 유발 없음 — 목록 응답용) */
export function usageSnapshot(provider, configDir) {
  if (provider !== 'claude' || !configDir) return null;
  return _cache.get(configDir)?.usage || null;
}

/**
 * 백그라운드 갱신 트리거. 캐시가 신선하면 즉시 반환, 오래됐으면
 * 이전 값을 유지한 채 비동기 스캔 시작(중복 스캔 방지).
 * @returns {Promise<object|null>} 최신(또는 갱신된) usage
 */
export function refreshAccountUsage(provider, configDir, now = Date.now()) {
  if (provider !== 'claude' || !configDir) return Promise.resolve(null);
  const entry = _cache.get(configDir);
  if (entry && now - entry.refreshedAt < CACHE_TTL) return Promise.resolve(entry.usage);
  if (entry?.refreshing) return entry.refreshing;
  const refreshing = scanClaudeUsage(configDir, now)
    .then(usage => {
      _cache.set(configDir, { usage, refreshedAt: now, refreshing: null });
      return usage;
    })
    .catch(() => {
      const prev = _cache.get(configDir);
      if (prev) prev.refreshing = null;
      return prev?.usage || null;
    });
  _cache.set(configDir, { usage: entry?.usage || null, refreshedAt: entry?.refreshedAt || 0, refreshing });
  return refreshing;
}

/** 테스트·즉시 값용: 캐시 무시하고 직접 스캔 */
export async function computeClaudeUsage(configDir, now = Date.now()) {
  return scanClaudeUsage(configDir, now);
}
