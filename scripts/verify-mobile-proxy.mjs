import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

// Private fixture only. Tokens stay in memory and are never printed.
const fixture = await startPortfolioServer({ durable: false });
try {
  const { token } = await (await fetch(fixture.url + '/api/lan-info')).json();
  const forwarded = { 'x-forwarded-for': '100.89.45.86' };
  const anonymous = await fetch(fixture.url + '/api/terminals', { headers: forwarded });
  assert.match(anonymous.headers.get('content-type'), /text\/html/);
  assert.doesNotMatch(await anonymous.text(), /"terminals"\s*:/);
  const login = await fetch(fixture.url + '/?token=' + encodeURIComponent(token), { headers: forwarded });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { ...forwarded, cookie };
  const authenticated = await fetch(fixture.url + '/api/terminals', { headers });
  assert.equal(authenticated.status, 200);
  assert.ok(Array.isArray((await authenticated.json()).terminals));
  assert.equal((await fetch(fixture.url + '/api/lan-info', { headers })).status, 403,
    'authenticated proxy users still cannot use local-only CLI endpoints');
  const wsUrl = fixture.url.replace('http:', 'ws:');
  const denied = new WebSocket(wsUrl, { headers: forwarded });
  const rejected = await new Promise((resolve, reject) => {
    denied.on('unexpected-response', (_req, response) => { response.resume(); denied.terminate(); resolve(response.statusCode); });
    denied.on('open', () => { denied.close(); reject(new Error('anonymous WebSocket accepted')); });
    denied.on('error', () => {});
  });
  assert.equal(rejected, 401);
  const accepted = new WebSocket(wsUrl, { headers });
  await once(accepted, 'open'); accepted.close(); await once(accepted, 'close');
  console.log('PASS: proxied HTTP login, cookie, anonymous WS denied, authenticated WS accepted, local-only API protected');
} finally { await fixture.cleanup(); }
