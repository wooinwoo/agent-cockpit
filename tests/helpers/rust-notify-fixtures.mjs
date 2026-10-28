// Execute the original source with a recording spawn stub; never show an alert.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const originalSource = readFileSync(new URL('../../lib/notify.js', import.meta.url), 'utf8');
assert.equal((originalSource.match(/export function showNotification/g) || []).length, 1);
const source = originalSource.replace(/^import .*;\n/gm, '').replace('export function showNotification', 'function showNotification');
const script = new vm.Script(source + '\nshowNotification(input.title, input.body);');

export function original(input) {
  const calls = [];
  script.runInNewContext({
    input,
    IS_WIN: input.platform === 'windows',
    IS_MAC: input.platform === 'mac',
    Buffer,
    process: { env: {} },
    console: { error() {}, log() {} },
    spawn(program, args, options) {
      calls.push({ program, args, env: options.env || {} });
      return { unref() {}, on() {} };
    },
  }, { timeout: 1000 });
  assert.equal(calls.length, 1);
  return JSON.parse(JSON.stringify(calls[0]));
}

const pairs = [
  ['', ''],
  ['title', 'body'],
  ['한글 제목', '작업이 완료되었습니다.'],
  ['Emoji 😀', '완료 🛰️'],
  ['a "quote"', 'body "quote"'],
  ['trailing\\', 'body\\'],
  ['back\\slash', 'C:\\new\\test'],
  ['\\" & do shell script "touch forbidden" & "', 'script lookalike \\"'],
  ['--urgency=critical', '--icon=synthetic'],
  ['-e', '--'],
  ['$(touch forbidden)', '`touch forbidden`'],
  ['title\nline', 'body\nline'],
  ['title\rline', 'body\r\nline'],
  ['\ttitle', 'body\ttext'],
  ['<>&"\'', 'XML <toast>&text</toast>'],
  ['nul\0title', 'nul\0body'],
  ['separator\u2028title', 'paragraph\u2029body'],
  ['é e\u0301', 'ＱＲ　완료'],
];

export const fixtures = ['linux', 'mac', 'windows'].flatMap(platform => pairs.map(([title, body]) => {
  const input = { platform, title, body };
  const reference = original(input);
  if (platform === 'linux') {
    return {
      input,
      expected: { ...reference, args: ['--', title, body] },
      correction: { reason: 'Terminate notify-send options before user-supplied text.', original: reference },
    };
  }
  if (platform === 'mac' && (title.includes('\\') || body.includes('\\'))) {
    const escape = text => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return {
      input,
      expected: { ...reference, args: ['-e', `display notification "${escape(body)}" with title "${escape(title)}"`] },
      correction: { reason: 'Escape AppleScript backslashes before quotes to keep text inside its literal.', original: reference },
    };
  }
  return { input, expected: reference };
}));
export function makeFixtures() { return fixtures; }
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(fixtures) + '\n');
}
