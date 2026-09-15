// ─── Cockpit 내장 AI 계정 저장소 ───
// 허브(.codex-account-launcher)와 무관하게 콕핏이 소유하는 계정 목록.
// 메타: DATA_DIR/ai-accounts.json
// 계정별 credential 디렉터리: DATA_DIR/ai-accounts/<provider>-<slug>/
//   - claude: CLAUDE_CONFIG_DIR → .credentials.json 존재 시 로그인됨
//   - codex:  CODEX_HOME → auth.json 존재 시 로그인됨

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { usageSnapshot, refreshAccountUsage } from './ai-usage-service.js';

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex']);
const STORE_FILE = join(DATA_DIR, 'ai-accounts.json');
const ACCOUNTS_ROOT = join(DATA_DIR, 'ai-accounts');

function accountIdFor(provider, homePath) {
  return createHash('sha256').update(`${provider}\0${String(homePath).toLowerCase()}`).digest('hex').slice(0, 16);
}

function isValidAccountId(id) {
  return typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);
}

function authFileFor(homePath, provider) {
  return join(homePath, provider === 'claude' ? '.credentials.json' : 'auth.json');
}

/** 콕핏 소유 계정 루트 디렉터리 — 감시자·테스트용 */
export function storedAccountsRoot() {
  return ACCOUNTS_ROOT;
}

// codex auth.json last_refresh가 이 기간보다 오래됐으면 확인 필요 — 토큰 자체 만료일은 파일에 없음
const CODEX_REFRESH_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** credential 파일 기반 로그인 상태 판정 — 파일 존재 + 토큰 만료/갱신 신선도.
 *  반환: { state: 'login'|'ready'|'warning', stateNote } */
export function credentialState(provider, homePath) {
  const file = authFileFor(homePath, provider);
  if (!existsSync(file)) return { state: 'login', stateNote: 'credential 파일 없음 — 로그인 터미널에서 로그인하세요' };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (provider === 'claude') {
      const expiresAt = Date.parse(raw?.claudeAiOauth?.expiresAt || '');
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        return { state: 'warning', stateNote: '액세스 토큰 만료 — 터미널을 열면 자동 갱신되거나 재로그인이 필요합니다' };
      }
    } else {
      const lastRefresh = Date.parse(raw?.last_refresh || '');
      if (Number.isFinite(lastRefresh) && Date.now() - lastRefresh > CODEX_REFRESH_STALE_MS) {
        return { state: 'warning', stateNote: '토큰 갱신이 30일 이상 됨 — 로그인 상태를 확인하세요' };
      }
    }
  } catch { /* 파일이 JSON으로 읽히지 않으면 존재 사실만으로 ready — 실행 시 판명 */ }
  return { state: 'ready', stateNote: '' };
}

function loadStore() {
  try {
    if (!existsSync(STORE_FILE)) return { accounts: [], budgets: {} };
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    const accounts = Array.isArray(raw) ? raw : (Array.isArray(raw.accounts) ? raw.accounts : []);
    const budgets = raw && typeof raw === 'object' && raw.budgets && typeof raw.budgets === 'object' ? raw.budgets : {};
    return {
      accounts: accounts.filter(a => a && isValidAccountId(a.id) && SUPPORTED_PROVIDERS.has(a.provider) && a.homePath),
      budgets,
    };
  } catch { return { accounts: [], budgets: {} }; }
}

function saveStore(store) {
  mkdirSync(ACCOUNTS_ROOT, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ accounts: store.accounts, budgets: store.budgets }, null, 2), 'utf8');
  renameSync(tmp, STORE_FILE);
}

/** 계정별 주간 토큰 예산 — 잔여량 % 계산 기준 (허브/내장 계정 공용, 계정 ID 키) */
export function setAccountBudget(accountId, weeklyTokenBudget) {
  if (!isValidAccountId(accountId)) throw new Error('Invalid AI account');
  const value = Math.round(Number(weeklyTokenBudget));
  if (!Number.isFinite(value) || value < 0) throw new Error('예산은 0 이상의 숫자(토큰 수)여야 합니다.');
  const store = loadStore();
  if (value === 0) delete store.budgets[accountId];
  else store.budgets[accountId] = value;
  saveStore(store);
  return { id: accountId, weeklyTokenBudget: value || null };
}

