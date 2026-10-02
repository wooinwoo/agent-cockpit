import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/board.js';

function setup() {
  const routes = {};
  let board = { note: { content: '', updatedAt: 0 }, tasks: [], nextTaskNumber: 1, revision: 0, updatedAt: 0 };
  register({
    addRoute(method, path, handler) { routes[`${method} ${path}`] = handler; },
    json(res, data, status = 200) { res.status = status; res.body = data; },
    readBody: async req => req.body || {},
    getBoard: () => board,
    replaceBoardIfRevision: (value, revision) => {
      if (revision !== board.revision) throw Object.assign(new Error('changed'), { code: 'BOARD_CONFLICT' });
      board = { ...value, revision: revision + 1 };
      return board;
    },
    updateBoardNote: content => (board = { ...board, note: { content } }),
    appendBoardNote: content => (board = { ...board, note: { content: `${board.note.content}\n${content}`.trim() } }),
    addBoardTask: (text, checklistId, kind, questionTo) => ({ board, task: { id: 'T-0001', text, checklistId, kind, questionTo, done: false } }),
    updateBoardTask: (id, updates) => id === 'T-0001' ? ({ board, task: { id, ...updates } }) : null,
    deleteBoardTask: id => id === 'T-0001' ? ({ board, task: { id } }) : null,
  });
  return routes;
}

describe('board routes', () => {
  it('forwards the question recipient to storage', async () => {
    const result = {};
    await setup()['POST /api/board/tasks']({ body: { text: '진행 상황은?', kind: 'question', questionTo: 'supervisor' } }, result);
    assert.equal(result.body.task.kind, 'question');
    assert.equal(result.body.task.questionTo, 'supervisor');
  });
  it('lists, creates, completes, and deletes tasks by ID', async () => {
    const routes = setup();
    const created = {};
    await routes['POST /api/board/tasks']({ body: { text: 'ship it', checklistId: 'C-0002' } }, created);
    assert.equal(created.status, 201);
    assert.equal(created.body.task.id, 'T-0001');
    assert.equal(created.body.task.checklistId, 'C-0002');

    const completed = {};
    await routes['PATCH /api/board/tasks/:id']({ params: { id: 'T-0001' }, body: { done: true } }, completed);
    assert.equal(completed.body.task.done, true);

    const deleted = {};
    routes['DELETE /api/board/tasks/:id']({ params: { id: 'T-0001' } }, deleted);
    assert.equal(deleted.body.task.id, 'T-0001');
  });

  it('returns 404 for an unknown task ID', async () => {
    const routes = setup();
    const res = {};
    await routes['PATCH /api/board/tasks/:id']({ params: { id: 'T-9999' }, body: { done: true } }, res);
    assert.equal(res.status, 404);
  });

  it('appends a note through a single mutation route', async () => {
    const routes = setup();
    const res = {};
    await routes['POST /api/board/note/append']({ body: { content: 'next' } }, res);
    assert.equal(res.body.note.content, 'next');
  });

  it('atomically imports a local board and rejects stale revisions', async () => {
    const routes = setup();
    const imported = {};
    await routes['PUT /api/board']({ body: { board: { note: { content: 'offline' }, tasks: [] }, revision: 0 } }, imported);
    assert.equal(imported.body.revision, 1);
    const stale = {};
    await routes['PUT /api/board']({ body: { board: { note: { content: 'stale' }, tasks: [] }, revision: 0 } }, stale);
    assert.equal(stale.status, 409);
  });

  it('returns a server error for storage failures', () => {
    const routes = setup();
    const error = Object.assign(new Error('disk unavailable'), { code: 'BOARD_STORAGE' });
    routes['GET /api/board'] = (() => {
      const isolated = {};
      register({
        addRoute(method, path, handler) { isolated[`${method} ${path}`] = handler; },
        json(res, data, status = 200) { res.status = status; res.body = data; },
        readBody: async () => ({}),
        getBoard: () => { throw error; },
      });
      return isolated['GET /api/board'];
    })();
    const res = {};
    routes['GET /api/board']({}, res);
    assert.equal(res.status, 500);
  });
});
