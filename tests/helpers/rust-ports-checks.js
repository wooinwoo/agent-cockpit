import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

function fakePorts(files) {
  const fs = require('node:fs');
  const name = require('node:path').basename(process.argv[1]);
  const args = process.argv.slice(2);
  if (name === 'ps' && !(args.length === 4 && args[0] === '-p' && args[2] === '-o' && args[3] === 'comm=' && files.pids.includes(args[1]))) {
    const result = require('node:child_process').spawnSync('/usr/bin/ps', args, { encoding: 'utf8' });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exitCode = result.status ?? 1;
    return;
  }
  fs.appendFileSync(files.log, JSON.stringify({ name, args }) + '\n');
  const mode = fs.readFileSync(files.mode, 'utf8');
  if (name === 'lsof') {
    if (JSON.stringify(args) !== JSON.stringify(['-iTCP', '-sTCP:LISTEN', '-nP', '-F', 'pcn'])) throw new Error('Unexpected lsof invocation');
    if (['fallback', 'unavailable'].includes(mode)) { process.exitCode = 1; return; }
    if (mode === 'empty') return;
    process.stdout.write('p1900000001\ncwrong-name\nn[::1]:5173\nn*:5173\np1900000002\ncalso-wrong\nn127.0.0.1:80\np1900000003\nn*:5173\nnmalformed\n');
  } else if (name === 'ss') {
    if (JSON.stringify(args) !== JSON.stringify(['-tlnp'])) throw new Error('Unexpected ss invocation');
    if (mode === 'unavailable') { process.exitCode = 1; return; }
    process.stdout.write('State Recv-Q Send-Q Local Peer Process\nLISTEN 0 128 [::]:8080 *:* users:(("wrong",pid=1900000001,fd=1))\nLISTEN 0 128 *:8080 *:* users:(("wrong",pid=1900000001,fd=2))\nLISTEN 0 128 0.0.0.0:9000 *:*\nLISTEN 0 128 127.0.0.1:8080 *:* users:(("other",pid=1900000002,fd=1))\n');
  } else if (name === 'ps') {
    if (mode === 'names-fail' || !['1900000001', '1900000002'].includes(args[1])) { process.exitCode = 1; return; }
    process.stdout.write(args[1] === '1900000001' ? '  fixture-node\n' : 'fixture-python\n');
  }
}

export async function preparePortsChecks(fixture) {
  const directory = join(fixture.directory, 'ports-cli');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = { directory, mode: join(directory, 'mode'), log: join(directory, 'events.jsonl'), pids: ['1900000001', '1900000002', '1900000003', '0'] };
  await writeFile(files.mode, 'lsof'); await writeFile(files.log, '');
  const source = `#!${process.execPath}\n(${fakePorts.toString()})(${JSON.stringify(files)});\n`;
  for (const name of ['lsof', 'ss', 'ps']) await writeFile(join(directory, name), source, { mode: 0o700 });
  fixture.env.PATH = `${directory}:${fixture.env.PATH}`;
  fixture.ports = files;
}

async function startIdentity(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
}

export async function verifyPortsChecks({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl], files = fixture.ports;
  const mode = async value => { await writeFile(`${files.mode}.tmp`, value); await rename(`${files.mode}.tmp`, files.mode); };
  const entry = (port, pid, address, processName) => ({ port, pid, protocol: 'TCP', address, processName, projectId: null, projectName: null, isDevServer: false });
  try {
    for (const state of ['lsof', 'names-fail', 'fallback', 'empty', 'unavailable']) {
      await mode(state);
      const results = await Promise.all(bases.map(base => request(base, '/api/ports')));
      check(results.map(r => r.status), [200, 200], `Ports ${state} status`);
      check(results[1].data, results[0].data, `Ports ${state} exact Node response`);
      const expected = state === 'lsof' || state === 'names-fail' ? [
        entry(80, 1900000002, '127.0.0.1', state === 'names-fail' ? 'Unknown' : 'fixture-python'),
        entry(5173, 1900000001, '[::1]', state === 'names-fail' ? 'Unknown' : 'fixture-node'),
        entry(5173, 1900000003, '*', 'Unknown'),
      ] : state === 'fallback' ? [
        entry(8080, 1900000001, '[::]', 'fixture-node'),
        entry(8080, 1900000002, '127.0.0.1', 'fixture-python'),
        entry(9000, 0, '0.0.0.0', 'Unknown'),
      ] : [];
      check(results[1].data, expected, `Ports ${state} stable fixture rows`);
    }
    for (const body of [{}, { pid: 0 }, { pid: -1 }, { pid: 'bad' }, { pid: '0x10' }, { pid: 4 }, { pid: '4tail' }]) {
      const results = await Promise.all(bases.map(base => request(base, '/api/ports/kill', { method: 'POST', body })));
      check(results.map(r => r.status), [400, 400], 'Invalid/protected PID status');
      check(results[1].data, results[0].data, 'Invalid/protected PID exact Node error');
    }
    for (const pid of [1, 2147483648, 4294967295, '999999999999999999999']) {
      check((await request(rustUrl, '/api/ports/kill', { method: 'POST', body: { pid } })).status, 400, 'Rust rejects PID1 and integer/group wrapping');
    }
    // Linux PID_MAX_LIMIT is far below INT_MAX; this PID cannot name a process.
    const maximum = Number((await readFile('/proc/sys/kernel/pid_max', 'utf8')).trim());
    check(maximum < 2147483647, true, 'Missing PID is outside the Linux allocation range');
    const missing = await Promise.all(bases.map(base => request(base, '/api/ports/kill', { method: 'POST', body: { pid: 2147483647 } })));
    check(missing.map(r => r.status), [400, 400], 'Missing PID status');
    check(missing[1].data, missing[0].data, 'Missing PID error matches Node');
    const tokens = await Promise.all([readFile(join(fixture.directory, 'data/cockpit/.cockpit-token'), 'utf8'), readFile(join(sandbox, '.cockpit-token'), 'utf8')]);
    for (const [index, base] of bases.entries()) {
      const result = await request(base, '/api/ports/kill', { method: 'POST', body: { pid: 4 }, headers: { origin: base, 'x-forwarded-for': '100.64.1.2', cookie: `cockpit-token=${tokens[index]}` } });
      check(result.status, 403, 'Authenticated remote kill remains forbidden');
      check(result.data, { error: 'Forbidden' }, 'Remote kill denied before PID handling');
    }
    const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    await once(child, 'spawn');
    const identity = await startIdentity(child.pid);
    try {
      check(child.exitCode, null, 'Owned termination fixture is alive');
      check(await startIdentity(child.pid), identity, 'Owned PID start identity matches immediately before kill');
      check((await request(rustUrl, '/api/ports/kill', { method: 'POST', body: { pid: child.pid } })).data, { killed: true }, 'Native SIGTERM succeeds on owned fixture only');
      let timer;
      const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fixture did not exit')), 4000); })]).finally(() => clearTimeout(timer));
      check(result, [null, 'SIGTERM'], 'Owned fixture exited from the requested signal');
    } finally {
      if (child.exitCode === null && child.signalCode === null && await startIdentity(child.pid).catch(() => null) === identity) { child.kill('SIGKILL'); await exited; }
    }
    const events = (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    check(events.some(e => e.name === 'lsof') && events.some(e => e.name === 'ss') && events.some(e => e.name === 'ps'), true, 'All discovery commands ran only through private wrappers');
  } finally { await mode('empty'); }
}
