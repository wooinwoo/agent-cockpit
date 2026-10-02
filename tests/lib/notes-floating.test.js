import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';

test('a delayed Notes response and repeated opens reuse the floating board and its draft', async () => {
  const dom = new JSDOM(`<div id="notes-sidebar-list"></div><div id="docs-toc"></div>
    <div id="notes-editor"></div><div id="terminal-view"></div><button id="supervision-fab"></button>
    <dialog id="supervision-floating"><div class="supervision-floating-head"></div><div class="supervision-floating-body"></div></dialog>`);
  try {
    const { document } = dom.window;
    const panel = document.getElementById('supervision-floating');
    panel.show = () => { panel.open = true; };
    panel.close = () => {
      if (!panel.open) return;
      panel.open = false;
      setTimeout(() => panel.dispatchEvent(new dom.window.Event('close')), 0);
    };
    let resolveNotes;
    const response = new Promise(resolve => { resolveNotes = resolve; });
    const actions = {};
    let mounts = 0;
    let stops = 0;
    const context = {
      window: dom.window, document, setTimeout, clearTimeout,
      app: {}, notify() {}, showToast(message) { throw new Error(message); },
      esc: value => String(value), fetchJson: () => response,
      registerClickActions: value => Object.assign(actions, value), registerInputActions() {},
      canLeaveSupervision: () => true, stopSupervision() { stops++; },
      mountSupervision(main) { mounts++; main.innerHTML = '<div class="supervision"><input name="objective"></div>'; },
    };
    const source = readFileSync(new URL('../../js/notes.js', import.meta.url), 'utf8')
      .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    runInNewContext(`${source}\nglobalThis.initNotes = initNotes;`, context);
    const pending = context.initNotes();
    await actions['toggle-floating-supervision']();
    const input = panel.querySelector('input');
    input.value = '미저장 목표';
    resolveNotes({ notes: [] });
    await pending;
    assert.equal(document.querySelectorAll('.supervision').length, 1);
    assert.equal(mounts, 1);
    const button = document.getElementById('supervision-fab');
    const rect = (element, left, top, width, height) => {
      const [x = 0, y = 0] = element.style.translate.split(' ').map(value => parseFloat(value) || 0);
      return { left: left + x, top: top + y, right: left + x + width, bottom: top + y + height, width, height };
    };
    context.innerWidth = 1000; context.innerHeight = 800;
    button.getClientRects = () => [{}];
    Object.defineProperty(button, 'offsetWidth', { value: 100 });
    button.getBoundingClientRect = () => rect(button, 700, 650, 100, 44);
    panel.getBoundingClientRect = () => rect(panel, 400, 100, 400, 500);
    document.getElementById('terminal-view').getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800 });
    context.moveFloatingSupervision(-200, -50);
    assert.equal(panel.style.translate, '-200px -50px');
    assert.equal(button.style.translate, panel.style.translate);
    actions['close-floating-supervision']();
    assert.equal(button.style.translate, '-200px -50px', 'folding preserves the moved button');
    context.moveFloatingSupervision(5000, 5000);
    assert.ok(button.getBoundingClientRect().right <= 992);
    assert.ok(button.getBoundingClientRect().bottom <= 792);
    await actions['toggle-floating-supervision']();
    assert.equal(button.style.translate, panel.style.translate);
    assert.ok(panel.getBoundingClientRect().top >= 8);
    assert.ok(button.getBoundingClientRect().bottom <= 792);
    actions['close-floating-supervision']();
    await Promise.all(Array.from({ length: 8 }, () => actions['toggle-floating-supervision']()));
    assert.equal(document.querySelectorAll('.supervision').length, 1);
    assert.equal(mounts, 1);
    assert.equal(panel.querySelector('input'), input);
    assert.equal(input.value, '미저장 목표');
    await context.initNotes();
    assert.equal(panel.open, false);
    assert.equal(document.querySelector('#notes-editor input'), input);
    let resolveNote;
    context.fetchJson = () => new Promise(resolve => { resolveNote = resolve; });
    const pendingNote = actions['open-note']({ dataset: { id: 'slow-note' } });
    await Promise.resolve();
    await actions['toggle-floating-supervision']();
    input.value = '늦은 노트가 지우면 안 되는 초안';
    resolveNote({ id: 'slow-note', title: '이전 선택', content: '' });
    await pendingNote;
    assert.equal(stops, 0, 'a stale note must not stop supervision polling or draft protection');
    assert.equal(panel.querySelector('input'), input);
    actions['close-floating-supervision']();
    await actions['toggle-floating-supervision']();
    assert.equal(panel.querySelector('input').value, '늦은 노트가 지우면 안 되는 초안');
    panel.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('#notes-editor input'), input);
    await actions['toggle-floating-supervision']();
    panel.close();
    await actions['toggle-floating-supervision']();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(panel.open, true, 'an older native close event must not undo a reopen');
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.querySelector('input'), input);
    assert.equal(mounts, 1);
  } finally { dom.window.close(); }
});
