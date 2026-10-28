// Native Rust compatibility checks against a private copy of the current Node
// server. No request reaches production and no real user data enters fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFile, writeFile, readdir, mkdir, stat, symlink, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { rustBinary as binary, rustBuildProfile } from '../tests/helpers/rust-server.js';
import { verifyRustBoard } from '../tests/helpers/rust-board-checks.js';
import { verifyAccountChecks } from '../tests/helpers/rust-account-checks.js';
import { verifyAccountLists } from '../tests/helpers/rust-account-list-checks.js';
import { verifyApprovalChecks } from '../tests/helpers/rust-approval-checks.js';
import { prepareGithubFixture, verifyGithubChecks } from '../tests/helpers/rust-github-checks.js';
import { verifyGitChecks } from '../tests/helpers/rust-git-checks.js';
import { prepareSessionChecks, verifySessionChecks } from '../tests/helpers/rust-session-checks.js';
import { prepareCostChecks, verifyCostChecks } from '../tests/helpers/rust-cost-checks.js';
import { verifyDelegateChecks } from '../tests/helpers/rust-delegate-checks.js';
import { prepareSystemChecks, verifySystemChecks, verifyCicdChecks } from '../tests/helpers/rust-system-checks.js';
import { verifySystemFileChecks } from '../tests/helpers/rust-system-file-checks.js';
import { verifyDevServerChecks } from '../tests/helpers/rust-dev-server-checks.js';
import { prepareBatchChecks, verifyBatchChecks } from '../tests/helpers/rust-batch-checks.js';
import { prepareBriefingChecks, verifyBriefingChecks } from '../tests/helpers/rust-briefing-checks.js';
import { prepareProjectSettingsChecks, verifyProjectSettingsChecks, verifyDiscoveryChecks } from '../tests/helpers/rust-project-settings-checks.js';
import { prepareAiConfigChecks, verifyAiConfigChecks, cleanupAiConfigChecks } from '../tests/helpers/rust-ai-config-checks.js';
import { preparePortsChecks, verifyPortsChecks } from '../tests/helpers/rust-ports-checks.js';
import { prepareAgentChecks, verifyAgentChecks } from '../tests/helpers/rust-agent-checks.js';
import { prepareGitAiChecks, verifyGitAiChecks } from '../tests/helpers/rust-git-ai-checks.js';
import { prepareWorkflowScheduleChecks, verifyWorkflowScheduleChecks } from '../tests/helpers/rust-workflow-schedule-checks.js';
import { prepareWorkflowChecks, verifyWorkflowChecks, cleanupWorkflowChecks } from '../tests/helpers/rust-workflow-checks.js';
import { verifyAutopilotChecks } from '../tests/helpers/rust-autopilot-checks.js';
import { verifySupervisorPolicyChecks } from '../tests/helpers/rust-supervisor-policy-checks.js';
import { prepareTelegramChecks, verifyTelegramChecks, cleanupTelegramChecks } from '../tests/helpers/rust-telegram-checks.js';
import { prepareSupervisorLlmChecks, verifySupervisorLlmChecks, cleanupSupervisorLlmChecks } from '../tests/helpers/rust-supervisor-llm-checks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await startPortfolioServer({ durable: false });
const sandbox = join(fixture.directory, 'rust');
let rust;
let rustUrl;
let assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };

async function launch(directory = sandbox) {
  const child = spawn(binary, ['--root', join(fixture.directory, 'app'), '--sandbox-dir', directory], {
    env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let failure = '';
  let spawnError;
  child.once('error', error => { spawnError = error; });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { failure += data; });
  for (let i = 0; i < 100; i++) {
    if (spawnError || child.exitCode !== null) throw spawnError || new Error(`Rust startup failed: ${failure}`);
    if (output.includes('\n')) {
      const started = JSON.parse(output.split('\n')[0]);
      check(started.productionReady, false, 'Preview must never advertise production readiness');
      return { child, url: `http://${started.listening}` };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error('Rust startup timeout');
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exit; } finally { clearTimeout(timer); }
}

async function request(base, path, { method = 'GET', body, headers = {} } = {}) {
  // Node's fetch can replace an explicit Host header. Use the wire-level HTTP
  // client so DNS-rebinding tests actually send the hostile Host under test.
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = httpRequest(base + path, {
      method, headers: { ...headers, ...(encoded === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }) },
      signal: AbortSignal.timeout(15_000),
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: response.statusCode, data, bytes, headers: new Headers(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) });
      });
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

