import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

const output = new URL('../docs/_local/session-maintenance-ui/', import.meta.url).pathname;
const sizes = [{ width: 1080, height: 1920 }, { width: 720, height: 1280 }, { width: 390, height: 844 }];
const injected = '<img src=x onerror="window.maintenanceInjected=true">';
const longEmail = `${'long-fixture-account-'.repeat(12)}${injected}@example.invalid`;
const historyText = `${injected}\n${'Archived fixture output <script>window.maintenanceInjected=true</script> '.repeat(40)}`;
const snapshot = {
  sessions: [
    { termId: 'fixture-jcode', alias: 'ai1', activity: { state: 'limited', agent: 'jcode' }, account: { id: 'fixture-registered-a', name: 'Claude fixture' }, rssKiB: 128 * 1024, lastOutputAt: 1791554400000, canResume: false, canArchive: false },
    { termId: 'fixture-busy', alias: `ai4 · ${'긴 세션 이름 '.repeat(16)}`, activity: { state: 'busy', agent: 'jcode' }, account: { id: 'fixture-registered-b', name: 'Other fixture' }, rssKiB: 85 * 1024, canResume: false, canArchive: false },
    { termId: 'fixture-exited', alias: 'ai6', activity: { state: 'offline', agent: 'claude' }, rssKiB: null, canResume: true, canArchive: true },
  ],
  archived: [{ termId: 'fixture-archive', alias: `ai7 · ${injected}`, archivedAt: 1791554400000, reason: 'exited', canResume: true }],
  processes: {
    orphans: [
      { pid: 123456, startTicks: '9000123456', termId: 'fixture-archive', name: 'node', rssKiB: 42 * 1024, ageSeconds: 900, eligible: true, reason: 'abandoned_mcp' },
      { pid: 123457, startTicks: '9000123457', termId: null, name: 'node', rssKiB: 12 * 1024, ageSeconds: 900, eligible: false, reason: 'unverified_session' },
    ],
    zombies: [{ pid: 123458, parentPid: 123459, name: 'node', rssKiB: 0 }],
  },
};
const accounts = [
  { provider: 'claude', label: 'fixture-otter', email: longEmail, available: true, isDefault: true },
  { provider: 'claude', label: 'fixture-expired', email: 'expired@example.invalid', available: false, isDefault: false },
  { provider: 'openai', label: 'fixture-codex', email: 'second@example.invalid', available: true, isDefault: false },
];
let fixture, browser, failure;
let accountBusy = true;
let listedSessions = snapshot.sessions;
let holdSessions, releaseSessions, accountRowsMode = false;
let accountListError = false;
let usagePendingReads = 0, usageRefreshCalls = 0, allowLogin = false;
const logins = [];
let allowNativeWorker = false;
const nativeWorkers = [];
let expectedCliAccount = null;
const cliWorkers = [];
const cardAccounts = [
 { id: 'fixture-registered-a', name: '현재 로그인', email: 'a@example.invalid', provider: 'claude', state: 'ready', source: 'cockpit', weeklyRemaining: 20, sessionRemaining: 30, weeklyTokenBudget: 40000000, usage: null },
 { id: 'fixture-registered-b', name: '다른 로그인', email: 'b@example.invalid', provider: 'claude', state: 'ready', source: 'cockpit', weeklyRemaining: 90, sessionRemaining: 90, usage: { limits: { weekly: { remaining: 90 }, session: { remaining: 90 } } } },
 { id: 'fixture-registered-c', name: '로그인 필요', provider: 'claude', state: 'login', source: 'cockpit' },
];
let cardChoices = cardAccounts.map((row, index) => ({ id: row.id, source: 'cockpit', provider: 'claude', email: row.email, available: index !== 2, label: 'claude-' + index, isDefault: index === 0, requiresConnection: false }));
let firstConnection = false, connectionApplied = false, connectionReads = 0, connectionFailure = false;
const registeredChoice = { source: 'cockpit', id: 'fixture-registered-a', provider: 'claude', label: 'fixture-shared-label', email: 'registered-before@example.invalid', available: true, requiresConnection: true };
const beforeConnection = [registeredChoice, { source: 'jcode', provider: 'claude', label: 'fixture-shared-label', email: 'old-native@example.invalid', available: true }];
const afterConnection = [
  { ...registeredChoice, id: 'fixture-registered-b', email: 'other-managed@example.invalid', requiresConnection: false },
  { ...registeredChoice, email: 'selected-managed@example.invalid', requiresConnection: false },
];
const results = [], pageErrors = [], mutations = [], unexpectedMutations = [], layoutErrors = [];
let pendingCostReads = 0;
try {
  await mkdir(output, { recursive: true });
  fixture = await startPortfolioServer({ durable: false, runtime: 'rust' });
  const executablePath = [process.env.CHROME_BIN, chromium.executablePath(), '/home/rst010/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'].find(path => path && existsSync(path));
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: sizes[0], serviceWorkers: 'block' });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => pageErrors.push(error.message));
  // Only this private fixture can receive GETs. Every mutation is mocked or rejected.
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== fixture.url) return route.abort();
    const method = request.method();
    if (url.pathname === '/api/terminals' && method === 'GET') {
      if (holdSessions) await new Promise(resolve => { releaseSessions = resolve; });
      return route.fulfill({ json: { terminals: listedSessions } });
    }
    if (url.pathname === '/api/ai-accounts' && method === 'GET') {
      if (usagePendingReads && --usagePendingReads === 0) cardAccounts[0].usage.query = { state: 'ready' };
      const costsLoading = pendingCostReads > 0;
      if (costsLoading) pendingCostReads--;
      return route.fulfill(accountListError ? { status: 503, json: { error: 'fixture: 계정 조회 연결 오류' } } : { json: { accounts: accountRowsMode ? cardAccounts : [], runtime: 'fixture', usageRefreshSupported: true,
        jcodeCosts: costsLoading ? null : { pricedRequests: 3, unpricedRequests: 2, todayUsd: 1.23, weekUsd: 4.56 } } });
    }
    if (url.pathname === '/api/ai-accounts/fixture-registered-a/usage-refresh' && method === 'POST') {
      usageRefreshCalls++;
      cardAccounts[0].usage.query = { state: 'loading' };
      usagePendingReads = 2;
      return route.fulfill({ json: { refreshing: true } });
    }
    if (url.pathname === '/api/terminals/maintenance') {
      if (method === 'GET') return route.fulfill({ json: snapshot });
      const body = request.postDataJSON();
      mutations.push({ path: url.pathname, body });
      if (body.action === 'history') return route.fulfill({ json: { output: historyText } });
      if (body.action === 'cleanup') return route.fulfill({ json: { requested: 1, signalled: body.processes, skipped: [] } });
      return route.fulfill({ status: 409, json: { error: 'fixture: 세션이 실행 중입니다.' } });
    }
    if (/^\/api\/terminals\/fixture-[a-z]+\/accounts$/.test(url.pathname) && method === 'GET') {
      if (accountRowsMode) return route.fulfill({ json: { accounts: cardChoices, managed: true } });
      if (firstConnection) connectionReads++;
      return route.fulfill({ json: { accounts: firstConnection ? (connectionApplied ? afterConnection : beforeConnection) : accounts, managed: firstConnection && connectionApplied } });
    }
    if (/^\/api\/terminals\/fixture-[a-z]+\/account$/.test(url.pathname) && method === 'POST') {
      mutations.push({ path: url.pathname, body: request.postDataJSON() });
      if (accountRowsMode && !accountBusy) cardChoices = cardChoices.map(choice => ({ ...choice, isDefault: choice.id === request.postDataJSON().accountId }));
      if (firstConnection) {
        const connected = !connectionApplied;
        connectionApplied = true;
        if (connectionFailure && connected) return route.fulfill({ status: 409, json: { error: 'fixture: 새 연결이 시작됐지만 계정 전환을 확인하지 못했습니다.' } });
        return route.fulfill({ json: { connected, accepted: true } });
      }
      return route.fulfill(accountBusy ? { status: 409, json: { error: 'fixture: 작업 실행 중이므로 계정 전환을 보류합니다.' } } : { json: { accepted: true } });
    }
    if (url.pathname === '/api/board/approval-watcher') return route.fulfill({ json: { state: 'stopped', canStop: false, targets: [], intervalSeconds: 3, heartbeat: null } });
    // main.js restores this UI preference during startup; keep the fixture notification-free.
    if (url.pathname === '/api/notify/toggle' && method === 'POST') return route.fulfill({ json: { enabled: false } });
    if (!['GET', 'HEAD'].includes(method)) { unexpectedMutations.push(`${method} ${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  // No live PTY connection: the browser receives an empty terminal inventory.
  await page.routeWebSocket('**/*', socket => {
    socket.send(JSON.stringify({ type: 'terminals', terminals: [] }));
    socket.onMessage(message => {
      const value = JSON.parse(String(message));
      if (expectedCliAccount && value.type === 'create' && value.accountId === expectedCliAccount && value.engine === undefined && value.loginMode === undefined) { cliWorkers.push(value); expectedCliAccount = null; return; }
      if (allowNativeWorker && value.type==='create' && value.engine==='jcode' && value.accountId==='fixture-registered-a' && value.loginMode!==true) { nativeWorkers.push(value); allowNativeWorker=false; return; }
      if (allowLogin && value.type === 'create' && value.loginMode === true && value.accountId === 'fixture-registered-a') { logins.push(value); allowLogin = false; return; }
      if (!['ping', 'resize', 'focus'].includes(value.type)) unexpectedMutations.push(`websocket ${value.type}`);
    });
  });
  await page.goto(fixture.url);
  await page.getByRole('tab', { name: '전체 현황', exact: true }).click();
  const root = page.locator('[data-wo-maintenance]');
  const status = root.locator('.wo-maint-body > [role="status"]');
  await root.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('[data-maint-summary]')?.textContent.includes('열림 3'));

  async function reachable(locator, label) {
    try { await locator.scrollIntoViewIfNeeded(); }
    catch (error) {
      // The real 15-second refresh may replace a row during the initial scroll.
      if (!error.message.includes('not attached to the DOM')) throw error;
      await locator.scrollIntoViewIfNeeded();
    }
    await locator.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      const nav = document.querySelector('.nav-tabs')?.getBoundingClientRect();
      const bottom = innerWidth <= 600 && nav ? nav.top : innerHeight;
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { label: el.tagName === 'SELECT' ? 'account select' : el.textContent.trim(), width: r.width, height: r.height, minHeight: getComputedStyle(el).minHeight, within: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= bottom + 1, hit: Boolean(hit && (hit === el || el.contains(hit))) };
    });
    if (!(state.width >= 44 && state.height >= 44 && state.within && state.hit)) layoutErrors.push(`${label}: ${JSON.stringify(state)}`);
  }
  async function layout(label) {
    // Native select scrollWidth includes long option labels; its actual bounds are checked below.
    const clipped = await root.evaluate(root => [root, ...root.querySelectorAll('.wo-maint-body,.wo-maint-toolbar,.wo-maint-list,.wo-maint-row,.wo-maint-accounts,.wo-maint-history')]
      .filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
      .map(el => ({ element: el.className || el.tagName, width: el.clientWidth, content: el.scrollWidth })));
    if (clipped.length) layoutErrors.push(`${label}: horizontal clipping ${JSON.stringify(clipped)}`);
    for (const button of await root.locator('button:visible,select:visible').all()) await reachable(button, label);
    assert.equal(await root.locator('img,script').count(), 0, `${label}: HTML must stay text`);
    assert.equal(await page.evaluate(() => Boolean(window.maintenanceInjected)), false);
  }
  async function tab(name) {
    const button = root.locator(`[data-maint-tab="${name}"]`);
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.equal(await root.locator('[data-maint-tab][aria-pressed="true"]').count(), 1);
  }
  for (const size of sizes) {
    const name = `${size.width}x${size.height}`;
    const layoutStart = layoutErrors.length;
    try {
      await page.setViewportSize(size);
      await tab('sessions');
      assert.equal(await root.locator('[data-maint-action="resume"][data-term-id="fixture-jcode"]').isDisabled(), true);
      assert.equal(await root.locator('[data-maint-action="archive"][data-term-id="fixture-busy"]').isDisabled(), true);
      await layout(`${name}: sessions`);
      await root.locator('[data-maint-action="archive"][data-term-id="fixture-exited"]').click();
      await page.waitForFunction(() => document.querySelector('.wo-maint-status')?.textContent === 'fixture: 세션이 실행 중입니다.');
      assert.equal(await status.textContent(), 'fixture: 세션이 실행 중입니다.', '409 survives the post-action refresh');
      await root.locator('[data-maint-action="accounts"][data-term-id="fixture-jcode"]').click();
      const select = root.locator('[data-maint-account-select]');
      await select.waitFor();
      assert.equal(await select.evaluate(el => el.closest('[data-maint-session]')?.dataset.maintSession), 'fixture-jcode', 'Account controls stay inside their session row');
      await page.waitForFunction(() => !document.querySelector('[data-maint-action="accounts"][data-term-id="fixture-jcode"]').disabled);
      assert.equal(await root.locator('[data-maint-action="accounts"][data-term-id="fixture-busy"]').isDisabled(), false, 'Other session rows unlock while account select retains focus');
      assert.equal(await root.locator('[data-maint-action="resume"][data-term-id="fixture-exited"]').isDisabled(), false);
      assert.equal(await select.locator('option').count(), 3);
      assert.ok((await select.locator('option').first().textContent()).includes(longEmail));
      assert.equal(await select.locator('option').nth(1).evaluate(option => option.disabled), true, 'Unavailable account option is disabled');
      accountBusy = true;
      await root.locator('[data-maint-account-switch]').click();
      await page.waitForFunction(() => document.querySelector('.wo-maint-status')?.textContent.startsWith('계정 전환 보류 · fixture:'));
      assert.match(await status.textContent(), /작업 실행 중/);
      assert.equal(await root.locator('[data-maint-account-status]').textContent(), await status.textContent(), 'Account error also appears beside the account controls');
      accountBusy = false;
      await root.locator('[data-maint-account-switch]').click();
      await page.waitForFunction(() => document.querySelector('.wo-maint-status')?.textContent.startsWith('전환 명령 전달됨'));
      assert.ok(!(await status.textContent()).includes('전환 완료'));
      assert.equal(await root.locator('[data-maint-account-status]').textContent(), await status.textContent(), 'Command acknowledgement also appears in the account panel');
      const switched = mutations.at(-1);
      assert.equal(switched.path, '/api/terminals/fixture-jcode/account');
      assert.deepEqual(switched.body, { provider: 'claude', label: 'fixture-otter' });
      await layout(`${name}: accounts`);
      await root.locator('.wo-maint-accounts').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: `${output}/${name}-accounts.png` });
      await root.locator('[data-maint-account-close]').click();
      assert.equal(await root.locator('.wo-maint-accounts').isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.termId), 'fixture-jcode', 'Closing returns focus to the same session row');
      await tab('archived');
      await root.locator('[data-maint-action="history"]').click();
      const history = root.locator('.wo-maint-history');
      await history.waitFor();
      assert.equal(await history.textContent(), historyText);
      await layout(`${name}: archived history`);
      await history.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: `${output}/${name}-history.png` });
      await tab('processes');
      assert.equal(await history.isVisible(), false);
      assert.equal(await root.locator('[data-maint-cleanup="123457"]').isDisabled(), true);
      await root.locator('[data-maint-cleanup="123456"]').click();
      await page.waitForFunction(() => document.querySelector('.wo-maint-status')?.textContent === '종료 요청 1개 · 상태가 달라져 제외 0개');
      assert.deepEqual(mutations.at(-1).body, { action: 'cleanup', processes: [{ pid: 123456, startTicks: '9000123456' }] });
      await layout(`${name}: processes`);
      await root.locator('.wo-maint-list').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: `${output}/${name}-processes.png` });
      const errors = layoutErrors.slice(layoutStart);
      results.push({ ...size, passed: errors.length === 0, functionalChecks: 'passed', layoutErrors: errors });
      if (errors.length) failure ||= new Error(errors[0]);
    } catch (error) {
      await page.screenshot({ path: `${output}/${name}-failure.png` });
      results.push({ ...size, passed: false, error: error.message });
      failure ||= error;
    }
  }
  firstConnection = true;
  await tab('sessions');
  await root.locator('[data-maint-action="accounts"][data-term-id="fixture-jcode"]').click();
  const connectedSelect = root.locator('[data-maint-account-select]');
  await connectedSelect.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-maint-account-select]')?.textContent.includes('old-native@example.invalid'));
  assert.equal(await connectedSelect.locator('option').count(), 2);
  await connectedSelect.selectOption('0');
  await root.locator('[data-maint-account-switch]').click();
  await page.waitForFunction(() => document.querySelector('[data-maint-account-select]')?.textContent.includes('selected-managed@example.invalid'));
  assert.equal(connectionReads, 2, 'A connected response reloads the account list');
  assert.deepEqual(mutations.at(-1).body, { accountId: registeredChoice.id });
  assert.equal(await connectedSelect.locator('option').count(), 2);
  assert.ok(!(await connectedSelect.textContent()).includes('old-native@example.invalid'), 'Old native account disappears after changing homes');
  assert.ok(!(await connectedSelect.textContent()).includes('registered-before@example.invalid'), 'Changed metadata replaces the original email even when labels match');
  assert.equal(await connectedSelect.inputValue(), '1', 'The registered account ID remains selected after list reordering');
  assert.ok((await connectedSelect.locator('option:checked').textContent()).includes('selected-managed@example.invalid'));
  await page.waitForFunction(() => document.querySelector('[data-maint-account-status]')?.textContent.startsWith('전환 명령 전달됨'));
  assert.ok(!(await root.locator('[data-maint-account-status]').textContent()).includes('전환 완료'));
  await root.locator('[data-maint-account-switch]').click();
  await page.waitForFunction(() => document.querySelector('[data-maint-account-status]')?.textContent.startsWith('전환 명령 전달됨'));
  assert.deepEqual(mutations.at(-1).body, { accountId: registeredChoice.id }, 'A second click uses the retained ID, not the stale native label');
  const connectionLayoutStart = layoutErrors.length;
  await layout('390x844: first connection account refresh');
  assert.deepEqual(layoutErrors.slice(connectionLayoutStart), []);
  await root.locator('.wo-maint-accounts').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: `${output}/390x844-connected-accounts.png` });
  results.push({ scenario: 'first connection reloads accounts and retains selected registered ID', passed: true });
  connectionApplied = false; connectionReads = 0; connectionFailure = true;
  await root.locator('[data-maint-account-close]').click();
  await root.locator('[data-maint-action="accounts"][data-term-id="fixture-jcode"]').click();
  await page.waitForFunction(() => document.querySelector('[data-maint-account-select]')?.textContent.includes('old-native@example.invalid'));
  await connectedSelect.selectOption('0');
  await root.locator('[data-maint-account-switch]').click();
  await page.waitForFunction(() => document.querySelector('[data-maint-account-select]')?.textContent.includes('selected-managed@example.invalid'));
  await page.waitForFunction(() => document.querySelector('[data-maint-account-status]')?.textContent.startsWith('계정 전환 보류 · fixture: 새 연결'));
  assert.equal(connectionReads, 2, 'A failed first connection reloads accounts even without a connected flag');
  assert.ok(!(await connectedSelect.textContent()).includes('old-native@example.invalid'), 'A partial handoff failure must not retain native options from the old home');
  assert.equal(await connectedSelect.inputValue(), '1', 'A failed first connection preserves the registered ID after reordering');
  assert.ok((await connectedSelect.locator('option:checked').textContent()).includes('selected-managed@example.invalid'));
  assert.deepEqual(mutations.at(-1).body, { accountId: registeredChoice.id });
  const retryCount = mutations.length;
  await root.locator('[data-maint-account-switch]').click();
  await page.waitForFunction(() => document.querySelector('[data-maint-account-status]')?.textContent.startsWith('전환 명령 전달됨'));
  assert.equal(mutations.length, retryCount + 1, 'Retry sends exactly one account request');
  assert.deepEqual(mutations.at(-1).body, { accountId: registeredChoice.id }, 'Retry after failed handoff uses the current registered ID');
  assert.equal(connectionReads, 2, 'The refreshed managed account can switch without another connection attempt');
  results.push({ scenario: 'failed first connection refreshes changed account home and preserves retry ID', passed: true });
  firstConnection = false; accountBusy = false; accountRowsMode = true;
  await page.setViewportSize(sizes[0]);
  await page.evaluate(async () => { const { app } = await import('/js/state.js'); app.activeTermId = 'fixture-jcode'; });
  await page.getByRole('tab', { name: 'AI 계정', exact: true }).click();
  const accountView = page.locator('#ai-accounts-view');
  await page.waitForFunction(() => document.querySelector('[data-action="switch-ai-account"][data-term-id="fixture-jcode"]') && !document.querySelector('[data-action="switch-ai-account"][data-account-id="fixture-registered-b"]').disabled);
  assert.equal(await accountView.locator('#ai-account-session,.ai-account-session-bar').count(), 0, 'No separate target-session picker');
  assert.equal(await accountView.locator('[data-maint-account-select]').count(), 0, 'AI accounts uses its existing rows instead of another picker');
  assert.match(await accountView.locator('#ai-account-context').textContent(), /ai1/);
  await accountView.locator('[data-action="edit-ai-budget"][data-account-id="fixture-registered-a"]').click();
  await accountView.locator('#ai-budget-input').fill('73');
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  await page.waitForFunction(() => !document.querySelector('[data-action="switch-ai-account"][data-account-id="fixture-registered-b"]').disabled);
  assert.equal(await accountView.locator('#ai-budget-input').inputValue(), '73', 'Refresh preserves an unsaved budget');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ai-budget-input', 'Refresh preserves editing focus');
  cardAccounts[0].usage = { limits: {} };
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.equal(await accountView.locator('#ai-budget-input').inputValue(), '73', 'Official quota arriving cannot discard a draft');
  cardAccounts[0].state = 'login';
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.equal(await accountView.locator('#ai-budget-input').inputValue(), '73', 'Authentication state changes cannot discard a draft');
  cardAccounts[0].state = 'ready'; cardAccounts[0].usage = null;
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  await accountView.locator('[data-action="cancel-ai-budget"]').click();
  const measuredAccount = { ...cardAccounts[0] };
  cardAccounts[0].weeklyRemaining = null; cardAccounts[0].sessionRemaining = null;
  cardAccounts[0].usage = { provider: 'claude', weeklyTokens: 0, sessionTokens: 0, lastActiveAt: '', limits: null };
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  const unverifiedRow = accountView.locator('[data-account-id="fixture-registered-a"]').filter({ has: page.locator('.ai-account-identity') });
  assert.match(await unverifiedRow.innerText(), /사용량 미확인/);
  assert.doesNotMatch(await unverifiedRow.innerText(), /주간 사용 0토큰|집계 중/);
  cardAccounts[0].weeklyRemaining = 100;
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.match(await unverifiedRow.innerText(), /사용량 미확인/);
  assert.doesNotMatch(await unverifiedRow.innerText(), /100%|집계 중/);
  assert.match(await accountView.locator('#ai-best-account').innerText(), /다른 로그인/);
  cardAccounts[0].usage = { provider: 'claude', weeklyTokens: 1200, sessionTokens: 300, lastActiveAt: '2026-10-16T00:00:00Z', limits: null };
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.match(await unverifiedRow.innerText(), /콕핏 로컬 계산/);
  assert.doesNotMatch(await unverifiedRow.innerText(), /사용량 미확인/);
  for (const limits of [{}, { weekly: null, session: null }]) {
    cardAccounts[0].usage.limits = limits;
    await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
    assert.match(await unverifiedRow.innerText(), /콕핏 로컬 계산/);
    assert.equal(await unverifiedRow.locator('[data-action="edit-ai-budget"]').count(), 1, 'Empty official windows cannot hide measured local usage or its budget');
  }
  Object.assign(cardAccounts[0], measuredAccount);
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  results.push({ scenario: 'Missing official quota and absent local history show unverified usage instead of fabricated zero; measured local history remains visible', passed: true });
  cardAccounts[0].usage = { query: { state: 'error', code: 'login_required' }, cost: { todayUsd: 0.001, weekUsd: 2.5, pricedRequests: 3 } };
  cardAccounts[0].jcodeCost = {todayUsd:0.001,weekUsd:3.75,pricedRequests:4,unpricedRequests:1};
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.match(await unverifiedRow.innerText(), /다시 로그인 필요/);
  assert.match(await unverifiedRow.innerText(), /최근 7일 \$2.50/);
  assert.match(await unverifiedRow.innerText(), /최근 7일 \$3.75.*1건 제외/);
  assert.match(await unverifiedRow.innerText(), /jcode 계정 기록/);
  assert.equal(await unverifiedRow.locator('[data-action="switch-ai-account"]').isDisabled(), true);
  assert.match(await page.locator('#ai-accounts-costs').innerText(), /최근 7일 \$4.56.*2건 제외/);
  assert.match(await page.locator('#ai-accounts-costs').innerText(), /실제 청구액·구독료와 다름/);
  assert.match(await page.locator('#ai-accounts-costs').innerText(), /합산하지 않습니다/);
  pendingCostReads = 1;
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.equal(pendingCostReads,0);
  assert.match(await page.locator('#ai-accounts-costs').innerText(), /최근 7일 \$4.56/);
  assert.match(await unverifiedRow.innerText(), /claude auth login --claudeai/);
  for (const size of [sizes[0], sizes[2]]) {
    await page.setViewportSize(size);
    assert.deepEqual(await accountView.evaluate(root => [root,...root.querySelectorAll('.ai-accounts-costs,.ai-account-row')].filter(el => el.scrollWidth > el.clientWidth+1).map(el=>el.className)),[]);
    await reachable(unverifiedRow.locator('[data-action="open-ai-account-terminal"]'), 'Re-login button');
    await page.screenshot({path:`${output}/${size.width}x${size.height}-usage-recovery-cost.png`});
  }
  await page.setViewportSize(sizes[0]);
  allowLogin = true;
  await unverifiedRow.locator('[data-action="open-ai-account-terminal"]').click();
  await page.waitForFunction(() => document.getElementById('terminal-view').classList.contains('active'));
  assert.equal(logins.length,1);
  assert.equal(logins[0].accountId,'fixture-registered-a');
  await page.getByRole('tab', {name:'AI 계정',exact:true}).click();
  cardAccounts[0].usage.query = {state:'error',code:'network_error'};
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.match(await unverifiedRow.innerText(),/서버에 연결하지 못했습니다/);
  await unverifiedRow.locator('[data-action="refresh-ai-usage"]').click();
  assert.equal(await unverifiedRow.locator('[data-action="refresh-ai-usage"]').isDisabled(),true);
  await unverifiedRow.locator('[data-action="refresh-ai-usage"]').dispatchEvent('click');
  await page.waitForFunction(() => !document.querySelector('[data-account-id="fixture-registered-a"] [data-action="refresh-ai-usage"]'));
  assert.equal(usageRefreshCalls,1,'Duplicate refresh is single-flight');
  Object.assign(cardAccounts[0],measuredAccount);
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  results.push({scenario:'Rejected login has working isolated login action; network retry is single-flight; partial API estimates remain visible at desktop/mobile sizes',passed:true});
  Object.assign(cardAccounts[0],{jcodeSupported:true,authEngine:'cli',usage:{query:{state:'loading'},authenticationRejected:true}});
  Object.assign(cardAccounts[1],{jcodeSupported:true,authEngine:'cli'});
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  const cliRow = accountView.locator('.ai-account-row[data-account-id="fixture-registered-b"]');
  const cliButton = cliRow.locator('[data-action="open-ai-account-terminal"]:not([data-engine])');
  const nativeConnection = unverifiedRow.locator('[data-action="open-ai-account-terminal"][data-engine="jcode"]');
  assert.equal(await unverifiedRow.locator('[data-action="open-ai-account-terminal"]:not([data-engine])').innerText(),'다시 로그인');
  assert.match(await unverifiedRow.innerText(),/claude auth login/);
  for (const [provider, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
    cardAccounts[1].provider = provider;
    await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
    assert.equal(await cliButton.innerText(), `${label} 새 세션`);
    assert.match(await page.locator('#ai-best-account').innerText(), new RegExp(`${label} 새 세션`));
    expectedCliAccount = 'fixture-registered-b';
    await (provider === 'claude' ? cliButton : page.locator('#ai-best-account')).click();
    await page.waitForFunction(() => document.getElementById('terminal-view').classList.contains('active'));
    assert.equal(expectedCliAccount, null, 'Existing CLI login launches without jcode engine or a new login');
    await page.getByRole('tab',{name:'AI 계정',exact:true}).click();
  }
  assert.equal(cliWorkers.length, 2);
  cardAccounts[1].provider = 'claude';
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.equal(await nativeConnection.innerText(), 'jcode 연결 · 별도 로그인');
  await nativeConnection.focus();
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.engine), 'jcode', 'Refresh preserves the explicit engine action focus');
  for (const size of [sizes[0], sizes[2]]) {
    await page.setViewportSize(size);
    assert.deepEqual(await accountView.evaluate(root => [root,...root.querySelectorAll('.ai-account-row')].filter(el => el.scrollWidth > el.clientWidth+1).map(el => el.className)), []);
    await reachable(cliButton, 'Existing CLI session button');
    await reachable(nativeConnection, 'Explicit jcode connection button');
    await page.screenshot({path:`${output}/${size.width}x${size.height}-existing-login.png`});
  }
  await page.setViewportSize(sizes[0]);
  allowLogin=true;
  await nativeConnection.click();
  await page.waitForFunction(() => document.getElementById('terminal-view').classList.contains('active'));
  assert.equal(logins.at(-1).engine,'jcode');
  await page.getByRole('tab',{name:'AI 계정',exact:true}).click();
  Object.assign(cardAccounts[0],{authEngine:'jcode'});
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.equal(await nativeConnection.count(), 0, 'Native accounts cannot fall back to the old CLI login');
  assert.equal(await unverifiedRow.locator('[data-action="open-ai-account-terminal"]').innerText(), 'jcode 로그인');
  allowLogin=true;
  await unverifiedRow.locator('[data-action="open-ai-account-terminal"]').click();
  await page.waitForFunction(() => document.getElementById('terminal-view').classList.contains('active'));
  assert.equal(logins.at(-1).engine, 'jcode');
  await page.getByRole('tab',{name:'AI 계정',exact:true}).click();
  results.push({scenario:'Existing Claude and Codex logins remain the default despite jcode installation; explicit native connection preserves focus and uses separate login',passed:true});
  Object.assign(cardAccounts[0],{authEngine:'jcode',usage:{query:{state:'ready'}}});
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  assert.equal(await unverifiedRow.locator('[data-action="open-ai-account-terminal"]').innerText(),'jcode 새 세션');
  for(const size of [sizes[0],sizes[2]]) {
    await page.setViewportSize(size);
    assert.deepEqual(await accountView.evaluate(root=>[root,...root.querySelectorAll('.ai-account-row')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.className)),[]);
    await reachable(unverifiedRow.locator('[data-action="open-ai-account-terminal"]'),'Native worker button');
    await page.screenshot({path:`${output}/${size.width}x${size.height}-native-account.png`});
  }
  allowNativeWorker=true;
  await unverifiedRow.locator('[data-action="open-ai-account-terminal"]').click();
  await page.waitForFunction(() => document.getElementById('terminal-view').classList.contains('active'));
  assert.equal(nativeWorkers.length,1);
  await page.setViewportSize(sizes[0]);
  await page.getByRole('tab',{name:'AI 계정',exact:true}).click();
  delete cardAccounts[0].jcodeSupported; delete cardAccounts[0].authEngine;
  delete cardAccounts[1].jcodeSupported; delete cardAccounts[1].authEngine;
  Object.assign(cardAccounts[0],measuredAccount);
  await page.evaluate(async () => { const view = await import('/js/ai-accounts.js'); await view.initAiAccounts(); });
  results.push({scenario:'Native login and worker actions use the jcode engine and remain visible on portrait/mobile screens',passed:true});
  accountListError = true;
  await accountView.locator('.ai-accounts-bar [data-action="refresh-ai-accounts"]').click();
  await accountView.locator('#ai-account-feedback').waitFor();
  assert.equal(await accountView.locator('#ai-account-list .ai-account-row').count(), 3, 'Failed refresh keeps the last known list');
  assert.equal(await accountView.locator('[data-action="switch-ai-account"][data-account-id="fixture-registered-b"]').isDisabled(), true);
  accountListError = false;
  await accountView.locator('.ai-accounts-bar [data-action="refresh-ai-accounts"]').click();
  await page.waitForFunction(() => document.getElementById('ai-account-feedback').hidden && !document.querySelector('[data-action="switch-ai-account"][data-account-id="fixture-registered-b"]').disabled);
  results.push({ scenario: 'Explicit session context, unsaved draft and focus survive refresh; stale lists disable actions and recover', passed: true });
  await accountView.locator('[data-action="select-account-session"][data-term-id="fixture-busy"]').click();
  await page.waitForFunction(() => document.getElementById('ai-account-context').textContent.includes('작업 중'));
  assert.equal(await accountView.locator('[data-action="switch-ai-account"]:enabled').count(), 0, 'Busy targets explain the wait before sending a switch request');
  const beforeBlockedSwitch = mutations.length;
  await accountView.locator('[data-action="switch-ai-account"]').first().dispatchEvent('click');
  assert.equal(mutations.length, beforeBlockedSwitch, 'Busy targets cannot submit through the row handler');
  listedSessions = snapshot.sessions.map(session => session.termId === 'fixture-busy' ? { ...session, activity: { ...session.activity, state: 'approval' } } : session);
  await accountView.locator('.ai-accounts-bar [data-action="refresh-ai-accounts"]').click();
  await page.waitForFunction(() => document.getElementById('ai-account-context').textContent.includes('승인·로그인 대기'));
  assert.equal(await accountView.locator('[data-action="switch-ai-account"]:enabled').count(), 0);
  listedSessions = snapshot.sessions.map(session => session.termId === 'fixture-busy' ? { ...session, activity: { ...session.activity, state: 'idle' } } : session);
  await accountView.locator('.ai-accounts-bar [data-action="refresh-ai-accounts"]').click();
  await page.waitForFunction(() => document.querySelector('[data-action="switch-ai-account"][data-term-id="fixture-busy"]') && !document.querySelector('[data-action="switch-ai-account"][data-account-id="fixture-registered-b"]').disabled);
  results.push({ scenario: 'Busy and approval targets disable account switching without requests; idle refresh restores it', passed: true });
  for (const size of sizes) {
    await page.setViewportSize(size);
    cardChoices = cardChoices.map((choice, index) => ({ ...choice, isDefault: index === 0 }));
    await accountView.locator('[data-action="select-account-session"][data-term-id="fixture-busy"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="switch-ai-account"][data-term-id="fixture-busy"]') && !document.querySelector('[data-action="switch-ai-account"][data-account-id="fixture-registered-b"]').disabled);
    await accountView.locator('[data-action="select-account-session"][data-term-id="fixture-jcode"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="switch-ai-account"][data-term-id="fixture-jcode"]') && !document.querySelector('[data-action="switch-ai-account"][data-account-id="fixture-registered-b"]').disabled);
    const first = accountView.locator('#ai-account-list .ai-account-row').first();
    assert.equal(await first.getAttribute('data-account-id'), 'fixture-registered-a', 'Default login is first even with lower quota');
    assert.match(await first.textContent(), /기본 로그인/);
    assert.equal(await first.locator('[data-action="select-account-session"][data-term-id="fixture-jcode"]').count(), 1, 'Session is attached to its account row');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.accountId), 'fixture-registered-a', 'Current login card receives focus');
    const unavailable = accountView.locator('[data-action="switch-ai-account"][data-account-id="fixture-registered-c"]');
    assert.equal(await unavailable.isDisabled(), true);
    const nextButton = accountView.locator('[data-action="switch-ai-account"][data-account-id="fixture-registered-b"]');
    const beforeSwitch = mutations.length;
    await nextButton.click();
    await page.waitForFunction(() => document.querySelector('[data-ai-switch-status="fixture-registered-b"]')?.textContent.startsWith('전환 명령 전달됨'));
    assert.equal(mutations.length, beforeSwitch + 1);
    assert.equal(mutations.at(-1).path, '/api/terminals/fixture-jcode/account');
    assert.deepEqual(mutations.at(-1).body, { accountId: 'fixture-registered-b' });
    assert.equal(await accountView.locator('#ai-account-list .ai-account-row').first().getAttribute('data-account-id'), 'fixture-registered-b');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.accountId), 'fixture-registered-b');
    const clipped = await accountView.evaluate(root => [root, ...root.querySelectorAll('.ai-account-row,.ai-account-linked-sessions')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className));
    assert.deepEqual(clipped, []);
    await reachable(nextButton, `Account row ${size.width}x${size.height}`);
    await reachable(accountView.locator('.ai-accounts-bar [data-action="refresh-ai-accounts"]'), 'Account refresh touch target');
    await page.screenshot({ path: `${output}/${size.width}x${size.height}-ai-account-rows.png` });
    results.push({ scenario: 'Active session and default login focus automatically; another account switches from its row', ...size, passed: true });
  }
  holdSessions = true;
  await accountView.locator('.ai-accounts-bar [data-action="refresh-ai-accounts"]').click();
  await page.waitForFunction(() => document.querySelector('[data-action="switch-ai-account"][data-account-id="fixture-registered-a"]').disabled);
  assert.equal(await accountView.locator('[data-action="switch-ai-account"][data-account-id="fixture-registered-a"]').isDisabled(), true);
  assert.equal(await accountView.locator('[data-action="select-account-session"]').first().isDisabled(), true);
  holdSessions = false; releaseSessions();
  await page.waitForFunction(() => !document.querySelector('[data-action="switch-ai-account"][data-account-id="fixture-registered-a"]').disabled);
  listedSessions = [snapshot.sessions[1]];
  await accountView.locator('.ai-accounts-bar [data-action="refresh-ai-accounts"]').click();
  await page.waitForFunction(() => document.getElementById('ai-account-context').textContent.includes('세션 목록'));
  assert.equal(await accountView.locator('[data-action="switch-ai-account"]').count(), 0, 'An ended target cannot silently become another live session');
  await accountView.locator('.ai-accounts-bar [data-action="refresh-ai-accounts"]').click();
  await page.waitForFunction(() => document.getElementById('ai-account-context').textContent.includes('세션 목록'));
  assert.equal(await accountView.locator('[data-action="switch-ai-account"]').count(), 0, 'Repeated refresh cannot revive automatic target selection');
  listedSessions = [];
  await accountView.locator('.ai-accounts-bar [data-action="refresh-ai-accounts"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="switch-ai-account"]'));
  assert.equal(await accountView.locator('[data-action="switch-ai-account"]').count(), 0, 'Ended targets cannot retain switch actions');
  results.push({ scenario: 'Session refresh blocks stale row actions and removes ended targets', passed: true });
  listedSessions = snapshot.sessions;
  await page.setViewportSize(sizes[0]);
  await page.evaluate(async sessions => {
    const { app, notify } = await import('/js/state.js');
    const { addTerminal } = await import('/js/terminal.js');
    for (const session of sessions) {
      addTerminal(session.termId, '__home__', false, session.activity.agent === 'jcode' ? 'jcode' : 'claude', session.account);
      Object.assign(app.termMap.get(session.termId), { alias: session.alias, label: session.alias, activity: session.activity });
    }
    app.activeTermId = 'fixture-jcode';
    app.layoutRoot = { type: 'leaf', termId: 'fixture-jcode' };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    const terminal = document.getElementById('terminal-view'); terminal.classList.add('active');
    notify('renderLayout');
    const { updateAgentWall } = await import('/js/agent-wall.js'); updateAgentWall();
  }, snapshot.sessions);
  const sessionButton = page.locator('[data-session-order-row="fixture-jcode"] [data-action="session-account-list"]');
  await sessionButton.waitFor();
  assert.match(await page.locator('[data-session-order-row="fixture-jcode"] .canvas-session-account-name').textContent(), /Claude fixture/);
  assert.equal(await page.locator('[data-session-order-row="fixture-exited"] [data-action="session-account-list"]').count(), 0, 'Other CLIs cannot use jcode switching');
  for (const size of sizes.filter(size => size.width > 600)) {
    await page.setViewportSize(size);
    const overflow = await page.locator('[data-canvas-session-list]').evaluate(root => [root, ...root.querySelectorAll('.canvas-session-row,.canvas-session-account-line')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className));
    assert.deepEqual(overflow, [], 'Terminal account rows fit the session list');
    await reachable(sessionButton, `Terminal account row ${size.width}x${size.height}`);
    await page.screenshot({ path: `${output}/${size.width}x${size.height}-terminal-account-rows.png` });
  }
  await sessionButton.click();
  await page.waitForFunction(() => document.getElementById('ai-accounts-view').classList.contains('active') && document.querySelector('[data-action="switch-ai-account"][data-term-id="fixture-jcode"]') && !document.querySelector('[data-action="switch-ai-account"][data-account-id="fixture-registered-b"]').disabled);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.accountId), 'fixture-registered-b', 'Session row opens and focuses its saved default account');
  assert.equal(await accountView.locator('#ai-account-session').count(), 0);
  await accountView.locator('#ai-account-search').fill('다른 로그인');
  assert.equal(await accountView.locator('#ai-account-list .ai-account-row').count(), 1);
  assert.match(await accountView.locator('.ai-account-switch-note').textContent(), /다른 세션에도 영향을/);
  await accountView.locator('#ai-account-search').fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#nav-more-btn').click();
  const mobileMenu = page.locator('#nav-more-menu');
  const awsMenuItem = mobileMenu.getByRole('button', { name: 'AWS 연결', exact: true });
  await reachable(awsMenuItem, 'Mobile More menu opens AWS above page content');
  await awsMenuItem.click();
  await page.locator('#aws-connect-view').waitFor({ state: 'visible' });
  await page.locator('#nav-more-btn').click();
  const accountsMenuItem = mobileMenu.getByRole('button', { name: 'AI 계정', exact: true });
  await reachable(accountsMenuItem, 'Mobile More menu returns to AI accounts');
  await accountsMenuItem.click();
  await accountView.waitFor({ state: 'visible' });
  results.push({ scenario: 'Mobile More menu is clickable above real account rows and navigates to AWS and back', passed: true });
  await page.evaluate(async () => { const { app } = await import('/js/state.js'); for (const term of app.termMap.values()) term.xterm.dispose(); app.termMap.clear(); });
  results.push({ scenario: 'Terminal session row shows account and opens its account list without a target picker', passed: true });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpectedMutations, []);
} catch (error) {
  failure ||= error;
} finally {
  const cleanupErrors = [];
  for (const clean of [() => browser?.close(), () => fixture?.cleanup()]) {
    try { await clean(); } catch (error) { cleanupErrors.push(error.message); failure ||= error; }
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), runtime: 'rust', results, pageErrors, unexpectedMutations, cleanupVerified: cleanupErrors.length === 0, cleanupErrors, error: failure?.message, note: 'Private fixture only; maintenance/account mutations and WebSockets mocked. No AI or cleanup process was invoked.' }, null, 2));
}
console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', viewports: results.map(({ layoutErrors, ...result }) => ({ ...result, layoutErrorCount: layoutErrors?.length || 0 })), output }));
if (failure) throw failure;
