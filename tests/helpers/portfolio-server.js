import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rustBinary } from './rust-server.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function startPortfolioServer({ durable = true, runtime = 'node' } = {}) {
  if (!['node', 'rust'].includes(runtime)) throw new Error(`Unknown fixture runtime: ${runtime}`);
  const directory = await mkdtemp(join(tmpdir(), 'cockpit-portfolio-'));
  const source = join(directory, 'app');
  const data = join(directory, 'data', 'cockpit');
  const project = join(directory, 'sample-project');
  const notificationBin = join(directory, 'notification-bin');
  let child;
  let output = '';
  let spawnError;
  let childClosed = true;
  let observations = Promise.resolve();
  const managedChildren = new Map();
  const env = {
    PATH: `${notificationBin}:${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TERM: 'xterm-256color',
    LOCALAPPDATA: join(directory, 'data'), XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_DATA_HOME: join(directory, 'share'), TMUX_TMPDIR: directory, TMPDIR: directory,
    COCKPIT_BIND: '127.0.0.1', COCKPIT_DURABLE_TERMINALS: durable ? '1' : '0',
    // Dedicated background-agent checks enable this explicitly. Other fixtures
    // must not generate unsolicited model requests while mutating private Git.
    COCKPIT_PREVIEW_BACKGROUND_AGENTS: '0',
    COCKPIT_PREVIEW_NETWORK_JSON: '[]',
    SHELL: join(directory, 'demo-shell'),
  };
  async function processIdentity(pid) {
    let stat;
    try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] || '') || !/^\d+$/.test(fields[1] || '')) throw new Error('Invalid fixture process identity');
    return { parent: Number(fields[1]), started: fields[19] };
  }
  async function stop() {
    if (!child?.pid) return;
    let forced = false;
    const running = child.exitCode === null && child.signalCode === null;
    if (running || (runtime === 'rust' && !childClosed)) {
      const exited = once(child, runtime === 'rust' ? 'close' : 'exit');
      if (running) child.kill('SIGTERM');
      const timeout = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, runtime === 'rust' ? 20_000 : 8000);
      let deadline;
      const bounded = runtime === 'rust' ? Promise.race([exited, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Fixture manager teardown timed out')), 25_000);
      })]) : exited;
      try { await bounded; } finally { clearTimeout(timeout); clearTimeout(deadline); }
    }
    if (runtime !== 'rust') return;
    await observations;
    const deadline = Date.now() + 5000;
    for (;;) {
      const remaining = [];
      for (const [pid, started] of managedChildren) {
        if ((await processIdentity(pid))?.started === started) remaining.push(pid);
      }
      if (!remaining.length) break;
      if (Date.now() >= deadline) throw new Error(`Fixture manager did not reap its server children: ${remaining.join(', ')}; preserved ${directory}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (spawnError) throw spawnError;
    if (forced || child.exitCode !== 0 || child.signalCode !== null) throw new Error(`Fixture manager did not stop gracefully: code=${child.exitCode}, signal=${child.signalCode}, forced=${forced}`);
    managedChildren.clear();
  }
  async function cleanup() {
    let failure;
    try { await stop(); }
    catch (error) {
      failure = error;
      // Preserve diagnostics if a live owned child could still be using these
      // files. Never turn a failed manager teardown into a passing fixture.
      if (child?.pid && child.exitCode === null && child.signalCode === null) throw error;
      for (const [pid, started] of managedChildren) {
        if ((await processIdentity(pid))?.started === started) throw error;
      }
    }
    // Only sockets in this fixture's private TMUX_TMPDIR belong to this run.
    const { readdir } = await import('node:fs/promises');
    const sockets = join(directory, `tmux-${process.getuid()}`);
    for (const name of await readdir(sockets).catch(() => [])) {
      if (!/^cockpit-[a-f0-9]{24}$/.test(name)) continue;
      try { execFileSync('/usr/bin/tmux', ['-L', name, 'kill-server'], { env, stdio: 'ignore' }); } catch { /* already stopped */ }
    }
    await rm(directory, { recursive: true, force: true });
    if (failure) throw failure;
  }
  try {
    await Promise.all([mkdir(source), mkdir(data, { recursive: true }), mkdir(join(project, 'src'), { recursive: true })]);
    await mkdir(notificationBin);
    // Private servers must not show desktop notifications on the user's host.
    // Dedicated notification tests prepend their own recording executable.
    await writeFile(join(notificationBin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    // Copy source only. Never copy local credentials, logs, sessions, or user projects.
    for (const name of ['server.js', 'package.json', 'index.html', 'manifest.json', 'sw.js', 'lib', 'routes', 'js', 'css', 'vendor']) {
      await cp(join(root, name), join(source, name), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(source, 'node_modules'), 'dir');
    // Isolate Node's home lookup without modifying HOME or the user's account files.
    const preload = join(directory, 'isolate-home.mjs');
    await writeFile(preload, `import os from 'node:os';\nimport { syncBuiltinESMExports } from 'node:module';\nos.homedir = () => ${JSON.stringify(directory)};\nsyncBuiltinESMExports();\n`);
    await writeFile(env.SHELL, '#!/bin/sh\nexport PS1="demo $ "\nexec /bin/bash --noprofile --norc\n', { mode: 0o700 });
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'sample-project', type: 'module', scripts: { test: 'node --test' } }, null, 2));
    await writeFile(join(project, 'src', 'total.js'), 'export const total = prices => prices.reduce((sum, price) => sum + price, 0);\n');
    await writeFile(join(project, 'total.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from './src/total.js';\ntest('합계와 빈 목록', () => { assert.equal(total([1200, 800]), 2000); assert.equal(total([]), 0); });\n");
    const git = args => execFileSync('/usr/bin/git', args, { cwd: project, env, stdio: 'ignore' });
    git(['init', '-b', 'demo/terminal']);
    git(['add', '.']);
    git(['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'feat: 시연용 합계 함수와 검증 추가']);
    await writeFile(join(project, 'src', 'total.js'), 'export const total = prices => prices.reduce((sum, price) => sum + price, 0);\n\n// 공개 시연용 변경: 실제 업무 데이터가 아닙니다.\n');
    await writeFile(join(data, 'projects.json'), JSON.stringify({ projects: [{ id: 'sample', name: 'Sample Project', path: project, color: '#60a5fa', stack: 'node' }] }));
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    env.COCKPIT_PORT = String(probe.address().port);
    await new Promise(resolve => probe.close(resolve));
    const url = `http://127.0.0.1:${env.COCKPIT_PORT}`;
    async function start() {
      if (child?.pid && child.exitCode === null && child.signalCode === null) throw new Error('Fixture server is already running');
      output = '';
      spawnError = undefined;
      observations = Promise.resolve();
      let announced = runtime === 'node';
      let stdout = '';
      const command = runtime === 'rust' ? rustBinary : process.execPath;
      const args = runtime === 'rust'
        ? ['--managed', '--root', source, '--data-dir', data, '--home-dir', directory, '--bind', `127.0.0.1:${env.COCKPIT_PORT}`]
        : ['--import', preload, join(source, 'server.js'), '--no-open'];
      child = spawn(command, args, { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] });
      childClosed = false;
      child.once('close', () => { childClosed = true; });
      const manager = child;
      const append = chunk => { output = (output + chunk).slice(-64 * 1024); };
      child.once('error', error => { spawnError = error; });
      child.stdout.on('data', chunk => {
        append(chunk);
        if (runtime !== 'rust') return;
        stdout += chunk;
        if (stdout.length > 16 * 1024) { spawnError = new Error('Fixture readiness exceeded its size limit'); stdout = ''; return; }
        let boundary;
        while ((boundary = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, boundary);
          stdout = stdout.slice(boundary + 1);
          observations = observations.then(async () => {
            const ready = JSON.parse(line);
            if (ready.managed !== true || ready.runtime !== 'rust' || ready.productionReady !== false
              || ready.listening !== `127.0.0.1:${env.COCKPIT_PORT}` || !Number.isSafeInteger(ready.serverPid) || ready.serverPid < 2) {
              throw new Error('Invalid fixture managed readiness');
            }
            const identity = await processIdentity(ready.serverPid);
            if (!identity || identity.parent !== manager.pid) throw new Error('Fixture server is not owned by its manager');
            managedChildren.set(ready.serverPid, identity.started);
            announced = true;
          }).catch(error => { spawnError = error; });
        }
      });
      child.stderr.on('data', append);
      for (let attempt = 0; attempt < (runtime === 'rust' ? 300 : 150); attempt++) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture server exited: ${output}`);
        if (announced) {
          try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* server starting */ }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Fixture server did not start: ${output}`);
    }
    await start();
    return { url, project, directory, env, stop, start, cleanup, runtime,
      checkpoint: async () => JSON.parse(await readFile(join(data, 'session-state.json'), 'utf8')),
    };
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `${error.message}; fixture cleanup failed: ${cleanupError.message}`); }
    throw error;
  }
}
