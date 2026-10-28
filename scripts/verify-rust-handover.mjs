import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer, stopRustServer, rustBinary as binary, rustBuildProfile } from '../tests/helpers/rust-server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = join(root, 'docs/_local/rust-handover-verification.json');
const startedAt = new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
let assertions = 0, fixture, native, preview, failure, cleaned = false;
const clients = [], children = [], providerCalls = [];
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };
const provider = createServer((request, response) => {
  providerCalls.push(request.url.split('?')[0]);
  request.resume(); response.writeHead(503); response.end('No provider calls belong in the handover gate');
});
async function until(read, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function json(path, value) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value), { mode: 0o600 }); }
async function request(base, path, options = {}) {
  const response = await fetch(base + path, { ...options,
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: AbortSignal.timeout(5000) });
  const data = await response.json();
  check(response.status, options.expected || 200, `${path} HTTP status`);
  return data;
}
function launch(args) {
  const child = spawn(binary, args, { cwd: join(fixture.directory, 'app'), env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { child, output: '', error: '', spawnError: null };
  child.stdout.on('data', bytes => { record.output = (record.output + bytes).slice(-100000); });
  child.stderr.on('data', bytes => { record.error = (record.error + bytes).slice(-100000); });
  child.on('error', error => { record.spawnError = error; });
  children.push(record); return record;
}
async function startLegacy(args) {
  const record = launch(args);
  await until(() => {
    if (record.spawnError || record.child.exitCode !== null) throw record.spawnError || new Error(`Legacy startup failed: ${record.error}`);
    return record.output.includes('\n');
  }, 'native legacy readiness');
  const ready = JSON.parse(record.output.split('\n')[0]);
  return { ...record, url: `http://${ready.listening}`, stop: () => stopRustServer(record.child) };
}
async function rejected(args, label) {
  const record = launch(args);
  await until(() => record.spawnError || record.child.exitCode !== null || record.child.signalCode !== null, label, 8000);
  if (record.spawnError) throw record.spawnError;
  check(record.child.exitCode !== 0 && record.child.signalCode === null, true, label);
  check(record.output.trim(), '', `${label}: no successful readiness`);
}
async function connect(base) {
  const ws = new WebSocket(base.replace('http:', 'ws:'), { handshakeTimeout: 3000 });
  const messages = [], errors = [];
  ws.on('message', bytes => { messages.push(JSON.parse(bytes)); });
  ws.on('error', error => { errors.push(error); });
  const client = { ws, messages, send: value => ws.send(JSON.stringify(value)),
    wait: predicate => until(() => { if (errors.length) throw errors[0]; return messages.find(predicate); }, 'terminal frame') };
  clients.push(client); await once(ws, 'open');
  client.initial = await client.wait(message => message.type === 'terminals');
  return client;
}
async function close(client) {
  if (client.ws.readyState >= WebSocket.CLOSING) return;
  const closed = once(client.ws, 'close'); client.ws.close();
  const timer = setTimeout(() => client.ws.terminate(), 1000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function input(client, termId, data, requestId) {
  client.send({ type: 'input', termId, data, requestId });
  check((await client.wait(message => message.type === 'input-result' && message.requestId === requestId)).accepted, true, `Shell input ${requestId}`);
}
function tmux(id, args) {
  assert.match(id, /^[a-f0-9]{24}$/);
  return execFileSync('/usr/bin/tmux', ['-L', `cockpit-${id}`, ...args],
    { env: fixture.env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function shellProof(client, termId, label) {
  const path = join(fixture.directory, `shell-${label}.json`);
  const code = `require('fs').writeFileSync(${JSON.stringify(path)},JSON.stringify({cwd:process.cwd(),mark:process.env.HANDOVER_MARK,term:process.env.COCKPIT_TERM_ID}))`;
  await input(client, termId, `${quote(process.execPath)} -e ${quote(code)}\r`, `proof-${label}`);
  await until(() => exists(path), `shell proof ${label}`);
  return JSON.parse(await readFile(path, 'utf8'));
}
async function fingerprint(directory, skip = () => false) {
  const rows = [];
  async function visit(path) {
    const name = relative(directory, path);
    if (skip(name)) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Unexpected link in synthetic persistence tree');
    if (stat.isDirectory()) {
      rows.push([name, 'directory']);
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else rows.push([name, createHash('sha256').update(await readFile(path)).digest('hex')]);
  }
  await visit(directory); return rows;
}
async function delegateProof(base, termId) {
  const controller = new AbortController(), frames = [];
  const response = await fetch(base + '/api/events', { signal: controller.signal });
  check(response.status, 200, 'Delegate path proof opens the actual native event stream');
  const consume = (async () => {
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      for (let end; (end = pending.indexOf('\n\n')) >= 0;) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const name = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
        if (name === 'session:status' && data) frames.push(JSON.parse(data));
      }
    }
  })().catch(error => { if (!controller.signal.aborted) throw error; });
  try {
    const directory = join(fixture.directory, `cockpit-delegates-${process.getuid()}`);
    const file = join(directory, 'handover.json');
    const adjacent = join(fixture.directory, 'adjacent-temp-state.json');
    await json(adjacent, { preserve: true });
    await json(file, { runId: 'private-handover', termId, cwd: fixture.project, model: 'private-model', state: 'running', updatedAt: Date.now() });
    await until(() => frames.find(frame => frame.delegateRunId === 'private-handover'), 'native consumption of legacy temporary delegate path');
    await until(async () => !await exists(file), 'delegate record removed after consumption');
    check(JSON.parse(await readFile(adjacent, 'utf8')), { preserve: true }, 'Delegate consumer preserves adjacent temporary files');
    await json(file, { runId: 'private-handover', termId, cwd: fixture.project, state: 'done', updatedAt: Date.now() });
    await until(async () => !await exists(file), 'delegate completion consumed');
  } finally { controller.abort(); await consume; }
}
function decrypt(key, value) {
  const [, iv, tag, ciphertext] = value.split(':');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  cipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(ciphertext, 'hex')), cipher.final()]).toString();
}

try {
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  fixture = await startPortfolioServer({ durable: true });
  await fixture.stop();
  const install = join(fixture.directory, 'app'), data = join(fixture.directory, 'data/cockpit');
  const providerBase = `http://127.0.0.1:${provider.address().port}`;
  Object.assign(fixture.env, { COCKPIT_PREVIEW_GEMINI_BASE: providerBase, COCKPIT_PREVIEW_CLAUDE_BASE: providerBase,
    COCKPIT_PREVIEW_TELEGRAM_BASE: providerBase });
  // This copied source and private PATH never consult real credentials or model CLIs.
  await appendFile(join(fixture.directory, 'isolate-home.mjs'), `\nconst fixtureFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return fixtureFetch(${JSON.stringify(providerBase)} + '/blocked-provider', options);
  return fixtureFetch(input, options);
};\n`);
  const modelMarker = join(fixture.directory, 'unexpected-model-cli');
  for (const command of ['claude', 'codex', 'jcode', 'gemini']) {
    await writeFile(join(fixture.directory, 'notification-bin', command), `#!/bin/sh\nprintf x >> ${quote(modelMarker)}\nexit 126\n`, { mode: 0o700 });
  }
  const now = Date.now();
  const definition = { id: 'handover', name: 'Private handover workflow', description: 'Never dispatched', inputs: [],
    steps: [{ id: 'check', type: 'condition', pattern: '^ok$', target: 'text' }],
    edges: [{ from: 'START', to: 'check' }, { from: 'check', to: 'END' }] };
  const run = { runId: 'handover-run', workflowId: 'handover', workflowName: definition.name, status: 'done',
    startedAt: now - 2000, endedAt: now - 1000, inputs: {}, steps: [], error: null };
  const schedule = { id: 'handover-schedule', workflowId: 'handover', workflowName: definition.name, preset: 'daily',
    hour: 9, day: 1, enabled: false, inputs: { text: 'before' }, lastRunAt: null, nextRunAt: null, createdAt: now };
  const todo = { id: 1, text: 'Preserve the private todo 😀\ud800', status: 'pending', ts: new Date(now).toISOString() };
  const autonomous = [{ id: 'handover-autonomy', pattern: 'every 1m', prompt: 'Do not run', project: null,
    enabled: false, lastRun: null, created: new Date(now).toISOString() }];
  const history = { 'conv-handover': { createdAt: now, messages: [{ role: 'user', content: 'Private history 😀\ud800', ts: now }] } };
  await Promise.all([
    json(join(install, 'workflows/handover.json'), definition), json(join(install, 'workflow-runs.json'), [run]),
    json(join(install, 'workflow-schedules.json'), [schedule]), json(join(install, 'logs/scheduled-tasks.json'), autonomous),
    json(join(install, 'telegram-config.json'), { token: '123:private-disabled-fixture', chatId: '12345', enabled: false }),
    json(join(data, 'agent-history.json'), history), json(join(data, 'alerts.json'), { enabled: false, disabledProjects: ['sample'] }),
    json(join(fixture.directory, '.claude/stats-cache.json'), { fixture: 'handover', totalMessages: 17, unknown: '\ud800' }),
    json(join(install, 'cost-cache.json'), { daily: {} }),
  ]);
  await writeFile(join(install, 'logs/telegram-todos.jsonl'), JSON.stringify(todo) + '\n', { mode: 0o600 });
  const activity = { project: fixture.project, display: 'handover private activity', timestamp: now, sessionId: 'abcd-0123' };
  await writeFile(join(fixture.directory, '.claude/history.jsonl'), JSON.stringify(activity) + '\n');
  const sessionDirectory = join(fixture.directory, '.claude/projects', fixture.project.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, 'abcd-0123.jsonl'), JSON.stringify({ type: 'user', timestamp: new Date(now).toISOString(),
    message: { content: 'Private handover session' } }) + '\n');
  await fixture.start();

  const note = await request(fixture.url, '/api/notes', { method: 'POST', expected: 201,
    body: { title: 'Node note 😀', content: 'Before handover \ud800', tags: ['handover'] } });
  const task = (await request(fixture.url, '/api/board/tasks', { method: 'POST', expected: 201,
    body: { text: 'Node checklist 😀' } })).task;
  await request(fixture.url, '/api/ai/config', { method: 'POST', body: { geminiApiKey: 'private-handover-node-1234' } });
  await until(async () => {
    try { return JSON.parse(await readFile(join(data, 'ai-config.json'), 'utf8')).geminiApiKey.startsWith('enc:'); }
    catch { return false; }
  }, 'Node encrypted configuration persistence');
  const tokenBytes = await readFile(join(data, '.cockpit-token'));
  const keyBytes = await readFile(join(data, '.encryption-key'));
  const stableRoutes = [`/api/notes/${note.id}`, '/api/ai/config', '/api/agent/conversations/conv-handover',
    '/api/workflows/handover', '/api/workflows/runs/handover-run', '/api/workflows/schedules',
    '/api/telegram/status', '/api/alerts/prefs', '/api/stats', '/api/activity',
    `/api/claude-sessions?projectPath=${encodeURIComponent(fixture.project)}`];
  const baseline = new Map();
  for (const route of stableRoutes) baseline.set(route, await request(fixture.url, route));
  check(baseline.get('/api/ai/config').geminiApiKey, '****1234', 'Node uses the encrypted fixture key');
  check(baseline.get('/api/activity')[0].command, activity.display, 'Node reads the explicit private home');

  const first = await connect(fixture.url);
  const counter = join(fixture.directory, 'one-shot.txt');
  const command = `node -e "require('fs').appendFileSync('${counter}','x')"`;
  first.send({ type: 'create', projectId: 'sample', command, cols: 80, rows: 24 });
  const created = await first.wait(message => message.type === 'created');
  await until(async () => await readFile(counter, 'utf8').catch(() => '') === 'x', 'Node one-shot command');
  const termId = created.termId;
  const workdir = join(fixture.project, 'handover 작업'); await mkdir(workdir);
  await input(first, termId, `cd ${quote(workdir)}; export HANDOVER_MARK=kept_from_node\r`, 'prepare-handover');
  const expectedShell = { cwd: workdir, mark: 'kept_from_node', term: termId };
  check(await shellProof(first, termId, 'node'), expectedShell, 'Original Node shell context');
  const saved = await until(async () => (await fixture.checkpoint()).terminals.find(row => row.termId === termId), 'Node checkpoint');
  const pane = tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']);
  check(created.alias, 'ai1', 'Node terminal alias');

  const legacyArgs = ['--root', install, '--data-dir', data, '--home-dir', fixture.directory,
    '--bind', `127.0.0.1:${new URL(fixture.url).port}`];
  const ignorePeriodic = name => name === 'session-state.json' || name === 'recovery-history' || name === 'snapshots';
  const beforeCollision = await fingerprint(data, ignorePeriodic);
  await rejected(legacyArgs, 'Occupied Node port rejects native startup');
  check(await fingerprint(data, ignorePeriodic), beforeCollision, 'Occupied port changes no stable data and creates no native lock');
  check(await exists(join(data, '.cockpit-native.lock')), false, 'Occupied port is checked before creating the native data lock');
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Rejected startup leaves the active Node pane intact');
  const invalidPreview = join(fixture.directory, 'rejected-preview');
  await rejected(['--root', install, '--sandbox-dir', invalidPreview, '--data-dir', data], 'Mixed sandbox/data flags rejected');
  await rejected(['--root', install, '--sandbox-dir', invalidPreview, '--home-dir', fixture.directory], 'Preview cannot import an external home');
  check(await exists(invalidPreview), false, 'Invalid mode flags create no preview directory');
  await close(first); await fixture.stop();
  check((await fixture.checkpoint()).terminals.find(row => row.termId === termId).cwd, workdir, 'Node stop checkpoints the actual shell directory');
  const preservedLogs = new Map(await Promise.all(['logs/telegram-todos.jsonl', 'logs/scheduled-tasks.json'].map(async name => [name, await readFile(join(install, name))])));
  const directoryIdentity = (await lstat(data)).ino;
  const recoveryDirectory = join(data, 'recovery-history');
  const originalHours = new Map(await Promise.all((await readdir(recoveryDirectory))
    .filter(name => /^\d{4}-\d{2}-\d{2}_\d{2}\.json$/.test(name))
    .map(async name => [name, await readFile(join(recoveryDirectory, name))])));

  native = await startLegacy(legacyArgs);
  check(native.url, fixture.url, 'Native reuses the exact Node address and port');
  check((await lstat(data)).ino, directoryIdentity, 'Native uses the original data directory in place');
  check((await readFile(join(data, '.cockpit-token'))).equals(tokenBytes), true, 'Native preserves the original authentication token bytes');
  check((await readFile(join(data, '.encryption-key'))).equals(keyBytes), true, 'Native preserves the original encryption key bytes');
  for (const route of stableRoutes) check(await request(native.url, route), baseline.get(route), `Native reads legacy path: ${route}`);
  const projects = await request(native.url, '/api/projects');
  check(projects.some(project => project.id === 'sample' && project.path === fixture.project), true, 'Native reads original project registrations');
  check((await request(native.url, '/api/board')).tasks.some(row => row.id === task.id && !row.done), true, 'Native reads the original checklist');
  check((await request(native.url, '/api/notes', { headers: { 'x-forwarded-for': '100.64.2.1', cookie: `cockpit-token=${tokenBytes.toString().trim()}` } })).notes.some(row => row.id === note.id), true, 'Old token authorizes the native server');
  const resumed = await connect(native.url);
  check(resumed.initial.active.length, 1, 'Native restores exactly one terminal');
  check(resumed.initial.active[0].termId, termId, 'Native preserves the fixed terminal ID');
  check(resumed.initial.active[0].alias, created.alias, 'Native preserves the terminal alias');
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Node to native attaches the same running shell PID');
  check(await shellProof(resumed, termId, 'native'), expectedShell, 'Native shell retains cwd, exports and terminal identity');
  check(await readFile(counter, 'utf8'), 'x', 'Native handover does not rerun the launcher command');
  await delegateProof(native.url, termId);

  const changedNote = await request(native.url, `/api/notes/${note.id}`, { method: 'PUT', body: { content: 'Saved by Rust 😀\udc00' } });
  await request(native.url, '/api/projects/sample', { method: 'PUT', body: { name: 'Changed in Rust' } });
  await request(native.url, `/api/board/tasks/${task.id}`, { method: 'PATCH', body: { done: true } });
  await request(native.url, '/api/ai/config', { method: 'POST', body: { geminiApiKey: 'private-handover-native-9876' } });
  await request(native.url, '/api/alerts/prefs', { method: 'POST', body: { enabled: true, disabledProjects: [] } });
  const changedSchedule = await request(native.url, '/api/workflows/schedules/handover-schedule',
    { method: 'PUT', body: { enabled: false, inputs: { text: 'Saved by Rust 😀' } } });
  await request(native.url, '/api/telegram/config', { method: 'POST',
    body: { token: '123:private-disabled-fixture', chatId: '67890', enabled: false } });
  const conversation = await request(native.url, '/api/agent/conversations', { method: 'POST', body: {}, expected: 201 });
  const encrypted = JSON.parse(await readFile(join(data, 'ai-config.json'), 'utf8')).geminiApiKey;
  check(decrypt(Buffer.from(keyBytes.toString().trim(), 'hex'), encrypted) === 'private-handover-native-9876', true, 'Rust writes ciphertext readable with the unchanged Node encryption key');
  check(JSON.parse(await readFile(join(install, `notes/${note.id}.json`), 'utf8')).content, changedNote.content, 'Native note mutation goes to the original installation notes');
  check(JSON.parse(await readFile(join(install, 'workflow-schedules.json'), 'utf8'))[0], changedSchedule, 'Native schedule mutation goes to the original installation file');
  for (const name of ['notes', 'telegram-config.json', 'workflow-runs.json', 'workflow-schedules.json', 'logs']) {
    check(await exists(join(data, name)), false, `Native does not create a shadow data-root ${name}`);
  }
  for (const [name, bytes] of preservedLogs) check((await readFile(join(install, name))).equals(bytes), true, `Disabled original storage stays unchanged: ${name}`);
  const historyFile = join(recoveryDirectory, 'latest.json');
  const periodic = await until(async () => {
    const value = JSON.parse(await readFile(historyFile, 'utf8'));
    return value.board.tasks.find(row => row.id === task.id)?.done ? value : false;
  }, 'Native periodic recovery history captures changed work without a restart', 40000);
  check(periodic.schemaVersion, 1, 'Native recovery history retains the original schema');
  check(periodic.sessionState.terminals.find(row => row.termId === termId).cwd, workdir, 'Periodic recovery captures the actual terminal directory');
  check(periodic.projects.projects.find(project => project.id === 'sample').name, 'Changed in Rust', 'Periodic recovery captures current project registration');
  check(periodic.projects.projects.every(project => Object.keys(project).every(key => ['id', 'name', 'path', 'color', 'stack'].includes(key))), true, 'Recovery includes only the original project registration fields');
  const recoverySource = await import(pathToFileURL(join(install, 'lib/recovery-history.js')).href);
  const oracleRecovery = join(fixture.directory, 'node-recovery-oracle');
  recoverySource.saveRecoveryHistory(oracleRecovery, { board: periodic.board, sessionState: periodic.sessionState,
    projects: periodic.projects.projects, now: periodic.savedAt });
  check(JSON.parse(await readFile(join(oracleRecovery, 'latest.json'), 'utf8')), periodic, 'Node and native recovery snapshots have identical values');
  const summaryBody = text => text.split('\n').slice(1).join('\n');
  check(summaryBody(await readFile(join(recoveryDirectory, '작업요약.txt'), 'utf8')), summaryBody(await readFile(join(oracleRecovery, '작업요약.txt'), 'utf8')), 'Native recovery summary matches original contents below its localized timestamp');
  check(await readFile(join(recoveryDirectory, '안내.txt'), 'utf8'), await readFile(join(oracleRecovery, '안내.txt'), 'utf8'), 'Existing recovery instructions remain compatible');
  check((await lstat(historyFile)).mode & 0o777, 0o600, 'Recovery snapshot stays private');
  const shutdownText = `${task.text} saved at shutdown`;
  await request(native.url, `/api/board/tasks/${task.id}`, { method: 'PATCH', body: { text: shutdownText } });
  await close(resumed); await native.stop();
  const finalRecovery = JSON.parse(await readFile(historyFile, 'utf8'));
  check(finalRecovery.board.tasks.find(row => row.id === task.id).text, shutdownText, 'Native shutdown records work changed after the periodic snapshot');
  for (const [name, bytes] of originalHours) check((await readFile(join(recoveryDirectory, name))).equals(bytes), true, `First hourly recovery snapshot stays immutable: ${name}`);
  const recoveryText = JSON.stringify(finalRecovery);
  for (const secret of [tokenBytes.toString().trim(), keyBytes.toString().trim(), 'private-handover-native-9876', '123:private-disabled-fixture']) {
    check(recoveryText.includes(secret), false, 'Recovery snapshot excludes credentials and configuration secrets');
  }
  const exported = join(fixture.directory, 'native-history-exported-by-node');
  recoverySource.exportRecovery(historyFile, exported);
  for (const [name, expected] of [['.cockpit-board.json', finalRecovery.board], ['session-state.json', finalRecovery.sessionState], ['projects.json', finalRecovery.projects]]) {
    check(JSON.parse(await readFile(join(exported, name), 'utf8')), expected, `Original Node recovery tool reads native ${name}`);
  }
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Native shutdown preserves the original tmux shell');

  await fixture.start();
  check(await request(fixture.url, `/api/notes/${note.id}`), changedNote, 'Rollback Node reads the native note mutation');
  check((await request(fixture.url, '/api/projects')).find(project => project.id === 'sample').name, 'Changed in Rust', 'Rollback reads native project mutation');
  check((await request(fixture.url, '/api/board')).tasks.find(row => row.id === task.id).done, true, 'Rollback reads completed native checklist');
  check((await request(fixture.url, '/api/ai/config')).geminiApiKey, '****9876', 'Rollback Node decrypts the native saved key');
  check(await request(fixture.url, '/api/alerts/prefs'), { enabled: true, disabledProjects: [] }, 'Rollback reads native alert preferences');
  check((await request(fixture.url, '/api/workflows/schedules'))[0], changedSchedule, 'Rollback reads native workflow schedule mutation');
  check((await request(fixture.url, '/api/telegram/status')).config.chatId, '67890', 'Rollback reads native Telegram configuration');
  check((await request(fixture.url, `/api/agent/conversations/${conversation.id}`)).id, conversation.id, 'Rollback reads native conversation creation');
  const rolledBack = await connect(fixture.url);
  check(rolledBack.initial.active.length, 1, 'Rollback restores exactly one terminal');
  check(rolledBack.initial.active[0].termId, termId, 'Rollback retains the fixed terminal ID');
  check(rolledBack.initial.active[0].alias, created.alias, 'Rollback retains the terminal alias');
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Native to Node rollback attaches the same shell PID');
  check(await shellProof(rolledBack, termId, 'rollback'), expectedShell, 'Rollback preserves shell state');
  check(await readFile(counter, 'utf8'), 'x', 'Complete Node to Rust to Node cycle launches the command exactly once');
  check((await readFile(join(data, '.cockpit-token'))).equals(tokenBytes), true, 'Rollback preserves authentication token bytes');
  check((await readFile(join(data, '.encryption-key'))).equals(keyBytes), true, 'Rollback preserves encryption key bytes');

  const sandbox = join(fixture.directory, 'isolated-preview');
  preview = await startRustServer({ root: install, directory: sandbox, env: fixture.env });
  check((await request(preview.url, '/api/notes')).notes, [], 'Preview does not read installation notes');
  check(await request(preview.url, '/api/projects'), [], 'Preview does not read legacy projects');
  check((await request(preview.url, '/api/ai/config')).configured, false, 'Preview does not read legacy credentials');
  check(await request(preview.url, '/api/agent/conversations'), [], 'Preview does not read legacy agent history');
  check(await request(preview.url, '/api/stats'), {}, 'Preview does not read legacy home stats');
  check((await readFile(join(sandbox, '.cockpit-token'))).equals(tokenBytes), false, 'Preview retains its independent token');
  await preview.stop();

  // Exercise legacy overrides with a second handover. Every path and executable
  // remains inside this fixture, including the emulated Windows user profile.
  await close(rolledBack); await fixture.stop();
  const ordinaryBoard = join(data, '.cockpit-board.json');
  const ordinaryBoardBytes = await readFile(ordinaryBoard);
  const shared = join(fixture.directory, 'shared'); await mkdir(shared);
  const windowsHome = join(fixture.directory, 'private-windows-home');
  const accountHome = join(fixture.directory, 'external-private-account');
  const profileName = 'Private Windows fallback account';
  const profileId = createHash('sha256').update(`claude\0${accountHome.toLowerCase()}`).digest('hex').slice(0, 16);
  await json(join(windowsHome, '.codex-account-launcher/profiles.json'), { profiles: [
    { provider: 'claude', name: profileName, claudeConfigDir: accountHome },
  ] });
  // An expired timestamp without any access/refresh token proves credential-path
  // reading without permitting a model request or an OAuth refresh.
  const credentialFile = join(accountHome, '.credentials.json');
  await json(credentialFile, { claudeAiOauth: { expiresAt: 1 } });
  const credentialBytes = await readFile(credentialFile);
  const cmdMarker = join(fixture.directory, 'private-cmd-invocations');
  const privateCmd = join(fixture.directory, 'notification-bin/cmd.exe');
  await writeFile(privateCmd, `#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1" != /d ] || [ "$2" != /c ] || [ "$3" != echo ] || [ "$4" != '%USERPROFILE%' ]; then exit 93; fi
printf 'private-profile-probe\\n' >> ${quote(cmdMarker)}
printf '%s\\n' ${quote(windowsHome)}
`, { mode: 0o700 });
  // Node's network-address probe uses an absolute Windows executable. Disable
  // that optional probe in the copied source before enabling synthetic WSL.
  await appendFile(join(fixture.directory, 'isolate-home.mjs'), `
import fixtureChildProcess from 'node:child_process';
const fixtureExecFileSync = fixtureChildProcess.execFileSync;
fixtureChildProcess.execFileSync = (file, args, options) => {
  if (String(file).startsWith('/mnt/')) throw new Error('Host executable blocked by private handover fixture');
  return fixtureExecFileSync(file === 'cmd.exe' ? ${JSON.stringify(privateCmd)} : file, args, options);
};
syncBuiltinESMExports();
`);
  Object.assign(fixture.env, { COCKPIT_BOARD_FILE: '../shared/board.json', WSL_DISTRO_NAME: 'private-handover',
    USER: `cockpit-private-${process.pid}-${Date.now()}` });
  delete fixture.env.COCKPIT_WINDOWS_HOME;
  delete fixture.env.AI_HUB_LAUNCHER_ROOT;
  const projectAccount = account => Object.fromEntries(['id', 'name', 'provider', 'state', 'stateNote', 'source', 'bridge'].map(key => [key, account?.[key]]));
  await fixture.start();
  const overrideTask = (await request(fixture.url, '/api/board/tasks', { method: 'POST', expected: 201,
    body: { text: 'Relative override checklist' } })).task;
  check(JSON.parse(await readFile(join(shared, 'board.json'), 'utf8')).tasks[0].id, overrideTask.id, 'Node resolves the relative board override from its working directory');
  const nodeAccount = (await request(fixture.url, '/api/ai-accounts')).accounts.find(account => account.id === profileId);
  check(nodeAccount?.name, profileName, 'Node discovers the private Windows profile through fake cmd.exe');
  check(nodeAccount?.state, 'warning', 'Node reads the synthetic credential home outside DATA_DIR');
  check(nodeAccount?.source, 'Windows', 'Node classifies the detected profile as Windows');
  const nodeProbes = await readFile(cmdMarker, 'utf8');
  check(/^(private-profile-probe\n)+$/.test(nodeProbes), true, 'Fake cmd records only its constant invocation marker');
  await fixture.stop();
  native = await startLegacy(legacyArgs);
  check((await request(native.url, '/api/board')).tasks[0].text, overrideTask.text, 'Native accepts ../shared/board.json without shadowing the original board');
  await request(native.url, `/api/board/tasks/${overrideTask.id}`, { method: 'PATCH', body: { done: true } });
  const nativeAccount = (await request(native.url, '/api/ai-accounts')).accounts.find(account => account.id === profileId);
  check(projectAccount(nativeAccount), projectAccount(nodeAccount), 'Native Windows fallback and external credential state match Node');
  check((await readFile(cmdMarker, 'utf8')).length > nodeProbes.length, true, 'Native actually executes the fixture fallback probe');
  check((await readFile(credentialFile)).equals(credentialBytes), true, 'Account discovery never changes the synthetic credential file');
  await native.stop(); await fixture.start();
  check((await request(fixture.url, '/api/board')).tasks.find(row => row.id === overrideTask.id).done, true, 'Node rollback reads the native relative-board mutation');
  check((await readFile(ordinaryBoard)).equals(ordinaryBoardBytes), true, 'Using the relative override leaves the previous normal board byte-for-byte intact');
  await fixture.stop();
  const beforePreviewProbes = await readFile(cmdMarker);
  const sharedBoardBytes = await readFile(join(shared, 'board.json'));
  preview = await startRustServer({ root: install, directory: join(fixture.directory, 'windows-profile-preview'), env: fixture.env });
  check((await request(preview.url, '/api/ai-accounts')).accounts, [], 'Preview cannot import the external Windows profile');
  check((await request(preview.url, '/api/board')).tasks, [], 'Preview ignores the legacy relative board override');
  await preview.stop();
  check((await readFile(cmdMarker)).equals(beforePreviewProbes), true, 'Preview never invokes the Windows fallback executable');
  check((await readFile(join(shared, 'board.json'))).equals(sharedBoardBytes), true, 'Preview leaves the shared legacy board untouched');
  check((await readFile(ordinaryBoard)).equals(ordinaryBoardBytes), true, 'Both board files remain isolated from preview');
  check(providerCalls, [], 'No model or Telegram network request occurs during handover');
  check(await exists(modelMarker), false, 'No model CLI runs during handover');
} catch (error) {
  failure = error;
} finally {
  const cleanup = async action => { try { await action(); } catch (error) { failure ||= error; } };
  for (const client of clients) await cleanup(() => close(client));
  await cleanup(() => preview?.stop()); await cleanup(() => native?.stop());
  for (const { child } of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await cleanup(() => stopRustServer(child));
  }
  await cleanup(() => fixture?.cleanup());
  await cleanup(async () => { provider.closeAllConnections(); if (provider.listening) await new Promise(resolve => provider.close(resolve)); });
  await cleanup(async () => {
    cleaned = !fixture || !await exists(fixture.directory);
    check(cleaned, true, 'All private fixture files and owned server resources are cleaned');
  });
  const report = { checkedAt: new Date().toISOString(), buildProfile: rustBuildProfile, startedAt, status: failure ? 'failed' : 'passed', assertions,
    handoverIntegrated: !failure && cleaned, productionReady: false,
    scope: 'Private Linux Node → Rust → Node on the same port, data files and tmux shell',
    remaining: ['managed restart lifecycle', 'production UI and platform gates', 'Telegram todo/autonomy command reads use their separate integration gate'],
    cleanupVerified: cleaned, providerRequests: providerCalls.length,
    ...(failure ? { failure: failure.message } : {}) };
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
if (failure) throw failure;
console.log(`Native handover gate passed: ${assertions} assertions. Production ready: false.`);
