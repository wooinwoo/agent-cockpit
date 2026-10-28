import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { appendFile, chmod, copyFile, lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer, rustBinary as binary, rustBuildProfile } from '../tests/helpers/rust-server.js';
import { prepareTelegramChecks, cleanupTelegramChecks } from '../tests/helpers/rust-telegram-checks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = join(root, 'docs/_local/rust-manager-verification.json');
const startedAt = new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
let fixture, unmanaged, managedBinary, binaryBackup, pinnedIdentity, failure, cleaned = false, assertions = 0;
const managers = [], clients = [];
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };
async function until(read, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await sleep(35); }
  throw new Error(`Timed out: ${label}`);
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// Only inspect PIDs reported by this script's owned manager. Start times prevent
// later PID reuse from turning cleanup into a signal to an unrelated process.
function identity(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(') ') + 2).split(' ');
    return { pid, parent: Number(fields[1]), start: fields[19], state: fields[0] };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
const sameProcess = record => identity(record.pid)?.start === record.start;
function signalOwned(record, signal) {
  if (sameProcess(record)) process.kill(record.pid, signal);
}
async function request(base, path, { status = 200, body, headers, method = 'GET', label = `${method} ${path}`, timeout = 5000 } = {}) {
  // node:http preserves an explicit Host header; fetch may replace it with the
  // URL authority and accidentally exercise the ordinary localhost path.
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      signal: AbortSignal.timeout(timeout) }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (text.length > 4 * 1024 * 1024) req.destroy(new Error('Private HTTP response exceeds limit'));
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  check(response.status, status, `${label}: HTTP status`);
  return response.headers['content-type']?.includes('application/json') ? JSON.parse(response.text) : response.text;
}
async function startManager(args, env = fixture.env) {
  const child = spawn(managedBinary, ['--managed', ...args], { cwd: join(fixture.directory, 'app'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const manager = { child, ready: [], owned: new Map(), pending: '', output: '', stderr: '', problem: null };
  managers.push(manager);
  child.on('error', error => { manager.problem = error; });
  child.stderr.on('data', bytes => { manager.stderr = (manager.stderr + bytes).slice(-12000); });
  child.stdout.on('data', bytes => {
    manager.output = (manager.output + bytes).slice(-24000);
    manager.pending += bytes;
    if (manager.pending.length > 100000) { manager.problem = new Error('Manager emitted an unbounded readiness line'); return; }
    for (let end; (end = manager.pending.indexOf('\n')) >= 0;) {
      const line = manager.pending.slice(0, end); manager.pending = manager.pending.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (!value.listening) continue;
        if (value.managed !== true || !Number.isInteger(value.serverPid) || value.serverPid <= 1) {
          throw new Error('Managed readiness is missing managed=true or a valid serverPid');
        }
        const owned = identity(value.serverPid);
        if (!owned || owned.parent !== child.pid) throw new Error('Readiness PID is not a direct child of the owned manager');
        manager.owned.set(`${owned.pid}:${owned.start}`, owned);
        manager.ready.push(value);
      } catch (error) { manager.problem = error; }
    }
  });
  await nextReady(manager, 0);
  return manager;
}
async function nextReady(manager, previousCount) {
  return until(() => {
    if (manager.problem) throw manager.problem;
    if (manager.child.exitCode !== null || manager.child.signalCode !== null) {
      throw new Error(`Manager exited before readiness: ${manager.stderr.slice(-2000)}`);
    }
    return manager.ready.length > previousCount ? manager.ready.at(-1) : null;
  }, 'managed server readiness', 20000);
}
async function stopManager(manager) {
  if (!manager.child.pid) return; // A failed spawn has no process or exit event.
  if (manager.child.exitCode !== null || manager.child.signalCode !== null) return;
  const exited = once(manager.child, 'exit');
  manager.child.kill('SIGTERM');
  const timer = setTimeout(() => manager.child.kill('SIGKILL'), 10000);
  try { check(await exited, [0, null], 'Owned manager exits gracefully on SIGTERM'); }
  finally { clearTimeout(timer); }
}
function reportedChild(manager, ready) {
  const record = [...manager.owned.values()].find(record => record.pid === ready.serverPid && sameProcess(record));
  if (!record || identity(record.pid)?.parent !== manager.child.pid) throw new Error('Refusing to signal an unverified server PID');
  return record;
}
async function executableIdentity(path) {
  const metadata = await stat(path);
  return { device: metadata.dev, inode: metadata.ino };
}
async function pinnedExecutable(manager, ready, label) {
  reportedChild(manager, ready);
  check(await executableIdentity(`/proc/${manager.child.pid}/exe`), pinnedIdentity, `${label}: manager runs the private executable copy`);
  check(await executableIdentity(`/proc/${ready.serverPid}/exe`), pinnedIdentity, `${label}: server runs the verified executable inode`);
}
async function restoreBinary() {
  if (!binaryBackup) return;
  await rename(binaryBackup, managedBinary);
  binaryBackup = undefined;
}
async function health(ready, expectedUrl) {
  const url = `http://${ready.listening}`;
  check(ready.runtime, 'rust', 'Manager readiness identifies native runtime');
  check(ready.productionReady, false, 'Manager readiness does not claim production completion');
  if (expectedUrl) check(url, expectedUrl, 'Restart keeps the bound address and port');
  check((await request(url, '/api/migration/status')).runtime, 'rust', 'Announced server actually serves HTTP');
  return url;
}
async function connect(base) {
  const ws = new WebSocket(base.replace('http:', 'ws:'), { handshakeTimeout: 3000 });
  const messages = [], errors = [];
  ws.on('message', bytes => { messages.push(JSON.parse(bytes)); });
  ws.on('error', error => { errors.push(error); });
  const client = { ws, messages, send: value => ws.send(JSON.stringify(value)),
    wait: predicate => until(() => { if (errors.length) throw errors[0]; return messages.find(predicate); }, 'managed terminal frame') };
  clients.push(client); await once(ws, 'open');
  client.initial = await client.wait(message => message.type === 'terminals'); return client;
}
async function close(client) {
  if (client.ws.readyState >= WebSocket.CLOSING) return;
  const closed = once(client.ws, 'close'); client.ws.close();
  const timer = setTimeout(() => client.ws.terminate(), 1000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function input(client, termId, text, requestId) {
  client.send({ type: 'input', termId, data: text, requestId });
  check((await client.wait(message => message.type === 'input-result' && message.requestId === requestId)).accepted, true, `Shell input ${requestId}`);
}
async function shellProof(client, termId, label) {
  const path = join(fixture.directory, `manager-shell-${label}.json`);
  const code = `require('fs').writeFileSync(${JSON.stringify(path)},JSON.stringify({cwd:process.cwd(),mark:process.env.MANAGER_MARK,term:process.env.COCKPIT_TERM_ID}))`;
  await input(client, termId, `${quote(process.execPath)} -e ${quote(code)}\r`, `proof-${label}`);
  await until(() => exists(path), `shell proof ${label}`);
  return JSON.parse(await readFile(path, 'utf8'));
}
function tmux(durableId, args) {
  assert.match(durableId, /^[a-f0-9]{24}$/);
  return execFileSync('/usr/bin/tmux', ['-L', `cockpit-${durableId}`, ...args],
    { env: fixture.env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  fixture = await startPortfolioServer({ durable: true });
  await fixture.stop();
  managedBinary = join(fixture.directory, 'private-managed-cockpit');
  await copyFile(binary, managedBinary);
  await chmod(managedBinary, 0o700);
  pinnedIdentity = await executableIdentity(managedBinary);
  check(pinnedIdentity.inode !== (await executableIdentity(binary)).inode, true, 'Manager replacement tests use an independent private executable copy');
  const install = join(fixture.directory, 'app'), data = join(fixture.directory, 'data/cockpit');
  const logPath = join(install, 'logs/server.log');
  check(await exists(logPath), false, 'Fixture starts without a prewritten native log');
  const token = await readFile(join(data, '.cockpit-token'));
  const modelMarker = join(fixture.directory, 'unexpected-manager-model');
  for (const command of ['claude', 'codex', 'jcode', 'gemini']) {
    await writeFile(join(fixture.directory, 'notification-bin', command), `#!/bin/sh\nprintf x >> ${quote(modelMarker)}\nexit 126\n`, { mode: 0o700 });
  }

  unmanaged = await startRustServer({ root: install, directory: join(fixture.directory, 'unmanaged'), env: fixture.env });
  const unsupported = await request(unmanaged.url, '/api/server/restart', { method: 'POST', status: 409 });
  check(typeof unsupported.error, 'string', 'Unmanaged restart returns an explicit error');
  await unmanaged.stop();
  const nonDurable = await startManager(['--root', install, '--sandbox-dir', join(fixture.directory, 'non-durable')],
    { ...fixture.env, COCKPIT_DURABLE_TERMINALS: '0' });
  const nonDurableUrl = await health(nonDurable.ready[0]);
  const cannotPreserve = await request(nonDurableUrl, '/api/server/restart', { method: 'POST', status: 409 });
  check(typeof cannotPreserve.error, 'string', 'Non-durable restart returns an explicit error');
  await stopManager(nonDurable);
  for (const child of nonDurable.owned.values()) await until(() => !sameProcess(child), 'non-durable child reaped');

  const args = ['--root', install, '--data-dir', data, '--home-dir', fixture.directory,
    '--bind', `127.0.0.1:${new URL(fixture.url).port}`];
  const manager = await startManager(args);
  let ready = manager.ready[0];
  const url = await health(ready, fixture.url);
  await pinnedExecutable(manager, ready, 'Initial readiness');
  let child = reportedChild(manager, ready);
  const unrestored = await request(url, '/api/server/restart', { method: 'POST', status: 409 });
  check(unrestored.error.includes('복원'), true, 'Restart waits for initial terminal restoration');
  const readyCount = manager.ready.length;
  await request(url, '/api/server/restart', { method: 'POST', status: 403, label: 'Restart rejects a foreign Origin',
    headers: { origin: 'https://attacker.invalid' } });
  await request(url, '/api/server/restart', { method: 'POST', status: 403, label: 'Restart rejects a foreign Host sent on the wire',
    headers: { host: 'attacker.invalid' } });
  const unauthenticated = await fetch(url + '/api/server/restart', { method: 'POST',
    headers: { 'x-forwarded-for': '100.64.2.1' }, signal: AbortSignal.timeout(5000) });
  check(unauthenticated.headers.get('content-type')?.includes('text/html'), true, 'Remote request without token receives the login page');
  await unauthenticated.arrayBuffer();
  await request(url, '/api/server/restart', { method: 'POST', status: 403, label: 'Authenticated remote restart requires Origin or Referer',
    headers: { 'x-forwarded-for': '100.64.2.1', cookie: `cockpit-token=${token.toString().trim()}` } });
  check(manager.ready.length, readyCount, 'Rejected authentication and CSRF requests never restart a child');

  const first = await connect(url);
  const counter = join(fixture.directory, 'manager-one-shot.txt');
  first.send({ type: 'create', projectId: 'sample', command: `node -e "require('fs').appendFileSync('${counter}','x')"`, cols: 80, rows: 24 });
  const created = await first.wait(message => message.type === 'created');
  const termId = created.termId;
  check(created.durable, true, 'Manager launches a durable private terminal');
  await until(async () => await readFile(counter, 'utf8').catch(() => '') === 'x', 'private one-shot launcher');
  const workdir = join(fixture.project, 'manager 작업'); await mkdir(workdir);
  await input(first, termId, `cd ${quote(workdir)}; export MANAGER_MARK=preserved\r`, 'prepare-manager');
  const expectedShell = { cwd: workdir, mark: 'preserved', term: termId };
  check(await shellProof(first, termId, 'initial'), expectedShell, 'Initial managed shell state');
  const checkpoint = async () => JSON.parse(await readFile(join(data, 'session-state.json'), 'utf8'));
  const saved = await until(async () => (await checkpoint()).terminals.find(row => row.termId === termId), 'managed checkpoint');
  const pane = tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']);
  const task = (await request(url, '/api/board/tasks', { method: 'POST', status: 201,
    body: { text: 'Private manager checklist', termId } })).task;

  // Keep the live pane running while making only this fixture's socket path
  // unavailable. Restore it even when the guard assertion fails.
  const socket = join(fixture.directory, `tmux-${process.getuid()}`, `cockpit-${saved.durableId}`);
  const hiddenSocket = socket + '.private-hidden';
  await rename(socket, hiddenSocket);
  try {
    const missingTmux = await request(url, '/api/server/restart', { method: 'POST', status: 409 });
    check(missingTmux.error.includes('tmux'), true, 'Missing tmux socket blocks managed restart');
  } finally { await rename(hiddenSocket, socket); }
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Socket guard never kills the pane');
  await request(url, '/api/projects/sample', { method: 'PUT', body: { devCmd: '/bin/sleep 60' } });
  await request(url, '/api/projects/sample/dev-server/start', { method: 'POST' });
  try {
    check((await request(url, '/api/dev-servers')).running.length, 1, 'Private idle development child is registered');
    const activeDev = await request(url, '/api/server/restart', { method: 'POST', status: 409 });
    check(typeof activeDev.error, 'string', 'A running development server blocks managed restart');
  } finally { await request(url, '/api/projects/sample/dev-server/stop', { method: 'POST' }); }
  await request(url, '/api/projects/sample', { method: 'PUT', body: { devCmd: '' } });

  const beforeRestart = manager.ready.length;
  const accepted = await request(url, '/api/server/restart', { method: 'POST' });
  check(accepted, { restarting: true, terminalCount: 1 }, 'Restart acknowledges exactly the preserved terminal');
  await request(url, '/api/server/restart', { method: 'POST', status: 409 });
  ready = await nextReady(manager, beforeRestart);
  await health(ready, url);
  check(ready.serverPid !== child.pid, true, 'API restart creates a new server child');
  await until(() => !sameProcess(child), 'old server child reaped after restart');
  child = reportedChild(manager, ready);
  const resumed = await connect(url);
  check(resumed.initial.active.map(row => [row.termId, row.alias]), [[termId, created.alias]], 'API restart preserves terminal identity and alias');
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'API restart reattaches the same shell PID');
  check(await shellProof(resumed, termId, 'restart'), expectedShell, 'API restart preserves cwd and exported environment');
  check(await readFile(counter, 'utf8'), 'x', 'API restart does not repeat the initial command');
  check((await readFile(join(data, '.cockpit-token'))).equals(token), true, 'API restart retains the authentication token');
  check((await request(url, '/api/board')).tasks.find(row => row.id === task.id).termId, termId, 'API restart retains checklist ownership');
  await request(url, `/api/board/tasks/${task.id}`, { method: 'PATCH', body: { done: true } });

  const beforeCrash = manager.ready.length;
  signalOwned(reportedChild(manager, ready), 'SIGKILL');
  ready = await nextReady(manager, beforeCrash);
  await health(ready, url);
  check(ready.serverPid !== child.pid, true, 'Manager replaces the deliberately killed owned server child');
  await until(() => !sameProcess(child), 'killed child reaped by manager');
  child = reportedChild(manager, ready);
  const recovered = await connect(url);
  check(recovered.initial.active.map(row => [row.termId, row.alias]), [[termId, created.alias]], 'Crash recovery preserves terminal identity and alias');
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Crash recovery preserves the running tmux shell');
  check(await shellProof(recovered, termId, 'crash'), expectedShell, 'Crash recovery preserves shell state');
  check(await readFile(counter, 'utf8'), 'x', 'Crash recovery does not rerun the one-shot command');
  check((await request(url, '/api/board')).tasks.find(row => row.id === task.id).done, true, 'Crash recovery retains a completed checklist mutation');
  check((await readFile(join(data, '.cockpit-token'))).equals(token), true, 'Crash recovery retains the same token');

  // The manager keeps its already verified executable open. Replace only the
  // fixture's path with a failing candidate, then prove rollback twice in this
  // same manager lifetime. Source and production binaries are never modified.
  await close(recovered);
  for (let cycle = 1; cycle <= 2; cycle++) {
    const previousReadyCount = manager.ready.length;
    const beforeLog = await readFile(logPath, 'utf8');
    const fallbackCount = text => text.split('Trying the previous verified executable once').length - 1;
    const failureCount = text => text.split('Server startup verification failed').length - 1;
    binaryBackup = `${managedBinary}.healthy-${cycle}`;
    await rename(managedBinary, binaryBackup);
    try {
      await writeFile(managedBinary, '#!/bin/sh\nexit 42\n', { mode: 0o700 });
      await chmod(managedBinary, 0o700);
      check((await executableIdentity(managedBinary)).inode !== pinnedIdentity.inode, true, `Rollback ${cycle}: candidate differs from the pinned executable`);
      const accepted = await request(url, '/api/server/restart', { method: 'POST' });
      check(accepted, { restarting: true, terminalCount: 1 }, `Rollback ${cycle}: restart accepted before candidate failure`);
      ready = await nextReady(manager, previousReadyCount);
      await health(ready, url);
      check(ready.serverPid !== child.pid, true, `Rollback ${cycle}: fallback creates a fresh healthy child`);
      await until(() => !sameProcess(child), `rollback ${cycle} previous child reaped`);
      child = reportedChild(manager, ready);
      await pinnedExecutable(manager, ready, `Rollback ${cycle}`);
      const afterLog = await readFile(logPath, 'utf8');
      check(failureCount(afterLog), failureCount(beforeLog) + 1, `Rollback ${cycle}: replacement actually fails startup verification`);
      check(fallbackCount(afterLog), fallbackCount(beforeLog) + 1, `Rollback ${cycle}: manager selects the previous verified executable`);
      const fallback = await connect(url);
      check(fallback.initial.active.map(row => [row.termId, row.alias]), [[termId, created.alias]], `Rollback ${cycle}: terminal ID and alias remain unchanged`);
      check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, `Rollback ${cycle}: original pane PID is preserved`);
      check(await shellProof(fallback, termId, `rollback-${cycle}`), expectedShell, `Rollback ${cycle}: shell context remains intact`);
      check(await readFile(counter, 'utf8'), 'x', `Rollback ${cycle}: initial command is not repeated`);
      check((await readFile(join(data, '.cockpit-token'))).equals(token), true, `Rollback ${cycle}: token is unchanged`);
      check((await request(url, '/api/board')).tasks.find(row => row.id === task.id).done, true, `Rollback ${cycle}: checklist completion is retained`);
      await close(fallback);
    } finally { await restoreBinary(); }
    check(await executableIdentity(managedBinary), pinnedIdentity, `Rollback ${cycle}: healthy private binary restored`);
  }
  const beforeHealthyRestart = manager.ready.length;
  check(await request(url, '/api/server/restart', { method: 'POST' }), { restarting: true, terminalCount: 1 }, 'A normal restart remains available after two failed replacements');
  ready = await nextReady(manager, beforeHealthyRestart);
  await health(ready, url);
  check(ready.serverPid !== child.pid, true, 'Restored healthy candidate starts as a new child');
  await until(() => !sameProcess(child), 'old fallback child reaped after healthy restart');
  child = reportedChild(manager, ready);
  await pinnedExecutable(manager, ready, 'Final healthy restart');
  const finalClient = await connect(url);
  check(finalClient.initial.active.map(row => [row.termId, row.alias]), [[termId, created.alias]], 'Healthy restart after rollbacks retains terminal identity');
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Healthy restart after rollbacks preserves the original pane');
  check(await shellProof(finalClient, termId, 'healthy-again'), expectedShell, 'Healthy restart after rollbacks retains cwd and exports');
  check((await request(url, '/api/board')).tasks.find(row => row.id === task.id).done, true, 'Healthy restart after rollbacks retains the checklist');
  check((await readFile(join(data, '.cockpit-token'))).equals(token), true, 'Healthy restart after rollbacks retains the token');

  async function continuity(currentReady, label) {
    await health(currentReady, url);
    const client = await connect(url);
    try {
      check(client.initial.active.map(row => [row.termId, row.alias]), [[termId, created.alias]], `${label}: terminal identity and alias preserved`);
      check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, `${label}: original shell PID preserved`);
      check(await shellProof(client, termId, label), expectedShell, `${label}: cwd and exported environment preserved`);
      check(await readFile(counter, 'utf8'), 'x', `${label}: launcher still ran exactly once`);
      check((await readFile(join(data, '.cockpit-token'))).equals(token), true, `${label}: token preserved`);
      check((await request(url, '/api/board')).tasks.find(row => row.id === task.id).done, true, `${label}: completed task preserved`);
    } finally { await close(client); }
  }

  // An executable that reaches health is still on probation. Copying the real
  // binary creates a different inode without introducing a synthetic protocol.
  await close(finalClient);
  binaryBackup = `${managedBinary}.healthy-before-early-crash`;
  await rename(managedBinary, binaryBackup);
  try {
    await copyFile(binary, managedBinary);
    await chmod(managedBinary, 0o700);
    const candidateIdentity = await executableIdentity(managedBinary);
    check(candidateIdentity.inode !== pinnedIdentity.inode, true, 'Early-crash candidate uses a distinct private executable inode');
    const beforeCandidate = manager.ready.length;
    check(await request(url, '/api/server/restart', { method: 'POST' }), { restarting: true, terminalCount: 1 }, 'Different-inode healthy candidate is admitted');
    ready = await nextReady(manager, beforeCandidate);
    await health(ready, url);
    await until(() => !sameProcess(child), 'old child reaped before candidate probation');
    child = reportedChild(manager, ready);
    check(await executableIdentity(`/proc/${child.pid}/exe`), candidateIdentity, 'Health-verified child actually executes the new candidate inode');
    check(await executableIdentity(`/proc/${manager.child.pid}/exe`), pinnedIdentity, 'Manager retains its original executable during candidate probation');
    const beforeEarlyCrash = manager.ready.length;
    signalOwned(child, 'SIGKILL');
    ready = await nextReady(manager, beforeEarlyCrash);
    check(ready.serverPid !== child.pid, true, 'Early candidate crash produces a replacement server');
    await until(() => !sameProcess(child), 'early-crashed candidate reaped');
    child = reportedChild(manager, ready);
    await pinnedExecutable(manager, ready, 'Early candidate crash rollback');
    await continuity(ready, 'early-crash-rollback');
  } finally { await restoreBinary(); }
  check(await executableIdentity(managedBinary), pinnedIdentity, 'Original private executable restored after the early-crash test');

  await until(async () => await exists(logPath) && (await lstat(logPath)).size > 0, 'real native log output');
  const log = await readFile(logPath, 'utf8');
  check(log.trim().length > 0, true, 'Managed native processes actually write the legacy installation log');
  check(log.includes(token.toString().trim()), false, 'Native log does not include the authentication token');
  check(manager.output.includes(token.toString().trim()), false, 'Manager readiness does not expose the authentication token');
  for (const client of clients) await close(client);
  await stopManager(manager);
  await until(() => !sameProcess(child), 'final server child reaped after manager shutdown');
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Manager SIGTERM preserves the waiting tmux shell');
  check((await checkpoint()).terminals.find(row => row.termId === termId).cwd, workdir, 'Manager shutdown leaves a resumable checkpoint');

  // Kill only the directly spawned manager. The server's recorded PID and start
  // time establish ownership before it is orphaned and no longer has that PPid.
  const orphanManager = await startManager(args);
  const orphanReady = orphanManager.ready[0];
  const orphan = reportedChild(orphanManager, orphanReady);
  await continuity(orphanReady, 'before-manager-kill');
  const managerExited = once(orphanManager.child, 'exit');
  orphanManager.child.kill('SIGKILL');
  check(await managerExited, [null, 'SIGKILL'], 'Only the owned manager is killed abruptly');
  check(sameProcess(orphan), true, 'The former managed server remains alive after manager SIGKILL');
  check(identity(orphan.pid).state !== 'Z', true, 'The orphan is running rather than merely an unreaped zombie');
  const orphanRestart = await request(url, '/api/server/restart', { method: 'POST', status: 409,
    label: 'An orphaned server refuses to exit for an unavailable manager' });
  check(typeof orphanRestart.error, 'string', 'Orphan restart refusal explains the failure');
  await sleep(400);
  check(sameProcess(orphan), true, 'Rejected orphan restart leaves the existing server alive beyond the restart delay');
  await continuity(orphanReady, 'orphan-restart-refused');
  signalOwned(orphan, 'SIGTERM');
  await until(() => !sameProcess(orphan), 'owned orphan exits and is reaped', 10000);
  await stopManager(orphanManager); // Already dead: must not signal a reused PID.
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Explicit orphan cleanup preserves the tmux shell');

  await prepareTelegramChecks({ fixture });
  const telegramManager = await startManager(args);
  let telegramReady = telegramManager.ready[0];
  let telegramChild = reportedChild(telegramManager, telegramReady);
  await continuity(telegramReady, 'telegram-start');
  const telegram = fixture.telegram;
  check(await request(url, '/api/telegram/config', { method: 'POST',
    body: { token: 'fixture-rust', chatId: 'private-chat', enabled: true } }), { ok: true, configured: true }, 'Managed Telegram accepts only the private fixture configuration');
  telegram.queue.length = 0;
  check(await request(url, '/api/telegram/start', { method: 'POST', body: {} }), { ok: true, polling: true }, 'Managed private Telegram poller starts');
  await until(() => telegram.polls.size === 1, 'single managed private Telegram poll');
  let telegramMessage = 1000;
  const push = text => telegram.push({ message: { message_id: telegramMessage++, chat: { id: 'private-chat', type: 'private' }, text } });
  const sent = from => telegram.requests.slice(from).filter(row => row.method === 'sendMessage');
  async function command(text, matches) {
    const from = telegram.requests.length;
    push(text);
    const reply = await until(() => sent(from).find(row => matches(row.body.text)), `managed Telegram reply for ${text}`);
    check(reply.body.chat_id, 'private-chat', `${text}: response stays in the configured private chat`);
    check(reply.body.disable_notification, true, `${text}: command preserves the source silent flag`);
    return reply.body.text;
  }
  const escaped = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const actualLog = await readFile(logPath, 'utf8');
  const readyLogLine = actualLog.trim().split('\n').findLast(line => line.includes(`"serverPid":${telegramChild.pid}`));
  check(typeof readyLogLine, 'string', 'Actual production-layout manager log contains this server readiness');
  const logReply = await command('/log 50', text => text.includes('서버 로그 (마지막 50줄)'));
  check(logReply.includes(escaped(readyLogLine)), true, 'Telegram reads the real manager log written at the legacy installation root');
  check(logReply.includes(token.toString().trim()), false, 'Telegram log response never exposes the authentication token');
  const boundaryError = 'ETIMEDOUT ' + 'x'.repeat(69) + '😀 after UTF-16 boundary';
  const diagnosticLines = [
    '[ERROR] ETIMEDOUT outside-the-last-500-lines',
    ...Array.from({ length: 501 }, (_, index) => `Private diagnostic filler ${index}`),
    '[ERROR] ETIMEDOUT older-network-error',
    'Gemini response in 100ms',
    'Gemini response in 300ms',
    'Gemini response in 0ms',
    '[ERROR] ETIMEDOUT <safe-one>& TOKEN=fixture-only-secret',
    'ECONNRESET <safe-two> 😀',
    boundaryError,
  ];
  await appendFile(logPath, diagnosticLines.join('\n') + '\n');
  await request(url, '/api/autopilot/mode', { method: 'POST', body: { mode: 'unattended' } });
  const approvalFrom = telegram.requests.length;
  // The decision endpoint asks permission; it never executes this command.
  const pendingApproval = request(url, '/api/autopilot/decide', { method: 'POST', timeout: 15000,
    body: { tool: 'Bash', input: { command: 'git pull' } } })
    .then(value => ({ value }), error => ({ error }));
  const approval = await until(() => sent(approvalFrom).find(row => row.body.reply_markup), 'private diagnostic pending approval');
  async function observedRss() {
    reportedChild(telegramManager, telegramReady);
    const status = await readFile(`/proc/${telegramChild.pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    check(Boolean(match), true, 'Private owned server exposes its actual RSS');
    return Math.round(Number(match[1]) / 1024);
  }
  const rssBefore = await observedRss();
  const expectedOffset = telegram.nextUpdate + 1;
  const diagnostic = await command('/diag', text => text.includes('런타임: Rust') && text.includes('polling 중') && text.includes('uptime:'));
  const rssAfter = await observedRss();
  const reportedRss = Number(/메모리: RSS (\d+)MB/.exec(diagnostic)?.[1]);
  check(Number.isFinite(reportedRss) && reportedRss > 0, true, 'Diagnostics reports numeric process RSS');
  check(reportedRss >= Math.min(rssBefore, rssAfter) - 1 && reportedRss <= Math.max(rssBefore, rssAfter) + 1, true,
    'Diagnostic RSS matches the same owned process sampled around the command');
  check(diagnostic.includes('Heap 해당 없음 (Rust, V8 미사용)'), true, 'Native diagnostics does not invent a V8 heap value');
  check(diagnostic.includes(`(offset=${expectedOffset})`), true, 'Diagnostic offset tracks the actual consumed Telegram update');
  await until(() => telegram.requests.some(row => row.method === 'getUpdates' && row.body.timeout > 0 && row.body.offset === expectedOffset), 'poller uses the diagnostic update offset');
  check(diagnostic.includes('최근 500줄 에러: 2건'), true, 'Diagnostic errors count only the last 500 log lines');
  check(diagnostic.includes('Gemini 평균 응답: 200ms'), true, 'Gemini average preserves source zero-sample exclusion');
  check(diagnostic.includes('pending approvals: 1건'), true, 'Diagnostics observes the actual outstanding approval');
  check(diagnostic.includes('outside-the-last-500-lines') || diagnostic.includes('older-network-error'), false, 'Diagnostics emits only the last three network errors');
  const expectedNetwork = [
    '[ERROR] ETIMEDOUT <safe-one>& TOKEN=***',
    'ECONNRESET <safe-two> 😀',
    boundaryError,
  ].map(line => escaped(line.slice(0, 80))).join('\n');
  check(diagnostic.includes(`<code>${expectedNetwork}</code>`), true, 'Recent network errors preserve HTML escaping, masking and UTF-16 truncation');
  check(diagnostic.includes('fixture-only-secret'), false, 'Diagnostic network details never expose the synthetic token');
  const originalDiagnosticLog = await readFile(logPath);
  const malformedDiagnosticLog = Buffer.concat([
    Buffer.from('[ERROR] ETIMEDOUT TOKEN=fixture-corrupt-secret\n'), Buffer.from([0xff, 0xfe]),
  ]);
  try {
    await writeFile(logPath, malformedDiagnosticLog);
    const corruptedOffset = telegram.nextUpdate + 1;
    const degraded = await command('/diag', text => text.includes('런타임: Rust') && text.includes('polling 중'));
    check(/메모리: RSS [1-9]\d*MB/.test(degraded), true, 'Unreadable logs do not hide actual process RSS');
    check(degraded.includes('uptime:') && degraded.includes(`(offset=${corruptedOffset})`), true, 'Unreadable logs preserve uptime and the live polling offset');
    check(degraded.includes('pending approvals: 1건'), true, 'Unreadable logs preserve the outstanding approval count');
    check(degraded.includes('최근 500줄 에러: 확인 불가'), true, 'Unreadable logs do not invent a zero error count');
    check(degraded.includes('Gemini 평균 응답: 확인 불가'), true, 'Unreadable logs mark timing measurements unavailable');
    check(degraded.includes('<b>최근 네트워크 에러:</b>\n확인 불가'), true, 'Unreadable logs mark recent network details unavailable');
    check(degraded.includes('fixture-corrupt-secret') || degraded.includes(token.toString().trim()), false, 'Rejected log contents and authentication tokens never enter diagnostics');
    check((await readFile(logPath)).equals(malformedDiagnosticLog), true, 'Diagnostics leaves rejected log bytes untouched');
  } finally { await writeFile(logPath, originalDiagnosticLog); }
  check((await readFile(logPath)).equals(originalDiagnosticLog), true, 'Private malformed-log fixture restores the original bytes');
  telegram.push({ callback_query: { id: 'private-diagnostic-denial',
    data: approval.body.reply_markup.inline_keyboard[0][1].callback_data,
    message: { message_id: 42, chat: { id: 'private-chat', type: 'private' } } } });
  const decision = await pendingApproval;
  if (decision.error) throw decision.error;
  check(decision.value.decision, 'deny', 'Private diagnostic approval is explicitly denied without executing a command');
  await command('/diag', text => text.includes('pending approvals: 0건'));
  await request(url, '/api/autopilot/mode', { method: 'POST', body: { mode: 'attended' } });

  const restartText = '터미널 1개를 보존하며 콕핏 서버를 재시작합니다.';
  const rejectedAck = telegram.holdNext('sendMessage', body => body.text === restartText);
  const beforeRejectedAck = telegramManager.ready.length;
  push('/restart');
  await until(() => rejectedAck.request, 'managed Telegram restart acknowledgement held');
  check(rejectedAck.request.body.chat_id, 'private-chat', 'Restart acknowledgement targets the configured private chat');
  check(sameProcess(telegramChild), true, 'A held Telegram acknowledgement has not stopped its server');
  rejectedAck.release({ ok: false, error_code: 400, description: 'Private acknowledgement delivery rejected' });
  await until(() => rejectedAck.closed, 'failed acknowledgement response completed');
  await sleep(700);
  await command('/status', text => text.includes('Cockpit 상태'));
  check(telegramManager.ready.length, beforeRejectedAck, 'Failed Telegram acknowledgement does not restart the server');
  check(sameProcess(telegramChild), true, 'Failed Telegram delivery preserves the original server PID');
  await health(telegramReady, url);

  // A fresh successful command proves the failed delivery released the pending
  // restart reservation. Clear consumed updates before the next startup sync.
  telegram.queue.length = 0;
  const beforeTelegramRestart = telegramManager.ready.length;
  await command('/restart', text => text === restartText);
  telegram.queue.length = 0;
  telegramReady = await nextReady(telegramManager, beforeTelegramRestart);
  check(telegramReady.serverPid !== telegramChild.pid, true, 'Delivered Telegram acknowledgement triggers a new managed server child');
  await until(() => !sameProcess(telegramChild), 'Telegram-restarted server child reaped');
  telegramChild = reportedChild(telegramManager, telegramReady);
  await continuity(telegramReady, 'telegram-restart');
  await until(() => telegram.polls.size === 1, 'private Telegram polling resumes after managed restart');
  await command('/status', text => text.includes('Cockpit 상태'));
  await request(url, '/api/telegram/stop', { method: 'POST', body: {} });
  await until(() => telegram.polls.size === 0, 'private Telegram polling closes');
  await stopManager(telegramManager);
  await until(() => !sameProcess(telegramChild), 'Telegram manager shutdown reaps its server');
  check(tmux(saved.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Telegram lifecycle retains the original tmux shell');
  check(await readFile(counter, 'utf8'), 'x', 'Entire manager lifecycle executes the launcher once');
  for (const entry of managers) for (const owned of entry.owned.values()) check(sameProcess(owned), false, 'Every observed manager child has been reaped');
  check(await exists(modelMarker), false, 'Manager tests never execute a model CLI');
} catch (error) {
  failure = error;
} finally {
  const cleanup = async operation => { try { await operation(); } catch (error) { failure ||= error; } };
  for (const client of clients) await cleanup(() => close(client));
  await cleanup(() => unmanaged?.stop());
  for (const manager of managers) {
    await cleanup(() => stopManager(manager));
    for (const owned of manager.owned.values()) await cleanup(async () => {
      if (!sameProcess(owned)) return;
      signalOwned(owned, 'SIGTERM');
      try { await until(() => !sameProcess(owned), 'owned orphan cleanup', 3000); }
      catch { signalOwned(owned, 'SIGKILL'); await until(() => !sameProcess(owned), 'owned orphan reaped', 3000); }
    });
  }
  await cleanup(() => restoreBinary());
  if (fixture) await cleanup(() => cleanupTelegramChecks(fixture));
  await cleanup(() => fixture?.cleanup());
  await cleanup(async () => {
    cleaned = (!fixture || !await exists(fixture.directory))
      && managers.every(manager => !manager.child.pid || manager.child.exitCode !== null || manager.child.signalCode !== null)
      && managers.every(manager => [...manager.owned.values()].every(child => !sameProcess(child)));
    check(cleaned, true, 'All private servers, clients, fixture tmux servers and files are cleaned');
  });
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ startedAt, checkedAt: new Date().toISOString(), buildProfile: rustBuildProfile,
    status: failure ? 'failed' : 'passed', assertions, managerIntegrated: !failure && cleaned, productionReady: false,
    scope: 'Private native manager: guarded restart, two failed replacements and early-crash rollback, orphan refusal, Telegram acknowledgement delivery, real log and diagnostic counters, terminal continuity and cleanup',
    cleanupVerified: cleaned,
    remaining: ['production UI and platform gates', 'actual production cutover'],
    ...(failure ? { failure: String(failure.message).slice(0, 2000) } : {}),
  }, null, 2) + '\n');
}
if (failure) { console.error(`Native manager gate failed after ${assertions} assertions: ${String(failure.message).slice(0, 2000)}`); process.exitCode = 1; }
else console.log(`Native manager gate passed: ${assertions} assertions. Production ready: false.`);
