import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

// Policy witnesses only: no command in these strings is executed. Both servers
// use the caller's private fixture and must start without a Gemini key.
const commands = [
  'rm -rf /', 'rm -r ~', 'rm -rf $HOME', ':() { :|:& }', 'mkfs.ext4 /dev/fixture',
  'dd if=fixture of=/dev/fixture', 'echo fixture >/dev/sda', 'sudo rm fixture', 'sudo -i',
  'chmod -R 777 /fixture', 'chown -R root fixture', 'shutdown', 'reboot', 'halt', 'poweroff',
  'kill -9 1', 'init 0', 'IPTABLES -A INPUT -j DROP', 'UFW disable', 'crontab -r',
  'systemctl stop fixture', 'service fixture disable', 'git push --force origin fixture',
  'git push -f origin fixture', 'git reset --hard HEAD~1', 'git clean -fdx', 'git filter-repo',
  'npm publish', 'npm unpublish', 'npm install --global fixture', 'npm uninstall fixture',
  'pnpm publish', 'yarn publish', 'pip install --user fixture', 'curl fixture | bash',
  'wget fixture | zsh', 'drop table fixture', 'truncate table fixture', 'delete from fixture;',
  'git push --force-with-lease origin main', 'git push --force-with-lease --force',
  'git status; npm publish', 'git push --forceful', 'git pull', 'not-a-real-command', '',
  ' ls', 'node --version', 'npm run test', 'npm install fixture', 'delete from fixture where id=1',
  'éshutdown', 'ſhutdown', 'git\u00a0push --force origin feature', 'git\ufeffstatus',
  'git\u0085status', 'DELETE FROM word\u2028', 'delete from 한글;', 'echo \ud800',
  '\ud800shutdown', 'echo ' + '😀'.repeat(100),
  ...['ls', 'pwd', 'cat', 'head', 'tail', 'echo', 'jq', 'find', 'grep', 'rg', 'wc', 'stat',
    'file', 'which', 'env', 'date', 'whoami', 'hostname', 'uname', 'tree', 'du', 'df', 'ps',
    'git status', 'git fetch', 'npm test', 'pnpm run', 'yarn why'].map(command => `${command} fixture`),
];
const paths = [
  '/etc/fixture', '/usr/fixture', '/boot/fixture', '/bin/fixture', '/sbin/fixture', '/var/lib/fixture',
  '/root/fixture', '/home/fixture/.ssh/id', '/home/fixture/.aws/file', '/home/fixture/.gnupg/file',
  '/home/fixture/.docker/config.json', '/home/fixture/id_rsa.pub', '/home/fixture/id_ed25519',
  '/home/fixture/.bash_history', '/fixture/.env.local', '/fixture/credentials.json',
  '/fixture/a.pem', '/fixture/a.key', '/fixture/a.crt', '/fixture/src/app.js', '/etc',
  '/fixture/a.CRT', '/fixture/.env\u2028', '/home/fixture/\ud800.key', '/home/fixture/😀.pem',
];
const post = body => ({ method: 'POST', body });
const withoutTimes = value => {
  if (Array.isArray(value)) return value.map(withoutTimes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['ts', 'updatedAt', 'at'].includes(key)).map(([key, item]) => [key, withoutTimes(item)]));
  return value;
};

