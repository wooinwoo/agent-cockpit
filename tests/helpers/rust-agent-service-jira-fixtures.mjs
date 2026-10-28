// Source differential oracle for JIRA. Only the HTTP transport is replaced;
// executeJira, issue normalization, request paths, JQL and pagination are original.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const tools = await readFile(new URL('../../lib/agent-tools.js', import.meta.url), 'utf8');
const service = await readFile(new URL('../../lib/jira-service.js', import.meta.url), 'utf8');
const toolStart = tools.indexOf('async function executeJira(arg)');
const toolEnd = tools.indexOf('async function executeCicd(arg)', toolStart);
const requestStart = service.indexOf('function makeRequest(config, method, path, body)');
const requestEnd = service.indexOf('function simplifyIssue(raw)', requestStart);
assert.ok(toolStart >= 0 && toolEnd > toolStart && requestStart >= 0 && requestEnd > requestStart);
const serviceCode = (service.slice(0, requestStart) +
  'const makeRequest = globalThis.fixtureRequest;\n' + service.slice(requestEnd))
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const toolCode = tools.slice(toolStart, toolEnd);
const now = Date.UTC(2030, 0, 15, 12);
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const issue = (key = 'PROJ-12', fields = {}) => ({ key, id: key.slice(-2), fields: { summary: '기본 작업', ...fields } });
const page = (issues, extra = {}) => ({ body: { issues, ...extra } });
const fail = (status, body = {}) => ({ status, body });
const full = issue('PROJ-12', {
  summary: '배포 검증 😀\ud800', status: { name: '진행 중', statusCategory: { key: 'indeterminate' } },
  priority: { name: '높음', iconUrl: 'https://fixture.invalid/high.svg' },
  assignee: { displayName: '담당😀', avatarUrls: { '24x24': 'https://fixture.invalid/avatar' } },
  reporter: { displayName: '보고자' }, duedate: '2020-01-01', created: '2025-01-01T12:00:00Z',
  updated: '2025-01-06T12:34:56.000+0900', issuetype: { name: 'Task', subtask: false },
  sprint: { name: '현재 스프린트', state: 'active', id: 1 }, labels: ['ship', '\udc00'],
  story_points: 3, customfield_10016: 9, parent: { key: 'PROJ-1', fields: { summary: '상위 작업' } },
  description: 'A'.repeat(599) + '😀tail', comment: { comments: [{ id: '1', author: { displayName: '작성자' }, body: 'comment', created: '2025-01-01' }] },
});

