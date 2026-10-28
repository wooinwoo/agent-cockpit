import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RUN_FIELDS = 'databaseId,name,displayTitle,headBranch,headSha,status,conclusion,event,createdAt,updatedAt,url,workflowName';

function fakeCommand(files) {
  const fs = require('node:fs');
  const name = require('node:path').basename(process.argv[1]);
  const args = process.argv.slice(2);
  if (name === 'gh' && !['run', 'workflow'].includes(args[0])) {
    const result = require('node:child_process').spawnSync(files.previousGh, args, { encoding: 'utf8' });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    process.exitCode = result.status ?? 1;
    return;
  }
  const mode = fs.readFileSync(files.mode, 'utf8');
  fs.appendFileSync(files.log, JSON.stringify({ name, args, cwd: process.cwd(), mode }) + '\n');
  if (name !== 'gh') return;
  if (mode === 'failure') { process.stderr.write('private CI fixture failure\n'); process.exitCode = 7; return; }
  if (mode === 'malformed') { process.stdout.write('{broken'); return; }
  if (mode === 'empty') return;
  if (args.includes('--log')) { process.stdout.write('  작업 😀\nsecond line\n'); return; }
  if (args[0] === 'workflow') { process.stdout.write(JSON.stringify([{ id: 10, name: '검증😀', state: 'active' }])); return; }
  const run = { databaseId: 123, name: 'CI \ud800', displayTitle: '검증', status: 'completed', conclusion: 'success', jobs: [{ name: 'build', status: 'completed' }] };
  process.stdout.write(JSON.stringify(args[1] === 'list' ? [run] : run));
}

export async function prepareSystemChecks(fixture) {
  const directory = join(fixture.directory, 'system-cli');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = { directory, mode: join(directory, 'mode'), log: join(directory, 'events.jsonl'), previousGh: join(fixture.github.directory, 'gh') };
  await writeFile(files.mode, 'ok'); await writeFile(files.log, '');
  const source = `#!${process.execPath}\n(${fakeCommand.toString()})(${JSON.stringify(files)});\n`;
  for (const name of ['gh', 'code', 'cursor', 'windsurf', 'antigravity', 'zed', 'xdg-open', 'wslview', 'firefox-developer-edition']) {
    await writeFile(join(directory, name), source, { mode: 0o700 });
  }
  fixture.env.PATH = `${directory}:${fixture.env.PATH}`;
  fixture.system = files;
}

