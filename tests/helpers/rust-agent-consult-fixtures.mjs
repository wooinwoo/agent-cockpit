// Evaluate the original CONSULT function with an in-memory model. No service,
// configuration, account, filesystem mutation, or network transport is imported.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { AGENT_PROFILES, findCommonSuperior, getRankLevel } from '../../lib/agent-profiles.js';

const source = await readFile(new URL('../../lib/agent-tools.js', import.meta.url), 'utf8');
const start = source.indexOf('async function executeConsult(arg, context)');
const end = source.indexOf('// Unified tool dispatcher', start);
assert.ok(start >= 0 && end > start, 'original CONSULT function boundaries');
const original = source.slice(start, end);

export async function makeFixtures() {
  const cases = [];
  const json = JSON.stringify;
  const agree = json({ stance: 'agree', reasoning: '같은 결론😀', suggestion: '' });
  const partial = json({ stance: 'partial', reasoning: '보완 필요', suggestion: '부분 개선' });
  const disagree = json({ stance: 'disagree', reasoning: '다른 근거', suggestion: '대안 방향' });
  const insist = json({ stance: 'insist', reasoning: '고집 근거', revised_view: '' });
  const accept = json({ stance: 'accept', reasoning: '동의', revised_view: '' });
  const revise = json({ stance: 'revise', reasoning: '조정', revised_view: '수정 방향' });
  const judge = json({ decision: 'new', reasoning: '최종 근거', final_direction: '최종 방향' });
  const base = 'agent:dev_daeri\ntopic:할 일 순서\nmy_view:검증 먼저\ncontext:실패한 작업';
  const add = (name, responses = [agree], overrides = {}) => cases.push({
    name, argument: base, callerId: 'dev_sawon', convId: 'fixture-consult', responses, ...overrides,
  });
  add('missing conversation', [], { convId: '' });
  add('missing topic', [], { argument: 'agent:dev_daeri' });
  for (const argument of [null, false, 0, '', ' \n\t', {}, ['hello'], 3]) {
    add('argument ' + json(argument), [], { argument });
  }
  add('missing target', [], { argument: 'topic:주제' });
  add('unknown target', [], { argument: 'agent:unknown\ntopic:주제' });
  add('self consult', [], { callerId: 'dev_daeri' });
  add('agreement');
  add('partial', [partial]);
  add('partial without suggestion', [json({ stance: 'partial', reasoning: '보완' })]);
  add('partial false suggestion', [json({ stance: 'partial', reasoning: ['배열', null, '\ud800'], suggestion: false })]);
  add('round one failure', [{ error: 'provider failed' }]);
  add('round one raw fallback', ['  plain response 😀\ud800  ']);
  add('round one cut fallback', ['😀'.repeat(151) + '\ud800']);
  add('first bare line topic', [agree], { argument: 'agent:dev_daeri\n\ufeffTopic\u00a0\nignored continuation\nmy_view: First \ncontext: BG' });
  add('repeated settings last wins', [agree], { argument: 'agent:intern\nagent:dev_daeri\ntopic:first\ntopic:last\nmy_view:a\nmy_view:b\ncontext:c\ncontext:d' });
  add('empty view and background', [agree], { argument: 'agent:dev_daeri\ntopic:topic' });
  add('UTF16 argument', [agree], { argument: 'agent:dev_daeri\ntopic:😀\ud800\nmy_view:\udc00\ncontext:\ud800' });
  add('unknown caller', [agree], { callerId: 'unregistered' });
  add('legacy alias', [agree], { callerId: 'sawon' });
  add('intern target', [agree], { argument: 'agent:intern\ntopic:주제', callerId: 'dev_daeri' });
  add('caller accepts', [disagree, accept]);
  add('caller revises', [disagree, revise]);
  add('revised view falls back', [disagree, json({ stance: 'revise', reasoning: '수정 근거', revised_view: '' })]);
  add('round two failure', [disagree, { error: 'round two failed' }]);
  add('round two raw fallback', [disagree, 'non JSON caller']);
  add('no suggestion falls back reasoning', [json({ stance: 'disagree', reasoning: '근거' }), accept]);
  add('judge new direction', [disagree, insist, judge]);
  add('judge caller', [disagree, insist, json({ decision: 'caller', reasoning: 'r', final_direction: 'f' })]);
  add('judge target', [disagree, insist, json({ decision: 'target', reasoning: 'r', final_direction: 'f' })]);
  add('judge failure target rank wins', [disagree, insist, { error: 'judge failed' }]);
  add('judge failure caller rank wins', [disagree, insist, { error: 'judge failed' }], { callerId: 'dev_bujang' });
  add('judge failure equal rank caller wins', [disagree, insist, { error: 'judge failed' }], { callerId: 'plan_daeri' });
  add('judge raw fallback', [disagree, insist, 'raw '.repeat(101) + '\ud800']);
  add('different teams superior', [disagree, insist, judge], { callerId: 'plan_sawon' });
  add('missing round fields', ['{}', '{}', '{}']);
  add('primitive rounds', ['false', '42', '[]']);
  add('null property fields', [json({ stance: 'disagree', reasoning: null, suggestion: null }), json({ stance: 'insist', reasoning: null }), json({ decision: null, reasoning: null, final_direction: null })]);
  add('UTF16 model fields', [json({ stance: 'disagree', reasoning: '\ud800😀', suggestion: '\udc00' }), json({ stance: 'insist', reasoning: '\ud800' }), json({ decision: 'new', reasoning: '\udc00', final_direction: '\ud800' })]);
  add('structured model fields', [json({ stance: 'disagree', reasoning: ['a', null, ['\ud800']], suggestion: ['\udc00'] }), json({ stance: 'insist', reasoning: { nested: 'x' } }), json({ decision: 'new', reasoning: 1e-8, final_direction: 1e21 })]);
  add('literal surrogate JSON', ['{"stance":"agree","reasoning":"\ud800"}']);
  add('invalid escaped surrogate JSON', ['{"stance":"agree","reasoning":"\\\ud800"}']);
  add('custom coercion error', ['{"stance":"agree","reasoning":{"toString":false}}']);
  const fence = String.fromCharCode(96).repeat(3);
  for (const [prefix, suffix] of [['', ''], [fence, fence], [fence + 'json\n', '\n' + fence], [fence + 'JSON\n', '\n' + fence], [fence + 'json', ''], ['', fence], [fence + 'json \r\n', ' \n' + fence]]) {
    add('fence ' + json([prefix, suffix]), [prefix + agree + suffix]);
  }
  for (const [callerId, targetId] of [
    ['dev_daeri', 'dev_gwajang'], ['dev_gwajang', 'dev_bujang'], ['dev_bujang', 'daepyo'],
    ['design_daeri', 'design_teamlead'], ['mkt_sawon', 'admin_teamlead'], ['intern', 'dev_sawon'],
    ['unregistered', 'dev_daeri'], ['sawon', 'daeri'],
  ]) {
    assert.ok(AGENT_PROFILES[targetId], 'fixture target exists: ' + targetId);
    add('superior ' + callerId + ' ' + targetId, [disagree, insist, judge], {
      callerId, argument: `agent:${targetId}\ntopic:topic\nmy_view:view`,
    });
  }
  const fixtures = [];
  for (const input of cases) {
    const requests = [], events = [];
    let index = 0;
    class GeminiFixture {
      constructor(key, model) { this.model = model; }
      async send(system, user, options) {
        requests.push({ model: this.model, system, user, timeoutMs: options.timeoutMs });
        assert.ok(index < input.responses.length, 'script exhausted: ' + input.name);
        const response = input.responses[index++];
        if (response && typeof response === 'object' && 'error' in response) throw new Error(response.error);
        return response;
      }
    }
    const execute = vm.runInNewContext(original + '\nexecuteConsult', {
      AGENT_PROFILES, findCommonSuperior, getRankLevel,
      _GeminiClient: GeminiFixture, _geminiApiKey: 'fixture-no-network',
      _broadcast: (name, data) => events.push({ name, data }),
      console: { log() {} },
    }, { filename: 'original-execute-consult.js', timeout: 1000 });
    let output;
    try { output = { value: await execute(input.argument, { convId: input.convId, callerAgentId: input.callerId }) }; }
    catch (error) { output = { error: error.message }; }
    fixtures.push({ input, expected: { ...output, events, requests } });
  }
  return JSON.parse(JSON.stringify(fixtures));
}

export const fixtures = await makeFixtures();
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(fixtures) + '\n');
}
