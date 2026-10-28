// Pure state contracts from the original monitor. All providers are snapshots;
// no application import, timer, transport, process, or credential is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rawSource = readFileSync(new URL('../../lib/monitor-agent.js', import.meta.url), 'utf8');
assert.equal(rawSource.split("await import('./jira-service.js')").length, 2);
const source = rawSource.replace("await import('./jira-service.js')", '_fixtureJira').replaceAll('export function ', 'function ');
const epoch = Date.parse('2026-10-08T12:00:00.000Z');
const clean = value => JSON.parse(JSON.stringify(value));
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'id' && typeof item === 'string' && /^(alert|report)-\d+-[a-z0-9]+$/.test(item)
      ? item.replace(/-[a-z0-9]+$/, '-ID')
      : key === 'title' && value.source === 'idle' ? '[idle nag]' : normalize(item),
  ]));
  return value;
}
function original() {
  let now = epoch;
  let snapshot = {};
  let events = [];
  let reviews = [];
  let randomIndex = 1;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const math = Object.create(Math);
  math.random = () => ((randomIndex++ % 40000) + 0.5) / 46656;
  const context = vm.createContext({
    Date: FixedDate, Math: math, console: { log() {}, warn() {} },
    setInterval() { throw new Error('fixture must not start a timer'); },
    setTimeout() { throw new Error('fixture must not start a timer'); },
    _fixtureJira: {
      getMyIssues: async () => snapshot.jira?.issues || [],
      getAllActiveSprints: async () => snapshot.jira?.sprints || [],
    },
    _fixturePoller: {
      broadcast: (name, value) => events.push([name, value]),
      getCached(key) {
        const index = key.indexOf(':');
        return snapshot[key.slice(0, index)]?.[key.slice(index + 1)] ?? null;
      },
    },
    _fixtureCockpit: {
      listTerminals: () => snapshot.terminals || [],
      getProjects: () => snapshot.projects || [],
      readTerminalBuffer: id => snapshot.terminals?.find(term => term.termId === id)?.buffer ?? null,
    },
    _fixtureProjects: () => snapshot.projects || [],
    _fixtureJiraConfig: () => snapshot.jira ? { url: 'https://fixture.invalid', email: 'fixture', token: 'inert' } : null,
    _fixtureReview: async (agentId, prompt, metadata) => { reviews.push({ agentId, prompt, metadata }); },
  });
  const api = vm.runInContext(source + `
    _poller = _fixturePoller; _cockpit = _fixtureCockpit;
    _getProjects = _fixtureProjects; _getJiraConfig = _fixtureJiraConfig;
    ({ checkAll, getActiveAlerts, getReports, getAllReports, dismissAlert, clearAllAlerts,
       dismissReport, addReport: _addReport, ready(value) { _triggerReview = value ? _fixtureReview : null; } })`, context, { timeout: 1000 });
  return async (input, oracleSnapshot = input.snapshot) => {
    now = input.now;
    events = []; reviews = [];
    let result = null;
    switch (input.operation) {
      case 'scan': snapshot = oracleSnapshot; api.ready(snapshot.reviewReady); await api.checkAll(); break;
      case 'dismissAlert': {
        const alert = input.key ? api.getActiveAlerts().find(alert => alert._alertKey === input.key) : null;
        result = api.dismissAlert(alert?.id ?? input.id ?? 'missing'); break;
      }
      case 'clearAlerts': result = api.clearAllAlerts(); break;
      case 'addReport': result = api.addReport(input.report); break;
      case 'dismissReport': {
        const report = Object.hasOwn(input, 'index') ? api.getAllReports()[input.index] : null;
        result = api.dismissReport(report?.id ?? input.id ?? 'missing'); break;
      }
      default: throw new Error('unknown fixture operation');
    }
    return normalize(clean({ result, events, reviews, alerts: api.getActiveAlerts(), reports: api.getReports(), allReports: api.getAllReports() }));
  };
}

