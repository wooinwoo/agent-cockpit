#!/usr/bin/env node
// ─── 콕핏 세션 상호 제어 CLI ───
// 각 AI 세션(Claude/Codex/OpenCode)이 다른 세션에 메시지를 보내고 화면을 읽는 도구.
// 사용: cockpit-session list | me | say <대상> <메시지> | read <대상> [줄수] [--new] | key <대상> <키>
//
// 토큰 절약: read 결과는 호출한 AI 세션의 컨텍스트에 그대로 들어가 매 턴 재청구된다.
// 그래서 (1) 기본 줄수를 20으로 제한, (2) 240자 넘는 줄은 잘라내고,
// (3) --new 플래그로 직전 확인 이후 변화가 없으면 한 줄만 반환한다. 폴링은 --new로.

const args = process.argv.slice(2);
const baseUrl = process.env.COCKPIT_URL || `http://127.0.0.1:${process.env.COCKPIT_PORT || 3847}`;
const MAX_LINE_CHARS = 240;

// 이름 있는 키 → 터미널 이스케이프 시퀀스
const KEY_NAMES = {
  enter: '\r', return: '\r', esc: '\x1b', escape: '\x1b', space: ' ',
  tab: '\t', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
  ctrlc: '\x03', ctrld: '\x04', ctrlz: '\x1a', backspace: '\x7f',
};

// ─── read --new 상태 (읽은 쪽 × 대상별 화면 지문) ───
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = process.env.COCKPIT_SESSION_STATE_DIR
  || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'cockpit-session');

function statePathFor(targetId) {
  const reader = process.env.COCKPIT_TERM_ID || 'external';
  return join(STATE_DIR, `${reader}-${targetId}.json`);
}

// 스피너·공백 변화는 "변경 없음"으로 쳐야 폴링이 공짜가 된다
function fingerprintLines(lines) {
  const normalized = lines.map(l => l
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏۰۰•]/g, '·')
    .replace(/\s+/g, ' ')
    .trim());
  return createHash('sha256').update(normalized.join('\n')).digest('hex');
}

function loadFingerprint(targetId) {
  try { return JSON.parse(readFileSync(statePathFor(targetId), 'utf8')).hash || null; } catch { return null; }
}

function saveFingerprint(targetId, hash) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(statePathFor(targetId), JSON.stringify({ hash, at: Date.now() }));
  } catch { /* 상태 저장 실패는 read 자체를 막지 않음 */ }
}

function trimLine(line) {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …(줄임)` : line;
}

async function request(path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(8000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

async function sessions() {
  const { terminals } = await request('/api/terminals');
  return terminals;
}

function mySession(terminals) {
  const termId = process.env.COCKPIT_TERM_ID;
  if (!termId) return null;
  return terminals.find(t => t.termId === termId) || null;
}

function usage() {
  console.log(`콕핏 세션 제어 — 세션끼리 대화/지시에 쓴다.

  cockpit-session list                    세션 목록 (별칭 ai1.., 프로젝트, 계정)
  cockpit-session me                      내 세션 별칭 확인
  cockpit-session say <대상> <메시지...>   대상 세션에 메시지 주입 (자동 서명)
  cockpit-session read <대상> [줄수=20]    대상 세션 화면 끝부분 읽기
  cockpit-session read <대상> --new        직전 확인 이후 변화가 없으면 한 줄만 반환 (폴링용 — 토큰 절약)
  cockpit-session key <대상> <키...>       원시 키 주입 — 프롬프트(1/2/3 선택·체크박스) 대리 응답용
                                          키: 숫자/문자, enter esc space tab up down ctrlc 등 (조합 가능)

대상은 별칭(ai3) 또는 세션 ID. 예:
  cockpit-session say ai3 "리팩터링 진행 상황 알려줘"
  cockpit-session read ai3 --new          # 폴링 — 변화 없으면 즉시 한 줄
  cockpit-session read ai3 60              # 자세히 볼 때만 크게
  cockpit-session key ai3 2               # 선택지 2번 선택
  cockpit-session key ai3 space enter     # 체크박스 토글 후 확인
  cockpit-session key ai3 esc              # 작업 중단`);
}

