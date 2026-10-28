// ─── 계정별 로컬 사용량 계산 (어카운트 허브의 claude-code-jsonl 방식 채용) ───
// Claude: 계정 설정 디렉터리의 projects/**/*.jsonl 에서 message.usage 토큰 합산.
// 허브처럼 OAuth 호출 없이 로컬 데이터만 사용 — 외부 의존·크리덴셜 무관.
//
// 무거운 /mnt/c 스캔이 이벤트 루프를 막지 않도록:
//  - 스캔은 비동기(fs/promises)
//  - stale-while-revalidate: 목록 요청은 캐시 즉시 반환, 갱신은 백그라운드

import { readdir, stat, readFile, writeFile, rename } from 'node:fs/promises';
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

const LIMITS_URL = 'https://api.anthropic.com/api/oauth/usage';
// Claude Code CLI와 같은 OAuth 클라이언트 — 바이너리(2.1.x)의 TOKEN_URL·CLIENT_ID
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const _refreshing = new Map();

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
} // credential 파일 → 진행 중 갱신 Promise (중복 갱신 방지)

/**
 * 만료된 액세스 토큰을 refresh token으로 갱신해 credential 파일에 되써 넣는다.
 * CLI와 같은 파일을 쓰므로 다음 CLI 실행도 새 토큰을 그대로 사용.
 * @returns {Promise<object|null>} 갱신된 claudeAiOauth, 실패 시 null
 */
export function refreshClaudeToken(configDir, { fetchImpl = fetch, now = Date.now } = {}) {
  const file = join(configDir, '.credentials.json');
  if (_refreshing.has(file)) return _refreshing.get(file);
  const job = (async () => {
    let raw;
    try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
    const oauth = raw?.claudeAiOauth;
    if (!oauth?.refreshToken) return null;
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
        ...(Array.isArray(oauth.scopes) && oauth.scopes.length ? { scope: oauth.scopes.join(' ') } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.access_token || !Number.isFinite(body.expires_in)) return null;
    // 갱신 중 CLI가 먼저 파일을 바꿨을 수 있음 — 최신 파일 위에 토큰 필드만 덮음
    let latest = raw;
    try { latest = JSON.parse(await readFile(file, 'utf8')); } catch { /* 방금 읽은 값 사용 */ }
    const next = {
      ...latest,
      claudeAiOauth: {
        ...latest.claudeAiOauth,
        accessToken: body.access_token,
        refreshToken: body.refresh_token || oauth.refreshToken,
        expiresAt: now() + body.expires_in * 1000,
        ...(Number.isFinite(body.refresh_token_expires_in) ? { refreshTokenExpiresAt: now() + body.refresh_token_expires_in * 1000 } : {}),
      },
    };
    await writeAtomic(file, next);
    return next.claudeAiOauth;
  })().catch(() => null).finally(() => _refreshing.delete(file));
  _refreshing.set(file, job);
  return job;
}

function requestLimits(accessToken) {
  return fetch(LIMITS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(10_000),
  });
}

// 공식 플랜 한도 — Claude Code /usage와 같은 OAuth 엔드포인트 (토큰 소모 없음).
// 액세스 토큰이 만료(임박)됐거나 401이면 refresh token으로 갱신 후 재시도.
// 토큰 없음·갱신 실패·오류면 null → 호출부가 로컬 예산 추정으로 폴백.
async function fetchClaudeLimits(configDir) {
  let oauth;
  try { oauth = JSON.parse(await readFile(join(configDir, '.credentials.json'), 'utf8'))?.claudeAiOauth; } catch { return null; }
  if (!oauth?.accessToken) return null;
  try {
    if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt - REFRESH_SKEW_MS < Date.now()) {
      oauth = await refreshClaudeToken(configDir);
      if (!oauth) return null;
    }
    let res = await requestLimits(oauth.accessToken);
    if (res.status === 401) {
      oauth = await refreshClaudeToken(configDir);
      if (!oauth) return null;
      res = await requestLimits(oauth.accessToken);
    }
    if (!res.ok) return null;
    const body = await res.json();
    const pick = w => (Number.isFinite(w?.utilization) ? { remaining: Math.max(0, 100 - w.utilization), resetAt: w.resets_at || '' } : null);
    return { weekly: pick(body.seven_day), session: pick(body.five_hour) };
  } catch { return null; }
}

async function scanClaudeUsage(configDir, now) {
  const limitsPromise = fetchClaudeLimits(configDir);
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
    limits: await limitsPromise,
  };
}

// Codex: CLI가 세션 rollout jsonl의 token_count 이벤트에 공식 한도(rate_limits)를 기록.
// 가장 최근 기록을 쓰며, 창 길이(window_minutes)로 주간/5시간을 구분 (primary가 주간일 수도 있음).
// API 조회(fetchCodexLimits)가 실패할 때의 폴백 — 마지막 Codex 사용 시점 값
async function scanCodexRollouts(codexHome, now) {
  const files = [];
  for await (const file of walkJsonl(join(codexHome, 'sessions'))) {
    try {
      const { mtimeMs } = await stat(file);
      if (mtimeMs >= now - WEEK_MS) files.push({ file, mtimeMs });
    } catch { /* 사라진 파일 무시 */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { file, mtimeMs } of files) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let rl;
      try { rl = JSON.parse(lines[i])?.payload?.rate_limits; } catch { continue; }
      const windows = [rl?.primary, rl?.secondary].filter(w => Number.isFinite(w?.used_percent));
      if (!windows.length) continue;
      const pick = w => {
        if (!w) return null;
        const resetMs = Number.isFinite(w.resets_at) ? w.resets_at * 1000 : NaN;
        // 리셋 시각이 지났으면 그 창은 다시 가득 참
        if (Number.isFinite(resetMs) && resetMs <= now) return { remaining: 100, resetAt: '' };
        return { remaining: Math.max(0, 100 - w.used_percent), resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : '' };
      };
      return {
        provider: 'codex',
        lastActiveAt: new Date(mtimeMs).toISOString(),
        limits: {
          weekly: pick(windows.find(w => w.window_minutes >= 24 * 60)),
          session: pick(windows.find(w => w.window_minutes < 24 * 60)),
        },
      };
    }
  }
  return null;
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

