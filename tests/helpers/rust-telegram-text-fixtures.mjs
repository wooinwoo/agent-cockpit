// Pure source functions only. Services are flat, synthetic in-memory snapshots.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(new URL('../../lib/telegram-bridge.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Telegram pure function boundaries: ${start}`);
  return source.slice(a, b);
}
const utilities = section('function timeAgo(', '// ─── Todo backlog');
const contextSource = section('function buildCockpitContext()', '// ─── Agent helpers');
const helpSource = section('function cmdHelp()', 'function cmdStatus(');
const durationSource = section('function parseDuration(', 'export async function requestApproval(');
const correctedContext = contextSource
  .replace("sess.state === 'active' ? '🟢'", "(sess.state === 'active' || sess.state === 'busy') ? '🟢'\n          : sess.state === 'waiting' ? '🟠'")
  .replace('pendingTodos[0].text.slice(0, 60)', 'maskSecrets(pendingTodos[0].text).slice(0, 60)')
  .replaceAll("(d.input?.command || d.input?.file_path || '').toString().slice(0, 80)", "maskSecrets((d.input?.command || d.input?.file_path || '').toString()).slice(0, 80)")
  .replace("(d.reasoning || '').slice(0, 100)", "maskSecrets(d.reasoning || '').slice(0, 100)")
  .replace("return lines.join('\\n');", "return maskSecrets(lines.join('\\n'));");
assert.notEqual(contextSource, correctedContext);
const clean = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function evaluate(input, corrected = false) {
  const snapshot = input.snapshot || {};
  const now = input.now ?? 1791450000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const cockpit = {};
  if (own(snapshot, 'projects')) {
    cockpit.getProjects = () => snapshot.projects;
    cockpit.poller = { getCached(key) {
      const [kind, ...parts] = key.split(':');
      return snapshot.projects?.findLast(project => String(project.id) === parts.join(':'))?.[kind];
    } };
  }
  if (own(snapshot, 'decisions')) cockpit.supervisor = {
    getMode: () => snapshot.mode,
    getRecentDecisions: n => snapshot.decisions.slice(-n),
    getPendingCount: () => snapshot.pending,
  };
  if (own(snapshot, 'terminals')) {
    cockpit.listTerminals = () => snapshot.terminals;
    cockpit.readTerminalBuffer = id => snapshot.terminals.find(terminal => terminal.termId === id)?.buffer;
  }
  const api = vm.runInNewContext(
    [utilities, corrected ? correctedContext : contextSource, helpSource, durationSource,
      '({ maskSecrets, timeAgo, parseDuration, fmtRemaining, cmdHelp, buildCockpitContext })'].join('\n'),
    {
      Date: Clock,
      _cockpit: cockpit,
      _focusedProject: snapshot.focus,
      listTodos: () => (snapshot.todos || []).filter(todo => todo.status === 'pending'),
    },
    { timeout: 1000 },
  );
  try {
    let value;
    if (input.action === 'mask') value = api.maskSecrets(input.value);
    else if (input.action === 'timeAgo') value = api.timeAgo(input.value);
    else if (input.action === 'duration') value = api.parseDuration(input.value);
    else if (input.action === 'remaining') value = api.fmtRemaining(Number(input.value));
    else if (input.action === 'help') value = api.cmdHelp();
    else value = api.buildCockpitContext();
    return typeof value === 'number' && !Number.isFinite(value) ? { nonFinite: String(value) } : clean(value);
  } catch (error) { return { error: error.message }; }
}
export function original(input) { return evaluate(input); }

