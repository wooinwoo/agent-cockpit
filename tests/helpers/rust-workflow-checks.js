import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, readdir, writeFile, unlink, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, label, timeout = 12000) {
  const end = Date.now() + timeout;
  let value;
  do { value = await read(); if (accept(value)) return value; await pause(25); } while (Date.now() < end);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['runId', 'startedAt', 'endedAt'].includes(key)).map(([key, item]) => [key, normalize(item)]));
  return value;
};
function definition(id, steps, edges, extra = {}) {
  return { id, name: `Private ${id} 😀\ud800`, description: 'Isolated native workflow contract', inputs: [{ key: 'text', label: 'Text' }], steps, edges, ...extra };
}
function single(id, step) {
  return definition(id, [{ id: 'one', name: 'Private step', ...step }], [{ from: 'START', to: 'one' }, { from: 'one', to: 'END' }]);
}

// Requires prepareGitAiChecks first. Run before restarting Node and launching
// Rust: the inherited PATH and fetch preload must refer only to private mocks.
export async function prepareWorkflowChecks({ fixture, sandbox }) {
  if (fixture.workflows) return;
  if (!fixture.gitAi) throw new Error('prepareGitAiChecks must precede prepareWorkflowChecks');
  const directory = join(fixture.directory, 'app/workflows');
  await mkdir(directory, { recursive: true }); await mkdir(sandbox, { recursive: true });
  // The fixture application is a private source copy. Do not execute repository
  // workflow definitions that could contain real account or deployment paths.
  for (const name of await readdir(directory)) if (name.endsWith('.json')) await unlink(join(directory, name));
  const pidFile = join(fixture.directory, 'workflow-owned-pids.json');
  const ownedScript = join(fixture.directory, 'workflow-owned-child.cjs');
  await writeFile(ownedScript, `const fs = require('node:fs');
const child = require('node:child_process').spawn('/bin/sleep', ['60'], { stdio: 'inherit' });
function identity(pid) { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return s.slice(s.lastIndexOf(') ') + 2).split(' ')[19]; }
child.once('spawn', () => fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid].map(pid => ({pid, start:identity(pid)})))));
setInterval(() => {}, 1000);
`, { mode: 0o600 });
  const defs = [
    single('wf-shell', { type: 'shell', command: 'echo hello-{{who}}', cwd: fixture.project, outputKey: 'result' }),
    definition('wf-parallel', [
      { id: 'right', type: 'condition', pattern: '^{{left}}$', target: 'original', outputKey: 'right' },
      { id: 'left', type: 'condition', pattern: '^ok$', target: 'text', outputKey: 'left' },
      { id: 'join', type: 'condition', pattern: '^{{left}}/{{right}}$', target: 'expected', outputKey: 'joined' },
    ], [{ from: 'START', to: ['right', 'left'] }, { from: ['left', 'right'], to: 'join' }, { from: 'join', to: 'END' }]),
    definition('wf-cycle', [{ id: 'again', type: 'condition', pattern: 'never', target: 'text' }], [{ from: 'START', to: 'again' }, { from: 'again', condition: { pattern: 'true', true: 'END', false: 'again' } }], { maxIterations: 2 }),
    definition('wf-legacy', [{ id: 'branch', type: 'condition', pattern: '^ok$', target: 'text' }, { id: 'pass', type: 'shell', command: 'echo branch-pass', cwd: fixture.project }], [{ from: 'START', to: 'branch' }, { from: 'branch', branches: { true: 'pass', false: 'END' } }, { from: 'pass', to: 'END' }]),
    single('wf-regex', { type: 'condition', pattern: '^(?=abab$)(ab)\\1$', target: 'text' }),
    single('wf-regex-surrogate', { type: 'condition', pattern: '^\ud800$', target: 'text' }),
    single('wf-regex-number', { type: 'condition', pattern: '^42$', target: 'count' }),
    single('wf-llm', { type: 'llm', role: 'Private role', prompt: 'Describe {{topic}}', provider: 'claude', model: 'auto', tools: [] }),
    single('wf-http', { type: 'http', url: 'http://workflow-fixture.invalid/echo', method: 'POST', headers: { 'x-fixture': '{{text}}' }, body: 'payload {{text}}' }),
    single('wf-http-status', { type: 'http', url: 'http://workflow-fixture.invalid/error' }),
    single('wf-blocked-http', { type: 'http', url: 'http://127.0.0.1:9/blocked' }),
    single('wf-redirect-private', { type: 'http', url: 'http://workflow-fixture.invalid/redirect-private' }),
    single('wf-failed', { type: 'fixture-unknown' }),
    definition('wf-stop', [{ id: 'one', type: 'http', url: 'http://workflow-fixture.invalid/slow?side={{side}}' }, { id: 'after', type: 'condition', pattern: '.*' }], [{ from: 'START', to: 'one' }, { from: 'one', to: 'after' }, { from: 'after', to: 'END' }]),
    single('wf-owned-stop', { type: 'shell', command: `node ${ownedScript} ${pidFile}`, cwd: fixture.project, timeout: 60000 }),
    single('wf-newline', { type: 'shell', command: 'echo safe\necho forbidden', cwd: fixture.project }),
  ];
  for (const def of defs) await writeFile(join(directory, `${def.id}.json`), JSON.stringify(def));
  await writeFile(join(directory, 'invalid.json'), '{broken');
  const histories = [join(fixture.directory, 'app/workflow-runs.json'), join(sandbox, 'workflow-runs.json')];
  const seed = { runId: 'workflow-seed', workflowId: 'seed', workflowName: 'Persisted private run', status: 'done', startedAt: 1, endedAt: 2, inputs: { text: '\ud800' }, steps: [], error: null, unknown: 'preserve' };
  for (const file of histories) await writeFile(file, JSON.stringify([seed]), { mode: 0o600 });
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push({ path: url.pathname, query: url.search, method: req.method, body, fixture: req.headers['x-fixture'] || '' });
    if (url.pathname === '/slow') {
      const timer = setTimeout(() => res.end('private slow response'), 750);
      res.once('close', () => clearTimeout(timer)); return;
    }
    if (url.pathname === '/redirect-private') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/forbidden` }); res.end(); return; }
    if (url.pathname === '/error') { res.writeHead(503); res.end('upstream error body remains node output'); return; }
    if (url.pathname === '/forbidden') { res.writeHead(500); res.end('must never be reached'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, body, fixture: req.headers['x-fixture'] || '' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  fixture.env.COCKPIT_PREVIEW_WORKFLOW_HTTP_BASE = base;
  fixture.workflows = { defs, histories, calls, server, pidFile, seed };
  await appendFile(join(fixture.directory, 'isolate-home.mjs'), `
const workflowFixtureFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'workflow-fixture.invalid') {
    if (url.origin !== 'http://workflow-fixture.invalid') throw new Error('Unexpected workflow fixture origin');
    return workflowFixtureFetch(${JSON.stringify(base)} + url.pathname + url.search, init);
  }
  return workflowFixtureFetch(input, init);
};
`);
}

async function identity(record) {
  try {
    const text = await readFile(`/proc/${record.pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(') ') + 2).split(' ');
    return fields[19] === record.start && fields[0] !== 'Z';
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function cleanupWorkflowChecks(fixture) {
  const state = fixture.workflows;
  if (!state || state.closed) return;
  state.closed = true;
  const owned = await readFile(state.pidFile, 'utf8').then(JSON.parse).catch(() => []);
  for (const record of owned) if (await identity(record)) process.kill(record.pid, 'SIGKILL');
  state.server.closeAllConnections();
  await new Promise(resolve => state.server.close(resolve));
}

