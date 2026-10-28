import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const configName = 'ai-config.json';
const keyName = '.encryption-key';
const encrypt = (key, plaintext) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
};
const decrypt = (key, encrypted) => {
  const [, iv, tag, data] = encrypted.split(':');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  cipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(data, 'hex')), cipher.final()]).toString('utf8');
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function saved(root, value) {
  for (let n = 0; n < 100; n++) {
    try {
      const key = Buffer.from((await readFile(join(root, keyName), 'utf8')).trim(), 'hex');
      const config = JSON.parse(await readFile(join(root, configName), 'utf8'));
      if (decrypt(key, config.geminiApiKey) === value) return { key, config };
    } catch { /* The original Node writer is asynchronous. */ }
    await pause(10);
  }
  throw new Error('Private AI fixture configuration did not finish saving');
}

// Run before restarting the private Node oracle and before launching Rust.
export async function prepareAiConfigChecks(fixture) {
  if (fixture.aiConfig) return;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = url.searchParams.get('key');
    requests.push({ path: url.pathname, key, method: req.method, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    if (key === 'fixture-timeout') return; // Client's 10-second deadline closes the request.
    if (key === 'fixture-rejected') { res.writeHead(403); res.end('E'.repeat(199) + '😀end'); return; }
    if (key === 'fixture-echo-secret') { res.writeHead(403); res.end(`invalid ${key}`); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"candidates":[]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  fixture.env.COCKPIT_PREVIEW_GEMINI_BASE = base;
  // The preload is copied fixture code only. A real Google URL cannot escape it.
  await appendFile(join(fixture.directory, 'isolate-home.mjs'), `
const originalFixtureFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'generativelanguage.googleapis.com') {
    if (url.pathname !== '/v1beta/models/gemini-2.5-flash:generateContent') throw new Error('Unexpected private Gemini fixture route');
    return originalFixtureFetch(${JSON.stringify(base)} + url.pathname + url.search, init);
  }
  return originalFixtureFetch(input, init);
};
`);
  fixture.aiConfig = { requests, server };
}

export async function cleanupAiConfigChecks(fixture) {
  const state = fixture.aiConfig;
  if (!state || state.closed) return;
  state.closed = true;
  state.server.closeAllConnections();
  await new Promise(resolve => state.server.close(resolve));
}

export async function verifyAiConfigChecks({ fixture, sandbox, rustUrl, request, check }) {
  if (!fixture.aiConfig) throw new Error('prepareAiConfigChecks must run before server launches');
  const roots = [join(fixture.directory, 'data/cockpit'), sandbox];
  const bases = [fixture.url, rustUrl];
  const pair = async (path, options) => {
    const responses = await Promise.all(bases.map(base => request(base, path, options)));
    check(responses[1].status, responses[0].status, `AI route status ${path}`);
    check(responses[1].data, responses[0].data, `AI route contract ${path}`);
    return responses[1];
  };
  const writeBoth = async value => {
    for (const root of roots) await writeFile(join(root, configName), JSON.stringify(value), { mode: 0o600 });
  };
  const post = geminiApiKey => ({ method: 'POST', body: { geminiApiKey } });
  for (const root of roots) {
    await mkdir(root, { recursive: true });
    await unlink(join(root, configName)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(join(root, keyName)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  check((await pair('/api/ai/config')).data, { configured: false }, 'Missing AI config omits masked-key field');
  await writeBoth({});
  check((await pair('/api/ai/config')).data, { configured: false, geminiApiKey: '' }, 'Existing empty AI config includes empty key');
  const legacy = 'legacy-prefix😀abc';
  await writeBoth({ geminiApiKey: legacy, future: 'preserved in backup' });
  check((await pair('/api/ai/config')).data.geminiApiKey, '****' + legacy.slice(-4), 'Legacy masking uses UTF-16 last four units');
  for (const value of [undefined, '', null, false, 0]) {
    check((await pair('/api/ai/config', post(value))).status, 400, 'Missing AI key is rejected');
    check((await pair('/api/ai/test', post(value))).status, 400, 'Missing test key is rejected');
  }
  // Intentional correction: truthy objects/numbers no longer trigger Node TypeErrors or coercion.
  for (const value of [123, true, [], {}]) {
    for (const path of ['/api/ai/config', '/api/ai/test']) check((await request(rustUrl, path, post(value))).status, 400, 'Native AI endpoints reject non-string keys');
  }
  const first = 'fixture-native-😀-1234';
  check((await pair('/api/ai/config', post(first))).data, { success: true }, 'Both implementations accept valid AI key');
  const initial = await Promise.all(roots.map(root => saved(root, first)));
  check((await pair('/api/ai/config')).data.geminiApiKey, '****1234', 'Persisted key is decrypted before masking');
  for (const [index, { config }] of initial.entries()) check(config.geminiApiKey.startsWith('enc:'), true, `Encrypted AI persistence ${index}`);
  const originalKey = await readFile(join(sandbox, keyName));
  for (const name of [keyName, configName]) check((await stat(join(sandbox, name))).mode & 0o777, 0o600, 'Native secret file permissions are private');
  // Read the native ciphertext through the unchanged Node decryptor.
  await writeFile(join(roots[0], keyName), originalKey);
  await writeFile(join(roots[0], configName), JSON.stringify(initial[1].config));
  check((await pair('/api/ai/config')).data.configured, true, 'Rust AES-GCM output is readable by original Node');
  const nodeCipher = encrypt(Buffer.from(originalKey.toString(), 'hex'), 'node-created-😀xyz');
  await writeBoth({ geminiApiKey: nodeCipher });
  check((await pair('/api/ai/config')).data.geminiApiKey, '****' + 'node-created-😀xyz'.slice(-4), 'Native reader accepts Node AES-GCM and hot reloads on every request');
  check((await pair('/api/ai/config', post(nodeCipher))).status, 200, 'Valid pre-encrypted key remains compatible');
  await Promise.all(roots.map(root => saved(root, 'node-created-😀xyz')));

  // Backups are capped, encrypted, private, and retain unrelated backup names.
  const backups = join(sandbox, 'backups');
  await writeFile(join(backups, 'unrelated.json.keep'), 'keep');
  for (let i = 0; i < 12; i++) check((await request(rustUrl, '/api/ai/config', post(`fixture-rotation-${i}`))).status, 200, 'Native repeated update succeeds');
  check(await readFile(join(sandbox, keyName)), originalKey, 'Existing encryption key is never rotated');
  const names = (await readdir(backups)).filter(name => name.startsWith('ai-config.json.') && name.endsWith('.bak'));
  check(names.length, 10, 'AI backup history retains exactly ten versions');
  for (const name of names) {
    const raw = await readFile(join(backups, name), 'utf8');
    const config = JSON.parse(raw);
    check(config.geminiApiKey.startsWith('enc:'), true, 'Native backup stores encrypted credential');
    check((await stat(join(backups, name))).mode & 0o777, 0o600, 'Backup permissions are private');
    check(decrypt(Buffer.from(originalKey.toString(), 'hex'), config.geminiApiKey).startsWith('fixture-rotation-'), true, 'Backups decrypt with unchanged installation key');
  }
  check(await readFile(join(backups, 'unrelated.json.keep'), 'utf8'), 'keep', 'Backup pruning preserves unrelated files');
  // Explicit legacy-backup protection, unlike Node copying plaintext verbatim.
  await writeFile(join(sandbox, configName), JSON.stringify({ geminiApiKey: legacy, future: 'preserved' }));
  await request(rustUrl, '/api/ai/config', post('fixture-after-legacy'));
  const last = (await readdir(backups)).filter(name => name.startsWith('ai-config.json.') && name.endsWith('.bak')).sort().at(-1);
  const legacyBackup = JSON.parse(await readFile(join(backups, last), 'utf8'));
  check(decrypt(Buffer.from(originalKey.toString(), 'hex'), legacyBackup.geminiApiKey), legacy, 'Legacy backup is encrypted without losing its key');
  check(legacyBackup.future, 'preserved', 'Backup retains unknown legacy fields');

  const backupSentinel = join(fixture.directory, 'ai-backup-sentinel');
  const suspiciousLink = join(backups, 'ai-config.json.0.bak');
  const suspiciousDirectory = join(backups, 'ai-config.json.1.bak');
  await writeFile(backupSentinel, 'preserve-outside-backups');
  await symlink(backupSentinel, suspiciousLink);
  await mkdir(suspiciousDirectory);
  try {
    const response = await request(rustUrl, '/api/ai/config', post('fixture-after-suspicious-backups'));
    check(response.status, 200, 'Suspicious old backup entries cannot turn committed save into failure');
    check(response.data, { success: true }, 'Committed key save reports success despite skipped retention entries');
    const { config, key } = await saved(sandbox, 'fixture-after-suspicious-backups');
    check(decrypt(key, config.geminiApiKey), 'fixture-after-suspicious-backups', 'Successful response matches actual persisted key');
    check(await readFile(backupSentinel, 'utf8'), 'preserve-outside-backups', 'Backup retention never changes external symlink target');
    check((await lstat(suspiciousLink)).isSymbolicLink(), true, 'Suspicious backup symlink remains untouched');
    check((await lstat(suspiciousDirectory)).isDirectory(), true, 'Suspicious backup directory remains untouched');
    const regular = [];
    for (const name of await readdir(backups)) {
      if (name.startsWith('ai-config.json.') && name.endsWith('.bak') && (await lstat(join(backups, name))).isFile()) regular.push(name);
    }
    check(regular.length, 10, 'Retention still keeps ten regular backups while skipping symlink and directory');
    for (const name of regular) {
      const backup = JSON.parse(await readFile(join(backups, name), 'utf8'));
      check(backup.geminiApiKey.startsWith('enc:'), true, 'Retained regular backups stay encrypted');
      check(typeof decrypt(key, backup.geminiApiKey), 'string', 'Retained regular backups remain recoverable');
    }
  } finally {
    await unlink(suspiciousLink); await rmdir(suspiciousDirectory); await unlink(backupSentinel);
  }

  const goodConfig = await readFile(join(sandbox, configName));
  for (const broken of ['{broken', '{"geminiApiKey":{}}', '{"geminiApiKey":"enc:00:00:00"}']) {
    await writeFile(join(sandbox, configName), broken);
    check((await request(rustUrl, '/api/ai/config')).status, 500, 'Malformed config is not exposed as a usable key');
    check((await request(rustUrl, '/api/ai/config', post('must-not-save'))).status, 500, 'Malformed config blocks replacement instead of false success');
    check(await readFile(join(sandbox, configName), 'utf8'), broken, 'Broken configuration is preserved for recovery');
    check(await readFile(join(sandbox, keyName)), originalKey, 'Broken configuration does not rotate encryption key');
  }
  await writeFile(join(sandbox, configName), goodConfig);
  for (const broken of ['bad', '11'.repeat(32)]) {
    await writeFile(join(sandbox, keyName), broken);
    check((await request(rustUrl, '/api/ai/config')).status, 500, 'Invalid or mismatched encryption key fails closed');
    check((await request(rustUrl, '/api/ai/config', post('must-not-save'))).status, 500, 'Invalid encryption key blocks writing');
    check(await readFile(join(sandbox, keyName), 'utf8'), broken, 'Broken key is never regenerated or overwritten');
    check(await readFile(join(sandbox, configName)), goodConfig, 'Invalid key cannot overwrite existing config');
  }
  await writeFile(join(sandbox, keyName), originalKey);
  await unlink(join(sandbox, keyName));
  check((await request(rustUrl, '/api/ai/config', post('must-not-save'))).status, 500, 'Missing key for encrypted config blocks rotation');
  check(await readFile(join(sandbox, keyName)).catch(error => error.code), 'ENOENT', 'Missing encrypted-config key is not replaced');
  await writeFile(join(sandbox, keyName), originalKey, { mode: 0o600 });
  const sentinel = join(fixture.directory, 'ai-sentinel');
  await writeFile(sentinel, 'private-sentinel');
  for (const name of [configName, keyName]) {
    const path = join(sandbox, name);
    const content = await readFile(path);
    await unlink(path); await symlink(sentinel, path);
    try {
      const response = await request(rustUrl, '/api/ai/config', post('must-not-save'));
      check(response.status, 500, 'Symlink credential destinations reject writes');
      check(JSON.stringify(response.data).includes('private-sentinel'), false, 'Storage errors do not disclose file contents');
      check(await readFile(sentinel, 'utf8'), 'private-sentinel', 'Rejected write preserves symlink target');
    } finally { await unlink(path); await writeFile(path, content, { mode: 0o600 }); }
  }
  await unlink(sentinel);

  const start = fixture.aiConfig.requests.length;
  check((await pair('/api/ai/test', post('fixture-success'))).data, { success: true }, 'Gemini success is exercised only against loopback mock');
  const rejected = await pair('/api/ai/test', post('fixture-rejected'));
  check(rejected.status, 400, 'Upstream API rejection retains original client status');
  check(rejected.data.error, 'API 403: ' + ('E'.repeat(199) + '😀end').slice(0, 200), 'Upstream error limit preserves UTF-16 slicing');
  for (const entry of fixture.aiConfig.requests.slice(start)) {
    check(entry.method, 'POST', 'Gemini probe uses POST');
    check(entry.path, '/v1beta/models/gemini-2.5-flash:generateContent', 'Gemini probe retains fixed model and endpoint');
    check(entry.body, { contents: [{ parts: [{ text: 'Say "OK" in one word.' }] }], generationConfig: { maxOutputTokens: 10 } }, 'Gemini probe retains original request body');
  }
  const echo = await request(rustUrl, '/api/ai/test', post('fixture-echo-secret'));
  check(echo.status, 400, 'Reflected-key upstream error remains a failure');
  check(JSON.stringify(echo.data).includes('fixture-echo-secret'), false, 'API error redacts a reflected credential');
  const timeout = await Promise.all(bases.map(base => request(base, '/api/ai/test', post('fixture-timeout'))));
  check(timeout.map(response => response.status), [400, 400], 'Both Gemini probes have a bounded 10-second timeout');
  check(timeout[1].data.error, 'API request timed out', 'Native timeout hides credential-bearing URL');
  check(await readFile(join(sandbox, configName)), goodConfig, 'Testing a key does not replace saved credentials');
}