const inputs = [];
const add = (action, value) => inputs.push({ action, value });
for (const value of [
  null, false, 0, '', true, 1, -1, 1e21, 1e-7, {}, [], [null, 1, ['a', '\ud800']],
  'normal public text', '\ud800surrogate\udc00', 'TOKEN=abc', 'TOKEN=abcd',
  'token: abcd', 'my_password = "synthetic-password"', "PWD='synthetic-password'",
  'API_KEY:abcd', 'MONKEY=synthetic-value', 'PASSWORD\u00a0=\ufeffsynthetic-value',
  'KEY = a\ud800bc', 'KEY=가나다라', 'TOKEN=aaa\nbbb',
  'AKIA' + 'A'.repeat(15), 'AKIA' + 'A'.repeat(16), 'akia' + 'A'.repeat(20),
  'AWS_SECRET_ACCESS_KEY = synthetic-value', 'aws_secret_access_key=abc',
  'sk-ant-' + 'a'.repeat(19), 'sk-ant-' + 'a'.repeat(20),
  'sk-' + 'a'.repeat(19), 'sk-' + 'a'.repeat(20), 'SK-' + 'a'.repeat(30),
  'AIza' + 'a'.repeat(19), 'AIza' + 'a'.repeat(20), 'ya29.a', 'ya29.',
  ...['p', 'o', 'u', 's', 'r', 'x'].map(kind => 'gh' + kind + '_' + 'a'.repeat(20)),
  'ghp_' + 'a'.repeat(19), 'glpat-' + 'a'.repeat(20),
  'Bearer ' + 'a'.repeat(19), 'Bearer ' + 'a'.repeat(20), 'bearer\n' + 'a'.repeat(25),
  'eyJ' + 'a'.repeat(19), 'eyJ' + 'a'.repeat(20),
  'postgres://synthetic:password@example.invalid/db',
  'PostgreSQL+srv://synthetic:password@example.invalid/db',
  'MYSQL://synthetic:password@example.invalid/db',
  'mongodb+srv://synthetic:password@example.invalid/db',
  'postgres://no-password@example.invalid/db',
  'TOKEN=abcd sk-' + 'a'.repeat(30) + ' ya29.fake ghp_' + 'b'.repeat(20),
]) add('mask', value);
for (const value of [
  '', '30m', '1h', '2h30m', '45s', '1h 2m 3s', '0m', '-1h', '1.5h',
  '30M', '2H30m', 'h30', 'm', '1\tm', '1\u00a0h', '1\ufeffs', '１h',
  '1h1h', 'x2my', '3ms', '2hm', '99s', '0001m', '9'.repeat(400) + 'h',
  '9999999999999999999999s', '0.5m', '1\n h', '\ud8001m',
]) add('duration', value);
for (const value of [
  -Infinity, -3600000, -1500, -500, -1, 0, 1, 499, 500, 1499, 1500,
  59999, 60000, 89999, 90000, 3599999, 3600000, 3629999, 3630000,
  7170000, 7200000, 86400000, 1e25, Infinity, NaN,
]) add('remaining', Number.isFinite(value) ? value : String(value));
const now = 1791450000000;
for (const value of [
  null, false, 0, '', true, 1, [], [0], {}, 'invalid', '\ud800',
  ...[-86400000, -3600000, -60000, 0, 59999, 60000, 3599999, 3600000, 86399999, 86400000, 172800000].map(offset => now - offset),
  '2026-10-08T09:00:00Z', '2026-10-08T18:00:00+09:00', '2026-10-08',
  '2026-10-08T09:00:00', '2026-02-30T09:00:00Z', 'Thu, 01 Jan 1970 00:00:00 GMT',
  '0', '13', '32', 8640000000000000, -8640000000000000, 8640000000000001,
]) inputs.push({ action: 'timeAgo', value, now });
inputs.push({ action: 'help' });
const context = snapshot => inputs.push({ action: 'context', snapshot, now });
context({});
context({ projects: [], terminals: [], todos: [] });
for (const focus of ['project', '\ud800', 1, [], { name: 'object' }, 'TOKEN=synthetic-token']) context({ focus });
context({ todos: [{ status: 'done', text: 'done' }, { status: 'pending', text: 'pending task' }] });
context({ todos: [{ status: 'pending', text: 'a'.repeat(59) + '😀tail' }] });
context({ todos: [{ status: 'pending', text: 'x'.repeat(55) + ' sk-' + 'a'.repeat(30) }] });
for (const state of ['active', 'busy', 'waiting', 'idle', 'paused', '', 'unknown', null, ['active'], ['busy'], true]) {
  context({ projects: [{ id: 'p', name: 'Project', session: { state, sessionCount: 0, lastActivity: now - 60000 }, git: { branch: 'main', uncommittedCount: 2 } }] });
}
context({ projects: [{ id: 'p' }, { id: 'q', name: null, session: { state: 'active', sessionCount: 3 }, git: {} }] });
context({ projects: [{ id: 'p', name: 'TOKEN=synthetic-project', session: { state: 'waiting' }, git: { branch: 'KEY=synthetic-branch' } }] });
for (const mode of ['away', 'here', '', null]) context({ decisions: [], mode });
for (const pending of [0, 1, 3, '2', -1]) context({ decisions: [], pending });
const iso = offset => new Date(now - offset).toISOString();
const decisions = Array.from({ length: 20 }, (_, index) => ({
  ts: iso(index * 60000), decision: ['approve', 'block', 'deny', 'ask'][index % 4],
  tool: 'BASH', input: { command: 'command ' + index }, reasoning: 'reason ' + index,
}));
context({ decisions, mode: 'away', pending: 2 });
context({ decisions: [
  { ts: iso(3600000), decision: 'deny', tool: 'boundary', input: { command: 'old' } },
  { ts: iso(-60000), decision: 'ask', input: { file_path: '/synthetic/future' } },
  { ts: 'invalid', decision: 'block', reasoning: 'invalid date' },
] });
context({ decisions: Array.from({ length: 110 }, (_, i) => ({ ts: iso(0), decision: i < 10 ? 'block' : 'approve' })) });
context({ decisions: [{ ts: iso(0), decision: 'block', tool: 'TOKEN=synthetic-tool', input: { command: 'x'.repeat(74) + ' sk-' + 'a'.repeat(30) }, reasoning: 'x'.repeat(94) + ' sk-' + 'b'.repeat(30) }] });
context({ decisions: [{ ts: iso(0), decision: 'deny', input: { command: ['array', 1, null] }, reasoning: 'a'.repeat(99) + '😀tail' }] });
for (const buffer of [
  '', ' \n ', 'line1\nline2\nline3\nline4\nline5\nline6\nline7',
  '\x1b[31mred\x1b[0m\n\x1b]0;synthetic title\x07normal',
  '\ufeff\u00a0edge\u00a0', '\ud800' + 'x'.repeat(400), '😀' + 'x'.repeat(399),
  'TOKEN=synthetic-token\n' + 'sk-' + 'a'.repeat(30),
]) context({ terminals: [{ termId: 't1', projectId: 'p', command: 'shell', buffer }] });
context({ projects: [{ id: 'p', name: 'Project' }], terminals: [{ termId: 't1', projectId: 'p', command: '', buffer: 'output' }, { termId: 't2', buffer: '\ud800' }] });
context({ focus: 'Project', todos: [{ status: 'pending', text: 'task' }], projects: [{ id: 'p', name: 'Project', session: { state: 'busy' } }], decisions, pending: 1, mode: 'away', terminals: [{ termId: 't1', projectId: 'p', command: 'TOKEN=synthetic-command', buffer: 'complete' }] });

export const fixtures = inputs.map(clean).map(input => {
  const reference = original(input);
  const expected = input.action === 'context' ? evaluate(input, true) : reference;
  if (JSON.stringify(reference) === JSON.stringify(expected)) return { input, expected };
  return {
    input, expected,
    correction: {
      reason: 'Recognize busy/waiting states; mask the complete context and mask todo/decision fields before UTF-16 truncation.',
      original: reference,
    },
  };
});
export function makeFixtures() { return fixtures; }
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(fixtures) + '\n');
}
