// Actual native long polling and owned agents; all messages and models stay private.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { prepareTelegramChecks, cleanupTelegramChecks } from '../tests/helpers/rust-telegram-checks.js';
import { original as originalText } from '../tests/helpers/rust-telegram-text-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = join(root, 'docs/_local/rust-telegram-commands-verification.json');
const report = { status: 'running', checkedAt: new Date().toISOString(), commandsIntegrated: false, productionReady: false,
  assertions: 0, commands: [], separatelyVerifiedBy: 'verify-rust-manager.mjs (managed restart and production log/diagnostic integration)', remaining: ['production handover', 'launcher and platform parity'], privateProviders: ['Gemini HTTP', 'Claude CLI'] };
await mkdir(join(root, 'docs/_local'), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.assertions++; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, message, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await predicate(); if (value) return value; await pause(20); }
  throw new Error(message);
}
async function request(base, path, body, extra = {}) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const text = await response.text(); let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
const final = message => JSON.stringify({ thinking: 'Private command verification', message, tool_calls: [], is_final: true });
const queue = [], calls = [], held = new Set(), unexpected = [];
const provider = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const call = { provider: req.url === '/claude' ? 'claude' : 'gemini', url: req.url,
    body: JSON.parse(Buffer.concat(chunks).toString()), closed: false };
  calls.push(call);
  res.on('close', () => { call.closed = true; held.delete(call); });
  call.release = answer => {
    if (res.destroyed || res.writableEnded) return;
    if (call.provider === 'claude') { res.writeHead(200); res.end(answer); return; }
    const body = { candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] };
    if (req.url.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify(body)}\n\n`);
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
  };
  const answer = queue.shift();
  if (answer === undefined) { unexpected.push(call.provider); res.writeHead(500); res.end('{}'); return; }
  if (answer === null) { held.add(call); return; }
  call.release(answer);
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
let fixture, runtime, sandbox, streamAbort, streamDone, activeChat = 'private-chat', messageId = 200;
const events = [];
async function subscribe() {
  streamAbort = new AbortController();
  const signal = streamAbort.signal;
  const response = await fetch(runtime.url + '/api/events', { signal });
  check(response.status, 200, 'Native SSE observes owned agent completion');
  streamDone = (async () => {
    let pending = ''; const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true }); let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const name = /^event:\s*(.+)$/m.exec(block)?.[1], data = /^data:\s*(.+)$/m.exec(block)?.[1];
        if (name && data) events.push({ name, data: JSON.parse(data) });
      }
    }
  })().catch(error => { if (!signal.aborted) throw error; });
}
async function stopStream() { streamAbort?.abort(); await streamDone; streamDone = undefined; }
const sentSince = index => fixture.telegram.requests.slice(index).filter(r => r.method === 'sendMessage');
function push(text, chat = activeChat) {
  fixture.telegram.push({ message: { message_id: messageId++, chat: { id: chat, type: 'private' }, text } });
}
async function command(text, expected, timeout = 6000, silent = true) {
  const before = fixture.telegram.requests.length;
  push(text);
  const response = await eventually(() => sentSince(before).find(r => typeof expected === 'string'
    ? r.body.text.includes(expected) : expected(r.body.text)), `No expected long-poll response for ${text}`, timeout);
  check(response.body.chat_id, activeChat, `Command reply belongs to configured chat: ${text}`);
  check(response.body.disable_notification, silent, `Command notification flag: ${text}`);
  report.commands.push(text.split(' ')[0]);
  return response.body;
}
async function configure(chat = activeChat, token = 'fixture-rust') {
  check((await request(runtime.url, '/api/telegram/config', { token, chatId: chat, enabled: true })).status, 200, 'Private Telegram configuration accepted');
  // The shared transport fixture deliberately returns a fixed startup offset.
  // Discard previously consumed test updates before starting a new generation.
  fixture.telegram.queue.length = 0;
  activeChat = chat;
  check((await request(runtime.url, '/api/telegram/start', {})).data, { ok: true, polling: true }, 'Private long poll started');
  await eventually(() => fixture.telegram.polls.size === 1, 'Exactly one private long poll');
}
async function waitDone(id, from) {
  await eventually(() => events.slice(from).some(e => e.name === 'agent:done' && e.data.convId === id), 'Agent completion event');
}
async function heldChat(label) {
  check(queue.length, 0, 'Previous scripted model responses consumed');
  const before = calls.length, from = events.length;
  queue.push(null); push(label);
  const call = await eventually(() => calls.slice(before).find(c => held.has(c)), 'Private model entered held response');
  const status = await command('/status', '대화 id:', 2000);
  const id = /대화 id: (.+)$/.exec(status.text)?.[1];
  check(Boolean(id && id !== '없음'), true, 'Held request has an actual conversation');
  check(call.closed, false, 'Status responds while provider remains pending');
  return { call, id, from };
}
function callback(chat, data, id = `callback-${messageId++}`) {
  return { callback_query: { id, data, message: { message_id: 42, chat: { id: chat, type: 'private' } } } };
}
try {
  fixture = await startPortfolioServer({ durable: false });
  await fixture.stop();
  await prepareTelegramChecks({ fixture });
  const base = `http://127.0.0.1:${provider.address().port}`, bin = join(fixture.directory, 'provider-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
