import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createBoardService } from '../../lib/board-service.js';
import { register } from '../../routes/board.js';
import { createBoardWorkerRunner } from '../../lib/board-workers.js';
import { JSDOM } from 'jsdom';
import { mountSessionChecklist } from '../../js/session-checklist.js';

function setup(t) {
  const dir = mkdtempSync('/tmp/cockpit-checklist-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = `${dir}/board.json`;
  const service = createBoardService(file);
  const add = (text, termId = 'one') => service.addBoardTask(text, undefined, 'task', 'user', undefined, termId);
  return { ...service, file, add };
}

test('each session retains 50 items, removes oldest completion and never unfinished work or another session', t => {
  const h = setup(t);
  const other = h.add('다른 세션 작업', 'two').task;
  const first = h.add('계속 미완료').task;
  const completed = h.add('완료됨').task;
  h.updateBoardTask(completed.id, { done: true });
  for (let i = 2; i < 50; i++) h.add(`작업 ${i}`);
  h.add('새 작업');
  const saved = createBoardService(h.file).getBoard();
  assert.equal(saved.tasks.filter(task => task.termId === 'one').length, 50);
  assert.ok(saved.tasks.some(task => task.id === first.id));
  assert.ok(saved.tasks.some(task => task.id === other.id));
  assert.ok(!saved.tasks.some(task => task.id === completed.id));
  assert.throws(() => h.add('넘치는 미완료'), /미완료 작업이 50개/);
  assert.deepEqual(h.getBoard(), saved);
});

test('legacy browser edits retain session ownership and cannot resurrect a pruned completion', t => {
  const h = setup(t);
  const task = h.add('수정 전').task;
  const base = h.getBoard();
  const edited = structuredClone(base);
  edited.tasks[0].text = '수정 후';
  delete edited.tasks[0].termId;
  h.replaceBoardIfRevision(edited, base.revision, base);
  assert.equal(h.getBoard().tasks[0].termId, 'one');
  h.updateBoardTask(task.id, { done: true });
  const old = h.getBoard();
  for (let i = 0; i < 50; i++) h.add(`할 일 ${i}`);
  const newContent = structuredClone(old);
  newContent.notes.push({ id: 'N-0001', title: '메모', content: '별도 메모' });
  h.replaceBoardIfRevision(newContent, old.revision, old);
  assert.equal(h.getBoard().tasks.filter(item => item.termId === 'one').length, 50);
  assert.ok(!h.getBoard().tasks.some(item => item.id === task.id));
});

test('task API accepts a stable session ID, persists completion and rejects unknown sessions', async t => {
  const h = setup(t);
  const routes = {};
  register({ ...h, addRoute: (method, path, handler) => { routes[`${method} ${path}`] = handler; },
    readBody: async req => req.body, json: (res, body, status = 200) => Object.assign(res, { body, status }),
    resolveTerminalRef: id => id === 'one' ? { id, entry: {} } : null });
  const res = {};
  await routes['POST /api/board/tasks']({ body: { text: '검증할 일', termId: 'one' } }, res);
  assert.equal(res.status, 201);
  assert.equal(res.body.task.termId, 'one');
  await routes['PATCH /api/board/tasks/:id']({ params: { id: res.body.task.id }, body: { done: true } }, res);
  assert.equal(res.body.task.done, true);
  await routes['POST /api/board/tasks']({ body: { text: '검증할 일', termId: 'missing' } }, res);
  assert.equal(res.status, 400);
});

test('worker checklist survives reassignment to another supervisor', t => {
  const h = setup(t);
  h.add('이전 감독 때 등록한 미완료 작업');
  const { supervisor } = h.addBoardSupervisor('다음 감독');
  h.updateBoardReview({ termId: 'manager-two', watched: [{ termId: 'one', goal: '검증 통과' }] }, undefined, supervisor.id);
  let time = Date.now();
  const messages = [];
  const tick = createBoardWorkerRunner({ ...h, now: () => time,
    resolveTerminalRef: id => ({ id, entry: { pty: { write: message => messages.push(message) } } }), terminalAgent: () => 'claude',
    readTerminalScreen: () => ({ current: true, lines: ['❯ ', '⏵⏵ auto mode on'] }) });
  tick(supervisor.id); time += 15000; tick(supervisor.id);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /이전 감독 때 등록한 미완료 작업/);
  assert.match(messages[0], /전체 tasks에서 termId/);
});

test('checklist blocking edits preserve their text after remote completion or deletion', t => {
  const h = setup(t), task = h.add('편집할 작업').task;
  const dom = new JSDOM('<section></section>');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; dom.window.close(); });
  const panel = dom.window.document.querySelector('section'), draft = {};
  const ui = mountSessionChecklist(panel, { termId: 'one', draft, getSupervisorId: () => 'S-0001', onSaved: () => {} });
  ui(h.getBoard());
  const select = panel.querySelector('[data-sc-state]'); select.value = 'blocked';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const text = panel.querySelector('[data-sc-blocker]'); text.value = '사용자가 작성하던 긴 대기 근거';
  text.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  h.updateBoardTask(task.id, { done: true }); ui(h.getBoard());
  assert.equal(draft.blockEdit.blocker, text.value);
  assert.equal(panel.querySelector('[data-sc-blocker]').value, text.value);
  assert.match(panel.textContent, /입력은 남아 있습니다/);
  h.deleteBoardTask(task.id); ui(h.getBoard());
  assert.equal(panel.querySelector('[data-sc-blocker]').value, text.value);
  panel.querySelector('[data-sc-block-cancel]').click();
  assert.equal(draft.blockEdit, null);
});

test('checklist blocking editor saves real dependency IDs and preserves a stale draft on conflict', async t => {
  const h = setup(t), task = h.add('구현할 작업').task;
  const question = h.addBoardTask('정확한 자료 경로', undefined, 'question').task;
  const dom = new JSDOM('<section></section>');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document'), originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  t.after(() => { globalThis.fetch = originalFetch; if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; dom.window.close(); });
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    try { return Response.json(h.updateBoardTask(url.split('/').at(-1), JSON.parse(options.body))); }
    catch (error) { return Response.json({ error: error.message }, { status: 409 }); }
  };
  const panel = dom.window.document.querySelector('section'), draft = {};
  const ui = mountSessionChecklist(panel, { termId: 'one', draft, getSupervisorId: () => 'S-0001', onSaved: board => ui(board || h.getBoard()) });
  const edit = reason => {
    const select = panel.querySelector('[data-sc-state]'); select.value = 'blocked'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const text = panel.querySelector('[data-sc-blocker]'); text.value = reason; text.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const dependency = panel.querySelector('[data-sc-dependency]'); dependency.value = question.id; dependency.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  ui(h.getBoard()); edit('원전 위치 필요'); assert.equal(requests, 0);
  panel.querySelector('[data-sc-block-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.getBoard().tasks.find(t => t.id === task.id).status, 'blocked');
  assert.deepEqual(h.getBoard().tasks.find(t => t.id === task.id).waitFor, [question.id]);
  edit('오래된 조건으로 편집 중');
  h.updateBoardTask(question.id, { answer: '허용 경로의 원전' }); ui(h.getBoard());
  panel.querySelector('[data-sc-block-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.getBoard().tasks.find(t => t.id === task.id).status, 'ready');
  assert.equal(draft.blockEdit.blocker, '오래된 조건으로 편집 중');
  assert.match(panel.querySelector('.sc-notice').textContent, /작업 상태가 다른 곳/);
});
