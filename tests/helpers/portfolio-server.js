import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function startPortfolioServer({ durable = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cockpit-portfolio-'));
  const source = join(directory, 'app');
  const data = join(directory, 'data', 'cockpit');
  const project = join(directory, 'sample-project');
  let child;
  let output = '';
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TERM: 'xterm-256color',
    LOCALAPPDATA: join(directory, 'data'), XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_DATA_HOME: join(directory, 'share'), TMUX_TMPDIR: directory,
    COCKPIT_BIND: '127.0.0.1', COCKPIT_DURABLE_TERMINALS: durable ? '1' : '0',
    SHELL: join(directory, 'demo-shell'),
  };
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    try { await exited; } finally { clearTimeout(timeout); }
  }
  async function cleanup() {
    await stop();
    // Only sockets in this fixture's private TMUX_TMPDIR belong to this run.
    const { readdir } = await import('node:fs/promises');
    const sockets = join(directory, `tmux-${process.getuid()}`);
    for (const name of await readdir(sockets).catch(() => [])) {
      if (!/^cockpit-[a-f0-9]{24}$/.test(name)) continue;
      try { execFileSync('/usr/bin/tmux', ['-L', name, 'kill-server'], { env, stdio: 'ignore' }); } catch { /* already stopped */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await Promise.all([mkdir(source), mkdir(data, { recursive: true }), mkdir(join(project, 'src'), { recursive: true })]);
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
      output = '';
      child = spawn(process.execPath, ['--import', preload, join(source, 'server.js'), '--no-open'], { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) throw new Error(`Fixture server exited: ${output}`);
        try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* server starting */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Fixture server did not start: ${output}`);
    }
    await start();
    return { url, project, directory, env, stop, start, cleanup,
      checkpoint: async () => JSON.parse(await readFile(join(data, 'session-state.json'), 'utf8')),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
