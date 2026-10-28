import { it } from 'node:test';
import assert from 'node:assert/strict';
import { boardSummary } from '../../lib/board-summary.js';
import { workOverviewRows } from '../../js/work-overview-state.js';
import { getSessionActivity } from '../../js/agent-wall-state.js';

it('keeps status views identical while omitting history and unknown payloads', () => {
  const now = 1_000_000;
  const board = { revision: 9, updatedAt: now, tasks: [
    { id: 'T-0001', text: 'done', done: true, kind: 'task', termId: 'a', updatedAt: 10 },
    { id: 'T-0002', text: 'next', done: false, kind: 'task', termId: 'a', status: 'ready' },
    { id: 'T-0003', text: 'blocked', done: false, kind: 'task', termId: 'b', status: 'blocked' },
  ], supervisors: [{ id: 'S-0001', termId: 'pm', name: 'PM', objective: 'goal', status: 'running',
    workerDispatch: 'running', runUntil: now + 1000,
    watched: [{ termId: 'a', alias: 'A', goal: 'finish A', priority: 1 }, { termId: 'b', goal: 'finish B', paused: true }],
    workerProgress: [{ termId: 'a', goal: 'finish A', lastProgressAt: now, run: { status: 'reported', summary: 'review me', reportedAt: now } },
      { termId: 'b', goal: 'finish B', run: { status: 'blocked', blocker: 'dependency', nextAction: 'check result' } }],
    reports: [{ at: 1, text: 'x'.repeat(1_000_000) }, { at: now, text: 'latest' }], hugeExtension: 'private history' }],
    note: { content: 'private note' } };
  const before = JSON.stringify(board);
  const summary = boardSummary(board);
  const terminals = [{ termId: 'pm' }, { termId: 'a', activity: { state: 'busy', observedAt: now } }];
  assert.deepEqual(workOverviewRows(summary, terminals, now), workOverviewRows(board, terminals, now));
  for (const termId of ['a', 'b', 'pm']) assert.deepEqual(getSessionActivity({ termId, board: summary, now }), getSessionActivity({ termId, board, now }));
  assert.equal(summary.supervisors[0].reports.length, 1);
  assert.ok(JSON.stringify(summary).length < 3000);
  assert.equal(JSON.stringify(board), before);
  assert.equal(summary.review, undefined);
});
