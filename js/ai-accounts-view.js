// AI 계정 목록의 순수 로직 — 사용 가능 판정, 정렬, 필터 (DOM 무관, 테스트 대상)

export function accountSwitchBlocker(session) {
  if (!session) return '';
  const state = session.activity?.state;
  if (state === 'busy') return '작업 중입니다. 작업이 끝나면 새로고침해서 전환하세요.';
  if (state === 'approval') return '승인·로그인 대기 중입니다. 터미널에서 처리한 뒤 새로고침하세요.';
  if (['unknown', 'offline', 'restarting'].includes(state)) return '세션 연결 상태를 확인한 뒤 새로고침하세요.';
  return '';
}

export function accountUsageUnverified(account) {
  if (account.state === 'login' || account.usage?.lastActiveAt || account.usage?.weeklyTokens > 0) return false;
  const missingQuota = !Number.isFinite(account.weeklyRemaining) && !Number.isFinite(account.sessionRemaining);
  const officialQuota = [account.usage?.limits?.weekly?.remaining, account.usage?.limits?.session?.remaining].some(Number.isFinite);
  const emptyLocalEstimate = account.source === 'cockpit' && account.usage?.provider === 'claude' && !officialQuota;
  return missingQuota || emptyLocalEstimate;
}

export function accountNeedsLogin(account) {
  return account.state === 'login' || account.usage?.authenticationRejected === true || ['login_required', 'scope_required'].includes(account.usage?.query?.code);
}

export function accountUsageIssue(account) {
  if (account.usage?.query?.state !== 'error') return '';
  const messages = {
    login_required: '저장된 로그인이 만료되었거나 해제됐습니다. 다시 로그인하세요.',
    scope_required: '현재 로그인에 사용량 조회 권한이 부족합니다. 다시 로그인하세요.',
    configuration_error: '인증 갱신 설정을 확인하지 못했습니다.',
    permission_denied: '사용량 조회 권한이 거부됐습니다. 계정 권한을 확인하세요.',
    rate_limited: '공급자가 사용량 조회를 일시 제한했습니다. 잠시 후 다시 조회하세요.',
    network_error: '공급자 서버에 연결하지 못했습니다. 다시 조회하세요.',
    credential_unavailable: '로그인 파일을 읽지 못했습니다. 로그인 상태를 확인하세요.',
  };
  return messages[account.usage.query.code] || '사용량 응답을 확인하지 못했습니다. 다시 조회하세요.';
}

export function usageCostText(cost) {
  const priced = Number.isSafeInteger(cost?.pricedRequests) && cost.pricedRequests > 0;
  if (!priced || !Number.isFinite(cost.weekUsd) || cost.weekUsd < 0) return cost?.unpricedRequests > 0
    ? `금액 미산정 · 토큰·단가 정보 부족 ${cost.unpricedRequests}건` : '금액 미산정 · 계산 가능한 사용 기록 없음';
  const usd = value => value > 0 && value < 0.01 ? '<$0.01' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const today = Number.isFinite(cost.todayUsd) && cost.todayUsd >= 0 ? `오늘 ${usd(cost.todayUsd)} · ` : '';
  return `${today}최근 7일 ${usd(cost.weekUsd)} · 계산 가능 ${cost.pricedRequests}건${cost.unpricedRequests > 0 ? ` · 정보 부족 ${cost.unpricedRequests}건 제외` : ''}`;
}

/** 지금 이 계정을 못 쓰는 이유. 쓸 수 있으면 null. 퍼센트를 모르면 막지 않음 */
export function accountBlocker(account) {
  if (account.state === 'login') return { reason: '로그인 필요', resetAt: '' };
  if (accountNeedsLogin(account)) return { reason: '로그인 갱신 필요', resetAt: '' };
  if (account.source && account.source !== 'cockpit' && account.state === 'warning') return { reason: '로그인 정보 확인 필요', resetAt: '' };
  if (Number.isFinite(account.weeklyRemaining) && account.weeklyRemaining <= 0) {
    return { reason: '주간 한도 소진', resetAt: account.weeklyResetAt || '' };
  }
  if (Number.isFinite(account.sessionRemaining) && account.sessionRemaining <= 0) {
    return { reason: '5시간 한도 소진', resetAt: account.sessionResetAt || '' };
  }
  return null;
}

/** 여유량 — 알려진 창 중 가장 빠듯한 값. 모르면 -1 */
export function accountHeadroom(account) {
  if (accountUsageUnverified(account)) return -1;
  const known = [account.weeklyRemaining, account.sessionRemaining].filter(Number.isFinite);
  return known.length ? Math.min(...known) : -1;
}

// 막힌 계정은 풀리는 시각, 아니면 주간 리셋 시각
function nextResetMs(account) {
  const t = Date.parse(accountBlocker(account)?.resetAt || account.weeklyResetAt || '');
  return Number.isFinite(t) ? t : Infinity;
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name));
const aliveFirst = (a, b) => Number(Boolean(accountBlocker(a))) - Number(Boolean(accountBlocker(b)));

const SORTS = {
  headroom: (a, b) => aliveFirst(a, b) || accountHeadroom(b) - accountHeadroom(a) || byName(a, b),
  reset: (a, b) => nextResetMs(a) - nextResetMs(b) || byName(a, b),
  name: byName,
  provider: (a, b) => String(a.provider).localeCompare(String(b.provider)) || SORTS.headroom(a, b),
};

export const DEFAULT_VIEW = { sort: 'headroom', provider: 'all', aliveOnly: false, query: '' };

export function defaultAccountIds(accounts, choices) {
  const email = value => String(value || '').trim().toLowerCase();
  return accounts.filter(account => choices.some(choice => choice.isDefault && choice.available
    && choice.provider === (account.provider === 'codex' ? 'openai' : account.provider)
    && ((choice.source === 'cockpit' && choice.id === account.id)
      || (choice.source === 'jcode' && email(choice.email) && email(choice.email) === email(account.email)))))
    .map(account => account.id);
}

/** 필터 + 정렬 적용한 새 배열 */
export function visibleAccounts(accounts, view = DEFAULT_VIEW) {
  const query = String(view.query || '').trim().toLowerCase();
  return accounts
    .filter(a => view.provider === 'all' || !view.provider || a.provider === view.provider)
    .filter(a => !view.aliveOnly || !accountBlocker(a))
    .filter(a => !query || `${a.name} ${a.email}`.toLowerCase().includes(query))
    .sort(SORTS[view.sort] || SORTS.headroom);
}

/** 지금 바로 쓰기 가장 여유 있는 계정 (없으면 null) */
export function bestAccount(accounts) {
  return visibleAccounts(accounts, { ...DEFAULT_VIEW, aliveOnly: true })[0] || null;
}
