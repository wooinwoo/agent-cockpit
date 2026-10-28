import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LIST_FIELDS = 'number,title,state,headRefName,baseRefName,author,updatedAt,createdAt,reviewDecision,isDraft,additions,deletions,changedFiles,labels,url,mergeable,statusCheckRollup';
const DETAIL_FIELDS = 'number,title,body,state,headRefName,baseRefName,author,updatedAt,createdAt,reviewDecision,isDraft,additions,deletions,changedFiles,labels,url,mergeable,statusCheckRollup,reviews,comments,files,commits';

// This function becomes a standalone executable. It only reads private fixture
// files and writes deterministic output; it never delegates to an installed gh.
function fakeGithub(files) {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const mode = fs.readFileSync(files.mode, 'utf8');
  fs.appendFileSync(files.log, JSON.stringify({ args, cwd, mode }) + '\n');
  const paths = JSON.parse(fs.readFileSync(files.paths, 'utf8'));
  const index = paths.indexOf(cwd);
  if (index < 0) {
    process.stdout.write('[]');
    return;
  }
  if (mode === 'failure') {
    process.stderr.write('private gh fixture failure\n');
    process.exitCode = 7;
    return;
  }
  if (mode === 'malformed' && ['list', 'view'].includes(args[1])) {
    process.stdout.write('{broken');
    return;
  }
  if (mode === 'wrong-shape' && args[1] === 'list') {
    process.stdout.write('{}');
    return;
  }
  if (mode === 'bad-labels' && ['list', 'view'].includes(args[1])) {
    process.stdout.write(JSON.stringify(args[1] === 'list' ? [{ labels: {} }] : { labels: {} }));
    return;
  }
  if (args[1] === 'diff') {
    process.stdout.write('diff --git a/한글.js b/한글.js\n+const value = "😀";\n');
    return;
  }
  const stateIndex = args.indexOf('--state');
  const state = stateIndex < 0 ? 'open' : args[stateIndex + 1];
  const pr = {
    number: 12 + index, title: `검증 😀 ${state}\ud800`, state: state.toUpperCase(),
    headRefName: 'feature/한글', baseRefName: 'main', author: { login: 'fixture' },
    updatedAt: index ? '2025-01-03T00:00:00Z' : '2025-01-02T00:00:00Z',
    createdAt: '2025-01-01T00:00:00Z', reviewDecision: '', isDraft: false,
    additions: 2, deletions: null, changedFiles: 1,
    labels: ['plain', { name: '한글' }, { name: '', color: '123456' }],
    url: 'https://example.invalid/pr/12', mergeable: null,
    statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'legacy', state: 'SUCCESS' }, {}],
  };
  if (args[1] === 'list') {
    process.stdout.write(JSON.stringify([pr, { number: 90 + index, title: 'missing optional fields', updatedAt: '2025-01-01T00:00:00Z' }]));
  } else if (args[1] === 'view') {
    process.stdout.write(JSON.stringify({
      ...pr, body: '본문\n😀\udfff',
      reviews: [{ author: null, state: 'APPROVED', body: null }, { author: { login: 'reviewer' }, submittedAt: '2025-01-02T00:00:00Z' }],
      comments: [{ body: '댓글', createdAt: null }, {}],
      files: [{ path: '한글.js', additions: 2 }, {}], commits: [{}, {}],
    }));
  } else {
    process.stdout.write('fixture action complete\n');
  }
}

export async function prepareGithubFixture(fixture) {
  await fixture.stop();
  const directory = join(fixture.directory, 'github-cli');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = { directory, mode: join(directory, 'mode'), log: join(directory, 'events.jsonl'), paths: join(directory, 'paths.json') };
  await writeFile(files.mode, 'ok', { mode: 0o600 });
  await writeFile(files.log, '', { mode: 0o600 });
  await writeFile(files.paths, '[]', { mode: 0o600 });
  await writeFile(join(directory, 'gh'), `#!${process.execPath}\n(${fakeGithub.toString()})(${JSON.stringify(files)});\n`, { mode: 0o700 });
  fixture.env.PATH = `${directory}:${fixture.env.PATH}`;
  fixture.github = files;
  await fixture.start();
}

