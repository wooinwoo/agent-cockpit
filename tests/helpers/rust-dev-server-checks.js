import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function until(read, accept, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(30);
  } while (Date.now() < end);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
async function identity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    return { start: fields[19], state: fields[0] };
  } catch { return null; }
}
async function alive(record) {
  const current = await identity(record.pid);
  return current?.start === record.start && !['Z', 'X'].includes(current.state);
}

export async function verifyDevServerChecks({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl];
  const id = 'dev-contract';
  const paths = [join(fixture.directory, 'dev-node'), join(sandbox, 'dev-rust')];
  const records = [];
  const registered = [];
  const controllers = [];
  const streams = [];
  const frames = [[], []];
  const route = `/api/projects/${id}/dev-server`;
  const normalize = value => {
    const copy = JSON.parse(JSON.stringify(value).replaceAll(paths[0], '<dev>').replaceAll(paths[1], '<dev>'));
    const rows = Array.isArray(copy) ? copy : copy.running;
    if (rows) for (const row of rows) row.startedAt = '<timestamp>';
    return copy;
  };
  const pair = async (path, method = 'GET', status = 200) => {
    const responses = await Promise.all(bases.map(base => request(base, path, { method })));
    check(responses.map(r => r.status), [status, status], `${path} status`);
    check(normalize(responses[1].data), normalize(responses[0].data), `${path} Node contract`);
    return responses[1].data;
  };
  const list = async base => (await request(base, '/api/dev-servers')).data.running;
  const record = async file => {
    const result = await until(async () => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }, Boolean, `Fixture PID ${file}`);
    records.push(result);
    return result;
  };
  const startStream = async (base, index) => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    streams.push((async () => {
      const decoder = new TextDecoder(); let pending = '';
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        for (let split; (split = pending.indexOf('\n\n')) >= 0;) {
          const frame = pending.slice(0, split); pending = pending.slice(split + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1]; const data = frame.match(/^data: (.+)$/m)?.[1];
          if (event && data) frames[index].push({ event, data: JSON.parse(data) });
        }
      }
    })().catch(error => { if (!controller.signal.aborted) throw error; }));
    await until(() => frames[index], rows => rows.some(f => f.event === 'init'), 'Dev SSE initial');
  };
  try {
    for (const [index, path] of paths.entries()) {
      await mkdir(path, { recursive: true });
      // These processes do no project work and bind no ports. Recorded /proc
      // start identities prevent cleanup from targeting a reused fixture PID.
      await writeFile(join(path, 'child.cjs'), `
const fs = require('node:fs');
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
fs.writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,start:stat.slice(stat.lastIndexOf(') ')+2).split(' ')[19]}));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 30000);
`);
      await writeFile(join(path, 'server.cjs'), `
const fs = require('node:fs'); const {spawn} = require('node:child_process'); const path = require('node:path');
const mode = process.argv[2] || 'normal'; const directory = __dirname;
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
fs.writeFileSync(path.join(directory, mode+'-parent.json'), JSON.stringify({pid:process.pid,start:stat.slice(stat.lastIndexOf(') ')+2).split(' ')[19]}));
spawn(process.execPath, [path.join(directory,'child.cjs'),path.join(directory,mode+'-child.json')], {stdio:'ignore'});
setTimeout(() => { process.stdout.write('http://localhost:5173\\n'); }, 150);
setTimeout(() => { process.stderr.write('port 8080\\n'); }, 350);
if (mode === 'orphan') setTimeout(() => process.exit(0), 700);
else if (mode === 'exit') setTimeout(() => process.exit(0), 700);
else setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 30000);
`);
      const response = await request(bases[index], '/api/projects', { method: 'POST', body: { id, name: 'Dev fixture', path: fixture.project } });
      check(response.status, 201, 'Register private dev fixture'); registered.push(bases[index]);
    }
    check((await pair('/api/dev-servers')).running, [], 'No dev servers initially');
    await pair(`${route}/start`, 'POST', 400);
    await pair(`${route}/stop`, 'POST', 404);
    await pair('/api/projects/missing-dev/dev-server/start', 'POST', 404);
    await pair('/api/projects/missing-dev/dev-server/stop', 'POST', 404);
    for (const [index, base] of bases.entries()) {
      const command = `${quote(process.execPath)} ${quote(join(paths[index], 'server.cjs'))} normal`;
      check((await request(base, `/api/projects/${id}`, { method: 'PUT', body: { devCmd: command } })).status, 200, 'Configure private fake command');
      await startStream(base, index);
    }
    await pair(`${route}/start`, 'POST');
    await pair(`${route}/start`, 'POST', 409);
    const firstRecords = [];
    for (const [index, path] of paths.entries()) {
      const parent = await record(join(path, 'normal-parent.json'));
      const child = await record(join(path, 'normal-child.json'));
      firstRecords[index] = [parent, child];
      await until(() => list(bases[index]), rows => rows.find(row => row.projectId === id)?.port === 5173, 'First advertised dev port');
      await until(() => frames[index], rows => rows.some(f => f.event === 'dev:status' && f.data.running.some(r => r.projectId === id && r.port === 5173)), 'Dev port SSE');
    }
    await delay(400);
    const running = await pair('/api/dev-servers');
    check(running.running[0].name, 'Dev fixture', 'GET dev snapshot includes project name');
    check(running.running[0].port, 5173, 'Later stderr port does not replace first stdout port');
    for (const rows of frames) {
      const updates = rows.filter(f => f.event === 'dev:status');
      check(updates.some(f => f.data.running.some(r => r.projectId === id && r.port === null)), true, 'Start broadcasts null port');
      check(updates.every(f => f.data.running.every(r => !Object.hasOwn(r, 'name'))), true, 'Dev SSE omits names');
    }
    // Verify initial snapshots while a dev server is running, not only updates.
    const snapshotController = new AbortController(); controllers.push(snapshotController);
    const snapshotResponse = await fetch(`${rustUrl}/api/events`, { signal: snapshotController.signal });
    const reader = snapshotResponse.body.getReader();
    let pending = ''; const decoder = new TextDecoder();
    try {
      await until(async () => {
        const chunk = await reader.read(); pending += decoder.decode(chunk.value || new Uint8Array(), { stream: true });
        return pending;
      }, text => text.includes('\n\n'), 'Dev running initial snapshot');
      const initial = JSON.parse(pending.match(/^data: (.+)$/m)[1]);
      check(initial.devServers[0].projectId, id, 'Initial SSE includes current dev server');
      check(Object.hasOwn(initial.devServers[0], 'name'), false, 'Initial SSE dev snapshot omits names');
    } finally { snapshotController.abort(); await reader.cancel().catch(() => {}); }
    await pair(`${route}/stop`, 'POST');
    check((await pair('/api/dev-servers')).running, [], 'Stop clears dev snapshot');
    for (const record of firstRecords[1]) await until(() => alive(record), value => !value, 'Rust stop kills owned parent and SIGTERM-resistant descendant');
    await pair(`${route}/stop`, 'POST', 404);
    for (const [index, base] of bases.entries()) {
      const before = frames[index].length;
      const command = `${quote(process.execPath)} ${quote(join(paths[index], 'server.cjs'))} exit`;
      await request(base, `/api/projects/${id}`, { method: 'PUT', body: { devCmd: command } });
      check((await request(base, `${route}/start`, { method: 'POST' })).status, 200, 'Natural exit fixture starts');
      await record(join(paths[index], 'exit-parent.json'));
      const child = await record(join(paths[index], 'exit-child.json'));
      await until(() => list(base), rows => !rows.some(row => row.projectId === id), 'Natural exit removes dev record');
      await until(() => frames[index].slice(before), rows => rows.some(f => f.event === 'dev:status' && !f.data.running.some(r => r.projectId === id)), 'Natural exit SSE');
      if (index === 1) await until(() => alive(child), value => !value, 'Rust natural shell exit cleans remaining descendants');
    }
    // A rapid stop/replacement cannot be deleted by the old monitor's exit.
    const base = rustUrl; const path = paths[1];
    await request(base, `/api/projects/${id}`, { method: 'PUT', body: { devCmd: `${quote(process.execPath)} ${quote(join(path, 'server.cjs'))} replace` } });
    check((await request(base, `${route}/start`, { method: 'POST' })).status, 200, 'Replacement test first run');
    await record(join(path, 'replace-parent.json')); await record(join(path, 'replace-child.json'));
    check((await request(base, `${route}/stop`, { method: 'POST' })).status, 200, 'Replacement test stops old run');
    check((await request(base, `${route}/start`, { method: 'POST' })).status, 200, 'Replacement starts immediately after stop');
    await delay(500);
    await record(join(path, 'replace-parent.json')); await record(join(path, 'replace-child.json'));
    check((await list(base)).some(row => row.projectId === id), true, 'Old exit cannot remove replacement');
    check((await request(base, `${route}/stop`, { method: 'POST' })).status, 200, 'Stop replacement');
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(streams);
    for (const base of registered) {
      await request(base, `${route}/stop`, { method: 'POST' }).catch(() => {});
      await request(base, `/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const path of paths) {
      for (const name of await readdir(path).catch(() => [])) {
        if (!name.endsWith('.json')) continue;
        try { records.push(JSON.parse(await readFile(join(path, name), 'utf8'))); } catch { /* partial fixture record */ }
      }
    }
    for (const record of records.reverse()) {
      if (await alive(record)) { try { process.kill(record.pid, 'SIGKILL'); } catch { /* exited */ } }
    }
  }
}