export async function verifyWorkflowChecks(context) {
  const { fixture, sandbox, request, check, restartServers } = context;
  if (!fixture.workflows) throw new Error('prepareWorkflowChecks must run before server launch');
  if (!restartServers) throw new Error('Workflow verification requires restartServers for cold restore and first-five-second scheduling');
  let bases = [fixture.url, context.rustUrl];
  const { defs, histories, calls, pidFile } = fixture.workflows;
  let frames = [[], []], controllers = [], streams = [];
  async function openEvents() {
    frames = [[], []]; controllers = []; streams = [];
    for (const [side, base] of bases.entries()) {
      const controller = new AbortController(); controllers.push(controller);
      const response = await fetch(base + '/api/events', { signal: controller.signal });
      streams.push((async () => {
        const decoder = new TextDecoder(); let pending = '';
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true });
          for (let end; (end = pending.indexOf('\n\n')) >= 0;) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            const event = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
            if (data && (event?.startsWith('workflow:') || event?.startsWith('schedule:'))) frames[side].push({ event, data: JSON.parse(data), receivedAt: Date.now() });
          }
        }
      })().catch(error => { if (!controller.signal.aborted) throw error; }));
    }
  }
  async function closeEvents() { controllers.forEach(c => c.abort()); await Promise.allSettled(streams); }
  const detail = async (side, id) => (await request(bases[side], `/api/workflows/runs/${id}`)).data;
  const done = (side, id) => until(() => detail(side, id), run => ['done', 'error', 'stopped'].includes(run.status), 'Private workflow completion');
  const started = async (side, workflowId, inputs = {}) => {
    const response = await request(bases[side], '/api/workflows/run', { method: 'POST', body: { workflowId, inputs } });
    check(response.status, 202, 'Native/original workflow is accepted');
    check(/^[a-f0-9]{16}$/.test(response.data.runId), true, 'Run IDs retain sixteen-hex format');
    return response.data.runId;
  };
  const compareRun = async (workflowId, inputs = {}, expected = 'done') => {
    const ids = await Promise.all(bases.map((_, side) => started(side, workflowId, inputs)));
    const runs = await Promise.all(ids.map((id, side) => done(side, id)));
    check(runs.map(run => run.status), [expected, expected], `Workflow ${workflowId} terminal statuses`);
    check(normalize(runs[1]), normalize(runs[0]), `Workflow ${workflowId} detailed original contract`);
    await until(() => frames.map((items, side) => items.filter(item => item.data.runId === ids[side])), groups => groups.every(items => items.some(item => item.event === (expected === 'done' ? 'workflow:complete' : 'workflow:error'))), 'Workflow terminal SSE');
    const events = frames.map((items, side) => items.filter(item => item.data.runId === ids[side]).map(item => ({ event: item.event, data: normalize(item.data) })));
    // Parallel task completions may interleave; compare each node's ordered
    // lifecycle and the run-level routing events without imposing wall time.
    const group = items => {
      const out = {};
      for (const item of items) (out[item.data.stepId || '_run'] ||= []).push(item);
      return out;
    };
    check(group(events[1]), group(events[0]), `Workflow ${workflowId} SSE lifecycle and UTF-16 output`);
    return { ids, runs };
  };
  try {
    await openEvents();
    const lists = await Promise.all(bases.map(base => request(base, '/api/workflows')));
    check(lists.map(r => r.status), [200, 200], 'Definition listing succeeds');
    check(lists[1].data, lists[0].data, 'Definition summary ordering, models and missing fields match');
    check(lists[1].data.length, defs.length, 'Malformed private definition is skipped');
    for (const def of defs) {
      const result = await Promise.all(bases.map(base => request(base, `/api/workflows/${def.id}`)));
      check(result.map(r => r.status), [200, 200], 'Definition read succeeds'); check(result[1].data, def, 'Native definition preserves UTF-16 and all fields'); check(result[1].data, result[0].data, 'Definition exact Node contract');
    }
    for (const path of ['/api/workflows/missing', '/api/workflows/..%2foutside', '/api/workflows/runs/missing']) {
      const results = await Promise.all(bases.map(base => request(base, path)));
      check(results.map(r => r.status), [404, 404], 'Missing or traversal workflow ID is rejected');
    }
    const seeded = await Promise.all(bases.map(base => request(base, '/api/workflows/runs/workflow-seed')));
    check(seeded[1].data, seeded[0].data, 'Persisted private run loads on both servers');
    for (const body of [{}, { workflowId: '' }, { workflowId: null }]) {
      const result = await Promise.all(bases.map(base => request(base, '/api/workflows/run', { method: 'POST', body })));
      check(result.map(r => r.status), [400, 400], 'Missing workflow ID cannot start work');
    }
    const unknown = await Promise.all(bases.map(base => request(base, '/api/workflows/run', { method: 'POST', body: { workflowId: 'missing' } })));
    check(unknown.map(r => r.status), [500, 500], 'Unknown definition rejects start'); check(unknown[1].data, unknown[0].data, 'Unknown definition error contract');
    check((await compareRun('wf-shell', { who: 'fixture' })).runs[1].steps[0].output, 'hello-fixture', 'Shell echo runs only in private fixture cwd');
    const parallel = await compareRun('wf-parallel', { left: 'seed', original: 'seed', text: 'ok', expected: 'true/true' });
    check(parallel.runs[1].steps.map(step => [step.output, step.iterations]), [['true', 1], ['true', 1], ['true', 1]], 'Parallel nodes read same snapshot and join runs once');
    check((await compareRun('wf-cycle', { text: 'ok' })).runs[1].steps[0].iterations, 3, 'Cycle counter forces pass after maxIterations');
    await compareRun('wf-legacy', { text: 'ok' });
    check((await compareRun('wf-regex', { text: 'abab' })).runs[1].steps[0].output, 'true', 'JS lookahead and backreference work natively');
    check((await compareRun('wf-regex-surrogate', { text: '\udc00' })).runs[1].steps[0].output, 'false', 'Different lone surrogate code units must not collapse into one replacement character');
    check((await compareRun('wf-regex-number', { count: 42 })).runs[1].steps[0].output, 'true', 'RegExp.test retains JavaScript numeric input coercion');
    const output = 'x'.repeat(1999) + '😀end';
    await writeFile(fixture.gitAi.mode, JSON.stringify({ stdout: output }));
    const beforeCalls = (await readFile(fixture.gitAi.log, 'utf8')).trim().split('\n').filter(Boolean).length;
    const llm = await compareRun('wf-llm', { topic: 'private fixture' });
    check(llm.runs[1].steps[0].output, output, 'Full model output remains intact in durable run');
    const modelCalls = (await readFile(fixture.gitAi.log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).slice(beforeCalls);
    check(modelCalls.length, 2, 'Only two private model wrapper calls occur'); check(modelCalls[1], modelCalls[0], 'Model prompt and CLI flags match source exactly');
    check(modelCalls[0].prompt, '[System Instructions]\nPrivate role\n\n[Task]\nDescribe private fixture', 'Role and interpolation envelope is preserved');
    check(modelCalls[0].args, ['-p', '--model', 'sonnet'], 'Workflow auto model maps to Sonnet');
    await compareRun('wf-http', { text: 'private' }); await compareRun('wf-http-status');
    await compareRun('wf-blocked-http', {}, 'error'); await compareRun('wf-failed', {}, 'error');
    const redirectId = await started(1, 'wf-redirect-private');
    check((await done(1, redirectId)).status, 'error', 'Native redirect to private address fails closed');
    check(calls.some(call => call.path === '/forbidden'), false, 'Blocked redirect never reaches private destination');
    const newlineId = await started(1, 'wf-newline');
    check((await done(1, newlineId)).error.startsWith('Blocked shell command'), true, 'Intentional correction: newline chaining is rejected');

    const stoppedIds = await Promise.all(bases.map((_, side) => started(side, 'wf-stop', { side: String(side) })));
    await until(() => calls.filter(call => call.path === '/slow'), rows => rows.length === 2, 'Both private slow requests started');
    const stopped = await Promise.all(bases.map((base, side) => request(base, `/api/workflows/runs/${stoppedIds[side]}/stop`, { method: 'POST', body: {} })));
    check(stopped.map(r => r.data), [{ stopped: true }, { stopped: true }], 'Stopping an active run succeeds');
    await pause(900);
    const stoppedRuns = await Promise.all(stoppedIds.map((id, side) => detail(side, id)));
    check(stoppedRuns.map(run => run.status), ['stopped', 'stopped'], 'Stopped runs never become done');
    check(stoppedRuns.map(run => run.steps[1].status), ['pending', 'pending'], 'Stop prevents subsequent node execution');
    check(stoppedRuns[1].steps[0].status, 'error', 'Native cancellation interrupts current HTTP node instead of merely setting status');
    for (const [side, id] of stoppedIds.entries()) check((await request(bases[side], `/api/workflows/runs/${id}/stop`, { method: 'POST', body: {} })).data, { stopped: false }, 'Repeated stop is idempotent');

    const ownedId = await started(1, 'wf-owned-stop');
    const owned = await until(() => readFile(pidFile, 'utf8').then(JSON.parse).catch(() => []), rows => rows.length === 2, 'Owned shell and descendant identities');
    check((await request(bases[1], `/api/workflows/runs/${ownedId}/stop`, { method: 'POST', body: {} })).data, { stopped: true }, 'Native process group stop succeeds');
    check(await Promise.all(owned.map(identity)), [false, false], 'Successful native stop returns only after its owned processes terminate');
    await until(async () => Promise.all(owned.map(identity)), values => values.every(v => !v), 'Owned shell descendant cleanup', 4000);
    const ownedRun = await until(() => detail(1, ownedId), run => run.steps[0].endedAt !== null && run.steps[0].status === 'error', 'Owned shell cleanup is recorded durably');
    check(ownedRun.status, 'stopped', 'Owned shell cancellation retains stopped state');
    check((await stat(histories[1])).mode & 0o777, 0o600, 'Native workflow history permissions are private');

    const preserved = await readFile(histories[1]);
    try {
      await writeFile(histories[1], '{broken');
      check((await request(bases[1], '/api/workflows/run', { method: 'POST', body: { workflowId: 'wf-shell' } })).status, 500, 'Corrupt run history rejects new execution');
      check(await readFile(histories[1], 'utf8'), '{broken', 'Corrupt run bytes are preserved');
      await unlink(histories[1]);
      const outside = join(fixture.directory, 'outside-workflow-runs.json'); await writeFile(outside, preserved); await symlink(outside, histories[1]);
      check((await request(bases[1], '/api/workflows/run', { method: 'POST', body: { workflowId: 'wf-shell' } })).status, 500, 'Symlink run history rejects execution');
      check(await readFile(outside), preserved, 'Outside workflow history remains unchanged');
      await unlink(histories[1]); await unlink(outside);
    } finally { await writeFile(histories[1], preserved, { mode: 0o600 }); }

    await until(() => readFile(histories[0], 'utf8').then(JSON.parse), rows => rows.some(row => row.runId === stoppedIds[0] && row.status === 'stopped'), 'Original asynchronous history flush');
    const savedDetails = await Promise.all(bases.map((_, side) => detail(side, llm.ids[side])));
    await closeEvents();
    const schedule = { id: 'first-five-seconds', workflowId: 'wf-shell', workflowName: 'Private scheduled echo', inputs: { who: 'scheduled' }, enabled: true, preset: 'daily', hour: 49, day: 1, nextRunAt: Date.now() - 1000, lastRunAt: null, createdAt: 1 };
    for (const file of [join(fixture.directory, 'app/workflow-schedules.json'), join(sandbox, 'workflow-schedules.json')]) await writeFile(file, JSON.stringify([schedule]));
    const restartAt = Date.now();
    const restarted = await restartServers();
    if (restarted?.rustUrl) context.rustUrl = restarted.rustUrl;
    bases = [fixture.url, context.rustUrl];
    await openEvents();
    for (const [side, id] of llm.ids.entries()) check(await detail(side, id), savedDetails[side], 'Completed workflow history survives a cold restart exactly');
    const fired = await until(() => frames.map(items => items.find(item => item.event === 'schedule:fired' && item.data.scheduleId === schedule.id)), items => items.every(Boolean), 'First-five-second scheduled execution', 15000);
    check(fired.every(item => item.receivedAt - restartAt < 20000), true, 'Missed schedule fires on first startup check before the sixty-second interval');
    check(fired.every(item => item.receivedAt - restartAt >= 4000), true, 'Schedule waits for the startup grace period');
    for (const [side, event] of fired.entries()) {
      const run = await done(side, event.data.runId);
      check(run.status, 'done', 'Scheduled private workflow completes');
      check(run.steps[0].output, 'hello-scheduled', 'Scheduled inputs reach native and original shell nodes');
      const scheduled = (await request(bases[side], '/api/workflows/schedules')).data.find(row => row.id === schedule.id);
      check(scheduled.lastRunAt >= restartAt && scheduled.nextRunAt > Date.now(), true, 'Schedule persists last/next before it can fire again');
      await request(bases[side], `/api/workflows/schedules/${schedule.id}`, { method: 'PUT', body: { enabled: false } });
    }
    await pause(200);
    check(frames.map(items => items.filter(item => item.event === 'schedule:fired' && item.data.scheduleId === schedule.id).length), [1, 1], 'Missed schedule fires exactly once');
    const runLists = await Promise.all(bases.map(base => request(base, '/api/workflows/runs')));
    check(runLists.every(result => result.status === 200 && result.data.length <= 50), true, 'Run lists remain bounded after restore and scheduling');
  } finally {
    await closeEvents();
    await writeFile(fixture.gitAi.mode, '{}');
    for (const base of bases) {
      const schedules = await request(base, '/api/workflows/schedules').catch(() => null);
      if (Array.isArray(schedules?.data)) for (const row of schedules.data) if (row.id === 'first-five-seconds') await request(base, `/api/workflows/schedules/${row.id}`, { method: 'DELETE' });
    }
  }
}