export function getAccountBudget(accountId) {
  if (!isValidAccountId(accountId)) return null;
  return loadStore().budgets[accountId] || null;
}

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'account';
}

// 계정 디렉터리에 세션 상호 통신 스킬 심기 (best-effort)
function seedSessionToolkit(homePath) {
  try {
    const skillSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'skills', 'cockpit-session');
    if (!existsSync(skillSrc)) return;
    const dst = join(homePath, 'skills', 'cockpit-session');
    mkdirSync(dst, { recursive: true });
    cpSync(skillSrc, dst, { recursive: true });
  } catch { /* 스킬 심기 실패는 계정 생성을 막지 않음 */ }
}

/** 감시자용 — 등록된 계정 credential 디렉터리 경로 목록 */
export function storedAccountDirs() {
  return loadStore().accounts.map(account => account.homePath);
}

/** 콕핏 소유 계정 + 로그인 상태 목록 */
export function listStoredAccounts() {
  const store = loadStore();
  return store.accounts.map(account => {
    const { state, stateNote } = credentialState(account.provider, account.homePath);
    // 사용량: 캐시 즉시 반환 + 만료됐으면 백그라운드 갱신 (응답 지연 없음)
    refreshAccountUsage(account.provider, account.homePath);
    const budget = store.budgets[account.id] || null;
    const usage = usageSnapshot(account.provider, account.homePath);
    return {
      id: account.id,
      name: account.name,
      email: account.email || '',
      provider: account.provider,
      plan: account.plan || '',
      state,
      stateNote,
      weeklyRemaining: estimateRemaining(usage, budget),
      sessionRemaining: null,
      weeklyResetAt: usage?.weeklyResetAt || '',
      sessionResetAt: '',
      lastRefreshedAt: '',
      source: 'cockpit',
      bridge: 'Cockpit',
      weeklyTokenBudget: budget,
      usage,
    };
  });
}

// 예산 기준 잔여량 % — 사용량·예산이 있을 때만 (허브 데이터와 무관한 로컬 추정)
export function estimateRemaining(usage, budgetTokens) {
  if (!usage || !budgetTokens || usage.provider !== 'claude') return null;
  const usedPct = (usage.weeklyTokens / budgetTokens) * 100;
  return Math.max(0, Math.min(100, 100 - usedPct));
}

/** 계정 등록 — 콕핏 소유 credential 디렉터리 생성 */
export function createStoredAccount({ name, provider, email }) {
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) throw new Error('계정 이름을 입력하세요.');
  if (!SUPPORTED_PROVIDERS.has(provider)) throw new Error('provider는 claude 또는 codex여야 합니다.');
  const cleanEmail = String(email || '').trim().slice(0, 120);

  const store = loadStore();
  if (store.accounts.some(a => a.provider === provider && a.name === cleanName)) {
    throw new Error(`같은 이름의 ${provider} 계정이 이미 있습니다.`);
  }

  let homePath = join(ACCOUNTS_ROOT, `${provider}-${slugify(cleanName)}`);
  if (existsSync(homePath)) homePath = `${homePath}-${Date.now().toString(36)}`;
  mkdirSync(homePath, { recursive: true });
  seedSessionToolkit(homePath);

  const record = {
    id: accountIdFor(provider, homePath),
    name: cleanName,
    email: cleanEmail,
    provider,
    homePath,
    createdAt: new Date().toISOString(),
  };
  saveStore({ ...store, accounts: [...store.accounts, record] });
  return record;
}

