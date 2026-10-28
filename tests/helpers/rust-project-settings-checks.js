import { mkdir, readFile, writeFile, rm, utimes, symlink } from 'node:fs/promises';
import { join } from 'node:path';

export function prepareProjectSettingsChecks(fixture) {
  fixture.env.COCKPIT_PROJECT_ROOTS = join(fixture.directory, 'discovery-root');
}

export async function verifyProjectSettingsChecks({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl];
  const root = join(fixture.directory, 'settings-projects');
  const paths = ['a', 'b', 'c'].map(name => join(root, name));
  for (const path of paths) await mkdir(path, { recursive: true });
  const exports = async base => (await request(base, '/api/settings/export')).data.projects;
  const same = async (path, body, expected = 200) => {
    const results = await Promise.all(bases.map(base => request(base, path, { method: 'POST', body })));
    check(results.map(result => result.status), [expected, expected], `Project import status ${path}`);
    check(results[1].data, results[0].data, `Project import result ${path}`);
    return results[1].data;
  };
  try {
    const config = { projects: [
      { id: 'ignored-id', name: 'Import Demo', path: paths[0], stack: ['node', 'rust'], devCmd: 'private command', github: 'owner/example', color: '#Abc', future: 'ignored' },
      { name: 'Duplicate', path: paths[0].toUpperCase() },
      { name: 'Import Demo', path: paths[1].replaceAll('/', '\\'), color: 'url(not-a-color)' },
      { name: '', path: paths[2] },
      { path: paths[2] },
    ] };
    check(await same('/api/settings/import', config), { success: true, imported: 2 }, 'Import normalizes paths and removes duplicates');
    const rows = await Promise.all(bases.map(async base => (await exports(base)).filter(p => paths.includes(p.path))));
    check(rows[1], rows[0], 'Imported project fields/default colors/IDs match Node');
    check(rows[1].map(p => p.id), ['import-demo', 'import-demo-2'], 'Imported IDs are generated and disambiguated');
    check(rows[1].some(p => Object.hasOwn(p, 'session') || Object.hasOwn(p, 'future')), false, 'Settings export contains saved fields without live caches or unapproved input fields');
    check(await same('/api/settings/import', config), { success: true, imported: 0 }, 'Import retry is idempotent');
    check(await same('/api/settings/import', {}), { success: true, imported: 0 }, 'Empty settings import');
    await same('/api/discover-projects/add', {}, 400);
    check(await same('/api/discover-projects/add', { projects: [
      { name: 'Bulk Demo', path: paths[2], color: '#000', stack: 'ignored', devCmd: 'ignored', github: 'ignored' },
      { name: 'Duplicate', path: paths[0] },
    ] }), { success: true, added: 1 }, 'Discovered project import only adds new paths');
    const bulk = await Promise.all(bases.map(async base => (await exports(base)).find(p => p.path === paths[2])));
    check(bulk[1], bulk[0], 'Discovered imports preserve exact allowed fields');
    check(Object.hasOwn(bulk[1], 'devCmd'), false, 'Discovery metadata cannot supply an execution command');
    const before = await exports(rustUrl);
    const invalid = await request(rustUrl, '/api/settings/import', { method: 'POST', body: { projects: [{ name: 'Atomic Candidate', path: join(root, 'not-saved') }, { name: 42, path: join(root, 'invalid') }] } });
    check(invalid.status, 400, 'Invalid import types are rejected');
    check(await exports(rustUrl), before, 'Invalid later item cannot partially save an import');
    const concurrent = { projects: [{ name: 'Concurrent Import', path: join(root, 'concurrent') }] };
    const replies = await Promise.all([1, 2].map(() => request(rustUrl, '/api/settings/import', { method: 'POST', body: concurrent })));
    check(replies.map(r => r.data.imported).sort(), [0, 1], 'Concurrent imports serialize path deduplication');
    const persisted = JSON.parse(await readFile(join(sandbox, 'projects.json'), 'utf8'));
    check(persisted.projects.filter(p => p.path === concurrent.projects[0].path).length, 1, 'Unique imported project persisted');
  } finally {
    for (const base of bases) {
      for (const project of await exports(base)) {
        if (project.path.startsWith(root + '/')) check((await request(base, `/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' })).status, 200, 'Remove imported private project');
      }
    }
  }
}

export async function verifyDiscoveryChecks({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl];
  const homes = [fixture.directory, join(sandbox, 'home')];
  const root = fixture.env.COCKPIT_PROJECT_ROOTS;
  const names = ['alpha', 'Bravo', 'Éclair', 'Zulu', '가나', '日本', 'folder with spaces'];
  const filesystem = names.map(name => join(root, name));
  const historyOnly = join(fixture.directory, 'history-only');
  const sessionOnly = join(fixture.directory, 'session-only');
  const fallbackOnly = join(fixture.directory, 'first-lines-only');
  const git = path => mkdir(join(path, '.git'), { recursive: true });
  const hidden = [join(root, 'node_modules', 'skip'), join(root, '.hidden', 'skip'), join(root, 'a', 'b', 'c', 'd', 'e', 'too-deep')];
  for (const path of [...filesystem, historyOnly, sessionOnly, fallbackOnly, ...hidden]) await git(path);
  await mkdir(join(root, 'not-git'), { recursive: true });
  await git(join(filesystem[0], 'nested-git'));
  const all = [...filesystem, historyOnly, sessionOnly, fallbackOnly];
  const files = [], originals = [];
  const encoded = path => path.replace(/[^a-zA-Z0-9]/g, '-');
  try {
    for (const home of homes) {
      const history = join(home, '.claude/history.jsonl');
      const previous = await readFile(history).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      originals.push([history, previous]);
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(history, [JSON.stringify({ project: historyOnly }), JSON.stringify({ project: historyOnly.toUpperCase() }), JSON.stringify({ project: join(root, 'not-git') }), '{broken'].join('\n'));
      for (const [index, path] of [historyOnly, sessionOnly, fallbackOnly].entries()) {
        const directory = join(home, '.claude/projects', encoded(path));
        await mkdir(directory, { recursive: true }); files.push(directory);
        const body = index === 2 ? [JSON.stringify({ cwd: path }), ...Array(30).fill('{}')].join('\n') : [JSON.stringify({ cwd: path.replaceAll('/', '\\') }), '{}'].join('\n');
        await writeFile(join(directory, 'a.jsonl'), body);
        const timestamp = new Date(`2026-02-0${index + 1}T00:00:00.000Z`);
        await utimes(join(directory, 'a.jsonl'), timestamp, timestamp);
      }
    }
    const responses = await Promise.all(bases.map(base => request(base, '/api/discover-projects')));
    check(responses.map(r => r.status), [200, 200], 'Project discovery succeeds');
    const rows = responses.map(r => r.data.filter(p => all.includes(p.path)));
    check(rows[1], rows[0], 'Discovery paths/session counts/date and locale sorting match Node');
    check(rows[1].length, all.length, 'Filesystem/history/tail/head discovery all contribute');
    check(rows[1].slice(0, 3).map(p => p.path), [fallbackOnly, sessionOnly, historyOnly], 'Activity sorts before locale name order');
    for (const result of responses) check(result.data.some(p => hidden.includes(p.path) || p.path === join(root, 'not-git') || p.path === join(filesystem[0], 'nested-git')), false, 'Discovery excludes skipped folders, excess depth and nested repositories');
    for (const base of bases) check((await request(base, '/api/discover-projects/add', { method: 'POST', body: { projects: [{ name: 'Discovered Alpha', path: filesystem[0] }] } })).data.added, 1, 'Add discovered repository');
    for (const base of bases) check((await request(base, '/api/discover-projects')).data.some(p => p.path === filesystem[0]), false, 'Registered project is excluded from future discovery');
    // Private session/history symlinks cannot make Rust read a different home.
    const external = join(fixture.directory, 'external-discovery-history');
    await writeFile(external, JSON.stringify({ project: join(filesystem[0], 'nested-git') }));
    const history = join(homes[1], '.claude/history.jsonl');
    await rm(history); await symlink(external, history);
    check((await request(rustUrl, '/api/discover-projects')).data.some(p => p.path === join(filesystem[0], 'nested-git')), false, 'Discovery rejects external history symlink');
    await rm(history); await rm(external);
  } finally {
    for (const [path, previous] of originals) { await rm(path, { force: true }); if (previous !== null) await writeFile(path, previous); }
    for (const directory of files) await rm(directory, { recursive: true, force: true });
    for (const base of bases) {
      const projects = (await request(base, '/api/settings/export')).data.projects;
      for (const project of projects) if (all.includes(project.path)) await request(base, `/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    }
    await rm(root, { recursive: true, force: true });
    for (const path of [historyOnly, sessionOnly, fallbackOnly]) await rm(path, { recursive: true, force: true });
  }
}
