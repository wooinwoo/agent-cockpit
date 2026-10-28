import { mkdir, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const endpoint = '/api/agent/delegate-status';

// The API promises a five-second polling cadence, not a hard response deadline
// under load. Allow two polls while keeping this well below the 15-second TTL.
async function until(read, predicate, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

async function stream(base) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: abort.signal });
  const state = { response, events: [], ended: false, stop: () => abort.abort() };
  state.done = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event && data) state.events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally { state.ended = true; }
  })();
  return state;
}

export async function verifyDelegateChecks({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl];
  const parent = { id: 'delegate-check-parent', name: 'Delegate Parent', path: join(fixture.directory, 'delegate-parent') };
  const child = { id: 'delegate-check-child', name: 'Delegate Child', path: join(parent.path, 'delegate-child') };
  const cwd = join(child.path, 'nested');
  const created = [];
  const streams = [];
  const activeRuns = new Set();
  // Deliberately never resolve Node's shared /tmp delegate bridge directory.
  const bridge = join(sandbox, 'delegate-status');
  const bridgeFiles = [];
  const bridgeRun = 'delegate-private-bridge';
  const sessions = s => s.events.filter(event => event.event === 'session:status').map(event => event.data);
  const state = async (base, id) => {
    const response = await request(base, '/api/projects');
    check(response.status, 200, 'Delegate project cache is available');
    return response.data.find(project => project.id === id)?.session;
  };
  const post = async (body, status = 200) => {
    const responses = await Promise.all(bases.map(base => request(base, endpoint, { method: 'POST', body })));
    check(responses.map(response => response.status), [status, status], 'Delegate status matches original Node');
    // Native body parsing rejects non-objects before route validation; both
    // retain HTTP 400 but the common parser's error text is intentionally distinct.
    if (body !== null && !Array.isArray(body)) check(responses[1].data, responses[0].data, 'Delegate response matches original Node');
    return responses[0].data;
  };
  const publish = async (name, content) => {
    const path = join(bridge, name);
    bridgeFiles.push(path);
    const temporary = path + '.pending';
    bridgeFiles.push(temporary);
    await writeFile(temporary, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
    await rename(temporary, path);
    return path;
  };
  const consumed = path => until(() => stat(path).then(() => false, error => {
    if (error.code === 'ENOENT') return true;
    throw error;
  }), value => value, 'Native delegate bridge consumes private file');
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(bridge, { recursive: true, mode: 0o700 });
    for (const project of [parent, child]) {
      for (const base of bases) {
        const response = await request(base, '/api/projects', { method: 'POST', body: project });
        if (response.status === 201) created.push({ base, id: response.data.id });
        check(response.status, 201, 'Register private delegate project');
        check(response.data.id, project.id, 'Delegate project IDs match across runtimes');
      }
    }
    for (const base of bases) {
      const opened = await stream(base);
      streams.push(opened);
      check(opened.response.status, 200, 'Delegate SSE stream is available');
      await until(() => opened.events, events => events.some(event => event.event === 'init'), 'Delegate SSE init');
    }

    // Start the single real TTL clock before the remaining HTTP checks so the
    // five-second polling assertions fit inside the same expiry wait.
    const bridgeStarted = Date.now();
    const path = await publish('running.json', { runId: bridgeRun, state: 'running', cwd: parent.path, model: 'opus-bridge', updatedAt: Date.now() });
    await consumed(path);
    await until(() => sessions(streams[1]), values => values.some(value => value.delegateRunId === bridgeRun && value.projectId === parent.id && value.state === 'busy'), 'Private bridge publishes delegated busy state');
    const bridgeMark = sessions(streams[1]).length;

    const runId = 'delegate-http-check';
    activeRuns.add(runId);
    const running = await post({ runId, state: 'running', termId: 'unknown-terminal', cwd, model: 'sonnet-check' });
    check(running, { projectId: child.id, state: 'busy' }, 'Unknown terminal falls back to deepest matching cwd');
    for (const opened of streams) {
      await until(() => sessions(opened), values => values.some(value => value.projectId === child.id && value.delegateRunId === runId && value.model === 'sonnet-check' && value.delegated === true), 'Running delegate appears in SSE');
    }
    // HTTP updatedAt is validation-only; reception time owns heartbeat expiry.
    await post({ runId, state: 'heartbeat', cwd: join(child.path, 'nested', '..'), model: 'opus-check', updatedAt: 1 });
    for (const opened of streams) {
      await until(() => sessions(opened), values => values.some(value => value.delegateRunId === runId && value.model === 'opus-check'), 'Heartbeat updates delegated model');
    }
    await Promise.all(bases.map(base => until(() => state(base, child.id), value => value?.delegateRunId === runId && value?.model === 'opus-check', 'Five-second poll refreshes delegate cache')));
    await until(() => state(rustUrl, parent.id), value => value?.delegateRunId === bridgeRun, 'Bridge busy state enters the polling cache before expiry');

    const invalid = [
      {}, [], null,
      { runId: '' }, { runId: 'bad_id' }, { runId: 'x'.repeat(81) },
      { state: 'invalid' }, { state: 1 },
      { model: 'bad model' }, { model: 'x'.repeat(65) }, { model: {} },
      { termId: 'bad_terminal' }, { termId: 1 },
      { cwd: 1 }, { cwd: 'x'.repeat(2001) },
      { updatedAt: 0 }, { updatedAt: -1 }, { updatedAt: null }, { updatedAt: '1' },
    ];
    for (const input of invalid) {
      const body = input === null || Array.isArray(input) || Object.keys(input).length === 0
        ? input : { runId: 'invalid-check', state: 'running', cwd, ...input };
      await post(body, 400);
    }
    await post({ runId: 'missing-project', state: 'running', cwd: join(fixture.directory, 'unregistered-delegate') }, 404);
    await post({ runId: 'missing-project', state: 'running', termId: 'unknown-terminal' }, 404);
    await post({ runId: 'prefix-boundary', state: 'running', cwd: parent.path + '-unregistered' }, 404);
    for (let index = 0; index < bases.length; index++) {
      const tokenPath = index ? join(sandbox, '.cockpit-token') : join(fixture.directory, 'data/cockpit/.cockpit-token');
      const token = (await readFile(tokenPath, 'utf8')).trim();
      const response = await request(bases[index], endpoint, {
        method: 'POST', body: { runId: 'remote-check', state: 'running', cwd },
        headers: { 'x-forwarded-for': '192.0.2.55', cookie: `cockpit-token=${token}`, origin: bases[index] },
      });
      check(response.status, 403, 'Valid remote authentication cannot send delegate status');
      check(response.data, { error: 'Forbidden' }, 'Delegate is explicitly localhost-only');
    }
    const marks = streams.map(opened => sessions(opened).length);
    const done = await post({ runId, state: 'done', cwd });
    activeRuns.delete(runId);
    check(done.projectId, child.id, 'Done resolves the same deepest project');
    check(done.state === 'busy', false, 'Done removes delegated busy overlay');
    await Promise.all(streams.map((opened, index) => until(() => sessions(opened).slice(marks[index]), values => values.some(value => value.projectId === child.id && !value.delegated), 'Done publishes the underlying project state')));
    await Promise.all(bases.map(base => until(() => state(base, child.id), value => value && !value.delegated, 'Poll cache clears finished delegate')));

    const invalidPaths = await Promise.all([
      publish('stale.json', { runId: 'bridge-stale', state: 'running', cwd: parent.path, updatedAt: Date.now() - 60_000 }),
      publish('future.json', { runId: 'bridge-future', state: 'running', cwd: parent.path, updatedAt: Date.now() + 60_000 }),
      publish('malformed.json', '{broken'),
      publish('invalid.json', { runId: 'bad_id', state: 'running', cwd: parent.path, updatedAt: Date.now() }),
    ]);
    await Promise.all(invalidPaths.map(consumed));
    check(sessions(streams[1]).some(value => ['bridge-stale', 'bridge-future', 'bad_id'].includes(value.delegateRunId)), false, 'Stale, future, malformed and invalid bridge files never publish a delegate');
    const elapsed = Date.now() - bridgeStarted;
    await until(() => state(rustUrl, parent.id), value => value && !value.delegated, 'Private bridge expires after 15 seconds and the next poll', Math.max(1000, 24_000 - elapsed));
    check(Date.now() - bridgeStarted >= 15_000, true, 'Delegate TTL does not expire early');
    await until(() => sessions(streams[1]).slice(bridgeMark), values => values.some(value => value.projectId === parent.id && !value.delegated), 'Expiry publishes restored parent session state', 1000);
    check(sessions(streams[0]).some(value => value.delegateRunId === bridgeRun), false, 'Private Rust bridge never reaches Node or shared watcher state');
  } catch (error) {
    error.message += `; SSE diagnostics: ${JSON.stringify(streams.map(opened => ({ ended: opened.ended, sessions: sessions(opened) })))}`;
    throw error;
  } finally {
    await request(rustUrl, endpoint, { method: 'POST', body: { runId: bridgeRun, state: 'done', cwd: parent.path } }).catch(() => {});
    for (const runId of activeRuns) {
      await Promise.all(bases.map(base => request(base, endpoint, { method: 'POST', body: { runId, state: 'done', cwd } }))).catch(() => {});
    }
    for (const opened of streams) opened.stop();
    await Promise.all(streams.map(opened => opened.done));
    for (const path of bridgeFiles) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const { base, id } of created.reverse()) {
      check((await request(base, `/api/projects/${id}`, { method: 'DELETE' })).status, 200, 'Remove delegate fixture project');
    }
  }
}
