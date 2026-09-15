import { app, notify } from './state.js';
import { registerClickActions } from './actions.js';
import { copyText, esc, fetchJson, postJson, showToast, timeAgo } from './utils.js';

let loading = false;
let lastData = null;
// 연결 테스트 결과 캐시 (id → { ok, checks }) — 재조회해도 유지
const testResults = {};
const testingIds = new Set();
let editingBudgetId = null;

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

function metric(label, value, resetAt, tone) {
  const known = Number.isFinite(value);
  const width = known ? Math.max(0, Math.min(100, value)) : 0;
  const resetParts = resetLabel(resetAt).split('·');
  const relative = resetParts[0]?.trim() || '';
  const absolute = resetParts[1]?.trim() || '';
  // 리셋 시각은 퍼센트와 무관하게 항상 노출 — 퍼센트만 모를 땐 시각 정보가 더 중요
  const resetText = resetAt
    ? `${relative}${absolute ? ` <i class="abs">${absolute}</i>` : ''}`
    : (known ? '' : '정보 없음');
  return `<div class="ai-account-metric">
    <div><span>${label}</span><strong>${remaining(value)}</strong></div>
    <div class="ai-account-meter" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" ${known ? `aria-valuenow="${Math.round(width)}"` : 'aria-valuetext="정보 없음"'}>
      <span class="${tone}" style="width:${width}%"></span>
    </div>
    <small>${resetText}</small>
  </div>`;
}

function render(data) {
  const list = document.getElementById('ai-account-list');
  const status = document.getElementById('ai-accounts-status');
  if (!list || !status) return;
  lastData = data;
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  app.aiAccounts = accounts;
  const ready = accounts.filter(account => account.state === 'ready').length;
  status.textContent = accounts.length
    ? `${data.runtime} · ${accounts.length}개 계정 · ${ready}개 실행 가능`
    : `${data.runtime || '로컬'} · 등록된 AI 계정이 없습니다. 위에서 계정을 추가하세요.`;
  if (!accounts.length) {
    list.innerHTML = `<div class="ai-accounts-empty"><strong>계정을 찾지 못했습니다.</strong><span>새 계정을 추가하거나 허브(.codex-account-launcher) 프로필을 확인하세요.</span></div>`;
    return;
  }
  list.innerHTML = accounts.map(account => {
    const isCockpit = account.source === 'cockpit';
    const stateLabel = account.state === 'ready' ? '사용 가능' : account.state === 'warning' ? '확인 필요' : '로그인 필요';
    // 콕핏 내장 계정은 어떤 상태든 열 수 있음 — 미로그인이면 로그인 터미널, 만료 의심이면 재로그인
    // 허브 계정은 ready일 때만 (서버 resolveAiAccountLaunch가 warning에서 거부)
    const canOpen = isCockpit || account.state === 'ready';
    const openLabel = isCockpit && account.state === 'login' ? '로그인 터미널 열기' : '터미널 열기';
    const loginCmd = account.provider === 'claude' ? 'claude login' : 'codex login';
    const testing = testingIds.has(account.id);
    const testResult = testResults[account.id];
    // 콕핏 계정은 주간 예산 기준으로만 %를 앎 — 5시간 미터는 데이터가 없으니 숨김
    const showSessionMeter = !isCockpit && (Number.isFinite(account.sessionRemaining) || account.sessionResetAt);
    const noWeeklyData = !Number.isFinite(account.weeklyRemaining);
    const showBudgetHint = isCockpit && !account.weeklyTokenBudget && noWeeklyData;
    const showCollectingHint = isCockpit && account.weeklyTokenBudget && noWeeklyData;
    return `<article class="ai-account-row ${esc(account.provider)}">
      <div class="ai-account-identity">
        <span class="ai-account-mark" aria-hidden="true">${account.provider === 'claude' ? 'C' : 'X'}</span>
        <div><h2>${esc(account.name)}</h2><p>${esc(account.email || account.provider)}</p></div>
      </div>
      <div class="ai-account-meta">
        <span>${esc(account.provider === 'claude' ? 'Claude Code' : 'Codex')}</span>
        ${account.plan ? `<span>${esc(account.plan)}</span>` : ''}
        <span>${esc(account.bridge)}</span>
      </div>
      <div class="ai-account-limits">
        ${showBudgetHint
          ? `<div class="ai-account-nobudget">주간 잔여량 — <strong>예산 미설정</strong><small>예산을 설정하면 사용량 %가 표시됩니다</small></div>`
          : showCollectingHint
            ? `<div class="ai-account-nobudget">주간 잔여량 — <strong>집계 중</strong><small>터미널 사용 기록이 쌓이면 표시됩니다</small></div>`
            : metric('주간 잔여량', account.weeklyRemaining, account.weeklyResetAt, 'weekly')}
        ${showSessionMeter ? metric('5시간 잔여량', account.sessionRemaining, account.sessionResetAt, 'session') : ''}
        ${account.usage ? `<div class="ai-account-usage">주간 사용 ${fmtTokens(account.usage.weeklyTokens)}토큰${account.weeklyTokenBudget ? ` / ${fmtTokens(account.weeklyTokenBudget)} (예산)` : ''} · 5시간 ${fmtTokens(account.usage.sessionTokens)}토큰${account.usage.weeklyResetAt ? ` · 주간 풀림(추정) ${fmtReset(account.usage.weeklyResetAt)}` : ''}<small>콕핏 로컬 계산</small></div>` : ''}
        ${isCockpit && account.state === 'login' ? `<div class="ai-account-login-hint"><span>로그인 터미널을 열면 자동 실행:</span><code>${loginCmd}</code><button class="btn" type="button" data-action="copy-login-cmd" data-cmd="${loginCmd}">복사</button><small>브라우저 인증 후 돌아오면 자동 갱신됩니다</small></div>` : ''}
        ${!isCockpit && account.state === 'login' ? `<div class="ai-account-login-hint"><span>허브 프로필에 로그인 정보가 없습니다.</span><small>허브(.codex-account-launcher) 도구에서 로그인하세요</small></div>` : ''}
        ${testResult ? `<div class="ai-account-test ${testResult.ok ? 'pass' : 'fail'}">${testResult.checks.map(c => `<div><b>${c.ok ? '✓' : '✗'}</b> ${esc(c.label)} — ${esc(c.detail)}</div>`).join('')}</div>` : ''}
        ${account.provider === 'claude' ? (editingBudgetId === account.id
          ? `<div class="ai-account-budget-edit"><input type="number" min="0" step="1" id="ai-budget-input" value="${account.weeklyTokenBudget ? Math.round(account.weeklyTokenBudget / 1e6) : 40}" aria-label="주간 토큰 예산 (백만 단위)"><span>M 토큰/주</span><button class="btn primary" type="button" data-action="save-ai-budget" data-account-id="${esc(account.id)}">저장</button><button class="btn" type="button" data-action="cancel-ai-budget">취소</button></div>`
          : `<button class="btn ai-account-budget" type="button" data-action="edit-ai-budget" data-account-id="${esc(account.id)}" title="주간 토큰 예산 — 잔여량 % 기준">${account.weeklyTokenBudget ? '예산 변경' : '예산 설정'}</button>`) : ''}
      </div>
      <div class="ai-account-action">
        <span class="ai-account-state ${esc(account.state)}"${account.stateNote ? ` title="${esc(account.stateNote)}"` : ''}><i></i>${stateLabel}</span>
        <button class="btn primary" type="button" data-action="open-ai-account-terminal" data-account-id="${esc(account.id)}" ${canOpen ? '' : 'disabled'}>${openLabel}</button>
        ${isCockpit ? `<button class="btn" type="button" data-action="test-ai-account" data-account-id="${esc(account.id)}" ${testing ? 'disabled' : ''}>${testing ? '테스트 중…' : '연결 테스트'}</button>` : ''}
        ${isCockpit ? `<button class="btn" type="button" data-action="delete-ai-account" data-account-id="${esc(account.id)}" data-account-name="${esc(account.name)}">삭제</button>` : ''}
      </div>
    </article>`;
  }).join('');
}