export async function verifyGithubChecks({ fixture, sandbox, rustUrl, request, check }) {
  const files = fixture.github;
  if (!files) throw new Error('prepareGithubFixture must run before either PR verification or Rust launch');
  const bases = [fixture.url, rustUrl];
  const projects = [
    { id: 'github-fixture-a', name: 'PR 검증 A 😀', path: join(sandbox, 'github-project-a') },
    { id: 'github-fixture-b', name: 'PR 검증 B', path: join(sandbox, 'github-project-b') },
  ];
  const created = [];
  const pair = (path, options) => Promise.all(bases.map(base => request(base, path, options)));
  const same = async (path, options, expectedStatus = 200, compareBody = true) => {
    const [node, rust] = await pair(path, options);
    check(node.status, expectedStatus, `Node PR oracle status: ${path}`);
    check(rust.status, node.status, `PR status matches Node: ${path}`);
    if (compareBody) check(rust.data, node.data, `PR response matches Node: ${path}`);
    return [node, rust];
  };
  const events = async () => (await readFile(files.log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const exactArgs = async (args, cwd = projects[0].path) => {
    const matches = (await events()).filter(event => event.cwd === cwd && JSON.stringify(event.args) === JSON.stringify(args));
    check(matches.length >= 2, true, `Both runtimes invoke gh with exact arguments: ${JSON.stringify(args)}`);
  };
  try {
    for (const project of projects) await mkdir(project.path, { recursive: true });
    await writeFile(files.paths, JSON.stringify(projects.map(project => project.path)));
    for (const project of projects) {
      for (const base of bases) {
        const response = await request(base, '/api/projects', { method: 'POST', body: project });
        if (response.status === 201) created.push({ base, id: response.data.id });
        check(response.status, 201, 'Register isolated PR project');
        check(response.data.id, project.id, 'PR fixture uses identical project IDs');
      }
    }
    const path = `/api/projects/${projects[0].id}/prs`;
    const [listed] = await same(path);
    check(listed.data.prs[0].title.endsWith('\ud800'), true, 'PR mapping preserves lone UTF-16 surrogate');
    check(Object.hasOwn(listed.data.prs[1], 'url'), false, 'Missing PR fields remain omitted');
    check(listed.data.prs[0].checks[2], {}, 'Missing check fields remain omitted');
    await exactArgs(['pr', 'list', '--json', LIST_FIELDS, '--limit', '20']);
    const [ignoredState] = await same(`${path}?state=closed`);
    check(ignoredState.data, listed.data, 'Single-project list ignores state query');
    for (const state of ['', 'all', 'open', 'merged', 'closed', 'invalid']) {
      const [node] = await same(`/api/prs${state ? `?state=${state}` : ''}`);
      check(node.data.prs.length, 4, 'Unknown fixture directories contribute no PRs');
      check(node.data.prs.map(pr => pr.projectId), [projects[1].id, projects[0].id, projects[0].id, projects[1].id], 'All-project PRs sort by date with stable ties');
      const args = ['pr', 'list', '--json', LIST_FIELDS, '--limit', '20'];
      if (!state || ['all', 'merged', 'closed'].includes(state)) args.push('--state', state || 'all');
      await exactArgs(args);
    }
    await same(`${path}/0012`);
    await exactArgs(['pr', 'view', '0012', '--json', DETAIL_FIELDS]);
    await same(`${path}/%31%32`, undefined, 400);
    const diff = await same(`${path}/12/diff`);
    check(diff[1].headers.get('content-type'), diff[0].headers.get('content-type'), 'PR diff keeps text/plain content type');
    await exactArgs(['pr', 'diff', '12']);

    const actions = [
      ['approve', {}, ['review', '12', '--approve']],
      ['approve', { body: '  검토 😀\n--approve  ' }, ['review', '12', '--approve', '--body', '  검토 😀\n--approve  ']],
      ['request-changes', {}, ['review', '12', '--request-changes', '--body', 'Changes requested']],
      ['request-changes', { body: '' }, ['review', '12', '--request-changes', '--body', 'Changes requested']],
      ['request-changes', { body: '수정 요청' }, ['review', '12', '--request-changes', '--body', '수정 요청']],
      ['comment', { body: '  댓글\n;$(not-a-command)  ' }, ['comment', '12', '--body', '  댓글\n;$(not-a-command)  ']],
      ...['squash', 'rebase', 'merge', 'invalid', null, ['merge']].map(method => ['merge', { method }, ['merge', '12', method === 'rebase' ? '--rebase' : method === 'merge' ? '--merge' : '--squash', '--delete-branch']]),
      ['merge', {}, ['merge', '12', '--squash', '--delete-branch']],
    ];
    for (const [action, body, args] of actions) {
      await same(`${path}/12/${action}`, { method: 'POST', body });
      await exactArgs(['pr', ...args]);
    }
    const actionCount = () => events().then(items => items.filter(event => ['review', 'comment', 'merge'].includes(event.args[1])).length);
    const beforeInvalid = await actionCount();
    for (const number of ['bad', '-1', '1.5', '%E4%B8%80', '12%3Bexit']) {
      await same(`${path}/${number}`, undefined, 400);
      await same(`${path}/${number}/diff`, undefined, 400);
      for (const action of ['approve', 'request-changes', 'comment', 'merge']) {
        await same(`${path}/${number}/${action}`, { method: 'POST', body: { body: 'hello' } }, 400);
      }
    }
    for (const body of [{}, { body: null }, { body: '' }, { body: ' \n\ufeff ' }]) {
      await same(`${path}/12/comment`, { method: 'POST', body }, 400);
    }
    for (const body of [{ body: false }, { body: 7 }, { body: {} }]) {
      await same(`${path}/12/comment`, { method: 'POST', body }, 500, false);
    }
    check(await actionCount(), beforeInvalid, 'Invalid PR numbers and comments never execute gh actions');
    await same('/api/projects/github-fixture-missing/prs', undefined, 404);
    await same('/api/projects/github-fixture-missing/prs/12/approve', { method: 'POST', body: {} }, 404);

    for (const mode of ['malformed', 'wrong-shape', 'bad-labels', 'failure']) {
      await writeFile(files.mode, mode);
      const [node] = await same(path);
      check(node.data, { projectId: projects[0].id, prs: [] }, 'List failures preserve empty-list fallback');
      await same('/api/prs');
      if (mode !== 'wrong-shape') {
        const responses = await same(`${path}/12`, undefined, 500, mode === 'failure');
        for (const response of responses) check(typeof response.data.error, 'string', 'Malformed detail returns a JSON error');
      }
      if (mode === 'failure') {
        await same(`${path}/12/diff`, undefined, 500);
        for (const action of ['approve', 'request-changes', 'comment', 'merge']) {
          await same(`${path}/12/${action}`, { method: 'POST', body: { body: 'failure check' } }, 500);
        }
      }
    }
    const logged = await events();
    check(logged.every(event => event.args[0] === 'pr' && ['list', 'view', 'diff', 'review', 'comment', 'merge'].includes(event.args[1])), true, 'Fixture executes only expected PR CLI commands');
  } finally {
    await writeFile(files.mode, 'ok');
    await writeFile(files.paths, '[]');
    for (const { base, id } of created) {
      const response = await request(base, `/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      check(response.status, 200, 'Remove PR fixture project after verification');
    }
  }
}
