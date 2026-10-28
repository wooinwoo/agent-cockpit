import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function fakeClaude(files) {
  const fs = await import('node:fs');
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  fs.appendFileSync(files.log, JSON.stringify({ args: process.argv.slice(2), prompt, nested: process.env.CLAUDECODE ?? null }) + '\n');
  const mode = JSON.parse(fs.readFileSync(files.mode, 'utf8'));
  if (mode.stderr) process.stderr.write(mode.stderr);
  if (mode.stdout) process.stdout.write(mode.stdout);
  process.exitCode = mode.code || 0;
}

export async function prepareGitAiChecks(fixture) {
  const directory = join(fixture.directory, 'ai-cli');
  await mkdir(directory, { mode: 0o700 });
  const files = { mode: join(directory, 'mode.json'), log: join(directory, 'calls.jsonl') };
  await writeFile(files.mode, '{}'); await writeFile(files.log, '');
  await writeFile(join(directory, 'claude'), `#!${process.execPath}\n(${fakeClaude.toString()})(${JSON.stringify(files)});\n`, { mode: 0o700 });
  fixture.env.PATH = `${directory}:${fixture.env.PATH}`;
  fixture.env.CLAUDECODE = 'fixture-nested-session';
  fixture.gitAi = files;
}

export async function verifyGitAiChecks({ fixture, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl], id = 'git-ai-fixture';
  const repos = ['node', 'rust'].map(side => join(fixture.directory, `git-ai-${side}`));
  const git = (repo, args) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const write = async text => Promise.all(repos.map(repo => writeFile(join(repo, '한글.txt'), text)));
  const calls = async () => (await readFile(fixture.gitAi.log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const mode = async value => writeFile(fixture.gitAi.mode, JSON.stringify(value));
  const pair = async (tail, body = {}, status = 200) => {
    const result = await Promise.all(bases.map(base => request(base, `/api/projects/${id}/${tail}`, { method: 'POST', body })));
    check(result.map(r => r.status), [status, status], `Git AI status ${tail}: ${JSON.stringify(result.map(r => r.data))}`);
    check(result[1].data, result[0].data, `Git AI original response ${tail}`);
    return result[1].data;
  };
  for (const [side, repo] of repos.entries()) {
    execFileSync('/usr/bin/git', ['clone', fixture.project, repo], { env: fixture.env, stdio: 'ignore' });
    // The original server may create a project-local runtime cache while polling.
    await writeFile(join(repo, '.git/info/exclude'), '.local/\n');
    check((await request(bases[side], '/api/projects', { method: 'POST', body: { id, name: 'Private AI contract', path: repo } })).status, 201, 'Register isolated Git AI repository');
  }
  try {
    check(repos.map(repo => git(repo, ['status', '--porcelain'])), ['', ''], 'Fixture repositories begin clean');
    await pair('generate-commit-msg', {}, 400);
    await pair('auto-commit/plan'); // First of five requests in the original limiter window.
    check((await calls()).length, 0, 'Empty changes never invoke a model');
    await write('첫 변경 😀\n');
    repos.forEach(repo => git(repo, ['add', '--', '한글.txt']));
    for (const output of ['"fix(ui): 입력 보존"', "'''fix(ui): quotes'''", '```\nfix(ui): fence\n```', '```text\nfix(ui): existing cleanup behavior\n```']) {
      await mode({ stdout: output }); await pair('generate-commit-msg');
    }
    let recorded = await calls();
    check(recorded[0], recorded[1], 'CLI arguments and exact prompt bytes agree with Node');
    check(recorded[0].args.slice(0, 3), ['-p', '--model', 'haiku'], 'Commit generation defaults to Haiku');
    check(recorded[0].nested, null, 'Nested Claude marker is removed');
    check(recorded[0].prompt.includes('[STAGED_CHANGES]'), true, 'Commit input envelope is preserved');
    await mode({ stderr: 'private fixture CLI failure', code: 7 });
    await pair('generate-commit-msg', {}, 500);
    const plan = { commits: [{ message: 'fix(ui): 입력 보존', files: ['한글.txt'], reasoning: '같은 변경' }], extra: '\ud800' };
    await mode({ stdout: '```json\n' + JSON.stringify(plan) + '\n```' });
    check(await pair('auto-commit/plan', { model: 'sonnet' }), plan, 'Plan preserves Unicode and unknown fields');
    recorded = await calls();
    check(recorded.at(-1), recorded.at(-2), 'Plan CLI options and prompt bytes agree');
    check(recorded.at(-1).args.slice(0, 3), ['-p', '--model', 'sonnet'], 'Requested plan model is forwarded');
    await write('😀'.repeat(16000) + '\n');
    repos.forEach(repo => git(repo, ['add', '--', '한글.txt']));
    await pair('generate-commit-msg');
    recorded = await calls();
    check(recorded.at(-1), recorded.at(-2), 'Commit prompt truncation uses UTF-16 boundaries');
    check(recorded.at(-1).prompt.includes('...(truncated)'), true, 'Large commit diff is bounded');
    check((await pair('auto-commit/plan')).truncated, true, 'Truncated plan is explicitly marked');
    recorded = await calls();
    check(recorded.at(-1), recorded.at(-2), 'Plan prompt truncation uses UTF-16 boundaries');
    check(recorded.at(-1).prompt.startsWith('NOTE: Diff was truncated.'), true, 'Truncated plan retains full-file-list instruction');
    await mode({ stdout: 'prefix {broken 😀' + 'x'.repeat(700) + '} suffix' });
    const invalid = await pair('auto-commit/plan', {}, 500);
    check(invalid.raw.length, 500, 'Invalid JSON diagnostic is bounded by UTF-16 length');
    await mode({ stdout: 'no JSON here' });
    await pair('auto-commit/plan', {}, 500);
    const before = (await calls()).length;
    await pair('auto-commit/plan', {}, 429);
    check((await calls()).length, before, 'Rate rejection never spawns a model');
    for (const base of bases) {
      check((await request(base, '/api/projects/missing/generate-commit-msg', { method: 'POST', body: {} })).status, 404, 'Unknown project cannot invoke model');
      check((await request(base, `/api/projects/${id}/generate-commit-msg`, { method: 'POST', body: {}, headers: { origin: 'https://invalid.example' } })).status, 403, 'Model invocation preserves CSRF guard');
    }
    check((await calls()).length, before, 'Invalid requests cannot invoke model');
    check(repos.map(repo => git(repo, ['log', '--oneline']).trim().split('\n').length), [1, 1], 'Planning never makes a commit');
  } finally {
    await mode({});
    for (const base of bases) await request(base, `/api/projects/${id}`, { method: 'DELETE' });
  }
}