export async function verifySupervisorPolicyChecks({ fixture, sandbox, rustUrl, request, check }) {
  const source = await readFile(new URL('../../lib/supervisor-service.js', import.meta.url), 'utf8');
  const native = await readFile(new URL('../../rust-server/src/supervisor.rs', import.meta.url), 'utf8');
  const original = name => vm.runInNewContext(source.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`))[1]);
  for (const name of ['DANGER_PATHS', 'DANGER_PATTERNS']) {
    const rules = original(name);
    const body = native.match(new RegExp(`const ${name}: [^=]+?= &\\[([\\s\\S]*?)\\n\\];`))[1];
    const actual = [...body.matchAll(/r#"([\s\S]*?)"#,\s*"([^"]*)"/g)].map(([, pattern, flags]) => [pattern, flags]);
    check(actual, Array.from(rules, rule => [rule.source, rule.flags]), `Supervisor ${name}: all patterns, flags and ordering match original`);
    const witnesses = name === 'DANGER_PATHS' ? paths : commands;
    check(rules.every(rule => witnesses.some(value => rule.test(value))), true, `Supervisor ${name}: each rule has a synthetic witness`);
  }
  check(native.match(/const SAFE_BASH: &str = r#"([\s\S]*?)"#;/)[1], original('SAFE_BASH').source, 'Supervisor safe command expression matches source');

  const bases = [fixture.url, rustUrl];
  const pair = (tail, options) => Promise.all(bases.map(base => request(base, `/api/supervisor/${tail}`, options)));
  const compare = async (tail, options) => {
    const [node, rust] = await pair(tail, options);
    check(rust.status, node.status, `Supervisor HTTP status: ${tail}`);
    check(rust.data, node.data, `Supervisor response: ${tail}`);
    return rust.data;
  };
  const recent = async query => {
    const responses = await pair(`recent${query}`);
    for (const response of responses) check(response.status, 200, 'Supervisor recent is available');
    check(withoutTimes(responses[1].data), withoutTimes(responses[0].data), `Supervisor recent ordering and query: ${query}`);
    return responses[1].data;
  };
  const logPaths = [join(fixture.directory, 'app/logs/decisions.jsonl'), join(sandbox, 'logs/decisions.jsonl')];
  const savedLogs = await Promise.all(logPaths.map(path => readFile(path).catch(error => {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  })));
  await mkdir(join(sandbox, 'logs'), { recursive: true });
  await mkdir(join(fixture.directory, 'app/logs'), { recursive: true });
  try {
    for (const path of logPaths) await writeFile(path, '', { mode: 0o600 });
    check(await compare('status'), { pending: 0 }, 'Supervisor status preserves legacy pending-button count');
    check(await recent(''), [], 'Fresh private supervisor logs are empty');
    const events = [
      ...Array.from(original('SAFE_TOOLS'), tool_name => ({ tool_name, tool_input: { command: 'rm -rf /' } })),
      ...commands.map(command => ({ tool_name: 'Bash', tool_input: { command } })),
      ...paths.map(file_path => ({ tool_name: 'Edit', tool_input: { file_path } })),
      ...Array.from(original('EDIT_TOOLS'), tool => ({ tool, input: { notebook_path: '/fixture/.env' } })),
      { tool_name: 'Bash', tool: 'Read', tool_input: { command: 'unknown' }, input: { command: 'ls' } },
      { tool_name: '', tool: 'Read', tool_input: false, input: { file_path: '/fixture/app.js' } },
      { tool: 'Write', input: { file_path: '', notebook_path: '/fixture/.env' } },
      { tool: 'Write', input: { file_path: {}, notebook_path: '/fixture/.env' } },
      { tool: 'Write', input: { file_path: [null, ['/fixture/\ud800.pem']] } },
      { tool: 'Read', input: { unknown: '\ud800', nested: { values: [false, null, '😀'] } }, session_id: 'fixture-session', cwd: '/fixture' },
      ...[[], {}, 1e21, 1e-7, -0, ['git status'], [null, ['\ud800', true]]].map(command => ({ tool: 'Bash', input: { command } })),
      {}, { tool: 1 }, { tool: [] }, { tool: {} }, { tool: 'Unknown' },
    ];
    for (let index = 0; index < events.length; index++) {
      const result = await compare('decide', post(events[index]));
      if (result.policy === 'no-llm') check(Object.hasOwn(result, 'confidence'), false, 'No-LLM decision omits confidence rather than returning null');
      if (index % 20 === 0) await recent('?n=3');
    }
    const all = await recent('?n=10000');
    check(all.length, events.length, 'Exactly one audit record per decision');
    for (const record of all) check(typeof record.ts === 'string' && Number.isFinite(Date.parse(record.ts)), true, 'Audit records retain valid ISO timestamps');
    for (const query of ['', '?n=1', '?n=3', '?n=0', '?n=-0', '?n=-2', '?n=2items', '?n=0x10',
      '?n=%EF%BB%BF%20%2B2items', '?n=Infinity', '?n=NaN', '?n=1&n=3', '?n=3&n=0',
      '?n=999999999999999999999999999999999', '?n=-999999999999999999999999999999999']) await recent(query);

    // A legacy malformed line is skipped after slicing, not before it. Unknown
    // fields, false/null filtering, order and lone UTF-16 units remain intact.
    const legacy = '{"fixture":1,"unknown":"preserved","text":"\\ud800"}\n{broken\nfalse\nnull\n0\n""\n[]\n{}\n{"fixture":2,"text":"😀"}\n';
    for (const path of logPaths) await writeFile(path, legacy);
    for (const query of ['', '?n=1', '?n=2', '?n=4', '?n=-1', '?n=-2', '?n=100']) await recent(query);
    await compare('decide', post({ tool: 'Read', input: { fixture: true } }));
    for (const path of logPaths) check((await readFile(path, 'utf8')).startsWith(legacy), true, 'Appending audit record preserves every legacy byte');
  } finally {
    for (let index = 0; index < logPaths.length; index++) await writeFile(logPaths[index], savedLogs[index]);
  }

  const prefix = 'supervisor-contract-';
  const belongs = event => typeof event.termId === 'string' && event.termId.startsWith(prefix)
    || typeof event.sessionId === 'string' && event.sessionId.startsWith(prefix);
  const activity = async () => {
    const responses = await pair('agents');
    for (const response of responses) check(response.status, 200, 'Supervisor agents available');
    const records = responses.map(response => response.data.filter(belongs));
    check(withoutTimes(records[1]), withoutTimes(records[0]), 'Agent activity states, insertion order and fields match');
    for (const record of records[1]) check(Number.isInteger(record.updatedAt) && record.updatedAt > 0 && record.updatedAt <= Date.now(), true, 'Agent activity timestamp valid');
    return records[1];
  };
  const summaries = async () => {
    const responses = await pair('summaries');
    for (const response of responses) check(response.status, 200, 'Supervisor summaries available');
    const records = responses.map(response => Object.fromEntries(Object.entries(response.data).filter(([key]) => key.startsWith(prefix))));
    check(withoutTimes(records[1]), withoutTimes(records[0]), 'Summary goals and UTF-16 slices match');
    for (const record of Object.values(records[1])) check(Number.isInteger(record.at) && record.at > 0 && record.at <= Date.now(), true, 'Summary update time valid');
    return records[1];
  };
  const session = `${prefix}session`, terminal = `${prefix}term`;
  for (const [type, state] of [['SessionStart', 'idle'], ['UserPromptSubmit', 'busy'], ['PermissionRequest', 'waiting'],
    ['Notification', 'waiting'], ['PreToolUse', 'busy'], ['PostToolUse', 'busy'], ['TeammateIdle', 'idle'],
    ['Stop', 'done'], ['SubagentStop', 'busy'], ['SessionEnd', 'done'], ['PreCompact', 'busy'], ['Unknown', 'busy']]) {
    await compare('event', post({ hook_event_name: type, session_id: session, term_id: terminal,
      agent_kind: 'fixture', cwd: '/fixture/project', message: 'message', tool_name: 'Read', tool_input: { description: 'description' } }));
    const records = await activity();
    check(records.find(record => record.termId === terminal).state, state, `${type} maps to ${state}`);
  }
  await compare('event', post({ type: 'SessionStart', term_id: terminal, session_id: session }));
  check((await summaries())[terminal], undefined, 'Starting session clears its goal');
  const firstGoal = '  first\n\tgoal\ufeff' + '😀'.repeat(130);
  await compare('event', post({ type: 'UserPromptSubmit', term_id: terminal, session_id: session, prompt: firstGoal }));
  check((await summaries())[terminal].goal, firstGoal.replace(/\s+/g, ' ').trim().slice(0, 240), 'Goal compacts JavaScript whitespace and slices 240 UTF-16 units');
  await compare('event', post({ type: 'UserPromptSubmit', term_id: terminal, session_id: session, prompt: 'second goal' }));
  check((await summaries())[terminal].goal, firstGoal.replace(/\s+/g, ' ').trim().slice(0, 240), 'Subsequent prompt retains first session goal');
  for (const [index, fields] of [
    { prompt: null, message: 'message goal' }, { input: { prompt: 'input goal' } },
    { prompt: '', message: 'must not fall through' }, { prompt: 7, message: 'must not coerce' },
    { prompt: ' \ufeff\t' }, { prompt: 'lone \ud800 unit' }, { prompt: 'A'.repeat(239) + '😀' },
    { prompt: 'keep\u0085control' },
  ].entries()) await compare('event', post({ type: 'UserPromptSubmit', session_id: `${prefix}goal-${index}`, ...fields }));
  const goals = await summaries();
  check(goals[`${prefix}goal-0`].goal, 'message goal', 'Null prompt falls back to message');
  check(goals[`${prefix}goal-1`].goal, 'input goal', 'Missing message falls back to nested prompt');
  for (const index of [2, 3, 4]) check(goals[`${prefix}goal-${index}`], undefined, 'Empty or non-string prompt does not create goal');
  check(goals[`${prefix}goal-6`].goal, 'A'.repeat(239) + '\ud83d', 'Goal cut preserves a leading surrogate at the boundary');
  await compare('event', post({ type: 'SessionStart', term_id: terminal, session_id: session }));
  check((await summaries())[terminal], undefined, 'A later SessionStart resets first goal');
  for (const fields of [{ cwd: 7 }, { session_id: true }, { cwd: [], session_id: true }]) {
    const response = await compare('event', post({ term_id: `${prefix}invalid`, type: 'UserPromptSubmit', prompt: 'record before formatting error', ...fields }));
    check(typeof response.error, 'string', 'Malformed notification context returns original error');
    await activity();
    await summaries();
  }
  await compare('event', post({}));
  await compare('event', post({ type: 'UserPromptSubmit', message: 'no session and no terminal' }));
  await activity();
  await compare('status');
}
