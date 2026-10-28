// Evaluate the original pure renderer. Fixtures contain synthetic data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(new URL('../../lib/qr.js', import.meta.url), 'utf8');
assert.equal((source.match(/export function generateQRSvg/g) || []).length, 1);
const render = vm.runInNewContext(
  source.replace('export function generateQRSvg', 'function generateQRSvg') + '\ngenerateQRSvg;',
  { Buffer },
  { timeout: 1000 },
);

export function original(input) {
  try {
    const svg = render(input.text, { scale: 6, margin: 4 });
    return {
      svgSha256: createHash('sha256').update(svg).digest('hex'),
      svgBytes: Buffer.byteLength(svg),
      viewBox: svg.match(/viewBox="([^"]+)"/)[1],
      darkModules: (svg.match(/<rect x=/g) || []).length,
    };
  } catch (error) { return { error: error.message }; }
}

const inputs = [];
// Every supported byte length proves each version transition and padding phase.
for (let length = 0; length <= 272; length++) inputs.push({ text: 'a'.repeat(length) });
for (const text of [
  'https://example.invalid/?token=synthetic-test-token',
  '<script>alert("synthetic")</script>', 'a\0b\r\nc\t', '한글 QR 코드',
  '😀😇🛰️', 'e\u0301é', '\ufeff\u2028\u2029', '\ud800', '\udc00',
  '\ud800\ud800\udc00', '\udc00\ud800', '가'.repeat(90), '가'.repeat(91),
  '😀'.repeat(67) + 'abc', '😀'.repeat(68), 'x'.repeat(1024),
]) inputs.push({ text });
// Different bit distributions exercise selection across all eight masks.
let random = 0x51a7;
for (let index = 0; index < 64; index++) {
  const length = (index * 73 + 11) % 272;
  let text = '';
  for (let i = 0; i < length; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    text += String.fromCharCode(32 + random % 95);
  }
  inputs.push({ text });
}
for (const text of [
  null, true, false, 0, 42, -1, 1.5, {}, { valueOf: null },
  [], [65, 66, 67], [null, true, false, '255', -1, 257, 1.9, {}, [65]],
  Array.from({ length: 256 }, (_, i) => i),
  { type: 'Buffer', data: [65, 0, 255] },
  { type: 'Buffer', data: [65], length: 2, 0: 66 },
  { length: 3, 0: 65, 2: 255 }, { length: '3', 0: 65 }, { length: -3 },
  { length: null }, { length: true }, { length: 3.9, 0: 65, 1: 66, 2: 67 },
  [{ toString: null }],
]) inputs.push({ text });

export const fixtures = inputs.map(input => {
  const reference = original(input);
  let payload;
  try { payload = Buffer.from(input.text, 'utf8'); } catch { return { input, expected: reference }; }
  if (payload.length <= 271) {
    const differences = ['Use standard format bits, fixed dark module and automatic mask selection.'];
    if (payload.length >= 107) differences.push('Interleave Reed-Solomon blocks for versions 6–10.');
    if (payload.length >= 135) differences.push('Write version information for versions 7–10.');
    return {
      input,
      // Expectations come from the input bytes and source dimensions, never
      // from the replacement encoder. Rust scans the rendered SVG independently.
      expected: { payloadHex: payload.toString('hex'), viewBox: reference.viewBox },
      correction: { reason: differences.join(' '), original: reference },
    };
  }
  return {
    input,
    expected: { error: 'QR data exceeds 271 UTF-8 bytes' },
    correction: {
      reason: 'Reject data above version 10 capacity; the original silently falls back to version 1 and truncates it.',
      original: reference,
    },
  };
});
export function makeFixtures() { return fixtures; }
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(fixtures) + '\n');
}
