import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { IS_WIN, IS_WSL } from './platform.js';
import { usageSnapshot, refreshAccountUsage, nextWeeklyResetFrom } from './ai-usage-service.js';
import { getAccountBudget, estimateRemaining, credentialState } from './ai-accounts-store.js';

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex']);

export function windowsToWslPath(value) {
  const path = String(value || '').trim();
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}` : path;
}

function hostWindowsHome() {
  if (!IS_WSL) return '';
  try {
    return execFileSync('cmd.exe', ['/d', '/c', 'echo', '%USERPROFILE%'], {
      encoding: 'utf8', timeout: 2000, windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

export function profileFileCandidates({
  env = process.env,
  home = homedir(),
  isWsl = IS_WSL,
  windowsHome,
  detectWindowsHome = hostWindowsHome,
} = {}) {
  const candidates = [];
  const add = (root, source) => {
    if (!root) return;
    const runtimeRoot = isWsl ? windowsToWslPath(root) : root;
    candidates.push({ path: join(runtimeRoot, 'profiles.json'), source });
  };
  add(env.AI_HUB_LAUNCHER_ROOT, 'Configured');
  add(join(home, '.codex-account-launcher'), isWsl ? 'WSL' : 'Local');
  if (isWsl) {
    const explicitWindowsHome = windowsHome || env.COCKPIT_WINDOWS_HOME || '';
    add(explicitWindowsHome ? join(windowsToWslPath(explicitWindowsHome), '.codex-account-launcher') : '', 'Windows');
    const guessedWindowsRoot = env.USER ? `/mnt/c/Users/${env.USER}/.codex-account-launcher` : '';
    add(guessedWindowsRoot, 'Windows');
    if (!explicitWindowsHome && (!guessedWindowsRoot || !existsSync(join(guessedWindowsRoot, 'profiles.json')))) {
      const detectedWindowsHome = detectWindowsHome();
      add(detectedWindowsHome ? join(windowsToWslPath(detectedWindowsHome), '.codex-account-launcher') : '', 'Windows');
    }
  }
  const seen = new Set();
  return candidates.filter(({ path }) => {
    const key = path.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function percentLeft(used) {
  const value = Number(used);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, 100 - value)) : null;
}

// 허브 한도 데이터 신선도 기준 — 이보다 오래됐으면 퍼센트를 신뢰하지 않고 로컬 계산에 맡김
const HUB_LIMITS_STALE_MS = 48 * 60 * 60 * 1000;

function credentialPath(profile, targetWsl, serverIsWin) {
  const provider = String(profile.provider || '').toLowerCase();
  const raw = String(provider === 'claude' ? profile.claudeConfigDir : profile.codexHome).trim();
  return targetWsl && !serverIsWin ? windowsToWslPath(raw) : raw;
}

function profileId(profile) {
  const provider = String(profile.provider || '').toLowerCase();
  const rawPath = String(provider === 'claude' ? profile.claudeConfigDir : profile.codexHome);
  return createHash('sha256').update(`${provider}\0${rawPath.toLowerCase()}`).digest('hex').slice(0, 16);
}

function loadRecords(options = {}) {
  const targetWsl = options.targetWsl ?? IS_WSL;
  const serverIsWin = options.serverIsWin ?? IS_WIN;
  const records = [];
  const sources = [];
  for (const candidate of profileFileCandidates(options)) {
    if (!existsSync(candidate.path)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate.path, 'utf8'));
      const profiles = Array.isArray(raw) ? raw : raw.profiles;
      if (!Array.isArray(profiles)) continue;
      const updatedAt = statSync(candidate.path).mtime.toISOString();
      sources.push({ source: candidate.source, updatedAt });
      for (const profile of profiles) {
        const provider = String(profile?.provider || '').toLowerCase();
        if (!SUPPORTED_PROVIDERS.has(provider)) continue;
        const homePath = credentialPath(profile, targetWsl, serverIsWin);
        if (!homePath) continue;
        const authFile = join(homePath, provider === 'claude' ? '.credentials.json' : 'auth.json');
        records.push({ profile, provider, homePath, authFile, source: candidate.source, updatedAt });
      }
    } catch {
      sources.push({ source: candidate.source, error: '프로필 파일을 읽지 못했습니다.' });
    }
  }
  const seen = new Set();
  return {
    sources,
    records: records.filter(({ profile }) => {
      const id = profileId(profile);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  };
}

export function listAiAccounts(options = {}) {
  const { records, sources } = loadRecords(options);
  return {
    runtime: IS_WSL ? 'WSL' : IS_WIN ? 'Windows' : 'Linux',
    sources,
    accounts: records.map(({ profile, provider, authFile, homePath, source, updatedAt }) => {
      const cred = credentialState(provider, homePath);
      const warning = Boolean(profile.lastLimitsError) || cred.state === 'warning';
      const lastRefreshMs = Date.parse(profile.lastLimitsRefreshUtc || '');
      const hubLimitsFresh = Number.isFinite(lastRefreshMs) && Date.now() - lastRefreshMs < HUB_LIMITS_STALE_MS;
      // 사용량: 캐시 즉시 반환 + 만료됐으면 백그라운드 갱신 (응답 지연 없음)
      refreshAccountUsage(provider, homePath);
      return {
        id: profileId(profile),
        name: String(profile.name || profile.accountName || `${provider} account`),
        email: String(profile.authenticatedEmail || profile.accountEmail || profile.loginEmail || ''),
        provider,
        plan: String(profile.accountPlan || profile.accountType || ''),
        state: cred.state === 'login' ? 'login' : (warning ? 'warning' : 'ready'),
        stateNote: cred.stateNote,
        // 허브 퍼센트는 마지막 갱신이 48시간 이내일 때만 표시 — 그 이후는 예산 기준 로컬 추정으로
        weeklyRemaining: hubLimitsFresh ? percentLeft(profile.weeklyLimitUsedPercent) : estimateRemaining(usageSnapshot(provider, homePath), getAccountBudget(profileId(profile))),
        sessionRemaining: hubLimitsFresh ? percentLeft(profile.shortLimitUsedPercent) : null,
        // 허브 기록이 오래됐어도 계정 고정 리셋 주기는 유효 — 매주 같은 시각으로 이어 계산
        weeklyResetAt: nextWeeklyResetFrom(profile.weeklyLimitResetUtc),
        sessionResetAt: '',
        lastRefreshedAt: String(profile.lastLimitsRefreshUtc || updatedAt || ''),
        source,
        bridge: IS_WSL && source === 'Windows' ? 'Windows → WSL' : source,
        weeklyTokenBudget: getAccountBudget(profileId(profile)) || null,
        usage: usageSnapshot(provider, homePath),
      };
    }),
  };
}

export function resolveAiAccountLaunch(accountId, options = {}) {
  const targetWsl = options.targetWsl ?? IS_WSL;
  if (typeof accountId !== 'string' || !/^[a-f0-9]{16}$/.test(accountId)) {
    throw new Error('Invalid AI account');
  }
  const { records } = loadRecords({ ...options, targetWsl });
  const record = records.find(({ profile }) => profileId(profile) === accountId);
  if (!record) throw new Error('AI account not found');
  if (!existsSync(record.authFile)) throw new Error('AI account login required');
  if (String(record.profile.lastLimitsError || '').trim()) throw new Error('AI account status check required');
  return {
    id: accountId,
    name: String(record.profile.name || record.profile.accountName || `${record.provider} account`),
    provider: record.provider,
    command: record.provider,
    envKey: record.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
    envValue: record.homePath,
    translateForWsl: targetWsl && /^[a-zA-Z]:[\\/]/.test(String(record.profile.claudeConfigDir || record.profile.codexHome || '')),
  };
}

/** 감시자 대상 디렉터리 — 허브 계정 credential 디렉터리 + 프로필 파일 위치 */
export function aiAccountWatchTargets(options = {}) {
  const { records } = loadRecords(options);
  const dirs = new Set(records.map(({ homePath }) => homePath));
  for (const candidate of profileFileCandidates(options)) {
    if (existsSync(candidate.path)) dirs.add(dirname(candidate.path));
  }
  return [...dirs];
}
