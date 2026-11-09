#!/usr/bin/env node
// ⚔️ Arena — 콕핏 터미널 2개에 Claude/Codex TUI를 띄우고 발언을 서로 릴레이하는 관전 모드
//
// 사용법:
//   node scripts/arena.mjs "<토론 주제>" [--turns 4] [--first codex|claude] [--cwd <경로>]
//   --use <claudeTermId>,<codexTermId>  이미 떠 있는 TUI 패널 재사용 (생성·CLI 기동 생략)
//
// 그림: 콕핏 Terminal 탭에 CLAUDE/CODEX 패널이 생기고, 각자의 답변이 상대 입력창에
//       실시간으로 타이핑되며 턴제로 치고받음. 이 스크립트는 릴레이 심판 로그만 출력.
// 안전: claude 는 --permission-mode plan, codex 는 --sandbox read-only — 코드 수정 불가.
//       신뢰(trust) 승인이 필요한 다이얼로그는 절대 대신 수락하지 않고 ESC로 건너뜀.
// 주의: 턴마다 양쪽 구독 쿼터 소모. Ctrl+C 로 릴레이만 중단 (TUI 패널은 남음).
import WebSocket from 'ws';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

// ── 단일 인스턴스 락: 릴레이 두 개가 같은 패널을 조종하는 참사 방지 ──
const LOCK = '/tmp/cockpit-arena.lock';
if (existsSync(LOCK)) {
  const oldPid = parseInt(readFileSync(LOCK, 'utf8'), 10);
  let alive = false;
  try { process.kill(oldPid, 0); alive = true; } catch { /* dead */ }
  if (alive) { console.error(`이미 Arena 가 실행 중입니다 (pid ${oldPid}). 중복 실행 금지.`); process.exit(1); }
  unlinkSync(LOCK);
}
writeFileSync(LOCK, String(process.pid));
const dropLock = () => { try { unlinkSync(LOCK); } catch { /* already gone */ } };
process.on('exit', dropLock);
process.on('SIGINT', () => { dropLock(); process.exit(130); });
process.on('SIGTERM', () => { dropLock(); process.exit(143); });

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
  else pos.push(argv[i]);
}
const topic = pos.join(' ');
if (!topic) { console.error('사용법: node scripts/arena.mjs "<토론 주제>" [--turns 4] [--first codex|claude] [--cwd <경로>] [--use cId,xId]'); process.exit(1); }
const TURNS = Math.max(2, parseInt(flags.turns || '4', 10));
const FIRST = (flags.first || 'codex').toLowerCase() === 'claude' ? 'CLAUDE' : 'CODEX';
const CWD = flags.cwd || process.cwd();
const IDLE_AFTER_BUSY = 12000; // busy 마커가 이 시간 동안 안 보이면 턴 종료
const TURN_TIMEOUT = 8 * 60 * 1000;

const CLI = {
  CLAUDE: 'claude --permission-mode plan',
  CODEX: 'codex --sandbox read-only',
};
// 작업 중 상태바에 매초 다시 그려지는 마커 — 유휴 배너 로테이션에는 없음
const BUSY_RE = /esc to interrupt/i;
// TUI 크롬(스피너·상태바·박스·다이얼로그·우리 주입 프리픽스) 제거용
const NOISE_RE = /^[\s]*$|esc to interrupt|tokens used|⏵⏵|^\s*[✻✽✶✢·●○◐◑*↓↑›]|^\s*[─│╭╮╰╯┌┐└┘]|^\s*Tip:|Press up to edit|auto mode|context left|\[(CLAUDE|CODEX)\]|\[듀얼\]|Do you trust|hooks? need|Press t to trust|esc to go back|esc to close|usage limit reset|plan mode|for agents/i;
const DIALOG_RE = /press t to trust|hooks? needs? review|esc to close|esc to go back/i;
const FOLDER_TRUST_RE = /do you trust/i;

