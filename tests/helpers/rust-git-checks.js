import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, label, timeout = 12_000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(100);
  } while (Date.now() < end);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

export async function verifyGitChecks({ fixture, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl];
  const id = 'git-contract';
  const repos = ['node', 'rust'].map(name => join(fixture.directory, `git-${name}`));
  const remotes = repos.map(path => `${path}-remote.git`);
  const git = (path, args) => execFileSync('/usr/bin/git', ['-C', path, ...args], {
    env: fixture.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const normalize = value => JSON.parse(JSON.stringify(value).replaceAll(repos[0], '<repo>').replaceAll(repos[1], '<repo>'));
  const pair = async (tail, body, expected = 200) => {
    const responses = await Promise.all(bases.map(base => request(base, `/api/projects/${id}/${tail}`, body === undefined ? {} : { method: 'POST', body })));
    check(responses.map(r => r.status), [expected, expected], `${tail} status: ${JSON.stringify(responses.map(r => r.data))}`);
    check(normalize(responses[1].data), normalize(responses[0].data), `${tail} Node contract`);
    return responses[1].data;
  };
  const write = async (name, text) => Promise.all(repos.map(path => writeFile(join(path, name), text)));
  const run = args => repos.map(path => git(path, args));
  for (const [index, path] of repos.entries()) {
    execFileSync('/usr/bin/git', ['clone', '--bare', fixture.project, remotes[index]], { env: fixture.env, stdio: 'ignore' });
    execFileSync('/usr/bin/git', ['clone', remotes[index], path], { env: fixture.env, stdio: 'ignore' });
    for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['core.quotePath', 'false'], ['pull.rebase', 'false']]) git(path, ['config', key, value]);
    const response = await request(bases[index], '/api/projects', { method: 'POST', body: { id, name: 'Git contract', path } });
    check(response.status, 201, 'Private git project registration');
  }
  let controller;
  let streamTask;
  try {
    for (const base of bases) {
      await until(async () => (await request(base, '/api/projects')).data.find(p => p.id === id), p => p.git && p.prs, 'Initial project polling');
    }
    await pair('git');
    await pair('branches');
    await pair('diff');
    for (const limit of ['', '1', '1tail', '0x2', '-1', 'nonsense', '1000']) await pair(`git/log?limit=${limit}`);

    controller = new AbortController();
    const frames = [];
    const response = await fetch(`${rustUrl}/api/events`, { signal: controller.signal });
    streamTask = (async () => {
      let pending = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        for (let split; (split = pending.indexOf('\n\n')) >= 0;) {
          const frame = pending.slice(0, split); pending = pending.slice(split + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
        }
      }
    })().catch(error => { if (!controller.signal.aborted) throw error; });
    await until(() => frames, f => f.some(v => v.event === 'init'), 'SSE initial');
    const initial = frames.find(f => f.event === 'init').data;
    check(initial.git[id].projectId, id, 'SSE initial git cache');
    check(initial.prs[id], { projectId: id, prs: [] }, 'SSE initial PR cache');

    await write('src/total.js', 'export const total = values => values.length;\n');
    await write('한글 space.txt', '새 파일😀\n');
    await write('--force', 'A path, never a git flag.\n');
    for (let i = 0; i < 12; i++) await write(`new-${i}.txt`, `${i}\n`);
    const status = await pair('git');
    check(status.uncommittedFiles.length, 10, 'Status file preview cap');
    check(status.uncommittedTotal, 15, 'Status full changed count');
    await pair('diff');
    await pair('git/stage', { files: ['src/total.js', '--force', '한글 space.txt'] });
    check(run(['diff', '--cached', '--name-only'])[1].includes('--force'), true, 'Dash file path passed after option terminator');
    await pair('diff');
    await pair('git/unstage', { files: ['src/total.js'] });
    await pair('git/unstage', { files: ['--all'] });
    await pair('git/discard', { files: ['src/total.js', '--force', '한글 space.txt', ...Array.from({ length: 12 }, (_, i) => `new-${i}.txt`)] });
    // Existing Node batches checkout with untracked paths, which can leave the
    // tracked file modified. Preserve that response contract and retry it alone.
    check(run(['status', '--porcelain'])[1], run(['status', '--porcelain'])[0], 'Mixed discard preserves existing Node behavior');
    await pair('git/discard', { files: ['src/total.js'] });
    check(run(['status', '--porcelain']), ['', ''], 'Discard restores tracked and removes untracked fixture files');

    await write('large.txt', 'x'.repeat(400) + '\n');
    run(['add', 'large.txt']); run(['commit', '-m', 'test: 큰 diff 기준 추가']);
    await write('large.txt', ('y'.repeat(400) + '\n').repeat(4000));
    const large = await pair('diff');
    check(large.unstaged.diff.includes('... truncated ('), true, 'Diff above 1 MiB uses 5 MiB capture and 3000-line display limit');
    check(large.unstaged.files[0].additions, 4000, 'Full diff statistics survive display truncation');
    await pair('git/discard', { files: ['large.txt'] });

    await write('binary.bin', Buffer.from([0, 1, 2, 3]));
    run(['add', 'binary.bin']); run(['commit', '-m', 'test: 이진 파일 기준 추가']);
    await write('binary.bin', Buffer.from([0, 8, 7, 6]));
    await Promise.all(repos.map(path => rename(join(path, 'large.txt'), join(path, 'renamed space.txt'))));
    await pair('git/stage', { files: ['--all'] });
    await pair('diff');
    await pair('git/commit', { message: 'test: 파일 이동과 이진 변경 | 구분자 보존' });
    await pair('git/log?limit=1');
    await pair('git/create-branch', { branch: 'feature/contract' });
    await pair('git/checkout', { branch: 'demo/terminal' });
    await pair('git/delete-branch', { branch: 'feature/contract' });
    await pair('git/delete-branch', { branch: 'main' }, 400);
    await pair('git/create-branch', { branch: 'invalid branch' }, 400);
    check((await request(rustUrl, `/api/projects/${id}/git/checkout`, { method: 'POST', body: { branch: '--detach' } })).status, 400, 'Reject a branch that would become a git option');

    await write('stash.txt', 'stash me\n');
    await pair('git/stash', { message: 'fixture stash', includeUntracked: true });
    await pair('stash-list');
    await pair('git/stash-apply', {});
    await pair('git/stash-drop', {});
    await pair('git/stash', { message: 'fixture pop', includeUntracked: true });
    await pair('git/stash-pop', {});
    await pair('git/discard', { files: ['stash.txt'] });
    await pair('git/stash-pop', { ref: '--help' }, 400);
    await pair('git/stash-drop', { ref: 'stash@{1000}' }, 400);

    await write('first.txt', 'first\n'); await write('second.txt', 'second\n');
    await pair('git/stage', { files: ['second.txt'] });
    const auto = await pair('auto-commit/execute', { message: 'test: 선택한 파일만 커밋', files: ['first.txt'] });
    check(auto.remaining, 1, 'Auto commit leaves unrelated work');
    check(run(['diff', '--cached', '--name-only']), ['', ''], 'Auto commit unstages unrelated files');
    await pair('git/discard', { files: ['second.txt'] });
    await pair('push', {}); await pair('fetch', {}); await pair('pull', {});
    for (const path of repos) git(path, ['worktree', 'add', '-b', 'worktree-contract', `${path}-worktree`]);
    await pair('git');

    // Concurrent staging must serialize without index.lock collisions.
    for (let i = 0; i < 8; i++) await write(`concurrent-${i}`, 'parallel staging\n');
    for (const base of bases) {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => request(base, `/api/projects/${id}/git/stage`, { method: 'POST', body: { files: [`concurrent-${i}`] } })));
      check(results.map(r => r.status), Array(8).fill(200), 'Serialized git mutations');
    }
    check(run(['diff', '--cached', '--name-only'])[1].trim().split('\n').length, 8, 'Every concurrent stage preserved');
    await pair('git/commit', { message: 'test: 동시 스테이징 보존' });
    for (const operation of ['git/stage', 'git/unstage', 'git/discard', 'git/commit', 'auto-commit/execute']) await pair(operation, {}, 400);
    for (const files of ['abc', [null], [3], ['a\0b']]) check((await request(rustUrl, `/api/projects/${id}/git/stage`, { method: 'POST', body: { files } })).status, 400, 'Malformed file array rejected before command');
    check((await request(rustUrl, `/api/projects/${id}/git/stage`, { method: 'POST', headers: { origin: 'https://invalid.example' }, body: { files: ['--all'] } })).status, 403, 'Git write preserves CSRF checks');
    await pair('git/stage', { files: ['does-not-exist'] }, 500);
    for (const base of bases) check((await request(base, '/api/projects/missing/git')).status, 404, 'Unknown git project');

    await write('periodic.txt', 'new periodic state\n');
    await until(() => frames, values => values.some(f => f.event === 'git:update' && f.data.projectId === id && f.data.uncommittedTotal === 1), 'Actual 30-second git SSE refresh', 40_000);
    const before = frames.filter(f => f.event === 'git:update' && f.data.projectId === id).length;
    await delay(800);
    check(frames.filter(f => f.event === 'git:update' && f.data.projectId === id).length, before, 'Unchanged cache does not broadcast every scheduler tick');
    for (const multiplier of [undefined, 0, -2, '2.5slow', 'Infinity', 20, 1]) {
      const responses = await Promise.all(bases.map(base => request(base, '/api/polling-speed', { method: 'POST', body: { multiplier } })));
      check(responses[1].data, responses[0].data, 'Polling multiplier contract');
    }

    const empty = join(fixture.directory, 'not-a-git-repo'); await mkdir(empty);
    for (const base of bases) check((await request(base, '/api/projects', { method: 'POST', body: { id: 'not-git', name: 'Empty', path: empty } })).status, 201, 'Register non-git directory');
    for (const tail of ['git', 'diff', 'git/log', 'stash-list']) {
      const responses = await Promise.all(bases.map(base => request(base, `/api/projects/not-git/${tail}`)));
      check(responses[1].data, responses[0].data, `${tail} non-git fallback`);
    }
    check((await request(rustUrl, `/api/projects/${id}`, { method: 'PUT', body: { path: empty } })).status, 200, 'Change project path');
    await until(async () => (await request(rustUrl, '/api/projects')).data.find(p => p.id === id), p => p?.git?.branch === 'unknown', 'Poller follows updated project path');
    check((await request(rustUrl, `/api/projects/${id}`, { method: 'DELETE' })).status, 200, 'Delete polled project');
    await delay(600);
    check((await request(rustUrl, '/api/projects')).data.some(p => p.id === id), false, 'Deleted project stays removed');
  } finally {
    controller?.abort(); await streamTask;
    for (const base of bases) for (const projectId of [id, 'not-git']) await request(base, `/api/projects/${projectId}`, { method: 'DELETE' });
  }
}
