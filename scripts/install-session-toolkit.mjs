#!/usr/bin/env node
// ─── 세션 상호 제어 도구 설치 ───
// 1) cockpit-session CLI → ~/.local/bin (PATH)
// 2) cockpit-session 스킬 → 각 Claude 설정 디렉터리의 skills/
//    대상: ~/.claude + 콕핏 내장 계정 전부 + --dir 로 지정한 추가 디렉터리(허브 등)
import { cpSync, existsSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const repoRoot = new URL('..', import.meta.url).pathname;
const cliSrc = join(repoRoot, 'scripts', 'cockpit-session.mjs');
const skillSrc = join(repoRoot, '.claude', 'skills', 'cockpit-session');

const args = process.argv.slice(2);
const extraDirs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && args[i + 1]) extraDirs.push(args[++i]);
}

if (!existsSync(skillSrc)) { console.error(`스킬 원본이 없습니다: ${skillSrc}`); process.exit(1); }

// 1) CLI 설치
const binDir = join(homedir(), '.local', 'bin');
mkdirSync(binDir, { recursive: true });
const cliDst = join(binDir, 'cockpit-session');
cpSync(cliSrc, cliDst);
chmodSync(cliDst, 0o755);
console.log(`[CLI] ${cliDst} 설치 완료 (PATH에 ~/.local/bin 이 있어야 함)`);

// 2) 스킬 설치 대상 수집
const appData = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), '.local', 'share');
const accountsRoot = join(appData, 'cockpit', 'ai-accounts');
const targets = [join(homedir(), '.claude'), ...extraDirs];
if (existsSync(accountsRoot)) {
  for (const name of readdirSync(accountsRoot)) targets.push(join(accountsRoot, name));
}

let installed = 0;
for (const dir of targets) {
  if (!existsSync(dir)) { console.log(`[skip] 디렉터리 없음: ${dir}`); continue; }
  try {
    const dst = join(dir, 'skills', 'cockpit-session');
    mkdirSync(dst, { recursive: true });
    cpSync(skillSrc, dst, { recursive: true });
    console.log(`[skill] ${dst}`);
    installed++;
  } catch (err) {
    console.error(`[fail] ${dir}: ${err.message}`);
  }
}
console.log(`완료 — 스킬 ${installed}곳 설치. 새 세션부터 스킬이 로드됩니다.`);