const http = require('node:http');
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const body = JSON.stringify({ prompt, args: process.argv.slice(2), pid: process.pid });
  const req = http.request(${JSON.stringify(base + '/claude')}, {method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}}, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
    res.on('end', () => { if (res.statusCode !== 200) process.exit(1); console.log(JSON.stringify({type:'result',result:text})); });
  });
  req.on('error', () => process.exit(1)); req.end(body);
});
`, { mode: 0o700 });
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  fixture.env.PATH = bin + ':' + fixture.env.PATH;
  fixture.env.COCKPIT_PREVIEW_GEMINI_BASE = base;
  sandbox = join(fixture.directory, 'rust');
  const start = () => startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  runtime = await start(); await runtime.stop();
  await writeFile(join(sandbox, 'projects.json'), await readFile(join(fixture.directory, 'data/cockpit/projects.json')));
  runtime = await start(); await subscribe(); await configure();

  const source = await readFile(join(root, 'lib/telegram-bridge.js'), 'utf8');
  const sourceCommands = source.slice(source.indexOf('function cmdStatus()'), source.indexOf('function cmdNew()'));
  const original = vm.runInNewContext(sourceCommands + '\n({cmdStatus,cmdSetMode})', {
    _cockpit: { supervisor: { getMode: () => 'here', getPendingCount: () => 0, setMode: mode => mode } },
    getTrustState: () => ({ active: false }), listTodos: () => [], _focusedProject: null, _convId: null,
  }, { timeout: 1000 });
  check((await command('/help', 'Cockpit 봇')).text, originalText({ action: 'help' }), 'Help body exactly matches source fixture');
  check((await command('/status', 'Cockpit 상태')).text, original.cmdStatus(), 'Initial status exactly matches source fixture');
  for (const mode of ['away', 'here']) check((await command('/' + mode, '모드로 전환됨')).text, original.cmdSetMode(mode), `Mode command matches source: ${mode}`);
  await command('나 퇴근', 'AWAY 모드 전환됨'); await command('/status', 'AWAY (적극 ask)');
  await command('돌아왔어', 'HERE 모드 전환됨'); await command('/status', 'HERE (알림 최소)');
  await command('/focus sample <safe>', 'sample &lt;safe&gt;'); await command('/focus', '현재 focus');
  await command('/unfocus', 'focus 해제됨');
  const newReply = await command('/new', '새 대화 시작:');
  const initialId = newReply.text.split(': ').at(-1);
  check((await request(runtime.url, '/api/agent/conversations/' + initialId)).status, 200, 'New creates durable conversation');
  await command('/clear', '컨텍스트 초기화됨');
  await command('/history', '메시지 없음');
  await command('/find absent', '검색 결과 없음');
  await command('/projects', 'Sample Project'); await command('/terminals', '활성 터미널 없음');
  const company = await request(runtime.url, '/api/agent/company');
  check(company.status, 200, 'Company API supplies the command roster');
  check(Array.isArray(company.data.teams), true, 'Company teams are an array');
  const development = company.data.teams.find(team => team.id === 'dev');
  check(Boolean(development), true, 'Company includes the development team');
  check(company.data.agents.some(agent => agent.team === development.id), true, 'Development team has members');
  const roster = await command('/agents', '에이전트 목록');
  const html = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  for (const team of company.data.teams) {
    check(roster.text.includes(`<b>${html(team.name)}</b>`), true, `Agent command includes team ${team.id}`);
    for (const member of company.data.agents.filter(agent => agent.team === team.id)) {
      check(roster.text.includes(html(`${member.name}(${member.rank})`)), true, `Agent command includes member ${member.id}`);
    }
  }
  await command('/decisions', 'supervisor 결정 없음');
  await command('/approvals', '승인 audit 로그 없음'); await command('/log', '서버 로그 파일 없음');
  await command('/diag', text => text.includes('런타임: Rust') && text.includes('polling 중'));
  await command('/restart', text => text.includes('관리 실행기로 시작해야 합니다'));
  check((await request(runtime.url, '/api/telegram/status')).status, 200, 'Unmanaged Telegram restart leaves the server running');

  await command('/trust invalid', '사용법:'); await command('/trust 30m', '신뢰 모드');
  await command('/status', '신뢰: 🟢 ON');
  await request(runtime.url, '/api/autopilot/mode', { mode: 'unattended' });
  const decision = value => request(runtime.url, '/api/autopilot/decide', { tool: 'Bash', input: { command: value } });
  const trustStart = fixture.telegram.requests.length;
  check((await decision('git pull')).data.decision, 'approve', 'Trust permits eligible approval');
  check(sentSince(trustStart).some(r => r.body.reply_markup), false, 'Trusted non-hard operation does not ask');
  const hardStart = fixture.telegram.requests.length; let hardDone = false;
  const hardDecision = decision('git push origin main').then(value => { hardDone = true; return value; });
  const hard = await eventually(() => sentSince(hardStart).find(r => r.body.reply_markup), 'Trust must still request HARD approval');
  check(hard.body.text.includes('(HARD)'), true, 'Hard boundary visible during trust');
  const deny = hard.body.reply_markup.inline_keyboard[0][1].callback_data;
  fixture.telegram.push(callback('foreign-chat', deny)); await pause(150);
  check(hardDone, false, 'Foreign chat cannot resolve hard approval');
  fixture.telegram.push(callback(activeChat, deny));
  check((await hardDecision).data.decision, 'deny', 'Authorized denial is honored');
  await command('/approvals', '[HARD]');
  await command('/untrust', '신뢰 모드 OFF'); await command('/status', '신뢰: 🔴 OFF');
  const audit = (await readFile(join(sandbox, 'logs/approvals.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  check(audit.some(r => r.decision === 'trust-auto' && !r.hard), true, 'Trust leaves durable audit evidence');
  check(audit.some(r => r.decision === 'user-deny' && r.hard), true, 'Hard denial audit retained');
  const expiredStart = fixture.telegram.requests.length;
  fixture.telegram.push(callback(activeChat, 'dec:expired:y', 'expired-command'));
  await eventually(() => fixture.telegram.requests.slice(expiredStart).some(r => r.method === 'answerCallbackQuery'
    && r.body.callback_query_id === 'expired-command' && r.body.text.includes('만료')), 'Legacy expired decision callback is acknowledged');
  const foreignStart = fixture.telegram.requests.length;
  push('/todo add foreign task', 'foreign-chat');
  fixture.telegram.push(callback('foreign-chat', 'dec:expired:y', 'foreign-expired'));
  await pause(150);
  check(sentSince(foreignStart).length, 0, 'Foreign messages have no command effect or response');
  check(fixture.telegram.requests.slice(foreignStart).some(r => r.body.callback_query_id === 'foreign-expired'), false, 'Foreign callbacks are ignored');

  await command('/todo', '미완료 todo 없음'); await command('/todo add durable first 😀', '#1');
  await command('/todo add durable second', '#2'); await command('/todo done 1', '완료 처리 (#1)');
  await command('/todo done 999', '#999 todo 없음'); await command('/todo list', 'durable second');
  const todoPath = join(sandbox, 'logs/telegram-todos.jsonl');
  const todos = (await readFile(todoPath, 'utf8')).trim().split('\n').map(JSON.parse);
  check(todos.map(t => [t.id, t.status]), [[1, 'done'], [2, 'pending']], 'Todo commands write durable backlog');
  await command('/todo next', 'Gemini API key not configured');
  await command('/schedule add "every 999h" "private scheduled work"', '등록됨');
  const schedulePath = join(sandbox, 'logs/scheduled-tasks.json');
  const schedules = JSON.parse(await readFile(schedulePath, 'utf8'));
  const scheduleId = schedules[0].id;
  await command('/schedule list', 'private scheduled work');
  await command(`/schedule run ${scheduleId}`, 'Gemini API key not configured');
  check(calls.length, 0, 'Missing model configuration never claims model work');
  await command(`/schedule toggle ${scheduleId}`, '토글됨');
  check(JSON.parse(await readFile(schedulePath, 'utf8'))[0].enabled, false, 'Schedule toggle persisted');

  check((await request(runtime.url, '/api/ai/config', { geminiApiKey: 'private-command-key' })).status, 200, 'Synthetic model key configured');
  check((await request(runtime.url, '/api/agent/model', { model: 'auto' })).status, 200, 'Original automatic routing exercised');
  queue.push(JSON.stringify({ mode: 'solo', team: 'dev', complexity: 'low' }), final('private ordinary answer'));
  await command('private ordinary question', 'private ordinary answer', 10_000, false);
  check(calls[0].provider, 'gemini', 'Automatic routing first calls private Gemini');
  check(queue.length, 0, 'Routing and answer consumed both scripted responses');
  await request(runtime.url, '/api/agent/model', { model: 'daepyo' });
  const claudeStart = calls.length;
  queue.push(final('private todo answer'));
  await command('/todo next', 'private todo answer', 10_000, false);
  check(calls[claudeStart].provider, 'claude', 'Director profile uses private Claude CLI');
  check(calls[claudeStart].body.args.includes('claude-opus-4-6'), true, 'Claude receives selected director model');
  check(calls[claudeStart].body.prompt.includes('durable second'), true, 'Todo text reaches real native agent request');
  check(JSON.parse((await readFile(todoPath, 'utf8')).trim().split('\n')[1]).status, 'pending', 'Answer does not silently mark todo complete');
  await command('/history 4', 'private todo answer'); await command('/find ordinary', '검색 결과');
  await command('/schedule run nonexistent', '없음 또는 이미 실행 중');
  queue.push(final('private schedule answer'));
  await command(`/schedule run ${scheduleId}`, 'private schedule answer', 10_000, false);
  check(Boolean(JSON.parse(await readFile(schedulePath, 'utf8'))[0].lastRun), true, 'Manual disabled schedule execution records last run');

  // Hold A's handler at typing after admission. A completes, then B completes
  // in the same conversation before A is allowed to read its result.
  const rapidStart = fixture.telegram.requests.length, rapidEvents = events.length;
  const typingGate = fixture.telegram.holdNext('sendChatAction');
  queue.push(final('private rapid answer A')); push('private rapid request A');
  await eventually(() => typingGate.request, 'First rapid handler reached held typing request');
  const rapidStatus = await command('/status', '대화 id:');
  const rapidId = /대화 id: (.+)$/.exec(rapidStatus.text)?.[1];
  check(Boolean(rapidId && rapidId !== '없음'), true, 'Rapid turns have an actual conversation');
  await waitDone(rapidId, rapidEvents);
  check(sentSince(rapidStart).some(r => r.body.text === 'private rapid answer A'), false, 'First handler cannot deliver while typing is held');
  queue.push(final('private rapid answer B'));
  await command('private rapid request B', 'private rapid answer B', 10_000, false);
  check((await command('/status', '대화 id:')).text.includes(`대화 id: ${rapidId}`), true, 'Second rapid turn reuses the conversation');
  typingGate.release();
  await eventually(() => sentSince(rapidStart).some(r => r.body.text === 'private rapid answer A'), 'First turn retains its own answer after second turn completes');
  await pause(200);
  for (const answer of ['private rapid answer A', 'private rapid answer B']) {
    check(sentSince(rapidStart).filter(r => r.body.text === answer).length, 1, 'Each rapid turn delivers its own result exactly once');
  }

  for (const reset of ['/new', '/clear']) {
    const marker = `private-long-${reset.slice(1)}-`, longAnswer = marker + 'x'.repeat(8000) + '-tail';
    const firstChunk = fixture.telegram.holdNext('sendMessage', body => body.text?.startsWith(marker));
    const firstSend = fixture.telegram.requests.length;
    queue.push(final(longAnswer)); push(`private long answer before ${reset}`);
    await eventually(() => firstChunk.request, 'Long answer first chunk reached private Telegram');
    check(firstChunk.request.body.text.length < longAnswer.length, true, 'Held reply really has remaining chunks');
    await command(reset, reset === '/new' ? '새 대화 시작' : '컨텍스트 초기화됨');
    await eventually(() => firstChunk.closed, 'Reset cancels held first-chunk transport', 2000);
    firstChunk.release(); await pause(200);
    check(sentSince(firstSend).filter(r => r.body.text.includes('x'.repeat(100))).length, 1, 'Reset prevents every remaining chunk of the old answer');
    check(sentSince(firstSend).some(r => r.body.text.endsWith('-tail')), false, 'Old answer tail never reaches Telegram after reset');
  }

  for (const reset of ['/new', '/clear']) {
    const { call, id, from } = await heldChat(`private held ${reset}`);
    await command(reset, reset === '/new' ? '새 대화 시작' : '컨텍스트 초기화됨');
    check(call.closed, false, 'Conversation reset preserves the admitted model job');
    const before = fixture.telegram.requests.length;
    call.release(final(`obsolete reply ${reset}`)); await waitDone(id, from); await pause(200);
    check(sentSince(before).some(r => r.body.text.includes(`obsolete reply ${reset}`)), false, 'Reset suppresses previous conversation reply');
  }
  const replacement = await heldChat('private held configuration');
  await configure('replacement-chat', 'fixture-replacement');
  await eventually(() => replacement.call.closed, 'Configuration replacement closes old provider');
  await waitDone(replacement.id, replacement.from);
  const afterReplace = fixture.telegram.requests.length;
  replacement.call.release(final('obsolete configuration result'));
  await command('/status', '대화 id: 없음'); await pause(100);
  check(sentSince(afterReplace).some(r => r.body.text.includes('obsolete configuration result')), false, 'Old result never reaches replacement chat');
  queue.push(final('replacement answer')); await command('private replacement question', 'replacement answer', 10_000, false);

  const scheduleHoldStart = calls.length; queue.push(null);
  await command(`/schedule run ${scheduleId}`, '즉시 실행');
  const scheduledHold = await eventually(() => calls.slice(scheduleHoldStart).find(c => held.has(c)), 'Manual schedule model held');
  await command(`/schedule run ${scheduleId}`, '이미 실행 중');
  check(calls.length, scheduleHoldStart + 1, 'Duplicate manual run cannot create another provider');
  check((await request(runtime.url, '/api/telegram/stop', {})).data.polling, false, 'Stop joins long poll');
  await eventually(() => scheduledHold.closed && fixture.telegram.polls.size === 0, 'Stop cancels scheduled model and Telegram poll');
  await configure();
  const scheduleReplaceStart = calls.length; queue.push(null);
  await command(`/schedule run ${scheduleId}`, '즉시 실행');
  const scheduleReplacement = await eventually(() => calls.slice(scheduleReplaceStart).find(c => held.has(c)), 'Schedule lease released after stop');
  await configure('final-chat', 'fixture-final');
  await eventually(() => scheduleReplacement.closed, 'Configuration change cancels scheduled model');
  await command(`/schedule remove ${scheduleId}`, '제거됨'); await command('/schedule list', '스케줄 없음');
  await command('/schedule remove nonexistent', '없음');
  await command('/schedule add "every 999h" "durable schedule"', '등록됨');
  await writeFile(join(sandbox, 'logs/server.log'), 'private log line\nTOKEN=synthetic-value\n');
  const log = await command('/log 2', 'private log line');
  check(log.text.includes('synthetic-value'), false, 'Log output masks secrets before delivery');

  const stopping = await heldChat('private held stop');
  await request(runtime.url, '/api/telegram/stop', {});
  await eventually(() => stopping.call.closed && fixture.telegram.polls.size === 0, 'Stop cancels ordinary model and long poll');
  await waitDone(stopping.id, stopping.from); await configure();
  const shutdown = await heldChat('private held shutdown');
  await stopStream(); await runtime.stop();
  await eventually(() => shutdown.call.closed && held.size === 0 && fixture.telegram.polls.size === 0, 'Shutdown closes all private models and Telegram poll');
  fixture.telegram.queue.length = 0;
  runtime = await start(); await subscribe(); await configure();
  await command('/todo list', 'durable second'); await command('/schedule list', 'durable schedule');
  check((await request(runtime.url, '/api/agent/conversations/' + shutdown.id)).data.messages.some(m => m.role === 'user'), true, 'Accepted chat survives full native restart');
  check((await request(runtime.url, '/api/agent/stop', { convId: shutdown.id })).data.stopped, false, 'Restart does not invent a running agent');

  // Supervisor reads its model key at startup. This restart makes the synthetic
  // key available before asking; no application-only test route is needed.
  await command('/away', 'AWAY 모드로 전환됨');
  const askCalls = calls.length, askSends = fixture.telegram.requests.length;
  queue.push(JSON.stringify({ decision: 'ask', reasoning: 'Private presence priority', ask_message: 'private pending presence question' }));
  let askSettled = false;
  const asking = request(runtime.url, '/api/supervisor/decide', { tool: 'Unknown', input: { command: 'private presence fixture' } })
    .then(value => { askSettled = true; return { value }; }, error => { askSettled = true; return { error }; });
  const askMessage = await eventually(() => sentSince(askSends).find(r => r.body.reply_markup?.inline_keyboard?.[0]?.[1]?.callback_data?.startsWith('ask:')), 'Supervisor created an actual pending ask');
  check(calls.length, askCalls + 1, 'Pending ask used only its private decision model');
  for (const [presence, reply, state] of [['나 퇴근', 'AWAY 모드 전환됨', 'AWAY (적극 ask)'], ['돌아왔어', 'HERE 모드 전환됨', 'HERE (알림 최소)']]) {
    await command(presence, reply, 2000); await command('/status', state);
    check(askSettled, false, 'Presence change does not answer pending ask');
    check(calls.length, askCalls + 1, 'Presence change never runs the ask resolver');
  }
  // The resolver emits approve/deny; supervisor-service maps deny to block on HTTP.
  queue.push(JSON.stringify({ decision: 'deny', reasoning: 'Private explicit answer' }));
  fixture.telegram.push(callback(activeChat, askMessage.body.reply_markup.inline_keyboard[0][1].callback_data));
  const resolved = await asking;
  if (resolved.error) throw resolved.error;
  check(resolved.value.status, 200, 'Explicit callback resolves the preserved ask');
  check(resolved.value.data.decision, 'block', 'Preserved ask returns the normalized denial contract');
  check(resolved.value.data.policy, 'llm-resolved', 'Explicit denial uses the model resolver rather than keyword fallback');
  check(resolved.value.data.reasoning, 'Private explicit answer', 'Model resolver reasoning reaches the HTTP result');
  check(resolved.value.data.userAnswer, '하지 마', 'Only explicit callback becomes the human answer');
  check(calls.length, askCalls + 2, 'One decision and one explicit-answer model call');
  check(queue.length, 0, 'All planned model answers consumed'); check(unexpected, [], 'No unplanned provider request');
  report.modelCalls = calls.length;
  report.commands = [...new Set(report.commands)].sort();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.message;
  throw error;
} finally {
  const cleanup = [];
  for (const action of [stopStream, () => runtime?.stop(), () => fixture && cleanupTelegramChecks(fixture), () => fixture?.cleanup(),
    async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }]) {
    try { await action(); } catch (error) { cleanup.push(error.message); }
  }
  if (cleanup.length) { report.status = 'failed'; report.cleanupErrors = cleanup; process.exitCode = 1; }
  report.commandsIntegrated = report.status === 'passed';
  report.checkedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
