// Focused verification of native session, delegate and cost data using private
// runtimes, a fake GitHub CLI, and synthetic records. Production is not contacted.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { prepareGithubFixture } from '../tests/helpers/rust-github-checks.js';
import { prepareSessionChecks, verifySessionChecks } from '../tests/helpers/rust-session-checks.js';
import { verifyDelegateChecks } from '../tests/helpers/rust-delegate-checks.js';
import { prepareCostChecks, verifyCostChecks } from '../tests/helpers/rust-cost-checks.js';

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
  fixture.env.TZ = 'UTC';
  await prepareGithubFixture(fixture);
  runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  const context = { fixture, sandbox, rustUrl: runtime.url, request, check };
  await prepareSessionChecks(context);
  await prepareCostChecks(context);
  await fixture.stop(); await fixture.start();
  await verifySessionChecks(context);
  console.log(JSON.stringify({ stage: 'sessions', assertions }));
  await verifyDelegateChecks(context);
  console.log(JSON.stringify({ stage: 'delegates', assertions }));
  await verifyCostChecks(context);
  const report = { checkedAt: new Date().toISOString(), assertions, productionReady: false };
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(join(root, 'docs/_local/rust-dashboard-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await runtime?.stop();
  await fixture.cleanup();
}
