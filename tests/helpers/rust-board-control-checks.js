import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyBoardControl({ fixture, sandbox, rustUrl, request, check, empty, rich, seed, files }) {
  const urls = [fixture.url, rustUrl];
  const dynamic = new Set(['createdAt', 'updatedAt', 'nextDueAt', 'lastReviewedAt', 'startedAt',
    'lastProgressAt', 'progressAt', 'reportedAt', 'resumeRequestedAt', 'at']);
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      dynamic.has(key) && typeof item === 'number' && item > 1e12 ? '<now>' : clean(item)]));
  };
  const read = async () => (await Promise.all(urls.map(url => request(url, '/api/board')))).map(r => r.data);
  const compare = async (method, path, body, status = 200) => {
    const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
    const result = await Promise.all(urls.map(url => request(url, `/api/board/${path}`, { method, body })));
    check(result.map(r => r.status), [status, status], `${path}: ${JSON.stringify(body)} status`);
    if (status < 400) {
      check(clean(result[1].data), clean(result[0].data), `${path} response`);
      check(result.map(r => r.data.revision), before.map(raw => JSON.parse(raw).revision), 'Metadata keeps content revision');
    } else {
      check(await Promise.all(files.map(file => readFile(file, 'utf8'))), before, 'Rejected control leaves board byte-for-byte intact');
    }
    return result.map(r => r.data);
  };
  const deadline = Date.now() + 3600000;
  const base = () => {
    const board = structuredClone(rich);
    board.tasks = board.tasks.map(task => task.termId === 'fixture-worker' && task.kind !== 'question' ? { ...task, done: true } : task);
    board.review = { ...board.review, status: 'stopped', workerDispatch: 'running', runUntil: deadline,
      autoRecover: false, recoveryAfter: 9e14, runHours: 1 };
    board.review.workerProgress[0].run.token = 'report-token';
    board.supervisors[0] = board.review;
    return board;
  };
  await seed(base());
  await compare('PUT', 'permissions', { codex: 'network', claude: 'full' });
  await compare('PUT', 'permissions', { codex: 'network', claude: 'invalid' }, 400);
  await compare('PUT', 'permissions', { claude: 'full' }, 400);
  await compare('PATCH', 'worker-dispatch', { mode: 'paused', expected: 'linked' }, 409);
  await compare('PATCH', 'worker-dispatch', { mode: 'invalid', expected: 'running' }, 400);
  const paused = await compare('PATCH', 'worker-dispatch', { mode: 'paused', expected: 'running' });
  check(paused[1].review.workerProgress[0].run.token, '', 'User pause revokes report token');
  check(paused[1].review.workerProgress[0].run.resumeRequestedAt, 0, 'User pause revokes queued resume');
  await compare('POST', 'worker-resume', { termId: 'fixture-worker' }, 409);
  await compare('POST', 'worker-report', { termId: 'fixture-worker', token: 'report-token', status: 'working', summary: 'late' }, 409);
  await compare('PATCH', 'worker-dispatch', { mode: 'running', expected: 'paused' });
  await compare('PATCH', 'worker-dispatch', { mode: 'running', expected: 'paused' }, 409);
  const stopped = await compare('PUT', 'review', { target: '', intervalMinutes: 3, objective: ' 독립 작업 계속 ', referencePaths: [' /fixture/참고.md '] });
  check(stopped[1].review.workerDispatch, 'running', 'Stopping manager preserves independent dispatch');
  check(stopped[1].review.runUntil, deadline, 'Stopping manager preserves worker deadline');
  await compare('POST', 'worker-resume', { termId: 'fixture-worker' });
  const expired = base(); expired.review.runUntil = 1; expired.supervisors[0] = expired.review;
  await seed(expired);
  await compare('POST', 'worker-resume', { termId: 'fixture-worker' }, 409);
  await compare('PATCH', 'worker-dispatch', { mode: 'running', expected: 'running' }, 400);
  await seed(empty);
  await compare('PATCH', 'worker-dispatch', { mode: 'running', expected: 'linked' }, 400);
  for (const body of [{ target: '', intervalMinutes: 0 }, { target: 3 }, { target: 'missing' },
    { target: '', referencePaths: ['bad\npath'] }, { target: '', objective: 3 },
    { target: '', watched: null }, { target: '', watched: [{ target: 'missing', goal: 'goal' }] },
    { target: '', autoRecover: 'yes' }]) await compare('PUT', 'review', body, 400);
  await compare('PATCH', 'worker-settings', { termId: 'missing', expected: null, settings: { objective: '', goal: 'goal', priority: 1, paused: false } }, 400);
  await compare('PATCH', 'worker-settings', { termId: 'missing', settings: {} }, 409);

  // A stopped second manager still owns independently running workers.
  const owned = base(); owned.review.workerDispatch = 'paused';
  owned.supervisors[0] = owned.review;
  owned.supervisors[1] = { ...structuredClone(owned.review), id: 'S-extra', workerDispatch: 'running' };
  await seed(owned);
  await compare('PATCH', 'worker-dispatch', { mode: 'running', expected: 'paused' }, 400);
  await seed(base());
  const claim = { termId: 'fixture-worker', token: 'report-token', status: 'working', summary: '진행 근거',
    artifact: '/fixture/한글😀\ud83d', version: 'rev-a', result: 'PASS', nextAction: '다음 업무' };
  const first = await compare('POST', 'worker-report', claim);
  check(first[1].review.workerProgress[0].lastProgressAt, 119, 'Worker report does not become supervisor-verified progress');
  check(first[1].review.workerProgress[0].run.evidenceKeys.length, 2, 'Native SHA-256 identity matches Node');
  const second = await compare('POST', 'worker-report', { ...claim, version: 'rev-b', result: 'PASS B' });
  const repeated = await compare('POST', 'worker-report', claim);
  check(repeated.map(b => b.review.workerProgress[0].run.progressAt), second.map(b => b.review.workerProgress[0].run.progressAt), 'A/B/A report cannot reset progress clock');
  check(repeated.map(b => b.review.workerProgress[0].run.evidence), second.map(b => b.review.workerProgress[0].run.evidence), 'Repeated evidence does not replace newest evidence');
  const complete = await compare('POST', 'worker-report', { ...claim, status: 'complete' });
  check(complete[1].review.workerProgress[0].run.status, 'reported', 'Worker completion remains an unverified claim');
  await compare('POST', 'worker-report', { ...claim, token: 'stale' }, 409);
  await compare('POST', 'worker-report', { ...claim, termId: 'missing' }, 409);
  await compare('POST', 'worker-report', { ...claim, artifact: '' }, 400);
  await compare('POST', 'worker-report', { ...claim, status: 'blocked', blocker: 'blocked', alternatives: 'none' }, 400);
  const blocked = { ...claim, status: 'blocked', blocker: ' 접근 제한 ', alternatives: ' 독립 경로도 접근 제한 ',
    remaining: [{ condition: '남은 조건', blocker: '접근 제한', nextAction: '접근 복구 뒤 확인' }] };
  await compare('POST', 'worker-report', blocked);
  await compare('POST', 'worker-report', { ...blocked, remaining: [{ condition: '남은 조건', blocker: '', nextAction: '확인' }] }, 400);
  const resumed = await compare('POST', 'worker-resume', { termId: 'fixture-worker' });
  check(resumed[1].review.workerProgress[0].run.resumeSentAt, 0, 'Resume queues a request; it does not claim delivery');

  await seed(base());
  const progress = { termId: 'fixture-worker', artifact: '/fixture/결과\ud83d', version: 'revision-a', result: 'PASS', workState: 'complete' };
  await compare('POST', 'review', { pendingSince: 110, status: 'complete', report: 'stale' }, 409);
  await compare('POST', 'review', { pendingSince: 111, status: 'complete', report: '근거 없음' }, 400);
  await compare('POST', 'review', { pendingSince: 111, report: '검증', progress: [{ ...progress, artifact: '' }] }, 400);
  await compare('POST', 'review', { pendingSince: 111, report: '검증', progress: [progress, progress] }, 400);
  const verified = await compare('POST', 'review', { pendingSince: 111, status: 'complete', report: ' 직접 검증 완료 ', progress: [progress] });
  check(verified[1].review.workerProgress[0].run.status, 'complete', 'Supervisor evidence confirms completion');
  check(verified[1].review.workerProgress[0].run.token, '', 'Verified completion revokes worker token');
  check(verified[1].review.pendingSince, 0, 'Report consumes pending claim');
  check(verified[1].review.nextDueAt - verified[1].review.lastReviewedAt, 7 * 60000, 'Next review uses configured interval');
  await compare('POST', 'review', { pendingSince: 111, report: 'duplicate' }, 409);
  // Put the old evidence into a fresh request to prove clock deduplication across requests.
  const dedup = structuredClone(verified[1]);
  dedup.review.pendingSince = 222; dedup.review.status = 'stopped'; dedup.supervisors[0] = dedup.review;
  delete dedup.scopeSupervisorId;
  await seed(dedup);
  const again = await compare('POST', 'review', { pendingSince: 222, status: 'complete', report: '재확인', progress: [progress] });
  check(again[1].review.workerProgress[0].lastProgressAt, dedup.review.workerProgress[0].lastProgressAt, 'Repeated verification cannot fake new progress');
  const grouped = base();
  grouped.supervisors[1] = { ...structuredClone(grouped.review), id: 'S-extra', name: '독립 감독', termId: 'other-manager' };
  grouped.review.workerDispatch = 'paused'; grouped.supervisors[0] = grouped.review;
  await seed(grouped);
  const scoped = await compare('POST', 'worker-report', { ...claim, supervisorId: 'S-extra' });
  check(scoped[1].scopeSupervisorId, 'S-extra', 'Worker report remains supervisor-scoped');
  const all = await read();
  check(all[1].review.workerProgress[0].run.summary, grouped.review.workerProgress[0].run.summary, 'Secondary report does not change primary manager');
  check(all[1].supervisors[1].workerProgress[0].run.summary, '진행 근거', 'Secondary worker state persisted');
  check(scoped[1].tasks.map(t => t.id), ['T-0009'], 'Report scope includes only assigned questions');

  const token = await readFile(join(sandbox, '.cockpit-token'), 'utf8');
  const queue = base();
  queue.tasks.push({ id: 'T-0100', text: '허용된 독립 구현', termId: 'fixture-worker', kind: 'task', done: false, createdAt: 1, updatedAt: 1 });
  queue.nextTaskNumber = 101;
  await seed(queue);
  await compare('POST', 'worker-report', blocked, 400);
  await compare('POST', 'review', { pendingSince: 111, status: 'complete', report: '등록 작업이 남은 완료 주장',
    progress: [{ ...progress, workState: undefined }] }, 400);
  const taskChange = async (id, body, status = 200) => {
    const results = await Promise.all(urls.map(url => request(url, `/api/board/tasks/${id}`, { method: 'PATCH', body })));
    check(results.map(r => r.status), [status, status], 'Queue state HTTP parity');
    check(clean(results[1].data), clean(results[0].data), 'Queue state and dependency identity parity');
    return results[1].data;
  };
  await taskChange('T-0100', { status: 'blocked', blocker: '원전 없음', waitFor: ['T-9999'] }, 400);
  await taskChange('T-0100', { status: 'blocked', blocker: '답변에 필요한 원전 대기', waitFor: ['T-0009'] });
  await compare('POST', 'worker-report', blocked);
  await taskChange('T-0009', { answer: '새 허용 원전 경로' });
  check((await read())[1].tasks.find(t => t.id === 'T-0100').status, 'ready', 'New answer releases native dependency wait');
  await taskChange('T-0100', { status: 'blocked', blocker: '오래된 초안', waitFor: ['T-0009'],
    expectedStatus: 'blocked' }, 409);
  await taskChange('T-0100', { status: 'blocked', blocker: '오래된 시각', waitFor: ['T-0009'],
    expectedUpdatedAt: 1, expectedStatus: 'ready' }, 409);
  await compare('POST', 'worker-report', blocked, 400);
  await taskChange('T-0100', { done: true });
  await taskChange('T-0100', { done: false });
  check((await read())[1].tasks.find(t => t.id === 'T-0100').activation, 1, 'Reopening records a new native delivery event');
  for (const [method, path] of [['PUT', 'permissions'], ['PUT', 'review'], ['POST', 'review'],
    ['PATCH', 'worker-settings'], ['PATCH', 'worker-dispatch'], ['POST', 'worker-report'], ['POST', 'worker-resume']]) {
    check((await request(rustUrl, `/api/board/${path}`, { method, body: {},
      headers: { 'x-forwarded-for': '100.64.1.2', cookie: `cockpit-token=${token}`, origin: rustUrl } })).status, 403, `${path} is local-only`);
  }
  await seed(empty);
}
