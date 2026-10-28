import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

// Isolated sample sessions: no input or resize reaches the user's terminals.
const fixture = await startPortfolioServer({ durable: false });
let browser;
try {
  const executablePath = [chromium.executablePath(), '/home/rst010/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  let states = ['busy', 'idle'], stale = false, unavailable = false;
  await page.route('**/api/terminals?activity=1', async route => {
    if (unavailable) return route.abort();
    const response = await route.fetch();
    const body = await response.json();
    body.terminals.forEach((term, index) => { term.activity = { agent: 'jcode', state: states[index], observedAt: Date.now() - (stale ? 20000 : 0) }; });
    await route.fulfill({ json: body });
  });
  await page.goto(fixture.url);
  await page.evaluate(async () => { window.testApp = (await import('/js/state.js')).app; });
  await page.waitForFunction(() => window.testApp.ws?.readyState === 1);
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) window.testApp.ws.send(JSON.stringify({ type: 'create', projectId: 'sample', cols: 100, rows: 28 }));
  });
  await page.waitForFunction(() => window.testApp.termMap.size === 2);
  const ids = await page.evaluate(async () => {
    // Deliberately wrong shared project state reproduces the original bug.
    window.testApp.state.projects.set('sample', { session: { state: 'waiting' } });
    const { renderLayout } = await import('/js/terminal.js');
    renderLayout();
    return [...window.testApp.termMap.keys()];
  });
  await page.waitForSelector('[data-canvas-frame]');
  async function check(expected, label) {
    for (let i = 0; i < ids.length; i++) {
      const frame = page.locator(`[data-canvas-frame="${ids[i]}"] .canvas-frame-signal`);
      await page.waitForFunction(({ id, state }) => document.querySelector(`[data-canvas-frame="${id}"] .canvas-frame-signal`)?.classList.contains(state), { id: ids[i], state: expected[i] });
      assert.equal(await frame.getAttribute('title'), label[i]);
      assert.equal(await page.locator(`.mob-tab[data-termid="${ids[i]}"] .mob-tab-signal`).getAttribute('title'), label[i]);
      await page.waitForFunction(({ id, text }) => document.querySelector(`[data-session-order-row="${id}"] .canvas-session-meta`)?.textContent.includes(text), { id: ids[i], text: label[i] }, { timeout: 10000 });
      if (['busy', 'idle', 'waiting'].includes(expected[i])) {
        const colors = await page.evaluate(({ id, state }) => {
          const reference = document.createElement('span');
          reference.style.backgroundColor = state === 'busy' ? 'var(--green)' : 'var(--yellow)';
          document.body.append(reference);
          const expectedColor = getComputedStyle(reference).backgroundColor;
          reference.remove();
          const actual = [`.canvas-frame-signal`, `.mob-tab-signal`, `.canvas-session-dot`].map((signal, index) => {
            const parent = [`[data-canvas-frame="${id}"]`, `.mob-tab[data-termid="${id}"]`, `[data-session-order-row="${id}"]`][index];
            return getComputedStyle(document.querySelector(`${parent} ${signal}`)).backgroundColor;
          });
          return { expectedColor, actual };
        }, { id: ids[i], state: expected[i] });
        assert.deepEqual(colors.actual, Array(3).fill(colors.expectedColor));
      }
    }
  }
  await check(['busy', 'idle'], ['실행 중', '입력 대기']);
  states = ['idle', 'approval'];
  await check(['idle', 'waiting'], ['입력 대기', '승인·로그인 대기']);
  stale = true;
  await check(['unknown', 'unknown'], ['관측 오래됨 · 연결 확인', '관측 오래됨 · 연결 확인']);
  stale = false; states = ['busy', 'idle'];
  await check(['busy', 'idle'], ['실행 중', '입력 대기']);
  unavailable = true;
  await check(['unknown', 'unknown'], ['관측 오래됨 · 연결 확인', '관측 오래됨 · 연결 확인']);
  unavailable = false;
  await check(['busy', 'idle'], ['실행 중', '입력 대기']);
  const output = new URL('../docs/_local/session-signals/', import.meta.url).pathname;
  await mkdir(output, { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1080, height: 1920 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: `${output}${viewport.width}x${viewport.height}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, transitions: 'busy → idle; approval; stale; disconnect; reconnect', surfaces: ['frame', 'session tab', 'session list'], screenshots: output }));
} finally {
  await browser?.close();
  await fixture.cleanup();
}
