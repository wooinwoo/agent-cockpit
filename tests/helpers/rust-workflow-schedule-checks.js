import { mkdir, readFile, writeFile, stat, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';

const endpoint = '/api/workflows/schedules';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Seed only disabled legacy rows. Restart the Node fixture after this function;
// Rust reads the private file on demand, so its already started process is safe.
export async function prepareWorkflowScheduleChecks({ fixture, sandbox }) {
  const rows = [{ id: 'legacy-disabled', workflowId: 'private-schedule-no-workflow', workflowName: '한글 😀\ud800',
    preset: 'weekly', hour: 9, day: 1, enabled: false, inputs: { extra: '\udc00' },
    lastRunAt: null, nextRunAt: 1, createdAt: 123, unknown: { retained: true } }];
  const files = [join(fixture.directory, 'app/workflow-schedules.json'), join(sandbox, 'workflow-schedules.json')];
  await mkdir(sandbox, { recursive: true });
  await Promise.all(files.map(file => writeFile(file, JSON.stringify(rows), { mode: 0o600 })));
  fixture.workflowSchedules = { files, rows };
}

export async function verifyWorkflowScheduleChecks({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl];
  const { files, rows } = fixture.workflowSchedules;
  const frames = [[], []], controllers = [], streams = [];
  const ids = [new Map(), new Map()];
  const normalize = (value, side) => {
    if (Array.isArray(value)) return value.map(item => normalize(item, side));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'createdAt').map(([key, item]) => [key, key === 'id' ? (ids[side].get(item) || item) : normalize(item, side)]));
    return value;
  };
  const pair = async (path, options, status = 200) => {
    const result = await Promise.all(bases.map(base => request(base, path, options)));
    check(result.map(r => r.status), [status, status], `Schedule status ${path}`);
    check(normalize(result[1].data, 1), normalize(result[0].data, 0), `Schedule original contract ${path}`);
    return result;
  };
  try {
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
            if (event === 'schedule:update' && data) frames[side].push(JSON.parse(data));
          }
        }
      })().catch(error => { if (!controller.signal.aborted) throw error; }));
    }
    check((await pair(endpoint))[1].data, rows, 'Disabled legacy rows preserve unknown fields and UTF-16 exactly');
    for (const workflowId of [undefined, '', null, false, 0]) await pair(endpoint, { method: 'POST', body: { workflowId } }, 400);
    await pair(endpoint + '/missing', { method: 'PUT', body: {} }, 404);
    await pair(endpoint + '/missing', { method: 'DELETE' }, 404);
    await pair(endpoint + '/legacy-disabled', { method: 'PUT', body: { inputs: { text: 'changed 😀\ud800' }, workflowId: 'ignored', workflowName: 'ignored', arbitrary: 'ignored' } });
    const legacy = (await pair(endpoint))[1].data[0];
    check(legacy.workflowId, rows[0].workflowId, 'Updates cannot change workflow identity');
    check(legacy.unknown, rows[0].unknown, 'Updates preserve unknown stored fields');
    check(legacy.nextRunAt, null, 'Updating disabled row clears next run');
    const cases = [
      {}, { preset: 'daily', hour: 49 }, { preset: 'weekly', hour: 49, day: 8 },
      { preset: 'monthly', hour: 49, day: 31 }, { preset: 'monthly', hour: 49, day: 0 },
      { preset: 'fallback', hour: 49 }, { preset: 'daily', hour: '49', day: null },
      { preset: 'monthly', hour: 49.75, day: 28.75 }, { preset: 'daily', hour: 'invalid' },
    ];
    for (const [index, extra] of cases.entries()) {
      const body = { workflowId: 'private-schedule-no-workflow', workflowName: '일정 😀\ud800', inputs: { secret: 'fixture-only', value: '\udc00' }, enabled: false, unknown: 'ignored', ...extra };
      const started = Date.now();
      const result = await Promise.all(bases.map(base => request(base, endpoint, { method: 'POST', body })));
      for (const [side, response] of result.entries()) {
        check(response.status, 201, 'Schedule creation succeeds');
        check(/^[a-f0-9]{12}$/.test(response.data.id), true, 'Schedule ID retains random twelve-hex shape');
        check(response.data.createdAt >= started && response.data.createdAt <= Date.now(), true, 'Creation timestamp is current without equality assumptions');
        ids[side].set(response.data.id, `created-${index}`);
        check(response.data.enabled, true, 'Original creation ignores supplied enabled:false');
        check(Object.hasOwn(response.data, 'unknown'), false, 'Creation ignores unspecified fields');
        check(response.data.nextRunAt === null || response.data.nextRunAt > Date.now(), true, 'Private fixture cannot dispatch a workflow while being disabled');
      }
      check(normalize(result[1].data, 1), normalize(result[0].data, 0), 'Computed local next-run time matches original Node');
      // Disable immediately; no real workflow definition or operation is involved.
      const disabled = await Promise.all(bases.map((base, side) => request(base, `${endpoint}/${result[side].data.id}`, { method: 'PUT', body: { enabled: false } })));
      check(disabled.map(r => r.status), [200, 200], 'Disable private schedules');
      check(normalize(disabled[1].data, 1), normalize(disabled[0].data, 0), 'Disabled schedules match original');
    }
    const list = await pair(endpoint);
    for (const [side, file] of files.entries()) check(normalize(JSON.parse(await readFile(file, 'utf8')), side), normalize(list[side].data, side), 'Success response corresponds to persisted schedule bytes');
    check((await stat(files[1])).mode & 0o777, 0o600, 'Native schedule file is private');
    await pair(endpoint + '/legacy-disabled', { method: 'DELETE' });
    await pair(endpoint + '/legacy-disabled', { method: 'DELETE' }, 404);
    for (let attempt = 0; attempt < 50 && frames.some(items => items.length < 2 + cases.length * 2); attempt++) await pause(10);
    check(normalize(frames[1], 1), normalize(frames[0], 0), 'Added, updated and removed SSE events retain original ordering and payloads');
    check(frames[1].length, 2 + cases.length * 2, 'Every successful CRUD mutation emits exactly one update');

    const original = await readFile(files[1]);
    const before = frames[1].length;
    try {
      for (const broken of ['{broken', '{}', '[null]']) {
        await writeFile(files[1], broken);
        check((await request(rustUrl, endpoint, { method: 'POST', body: { workflowId: 'cannot-save' } })).status, 500, 'Malformed schedule storage rejects mutations');
        check(await readFile(files[1], 'utf8'), broken, 'Broken schedule file is preserved');
      }
      await unlink(files[1]);
      const outside = join(fixture.directory, 'outside-workflow-schedules.json');
      await writeFile(outside, original);
      await symlink(outside, files[1]);
      check((await request(rustUrl, endpoint, { method: 'POST', body: { workflowId: 'cannot-save' } })).status, 500, 'Symlink schedule storage rejects writes');
      check(await readFile(outside), original, 'Rejected mutation preserves external file');
      await unlink(files[1]); await unlink(outside);
    } finally { await writeFile(files[1], original, { mode: 0o600 }); }
    await pause(30);
    check(frames[1].length, before, 'Failed persistence cannot publish a successful update');
    await pair(endpoint);
  } finally {
    for (const base of bases) {
      const result = await request(base, endpoint);
      if (Array.isArray(result.data)) for (const row of result.data) await request(base, `${endpoint}/${row.id}`, { method: 'DELETE' });
    }
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(streams);
  }
}
