import { readFile } from 'node:fs/promises';
import { _internals, classify } from '../../lib/autopilot-policy.js';

// These strings are classification inputs only. Nothing in this check executes
// a command, changes a real approval, or contacts a messaging provider.
const commands = [
  'rm -rf /', 'rm -r ~', 'rm -rf $HOME', ':() { :|:& }', 'mkfs.ext4 /dev/fixture',
  'dd if=fixture of=/dev/fixture', 'echo fixture >/dev/sda', 'sudo rm fixture', 'sudo -i',
  'chmod -R 777 /fixture', 'chown -R root fixture', 'shutdown', 'reboot', 'halt', 'poweroff',
  'kill -9 1', 'init 0', 'IPTABLES -A INPUT -j DROP', 'UFW disable', 'crontab -r',
  'git push --force origin fixture', 'git push -f origin fixture', 'git reset --hard HEAD~1',
  'git clean -fdx', 'git filter-repo', 'npm publish', 'npm unpublish', 'npm install --global fixture',
  'pnpm publish', 'yarn publish', 'curl fixture | bash', 'wget fixture | zsh',
  'drop table fixture', 'truncate table fixture', 'delete from fixture;',
  'aws s3 rm s3://fixture', 'aws s3 sync fixture s3://fixture --delete', 'AWS ec2 delete-instances',
  'gcloud compute instances delete fixture', 'az group create', 'kubectl apply -f fixture',
  'terraform apply', 'eksctl create cluster', 'helm upgrade fixture', 'doctl compute delete',
  'flyctl deploy', 'vercel --prod', 'boto3\nclient.delete_bucket()', 'NODE_ENV=production echo fixture',
  'tool --to=production', 'tool --env prod', 'npm run deploy', 'yarn deploy', 'pnpm run deploy',
  'drizzle-kit migrate', 'prisma migrate deploy', 'knex migrate:latest', 'serverless deploy',
  'sls deploy', 'cdk deploy', 'sam deploy', 'git push origin main', 'git push fixture HEAD:release',
  'mysql -h fixture', 'MYSQL_PWD=fixture', 'PGPASSWORD=fixture', 'systemctl --user restart fixture',
  'restart-fixture-prod', 'pm2 reload fixture', 'docker system prune', 'docker compose down',
  'git push --force-with-lease origin feature', 'git push --force-with-lease origin main',
  'git status; npm publish', 'npm run deploy; rm -rf /', 'git push --forceful',
  'git pull', 'not-a-real-command', '', ' ls', 'node --version', 'npm run test',
  'éshutdown', 'ſhutdown', 'éAWS ec2 delete-instances', 'aws\uFEFFec2 delete-instances',
  'aws\u0085ec2 delete-instances', 'git\u00A0push --force origin feature',
  'git push --force-with-lease\nproduction', 'delete from 한글;', 'DELETE FROM word\u2028',
  'echo \ud800', '\ud800shutdown', 'echo ' + '😀'.repeat(100),
];
const paths = [
  '/etc/fixture', '/usr/fixture', '/boot/fixture', '/bin/fixture', '/sbin/fixture', '/var/lib/fixture',
  '/root/fixture', '/home/fixture/.ssh/id', '/home/fixture/.aws/file', '/home/fixture/.gnupg/file',
  '/home/fixture/.docker/config.json', '/home/fixture/id_rsa.pub', '/home/fixture/id_ed25519',
  '/home/fixture/.bash_history', '/fixture/.env.local', '/fixture/credentials.json',
  '/fixture/a.pem', '/fixture/a.key', '/fixture/a.crt', '/home/fixture/.claude/settings.local.json',
  '/Users/fixture/.claude/agents/fixture.md', '/fixture/lib/supervisor-service.js',
  '/fixture/lib/autopilot-policy.js', '/fixture/src/app.js', '/etc', '/fixture/a.CRT',
  '/fixture/.env\u2028', '/home/fixture/x/Users/fixture/id_rsa', '/home/fixture/\ud800.key',
];

