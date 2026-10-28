import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../skills/cockpit-report/scripts/register.py', import.meta.url));
const report = { id: 'fixture-report', path: '/project/한글 공백/quote\'&$(never).md', title: '진행 보고서', session: 'ai7' };

async function fixture(t, handle) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    handle(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const run = async (extra = {}) => {
    try {
      const result = await promisify(execFile)('/usr/bin/python3', [script, report.path, '--title', report.title, '--session', report.session],
        { env: { ...process.env, COCKPIT_URL: `http://127.0.0.1:${server.address().port}`, ...extra } });
      return { code: 0, data: JSON.parse(result.stdout) };
    } catch (error) { return { code: error.code, data: JSON.parse(error.stdout) }; }
  };
  return { run, requests };
}

test('report registration preserves the exact path and verifies the saved entry without a proxy', async t => {
  const { run, requests } = await fixture(t, (req, res) => res.end(JSON.stringify(req.method === 'POST' ? { report } : { reports: [report] })));
  const result = await run({ http_proxy: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', no_proxy: '', NO_PROXY: '' });
  assert.equal(result.code, 0); assert.equal(result.data.ok, true);
  assert.deepEqual(requests, [{ method: 'POST', path: '/api/reports', body: { path: report.path, title: report.title, session: report.session } },
    { method: 'GET', path: '/api/reports', body: null }]);
});

test('report registration rejects server errors without a retry or success claim', async t => {
  const { run, requests } = await fixture(t, (req, res) => { res.statusCode = 403; res.end(JSON.stringify({ error: '프로젝트 밖 경로' })); });
  const result = await run();
  assert.equal(result.code, 1); assert.equal(result.data.ok, false); assert.equal(result.data.error, '프로젝트 밖 경로');
  assert.equal(requests.length, 1);
});

test('a saved report with failed verification remains a separate incomplete result', async t => {
  const { run, requests } = await fixture(t, (req, res) => {
    if (req.method === 'POST') res.end(JSON.stringify({ report }));
    else { res.statusCode = 500; res.end(JSON.stringify({ error: '목록 조회 실패' })); }
  });
  const result = await run();
  assert.equal(result.code, 1); assert.equal(result.data.ok, false); assert.equal(result.data.registered, true);
  assert.deepEqual(result.data.report, report); assert.equal(requests.length, 2);
});

test('report registration refuses a remote server before sending file metadata', async t => {
  const { run, requests } = await fixture(t, (req, res) => res.end('{}'));
  const result = await run({ COCKPIT_URL: 'http://example.com' });
  assert.equal(result.code, 1); assert.equal(result.data.ok, false); assert.equal(requests.length, 0);
});

test('report registration does not follow redirects to another endpoint', async t => {
  const { run, requests } = await fixture(t, (req, res) => { res.statusCode = 307; res.setHeader('location', '/unexpected'); res.end('{}'); });
  const result = await run();
  assert.equal(result.code, 1); assert.equal(result.data.ok, false); assert.equal(requests.length, 1);
});
