// AI credentials, conversation history and port actions use private fixtures.
// No real model, login, listener discovery or user process is touched.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { prepareAiConfigChecks, verifyAiConfigChecks, cleanupAiConfigChecks } from '../tests/helpers/rust-ai-config-checks.js';
import { preparePortsChecks, verifyPortsChecks } from '../tests/helpers/rust-ports-checks.js';
import { prepareAgentChecks, verifyAgentChecks } from '../tests/helpers/rust-agent-checks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await startPortfolioServer({ durable: false });
const sandbox = join(fixture.directory, 'rust');
let runtime, assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const request = async (base, path, { method = 'GET', body, headers = {} } = {}) => {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await response.text(); let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
};
try {
  await prepareAiConfigChecks(fixture);
  await preparePortsChecks(fixture);
  runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  const context = { fixture, sandbox, rustUrl: runtime.url, request, check };
  await prepareAgentChecks(context);
  await fixture.stop(); await fixture.start();
  for (const [stage, verify] of [['agent', verifyAgentChecks], ['ports', verifyPortsChecks], ['ai-config', verifyAiConfigChecks]]) {
    await verify(context);
    console.log(JSON.stringify({ stage, assertions }));
  }
  const report = { checkedAt: new Date().toISOString(), assertions, productionReady: false };
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(join(root, 'docs/_local/rust-agent-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await cleanupAiConfigChecks(fixture);
  await runtime?.stop();
  await fixture.cleanup();
}