try {
  const [cmd, target, ...rest] = args;

  if (!cmd || cmd === 'help' || cmd === '--help') { usage(); process.exit(0); }

  if (cmd === 'list') {
    const list = await sessions();
    if (!list.length) { console.log('활성 세션 없음'); process.exit(0); }
    const me = process.env.COCKPIT_TERM_ID;
    for (const t of list) {
      const account = t.account ? ` · ${t.account.provider}:${t.account.name}` : '';
      const mark = t.termId === me ? ' ← 나' : '';
      console.log(`${(t.alias || '??').padEnd(5)} ${t.projectId}${account}${t.command ? ` · ${t.command}` : ''}${mark}`);
    }
    process.exit(0);
  }

  if (cmd === 'me') {
    const me = mySession(await sessions());
    console.log(me ? `${me.alias} (${me.termId})` : '이 셸은 콕핏 터미널이 아닙니다 (COCKPIT_TERM_ID 없음)');
    process.exit(0);
  }

  if (cmd === 'say') {
    const message = rest.join(' ').trim();
    if (!target || !message) { console.error('사용법: cockpit-session say <대상> <메시지>'); process.exit(1); }
    const list = await sessions();
    const me = mySession(list);
    const from = me?.alias || '외부';
    const found = list.find(t => t.alias?.toLowerCase() === target.toLowerCase() || t.termId === target);
    if (!found) { console.error(`세션을 찾지 못했습니다: ${target} — cockpit-session list 로 확인`); process.exit(1); }
    const framed = [
      `[콕핏 세션 메시지 | 보낸 세션: ${from}]`,
      message,
      '',
      `— 답장: cockpit-session say ${from} "답장 내용"`,
      '— 목록: cockpit-session list',
    ].join('\n');
    const result = await request(`/api/terminals/${encodeURIComponent(found.termId)}/input`, 'POST', { data: framed });
    console.log(`전송 완료 → ${result.alias || found.termId}`);
    process.exit(0);
  }

  if (cmd === 'read') {
    if (!target) { console.error('사용법: cockpit-session read <대상> [줄수] [--new]'); process.exit(1); }
    const onlyNew = rest.includes('--new');
    const lines = Math.max(1, Math.min(500, parseInt(rest.find(a => /^\d+$/.test(a)), 10) || 20));
    const list = await sessions();
    const found = list.find(t => t.alias?.toLowerCase() === target.toLowerCase() || t.termId === target);
    if (!found) { console.error(`세션을 찾지 못했습니다: ${target}`); process.exit(1); }
    const screen = await request(`/api/terminals/${encodeURIComponent(found.termId)}/screen?lines=${lines}`);
    const trimmed = screen.lines.map(trimLine);
    const hash = fingerprintLines(screen.lines);
    const prevHash = loadFingerprint(found.termId);
    saveFingerprint(found.termId, hash);
    if (onlyNew && hash === prevHash) {
      console.log(`── ${screen.alias || found.termId}: 변화 없음 ──`);
      process.exit(0);
    }
    console.log(`── ${screen.alias || found.termId} 화면 (끝 ${screen.lines.length}줄${screen.truncated ? ', 이전 내용 생략' : ''}) ──`);
    console.log(trimmed.join('\n'));
    process.exit(0);
  }

  if (cmd === 'key') {
    if (!target || !rest.length) { console.error('사용법: cockpit-session key <대상> <키...> — 예: key ai2 2 / key ai2 space enter'); process.exit(1); }
    const list = await sessions();
    const found = list.find(t => t.alias?.toLowerCase() === target.toLowerCase() || t.termId === target);
    if (!found) { console.error(`세션을 찾지 못했습니다: ${target}`); process.exit(1); }
    // 토큰 조합: 이름 있는 키는 매핑, 한 글자는 그대로 (enter:false — 개행 자동 추가 안 함)
    const data = rest.map(k => KEY_NAMES[k.toLowerCase()] ?? k).join('');
    const result = await request(`/api/terminals/${encodeURIComponent(found.termId)}/input`, 'POST', { data, enter: false });
    console.log(`키 전송 [${rest.join(' ')}] → ${result.alias || found.termId}`);
    process.exit(0);
  }

  usage();
  console.error(`\n알 수 없는 명령: ${cmd}`);
  process.exit(1);
} catch (err) {
  console.error(`오류: ${err.message}`);
  process.exit(1);
}
