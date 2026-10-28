import { app, notify } from './state.js';
import { registerClickActions } from './actions.js';
import { captureScroll, copyText, esc, fetchJson, postJson, showToast, timeAgo } from './utils.js';
import { DEFAULT_VIEW, accountBlocker, accountSwitchBlocker, accountUsageUnverified, accountNeedsLogin, accountUsageIssue, usageCostText, accountHeadroom, bestAccount, visibleAccounts, defaultAccountIds } from './ai-accounts-view.js';
import { mountAccountSwitch } from './account-switch.js';

let loading = false;
let lastData = null;
// 연결 테스트 결과 캐시 (id → { ok, checks }) — 재조회해도 유지
const testResults = {};
const testingIds = new Set();
const refreshingUsageIds = new Set();
let editingBudgetId = null;
let editingBudgetDraft = null;
let accountSwitch, sessionChoices = [], sessionsLoading = false;
let switchChoices = [], switchSession, selectedSessionId, observedActiveTerm, focusedAccountId, focusWanted = false;
let requestedAccountId, switchMessage = '';
let accountsError = '';

function updateAccountContext() {
  const context = document.getElementById('ai-account-context');
  if (context) context.textContent = sessionsLoading ? '전환할 세션을 확인하고 있습니다.'
    : switchSession ? `${switchSession.alias || switchSession.termId} · ${accountSwitch?.pending ? '계정 확인·전환 중' : accountSwitchBlocker(switchSession) || '아래 계정에서 이 세션으로 전환할 수 있습니다.'}`
      : '기존 세션을 바꾸려면 세션 목록에서 해당 세션의 계정 버튼을 누르세요. 새 세션은 아래에서 열 수 있습니다.';
}

function updateSwitchButtons() {
  updateAccountContext();
  document.querySelectorAll('[data-action="refresh-ai-usage"]').forEach(button => {
    button.disabled = Boolean(accountsError || accountSwitch?.pending || refreshingUsageIds.has(button.dataset.accountId));
  });
  document.querySelectorAll('[data-action="select-account-session"]').forEach(button => {
    button.disabled = Boolean(accountsError || accountSwitch?.pending || sessionsLoading);
  });
  document.querySelectorAll('[data-action="switch-ai-account"]').forEach(button => {
    const account = (app.aiAccounts || []).find(item => item.id === button.dataset.accountId);
    button.disabled = Boolean(accountsError || accountSwitch?.pending || sessionsLoading || refreshingUsageIds.has(button.dataset.accountId) || accountSwitchBlocker(switchSession) || !switchChoices.some(item => item.id === button.dataset.accountId && item.available) || (account && accountBlocker(account)));
  });
}


function bindSessionSwitch() {
  if (accountSwitch) return;
  const panel = document.getElementById('ai-account-switch-panel');
  if (!panel) return;
  accountSwitch = mountAccountSwitch(panel, {
    onPending: () => updateSwitchButtons(),
    onStatus: message => {
      switchMessage = message;
      const row = [...document.querySelectorAll('[data-ai-switch-status]')].find(item => item.dataset.aiSwitchStatus === requestedAccountId);
      if (row) row.textContent = message;
    },
    onAccounts: (choices, selectedId) => {
      switchChoices = choices;
      if (selectedId) { focusedAccountId = selectedId; focusWanted = true; }
      rerender();
    },
  });
}

async function refreshSessionChoices() {
  if (!accountSwitch || accountSwitch.pending || sessionsLoading) return;
  sessionsLoading = true;
  updateSwitchButtons();
  try {
    const data = await fetchJson('/api/terminals?activity=1', { timeoutMs: 8000 });
    const selected = app.activeTermId && app.activeTermId !== observedActiveTerm ? app.activeTermId : selectedSessionId;
    const previous = switchSession?.termId;
    observedActiveTerm = app.activeTermId;
    sessionChoices = data.terminals.filter(session => session.activity?.agent === 'jcode'
      || (!session.activity?.agent && session.activity?.state !== 'offline' && /^jcode(?:\s|$)/.test(session.command || '')));
    const next = sessionChoices.find(session => session.termId === selected)
      || (!selected && sessionChoices.length === 1 ? sessionChoices[0] : null);
    selectedSessionId = next?.termId || selected;
    switchSession = next;
    if (next) {
      if (previous !== next.termId) {
        focusedAccountId = null; requestedAccountId = null; focusWanted = true;
      }
      await accountSwitch.open(next);
    } else {
      accountSwitch.close();
    }
  } catch (error) {
    switchSession = null;
    accountSwitch.close();
    showToast(`세션 조회 실패 · ${error.message}`, 'error');
  }
  finally {
    sessionsLoading = false;
    updateSwitchButtons();
  }
}

