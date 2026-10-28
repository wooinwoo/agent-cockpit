// Exercise actual HTTP, SSE, storage and owned native jobs using private providers.
// The fixture contains no user credentials, projects, sessions or remote services.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { prepareTelegramChecks, cleanupTelegramChecks } from '../tests/helpers/rust-telegram-checks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = join(root, 'docs/_local/rust-agent-runtime-verification.json');
const report = { status: 'running', checkedAt: new Date().toISOString(), runtimeApiIntegrated: false, productionReady: false, assertions: 0 };
await mkdir(join(root, 'docs/_local'), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.assertions++; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, message, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await pause(20); }
  throw new Error(message);
}
async function request(base, path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
const plan = (calls, message = '확인 중') => JSON.stringify({ thinking: 'Private fixture plan', message, tool_calls: calls, is_final: false });
const cockpit = argument => ({ tool: 'COCKPIT', argument });
const queue = [], calls = [], held = new Set(), unexpected = [];
const provider = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const call = { url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()), closed: false };
  calls.push(call);
  res.on('close', () => { call.closed = true; held.delete(res); });
  const answer = queue.shift();
  if (answer === undefined) { unexpected.push(call.url); res.writeHead(500); res.end('{}'); return; }
  if (answer === null) { held.add(res); return; }
  const body = { candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] };
  if (req.url.includes(':streamGenerateContent')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify(body)}\n\n`);
  } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
let fixture, runtime, streamAbort, streamDone, approvals;
const events = [];
async function subscribe() {
  streamAbort = new AbortController();
  const response = await fetch(runtime.url + '/api/events', { signal: streamAbort.signal });
  check(response.status, 200, 'SSE connection');
  streamDone = (async () => {
    let pending = ''; const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const name = /^event:\s*(.+)$/m.exec(block)?.[1];
        const data = /^data:\s*(.+)$/m.exec(block)?.[1];
        if (name && data) events.push({ name, data: JSON.parse(data) });
      }
    }
  })().catch(error => { if (!streamAbort.signal.aborted) throw error; });
}
async function stopStream() { streamAbort?.abort(); await streamDone; }
async function chat(id, responses, message = '격리된 기능 검증') {
  check(queue.length, 0, 'Previous model response queue consumed');
  queue.push(...responses);
  check(await request(runtime.url, '/api/agent/chat', { convId: id, message, agentId: 'dev_sawon', projectId: 'sample' }), { status: 200, data: { status: 'started' } }, 'Native chat accepted');
}
async function done(id) {
  await eventually(() => events.some(e => e.name === 'agent:done' && e.data.convId === id), `Agent completion missing: ${id}; ${JSON.stringify(events.filter(e => e.data.convId === id))}`);
  check(events.some(e => e.name === 'agent:error' && e.data.convId === id), false, 'No runtime error');
  check(queue.length, 0, `All planned model turns consumed: ${JSON.stringify(events.filter(e => e.data.convId === id))}`);
}
try {
  fixture = await startPortfolioServer({ durable: true });
  fixture.env.COCKPIT_PREVIEW_GEMINI_BASE = `http://127.0.0.1:${provider.address().port}`;
  await prepareTelegramChecks({ fixture });
  const sandbox = join(fixture.directory, 'rust');
  const start = () => startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  runtime = await start(); await runtime.stop();
  await writeFile(join(sandbox, 'projects.json'), await readFile(join(fixture.directory, 'data/cockpit/projects.json')));
  await mkdir(join(fixture.directory, 'app/workflows'), { recursive: true });
  await writeFile(join(fixture.directory, 'app/workflows/fixture.json'), JSON.stringify({ id: 'fixture', name: 'Private workflow', steps: [{ id: 'check', type: 'condition', target: 'text', pattern: '^ok$' }], edges: [{ from: 'START', to: 'check' }, { from: 'check', to: 'END' }] }));
  runtime = await start();
  for (const [path, body] of [
    ['/api/agent/chat', {}], ['/api/agent/chat', { convId: 'x', message: 'before key' }],
    ['/api/agent/stop', {}], ['/api/agent/stop', { convId: 'missing' }],
  ]) check(await request(runtime.url, path, body), await request(fixture.url, path, body), `Original HTTP contract ${path}`);
  check(calls.length, 0, 'Validation does not call model');
  await fixture.stop();
  check((await request(runtime.url, '/api/ai/config', { geminiApiKey: 'private-key-one' })).status, 200, 'Private model configuration');
  await subscribe();
  await chat('service-tools', [plan([
    { tool: 'WRITE', file: join(fixture.project, 'native-agent.txt'), content: '저장 완료 😀' },
    cockpit('note-create:검증 노트\n본문 😀'), cockpit('projects'),
  ]), '기능 검증 완료']);
  await done('service-tools');
  check(await readFile(join(fixture.project, 'native-agent.txt'), 'utf8'), '저장 완료 😀', 'Native WRITE reaches registered project');
  const notes = (await request(runtime.url, '/api/notes')).data.notes;
  check(notes.length, 1, 'Native COCKPIT note create persists');
  check((await request(runtime.url, `/api/notes/${notes[0].id}`)).data.content, '본문 😀', 'Note content preserved');
  const history = (await request(runtime.url, '/api/agent/conversations/service-tools')).data;
  check(history.messages.at(-1).content, '기능 검증 완료', 'Final answer persisted');
  check(history.messages.at(-1).toolSummary.length, 3, 'Tool history persisted');
  check(events.some(e => e.name === 'agent:streaming' && e.data.convId === 'service-tools'), true, 'Model streaming reaches SSE');
  check(calls[0].url.includes('private-key-one'), true, 'Configured key reaches private provider');

  await chat('denied-tools', [plan([cockpit('  TeRmInAl-CrEaTe:sample'), cockpit(' WoRkFlOw-StArT:fixture')]), '승인 거절 확인']);
  await done('denied-tools');
  const denied = events.filter(e => e.name === 'agent:tool-result' && e.data.convId === 'denied-tools');
  check(denied.length, 2, 'Both guarded tools returned');
  check(denied.every(e => e.data.result.includes('거부')), true, 'Whitespace/case cannot bypass approval');
  check((await request(runtime.url, '/api/workflows/runs')).data.length, 0, 'Denied workflow cannot start');
  check((await request(runtime.url, '/api/terminals')).data.terminals.length, 0, 'Denied terminal cannot start');

  check((await request(runtime.url, '/api/telegram/config', { token: 'fixture-rust', chatId: 'private-chat', enabled: true })).status, 200, 'Private approval transport configured');
  await request(runtime.url, '/api/telegram/start', {});
  const seen = new Set();
  approvals = setInterval(() => {
    for (const call of fixture.telegram.requests) {
      const data = call.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
      if (!data || !data.startsWith('apr:') || !data.endsWith(':y') || seen.has(data)) continue;
      seen.add(data);
      fixture.telegram.push({ callback_query: { id: `private-${seen.size}`, data, message: { message_id: 42, chat: { id: 'private-chat' } } } });
    }
  }, 20);
  await chat('accepted-tools', [plan([cockpit('terminal-create:sample'), cockpit('workflow-start:fixture\n{"text":"ok"}')]), '접수 검증 완료']);
  await done('accepted-tools');
  const terminalReceipt = events.find(e => e.name === 'agent:service-accepted' && e.data.operation === 'terminal-create');
  const workflowReceipt = events.find(e => e.name === 'agent:service-accepted' && e.data.operation === 'workflow-start');
  check(Boolean(terminalReceipt), true, 'Durable terminal created from async agent without nested runtime panic');
  check(Boolean(workflowReceipt), true, 'Workflow ownership transferred with receipt');
  await eventually(async () => {
    const run = (await request(runtime.url, `/api/workflows/runs/${workflowReceipt.data.id}`)).data;
    assert.notEqual(run.status, 'error', `Owned workflow failed: ${JSON.stringify(run)}`);
    return run.status === 'done';
  }, 'Owned workflow finishes');
  await chat('terminal-input', [plan([cockpit(`terminal-input:${terminalReceipt.data.id}:printf 'native-terminal-ok\\n'`)]), '입력 검증 완료']);
  await done('terminal-input');
  check(events.some(e => e.name === 'agent:tool-result' && e.data.convId === 'terminal-input' && e.data.result.includes('native-terminal-ok')), true, 'Terminal input delivery returns actual output');

  const beforeHold = calls.length;
  await chat('stop-me', [null]);
  await eventually(() => calls.length > beforeHold, 'Model request starts before stop');
  const saved = JSON.parse(await readFile(join(sandbox, 'agent-history.json'), 'utf8'));
  check(saved['stop-me'].messages[0].role, 'user', 'Accepted user turn saved before provider completes');
  check((await request(runtime.url, '/api/agent/chat', { convId: 'stop-me', message: 'duplicate', agentId: 'dev_sawon' })).status, 500, 'Concurrent turn rejected');
  check((await request(runtime.url, '/api/agent/stop', { convId: 'stop-me' })).data, { stopped: true }, 'Active run stopped');
  await eventually(() => calls[beforeHold].closed, 'Stop closes owned HTTP transport');
  await done('stop-me');
  await request(runtime.url, '/api/ai/config', { geminiApiKey: 'private-key-two' });
  await chat('new-key', ['새 키 확인']); await done('new-key');
  check(calls.at(-1).url.includes('private-key-two'), true, 'Provider reads rotated key without server restart');

  const beforeDelete = calls.length;
  await chat('delete-me', [null]); await eventually(() => calls.length > beforeDelete, 'Deleted run starts');
  check((await request(runtime.url, '/api/agent/conversations/delete-me', undefined, 'DELETE')).status, 200, 'Running conversation deleted');
  await eventually(() => calls[beforeDelete].closed, 'Delete cancels provider');
  await pause(50);
  check((await request(runtime.url, '/api/agent/conversations/delete-me')).status, 404, 'Late finish never resurrects deleted conversation');
  check(Boolean(JSON.parse(await readFile(join(sandbox, 'agent-history.json'), 'utf8'))['delete-me']), false, 'Deleted history stays absent on disk');

  const beforeShutdown = calls.length;
  await chat('shutdown-me', [null]); await eventually(() => calls.length > beforeShutdown, 'Shutdown run starts');
  await stopStream(); await runtime.stop();
  check(calls[beforeShutdown].closed, true, 'Graceful shutdown closes provider');
  runtime = await start();
  check((await request(runtime.url, '/api/agent/conversations/shutdown-me')).data.messages[0].role, 'user', 'Accepted history survives restart');
  check((await request(runtime.url, '/api/agent/stop', { convId: 'shutdown-me' })).data.stopped, false, 'Restart does not invent a running job');
  check((await request(runtime.url, '/api/agent/conversations/service-tools')).data.messages.at(-1).content, '기능 검증 완료', 'Completed history survives restart');
  for (let i = 0; i < 30; i++) check((await request(runtime.url, '/api/agent/chat', {})).status, 400, 'Invalid chats count toward rate limit');
  const limited = await fetch(runtime.url + '/api/agent/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  check(limited.status, 429, 'Chat rate limit applies before JSON parsing');
  check(unexpected, [], 'No unplanned provider requests');
  report.runtimeApiIntegrated = true; report.status = 'passed';
} catch (error) {
  report.status = 'failed'; throw error;
} finally {
  clearInterval(approvals);
  await stopStream();
  await runtime?.stop();
  if (fixture) {
    await cleanupTelegramChecks(fixture);
    // Durable panes deliberately outlive Rust. End only sockets in this private
    // fixture before its directory is removed; otherwise their shells leak.
    const tmuxDir = join(fixture.directory, 'rust/tmux');
    for (const name of await readdir(join(tmuxDir, `tmux-${process.getuid()}`)).catch(() => [])) {
      if (!/^cockpit-[a-f0-9]{24}$/.test(name)) continue;
      execFileSync('/usr/bin/tmux', ['-L', name, 'kill-server'], { env: { ...fixture.env, TMUX_TMPDIR: tmuxDir }, stdio: 'ignore', timeout: 3000 });
    }
    await fixture.cleanup();
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  report.checkedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
