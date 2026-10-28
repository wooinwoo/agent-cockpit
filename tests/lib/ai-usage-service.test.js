import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeClaudeUsage, usageSnapshot, refreshAccountUsage, nextWeeklyResetFrom } from '../../lib/ai-usage-service.js';

const NOW = Date.parse('2026-09-10T06:00:00.000Z');

function seedAccount(root, entries) {
  const projDir = join(root, 'projects', 'demo-app');
  mkdirSync(projDir, { recursive: true });
  const lines = entries.map(e => JSON.stringify({
    timestamp: e.ts,
    message: { usage: { input_tokens: e.in || 0, output_tokens: e.out || 0 } },
  }));
  writeFileSync(join(projDir, 's1.jsonl'), lines.join('\n'));
  // mtime을 최신으로 유지 (7일 필터 통과)
  utimesSync(join(projDir, 's1.jsonl'), new Date(NOW), new Date(NOW));
}

test('computes weekly and 5h window usage from jsonl', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-ai-usage-'));
  seedAccount(root, [
    { ts: '2026-09-10T05:00:00.000Z', in: 100, out: 50 },   // 5h 창 안
    { ts: '2026-09-10T02:00:00.000Z', in: 200, out: 100 },  // 5h 창 안
    { ts: '2026-09-08T00:00:00.000Z', in: 1000, out: 0 },   // 주간, 창 밖
    { ts: '2026-08-20T00:00:00.000Z', in: 99999, out: 0 },  // 주간 밖 — 제외
  ]);
  const usage = await computeClaudeUsage(root, NOW);
  assert.equal(usage.provider, 'claude');
  assert.equal(usage.weeklyTokens, 1450);      // 150 + 300 + 1000
  assert.equal(usage.sessionTokens, 450);      // 5h 창 두 건
  assert.equal(usage.daily.length, 2);
  assert.equal(usage.lastActiveAt, '2026-09-10T05:00:00.000Z');
  // 주간 풀림 추정: 가장 오래된 사용(09-08T00:00Z) + 7일
  assert.equal(usage.weeklyResetAt, '2026-09-15T00:00:00.000Z');
});

test('nextWeeklyResetFrom advances stale hub reset by weekly cadence', () => {
  // 허브 마지막 기록 8/29 08:59 UTC — NOW(9/10 06:00Z) 이후 첫 리셋은 9/12 08:59
  assert.equal(nextWeeklyResetFrom('2026-08-29T08:59:00+00:00', NOW), '2026-09-12T08:59:00.000Z');
  assert.equal(nextWeeklyResetFrom('2026-09-12T08:59:00Z', NOW), '2026-09-12T08:59:00.000Z'); // 미래면 그대로
  assert.equal(nextWeeklyResetFrom('', NOW), '');
  assert.equal(nextWeeklyResetFrom('not-a-date', NOW), '');
});

test('stale-while-revalidate: snapshot is instant, refresh fills cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-ai-usage-'));
  seedAccount(root, [{ ts: '2026-09-09T00:00:00.000Z', in: 10, out: 0 }]);

  // 스캔 전 스냅샷 — 즉시 null (스캔 유발 없음)
  assert.equal(usageSnapshot('claude', root), null);
  assert.equal(usageSnapshot('gemini', root), null);
  assert.equal(usageSnapshot('claude', ''), null);

  // 첫 갱신은 스캔 완료까지 대기
  const fresh = await refreshAccountUsage('claude', root, NOW);
  assert.equal(fresh.weeklyTokens, 10);

  // 갱신 후 스냅샷 즉시 반환, 신선한 캐시로 재호출은 추가 스캔 없음
  assert.equal(usageSnapshot('claude', root).weeklyTokens, 10);
  const again = await refreshAccountUsage('claude', root, NOW + 1000);
  assert.equal(again, fresh);

  // 만료 후 재호출은 백그라운드 재스캔 — 이전 값 유지
  const stale = refreshAccountUsage('claude', root, NOW + 10 * 60 * 1000);
  assert.ok(stale instanceof Promise);
  assert.equal(usageSnapshot('claude', root).weeklyTokens, 10);
  assert.equal((await stale).weeklyTokens, 10);

  const empty = await computeClaudeUsage(join(root, 'nope'), NOW);
  assert.equal(empty.weeklyTokens, 0);
  assert.equal(empty.lastActiveAt, '');
});

