// Private Node/Rust policy comparisons. No production sessions or model keys.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { verifyAutopilotChecks } from '../tests/helpers/rust-autopilot-checks.js';
import { verifySupervisorPolicyChecks } from '../tests/helpers/rust-supervisor-policy-checks.js';
import { prepareTelegramChecks, verifyTelegramChecks, cleanupTelegramChecks } from '../tests/helpers/rust-telegram-checks.js';
import { prepareSupervisorLlmChecks, verifySupervisorLlmChecks, cleanupSupervisorLlmChecks } from '../tests/helpers/rust-supervisor-llm-checks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await startPortfolioServer({ durable: false });
const sandbox = join(fixture.directory, 'rust');
let runtime, assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const request = async (base, path, { method = 'GET', body, headers = {} } = {}) => {
  const response = await fetch(base + path, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
};
try {
  fixture.env.TZ = 'UTC';
  await prepareTelegramChecks({ fixture, sandbox });
  await prepareSupervisorLlmChecks({ fixture, sandbox });
  await fixture.stop(); await fixture.start();
  runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  const context = { fixture, sandbox, rustUrl: runtime.url, request, check, restartServers: async () => {
    await runtime.stop(); await fixture.stop(); await fixture.start();
    runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
    context.rustUrl = runtime.url;
    return { rustUrl: runtime.url };
  } };
  for (const [stage, verify] of [['supervisor-policy', verifySupervisorPolicyChecks], ['autopilot', verifyAutopilotChecks], ['telegram-core', verifyTelegramChecks], ['supervisor-model', verifySupervisorLlmChecks]]) {
    await verify(context);
    console.log(JSON.stringify({ stage, assertions }));
  }
  const report = { checkedAt: new Date().toISOString(), assertions, productionReady: false,
    remaining: ['Telegram command and agent bridge', 'Production handover and recovery'] };
  await mkdir(join(root, 'docs/_local'), { recursive: true });
  await writeFile(join(root, 'docs/_local/rust-policy-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await runtime?.stop();
  await fixture.cleanup();
  await cleanupTelegramChecks(fixture);
  await cleanupSupervisorLlmChecks(fixture);
}
