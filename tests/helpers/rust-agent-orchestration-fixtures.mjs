import { original } from './rust-agent-runtime-fixtures.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const raw = (message, tool_calls = [], is_final = false) => JSON.stringify({ thinking: 'plan', message, tool_calls, is_final });
const read = { tool: 'READ', argument: 'small.md' };
const task = (id, assignee = 'dev_sawon', deps = []) => ({ id, description: `작업 ${id}`, assignee, deps });
const plan = tasks => JSON.stringify({ delegation_message: '분배', tasks });
const approved = JSON.stringify({ has_issues: false, conflicts: [], rejections: [], approved: ['t1', 't2'] });
const two = [task('t1'), task('t2', 'plan_sawon', ['t1'])];
const independent = [task('t1'), task('t2', 'plan_sawon')];
const cases = [
  { name: 'sub-plain', kind: 'sub', responses: ['done'] },
  { name: 'sub-tools', kind: 'sub', responses: [raw('읽기', [read]), raw('완료')], results: ['contents'] },
  { name: 'sub-denied', kind: 'sub', agent: 'intern', responses: [raw('시도', [{ tool: 'BASH', argument: 'pwd' }]), raw('다른 방법')] },
  { name: 'sub-empty', kind: 'sub', responses: ['', raw('다시 응답')] },
  { name: 'sub-limit', kind: 'sub', maxIter: 1, responses: [raw('읽기', [read])], results: ['x'] },
  { name: 'sub-throw-tool', kind: 'sub', responses: [raw('읽기', [read]), raw('중단')], results: [{ error: 'fixture read failed' }] },
  { name: 'sub-unicode', kind: 'sub', message: '😀\ud800', responses: [raw('읽기', [read], true)], results: ['😀'.repeat(2600)] },
  { name: 'sub-edit-write', kind: 'sub', responses: [raw('작성', [{ tool: 'WRITE', file: 'a', content: '😀' }, { tool: 'EDIT', file: 'b', old_content: 'x', new_content: 'y' }]), raw('완료')], results: ['ok', 'ok'] },
  { name: 'parallel', responses: [plan([task('t1'), task('t2', 'plan_sawon')]), raw('개발 결과'), raw('기획 결과'), approved, '종합'] },
  { name: 'dependency', responses: [plan(two), raw('첫 결과', [read]), raw('개발 결과'), raw('기획 결과'), approved, '종합'], results: ['file'] },
  { name: 'single', responses: [plan([task('t1')]), raw('개발 결과'), '종합'] },
  { name: 'bad-plan-fallback', responses: ['not a plan', raw('혼자 처리')] },
  { name: 'planning-error', responses: [{ error: 'plan provider down' }] },
  { name: 'synthesis-error', responses: [plan([task('t1')]), raw('결과'), { error: 'synthesis provider down' }] },
  { name: 'review-error', responses: [plan(two), raw('A'), raw('B'), { error: 'review provider down' }, '종합'] },
  { name: 'review-null', responses: [plan(two), raw('A'), raw('B'), 'null', '종합'] },
  { name: 'team-scoped', orchestrator: 'plan_teamlead', responses: [plan([task('t1', 'plan_sawon')]), raw('문서'), '기획 결과'] },
];
for (const winner of ['task_a', 'task_b', 'merge']) {
  const review = { has_issues: true, conflicts: [{ task_a: 't1', task_b: 't2', description: '서로 다름' }], rejections: [] };
  cases.push({ name: `conflict-${winner}`, responses: [plan(independent), raw('A'), raw('B'), JSON.stringify(review), JSON.stringify({ winner, reasoning: '근거', merged_result: '통합 😀\ud800' }), '종합'] });
}
cases.push({ name: 'conflict-provider-fallback', responses: [plan(independent), raw('A'), raw('B'), JSON.stringify({ has_issues: true, conflicts: [{ task_a: 't1', task_b: 't2', description: '다름' }] }), { error: 'resolution unavailable' }, '종합'] });
cases.push({ name: 'review-retry', responses: [plan(independent), raw('A'), raw('B'), JSON.stringify({ has_issues: true, rejections: [{ task_id: 't1', reason: '누락', feedback: '고쳐' }], conflicts: [] }), raw('수정 A'), '종합'] });

export async function makeFixtures() {
  const fixtures = [];
  for (const input of cases) {
    const { api, events, calls, requests } = original(input);
    const agent = input.agent || 'dev_sawon';
    const teams = { dev: api.buildDevTeamContext(), plan: api.buildPlanTeamContext(), design: api.buildDesignTeamContext(), admin: api.buildAdminTeamContext(), marketing: api.buildMktTeamContext() };
    const message = input.message || '전체 작업';
    const conv = { messages: [{ role: 'user', content: message, ts: 123456 }], createdAt: 123456 };
    let result = null;
    if (input.kind === 'sub') {
      const subTask = task('sub', agent);
      result = await api.runSubAgentLoop('fixture', subTask, api.AGENT_PROFILES[agent], '앞선 결과', message, { aborted: false }, { maxIter: input.maxIter });
    } else {
      await api.runOrchestratedLoop('fixture', conv, message, input.orchestrator || 'daepyo', { saveHistory() {} });
    }
    fixtures.push({ input: { ...input, teams }, expected: { events, calls, requests, messages: conv.messages, result } });
  }
  return JSON.parse(JSON.stringify(fixtures));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixtures = await makeFixtures();
  writeFileSync(new URL('../fixtures/rust-agent-orchestration.json', import.meta.url), JSON.stringify(fixtures) + '\n');
  console.log(`Orchestration reference cases: ${fixtures.length}`);
}
