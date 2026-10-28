// Installed MsEdgeTTS 2.0.4 protocol oracle. All sockets, streams and filesystem
// adapters are inert; only local SHA-256 runs. No provider connection is opened.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../../node_modules/msedge-tts/dist/MsEdgeTTS.js', import.meta.url), 'utf8');
const prosodySource = readFileSync(new URL('../../node_modules/msedge-tts/dist/Prosody.js', import.meta.url), 'utf8');
const route = readFileSync(new URL('../../routes/agent.js', import.meta.url), 'utf8');
const voice = route.match(/tts\.setMetadata\('([^']+)', '([^']+)'\)/);
assert.ok(voice);
assert.ok(route.includes('const text = body.text.slice(0, 800);'));
const id = '000102030405060708090a0b0c0d0e0f';
const now = Date.parse('2026-10-08T12:00:00Z');
const clean = value => JSON.parse(JSON.stringify(value));
const wire = value => Buffer.from(value, 'utf8').toString('utf8');
const escapeXml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function original(time = now) {
  const sockets = [];
  const events = [];
  class InertStream {
    on() { return this; }
    once() { return this; }
    destroy() {}
    push(data) { if (data === null) events.push({ kind: 'end' }); }
  }
  class InertSocket {
    OPEN = 1;
    readyState = 1;
    sent = [];
    constructor(url, options) {
      this.url = url;
      this.options = options;
      sockets.push(this);
      queueMicrotask(() => this.onopen());
    }
    send(message, callback) { this.sent.push(message); callback?.(); }
    close() { this.onclose?.(); }
  }
  const prosody = { exports: {} };
  vm.runInNewContext(prosodySource, prosody, { timeout: 1000 });
  const math = Object.create(Math);
  math.random = () => 0.5;
  const context = vm.createContext({
    exports: {},
    require: name => {
      if (name === './Prosody') return prosody.exports;
      if (name === 'isomorphic-ws') return InertSocket;
      if (name === 'buffer/index') return { Buffer };
      if (name === 'stream') return { Readable: InertStream };
      if (['axios', 'fs', './Output', './utils'].includes(name)) return {};
      throw new Error(`Unexpected fixture import: ${name}`);
    },
    Date: { now: () => time }, Math: math, TextEncoder, Uint8Array, ArrayBuffer,
    crypto: {
      subtle: webcrypto.subtle,
      getRandomValues: array => { for (let i = 0; i < array.length; i++) array[i] = i; return array; },
    },
  });
  vm.runInContext(source, context, { timeout: 1000 });
  const Tts = context.exports.MsEdgeTTS;
  return { Tts, sockets, events };
}
async function client() {
  const source = original();
  const instance = new source.Tts();
  await instance.setMetadata(voice[1], voice[2]);
  instance._pushAudioData = data => source.events.push({ kind: 'audio', hex: Buffer.from(data).toString('hex') });
  instance._pushMetadata = () => {};
  return { ...source, instance };
}

const protocolClient = await client();
const config = protocolClient.sockets[0].sent[0];
const [configHeaders, configBody] = config.split('\r\n\r\n');
const protocol = {
  now, configHeaders, configBody: JSON.parse(configBody),
  url: protocolClient.sockets[0].url,
  connectionId: '88888888-8888-8888-8888-888888888888',
  userAgent: protocolClient.sockets[0].options.headers['User-Agent'],
  origin: protocolClient.sockets[0].options.headers.Origin,
};
const hashes = [];
for (const time of [
  0, 1, -1, -1000, 299999, 300000, 300001, 946684800000, 1700000000000,
  now - 1, now, now + 1, now + 299999, now + 300000,
  -11644473600000, -11644473600001, 253402300799999,
]) {
  const { Tts } = original(time);
  hashes.push({ now: time, expected: await Tts.generateSecMsGec(Tts.TRUSTED_CLIENT_TOKEN) });
}
const requests = [];
for (const [name, input] of [
  ['korean', '안녕하세요. 작업이 끝났습니다.'], ['spaces', '   '], ['newline', '첫 줄\r\n다음 줄\t끝'],
  ['unicode', '한글😀\ud800\udc00\ud800'], ['low-surrogate', '\udc00'],
  ['limit-799', '가'.repeat(799)], ['limit-800', '가'.repeat(800)], ['limit-801', '가'.repeat(801)],
  ['split-surrogate', 'a'.repeat(799) + '😀끝'], ['limit-before-xml-escape', '&'.repeat(801)],
  ['xml-injection', '</prosody></voice><voice name="other">무시</voice>'],
  ['xml-literals', '< > & " \' &amp;'], ['no-header-injection', 'X-RequestId:foreign\r\nPath:turn.end'],
  ['empty', ''], ['null', null], ['false', false], ['zero', 0], ['true', true], ['number', 123], ['object', {}], ['array', ['one', 'two']],
]) {
  let expected;
  let sourceValue;
  if (!input) {
    expected = { error: 'text required' };
    sourceValue = expected;
  } else if (typeof input !== 'string') {
    expected = { error: 'text must be a string' };
    try { sourceValue = { prepared: input.slice(0, 800) }; }
    catch (error) { sourceValue = { error: error.message }; }
  } else {
    const prepared = input.slice(0, 800);
    const { instance, sockets } = await client();
    instance.toStream(prepared);
    sourceValue = { prepared, ssml: wire(sockets[0].sent.at(-1)) };
    instance.toStream(escapeXml(prepared));
    expected = { prepared, ssml: wire(sockets[0].sent.at(-1)) };
  }
  requests.push(clean({ name, input, expected, sourceExpected: sourceValue,
    ...(JSON.stringify(expected) !== JSON.stringify(sourceValue) ? { corrected: typeof input === 'string' ? 'Treat input as XML-escaped plain text.' : 'Reject truthy non-string input with a validation error.' } : {}),
  }));
}

