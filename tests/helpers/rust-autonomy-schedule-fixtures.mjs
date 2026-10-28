// Original scheduler storage operations and matching, with only in-memory data.
// Execution, timers, real schedule files, Telegram and agents are never loaded.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(new URL('../../lib/autonomy-scheduler.js', import.meta.url), 'utf8');
const start = source.indexOf('export function add(');
const end = source.indexOf('async function execute(', start);
assert.ok(start >= 0 && end > start, 'original autonomy scheduler boundaries');
const code = source.slice(start, end).replace(/^export /gm, '');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clean = value => JSON.parse(JSON.stringify(value));

export function original(input) {
  const now = input.action === 'matches' ? undefined : input.now ?? 1791446400000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    rows: clean(input.rows || []), Date: Clock,
    crypto: { randomBytes(size) { assert.equal(size, 3); return { toString(format) { assert.equal(format, 'hex'); return '112233'; } }; } },
  });
  const api = vm.runInContext('let _schedules = rows; function save() {}\n' + code + '\n({ add, list, remove, toggle, matches })', context, { timeout: 1000 });
  try {
    let value;
    if (input.action === 'matches') value = api.matches(input.schedule, new Clock(input.now));
    else if (input.action === 'add') value = own(input, 'opts') ? api.add(input.pattern, input.prompt, input.opts) : api.add(input.pattern, input.prompt);
    else if (input.action === 'remove') value = api.remove(input.id);
    else if (input.action === 'toggle') value = api.toggle(input.id);
    else value = api.list();
    return clean({ value, ...(input.action === 'matches' ? {} : { rows: api.list() }) });
  } catch (error) { return { error: error.message }; }
}

const inputs = [];
function match(pattern, now, lastRun = null, enabled = true) {
  inputs.push({ action: 'matches', schedule: { id: 'a', pattern, enabled, lastRun }, now });
}
for (const pattern of [
  'every 1m', 'every 2h', 'EVERY 1 M', 'every\t2\nh', 'every\u00a01m',
  'every 0m', 'every 0h', 'every 00001m', 'every 1m\n', ' every 1m', 'every 1m ',
  'every -1m', 'every +1m', 'every 1.5m', 'every １m', 'every 1d',
  'every ' + '9'.repeat(400) + 'h', '', '\ud800',
]) {
  for (const now of [0, 59999, 60000, 7200000]) match(pattern, now);
}
for (const last of [null, false, 0, 1, 60000, -60000, true, '', 'invalid', '1970-01-01T00:01:00.000Z', '1970-01-01T01:01:00+01:00', [], [0], {}, { toString: null }, ['1970-01-01T00:01:00Z']]) {
  match('every 1m', 120000, last);
  match('09:30 daily', '2026-10-08T09:30:00', last);
}
for (const enabled of [null, false, 0, '', true, 1, 'false', [], {}]) match('every 0m', 0, null, enabled);
for (const pattern of [null, false, 0, 1, [], {}, { match: false }]) {
  match(pattern, 0);
  match(pattern, 0, null, false);
}
for (const schedule of [null, false, 1, {}, { enabled: true }]) inputs.push({ action: 'matches', schedule, now: 0 });

for (const pattern of [
  '09:30 daily', '9:30 DAILY', '09:30 weekday', '9:30 WeekDay\n',
  '09:3 daily', '9:030 daily', '009:30 daily', '24:00 daily', '25:30 daily',
  '09:60 daily', '99:99 daily', '09:30 weekly', '09:30\tdaily', '09:30 daily ',
]) {
  for (const now of ['2026-10-08T09:30:00', '2026-10-08T09:30:59.999', '2026-10-08T09:31:00', '2026-10-10T09:30:00', '2026-10-11T09:30:00']) match(pattern, now);
}
for (const last of ['2026-10-08T00:00:00', '2026-10-08T23:59:59', '2026-10-07T23:59:59', '2026-10-09T00:00:00', 'invalid', true]) match('09:30 daily', '2026-10-08T09:30:00', last);
for (const now of [
  'invalid', '', '\ud800', '2026-13-01T09:30:00', '2026-10-32T09:30:00',
  '2026-10-08T24:30:00', '2026-10-08T09:60:00', '2026-10-08T09:30:60',
  '2026-10-08T09:30:00+24:00', '-000000-01-01T00:00:00Z',
  8640000000000001, -8640000000000001, 8640000000000000, -8640000000000000,
  '2026-02-30T09:30:00', '2026-10-08T24:00:00', '2026-10-08T09:30:00.9999',
]) {
  match('every 0m', now);
  match('09:30 daily', now);
}
for (const last of ['0', '1', '12', '13', '31', '32', '49', '50', '99', '100', '2026', '2026-10', '2026-10-08', 'Thu, 01 Jan 1970 00:00:00 GMT']) match('every 1m', '2030-01-01T00:00:00Z', last);

for (const [pattern, prompt, opts] of [
  [' every 1m ', ' task ', {}], [null, null, {}], [true, false, {}],
  [1e21, -0, {}], [1e-7, 1e20, {}], [[], [null, 1, ['a', '\ud800']], {}],
  [{ valueOf: false }, {}, {}], [{ toString: null }, 'x', {}],
  ['every 1m', { toString: null }, {}], ['\ufeffevery 0m\u00a0', '\ud800😀\udc00', { project: '\ud800' }],
  ['every 1m', 'x', null], ['every 1m', 'x', true],
  ['every 1m', 'x', { project: '' }], ['every 1m', 'x', { project: ['a', null] }],
]) inputs.push({ action: 'add', pattern, prompt, opts, now: 1791446400000 });
inputs.push({ action: 'add', pattern: 'every 1m', prompt: 'default opts', now: -1 });
inputs.push({ action: 'add', pattern: 'every 1m', prompt: 'invalid now', now: 8640000000000001 });

const rows = [
  { id: 'a', enabled: true, pattern: 'every 1m', prompt: '\ud800', future: { nested: '\udc00' } },
  { id: 'b', enabled: false }, { id: 'duplicate', enabled: 0 }, { id: 'duplicate', enabled: 'false' },
  { id: null }, {}, { id: 7 }, { id: ['a'] },
];
for (const id of ['a', 'b', 'missing', 'duplicate', null, 7, '7', ['a']]) {
  inputs.push({ action: 'remove', id, rows });
  inputs.push({ action: 'toggle', id, rows });
}
inputs.push({ action: 'list', rows });

export const fixtures = inputs.map(clean).map(input => ({ input, expected: original(input) }));
export function makeFixtures() { return fixtures; }
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(fixtures) + '\n');
