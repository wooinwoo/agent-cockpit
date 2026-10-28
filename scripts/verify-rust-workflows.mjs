// All commands and model calls use private repositories, fake CLIs and loopback fixtures.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer, verifyImmediateRustShutdown } from '../tests/helpers/rust-server.js';
import { prepareGitAiChecks, verifyGitAiChecks } from '../tests/helpers/rust-git-ai-checks.js';
import { prepareWorkflowScheduleChecks, verifyWorkflowScheduleChecks } from '../tests/helpers/rust-workflow-schedule-checks.js';
import { prepareWorkflowChecks, verifyWorkflowChecks, cleanupWorkflowChecks } from '../tests/helpers/rust-workflow-checks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await startPortfolioServer({ durable: false });
const sandbox = join(fixture.directory, 'rust');
let runtime, assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const request = async (base, path, { method = 'GET', body, headers = {} } = {}) => {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch(error => { throw new Error(`${method} ${base}${path}: ${error.message}`, { cause: error }); });
  const text = await response.text(); let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
};
try {
  fixture.env.TZ = 'UTC';
  await prepareGitAiChecks(fixture);
  await verifyImmediateRustShutdown({ root: join(fixture.directory, 'app'), directory: join(fixture.directory, 'immediate-shutdown'), env: fixture.env }, check);
  // Initialize the empty Rust directory before seeding private persisted data.
  runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  await runtime.stop();
  await prepareWorkflowChecks({ fixture, sandbox });
  runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  const context = { fixture, sandbox, rustUrl: runtime.url, request, check, restartServers: async () => {
    await runtime.stop(); await fixture.stop();
    await fixture.start();
    runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
    context.rustUrl = runtime.url;
    return { rustUrl: runtime.url };
  } };
  await prepareWorkflowScheduleChecks(context);
  await fixture.stop(); await fixture.start();
  for (const [stage, verify] of [['git-ai', verifyGitAiChecks], ['workflow-schedules', verifyWorkflowScheduleChecks], ['workflows', verifyWorkflowChecks]]) {
    await verify(context);
    console.log(JSON.stringify({ stage, assertions }));
  }
  const report = { checkedAt: new Date().toISOString(), assertions, productionReady: false };
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(join(root, 'docs/_local/rust-workflow-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await cleanupWorkflowChecks(fixture);
  await runtime?.stop();
  await fixture.cleanup();
}
