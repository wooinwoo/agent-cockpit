import { it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

it('fetches full details only for visible editors and coalesces their refreshes', async () => {
  const dom = new JSDOM('<div data-session-management></div><div data-session-management></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const panels = [...document.querySelectorAll('[data-session-management]')];
  const seen = [];
  for (const panel of panels) panel.refresh = board => { if (board) seen.push(board); };
  const { refreshSessionManagement, updateSessionManagement } = await import('../../js/session-management.js');
  let calls = 0, release;
  globalThis.fetch = async path => {
    calls++; assert.equal(path, '/api/board');
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ updatedAt: 5, tasks: [], supervisors: [] }) };
  };
  await refreshSessionManagement();
  assert.equal(calls, 0);
  panels[0].getClientRects = () => [{}];
  const first = refreshSessionManagement();
  const second = refreshSessionManagement();
  assert.equal(first, second);
  assert.equal(calls, 1);
  release(); await first;
  assert.equal(seen.length, 2);
  updateSessionManagement({ projection: 'overview', updatedAt: 99 });
  assert.ok(seen.every(board => board.updatedAt === 5));
  await refreshSessionManagement();
  assert.equal(calls, 1);
  dom.window.close();
});
