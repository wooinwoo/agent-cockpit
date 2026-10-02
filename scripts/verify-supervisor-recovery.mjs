// Isolated process-lifecycle check: this creates a fake CLI, never a real AI session.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import pty from 'node-pty';
import { ensureDurableTerminal, durableTerminalExists, durableTerminalProcess, restartDurableAgent, killDurableTerminal } from '../lib/durable-terminal.js';
import { detectTerminalAgent } from '../lib/process-agent.js';
import { createBoardService } from '../lib/board-service.js';
import { createBoardReviewer } from '../lib/board-review.js';

const directory = mkdtempSync('/tmp/cockpit-recovery-proof-');
const id = randomBytes(12).toString('hex');
const entry = { durableId: id, pty: { pid: 1, write: message => messages.push(message) } };
const messages = [];
const isolatedEnv = { ...process.env, PATH: `${directory}:/usr/bin:/bin`, SHELL: '/bin/sh', TERM: 'xterm-256color' };
const isolatedExec = (file, args, options) => execFileSync(file, args, { ...options, env: isolatedEnv });
let created = false;
const attachments = [];
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await delay(50); }
  throw new Error('Timed out waiting for the isolated process');
}
function assertFakeAgent() {
  const queue = [durableTerminalProcess(id).pid];
  while (queue.length) {
    const pid = queue.shift();
    if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(`${directory}/codex`)) return;
    queue.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
  }
  throw new Error('Test isolation failed: the running CLI is not the temporary fake agent');
}
try {
  writeFileSync(`${directory}/codex`, `#!/usr/bin/python3\nimport sys, signal\nsignal.alarm(120)\nfor line in sys.stdin:\n with open(${JSON.stringify(`${directory}/received.txt`)}, "a") as output: output.write(line)\n`, { mode: 0o755 });
  ensureDurableTerminal({ id, cwd: directory, env: isolatedEnv });
  created = true;
  // tmux's default login shell reads /etc/profile and overwrites the test PATH.
  // A private non-login shell keeps all restarts on the fake executable.
  isolatedExec('/usr/bin/tmux', ['-L', `cockpit-${id}`, 'respawn-pane', '-k', '-t', 'main', `exec /usr/bin/env PATH=${directory}:/usr/bin:/bin /bin/sh`], { timeout: 1000 });
  await delay(200);
  const tmuxPid = Number(execFileSync('/usr/bin/tmux', ['-L', `cockpit-${id}`, 'display-message', '-p', '#{pid}'], { encoding: 'utf8', timeout: 1000 }).trim());
  process.kill(tmuxPid, 'SIGSTOP');
  try {
    // A separate process bounds the regression check even before the fix.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { durableTerminalExists, durableTerminalCwd } from ${JSON.stringify(new URL('../lib/durable-terminal.js', import.meta.url).href)};
      console.log(JSON.stringify([durableTerminalExists(process.argv[1]), durableTerminalCwd(process.argv[1])]));
    `, id], { encoding: 'utf8', timeout: 4000 });
    assert.equal(probe.status, 0, 'A suspended tmux server must not block Cockpit indefinitely');
    assert.deepEqual(JSON.parse(probe.stdout), [false, '']);
  } finally { process.kill(tmuxPid, 'SIGCONT'); }
  restartDurableAgent(id, 'codex', { exec: isolatedExec });
  await until(() => detectTerminalAgent(entry).kind === 'codex');
  assertFakeAgent();
  const firstPid = durableTerminalProcess(id).pid;
  assert.throws(() => restartDurableAgent(id, 'codex', { exec: isolatedExec }), /실행 중/);
  assert.equal(durableTerminalProcess(id).pid, firstPid);
  const service = createBoardService(`${directory}/board.json`);
  service.updateBoardReview({ termId: 'manager', autoRecover: true, objective: '보존된 목표', watched: [{ termId: 'worker', goal: '테스트 통과' }] });
  let time = Date.now();
  let recoveries = 0;
  const tick = createBoardReviewer({ ...service, now: () => time, resolveTerminalRef: () => ({ id: 'manager', entry }),
    terminalAgent: () => { const result = detectTerminalAgent(entry); return result.available ? result.kind || '' : null; },
    recoverSupervisor: (_review, { interrupt = false } = {}) => { restartDurableAgent(id, 'codex', { allowRunning: interrupt, exec: isolatedExec }); recoveries++; } });
  tick();
  service.reportBoardReview(service.getBoard().review.pendingSince, { report: '종료 전 작업 기록' });
  process.kill(firstPid, 'SIGKILL');
  await until(() => durableTerminalProcess(id)?.dead);
  tick(); tick(); assert.equal(recoveries, 1, service.getBoard().review.lastError);
  await until(() => detectTerminalAgent(entry).kind === 'codex');
  assertFakeAgent();
  assert.notEqual(durableTerminalProcess(id).pid, firstPid);
  time = service.getBoard().review.recoveryAfter;
  tick();
  assert.equal(messages.length, 2);
  assert.match(messages[1], /보존된 목표/);
  assert.equal(createBoardService(`${directory}/board.json`).getBoard().review.reports[0].text, '종료 전 작업 기록');
  const stalledPid = durableTerminalProcess(id).pid;
  service.updateBoardReview({ stallMinutes: 5 });
  time += 300_000; tick();
  assert.equal(recoveries, 2);
  await until(() => detectTerminalAgent(entry).kind === 'codex');
  assertFakeAgent();
  assert.notEqual(durableTerminalProcess(id).pid, stalledPid);
  assert.equal(service.getBoard().review.reports.at(-1).status, 'interrupted');

  // Run the actual startup/restore functions with real PTYs and the isolated
  // checkpoint. The HTTP server and unrelated application services stay out.
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const restore = source.slice(source.indexOf('function tryRestoreTerminal('), source.indexOf('// 프로젝트 등록/account 복구'));
  const startup = source.slice(source.indexOf('// An opted-in supervisor must resume'), source.indexOf("  logger.info('server', `Claude Code Dashboard"));
  const checkpoint = `${directory}/session-state.json`;
  writeFileSync(checkpoint, JSON.stringify({ terminals: [{ termId: 'manager', projectId: '__home__', durableId: id, command: 'codex', cwd: directory, supervisor: true }] }));
  const beforeRestorePid = durableTerminalProcess(id).pid;
  for (const autoRecover of [false, true]) {
    service.updateBoardReview({ autoRecover, status: 'running', recoveryAfter: 0, nextDueAt: 0, pendingSince: 0, cycleStartedAt: 0 });
    const restored = new Map();
    let checkpoints = 0;
    runInNewContext(`${restore}\n${startup}`, {
      ...service, terminals: restored, deferredTerminalRestores: [], _terminalsRestored: false,
      DURABLE_TERMINALS: true, durableTerminalExists, IS_WIN: false, existsSync, homedir: () => directory,
      loadTerminalState: () => JSON.parse(readFileSync(checkpoint, 'utf8')),
      saveTerminalStateNow: () => { checkpoints++; }, saveTerminalState() {},
      terminalSpawnSpec: (_termId, cwd, _account, durableId) => ({ ...ensureDurableTerminal({ id: durableId, cwd, env: isolatedEnv }), durableId }),
      pty, wss: { clients: [] }, bufAppend(terminal, data) { terminal._bufArr.push(data); }, nextTerminalAlias: () => 'ai8', setTimeout, randomBytes,
      logger: { info() {}, warn(message, detail) { throw new Error(`${message}: ${detail}`); }, error(message, detail) { throw new Error(`${message}: ${detail}`); } },
    });
    assert.equal(checkpoints, 1);
    assert.equal(restored.size, 1);
    attachments.push(restored.get('manager').pty);
    await until(() => restored.get('manager')._bufArr.length > 0);
    assert.equal(durableTerminalProcess(id).pid, beforeRestorePid, 'Restoring must not launch a duplicate AI');
    const restoredService = createBoardService(`${directory}/board.json`);
    const restoredTick = createBoardReviewer({ ...restoredService, now: () => time,
      resolveTerminalRef: ref => ref === 'manager' ? { id: ref, entry: restored.get(ref) } : null,
      terminalAgent: terminal => detectTerminalAgent(terminal).kind || '' });
    restoredTick();
    const pending = restoredService.getBoard().review.pendingSince;
    assert.ok(pending, JSON.stringify({ review: restoredService.getBoard().review, agent: detectTerminalAgent(restored.get('manager')) }));
    try {
      await until(() => existsSync(`${directory}/received.txt`) && readFileSync(`${directory}/received.txt`, 'utf8').includes('보존된 목표'));
    } catch (error) {
      throw new Error(JSON.stringify({ message: error.message, output: restored.get('manager')._bufArr.join('').slice(-3000),
        received: existsSync(`${directory}/received.txt`) ? readFileSync(`${directory}/received.txt`, 'utf8').slice(-3000) : null }));
    }
    restoredService.reportBoardReview(pending, { status: 'waiting', report: `재접속 없이 점검 재개: autoRecover=${autoRecover}` });
    assert.match(createBoardService(`${directory}/board.json`).getBoard().review.reports.at(-1).text, /재접속 없이/);
    attachments.pop().kill();
  }
  service.updateBoardReview({ status: 'stopped' });
  process.kill(durableTerminalProcess(id).pid, 'SIGKILL');
  await until(() => durableTerminalProcess(id)?.dead);
  time += 600_000; tick(); assert.equal(recoveries, 2);
  console.log('PASS: bounded suspended-tmux queries, real tmux discovery, dead/stalled recovery, headless checkpoint restore with real PTYs, persisted mission/report, explicit stop');
} finally {
  for (const attachment of attachments) { try { attachment.kill(); } catch {} }
  if (created) killDurableTerminal(id);
  rmSync(directory, { recursive: true, force: true });
}