const ws = new WebSocket('ws://127.0.0.1:3847');
const sides = { CLAUDE: null, CODEX: null }; // side → termId
const acc = {};        // termId → 이번 턴 누적 출력 (ANSI 원문)
const fresh = {};      // termId → 마지막 다이얼로그 검사 이후 새 출력 (스트립)
const lastBusyAt = {}; // termId → busy 마지막 판정 시각
const outTimes = {};   // termId → 최근 출력 이벤트 타임스탬프 (빈도 기반 busy 판정)
const lastDialogAt = {};
const answeredTrust = {};
const lastSay = {};
let pendingCreate = null;

const send = (obj) => ws.send(JSON.stringify(obj));
const type = (termId, data) => send({ type: 'input', termId, data });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`[${now()}] ${msg}`);

function stripAnsi(s) {
  // CSI 정식 문법(파라미터 0x30-3F, 중간자 0x20-2F, 종결 0x40-7E) — claude TUI 의
  // DECSCUSR("ESC[0 q", 스페이스 중간자)가 글자 사이마다 끼어 마커를 조각내므로 필수
  /* eslint-disable no-control-regex */
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
  /* eslint-enable no-control-regex */
}
function cleanCapture(raw) {
  const stripped = stripAnsi(raw);
  // 1순위: 마커 추출 — 프레임에서 발언을 ⟦BEGIN⟧/⟦END⟧ 로 감싸게 지시함.
  // (claude TUI 는 커서 이동으로 그려서 출력이 줄 단위가 아님 — 라인 필터가 통삭제하는 문제 회피)
  const blocks = [...stripped.matchAll(/⟦BEGIN⟧([\s\S]*?)⟦END⟧/g)];
  if (blocks.length) {
    const inner = blocks[blocks.length - 1][1]
      .split(/\s{3,}/)
      .filter(seg => seg.trim() && !/Use \/skills|plan mode|esc to interrupt|› |tokens|shift\+tab/i.test(seg))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (inner.length > 40) return inner.length > 2500 ? '…' + inner.slice(-2500) : inner;
  }
  // 폴백: 라인 필터
  const lines = stripped.split('\n').map(l => l.trimEnd()).filter(l => !NOISE_RE.test(l));
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 2500 ? '…' + text.slice(-2500) : text;
}

function createTerm() {
  return new Promise((resolve) => {
    pendingCreate = resolve;
    send({ type: 'create', projectId: '__home__', cols: 100, rows: 30 });
  });
}

// 새 출력(리페인트) 기준으로 다이얼로그 감지 — 열려 있는 동안 반복 ESC 가능
function handleDialogs(side) {
  const id = sides[side];
  const f = fresh[id] || '';
  if (!f.trim()) return;
  fresh[id] = '';
  if (DIALOG_RE.test(f)) {
    lastDialogAt[id] = Date.now();
    log(`${side} 훅/리뷰 다이얼로그 감지 — ESC (신뢰 승인은 대신 안 함)`);
    type(id, '\x1b');
    return;
  }
  if (!answeredTrust[id] && FOLDER_TRUST_RE.test(f)) {
    answeredTrust[id] = true;
    lastDialogAt[id] = Date.now();
    log(`${side} 폴더 신뢰 다이얼로그 — '3. Continue' 선택`);
    if (side === 'CODEX') { type(id, '3'); setTimeout(() => type(id, '\r'), 300); }
    else type(id, '\r');
  }
}

// CLI 사망 감지: TUI 가 죽으면 셸 프롬프트가 다시 나타남 (pty 짜부라짐이 TUI 를 죽이는 사례)
const SHELL_PROMPT_RE = /[\w.-]+@[^\n]{0,140}\$\s*$/;
const relaunches = {};
function checkAliveAndRevive(side) {
  const id = sides[side];
  const tail = (fresh[`tail:${id}`] || '');
  if (!SHELL_PROMPT_RE.test(tail)) return;
  if ((relaunches[id] || 0) >= 2) return;
  relaunches[id] = (relaunches[id] || 0) + 1;
  log(`⚠️ ${side} CLI 사망 감지 — 크기 보정 후 재기동 (${relaunches[id]}차)`);
  fresh[`tail:${id}`] = '';
  assertSize(id);
  setTimeout(() => type(id, `${CLI[side]}\r`), 600);
}

