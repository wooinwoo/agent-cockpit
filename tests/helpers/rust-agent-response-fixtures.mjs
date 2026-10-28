// Differential fixtures evaluate the original parser without importing services.
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(new URL('../../lib/agent-tools.js', import.meta.url), 'utf8');
const start = source.indexOf('export function buildEditArg(tc)');
assert.ok(start >= 0, 'original parser entry point');
const api = vm.runInNewContext(
  'const MAX_TOOLS_PER_TURN = 5;\n' + source.slice(start).replaceAll('export function ', 'function ')
    + '\n({ parseAgentResponse, buildEditArg, buildWriteArg })',
  {}, { filename: fileURLToPath(new URL('../../lib/agent-tools.js', import.meta.url)), timeout: 1000 },
);

const cases = [];
const add = (action, input) => cases.push({ action, ...input });
const parse = (text, userMessage = '') => add('parse', { text, userMessage });
const structured = value => JSON.stringify({ thinking: '', is_final: false, ...value });
const calls = values => structured({ tool_calls: values });
for (const text of [
  '', '  hello  ', '\ufeffhello\u00a0', '<thinking>private</thinking>answer',
  '<thinking>a</thinking>x<thinking>b</thinking>', '<thinking>unfinished',
  '@@TOOL:READ@@x@@END@@', '😀\ud800 x @@TOOL:read@@ \udc00 @@END@@suffix',
  '<thinking> a </thinking>\nanswer @@TOOL:BASH@@ pwd \n@@END@@',
  '@@TOOL:READ@@@@END@@', '@@TOOL:한글@@x@@END@@', '@@TOOL:_1@@x@@END@@',
  '@@TOOL:A@@first@@TOOL:B@@second@@END@@after@@END@@',
  Array.from({ length: 8 }, (_, i) => '@@TOOL:T' + i + '@@ ' + i + ' @@END@@').join('\n'),
  structured({ message: 'done', is_final: true }),
  structured({ thinking: '\ud800😀\udc00', message: '\ud800' }),
  '{"thinking":"\ud800","is_final":true}',
  '{"thinking":"\\\ud800","is_final":true}',
  '{"thinking":"","is_final":true,"tool_calls":[{"tool":"READ","argument":1e400}]}',
  '{"thinking":false,"is_final":true}', '{"thinking":"","is_final":"true"}',
  '{"is_final":true,"thinking":""}', 'null', '[]', '42', 'true',
]) parse(text);

const fence = String.fromCharCode(96).repeat(3);
const base = structured({ thinking: 'plan', message: 'hi', is_final: true });
for (const prefix of ['', fence, fence + 'json', fence + 'json\n', fence + 'json \r\n', fence + '\n', ' ' + fence + 'JSON\n', 'prefix ', '{prefix ']) {
  for (const suffix of ['', fence, '\n' + fence, ' suffix', ' suffix }']) parse(prefix + base + suffix);
}
for (const invalid of [null, false, 0, 1, {}, [], { trim: true }]) parse(invalid);
for (const tools of [
  null, true, {}, 'READ', [], [null, false, 1, 'READ'],
  [{ tool: ' read ', argument: null }], [{ tool: 'ßıﬃ\ud800', argument: '\udc00' }],
  [{ tool: 'READ', argument: { toString: null } }],
  [{ tool: 'READ', argument: [{ toString: false }] }],
  [{ tool: 'READ', argument: { valueOf: false } }],
  [{ tool: 'READ', file: null, old_content: null, new_content: false, content: ['x'] }],
  [...Array.from({ length: 8 }, (_, i) => ({ tool: 't' + i, argument: i }))],
  [{ tool: '\ufeff' }, { tool: '\u0085' }, { tool: 'a\u00a0' }, { tool: '\ud800' }],
]) parse(calls(tools));