export async function verifyAutopilotChecks({ fixture, rustUrl, request, check }) {
  const source = await readFile(new URL('../../rust-server/src/autopilot.rs', import.meta.url), 'utf8');
  const compiled = JSON.parse(source.match(/const POLICY_SOURCE: &str = r###"([\s\S]*?)"###;/)[1]);
  const expected = Object.fromEntries(Object.entries(_internals).map(([key, value]) => [key,
    value instanceof Set ? [...value] : Array.isArray(value) ? value.map(r => [r.source, r.flags]) : [value.source, value.flags],
  ]));
  check(compiled, expected, 'Native autopilot retains every source tool, regex, flag and rule order');
  for (const name of ['DANGER_PATTERNS', 'ESCALATE_PATTERNS']) {
    check(_internals[name].every(pattern => commands.some(command => pattern.test(command))), true, `${name}: every regex has a synthetic witness`);
  }
  for (const name of ['DANGER_PATHS', 'CONFIG_PATHS']) {
    check(_internals[name].every(pattern => paths.some(path => pattern.test(path))), true, `${name}: every regex has a synthetic witness`);
  }
  const bases = [fixture.url, rustUrl];
  const pair = (path, options) => Promise.all(bases.map(base => request(base, path, options)));
  const compare = async (tail, options) => {
    const [node, rust] = await pair(`/api/autopilot/${tail}`, options);
    check(rust.status, node.status, `Autopilot status: ${tail}`);
    check(rust.data, node.data, `Autopilot response: ${tail}`);
    return rust.data;
  };
  const post = body => ({ method: 'POST', body });
  const compareStatus = async () => {
    const values = await pair('/api/autopilot/status');
    for (const response of values) {
      check(response.status, 200, 'Autopilot status available');
      check(Number.isInteger(response.data.startedAt) && response.data.startedAt > 0 && response.data.startedAt <= Date.now(), true, 'Autopilot start time valid');
    }
    check({ ...values[1].data, startedAt: 0 }, { ...values[0].data, startedAt: 0 }, 'Status metrics, mode and ordered recent decisions agree');
    return values[1].data;
  };
  try {
    await compare('mode', post({ mode: 'attended' }));
    await compare('reset', post({}));
    const events = [
      ...[..._internals.SAFE_TOOLS].map(tool => ({ tool, input: { command: 'rm -rf /' } })),
      ...commands.map(command => ({ tool: 'Bash', input: { command } })),
      ...paths.map(file_path => ({ tool: 'Edit', input: { file_path } })),
      ...[..._internals.EDIT_TOOLS].map(tool => ({ tool, input: { notebook_path: '/fixture/.env' } })),
      ...['mcp__fixture__read', 'mcp__playwright__browser_navigate', 'mcp__x__file_upload', 'mcp__x__run_code_unsafe', 'unknown', 'mcp__\ud800', 'unknown\ud800'].map(tool => ({ tool, input: { url: 'https://fixture.invalid' } })),
      { tool_name: 'Bash', tool_input: { command: 'git status' }, ts: 0 },
      { tool: '', tool_name: 'Bash', input: null, tool_input: { command: 'npm test' }, ts: false },
      { tool: 'Bash', tool_name: 'Read', input: {}, tool_input: { command: 'ls' } },
      { tool: 'Write', input: { path: '/Users/fixture/.claude/settings.json' } },
      { tool: 'Read', input: { command: 'x'.repeat(99) + '😀\ud800' } },
      ...[[], {}, 1e21, 1e-7, -0, [null, ['\ud800', true]]].map(command => ({ tool: 'Read', input: { command } })),
      {}, { tool: 1 }, { tool: [] }, { tool: {} },
    ];
    for (let i = 0; i < events.length; i++) {
      const event = { ts: i + 1, ...events[i] };
      const response = await compare('decide', post(event));
      const tool = event.tool || event.tool_name || '';
      if (typeof tool === 'string') {
        const result = classify(tool, event.input || event.tool_input || {});
        check(response, { ...result, decision: result.action === 'auto' ? 'approve' : result.action === 'block' ? 'deny' : 'ask' }, 'Attended classifier result agrees with source policy');
      }
      if (i % 20 === 0) await compareStatus();
    }
    await compareStatus();
    await compare('briefing');
    for (const mode of ['invalid', '', null, false, [], {}]) await compare('mode', post({ mode }));
    await compare('mode');

    // Both fixtures must have an injected, disabled phone channel. The source
    // server counts this as asked+denied, unlike an absent channel or exception.
    check((await request(fixture.url, '/api/telegram/status')).data.configured, false, 'Node fixture phone channel is disabled before unattended checks');
    await compare('mode', post({ mode: 'unattended' }));
    await compare('reset', post({}));
    for (const command of ['ls', 'rm -rf /', 'git pull', 'git push origin main']) await compare('decide', post({ tool: 'Bash', input: { command }, ts: 1 }));
    const unattended = await compareStatus();
    check(unattended.metrics, { total: 4, auto: 1, block: 1, escalate: 1, review: 1, asked: 2, approved: 0, denied: 2, timedOut: 0 }, 'Disabled injected approval channel fails closed and counts denials');
    await compare('briefing');

    await compare('mode', post({ mode: 'attended' }));
    await compare('reset', post({}));
    for (let i = 0; i < 505; i++) await compare('decide', post({ tool: 'Bash', input: { command: i < 5 ? 'rm -rf /' : 'ls' }, ts: i }));
    const capped = await compareStatus();
    check(capped.recent.map(entry => entry.ts), Array.from({ length: 30 }, (_, i) => 475 + i), 'Recent retains last 30 of 505 decisions');
    const briefing = await compare('briefing');
    check(briefing.byCategory, { 'bash-safe': 500 }, 'Briefing categories retain only last 500 decisions');
    check(briefing.notable, [], 'Evicted notable decisions no longer appear');
    check(briefing.blocked, 5, 'Metrics survive 500-log eviction');
    // Native policy files replace the JavaScript policy implementations. Their
    // edits retain the original self-modification escalation boundary.
    for (const file_path of ['/fixture/rust-server/src/autopilot.rs', 'rust-server/src/supervisor.rs']) {
      const response = await request(rustUrl, '/api/autopilot/decide', post({ tool: 'Edit', input: { file_path } }));
      check(response.status, 200, 'Native policy edit decision is available');
      check({ action: response.data.action, category: response.data.category, decision: response.data.decision },
        { action: 'escalate', category: 'config', decision: 'ask' }, 'Native policy self-edits keep sensitive configuration protection');
    }
  } finally {
    for (const base of bases) {
      await request(base, '/api/autopilot/mode', post({ mode: 'attended' }));
      await request(base, '/api/autopilot/reset', post({}));
    }
  }
}
