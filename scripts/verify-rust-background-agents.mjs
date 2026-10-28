// Private end-to-end coverage for headless monitoring, review reports and schedules.
// All providers, projects, Telegram traffic and terminal processes belong to this fixture.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { prepareTelegramChecks, cleanupTelegramChecks } from '../tests/helpers/rust-telegram-checks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = join(root, 'docs/_local/rust-background-agents-verification.json');
const report = { status: 'running', checkedAt: new Date().toISOString(), assertions: 0, backgroundAgentsIntegrated: false, productionReady: false };
await mkdir(join(root, 'docs/_local'), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.assertions++; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await pause(25); }
  throw new Error(message);
}
async function request(base, path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
let fixture, runtime, socket, streamAbort, streamDone;
const events = [], messages = [];
const api = (path, body, method) => request(runtime.url, path, body, method);
async function subscribe() {
  streamAbort = new AbortController();
  const response = await fetch(runtime.url + '/api/events', { signal: streamAbort.signal });
  check(response.status, 200, 'Monitor SSE connected');
  streamDone = (async () => {
    let pending = ''; const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const name = /^event:\s*(.+)$/m.exec(block)?.[1], data = /^data:\s*(.+)$/m.exec(block)?.[1];
        if (name && data) events.push({ name, data: JSON.parse(data) });
      }
    }
  })().catch(error => { if (!streamAbort.signal.aborted) throw error; });
}
async function stopStream() { streamAbort?.abort(); await streamDone; }
try {
  fixture = await startPortfolioServer({ durable: false });
  const sandbox = join(fixture.directory, 'rust'), bin = join(fixture.directory, 'bin');
  const callsPath = join(fixture.directory, 'provider-calls.jsonl');
  const controlPath = join(fixture.directory, 'provider-mode');
  const ghCallsPath = join(fixture.directory, 'ci-calls.jsonl');
  const ghControlPath = join(fixture.directory, 'ci-mode');
  const ghResultPath = join(fixture.directory, 'ci-result.json');
  const reportFile = join(sandbox, 'monitor-reports.json');
  const scheduleFile = join(sandbox, 'logs/scheduled-tasks.json');
  await mkdir(bin);
  await writeFile(callsPath, ''); await writeFile(ghCallsPath, '');
  await writeFile(controlPath, 'done'); await writeFile(ghControlPath, 'done');
  await writeFile(ghResultPath, JSON.stringify([{ databaseId: 42, headBranch: 'fixture-branch', url: 'https://example.invalid/runs/42', name: 'Private build', conclusion: 'failure' }]));
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({pid:process.pid,prompt,args:process.argv.slice(2)})+'\\n');
  const timer = setInterval(() => {
    if (fs.readFileSync(${JSON.stringify(controlPath)}, 'utf8') === 'hold') return;
    clearInterval(timer); console.log(JSON.stringify({type:'result',result:'격리 검토 완료'}));
  }, 20);
});
`, { mode: 0o700 });
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(ghCallsPath)}, JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');
const timer = setInterval(() => {
  if (fs.readFileSync(${JSON.stringify(ghControlPath)}, 'utf8') === 'hold') return;
  clearInterval(timer); console.log(fs.readFileSync(${JSON.stringify(ghResultPath)}, 'utf8'));
}, 20);
`, { mode: 0o700 });
  fixture.env.PATH = bin + ':' + fixture.env.PATH;
  Object.assign(fixture.env, { COCKPIT_PREVIEW_BACKGROUND_AGENTS: '1', COCKPIT_PREVIEW_MONITOR_FIRST_MS: '100', COCKPIT_PREVIEW_MONITOR_INTERVAL_MS: '100', COCKPIT_PREVIEW_AUTONOMY_FIRST_MS: '100', COCKPIT_PREVIEW_AUTONOMY_INTERVAL_MS: '100' });
  await prepareTelegramChecks({ fixture });
  const start = () => startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  const calls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const ciCalls = async () => (await readFile(ghCallsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const git = args => execFileSync('/usr/bin/git', args, { cwd: fixture.project, env: fixture.env, stdio: 'ignore' });
  const commit = message => { git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message]); };
  runtime = await start();
  for (const [path, body] of [
    ['/api/agent/alerts'], ['/api/agent/reports'], ['/api/agent/alerts/dismiss', {}],
    ['/api/agent/alerts/dismiss', { alertId: 'missing' }], ['/api/agent/alerts/clear', {}],
    ['/api/agent/reports/dismiss', {}], ['/api/agent/reports/dismiss', { reportId: 'missing' }],
    ['/api/agent/alerts/act', {}], ['/api/agent/alerts/act', { alertId: 'missing', convId: 'test', prompt: 'no key' }],
  ]) check(await api(path, body), await request(fixture.url, path, body), `Original monitor route contract ${path}`);
  await runtime.stop(); await fixture.stop();
  await writeFile(join(sandbox, 'projects.json'), await readFile(join(fixture.directory, 'data/cockpit/projects.json')));
  runtime = await start();
  // No browser or SSE subscriber exists during the first review.
  await pause(400);
  commit('feat: 무인 감시 첫 변경');
  await until(async () => (await api('/api/agent/alerts')).data.some(a => a.source === 'git'), 'Headless Git change detected');
  check((await api('/api/agent/conversations')).data.length, 0, 'No key creates no empty review history');
  check((await calls()).length, 0, 'No key starts no provider');
  await api('/api/ai/config', { geminiApiKey: 'private-fixture-key' });
  await api('/api/agent/model', { model: 'dev_gwajang' });
  await api('/api/agent/alerts/clear', {});
  commit('feat: 무인 검토 두 번째 변경');
  const first = await until(async () => (await api('/api/agent/reports')).data.find(r => r.status === 'done'), 'Headless Git review stores a completed report');
  check(first.content, '격리 검토 완료', 'Report captures actual private model output');
  check((await api(`/api/agent/conversations/${first.convId}`)).data.messages.at(-1).content, first.content, 'Report refers to actual conversation');
  check((await stat(reportFile)).mode & 0o777, 0o600, 'Report storage is private');
  check((await calls()).length, 1, 'One change starts one provider');
  check((await calls())[0].args.includes('--no-session-persistence'), true, 'Background reviewer uses isolated native transport');
  await pause(350);
  check((await calls()).length, 1, 'Polling does not repeat the same review');
  const alert = (await api('/api/agent/alerts')).data.find(a => a.source === 'git');
  check(Boolean(alert), true, 'Review still exposes the triggering alert');
  check((await api('/api/agent/alerts/act', { alertId: alert.id, convId: 'alert-action', prompt: 'Private alert action' })).data, { status: 'started' }, 'Alert action starts actual agent job');
  await until(async () => (await api('/api/agent/conversations/alert-action')).data.messages?.at(-1)?.content === '격리 검토 완료', 'Alert action completes');
  check((await api('/api/agent/alerts')).data.some(a => a.id === alert.id), false, 'Action dismisses its alert');
  check((await api('/api/agent/reports/dismiss', { reportId: first.id })).data, { dismissed: true }, 'Report dismissed');
  check((await api('/api/agent/reports')).data.some(r => r.id === first.id), false, 'Dismissed report hidden');
  const saved = await readFile(reportFile);
  await writeFile(reportFile, '{broken');
  check((await api('/api/agent/reports')).status, 500, 'Corrupt report file surfaces an error');
  check((await api('/api/agent/reports/dismiss', { reportId: first.id })).status, 500, 'Corrupt report file cannot be overwritten');
  check(await readFile(reportFile, 'utf8'), '{broken', 'Corrupt report bytes preserved');
  await writeFile(reportFile, saved);
  const outside = join(fixture.directory, 'outside-reports.json'); await writeFile(outside, saved);
  await unlink(reportFile); await symlink(outside, reportFile);
  check((await api('/api/agent/reports')).status, 500, 'Report symlink rejected');
  check(await readFile(outside), saved, 'Report symlink target unchanged');
  await unlink(reportFile); await writeFile(reportFile, saved, { mode: 0o600 });
  await runtime.stop(); runtime = await start();
  check((await api('/api/agent/reports')).data.some(r => r.id === first.id), false, 'Report dismissal survives restart');
  check(JSON.parse(await readFile(reportFile, 'utf8')).some(r => r.id === first.id && r.dismissed), true, 'Dismissed history retained on disk');
  await api('/api/agent/model', { model: 'dev_gwajang' });
  await subscribe();
  await writeFile(ghControlPath, 'hold');
  check((await api('/api/projects/sample', { github: 'fixture/private' }, 'PUT')).status, 200, 'Enable CI through the actual project API');
  await until(async () => (await ciCalls()).some(call => call.args[0] === 'run'), 'Private CI request starts');
  socket = new WebSocket(runtime.url.replace('http:', 'ws:'));
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'create', projectId: 'sample', command: '', cols: 100, rows: 30 }));
  const terminal = await until(() => messages.find(m => m.type === 'created'), 'Private terminal created');
  socket.send(JSON.stringify({ type: 'input', termId: terminal.termId, data: "printf 'ENOENT: private missing file\\n'\r", requestId: 'monitor-error' }));
  const terminalAlert = await until(async () => (await api('/api/agent/alerts')).data.find(a => a.source === 'terminal'), 'Terminal alert remains live while CI is blocked');
  check(terminalAlert.context.termId, terminal.termId, 'Terminal alert identifies the actual session');
  await until(() => events.some(e => e.name === 'agent:proactive' && e.data.id === terminalAlert.id), 'Terminal alert reaches SSE');
  await pause(300); commit('feat: 원격 CI 대기 중 로컬 변경');
  const second = await until(async () => (await api('/api/agent/reports')).data.find(r => r.status === 'done'), 'Blocked CI does not postpone Git review');
  check(events.some(e => e.name === 'monitor:review-start' && e.data.convId === second.convId), true, 'Review start reaches SSE');
  await until(() => events.some(e => e.name === 'monitor:report' && e.data.id === second.id), 'Completed report reaches SSE');
  check((await api('/api/agent/alerts/dismiss', { alertId: terminalAlert.id })).data, { dismissed: true }, 'Terminal alert dismissed');
  check((await api('/api/agent/alerts/dismiss', { alertId: terminalAlert.id })).data, { dismissed: false }, 'Dismissal is idempotent');
  await writeFile(ghControlPath, 'done');
  const ciAlert = await until(async () => (await api('/api/agent/alerts')).data.find(a => a.source === 'cicd'), 'Actual gh failure reaches monitor');
  check(ciAlert.context.runId, 42, 'CI monitor uses gh databaseId');
  check(ciAlert.context.branch, 'fixture-branch', 'CI monitor uses gh headBranch');
  check(ciAlert.context.url, 'https://example.invalid/runs/42', 'CI monitor preserves gh run link');
  socket.send(JSON.stringify({ type: 'kill', termId: terminal.termId }));
  await until(() => messages.some(m => m.type === 'exit' && m.termId === terminal.termId), 'Private terminal closed');
  socket.close(); await once(socket, 'close'); socket = undefined;

  await api('/api/telegram/config', { token: 'fixture-rust', chatId: 'private-chat', enabled: true });
  await mkdir(join(sandbox, 'logs'), { recursive: true });
  const scheduled = { id: 'private-schedule', pattern: 'every 1m', prompt: 'Private scheduled task', enabled: true, lastRun: null, createdAt: new Date().toISOString(), unknown: 'preserved' };
  const beforeSchedule = (await calls()).length;
  await writeFile(scheduleFile, JSON.stringify([scheduled]));
  await until(async () => (await calls()).length === beforeSchedule + 1, 'Due schedule starts without a browser action');
  await until(() => fixture.telegram.requests.some(r => r.method === 'sendMessage' && r.body.text === '격리 검토 완료'), 'Scheduled result is delivered to private Telegram');
  const persisted = JSON.parse(await readFile(scheduleFile, 'utf8'))[0];
  check(typeof persisted.lastRun, 'string', 'Scheduled lastRun is persisted');
  check(persisted.unknown, 'preserved', 'Schedule updates preserve unknown fields');
  check((await stat(scheduleFile)).mode & 0o777, 0o600, 'Scheduled storage is private');
  await pause(350); check((await calls()).length, beforeSchedule + 1, 'One due occurrence starts once');
  await writeFile(controlPath, 'hold');
  await writeFile(scheduleFile, JSON.stringify([{ ...scheduled, lastRun: null }]));
  await until(async () => (await calls()).length === beforeSchedule + 2, 'Held scheduled request starts');
  // Reintroducing a due timestamp while the same task is in flight cannot duplicate it.
  await writeFile(scheduleFile, JSON.stringify([{ ...scheduled, lastRun: null }]));
  await pause(400); check((await calls()).length, beforeSchedule + 2, 'Active schedule lease prevents overlap');
  await writeFile(scheduleFile, JSON.stringify([{ ...scheduled, enabled: false, lastRun: new Date().toISOString() }]));
  const heldPid = (await calls()).at(-1).pid;
  await stopStream(); await runtime.stop();
  await until(() => { try { process.kill(heldPid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') throw error; return true; } }, 'Shutdown reaps the held scheduled provider');
  check((await calls()).length, beforeSchedule + 2, 'Shutdown starts no additional model work');
  await writeFile(controlPath, 'done'); runtime = await start();
  await pause(350); check((await calls()).length, beforeSchedule + 2, 'Restart respects disabled schedules');
  check((await api('/api/agent/reports')).data.some(r => r.id === second.id && r.content === '격리 검토 완료'), true, 'Completed reports survive restart');
  await api('/api/agent/model', { model: 'dev_gwajang' });
  const beforeBurst = (await calls()).length;
  await writeFile(controlPath, 'hold');
  const burst = Array.from({ length: 6 }, (_, index) => ({ ...scheduled, id: `burst-${index}`, prompt: `Private queued task ${index}` }));
  await writeFile(scheduleFile, JSON.stringify(burst));
  await until(async () => (await calls()).length === beforeBurst + 4, 'First four due tasks claim execution slots');
  await pause(350); check((await calls()).length, beforeBurst + 4, 'More than four providers cannot run concurrently');
  const queued = JSON.parse(await readFile(scheduleFile, 'utf8'));
  queued[5].enabled = false;
  await writeFile(scheduleFile, JSON.stringify(queued));
  await writeFile(controlPath, 'done');
  await until(async () => (await calls()).length === beforeBurst + 5, 'Fifth queued occurrence executes when a slot becomes free');
  await until(async () => JSON.parse(await readFile(scheduleFile, 'utf8'))[4].lastRun, 'Queued occurrence persists its actual start');
  await pause(350); check((await calls()).length, beforeBurst + 5, 'A disabled queued occurrence cannot start');
  check(events.some(e => e.name === 'monitor:report-error' || e.name === 'monitor:review-error'), false, 'Background run produced no hidden errors');
  report.backgroundAgentsIntegrated = true; report.status = 'passed';
} catch (error) {
  report.status = 'failed'; throw error;
} finally {
  socket?.terminate(); await stopStream(); await runtime?.stop();
  if (fixture) { await cleanupTelegramChecks(fixture); await fixture.cleanup(); }
  report.checkedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