// 다이얼로그가 잠잠해질 때까지 정리 (시드 전 컴포저 확보)
async function settleDialogs(minMs) {
  const start = Date.now();
  for (;;) {
    handleDialogs('CLAUDE');
    handleDialogs('CODEX');
    checkAliveAndRevive('CLAUDE');
    checkAliveAndRevive('CODEX');
    const quiet = Math.min(...['CLAUDE', 'CODEX'].map(s => Date.now() - (lastDialogAt[sides[s]] || 0)));
    if (Date.now() - start >= minMs && quiet >= 4000) return;
    if (Date.now() - start > 60000) { log('⚠️ 다이얼로그 정리 시한 초과 — 진행'); return; }
    await sleep(800);
  }
}

// 턴 종료 대기. requireBusySince: 그 시각 이후 실제 작업 시작을 확인, 미시작이면 재전송.
async function waitTurnEnd(side, { minWait = 3000, requireBusySince = null } = {}) {
  const id = sides[side];
  const start = Date.now();
  assertSize(id); // 대기 중 렌더링이 정상 폭이어야 busy 마커·캡처가 읽힘
  await sleep(minWait);

  if (requireBusySince) {
    let retries = 0;
    while ((lastBusyAt[id] || 0) < requireBusySince) {
      if (Date.now() - start > TURN_TIMEOUT) { log(`⚠️ ${side} 작업 시작 감지 실패 — 현재 상태로 진행`); return; }
      if (retries < 2 && Date.now() - requireBusySince > 45000 * (retries + 1) && lastSay[id]) {
        retries++;
        log(`${side} 미제출 의심 — 전체 메시지 재전송 (${retries}차)`);
        await say(side, lastSay[id]);
      }
      handleDialogs(side);
      checkAliveAndRevive(side);
      await sleep(700);
    }
  }

  for (;;) {
    if (Date.now() - start > TURN_TIMEOUT) { log(`⚠️ ${side} 턴 타임아웃 — 현재 상태로 진행`); return; }
    handleDialogs(side);
    const sinceBusy = Date.now() - (lastBusyAt[id] || 0);
    if (sinceBusy >= IDLE_AFTER_BUSY) return;
    await sleep(700);
  }
}

// 관전자 클라이언트(구버전 JS)가 숨은 탭에서 pty 를 수시로 짜부라뜨림 — 크기 재보장.
// 짜부라지면 TUI 렌더링이 글자 단위로 쪼개져 busy 마커 감지·캡처가 전부 무력화됨.
let _sizeFlip = false;
function assertSize(termId) {
  _sizeFlip = !_sizeFlip;
  send({ type: 'resize', termId, cols: _sizeFlip ? 100 : 101, rows: 30 });
}

async function say(side, text) {
  const termId = sides[side];
  lastSay[termId] = text;
  assertSize(termId);
  await sleep(400);
  // 브래킷 페이스트로 멀티라인 안전 입력 후 Enter
  type(termId, `\x1b[200~${text}\x1b[201~`);
  await sleep(600);
  type(termId, '\r');
}

ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'created' && pendingCreate) { const r = pendingCreate; pendingCreate = null; r(msg.termId); }
  if (msg.type === 'output' && msg.termId in acc) {
    acc[msg.termId] += msg.data;
    const stripped = stripAnsi(msg.data);
    fresh[msg.termId] = ((fresh[msg.termId] || '') + stripped).slice(-4000);
    fresh[`tail:${msg.termId}`] = ((fresh[`tail:${msg.termId}`] || '') + stripped).slice(-300);
    // busy 판정: ① 마커 매칭(코덱스처럼 통짜 렌더) ② 출력 이벤트 빈도(셀 단위 diff 렌더 대응 —
    // 작업 중엔 스피너·타이머가 초당 수회 리페인트, 유휴 땐 배너 로테이션 정도)
    (outTimes[msg.termId] ||= []).push(Date.now());
    if (outTimes[msg.termId].length > 200) outTimes[msg.termId].splice(0, 100);
    if (BUSY_RE.test(stripped) || BUSY_RE.test(fresh[msg.termId].slice(-300))) lastBusyAt[msg.termId] = Date.now();
    const recent10s = outTimes[msg.termId].filter(t => Date.now() - t < 10000).length;
    if (recent10s >= 8) lastBusyAt[msg.termId] = Date.now(); // 리사이즈 리페인트 버스트(1~4건)는 미달
  }
});

