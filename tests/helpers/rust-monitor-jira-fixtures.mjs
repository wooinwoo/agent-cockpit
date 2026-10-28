// In-memory oracle: original Jira normalization, pagination, board/sprint
// aggregation and locale sorting. No transport or local configuration is loaded.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = await readFile(new URL('../../lib/jira-service.js', import.meta.url), 'utf8');
const start = source.indexOf('function makeRequest(config, method, path, body)');
const end = source.indexOf('function simplifyIssue(raw)', start);
assert.ok(start >= 0 && end > start);
const code = (source.slice(0, start) + 'const makeRequest = globalThis.fixtureRequest;\n' + source.slice(end))
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const issuePath = '/rest/api/3/search/jql';
const boardPath = '/rest/agile/1.0/board?maxResults=50';
const sprintPath = id => `/rest/agile/1.0/board/${id}/sprint?state=active,future&maxResults=10`;
const page = (issues, extra = {}) => ({ path: issuePath, body: { issues, ...extra } });
const boards = values => ({ path: boardPath, body: { values } });
const sprints = (id, values) => ({ path: sprintPath(id), body: { values } });
const issue = (id, fields = {}) => ({ key: 'FIX-' + id, id: String(id), fields: { summary: '작업 ' + id, ...fields } });

export async function makeFixtures() {
  const inputs = [];
  const add = (name, replies) => inputs.push({ name, replies });
  add('empty monitor snapshot', [page([]), boards([])]);
  add('no scrum boards', [page([issue(1)]), boards([{ id: 1, type: 'kanban' }, { id: 2, type: 'simple' }, { id: 3 }])]);
  add('issue pages request remaining maximum', [
    page(Array.from({ length: 7 }, (_, index) => issue(index)), { nextPageToken: 'next-8' }),
    page(Array.from({ length: 8 }, (_, index) => issue(index + 7)), { nextPageToken: 'ignored-limit' }), boards([]),
  ]);
  add('issue empty page stops', [page([issue(1)], { nextPageToken: 'empty' }), page([], { nextPageToken: 'ignored-empty' }), boards([])]);
  add('issue missing token stops', [page([issue(1)]), boards([])]);
  add('issue isLast stops', [page([issue(1)], { isLast: true, nextPageToken: 'ignored-last' }), boards([])]);
  add('issue failure rejects snapshot', [{ path: issuePath, status: 403 }]);
  add('malformed issue response rejects snapshot', [{ path: issuePath, body: { issues: {} } }]);
  add('board failure preserves issues', [page([issue(1)]), { path: boardPath, status: 500 }]);
  add('board null response preserves issues', [page([issue(1)]), { path: boardPath, body: null }]);
  add('board malformed values preserves issues', [page([issue(1)]), { path: boardPath, body: { values: true } }]);
  add('sprint normalization', [page([issue(1, { status: { name: '진행 중' }, updated: '2027-01-01T12:00:00Z', story_points: 0 })]),
    boards([{ id: 1, name: '개발', type: 'scrum' }]),
    sprints(1, [{ id: 11, name: 'Sprint A', state: 'active', startDate: '2027-01-01', endDate: '2027-01-15', goal: '목표😀\ud800' }, { id: 12, name: 'Sprint B', state: 'future' }]),
  ]);
  add('individual sprint failures preserve successful boards', [page([issue(1)]),
    boards([{ id: 1, type: 'scrum' }, { id: 2, type: 'scrum' }, { id: 3, type: 'scrum' }, { id: 4, type: 'kanban' }]),
    { path: sprintPath(1), status: 503 }, sprints(2, [{ id: 21, state: 'active', name: 'Success' }]), { path: sprintPath(3), body: null },
  ]);
  add('dedup active overrides earlier future and later active wins', [page([]),
    boards([{ id: 1, type: 'scrum' }, { id: 2, type: 'scrum' }, { id: 3, type: 'scrum' }]),
    sprints(1, [{ id: 99, state: 'future', name: 'first future' }, { id: 98, state: 'active', name: 'first active' }]),
    sprints(2, [{ id: 99, state: 'active', name: 'active replacement' }, { id: 98, state: 'future', name: 'ignored future' }]),
    sprints(3, [{ id: 99, state: 'active', name: 'last active' }]),
  ]);
  add('name locale sort and active precedence', [page([]), boards([{ id: 1, type: 'scrum' }]),
    sprints(1, ['z', '10', 'A', 'a', 'á', '2', '한글', '😀', '\ud800'].map((name, index) => ({ id: index, name, state: index < 5 ? 'active' : 'future' }))),
  ]);
  add('numeric and string sprint IDs are distinct', [page([]), boards([{ id: '1', type: 'scrum' }]),
    sprints('1', [{ id: 5, name: 'number', state: 'active' }, { id: '5', name: 'string', state: 'active' }]),
  ]);
  add('missing versus null sprint IDs distinct', [page([]), boards([{ id: 1, type: 'scrum' }]),
    sprints(1, [{ name: 'missing', state: 'future' }, { id: null, name: 'null', state: 'future' }, { name: 'missing newer', state: 'future' }]),
  ]);
  add('sprint defaults preserve zero false values', [page([]), boards([{ id: 1, type: 'scrum' }]),
    sprints(1, [{ id: 0, name: '', state: false, startDate: '', endDate: false, goal: 0 }]),
  ]);
  add('null sprint entry discards that board', [page([]), boards([{ id: 1, type: 'scrum' }, { id: 2, type: 'scrum' }]),
    sprints(1, [null]), sprints(2, [{ id: 20, name: 'Kept', state: 'active' }]),
  ]);
  add('invalid name collection remains optional', [page([]), boards([{ id: 1, type: 'scrum' }]),
    sprints(1, [{ id: 1, name: { invalid: true }, state: 'active' }, { id: 2, name: { invalid: true }, state: 'active' }]),
  ]);
  const fixtures = [];
  for (const input of inputs) {
    const requests = [];
    const replies = [...input.replies];
    const fixtureRequest = async (_config, method, path, body) => {
      requests.push({ method, path, ...(body === undefined ? {} : { body }) });
      const index = replies.findIndex(reply => reply.path === path);
      assert.ok(index >= 0, 'unexpected request: ' + input.name + ': ' + path);
      const reply = replies.splice(index, 1)[0];
      const status = reply.status || 200;
      if (status >= 400) {
        if (status === 401) throw new Error('Jira API 토큰이 만료되었거나 유효하지 않습니다');
        if (status === 403) throw new Error('Jira 접근 권한이 없습니다');
        throw new Error(reply.body?.errorMessages?.[0] || reply.body?.message || `Jira API ${status}`);
      }
      return reply.body;
    };
    const api = vm.runInNewContext(code + '\n({ getMyIssues, getAllActiveSprints })', { fixtureRequest, URLSearchParams }, { timeout: 1000 });
    const config = { url: 'https://fixture.invalid', email: 'fixture@example.invalid', token: 'fixture-token' };
    let output;
    try {
      const issues = await api.getMyIssues(config, { maxResults: 15 });
      let sprints = [];
      try { sprints = await api.getAllActiveSprints(config); } catch { /* Original monitor makes sprint lookup optional. */ }
      output = { value: { issues, sprints } };
    } catch (error) { output = { error: error.message }; }
    if (Object.hasOwn(output, 'value')) {
      assert.ok(requests.some(request => request.path === boardPath), 'successful issue scan must reach original getBoards: ' + input.name);
    }
    assert.equal(replies.length, 0, 'every scripted Jira request must execute: ' + input.name);
    fixtures.push({ input, expected: { ...output, requests } });
  }
  return JSON.parse(JSON.stringify(fixtures));
}

export const fixtures = await makeFixtures();
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(fixtures) + '\n');
}
