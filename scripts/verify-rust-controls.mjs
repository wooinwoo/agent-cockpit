// Native settings, discovery, briefing and batch command verification. Every
// runtime, repository, history record and executable is a private fixture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { prepareGithubFixture } from '../tests/helpers/rust-github-checks.js';
import { prepareBatchChecks, verifyBatchChecks } from '../tests/helpers/rust-batch-checks.js';
import { prepareBriefingChecks, verifyBriefingChecks } from '../tests/helpers/rust-briefing-checks.js';
import { prepareProjectSettingsChecks, verifyProjectSettingsChecks, verifyDiscoveryChecks } from '../tests/helpers/rust-project-settings-checks.js';

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
  await prepareBatchChecks(fixture);
  prepareProjectSettingsChecks(fixture);
  await fixture.stop(); await fixture.start();
  runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  const context = { fixture, sandbox, rustUrl: runtime.url, request, check };
  await prepareBriefingChecks(context);
  for (const [stage, verify] of [['settings', verifyProjectSettingsChecks], ['discovery', verifyDiscoveryChecks], ['batch', verifyBatchChecks], ['briefing', verifyBriefingChecks]]) {
    await verify(context);
    console.log(JSON.stringify({ stage, assertions }));
  }
  const report = { checkedAt: new Date().toISOString(), assertions, productionReady: false };
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(join(root, 'docs/_local/rust-controls-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await runtime?.stop();
  await fixture.cleanup();
}
