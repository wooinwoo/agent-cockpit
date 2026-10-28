import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

const checks = [];
const secrets = ['fixture-claude-a-access', 'fixture-claude-a-refresh', 'fixture-claude-b-access', 'fixture-claude-b-refresh', 'fixture-codex-access', 'fixture-codex-refresh', 'fixture-original-access'];
const conversation = 'session_fox_1790191044353_621ff7b98fbf962b';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const until = async (fn, label, milliseconds = 12000) => {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Fixture timeout: ${label}`);
};
let fixture, ws;
try {
  fixture = await startPortfolioServer({ runtime: 'rust' });
  await fixture.stop();
  await chmod(join(fixture.directory,'data/cockpit'),0o700);
  const modeFile = join(fixture.project, 'jcode-screen-mode');
  const closeStateFile = join(fixture.project, 'jcode-close-state');
  const eventFile = join(fixture.project, 'jcode-events.jsonl');
  const sourceHome = join(fixture.project, 'original-jcode-home');
  const runtimeDirectory = join(fixture.project, 'jcode-runtime');
  const managedHome = join(fixture.directory, 'data/cockpit/jcode-accounts');
  const checkpointPath = join(fixture.directory, 'data/cockpit/session-state.json');
  await mkdir(sourceHome, { mode: 0o700 });
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await writeFile(modeFile, 'idle');
  await writeFile(closeStateFile, 'Closed');
  await writeFile(eventFile, '');
  const originalAuth = join(sourceHome, 'auth.json');
  await writeFile(originalAuth, JSON.stringify({ anthropic_accounts: [{ label: 'original-keep', access: secrets[6], refresh: 'fixture-original-refresh' }], active_anthropic_account: 'original-keep' }), { mode: 0o600 });
  const originalHash = digest(await readFile(originalAuth));
  const settings = {
    'config.toml': '[display]\ntheme = "fixture-dark"\n',
    'mcp.json': JSON.stringify({ mcpServers: { fixture: { command: '/bin/true', args: [] } } }),
  };
  for (const [name, text] of Object.entries(settings)) await writeFile(join(sourceHome, name), text, { mode: 0o600 });
  const fakeJcode = join(fixture.project, 'jcode');
  const fakeSource = `#!${process.execPath}
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
const home = process.env.JCODE_HOME;
const modeFile = ${JSON.stringify(modeFile)}, eventFile = ${JSON.stringify(eventFile)}, closeStateFile = ${JSON.stringify(closeStateFile)};
const id = process.argv.find(arg => arg.startsWith('--resume='))?.slice(9) || ${JSON.stringify(conversation)};
const log = value => fs.appendFileSync(eventFile, JSON.stringify({ ...value, pid: process.pid, home }) + '\\n');
for (const name of ['client_sessions', 'sessions']) fs.mkdirSync(path.join(home, name), { recursive: true, mode: 0o700 });
const sessionPath = path.join(home, 'sessions', id + '.json');
const session = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath)) : { id, status: 'Active', provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Synthetic preserved conversation' }] };
if (session.id !== id) throw new Error('Fixture conversation mismatch');
session.status = 'Active';
fs.writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });
fs.writeFileSync(path.join(home, 'client_sessions', String(process.pid)), id, { mode: 0o600 });
process.stdin.setRawMode(true); process.stdin.resume();
let mode = '', input = '', closing = false;
const show = () => {
  const next = fs.readFileSync(modeFile, 'utf8');
  if (next === mode) return;
  mode = next;
  process.stdout.write('\\x1b[2J\\x1b[H' + ({ idle: '1>', busy: '1…', draft: '1> unfinished draft', approval: 'Do you want to proceed?\\r\\n1. Yes\\r\\n1>' })[mode]);
};
show(); const interval = setInterval(show, 20);
const server = net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      log({ event: 'debug', command: command.command });
      let output;
      if (command.command === 'clients:map') output = { count: 1, clients: [{ client_id: 'fixture-client', session_id: id, status: 'ready' }] };
      else if (command.command === 'sessions') output = [{ session_id: id, provider: 'anthropic', model: session.model, is_processing: mode === 'busy', status: 'ready' }];
      else output = null;
      socket.write(JSON.stringify({ type: 'debug_response', id: command.id, ok: output !== null, output: JSON.stringify(output) }) + '\\n');
    }
  });
});
const socketPath = process.env.JCODE_SOCKET
  ? path.join(path.dirname(process.env.JCODE_SOCKET), path.basename(process.env.JCODE_SOCKET).replaceAll('.sock', '-debug.sock'))
  : path.join(process.env.JCODE_RUNTIME_DIR || process.env.XDG_RUNTIME_DIR || path.join(process.env.TMPDIR || '/tmp', 'jcode-' + process.getuid()), 'jcode-debug.sock');
