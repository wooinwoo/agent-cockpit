import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Real private PTYs run tiny fake agents. No message reaches a user AI session.
export async function verifyControlTerminals({ api, check, monitor, until, observed, id, alias, directory }) {
  const send = (method, route, body) => api(`/api/board/${route}`, { method,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const read = async () => (await api('/api/board')).data;
  const settings = worker => ({ objective: worker.objective, goal: worker.goal, priority: worker.priority, paused: worker.paused });
  const configured = await send('PUT', 'review', { target: '', intervalMinutes: 2, watched: [{ target: alias, goal: '완료 검증' }] });
  check(configured.status, 200, 'Assign a live worker using its alias');
  check(configured.data.review.watched[0].termId, id, 'Assignment stores fixed ID');
  check(configured.data.review.workerProgress[0].goal, '완료 검증', 'Assignment initializes worker progress');
  check(configured.data.review.workerProgress[0].run.status, 'ready', 'Configuration response includes normalized run defaults');
  check((await send('PATCH', 'worker-dispatch', { mode: 'running', expected: 'linked' })).status, 200, 'Enable independent worker dispatch');
  let board = await read();
  const original = settings(board.review.watched[0]);
  board.review.workerProgress[0].evidence = '검증 영수증';
  board.review.workerProgress[0].run.token = 'fixture-active-token';
  board.review.pendingSince = 444;
  board.supervisors[0] = board.review;
  await writeFile(join(directory, '.cockpit-board.json'), JSON.stringify(board));
  const priority = await send('PATCH', 'worker-settings', { termId: id, expected: original, settings: { ...original, priority: 1, paused: true } });
  check(priority.status, 200, 'Priority and pause update');
  check(priority.data.review.workerProgress[0].evidence, '검증 영수증', 'Priority change preserves evidence');
  check(priority.data.review.workerProgress[0].run.token, 'fixture-active-token', 'Priority change preserves assignment token');
  check(priority.data.review.pendingSince, 0, 'Settings change invalidates outstanding supervisor claim');
  check((await send('PATCH', 'worker-settings', { termId: id, expected: original, settings: original })).status, 409, 'Stale worker settings rejected');
  board = await read();
  const current = settings(board.review.watched[0]);
  const reassigned = await send('PATCH', 'worker-settings', { termId: id, expected: current, settings: { ...current, objective: '새 본업' } });
  check(reassigned.status, 200, 'Change worker objective');
  check(reassigned.data.review.workerProgress[0].run.token, '', 'Reassignment response includes revoked token');
  board = await read();
  check(board.review.workerProgress[0].evidence, '', 'Changed objective cannot inherit old evidence');
  check(board.review.workerProgress[0].run.token, '', 'Changed objective revokes old token');
  check((await send('PUT', 'review', { target: id })).status, 400, 'Worker cannot supervise itself');
  const added = await send('POST', 'supervisors', { name: '두 번째 감독' });
  const second = added.data.supervisor.id;
  const assign = { supervisorId: second, termId: id, expected: null,
    settings: { objective: '별도 본업', goal: '별도 검증', priority: 2, paused: false } };
  check((await send('PATCH', 'worker-settings', assign)).status, 200, 'Stopped secondary manager may prepare an inactive assignment');
  check((await send('PATCH', 'worker-dispatch', { supervisorId: second, mode: 'running', expected: 'linked' })).status, 400, 'Active ownership excludes a second dispatcher');
  check((await send('PATCH', 'worker-dispatch', { mode: 'paused', expected: 'running' })).status, 200, 'Pause original dispatcher');
  check((await send('PATCH', 'worker-dispatch', { supervisorId: second, mode: 'running', expected: 'linked' })).status, 200, 'Released worker can move to another dispatcher');
  check((await send('PATCH', 'worker-dispatch', { supervisorId: second, mode: 'paused', expected: 'running' })).status, 200, 'Pause secondary dispatcher');
  const cursor = monitor.messages.length;
  monitor.send({ type: 'create', projectId: 'sample', command: 'claude --dangerously-skip-permissions', cols: 100, rows: 30 });
  const manager = await until(() => monitor.messages.slice(cursor).find(message => message.type === 'created'), 'Fixture supervisor');
  try {
    await observed(manager.termId, 'idle');
    const overnight = await send('PUT', 'review', { target: manager.alias, intervalMinutes: 2,
      autoRecover: true, stallMinutes: 5, runHours: 1, watched: [{ target: id, goal: '야간 완료' }] });
    check(overnight.status, 200, 'Known unattended launcher can save recovery settings');
    check(overnight.data.review.termId, manager.termId, 'Supervisor alias resolves to fixed ID');
    check(overnight.data.review.recoveryTerminal.termId, manager.termId, 'Recovery snapshot belongs to selected terminal');
    check(overnight.data.review.recoveryTerminal.command, 'claude --dangerously-skip-permissions', 'Recovery retains exact permission preset');
    check(/^[a-f0-9]{24}$/.test(overnight.data.review.recoveryTerminal.durableId), true, 'Recovery retains private tmux identity');
    check(overnight.data.review.runUntil > Date.now() + 3_500_000, true, 'Night deadline persisted');
    check((await send('PUT', 'review', { target: manager.termId, autoRecover: false, runHours: 1, stallMinutes: 0 })).status, 400, 'Night operation requires recovery and report deadline');
    check((await send('PUT', 'review', { target: id, watched: [], autoRecover: true, runHours: 0, stallMinutes: 5 })).status, 400, 'Wrapped launcher cannot silently become a recoverable preset');
    check((await send('PUT', 'review', { target: '', watched: [], autoRecover: false })).status, 200, 'Stop fixture supervisor');
  } finally {
    monitor.send({ type: 'kill', termId: manager.termId });
    await monitor.wait(message => message.type === 'exit' && message.termId === manager.termId);
  }
  const manualCursor = monitor.messages.length;
  monitor.send({ type: 'create', projectId: 'sample', command: '', cols: 100, rows: 30 });
  const manual = await until(() => monitor.messages.slice(manualCursor).find(message => message.type === 'created'), 'Manual agent terminal');
  try {
    for (const agent of ['claude', 'codex', 'jcode']) {
      const requestId = `manual-${agent}-start`;
      monitor.send({ type: 'input', termId: manual.termId, data: `${agent}\r`, requestId });
      check((await monitor.wait(message => message.requestId === requestId)).accepted, true, 'Start manual fixture agent');
      await observed(manual.termId, 'idle');
      const recovery = await send('PUT', 'review', { target: manual.termId, watched: [], autoRecover: true, runHours: 0, stallMinutes: 5 });
      check(recovery.status, 200, 'Manually started agent supports recovery settings');
      check(recovery.data.review.recoveryTerminal.command, agent === 'codex' ? 'codex --no-daemon' : agent, 'Manual agent recovery uses default permissions only');
      check((await send('PUT', 'review', { target: manual.termId, runHours: 1 })).status, 400, 'Manual process kind cannot prove unattended permissions');
      check((await send('PUT', 'review', { target: '', watched: [], autoRecover: false })).status, 200, 'Stop manual agent supervision');
      monitor.send({ type: 'input', termId: manual.termId, data: 'q\r', requestId: `manual-${agent}-exit` });
      await observed(manual.termId, 'offline');
    }
  } finally {
    monitor.send({ type: 'kill', termId: manual.termId });
    await monitor.wait(message => message.type === 'exit' && message.termId === manual.termId);
  }
}
