import test from 'node:test';
import assert from 'node:assert/strict';
import { isMcpServerProcess, hasLivingParentMarker, cleanupOrphanMcpProcesses } from '../../lib/orphan-cleaner.js';

test('isMcpServerProcess matches npx MCP binaries only', () => {
  assert.equal(isMcpServerProcess('node /home/u/.npm/_npx/abc/node_modules/.bin/playwright-mcp --executable-path x'), true);
  assert.equal(isMcpServerProcess('node /home/u/.npm/_npx/def/node_modules/.bin/context7-mcp'), true);
  assert.equal(isMcpServerProcess('node /home/u/.npm/_npx/ghi/node_modules/.bin/mcp-server-filesystem'), true);
  assert.equal(isMcpServerProcess('node /home/u/.npm/_npx/abc/node_modules/.bin/rollup -c'), false);
  assert.equal(isMcpServerProcess('node server.js'), false);
  assert.equal(isMcpServerProcess('claude --model haiku'), false);
  assert.equal(isMcpServerProcess(''), false);
});

test('hasLivingParentMarker keeps sessions inside AI/editor/tmux trees', () => {
  assert.equal(hasLivingParentMarker(['tmux -L cockpit-x new-session -d']), true);
  assert.equal(hasLivingParentMarker(['claude -p --safe-mode', 'tmux attach']), true);
  assert.equal(hasLivingParentMarker(["sh -c 'playwright-mcp'", 'node server.js']), true);
  assert.equal(hasLivingParentMarker(["sh -c 'playwright-mcp'"]), false);
  assert.equal(hasLivingParentMarker([]), false);
});

test('cleanup runs safely on a live system and returns what it killed', () => {
  const killed = [];
  const result = cleanupOrphanMcpProcesses({
    minAgeSeconds: Number.MAX_SAFE_INTEGER, // 테스트에선 실제 kill 없음: 전부 나이 미달로 걸러짐
    kill: (pid, signal) => { killed.push([pid, signal]); },
    logger: { info: () => {} },
  });
  assert.ok(Array.isArray(result));
  assert.deepEqual(killed, []); // 나이 필터가 전부 차단 — 부작용 없음
});
