import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/notes.js';

after(() => setTimeout(() => process.exit(0), 200));

function createMockRes() {
  const res = {
    _status: null,
    writeHead(status, headers) { res._status = status; Object.assign(res._headers || (res._headers = {}), headers || {}); },
    end(data) { res._body = data; },
  };
  return res;
}

function parseBody(res) { return res._body == null ? null : JSON.parse(res._body); }

function createMockReq({ body = null, params = {} } = {}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    params,
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: () => Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) };
    },
  };
}

function setup(overrides = {}) {
  const routes = {};
  const notes = new Map();
  const svc = {
    listNotes: async () => [...notes.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(n => ({ ...n, preview: (n.content || '').slice(0, 120) })),
    getNote: async id => notes.get(id) || null,
    createNote: async ({ title, content }) => {
      const note = { id: 'deadbeef01', title, content: content || '', tags: [], createdAt: 1, updatedAt: 2 };
      notes.set(note.id, note);
      return note;
    },
    updateNote: async (id, updates) => {
      const note = notes.get(id);
      if (!note) return null;
      Object.assign(note, updates, { updatedAt: 3 });
      return note;
    },
    deleteNote: async id => notes.delete(id),
    ...overrides,
  };
  const ctx = {
    addRoute(method, pattern, handler) { routes[`${method} ${pattern}`] = handler; },
    json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: async (req) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString());
    },
    rateLimit: () => true,
    ...svc,
  };
  register(ctx);
  return routes;
}

describe('routes/notes.js', () => {
  it('CRUD roundtrip', async () => {
    const routes = setup();
    const created = createMockRes();
    await routes['POST /api/notes'](createMockReq({ body: { title: '테스트 노트', content: '내용' } }), created);
    assert.equal(created._status, 201);
    assert.equal(parseBody(created).title, '테스트 노트');

    const list = createMockRes();
    await routes['GET /api/notes'](createMockReq(), list);
    assert.equal(parseBody(list).notes.length, 1);

    const got = createMockRes();
    await routes['GET /api/notes/:id'](createMockReq({ params: { id: 'deadbeef01' } }), got);
    assert.equal(parseBody(got).content, '내용');

    const missing = createMockRes();
    await routes['GET /api/notes/:id'](createMockReq({ params: { id: 'nope' } }), missing);
    assert.equal(missing._status, 404);

    const updated = createMockRes();
    await routes['PUT /api/notes/:id'](createMockReq({ params: { id: 'deadbeef01' }, body: { content: '고침' } }), updated);
    assert.equal(parseBody(updated).content, '고침');
    assert.equal(parseBody(updated).updatedAt, 3);

    const badUpdate = createMockRes();
    await routes['PUT /api/notes/:id'](createMockReq({ params: { id: 'deadbeef01' }, body: {} }), badUpdate);
    assert.equal(badUpdate._status, 400);

    const deleted = createMockRes();
    await routes['DELETE /api/notes/:id'](createMockReq({ params: { id: 'deadbeef01' } }), deleted);
    assert.deepEqual(parseBody(deleted), { deleted: true });
  });

  it('rejects empty title and truncates long content', async () => {
    const routes = setup();
    const bad = createMockRes();
    await routes['POST /api/notes'](createMockReq({ body: { title: '   ' } }), bad);
    assert.equal(bad._status, 400);

    const long = createMockRes();
    await routes['POST /api/notes'](createMockReq({ body: { title: 'ok', content: 'x'.repeat(500_100) } }), long);
    assert.equal(long._status, 201);
    assert.equal(parseBody(long).content.length, 500_000);
  });
});
