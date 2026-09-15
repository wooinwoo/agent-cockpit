import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAiAccounts, profileFileCandidates, resolveAiAccountLaunch, windowsToWslPath } from '../../lib/ai-accounts-service.js';

test('converts Windows profile paths for WSL', () => {
  assert.equal(windowsToWslPath('C:\\Users\\dev\\.ai\\claude'), '/mnt/c/Users/dev/.ai/claude');
  const files = profileFileCandidates({ env: { USER: 'dev' }, home: '/home/dev', isWsl: true, windowsHome: 'D:\\People\\dev' });
  assert.deepEqual(files.map(item => item.path), [
    '/home/dev/.codex-account-launcher/profiles.json',
    '/mnt/d/People/dev/.codex-account-launcher/profiles.json',
    '/mnt/c/Users/dev/.codex-account-launcher/profiles.json',
  ]);
});

test('discovers the real Windows home even when a WSL profile file exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cockpit-ai-wsl-home-'));
  const localRoot = join(home, '.codex-account-launcher');
  mkdirSync(localRoot, { recursive: true });
  writeFileSync(join(localRoot, 'profiles.json'), '[]');
  const files = profileFileCandidates({
    env: { USER: 'different-wsl-user' }, home, isWsl: true,
    detectWindowsHome: () => 'D:\\People\\windows-user',
  });
  assert.equal(files.some(item => item.path === '/mnt/d/People/windows-user/.codex-account-launcher/profiles.json'), true);
});

test('returns safe summaries and resolves launch environment by server-side id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-ai-accounts-'));
  const claudeHome = join(root, 'claude-one');
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(claudeHome, '.credentials.json'), '{}');
  writeFileSync(join(root, 'profiles.json'), JSON.stringify([{
    provider: 'claude', name: '업무용', accountEmail: 'dev@example.com',
    claudeConfigDir: claudeHome, weeklyLimitUsedPercent: 28, shortLimitUsedPercent: 7,
    lastLimitsRefreshUtc: new Date().toISOString(), // 신선 — 퍼센트 표시
  }]));

  const options = { env: { AI_HUB_LAUNCHER_ROOT: root }, home: '/missing', isWsl: false, targetWsl: false };
  const data = listAiAccounts(options);
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].weeklyRemaining, 72);
  assert.equal(data.accounts[0].sessionRemaining, 93);
  assert.equal('claudeConfigDir' in data.accounts[0], false);
  assert.equal(JSON.stringify(data.accounts[0]).toLowerCase().includes('auth'), false);

  const launch = resolveAiAccountLaunch(data.accounts[0].id, options);
  assert.equal(launch.envKey, 'CLAUDE_CONFIG_DIR');
  assert.equal(launch.envValue, claudeHome);
  assert.throws(() => resolveAiAccountLaunch('not-an-id', options), /Invalid AI account/);

  writeFileSync(join(root, 'profiles.json'), JSON.stringify([{
    provider: 'claude', name: '업무용', accountEmail: 'dev@example.com',
    claudeConfigDir: claudeHome, lastLimitsError: 'Wrong Claude account is logged in for this profile.',
    lastLimitsRefreshUtc: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(), // 낡음
  }]));
  const warning = listAiAccounts(options).accounts[0];
  assert.equal(warning.state, 'warning');
  assert.equal(warning.weeklyRemaining, null); // 낡은 퍼센트는 미표시
  assert.throws(() => resolveAiAccountLaunch(warning.id, options), /status check required/);
});
