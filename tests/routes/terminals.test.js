import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/terminals.js';

after(() => setTimeout(() => process.exit(0), 200));

function createMockRes() {
  const res = {
    _status: null,
    _body: null,
    writeHead(status, headers) { res._status = status; Object.assign(res._headers || (res._headers = {}), headers || {}); },
    end(data) { res._body = data; },
  };
  return res;
}

function parseBody(res) {
  return res._body == null ? null : JSON.parse(res._body);
}

function createMockReq({ body = null, params = {}, query = {}, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    params, query,
    socket: { remoteAddress },
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: () => Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) };
    },
  };
}

function setup({ written = [], ref = null, summaries = [], screen = null, board = { supervisors: [] }, save = () => {} } = {}) {
  const routes = {};
  const terminals = new Map();
  if (ref) terminals.set(ref.id, { alias: ref.alias, projectId: 'p1', command: '', pty: { write: d => written.push(d) } });
  const ctx = {
    addRoute(method, pattern, handler) { routes[`${method} ${pattern}`] = handler; },
    json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: async (req) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString());
    },
    rateLimit: () => true,
    isLocalhost: (req) => req.socket.remoteAddress === '127.0.0.1',
    resolveTerminalRef: (r) => {
      if (!ref) return null;
      if (r === ref.id || r.toLowerCase() === (ref.alias || '').toLowerCase()) return { id: ref.id, entry: terminals.get(ref.id) };
      return null;
    },
    terminalSummaryList: () => summaries,
    getBoard: () => board,
    updateBoardReview: (updates, expected) => Object.assign(expected, updates),
    saveTerminalStateNow: save,
    readTerminalScreen: (r, lines) => screen && (r === ref.id || r.toLowerCase() === (ref.alias || '').toLowerCase())
      ? { termId: ref.id, alias: ref.alias || '', lines: screen.slice(0, lines), truncated: false }
      : null,
  };
  register(ctx);
  return routes;
}

