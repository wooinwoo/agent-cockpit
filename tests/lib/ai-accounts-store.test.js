import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA_DIR은 config.js 로드 시 고정되므로 임시 디렉터리로 리다이렉트 후 동적 import
const tempRoot = await mkdtemp(join(tmpdir(), 'cockpit-ai-store-'));
process.env.LOCALAPPDATA = tempRoot;
const DATA_DIR = join(tempRoot, 'cockpit');
mkdirSync(DATA_DIR, { recursive: true });

const {
  listStoredAccounts, createStoredAccount, deleteStoredAccount, resolveStoredLaunch,
  setAccountBudget, getAccountBudget, estimateRemaining, credentialState, storedAccountsRoot,
  checkStoredAccountLogin, loginCommandFor,
} = await import('../../lib/ai-accounts-store.js');

test('creates an account with a cockpit-owned credential dir', () => {
  const record = createStoredAccount({ name: '개인 Claude', provider: 'claude' });
  assert.match(record.id, /^[a-f0-9]{16}$/);
  assert.equal(record.provider, 'claude');
  assert.ok(existsSync(record.homePath));
  assert.ok(record.homePath.includes(join(DATA_DIR, 'ai-accounts')));
  // 세션 상호 통신 스킬이 계정 디렉터리에 심겼는지(원본이 있는 환경에서만 단정)
  const skillSrc = new URL('../../.claude/skills/cockpit-session/SKILL.md', import.meta.url);
  if (existsSync(skillSrc)) {
    assert.equal(existsSync(join(record.homePath, 'skills', 'cockpit-session', 'SKILL.md')), true);
  }

  const accounts = listStoredAccounts();
  const created = accounts.find(a => a.id === record.id);
  assert.equal(created.state, 'login'); // credential 없으면 로그인 필요
  assert.equal(created.source, 'cockpit');
});

test('rejects invalid input and duplicate names', () => {
  assert.throws(() => createStoredAccount({ name: '  ', provider: 'claude' }), /이름/);
  assert.throws(() => createStoredAccount({ name: 'x', provider: 'gpt' }), /provider/);
  assert.throws(() => createStoredAccount({ name: '개인 Claude', provider: 'claude' }), /이미/);
});

test('resolveStoredLaunch allows pre-login spawn then reports ready after login', () => {
  const record = createStoredAccount({ name: 'corp codex', provider: 'codex' });
  // 미로그인 상태에서도 스폰 가능 — 터미널 안에서 로그인하는 흐름
  const early = resolveStoredLaunch(record.id);
  assert.equal(early.envKey, 'CODEX_HOME');
  assert.equal(early.envValue, record.homePath);
  writeFileSync(join(record.homePath, 'auth.json'), '{}');

  const launch = resolveStoredLaunch(record.id);
  assert.equal(launch.command, 'codex');
  assert.equal(launch.translateForWsl, false);

  // 로그인 후 상태 목록에도 ready 반영
  assert.equal(listStoredAccounts().find(a => a.id === record.id).state, 'ready');
  assert.throws(() => resolveStoredLaunch('nope'), /Invalid/);
});

test('credentialState reflects token expiry and refresh staleness', () => {
  const claudeAcct = createStoredAccount({ name: '만료 의심 Claude', provider: 'claude' });
  // credential 없음 → login
  assert.equal(credentialState('claude', claudeAcct.homePath).state, 'login');

  // 액세스 토큰 만료 → warning
  writeFileSync(join(claudeAcct.homePath, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { expiresAt: new Date(Date.now() - 86_400_000).toISOString() },
  }));
  assert.equal(credentialState('claude', claudeAcct.homePath).state, 'warning');
  assert.equal(listStoredAccounts().find(a => a.id === claudeAcct.id).state, 'warning');

  // 만료 미래 → ready
  writeFileSync(join(claudeAcct.homePath, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  }));
  assert.equal(credentialState('claude', claudeAcct.homePath).state, 'ready');

  // expiresAt 없으면 파일 존재만으로 ready
  writeFileSync(join(claudeAcct.homePath, '.credentials.json'), '{}');
  assert.equal(credentialState('claude', claudeAcct.homePath).state, 'ready');

  const codexAcct = createStoredAccount({ name: '낡은 codex', provider: 'codex' });
  // last_refresh 30일+ → warning
  writeFileSync(join(codexAcct.homePath, 'auth.json'), JSON.stringify({
    last_refresh: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  }));
  assert.equal(credentialState('codex', codexAcct.homePath).state, 'warning');
  // 최근 갱신 → ready
  writeFileSync(join(codexAcct.homePath, 'auth.json'), JSON.stringify({
    last_refresh: new Date().toISOString(),
  }));
  assert.equal(credentialState('codex', codexAcct.homePath).state, 'ready');
  assert.ok(storedAccountsRoot().includes('ai-accounts'));
});

