import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const localDate = (value, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', { ...(timeZone ? { timeZone } : {}), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const field = type => parts.find(part => part.type === type).value;
  return `${field('year')}-${field('month')}-${field('day')}`;
};

export async function prepareBriefingChecks({ fixture, sandbox }) {
  const now = Date.now();
  const yesterday = localDate(new Date(now - 86_400_000), fixture.env.TZ);
  const roots = [join(fixture.directory, 'data/cockpit'), sandbox];
  const snapshot = {
    date: yesterday, timestamp: new Date(now - 86_400_000).toISOString(),
    projects: { sample: { lastCommit: 'older fixture commit', prCount: 2 } },
    cost: { daily: 4.25, weekly: 21 }, future: 'preserved 😀\ud800',
  };
  for (const root of roots) {
    await mkdir(join(root, 'snapshots'), { recursive: true });
    await writeFile(join(root, 'snapshots', `${yesterday}.json`), JSON.stringify(snapshot), { mode: 0o600 });
  }
  fixture.briefing = { roots, yesterday, snapshot };
}

async function oracle(fixture, operation, states, cost, now) {
  // Import only the copied source, in a child with private HOME/data/temp paths.
  // No in-process production config or real user snapshots can be initialized.
  const module = pathToFileURL(join(fixture.directory, 'app/lib/briefing-service.js')).href;
  const source = `
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [${now}])); }
  static now() { return ${now}; }
};
const service = await import(${JSON.stringify(module)});
const states = ${JSON.stringify(states)};
const cost = ${JSON.stringify(cost)};
process.stdout.write(JSON.stringify(service[${JSON.stringify(operation)}](states, cost)));
`;
  const { stdout } = await execute(process.execPath, ['--import', join(fixture.directory, 'isolate-home.mjs'), '--input-type=module', '--eval', source], {
    cwd: join(fixture.directory, 'app'),
    env: fixture.env,
    timeout: 5000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function verifyBriefingChecks({ fixture, sandbox, rustUrl, request, check }) {
  if (!fixture.briefing) await prepareBriefingChecks({ fixture, sandbox });
  const { roots, yesterday, snapshot } = fixture.briefing;
  const bases = [fixture.url, rustUrl];
  const pair = async (path, options) => {
    const responses = await Promise.all(bases.map(base => request(base, path, options)));
    check(responses.map(r => r.status), [200, 200], `Briefing route status ${path}`);
    check(responses[1].data, responses[0].data, `Briefing preference contract ${path}`);
    return responses[1].data;
  };
  for (const root of roots) await unlink(join(root, 'alerts.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  check(await pair('/api/alerts/prefs'), { enabled: true, disabledProjects: [] }, 'Missing prefs return exact defaults');
  const prefs = { enabled: false, disabledProjects: ['sample'], future: { value: '😀\ud800', count: 17 }, extra: null };
  check(await pair('/api/alerts/prefs', { method: 'POST', body: prefs }), { ok: true }, 'Preferences save succeeds');
  check(await pair('/api/alerts/prefs'), prefs, 'Unknown preferences and UTF-16 survive read/write');
  for (const root of roots) check(JSON.parse(await readFile(join(root, 'alerts.json'), 'utf8')), prefs, 'Preferences are actually persisted');
  await pair('/api/alerts/prefs', { method: 'POST', body: { disabledProjects: [] } });
  check(await pair('/api/alerts/prefs'), { disabledProjects: [] }, 'POST replaces preferences rather than merging defaults');
  for (const root of roots) await writeFile(join(root, 'alerts.json'), '{broken');
  check(await pair('/api/alerts/prefs'), { enabled: true, disabledProjects: [] }, 'Malformed preference file uses defaults');

  const projects = (await request(rustUrl, '/api/projects')).data;
  const cost = (await request(rustUrl, '/api/cost/daily')).data;
  const states = Object.fromEntries(projects.map(project => [project.id, {
    session: project.session, git: project.git, prs: project.prs, cicd: null,
  }]));
  // Deliberate correction: the old HTTP route reads nonexistent `prs:` cache.
  // Compare its original pure function using the real cache, not that route bug.
  const now = Date.now();
  const briefing = await request(rustUrl, '/api/briefing');
  check(briefing.status, 200, 'Native briefing succeeds');
  check(briefing.data, await oracle(fixture, 'generateBriefing', states, cost, now), 'Briefing matches original projection with actual PR cache');
  check(briefing.data.hasPreviousSnapshot, true, 'Yesterday snapshot is loaded');
  check(briefing.data.cost.yesterday, 4.25, 'Yesterday cost comes from persisted snapshot');
  const alerts = await request(rustUrl, '/api/alerts');
  check(alerts.status, 200, 'Native alerts succeed');
  check(alerts.data, await oracle(fixture, 'checkAlerts', states, cost, now), 'Alerts match original thresholds and ordering');
  check(JSON.parse(await readFile(join(sandbox, 'snapshots', `${yesterday}.json`), 'utf8')), snapshot, 'GET leaves historical snapshot intact');

  const previous = join(sandbox, 'snapshots', `${yesterday}.json`);
  await writeFile(previous, '{broken');
  check((await request(rustUrl, '/api/briefing')).data.hasPreviousSnapshot, false, 'Malformed yesterday snapshot is ignored');
  check(await readFile(previous, 'utf8'), '{broken', 'Read failure does not overwrite snapshot');
  await writeFile(previous, JSON.stringify(snapshot));
  const outside = join(fixture.directory, 'briefing-outside.json');
  await writeFile(outside, JSON.stringify(snapshot));
  await unlink(previous); await symlink(outside, previous);
  check((await request(rustUrl, '/api/briefing')).data.hasPreviousSnapshot, false, 'Snapshot symlink outside preview is rejected');
  await unlink(previous); await writeFile(previous, JSON.stringify(snapshot));
  const prefPath = join(sandbox, 'alerts.json');
  await unlink(prefPath); await symlink(outside, prefPath);
  try {
    check((await request(rustUrl, '/api/alerts/prefs', { method: 'POST', body: prefs })).status, 500, 'Unsafe preference destination fails without false success');
    check(JSON.parse(await readFile(outside, 'utf8')), snapshot, 'Rejected preference save leaves outside file unchanged');
  } finally {
    await unlink(prefPath); await writeFile(prefPath, JSON.stringify(prefs));
    await unlink(outside);
  }
}
