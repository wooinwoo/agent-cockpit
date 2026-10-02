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
    panel.close = () => { panel.open = false; };
    let resolveNotes;
    const response = new Promise(resolve => { resolveNotes = resolve; });
    const actions = {};
    let mounts = 0;
    const context = {
      window: dom.window, document, setTimeout, clearTimeout,
      app: {}, notify() {}, showToast(message) { throw new Error(message); },
      esc: value => String(value), fetchJson: () => response,
      registerClickActions: value => Object.assign(actions, value), registerInputActions() {},
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
    actions['close-floating-supervision']();
    await Promise.all(Array.from({ length: 8 }, () => actions['toggle-floating-supervision']()));
    assert.equal(document.querySelectorAll('.supervision').length, 1);
    assert.equal(mounts, 1);
    assert.equal(panel.querySelector('input'), input);
    assert.equal(input.value, '미저장 목표');
    await context.initNotes();
    assert.equal(panel.open, false);
    assert.equal(document.querySelector('#notes-editor input'), input);
  } finally { dom.window.close(); }
});