const fixtures = [];
async function scenario(label, steps, corrected) {
  const run = original();
  const outputs = [];
  for (const step of steps) {
    const { oracleSnapshot, ...input } = step;
    outputs.push({ input, expected: await run(input, oracleSnapshot ?? input.snapshot) });
  }
  fixtures.push({ label, ...(corrected ? { corrected } : {}), steps: outputs });
}
const project = { id: 'p1', name: '프로젝트😀\ud800', path: '/fixture/project', github: 'fixture/repo' };
const second = { id: 'p2', name: '두 번째', path: '/fixture/second', github: 'fixture/second' };
const term = buffer => ({ termId: 't1', projectId: 'p1', command: 'claude', buffer });
const scan = (snapshot, offset = 0) => ({ operation: 'scan', snapshot, now: epoch + offset });
const git = (hash = 'oldhash', count = 0) => ({ recentCommits: [{ hash, message: '커밋 메시지😀\ud800' }], stagedFiles: Array.from({ length: count }, (_, i) => ({ file: 'file-' + i })), unstagedFiles: [] });
const rawIssue = (status, updated, summary = 'Jira 작업😀\ud800') => ({ key: 'TEST-1', fields: { status: { name: status }, updated, summary } });

await scenario('empty state', [scan({}), scan({ projects: [], terminals: [] }, 600001), { operation: 'dismissAlert', id: 'missing', now: epoch }, { operation: 'clearAlerts', now: epoch }, { operation: 'dismissReport', id: 'missing', now: epoch }]);
for (const pattern of ['ENOENT', 'eacces', 'EPERM', 'EADDRINUSE', 'segfault', 'SIGSEGV', 'SIGABRT', 'SIGKILL', 'FATAL', 'panic', 'OOM', 'OutOfMemory', 'heap out of memory', 'npm ERR!', 'FAIL unit test', 'Tests: 3 failed', 'Traceback (most recent call last)', 'Unhandled rejection', 'Unhandled promise rejection', 'TypeError', 'ReferenceError', 'SyntaxError', 'BUILD FAILED', 'Compilation failed', 'error TS1234:', '[ERROR] hello', '[ERROR] four', 'xENOENTx', 'all tests passed']) {
  await scenario('terminal pattern: ' + pattern, [scan({ projects: [project], terminals: [term('before😀\ud800\n' + pattern + '\nafter\udc00')] })]);
}
await scenario('terminal ANSI/context/priority', [scan({ projects: [project], terminals: [term('\u001b[31m' + '앞'.repeat(130) + '\ud800TypeError ENOENT\u001b[0m' + '뒤'.repeat(250) + '\u001b]0;title\u0007')] })]);
await scenario('new data only and duplicate type fallback', [
  scan({ projects: [project], terminals: [term('ENOENT')] }),
  scan({ projects: [project], terminals: [term('ENOENT')] }, 1000),
  scan({ projects: [project], terminals: [term('ENOENT ENOENT TypeError')] }, 2000),
  scan({ projects: [project], terminals: [term('ENOENT ENOENT TypeError ENOENT')] }, 300000),
]);
await scenario('multiple terminals keep insertion tie order', [scan({ projects: [project], terminals: [term('ENOENT'), { termId: 't2', projectId: 'unknown', command: '', buffer: 'TypeError' }, { termId: 't3', projectId: 'p1', buffer: 'panic' }] })]);
await scenario('dead terminal offsets removed', [scan({ terminals: [term('ENOENT')] }), scan({ terminals: [] }, 1000), scan({ terminals: [term('ENOENT TypeError')] }, 2000)]);