function binary(data, override = {}) {
  const header = Buffer.from(`X-RequestId:${override.id ?? id}\r\n${override.omitType ? '' : `Content-Type:${override.type ?? 'audio/mpeg'}\r\n`}Path:${override.path ?? 'audio'}\r\n`);
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(header.length);
  return Buffer.concat([prefix, header, Buffer.from(data)]);
}
const frames = [];
async function frame(name, type, data, correctedError) {
  const { instance, sockets, events } = await client();
  instance.toStream('fixture');
  let sourceExpected;
  try {
    const bytes = Buffer.from(data);
    sockets[0].onmessage({ data: type === 'binary' ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : data });
    sourceExpected = events[0] ?? { kind: 'ignore' };
  } catch (error) { sourceExpected = { error: error.message }; }
  frames.push(clean({ name, type, data: type === 'binary' ? [...data] : data,
    sourceExpected, expected: correctedError ? { error: `TTS protocol error: ${correctedError}` } : sourceExpected,
    ...(correctedError ? { corrected: 'Validate frame headers and request ownership instead of substring dispatch.' } : {}),
  }));
}
for (const path of ['turn.start', 'response', 'audio.metadata', 'turn.end']) {
  await frame(path, 'text', `X-RequestId:${id}\r\nContent-Type:application/json\r\nPath:${path}\r\n\r\n{}`);
}
await frame('header-only-end', 'text', `X-RequestId:${id}\r\nPath:turn.end\r\n`);
await frame('audio-one', 'binary', binary([73, 68, 51, 0, 255, 8]));
await frame('audio-empty-chunk', 'binary', binary([]));
await frame('audio-empty-without-type', 'binary', binary([], { omitType: true }));
await frame('audio-data-without-type', 'binary', binary([73, 68, 51], { omitType: true }), 'unexpected binary audio type');
await frame('binary-prefix-short', 'binary', Buffer.from([0]), 'missing binary header length');
await frame('binary-prefix-long', 'binary', Buffer.from([0, 255, 0]), 'truncated binary headers');
await frame('foreign-audio', 'binary', binary([73, 68, 51], { id: 'ffffffffffffffffffffffffffffffff' }), 'request ID mismatch');
await frame('wrong-format', 'binary', binary([73, 68, 51], { type: 'audio/ogg' }), 'unexpected binary audio type');
await frame('wrong-binary-path', 'binary', binary([73, 68, 51], { path: 'turn.end' }), 'unexpected binary audio type');
await frame('foreign-end', 'text', `X-RequestId:ffffffffffffffffffffffffffffffff\r\nPath:turn.end\r\n\r\n{}`, 'request ID mismatch');
await frame('missing-request-id', 'text', 'Path:turn.end\r\n\r\n{}', 'missing request ID');
await frame('duplicate-request-id', 'text', `X-RequestId:${id}\r\nX-RequestId:${id}\r\nPath:turn.end\r\n\r\n{}`, 'duplicate header');
await frame('text-audio', 'text', `X-RequestId:${id}\r\nPath:audio\r\n\r\nID3`, 'unexpected text path');
await frame('unknown-path', 'text', `X-RequestId:${id}\r\nPath:unknown\r\n\r\n{}`, 'unexpected text path');
await frame('body-cannot-spoof-path', 'text', `X-RequestId:${id}\r\nPath:unknown\r\n\r\nPath:turn.end`, 'unexpected text path');
await frame('unterminated-headers', 'text', `X-RequestId:${id}\r\nPath:turn.end`, 'unterminated headers');

export const fixtures = { protocol, hashes, requests, frames };
if (process.argv.includes('--emit')) process.stdout.write(JSON.stringify(fixtures, null, 2) + '\n');
