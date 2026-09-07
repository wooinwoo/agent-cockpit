import assert from 'node:assert/strict';
import test from 'node:test';

import { patchXtermImeComposition } from '../../js/xterm-ime-guard.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function createXterm() {
  const handled = [];
  const captureListeners = new Map();
  const textarea = {
    value: '',
    selectionEnd: 0,
    addEventListener(type, listener, capture) {
      if (capture) captureListeners.set(type, listener);
    },
  };
  const helper = {
    _isComposing: false,
    _isSendingComposition: false,
    _compositionPosition: { start: 0, end: 0 },
    _dataAlreadySent: '',
    _textarea: textarea,
    _compositionView: { classList: { add() {}, remove() {} }, textContent: '' },
    _coreService: { triggerDataEvent: value => handled.push(value) },
    _handleAnyTextareaChanges() {},
    keydown() { return true; },
    _finalizeComposition() {},
    compositionstart() {
      this._isComposing = true;
      this._compositionPosition.start = this._textarea.value.length;
      this._dataAlreadySent = '';
    },
    compositionupdate(event) {
      this._compositionView.textContent = event.data;
      setTimeout(() => { this._compositionPosition.end = this._textarea.value.length; }, 0);
    },
    compositionend() { this._finalizeComposition(true); },
  };
  const endComposition = data => {
    captureListeners.get('compositionend')?.({ data });
    helper.compositionend();
  };
  return { xterm: { _core: { _compositionHelper: helper } }, helper, textarea, handled, endComposition };
}

test('keeps every queued Korean composition when the next key arrives', async () => {
  const { xterm, helper, textarea, handled } = createXterm();
  assert.equal(patchXtermImeComposition(xterm), true);

  helper.compositionstart();
  helper.compositionupdate({ data: '니' });
  textarea.value = '니';
  textarea.selectionEnd = 1;
  await tick();
  helper.compositionend();

  helper.compositionstart();
  helper.compositionupdate({ data: '다' });
  textarea.value = '니다';
  textarea.selectionEnd = 2;
  helper.compositionend();
  assert.equal(helper.keydown({ keyCode: 190 }), true);

  assert.equal(handled.join(''), '니다');
  await tick();
  assert.equal(handled.join(''), '니다');
});

test('a key pressed mid-composition defers to the IME instead of force-finalizing', async () => {
  const { xterm, helper, textarea, handled, endComposition } = createXterm();
  patchXtermImeComposition(xterm);

  helper.compositionstart();
  helper.compositionupdate({ data: '가' });
  textarea.value = '가';
  textarea.selectionEnd = 1;
  // 조합 중 스페이스 — 강제 확정하면 WebView2/TSF에서 조합이 잘려 한글이 씹힌다.
  // xterm 처리를 스킵(false)하고 IME에 맡긴 뒤, 확정은 compositionend 경유로만.
  assert.equal(helper.keydown({ keyCode: 32 }), false);
  assert.equal(handled.join(''), '');

  endComposition('가');
  await tick();
  assert.equal(handled.join(''), '가');
});

test('recovers a Windows IME commit when the textarea replacement invalidates offsets', async () => {
  const { xterm, helper, textarea, handled, endComposition } = createXterm();
  patchXtermImeComposition(xterm);

  textarea.value = '앞';
  textarea.selectionEnd = 1;
  helper.compositionstart();
  helper.compositionupdate({ data: 'ㅎ' });
  textarea.value = '한';
  textarea.selectionEnd = 1;
  endComposition('한');

  await tick();
  assert.equal(handled.join(''), '한');
});

test('does not duplicate middle commits when three compositions queue together', async () => {
  const { xterm, helper, textarea, handled, endComposition } = createXterm();
  patchXtermImeComposition(xterm);

  for (const value of ['니', '니다', '니다라']) {
    helper.compositionstart();
    textarea.value = value;
    textarea.selectionEnd = value.length;
    helper._compositionPosition.end = value.length;
    endComposition(value.at(-1));
  }
  helper.keydown({ keyCode: 190 });

  assert.equal(handled.join(''), '니다라');
  await tick();
  assert.equal(handled.join(''), '니다라');
});

test('uses the full Windows commit when stale offsets leave a partial slice', async () => {
  const { xterm, helper, textarea, handled, endComposition } = createXterm();
  patchXtermImeComposition(xterm);

  textarea.value = '앞';
  textarea.selectionEnd = 1;
  helper.compositionstart();
  textarea.value = '한글';
  textarea.selectionEnd = 2;
  endComposition('한글');

  await tick();
  assert.equal(handled.join(''), '한글');
});

test('fails safely when xterm internals do not match', () => {
  assert.equal(patchXtermImeComposition({}), false);
  const { xterm, helper } = createXterm();
  Object.defineProperty(helper, 'keydown', { value: helper.keydown, writable: false });
  assert.equal(patchXtermImeComposition(xterm), false);
  assert.equal(patchXtermImeComposition({
    _core: { _compositionHelper: { ...createXterm().helper, _coreService: { triggerDataEvent: true } } },
  }), false);
  assert.equal(patchXtermImeComposition({
    _core: { _compositionHelper: { ...createXterm().helper, _textarea: { addEventListener: true } } },
  }), false);
});
