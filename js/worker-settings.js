// The session panel and supervisor board share one persisted assignment.
export function workerSettings(worker) {
  return { objective: worker?.objective || '', goal: worker?.goal || '',
    priority: [1, 2, 3].includes(worker?.priority) ? worker.priority : 2, paused: worker?.paused === true };
}

export const orderedWorkers = workers => workers.slice().sort((a, b) => workerSettings(a).priority - workerSettings(b).priority);

// A worker can report new evidence before the supervisor verifies completion.
export const workerProgressAt = worker => Math.max(worker?.lastProgressAt || 0, worker?.run?.progressAt || 0);

export function workerAssignment(reviews, termId, now = Date.now()) {
  return reviews.filter(review => review.watched?.some(worker => worker.termId === termId))
    .sort((a, b) => Number(workerDispatchEnabled(b, now)) - Number(workerDispatchEnabled(a, now))
      || Number(['running', 'waiting'].includes(b.status)) - Number(['running', 'waiting'].includes(a.status))
      || (b.workerProgress?.find(worker => worker.termId === termId)?.run?.reportedAt || 0)
        - (a.workerProgress?.find(worker => worker.termId === termId)?.run?.reportedAt || 0))[0];
}

// Existing boards retain their linked stop behavior until the user enables independent dispatch.
export function workerDispatchEnabled(review, now = Date.now()) {
  if (review.runUntil && review.runUntil <= now) return false;
  return review.workerDispatch === 'running' || (review.workerDispatch !== 'paused' && review.workerDispatch !== 'running'
    && Boolean(review.termId) && !['stopped', 'complete'].includes(review.status));
}
