import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('peer read --new reports live capture loss and recovery even when the text is unchanged', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'cockpit-peer-read-'));
  let current = true;
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push([req.method, url.pathname, url.searchParams.get('current')]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(url.pathname === '/api/terminals'
      ? { terminals: [{ termId: 'fixture-peer', alias: 'ai-fixture' }] }
      : { alias: 'ai-fixture', current, lines: ['41…'], truncated: false }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(cache, { recursive: true, force: true }); });
  const read = async () => (await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../scripts/cockpit-session.mjs', import.meta.url)), 'read', 'ai-fixture', '8', '--new'],
    { env: { ...process.env, COCKPIT_URL: `http://127.0.0.1:${server.address().port}`, COCKPIT_SESSION_STATE_DIR: cache, COCKPIT_TERM_ID: 'fixture-reader' } })).stdout;
  assert.match(await read(), /현재 화면 \(/);
  assert.match(await read(), /변화 없음/);
  current = false;
  assert.match(await read(), /현재 화면 확인 실패/);
  assert.match(await read(), /현재 화면 확인 실패/);
  current = true;
  assert.match(await read(), /현재 화면 \(/);
  assert.ok(requests.every(([method, path, flag]) => method === 'GET' && (path === '/api/terminals' || flag === '1')));
});
