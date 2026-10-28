import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createBoardService } from '../lib/board-service.js';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';

const native = process.argv.includes('--rust');
const selected = process.argv.slice(2).find(value => !value.startsWith('--'));
const output = new URL(`../docs/_local/work-overview/${native ? 'rust-portrait' : 'portrait'}/`, import.meta.url).pathname;
const cases = [
  { name: '1080x1920', width: 1080, height: 1920 },
  { name: '900x1600', width: 900, height: 1600 },
  { name: '1080-at-125-percent-equivalent', width: 864, height: 1536 },
  { name: '1080-at-150-percent-equivalent', width: 720, height: 1280 },
  { name: '1080-at-200-percent-equivalent', width: 540, height: 960 },
  { name: 'split-boundary-1001', width: 1001, height: 1200 },
  { name: 'split-boundary-1000', width: 1000, height: 1200 },
  { name: 'mobile-boundary-601', width: 601, height: 1000 },
  { name: 'mobile-boundary-600', width: 600, height: 1000 },
  { name: 'short-window-1280x720', width: 1280, height: 720 },
].filter(size => !selected || size.name === selected);
let browser, runtime, fixture, failure;
const results = [], errors = [];
try {
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/results.json`, JSON.stringify({ status: 'running', runtime: native ? 'rust' : 'node', results: [] }));
  fixture = await startPortfolioServer({ durable: false });
  let url = fixture.url;
  let boardFile = `${fixture.directory}/data/cockpit/.cockpit-board.json`;
  if (native) {
    await fixture.stop();
    const directory = `${fixture.directory}/rust-layout`;
    const start = () => startRustServer({ root: `${fixture.directory}/app`, directory, env: fixture.env });
    runtime = await start();
    await runtime.stop();
    await copyFile(`${fixture.directory}/data/cockpit/projects.json`, `${directory}/projects.json`);
    runtime = await start();
    url = runtime.url;
    boardFile = `${directory}/.cockpit-board.json`;
  }
  const executablePath = [process.env.CHROME_BIN, chromium.executablePath(), '/home/rst010/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'].find(path => path && existsSync(path));
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
  await page.route('**/api/board/approval-watcher', route => route.fulfill({ json: { state: 'stopped', canStop: false, targets: ['ai1', 'ai4', 'ai6', 'ai7'], intervalSeconds: 3, heartbeat: null } }));
  await page.goto(url);
  await page.evaluate(async () => { window.testApp = (await import('/js/state.js')).app; });
  await page.waitForFunction(() => window.testApp.ws?.readyState === 1);
  await page.evaluate(() => { for (let i = 0; i < 3; i++) window.testApp.ws.send(JSON.stringify({ type: 'create', projectId: 'sample', cols: 80, rows: 25 })); });
  await page.waitForFunction(() => window.testApp.termMap.size === 3);
  const ids = await page.evaluate(() => [...window.testApp.termMap.keys()]);
  const service = createBoardService(boardFile);
  service.updateBoardReview({ termId: ids[2], alias: 'ai8', status: 'stopped', watched: [
    { termId: ids[0], goal: '좁은 화면에서도 저장 버튼과 체크리스트 전체를 확인할 수 있어야 합니다. '.repeat(15), objective: '배포 노트북 설치와 실제 운영 환경 검증 · 세로 모니터에서 긴 제목과 경로 표시 확인', priority: 1 },
    { termId: ids[1], goal: '모바일 회귀 테스트 통과', objective: '긴 작업 기록 확인', priority: 2 },
  ] });
  const progress = service.getBoard().review.workerProgress;
  service.updateBoardReview({ workerProgress: progress.map(worker => ({ ...worker, evidence: `/local/verification/${'long-result-'.repeat(20)}.txt`, nextAction: '검증 결과 확인 후 다음 독립 작업을 진행합니다. '.repeat(10), run: { status: 'active', summary: '확인한 수행 결과와 남은 작업입니다. '.repeat(20) } })) });
  for (let i = 0; i < 50; i++) {
    const added = service.addBoardTask(`${String(i + 1).padStart(2, '0')} · ${i === 49 ? '마지막 체크리스트 항목' : '검증 작업'} · ${'긴 경로와 작업 설명 확인 '.repeat(4)}`, undefined, 'task', 'user', 'S-0001', ids[0]);
    if (i >= 20) service.updateBoardTask(added.task.id, { done: true });
  }
  await page.getByRole('tab', { name: '전체 현황', exact: true }).click();
  const view = page.locator('#work-overview-view');
  await page.waitForFunction(() => document.querySelectorAll('.wo-row').length === 3);

  async function noHorizontalClipping(label) {
    const failures = await view.evaluate(root => [...root.querySelectorAll('.wo-board, .wo-row, .wo-detail, .session-management, .sm-fields, .sm-checklist, .sm-progress'), root]
      .filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
      .map(el => ({ element: el.className || el.id, width: el.clientWidth, content: el.scrollWidth })));
    assert.deepEqual(failures, [], label);
    const overlaps = await view.evaluate(root => [...root.querySelectorAll('.wo-work > strong')]
      .filter(el => el.getClientRects().length && el.getBoundingClientRect().right > el.parentElement.getBoundingClientRect().right + 1)
      .map(el => el.textContent.slice(0, 30)));
    assert.deepEqual(overlaps, [], `${label}: title overlaps adjacent columns`);
  }
  async function reachable(locator, label) {
    await locator.scrollIntoViewIfNeeded();
    // Center within nested scroll regions and allow sticky layout to settle.
    await locator.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      const nav = document.querySelector('.nav-tabs')?.getBoundingClientRect();
      const bottom = innerWidth <= 600 && nav ? nav.top : innerHeight;
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { withinViewport: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= bottom + 1,
        unobscured: Boolean(hit && (hit === el || el.contains(hit))),
        bounds: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, viewportBottom: bottom };
    });
    if (!result.withinViewport || !result.unobscured) await page.screenshot({ path: `${output}/failure.png` });
    assert.equal(result.withinViewport && result.unobscured, true, `${label}: ${JSON.stringify(result)}`);
  }
  for (const size of cases) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await view.evaluate(el => { el.scrollTop = 0; });
    await noHorizontalClipping(`${size.name}: list`);
    await reachable(view.locator('.wo-row').last(), `${size.name}: last session`);
    await view.locator('.wo-controls > summary').click();
    await reachable(view.locator('[data-wo-dispatch]').first(), `${size.name}: dispatch settings`);
    await noHorizontalClipping(`${size.name}: expanded settings`);
    await view.locator('.wo-controls > summary').click();
    if (['1080x1920', '1080-at-150-percent-equivalent'].includes(size.name)) {
      await view.evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: `${output}/${size.name}-list.png` });
    }
    await view.locator(`[data-wo-session="${ids[0]}"]`).click();
    const panel = view.locator('[data-session-management]');
    await panel.getByRole('tab', { name: '목표·설정', exact: true }).click();
    await reachable(panel.locator('[name="goal"]'), `${size.name}: completion criteria`);
    await reachable(panel.getByRole('button', { name: '변경 저장' }), `${size.name}: save button`);
    await noHorizontalClipping(`${size.name}: session settings`);
    if (['1080x1920', '1080-at-150-percent-equivalent'].includes(size.name)) await page.screenshot({ path: `${output}/${size.name}-detail.png` });
    await panel.getByRole('tab', { name: '체크리스트', exact: true }).click();
    await reachable(panel.locator('[data-sc-open] .sc-row').last().locator('[data-sc-delete]'), `${size.name}: last unfinished task`);
    await panel.locator('.sc-completed > summary').click();
    await reachable(panel.locator('[data-sc-done] .sc-row').last().locator('[data-sc-delete]'), `${size.name}: 50th checklist item`);
    await noHorizontalClipping(`${size.name}: checklist`);
    await panel.getByRole('tab', { name: '진행·근거', exact: true }).click();
    await reachable(panel.locator('.sm-progress section').last().locator('h3'), `${size.name}: evidence footer`);
    await noHorizontalClipping(`${size.name}: progress`);
    await view.locator('[data-wo-close]').click();
    results.push({ ...size, passed: true });
    console.log(JSON.stringify(results.at(-1)));
  }
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const cleanup of [() => browser?.close(), () => runtime?.stop(), () => fixture?.cleanup()]) {
    try { await cleanup(); } catch (error) { cleanupErrors.push(error); failure ||= error; }
  }
  try {
    await writeFile(`${output}/results.json`, JSON.stringify({
      status: failure ? 'failed' : 'passed', runtime: native ? 'rust' : 'node', checkedAt: new Date().toISOString(),
      cleanupVerified: cleanupErrors.length === 0, results,
      errors: [...errors, ...[failure, ...cleanupErrors].filter(Boolean).map(error => String(error.message || error))],
      note: 'Zoom cases use equivalent CSS viewport dimensions, not browser zoom controls.',
    }, null, 2));
  } catch (error) { failure ||= error; }
}
if (failure) throw failure;
