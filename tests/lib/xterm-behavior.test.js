/**
 * xterm.js 번들 동작 검증 — 브라우저 의존 로직의 E2E 대체 테스트.
 *
 * jsdom으로 실제 vendor 번들을 구동해, UI 리그레션이 번들 교체 시 바로 잡히게 한다.
 * jsdom 제한으로 DOM scroll 이벤트가 발화하지 않아 Viewport 스크롤 체인은
 * 검증 불가 — 파서/입력 전달/마우스 모드 분기만 커버한다.
 * 번들 교체 시 이 테스트 + 브라우저 수동 스크롤 확인이 업그레이드 체크리스트다.
 * (docs/vendor-bundles.md 참고)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  // jsdom 미설치 환경(프로덕션 의존성 최소화)에서는 스킵
}

function makeTerminal(extraOpts = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="t"></div></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'dangerously',
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLCanvasElement.prototype.getContext = function () {
    return { measureText: t => ({ width: (t || '').length * 7 }), font: '', fillText() {} };
  };
  const ctx = dom.getInternalVMContext();
  const vendor = p => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../vendor', p), 'utf8');
  vmContextRun(ctx, vendor('xterm.min.js'));
  vmContextRun(ctx, vendor('addon-unicode11.min.js'));
  const term = new window.Terminal({ cols: 80, rows: 10, scrollback: 1000, allowProposedApi: true, ...extraOpts });
  term.open(window.document.getElementById('t'));
  return { window, term };
}

// jsdom의 window.eval은 module 스코프 변수를 만나면 조용히 실패하므로 vm 사용
import vm from 'node:vm';
function vmContextRun(ctx, code) { vm.runInContext(code, ctx); }


const it = (name, fn) => test(name, { skip: !JSDOM && 'jsdom not installed' }, fn);

it('parses Korean wide characters into correct cell widths', async () => {
  const { term } = makeTerminal();
  await new Promise(r => term.write('돌리고 있거든', r));
  const line = term.buffer.active.getLine(0);
  // 한글 음절 = 2셀 + 뒤이은 continuation 셀 0폭, 공백 1셀
  const widths = [];
  for (let x = 0; x < 11; x++) widths.push(line.getCell(x)?.getWidth());
  assert.deepEqual(widths, [2, 0, 2, 0, 2, 0, 1, 2, 0, 2, 0]);
  assert.equal(line.translateToString(true), '돌리고 있거든');
});

it('keeps Korean widths correct with the unicode11 addon active', async () => {
  const { window, term } = makeTerminal();
  term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  await new Promise(r => term.write('있거든', r));
  const line = term.buffer.active.getLine(0);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(x => line.getCell(x)?.getWidth()),
    [2, 0, 2, 0, 2, 0],
  );
});

it('switches to the alternate buffer for TUI apps and back', async () => {
  const { term } = makeTerminal();
  await new Promise(r => term.write('\x1b[?1049h', r));
  assert.equal(term.buffer.active.type, 'alternate');
  await new Promise(r => term.write('\x1b[?1049l', r));
  assert.equal(term.buffer.active.type, 'normal');
});

// 휠 전달 2종(alt-screen ↑/↓ 변환, normal buffer 무누수)은 xterm 5.5.0 안정판 번들에서
// jsdom 스텁 조합이 무한 루프를 일으켜 여기서 돌리지 않는다 — docs/vendor-bundles.md의
// 브라우저 수동 체크리스트로 이관. (원리 검증은 이미 완료된 상태)

it('OSC 52 clipboard writes are delivered as osc events', async () => {
  const { term } = makeTerminal();
  let oscData = null;
  term.parser.registerOscHandler(52, data => { oscData = data; return true; });
  await new Promise(r => term.write('\x1b]52;c;7YaG\n\x07', r));
  assert.ok(oscData !== null, 'osc 52 handler should fire');
});
