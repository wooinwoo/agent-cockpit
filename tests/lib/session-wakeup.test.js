import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountSessionWakeup } from '../../js/session-wakeup.js';

function fixture(t, fetch) {
  const dom = new JSDOM('<section></section>');
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, fetch })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  Object.defineProperty(dom.window.document, 'hidden', { value: false });
  t.after(() => dom.window.close());
  return { dom, root: dom.window.document.querySelector('section') };
}

test('config loads without a secret and edits survive a pending refresh and panel remount', async t => {
  let complete;
  const h = fixture(t, () => new Promise(resolve => { complete = config => resolve({ ok: true, json: async () => config }); }));
  const draft = {};
  const refresh = mountSessionWakeup(h.root, { termId: 'one', draft });
  const pending = refresh();
  const fields = h.root.querySelector('form').elements;
  fields.afterSeconds.value = '120'; fields.url.value = 'http://127.0.0.1/hook';
  fields.url.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  complete({ enabled: false, afterSeconds: 600, url: '', secretConfigured: true });
  await pending;
  assert.equal(fields.afterSeconds.value, '120');
  assert.equal(fields.url.value, 'http://127.0.0.1/hook');
  mountSessionWakeup(h.root, { termId: 'one', draft });
  assert.equal(h.root.querySelector('[name=afterSeconds]').value, '120');
  assert.equal(h.root.querySelector('[name=url]').value, 'http://127.0.0.1/hook');
  assert.equal(draft.wakeup.dirty, true);
});

test('saving an existing destination keeps its secret unless a replacement is entered', async t => {
  const calls = [];
  const config = { enabled: true, afterSeconds: 600, url: 'http://127.0.0.1/hook', secretConfigured: true };
  const h = fixture(t, async (url, opts) => {
    calls.push({ url, ...opts });
    return { ok: true, json: async () => opts?.method === 'PUT' ? { ...config, ...JSON.parse(opts.body) } : config };
  });
  const draft = {}, refresh = mountSessionWakeup(h.root, { termId: 'one', draft });
  await refresh();
  const form = h.root.querySelector('form');
  form.elements.afterSeconds.value = '300';
  form.elements.afterSeconds.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  form.dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const sent = JSON.parse(calls.find(call => call.method === 'PUT').body);
  assert.equal(sent.afterSeconds, 300);
  assert.equal('secret' in sent, false);
  assert.equal(draft.wakeup.dirty, false);
  assert.equal(form.elements.secret.value, '');
});

test('wakeup tab works for an unassigned session and avoids full board polling', async t => {
  const calls = [];
  const h = fixture(t, async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ enabled: false, afterSeconds: 600, url: '', secretConfigured: false }) };
  });
  const { createSessionManagement, refreshSessionManagement } = await import('../../js/session-management.js');
  const panel = createSessionManagement('unassigned', { alias: 'ai1' });
  panel.getClientRects = () => [{ width: 400, height: 600 }];
  h.root.append(panel);
  calls.length = 0; // The initial settings tab may fetch the board once.
  panel.querySelector('[data-sm-tab="wakeup"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(panel.querySelector('[data-sm-panel="wakeup"]').hidden, false);
  assert.equal(panel.querySelector('[data-sm-panel="settings"]').hidden, true);
  assert.equal(panel.querySelector('[data-sm-tab="wakeup"]').getAttribute('aria-selected'), 'true');
  assert.ok(panel.querySelector('[data-wakeup-status]').textContent.includes('감시 꺼짐'));
  await refreshSessionManagement();
  assert.deepEqual(calls, ['/api/terminals/unassigned/wakeup']);
  panel.querySelector('[data-sm-tab="wakeup"]').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(panel.querySelector('[data-sm-tab="settings"]').getAttribute('aria-selected'), 'true');
});