async function events(files) { return (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }

export async function verifyCicdChecks({ fixture, sandbox, rustUrl, request, check }) {
  const files = fixture.system, bases = [fixture.url, rustUrl];
  const project = { id: 'cicd-fixture', name: 'CI 검증', path: join(sandbox, 'cicd-project') };
  await mkdir(project.path, { recursive: true });
  const same = async (path, options, status = 200, compare = true) => {
    const [node, rust] = await Promise.all(bases.map(base => request(base, path, options)));
    check(node.status, status, `Node CI status ${path}`); check(rust.status, status, `Rust CI status ${path}`);
    if (compare) check(rust.data, node.data, `CI response ${path}`);
    return [node, rust];
  };
  const exact = async args => check((await events(files)).filter(e => e.name === 'gh' && e.cwd === project.path && JSON.stringify(e.args) === JSON.stringify(args)).length >= 2, true, `Both CI commands preserve argv ${JSON.stringify(args)}`);
  const path = `/api/cicd/runs/${project.id}`;
  try {
    for (const base of bases) check((await request(base, '/api/projects', { method: 'POST', body: project })).status, 201, 'Create CI fixture');
    const [listed] = await same(path);
    check(listed.data[0].name.endsWith('\ud800'), true, 'CI keeps UTF-16 values');
    await exact(['run', 'list', '--json', RUN_FIELDS, '-L', '30']);
    const before = (await events(files)).filter(e => e.name === 'gh' && e.args[0] === 'run' && e.args[1] === 'list').length;
    await same(`${path}?limit=5`);
    check((await events(files)).filter(e => e.name === 'gh' && e.args[0] === 'run' && e.args[1] === 'list').length, before, 'CI 60-second cache ignores limit like Node');
    await same(`${path}?workflow=test.yml&status=queued&branch=feature%2F%ED%95%9C%EA%B8%80&limit=0x10`);
    await exact(['run', 'list', '--json', RUN_FIELDS, '-L', '16', '-w', 'test.yml', '-s', 'queued', '-b', 'feature/한글']);
    await same(`${path}/00123`); await exact(['run', 'view', '00123', '--json', `${RUN_FIELDS},jobs`]);
    await same(`${path}/123/jobs`); await exact(['run', 'view', '123', '--json', 'jobs']);
    const logs = await same(`${path}/123/logs`);
    check(logs[1].headers.get('content-type'), logs[0].headers.get('content-type'), 'CI logs content type');
    check(logs[1].data, '작업 😀\nsecond line', 'CI logs trim output');
    await same(`/api/cicd/workflows/${project.id}`); await exact(['workflow', 'list', '--json', 'id,name,state']);
    for (const [operation, body] of [['rerun', {}], ['rerun', { failed: true }], ['rerun', { failed: 'false' }], ['cancel', {}]]) {
      await same(`${path}/123/${operation}`, { method: 'POST', body });
      await exact(['run', operation, '123', ...(operation === 'rerun' && body.failed ? ['--failed'] : [])]);
      const count = (await events(files)).filter(e => e.name === 'gh' && e.args[0] === 'run' && e.args[1] === 'list').length;
      await same(path);
      check((await events(files)).filter(e => e.name === 'gh' && e.args[0] === 'run' && e.args[1] === 'list').length, count + 2, 'CI actions invalidate run cache');
    }
    for (const id of ['nope', '-1', '1.5', '%31', '1%3Bexit']) {
      for (const suffix of ['', '/jobs', '/logs']) await same(`${path}/${id}${suffix}`, undefined, 400);
      for (const op of ['cancel', 'rerun']) await same(`${path}/${id}/${op}`, { method: 'POST', body: {} }, 400);
    }
    await same('/api/cicd/runs/missing-project/123', undefined, 404);
    for (const mode of ['failure', 'malformed', 'empty']) {
      await writeFile(files.mode, mode);
      const status = mode === 'empty' ? 200 : 500;
      await same(`${path}?branch=${mode}`, undefined, status, mode !== 'malformed');
      await same(`${path}/123`, undefined, 500, mode === 'failure');
      if (mode === 'failure') {
        const [logs] = await same(`${path}/123/logs`); check(logs.data, '(No logs available)', 'Missing CI logs fallback');
        await same(`${path}/123/rerun`, { method: 'POST', body: {} }, 500);
      }
    }
  } finally {
    await writeFile(files.mode, 'ok');
    for (const base of bases) await request(base, `/api/projects/${project.id}`, { method: 'DELETE' });
  }
}

export async function verifySystemChecks({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl], files = fixture.system;
  const project = { id: 'system-fixture', name: 'System 검증', path: join(sandbox, 'system-project') };
  const file = join(project.path, '한글 file.txt');
  await mkdir(project.path, { recursive: true }); await writeFile(file, 'fixture');
  const same = async (path, body, status = 200) => {
    const responses = await Promise.all(bases.map(base => request(base, path, { method: 'POST', body })));
    check(responses[0].status, status, `Node system status ${path}`);
    check(responses[1].status, status, `Rust system status ${path}`);
    check(responses[1].data, responses[0].data, `System response ${path}`);
  };
  const invoked = async (name, args) => {
    const until = Date.now() + 4000;
    do {
      const found = (await events(files)).filter(e => e.name === name && JSON.stringify(e.args) === JSON.stringify(args));
      if (found.length >= 2) { check(true, true, `Both desktop launchers use exact argv ${name}`); return; }
      await new Promise(resolve => setTimeout(resolve, 40));
    } while (Date.now() < until);
    check(false, true, `Both desktop launchers use exact argv ${name}: ${JSON.stringify(args)}`);
  };
  try {
    for (const base of bases) check((await request(base, '/api/projects', { method: 'POST', body: project })).status, 201, 'Create system fixture');
    const [node, rust] = await Promise.all(bases.map(base => request(base, '/api/health')));
    check(rust.status, 200, 'Native health succeeds');
    check(Object.keys(rust.data).sort(), Object.keys(node.data).sort(), 'Health preserves fields');
    for (const key of ['status', 'version', 'terminals', 'durableTerminals']) check(rust.data[key], node.data[key], `Health ${key}`);
    for (const key of ['uptime', 'memory', 'projects', 'sseClients']) check(Number.isInteger(rust.data[key]) && rust.data[key] >= 0, true, `Health measures ${key}`);
    check(rust.data.memory > 0, true, 'Native health reports actual RSS');
    for (const ide of ['code', 'cursor', 'windsurf', 'antigravity', 'zed']) {
      await same(`/api/projects/${project.id}/open-ide`, { ide }); await invoked(ide, [project.path]);
      await same('/api/open-in-ide', { ide, path: '한글 file.txt', projectId: project.id, line: '12tail', column: 3 });
      await invoked(ide, ide === 'zed' ? [`${file}:12`] : ['--goto', `${file}:12:3`]);
    }
    const missingFile = join(project.path, 'new-file.txt');
    await same('/api/open-in-ide', { path: missingFile }); await invoked('code', [missingFile]);
    await same('/api/open-in-ide', { path: file, line: -3 }); await invoked('code', [file]);
    await same('/api/open-folder', { path: file }); await invoked('xdg-open', [project.path]);
    const url = 'HTTPS://example.invalid/path?q=%3B&value=$(not-a-command)';
    await same('/api/open-url', { url }); await invoked('xdg-open', [url]);
    await same('/api/open-url', { url, browser: 'firefox-dev' }); await invoked('firefox-developer-edition', [url]);
    await same('/api/open-url', { url: 'javascript:alert(1)' }, 400);
    await same('/api/open-url', {}, 400);
    await same('/api/open-in-ide', {}, 400);
    await same('/api/open-in-ide', { path: file, ide: 'bad' }, 400);
    await same(`/api/projects/${project.id}/open-ide`, { ide: ['code'] }, 400);
    await same('/api/open-folder', { path: join(fixture.directory, 'outside') }, 403);
    await same('/api/projects/missing/open-ide', {}, 404);
    const denied = await request(rustUrl, '/api/open-in-ide', { method: 'POST', body: { path: `${project.path}/missing/../../outside` } });
    check(denied.status, 403, 'Missing parents cannot hide traversal');
  } finally {
    for (const base of bases) await request(base, `/api/projects/${project.id}`, { method: 'DELETE' });
  }
}
