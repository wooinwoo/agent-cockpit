import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const keys = ['supervisor-fixture-key-a', 'supervisor-fixture-key-b'];
const modelPath = '/v1beta/models/gemini-2.5-flash:streamGenerateContent';
const post = body => ({ method: 'POST', body });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = parts => `data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\r\n\r\n`;
const failed = { decision: 'block', reasoning: 'LLM unavailable, conservative deny', policy: 'llm-fail-deny', userAnswer: null };
const noLlm = { decision: 'block', reasoning: 'no LLM, no rule match', policy: 'no-llm', userAnswer: null };

// This preparation starts a transport mock and appends a fetch interceptor to
// the private Node preload. It does not create or seed either server data root.
export async function prepareSupervisorLlmChecks({ fixture }) {
  if (fixture.supervisorLlm) return;
  const state = { calls: [], unexpected: [], plan: null, closed: false };
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const url = new URL(req.url, 'http://127.0.0.1');
      const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method,
        contentType: req.headers['content-type'], body: JSON.parse(body || '{}') };
      state.calls.push(call);
      const plan = state.plan;
      if (!plan || call.path !== modelPath || !keys.includes(call.query.key)) {
        state.unexpected.push(call);
        res.writeHead(500); res.end('Unexpected private supervisor model request'); return;
      }
      if (plan.status) { res.writeHead(plan.status); res.end('Synthetic upstream failure'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (plan.disconnect) { res.flushHeaders(); res.destroy(); return; }
      const text = plan.text ?? '';
      const midpoint = Math.floor(text.length / 2);
      const payload = plan.empty ? ': private empty stream\r\n\r\ndata: [DONE]\r\n\r\n'
        : ': fixture comment\r\n\r\ndata: not-json\r\n\r\n' + frame([{ thought: true, text: '{"decision":"deny"}' }])
          + frame([{ text: text.slice(0, midpoint) }, { text: text.slice(midpoint) }]) + 'data: [DONE]\r\n\r\n';
      if (plan.fragments) {
        const bytes = Buffer.from(payload);
        for (let offset = 0; offset < bytes.length && !res.destroyed; offset += 7) {
          res.write(bytes.subarray(offset, offset + 7));
          await sleep(1);
        }
        res.end();
      } else res.end(payload);
    } catch (error) {
      state.unexpected.push({ error: error.message });
      if (!res.destroyed) { res.writeHead(500); res.end('Invalid private fixture request'); }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const priorAiConfigMock = Boolean(fixture.aiConfig);
  try {
    await appendFile(join(fixture.directory, 'isolate-home.mjs'), `
const supervisorLlmFixtureFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'generativelanguage.googleapis.com') {
    if (url.origin !== 'https://generativelanguage.googleapis.com' || url.username || url.password) throw new Error('Unexpected supervisor fixture origin');
    if (url.pathname === ${JSON.stringify(modelPath)} && ${JSON.stringify(keys)}.includes(url.searchParams.get('key'))) {
      return supervisorLlmFixtureFetch(${JSON.stringify(base)} + url.pathname + url.search, { ...init, redirect: 'error' });
    }
    if (${JSON.stringify(keys)}.includes(url.searchParams.get('key'))) throw new Error('Unexpected supervisor model route');
    ${priorAiConfigMock ? 'return supervisorLlmFixtureFetch(input, init);' : "throw new Error('Unexpected Gemini request blocked by supervisor fixture');"}
  }
  if (url.hostname.endsWith('.googleapis.com')) throw new Error('Unexpected Google API request blocked');
  return supervisorLlmFixtureFetch(input, init);
};
`);
    Object.assign(state, { server, base });
    fixture.supervisorLlm = state;
  } catch (error) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
}

export async function cleanupSupervisorLlmChecks(fixture) {
  const state = fixture.supervisorLlm;
  if (!state || state.closed) return;
  state.closed = true;
  state.server.closeAllConnections();
  await new Promise(resolve => state.server.close(resolve));
}

export async function verifySupervisorLlmChecks(context) {
  const { fixture, sandbox, request, check, restartServers } = context;
  const state = fixture.supervisorLlm;
  if (!state || state.closed) throw new Error('prepareSupervisorLlmChecks must precede private server startup');
  if (!restartServers) throw new Error('Supervisor model verification requires restartServers');
  const source = await readFile(new URL('../../lib/supervisor-llm.js', import.meta.url), 'utf8');
  const system = source.match(/function buildDecideSystem\(\) \{\s*return `([\s\S]*?)`;/)[1];
  const paths = [join(fixture.directory, 'data/cockpit/ai-config.json'), join(sandbox, 'ai-config.json')];
  const saved = await Promise.all(paths.map(path => readFile(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })));
  const oldBase = fixture.env.COCKPIT_PREVIEW_GEMINI_BASE;
  let bases = [fixture.url, context.rustUrl];
  const restart = async () => {
    const result = await restartServers();
    if (result?.rustUrl) context.rustUrl = result.rustUrl;
    bases = [fixture.url, context.rustUrl];
  };
  const seed = async key => {
    for (const path of paths) await writeFile(path, JSON.stringify(key ? { geminiApiKey: key } : {}), { mode: 0o600 });
  };
  const pair = (path, options) => Promise.all(bases.map(base => request(base, path, options)));
  const compareDecision = async (event, expected) => {
    const responses = await pair('/api/supervisor/decide', post(event));
    check(responses.map(response => response.status), [200, 200], 'Supervisor model decision HTTP status');
    check(responses[1].data, responses[0].data, 'Supervisor original/native model result');
    if (expected) check(responses[1].data, expected, 'Supervisor model result matches explicit expectation');
    return responses[1].data;
  };
  const expectedPrompt = event => {
    const tool = event.tool_name || event.tool || '?';
    const session = event.session_id ? `\n세션: ${event.session_id}` : '';
    const input = JSON.stringify(event.tool_input || event.input || {}, null, 2).slice(0, 1500);
    return `도구: ${tool}${session}\n\n입력:\n${input}\n\n결정 JSON으로 응답.`;
  };
  const run = async ({ event = { tool: 'Unknown', input: { command: 'fixture operation' }, session_id: 'fixture-session' }, expected, ...plan }, key = keys[0]) => {
    state.plan = plan;
    const before = state.calls.length;
    const result = await compareDecision(event, expected);
    const calls = state.calls.slice(before);
    check(calls.length, 2, 'One model request per original/native decision');
    const prompt = expectedPrompt(event);
    for (const call of calls) {
      check(call.path, modelPath, 'Supervisor uses Gemini 2.5 Flash streaming endpoint');
      check(call.query, { alt: 'sse', key }, 'Supervisor uses cached synthetic key and SSE');
      check(call.method, 'POST', 'Supervisor model request uses POST');
      check(call.contentType, 'application/json', 'Supervisor model request content type');
      const body = { ...call.body };
      const actualPrompt = body.contents?.[0]?.parts?.[0]?.text;
      check(body.contents, [{ role: 'user', parts: [{ text: actualPrompt }] }], 'Supervisor sends one user text part');
      body.contents = [{ role: 'user', parts: [{ text: '<prompt checked separately>' }] }];
      check(body, { contents: [{ role: 'user', parts: [{ text: '<prompt checked separately>' }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
        systemInstruction: { parts: [{ text: system }] } }, 'Supervisor exact system prompt and generation options');
      check(actualPrompt, prompt, 'Supervisor prompt preserves exact text, object order and UTF-16 truncation');
    }
    state.plan = null;
    return result;
  };

  try {
    fixture.env.COCKPIT_PREVIEW_GEMINI_BASE = state.base;
    await seed(null); await restart();
    for (const response of await pair('/api/telegram/status')) check(response.data.configured, false, 'No real messaging channel configured for model tests');
    const unknown = { tool: 'Unknown', input: { command: 'fixture operation' } };
    let before = state.calls.length;
    await compareDecision(unknown, noLlm);
    check(state.calls.length, before, 'Missing startup key avoids model calls');
    await seed(keys[0]);
    for (const response of await pair('/api/ai/config')) check(response.data.configured, true, 'New private key is visible in uncached configuration');
    await compareDecision(unknown, noLlm);
    check(state.calls.length, before, 'Adding key does not refresh an unready cached supervisor implicitly');
    await restart();
    const approved = { decision: 'approve', confidence: 0.5, reasoning: 'llm decided', policy: 'llm', userAnswer: null };
    await run({ text: '{"decision":"approve"}', expected: approved });
    await seed(keys[1]);
    await run({ text: '{"decision":"approve"}', expected: approved });
    await seed(null);
    await run({ text: '{"decision":"approve"}', expected: approved });
    await seed(keys[1]); await restart();
    await run({ text: '{"decision":"approve"}', expected: approved }, keys[1]);
    await seed(keys[0]); await restart();

    const cases = [
      { text: 'prefix ```json\n{"decision":"approve","confidence":0.81,"reasoning":"한글 😀"}\n``` suffix', fragments: true,
        expected: { ...approved, confidence: 0.81, reasoning: '한글 😀' } },
      { text: '{}', expected: { ...approved, decision: 'ask' } },
      { text: '{"confidence":null,"reasoning":""}', expected: { ...approved, decision: 'ask' } },
      { text: '{"decision":null,"confidence":false,"reasoning":0}', expected: { ...approved, decision: 'ask', confidence: false } },
      { text: '{"decision":["approve"],"confidence":0}', expected: { ...approved, decision: 'ask', confidence: 0 } },
      { text: '{"decision":["deny"]}', expected: { ...approved, decision: 'ask' } },
      { text: '{"decision":true,"reasoning":{"a":1}}', expected: { ...approved, decision: 'ask', reasoning: { a: 1 } } },
      { text: '{"decision":"deny","reasoning":"private deny"}', expected: { ...approved, decision: 'block', reasoning: 'private deny' } },
      { text: '{"decision":"block"}', expected: { ...approved, decision: 'block' } },
      { text: JSON.stringify({ decision: 'ask', reasoning: ' needs user \ud800 ', ask_message: 'question' }),
        expected: { ...approved, decision: 'ask', reasoning: 'needs user \ud800  (HERE: 화면 프롬프트로 위임)', policy: 'here-passthrough' } },
      { text: '{"decision":"ask","reasoning":[]}', expected: { ...approved, decision: 'ask', reasoning: '(HERE: 화면 프롬프트로 위임)', policy: 'here-passthrough' } },
      { text: '[{"decision":"approve"}]', expected: approved },
      { text: 'prefix {"decision":"approve"} suffix', expected: approved },
      { text: '```nonsense``` {"decision":"approve"}', expected: failed },
      { text: '{} {}', expected: failed }, { text: '{broken}', expected: failed },
      { text: 'null', expected: failed }, { empty: true, expected: failed },
      { status: 403, expected: failed }, { status: 503, expected: failed },
      { disconnect: true, expected: failed },
    ];
    for (const scenario of cases) await run(scenario);
    const inputPrefix = JSON.stringify({ command: 'MARK' }, null, 2).indexOf('MARK');
    const promptEvents = [
      { tool: 'Unknown', input: { command: 'x'.repeat(1499 - inputPrefix) + '😀end' } },
      { tool: 'Unknown', input: { command: '한글😀'.repeat(700) } },
      { tool: 'Unknown', input: { command: 'embedded \ud800 and \udc00' } },
      { tool: 'Unknown\ud800', session_id: 'session\udc00', input: {} },
      { tool: {}, input: [1e21, 1e-7, -0, '\ud800', { path: '/fixture' }] },
      { tool_name: 'Unknown', tool_input: { command: 'preferred' }, input: { command: 'ignored' } },
      { tool: 'Unknown', input: true },
      { tool: 'Unknown', input: { url: 'https://fixture.invalid/important', body: 'B'.repeat(2000) } },
      { tool: 'Unknown', input: { z: 1, a: { z: 2, a: 'ordered' }, command: 'private' } },
      { tool: 'Unknown', input: { '10': 'ten', '2': 'two', z: true, '01': 'one', '4294967295': 'non-index', a: false } },
    ];
    for (const event of promptEvents) await run({ event, text: '{"decision":"approve"}', expected: approved });
    before = state.calls.length;
    await compareDecision({ tool: 'Read', input: { command: 'fixture' } },
      { decision: 'approve', confidence: 0.99, reasoning: 'Read is read-only/safe', policy: 'safelist', userAnswer: null });
    await compareDecision({ tool: 'Bash', input: { command: 'rm -rf /' } });
    check(state.calls.length, before, 'Safe and forbidden rules bypass the model even when configured');
    check(state.unexpected, [], 'No unplanned model or external transport requests');
    check((await pair('/api/supervisor/status')).map(response => response.data), [{ pending: 0 }, { pending: 0 }], 'HERE ask does not create legacy button waits');
    // AWAY is exercised by Rust channel unit tests; no HTTP mode setter exists
    // for the supervisor, so this public API contract deliberately covers HERE.
  } finally {
    state.plan = null;
    for (let index = 0; index < paths.length; index++) {
      if (saved[index] === null) await unlink(paths[index]).catch(error => { if (error.code !== 'ENOENT') throw error; });
      else await writeFile(paths[index], saved[index], { mode: 0o600 });
    }
    if (oldBase === undefined) delete fixture.env.COCKPIT_PREVIEW_GEMINI_BASE;
    else fixture.env.COCKPIT_PREVIEW_GEMINI_BASE = oldBase;
    await restart();
  }
}
