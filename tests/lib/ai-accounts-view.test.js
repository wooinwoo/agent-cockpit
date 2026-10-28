import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBlocker, accountSwitchBlocker, accountUsageUnverified, accountNeedsLogin, accountUsageIssue, usageCostText, accountHeadroom, bestAccount, visibleAccounts, defaultAccountIds } from '../../js/ai-accounts-view.js';

const acc = (name, extra = {}) => ({ name, email: `${name}@x.com`, provider: 'claude', state: 'ready', weeklyRemaining: null, sessionRemaining: null, weeklyResetAt: '', sessionResetAt: '', ...extra });

test('rejected saved logins cannot be recommended; provider errors keep actionable causes', () => {
  for (const code of ['login_required','scope_required']) {
    const account = acc('expired', { weeklyRemaining: 100, usage: { query: { state: 'error', code } } });
    assert.equal(accountNeedsLogin(account),true);
    assert.ok(accountBlocker(account));
    assert.equal(bestAccount([account]),null);
    assert.match(accountUsageIssue(account),/다시 로그인/);
  }
  assert.match(accountUsageIssue(acc('network',{usage:{query:{state:'error',code:'network_error'}}})),/서버에 연결/);
  assert.match(accountUsageIssue(acc('permission',{usage:{query:{state:'error',code:'permission_denied'}}})),/권한이 거부/);
  const retrying = acc('retrying',{usage:{authenticationRejected:true,query:{state:'loading'}}});
  assert.equal(accountNeedsLogin(retrying),true);
  assert.equal(bestAccount([retrying]),null);
});

test('cost summaries distinguish missing, partial, small and measured zero amounts', () => {
  assert.doesNotMatch(usageCostText(null),/\$0/);
  assert.match(usageCostText({weekUsd:0,pricedRequests:0,unpricedRequests:9}),/미산정/);
  assert.match(usageCostText({weekUsd:3,todayUsd:0,pricedRequests:2,unpricedRequests:1}),/오늘 \$0.00.*최근 7일 \$3.00.*1건 제외/);
  assert.match(usageCostText({weekUsd:0.001,pricedRequests:1}),/<\$0.01/);
  assert.doesNotMatch(usageCostText({weekUsd:-1,pricedRequests:1}),/\$/);
});

test('account switching shows why busy, approval and disconnected sessions must wait', () => {
  for (const state of ['busy', 'approval', 'offline', 'restarting', 'unknown']) {
    assert.ok(accountSwitchBlocker({ activity: { state } }));
  }
  for (const state of ['idle', 'limited']) assert.equal(accountSwitchBlocker({ activity: { state } }), '');
  assert.equal(accountSwitchBlocker(null), '');
});

test('missing history cannot turn a local budget into verified 100 percent headroom', () => {
  const empty = acc('empty', { source: 'cockpit', weeklyRemaining: 100, usage: { provider: 'claude', weeklyTokens: 0, lastActiveAt: '', limits: null } });
  const measured = acc('measured', { weeklyRemaining: 30 });
  assert.equal(accountUsageUnverified(empty), true);
  assert.equal(accountHeadroom(empty), -1);
  assert.equal(bestAccount([empty, measured]).name, 'measured');
  for (const limits of [{}, { weekly: null, session: null }]) assert.equal(accountUsageUnverified({ ...empty, usage: { ...empty.usage, limits } }), true);
  assert.equal(accountUsageUnverified({ ...empty, usage: { ...empty.usage, limits: { weekly: { remaining: 100 } } } }), false);
  assert.equal(accountUsageUnverified({ ...empty, usage: { ...empty.usage, weeklyTokens: 20, lastActiveAt: '2026-10-16T00:00:00Z' } }), false);
});

test('blocker: login, exhausted weekly/session, unknown stays alive', () => {
  assert.equal(accountBlocker(acc('a', { state: 'login' })).reason, '로그인 필요');
  assert.deepEqual(accountBlocker(acc('a', { weeklyRemaining: 0, weeklyResetAt: 'W' })), { reason: '주간 한도 소진', resetAt: 'W' });
  assert.equal(accountBlocker(acc('a', { weeklyRemaining: 30, sessionRemaining: 0 })).reason, '5시간 한도 소진');
  assert.equal(accountBlocker(acc('a')), null);
  assert.equal(accountHeadroom(acc('a', { weeklyRemaining: 30, sessionRemaining: 70 })), 30);
  assert.equal(accountHeadroom(acc('a')), -1);
});

test('sort by headroom puts blocked last; filters combine', () => {
  const list = [
    acc('dead', { weeklyRemaining: 0, sessionRemaining: 90 }),
    acc('low', { weeklyRemaining: 20, sessionRemaining: 90 }),
    acc('high', { weeklyRemaining: 80, sessionRemaining: 90 }),
    acc('cx', { provider: 'codex', weeklyRemaining: 50 }),
    acc('nologin', { state: 'login' }),
  ];
  assert.deepEqual(visibleAccounts(list).map(a => a.name), ['high', 'cx', 'low', 'dead', 'nologin']);
  assert.deepEqual(visibleAccounts(list, { sort: 'name', aliveOnly: true }).map(a => a.name), ['cx', 'high', 'low']);
  assert.deepEqual(visibleAccounts(list, { provider: 'codex' }).map(a => a.name), ['cx']);
  assert.deepEqual(visibleAccounts(list, { query: 'LO' }).map(a => a.name), ['low', 'nologin']);
  assert.equal(list[0].name, 'dead'); // 원본 배열 불변
  assert.equal(bestAccount(list).name, 'high');
  assert.equal(bestAccount([list[0]]), null);
});

test('sort by reset: soonest first, unknown last', () => {
  const list = [
    acc('none'),
    acc('late', { weeklyResetAt: '2026-09-20T00:00:00Z' }),
    acc('blockedSoon', { sessionRemaining: 0, sessionResetAt: '2026-09-16T10:00:00Z', weeklyResetAt: '2026-09-21T00:00:00Z' }),
  ];
  assert.deepEqual(visibleAccounts(list, { sort: 'reset' }).map(a => a.name), ['blockedSoon', 'late', 'none']);
});

test('hub warnings are not recommended when the launcher only accepts ready profiles', () => {
  const warning = acc('hub-warning', { source: 'hub', state: 'warning', weeklyRemaining: 100 });
  const ready = acc('ready', { source: 'hub', weeklyRemaining: 30 });
  assert.equal(accountBlocker(warning).reason, '로그인 정보 확인 필요');
  assert.equal(bestAccount([warning, ready]).name, 'ready');
  assert.equal(accountBlocker(acc('local-warning', { source: 'cockpit', state: 'warning' })), null);
});

test('default login matches verified IDs or provider-specific emails without guessing empty identities', () => {
  const rows = [acc('a', { id: 'a' }), acc('b', { id: 'b', provider: 'codex', email: 'a@x.com' }), acc('c', { id: 'c', email: '' })];
  assert.deepEqual(defaultAccountIds(rows, [{ source: 'jcode', provider: 'claude', email: ' A@X.COM ', isDefault: true, available: true }]), ['a']);
  assert.deepEqual(defaultAccountIds(rows, [{ source: 'cockpit', id: 'b', provider: 'openai', isDefault: true, available: true }]), ['b']);
  assert.deepEqual(defaultAccountIds(rows, [{ source: 'jcode', provider: 'claude', email: '', isDefault: true, available: true }]), []);
  assert.deepEqual(defaultAccountIds(rows, [{ source: 'cockpit', id: 'a', provider: 'claude', isDefault: true, available: false }]), []);
});
