import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { rustBuildProfile } from '../tests/helpers/rust-server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.argv.includes('--rust') ? 'rust' : 'node';
let fixture, browser, failure, blockedCheckpoint;
const errors = [];
const checks = [];
try {
  fixture = await startPortfolioServer({ runtime });
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1080, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('[WS] message handler error')) errors.push(message.text()); });
  await page.goto(fixture.url);
  await page.evaluate(async () => {
    window.closeApp = (await import('/js/state.js')).app;
    window.closeCore = await import('/js/terminal.js');
    window.closeReceipts = [];
  });
  await page.waitForFunction(() => window.closeApp.ws?.readyState === 1);
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) window.closeApp.ws.send(JSON.stringify({ type: 'create', projectId: 'sample', cols: 100, rows: 24 }));
  });
  await page.waitForFunction(() => window.closeApp.termMap.size === 2);
  const ids = await page.evaluate(() => [...window.closeApp.termMap.keys()]);
  const terminals = async () => (await fetch(fixture.url + '/api/terminals').then(response => response.json())).terminals;

  const offline = await page.evaluate(id => {
    window.closeApp.ws.close();
    return { accepted: window.closeCore.closeTerminal(id), retained: window.closeApp.termMap.has(id) };
  }, ids[0]);
  assert.deepEqual(offline, { accepted: false, retained: true });
  assert.ok((await terminals()).some(item => item.termId === ids[0]));
  await page.waitForFunction(() => window.closeApp.ws?.readyState === 1);
  assert.ok(await page.evaluate(id => window.closeApp.termMap.has(id), ids[0]));
  checks.push('Disconnected close retains the visible terminal and never pretends to stop it');

  const reordered = await page.evaluate(id => {
    const ws = window.closeApp.ws;
    if (!ws.closeReceiptsSupported) throw new Error('Server did not advertise close receipts');
    const send = ws.send;
    ws.send = () => {};
    try { window.closeCore.closeTerminal(id); } finally { ws.send = send; }
    ws.onmessage({ data: JSON.stringify({ type: 'exit', termId: id, exitCode: 0 }) });
    const retainedAfterExit = window.closeApp.termMap.has(id);
    ws.onmessage({ data: JSON.stringify({ type: 'kill-result', termId: id, accepted: false, error: 'Fixture close denied' }) });
    return { retainedAfterExit, retainedAfterDenial: window.closeApp.termMap.has(id) };
  }, ids[0]);
  assert.deepEqual(reordered, { retainedAfterExit: true, retainedAfterDenial: true });
  checks.push('A natural exit arriving before a rejected close receipt cannot erase the retry target');

  await page.evaluate(() => {
    window.closeApp.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'kill-result') window.closeReceipts.push(message);
    });
  });
  const checkpoint = join(fixture.directory, 'data/cockpit/session-state.json');
  const backup = checkpoint + '.close-test';
  await rename(checkpoint, backup);
  await mkdir(checkpoint);
  blockedCheckpoint = { checkpoint, backup };
  const queued = await page.evaluate(id => {
    const ws = window.closeApp.ws;
    const original = ws.send.bind(ws);
    let requests = 0;
    ws.send = text => { if (JSON.parse(text).type === 'kill') requests++; original(text); };
    try {
      const accepted = window.closeCore.closeTerminal(id);
      window.closeCore.closeTerminal(id);
      return { accepted, retained: window.closeApp.termMap.has(id), requests };
    } finally { ws.send = original; }
  }, ids[0]);
  assert.deepEqual(queued, { accepted: true, retained: true, requests: 1 });
  await page.waitForFunction(id => window.closeReceipts.some(message => message.termId === id && message.accepted === false), ids[0]);
  assert.ok(await page.evaluate(id => window.closeApp.termMap.has(id), ids[0]));
  checks.push('Pending close stays visible; duplicate close sends one request; persistence failure is rejected');
  await rmdir(checkpoint);
  await rename(backup, checkpoint);
  blockedCheckpoint = null;

  await page.evaluate(id => window.closeCore.closeTerminal(id), ids[0]);
  await page.waitForFunction(id => !window.closeApp.termMap.has(id), ids[0]);
  await page.waitForFunction(id => window.closeReceipts.some(message => message.termId === id && message.accepted === true), ids[0]);
  assert.ok(!(await terminals()).some(item => item.termId === ids[0]));
  assert.ok(!JSON.parse(await readFile(checkpoint, 'utf8')).terminals.some(item => item.termId === ids[0]));
  checks.push('Confirmed retry removes the terminal from the UI, server and restart checkpoint');

  await page.evaluate(id => window.closeApp.ws.send(JSON.stringify({ type: 'input', termId: id, data: 'exit\r' })), ids[1]);
  await page.waitForFunction(id => window.closeApp.termMap.get(id)?.exited === true, ids[1]);
  assert.ok(await page.evaluate(id => window.closeApp.termMap.has(id), ids[1]));
  await page.evaluate(id => window.closeCore.closeTerminal(id), ids[1]);
  await page.waitForFunction(id => !window.closeApp.termMap.has(id), ids[1]);
  checks.push('Natural exit remains visible until explicitly closed; closing an absent process is acknowledged');

  await fixture.stop();
  await fixture.start();
  await page.reload();
  await page.evaluate(async () => { window.closeApp = (await import('/js/state.js')).app; });
  await page.waitForFunction(() => window.closeApp.ws?.readyState === 1);
  assert.equal((await terminals()).length, 0);
  assert.equal(await page.evaluate(() => window.closeApp.termMap.size), 0);
  checks.push('Confirmed closed terminals stay absent after server restart and browser reload');
  assert.deepEqual(errors, []);
} catch (error) { failure = error; }
finally {
  for (const cleanup of [
    async () => { if (blockedCheckpoint) { await rmdir(blockedCheckpoint.checkpoint); await rename(blockedCheckpoint.backup, blockedCheckpoint.checkpoint); } },
    async () => { await browser?.close(); },
    async () => { await fixture?.cleanup(); },
  ]) {
    try { await cleanup(); } catch (error) { failure ||= error; }
  }
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  const report = { checkedAt: new Date().toISOString(), runtime, ...(runtime === 'rust' ? { buildProfile: rustBuildProfile } : {}), status: failure ? 'failed' : 'passed', checks, browserErrors: errors, cleanupVerified: !failure,
    ...(failure ? { error: failure.stack } : {}) };
  await writeFile(join(root, `docs/_local/${runtime}-terminal-close-verification.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
if (failure) process.exitCode = 1;
