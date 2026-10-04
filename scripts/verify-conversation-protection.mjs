// Isolated shells only: never reads or writes live AI terminals.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

const fixture = await startPortfolioServer();
const run = promisify(execFile);
let browser, socket;
const api = async (path, method = 'GET', body) => {
  const response = await fetch(fixture.url + path, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
const until = async check => {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for fixture state');
};
try {
  socket = new WebSocket(fixture.url.replace('http:', 'ws:'));
  await once(socket, 'open');
  const create = () => new Promise(resolve => {
    const listener = raw => { const msg = JSON.parse(raw); if (msg.type === 'created') { socket.off('message', listener); resolve(msg.termId); } };
    socket.on('message', listener);
    socket.send(JSON.stringify({ type: 'create', projectId: 'sample', command: '', cols: 100, rows: 30 }));
  });
  const termId = await create();
  const other = await create();
  const endpoint = `/api/terminals/${termId}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/home/rst010/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.querySelector('.session-conversation button:not(:disabled)'));
  await page.locator(`[data-action="canvas-jump"][data-termid="${termId}"]`).click();
  const control = page.locator(`[data-canvas-frame="${termId}"] .session-conversation`);
  await control.locator('button').click();
  await until(async () => (await api('/api/terminals')).body.terminals.find(t => t.termId === termId)?.conversationHeld);
  await page.waitForFunction(id => document.querySelector(`[data-canvas-frame="${id}"] .session-conversation button`)?.textContent === '대화 끝 · 재개', termId);
  for (const body of [{ data: 'unwanted message' }, { data: '\r', enter: false }]) {
    const result = await api(endpoint + '/input', 'POST', body);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'CONVERSATION_HELD');
  }
  socket.send(JSON.stringify({ type: 'input', termId, data: `printf ok > '${fixture.directory}/user-input.txt'\r` }));
  await until(async () => (await readFile(`${fixture.directory}/user-input.txt`, 'utf8').catch(() => '')) === 'ok');
  assert.equal((await api(`/api/terminals/${other}/input`, 'POST', { data: `printf ok > '${fixture.directory}/peer-input.txt'` })).status, 200);
  await until(async () => (await readFile(`${fixture.directory}/peer-input.txt`, 'utf8').catch(() => '')) === 'ok');
  assert.equal((await fixture.checkpoint()).terminals.find(t => t.termId === termId).conversationHeld, true);
  await page.screenshot({ path: '/tmp/cockpit-conversation-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.mobile-leaf .session-conversation'));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/cockpit-conversation-mobile.png' });
  socket.close();
  await fixture.stop();
  await fixture.start();
  await page.reload();
  await until(async () => (await api('/api/terminals')).body.terminals.some(t => t.termId === termId && t.conversationHeld));
  assert.equal((await api(endpoint + '/input', 'POST', { data: 'still blocked' })).status, 409);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(`[data-action="canvas-jump"][data-termid="${termId}"]`).click();
  await control.locator('button').focus();
  await page.keyboard.press('Enter');
  await until(async () => !(await api('/api/terminals')).body.terminals.find(t => t.termId === termId)?.conversationHeld);
  assert.equal((await api(endpoint + '/input', 'POST', { data: `printf ok > '${fixture.directory}/resumed.txt'` })).status, 200);
  await until(async () => (await readFile(`${fixture.directory}/resumed.txt`, 'utf8').catch(() => '')) === 'ok');
  const cli = fileURLToPath(new URL('./cockpit-session.mjs', import.meta.url));
  await run(process.execPath, [cli, 'conversation', termId, 'on'], { env: { ...fixture.env, COCKPIT_URL: fixture.url } });
  assert.match((await run(process.execPath, [cli, 'list'], { env: { ...fixture.env, COCKPIT_URL: fixture.url } })).stdout, /사용자 대화 보호 중/);
  await run(process.execPath, [cli, 'conversation', termId, 'off'], { env: { ...fixture.env, COCKPIT_URL: fixture.url } });
  assert.deepEqual(errors, []);
  console.log('PASS: peer and key rejection, user input preserved, independent worker, durable restart, keyboard release, CLI, desktop/mobile');
} finally {
  socket?.close();
  await browser?.close();
  await fixture.cleanup();
}