test('checkStoredAccountLogin reports a checklist without spending tokens', async () => {
  assert.equal(loginCommandFor('claude'), 'claude login');
  assert.equal(loginCommandFor('codex'), 'codex login');

  const acct = createStoredAccount({ name: '연결 테스트', provider: 'codex', email: 'test@example.com' });
  assert.equal(acct.email, 'test@example.com');
  assert.equal(listStoredAccounts().find(a => a.id === acct.id).email, 'test@example.com');

  // 파일 없음 → CLI 실행 없이 login
  let mustNotRun = false;
  let r = await checkStoredAccountLogin(acct.id, { run: async () => { mustNotRun = true; return {}; } });
  assert.equal(mustNotRun, false);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'login');
  assert.equal(r.checks.length, 1);

  // 파일 있음 + CLI 성공 → ok
  writeFileSync(join(acct.homePath, 'auth.json'), JSON.stringify({ last_refresh: new Date().toISOString() }));
  const okRun = async (cmd, args, env) => {
    assert.equal(cmd, 'codex');
    assert.deepEqual(args, ['login', 'status']);
    assert.equal(env.CODEX_HOME, acct.homePath);
    return { error: null, stdout: 'Logged in using ChatGPT\n', stderr: '' };
  };
  r = await checkStoredAccountLogin(acct.id, { run: okRun });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'ready');
  assert.equal(r.checks.length, 3);
  assert.ok(r.checks.every(c => c.ok));

  // CLI 실패 → ok false, 체크별 원인 포함
  r = await checkStoredAccountLogin(acct.id, {
    run: async () => ({ error: new Error('Command failed'), stdout: '', stderr: 'Not logged in' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.checks[2].ok, false);
  assert.match(r.checks[2].detail, /Not logged in/);

  // 만료 토큰 → 토큰 체크 실패
  const expired = createStoredAccount({ name: '만료 연결', provider: 'claude' });
  writeFileSync(join(expired.homePath, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { expiresAt: new Date(Date.now() - 1000).toISOString() },
  }));
  r = await checkStoredAccountLogin(expired.id, { run: async () => ({ error: null, stdout: 'ok', stderr: '' }) });
  assert.equal(r.ok, false);
  assert.equal(r.checks[1].ok, false);

  await assert.rejects(() => checkStoredAccountLogin('nope'), /Invalid/);
  await assert.rejects(() => checkStoredAccountLogin('a'.repeat(16)), /not found/);
});

test('deleteStoredAccount removes record and cockpit-owned dir only', () => {
  const record = createStoredAccount({ name: '지울 계정', provider: 'claude' });
  writeFileSync(join(record.homePath, '.credentials.json'), '{}');
  deleteStoredAccount(record.id);
  assert.equal(listStoredAccounts().some(a => a.id === record.id), false);
  assert.equal(existsSync(record.homePath), false);
  assert.throws(() => deleteStoredAccount(record.id), /not found/);
  assert.throws(() => deleteStoredAccount('nope'), /Invalid/);
});

test('budget persists and drives remaining estimate', () => {
  const record = createStoredAccount({ name: '예산 계정', provider: 'claude' });
  setAccountBudget(record.id, 1_000_000);
  assert.equal(getAccountBudget(record.id), 1_000_000);
  // 목록에 예산이 붙어 나온다
  assert.equal(listStoredAccounts().find(a => a.id === record.id).weeklyTokenBudget, 1_000_000);

  // 추정: 30만/100만 사용 → 70% 잔여
  assert.equal(estimateRemaining({ provider: 'claude', weeklyTokens: 300_000 }, 1_000_000), 70);
  assert.equal(estimateRemaining({ provider: 'claude', weeklyTokens: 2_000_000 }, 1_000_000), 0); // 상한 클램프
  assert.equal(estimateRemaining(null, 1_000_000), null);
  assert.equal(estimateRemaining({ provider: 'claude', weeklyTokens: 1 }, null), null);

  // 0이면 해제
  setAccountBudget(record.id, 0);
  assert.equal(getAccountBudget(record.id), null);
  assert.throws(() => setAccountBudget('bad-id', 5), /Invalid/);
  deleteStoredAccount(record.id);
});
