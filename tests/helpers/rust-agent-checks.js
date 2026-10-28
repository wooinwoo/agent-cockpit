import { readFile, writeFile, stat, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_PROFILES, TEAMS } from '../../lib/agent-profiles.js';

export async function prepareAgentChecks({ fixture, sandbox }) {
  const now = Date.now();
  const entry = (count, createdAt) => ({ createdAt, extension: { preserve: true }, messages: Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: 한글 ${'😀'.repeat(45)}\ud83d`, ts: now - count + i, extra: { nested: '\udc00' } })) });
  const history = { 'conv-old': entry(1, now - 8 * 86_400_000), 'conv-latest': entry(105, now - 1000), 'conv-z': entry(1, now - 2000), 'conv-a': entry(2, now - 2000), '12': entry(1, now - 2000), '2': entry(1, now - 2000) };
  await Promise.all([join(fixture.directory, 'data/cockpit'), sandbox].map(path => writeFile(join(path, 'agent-history.json'), JSON.stringify(history))));
  fixture.agentHistory = history;
}

export async function verifyAgentChecks({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl];
  const pair = (path, options) => Promise.all(bases.map(base => request(base, path, options)));
  const compare = async (path, options) => {
    const [node, rust] = await pair(path, options);
    check(rust.status, node.status, `Agent status ${path}`);
    check(rust.data, node.data, `Agent response ${path}`);
    return rust.data;
  };
  const list = await compare('/api/agent/conversations');
  check(list.map(c => c.id), ['conv-latest', '2', '12', 'conv-z', 'conv-a', 'conv-old'], 'History stable sort follows JS property order');
  check(list[0].lastMessage.length, 80, 'Conversation preview uses 80 UTF16 units');
  for (const id of [...Object.keys(fixture.agentHistory), 'missing']) await compare(`/api/agent/conversations/${id}`);
  const catalog = JSON.parse(await readFile(new URL('../../rust-server/src/agent_profiles.json', import.meta.url), 'utf8'));
  check(catalog, { profiles: Object.entries(AGENT_PROFILES), teams: Object.values(TEAMS) }, 'Compiled catalog retains current original profiles, personas and aliases');
  for (const path of ['/api/agent/model', '/api/agent/username', '/api/agent/agents', '/api/agent/teams', '/api/agent/company']) await compare(path);
  for (const model of ['flash', 'pro', ...Object.keys(AGENT_PROFILES), 'invalid', {}, [], null, false, '', 'auto']) await compare('/api/agent/model', { method: 'POST', body: { model } });
  for (const name of ['  테스트 😀\ud83d  ', '', ' \uFEFF ', '\t대표\n', null, false]) await compare('/api/agent/username', { method: 'POST', body: { name } });
  check((await request(rustUrl, '/api/agent/username', { method: 'POST', body: { name: {} } })).status, 400, 'Invalid name type fails without damaging server state');
  for (const id of ['conv-a', 'missing']) await compare(`/api/agent/conversations/${id}`, { method: 'DELETE' });
  const histories = [join(fixture.directory, 'data/cockpit/agent-history.json'), join(sandbox, 'agent-history.json')];
  for (let i = 0; i < histories.length; i++) {
    for (let retry = 0; retry < 100; retry++) {
      const saved = await readFile(histories[i], 'utf8').then(JSON.parse).catch(() => null);
      if (saved && !saved['conv-a']) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const saved = JSON.parse(await readFile(histories[i], 'utf8'));
    check(saved['conv-latest'].messages, fixture.agentHistory['conv-latest'].messages.slice(-100), 'Saved history preserves last100 message bodies and unknown fields');
  }
  check(JSON.parse(await readFile(histories[1], 'utf8'))['conv-latest'].extension, { preserve: true }, 'Native history preserves conversation extensions');
  check((await stat(histories[1])).mode & 0o777, 0o600, 'History is private');
  const created = [[], []];
  for (let n = 0; n < 55; n++) {
    const values = await pair('/api/agent/conversations', { method: 'POST', body: {} });
    for (let i = 0; i < values.length; i++) {
      check(values[i].status, 201, 'Create conversation');
      check(/^conv-\d+-[a-z0-9]{1,4}$/.test(values[i].data.id), true, 'Original conversation ID shape');
      created[i].push(values[i].data.id);
    }
    if (n === 0) for (const base of bases) check((await request(base, '/api/agent/conversations/conv-old')).status, 404, 'Creation evicts conversations older than7days');
  }
  for (let i = 0; i < bases.length; i++) {
    const rows = (await request(bases[i], '/api/agent/conversations')).data;
    check(rows.length, 50, 'Conversation count limited to50');
    check(rows.every(row => created[i].includes(row.id) && row.messageCount === 0 && row.lastMessage === ''), true, 'Only recent created conversations remain');
  }
  const concurrent = await Promise.all(Array.from({ length: 10 }, () => request(rustUrl, '/api/agent/conversations', { method: 'POST', body: {} })));
  check(concurrent.every(r => r.status === 201), true, 'Concurrent creates persist successfully');
  check(new Set(concurrent.map(r => r.data.id)).size, 10, 'Concurrent conversation IDs are distinct');
  check(Object.keys(JSON.parse(await readFile(histories[1], 'utf8'))).length, 50, 'Concurrent writes retain valid bounded history');
  const original = await readFile(histories[1]);
  try {
    await writeFile(histories[1], '{broken');
    check((await request(rustUrl, '/api/agent/conversations', { method: 'POST', body: {} })).status, 500, 'Corrupt saved history rejects mutations');
    check(await readFile(histories[1], 'utf8'), '{broken', 'Corrupt history bytes retained');
    await unlink(histories[1]);
    const outside = join(fixture.directory, 'outside-agent-history.json');
    await writeFile(outside, original);
    await symlink(outside, histories[1]);
    check((await request(rustUrl, '/api/agent/conversations/missing', { method: 'DELETE' })).status, 500, 'Symlink history rejects mutations');
    check((await readFile(outside)).equals(original), true, 'Outside history untouched');
    await unlink(histories[1]);
  } finally {
    await writeFile(histories[1], original, { mode: 0o600 });
  }
  // Leave no conversation fixtures for subsequent checks. No chat or real LLM
  // request is made; full chat orchestration is a separate migration gate.
  for (const base of bases) {
    const rows = (await request(base, '/api/agent/conversations')).data;
    for (const row of rows) check((await request(base, `/api/agent/conversations/${row.id}`, { method: 'DELETE' })).status, 200, 'Remove private conversation fixture');
  }
}