// Codex CLI와 같은 OAuth 클라이언트·엔드포인트 — 바이너리(0.154)의 문자열
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Codex auth.json 토큰을 refresh token으로 갱신해 되써 넣는다. 실패 시 null */
export function refreshCodexToken(codexHome, { fetchImpl = fetch } = {}) {
  const file = join(codexHome, 'auth.json');
  if (_refreshing.has(file)) return _refreshing.get(file);
  const job = (async () => {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (!raw?.tokens?.refresh_token) return null;
    const res = await fetchImpl(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: raw.tokens.refresh_token }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.access_token) return null;
    let latest = raw;
    try { latest = JSON.parse(await readFile(file, 'utf8')); } catch { /* 방금 읽은 값 사용 */ }
    const next = {
      ...latest,
      tokens: {
        ...latest.tokens,
        access_token: body.access_token,
        ...(body.id_token ? { id_token: body.id_token } : {}),
        ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
      },
      last_refresh: new Date().toISOString(),
    };
    await writeAtomic(file, next);
    return next.tokens;
  })().catch(() => null).finally(() => _refreshing.delete(file));
  _refreshing.set(file, job);
  return job;
}

function requestCodexUsage(tokens, fetchImpl) {
  return fetchImpl(CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      ...(tokens.account_id ? { 'ChatGPT-Account-Id': tokens.account_id } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

/** Codex 공식 한도 — /status와 같은 사용량 API. 401이면 토큰 갱신 후 재시도. 실패 시 null */
export async function fetchCodexLimits(codexHome, { fetchImpl = fetch, now = Date.now() } = {}) {
  let tokens;
  try { tokens = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'))?.tokens; } catch { return null; }
  if (!tokens?.access_token) return null;
  try {
    let res = await requestCodexUsage(tokens, fetchImpl);
    if (res.status === 401) {
      tokens = await refreshCodexToken(codexHome, { fetchImpl });
      if (!tokens) return null;
      res = await requestCodexUsage(tokens, fetchImpl);
    }
    if (!res.ok) return null;
    const body = await res.json();
    const windows = [body?.rate_limit?.primary_window, body?.rate_limit?.secondary_window]
      .filter(w => Number.isFinite(w?.used_percent));
    if (!windows.length) return null;
    const pick = w => {
      if (!w) return null;
      const resetMs = Number.isFinite(w.reset_at) ? w.reset_at * 1000 : NaN;
      if (Number.isFinite(resetMs) && resetMs <= now) return { remaining: 100, resetAt: '' };
      return { remaining: Math.max(0, 100 - w.used_percent), resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : '' };
    };
    return {
      plan: body.plan_type || '',
      limits: {
        weekly: pick(windows.find(w => w.limit_window_seconds >= 24 * 3600)),
        session: pick(windows.find(w => w.limit_window_seconds < 24 * 3600)),
      },
    };
  } catch { return null; }
}

async function scanCodexUsage(codexHome, now) {
  const api = await fetchCodexLimits(codexHome, { now });
  if (api) return { provider: 'codex', lastActiveAt: '', limits: api.limits };
  return scanCodexRollouts(codexHome, now);
}

const SCANNERS = { claude: scanClaudeUsage, codex: scanCodexUsage };

/** credential 변경(로그인·토큰 갱신) 시 호출 — 다음 조회에서 즉시 재스캔 */
export function invalidateAccountUsage(configDir) {
  const entry = _cache.get(configDir);
  if (entry) entry.refreshedAt = 0;
}

/** 캐시에서 즉시 꺼내기 (스캔 유발 없음 — 목록 응답용) */
export function usageSnapshot(provider, configDir) {
  if (!SCANNERS[provider] || !configDir) return null;
  return _cache.get(configDir)?.usage || null;
}

/**
 * 백그라운드 갱신 트리거. 캐시가 신선하면 즉시 반환, 오래됐으면
 * 이전 값을 유지한 채 비동기 스캔 시작(중복 스캔 방지).
 * @returns {Promise<object|null>} 최신(또는 갱신된) usage
 */
export function refreshAccountUsage(provider, configDir, now = Date.now()) {
  if (!SCANNERS[provider] || !configDir) return Promise.resolve(null);
  const entry = _cache.get(configDir);
  if (entry && now - entry.refreshedAt < CACHE_TTL) return Promise.resolve(entry.usage);
  if (entry?.refreshing) return entry.refreshing;
  const refreshing = SCANNERS[provider](configDir, now)
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

export async function computeCodexUsage(codexHome, now = Date.now()) {
  return scanCodexRollouts(codexHome, now);
}
