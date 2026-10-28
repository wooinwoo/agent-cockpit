import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, unlink, rmdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyBoardControl } from './rust-board-control-checks.js';

// Differential HTTP checks use the caller's two disposable servers. File writes
// below are fixture setup or the existing CLI fallback, never production data.
export async function verifyRustBoard({ fixture, sandbox, rustUrl, request, check }) {
  const urls = [fixture.url, rustUrl];
  const files = [join(fixture.directory, 'data/cockpit/.cockpit-board.json'), join(sandbox, '.cockpit-board.json')];
  const normalizeTimes = value => {
    if (Array.isArray(value)) return value.map(normalizeTimes);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      ['createdAt', 'updatedAt'].includes(key) && item ? '<time>' : normalizeTimes(item)]));
  };
  const seed = async value => Promise.all(files.map(file => writeFile(file, JSON.stringify(value))));
  const reads = async () => Promise.all(urls.map(url => request(url, '/api/board')));
  const compare = async (path = '/api/board', options, status = 200, label = path) => {
    const responses = await Promise.all(urls.map(url => request(url, path, options)));
    check(responses.map(r => r.status), [status, status], `${label}: status`);
    if (status < 400) check(normalizeTimes(responses[1].data), normalizeTimes(responses[0].data), `${label}: data`);
    return responses;
  };
  const put = (url, board, base = board) => request(url, '/api/board', {
    method: 'PUT', body: { board, base, revision: base.revision },
  });
  const empty = (await compare())[0].data;

  const review = {
    ...empty.review, name: '감독 😀', termId: 'fixture-manager', alias: 'ai8', status: 'stopped',
    objective: '완료 조건', referencePaths: [' /fixture/참고.md ', ''], intervalMinutes: 7,
    pendingSince: 111, lastReviewedAt: 112, nextDueAt: 113, runHours: 4, runUntil: 114,
    workerDispatch: 'paused', attempts: 2, retryAt: 115, lastError: '보존', autoRecover: true,
    launchPermissions: { codex: 'workspace-network', claude: 'bypassPermissions' },
    recoveryAttempts: 3, recoveryAfter: 116, stallMinutes: 5, cycleStartedAt: 117,
    recoveryTerminal: { termId: 'fixture-manager', alias: 'ai8', projectId: 'fixture', command: 'echo fixture',
      cwd: '/fixture', accountId: 'fixture-account', durableId: 'fixture-pane', conversationHeld: true },
    watched: [{ termId: 'fixture-worker', alias: 'ai6', goal: '직접 검증', objective: '본업', priority: 1, paused: true }],
    workerProgress: [{ termId: 'fixture-worker', goal: '직접 검증', startedAt: 118, lastProgressAt: 119,
      evidence: 'fixture receipt', evidenceKeys: ['a'.repeat(64), 'invalid'], blocker: 'fixture', nextAction: '다음', alertedAt: 120,
      run: { status: 'active', token: 'fixture-only-token', resumeRequestedAt: 121, resumeSentAt: 122,
        resumeSubmittedAt: 123, interventionAt: 124, checkQueuedAt: 125, remaining: ['첫째', '둘째'],
        lastSentAt: 126, reportedAt: 127, attempts: 4, summary: '진행', nextAction: '확인', progressAt: 128,
        evidence: 'fixture', evidenceKeys: ['b'.repeat(64)], blocker: 'fixture', alternatives: '다른 작업',
        dependencyKey: 'c'.repeat(64), observed: 'busy', lastError: '진단' } }],
    reports: [{ at: 129, status: 'running', text: '검증 자료' }],
  };
  const rich = {
    ...empty, review, supervisors: [review, { ...empty.review, id: 'S-extra', name: '감독 2' }], revision: 9,
    notes: [{ id: 'N-0003', title: ' 메모 ', content: '한글😀\ud83d', createdAt: 10, updatedAt: 11 }],
    checklists: [{ id: 'C-0002', title: '개인 업무', goal: '완료 조건', supervisorId: 'S-0001', createdAt: 10, updatedAt: 11 },
      { id: 'C-0004', title: '감독 2 업무', goal: '검증', supervisorId: 'S-extra', createdAt: 10, updatedAt: 11 }],
    tasks: [{ id: 'T-0007', text: ' 수행 ', done: false, kind: 'task', termId: 'fixture-worker', checklistId: 'C-0002', createdAt: 10, updatedAt: 11 },
      { id: 'T-0008', text: '내 질문', kind: 'question', questionTo: 'supervisor', answer: '답변', checklistId: 'C-0002', createdAt: 10, updatedAt: 11 },
      { id: 'T-0009', text: '감독 질문', kind: 'question', questionTo: 'user', answer: '', checklistId: 'C-0004', createdAt: 10, updatedAt: 11 }],
  };
  await seed(rich);
  await compare(undefined, undefined, 200, 'Full persisted supervision state');
  await compare('/api/board?supervisorId=S-extra');
  await compare('/api/board?supervisorId=missing', undefined, 400);

  for (const input of [
    { note: { content: '구형 메모', updatedAt: 10 }, tasks: [{ id: 'T-0010', text: '구형 작업', createdAt: 10, updatedAt: 11 }] },
    { notes: [], checklists: [], tasks: [{ id: 'T-0001', text: 'fallback', createdAt: 1, updatedAt: 2 }] },
    { ...rich, notes: [...rich.notes, rich.notes[0], { id: 'invalid', content: 'skip' }], tasks: [...rich.tasks, rich.tasks[0]] },
    { ...rich, review: { ...review, name: '\ufeff 감독 ', intervalMinutes: '5', attempts: '-2',
      referencePaths: [null, '  ', 1, ' 경로 '], runHours: 25, runUntil: '100', stallMinutes: 4,
      watched: [{ termId: 'a', alias: 3, goal: ['x', 'y'], objective: { a: 1 }, priority: '1', paused: 1 }],
      workerProgress: [{ termId: 'a', run: { status: 'invalid', observed: '', attempts: -1, remaining: ['', 3, '다음'] } }] } },
    { ...rich, notes: [{ ...rich.notes[0], title: 'x'.repeat(79) + '😀', content: 'x'.repeat(11999) + '😀' }],
      tasks: [{ ...rich.tasks[1], text: 'x'.repeat(499) + '😀', answer: 'x'.repeat(3999) + '😀' }] },
  ]) {
    await seed(input);
    await compare(undefined, undefined, 200, 'Normalization compatibility');
  }

  await seed(empty);
  await compare('/api/board/note', { method: 'PUT', body: { content: '  한글\ud83d  ' } });
  await compare('/api/board/note/append', { method: 'POST', body: { content: ' 덧붙임 ' } });
  await compare('/api/board/note', { method: 'PUT', body: { content: 'x'.repeat(11999) + '😀' } });
  const fullNote = await Promise.all(files.map(file => readFile(file, 'utf8')));
  await compare('/api/board/note/append', { method: 'POST', body: { content: 'overflow' } }, 400);
  check(await Promise.all(files.map(file => readFile(file, 'utf8'))), fullNote, 'Append overflow preserves both files');
  await seed(empty);
  await compare('/api/board/tasks', { method: 'POST', body: { text: '첫 작업' } }, 201);
  await compare('/api/board/tasks', { method: 'POST', body: { text: '내 질문', kind: 'question', questionTo: 'supervisor' } }, 201);
  await compare('/api/board/tasks/T-0002', { method: 'PATCH', body: { answer: '답변😀\ud83d', done: true } });
  await compare('/api/board/tasks/T-0002', { method: 'PATCH', body: { done: false } });
  await compare('/api/board/tasks/T-0001', { method: 'PATCH', body: { answer: 'invalid' } }, 400);
  await compare('/api/board/tasks/T-0001', { method: 'DELETE' });
  const afterDelete = await compare('/api/board/tasks', { method: 'POST', body: { text: '삭제 후 추가' } }, 201);
  check(afterDelete[1].data.task.id, 'T-0003', 'Deleted task ID is never reused');
  const beforeInvalid = await Promise.all(files.map(file => readFile(file, 'utf8')));
  for (const body of [{ text: '' }, { text: 3 }, { text: 'x', kind: 'invalid' },
    { text: 'x', questionTo: 'invalid' }, { text: 'x', checklistId: 'C-9999' },
    { text: 'x', supervisorId: 'missing' }, { text: 'x', termId: 'ai6' }, { text: 'x', termId: null }]) {
    await compare('/api/board/tasks', { method: 'POST', body }, 400);
  }
  await compare('/api/board/tasks/T-9999', { method: 'PATCH', body: { done: true } }, 404);
  await compare('/api/board/tasks/T-9999', { method: 'DELETE' }, 404);
  check(await Promise.all(files.map(file => readFile(file, 'utf8'))), beforeInvalid, 'Invalid operations do not revise or overwrite');

  // Both fresh and stale editors must retain newer supervisor delivery state.
  await seed(rich);
  const bases = (await reads()).map(r => r.data);
  const edits = bases.map(base => structuredClone(base));
  edits.forEach(board => { board.tasks[1].answer = '로컬 답변'; delete board.tasks[1].questionTo;
    board.tasks[0].kind = 'question'; delete board.tasks[0].termId; board.review.pendingSince = 0; });
  await Promise.all(files.map(async (file, i) => {
    const latest = structuredClone(bases[i]);
    latest.review.pendingSince = 555; latest.review.workerProgress[0].run.token = 'new-fixture-token';
    latest.supervisors[0] = latest.review;
    await writeFile(file, JSON.stringify(latest));
  }));
  const replacements = await Promise.all(urls.map((url, i) => put(url, edits[i], bases[i])));
  check(replacements.map(r => r.status), [200, 200], 'Content save with concurrent review metadata');
  check(normalizeTimes(replacements[1].data), normalizeTimes(replacements[0].data), 'Fresh content CAS parity');
  check(replacements[1].data.review.workerProgress[0].run.token, 'new-fixture-token', 'Fresh worker token retained');
  check(replacements[1].data.tasks[0].termId, 'fixture-worker', 'Legacy editor retains session ownership');
  check(replacements[1].data.tasks[1].questionTo, 'supervisor', 'Legacy editor retains question direction');

  for (const conflict of [false, true]) {
    await seed(rich);
    const base = (await reads()).map(r => r.data);
    await compare('/api/board/tasks/T-0008', { method: 'PATCH', body: { answer: '동시 답변' } });
    const local = base.map(board => structuredClone(board));
    local.forEach(board => { board.tasks[1][conflict ? 'answer' : 'text'] = '로컬 수정'; });
    const result = await Promise.all(urls.map((url, i) => put(url, local[i], base[i])));
    check(result.map(r => r.status), [conflict ? 409 : 200, conflict ? 409 : 200], 'Three-way field merge / conflict');
    await compare();
  }
  await seed(rich);
  const staleLists = (await reads()).map(r => r.data);
  await compare('/api/board/tasks', { method: 'POST', body: { text: '새 원격 작업', checklistId: 'C-0002' } }, 201);
  const deletedLists = staleLists.map(board => ({ ...board, checklists: board.checklists.filter(l => l.id !== 'C-0002'),
    tasks: board.tasks.filter(t => t.checklistId !== 'C-0002') }));
  check((await Promise.all(urls.map((url, i) => put(url, deletedLists[i], staleLists[i])))).map(r => r.status), [409, 409], 'Deleting a list cannot delete new remote work');
  const scopes = await Promise.all(urls.map(url => request(url, '/api/board?supervisorId=S-extra')));
  check((await Promise.all(urls.map((url, i) => put(url, scopes[i].data)))).map(r => r.status), [400, 400], 'Scoped read cannot replace whole board');
  await compare('/api/board/tasks', { method: 'POST', body: { text: 'wrong owner', checklistId: 'C-0004', supervisorId: 'S-0001' } }, 400);

  // Retention rejects unfinished overflow and evicts only the oldest completed item.
  const history = { ...rich, tasks: Array.from({ length: 50 }, (_, i) => ({ ...rich.tasks[0],
    id: `T-${String(i + 1).padStart(4, '0')}`, text: `할 일 ${i}`, done: i < 2, createdAt: i + 1, updatedAt: i + 1 })) };
  await seed(history);
  const histories = (await reads()).map(r => r.data);
  histories.forEach(board => board.tasks.push({ ...board.tasks[2], id: 'T-0051', text: '새 작업' }));
  const retained = await Promise.all(urls.map((url, i) => put(url, histories[i])));
  check(retained.map(r => r.status), [200, 200], 'Retention save status');
  check(normalizeTimes(retained[1].data), normalizeTimes(retained[0].data), 'Retention parity');
  check(retained[1].data.tasks.length, 50, 'Session checklist keeps 50 items');
  check(retained[1].data.tasks.some(t => t.id === 'T-0001'), false, 'Oldest completed item removed');
  await seed({ ...history, tasks: history.tasks.map(t => ({ ...t, done: false })) });
  const unfinished = (await reads()).map(r => r.data);
  unfinished.forEach(board => board.tasks.push({ ...board.tasks[0], id: 'T-0051' }));
  check((await Promise.all(urls.map((url, i) => put(url, unfinished[i])))).map(r => r.status), [400, 400], 'Unfinished overflow rejected');
  check((await reads())[1].data.tasks.length, 50, 'Unfinished work preserved');

  await seed(empty);
  const added = await Promise.all(urls.map(url => request(url, '/api/board/supervisors', { method: 'POST', body: { name: ' 감독 2 ' } })));
  check(added.map(r => r.status), [201, 201], 'Supervisor create');
  check(added[1].data.supervisor.name, '감독 2', 'Supervisor name trimmed');
  check(/^S-[a-f0-9-]{36}$/.test(added[1].data.supervisor.id), true, 'Supervisor stable ID shape');
  check(added[1].data.board.review, added[1].data.board.supervisors[0], 'Primary supervisor projection');
  await seed({ ...empty, supervisors: Array.from({ length: 12 }, (_, i) => ({ ...empty.review, id: i ? `S-extra-${i}` : 'S-0001' })) });
  await compare('/api/board/supervisors', { method: 'POST', body: { name: 'too many' } }, 400);
  const token = await readFile(join(sandbox, '.cockpit-token'), 'utf8');
  check((await request(rustUrl, '/api/board/supervisors', { method: 'POST', body: { name: 'remote' },
    headers: { 'x-forwarded-for': '100.64.1.2', cookie: `cockpit-token=${token}`, origin: rustUrl } })).status, 403, 'Supervisor creation remains local-only');

  // File corruption and a symlink cannot turn into a successful blank-board save.
  await Promise.all(files.map(file => writeFile(file, '{corrupt')));
  await compare(undefined, undefined, 500);
  await compare('/api/board/note', { method: 'PUT', body: { content: 'overwrite' } }, 500);
  check(await Promise.all(files.map(file => readFile(file, 'utf8'))), ['{corrupt', '{corrupt'], 'Corrupt files retained');
  await unlink(files[1]);
  const protectedFile = join(sandbox, 'board-protected-fixture.json');
  await writeFile(protectedFile, JSON.stringify(rich));
  await symlink(protectedFile, files[1]);
  check((await request(rustUrl, '/api/board/note', { method: 'PUT', body: { content: 'overwrite' } })).status, 500, 'Board symlink write rejected');
  check(JSON.parse(await readFile(protectedFile, 'utf8')), rich, 'Symlink target untouched');
  await unlink(files[1]);
  await seed(empty);

  const lock = `${files[1]}.lock`;
  const marker = `owner-${process.pid}-00000000-0000-0000-0000-000000000000`;
  await mkdir(lock);
  await writeFile(join(lock, marker), '');
  try {
    check((await request(rustUrl, '/api/board/note', { method: 'PUT', body: { content: 'blocked' } })).status, 503, 'Live CLI lock is not stolen');
    check((await request(rustUrl, '/api/board')).data.revision, 0, 'Read remains available during writer lock');
  } finally { await unlink(join(lock, marker)); await rmdir(lock); }
  const dead = spawn(process.execPath, ['-e', ''], { env: fixture.env });
  await once(dead, 'exit');
  await mkdir(lock);
  await writeFile(join(lock, `owner-${dead.pid}-00000000-0000-0000-0000-000000000000`), '');
  check((await request(rustUrl, '/api/board/note', { method: 'PUT', body: { content: 'recovered' } })).status, 200, 'Dead writer lock recovered');

  await seed(empty);
  const service = pathToFileURL(join(fixture.directory, 'app/lib/board-service.js')).href;
  const worker = spawn(process.execPath, ['--input-type=module', '-e',
    `import { createBoardService } from ${JSON.stringify(service)};
     const board = createBoardService(process.env.COCKPIT_BOARD_FILE);
     for (let i = 0; i < 20; i++) board.addBoardTask('CLI ' + i);`], {
    env: { ...fixture.env, COCKPIT_BOARD_FILE: files[1] }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let failure = '';
  worker.stderr.on('data', chunk => { failure += chunk; });
  const exited = once(worker, 'exit');
  try {
    const requests = await Promise.all(Array.from({ length: 20 }, (_, i) => request(rustUrl, '/api/board/tasks', {
      method: 'POST', body: { text: `HTTP ${i}` },
    })));
    check(requests.filter(r => r.status !== 201).map(r => ({status:r.status,data:r.data})), [], 'Concurrent native mutations succeed');
    const [code] = await exited;
    check(code, 0, `Existing Node CLI writer succeeds: ${failure}`);
    const concurrent = (await request(rustUrl, '/api/board')).data;
    check(concurrent.tasks.length, 40, 'CLI and native concurrent writes all retained');
    check(new Set(concurrent.tasks.map(t => t.id)).size, 40, 'Concurrent task IDs unique');
    check(concurrent.revision, 40, 'One revision per committed mutation');
    check(concurrent.nextTaskNumber, 41, 'Counter advances under shared file lock');
    check((await stat(files[1])).mode & 0o777, 0o600, 'Private board file permissions');
  } finally { if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGTERM'); await exited; } }

  // Rust preserves fields from newer clients even before their behavior is ported.
  const future = { ...rich, future: { nested: 'preserve\ud83d' }, review: { ...review, future: 'state' },
    notes: rich.notes.map(note => ({ ...note, futureNote: 'memo metadata' })),
    checklists: rich.checklists.map(list => ({ ...list, futureList: 'list metadata' })),
    tasks: rich.tasks.map(task => ({ ...task, futureTask: 'task metadata' })) };
  await writeFile(files[1], JSON.stringify(future));
  const saved = await request(rustUrl, '/api/board/note', { method: 'PUT', body: { content: 'memo' } });
  check(saved.status, 200, 'Future fields save');
  check(saved.data.future, future.future, 'Unknown root fields retained');
  check(saved.data.review.future, 'state', 'Unknown supervision fields retained');
  for (const stale of [false, true]) {
    const base = (await request(rustUrl, '/api/board')).data;
    const local = structuredClone(base);
    delete local.future;
    local.notes.forEach(note => { delete note.futureNote; });
    local.checklists.forEach(list => { delete list.futureList; });
    local.tasks.forEach(task => { delete task.futureTask; });
    local.notes[0].content = stale ? 'stale editor' : 'current editor';
    local.tasks[1].kind = 'task';
    delete local.tasks[1].questionTo;
    if (stale) await request(rustUrl, '/api/board/tasks/T-0007', { method: 'PATCH', body: { done: true } });
    const updated = await put(rustUrl, local, base);
    check(updated.status, 200, 'Whole-board save preserves unknown fields');
    check(updated.data.future, future.future, 'Browser projection retains root metadata');
    check(updated.data.notes[0].futureNote, 'memo metadata', 'Browser projection retains note metadata');
    check(updated.data.checklists[0].futureList, 'list metadata', 'Browser projection retains checklist metadata');
    check(updated.data.tasks[0].futureTask, 'task metadata', 'Browser projection retains task metadata');
    check(Object.hasOwn(updated.data.tasks[1], 'questionTo'), false, 'Kind change does not revive question recipient');
  }
  const beforeDeep = await readFile(files[1], 'utf8');
  const deep = '['.repeat(130) + '0' + ']'.repeat(130);
  check((await request(rustUrl, '/api/board/note', { method: 'PUT', body: '{"content":"overwrite","extra":' + deep + '}' })).status, 400, 'Deep request rejected before recursive processing');
  check(await readFile(files[1], 'utf8'), beforeDeep, 'Deep request leaves stored board unchanged');
  await writeFile(files[1], '{"extra":' + deep + '}');
  check((await request(rustUrl, '/api/board')).status, 500, 'Deep persisted data rejected without crashing server');
  check(await readFile(files[1], 'utf8'), '{"extra":' + deep + '}', 'Deep persisted data preserved');
  await seed(empty);
  await verifyBoardControl({ fixture, sandbox, rustUrl, request, check, empty, rich, seed, files });
}