test('reads codex official rate limits from latest rollout', async () => {
  const { computeCodexUsage } = await import('../../lib/ai-usage-service.js');
  const root = await mkdtemp(join(tmpdir(), 'cockpit-codex-usage-'));
  const dir = join(root, 'sessions', '2026', '09', '10');
  mkdirSync(dir, { recursive: true });
  const resetSec = Math.floor((NOW + 3 * 24 * 60 * 60 * 1000) / 1000);
  const line = rl => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } });
  writeFileSync(join(dir, 'rollout-a.jsonl'), [
    line({ primary: { used_percent: 10, window_minutes: 10080, resets_at: resetSec }, secondary: null }),
    line({ primary: { used_percent: 40, window_minutes: 300, resets_at: Math.floor(NOW / 1000) - 60 }, secondary: { used_percent: 25, window_minutes: 10080, resets_at: resetSec } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
  ].join('\n'));
  utimesSync(join(dir, 'rollout-a.jsonl'), new Date(NOW), new Date(NOW));

  const usage = await computeCodexUsage(root, NOW);
  assert.equal(usage.provider, 'codex');
  assert.equal(usage.limits.weekly.remaining, 75);
  assert.equal(usage.limits.weekly.resetAt, new Date(resetSec * 1000).toISOString());
  assert.deepEqual(usage.limits.session, { remaining: 100, resetAt: '' }); // 리셋 지남
  assert.equal(await computeCodexUsage(join(root, 'nope'), NOW), null);
});

test('refreshClaudeToken rotates tokens into credential file', async () => {
  const { refreshClaudeToken } = await import('../../lib/ai-usage-service.js');
  const { readFileSync } = await import('node:fs');
  const root = await mkdtemp(join(tmpdir(), 'cockpit-claude-refresh-'));
  const file = join(root, '.credentials.json');
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r1', expiresAt: 1, scopes: ['user:inference'], subscriptionType: 'max' } }));
  let sent;
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }) }; };
  const [a, b] = await Promise.all([refreshClaudeToken(root, { fetchImpl, now: () => 1000 }), refreshClaudeToken(root, { fetchImpl, now: () => 1000 })]);
  assert.equal(a, b); // 동시 호출은 한 번만 갱신
  assert.deepEqual(sent, { grant_type: 'refresh_token', refresh_token: 'r1', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: 'user:inference' });
  const saved = JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth;
  assert.deepEqual(saved, { accessToken: 'new', refreshToken: 'r2', expiresAt: 3_601_000, scopes: ['user:inference'], subscriptionType: 'max' });
  const failed = await refreshClaudeToken(root, { fetchImpl: async () => ({ ok: false }) });
  assert.equal(failed, null);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth.accessToken, 'new'); // 실패 시 파일 유지
});

test('fetchCodexLimits reads usage API and refreshes token on 401', async () => {
  const { fetchCodexLimits } = await import('../../lib/ai-usage-service.js');
  const { readFileSync } = await import('node:fs');
  const root = await mkdtemp(join(tmpdir(), 'cockpit-codex-api-'));
  writeFileSync(join(root, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'old', refresh_token: 'r1', id_token: 'i1', account_id: 'acc' } }));
  const resetSec = Math.floor(NOW / 1000) + 3600;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init.headers?.Authorization || JSON.parse(init.body).refresh_token]);
    if (url.includes('oauth/token')) return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'r2' }) };
    if (init.headers.Authorization === 'Bearer old') return { ok: false, status: 401 };
    return { ok: true, status: 200, json: async () => ({ plan_type: 'pro', rate_limit: {
      primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: resetSec },
      secondary_window: { used_percent: 90, limit_window_seconds: 604800, reset_at: resetSec },
    } }) };
  };
  const result = await fetchCodexLimits(root, { fetchImpl, now: NOW });
  assert.deepEqual(result.limits, {
    weekly: { remaining: 10, resetAt: new Date(resetSec * 1000).toISOString() },
    session: { remaining: 70, resetAt: new Date(resetSec * 1000).toISOString() },
  });
  assert.deepEqual(calls.map(c => c[1]), ['Bearer old', 'r1', 'Bearer new']);
  const saved = JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8'));
  assert.equal(saved.tokens.access_token, 'new');
  assert.equal(saved.tokens.refresh_token, 'r2');
  assert.equal(saved.tokens.id_token, 'i1');
  assert.equal(saved.tokens.account_id, 'acc');
  assert.equal(await fetchCodexLimits(join(root, 'nope'), { fetchImpl }), null);
});