for (const argument of [null, '', '\ud800', true, false, 0, -0, 1e-7, 1e-6, 1e20, 1e21, -1e21, 1000000000000000128, [], [null, 1, [null, false]], {}, { x: 1 }]) {
  parse(calls([{ tool: 'READ', argument }]));
}
for (const userMessage of [
  '유튜브에서 잔잔한 음악 틀어줘', 'YouTube PLAY lofi A B!', 'youtube play', 'youtube',
  "GOOGLE A B 검색해줘", "구글에서 !'()*~_-.+/?: 한글 😀", 'search music', 'display status',
  '유튜브 google', '유튜브 구글 cats', 'google \ud800', 'youtube \udc00', 'plain \ud800',
  true, 1, [], ['youtube'], ['google', 'cats'], { toString: false }, null,
]) {
  parse('ok', userMessage);
  if (typeof userMessage === 'string') parse(userMessage);
}
for (const tc of [
  null, false, 1, '', [], {}, { arg: null }, { arg: false }, { arg: '\ud800' },
  { file: '', content: 'x', oldContent: 'a', newContent: 'b', arg: 'fallback' },
  { file: 'x', content: null, oldContent: null, newContent: false },
  { file: 'x', content: '\ud800', oldContent: '\ud800', newContent: '\udc00' },
  { file: [], content: ['a', null], oldContent: {}, newContent: [[1], false] },
  { file: ['x', null], content: 1e21, oldContent: 1e-7, newContent: -0 },
  { file: { toString: null }, content: 'x', oldContent: 'x', newContent: 'y' },
  { file: 'x', content: { toString: false }, oldContent: { toString: false }, newContent: 'y' },
  { file: 'x', content: { valueOf: false }, oldContent: { valueOf: false }, newContent: 'y' },
]) {
  add('edit', { value: tc });
  add('write', { value: tc });
}

// Seeded variations exercise repeatable parser branches.
let seed = 0x51a7f;
const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
const atoms = ['hello', '검색해 cat', 'PLAY music', '\ud800', '\udc00', '😀', '<thinking>x</thinking>', '@@END@@', '\u00a0', '\n', fence];
for (let i = 0; i < 240; i++) {
  const text = Array.from({ length: 1 + random(6) }, () => atoms[random(atoms.length)]).join(' ');
  switch (random(4)) {
    case 0: parse(text); break;
    case 1: parse('response', text); break;
    case 2: parse('pre @@TOOL:READ@@' + text + '@@END@@ tail'); break;
    default: parse(calls([{ tool: 'read', argument: text, file: text }]));
  }
}

function outcome(input) {
  try {
    const value = input.action === 'parse' ? api.parseAgentResponse(input.text, input.userMessage)
      : input.action === 'edit' ? api.buildEditArg(input.value) : api.buildWriteArg(input.value);
    return value === undefined ? { defined: false } : { defined: true, value };
  } catch (error) {
    return { error: error.message };
  }
}

export const fixtures = cases.map(input => ({ input, expected: outcome(input) }));
const runnerIndex = process.argv.indexOf('--runner');
if (runnerIndex >= 0) {
  const runner = process.argv[runnerIndex + 1];
  assert.ok(runner?.startsWith('/'), '--runner requires an absolute executable path');
  // A file descriptor gives the runner a deterministic EOF even in hosts where
  // Node's synchronous child stdin socket retains its writable endpoint.
  const directory = mkdtempSync(join(tmpdir(), 'cockpit-agent-response-fixtures-'));
  const inputPath = join(directory, 'input.jsonl');
  writeFileSync(inputPath, fixtures.map(({ input }) => JSON.stringify(input)).join('\n') + '\n');
  const inputFd = openSync(inputPath, 'r');
  let result;
  try {
    result = spawnSync(runner, [], {
      stdio: [inputFd, 'pipe', 'pipe'],
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
    });
  } finally {
    closeSync(inputFd);
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(outputs.length, fixtures.length, 'one native result per fixture');
  for (let i = 0; i < fixtures.length; i++) {
    assert.deepEqual(outputs[i], JSON.parse(JSON.stringify(fixtures[i].expected)), 'fixture ' + i + ': ' + JSON.stringify(fixtures[i].input));
  }
  process.stdout.write('agent-response differential: ' + fixtures.length + ' passed\n');
} else if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(fixtures) + '\n');
}