const normalizedNote = note => ({ ...note, id: '<id>', createdAt: '<created>', updatedAt: '<updated>' });

async function inventory(native) {
  const files = ['server.js', ...(await readdir(join(root, 'routes'))).filter(name => name.endsWith('.js')).map(name => `routes/${name}`)];
  const routes = [];
  for (const file of files) {
    const source = await readFile(join(root, file), 'utf8');
    for (const match of source.matchAll(/addRoute\(\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]\s*,\s*['"]([^'"]+)['"]/g)) {
      routes.push({ method: match[1], path: match[2], file });
    }
  }
  const implemented = new Set(native.map(([method, path]) => `${method} ${path}`));
  for (const route of implemented) check(routes.some(r => `${r.method} ${r.path}` === route), true, `Unknown claimed route: ${route}`);
  return {
    productionReady: false,
    registeredRoutes: routes.length,
    implementedRoutes: implemented.size,
    remainingRoutes: routes.filter(r => !implemented.has(`${r.method} ${r.path}`)),
    remainingProtocols: ['production handover', 'launcher and platform parity'],
  };
}

try {
  fixture.env.TZ = 'UTC';
  fixture.env.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z';
  fixture.env.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z';
  await prepareGithubFixture(fixture);
  await prepareSystemChecks(fixture);
  await prepareBatchChecks(fixture);
  await prepareAiConfigChecks(fixture);
  await preparePortsChecks(fixture);
  await prepareGitAiChecks(fixture);
  await prepareTelegramChecks({ fixture, sandbox });
  await prepareSupervisorLlmChecks({ fixture, sandbox });
  prepareProjectSettingsChecks(fixture);
  ({ child: rust, url: rustUrl } = await launch());
  await stop(rust);
  await prepareWorkflowChecks({ fixture, sandbox });
  await prepareWorkflowScheduleChecks({ fixture, sandbox });
  ({ child: rust, url: rustUrl } = await launch());
  await prepareSessionChecks({ fixture, sandbox });
  await prepareCostChecks({ fixture, sandbox });
  await prepareBriefingChecks({ fixture, sandbox });
  await prepareAgentChecks({ fixture, sandbox });
  await fixture.stop();
  await fixture.start();
  await verifySupervisorPolicyChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyAutopilotChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyTelegramChecks({ fixture, sandbox, rustUrl, request, check, restartServers: async () => {
    await stop(rust); await fixture.stop(); await fixture.start();
    ({ child: rust, url: rustUrl } = await launch());
    return { rustUrl };
  } });
  console.log(JSON.stringify({ stage: 'policies-and-telegram', assertions }));
  await verifySupervisorLlmChecks({ fixture, sandbox, rustUrl, request, check, restartServers: async () => {
    await stop(rust); await fixture.stop(); await fixture.start();
    ({ child: rust, url: rustUrl } = await launch());
    return { rustUrl };
  } });
  await verifyGitChecks({ fixture, rustUrl, request, check });
  await verifyGitAiChecks({ fixture, rustUrl, request, check });
  await verifyWorkflowScheduleChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyWorkflowChecks({ fixture, sandbox, rustUrl, request, check, restartServers: async () => {
    await stop(rust); await fixture.stop(); await fixture.start();
    ({ child: rust, url: rustUrl } = await launch());
    return { rustUrl };
  } });
  console.log(JSON.stringify({ stage: 'git-and-workflows', assertions }));
  await verifyGithubChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyCicdChecks({ fixture, sandbox, rustUrl, request, check });
  await verifySystemChecks({ fixture, sandbox, rustUrl, request, check });
  await verifySystemFileChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyDevServerChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyPortsChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyProjectSettingsChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyDiscoveryChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyBatchChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyAgentChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyRustBoard({ fixture, sandbox, rustUrl, request, check });
  await verifyAccountChecks({fixture,sandbox,rustUrl,request,check});
  await verifyAccountLists({fixture,sandbox,rustUrl,request,check});
  await verifySessionChecks({fixture,sandbox,rustUrl,request,check});
  await verifyDelegateChecks({fixture,sandbox,rustUrl,request,check});
  await verifyCostChecks({fixture,sandbox,rustUrl,request,check});
  await verifyBriefingChecks({ fixture, sandbox, rustUrl, request, check });
  await verifyApprovalChecks({fixture,sandbox,rustUrl,request,check});
  await verifyAiConfigChecks({ fixture, sandbox, rustUrl, request, check });
  const tokens = await Promise.all([
    readFile(join(fixture.directory, 'data/cockpit/.cockpit-token'), 'utf8'),
    readFile(join(sandbox, '.cockpit-token'), 'utf8'),
  ]);
  check((await stat(join(sandbox, '.cockpit-token'))).mode & 0o777, 0o600, 'Token permissions');

  // Every public asset retains its current bytes. Private files are not routes.
  for (const path of ['/', '/manifest.json', '/sw.js', '/js/work-overview.js', '/css/cockpit.css', '/vendor/xterm.min.js',
    ...['PretendardVariable', 'JetBrainsMono-Regular', 'JetBrainsMono-Bold', 'JetBrainsMono-Italic'].map(name => `/vendor/fonts/${name}.woff2`)]) {
    const responses = await Promise.all([fixture.url, rustUrl].map(base => request(base, path)));
    check(responses[1].status, responses[0].status, `${path} status`);
    check(responses[1].bytes.equals(responses[0].bytes), true, `${path} exact bytes`);
    for (const key of ['content-type', 'cache-control', 'service-worker-allowed', 'content-security-policy', 'x-frame-options', 'x-content-type-options']) {
      check(responses[1].headers.get(key), responses[0].headers.get(key), `${path} ${key}`);
    }
  }
  for (const path of ['/server.js', '/package.json', '/.cockpit-token', '/notes/ab.json', '/js/%2e%2e%2fserver.js', '/css/../../.cockpit-token', '/vendor/fonts/%2e%2e%2fserver.js', '/vendor/fonts/missing.woff2']) {
    check((await request(rustUrl, path)).status, 404, `Private or traversal path: ${path}`);
  }

  // Proxy headers remove localhost trust. Host and Origin remain independently checked.
  for (const [index, base] of [fixture.url, rustUrl].entries()) {
    check((await request(base, '/api/notes', { headers: { host: 'attacker.invalid' } })).status, 403, 'DNS rebinding');
    for (const proxy of ['x-forwarded-for', 'forwarded', 'tailscale-user-login']) {
      const response = await request(base, '/api/notes', { headers: { [proxy]: 'remote' } });
      check(response.headers.get('content-type').includes('text/html'), true, `${proxy} cannot bypass auth`);
    }
    check((await request(base, '/api/notes', { method: 'POST', headers: { origin: 'https://attacker.invalid' }, body: { title: 'forged' } })).status, 403, 'Cross-origin local write');
    const remote = { 'x-forwarded-for': '100.64.1.2', cookie: `cockpit-token=${tokens[index]}` };
    check((await request(base, '/api/notes', { headers: remote })).status, 200, 'Authenticated remote read');
    check((await request(base, '/api/notes', { method: 'POST', headers: remote, body: { title: 'forged' } })).status, 403, 'Remote write requires origin');
    check((await request(base, '/api/notes', { method: 'POST', headers: { ...remote, origin: base }, body: { title: '' } })).status, 400, 'Same-origin remote write reaches validation');
    const login = await request(base, '/api/auth/login', { method: 'POST', headers: { 'x-forwarded-proto': 'https' }, body: { token: tokens[index] } });
    check(login.status, 200, 'Login');
    for (const flag of ['HttpOnly', 'SameSite=Strict', ';Secure']) check(login.headers.get('set-cookie').includes(flag), true, flag);
    const redirect = await request(base, `/?token=${tokens[index]}`, { headers: { 'x-forwarded-for': '100.64.1.2' } });
    check(redirect.headers.has('set-cookie'), true, 'Token bootstrap cookie');
    check((await request(base, '/api/auth/login', { method: 'POST', body: { token: 123 } })).status, 401, 'Non-string token');
    check((await request(base, '/api/notes', { method: 'POST', body: '{broken' })).status, 400, 'Malformed JSON');
    check((await request(base, '/api/notes', { method: 'POST', body: { title: '   ' } })).status, 400, 'Empty title');
    check((await request(base, '/api/notes/INVALID')).status, 404, 'Invalid note id');
  }

  // Project registration is the foundation used by terminal creation. Compare
  // persisted fields separately from the session/git/PR polling still to port.
  const projectFields = ({ session, git, prs, ...project }) => project;
  const projectIds = [];
  for (const input of [
    { name: 'Preview Test', path: fixture.project, stack: 'node', devCmd: 'npm test', ignored: 'must disappear' },
    { name: 'Preview Test', path: fixture.project, color: 'red;display:none' },
    { id: '한글', name: '한글😀\ud83d', path: fixture.project, color: '#abcd' },
  ]) {
    const responses = await Promise.all([fixture.url, rustUrl].map(base => request(base, '/api/projects', { method: 'POST', body: input })));
    check(responses.map(r => r.status), [201,201], 'Project create');
    check(responses[1].data, responses[0].data, 'Project ID, color and allowed field contract');
    projectIds.push(responses[0].data.id);
  }
  check(projectIds.slice(0,2), ['preview-test','preview-test-2'], 'Duplicate project ID suffix');
  for (const input of [{ color: 'url(evil)', github: 'example/repo', id: 'replace-id' }, { color: '#123456', name: '수정 이름' }]) {
    const pair = await Promise.all([fixture.url, rustUrl].map(base => request(base, '/api/projects/preview-test', { method: 'PUT', body: input })));
    check(pair.map(r => r.status), [200,200], 'Project update');
    check(pair[1].data, pair[0].data, 'Project update contract');
  }
  const listsByRuntime = await Promise.all([fixture.url, rustUrl].map(base => request(base, '/api/projects')));
  check(listsByRuntime[1].data.map(projectFields), listsByRuntime[0].data.filter(p => projectIds.includes(p.id)).map(projectFields), 'Registered projects');
  for (const base of [fixture.url, rustUrl]) {
    check((await request(base, '/api/projects', { method: 'POST', body: { name:'missing' } })).status,400,'Missing project path');
    check((await request(base, '/api/projects/missing', { method: 'PUT', body: {} })).status,404,'Missing project update');
    check((await request(base, '/api/projects/missing/scripts')).status,404,'Missing project scripts');
    check((await request(base, '/api/scripts-by-path')).status,400,'Missing scripts path');
    check((await request(base, `/api/scripts-by-path?path=${encodeURIComponent(fixture.project)}`)).data,{scripts:{test:'node --test'}},'Package scripts path');
    check((await request(base, '/api/projects/preview-test/scripts')).data,{scripts:{test:'node --test'}},'Package scripts project');
    check((await request(base, '/api/scripts-by-path?path=/unregistered')).data,{scripts:{}},'Unregistered scripts path');
  }
  const browse = await Promise.all([fixture.url,rustUrl].map(base=>request(base,`/api/browse?dir=${encodeURIComponent(fixture.project)}`)));
  check(browse[1].data,browse[0].data,'Path picker directory entries');
  const remoteRust = {'x-forwarded-for':'100.64.1.2',cookie:`cockpit-token=${tokens[1]}`};
  check((await request(rustUrl,'/api/browse',{headers:remoteRust})).status,403,'Remote root browse');
  check((await request(rustUrl,`/api/browse?dir=${encodeURIComponent(fixture.project)}`,{headers:remoteRust})).status,200,'Remote registered browse');
  check((await request(rustUrl,`/api/browse?dir=${encodeURIComponent(fixture.directory)}`,{headers:remoteRust})).status,403,'Remote outside browse');
  const escaped = join(fixture.directory,'outside-project');
  await mkdir(escaped);
  await writeFile(join(escaped,'package.json'),JSON.stringify({scripts:{secret:'never return'}}));
  await symlink(escaped,join(fixture.project,'escape'));
  const escapedPath = encodeURIComponent(join(fixture.project,'escape'));
  check((await request(rustUrl,`/api/scripts-by-path?path=${escapedPath}`)).data,{scripts:{}},'Scripts symlink cannot escape registered project');
  check((await request(rustUrl,`/api/browse?dir=${escapedPath}`,{headers:remoteRust})).status,403,'Browse symlink cannot escape registered project');

  // Failed persistence must not publish changes in memory or lose the last file.
  const savedProjects = await readFile(join(sandbox,'projects.json'),'utf8');
  await rename(join(sandbox,'backups'),join(sandbox,'saved-backups'));
  await writeFile(join(sandbox,'backups'),'fixture write blocker');
  check((await request(rustUrl,'/api/projects/preview-test',{method:'PUT',body:{name:'must not commit'}})).status,500,'Project save failure');
  check(await readFile(join(sandbox,'projects.json'),'utf8'),savedProjects,'Failed save leaves disk unchanged');
  check((await request(rustUrl,'/api/projects')).data.find(p=>p.id==='preview-test').name,'수정 이름','Failed save leaves memory unchanged');
  await unlink(join(sandbox,'backups'));
  await rename(join(sandbox,'saved-backups'),join(sandbox,'backups'));
  for (let i=0;i<12;i++) check((await request(rustUrl,'/api/projects/preview-test',{method:'PUT',body:{stack:`node${i}`}})).status,200,'Repeated project save');
  check((await readdir(join(sandbox,'backups'))).filter(name=>name.startsWith('projects.json.')&&name.endsWith('.bak')).length,10,'Ten project backups retained');
  const projectUpdates = await Promise.all([
    request(rustUrl,'/api/projects/preview-test',{method:'PUT',body:{name:'동시 이름'}}),
    request(rustUrl,'/api/projects/preview-test',{method:'PUT',body:{github:'parallel/repository'}}),
  ]);
  check(projectUpdates.map(r=>r.status),[200,200],'Concurrent project updates');
  const concurrentProject = (await request(rustUrl,'/api/projects')).data.find(p=>p.id==='preview-test');
  check([concurrentProject.name,concurrentProject.github],['동시 이름','parallel/repository'],'No lost project update');
  const beforeRestartProjects = (await request(rustUrl,'/api/projects')).data.map(projectFields);

  const ids = [];
  const created = [];
  for (const base of [fixture.url, rustUrl]) {
    const response = await request(base, '/api/notes', { method: 'POST', body: {
      title: ' 한글 노트 😀 ', content: '본문😀'.repeat(100), project: 'demo', tags: ['검증', 17, null, 'rust'],
    } });
    check(response.status, 201, 'Create');
    check(/^[a-f0-9]{16}$/.test(response.data.id), true, 'Compatible generated id');
    ids.push(response.data.id); created.push(response.data);
    check((await request(base, `/api/notes/${response.data.id}`)).data, response.data, 'Read after create');
    check((await request(base, `/api/notes/${response.data.id}`, { method: 'PUT', body: { unexpected: true } })).status, 400, 'Reject empty update');
  }
  check(normalizedNote(created[1]), normalizedNote(created[0]), 'Create contract');
  const updates = await Promise.all([fixture.url, rustUrl].map((base, index) => request(base, `/api/notes/${ids[index]}`, {
    method: 'PUT', body: { title: '제목'.repeat(150), content: '가'.repeat(500_002), tags: Array.from({ length: 23 }, (_, i) => `태그${i}`) },
  })));
  check(normalizedNote(updates[1].data), normalizedNote(updates[0].data), 'Truncation contract');
  check(updates[1].data.content.length, 500_000, 'Content bound');
  const lists = await Promise.all([fixture.url, rustUrl].map(base => request(base, '/api/notes')));
  check(lists[1].data.notes.map(normalizedNote), lists[0].data.notes.map(normalizedNote), 'List and preview contract');

  // Node slices UTF-16, including between the two halves of an emoji. Rust must
  // preserve even those strings, including data written before the migration.
  for (const body of [
    { title: 'a'.repeat(199) + '😀', content: 'a'.repeat(119) + '😀', tags: ['x\ud83d'], project: { legacy: '\udc00' } },
    { title: '경계 본문', content: 'a'.repeat(499_999) + '😀' },
    { title: '단독 surrogate', content: 'a\ud83d\udc00\udc01b\ud83d' },
  ]) {
    const pair = await Promise.all([fixture.url, rustUrl].map(base => request(base, '/api/notes', { method: 'POST', body })));
    check(pair.map(r => r.status), [201, 201], 'UTF-16 create');
    check(normalizedNote(pair[1].data), normalizedNote(pair[0].data), 'UTF-16 contract');
    const legacy = { ...pair[0].data, id: 'beef', future: { untouched: '\ud800' } };
    await writeFile(join(sandbox, 'notes/beef.json'), JSON.stringify(legacy));
    check((await request(rustUrl, '/api/notes/beef')).data, legacy, 'Read Node-written UTF-16 note');
    const changed = await request(rustUrl, '/api/notes/beef', { method: 'PUT', body: { title: '수정' } });
    check(changed.data.content, legacy.content, 'Preserve legacy content during partial update');
    check(changed.data.future, legacy.future, 'Preserve unknown legacy fields');
    check((await request(rustUrl, '/api/notes')).data.notes.some(note => note.id === 'beef'), true, 'Legacy note remains visible');
    check((await request(rustUrl, '/api/notes/beef', { method: 'DELETE' })).status, 200, 'Delete imported fixture');
    for (const [index, base] of [fixture.url, rustUrl].entries()) {
      check((await request(base, `/api/notes/${pair[index].data.id}`, { method: 'DELETE' })).status, 200, 'Delete UTF-16 fixture');
    }
  }

  // Simultaneous partial updates preserve both fields in native storage.
  const concurrent = await Promise.all([
    request(rustUrl, `/api/notes/${ids[1]}`, { method: 'PUT', body: { title: '동시 제목' } }),
    request(rustUrl, `/api/notes/${ids[1]}`, { method: 'PUT', body: { content: '동시 본문' } }),
  ]);
  check(concurrent.map(r => r.status), [200, 200], 'Concurrent updates');
  const persisted = (await request(rustUrl, `/api/notes/${ids[1]}`)).data;
  check([persisted.title, persisted.content], ['동시 제목', '동시 본문'], 'No lost partial update');
  await stop(rust);
  const legacyProjects = JSON.parse(await readFile(join(sandbox,'projects.json'),'utf8'));
  legacyProjects.futureField = '\ud800';
  legacyProjects.projects.push({name:'Legacy Demo',path:fixture.project,legacyNote:'\udc00'});
  const legacyProjectsBytes = JSON.stringify(legacyProjects);
  await writeFile(join(sandbox,'projects.json'),legacyProjectsBytes);
  ({ child: rust, url: rustUrl } = await launch());
  check((await request(rustUrl, `/api/notes/${ids[1]}`)).data, persisted, 'Data survives restart');
  check(await readFile(join(sandbox, '.cockpit-token'), 'utf8'), tokens[1], 'Token survives restart');
  const restoredProjects = (await request(rustUrl,'/api/projects')).data.map(projectFields);
  check(restoredProjects.filter(p=>p.id!=='legacy-demo'),beforeRestartProjects,'Projects survive restart');
  check(restoredProjects.find(p=>p.id==='legacy-demo'),{name:'Legacy Demo',path:fixture.project,id:'legacy-demo',legacyNote:'\udc00'},'Legacy project ID migration');
  check(JSON.parse(await readFile(join(sandbox,'projects.json'),'utf8')).futureField,'\ud800','Unknown legacy project metadata preserved');
  const backupFiles = (await readdir(join(sandbox,'backups'))).filter(name=>name.startsWith('projects.json.')&&name.endsWith('.bak'));
  check((await Promise.all(backupFiles.map(name=>readFile(join(sandbox,'backups',name),'utf8')))).includes(legacyProjectsBytes),true,'Original legacy projects backed up before migration');
  for (const id of projectIds.slice(0,2)) {
    for (const base of [fixture.url,rustUrl]) {
      check((await request(base,`/api/projects/${id}`,{method:'DELETE'})).data,{deleted:true},'Delete project');
      check((await request(base,`/api/projects/${id}`,{method:'DELETE'})).status,404,'Already deleted project');
    }
  }

  // A second process and an existing production-like directory are rejected.
  await assert.rejects(launch(), /already in use/); assertions++;
  const occupied = join(fixture.directory, 'occupied');
  await mkdir(occupied);
  await writeFile(join(occupied, 'board.json'), '{"preserve":true}');
  await assert.rejects(launch(occupied), /Refusing existing data/); assertions++;
  check(await readFile(join(occupied, 'board.json'), 'utf8'), '{"preserve":true}', 'Existing data unchanged');

  // No symlink can turn a note write or public asset read into a private-file operation.
  const protectedFile = join(fixture.directory, 'private.txt');
  await writeFile(protectedFile, 'fixture secret');
  await symlink(protectedFile, join(sandbox, 'notes/ff.json'));
  await symlink(protectedFile, join(fixture.directory, 'app/js/private-link.js'));
  await writeFile(join(fixture.directory, 'app/private.txt'), 'inside-root secret');
  await symlink(join(fixture.directory, 'app/private.txt'), join(fixture.directory, 'app/js/inside-link.js'));
  check((await request(rustUrl, '/api/notes/ff', { method: 'PUT', body: { title: 'overwrite' } })).status, 500, 'Reject note symlink');
  check((await request(rustUrl, '/js/private-link.js')).status, 404, 'Reject asset symlink');
  check((await request(rustUrl, '/js/inside-link.js')).status, 404, 'Reject asset symlink inside root');
  check(await readFile(protectedFile, 'utf8'), 'fixture secret', 'Private target unchanged');
  await writeFile(join(sandbox, 'notes/ab.json'), '{corrupt');
  check((await request(rustUrl, '/api/notes/ab', { method: 'PUT', body: { title: 'overwrite' } })).status, 500, 'Reject corrupt update');
  check(await readFile(join(sandbox, 'notes/ab.json'), 'utf8'), '{corrupt', 'Corrupt input retained');
  check((await request(rustUrl, '/api/notes')).data.notes.length, 1, 'List skips corrupt notes');

  for (const [index, base] of [fixture.url, rustUrl].entries()) {
    check((await request(base, `/api/notes/${ids[index]}`, { method: 'DELETE' })).data, { deleted: true }, 'Delete');
    check((await request(base, `/api/notes/${ids[index]}`)).status, 404, 'Deleted note missing');
    let response;
    for (let i = 0; i < 12; i++) response = await request(base, '/api/auth/login', { method: 'POST', body: { token: 'invalid' } });
    check(response.status, 429, 'Login rate bound');
    check(response.headers.get('retry-after'), '60', 'Login retry bound');
  }
  check((await request(rustUrl, '/api/notes', { method: 'POST', body: ' '.repeat(10 * 1024 * 1024 + 1) })).status, 413, 'Oversize body');
  check((await request(rustUrl, '/api/server/restart', {method:'POST',body:{}})).status, 409, 'Unmanaged preview cannot restart without an owning process manager');
  check((await request(rustUrl, '/api/terminals')).data, {terminals:[]}, 'Native empty terminal registry');
  const status = (await request(rustUrl, '/api/migration/status')).data;
  check(status.productionReady, false, 'Cutover gate');
  const coverage = await inventory(status.nativeRoutes);
  // These two registered routes require actual owned execution, not only a
  // metadata inventory. Run their private HTTP/SSE/provider gate as well.
  await import('./verify-rust-agent-runtime.mjs');
  const agentRuntime = JSON.parse(await readFile(join(root, 'docs/_local/rust-agent-runtime-verification.json'), 'utf8'));
  check(agentRuntime.status, 'passed', 'Native agent API integration gate');
  assertions += agentRuntime.assertions;
  await import('./verify-rust-background-agents.mjs');
  const background = JSON.parse(await readFile(join(root, 'docs/_local/rust-background-agents-verification.json'), 'utf8'));
  check(background.status, 'passed', 'Headless monitor and schedule integration gate');
  assertions += background.assertions;
  await import('./verify-rust-connections.mjs');
  const connections = JSON.parse(await readFile(join(root, 'docs/_local/rust-connections-verification.json'), 'utf8'));
  check(connections.status, 'passed', 'Network, QR, session launcher and voice integration gate');
  assertions += connections.assertions;
  await import('./verify-rust-polling.mjs');
  const polling = JSON.parse(await readFile(join(root, 'docs/_local/rust-polling-verification.json'), 'utf8'));
  check(polling.status, 'passed', 'Project SSE lifecycle and actual desktop notification integration gate');
  assertions += polling.assertions;
  await import('./verify-rust-telegram-commands.mjs');
  const telegramCommands = JSON.parse(await readFile(join(root, 'docs/_local/rust-telegram-commands-verification.json'), 'utf8'));
  check(telegramCommands.status, 'passed', 'Telegram commands and owned agent integration gate');
  assertions += telegramCommands.assertions;
  await import('./verify-rust-handover.mjs');
  const handover = JSON.parse(await readFile(join(root, 'docs/_local/rust-handover-verification.json'), 'utf8'));
  check(handover.status, 'passed', 'Same-file Node to Rust to Node handover gate');
  assertions += handover.assertions;
  await import('./verify-rust-manager.mjs');
  const manager = JSON.parse(await readFile(join(root, 'docs/_local/rust-manager-verification.json'), 'utf8'));
  check(manager.status, 'passed', 'Managed native restart, rollback, orphan and Telegram delivery gate');
  check(manager.cleanupVerified, true, 'Managed lifecycle verification cleans up its owned resources');
  assertions += manager.assertions;
  const report = { checkedAt: new Date().toISOString(), buildProfile: rustBuildProfile, assertions, agentRuntimeVerified: agentRuntime.runtimeApiIntegrated, backgroundAgentsVerified: background.backgroundAgentsIntegrated, connectionsVerified: connections.connectionsIntegrated, pollingVerified: polling.pollingIntegrated, telegramCommandsVerified: telegramCommands.commandsIntegrated, handoverVerified: handover.handoverIntegrated, managerVerified: manager.managerIntegrated, ...coverage };
  const reportPath = join(root, 'docs/_local/rust-migration-verification.json');
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ assertions, nativeRoutes: coverage.implementedRoutes, totalRoutes: coverage.registeredRoutes, productionReady: false, report: reportPath }));
  if (process.argv.includes('--require-complete')) {
    assert.equal(coverage.remainingRoutes.length, 0, 'Production cutover blocked: routes remain unported');
    assert.equal(coverage.remainingProtocols.length, 0, 'Production cutover blocked: protocols remain unported');
    assert.equal(status.productionReady, true, 'Production cutover blocked: preview server');
  }
} finally {
  await cleanupWorkflowChecks(fixture);
  await cleanupAiConfigChecks(fixture);
  await stop(rust);
  await fixture.cleanup();
  await cleanupTelegramChecks(fixture);
  await cleanupSupervisorLlmChecks(fixture);
}
