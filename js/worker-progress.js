export const WORKER_PROGRESS_DEADLINE = 5 * 60_000;

// This detects missing new reported evidence, not whether the evidence is true.
export function stalledWorkerProgress(review, now = Date.now()) {
  return (review.workerProgress || []).filter(worker =>
    review.watched.some(target => target.termId === worker.termId && target.goal === worker.goal)
    && now - (worker.lastProgressAt || worker.startedAt) >= WORKER_PROGRESS_DEADLINE);
}