const failure = { id: 17, name: 'CI😀\ud800', conclusion: 'failure', head_branch: 'main', html_url: 'https://fixture.invalid/run/17' };
await scenario('CI GitHub gate and first run only', [scan({ projects: [project, { ...second, github: '' }], cicd: { p1: { runs: [{ ...failure, conclusion: 'success' }, failure] }, p2: { runs: [failure] } } }), scan({ projects: [project], cicd: { p1: { runs: [failure] } } }, 1000)]);
await scenario('CI cooldown and ten minute active expiry', [0, 299999, 300000, 600000, 600001].map(offset => scan({ projects: [project], cicd: { p1: { runs: [failure] } } }, offset)));
await scenario('dismissed history expires only after the cleanup cycle', [
  scan({ projects: [project], cicd: { p1: { runs: [failure] } } }),
  { operation: 'dismissAlert', key: 'cicd:failure:p1:17', now: epoch + 1 },
  scan({ projects: [project], cicd: { p1: { runs: [failure] } } }, 300001),
  scan({ projects: [project], cicd: { p1: { runs: [failure] } } }, 1800002),
  scan({ projects: [project], cicd: { p1: { runs: [failure] } } }, 1800003),
]);
await scenario('clear does not erase cooldown history', [scan({ projects: [project], cicd: { p1: { runs: [failure] } } }), { operation: 'clearAlerts', now: epoch + 1 }, scan({ projects: [project], cicd: { p1: { runs: [failure] } } }, 2), scan({ projects: [project], cicd: { p1: { runs: [failure] } } }, 300000)]);
await scenario('CI missing optional fields', [scan({ projects: [project], cicd: { p1: { runs: [{ conclusion: 'failure' }] } } })]);

await scenario('Git baseline then commit and changed files share review cooldown', [
  scan({ projects: [project], git: { p1: git() }, reviewReady: true }),
  scan({ projects: [project], git: { p1: git('new😀hash', 6) }, reviewReady: true }, 1000),
  scan({ projects: [project], git: { p1: git('third', 9) }, reviewReady: true }, 2000),
  scan({ projects: [project], git: { p1: git('fourth', 12) }, reviewReady: true }, 301000),
]);
await scenario('Git count increase threshold and absent review callback', [
  scan({ projects: [project], git: { p1: git() } }),
  scan({ projects: [project], git: { p1: git('oldhash', 2) } }, 1000),
  scan({ projects: [project], git: { p1: git('oldhash', 4) } }, 2000),
  scan({ projects: [project], git: { p1: { ...git('newhash'), stagedFiles: ['one', { name: 'two' }, { file: 'three' }], unstagedFiles: [{ file: 'four' }, 'five', 'six', 'seven'] } }, reviewReady: true }, 3000),
]);
await scenario('independent project review cooldown', [scan({ projects: [project, second], git: { p1: git(), p2: git() }, reviewReady: true }), scan({ projects: [project, second], git: { p1: git('a'), p2: git('b') }, reviewReady: true }, 1000)]);
await scenario('Git exact five minute boundary', [scan({ projects: [project], git: { p1: git() }, reviewReady: true }), scan({ projects: [project], git: { p1: git('a') }, reviewReady: true }, 1), scan({ projects: [project], git: { p1: git('b') }, reviewReady: true }, 300000), scan({ projects: [project], git: { p1: git('c') }, reviewReady: true }, 300001)]);

await scenario('Jira baseline/status/update/missing snapshot', [
  scan({ jira: { issues: [rawIssue('Todo', 'first')], sprints: [] } }),
  scan({ jira: { issues: [rawIssue('In Progress', 'second')], sprints: [] } }, 120000),
  scan({ jira: { issues: [rawIssue('In Progress', 'third')], sprints: [] } }, 240000),
  scan({}, 360000),
  scan({ jira: { issues: [rawIssue('Done', 'fourth', '')], sprints: [] } }, 480000),
]);
await scenario('Jira sprint deadline strict boundaries and rounding', [scan({ jira: { issues: [], sprints: [
  ...[-1, 0, 0.1, 0.5, 1.5, 23.9, 24, 25].map((hours, i) => ({ id: i, name: 'Sprint ' + hours, endDate: new Date(epoch + hours * 3600000).toISOString() })),
  { id: 99, name: 'invalid', endDate: 'invalid' }, { id: 100, name: 'missing' },
] } })]);
await scenario('Jira missing field fallbacks', [scan({ jira: { issues: [{ key: 'TEST-2' }], sprints: [] } }), scan({ jira: { issues: [{ key: 'TEST-2', fields: { status: { name: 'Done' }, updated: 'next' } }], sprints: [] } }, 120000)]);

