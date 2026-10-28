import test from 'node:test';
import assert from 'node:assert/strict';
import { supervisorWatchDecision } from '../../scripts/watch-supervisor.mjs';

test('daily watch nudges only its assigned idle supervisor and respects reports, drafts, approvals, pauses and deadlines', () => {
  const now = 1000000;
  const review = { termId: 'manager', status: 'running', lastReviewedAt: 1 };
  const terminal = { activity: { state: 'idle', observedAt: now } };
  const decide = (r = review, t = terminal, last = 0) => supervisorWatchDecision(r, t, 'manager', now, last);
  assert.equal(decide(), 'nudge');
  assert.equal(decide(review, terminal, now - 1000), 'cooldown');
  assert.equal(decide({ ...review, lastReviewedAt: now - 1000 }), 'cooldown');
  assert.equal(decide({ ...review, pendingSince: now - 1000 }), 'cooldown');
  for (const status of ['stopped', 'complete']) assert.equal(decide({ ...review, status }), 'inactive');
  assert.equal(decide({ ...review, runUntil: now }), 'inactive');
  assert.equal(decide({ ...review, termId: 'replacement' }), 'inactive');
  assert.equal(decide(review, { ...terminal, conversationHeld: true }), 'conversation-held');
  assert.equal(decide(review, null), 'offline');
  for (const state of ['busy', 'approval', 'unknown', 'paused', 'limited', 'goal-blocked', 'offline']) {
    assert.equal(decide(review, { activity: { state, observedAt: now } }), state);
  }
  assert.equal(decide(review, { activity: { state: 'idle', observedAt: now - 15001 } }), 'stale-observation');
});
