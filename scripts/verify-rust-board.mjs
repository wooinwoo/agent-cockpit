// Run existing board compatibility scenarios in private Node and Rust fixtures.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { verifyRustBoard } from '../tests/helpers/rust-board-checks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await startPortfolioServer({ durable: false });
const sandbox = join(fixture.directory, 'rust-board');
let runtime, assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const request = async (base, path, { method = 'GET', body, headers = {} } = {}) => {
  const response = await fetch(base + path, { method, headers: { ...headers,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
};
try {
  runtime = await startRustServer({ root: join(fixture.directory, 'app'), directory: sandbox, env: fixture.env });
  await verifyRustBoard({ fixture, sandbox, rustUrl: runtime.url, request, check });
  console.log(JSON.stringify({ status: 'passed', assertions }));
} finally {
  await runtime?.stop();
  await fixture.cleanup();
}
