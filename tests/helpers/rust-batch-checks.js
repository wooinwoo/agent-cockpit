import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, label) {
  const deadline = Date.now() + 12_000;
  let value;
  do { value = await read(); if (accept(value)) return value; await delay(25); } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
function fakeNpm(files) {
  const fs = require('node:fs');
  const config = JSON.parse(fs.readFileSync(files.config, 'utf8'));
  if (!config.paths.includes(process.cwd())) { process.stderr.write('Not a private batch project'); process.exit(70); }
  const item = { pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) };
  fs.appendFileSync(files.log, JSON.stringify({ ...item, event: 'start' }) + '\n');
  setTimeout(() => {
    fs.appendFileSync(files.log, JSON.stringify({ ...item, event: 'end' }) + '\n');
    if (config.failure) { process.stderr.write(config.output); process.exitCode = 7; }
    else process.stdout.write(config.output);
  }, config.delay || 0);
}

// Call before launching Rust and restarting the private Node fixture so both
// inherit the same fake npm. It never invokes an installed npm or the network.
export async function prepareBatchChecks(fixture) {
  const directory = join(fixture.directory, 'batch-cli');
  await mkdir(directory, { recursive: true });
  const files = { config: join(directory, 'config.json'), log: join(directory, 'calls.jsonl') };
  await writeFile(files.config, JSON.stringify({ paths: [], output: 'fixture', delay: 0 }));
  await writeFile(files.log, '');
  await writeFile(join(directory, 'npm'), `#!${process.execPath}\n(${fakeNpm.toString()})(${JSON.stringify(files)});\n`, { mode: 0o755 });
  fixture.env.PATH = `${directory}:${fixture.env.PATH}`;
  fixture.batch = { directory, files };
}