/** 계정 삭제 — 콕핏 소유 디렉터리만 함께 제거 */
export function deleteStoredAccount(id) {
  if (!isValidAccountId(id)) throw new Error('Invalid AI account');
  const store = loadStore();
  const record = store.accounts.find(a => a.id === id);
  if (!record) throw new Error('AI account not found');
  // 경로 조작 방지: 정규화 뒤에도 소유 루트 하위일 때만 삭제
  const ownedRoot = resolve(ACCOUNTS_ROOT);
  if (resolve(record.homePath).startsWith(ownedRoot + sep)) {
    try { rmSync(record.homePath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  delete store.budgets[id];
  saveStore({ ...store, accounts: store.accounts.filter(a => a.id !== id) });
  return { deleted: true };
}

/** 터미널 스폰용 launch 사양 (기존 resolveAiAccountLaunch와 동일한 형태).
 *  미로그인 계정도 스폰 허용 — 터미널 안에서 로그인하는 것이 내장 계정의 로그인 흐름. */
export function resolveStoredLaunch(accountId, options = {}) {
  if (!isValidAccountId(accountId)) throw new Error('Invalid AI account');
  const record = loadStore().accounts.find(a => a.id === accountId);
  if (!record) throw new Error('AI account not found');
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    command: record.provider,
    envKey: record.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
    envValue: record.homePath,
    translateForWsl: Boolean(options.targetWsl) && /^[a-zA-Z]:[\\/]/.test(record.homePath),
  };
}

/** 로그인 안내 명령 — 계정 카드에 그대로 보여준다 */
export function loginCommandFor(provider) {
  return provider === 'claude' ? 'claude login' : 'codex login';
}

function runCli(cmd, args, env, timeoutMs) {
  return new Promise(resolve => {
    execFile(cmd, args, { env, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 연결 테스트 — 토큰을 쓰지 않고 "로그인이 되는 상태인지" 실측한다.
 *  claude: credential 파일 + 만료 + `claude doctor` / codex: 파일 + `codex login status`.
 *  @param {object} [options.run] 테스트용 러너 주입 (cmd, args, env, timeoutMs) => { error, stdout, stderr } */
export async function checkStoredAccountLogin(accountId, options = {}) {
  if (!isValidAccountId(accountId)) throw new Error('Invalid AI account');
  const record = loadStore().accounts.find(a => a.id === accountId);
  if (!record) throw new Error('AI account not found');
  const run = options.run || runCli;
  const timeoutMs = options.timeoutMs || 25000;
  const envKey = record.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const env = { ...process.env, [envKey]: record.homePath };

  const checks = [];
  const file = authFileFor(record.homePath, record.provider);
  if (!existsSync(file)) {
    checks.push({ label: '로그인 파일', ok: false, detail: '없음 — 로그인 터미널에서 먼저 로그인하세요' });
    return { id: record.id, ok: false, state: 'login', checks };
  }
  checks.push({
    label: '로그인 파일', ok: true,
    detail: record.provider === 'claude' ? '.credentials.json 있음' : 'auth.json 있음',
  });

  const cred = credentialState(record.provider, record.homePath);
  if (cred.state === 'warning') {
    checks.push({ label: '토큰 유효성', ok: false, detail: cred.stateNote });
  } else {
    checks.push({ label: '토큰 유효성', ok: true, detail: '만료 징후 없음' });
  }

  const cliArgs = record.provider === 'claude' ? ['doctor'] : ['login', 'status'];
  const result = await run(record.provider, cliArgs, env, timeoutMs);
  if (result.error) {
    const detail = result.error.code === 'ENOENT'
      ? `CLI(${record.provider})를 찾을 수 없음 — 서버 PATH를 확인하세요`
      : result.error.killed
        ? `시간 초과 (${Math.round(timeoutMs / 1000)}초)`
        : (result.stderr.trim().split('\n').pop() || result.error.message).slice(0, 160);
    checks.push({ label: record.provider === 'claude' ? 'claude doctor' : 'codex login status', ok: false, detail });
  } else {
    const firstLine = (result.stdout.trim().split('\n')[0] || 'OK').slice(0, 120);
    checks.push({ label: record.provider === 'claude' ? 'claude doctor' : 'codex login status', ok: true, detail: firstLine });
  }

  const ok = checks.every(c => c.ok);
  return { id: record.id, ok, state: ok ? 'ready' : (cred.state === 'login' ? 'login' : 'warning'), checks };
}
