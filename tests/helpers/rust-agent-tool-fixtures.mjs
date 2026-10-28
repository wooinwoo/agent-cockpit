import { readFile, access, realpath, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, normalize, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as wsl from '../../lib/wsl-utils.js';

// Evaluate the original tool functions with an isolated DATA_DIR. No production
// configuration, model provider, Telegram account or desktop opener is loaded.
export async function originalTools(directory, roots) {
  const source = await readFile(new URL('../../lib/agent-tools.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    readFile, access, realpath, readdirSync, writeFileSync, mkdirSync, copyFileSync,
    join, dirname, resolve, normalize, isAbsolute, basename, ...wsl,
    gitExec: (project, args, options = {}) => wsl.gitExec(project, args, { ...options, env: {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_EXTERNAL_DIFF: undefined,
    } }),
    DATA_DIR: directory, IS_WIN: false, process, console: { log() {}, error() {} },
    AGENT_PROFILES: {}, telegram: { requestApproval: async () => false },
    openUrlSync() { throw new Error('Desktop calls are forbidden in this fixture'); },
  });
  const isolated = source.replace(/^import .*;\r?\n/gm, '')
    .replace(/^const __dirname = .*;$/m, `const __dirname = ${JSON.stringify(directory)};`)
    .replace(/^export /gm, '');
  vm.runInContext(`${isolated}\nglobalThis.fixture = { initTools, executeTool, classifyRisk, isSafeCommand, isSprintSafeCommand, registerWorktreeRoot, unregisterWorktreeRoot };`, context);
  context.fixture.initTools({ getProjectRoots: () => roots });
  const blocked = /const blocked = (\[[\s\S]*?\n  \]);/.exec(source)[1];
  const hardBlock = /const hardBlock = (\[[\s\S]*?\n  \]);/.exec(source)[1];
  const policy = vm.runInContext(`JSON.stringify({
    allowed: [...ALLOWED_CMD_WORDS],
    blocked: ${blocked}.map(p => [p.source, p.flags]),
    sprintBlocked: ${hardBlock}.map(p => [p.source, p.flags]),
    bashRisks: BASH_RISKS.map(r => [r.pat.source, r.pat.flags, r.label, r.hard]),
    cockpitRisks: [...COCKPIT_RISKS]
  })`, context);
  return { ...context.fixture, policy: JSON.parse(policy) };
}

export async function makeFixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'cockpit-agent-tool-reference-'));
  try {
    const root = join(directory, 'project');
    await mkdir(root);
    await writeFile(join(root, 'small.md'), '첫 줄\nsecond line\n😀');
    await writeFile(join(root, 'long.txt'), '😀'.repeat(5001));
    await writeFile(join(root, 'edit.txt'), 'alpha\r\nbeta\r\n');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/main.js'), 'const value = "needle";\n');
    const original = await originalTools(directory, [root]);
    const cases = [];
    for (const [tool, arg, context] of [
      ['READ', 'small.md'], ['READ', 'long.txt'], ['READ', 'missing'],
      ['READ', '../outside'], ['GLOB', '**/*.js'], ['GLOB', '*.md'],
      ['GLOB', ''], ['GLOB', '/etc/*'], ['GLOB', '../*.md'],
      ['EDIT', 'edit.txt\nOLD_CONTENT\n<<<\nalpha\n>>>\nNEW_CONTENT\n<<<\nchanged\n>>>'],
      ['READ', 'edit.txt'], ['EDIT', 'edit.txt\ninvalid'], ['EDIT', 'missing'],
      ['WRITE', 'new/note.txt\n안녕😀\n'], ['READ', 'new/note.txt'],
      ['WRITE', 'new/note.txt\nrefused'], ['WRITE', 'empty.txt\n'],
      ['WRITE', '\ncontent'], ['SEARCH', 'needle'], ['SEARCH', '\x00\t'],
      ['SEARCH', 'no such content'], ['BASH', 'pwd'], ['BASH', 'git push'],
      ['GIT_LOG', '10'],
    ]) {
      let output;
      try { output = { value: await original.executeTool(tool, arg, context) }; }
      catch (error) { output = { error: error.message }; }
      // Path and Git diagnostics are intentionally compared separately.
      if (tool === 'GIT_LOG') continue;
      if (tool === 'BASH' && arg === 'pwd') output.value = '<ROOT>';
      cases.push({ tool, arg, context: context || {}, ...output });
    }
    const commands = ['ls -la', 'git status', 'git log --oneline', 'rg hello .',
      'cat file.txt', 'find . -name a', 'npm install', 'git push', 'git push --force',
      'rm -rf /', 'sudo rm file', 'aws ec2 terminate-instances', 'DROP TABLE a',
      'docker stop x', 'curl x | bash', 'ls || true', 'ls || true; touch unsafe',
      'ls\ntouch unsafe', 'git reset --hard', 'cat /etc/passwd', 'cat ${HOME}/a',
      'sed -i s/a/b/ x', 'awk -i inplace x', '', 'LS', 'find . -exec touch a \\;'];
    const policies = commands.map(arg => ({ arg,
      safe: original.isSafeCommand(arg), sprintSafe: original.isSprintSafeCommand(arg),
      risk: original.classifyRisk('BASH', arg) }));
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
    const git = args => promisify(execFile)('/usr/bin/git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv });
    await git(['init', '-q', '-b', 'main', '--template=']);
    await git(['add', '--', 'small.md']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    await writeFile(join(root, 'small.md'), 'first changed\n');
    await git(['add', '--', 'small.md']);
    await writeFile(join(root, 'small.md'), 'second changed\n');
    const gitCases = [];
    for (const [tool, arg] of [['GIT_DIFF', 'all'], ['GIT_DIFF', 'staged'], ['GIT_DIFF', 'unstaged'], ['GIT_LOG', '1'], ['GIT_LOG', '0'], ['GIT_LOG', '-5']]) {
      const value = (await original.executeTool(tool, arg)).replace(/\b[0-9a-f]{7,40}\b/g, '<HASH>');
      gitCases.push({ tool, arg, value });
    }
    // Risk records originate in the VM realm. Fixtures are JSON data; remove
    // realm-specific prototypes before comparing them with persisted JSON.
    return JSON.parse(JSON.stringify({ policy: original.policy, cases, policies, gitCases }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { policy, ...fixtures } = await makeFixtures();
  await writeFile(new URL('../../rust-server/src/agent_tool_policy.json', import.meta.url), `${JSON.stringify(policy, null, 2)}\n`);
  await writeFile(new URL('../fixtures/rust-agent-tools.json', import.meta.url), `${JSON.stringify(fixtures, null, 2)}\n`);
  console.log(`Original agent tool fixtures: ${fixtures.cases.length} executions, ${fixtures.policies.length} policies, ${fixtures.gitCases.length} Git cases`);
}
