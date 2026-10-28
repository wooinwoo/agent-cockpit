// Evaluate the original orchestrator in a private VM. Providers, tools, clocks
// and Telegram are replaced; no account, network or application state is loaded.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseWslPath } from '../../lib/wsl-utils.js';

const profiles = readFileSync(new URL('../../lib/agent-profiles.js', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../../lib/agent-tools.js', import.meta.url), 'utf8');
const orchestrator = readFileSync(new URL('../../lib/agent-orchestrator.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(Buffer.from(value, 'utf16le')).digest('hex');
const digest = value => ({ length: value.length, hash: hash(value) });
export function original(input = {}) {
  const events = [], calls = [], requests = [];
  const remaining = [...(input.responses || [])], results = [...(input.results || [])];
  class FixedDate extends Date { static now() { return 123456; } }
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date: FixedDate,
    process: { platform: input.platform || 'linux', env: {} },
    setTimeout() { return 0; }, clearTimeout() {},
    IS_WIN: input.platform === 'win32', parseWslPath,
    // The original parser is pure from buildEditArg to EOF.
    MAX_TOOLS_PER_TURN: 5, TOOL_RESULT_LIMIT: 5000, READ_MAX_CHARS: 10000,
    setSubAgentRunner() {},
    executeTool: async (kind, argument, ctx) => {
      requests.push({ kind, argument, convId: ctx.convId, agentId: ctx.callerAgentId });
      const result = results.shift() ?? 'ok';
      if (result && typeof result === 'object' && 'error' in result) throw new Error(result.error);
      return result;
    },
    telegram: { sendTyping: async () => {}, sendMessage: async () => {} },
  });
  vm.runInContext(profiles.replace(/^export /gm, '') + '\n'
    + tools.slice(tools.indexOf('export function buildEditArg(tc)')).replace(/^export /gm, '') + '\n'
    + orchestrator.replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nglobalThis.api = { AGENT_PROFILES, buildSystemPrompt, buildConversationHistory, buildToolLogString, summarizeToolResult, trimToolLog, assemblePrompt, runAgentLoop, runOrchestratedLoop, runSubAgentLoop, initOrchestrator, getAgentTools, buildDevTeamContext, buildDesignTeamContext, buildMktTeamContext, buildAdminTeamContext, buildPlanTeamContext };', context, { timeout: 1000 });
  const api = context.api;
  class Gemini {
    constructor(key, model) { this.model = model; }
    async send(system, user, options) {
      calls.push({ model: this.model, timeout: options.timeoutMs, system: digest(system), user: digest(user) });
      const response = remaining.shift();
      if (response && typeof response === 'object' && 'error' in response) throw new Error(response.error);
      if (typeof response !== 'string') throw new Error('Fixture provider exhausted');
      options.onStream?.({ type: 'text', delta: response });
      return response;
    }
  }
  api.initOrchestrator({ getProjectRoots: () => input.roots || [], getProjectsMeta: () => [],
    geminiApiKey: 'fixture', GeminiClient: Gemini, userName: input.userName || '',
    broadcast: (name, data) => events.push({ name, data: clone(data) }) });
  api.runAgentLoop._runningLoops = new Map();
  return { api, events, calls, requests };
}
const raw = (message, tool_calls = [], is_final = false) => JSON.stringify({ thinking: 'plan', message, tool_calls, is_final });
const read = { tool: 'READ', argument: 'small.md' };

export async function makeRuntimeFixtures() {
  const cases = [
    { name: 'plain', responses: ['완료'] },
    { name: 'structured', responses: [raw('읽음', [read]), raw('완료', [], true)], results: ['file text'] },
    { name: 'multi-edit-write', responses: [raw('변경', [{ tool: 'EDIT', file: 'a', old_content: 'x', new_content: 'y' }, { tool: 'WRITE', file: 'b', content: '😀\ud800' }]), raw('완료')], results: ['edited', 'written'] },
    { name: 'tool-error', responses: [raw('읽음', [read]), raw('종료')], results: [{ error: 'cannot read' }] },
    { name: 'git-error', responses: [raw('확인', [{ tool: 'GIT_LOG', argument: '3' }]), raw('종료')], results: ['fatal: not a git repository (or any parent)'] },
    { name: 'provider-error', responses: [{ error: 'fixture model unavailable' }] },
    { name: 'empty', responses: [''] },
    { name: 'unicode', responses: [raw('😀\ud800', [read]), raw('\udc00끝')], results: ['😀'.repeat(2501)] },
    { name: 'max-iteration', maxIter: 1, responses: [raw('확인', [read]), raw('마지막 요약')], results: ['ok'] },
    { name: 'max-empty-summary', maxIter: 1, responses: [raw('확인', [read]), '@@TOOL:READ@@not-run@@END@@'], results: ['ok'] },
    { name: 'three-errors', maxIter: 4, responses: Array(3).fill(raw('재시도', [read])), results: Array(3).fill('Error: repeat') },
    { name: 'reset-error-streak', maxIter: 4, responses: [raw('확인', [read, read, read, read]), raw('종료')], results: ['Error: repeat', 'ok', 'Error: repeat', 'Error: repeat'] },
    { name: 'permission', agent: 'intern', responses: [raw('확인', [{ tool: 'BASH', argument: 'pwd' }, read]), raw('종료')], results: ['read-only'] },
    { name: 'implicit-embed', message: 'youtube play cats', responses: ['검색합니다'], results: ['@@EMBED:https://example.invalid/embed@@'] },
    { name: 'final-with-tools', responses: [raw('끝', [read], true)], results: ['ok'] },
    { name: 'five-tool-limit', responses: [raw('여러 파일', Array(8).fill(read)), raw('완료')], results: Array(5).fill('ok') },
  ];
  const fixtures = [];
  for (const input of cases) {
    const { api, events, calls, requests } = original(input);
    const agent = input.agent || 'dev_sawon';
    if (input.maxIter) api.AGENT_PROFILES[agent].maxIter = input.maxIter;
    const profile = clone(api.AGENT_PROFILES[agent]);
    const conv = { messages: [{ role: 'user', content: input.message || '작업', ts: 123456 }], createdAt: 123456 };
    let saves = 0;
    await api.runAgentLoop('fixture', conv, agent, { saveHistory() { saves++; } });
    const team = profile.team === 'dev' ? api.buildDevTeamContext() : '';
    fixtures.push({ input: { ...input, profile, team }, expected: { events, calls, requests, messages: conv.messages, saves } });
  }
  return clone(fixtures);
}

export function makePromptFixtures() {
  const base = original().api;
  const cases = [];
  for (const agent of [null, ...Object.keys(base.AGENT_PROFILES)]) {
    for (const model of ['flash', 'pro']) {
      for (const roots of [[], ['/tmp/프로젝트😀'], ['\\\\wsl.localhost\\Ubuntu\\home\\test']]) {
        const input = { action: 'system', agent, model, roots, userName: '대표😀\ud800', platform: roots.length ? 'win32' : 'linux' };
        const { api } = original(input);
        cases.push({ input, expected: digest(api.buildSystemPrompt(model, agent ? api.AGENT_PROFILES[agent] : null)) });
      }
    }
  }
  const add = (input, fn) => {
    try { cases.push({ input, expected: { value: clone(fn()) } }); }
    catch { cases.push({ input, expected: { error: true } }); }
  };
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i + '<x&😀\ud800>' + '😀'.repeat(1550), toolSummary: [{ tool: 'READ', arg: '😀'.repeat(50) }] }));
  for (const maxChars of [0, 3000, 15000, 55000]) {
    add({ action: 'history', messages, maxChars }, () => base.buildConversationHistory(messages, maxChars));
  }
  for (const messages of [[], [{ role: 'user', content: '' }], [{ role: 'user', content: 42 }], [{ content: '\ud800<&>', toolSummary: [] }]]) {
    add({ action: 'history', messages, maxChars: 15000 }, () => base.buildConversationHistory(messages));
  }
  for (const tool of ['READ', 'SEARCH', 'GLOB', 'EDIT', 'BASH']) {
    for (const result of ['', 'a', '😀'.repeat(201), Array(12).fill('x😀').join('\n'), null, 42]) {
      add({ action: 'summary', tool, result }, () => base.summarizeToolResult(tool, result));
    }
  }
  for (const log of [[], [{ tool: 'READ', arg: 'x', result: 'ok' }], [{ turn: 1, thinking: 'a\nb\ud800', tool: 'READ', arg: 'x', result: 'Error: broken\nline' }], Array.from({ length: 9 }, (_, i) => ({ turn: i + 1, thinking: '😀'.repeat(300), tool: i % 2 ? 'BASH' : 'READ', arg: '😀'.repeat(150), result: '😀'.repeat(3000) }))]) {
    add({ action: 'log', log }, () => base.buildToolLogString(log));
    add({ action: 'trim', log }, () => { const copy = clone(log); base.trimToolLog(copy); return copy; });
  }
  return clone(cases);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = await makeRuntimeFixtures(), prompt = makePromptFixtures();
  writeFileSync(new URL('../fixtures/rust-agent-runtime.json', import.meta.url), JSON.stringify(runtime) + '\n');
  writeFileSync(new URL('../fixtures/rust-agent-prompt.json', import.meta.url), JSON.stringify(prompt) + '\n');
  console.log(`Agent reference fixtures: ${runtime.length} runtime, ${prompt.length} prompt`);
}
