// Read-only projection shared by the status views. Full-board editors retain
// the existing GET contract; a projection must never be saved as a full board.
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value || {}, key)).map(key => [key, value[key]]));
export function boardSummary(board) {
  return {
    projection: 'overview', revision: board.revision, updatedAt: board.updatedAt,
    tasks: (board.tasks || []).map(task => pick(task, ['id', 'text', 'kind', 'done', 'termId', 'status', 'updatedAt', 'createdAt', 'checklistId', 'waitFor', 'waitKey', 'blocker', 'activation', 'answer'])),
    supervisors: (board.supervisors || (board.review ? [board.review] : [])).map(review => ({
      ...pick(review, ['id', 'termId', 'name', 'alias', 'objective', 'status', 'workerDispatch', 'runUntil']),
      watched: (review.watched || []).map(worker => pick(worker, ['termId', 'alias', 'goal', 'objective', 'priority', 'paused'])),
      workerProgress: (review.workerProgress || []).map(worker => ({
        ...pick(worker, ['termId', 'goal', 'evidence', 'blocker', 'nextAction', 'startedAt', 'lastProgressAt']),
        run: pick(worker.run, ['status', 'summary', 'observed', 'reportedAt', 'progressAt', 'blocker', 'nextAction', 'blockedVerifiedAt']),
      })),
      reports: (review.reports || []).slice(-1).map(report => pick(report, ['at', 'status', 'text'])),
    })),
  };
}
