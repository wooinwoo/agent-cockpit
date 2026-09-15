// ─── Notes API — 노트 CRUD (lib/notes-service.js 래핑) ───

export function register(ctx) {
  const { addRoute, json, readBody, listNotes, getNote, createNote, updateNote, deleteNote, rateLimit } = ctx;

  addRoute('GET', '/api/notes', async (_req, res) => {
    try { json(res, { notes: await listNotes() }); }
    catch (err) { json(res, { error: `노트 목록을 읽지 못했습니다: ${err.message}` }, 500); }
  });

  addRoute('GET', '/api/notes/:id', async (req, res) => {
    const note = await getNote(req.params.id);
    if (!note) return json(res, { error: 'Not found' }, 404);
    json(res, note);
  });

  addRoute('POST', '/api/notes', async (req, res) => {
    if (!rateLimit(`notes:create:${req.socket?.remoteAddress}`, 30)) return json(res, { error: 'Too many requests' }, 429);
    const body = await readBody(req);
    const title = typeof body.title === 'string' ? body.title.slice(0, 200) : '';
    if (!title.trim()) return json(res, { error: 'title required' }, 400);
    const content = typeof body.content === 'string' ? body.content.slice(0, 500_000) : '';
    const tags = Array.isArray(body.tags) ? body.tags.filter(t => typeof t === 'string').slice(0, 20) : [];
    try { json(res, await createNote({ title, content, project: body.project || '', tags }), 201); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('PUT', '/api/notes/:id', async (req, res) => {
    const body = await readBody(req);
    const updates = {};
    for (const key of ['title', 'content', 'project']) {
      if (typeof body[key] === 'string') updates[key] = body[key].slice(0, key === 'content' ? 500_000 : 200);
    }
    if (Array.isArray(body.tags)) updates.tags = body.tags.filter(t => typeof t === 'string').slice(0, 20);
    if (!Object.keys(updates).length) return json(res, { error: 'no updatable fields' }, 400);
    const note = await updateNote(req.params.id, updates);
    if (!note) return json(res, { error: 'Not found' }, 404);
    json(res, note);
  });

  addRoute('DELETE', '/api/notes/:id', async (req, res) => {
    const ok = await deleteNote(req.params.id);
    if (!ok) return json(res, { error: 'Not found' }, 404);
    json(res, { deleted: true });
  });
}