export function showSessionAccounts(termId) {
  if (accountSwitch?.pending || sessionsLoading) {
    showToast('계정 확인·전환이 끝난 뒤 다시 선택하세요.', 'info');
    return;
  }
  const term = app.termMap.get(termId);
  switchSession = { termId, alias: term?.alias || term?.label || termId };
  selectedSessionId = termId;
  observedActiveTerm = app.activeTermId;
  requestedAccountId = null; focusedAccountId = null; focusWanted = true;
  if (document.getElementById('ai-accounts-view')?.classList.contains('active')) initAiAccounts();
  else notify('switchView', 'ai-accounts');
}

async function selectAccountSession(button) {
  if (accountSwitch?.pending || sessionsLoading) return;
  const session = sessionChoices.find(item => item.termId === button.dataset.termId);
  if (!session) return;
  switchSession = session;
  selectedSessionId = session.termId;
  requestedAccountId = null; focusedAccountId = null; focusWanted = true;
  await accountSwitch.open(session);
}

function rerender() {
  if (lastData) render(lastData);
}

// 뷰가 띄워져 있는 동안 30초 폴링 — 감시자가 놓치는 갱신(토큰 만료 등)도 잡는다
let autoRefreshTimer = null;

function ensureAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(() => {
    const view = document.getElementById('ai-accounts-view');
    if (view?.classList.contains('active') && !loading) initAiAccounts();
  }, 30_000);
}

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function fmtReset(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMinutes()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function remaining(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : '—';
}

function resetLabel(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '초기화 정보 없음';
  const minutes = Math.max(0, Math.round((date.getTime() - Date.now()) / 60000));
  let relative;
  if (minutes < 60) relative = `${minutes}분 후`;
  else if (minutes < 1440) relative = `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 후`;
  else relative = `${Math.floor(minutes / 1440)}일 ${Math.floor((minutes % 1440) / 60)}시간 후`;
  return `${relative} · ${fmtReset(value)}`;
}

function populateProjects() {
  const select = document.getElementById('ai-account-project');
  if (!select) return;
  const previous = select.value;
  const activeProject = app.termMap.get(app.activeTermId)?.projectId || '__home__';
  select.innerHTML = `<option value="__home__">홈 디렉터리</option>${app.projectList.map(project =>
    `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('')}`;
  select.value = [...select.options].some(option => option.value === previous) ? previous : activeProject;
}

// 잔여량 구간 — 막대·숫자 색
function level(value) {
  if (!Number.isFinite(value)) return 'unknown';
  return value < 20 ? 'low' : value < 50 ? 'mid' : 'high';
}

function metric(label, value, resetAt) {
  const known = Number.isFinite(value);
  const width = known ? Math.max(0, Math.min(100, value)) : 0;
  const resetParts = resetLabel(resetAt).split('·');
  const relative = resetParts[0]?.trim() || '';
  const absolute = resetParts[1]?.trim() || '';
  // 리셋 시각은 퍼센트와 무관하게 항상 노출 — 퍼센트만 모를 땐 시각 정보가 더 중요
  const resetText = resetAt
    ? `${relative}${absolute ? ` <i class="abs">${absolute}</i>` : ''}`
    : (known ? '' : '정보 없음');
  return `<div class="ai-account-metric ${level(value)}">
    <div><span>${label}</span><strong>${remaining(value)}</strong></div>
    <div class="ai-account-meter" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" ${known ? `aria-valuenow="${Math.round(width)}"` : 'aria-valuetext="정보 없음"'}>
      <span style="width:${width}%"></span>
    </div>
    <small>${resetText}</small>
  </div>`;
}

// ─── 목록 보기 설정 (정렬·필터) — 브라우저별 편의 설정이라 localStorage ───
const VIEW_KEY = 'cockpit-ai-accounts-view';
let view = { ...DEFAULT_VIEW };
try { view = { ...DEFAULT_VIEW, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'), query: '' }; } catch { /* storage unavailable */ }

function setView(patch) {
  view = { ...view, ...patch };
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ ...view, query: '' })); } catch { /* storage unavailable */ }
  rerender();
}

let filterBound = false;
function bindFilterControls() {
  if (filterBound) return;
  const search = document.getElementById('ai-account-search');
  const alive = document.getElementById('ai-account-alive');
  const sort = document.getElementById('ai-account-sort');
  if (!search || !alive || !sort) return;
  filterBound = true;
  search.addEventListener('input', () => setView({ query: search.value }));
  alive.addEventListener('change', () => setView({ aliveOnly: alive.checked }));
  sort.addEventListener('change', () => setView({ sort: sort.value }));
}

function syncFilterControls() {
  const alive = document.getElementById('ai-account-alive');
  const sort = document.getElementById('ai-account-sort');
  if (alive) alive.checked = Boolean(view.aliveOnly);
  if (sort) sort.value = view.sort;
  document.querySelectorAll('[data-action="ai-account-provider-filter"]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.value === view.provider));
  });
}

function render(data) {
  const list = document.getElementById('ai-account-list');
  const status = document.getElementById('ai-accounts-status');
  if (!list || !status) return;
  const restoreScroll = captureScroll(document.getElementById('ai-accounts-view'));
  const active = list.contains(document.activeElement) ? document.activeElement : null;
  const focusedRow = active?.closest('.ai-account-row')?.dataset.accountId;
  const previousBudget = document.getElementById('ai-budget-input');
  if (previousBudget?.closest('.ai-account-row')?.dataset.accountId === editingBudgetId) editingBudgetDraft = previousBudget.value;
  lastData = data;
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  app.aiAccounts = accounts;
  const costs = document.getElementById('ai-accounts-costs');
  if (costs) {
    costs.hidden = !data.usageRefreshSupported;
    costs.innerHTML = `<div><strong>jcode 공용 기록 · API 환산 추정</strong><b>${esc(data.jcodeCosts ? usageCostText(data.jcodeCosts) : '사용 기록을 확인하고 있습니다…')}</b></div><p>현재 남은 jcode 로그 일부만 집계 · UTC 기준 · 세션 모델·일반 API 단가 · 실제 청구액·구독료와 다름</p><p>과거 로그는 계정별 배분이 불가합니다. 계정 정보가 기록된 새 요청은 아래 각 계정에서 별도로 표시합니다. 두 금액은 겹치므로 합산하지 않습니다.${data.jcodeCosts?.unreadableRecords || data.jcodeCosts?.accountRecords?.unreadableRecords ? ' 읽지 못한 기록은 제외했습니다.' : ''}${data.jcodeCosts?.accountRecords?.unassignedRequests ? ` 계정 미확인 ${esc(data.jcodeCosts.accountRecords.unassignedRequests)}건은 계정별 집계에서 제외했습니다.` : ''}</p>`;
  }
  syncFilterControls();
  updateAccountContext();
  const switchNote = document.querySelector('#ai-accounts-view .ai-account-switch-note');
  if (switchNote) switchNote.textContent = !switchChoices.length
    ? '계정을 바꾸기 전에 해당 계정의 로그인을 완료하세요. 작업·승인·작성 중인 입력을 마친 뒤 전환할 수 있습니다.'
    : switchChoices.every(choice=>choice.authEngine==='jcode')
      ? '선택한 세션의 대화를 해당 계정의 jcode 환경에 다시 연결합니다. 다른 계정의 세션에는 영향을 주지 않습니다.'
      : '공용 저장 계정을 전환하면 같은 jcode 서버의 다른 세션에도 영향을 줄 수 있습니다. 기본 로그인은 저장값이며 실제 연결과 다를 수 있습니다.';
  const feedback = document.getElementById('ai-account-feedback');
  if (feedback) { feedback.textContent = accountsError ? `계정 갱신 실패 · ${accountsError} 이전 목록을 표시하고 있습니다. 새로고침 후 다시 조작하세요.` : ''; feedback.hidden = !accountsError; }

  const blockedCount = accounts.filter(accountBlocker).length;
  status.innerHTML = accounts.length
    ? `${accounts.length}개 계정 · <b class="ok">${accounts.length - blockedCount}개 선택 가능</b>${blockedCount ? ` · <b class="bad">${blockedCount}개 확인 필요</b>` : ''}`
    : `${esc(data.runtime || '로컬')} · 등록된 AI 계정이 없습니다. 계정 추가 항목을 펼치세요.`;

  const best = bestAccount(accounts);
  const bestButton = document.getElementById('ai-best-account');
  if (bestButton) {
    bestButton.hidden = !best;
    bestButton.disabled = Boolean(accountsError);
    if (best) {
      bestButton.dataset.accountId = best.id;
      const native = best.source==='cockpit' && best.authEngine==='jcode';
      const action = native ? (accountNeedsLogin(best) ? 'jcode 로그인' : 'jcode 새 세션') : `${best.provider==='claude'?'Claude Code':'Codex'} 새 세션`;
      bestButton.textContent = `${best.name} · ${action}`;
      const headroom = accountHeadroom(best);
      bestButton.title = headroom >= 0 ? `확인된 잔여량 ${Math.round(headroom)}% · ${action}` : `잔여량 정보 없음 · ${action}`;
    }
  }

  if (!accounts.length) {
    list.innerHTML = `<div class="ai-accounts-empty"><strong>계정을 찾지 못했습니다.</strong><span>새 계정을 추가하거나 허브(.codex-account-launcher) 프로필을 확인하세요.</span></div>`;
    return;
  }
  const defaults = new Set(defaultAccountIds(accounts, switchChoices));
  const shown = visibleAccounts(accounts, view).sort((a, b) => Number(defaults.has(b.id)) - Number(defaults.has(a.id)));
  if (switchChoices.length && !requestedAccountId) focusedAccountId = shown.find(account => defaults.has(account.id))?.id || shown.find(account => account.state === 'ready')?.id;
  if (!shown.length) {
    list.innerHTML = `<div class="ai-accounts-empty"><strong>조건에 맞는 계정이 없습니다.</strong><span><button class="btn" type="button" data-action="reset-ai-account-filter">필터 초기화</button></span></div>`;
    return;
  }
  list.innerHTML = shown.map(account => {
    const isCockpit = account.source === 'cockpit';
    const nativeMode = isCockpit && account.authEngine === 'jcode';
    const nativeLogin = nativeMode && accountNeedsLogin(account);
    const blocker = accountBlocker(account);
    const needsLogin = accountNeedsLogin(account);
    const usageIssue = accountUsageIssue(account);
    const refreshingUsage = refreshingUsageIds.has(account.id);
    const stateLabel = account.state === 'login' ? '로그인 필요' : needsLogin ? '다시 로그인 필요' : account.state === 'ready' ? '인증정보 있음' : '확인 필요';
    // 콕핏 내장 계정은 어떤 상태든 열 수 있음 — 미로그인이면 로그인 터미널, 만료 의심이면 재로그인
    // 허브 계정은 ready일 때만 (서버 resolveAiAccountLaunch가 warning에서 거부)
    const canOpen = (isCockpit || account.state === 'ready') && !(nativeMode && !account.jcodeSupported);
    const openLabel = nativeMode ? (nativeLogin ? 'jcode 로그인' : 'jcode 새 세션') : isCockpit && needsLogin ? (account.state === 'login' ? '로그인 터미널 열기' : '다시 로그인') : `${account.provider==='claude'?'Claude Code':'Codex'} 새 세션`;
    const loginCmd = account.provider === 'claude' ? 'claude auth login --claudeai' : 'codex login';
    const testing = testingIds.has(account.id);
    const testResult = testResults[account.id];
    // 공식 한도(usage.limits)가 있으면 로컬 토큰 집계·예산은 군더더기 — 숨김
    const hasLimits = [account.usage?.limits?.weekly?.remaining, account.usage?.limits?.session?.remaining].some(Number.isFinite);
    // 미로그인 계정은 로그인 안내만 — 사용량·예산은 로그인 뒤 의미 있음
    const usageUnverified = accountUsageUnverified(account);
    const showSessionMeter = Number.isFinite(account.sessionRemaining) || (!isCockpit && account.sessionResetAt);
    const noWeeklyData = !Number.isFinite(account.weeklyRemaining);
    const showBudgetHint = isCockpit && !needsLogin && account.provider === 'claude' && !account.weeklyTokenBudget && noWeeklyData;
    const showCollectingHint = isCockpit && account.weeklyTokenBudget && noWeeklyData;
    const showEmail = account.email && account.email !== account.name;
    // 로그인 필요는 상태 배지로 충분 — 한도 소진만 사유·풀림 시각 표시
    const blockerText = blocker && !needsLogin
      ? `${blocker.reason}${blocker.resetAt ? ` · ${resetLabel(blocker.resetAt).split('·')[0].trim()} 풀림` : ''}`
      : '';
    const sessionBlocker = accountSwitchBlocker(switchSession);
    const canSwitch = switchChoices.some(choice => choice.id === account.id && choice.available) && !blocker && !sessionBlocker && !refreshingUsage;
    const hasTarget = Boolean(switchSession);
    const linked = sessionChoices.filter(session => session.termId === switchSession?.termId
      ? defaults.has(account.id) : session.account?.id === account.id);
    return `<article class="ai-account-row ${esc(account.provider)}${blocker ? ' blocked' : ''}${focusedAccountId === account.id ? ' login-focused' : ''}" data-account-id="${esc(account.id)}" tabindex="-1">
      <div class="ai-account-identity">
        <span class="ai-account-mark" aria-hidden="true">${account.provider === 'claude' ? 'C' : 'X'}</span>
        <div>
          <h2>${esc(account.name)}</h2>
          ${showEmail ? `<p>${esc(account.email)}</p>` : ''}
          <div class="ai-account-meta">
            <span class="ai-account-state ${esc(needsLogin ? 'login' : account.state)}"${account.stateNote ? ` title="${esc(account.stateNote)}"` : ''}><i></i>${stateLabel}</span>
            <span>${esc(account.provider === 'claude' ? (account.authEngine === 'jcode' ? 'Claude' : 'Claude Code') : 'Codex')}${account.authEngine ? ` · ${account.authEngine === 'jcode' ? 'jcode 인증' : 'CLI 인증'}` : ''}</span>
            ${defaults.has(account.id) ? `<span class="ai-account-default">${account.provider === 'claude' ? 'Claude' : 'Codex'} 기본 로그인</span>` : ''}
            ${account.plan ? `<span>${esc(account.plan)}</span>` : ''}
            ${isCockpit ? '' : `<span>${esc(account.bridge)}</span>`}
          </div>
          ${linked.length ? `<div class="ai-account-linked-sessions">${linked.map(session => `<button class="btn" type="button" data-action="select-account-session" data-term-id="${esc(session.termId)}" ${accountSwitch?.pending || sessionsLoading ? 'disabled' : ''} title="${esc(session.alias || session.termId)} · ${session.termId === switchSession?.termId ? '저장된 기본 로그인' : '실행 시 지정한 계정'} · 이 세션의 계정 보기">${esc(session.alias || session.termId)} · ${session.termId === switchSession?.termId ? `${account.provider === 'claude' ? 'Claude' : 'Codex'} 기본` : '실행 설정'}</button>`).join('')}</div>` : ''}
          ${blockerText ? `<div class="ai-account-blocker">${esc(blockerText)}</div>` : ''}
        </div>
      </div>
      <div class="ai-account-limits">
        ${data.usageRefreshSupported ? `<div class="ai-account-cost"><strong>jcode 계정 기록 · API 환산 추정</strong><span>${esc(account.jcodeCost ? usageCostText(account.jcodeCost) : '기록 대기 · 계정을 확인한 요청 기록 없음')}</span><small>계정 기록을 지원하는 jcode로 시작한 요청부터 집계 · 최근 7일 · UTC · 일반 단가</small></div>${account.usage?.cost?.pricedRequests ? `<div class="ai-account-cost"><strong>Claude CLI 로컬 기록 · API 환산 추정</strong><span>${esc(usageCostText(account.usage.cost))}</span><small>jcode 기록과 별도 집계 · 실제 청구액과 다름</small></div>` : ''}` : ''}
        ${usageIssue ? `<p class="ai-account-usage-query" role="status">${esc(usageIssue)}</p>` : ''}
        ${needsLogin ? '' : usageUnverified
          ? '<div class="ai-account-nobudget"><strong>사용량 미확인</strong><small>공식 한도와 이 계정의 최근 로컬 기록을 확인하지 못했습니다.</small><small>새로고침 후에도 같으면 로그인 상태를 확인하세요.</small></div>'
          : showBudgetHint
          ? `<div class="ai-account-nobudget">주간 잔여량 — <strong>예산 미설정</strong><small>예산을 설정하면 사용량 %가 표시됩니다</small></div>`
          : showCollectingHint
            ? `<div class="ai-account-nobudget">주간 잔여량 — <strong>집계 중</strong><small>터미널 사용 기록이 쌓이면 표시됩니다</small></div>`
            : metric('주간', account.weeklyRemaining, account.weeklyResetAt)}
        ${showSessionMeter && !needsLogin ? metric('5시간', account.sessionRemaining, account.sessionResetAt) : ''}
        ${account.usage?.provider === 'claude' && !hasLimits && !needsLogin && !usageUnverified ? `<div class="ai-account-usage">주간 사용 ${fmtTokens(account.usage.weeklyTokens)}토큰${account.weeklyTokenBudget ? ` / ${fmtTokens(account.weeklyTokenBudget)} (예산)` : ''} · 5시간 ${fmtTokens(account.usage.sessionTokens)}토큰${account.usage.weeklyResetAt ? ` · 주간 풀림(추정) ${fmtReset(account.usage.weeklyResetAt)}` : ''}<small>콕핏 로컬 계산</small></div>` : ''}
        ${nativeLogin ? '<div class="ai-account-login-hint"><span>이 계정의 jcode 브라우저 로그인을 엽니다.</span><small>인증이 끝나면 같은 버튼에서 새 작업 세션을 열 수 있습니다.</small></div>' : isCockpit && needsLogin && !nativeMode ? `<div class="ai-account-login-hint"><span>로그인 터미널을 열면 자동 실행:</span><code>${loginCmd}</code><button class="btn" type="button" data-action="copy-login-cmd" data-cmd="${loginCmd}">복사</button><small>브라우저 인증 후 돌아오면 자동 갱신됩니다</small></div>` : ''}
        ${!isCockpit && account.state === 'login' ? `<div class="ai-account-login-hint"><span>허브 프로필에 로그인 정보가 없습니다.</span><small>허브(.codex-account-launcher) 도구에서 로그인하세요</small></div>` : ''}
        ${testResult ? `<div class="ai-account-test ${testResult.ok ? 'pass' : 'fail'}">${testResult.checks.map(c => `<div class="${c.ok ? 'ok' : 'bad'}"><b>${c.ok ? '✓' : '✗'}</b><span>${esc(c.label)}</span><em>${esc(c.detail)}</em></div>`).join('')}</div>` : ''}
        ${account.provider === 'claude' && (editingBudgetId === account.id || (!hasLimits && !needsLogin)) ? (editingBudgetId === account.id
          ? `<div class="ai-account-budget-edit"><input type="number" min="0" step="1" id="ai-budget-input" value="${account.weeklyTokenBudget ? Math.round(account.weeklyTokenBudget / 1e6) : 40}" aria-label="주간 토큰 예산 (백만 단위)"><span>M 토큰/주</span><button class="btn primary" type="button" data-action="save-ai-budget" data-account-id="${esc(account.id)}">저장</button><button class="btn" type="button" data-action="cancel-ai-budget">취소</button></div>`
          : `<button class="btn ai-account-budget" type="button" data-action="edit-ai-budget" data-account-id="${esc(account.id)}" title="공식 사용 한도와 별개인 로컬 토큰 예산">${account.weeklyTokenBudget ? '예산 변경' : '로컬 예산 설정'}</button>`) : ''}
      </div>
      <div class="ai-account-action">
        ${hasTarget ? `<button class="btn primary ai-account-switch-row" type="button" data-action="switch-ai-account" data-account-id="${esc(account.id)}" data-term-id="${esc(switchSession.termId)}" ${canSwitch && !accountSwitch?.pending && !sessionsLoading ? '' : 'disabled'}${sessionBlocker ? ` title="${esc(sessionBlocker)}"` : ''}>${esc(switchSession.alias || switchSession.termId)}${sessionBlocker ? ' · 전환 보류' : '에 전환'}</button>` : ''}
        ${requestedAccountId === account.id ? `<p class="wo-maint-status" role="status" data-ai-switch-status="${esc(account.id)}">${esc(switchMessage)}</p>` : ''}
        <button class="btn ${hasTarget || (blocker && account.state !== 'login') ? '' : 'primary'}" type="button" data-action="open-ai-account-terminal" data-account-id="${esc(account.id)}" ${canOpen ? '' : 'disabled'}>${openLabel}</button>
        ${isCockpit && !nativeMode && account.jcodeSupported ? `<button class="btn" type="button" data-action="open-ai-account-terminal" data-account-id="${esc(account.id)}" data-engine="jcode" title="이 계정의 jcode 전용 로그인을 연결합니다">jcode 연결 · 별도 로그인</button>` : ''}
        ${data.usageRefreshSupported && (usageIssue || usageUnverified || refreshingUsage) ? `<button class="btn" type="button" data-action="refresh-ai-usage" data-account-id="${esc(account.id)}" ${refreshingUsage || accountSwitch?.pending ? 'disabled' : ''}>${refreshingUsage ? '사용량 확인 중…' : '사용량 다시 조회'}</button>` : ''}
        ${isCockpit ? `<div class="ai-account-subactions">
          <button class="btn" type="button" data-action="test-ai-account" data-account-id="${esc(account.id)}" ${testing ? 'disabled' : ''}>${testing ? '테스트 중…' : '연결 테스트'}</button>
          <button class="btn danger" type="button" data-action="delete-ai-account" data-account-id="${esc(account.id)}" data-account-name="${esc(account.name)}">삭제</button>
        </div>` : ''}
      </div>
    </article>`;
  }).join('');
  const budgetInput = document.getElementById('ai-budget-input');
  if (budgetInput && editingBudgetDraft !== null) budgetInput.value = editingBudgetDraft;
  if (accountsError) list.querySelectorAll('button, input').forEach(control => { control.disabled = true; });
  restoreScroll();
  if (!focusWanted && active && focusedRow) {
    const row = [...list.children].find(item => item.dataset.accountId === focusedRow);
    const replacement = active.id === 'ai-budget-input' ? budgetInput : [...(row?.querySelectorAll('[data-action]') || [])].find(item => item.dataset.action === active.dataset.action && item.dataset.termId === active.dataset.termId && item.dataset.engine === active.dataset.engine);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  }
  if (focusWanted && focusedAccountId && switchChoices.length) {
    const active = document.activeElement;
    const editing = active?.matches('input, textarea, select');
    const row = [...list.children].find(item => item.dataset.accountId === focusedAccountId);
    if (row && !editing) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
    focusWanted = false;
  }
}

async function switchAccountRow(button) {
  if (accountsError || accountSwitch?.pending || sessionsLoading || refreshingUsageIds.has(button.dataset.accountId) || accountSwitchBlocker(switchSession)) return;
  if (button.dataset.termId !== switchSession?.termId) return;
  requestedAccountId = button.dataset.accountId;
  switchMessage = '';
  rerender();
  await accountSwitch.switchAccount(requestedAccountId);
}

export async function initAiAccounts() {
  bindSessionSwitch();
  refreshSessionChoices();
  populateProjects();
  bindFilterControls();
  ensureAutoRefresh();
  if (loading) return;
  loading = true;
  const status = document.getElementById('ai-accounts-status');
  if (status) status.textContent = '계정 정보를 불러오는 중…';
  try {
    const data = await fetchJson('/api/ai-accounts');
    accountsError = '';
    render(data);
    if (data.usageRefreshSupported && !data.jcodeCosts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (document.getElementById('ai-accounts-view')?.classList.contains('active')) {
        render(await fetchJson('/api/ai-accounts'));
      }
    }
  } catch (error) {
    accountsError = error.message || '계정 정보를 불러오지 못했습니다.';
    const list = document.getElementById('ai-account-list');
    if (lastData) render(lastData);
    else {
      if (status) status.textContent = `계정 조회 실패 · ${accountsError}`;
      if (list) list.innerHTML = '<div class="ai-accounts-empty">새로고침으로 계정 목록을 다시 불러오세요.</div>';
    }
  } finally {
    loading = false;
  }
}

function openAccountTerminal(button) {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
    showToast('터미널 서버가 연결되지 않았습니다.', 'error');
    return;
  }
  const projectId = document.getElementById('ai-account-project')?.value || '__home__';
  const account = (app.aiAccounts || []).find(a => a.id === button.dataset.accountId);
  const nativeMode = account?.source === 'cockpit' && (account.authEngine === 'jcode' || button.dataset.engine === 'jcode');
  // 미로그인 내장 계정은 로그인 명령을 터미널에서 자동 실행
  const loginMode = Boolean(account) && account.source === 'cockpit' && (accountNeedsLogin(account) || (nativeMode && account.authEngine !== 'jcode'));
  app.ws.send(JSON.stringify({
    type: 'create', projectId, accountId: button.dataset.accountId, cols: 120, rows: 30,
    ...(loginMode ? { loginMode: true } : {}),
    ...(nativeMode ? { engine: 'jcode' } : {}),
  }));
  notify('switchView', 'terminal');
  showToast(loginMode ? (nativeMode ? '이 계정의 jcode 로그인을 여는 중…' : '로그인 터미널을 여는 중 — 로그인 명령을 자동 실행합니다') : '선택한 계정으로 새 터미널을 여는 중…', 'info');
}

async function refreshUsage(button) {
  const id = button.dataset.accountId;
  if (accountsError || accountSwitch?.pending || refreshingUsageIds.has(id)) return;
  refreshingUsageIds.add(id);
  rerender();
  try {
    await postJson(`/api/ai-accounts/${encodeURIComponent(id)}/usage-refresh`, {});
    const deadline = Date.now() + 65_000;
    do {
      const data = await fetchJson('/api/ai-accounts', { timeoutMs: 8000 });
      accountsError = '';
      render(data);
      const account = data.accounts.find(account => account.id === id);
      if (!account || (account.usage?.query && account.usage.query.state !== 'loading')) break;
      if (!document.getElementById('ai-accounts-view')?.classList.contains('active')) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
  } catch (error) {
    showToast(`사용량 조회 실패 · ${error.message}`, 'error');
  } finally {
    refreshingUsageIds.delete(id);
    rerender();
  }
}

async function addAccount() {
  const nameInput = document.getElementById('ai-account-name');
  const emailInput = document.getElementById('ai-account-email');
  const providerSelect = document.getElementById('ai-account-provider');
  const name = nameInput?.value.trim();
  const email = emailInput?.value.trim();
  const provider = providerSelect?.value;
  if (!name) { showToast('계정 이름을 입력하세요.', 'warning'); nameInput?.focus(); return; }
  const nativeMode = lastData?.jcodeAccountsSupported === true;
  if (nativeMode && (!email || !emailInput.checkValidity())) { showToast('로그인할 계정 이메일을 입력하세요.', 'warning'); emailInput?.focus(); return; }
  try {
    await postJson('/api/ai-accounts', { name, provider, email, ...(nativeMode ? {engine:'jcode'} : {}) });
    showToast(`${provider === 'claude' ? 'Claude' : 'Codex'} 계정 "${name}" 추가 — 로그인 터미널을 열어 로그인하세요.`, 'success');
    if (nameInput) nameInput.value = '';
    if (emailInput) emailInput.value = '';
    await initAiAccounts();
  } catch (error) {
    showToast(error.message || '계정을 추가하지 못했습니다.', 'error');
  }
}

async function deleteAccount(button) {
  const name = button.dataset.accountName || '이 계정';
  if (!confirm(`"${name}" 계정을 삭제할까요? 콕핏이 만든 로그인 정보도 함께 삭제됩니다.\n이 계정으로 열린 터미널이 있으면 로그인이 풀려 동작이 멈출 수 있습니다.`)) return;
  try {
    const result = await fetchJson(`/api/ai-accounts/${button.dataset.accountId}`, { method: 'DELETE' });
    showToast(result.cleanupWarning || `계정 "${name}" 삭제됨`, result.cleanupWarning ? 'warning' : 'success');
    await initAiAccounts();
  } catch (error) {
    showToast(error.message || '삭제하지 못했습니다.', 'error');
  }
}

async function copyLoginCmd(button) {
  const ok = await copyText(button.dataset.cmd || '');
  showToast(ok ? '로그인 명령 복사됨 — 로그인 터미널에 붙여넣으세요' : '복사 실패', ok ? 'success' : 'error');
}

async function testAccount(button) {
  const id = button.dataset.accountId;
  if (testingIds.has(id)) return;
  testingIds.add(id);
  rerender();
  try {
    const result = await postJson(`/api/ai-accounts/${id}/test`, {}, { timeoutMs: 45_000 });
    testResults[id] = result;
    const failed = (result.checks || []).filter(c => !c.ok);
    showToast(
      result.ok ? '연결 테스트 통과'
        : `연결 테스트 실패: ${failed.map(c => c.label).join(', ')}`,
      result.ok ? 'success' : 'error',
    );
    await initAiAccounts(); // 상태 배지도 최신으로
    rerender(); // initAiAccounts가 render를 덮어쓰므로 결과 다시 표시
  } catch (error) {
    showToast(error.message || '테스트 실패', 'error');
  } finally {
    testingIds.delete(id);
    rerender();
  }
}

async function saveBudget(button) {
  const id = button.dataset.accountId;
  const input = document.getElementById('ai-budget-input');
  const m = Math.round(parseFloat(input?.value));
  if (!Number.isFinite(m) || m < 0) { showToast('숫자를 입력하세요.', 'warning'); return; }
  try {
    await postJson(`/api/ai-accounts/${id}/budget`, { weeklyTokenBudget: m * 1_000_000 });
    showToast(m ? `예산 ${m}M 토큰 설정 — 잔여량 %가 표시됩니다` : '예산 해제', 'success');
    editingBudgetId = null;
    editingBudgetDraft = null;
    await initAiAccounts();
  } catch (error) {
    showToast(error.message || '예산 설정 실패', 'error');
  }
}

registerClickActions({
  'refresh-ai-accounts': initAiAccounts,
  'refresh-ai-usage': refreshUsage,
  'switch-ai-account': switchAccountRow,
  'select-account-session': selectAccountSession,
  'open-ai-account-terminal': openAccountTerminal,
  'add-ai-account': addAccount,
  'delete-ai-account': deleteAccount,
  'copy-login-cmd': copyLoginCmd,
  'test-ai-account': testAccount,
  'edit-ai-budget': button => { editingBudgetId = button.dataset.accountId; editingBudgetDraft = null; rerender(); },
  'save-ai-budget': saveBudget,
  'cancel-ai-budget': () => { editingBudgetId = null; editingBudgetDraft = null; rerender(); },
  'ai-account-provider-filter': button => setView({ provider: button.dataset.value }),
  'reset-ai-account-filter': () => {
    const search = document.getElementById('ai-account-search');
    if (search) search.value = '';
    setView({ ...DEFAULT_VIEW });
  },
});
