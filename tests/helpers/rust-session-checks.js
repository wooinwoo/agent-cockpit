import { mkdir, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function prepareSessionChecks({ fixture, sandbox }) {
  const homes = [fixture.directory, join(sandbox, 'home')];
  const encoded = fixture.project.replace(/[/\\]/g, '-');
  if (encoded !== fixture.project.replace(/[^a-zA-Z0-9]/g, '-')) {
    throw new Error('Session fixture path must share both Claude directory encodings');
  }
  const main = 'abcd-0001';
  const limited = 'abcd-0002';
  const modified = Math.floor((Date.now() - 600_000) / 1000) * 1000;
  const activeAt = modified + 86_400_000;
  const title = `  ${'a'.repeat(58)}😀 title`;
  const content = [
    { type: 'user', timestamp: '2026-01-02T00:00:00.000Z', message: { content: [
      { type: 'text', text: title }, { type: 'image', source: { type: 'url', url: 'https://example.invalid/input.png' } },
      { type: 'text', text: '고립 서로게이트 \ud800' },
    ] } },
    { type: 'assistant', timestamp: '2026-01-02T00:01:00.000Z', message: {
      model: 'claude-sonnet-4-20260101', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 },
      content: [
        { type: 'thinking', thinking: '비공개 fixture 생각 \udc00' },
        { type: 'text', text: 'git commit -m "test: 한글\ud800 보존"' },
        { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/fixture/read.txt' } },
        { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/fixture/edit.txt', old_string: 'old', new_string: 'new' } },
        { type: 'tool_use', id: 'write', name: 'write_to_file', input: { path: '/fixture/write.txt' } },
        { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: `echo ${'x'.repeat(140)}` } },
        { type: 'tool_use', id: 'grep', name: 'search_files', input: { query: 'needle' } },
        { type: 'tool_use', id: 'glob', name: 'Glob', input: { pattern: '**/*.js' } },
        { type: 'tool_use', id: 'task', name: 'Task', input: { description: 'fixture review' } },
        { type: 'tool_use', name: 'Other', input: { short: 'value', count: 1 } },
      ],
    } },
    { type: 'user', createdAt: '2026-01-02T00:02:00.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'edit', content: '+12 lines' },
      { type: 'tool_result', tool_use_id: 'read', content: [
        'plain text', { type: 'image', source: { type: 'url', url: 'https://example.invalid/tool.png' } },
        { type: 'text', text: 'array text\ud800' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Zml4dHVyZQ==' } },
      ] },
      { type: 'image', source: { type: 'base64', data: 'YWJj' } },
      { type: 'tool_result' },
    ] } },
    { type: 'user', message: { content: `long-user:${'u'.repeat(2990)}😀 after` } },
    { type: 'assistant', message: { content: `long-assistant:${'a'.repeat(4984)}😀 after` } },
    { type: 'assistant', message: { content: '' } },
    { type: 'assistant', timestamp: null, message: { usage: { input_tokens: 2, output_tokens: 4 }, content: [{ type: 'text', text: 'finished' }] } },
  ];
  // The title limit counts physical lines, including blanks and invalid JSON.
  const limitedLines = ['', '{broken', ...Array.from({ length: 48 }, () => JSON.stringify({ type: 'progress' })),
    ...Array.from({ length: 220 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `user-${i}` } })),
    ...Array.from({ length: 510 }, (_, i) => JSON.stringify({ type: 'assistant', message: {
      model: 'claude-haiku-20260101', content: [{ type: 'tool_use', name: 'Write', id: `tool-${i}`, input: { file_path: `/fixture/file-${i}` } }],
    } })),
  ];
  const files = [[main, ['{bad JSON', ...content.map(entry => JSON.stringify(entry)), ''].join('\n'), modified],
    [limited, `${limitedLines.join('\n')}\n`, modified - 10_000]];
  for (const home of homes) {
    const directory = join(home, '.claude/projects', encoded);
    await mkdir(directory, { recursive: true });
    for (const [id, text, stamp] of files) {
      const path = join(directory, `${id}.jsonl`);
      await writeFile(path, text);
      await utimes(path, stamp / 1000, stamp / 1000);
    }
    const dbDirectory = join(home, '.local/share/opencode');
    await mkdir(dbDirectory, { recursive: true });
    const db = new DatabaseSync(join(dbDirectory, 'opencode.db'));
    try {
      db.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER); CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER)');
      const insert = db.prepare('INSERT OR REPLACE INTO session VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('native-main', fixture.project, JSON.stringify({ id: 'native-model' }), 'OpenCode fixture', activeAt, null);
      insert.run('native-child', `${fixture.project}/child`, JSON.stringify({ id: 'child-model' }), `${'o'.repeat(79)}😀`, activeAt + 1000, null);
      insert.run('native-archived', fixture.project, '{}', 'Excluded archived session', activeAt + 2000, activeAt);
      db.prepare('INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?)').run('fixture-message', 'native-main', JSON.stringify({ role: 'assistant' }), activeAt);
    } finally { db.close(); }
  }
  fixture.sessions = { main, limited, modified, activeAt, title, projectId: 'session-contract' };
}