if (!socketPath.startsWith(${JSON.stringify(fixture.directory + '/')})) throw new Error('Fixture socket escaped private directory');
fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); log({ event: 'start', cwd: process.cwd(), args: process.argv.slice(2), sessionId: id, debugSocket: socketPath }); });
process.stdin.on('data', bytes => {
  input += bytes.toString();
  let end;
  while ((end = input.indexOf('\\r')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    log({ event: 'input', line });
    if (line === '/quit' && !closing) {
      closing = true; clearInterval(interval); session.status = fs.readFileSync(closeStateFile, 'utf8');
      fs.writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });
      log({ event: 'closed', sessionId: id });
      server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 40);
    } else if (line.startsWith('/account ')) {
      const [, provider, operation, label] = line.split(' ');
      if (operation !== 'switch') throw new Error('Invalid fixture account command');
      const authPath = path.join(home, provider === 'claude' ? 'auth.json' : 'openai-auth.json');
      const auth = JSON.parse(fs.readFileSync(authPath));
      const list = provider === 'claude' ? 'anthropic_accounts' : 'openai_accounts';
      if (!auth[list].some(account => account.label === label)) throw new Error('Unknown fixture account');
      auth[provider === 'claude' ? 'active_anthropic_account' : 'active_openai_account'] = label;
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      process.stdout.write('\\x1b[2J\\x1b[HSwitched ' + (provider === 'claude' ? 'Claude' : 'OpenAI') + ' account to ' + label + '\\r\\n1>');
    }
  }
});
`;
  await writeFile(fakeJcode, fakeSource, { mode: 0o700 });
  await writeFile(fixture.env.SHELL, '#!/bin/bash\nexec /bin/bash --noprofile --norc\n', { mode: 0o700 });
  fixture.env.JCODE_HOME = sourceHome;
  fixture.env.JCODE_RUNTIME_DIR = runtimeDirectory;
  fixture.env.PATH = `${fixture.project}:${fixture.env.PATH}`;
  fixture.env['BASH_FUNC_jcode%%'] = `() { '${fakeJcode}' "$@"; }`;
  await fixture.start();
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(fixture.url + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
    const data = await response.json();
    const serialized = JSON.stringify(data);
    for (const secret of secrets) assert.ok(!serialized.includes(secret), 'API must not expose fixture credentials');
    return { status: response.status, data };
  };
  const connect = async () => {
    const messages = [];
    ws = new WebSocket(fixture.url.replace('http:', 'ws:'));
    ws.on('message', text => messages.push(JSON.parse(text)));
    await once(ws, 'open');
    await until(() => messages.find(item => item.type === 'terminals'), 'terminal restore');
    return messages;
  };
  const registered = [], sources = [];
  for (const [provider, name, email, index] of [['claude', 'Claude A', 'a@example.invalid', 0], ['claude', 'Claude B', 'b@example.invalid', 2], ['codex', 'Codex A', 'c@example.invalid', 4]]) {
    const response = await request('/api/ai-accounts', { provider, name, email });
    assert.equal(response.status, 201);
    const record = response.data;
    assert.ok(record.homePath.startsWith(join(fixture.directory, 'data/cockpit/ai-accounts/')));
    registered.push(record);
    const path = join(record.homePath, provider === 'claude' ? '.credentials.json' : 'auth.json');
    const credential = provider === 'claude'
      ? { claudeAiOauth: { accessToken: secrets[index], refreshToken: secrets[index + 1], expiresAt: 1999999999000, scopes: ['user:inference'], subscriptionType: 'max' } }
      : { tokens: { access_token: secrets[index], refresh_token: secrets[index + 1], account_id: 'fixture-codex-account', expires_at: 1999999999000 } };
    await writeFile(path, JSON.stringify(credential), { mode: 0o600 });
    sources.push({ path, hash: digest(await readFile(path)) });
  }
  const prepared = await request('/api/terminals/accounts/prepare', {});
  assert.equal(prepared.status, 200, JSON.stringify(prepared));
  assert.equal(prepared.data.accounts.length, 3);
  assert.equal((await stat(managedHome)).mode & 0o777, 0o700);
  assert.equal((await stat(join(managedHome, 'auth.json'))).mode & 0o777, 0o600);
  checks.push('Registered Claude 2 + Codex 1 prepare privately without exposing credentials');
  const messages = await connect();
  ws.send(JSON.stringify({ type: 'create', projectId: 'sample', command: 'jcode', cols: 120, rows: 30 }));
  const termId = (await until(() => messages.find(item => item.type === 'created'), 'fixture jcode created')).termId;
  const events = async () => (await readFile(eventFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const checkpoint = async () => JSON.parse(await readFile(checkpointPath, 'utf8')).terminals.find(item => item.termId === termId);
  const listed = await until(async () => { const response = await request(`/api/terminals/${termId}/accounts`); return response.status === 200 && response.data; }, 'account metadata');
  assert.equal(listed.managed, false);
  for (const account of registered) assert.ok(listed.accounts.some(item => item.id === account.id && item.source === 'cockpit' && item.requiresConnection));
  const before = await checkpoint();
  const initial = await until(async () => (await events()).find(item => item.event === 'start'), 'source client started');
  const accountPath = `/api/terminals/${termId}/account`;
  for (const mode of ['busy', 'draft']) {
    await writeFile(modeFile, mode);
    await until(async () => {
      const response = await request('/api/terminals/maintenance');
      return response.data.sessions.find(item => item.termId === termId)?.activity?.state === (mode === 'busy' ? 'busy' : 'unknown');
    }, `${mode} composer visible`);
    assert.equal((await request(accountPath, { accountId: registered[0].id })).status, 409, mode);
  }
  await writeFile(modeFile, 'idle');
  await until(async () => (await request('/api/terminals/maintenance')).data.sessions.find(item => item.termId === termId)?.activity?.state === 'idle', 'idle composer');
  assert.equal((await request(`/api/terminals/${termId}/conversation`, { held: true }, 'PUT')).status, 200);
  assert.equal((await request(accountPath, { accountId: registered[0].id })).status, 409, 'Held conversation blocks migration');
  assert.equal((await request(`/api/terminals/${termId}/conversation`, { held: false }, 'PUT')).status, 200);
  assert.equal((await events()).filter(item => item.event === 'input').length, 0, 'Refused states must not send /quit or any input');
  checks.push('Busy, draft and held sessions reject account connection before any terminal input');
  await writeFile(closeStateFile, 'Active');
  const rejectedSnapshot = await request(accountPath, { accountId: registered[0].id });
  assert.equal(rejectedSnapshot.status, 409, 'An unclosed snapshot cannot migrate');
  const rolledBack = await until(async () => (await events()).filter(item => item.event === 'start' && item.home === sourceHome).at(1), 'same-source conversation rollback');
  assert.deepEqual(rolledBack.args, [`--resume=${conversation}`]);
  assert.equal(rolledBack.sessionId, conversation); assert.equal(rolledBack.cwd, initial.cwd);
  assert.equal((await events()).filter(item => item.event === 'start' && item.home === managedHome).length, 0, 'Unclosed source must never launch a target client');
  assert.equal((await checkpoint()).jcodeHomeManaged, false);
  for (const [name, text] of Object.entries(settings)) assert.equal(await readFile(join(managedHome, name), 'utf8'), text, 'Settings survive the refused migration');
  await writeFile(closeStateFile, 'Closed');
  checks.push('An unclosed snapshot refuses target launch and restores the exact original conversation');
  const migrated = await request(accountPath, { accountId: registered[0].id });
  assert.equal(migrated.status, 200, JSON.stringify(migrated));
  const resumed = await until(async () => (await events()).find(item => item.event === 'start' && item.home === managedHome), 'exact managed resume');
  assert.equal(resumed.sessionId, conversation);
  assert.deepEqual(resumed.args, [`--resume=${conversation}`]);
  assert.equal(resumed.cwd, initial.cwd);
  assert.notEqual(resumed.debugSocket, initial.debugSocket, 'Managed client must not reconnect to the original daemon');
  const after = await checkpoint();
  assert.equal(after.termId, before.termId); assert.equal(after.alias, before.alias); assert.equal(after.cwd, before.cwd);
  assert.equal(after.jcodeHomeManaged, true); assert.equal(after.jcodeSessionId, conversation);
  assert.equal(after.command, `jcode --resume=${conversation}`);
  const sourceSession = JSON.parse(await readFile(join(sourceHome, 'sessions', `${conversation}.json`), 'utf8'));
  const managedSession = JSON.parse(await readFile(join(managedHome, 'sessions', `${conversation}.json`), 'utf8'));
  assert.equal(sourceSession.status, 'Closed'); assert.deepEqual(managedSession.messages, sourceSession.messages);
  const migratedEvents = await events();
  assert.equal(migratedEvents.filter(item => item.event === 'input' && item.line === '/quit').length, 2);
  assert.ok(migratedEvents.some(item => item.event === 'debug' && item.command === 'clients:map'));
  assert.ok(migratedEvents.some(item => item.event === 'debug' && item.command === 'sessions'));
  checks.push('Closed source snapshot resumes the exact conversation with unchanged terminal ID, alias and cwd');
  const connected = (await request(`/api/terminals/${termId}/accounts`)).data;
  assert.equal(connected.managed, true);
  const selection = connected.accounts.find(item => item.id === registered[0].id);
  assert.ok(selection?.available);
  await until(async () => JSON.parse(await readFile(join(managedHome, 'auth.json'), 'utf8')).active_anthropic_account === selection.label, 'selected managed account');
  await until(async () => (await request(`/api/terminals/${termId}/accounts`)).data.accounts.find(item => item.id === registered[0].id)?.isDefault === true, 'selected registered default metadata');
  const second = connected.accounts.find(item => item.id === registered[1].id);
  assert.equal((await request(accountPath, { accountId: registered[1].id })).status, 200);
  await until(async () => JSON.parse(await readFile(join(managedHome, 'auth.json'), 'utf8')).active_anthropic_account === second.label, 'second native account');
  await until(async () => {
    const choices = (await request(`/api/terminals/${termId}/accounts`)).data.accounts;
    return choices.find(item => item.id === registered[1].id)?.isDefault === true
      && choices.find(item => item.id === registered[0].id)?.isDefault === false;
  }, 'default metadata follows registered account switching');
  assert.equal((await events()).filter(item => item.event === 'start').length, 3, 'Native switching must not restart the conversation');
  assert.equal((await events()).filter(item => item.event === 'input' && item.line === '/quit').length, 2);
  checks.push('A second registered account switches inside the managed jcode process without another quit');
  ws.close(); await fixture.stop();
  const delayed = JSON.parse(await readFile(checkpointPath, 'utf8'));
  delayed.terminals.find(item => item.termId === termId).accountHandoffError = 'Fixture: delayed client startup';
  await writeFile(checkpointPath, JSON.stringify(delayed));
  await fixture.start(); await connect();
  const restored = await checkpoint();
  assert.equal(restored.termId, before.termId); assert.equal(restored.alias, before.alias); assert.equal(restored.cwd, before.cwd);
  assert.equal(restored.jcodeHomeManaged, true); assert.equal(restored.jcodeSessionId, conversation);
  assert.equal((await request(`/api/terminals/${termId}/accounts`)).data.managed, true);
  assert.equal((await request(accountPath, { accountId: registered[1].id })).status, 200, 'Explicit retry recovers a now-ready exact managed conversation');
  assert.equal((await checkpoint()).accountHandoffError, undefined);
  assert.equal(JSON.parse(await readFile(join(managedHome, 'auth.json'), 'utf8')).active_anthropic_account, second.label);
  ws.close(); await fixture.stop();
  execFileSync('/usr/bin/tmux', ['-L', `cockpit-${after.durableId}`, 'kill-server'], { env: fixture.env });
  await fixture.start(); await connect();
  const cold = await until(async () => (await events()).filter(item => item.event === 'start' && item.home === managedHome).at(1), 'cold managed restore');
  assert.deepEqual(cold.args, [`--resume=${conversation}`]);
  assert.equal(cold.debugSocket, resumed.debugSocket);
  assert.equal((await checkpoint()).alias, before.alias);
  for (const source of sources) assert.equal(digest(await readFile(source.path)), source.hash, 'Registered source credentials remain unchanged');
  assert.equal(digest(await readFile(originalAuth)), originalHash, 'Original jcode auth remains unchanged');
  for (const [name, text] of Object.entries(settings)) {
    assert.equal(await readFile(join(sourceHome, name), 'utf8'), text, 'Original settings remain unchanged');
    assert.equal(await readFile(join(managedHome, name), 'utf8'), text, 'Identical copied settings allow rollback and retry');
  }
  checks.push('Server restart restores managed session metadata and choice; original credentials remain byte-identical');
  checks.push('Explicit retry clears a delayed-start failure and a cold pane restore reuses the exact managed home, daemon and conversation');
  // The same fixture also exercises the per-account native engine, without real logins.
  const privateEngine = join(fixture.directory, 'data/cockpit/jcode-engine/jcode');
  await mkdir(join(privateEngine, '..'), { recursive: true, mode: 0o700 });
  const nativePrefix = `
