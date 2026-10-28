import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';

const binary = resolve(process.argv[2] || '/home/rst010/projects/personal/claude-code-cockpit/docs/_local/jcode-native-accounts/jcode');
const temporary = await mkdtemp('/tmp/cockpit-native-engine-');
const children = [];
const pause = milliseconds => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));
async function run(arguments_, env) {
  const child = spawn(binary, ['--no-update', '--no-selfdev', ...arguments_], { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-16384); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16384); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try { const [code] = await once(child, 'exit'); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); }
}
async function ping(socket) {
  const connection = connect(socket);
  try {
    await once(connection, 'connect');
    const response = new Promise((resolveResponse, reject) => {
      let buffer = '';
      connection.setTimeout(1000, () => reject(new Error('Owned daemon ping timed out')));
      connection.on('error', reject);
      connection.on('data', bytes => {
        buffer += bytes;
        for (const line of buffer.split('\n').slice(0, -1)) {
          const value = JSON.parse(line);
          if (value.type === 'pong' && value.id === 1) resolveResponse(value);
        }
      });
    });
    connection.write('{"type":"ping","id":1}\n');
    await response;
  } finally { connection.destroy(); }
}

try {
  const sockets = [];
  for (const provider of ['claude', 'openai']) {
    const root = join(temporary, provider), home = join(root, '.jcode'), runtime = join(root, 'runtime');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(runtime, { mode: 0o700 });
    const socket = join(runtime, 'jcode.sock');
    sockets.push(socket);
    const env = { HOME: root, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      JCODE_HOME: home, JCODE_RUNTIME_DIR: runtime, JCODE_SOCKET: socket, JCODE_ACCOUNT_ONLY: '1',
      JCODE_EXPECTED_EMAIL: 'one@example.invalid', JCODE_NO_TELEMETRY: '1', JCODE_DEFERRED_AUTH_BOOTSTRAP: '1' };
    const claude = provider === 'claude', label = `${provider}-otter`;
    const credential = claude
      ? { anthropic_accounts: [{ label, email: env.JCODE_EXPECTED_EMAIL, access: 'fixture-native-access', refresh: 'fixture-native-refresh', expires: Date.now() + 3600000 }], active_anthropic_account: label }
      : { openai_accounts: [{ label, email: env.JCODE_EXPECTED_EMAIL, access_token: 'fixture-native-access', refresh_token: 'fixture-native-refresh', expires_at: Date.now() + 3600000, account_id: 'workspace-one' }], active_openai_account: label };
    if (!claude) env.JCODE_EXPECTED_WORKSPACE = 'workspace-one';
    const file = join(home, claude ? 'auth.json' : 'openai-auth.json');
    await writeFile(file, JSON.stringify(credential), { mode: 0o600 });
    const before = await readFile(file);
    const capability = await run(['cockpit-account'], env);
    assert.equal(capability.code, 0, capability.stderr.replaceAll('fixture-native-access','[fixture]').replaceAll('fixture-native-refresh','[fixture]'));
    assert.equal(JSON.parse(capability.stdout).nativeAccountOnly, true);
    const arguments_ = ['cockpit-account', '--refresh', '--provider', provider, '--account', label, '--expected-email', env.JCODE_EXPECTED_EMAIL];
    const fresh = await run(arguments_, env);
    assert.equal(fresh.code, 0);
    assert.deepEqual(JSON.parse(fresh.stdout), { ok: true, refreshed: false });
    for (const invalidEnv of [{ ...env, JCODE_EXPECTED_EMAIL: 'other@example.invalid' }, { ...env, JCODE_ACCOUNT_ONLY: '0' }]) {
      const rejected = await run(arguments_, invalidEnv);
      assert.equal(JSON.parse(rejected.stdout).ok, false);
      assert.doesNotMatch(rejected.stdout + rejected.stderr, /fixture-native-(?:access|refresh)/);
    }
    const ssh = await run(['--ssh', 'fixture.invalid'], env);
    assert.notEqual(ssh.code, 0);
    assert.match(ssh.stderr, /cannot transfer credentials over SSH/);
    assert.deepEqual(await readFile(file), before);
    const child = spawn(binary, ['--no-update', '--no-selfdev', '--provider', provider, 'serve', '--temporary-server', '--owner-pid', String(process.pid), '--temp-idle-timeout-secs', '10'], { cwd: temporary, env, stdio: 'ignore' });
    children.push({ child, exited: once(child, 'exit') });
    const deadline = Date.now() + 12000;
    let connected = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { await ping(socket); connected = true; break; } catch { await pause(100); }
    }
    assert(connected, 'Each isolated account daemon must answer its own socket');
  }
  assert.notEqual(sockets[0], sockets[1]);
  for (const { child, exited } of children) { child.kill('SIGTERM'); await exited; }
  const result = { status: 'passed', checkedAt: new Date().toISOString(), binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    nativeProviders: 2, isolatedDaemonPings: 2, freshRefreshWithoutNetwork: true, identitiesPreserved: true,
    realCredentialsProvided: false, userSessionsTouched: false, modelRequestsSent: 0 };
  await writeFile(join(dirname(binary), 'native-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  for (const { child, exited } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