// Input/detail are JSON.stringify projections. V preserves values but not the
// original insertion order of nested object properties, so compare that payload.
function canonical(value, key = '') {
  if (typeof value === 'string' && (key === 'input' || key === 'detail') && /^[{[]/.test(value)) {
    try { return canonical(JSON.parse(value)); } catch { /* truncated or plain text */ }
  }
  if (Array.isArray(value)) return value.map(item => canonical(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name], name)]));
  return value;
}

async function initialSessions(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader;
  try {
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Session SSE ended before init');
      pending += decoder.decode(value, { stream: true });
      for (let split; (split = pending.indexOf('\n\n')) >= 0;) {
        const frame = pending.slice(0, split); pending = pending.slice(split + 2);
        if (frame.match(/^event: (.+)$/m)?.[1] === 'init') return JSON.parse(frame.match(/^data: (.+)$/m)[1]).sessions;
      }
    }
  } finally {
    controller.abort(); clearTimeout(timer);
    await reader?.cancel().catch(() => {});
  }
}

export async function verifySessionChecks({ fixture, sandbox, rustUrl, request, check }) {
  if (!fixture.sessions) throw new Error('prepareSessionChecks must run before verification');
  const { main, limited, activeAt, projectId } = fixture.sessions;
  const bases = [fixture.url, rustUrl];
  const project = `/api/projects/${projectId}`;
  const query = `projectPath=${encodeURIComponent(fixture.project)}`;
  const registered = [];
  const pair = async (path, expected = 200) => {
    const responses = await Promise.all(bases.map(base => request(base, path)));
    check(responses.map(r => r.status), [expected, expected], `${path} status`);
    check(canonical(responses[1].data), canonical(responses[0].data), `${path} Node contract`);
    return responses[1].data;
  };
  try {
    for (const base of bases) {
      const response = await request(base, '/api/projects', { method: 'POST', body: { id: projectId, name: 'Session contract', path: fixture.project } });
      check(response.status, 201, 'Private session project registration');
      registered.push(base);
      check(response.data.id, projectId, 'Same session project ID in both runtimes');
    }
    const listing = await pair(`/api/claude-sessions?${query}`);
    check(listing.sessions.find(s => s.id === main).title, ` ${'a'.repeat(58)}\ud83d`, 'Title is 60 UTF-16 units after whitespace collapse');
    check(listing.sessions.find(s => s.id === limited).title, '', 'Title stops after 50 physical lines');
    await pair(`/api/claude-sessions?${query}`); // Cached title path.
    const chat = await pair(`/api/claude-session?${query}&sessionId=${main}`);
    check(chat.model, 'claude-sonnet-4-20260101', 'Chat retains the first full model name');
    check(chat.usage, { in: 1_000_005, out: 1_000_004 }, 'Chat input includes cache creation but excludes cache reads');
    const allParts = chat.messages.flatMap(m => m.parts);
    check(allParts.some(p => p.kind === 'thinking' && p.text.endsWith('\udc00')), true, 'Thinking keeps lone surrogate');
    check(allParts.filter(p => p.kind === 'image' && p.label === 'tool image').length, 2, 'Array tool results retain both image sources');
    check(allParts.some(p => p.kind === 'tool_result' && !Object.hasOwn(p, 'content')), true, 'Missing tool-result fields remain omitted');
    await pair(`/api/claude-session?${query}`);
    await pair(`/api/claude-session?${query}&sessionId=abcd-000`);
    await pair(`/api/claude-session?${query}&sessionId=not-found`);
    const messages = await pair(`${project}/sessions/${main}/messages`);
    const longUser = messages.find(m => m.content.startsWith('long-user:'));
    check(longUser.content.length, 3000, 'User preview truncation');
    const longAssistant = messages.find(m => m.content.startsWith('long-assistant:'));
    check(longAssistant.content.length, 5000, 'Assistant preview truncation');
    check(longAssistant.content.charCodeAt(4999), 0xd83d, 'Assistant truncation retains a lone high surrogate');
    check(messages.some(m => m.role === 'user' && !Object.hasOwn(m, 'ts')), true, 'Message timestamps remain omitted when absent');
    const timeline = await pair(`${project}/sessions/${main}/timeline`);
    check(timeline.summary.model, 'sonnet-4', 'Timeline strips model family prefix and date');
    check(timeline.summary.tokens, { input: 1_000_002, output: 1_000_004, cacheRead: 7, cacheWrite: 3 }, 'Timeline token categories');
    check(timeline.events.find(e => e.type === 'commit').detail, 'test: 한글\ud800 보존', 'Commit detail preserves UTF-16');
    check(timeline.summary.filesChanged.find(f => f.fullPath === '/fixture/edit.txt'), { path: 'edit.txt', fullPath: '/fixture/edit.txt', adds: 0, removes: 0 }, 'Tool result file tracking retains source shape');
    const cappedMessages = await pair(`${project}/sessions/${limited}/messages`);
    check(cappedMessages.length, 200, 'Session preview returns the last 200 messages');
    check(cappedMessages[0].tools[0].input, '{"file_path":"/fixture/file-310"}', 'Message limit selects the tail');
    const cappedTimeline = await pair(`${project}/sessions/${limited}/timeline`);
    check(cappedTimeline.events.length, 500, 'Timeline returns the first 500 events');
    check(cappedTimeline.events.at(-1).id, 'tool-499', 'Timeline limit selects the head');
    check(cappedTimeline.summary.filesChanged.length, 510, 'Timeline aggregates files beyond the visible event cap');
    check(cappedTimeline.summary.messageCount, 220, 'Timeline counts all user messages');
    const sessions = await pair(`${project}/sessions`);
    check(sessions.some(s => s.sessionId === 'oc:native-main' && s.source === 'opencode'), true, 'OpenCode rows merge with Claude sessions');
    check(sessions.some(s => s.sessionId === 'oc:native-archived'), false, 'Archived OpenCode rows are excluded');
    check(sessions.find(s => s.sessionId === 'oc:native-child').title, `${'o'.repeat(79)}\ud83d`, 'OpenCode title uses 80 UTF-16 units');
    for (const suffix of ['messages', 'timeline']) {
      for (const invalid of ['INVALID', 'abc_def', 'oc:native-main']) await pair(`${project}/sessions/${invalid}/${suffix}`, 400);
      const missing = await pair(`${project}/sessions/ffffffff/${suffix}`);
      check(missing, suffix === 'messages' ? [] : { events: [], summary: null }, 'Missing session preserves empty response shape');
    }
    await pair('/api/claude-sessions', 400);
    await pair('/api/claude-session', 400);
    const absentPath = encodeURIComponent(join(sandbox, 'missing-session-project'));
    check(await pair(`/api/claude-sessions?projectPath=${absentPath}`), { sessions: [] }, 'Missing Claude directory list');
    check(await pair(`/api/claude-session?projectPath=${absentPath}`), { messages: [], session: null }, 'Missing Claude directory chat');
    const states = [];
    for (const base of bases) {
      let state;
      for (let i = 0; i < 150; i++) {
        state = (await request(base, '/api/projects')).data.find(p => p.id === projectId)?.session;
        if (state?.sessionId === 'native-main') break;
        await delay(100);
      }
      check(state, { projectId, state: 'busy', sessionId: 'native-main', lastActivity: new Date(activeAt).toISOString(), model: 'native-model' }, 'OpenCode exact directory takes precedence over newer child session');
      states.push(state);
      const initial = await initialSessions(base);
      check(initial[projectId], state, 'SSE init carries the same session state as project polling');
    }
    check(states[1], states[0], 'Native session state matches Node');
  } finally {
    for (const base of registered) {
      const response = await request(base, project, { method: 'DELETE' });
      check(response.status, 200, 'Remove private session project registration');
    }
  }
}
