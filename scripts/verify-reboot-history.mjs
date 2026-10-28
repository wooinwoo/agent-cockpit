// Isolated server and plain shell only. No user AI, credentials, or tmux sockets.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { createBoardService } from '../lib/board-service.js';
import { exportRecovery } from '../lib/recovery-history.js';

const fixture = await startPortfolioServer({ durable: false });
let socket;
try {
  socket = new WebSocket(fixture.url.replace('http:', 'ws:'), { origin: fixture.url });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'create', projectId: 'sample', cols: 100, rows: 28 }));
  let terminal;
  for (let attempt = 0; attempt < 100; attempt++) {
    terminal = (await (await fetch(`${fixture.url}/api/terminals`)).json()).terminals[0];
    if (terminal) break;
    await delay(100);
  }
  assert.ok(terminal?.termId);
  const data = `${fixture.directory}/data/cockpit`;
  const service = createBoardService(`${data}/.cockpit-board.json`);
  service.updateBoardReview({ status: 'stopped', workerDispatch: 'running', objective: '저장된 전체 목표',
    watched: [{ termId: terminal.termId, alias: 'ai1', goal: '재부팅 후 이어갈 조건', priority: 1, paused: true }] });
  service.addBoardTask('완료된 단계', undefined, 'task', 'user', 'S-0001', terminal.termId);
  const task = service.getBoard().tasks[0]; service.updateBoardTask(task.id, { done: true });
  await fixture.stop(); socket.close(); socket = null;
  const state = await fixture.checkpoint();
  assert.equal(state.terminals[0].termId, terminal.termId);
  // A real server restart with no surviving durable terminal, after a week offline.
  state.timestamp = Date.now() - 7 * 86400000;
  await writeFile(`${data}/session-state.json`, JSON.stringify(state));
  await fixture.start();
  const restored = (await (await fetch(`${fixture.url}/api/terminals`)).json()).terminals;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].termId, terminal.termId);
  const board = await (await fetch(`${fixture.url}/api/board`)).json();
  assert.equal(board.review.watched[0].paused, true);
  assert.equal(board.review.watched[0].priority, 1);
  assert.equal(board.review.watched[0].goal, '재부팅 후 이어갈 조건');
  assert.equal(board.tasks[0].done, true);
  const snapshot = JSON.parse(await readFile(`${data}/recovery-history/latest.json`));
  assert.equal(snapshot.sessionState.terminals[0].termId, terminal.termId);
  assert.equal(snapshot.board.tasks[0].done, true);
  const output = exportRecovery(`${data}/recovery-history/latest.json`, `${fixture.directory}/exported`);
  assert.equal(JSON.parse(await readFile(`${output}/.cockpit-board.json`)).tasks[0].done, true);
  assert.match(await readFile(`${data}/recovery-history/작업요약.txt`, 'utf8'), /재부팅 후 이어갈 조건/);
  console.log(JSON.stringify({ coldRestart: true, headlessRestore: true, fixedIdPreserved: true,
    pauseAndPriorityPreserved: true, completedChecklistPreserved: true, historyExport: true }));
} finally { socket?.close(); await fixture.cleanup(); }
