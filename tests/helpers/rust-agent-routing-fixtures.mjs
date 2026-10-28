// Evaluate the original pure routing functions with an inert model adapter.
// No application module, provider, account, network, or shell process is loaded.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const profilesSource = readFileSync(new URL('../../lib/agent-profiles.js', import.meta.url), 'utf8');
const orchestratorSource = readFileSync(new URL('../../lib/agent-orchestrator.js', import.meta.url), 'utf8');
const start = orchestratorSource.indexOf('let _teamLeadIdx = 0;');
const end = orchestratorSource.indexOf('export function buildSystemPrompt(');
assert.ok(start >= 0 && end > start, 'original routing function boundaries');
const routingSource = orchestratorSource.slice(start, end).replaceAll('export async function ', 'async function ');
const clean = value => JSON.parse(JSON.stringify(value));

function original() {
  const context = vm.createContext({ console: { log() {}, warn() {} } });
  return vm.runInContext(
    profilesSource.replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
    + '\nlet _geminiApiKey = "fake"; const GEMINI_MODELS = { flash: "gemini-2.5-flash" };'
    + '\nlet response, failure, calls = []; class _GeminiClient {'
    + 'constructor(key, model) { this.model = model; }'
    + 'async send(system, user, options) { calls.push({ system, user, model: this.model, provider: "gemini", timeoutMs: options.timeoutMs }); if (failure !== undefined) throw new Error(failure); return response; }}\n'
    + routingSource
    + '\n({ ids: Object.keys(AGENT_PROFILES), getRankLevel, getTeamMembers, getTeamLead, pickAgentByComplexity, escalateAgent, findCommonSuperior, '
    + 'async detect(input) { response = input.raw; failure = input.error; calls = []; _geminiApiKey = input.configured ? "fake" : ""; let expected; try { expected = { value: await detectMode(input.message) }; } catch(error) { expected = { error: error.message }; } return { expected, calls }; } })',
    context,
    { filename: fileURLToPath(new URL('../../lib/agent-orchestrator.js', import.meta.url)), timeout: 1000 },
  );
}

const api = original();
const helperCases = [];
function helper(action, input) {
  let expected;
  switch (action) {
    case 'rank': expected = api.getRankLevel(input.id); break;
    case 'members': expected = api.getTeamMembers(input.team).map(p => p.id); break;
    case 'lead': expected = api.getTeamLead(input.team)?.id ?? null; break;
    case 'pick': expected = api.pickAgentByComplexity(input.team, input.complexity)?.id ?? null; break;
    case 'escalate': expected = api.escalateAgent(input.id).id; break;
    case 'superior': expected = api.findCommonSuperior(input.id, input.other).id; break;
    default: throw new Error('unknown helper');
  }
  helperCases.push({ input: { action, ...input }, expected: clean(expected) });
}
const ids = [...api.ids, 'missing', '', 'DEV_SAWON'];
for (const id of ids) {
  helper('rank', { id });
  helper('escalate', { id });
  for (const other of ids) helper('superior', { id, other });
}
for (const team of ['dev', 'plan', 'design', 'admin', 'marketing', 'intern', '', 'missing', null, true, []]) {
  helper('members', { team });
  helper('lead', { team });
  for (const complexity of ['low', 'mid', 'high', '', null, true, 'MID']) helper('pick', { team, complexity });
}
for (let i = 0; i < 12; i++) {
  for (const team of ['dev', 'design', 'plan', 'dev', 'admin', 'marketing']) helper('pick', { team, complexity: 'mid' });
}

const inputs = [];
const input = (message, raw = '{}', configured = true) => ({ message, raw, configured });
const add = (message, raw = '{}', configured = true) => inputs.push([input(message, raw, configured)]);
for (const message of ['콕핏이사', '김부장', '핏대리', '원과장', '콕사원', '한기장', '박기리', '이기원', '최디장', '정디리', '강경장', '차경리', '윤경원', '오마장', '류마리', '신마원', '막내']) {
  for (const suffix of ['', ' 불러', ' 와봐', ' 맡겨']) add('😀\ud800' + message + suffix);
}
for (const team of ['개발', '기획', '디자인', '경영', '마케팅']) {
  for (const suffix of ['불러', '팀 호출', '팀\n맡겨', '팀\ufeff시켜', '팀\u0085데려']) add(team + suffix);
}
for (const message of [
  '이사 불러', '부장 데려', '과장 호출', '대리 찾아', '팀장 불러', '상사 호출', '윗사람 데려',
  '상사 말고 이사 불러', '대리 말고 부장 찾아', '과장 불러\n이사 찾아', '팀장\n불러',
  '콕사원 김부장', '김부장 콕사원', '😀\ud800콕사원 불러', '아무나 부장 불러',
  '하이', '안녕하세요', '헬로', 'ㅎㅇ', '게누구', '여기\n누구', '아무나', ' 하이',
  '게\u0085누구', '여기\ufeff누구', '', '\ud800', '\udc00', '고쳐줘',
]) add(message);
for (const id of ids) add('이 작업은 ' + id + ' 가능함?', '{"team":"marketing","complexity":"high","mode":"orchestrated"}');
add('dev_sawon dev_bujang', '{"team":"intern","mode":"orchestrated"}');
add('dev_bujang dev_sawon', '{}');
add('DEV_BUJANG', '{"team":"marketing","complexity":"high"}');
for (const team of ['dev', 'plan', 'design', 'admin', 'marketing', 'intern', '', 'unknown', null, true, []]) {
  for (const complexity of ['low', 'mid', 'high', '', 'HIGH', null, 1]) {
    for (const mode of ['solo', 'orchestrated', 'ORCHESTRATED']) add('일반 작업 요청', JSON.stringify({ team, complexity, mode }));
  }
}
const fence = '`'.repeat(3);
const route = '{"team":"plan","complexity":"high","mode":"solo"}';
for (const prefix of ['', fence, fence + 'json', fence + 'json\n', fence + 'JSON\n', 'prefix ', '\ufeff']) {
  for (const suffix of ['', fence, '\n' + fence, ' suffix', '\u00a0']) add('일반 작업 요청', prefix + route + suffix);
}
for (const raw of ['null', '[]', '42', 'true', '"text"', '{', '', null, false, 2, {}, [], '{"team":"\\ud800"}']) add('일반 요청', raw);
inputs.push([{ message: '일반 요청', error: 'fake provider unavailable', configured: true }]);
for (const message of [null, false, 1, {}, [], '상사 불러', '일반 작업']) {
  add(message, '{}', false);
  if (typeof message !== 'string') add(message);
}
inputs.push(Array.from({ length: 12 }, () => input('상사 불러')));
inputs.push(Array.from({ length: 15 }, (_, i) => i % 3 === 0
  ? input('팀장 불러')
  : input('일반 요청', JSON.stringify({ team: 'dev', complexity: 'mid' }))));
inputs.push(Array.from({ length: 12 }, (_, i) => input('일반 요청', JSON.stringify({ team: i % 3 === 0 ? 'design' : 'dev', complexity: 'mid' }))));

const routingCases = [];
let routerPrompt;
for (const steps of inputs) {
  const api = original();
  const results = [];
  for (const input of steps) {
    const { expected, calls } = clean(await api.detect(input));
    if (calls.length) routerPrompt ??= calls[0].system;
    results.push({ input, expected, calls });
  }
  routingCases.push({ steps: results });
}
export const fixtures = { routerPrompt, helperCases, routingCases };
if (process.argv.includes('--emit')) process.stdout.write(JSON.stringify(fixtures, null, 2) + '\n');
