import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createBoardService } from '../lib/board-service.js';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

const fixture = await startPortfolioServer({ durable: false });
const screenshots = new URL('../docs/_local/work-overview/', import.meta.url).pathname;
await mkdir(screenshots, { recursive: true });
let browser;
try {
  const executablePath = [process.env.CHROME_BIN, chromium.executablePath(), '/home/rst010/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'].find(path => path && existsSync(path));
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  // Mock only the existing watcher endpoints; never operate the user's approval process.
  let watcherRunning = true, watcherUnavailable = false, stopRequests = 0;
  let releaseStop, stopStarted, releaseRead, readStarted, delayNextRead = false;
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  const stopStartedPromise = new Promise(resolve => { stopStarted = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const readStartedPromise = new Promise(resolve => { readStarted = resolve; });
  const watcherStatus = () => ({ state: watcherRunning ? 'running' : 'stopped', canStop: watcherRunning, targets: ['ai1', 'ai4', 'ai6', 'ai7'], intervalSeconds: 3,
    heartbeat: { at: Date.now(), stale: false, sent: 3, cleared: 3 } });
  await page.route('**/api/board/approval-watcher', async route => {
    const status = watcherStatus();
    if (delayNextRead) { delayNextRead = false; readStarted(); await readGate; }
    return route.fulfill({ status: watcherUnavailable ? 403 : 200, json: watcherUnavailable ? { error: '로컬 접속 필요' } : status });
  });
  await page.route('**/api/board/approval-watcher/stop', async route => { stopRequests++; stopStarted(); await stopGate; watcherRunning = false; return route.fulfill({ json: watcherStatus() }); });
  await page.goto(fixture.url);
  await page.evaluate(async () => { window.testApp = (await import('/js/state.js')).app; });
  await page.waitForFunction(() => window.testApp.ws?.readyState === 1);
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.testApp.ws.send(JSON.stringify({ type: 'create', projectId: 'sample', cols: 100, rows: 28 })); });
  await page.waitForFunction(() => window.testApp.termMap.size === 4);
  const ids = await page.evaluate(() => [...window.testApp.termMap.keys()]);
  const service = createBoardService(`${fixture.directory}/data/cockpit/.cockpit-board.json`);
  service.updateBoardReview({ termId: ids[3], alias: 'ai8', status: 'stopped', objective: '출시 준비 현황 취합 · 샘플', watched: [
    { termId: ids[0], alias: 'ai1', objective: '로그인 오류 수정', goal: '로그인 회귀 테스트 통과', priority: 1 },
    { termId: ids[1], alias: 'ai4', objective: '모바일 화면 점검', goal: '390px 화면 검증', priority: 2 },
    { termId: ids[2], alias: 'ai6', objective: '배포 노트북 설치', goal: '서비스 구동 검증', priority: 2 },
    { termId: 'disconnected', alias: 'ai7', objective: '수집 결과 확인', goal: '수집 결과 대조', priority: 3 },
  ] });
  service.updateBoardReview({ workerProgress: service.getBoard().review.workerProgress.map((worker, i) => ({ ...worker,
    nextAction: ['접속 정보 확인 후 검증', '휴대폰 실기기 확인', '다음 배포 대기', '수집기 재연결'][i],
    run: { status: ['blocked', 'reported', 'complete', 'ready'][i], summary: ['예외 처리 수정. 배포 환경 확인이 남았습니다.', '좁은 화면 점검 완료, 최종 확인 요청', '서비스 구동과 재시작 검증 완료', ''][i], blocker: i === 0 ? '검증 환경 접속 정보 필요' : '', reportedAt: Date.now() },
  })) });
  for (let i = 0; i < 3; i++) service.addBoardTask(['로그인 성공 경로 검증', '만료 세션 처리 확인', '배포 환경 확인'][i], undefined, 'task', 'user', 'S-0001', ids[0]);
  await page.getByRole('tab', { name: '전체 현황', exact: true }).click();
  const view = page.locator('#work-overview-view');
  await page.waitForFunction(() => document.querySelectorAll('.wo-row').length === 5);
  assert.equal(await view.locator('.wo-controls').evaluate(el => el.open), false);
  await view.locator('.wo-controls > summary').click();
  assert.equal(await view.locator('[data-wo-approval-stop]').isEnabled(), true);
  page.once('dialog', dialog => dialog.accept());
  await view.locator('[data-wo-approval-stop]').click();
  await stopStartedPromise;
  delayNextRead = true;
  await page.evaluate(() => document.querySelector('[data-wo-refresh]').click());
  await readStartedPromise;
  releaseStop();
  await page.waitForFunction(() => document.querySelector('[data-wo-approval-state]')?.textContent === '중지됨');
  const lateRead = page.waitForResponse(response => response.url().endsWith('/api/board/approval-watcher'));
  releaseRead();
  await (await lateRead).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await view.locator('[data-wo-approval-state]').textContent(), '중지됨');
  assert.equal(stopRequests, 1);
  assert.equal(await view.locator('[data-wo-approval-stop]').isDisabled(), true);
  assert.ok((await view.locator('.wo-row').first().textContent()).includes('로그인 오류 수정'));
  const dispatch = view.locator('[data-wo-dispatch]').first();
  await dispatch.selectOption('running');
  await page.waitForFunction(() => document.querySelector('[data-wo-dispatch-message]')?.textContent.startsWith('독립 진행 켜짐'));
  assert.equal(service.getBoard().review.workerDispatch, 'running');
  assert.equal(service.getBoard().review.status, 'stopped');
  await dispatch.selectOption('paused');
  await page.waitForFunction(() => document.querySelector('[data-wo-dispatch-message]')?.textContent.startsWith('설정 저장됨'));
  assert.equal(service.getBoard().review.workerDispatch, 'paused');
  await view.locator('.wo-controls > summary').click();
  await page.screenshot({ path: `${screenshots}/desktop.png` });
  await view.locator(`[data-wo-progress="${ids[0]}"]`).click();
  assert.equal(await view.locator('.wo-detail [data-sm-tab="progress"]').getAttribute('aria-selected'), 'true');
  assert.ok((await view.locator('.wo-detail .sm-progress').textContent()).includes('검증 환경 접속 정보 필요'));
  await view.locator('[data-wo-close]').click();
  await view.locator('[data-wo-filter="done"]').click();
  assert.equal(await view.locator('.wo-row').count(), 1);
  await view.locator('[data-wo-filter="all"]').click();
  await view.locator(`[data-wo-session="${ids[0]}"]`).click();
  const panel = view.locator('[data-session-management]');
  assert.ok((await panel.locator('[data-sm-owner]').textContent()).includes('자동 지시 정지'));
  await panel.locator('[name="objective"]').fill('로그인 수정 후 배포 확인');
  await view.locator('[data-wo-refresh]').click();
  assert.equal(await panel.locator('[name="objective"]').inputValue(), '로그인 수정 후 배포 확인');
  // The retained overview and terminal panels must share the same unsaved draft.
  await page.evaluate(async () => {
    (await import('/js/dashboard.js')).switchView('terminal');
    if (!document.querySelector('[data-canvas-frame]')) (await import('/js/actions.js')).getClickAction('toggle-canvas-view')?.();
  });
  const frame = page.locator(`[data-canvas-frame="${ids[0]}"]`);
  await page.locator(`.canvas-session-manage[data-termid="${ids[0]}"]`).click();
  const terminalPanel = frame.locator('[data-session-management]');
  assert.equal(await terminalPanel.locator('[name="objective"]').inputValue(), '로그인 수정 후 배포 확인');
  await terminalPanel.locator('[name="objective"]').fill('두 화면에서 공유한 목표');
  await page.getByRole('tab', { name: '전체 현황', exact: true }).click();
  assert.equal(await panel.locator('[name="objective"]').inputValue(), '두 화면에서 공유한 목표');
  assert.equal(await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-session-management] [id]')].map(el => el.id);
    return ids.length === new Set(ids).size;
  }), true);
  await panel.locator('[name="objective"]').fill('로그인 수정 후 배포 확인');
  await panel.getByRole('button', { name: '변경 저장' }).click();
  await page.waitForFunction(() => document.querySelector('.wo-detail [data-sm-message]')?.textContent.startsWith('저장됨'));
  assert.equal(service.getBoard().review.watched[0].objective, '로그인 수정 후 배포 확인');
  await panel.getByRole('tab', { name: '체크리스트', exact: true }).click();
  await panel.locator('[data-sc-toggle]').first().check();
  await page.waitForFunction(() => document.querySelector('.wo-detail [data-sc-count]')?.textContent.includes('1 / 3'));
  await page.waitForFunction(id => document.querySelector(`[data-wo-session="${id}"] .wo-check`)?.textContent.includes('1 / 3'), ids[0]);
  await page.screenshot({ path: `${screenshots}/detail-desktop.png` });
  await view.locator('[data-wo-close]').click();
  await view.locator('[data-wo-filter="completed"]').click();
  assert.equal(await view.locator('.wo-row').count(), 1);
  const completed = view.locator(`[data-wo-completed="${ids[0]}"]`);
  await completed.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await completed.locator('li').first().textContent().then(text => text.includes('로그인 성공 경로 검증')), true);
  await page.evaluate(() => document.querySelector('[data-wo-refresh]').click());
  await page.waitForTimeout(5500);
  assert.equal(await completed.evaluate(el => el.open), true);
  assert.equal(await completed.locator('summary').evaluate(el => el === document.activeElement), true);
  await page.screenshot({ path: `${screenshots}/completed-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/completed-mobile.png` });
  await completed.evaluate(el => el.scrollIntoView({ block: 'center' }));
  assert.equal(await completed.locator('li').last().evaluate(el => el.getBoundingClientRect().bottom <= document.querySelector('.nav-tabs').getBoundingClientRect().top), true);
  await page.screenshot({ path: `${screenshots}/completed-mobile-content.png` });
  await view.locator(`[data-wo-session="${ids[0]}"]`).click();
  assert.ok(await view.evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: `${screenshots}/detail-mobile.png` });
  await view.locator('[data-wo-close]').click();
  await view.locator('[data-wo-filter="all"]').click();
  await view.evaluate(el => { el.scrollTop = 0; });
  assert.ok((await view.locator('.wo-filters').boundingBox()).height >= 44, 'mobile filter touch targets remain visible');
  assert.ok((await view.locator('.wo-row').first().boundingBox()).y < 340, 'first mobile session appears without scrolling through settings');
  await page.screenshot({ path: `${screenshots}/mobile.png` });
  assert.ok(await view.evaluate(el => el.scrollWidth <= el.clientWidth));
  // Poll failure retains known data and visibly marks it stale; recovery restores freshness.
  await page.route('**/api/board', route => route.abort());
  await view.locator('[data-wo-refresh]').click();
  await page.waitForFunction(() => document.querySelector('[data-wo-status]')?.dataset.error === 'true');
  assert.equal(await view.locator('.wo-row').count(), 5);
  await page.waitForTimeout(16000);
  await view.locator('[data-wo-refresh]').click();
  await page.waitForFunction(() => document.querySelector('[data-wo-status]')?.dataset.error === 'true');
  await page.waitForFunction(() => [...document.querySelectorAll('.wo-badge')].some(el => el.textContent.includes('관측 오래됨')));
  await page.unroute('**/api/board');
  await view.locator('[data-wo-refresh]').click();
  await page.waitForFunction(() => document.querySelector('[data-wo-status]')?.dataset.error === 'false');
  watcherUnavailable = true;
  await view.locator('[data-wo-refresh]').click();
  await page.waitForFunction(() => document.querySelector('[data-wo-approval-state]')?.textContent.includes('조회 불가'));
  assert.equal(await view.locator('[data-wo-approval-stop]').isDisabled(), true);
  assert.equal(await view.locator('.wo-row').count(), 5);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ rows: 5, filters: true, completedHistory: true, approvalStopAndUnavailableState: true, expansionAndFocusPreserved: true, settingsSaved: true, checklistSynced: true, draftPreservedAcrossViews: true, errorRecovery: true, screenshots, errors: 0 }));
} finally { await browser?.close(); await fixture.cleanup(); }
