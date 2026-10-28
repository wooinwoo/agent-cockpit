// Run only the original Telegram todo helpers against an in-memory filesystem.
// The bridge, network transport, timers and real user backlog are never loaded.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(new URL('../../lib/telegram-bridge.js', import.meta.url), 'utf8');
const start = source.indexOf('function loadTodos()');
const end = source.indexOf('function buildCockpitContext()', start);
assert.ok(start >= 0 && end > start, 'Original Telegram todo helper boundaries');
const code = source.slice(start, end);
const clean = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function original(input) {
  let bytes = own(input, 'raw') ? input.raw : undefined;
  const now = input.now ?? 1791446400000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: Clock, TODO_PATH: '/private/logs/telegram-todos.jsonl',
    path: { dirname() { return '/private/logs'; } },
    _logger: { error() { throw new Error('Unexpected source save failure'); } },
    fs: {
      existsSync() { return bytes !== undefined; },
      readFileSync() { assert.notEqual(bytes, undefined); return bytes; },
      mkdirSync() {}, writeFileSync(_path, text) { bytes = text; },
    },
  });
  const api = vm.runInContext(code + '\n({addTodo,listTodos,markTodoDone,nextTodo})', context, { timeout: 1000 });
  try {
    let value;
    if (input.action === 'add') value = api.addTodo(input.text);
    else if (input.action === 'done') value = api.markTodoDone(input.id);
    else if (input.action === 'next') value = api.nextTodo();
    else value = api.listTodos(input.includeDone === true);
    return clean({ value, rows: api.listTodos(true) });
  } catch (error) { return { error: error.message }; }
}

const normal = [
  { id: 7, text: '첫 번째\ud800😀', status: 'pending', ts: '2026-01-01T00:00:00.000Z', future: { nested: '\udc00' } },
  { id: 2, text: '완료', status: 'done', doneAt: '2026-01-02T00:00:00.000Z' },
  { id: 9, text: '다음', status: 'pending' },
  { id: 3, text: '다른 상태', status: 'archived', custom: [null, true, 2] },
];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const inputs = [];
for (const raw of [undefined, '', '\n  \n', jsonl(normal), '\ufeff \n' + jsonl(normal) + '\n\u00a0', '{"id":1,"status":"pending"}\r\n\r\n', jsonl([{ id: 4, status: 'done' }])]) {
  for (const action of ['list', 'next']) inputs.push({ action, ...(raw === undefined ? {} : { raw }) });
  inputs.push({ action: 'list', includeDone: true, ...(raw === undefined ? {} : { raw }) });
}
for (const text of ['', '  do not trim  ', '\ud800😀\udc00\nsecond line', null, true, false, 0, -1.5, ['a', null], { nested: '\udc00' }]) {
  inputs.push({ action: 'add', text, now: 1791446400000 });
  inputs.push({ action: 'add', raw: jsonl(normal), text, now: -1 });
}
for (const now of [0, 1, -1, -62167219200000, 253402300800000, -62198755200000, 8640000000000000, -8640000000000000, 8640000000000001]) {
  inputs.push({ action: 'add', text: 'Date boundary', now });
  inputs.push({ action: 'done', raw: jsonl(normal), id: 7, now });
}
for (const id of [7, 2, 9, 3, 999, 0, -1, 7.5]) inputs.push({ action: 'done', raw: jsonl(normal), id, now: 1791446400123 });
for (const rows of [
  [{ id: 0, status: 'pending' }], [{ id: -3, status: 'pending' }, { id: -5 }],
  [{ id: 1.5, status: 'pending' }], [{ id: 1, status: 'pending' }, { id: 1, status: 'pending', marker: 'second' }],
  [{ id: 9007199254740990, status: 'pending' }],
]) {
  inputs.push({ action: 'add', raw: jsonl(rows), text: 'Numeric ID boundary', now: 0 });
  inputs.push({ action: 'done', raw: jsonl(rows), id: rows[0].id, now: 1 });
}
inputs.push({ action: 'done', id: 1, now: 0 });
export const fixtures = inputs.map(clean).map(input => ({ input, expected: original(input) }));
export function makeFixtures() { return fixtures; }
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(fixtures) + '\n');
