import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rustBinary, rustBuildProfile } from '../tests/helpers/rust-server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'cockpit-startup-'));
const children = [];
const checks = [];
const readonlyDirectories = [];
let failure, cleanupVerified = false;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks.push(label); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { const result = await read(); if (result) return result; await sleep(25); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
function launch(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { child, output: '', errors: '', error: null, closed: false, serverPid: null };
  child.stdout.on('data', bytes => { record.output += bytes; });
  child.stderr.on('data', bytes => { record.errors += bytes; });
  child.on('error', error => { record.error = error; });
  child.once('close', () => { record.closed = true; });
  children.push(record);
  return record;
}
async function stop(record) {
  if (!record.closed) {
    record.child.kill('SIGTERM');
    await until(() => record.closed, 'managed shutdown');
  }
  assert.ifError(record.error);
  check([record.child.exitCode, record.child.signalCode], [0, null], 'Native launcher shuts down cleanly');
  if (record.serverPid) {
    check(await stat(`/proc/${record.serverPid}`).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'Manager reaps its server child');
  }
}
async function fixture(name) {
  const source = join(directory, name, 'app');
  const home = join(directory, name, 'home');
  const data = join(home, '.local/share/cockpit');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(join(source, 'rust-server/target/release'), { recursive: true });
  await mkdir(home);
  for (const file of ['package.json', 'index.html', 'scripts/start-cockpit.mjs', 'scripts/start-cockpit.sh']) {
    await copyFile(join(root, file), join(source, file));
  }
  await symlink(rustBinary, join(source, 'rust-server/target/release/cockpit-server'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: directory, TMUX_TMPDIR: directory,
    COCKPIT_WINDOWS_HOME: home, COCKPIT_BIND: '127.0.0.1', COCKPIT_PORT: String(port),
    COCKPIT_DURABLE_TERMINALS: '0', COCKPIT_PREVIEW_BACKGROUND_AGENTS: '0', COCKPIT_PREVIEW_NETWORK_JSON: '[]' };
  const start = async stateDirectory => {
    const record = stateDirectory
      ? launch(rustBinary, ['--managed', '--root', source, '--data-dir', data, '--home-dir', home, '--state-dir', stateDirectory], env)
      : launch(process.execPath, [join(source, 'scripts/start-cockpit.mjs'), '--no-open'], env);
    const ready = await until(() => {
      assert.ifError(record.error);
      if (record.closed) throw new Error(`Startup failed: ${record.errors}`);
      return record.output.includes('\n') && JSON.parse(record.output.split('\n')[0]);
    }, 'managed readiness');
    check([ready.runtime, ready.managed], ['rust', true], stateDirectory ? 'Packaged storage starts the native manager' : 'Default source launcher starts the native manager');
    record.serverPid = ready.serverPid;
    return record;
  };
  const api = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000), ...options,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body), headers: { 'content-type': 'application/json' } }) });
    assert.equal(response.status, options.expected || 200, path);
    return response.json();
  };
  return { source, home, data, env, start, api, url: `http://127.0.0.1:${port}` };
}

async function readonly(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await readonly(join(path, entry.name));
    else if (entry.isFile()) await chmod(join(path, entry.name), 0o444);
  }
  await chmod(path, 0o555);
  readonlyDirectories.push(path);
}

try {
  const fresh = await fixture('fresh');
  const first = await fresh.start();
  check((await fresh.api('/api/health')).terminals, 0, 'Fresh HOME starts with no inherited terminals');
  check(await fresh.api('/api/projects'), [], 'Fresh HOME starts with an empty project list');
  check((await stat(fresh.data)).mode & 0o777, 0o700, 'Fresh data directory is private');
  const token = await readFile(join(fresh.data, '.cockpit-token'));
  check([token.length, (await stat(join(fresh.data, '.cockpit-token'))).mode & 0o777], [32, 0o600], 'Fresh token has private permissions');
  await stop(first);
  const retry = await fresh.start();
  check(await readFile(join(fresh.data, '.cockpit-token')), token, 'Restart preserves the generated token');
  await stop(retry);

  const legacy = await fixture('legacy');
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update('synthetic-startup-key-1234'), cipher.final()]);
  const files = {
    '.encryption-key': key.toString('hex'), '.cockpit-token': 'synthetic-startup-token-0123456789',
    'projects.json': JSON.stringify({ projects: [{ id: 'legacy', name: 'Preserved project', path: legacy.home }] }),
    'jira-config.json': '{}',
    'ai-config.json': JSON.stringify({ geminiApiKey: `enc:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}` }),
    'session-state.json': JSON.stringify({ terminals: [], marker: 'preserve' }),
    'agent-history.json': '{}',
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(legacy.source, name), bytes, { mode: 0o600 });
  const migrated = await legacy.start();
  for (const [name, bytes] of Object.entries(files)) {
    check(await readFile(join(legacy.source, name), 'utf8'), bytes, `Original ${name} survives migration`);
    check(await readFile(join(legacy.data, name), 'utf8'), bytes, `Migration preserves ${name} bytes`);
  }
  check((await legacy.api('/api/projects')).map(project => project.id), ['legacy'], 'Migrated projects are visible through HTTP');
  check((await legacy.api('/api/ai/config')).geminiApiKey, '****1234', 'Migrated encrypted settings remain readable with the original key');
  await stop(migrated);
  await writeFile(join(legacy.source, 'projects.json'), '{"projects":[]}');
  const again = await legacy.start();
  check((await legacy.api('/api/projects')).map(project => project.id), ['legacy'], 'Existing data wins over stale installation files on restart');
  await stop(again);

  assert.notEqual(process.getuid(), 0, 'Read-only installation proof must run without root privileges');
  const packaged = await fixture('packaged');
  const stateDirectory = join(packaged.home, 'install-state');
  await mkdir(stateDirectory, { mode: 0o700 });
  await readonly(packaged.source);
  const installed = await packaged.start(stateDirectory);
  check(await fetch(packaged.url).then(response => response.text()), await readFile(join(packaged.source, 'index.html'), 'utf8'), 'Read-only installation serves the original HTML bytes');
  const note = await packaged.api('/api/notes', { method: 'POST', expected: 201, body: { title: 'Packaged note', content: 'Preserve after restart' } });
  check(JSON.parse(await readFile(join(stateDirectory, 'notes', `${note.id}.json`), 'utf8')).content, 'Preserve after restart', 'Notes write to the separate user state directory');
  check((await stat(join(stateDirectory, 'logs/server.log'))).isFile(), true, 'Manager logs write outside the read-only installation');
  check((await readdir(packaged.source)).filter(name => ['logs', 'notes'].includes(name)), [], 'Runtime creates no state in the read-only installation');
  await stop(installed);
  const installedAgain = await packaged.start(stateDirectory);
  check((await packaged.api(`/api/notes/${note.id}`)).content, 'Preserve after restart', 'Packaged state persists across managed restart');
  await stop(installedAgain);
} catch (error) { failure = error; }
finally {
  try {
    for (const record of children) if (!record.closed) await stop(record);
    for (const path of readonlyDirectories.reverse()) await chmod(path, 0o700);
    await rm(directory, { recursive: true, force: true });
    cleanupVerified = true;
  } catch (error) { failure ||= error; }
  const report = { checkedAt: new Date().toISOString(), status: failure ? 'failed' : 'passed', buildProfile: rustBuildProfile,
    checks, cleanupVerified, ...(failure ? { error: failure.stack, preservedFixture: cleanupVerified ? undefined : directory } : {}) };
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(join(root, 'docs/_local/rust-startup-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
if (failure) process.exitCode = 1;
