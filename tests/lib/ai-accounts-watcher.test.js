import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA_DIR은 config.js 로드 시 고정되므로 임시 디렉터리로 리다이렉트 후 동적 import
const tempRoot = await mkdtemp(join(tmpdir(), 'cockpit-ai-watch-'));
process.env.LOCALAPPDATA = tempRoot;
mkdirSync(join(tempRoot, 'cockpit'), { recursive: true });

const { createStoredAccount } = await import('../../lib/ai-accounts-store.js');
const { startAiAccountWatcher, stopAiAccountWatcher } = await import('../../lib/ai-accounts-watcher.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const settled = () => sleep(400); // 계정 생성(디렉터리 추가) 이벤트가 소진될 때까지

test('watcher broadcasts when a credential file appears', async () => {
  const events = [];
  const poller = { broadcast: (event) => events.push(event) };
  startAiAccountWatcher(poller, { debounceMs: 30 });

  const record = createStoredAccount({ name: '감시 대상', provider: 'claude' });
  await settled(); // 감시자가 새 계정 디렉터리를 포착·감시 시작
  const before = events.length;
  writeFileSync(join(record.homePath, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  }));

  await sleep(400);
  stopAiAccountWatcher();
  assert.ok(events.length > before, 'credential 생성 이벤트가 브로드캐스트돼야 함');
  assert.ok(events.includes('ai-accounts:changed'));
});

test('watcher ignores unrelated files', async () => {
  const events = [];
  const poller = { broadcast: (event) => events.push(event) };
  startAiAccountWatcher(poller, { debounceMs: 30 });

  const record = createStoredAccount({ name: '무관 파일', provider: 'codex' });
  await settled();
  const before = events.length;
  writeFileSync(join(record.homePath, 'notes.txt'), 'not a credential');

  await sleep(300);
  assert.equal(events.length, before, 'credential 외 파일은 브로드캐스트하지 않음');
  stopAiAccountWatcher();
});