if (process.argv.includes('cockpit-account')) {
  console.log(JSON.stringify(process.argv.includes('--refresh') ? {ok:true,refreshed:false} : {version:1,nativeAccountOnly:true,guardedLogin:true,guardedInitialization:true,refreshOwner:'jcode',accountCostRecords:true}));
  process.exit(0);
}
if (process.argv.includes('login')) {
  if(process.env.JCODE_ACCOUNT_ONLY!=='1') throw new Error('Native isolation missing');
  const nativeHome=process.env.JCODE_HOME;
  const marker=JSON.parse(fs.readFileSync(path.join(nativeHome,'cockpit-account.json')));
  if(marker.email!==process.env.JCODE_EXPECTED_EMAIL) throw new Error('Wrong native identity');
  const claude=marker.provider==='claude', file=path.join(nativeHome,claude?'auth.json':'openai-auth.json');
  const auth=JSON.parse(fs.readFileSync(file)), item=auth[claude?'anthropic_accounts':'openai_accounts'][0];
  if(item[claude?'access':'access_token']!=='') throw new Error('Old token was copied');
  item[claude?'access':'access_token']='fixture-fresh-native-access';
  item[claude?'refresh':'refresh_token']='fixture-fresh-native-refresh';
  item[claude?'expires':'expires_at']=Date.now()+3600000;
  if(!claude)item.account_id=marker.workspaceId||'fixture-new-workspace';
  fs.writeFileSync(file,JSON.stringify(auth),{mode:0o600});
  fs.appendFileSync(${JSON.stringify(eventFile)},JSON.stringify({event:'native-login',home:nativeHome,email:marker.email})+'\\n');
  process.exit(0);
}
`;
  await writeFile(privateEngine, fakeSource.replace('const home =', nativePrefix + 'const home ='), { mode: 0o700 });
  assert.equal((await request('/api/ai-accounts', {name:'Invalid native',provider:'claude',engine:'jcode'})).status,400);
  const nativeHomes = registered.map(account => join(fixture.directory, 'data/cockpit/jcode-profiles', account.id, '.jcode'));
  for (let index=0;index<registered.length;index++) {
    ws.send(JSON.stringify({type:'create',projectId:'sample',accountId:registered[index].id,engine:'jcode',loginMode:true,cols:120,rows:30}));
    await until(async()=> (await events()).some(event=>event.event==='native-login'&&event.home===nativeHomes[index]), 'fresh native login');
    assert.equal((await stat(nativeHomes[index])).mode&0o777,0o700);
  }
  checks.push('Explicit native login initializes empty private profiles and never copies old CLI tokens');
  const nativeMessages = [];
  ws.on('message',text=>nativeMessages.push(JSON.parse(text)));
  ws.send(JSON.stringify({type:'create',projectId:'sample',accountId:registered[0].id,engine:'jcode',cols:120,rows:30}));
  const nativeId=(await until(()=>nativeMessages.find(item=>item.type==='created'),'native worker created')).termId;
  await until(async()=> (await events()).some(item=>item.event==='start'&&item.home===nativeHomes[0]),'native worker started');
  const nativePath=`/api/terminals/${nativeId}/account`;
  const choice=(await request(`/api/terminals/${nativeId}/accounts`)).data.accounts.find(account=>account.id===registered[0].id);
  assert.equal(choice.isDefault,true); assert.equal(choice.requiresConnection,false);
  const nativeSwitched=await request(nativePath,{accountId:registered[1].id});
  assert.equal(nativeSwitched.status,200,JSON.stringify(nativeSwitched));
  const nativeState=()=>readFile(checkpointPath,'utf8').then(text=>JSON.parse(text).terminals.find(item=>item.termId===nativeId));
  assert.equal((await nativeState()).accountId,registered[1].id);
  assert.equal((await nativeState()).accountEngine,'jcode');
  assert.equal((await nativeState()).command,`jcode --resume=${conversation}`);
  const selected=(await request(`/api/terminals/${nativeId}/accounts`)).data.accounts.find(account=>account.id===registered[1].id);
  assert.equal(selected.isDefault,true);
  const quits=(await events()).filter(item=>item.event==='input'&&item.line==='/quit').length;
  assert.equal((await request(nativePath,{accountId:registered[2].id})).status,409,'Cross-provider native handoff must fail before /quit');
  assert.equal((await events()).filter(item=>item.event==='input'&&item.line==='/quit').length,quits);
  assert.equal((await request(nativePath,{accountId:registered[1].id})).status,200,'Current native account is an input-free no-op');
  assert.equal((await request(nativePath,{accountId:registered[0].id})).status,200,'Return to the original native account');
  assert.equal((await nativeState()).accountId,registered[0].id);
  assert.equal((await request(nativePath,{accountId:registered[1].id})).status,200,'Repeated native roundtrip');
  const record={schema:1,id:'native-cost-fixture',timestamp:new Date().toISOString(),provider:'claude',email:registered[0].email,model:'claude-opus-5-5',cache_ttl:'5m',input_tokens:1000,output_tokens:100,cache_read_input_tokens:900,cache_creation_input_tokens:0};
  await writeFile(join(nativeHomes[0],'account_usage.jsonl'),JSON.stringify(record)+'\n',{mode:0o600});
  await until(async()=> (await request('/api/ai-accounts')).data.accounts.find(account=>account.id===registered[0].id)?.jcodeCost?.pricedRequests===1,'native ledger attribution');
  checks.push('Native handoff resumes the exact conversation in the selected private profile; provider mismatch never stops work');
  ws.close(); await fixture.stop();
  execFileSync('/usr/bin/tmux',['-L',`cockpit-${(await nativeState()).durableId}`,'kill-server'],{env:fixture.env});
  const starts=(await events()).filter(item=>item.event==='start'&&item.home===nativeHomes[1]).length;
  await fixture.start(); await connect();
  await until(async()=> (await events()).filter(item=>item.event==='start'&&item.home===nativeHomes[1]).length>starts,'cold native restore');
  assert.equal((await nativeState()).accountId,registered[1].id);
  for(const source of sources) assert.equal(digest(await readFile(source.path)),source.hash);
  assert.equal(digest(await readFile(originalAuth)),originalHash);
  checks.push('Cold native restore retains account ownership and per-account costs without touching original credentials');
  console.log(JSON.stringify({ status: 'passed', checks }));
} finally {
  ws?.close();
  await fixture?.cleanup();
}