ws.on('open', async () => {
  try {
    log(`⚔️ Arena 시작 — 주제: ${topic}`);
    log(`선공 ${FIRST} · ${TURNS}턴 · cwd ${CWD}`);

    if (flags.use) {
      const [cId, xId] = flags.use.split(',').map(s => s.trim());
      sides.CLAUDE = cId; sides.CODEX = xId;
      for (const id of [cId, xId]) {
        acc[id] = ''; fresh[id] = ''; lastBusyAt[id] = 0;
        send({ type: 'resize', termId: id, cols: 102, rows: 30 }); // 크기 변경 → SIGWINCH 리페인트
      }
      log(`기존 패널 재사용 — CLAUDE ${cId} / CODEX ${xId}`);
      await settleDialogs(5000);
    } else {
      for (const side of ['CLAUDE', 'CODEX']) {
        const id = await createTerm();
        sides[side] = id;
        acc[id] = ''; fresh[id] = ''; lastBusyAt[id] = 0;
        log(`${side} 터미널 생성: ${id}`);
        // 관전 클라이언트가 생성 직후 pty 를 짜부라뜨림 → 크기 보정 후에 CLI 기동
        // (짜부라진 크기에서 TUI 를 켜면 죽을 수 있음)
        await sleep(1500);
        assertSize(id);
        await sleep(1000);
        assertSize(id);
        await sleep(500);
        type(id, `cd ${JSON.stringify(CWD)} && ${CLI[side]}\r`);
      }
      log('TUI 기동 + 다이얼로그 정리 대기...');
      await settleDialogs(14000);
    }

    const A = FIRST, B = A === 'CODEX' ? 'CLAUDE' : 'CODEX';
    const frame = (side, opp) =>
      `[듀얼] 너는 ${side} 측. 상대(${opp})의 발언이 [${opp}] 프리픽스로 전달된다. ` +
      `실제 코드 근거(파일:행)로 반박 또는 인정하라. 발언은 5문장 이내, 한국어. 코드 수정 금지, 토론만. ` +
      `발언 전문은 반드시 ⟦BEGIN⟧ 으로 시작해 ⟦END⟧ 로 끝내라 (캡처용 마커). 주제: ${topic}`;

    acc[sides[A]] = '';
    let sayAt = Date.now();
    await say(A, frame(A, B) + '\n먼저 네 입장을 제시하라.');
    log(`Turn 1/${TURNS} — ${A} 발언 중... (콕핏 Terminal 탭에서 관전)`);

    let speaker = A;
    for (let t = 1; t <= TURNS; t++) {
      const listener = speaker === A ? B : A;
      await waitTurnEnd(speaker, { minWait: 8000, requireBusySince: sayAt });
      const captured = cleanCapture(acc[sides[speaker]]);
      log(`Turn ${t} 종료 — ${speaker} 발언 ${captured.length}자 캡처 → ${listener}에게 전달`);

      if (t === TURNS) break;
      acc[sides[listener]] = '';
      const preamble = t === 1 ? frame(listener, speaker) + '\n' : '';
      const finalNote = t === TURNS - 1 ? '\n(마지막 턴이다 — 판정과 함께 전체 스코어보드를 표로 정리하라)' : '';
      sayAt = Date.now();
      await say(listener, `${preamble}[${speaker}] ${captured}${finalNote}`);
      log(`Turn ${t + 1}/${TURNS} — ${listener} 발언 중...`);
      speaker = listener;
    }

    log('🏁 릴레이 종료 — 패널은 남겨둠 (이어서 직접 개입 가능).');
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error('Arena 오류:', e.message);
    ws.close();
    process.exit(1);
  }
});

ws.on('error', (e) => { console.error('WS 연결 실패:', e.message, '— 콕핏 서버(3847) 확인'); process.exit(1); });