export async function initAiAccounts() {
  populateProjects();
  ensureAutoRefresh();
  if (loading) return;
  loading = true;
  const status = document.getElementById('ai-accounts-status');
  if (status) status.textContent = '계정 정보를 불러오는 중…';
  try {
    render(await fetchJson('/api/ai-accounts'));
  } catch (error) {
    if (status) status.textContent = error.message || '계정 정보를 불러오지 못했습니다.';
    const list = document.getElementById('ai-account-list');
    if (list) list.innerHTML = '';
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
  // 미로그인 내장 계정은 로그인 명령을 터미널에서 자동 실행
  const loginMode = Boolean(account) && account.source === 'cockpit' && account.state === 'login';
  app.ws.send(JSON.stringify({
    type: 'create', projectId, accountId: button.dataset.accountId, cols: 120, rows: 30,
    ...(loginMode ? { loginMode: true } : {}),
  }));
  notify('switchView', 'terminal');
  showToast(loginMode ? '로그인 터미널을 여는 중 — 로그인 명령을 자동 실행합니다' : '선택한 계정으로 새 터미널을 여는 중…', 'info');
}

async function addAccount() {
  const nameInput = document.getElementById('ai-account-name');
  const emailInput = document.getElementById('ai-account-email');
  const providerSelect = document.getElementById('ai-account-provider');
  const name = nameInput?.value.trim();
  const email = emailInput?.value.trim();
  const provider = providerSelect?.value;
  if (!name) { showToast('계정 이름을 입력하세요.', 'warning'); nameInput?.focus(); return; }
  try {
    await postJson('/api/ai-accounts', { name, provider, email });
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
    await fetchJson(`/api/ai-accounts/${button.dataset.accountId}`, { method: 'DELETE' });
    showToast(`계정 "${name}" 삭제됨`, 'success');
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
    const result = await postJson(`/api/ai-accounts/${id}/test`, {});
    testResults[id] = result;
    const failed = (result.checks || []).filter(c => !c.ok);
    showToast(
      result.ok ? '연결 테스트 통과 — 이 계정으로 작업 가능합니다'
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
    await initAiAccounts();
  } catch (error) {
    showToast(error.message || '예산 설정 실패', 'error');
  }
}

registerClickActions({
  'refresh-ai-accounts': initAiAccounts,
  'open-ai-account-terminal': openAccountTerminal,
  'add-ai-account': addAccount,
  'delete-ai-account': deleteAccount,
  'copy-login-cmd': copyLoginCmd,
  'test-ai-account': testAccount,
  'edit-ai-budget': button => { editingBudgetId = button.dataset.accountId; rerender(); },
  'save-ai-budget': saveBudget,
  'cancel-ai-budget': () => { editingBudgetId = null; rerender(); },
});
