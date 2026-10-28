// Exercise the actual Rust HTTP/SSE polling loop with private transcript files.
// Desktop notifications and GitHub commands resolve only to fixture executables.
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = join(root, 'docs/_local/rust-polling-verification.json');
const startedAt = Date.now();
const report = { status: 'running', checkedAt: new Date().toISOString(), assertions: 0, pollingIntegrated: false, productionReady: false, stages: [] };
await mkdir(join(root, 'docs/_local'), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.assertions++; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, message, timeout = 12_000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await pause(40);
  }
  throw new Error(message);
}
async function request(base, path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
  const response = await fetch(base + path, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}
async function records(path) {
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
}
async function atomicJson(path, value) {
  await writeFile(path + '.pending', JSON.stringify(value));
  await rename(path + '.pending', path);
}
async function sameProcess(row) {
  try {
    const stat = await readFile(`/proc/${row.pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] === row.start;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
let fixture, runtime, notifyControl, ghControl, notificationsPath, ghCallsPath, failure;
const streams = [];
const api = (path, body, method, headers) => request(runtime.url, path, body, method, headers);
const stage = name => { report.stages.push(name); console.log(JSON.stringify({ stage: name, assertions: report.assertions })); };
async function subscribe() {
  const abort = new AbortController();
  const headerTimeout = setTimeout(() => abort.abort(), 5000);
  let response;
  try { response = await fetch(runtime.url + '/api/events', { signal: abort.signal }); }
  catch (error) { abort.abort(); throw error; }
  finally { clearTimeout(headerTimeout); }
  check(response.status, 200, 'Private polling SSE connects');
  check(response.headers.get('content-type'), 'text/event-stream', 'Polling route returns an SSE stream');
  const stream = { frames: [], ended: false, error: null, stop: async () => { abort.abort(); await stream.done; } };
  streams.push(stream);
  stream.done = (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        for (let boundary; (boundary = pending.indexOf('\n\n')) >= 0;) {
          const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name && data) stream.frames.push({ name, data: JSON.parse(data) });
        }
      }
    } catch (error) { if (!abort.signal.aborted) stream.error = error; }
    finally { stream.ended = true; }
  })();
  await until(() => stream.frames, frames => frames.some(frame => frame.name === 'init'), 'SSE init arrives', 5000);
  return stream;
}
const sessions = (stream, id) => stream.frames.filter(frame => frame.name === 'session:status' && frame.data.projectId === id);
const projectState = async id => (await api('/api/projects')).data.find(project => project.id === id)?.session;
async function transcript(sandbox, projectPath, state, marker) {
  const directory = join(sandbox, 'home/.claude/projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'abcd-1234.jsonl');
  const stamp = Math.floor((Date.now() - (state === 'idle' ? 600_000 : state === 'waiting' ? 60_000 : 0)) / 1000) * 1000;
  await writeFile(path, JSON.stringify({ type: 'assistant', timestamp: new Date(stamp).toISOString(), message: { model: `claude-${marker}-20260101`, content: 'Private polling fixture' } }) + '\n');
  await utimes(path, stamp / 1000, stamp / 1000);
  return marker;
}
async function observe(stream, id, state, marker, from = stream.frames.length) {
  const frame = await until(() => stream.frames.slice(from), frames => frames.find(frame => frame.name === 'session:status' && frame.data.projectId === id && frame.data.state === state && frame.data.model === marker), `Polling observes ${id}: ${state} (${marker})`);
  check(frame.some(value => value.name === 'session:status' && value.data.projectId === id && value.data.state === state && value.data.model === marker), true, 'Changed transcript reaches live SSE');
  await until(() => projectState(id), value => value?.state === state && value.model === marker, 'HTTP project cache agrees with live SSE');
}

try {
  check(process.platform, 'linux', 'Private notifier verification requires the Linux notify-send branch');
  fixture = await startPortfolioServer({ durable: false });
  const sandbox = join(fixture.directory, 'rust');
  const bin = join(fixture.directory, 'polling-bin');
  notificationsPath = join(fixture.directory, 'notifications.jsonl');
  ghCallsPath = join(fixture.directory, 'polling-gh.jsonl');
  notifyControl = join(fixture.directory, 'notify-control.json');
  ghControl = join(fixture.directory, 'gh-control.json');
  await mkdir(bin);
  await writeFile(notificationsPath, ''); await writeFile(ghCallsPath, '');
  await atomicJson(notifyControl, { hold: false }); await atomicJson(ghControl, {});
  const identity = "const stat=fs.readFileSync('/proc/self/stat','utf8'); const start=stat.slice(stat.lastIndexOf(') ')+2).split(' ')[19];";
  await writeFile(join(bin, 'notify-send'), `#!${process.execPath}
const fs=require('node:fs'); ${identity}
fs.appendFileSync(${JSON.stringify(notificationsPath)},JSON.stringify({pid:process.pid,start,args:process.argv.slice(2)})+'\\n');
const timer=setInterval(()=>{let hold=false;try{hold=JSON.parse(fs.readFileSync(${JSON.stringify(notifyControl)},'utf8')).hold}catch{}if(!hold){clearInterval(timer);process.exit(0)}},20);
setTimeout(()=>process.exit(2),20000).unref();
`, { mode: 0o700 });
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs=require('node:fs'); ${identity}
const cwd=process.cwd(); const control=${JSON.stringify(ghControl)};
const get=()=>{try{return JSON.parse(fs.readFileSync(control,'utf8'))[cwd]||{}}catch{return {}}};
const initial=get();
fs.appendFileSync(${JSON.stringify(ghCallsPath)},JSON.stringify({pid:process.pid,start,cwd,args:process.argv.slice(2)})+'\\n');
const timer=setInterval(()=>{if(get().hold)return;clearInterval(timer);console.log(JSON.stringify(initial.title?[{number:1,title:initial.title,state:'OPEN'}]:[]));},20);
setTimeout(()=>process.exit(2),20000).unref();
`, { mode: 0o700 });
  // Restart only the private Node fixture so even accidental source notifications
  // resolve to this fake binary. Its home has no session transcripts.
  await fixture.stop(); fixture.env.PATH = bin + ':' + fixture.env.PATH;
  await fixture.start();
  const start = () => startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  runtime = await start(); await runtime.stop();
  const id = 'polling-session';
  const projectName = '-Private 완료 "quoted" 😀';
  await atomicJson(join(sandbox, 'projects.json'), { projects: [{ id, name: projectName, path: fixture.project }] });
  await transcript(sandbox, fixture.project, 'busy', 'first-observation');
  runtime = await start();
  await until(() => projectState(id), state => state?.model === 'first-observation', 'Startup warms the session cache without SSE');
  check((await records(notificationsPath)).length, 0, 'First busy observation does not notify');
  const token = (await readFile(join(sandbox, '.cockpit-token'), 'utf8')).trim();
  const remote = { 'x-forwarded-for': '192.0.2.10', cookie: `cockpit-token=${token}` };
  check((await api('/api/notify/toggle', { enabled: false }, 'POST', { 'x-forwarded-for': '192.0.2.10' })).headers.get('content-type')?.startsWith('text/html'), true, 'Unauthenticated toggle cannot change state');
  check((await api('/api/notify/toggle', { enabled: false }, 'POST', { ...remote, origin: 'http://untrusted.invalid' })).status, 403, 'Cross-origin toggle is rejected');
  check((await api('/api/notify/toggle', { enabled: false }, 'POST', remote)).status, 403, 'Remote mutation without an origin is rejected');
  let stream = await subscribe();
  const initial = stream.frames.find(frame => frame.name === 'init').data;
  check(initial.sessions[id].model, 'first-observation', 'SSE init uses the warmed session cache');
  check(initial.nodeVersion, null, 'Native runtime does not pretend to run a Node server');
  check(Object.keys(initial).sort(), ['sessions', 'git', 'prs', 'costs', 'activity', 'devServers', 'nodeVersion'].sort(), 'SSE init preserves the existing seven-field contract');
  let mark = stream.frames.length;
  await transcript(sandbox, fixture.project, 'idle', 'first-completion');
  await observe(stream, id, 'idle', 'first-completion', mark);
  await until(() => records(notificationsPath), rows => rows.length === 1, 'Default-enabled busy to idle transition invokes the private notifier');
  check((await records(notificationsPath))[0].args, ['--', `${projectName} — Session Complete`, 'Claude session finished.'], 'Notification title and body are separate safe arguments');
  const settled = sessions(stream, id).length;
  await pause(6100);
  check(sessions(stream, id).length, settled, 'Unchanged session cache does not publish duplicate status');
  check((await records(notificationsPath)).length, 1, 'Repeated idle observation does not notify again');
  stage('startup-default-notification-and-deduplication');

  for (const body of [{}, { enabled: true }, { enabled: false }, { enabled: null }, { enabled: 0 }, { enabled: '' }, { enabled: 'false' }, { enabled: [] }, { enabled: {} }]) {
    const [node, rust] = await Promise.all([request(fixture.url, '/api/notify/toggle', body), api('/api/notify/toggle', body)]);
    check({ status: rust.status, data: rust.data }, { status: node.status, data: node.data }, 'Toggle response matches the original Node route');
    check(rust.data, { enabled: body.enabled !== false }, 'Only literal false disables notifications');
  }
  for (const body of [null, [], false]) check((await api('/api/notify/toggle', body)).status, 400, 'Non-object toggle input is rejected by native body validation');
  check((await api('/api/notify/toggle', { enabled: false }, 'POST', { ...remote, origin: runtime.url })).data, { enabled: false }, 'Authenticated same-origin toggle can disable notifications');
  await fixture.stop();
  mark = stream.frames.length;
  await transcript(sandbox, fixture.project, 'busy', 'disabled-busy');
  await observe(stream, id, 'busy', 'disabled-busy', mark);
  mark = stream.frames.length;
  await transcript(sandbox, fixture.project, 'idle', 'disabled-completion');
  await observe(stream, id, 'idle', 'disabled-completion', mark);
  await pause(150);
  check((await records(notificationsPath)).length, 1, 'OFF prevents actual desktop execution while still updating the session cache');
  check((await api('/api/notify/toggle', { enabled: true })).data, { enabled: true }, 'Notifications can be re-enabled');
  await pause(6100);
  check((await records(notificationsPath)).length, 1, 'Re-enabling does not replay a completion observed while OFF');
  mark = stream.frames.length;
  await transcript(sandbox, fixture.project, 'waiting', 'enabled-waiting');
  await observe(stream, id, 'waiting', 'enabled-waiting', mark);
  check((await records(notificationsPath)).length, 1, 'Entering waiting does not report completion');
  mark = stream.frames.length;
  await transcript(sandbox, fixture.project, 'idle', 'enabled-completion');
  await observe(stream, id, 'idle', 'enabled-completion', mark);
  await until(() => records(notificationsPath), rows => rows.length === 2, 'Re-enabled waiting to idle transition invokes the notifier');
  stage('toggle-contract-auth-and-real-execution');

  await stream.stop();
  await pause(200);
  await transcript(sandbox, fixture.project, 'waiting', 'headless-change');
  await pause(6200);
  check((await projectState(id)).model, 'enabled-completion', 'With all SSE clients closed, warmed session polling pauses');
  check((await records(notificationsPath)).length, 2, 'A disconnected UI does not cause unexpected completion notifications');
  const warmPath = join(fixture.directory, 'headless-warm');
  await mkdir(warmPath);
  await transcript(sandbox, warmPath, 'idle', 'headless-first');
  check((await api('/api/projects', { id: 'headless-warm', name: 'Headless warmup', path: warmPath })).status, 201, 'A new project can register without SSE');
  await until(() => projectState('headless-warm'), state => state?.model === 'headless-first', 'A new cache still warms without subscribers');
  check((await records(notificationsPath)).length, 2, 'First idle observation does not notify');
  check((await api('/api/projects/headless-warm', undefined, 'DELETE')).status, 200, 'Private warmup project is removed');
  stream = await subscribe();
  check(stream.frames.find(frame => frame.name === 'init').data.sessions[id].model, 'enabled-completion', 'Reconnect init retains the last cached state');
  await observe(stream, id, 'waiting', 'headless-change', 0);
  stage('no-subscriber-pause-warmup-and-reconnect');

  const replacement = join(fixture.directory, 'replacement-session');
  await mkdir(replacement);
  await transcript(sandbox, replacement, 'idle', 'replacement-initial');
  mark = stream.frames.length;
  check((await api(`/api/projects/${id}`, { path: replacement, name: 'Replacement session' }, 'PUT')).status, 200, 'Project path is updated through the actual API');
  await observe(stream, id, 'idle', 'replacement-initial', mark);
  check((await records(notificationsPath)).length, 2, 'Replacing a project path resets completion history instead of reporting the old session complete');
  await transcript(sandbox, fixture.project, 'busy', 'abandoned-path');
  const stableMark = stream.frames.length;
  await pause(6100);
  check((await projectState(id)).model, 'replacement-initial', 'Old transcript path cannot overwrite the replacement cache');
  check(stream.frames.slice(stableMark).some(frame => frame.data?.model === 'abandoned-path'), false, 'Old transcript path produces no late status event');

  const oldPath = join(fixture.directory, 'held-old'), newPath = join(fixture.directory, 'held-new'), deletePath = join(fixture.directory, 'held-delete');
  await Promise.all([oldPath, newPath, deletePath].map(path => mkdir(path)));
  await atomicJson(ghControl, { [oldPath]: { hold: true, title: 'stale-before-update' }, [newPath]: { title: 'current-after-update' }, [deletePath]: { hold: true, title: 'stale-after-delete' } });
  check((await api('/api/projects', { id: 'held-update', name: 'Held update', path: oldPath })).status, 201, 'Register a project with an in-flight private PR poll');
  const heldUpdate = (await until(() => records(ghCallsPath), rows => rows.some(row => row.cwd === oldPath), 'Private old-path PR command starts')).find(row => row.cwd === oldPath);
  check(await sameProcess(heldUpdate), true, 'Old-path PR command is still pending before mutation');
  mark = stream.frames.length;
  check((await api('/api/projects/held-update', { path: newPath }, 'PUT')).status, 200, 'Project mutation cancels the old polling generation');
  await until(() => stream.frames.slice(mark), frames => frames.some(frame => frame.name === 'pr:update' && frame.data.projectId === 'held-update' && frame.data.prs[0]?.title === 'current-after-update'), 'Replacement generation publishes its actual private PR result');
  await until(() => sameProcess(heldUpdate), alive => !alive, 'Project mutation reaps the old PR command');
  check((await api('/api/projects', { id: 'held-delete', name: 'Held delete', path: deletePath })).status, 201, 'Register another pending private PR poll');
  const heldDelete = (await until(() => records(ghCallsPath), rows => rows.some(row => row.cwd === deletePath), 'Private deleted-project PR command starts')).find(row => row.cwd === deletePath);
  check(await sameProcess(heldDelete), true, 'Deleted-project PR command is pending before deletion');
  check((await api('/api/projects/held-delete', undefined, 'DELETE')).status, 200, 'Project deletion invalidates its polling generation');
  const deleteMark = stream.frames.length;
  await until(() => sameProcess(heldDelete), alive => !alive, 'Project deletion reaps its pending PR command');
  await atomicJson(ghControl, {});
  await pause(250);
  check(stream.frames.slice(mark).some(frame => frame.name === 'pr:update' && frame.data.prs?.some(pr => pr.title === 'stale-before-update' || pr.title === 'stale-after-delete')), false, 'Cancelled PR generations cannot publish stale results');
  check(stream.frames.slice(deleteMark).some(frame => frame.data?.projectId === 'held-delete'), false, 'No event is published for the deleted project after the response');
  check((await api('/api/projects')).data.some(project => project.id === 'held-delete'), false, 'Deleted project has no HTTP cache entry');
  check((await api('/api/projects/held-update', undefined, 'DELETE')).status, 200, 'Remove the remaining private PR project');
  stage('project-replacement-deletion-and-pending-command-cancellation');

  mark = stream.frames.length;
  await transcript(sandbox, replacement, 'busy', 'shutdown-busy');
  await observe(stream, id, 'busy', 'shutdown-busy', mark);
  await atomicJson(notifyControl, { hold: true });
  mark = stream.frames.length;
  await transcript(sandbox, replacement, 'idle', 'shutdown-completion');
  const heldNotification = (await until(() => records(notificationsPath), rows => rows.length === 3, 'A real polling transition starts the held private notifier')).at(-1);
  check(await sameProcess(heldNotification), true, 'The notification process is pending before shutdown');
  await observe(stream, id, 'idle', 'shutdown-completion', mark);
  const shutdownAt = Date.now();
  await runtime.stop();
  check(Date.now() - shutdownAt < 8000, true, 'Shutdown completes within the private server grace period');
  await until(() => sameProcess(heldNotification), alive => !alive, 'Shutdown reaps the pending notifier', 2000);
  await until(() => stream.ended, ended => ended, 'Shutdown closes the live SSE response', 2000);
  check((await records(notificationsPath)).length, 3, 'Shutdown starts no extra notification');
  for (const connection of streams) check(connection.error, null, 'SSE lifecycle completes without a hidden stream error');
  stage('shutdown-owned-notifier-and-live-sse');
} catch (error) { failure = error; }
finally {
  // Release only private fake commands even when an assertion fails. Cleanup
  // must finish before the report is allowed to claim integration success.
  const cleanup = async operation => { try { await operation(); } catch (error) { failure ??= error; } };
  await cleanup(async () => { if (notifyControl) await atomicJson(notifyControl, { hold: false }); });
  await cleanup(async () => { if (ghControl) await atomicJson(ghControl, {}); });
  for (const stream of streams) await cleanup(() => stream.stop());
  await cleanup(async () => { await runtime?.stop(); });
  await cleanup(async () => {
    for (const path of [notificationsPath, ghCallsPath].filter(Boolean)) {
      for (const row of await records(path)) await until(() => sameProcess(row), alive => !alive, 'Private child is reaped before fixture cleanup', 3000);
    }
  });
  await cleanup(async () => { await fixture?.cleanup(); });
  report.checkedAt = new Date().toISOString(); report.durationMs = Date.now() - startedAt;
  report.status = failure ? 'failed' : 'passed'; report.pollingIntegrated = !failure;
  if (failure) report.failure = failure.message;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
if (failure) throw failure;
