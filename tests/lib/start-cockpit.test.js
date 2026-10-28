import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t, preload = '') {
  const directory = await mkdtemp(join(tmpdir(), "cockpit startup ' "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'home'));
  await mkdir(join(directory, 'rust-server/target/release'), { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  for (const name of ['start-cockpit.mjs', 'start-cockpit.sh']) {
    await copyFile(join(root, 'scripts', name), join(directory, 'scripts', name));
  }
  const native = join(directory, 'rust-server/target/release/cockpit-server');
  const recorder = join(directory, 'native.mjs');
  await writeFile(recorder, `
    import { writeFileSync } from 'node:fs';
    // Install signal handlers before announcing readiness; the test signals as soon as it reads stdout.
    if (process.env.STARTUP_WAIT) {
      setInterval(() => {}, 1000);
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
        writeFileSync(process.env.STARTUP_MARKER, signal); process.exit(0);
      });
    }
    console.log(JSON.stringify({kind: 'rust', pid: process.pid, args: process.argv.slice(2)}));
    if (!process.env.STARTUP_WAIT) process.exit(Number(process.env.STARTUP_EXIT || 0));
  `);
  await writeFile(native, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`, { mode: 0o700 });
  await writeFile(join(directory, 'server.js'), 'console.log(JSON.stringify({kind:"node",pid:process.pid,args:process.argv.slice(2)}));');
  const preloadPath = join(directory, 'preload.mjs');
  await writeFile(preloadPath, preload);
  const argv = ['--import', preloadPath, join(directory, 'scripts/start-cockpit.mjs')];
  const env = { PATH: '/usr/bin:/bin', HOME: join(directory, 'home'), COCKPIT_NODE_BIN: process.execPath };
  const run = args => {
    const result = spawnSync(process.execPath, [...argv, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    return result;
  };
  return { directory, native, argv, env, run };
}

test('Linux default selects Rust, preserves path arguments and propagates exit codes', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  const result = f.run(['--no-open']);
  assert.equal(result.status, 0, result.stderr);
  const ready = JSON.parse(result.stdout);
  assert.equal(ready.kind, 'rust');
  assert.deepEqual(ready.args, ['--managed', '--root', f.directory, '--data-dir', join(f.directory, 'home/.local/share/cockpit'), '--home-dir', f.env.HOME]);
  if (typeof process.execve === 'function') assert.equal(ready.pid, result.pid);
  f.env.STARTUP_EXIT = '23';
  assert.equal(f.run([]).status, 23);
  f.env.LOCALAPPDATA = join(f.directory, 'alternate data');
  assert.equal(JSON.parse(f.run([]).stdout).args[4], join(f.env.LOCALAPPDATA, 'cockpit'));
  assert.equal(f.run(['--unknown']).status, 64);
  await rm(f.native);
  const missing = f.run([]);
  assert.equal(missing.status, 127);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Rust release executable is missing/);
});

test('explicit Node rollback preserves arguments without an extra resident launcher', async t => {
  const f = await fixture(t);
  const result = f.run(['--node', '--no-open']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'node', pid: result.pid, args: ['--no-open'] });
});

for (const platform of ['win32', 'darwin']) {
  test(`${platform} retains the legacy entry with a migration diagnostic`, async t => {
    const f = await fixture(t, `Object.defineProperty(process, 'platform', { value: '${platform}' });`);
    const result = f.run(['--no-open']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).kind, 'node');
    assert.match(result.stderr, /still uses the Node backend/);
  });
}

for (const fallback of [false, true]) {
  test(`native launcher forwards shutdown, execve fallback=${fallback}`, { skip: process.platform !== 'linux', timeout: 8000 }, async t => {
    const f = await fixture(t, fallback ? 'process.execve = undefined;' : '');
    const marker = join(f.directory, 'signal');
    const child = spawn(process.execPath, f.argv, { env: { ...f.env, STARTUP_WAIT: '1', STARTUP_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    exit.catch(() => {});
    t.after(async () => { if (child.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } });
    await Promise.race([
      once(child.stdout, 'data', { signal: t.signal }),
      exit.then(() => { throw new Error('Fixture exited before readiness'); }),
    ]);
    child.kill('SIGTERM');
    assert.deepEqual(await exit, [0, null]);
    assert.equal(await readFile(marker, 'utf8'), 'SIGTERM');
  });
}
