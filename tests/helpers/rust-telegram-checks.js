import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, readFile, writeFile, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, message, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await pause(10); }
  throw new Error(message);
}

// Strictly private transport: source HTTPS is redirected only inside this fixture.
export async function prepareTelegramChecks({ fixture }) {
  if (fixture.telegram) return;
  const state = { requests: [], queue: [], polls: new Set(), nextUpdate: 100, heldInitial: false, initialResponses: new Set(), heldSends: new Set(), rejectPolls: false, failAck: false, gates: [] };
  // One matching request is held until the test releases it or its owner cancels.
  state.holdNext = (method, matches = () => true) => {
    const gate = { method, matches, request: null, closed: false, release: null };
    state.gates.push(gate);
    return gate;
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const match = req.url.match(/^\/bot([^/]+)\/([^/?]+)$/);
    if (!match) { res.writeHead(404); res.end(); return; }
    const [, token, method] = match;
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    state.requests.push({ token, method, body });
    const send = data => { if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); } };
    if (method === 'getUpdates' && body.timeout === 0) {
      if (state.heldInitial && token === 'fixture-rust') { state.initialResponses.add(res); res.on('close', () => state.initialResponses.delete(res)); return; }
      send({ ok: true, result: [{ update_id: 90, message: { chat: { id: 'private-chat' }, text: '/unhandled-backlog' } }] }); return;
    }
    if (method === 'getUpdates') {
      if (state.rejectPolls) { send({ ok: false, description: 'fixture unauthorized' }); return; }
      const respond = () => {
        const updates = state.queue.filter(u => u.update_id >= (body.offset || 0));
        if (updates.length) { send({ ok: true, result: updates }); return true; }
        return false;
      };
      if (respond()) return;
      const poll = { res, respond, token };
      state.polls.add(poll);
      const timeout = setTimeout(() => send({ ok: true, result: [] }), 2000);
      res.on('close', () => { clearTimeout(timeout); state.polls.delete(poll); });
      return;
    }
    const gateIndex = state.gates.findIndex(gate => gate.method === method && gate.matches(body));
    if (gateIndex !== -1) {
      const [gate] = state.gates.splice(gateIndex, 1);
      gate.request = { token, method, body };
      gate.release = (response = { ok: true, result: { message_id: 42 } }) => send(response);
      res.on('close', () => { gate.closed = true; });
      return;
    }
    if (method === 'answerCallbackQuery' && state.failAck) { res.end('not JSON'); return; }
    if (method === 'sendMessage' && body.reply_markup && body.text.includes('fixture-rejected-approval')) { send({ ok: false, error_code: 400 }); return; }
    if (method === 'sendMessage' && body.reply_markup && body.text.includes('fixture-invalid-approval')) { res.end('invalid response'); return; }
    if (method === 'sendMessage' && body.text === 'fixture-held') { state.heldSends.add(res); res.on('close', () => state.heldSends.delete(res)); return; }
    if (method === 'sendMessage' && body.text === 'fixture-invalid-json') { res.end('invalid ' + token); return; }
    if (method === 'sendMessage' && body.text === 'fixture-oversized') { res.end('x'.repeat(4 * 1024 * 1024 + 1)); return; }
    if (method === 'sendMessage' && body.text === 'fixture-redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/forbidden' }); res.end('{}'); return; }
    send({ ok: true, result: { message_id: 42 } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  fixture.env.COCKPIT_PREVIEW_TELEGRAM_BASE = base;
  await appendFile(join(fixture.directory, 'isolate-home.mjs'), `
import privateTelegramHttps from 'node:https';
import privateTelegramHttp from 'node:http';
const privateTelegramRequest = privateTelegramHttps.request;
privateTelegramHttps.request = function(options, callback) {
  if (options?.hostname === 'api.telegram.org') {
    return privateTelegramHttp.request({ ...options, hostname: '127.0.0.1', port: ${server.address().port}, protocol: 'http:' }, callback);
  }
  return privateTelegramRequest.call(this, options, callback);
};
`);
  state.server = server;
  state.push = update => { state.queue.push({ update_id: state.nextUpdate++, ...update }); for (const poll of [...state.polls]) poll.respond(); };
  fixture.telegram = state;
}
export async function cleanupTelegramChecks(fixture) {
  const state = fixture.telegram;
  if (!state || state.closed) return;
  state.closed = true; state.server.closeAllConnections(); await new Promise(resolve => state.server.close(resolve));
}
export async function verifyTelegramChecks(context) {
  const { fixture, sandbox, request, check } = context;
  const state = fixture.telegram;
  const bases = () => [fixture.url, context.rustUrl];
  const post = body => ({ method: 'POST', body });
  const pair = async (path, options) => {
    const [node, rust] = await Promise.all(bases().map(base => request(base, '/api/telegram/' + path, options)));
    check(rust.status, node.status, `Telegram status ${path}`); check(rust.data, node.data, `Telegram response ${path}`); return rust.data;
  };
  const configs = [join(fixture.directory, 'app/telegram-config.json'), join(sandbox, 'telegram-config.json')];
  check(await pair('status'), { configured: false, polling: false, config: null }, 'Fresh Telegram state is unconfigured');
  check(await pair('start', post({})), { ok: false, polling: false }, 'Disabled bridge cannot start');
  check(await pair('test', post({})), { ok: false, result: { ok: false, skipped: 'telegram disabled' } }, 'Disabled send is explicit');
  for (const body of [{}, { token: '' }, { token: 'fixture', chatId: '' }, { token: false, chatId: 1 }]) await pair('config', post(body));
  await pair('config', post({ token: 'fixture-common', chatId: 123, enabled: false }));
  check((await pair('status')).config, { token: '***', chatId: '123', enabled: false }, 'Token masked and numeric chat ID stringified');
  check((await stat(configs[1])).mode & 0o777, 0o600, 'Native Telegram config private mode');
  await pair('config', post({ token: 'fixture-common', chatId: 'private-chat' }));
  for (const text of [undefined, '', null, false, 0, [], {}, '한글 <>&', '😀'.repeat(1901), 'a'.repeat(2500) + '\n  ' + 'b'.repeat(2500) + '  ', 'a'.repeat(3799) + '😀\ud800']) {
    const before = state.requests.length;
    await pair('test', post({ text }));
    const sent = state.requests.slice(before).filter(r => r.method === 'sendMessage');
    check(sent.length % 2, 0, 'Both bridges emit same chunk count');
    // Sequential chunks may interleave; their multiset still proves exact UTF-16 and flags.
    const byText = new Map();
    for (const request of sent) {
      // JSON object order is not observable API behavior; string code units are.
      const key = JSON.stringify(Object.keys(request.body).sort().map(key => [key, request.body[key]]));
      byText.set(key, (byText.get(key) || 0) + 1);
    }
    const unmatched = [...byText.entries()].filter(([, count]) => count % 2 !== 0).map(([key, count]) => {
      const body = Object.fromEntries(JSON.parse(key));
      return { count, keys: Object.keys(body), chat: body.chat_id, silent: body.disable_notification, parseMode: body.parse_mode,
        textLength: body.text.length, textStart: body.text.slice(0, 120), textEnd: body.text.slice(-80) };
    });
    check(unmatched, [], 'Telegram exact UTF-16 chunk bodies and silence flag match source');
  }
  for (const text of ['fixture-invalid-json', 'fixture-oversized']) {
    const result = await request(context.rustUrl, '/api/telegram/test', post({ text }));
    check(result.status, 500, 'Malformed or oversized Telegram response rejected');
    check(JSON.stringify(result.data).includes('fixture-common'), false, 'Transport errors never expose bot token');
  }
  const redirect = await request(context.rustUrl, '/api/telegram/test', post({ text: 'fixture-redirect' }));
  check(redirect.status, 200, 'Redirect response parsed without following Location');
  check(redirect.data, { ok: false, result: {} }, 'Redirect never contacts its target');
  const original = await readFile(configs[1]);
  await writeFile(configs[1], '{broken');
  check((await request(context.rustUrl, '/api/telegram/config', post({ token: 'replacement', chatId: 1 }))).status, 500, 'Corrupt Telegram config is not overwritten');
  check(await readFile(configs[1], 'utf8'), '{broken', 'Corrupt bytes retained');
  await writeFile(configs[1], original);
  const outside = join(sandbox, 'telegram-outside.json'); await writeFile(outside, original);
  await unlink(configs[1]); await symlink(outside, configs[1]);
  check((await request(context.rustUrl, '/api/telegram/config', post({ token: 'replacement', chatId: 1 }))).status, 500, 'Symlink Telegram config refused');
  check(await readFile(outside), original, 'Symlink target retained');
  await unlink(configs[1]); await writeFile(configs[1], original, { mode: 0o600 });

  await request(context.rustUrl, '/api/telegram/config', post({ token: 'fixture-rust', chatId: 'private-chat' }));
  const before = state.requests.length;
  const starts = await Promise.all(Array.from({ length: 10 }, () => request(context.rustUrl, '/api/telegram/start', post({}))));
  check(starts.every(r => r.status === 200 && r.data.ok && r.data.polling), true, 'Concurrent start calls share one native poller');
  await eventually(() => state.polls.size > 0, 'Native poller did not long poll');
  check(state.requests.slice(before).filter(r => r.method === 'getUpdates' && r.body.timeout === 0).length, 1, 'Concurrent starts perform one backlog sync');
  check(state.requests.slice(before).find(r => r.method === 'getUpdates' && r.body.timeout > 0).body.offset, 91, 'Startup skips backlog using last update + 1');
  check(state.polls.size, 1, 'Exactly one long poll active');
  await request(context.rustUrl, '/api/autopilot/mode', post({ mode: 'unattended' }));
  const decision = command => request(context.rustUrl, '/api/autopilot/decide', post({ tool: 'Bash', input: { command } }));
  const begin = state.requests.length;
  let finished = false;
  const approved = decision('git pull').then(r => { finished = true; return r; });
  await eventually(() => state.requests.slice(begin).some(r => r.body.reply_markup), 'Approval message not sent');
  const keyboard = state.requests.slice(begin).find(r => r.body.reply_markup).body.reply_markup.inline_keyboard[0];
  const callback = (chat, data) => ({ callback_query: { id: 'callback-fixture', data, message: { chat: { id: chat }, message_id: 42 } } });
  state.push(callback('foreign-chat', keyboard[0].callback_data));
  await pause(100); check(finished, false, 'Foreign chat callback cannot approve');
  state.failAck = true;
  state.push(callback('private-chat', keyboard[0].callback_data));
  check((await approved).data.decision, 'approve', 'Matching approval resolves even when callback ACK fails');
  state.failAck = false;
  const deniedBegin = state.requests.length;
  const denied = decision('git push origin main');
  await eventually(() => state.requests.slice(deniedBegin).some(r => r.body.reply_markup), 'Hard approval message not sent');
  const hard = state.requests.slice(deniedBegin).find(r => r.body.reply_markup).body;
  check(hard.text.includes('(HARD)'), true, 'Production approval retains hard-risk label');
  state.push(callback('private-chat', hard.reply_markup.inline_keyboard[0][1].callback_data));
  check((await denied).data.decision, 'deny', 'Matching denial fails closed');
  const log = (await readFile(join(sandbox, 'logs/approvals.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  check(log.slice(-2).map(row => [row.decision, row.hard]), [['user-approve', false], ['user-deny', true]], 'Approval audit records explicit human decisions and hard boundary');
  check((await stat(join(sandbox, 'logs/approvals.jsonl'))).mode & 0o777, 0o600, 'Approval audit private mode');
  for (const command of ['fixture-rejected-approval', 'fixture-invalid-approval']) {
    check((await decision(command)).data.decision, 'deny', 'Failed approval delivery denies immediately');
    const record = JSON.parse((await readFile(join(sandbox, 'logs/approvals.jsonl'), 'utf8')).trim().split('\n').at(-1));
    check(record.decision, 'deny-send-error', 'Failed approval delivery leaves explicit audit evidence');
  }
  await request(context.rustUrl, '/api/autopilot/mode', post({ mode: 'attended' }));
  check((await request(context.rustUrl, '/api/telegram/stop', post({}))).data, { ok: true, polling: false }, 'Native stop reports stopped after joining task');
  await eventually(() => state.polls.size === 0, 'Stopped Telegram long poll left a live socket');
  const stoppedCount = state.requests.length; await pause(100);
  check(state.requests.length, stoppedCount, 'Stopped poller does not restart or send stale requests');

  const held = request(context.rustUrl, '/api/telegram/test', post({ text: 'fixture-held' }));
  await eventually(() => state.heldSends.size === 1, 'Held send was not started');
  await request(context.rustUrl, '/api/telegram/config', post({ token: 'fixture-rust', chatId: 'private-chat' }));
  check((await held).status, 500, 'Configuration change cancels in-flight transport');
  await eventually(() => state.heldSends.size === 0, 'Configuration change left old send socket alive');

  state.rejectPolls = true;
  const rejectionStart = state.requests.length;
  await request(context.rustUrl, '/api/telegram/start', post({}));
  await eventually(() => state.requests.slice(rejectionStart).some(r => r.method === 'getUpdates' && r.body.timeout > 0), 'Rejected polling request not observed');
  await pause(250);
  check(state.requests.slice(rejectionStart).filter(r => r.method === 'getUpdates' && r.body.timeout > 0).length, 1, 'API rejection backs off instead of hammering Telegram');
  await request(context.rustUrl, '/api/telegram/stop', post({}));
  state.rejectPolls = false;

  state.heldInitial = true;
  const starting = request(context.rustUrl, '/api/telegram/start', post({}));
  await eventually(() => state.initialResponses.size === 1, 'Initial sync was not held');
  const queuedStart = request(context.rustUrl, '/api/telegram/start', post({}));
  await pause(50); // Start B is queued behind A's held initial sync.
  const stop = await request(context.rustUrl, '/api/telegram/stop', post({}));
  check(stop.data, { ok: true, polling: false }, 'Stop cancels an in-flight startup sync');
  check((await starting).data, { ok: false, polling: false }, 'Cancelled startup cannot create a stale poller');
  check((await queuedStart).data, { ok: false, polling: false }, 'Stop invalidates a queued start before it can begin another long sync');
  await eventually(() => state.initialResponses.size === 0, 'Cancelled startup left a socket');
  state.heldInitial = false;
  for (const base of bases()) await request(base, '/api/telegram/config', post({ token: 'fixture-disabled', chatId: 'private-chat', enabled: false }));
}
