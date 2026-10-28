// Exercise desktop commands, CI contracts, uploads and owned dev servers only
// against private runtimes and fake executables. Production is not contacted.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { prepareGithubFixture } from '../tests/helpers/rust-github-checks.js';
import { prepareSystemChecks, verifySystemChecks, verifyCicdChecks } from '../tests/helpers/rust-system-checks.js';
import { verifySystemFileChecks } from '../tests/helpers/rust-system-file-checks.js';
import { verifyDevServerChecks } from '../tests/helpers/rust-dev-server-checks.js';

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
  await prepareGithubFixture(fixture);
  await prepareSystemChecks(fixture);
  await fixture.stop(); await fixture.start();
  runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  const context = { fixture, sandbox, rustUrl: runtime.url, request, check };
  for (const [stage, verify] of [['cicd', verifyCicdChecks], ['system', verifySystemChecks], ['files', verifySystemFileChecks], ['devServers', verifyDevServerChecks]]) {
    await verify(context);
    console.log(JSON.stringify({ stage, assertions }));
  }
  const report = { checkedAt: new Date().toISOString(), assertions, productionReady: false };
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(join(root, 'docs/_local/rust-system-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await runtime?.stop();
  await fixture.cleanup();
}
