import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { rustBuildProfile } from '../tests/helpers/rust-server.js';

const capture = process.argv.includes('--capture');
const rust = process.argv.includes('--rust');
const runtime = rust ? 'rust' : 'node';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const media = fileURLToPath(new URL('../docs/media/', import.meta.url));
const localReports = fileURLToPath(new URL('../docs/_local/', import.meta.url));
let fixture;
let plainFixture;
let browser;
let page;
let result;
let failure;
try {
  fixture = await startPortfolioServer({ runtime });
  const executablePath = process.env.CHROME_BIN || chromium.executablePath();
  assert.ok(existsSync(executablePath), 'Install Chromium: npx playwright-core install chromium (or set CHROME_BIN)');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  if (capture) await mkdir(media, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(capture ? { recordVideo: { dir: join(fixture.directory, 'video'), size: { width: 1440, height: 900 } } } : {}),
  });
  // The sample app uses local assets only; no recording request reaches an external service.
  await context.route('**/*', route => [fixture.url, plainFixture?.url].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('[WS] message handler error')) errors.push(message.text());
  });
  await page.goto(fixture.url);
  await page.evaluate(async () => { window.portfolioApp = (await import('/js/state.js')).app; });
  await page.waitForFunction(() => window.portfolioApp.ws?.readyState === 1);
  const chapter = async text => {
    if (!capture) return;
    await page.evaluate(text => {
      let caption = document.getElementById('portfolio-caption');
      if (!caption) {
        caption = document.createElement('div');
        caption.id = 'portfolio-caption';
        caption.style.cssText = 'position:fixed;bottom:72px;left:50%;transform:translateX(-50%);z-index:99999;background:#10191ff2;color:#f0f6fc;border:1px solid #64748b;padding:16px 24px;border-radius:8px;font:16px/1.7 system-ui;white-space:pre-line;max-width:800px;pointer-events:none;box-shadow:0 8px 32px #0008';
        document.body.append(caption);
      }
      caption.textContent = `공개용 샘플 · 실제 Cockpit 실행\n${text}`;
    }, text);
    await page.waitForTimeout(8000);
  };
  await chapter('1 / 8  여러 프로젝트의 터미널을 한 작업 공간에서 운영합니다.');
  await page.evaluate(async () => {
    const { app } = await import('/js/state.js');
    app.ws.send(JSON.stringify({ type: 'create', projectId: 'sample', cols: 100, rows: 28 }));
    app.ws.send(JSON.stringify({ type: 'create', projectId: 'sample', cols: 100, rows: 28 }));
  });
  await page.waitForFunction(() => window.portfolioApp.termMap.size === 2);
  const ids = await page.evaluate(async () => {
    const { app, pairTerminals, setTerminalGroupLayout } = await import('/js/state.js');
    const { renderLayout, saveLayout } = await import('/js/terminal.js');
    const ids = [...app.termMap.keys()];
    app.termMap.get(ids[0]).label = '검증 · Sample Project';
    app.termMap.get(ids[1]).label = '작업 · Sample Project';
    pairTerminals(...ids);
    setTerminalGroupLayout(ids[0], 'cols');
    renderLayout();
    saveLayout();
    return ids;
  });
  await page.keyboard.press('Alt+1');
  await page.waitForFunction(() => {
    const rects = [...document.querySelectorAll('.xterm-wrap')].map(el => el.getBoundingClientRect());
    return rects.length === 2 && rects.every(r => r.width > 200 && r.x >= 0 && r.right <= innerWidth)
      && (rects[0].right <= rects[1].left || rects[1].right <= rects[0].left);
  });
  await chapter('2 / 8  두 터미널을 그룹으로 묶고 가로로 배치했습니다.');
  const input = async (id, data) => {
    await page.waitForFunction(id => {
      const entry = window.portfolioApp.termMap.get(id);
      return entry?.opened && !entry._replaying;
    }, id);
    await page.evaluate(async ({ id, data }) => {
      const { app } = await import('/js/state.js');
      app.ws.send(JSON.stringify({ type: 'input', termId: id, data }));
    }, { id, data });
  };
  const waitOutput = async (id, text) => page.waitForFunction(({ id, text }) => {
    const entry = window.portfolioApp.termMap.get(id);
    const term = entry?.xterm;
    if (!term) return false;
    const buffer = term.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => {
      const line = buffer.getLine(i);
      return (line?.isWrapped ? '' : '\n') + (line?.translateToString(true) || '');
    }).join('').includes(text);
  }, { id, text });
  await input(ids[0], "export PORTFOLIO_MARKER=survives_restart; cd src; printf '\\nSESSION_READY:%s:%s\\n' \"$PORTFOLIO_MARKER\" \"$PWD\"\r");
  await waitOutput(ids[0], 'SESSION_READY:survives_restart:');
  await input(ids[1], "npm test\r");
  await waitOutput(ids[1], '합계와 빈 목록');
  await input(ids[0], 'clear\rgit status --short\rgit diff --stat\r');
  await waitOutput(ids[0], 'total.js');
  await page.waitForTimeout(800);
  await chapter('3 / 8  왼쪽은 Git 변경, 오른쪽은 샘플 프로젝트의 실제 테스트 결과입니다.');
  await page.screenshot({ path: capture ? join(media, 'terminal-workspace.png') : join(fixture.directory, 'workspace.png'), style: '#portfolio-caption { visibility: hidden; }' });
  const before = await page.evaluate(async () => {
    const { app } = await import('/js/state.js');
    return { pairs: app.terminalPairs, order: app.sessionOrder, layout: app.layoutRoot };
  });
  await chapter('4 / 8  서버를 종료하고 다시 시작합니다. tmux의 셸은 계속 유지됩니다.');
  const restartAt = performance.now();
  await fixture.stop();
  const checkpoint = await fixture.checkpoint();
  assert.equal(checkpoint.terminals.length, 2);
  assert.ok(checkpoint.terminals.every(term => /^[a-f0-9]{24}$/.test(term.durableId)));
  assert.equal(checkpoint.terminals.find(term => term.termId === ids[0]).cwd, join(fixture.project, 'src'));
  await fixture.start();
  await page.reload();
  await page.evaluate(async () => { window.portfolioApp = (await import('/js/state.js')).app; });
  await page.waitForFunction(ids => {
    const app = window.portfolioApp;
    return app.ws?.readyState === 1 && ids.every(id => app.termMap.get(id)?.durable);
  }, ids);
  const after = await page.evaluate(async () => {
    const { app } = await import('/js/state.js');
    return { pairs: app.terminalPairs, order: app.sessionOrder, layout: app.layoutRoot };
  });
  assert.deepEqual(after, before, 'Group, order and split layout survive restart and browser reload');
  // A shell-local variable proves this is the original process, not a new shell at the same path.
  // Check complete values inside the original shell. tmux cursor redraws can
  // split a long path without preserving xterm's wrapped-line metadata.
  // Assemble the short marker at runtime so the echoed command cannot match it.
  await input(ids[0], `if [ "$PORTFOLIO_MARKER" = survives_restart ] && [ "$PWD" = ${shellQuote(join(fixture.project, 'src'))} ]; then printf '\\nRESTORED_%s_%s\\n' STATE OK; else printf '\\nRESTORE_FAILED\\n'; fi\r`);
  await waitOutput(ids[0], '\nRESTORED_STATE_OK');
  const restartMs = Math.round(performance.now() - restartAt);
  await chapter('5 / 8  동일한 셸 변수·작업 경로·터미널 그룹·순서·분할 배치를 검증했습니다.');
  if (capture) await page.screenshot({ path: join(media, 'restored-terminals.png'), style: '#portfolio-caption { visibility: hidden; }' });
  // tmux uses the alternate buffer. Verify ordinary-shell scrollback separately.
  plainFixture = await startPortfolioServer({ durable: false, runtime });
  await page.goto(plainFixture.url);
  await page.evaluate(async () => { window.portfolioApp = (await import('/js/state.js')).app; });
  await page.waitForFunction(() => window.portfolioApp.ws?.readyState === 1);
  await page.evaluate(() => window.portfolioApp.ws.send(JSON.stringify({ type: 'create', projectId: 'sample', cols: 100, rows: 28 })));
  await page.waitForFunction(() => window.portfolioApp.termMap.size === 1);
  const plainId = await page.evaluate(() => [...window.portfolioApp.termMap.keys()][0]);
  await chapter('6 / 8  일반 셸의 스크롤은 별도로 검증합니다. 이 세션은 tmux를 사용하지 않습니다.');
  await input(plainId, 'seq 1 300\r');
  await waitOutput(plainId, '\n300');
  await page.waitForTimeout(500);
  const wrap = page.locator('.xterm-wrap');
  const box = await wrap.boundingBox();
  assert.ok(box?.width > 100 && box.height > 100, 'Scroll target is visible');
  const scrollState = () => wrap.locator('.xterm-viewport').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  const scrollBefore = await scrollState();
  assert.ok(scrollBefore.height > scrollBefore.client, 'Real PTY output fills scrollback');
  await chapter('7 / 8  실제 셸에서 300줄을 출력했습니다. 휠을 올려 이전 출력을 확인합니다.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(400);
  const scrollAfter = await scrollState();
  assert.ok(scrollAfter.top < scrollBefore.top, 'Browser wheel moves ordinary-shell scrollback upward');
  await chapter('8 / 8  복원과 일반 버퍼 휠 검증 완료. 실제 OS 한글 입력기는 별도 수동 검증 대상입니다.');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  result = { checkedAt: new Date().toISOString(), node: process.version, browser: browser.version(),
    terminals: 2, sameShellAndCwd: true, groupOrderAndLayout: true, restartMs, scrollMode: 'ordinary PTY (tmux disabled)',
    scrollBefore: scrollBefore.top, scrollAfter: scrollAfter.top, browserErrors: errors.length,
    note: 'Isolated sample project; one local run, not a performance benchmark. Native OS IME input is not exercised.',
  };
  if (rust) Object.assign(result, { runtime: 'rust', managed: true, productionReady: false });
  if (capture) {
    await writeFile(join(media, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  }
  if (!rust) console.log(JSON.stringify(result, null, 2));
  const video = page.video();
  await context.close();
  if (capture) await video.saveAs(join(media, 'cockpit-demo.webm'));
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) {
    console.error(JSON.stringify(await page.evaluate(() => [...window.portfolioApp.termMap].map(([id, { xterm }]) => ({
      id, cols: xterm.cols, rows: xterm.rows, bufferType: xterm.buffer.active.type, bufferLength: xterm.buffer.active.length,
      lines: Array.from({ length: Math.max(xterm.rows, xterm.buffer.active.length) }, (_, i) => {
        const line = xterm.buffer.active.getLine(i);
        return { i, wrapped: line?.isWrapped, text: line?.translateToString(true) };
      }).slice(-50),
    }))), null, 2));
    // A slow failure screenshot must not replace the original error.
    await page.screenshot({ path: '/tmp/cockpit-portfolio-failure.png', timeout: 5000 }).catch(() => {});
  }
  throw error;
} finally {
  const cleanup = await Promise.allSettled([browser?.close(), plainFixture?.cleanup(), fixture?.cleanup()]);
  const cleanupErrors = cleanup.filter(value => value.status === 'rejected').map(value => value.reason);
  if (rust) {
    const passed = !failure && cleanupErrors.length === 0 && result !== undefined;
    const report = { ...result, checkedAt: new Date().toISOString(), runtime: 'rust', buildProfile: rustBuildProfile, managed: true,
      productionReady: false, status: passed ? 'passed' : 'failed', managedChildrenReaped: passed,
      ...(!passed ? { errors: [failure, ...cleanupErrors].filter(Boolean).map(error => String(error.message || error)) } : {}),
    };
    await mkdir(localReports, { recursive: true });
    await writeFile(join(localReports, 'rust-browser-verification.json'), JSON.stringify(report, null, 2) + '\n');
    if (passed) console.log(JSON.stringify(report, null, 2));
  }
  if (cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors].filter(Boolean), 'Portfolio fixture cleanup failed');
}
