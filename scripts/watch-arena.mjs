// 아레나 경기 감시: 참가 패널들의 출력 스트림에서 턴 이벤트만 추출해 한 줄씩 출력
import WebSocket from 'ws';

// 사용법: node scripts/watch-arena.mjs <termId>=<라벨> [<termId>=<라벨> ...]
const WATCH = Object.fromEntries(
  process.argv.slice(2).map(arg => {
    const at = arg.indexOf('=');
    return at > 0 ? [arg.slice(0, at), arg.slice(at + 1)] : [arg, arg];
  }),
);
if (!Object.keys(WATCH).length) {
  console.error('사용법: node scripts/watch-arena.mjs <termId>=<라벨> [...]');
  process.exit(1);
}
const ws = new WebSocket('ws://127.0.0.1:3847');
const state = {}; // termId → { lastOut, busy, buf }

function strip(s) {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, '');
}
const now = () => new Date().toTimeString().slice(0, 8);
const say = (m) => console.log(`[${now()}] ${m}`);

ws.on('open', () => say('감시 시작 — 아레나 개전 대기'));
ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type !== 'output' || !(msg.termId in WATCH)) return;
  const name = WATCH[msg.termId];
  const st = (state[msg.termId] ||= { lastOut: 0, busy: false, buf: '' });
  const text = strip(msg.data);
  st.buf = (st.buf + text).slice(-3000);

  // 시드는 팬당 90초에 1회만 (리페인트 에코 억제)
  if (/\[듀얼\]|\[상호검증\]/.test(text) && Date.now() - (st.seedAt || 0) > 90000) {
    st.seedAt = Date.now();
    say(`⚔️ ${name} ← 시드/턴 전달됨`);
  }
  // END 는 "작업 시작 이후" 1회만 — 완료된 발언의 리페인트 에코 무시
  if (text.includes('END⟧') && st.endArmed) {
    st.endArmed = false;
    say(`✅ ${name} 발언 완료 (⟦END⟧)`);
  }
  if (!st.busy && /esc to interrupt/i.test(st.buf.slice(-600))) {
    st.busy = true;
    st.endArmed = true;
    say(`▶ ${name} 작업 시작`);
  }
  st.lastOut = Date.now();
});
setInterval(() => {
  for (const [id, st] of Object.entries(state)) {
    if (st.busy && Date.now() - st.lastOut > 90000) {
      st.busy = false;
      say(`⏸ ${WATCH[id]} 90초 침묵 (턴 종료 추정)`);
    }
  }
}, 15000);
ws.on('error', (e) => { console.log('WS 오류:', e.message); process.exit(1); });
ws.on('close', () => { console.log('WS 종료'); process.exit(0); });