export async function verifyBatchChecks({ fixture, rustUrl, request, check }) {
  if (!fixture.batch) throw new Error('prepareBatchChecks must run before both server launches');
  const bases = [fixture.url, rustUrl];
  const ids = Array.from({ length: 7 }, (_, i) => `batch-contract-${i}`);
  const paths = ids.map(id => join(fixture.directory, id));
  const { files } = fixture.batch;
  const registered = [];
  const controllers = [];
  const streams = [];
  const frames = [[], []];
  const configuration = async (extra = {}) => {
    await writeFile(files.log, '');
    await writeFile(files.config, JSON.stringify({ paths, output: 'private batch stdout\n', delay: 20, ...extra }));
  };
  const log = async () => (await readFile(files.log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const pair = async (path, method = 'GET', body, status = 200) => {
    const responses = await Promise.all(bases.map(base => request(base, path, { method, body })));
    check(responses.map(r => r.status), [status, status], `${path} status`);
    check(responses[1].data, responses[0].data, `${path} Node contract`);
    return responses[1].data;
  };
  const execute = (base, body) => request(base, '/api/batch/execute', { method: 'POST', body });
  const status = async base => (await request(base, '/api/batch/status')).data;
  const checkResult = (response, native, total, completed = total) => {
    check(response.status, 200, 'Batch execution HTTP response');
    check(response.data.total, total, 'Batch total preserves original target count');
    check(response.data.results.length, completed, 'Batch completed target count');
    check(response.data.success, native ? completed : 0, 'Intentional fix: native reads stdout instead of slicing the Node output object');
    check(response.data.error, native ? 0 : completed, 'Original successful Node commands report output.slice TypeError');
    if (!native) check(response.data.results.every(r => /slice is not a function/.test(r.output)), true, 'Document original output object bug explicitly');
  };
  try {
    for (const [i, path] of paths.entries()) {
      await mkdir(path, { recursive: true });
      for (const base of bases) {
        const response = await request(base, '/api/projects', { method: 'POST', body: { id: ids[i], name: `Batch ${i}`, path } });
        check(response.status, 201, 'Register private batch project'); registered.push([base, ids[i]]);
      }
    }
    for (const [index, base] of bases.entries()) {
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
      await until(() => frames[index], rows => rows.some(f => f.event === 'init'), 'Batch SSE init');
    }
    const whitelist = await pair('/api/batch/whitelist');
    check(whitelist.length, 12, 'Full command whitelist');
    check(whitelist.every(item => !Object.hasOwn(item, 'cmd')), true, 'Whitelist hides executable command field');
    check(await pair('/api/batch/status'), null, 'Initially idle batch');
    check(await pair('/api/batch/stop', 'POST'), { stopped: false }, 'Stop without a batch');
    for (const body of [{}, { commandId: 'npm-test', projectIds: 'invalid' }, { commandId: 'npm-test', projectIds: ['missing'] },
      { commandId: 'npm publish; touch injected', projectIds: [ids[0]] }]) await pair('/api/batch/execute', 'POST', body, 400);
    await configuration();
    for (const [index, base] of bases.entries()) {
      await configuration();
      const result = await execute(base, { commandId: 'npm-test', projectIds: [ids[0], 'missing', ids[1]], parallel: false });
      checkResult(result, index === 1, 2);
      check(result.data.results.map(r => r.projectId), ids.slice(0, 2), 'Sequential target order and invalid-ID filtering');
      check((await log()).filter(r => r.event === 'start').map(r => r.args), [['test'], ['test']], 'Whitelist becomes fixed argv');
      if (index === 1) check(result.data.results[0].output, 'private batch stdout\n', 'Native genuine successful stdout');
      await until(() => frames[index], rows => rows.some(f => f.event === 'batch:done' && f.data.batchId === result.data.batchId), 'Batch final SSE');
      const events = frames[index].filter(f => f.data.batchId === result.data.batchId);
      check(events.map(f => f.event), ['batch:start', 'batch:progress', 'batch:progress', 'batch:progress', 'batch:progress', 'batch:done'], 'Sequential SSE lifecycle');
      check(events.filter(f => f.event === 'batch:progress').map(f => f.data.index), [0, 0, 1, 1], 'Running/result SSE indexes');
      check(await status(base), null, 'Job clears after completion');
    }
    const failures = [];
    for (const base of bases) {
      await configuration({ failure: true, output: 'private failure\n' });
      failures.push((await execute(base, { commandId: 'npm-build', projectIds: [ids[0]] })).data);
    }
    const comparable = result => ({ ...result, batchId: '<id>', results: result.results.map(row => ({ ...row, duration: '<ms>' })) });
    check(comparable(failures[1]), comparable(failures[0]), 'Nonzero command preserves original error message');
    await configuration({ output: `${'x'.repeat(4999)}😀 tail` });
    const long = await execute(rustUrl, { commandId: 'npm-test', projectIds: [ids[0]] });
    check(long.data.results[0].output.length, 5000, 'Success output UTF-16 limit');
    check(long.data.results[0].output.charCodeAt(4999), 0xd83d, 'Success truncation preserves lone surrogate');
    const errorPrefix = 'Command failed: sh -c npm run build\n';
    await configuration({ failure: true, output: `${'e'.repeat(1999 - errorPrefix.length)}😀 tail` });
    const longError = await execute(rustUrl, { commandId: 'npm-build', projectIds: [ids[0]] });
    check(longError.data.results[0].output.length, 2000, 'Failure output UTF-16 limit');
    check(longError.data.results[0].output.charCodeAt(1999), 0xd83d, 'Failure truncation preserves lone surrogate');
    for (const [index, base] of bases.entries()) {
      await configuration({ delay: 250 });
      const result = await execute(base, { commandId: 'npm-test', projectIds: ids, parallel: true, maxConcurrent: 99 });
      checkResult(result, index === 1, ids.length);
      let active = 0; let maximum = 0;
      for (const event of await log()) { active += event.event === 'start' ? 1 : -1; maximum = Math.max(maximum, active); }
      check(maximum, 5, 'Parallel batch cap is five'); check(active, 0, 'All fake command processes finish');
      await configuration({ delay: 600 });
      const pending = execute(base, { commandId: 'npm-test', projectIds: ids.slice(0, 3) });
      await until(log, rows => rows.some(r => r.event === 'start'), 'Current command really started');
      const current = await status(base);
      check(current.total, 3, 'Active status total'); check(current.completed, 0, 'Active status completed count');
      const duplicate = await execute(base, { commandId: 'npm-test', projectIds: [ids[0]] });
      check(duplicate.status, 400, 'One batch at a time'); check(duplicate.data, { error: 'Another batch is already running' }, 'Duplicate response');
      check((await request(base, '/api/batch/stop', { method: 'POST' })).data, { stopped: true }, 'Stop signals running batch');
      check((await status(base))?.batchId, current.batchId, 'Stop retains active job until current command finishes');
      const stopped = await pending;
      checkResult(stopped, index === 1, 3, 1);
      check((await log()).filter(r => r.event === 'start').length, 1, 'Stop prevents subsequent commands');
      await until(() => frames[index], rows => rows.some(f => f.event === 'batch:done' && f.data.batchId === current.batchId && f.data.stopped === true), 'Immediate stopped SSE');
      check(await status(base), null, 'Stopped job clears after current work finishes');
    }
    await configuration({ delay: 250 });
    const body = JSON.stringify({ commandId: 'npm-test', projectIds: ids.slice(0, 3) });
    const connection = httpRequest(`${rustUrl}/api/batch/execute`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    connection.on('error', () => {}); connection.end(body);
    try {
      await until(log, rows => rows.some(r => r.event === 'start'), 'Disconnected HTTP batch started');
      const current = await status(rustUrl); connection.destroy();
      await until(() => status(rustUrl), value => value === null, 'Disconnected HTTP batch clears normally');
      check((await log()).filter(r => r.event === 'end').length, 3, 'HTTP disconnect does not cancel accepted commands');
      const done = await until(() => frames[1].find(f => f.event === 'batch:done' && f.data.batchId === current.batchId && !f.data.stopped), Boolean, 'Disconnected batch final SSE');
      check(done.data.success, 3, 'Disconnected batch retains real results');
    } finally { connection.destroy(); }
  } finally {
    for (const base of bases) {
      await request(base, '/api/batch/stop', { method: 'POST' }).catch(() => {});
      await until(() => status(base), value => value === null, 'Private batch cleanup').catch(() => {});
    }
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(streams);
    for (const [base, id] of registered) await request(base, `/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}
