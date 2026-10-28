import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { workerScreenState } from '../../lib/board-workers.js';

// Isolate the actual server recovery boundary without starting a listener or
// restarting any process. The earlier scheduler observation can be outdated.
const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const start = server.indexOf('function recoverBoardSupervisor(');
const end = server.indexOf('\nconst agentScanTimer', start);
assert.ok(start >= 0 && end > start);

test('supervisor recovery rechecks the current composer before restarting a live process', () => {
  const review = { id: 'S-0001', termId: 'manager', recoveryTerminal: {
    termId: 'manager', durableId: 'fixture', command: 'codex --no-daemon',
  } };
  for (const [screen, permitted] of [
    [{ current: true, lines: ['Working (esc to interrupt)', '›'] }, true],
    [{ current: true, lines: ['Conversation interrupted', '›'] }, true],
    [{ current: true, lines: ['Conversation interrupted', '› 새 사용자 초안'] }, false],
    [{ current: true, lines: ['Working (esc to interrupt)', '› 새 사용자 초안'] }, false],
    [{ current: true, lines: ['Do you want to proceed?', '1. Yes', '2. No'] }, false],
    [{ current: false, lines: ['Working (esc to interrupt)', '›'] }, false],
  ]) {
    let restarts = 0;
    const entry = {};
    const recover = runInNewContext(`${server.slice(start, end)}\nrecoverBoardSupervisor`, {
      _shuttingDown: false, _terminalsRestored: true,
      getBoard: () => ({ review }), resolveTerminalRef: () => ({ entry }),
      validateRecoveryCommand: () => {}, terminalAgent: () => 'codex',
      readTerminalScreen: () => screen, workerScreenState,
      restartDurableAgent: () => { restarts++; },
    });
    if (permitted) recover(review, { interrupt: true });
    else assert.throws(() => recover(review, { interrupt: true }), /자동 복구를 보류/);
    assert.equal(restarts, permitted ? 1 : 0);
    assert.equal(Boolean(entry.restarting), false);
  }
});
