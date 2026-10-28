import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

const output = new URL('../docs/_local/reports-verification/', import.meta.url).pathname;
const viewports = [{ width: 1600, height: 1000 }, { width: 1080, height: 1920 }, { width: 1024, height: 600 }, { width: 390, height: 844 }];
const checks = [], errors = [], external = [], screenshots = [];
const captureScreenshots = !process.argv.includes('--no-capture');
let fixture, browser;
const check = label => checks.push(label);
try {
  await mkdir(output, { recursive: true });
  fixture = await startPortfolioServer({ durable: false, runtime: 'rust' });
  const markdown = join(fixture.project, '보험사_진행_시험.md');
  const html = join(fixture.project, '보고서_시험.html');
  const late = join(fixture.project, '추가_시험.md');
  const committed = join(fixture.project, '저장_완료_시험.md');
  const md = '# 업무 진행 시험 보고\n\n| 작업 | 상태 |\n| --- | --- |\n| 독립 시험 | 완료 |\n\n- 검증 근거 확인\n\n```js\nconst safe = true;\n```\n\n<script>parent.reportInjected=true</script>\n';
  const document = `<!doctype html><html lang="ko"><head><title>HTML 시험</title><style>body{font:16px/1.7 system-ui;padding:24px;color:#26343b}table{border-collapse:collapse;width:100%}td,th{padding:10px;border:1px solid #c7d0d8;text-align:left}</style><meta http-equiv="refresh" content="0;url=https://report-test.invalid/leak"></head><body><h1>HTML 진행 시험</h1><p>공개된 시험 데이터입니다.</p><table><tr><th>업무</th><th>확인</th></tr><tr><td>보고서 미리보기</td><td>시험 완료</td></tr></table><script>parent.reportInjected=true;fetch('/api/report-leak')</script><img src="https://report-test.invalid/private"><iframe src="https://report-test.invalid/frame"></iframe></body></html>`;
  await Promise.all([writeFile(markdown, md), writeFile(html, document), writeFile(late, '# 나중에 등록된 보고서\n새 목록'), writeFile(committed, '# 저장은 완료된 보고서')]);
  async function api(path, method = 'GET', body, headers = {}) {
    const response = await fetch(fixture.url + path, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await api('/api/reports')).data.reports.length, 0);
  const first = await api('/api/reports', 'POST', { path: markdown, title: '생보 진행 시험', session: 'ai7' });
  const second = await api('/api/reports', 'POST', { path: html, title: '전체 진행 시험', session: 'ai6' });
  assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(second.status, 200, JSON.stringify(second.data));
  const duplicate = await api('/api/reports', 'POST', { path: markdown });
  assert.equal(duplicate.data.report.id, first.data.report.id);
  assert.equal(duplicate.data.report.title, '생보 진행 시험');
  assert.equal(duplicate.data.report.session, 'ai7');
  assert.equal((await api('/api/reports')).data.reports.length, 2);
  for (const [path, expected] of [[join(fixture.directory, 'outside.md'), 403], [join(fixture.project, 'missing.md'), 404], [join(fixture.project, 'secret.xlsx'), 400]]) {
    assert.equal((await api('/api/reports', 'POST', { path })).status, expected);
  }
  check('Canonical duplicate registration preserves metadata; invalid, missing and outside paths are rejected');
  const token = (await readFile(join(fixture.directory, 'data/cockpit/.cockpit-token'), 'utf8')).trim();
  const remote = { 'x-forwarded-for': '100.64.2.1', cookie: `cockpit-token=${token}`, origin: fixture.url };
  assert.equal((await api('/api/reports', 'GET', undefined, remote)).status, 200);
  assert.equal((await api('/api/reports', 'POST', { path: late }, remote)).status, 403);
  assert.equal((await api(`/api/reports/${first.data.report.id}`, 'DELETE', undefined, remote)).status, 403);
  check('Authenticated remote viewing works; remote registration and removal are rejected');
  await fixture.stop(); await fixture.start();
  assert.equal((await api('/api/reports')).data.reports.length, 2);
  check('Registered reports survive a native server restart');

  const executablePath = [process.env.CHROME_BIN, chromium.executablePath(), '/home/rst010/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'].find(path => path && existsSync(path));
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  // A fresh private origin avoids cache reuse; Playwright's service-worker
  // blocker itself throws inside the deliberately opaque preview frames.
  const page = await browser.newPage({ viewport: viewports[0] });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  async function until(predicate, label) {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
      await page.waitForTimeout(20);
    }
  }
  let holdMarkdown = false, releaseMarkdown, markdownPending = false;
  let holdList = false, releaseList, listPending = false, failList = false;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.url) { external.push(url.origin + url.pathname); return route.abort(); }
    if (url.pathname === '/api/report-leak') { errors.push('Report reached parent API'); return route.abort(); }
    if (url.pathname === '/api/file' && url.searchParams.get('path') === markdown && holdMarkdown) {
      holdMarkdown = false; const response = await route.fetch(); markdownPending = true;
      await new Promise(resolve => { releaseMarkdown = resolve; });
      return route.fulfill({ response });
    }
    if (url.pathname === '/api/reports' && route.request().method() === 'GET') {
      if (failList) { failList = false; return route.fulfill({ status: 500, json: { error: '시험 저장소 오류' } }); }
      if (holdList) {
        holdList = false; const response = await route.fetch(); listPending = true;
        await new Promise(resolve => { releaseList = resolve; });
        return route.fulfill({ response });
      }
    }
    return route.continue();
  });
  await page.routeWebSocket('**/*', socket => {
    socket.send(JSON.stringify({ type: 'terminals', terminals: [] }));
    socket.onMessage(message => {
      const value = JSON.parse(String(message));
      if (!['ping', 'resize', 'focus'].includes(value.type)) errors.push(`Unexpected PTY mutation: ${value.type}`);
    });
  });
  await page.goto(fixture.url);
  async function openTab() {
    const tab = page.locator('.nav-tab[data-view="reports"]');
    if (await tab.isVisible()) await tab.click();
    else { await page.locator('#nav-more-btn').click(); await page.locator('#nav-more-menu [data-view="reports"]').click(); }
    await page.locator('#reports-view.active').waitFor();
  }
  await openTab();
  const root = page.locator('#reports-view');
  const navToggle = page.locator('[data-action="toggle-nav-rail"]');
  await root.locator('[data-report-select]').first().waitFor();
  await root.locator('[data-report-search]').fill('ai7');
  assert.equal(await root.locator('[data-report-select]').count(), 1);
  await root.locator('[data-report-search]').fill('');
  await root.locator('[data-report-kind]').selectOption('html');
  assert.equal(await root.locator('[data-report-select]').count(), 1);
  await root.locator('[data-report-kind]').selectOption('');
  await root.locator(`[data-report-select="${first.data.report.id}"]`).click();
  await page.frameLocator('[data-report-preview] iframe').getByRole('heading', { name: '업무 진행 시험 보고' }).waitFor();
  assert.equal(await page.frameLocator('[data-report-preview] iframe').locator('table').count(), 1);
  assert.equal(await page.evaluate(() => Boolean(window.reportInjected)), false);
  assert.equal(await root.locator('[data-report-preview] iframe').getAttribute('sandbox'), '');
  check('Report search, format filter and Markdown tables render in an isolated preview');
  await root.locator(`[data-report-select="${second.data.report.id}"]`).click();
  await page.frameLocator('[data-report-preview] iframe').getByRole('heading', { name: 'HTML 진행 시험' }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => Boolean(window.reportInjected)), false);
  assert.equal(external.length, 0, 'Report scripts, remote assets and automatic refresh cannot make requests');
  check('HTML scripts, parent access, external resources and automatic refresh are blocked');
  const downloadEvent = page.waitForEvent('download');
  await root.locator('[data-report-download]').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), '보고서_시험.html');
  check('The selected source can be downloaded under its filename');

  const libraryToggle = root.locator('[data-report-toggle-library]');
  await root.locator('[data-report-search]').fill('ai6');
  const frameBeforeCollapse = await root.locator('[data-report-preview] iframe').elementHandle();
  await libraryToggle.click();
  assert.equal(await libraryToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await root.locator('.report-library').isVisible(), false);
  assert.equal(await root.locator('[data-report-registration]').isVisible(), false);
  assert.equal(await frameBeforeCollapse.evaluate(frame => frame === document.querySelector('[data-report-preview] iframe')), true);
  assert.equal(await page.evaluate(() => document.fullscreenElement), null);
  await libraryToggle.click();
  assert.equal(await libraryToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await root.locator('[data-report-search]').inputValue(), 'ai6');
  assert.equal(await root.locator('[data-report-select]').count(), 1);
  await root.locator('[data-report-search]').fill('');
  check('The library can close and reopen without fullscreen, losing filters or reloading the preview');
  await libraryToggle.click();
  await root.locator('[data-report-add]').first().click();
  assert.equal(await root.locator('.report-library').isVisible(), true);
  assert.equal(await root.locator('[data-report-registration]').isVisible(), true);
  assert.equal(await root.locator('[data-report-registration]').getAttribute('open'), '');
  assert.equal(await root.locator('[name="path"]').evaluate(field => field === document.activeElement), true);
  check('Registration restores its visible region and keyboard focus from the wider reading view');

  holdMarkdown = true;
  await root.locator(`[data-report-select="${first.data.report.id}"]`).click();
  await until(() => markdownPending, 'Delayed Markdown request');
  await root.locator(`[data-report-select="${second.data.report.id}"]`).click();
  await page.frameLocator('[data-report-preview] iframe').getByRole('heading', { name: 'HTML 진행 시험' }).waitFor();
  releaseMarkdown(); await page.waitForTimeout(150);
  await page.frameLocator('[data-report-preview] iframe').getByRole('heading', { name: 'HTML 진행 시험' }).waitFor();
  check('A delayed response cannot replace a more recently selected preview');

  await root.locator('[data-report-add]').first().click();
  await root.locator('[name="path"]').fill(join(fixture.project, 'missing.md'));
  await root.locator('[name="title"]').fill('실패 후 보존할 입력');
  await root.locator('button[type="submit"]').click();
  await root.locator('[data-report-register-status]').filter({ hasText: '등록하지 못했습니다' }).waitFor();
  assert.equal(await root.locator('[name="title"]').inputValue(), '실패 후 보존할 입력');
  check('A failed registration retains the form for correction');
  holdList = true;
  await root.locator('[data-report-refresh]').click();
  await until(() => listPending, 'Delayed report list');
  await root.locator('[name="path"]').fill(late);
  await root.locator('[name="title"]').fill('새 보고서 시험');
  await root.locator('button[type="submit"]').click();
  await root.getByRole('button', { name: /새 보고서 시험/ }).waitFor();
  releaseList(); await page.waitForTimeout(150);
  assert.equal(await root.locator('[data-report-select]').count(), 3);
  check('A stale list response cannot erase a newly registered report');
  await root.locator('[data-report-add]').first().click();
  await root.locator('[name="path"]').fill(committed);
  await root.locator('[name="title"]').fill('재조회 실패 시험');
  failList = true;
  await root.locator('button[type="submit"]').click();
  await root.locator('[data-report-status][data-error="true"]').filter({ hasText: '등록은 저장됐습니다' }).waitFor();
  await root.getByRole('button', { name: /재조회 실패 시험/ }).waitFor();
  await page.frameLocator('[data-report-preview] iframe').getByRole('heading', { name: '저장은 완료된 보고서' }).waitFor();
  assert.equal((await api('/api/reports')).data.reports.length, 4);
  check('Registration remains visible and its refresh error stays explicit after a committed write');
  failList = true;
  await libraryToggle.click();
  assert.equal(await root.getByRole('button', { name: '목록에서 삭제', exact: true }).isVisible(), true);
  await root.locator('[data-report-remove]').click();
  await root.locator('[data-report-status][data-error="true"]').filter({ hasText: '목록 제거는 저장됐습니다' }).waitFor();
  assert.equal(await root.getByRole('button', { name: /재조회 실패 시험/ }).count(), 0);
  assert.equal(await readFile(committed, 'utf8'), '# 저장은 완료된 보고서');
  assert.equal((await api('/api/reports')).data.reports.length, 3);
  assert.equal(await libraryToggle.evaluate(button => button === document.activeElement), true);
  await libraryToggle.click();
  check('Removal stays reflected after a committed delete followed by a list error; the source remains');
  failList = true;
  await root.locator('[data-report-refresh]').click();
  await root.locator('[data-report-status]').filter({ hasText: '시험 저장소 오류' }).waitFor();
  assert.equal(await root.locator('[data-report-select]').count(), 3);
  await root.locator('[data-report-refresh]').click();
  await root.locator('[data-report-status]').filter({ hasText: '원본 파일 기준' }).waitFor();
  check('A list error preserves the visible reports and can be retried');
  await writeFile(markdown, md + '\n## 새로 추가한 검증\n갱신된 원본\n');
  await root.locator(`[data-report-select="${first.data.report.id}"]`).click();
  await page.frameLocator('[data-report-preview] iframe').getByRole('heading', { name: '새로 추가한 검증' }).waitFor();
  check('The preview reads the latest source file rather than a saved content copy');

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    if (viewport.width > 600 && await navToggle.getAttribute('aria-expanded') === 'false') await navToggle.click();
    await root.locator(`[data-report-select="${first.data.report.id}"]`).click();
    await page.frameLocator('[data-report-preview] iframe').getByRole('heading', { name: '업무 진행 시험 보고' }).waitFor();
    const clipping = await root.evaluate(element => [element, ...element.querySelectorAll('.reports-head,.reports-layout,.report-library,.report-detail,.report-detail-head,.report-detail-actions,.report-filters')]
      .filter(item => item.scrollWidth > item.clientWidth + 1).map(item => ({ name: item.className, width: item.clientWidth, content: item.scrollWidth })));
    assert.deepEqual(clipping, [], `No clipped controls at ${viewport.width}×${viewport.height}`);
    for (const control of await root.locator('button:visible,input:visible,select:visible').all()) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      assert(box && box.width >= 44 && box.height >= 44, 'Controls retain usable hit areas');
    }
    await root.locator('[data-report-detail]').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const path = join(output, `${viewport.width}x${viewport.height}.png`);
    if (captureScreenshots) { await page.screenshot({ path }); screenshots.push(path); }
    await libraryToggle.click();
    const width = await root.locator('.reports-layout').boundingBox();
    const detail = await root.locator('[data-report-detail]').boundingBox();
    assert(width && detail && Math.abs(width.width - detail.width) <= 1, 'The preview uses the whole report region with the library closed');
    assert.equal(await root.locator('.report-library').isVisible(), false);
    const collapsedClipping = await root.evaluate(element => [element, ...element.querySelectorAll('.reports-head,.reports-layout,.report-detail,.report-detail-head,.report-detail-actions')]
      .filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.className));
    assert.deepEqual(collapsedClipping, [], 'The wider reading view keeps its controls within the viewport');
    await root.locator('[data-report-detail]').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    if (viewport.width > 600) {
      const appBefore = await page.locator('.app').boundingBox();
      const frame = await root.locator('[data-report-preview] iframe').elementHandle();
      await navToggle.focus(); await page.keyboard.press('Enter');
      assert.equal(await navToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#cockpit-navigation').isVisible(), false);
      assert.equal(await page.locator('.header-right').isVisible(), true);
      const appAfter = await page.locator('.app').boundingBox();
      assert(appBefore && appAfter && Math.abs(appAfter.width - appBefore.width - 68) <= 1, 'Closing the app rail adds its 68px to the working surface');
      assert.equal(appAfter.x, 0);
      assert.equal(await frame.evaluate(element => element === document.querySelector('[data-report-preview] iframe')), true);
      const button = await navToggle.boundingBox();
      assert(button && button.width >= 44 && button.height >= 44 && button.x >= 0 && button.y >= 0 && button.x + button.width <= viewport.width, `The restore control stays reachable: ${JSON.stringify({ button, viewport })}`);
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('#cockpit-navigation'))), false);
      }
    } else {
      assert.equal(await navToggle.isVisible(), false);
      assert.equal(await page.locator('#cockpit-navigation').isVisible(), true);
      assert.equal(await page.locator('#nav-more-btn').isVisible(), true);
    }
    const collapsedPath = join(output, `${viewport.width}x${viewport.height}-reading.png`);
    if (captureScreenshots) { await page.screenshot({ path: collapsedPath }); screenshots.push(collapsedPath); }
    await libraryToggle.click();
  }
  check('Desktop, portrait, short desktop and mobile layouts keep controls reachable with the library open or closed');
  check('The app rail closes independently, adds 68px, preserves the preview and keeps restoration reachable; mobile navigation stays available');
  await page.setViewportSize(viewports[0]);
  await root.locator(`[data-report-select="${second.data.report.id}"]`).click();
  await rm(html);
  await root.locator('[data-report-refresh]').click();
  await root.getByRole('alert').filter({ hasText: '보고서를 열지 못했습니다' }).waitFor();
  assert.equal(await root.locator('[data-report-download]').isDisabled(), true);
  await root.locator('[data-report-remove]').click();
  await root.locator('[data-report-status]').filter({ hasText: '원본 파일은 그대로' }).waitFor();
  await root.locator(`[data-report-select="${first.data.report.id}"]`).click();
  await root.locator('[data-report-remove]').click();
  await root.locator('[data-report-status]').filter({ hasText: '원본 파일은 그대로' }).waitFor();
  assert.equal(await readFile(markdown, 'utf8'), md + '\n## 새로 추가한 검증\n갱신된 원본\n');
  check('Missing files have a clear retry state; removing a report never deletes its source');
  assert.equal(await navToggle.getAttribute('aria-expanded'), 'false');
  await page.reload();
  await navToggle.locator('visible=true').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-action="toggle-nav-rail"]')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await navToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#cockpit-navigation').isVisible(), false);
  for (const width of [600, 601, 600, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.locator('#cockpit-navigation').isVisible(), width <= 600);
    assert.equal(await navToggle.isVisible(), width > 600);
  }
  await navToggle.click();
  assert.equal(await navToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#cockpit-navigation').isVisible(), true);
  await page.locator('.nav-tab[data-view="reports"]').click();
  await root.locator('[data-report-select]').first().waitFor();
  check('The app rail preference survives reload and breakpoint changes; restoring navigation still reaches the report tab');
  await page.locator('.nav-tab[data-view="terminal"]').click();
  await page.locator('#terminal-view.active').waitFor();
  await navToggle.click();
  const wideTerminal = await page.locator('#terminal-view').boundingBox();
  assert(wideTerminal && wideTerminal.x === 0 && Math.abs(wideTerminal.width - 1024) <= 1, 'The terminal working surface also uses the reclaimed rail space');
  await navToggle.click();
  const restoredTerminal = await page.locator('#terminal-view').boundingBox();
  assert(restoredTerminal && restoredTerminal.x === 68 && Math.abs(restoredTerminal.width - 956) <= 1, 'Restoring the rail also restores the terminal geometry');
  check('The terminal working surface responds to the global rail toggle without session creation or input');
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), status: 'passed', runtime: 'rust', checks, viewports, screenshots, screenshotsCaptured: captureScreenshots, browserErrors: errors, externalRequests: external };
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await fixture?.cleanup();
}
