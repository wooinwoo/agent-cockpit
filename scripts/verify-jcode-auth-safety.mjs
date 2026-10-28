import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const binary = resolve(process.argv[2] || '/home/rst010/projects/personal/claude-code-cockpit/docs/_local/jcode-auth-safety/jcode');
const temporary = await mkdtemp('/tmp/cockpit-auth-safety-');
const home = join(temporary, 'home');
const native = join(home, '.jcode');
const runtime = join(temporary, 'runtime');
const environment = {
  HOME: home, PATH: '/usr/bin:/bin',
  XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  JCODE_HOME: native, JCODE_RUNTIME_DIR: runtime, JCODE_SOCKET: join(runtime, 'fixture.sock'),
  JCODE_NO_TELEMETRY: '1', JCODE_DEFERRED_AUTH_BOOTSTRAP: '1',
};

async function rejected(arguments_, message) {
  const child = spawn(binary, ['--no-update', '--no-selfdev', 'login', ...arguments_], {
    cwd: temporary, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  let timeout;
  try {
    const code = await new Promise((resolveExit, rejectExit) => {
      timeout = setTimeout(() => { child.kill('SIGKILL'); rejectExit(new Error('Owned CLI fixture timed out')); }, 8000);
      child.once('error', rejectExit);
      child.once('exit', resolveExit);
    });
    assert.notEqual(code, 0, 'Unsafe login must fail');
    assert.match(output, message);
    assert.doesNotMatch(output, /https:\/\/[^\s]*(?:authorize|oauth)|fixture-access|fixture-refresh/);
  } finally {
    clearTimeout(timeout);
  }
}

let cases = 0;
try {
  await mkdir(runtime, { mode: 0o700 });
  await rejected(['--provider', 'claude', '--account', 'missing', '--expected-email', 'one@example.com', '--no-browser', '--no-validate'], /Selected Claude account no longer exists/);
  cases++;
  await mkdir(native, { recursive: true, mode: 0o700 });
  const auth = join(native, 'auth.json');
  const openai = join(native, 'openai-auth.json');
  const config = join(native, 'config.toml');
  await writeFile(auth, JSON.stringify({
    anthropic_accounts: [{ label: 'claude-otter', email: 'one@example.com',
      access: 'fixture-access', refresh: 'fixture-refresh', expires: 1,
      subscription_type: 'max', scopes: ['user:inference'] }],
    active_anthropic_account: 'claude-otter',
  }), { mode: 0o600 });
  await writeFile(openai, JSON.stringify({
    openai_accounts: [{ label: 'openai-otter', email: 'one@example.com',
      access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: 1 }],
    active_openai_account: 'openai-otter',
  }), { mode: 0o600 });
  await writeFile(config, 'default_provider = "openai"\n', { mode: 0o600 });
  const before = await Promise.all([auth, openai, config].map(path => readFile(path)));
  const guard = ['--account', 'claude-otter', '--expected-email', 'one@example.com', '--no-browser', '--no-validate'];
  for (const provider of [[], ['--provider', 'auto']]) {
    await rejected([...provider, ...guard], /requires an explicit Claude or OpenAI provider/);
    cases++;
  }
  await rejected(['--provider', 'claude', '--account', 'missing', '--expected-email', 'one@example.com', '--no-browser', '--no-validate'], /Selected Claude account no longer exists/);
  cases++;
  await rejected(['--provider', 'claude', '--account', 'claude-otter', '--expected-email', 'other@example.com', '--no-browser', '--no-validate'], /does not match the selected account/);
  cases++;
  await rejected(['--provider', 'claude', ...guard, '--print-auth-url'], /requires an interactive login/);
  cases++;
  await rejected(['--provider', 'openai', '--account', 'openai-otter', '--expected-email', 'one@example.com', '--no-browser', '--no-validate'], /has no verified workspace/);
  cases++;
  const after = await Promise.all([auth, openai, config].map(path => readFile(path)));
  for (let i = 0; i < before.length; i++) assert.deepEqual(after[i], before[i], 'Existing identity and defaults must be preserved');
  console.log(JSON.stringify({ status: 'passed', cases,
    binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    credentialsAndDefaultsPreserved: true, realCredentialsProvided: false,
    userSessionsTouched: false, modelRequestsSent: 0 }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