describe('routes/terminals.js', () => {
  it('conversation hold rejects peer messages and raw keys; release reschedules only related active boards', async () => {
    const active = { id: 'S-1', termId: 'manager', status: 'running', pendingSince: 7, retryAt: 100,
      watched: [{ termId: 'worker' }], workerProgress: [{ termId: 'worker', run: { token: 'existing', resumeSentAt: 3, attempts: 4 } }] };
    const stopped = { ...structuredClone(active), id: 'S-2', status: 'stopped' };
    const unrelated = { ...structuredClone(active), id: 'S-3', watched: [{ termId: 'other' }] };
    const written = []; let saved = 0;
    const routes = setup({ written, ref: { id: 'worker', alias: 'ai6' }, board: { supervisors: [active, stopped, unrelated] }, save: () => saved++ });
    const call = async (path, body) => {
      const res = createMockRes();
      await routes[path](createMockReq({ params: { ref: 'worker' }, body }), res); return res;
    };
    const hold = value => call('PUT /api/terminals/:ref/conversation', { held: value });
    assert.equal((await hold('yes'))._status, 400);
    assert.equal((await hold(true))._status, 200);
    assert.equal(saved, 1);
    for (const data of [{ data: 'next task' }, { data: '\r', enter: false }]) {
      const result = await call('POST /api/terminals/:ref/input', data);
      assert.equal(result._status, 409);
      assert.equal(parseBody(result).code, 'CONVERSATION_HELD');
    }
    assert.deepEqual(written, []);
    assert.equal((await hold(false))._status, 200);
    assert.equal(saved, 2);
    assert.equal(active.pendingSince, 0);
    assert.equal(active.retryAt, 0);
    assert.equal(active.workerProgress[0].run.token, 'existing');
    assert.equal(active.workerProgress[0].run.resumeSentAt, 0);
    assert.equal(stopped.pendingSince, 7);
    assert.equal(unrelated.pendingSince, 7);
    assert.equal((await call('POST /api/terminals/:ref/input', { data: 'fresh task' }))._status, 200);
    assert.deepEqual(written, ['fresh task\r'], 'blocked messages are never replayed');
  });

  it('failed persistence never claims a changed protection state', async () => {
    const written = [];
    let fail = false;
    const routes = setup({ written, ref: { id: 'worker', alias: 'ai6' }, save: () => { if (fail) throw new Error('disk full'); } });
    const set = async held => { const res = createMockRes(); await routes['PUT /api/terminals/:ref/conversation'](createMockReq({ params: { ref: 'worker' }, body: { held } }), res); return res; };
    await set(true); fail = true;
    assert.equal((await set(false))._status, 500);
    const res = createMockRes();
    await routes['POST /api/terminals/:ref/input'](createMockReq({ params: { ref: 'worker' }, body: { data: 'no entry' } }), res);
    assert.equal(res._status, 409);
    assert.deepEqual(written, []);
  });

  it('releasing a stopped supervisor clears its saved protection without restarting supervision', async () => {
    const review = { id: 'S-1', termId: 'manager', status: 'running', watched: [], workerProgress: [], recoveryTerminal: { termId: 'manager' } };
    const routes = setup({ ref: { id: 'manager' }, board: { supervisors: [review] } });
    const set = async held => { const res = createMockRes(); await routes['PUT /api/terminals/:ref/conversation'](createMockReq({ params: { ref: 'manager' }, body: { held } }), res); assert.equal(res._status, 200); };
    await set(true);
    assert.equal(review.recoveryTerminal.conversationHeld, true);
    review.status = 'stopped'; review.nextDueAt = 0;
    await set(false);
    assert.equal(review.recoveryTerminal.conversationHeld, false);
    assert.equal(review.status, 'stopped');
    assert.equal(review.nextDueAt, 0);
  });

  it('GET /api/terminals returns summaries', () => {
    const routes = setup({ summaries: [{ termId: 't1', alias: 'ai1', projectId: 'p1', command: '', account: null, durable: false }] });
    const res = createMockRes();
    routes['GET /api/terminals'](createMockReq(), res);
    assert.equal(res._status, 200);
    assert.deepEqual(parseBody(res).terminals[0], { termId: 't1', alias: 'ai1', projectId: 'p1', command: '', account: null, durable: false });
  });

  it('POST input injects with trailing newline by alias', async () => {
    const written = [];
    const routes = setup({ written, ref: { id: 'proj1-abc123', alias: 'ai2' } });
    const res = createMockRes();
    await routes['POST /api/terminals/:ref/input'](createMockReq({ params: { ref: 'ai2' }, body: { data: 'npm test' } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(written, ['npm test\r']);
    assert.equal(parseBody(res).alias, 'ai2');
  });

  it('POST input honors enter=false and rejects bad data', async () => {
    const written = [];
    const routes = setup({ written, ref: { id: 'proj1-abc123', alias: 'ai2' } });
    const res = createMockRes();
    await routes['POST /api/terminals/:ref/input'](createMockReq({ params: { ref: 'ai2' }, body: { data: 'raw', enter: false } }), res);
    assert.deepEqual(written, ['raw']);

    const res2 = createMockRes();
    await routes['POST /api/terminals/:ref/input'](createMockReq({ params: { ref: 'ai2' }, body: { data: '' } }), res2);
    assert.equal(res2._status, 400);
  });

  it('POST input wraps multiline in bracketed paste', async () => {
    const written = [];
    const routes = setup({ written, ref: { id: 'proj1-abc123', alias: 'ai2' } });
    const res = createMockRes();
    await routes['POST /api/terminals/:ref/input'](createMockReq({ params: { ref: 'ai2' }, body: { data: 'line1\nline2' } }), res);
    assert.deepEqual(written, ['\x1b[200~line1\nline2\x1b[201~\r']);
  });

  it('POST input is forbidden off-localhost and 404 for unknown ref', async () => {
    const routes = setup({ ref: { id: 'proj1-abc123', alias: 'ai2' } });
    const res = createMockRes();
    await routes['POST /api/terminals/:ref/input'](createMockReq({ params: { ref: 'ai2' }, body: { data: 'x' }, remoteAddress: '192.168.0.5' }), res);
    assert.equal(res._status, 403);

    const res2 = createMockRes();
    await routes['POST /api/terminals/:ref/input'](createMockReq({ params: { ref: 'nope' }, body: { data: 'x' } }), res2);
    assert.equal(res2._status, 404);
  });

  it('GET screen reads tail lines by alias, localhost only', () => {
    const routes = setup({ ref: { id: 'proj1-abc123', alias: 'ai1' }, screen: ['l1', 'l2', 'l3'] });
    const res = createMockRes();
    routes['GET /api/terminals/:ref/screen'](createMockReq({ params: { ref: 'ai1' }, query: { lines: '2' } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(parseBody(res).lines, ['l1', 'l2']);

    const res2 = createMockRes();
    routes['GET /api/terminals/:ref/screen'](createMockReq({ params: { ref: 'ai1' }, remoteAddress: '10.0.0.9' }), res2);
    assert.equal(res2._status, 403);
  });
});