export async function makeFixtures() {
  const inputs = [];
  const add = (name, argument, responses = [], extras = {}) => inputs.push({ name, argument, responses, ...extras });
  add('unconfigured', 'PROJ-1', [], { config: null });
  add('missing token', 'PROJ-1', [], { config: { url: 'https://fixture.invalid', email: 'fixture@example.invalid' } });
  for (const argument of [null, false, 1, {}, [], 'nope', '', 'JQL:', 'search: ', 'A_1-2', 'A1-2', 'PROJ--2']) {
    add('argument ' + JSON.stringify(argument), argument);
  }
  add('full detail', ' proj-12 ', [{ body: full }]);
  add('minimal detail', 'ABC-1', [{ body: issue('ABC-1') }]);
  add('optional undefined properties', 'ABC-1', [{ body: issue('ABC-1', { assignee: {}, reporter: {}, status: {}, priority: {}, issuetype: {}, sprint: {}, parent: {} }) }]);
  add('zero story points retained', 'ABC-1', [{ body: issue('ABC-1', { story_points: 0, customfield_10016: 7 }) }]);
  add('legacy story points', 'ABC-1', [{ body: issue('ABC-1', { customfield_10016: 7 }) }]);
  add('ADF description', 'ABC-1', [{ body: issue('ABC-1', { description: { type: 'doc', content: [] } }) }]);
  add('future due and invalid updated', 'ABC-1', [{ body: issue('ABC-1', { duedate: '2099-01-02', updated: 'bad date' }) }]);
  add('same day overdue after midnight', 'ABC-1', [{ body: issue('ABC-1', { duedate: '2030-01-15' }) }]);
  add('null issue', 'ABC-1', [{ body: null }]);
  add('bad due date type', 'ABC-1', [{ body: issue('ABC-1', { duedate: true }) }]);
  add('bad labels type', 'ABC-1', [{ body: issue('ABC-1', { labels: 'label' }) }]);
  add('bad comments type', 'ABC-1', [{ body: issue('ABC-1', { comment: { comments: {} } }) }]);
  add('null comment', 'ABC-1', [{ body: issue('ABC-1', { comment: { comments: [null] } }) }]);
  add('array label coercion', 'ABC-1', [{ body: issue('ABC-1', { labels: [null, ['\ud800', null], false], summary: ['summary', '\udc00'] }) }]);
  add('JQL full list', ' JqL: assignee = currentUser() ORDER BY updated DESC ', [page([full, issue('PROJ-13'), issue('PROJ-14', { status: { name: '진행 중' }, duedate: '2099-01-01' })])]);
  add('JQL empty', 'jql: status = "Done"', [page([])]);
  add('JQL preserves literal UTF16', 'jql: summary ~ "\ud800"', [page([])]);
  add('JQL integer status ordering', 'jql: project = A', [page(['10', 'z', '2', 'z', '01'].map((name, index) => issue('A-' + index, { status: { name } }))) ]);
  add('keyword list', 'SeArCh: 배포', [page([full])]);
  add('keyword empty', 'search: missing', [page([])]);
  add('keyword UTF16 empty', 'search: 😀\ud800', [page([])]);
  add('keyword fallback filters summary or key', 'search: dep', [fail(500), page([issue('DEP-1'), issue('A-2', { summary: 'DEPLOY' }), issue('A-3')], { isLast: true })]);
  add('keyword fallback paginates', 'search: match', [fail(400), page([issue('A-1', { summary: 'Match first' })], { nextPageToken: 'page-two' }), page([issue('A-2', { summary: 'MATCH second' })], { isLast: true })]);
  add('keyword fallback no page token', 'search: other', [fail(500), page([issue('A-1')])]);
  add('keyword fallback empty batch', 'search: other', [fail(500), page([], { nextPageToken: 'ignored' })]);
  add('keyword fallback Unicode lower', 'search: ος\ud800', [fail(500), page([issue('A-1', { summary: 'ΟΣ\ud800' })], { isLast: true })]);
  add('keyword fallback lower dotted I', 'search: i\u0307', [fail(500), page([issue('A-1', { summary: 'İ' })], { isLast: true })]);
  add('keyword fallback limit 30', 'search: item', [fail(500), page(Array.from({ length: 30 }, (_, index) => issue('A-' + index, { summary: 'item ' + index })), { nextPageToken: 'ignored' })]);
  for (const [status, body] of [[401, {}], [403, {}], [404, { errorMessages: ['missing'] }], [500, { message: 'server broken' }], [503, {}], [400, { errorMessages: ['\ud800'] }]]) {
    add('detail HTTP error ' + status, 'ABC-1', [fail(status, body)]);
  }
  add('JQL unsupported error', 'jql: x', [fail(500, { message: 'searchIssues unavailable' })]);
  add('fallback failure returns second error', 'search: x', [fail(500, { message: 'first' }), fail(403)]);
  for (const body of [null, {}, { issues: null }, { issues: {} }, { issues: [null] }]) {
    add('search response ' + JSON.stringify(body), 'jql: x', [{ body }]);
  }
  const fixtures = [];
  for (const input of inputs) {
    const requests = [];
    let responseIndex = 0;
    const config = Object.hasOwn(input, 'config') ? input.config : {
      url: 'https://fixture.invalid', email: 'fixture@example.invalid', token: 'fixture-token',
    };
    const fixtureRequest = async (config, method, path, body) => {
      requests.push({ method, path, ...(body === undefined ? {} : { body }) });
      assert.ok(responseIndex < input.responses.length, 'script exhausted: ' + input.name);
      const response = input.responses[responseIndex++];
      const status = response.status || 200;
      if (status >= 400) {
        if (status === 401) throw new Error('Jira API 토큰이 만료되었거나 유효하지 않습니다');
        if (status === 403) throw new Error('Jira 접근 권한이 없습니다');
        throw new Error(response.body?.errorMessages?.[0] || response.body?.message || `Jira API ${status}`);
      }
      return response.body;
    };
    const context = vm.createContext({ fixtureRequest, Date: FixedDate });
    const api = vm.runInContext(serviceCode + '\n({ searchIssues, getMyIssues, getIssue, simplifyIssue })', context, { timeout: 1000 });
    context._getJiraConfig = () => config;
    context.getJiraService = async () => api;
    const execute = vm.runInContext(toolCode + '\nexecuteJira', context, { timeout: 1000 });
    let output;
    try { output = { value: await execute(input.argument) }; }
    catch (error) { output = { error: error.message }; }
    fixtures.push({ input: { ...input, now }, expected: { ...output, requests } });
  }
  return JSON.parse(JSON.stringify(fixtures));
}

export const fixtures = await makeFixtures();
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(fixtures) + '\n');
}
