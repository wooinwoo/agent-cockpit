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
  assert.equal(usageSnapshot('codex', root), null);
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
