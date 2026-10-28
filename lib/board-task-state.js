import { createHash } from 'node:crypto';

export function taskStatus(task) {
  if (task.done) return 'done';
  return ['running', 'blocked'].includes(task.status) ? task.status : 'ready';
}

function waitKey(board, ids, legacy = false) {
  return createHash('sha256').update(JSON.stringify(ids.map(id => {
    const task = board.tasks.find(item => item.id === id);
    if (!task) return [id, null];
    const producers = (board.supervisors || [board.review]).filter(review => !['stopped', 'complete'].includes(review.status) || review.workerDispatch === 'running')
      .flatMap(review => (review.workerProgress || []).filter(worker => task.termId && worker.termId === task.termId
        && review.watched?.some(assigned => assigned.termId === worker.termId && assigned.goal === worker.goal))
        .map(worker => [review.id, worker.evidence || '', worker.run?.evidence || '']));
    return [id, task.done, task.answer || '', task.kind === 'question' && !legacy ? '' : task.text, producers];
  }))).digest('hex');
}

export function taskDispatchKey(board, review, assigned, worker, task, dependencies) {
  return createHash('sha256').update(JSON.stringify([worker.goal, assigned.objective || '', String(assigned.priority || 2),
    review.referencePaths, worker.nextAction || '', task ? [task.id, task.text, String(task.activation || 0), waitKey(board, task.waitFor || [])] : dependencies])).digest('hex');
}

export function reviewInputKey(board, review, legacy = false) {
  return createHash('sha256').update(JSON.stringify([review.objective, review.referencePaths,
    review.watched.map(w => [w.termId, w.goal, w.objective, String(w.priority), w.paused]),
    board.checklists.map(list => [list.id, list.goal]),
    board.tasks.map(task => legacy
      ? [task.id, task.text, task.done, task.answer || '', task.status || '', task.blocker || '', task.waitFor || []]
      : [task.id, task.kind === 'question' ? '' : task.text, task.done, task.answer || '', taskStatus(task) === 'blocked', task.waitFor || []]),
    review.workerProgress.map(w => legacy
      ? [w.termId, w.goal, w.evidence, w.run.evidence, w.run.status, w.run.blocker,
        w.run.remaining.map(r => [r.condition, r.blocker, r.nextAction]), String(w.run.interventionAt)]
      : [w.termId, w.goal, w.evidence, w.run.evidence,
        !workerTasks(board, w.termId).length && w.run.status === 'blocked', String(w.run.interventionAt)])])).digest('hex');
}

export function refreshTaskStates(board) {
  const ready = new Set();
  for (const task of board.tasks) {
    if (!task.termId || task.kind === 'question' || taskStatus(task) !== 'blocked') continue;
    const ids = task.waitFor || [];
    const key = waitKey(board, ids);
    // Upgrade an unchanged legacy dependency without treating deployment as new input.
    if (task.waitKey !== key && task.waitKey === waitKey(board, ids, true)) task.waitKey = key;
    if (!ids.length || !task.blocker?.trim() || task.waitKey !== key
        || ids.some(id => !board.tasks.some(item => item.id === id))
        || ids.some(id => reaches(board, id, task.id))
        || ids.every(id => board.tasks.find(item => item.id === id)?.done)) ready.add(task.id);
  }
  for (const task of board.tasks) if (ready.has(task.id)) task.status = 'ready';
}

function reaches(board, id, target, seen = new Set()) {
  if (id === target) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  const dependency = board.tasks.find(item => item.id === id);
  return dependency && dependency.kind !== 'question' && taskStatus(dependency) === 'blocked'
    && (dependency.waitFor || []).some(next => reaches(board, next, target, seen));
}

export function workerTasks(board, termId) {
  return board.tasks.filter(task => task.termId === termId && task.kind !== 'question' && !task.done);
}

export function nextWorkerTask(board, termId) {
  const tasks = workerTasks(board, termId);
  return tasks.find(task => taskStatus(task) === 'running') || tasks.find(task => taskStatus(task) === 'ready');
}

export function validateWorkerQueue(board, termId, status) {
  const tasks = workerTasks(board, termId);
  if (status === 'complete' && tasks.length) throw new Error(`미완료 체크리스트가 남아 있습니다: ${tasks.map(task => task.id).join(', ')}. 검증 후 체크하세요.`);
  const runnable = nextWorkerTask(board, termId);
  if (status === 'blocked' && runnable) throw new Error(`실행 가능한 체크리스트가 남아 있습니다: ${runnable.id} ${runnable.text}. 전체 대기 대신 이 작업을 진행하세요.`);
}

export function applyTaskState(board, task, updates) {
  if (!['status', 'done', 'blocker', 'waitFor'].some(key => updates[key] !== undefined)) return {};
  if (!task.termId || task.kind === 'question') {
    if (['status', 'blocker', 'waitFor'].some(key => updates[key] !== undefined)) throw new Error('작업 상태는 세션 체크리스트에서만 변경할 수 있습니다.');
    return {};
  }
  const status = updates.status !== undefined ? updates.status : updates.done !== undefined ? updates.done === true ? 'done' : 'ready' : taskStatus(task);
  if (!['ready', 'running', 'blocked', 'done'].includes(status)) throw new Error('작업 상태는 ready, running, blocked, done 중 하나입니다.');
  if (updates.status !== undefined && updates.done !== undefined && (updates.done === true) !== (status === 'done')) throw new Error('작업 상태와 완료 체크가 일치하지 않습니다.');
  if (status !== 'blocked') return { status, done: status === 'done', blocker: '', waitFor: [], waitKey: '',
    activation: (Number(task.activation) || 0) + (status === 'ready' && taskStatus(task) !== 'ready' ? 1 : 0) };
  const blocker = updates.blocker !== undefined ? updates.blocker : task.blocker;
  const ids = updates.waitFor !== undefined ? updates.waitFor : task.waitFor;
  if (typeof blocker !== 'string' || !blocker.trim() || blocker.length > 1000 || !Array.isArray(ids) || !ids.length || ids.length > 10
      || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^T-\d{4,}$/.test(id)
        || id === task.id || !board.tasks.some(item => item.id === id))) throw new Error('막힘에는 이유와 실제 대기 항목 ID(waitFor, 최대 10개)가 필요합니다.');
  if (ids.every(id => board.tasks.find(item => item.id === id).done)) throw new Error('대기 항목이 이미 완료됐습니다. 결과를 확인하고 실행 가능한 상태로 바꾸세요.');
  if (ids.some(id => reaches(board, id, task.id))) throw new Error('작업 대기 조건이 순환합니다. 먼저 실행할 작업을 정하세요.');
  return { status, done: false, blocker: blocker.trim(), waitFor: ids, waitKey: waitKey(board, ids) };
}