await scenario('idle strictly after ten minutes and thirty minute nag cooldown', [0, 600000, 600001, 2400001, 2400002].map(offset => scan({ terminals: [term('ready')] }, offset)));
await scenario('one active terminal prevents global idle nag', [scan({ terminals: [term('ready'), { ...term('waiting'), termId: 't2' }] }), scan({ terminals: [term('ready'), { ...term('waiting new'), termId: 't2' }] }, 600001)]);
await scenario('empty terminal buffer does not count as idle', [scan({ terminals: [term('')] }), scan({ terminals: [term('')] }, 1800001)]);
await scenario('event ordering across terminal CI Jira Git idle', [
  scan({ projects: [project], terminals: [term('ready')], git: { p1: git() }, jira: { issues: [rawIssue('Todo', 'first')], sprints: [] }, reviewReady: true }),
  scan({ projects: [project], terminals: [term('ready TypeError')], cicd: { p1: { runs: [failure] } }, git: { p1: git('newhash', 3) }, jira: { issues: [rawIssue('Done', 'second')], sprints: [] }, reviewReady: true }, 600001),
]);

await scenario('reports newest first, caller ID, dismissal and immutable fields', [
  { operation: 'addReport', report: { agentId: 'dev_sawon', content: '보고😀\ud800', timestamp: 0, dismissed: true }, now: epoch },
  { operation: 'addReport', report: { id: 'fixed', title: '둘째', extra: { preserve: true } }, now: epoch + 1 },
  { operation: 'dismissReport', id: 'fixed', now: epoch + 2 },
  { operation: 'dismissReport', index: 1, now: epoch + 3 },
  { operation: 'dismissReport', id: 'missing', now: epoch + 4 },
]);
await scenario('report retention keeps fifty newest', Array.from({ length: 53 }, (_, i) => ({ operation: 'addReport', report: { id: 'r-' + i, content: 'report ' + i }, now: epoch + i })));
await scenario('report spread primitive and duplicate IDs', [
  ...[null, false, 1, ['a', 'b'], '😀\ud800', { id: 'same', content: 'first' }, { id: 'same', content: 'second' }].map((report, i) => ({ operation: 'addReport', report, now: epoch + i })),
  { operation: 'dismissReport', id: 'same', now: epoch + 8 },
]);

// Corrected inputs are explicitly separated from source compatibility. The
// oracle receives equivalent growing replay text or the raw Jira issue shape.
const rotations = [
  ['old-prefix-ready', 'ready\nTypeError new'],
  ['12345678901234567890ready', 'ready\nEACCES'],
  ['waiting....', 'SyntaxError'],
];
for (const [old, current] of rotations) {
  const appended = current.startsWith('ready') ? current.slice(5) : current;
  await scenario('corrected rotated buffer: ' + current, [scan({ terminals: [term(old)] }), { ...scan({ terminals: [term(current)] }, 1000), oracleSnapshot: { terminals: [term(old + appended)] } }], 'Scan new suffix when capped buffers change without length growth.');
}
await scenario('corrected equal-length activity prevents false idle', [scan({ terminals: [term('aaaa')] }), { ...scan({ terminals: [term('bbbb')] }, 600001), oracleSnapshot: { terminals: [term('aaaabbbb')] } }, { ...scan({ terminals: [term('bbbb')] }, 1200002), oracleSnapshot: { terminals: [term('aaaabbbb')] } }], 'Any buffer content change resets idle activity.');
await scenario('corrected cleared terminal resumes scanning', [scan({ terminals: [term('ready-no-errors')] }), scan({ terminals: [term('')] }, 1000), { ...scan({ terminals: [term('ENOENT')] }, 2000), oracleSnapshot: { terminals: [term('ready-no-errorsENOENT')] } }], 'Cleared replay buffers reset the previous scan offset.');
await scenario('corrected flattened Jira provider shape', ['Todo', 'In Progress', 'In Progress'].map((status, i) => ({
  ...scan({ jira: { issues: [{ key: 'TEST-1', status: { name: status }, updated: 'update-' + i, summary: 'flat😀\ud800' }], sprints: [] } }, i * 120000),
  oracleSnapshot: { jira: { issues: [rawIssue(status, 'update-' + i, 'flat😀\ud800')], sprints: [] } },
})), 'jira-service returns simplified issues instead of raw.fields; both shapes are accepted.');

export { fixtures };
if (process.argv.includes('--emit')) process.stdout.write(JSON.stringify(fixtures, null, 2) + '\n');
