#!/usr/bin/env node
// Isolated cost-parser measurement. Only synthetic fixture homes are read by servers.
import assert from 'node:assert/strict';
import { readFile, readlink, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { rustBinary, rustBuildProfile } from '../tests/helpers/rust-server.js';

function option(name, fallback, low, high) {
  const arg = process.argv.find(value => value.startsWith(`--${name}=`));
  const value = arg ? Number(arg.slice(name.length + 3)) : fallback;
  assert.ok(Number.isInteger(value) && value >= low && value <= high, `Invalid --${name}`);
  return value;
}
assert.equal(rustBuildProfile, 'release', 'Pass --release to measure the installed build profile');
const config = {
  contentMiB: option('mib', 8, 4, 128),
  lineKiB: option('line-kib', 1024, 1, 8192),
  files: option('files', 4, 1, 16),
  cycles: option('cycles', 3, 2, 6),
  intervalMs: 31_000,
  sampleMs: 100,
  rssLimitKiB: 768 * 1024,
};
const initialRows = config.contentMiB * 1024 / config.lineKiB;
assert.ok(Number.isInteger(initialRows) && initialRows >= config.files);
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => abort.abort(new Error(`Measurement interrupted by ${signal}`)));
}
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const wait = ms => delay(ms, undefined, { signal: abort.signal });

async function identity(pid) {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  const parts = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid, parent: Number(parts[1]), started: parts[19] };
}
async function children(pid) {
  const text = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
  return text.trim().split(/\s+/).filter(Boolean).map(Number);
}
async function fixtureProcesses(fixture) {
  const expectedCwd = join(fixture.directory, 'app');
  const direct = [];
  for (const pid of await children(process.pid)) {
    try {
      if (await readlink(`/proc/${pid}/cwd`) === expectedCwd) direct.push(await identity(pid));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(direct.length, 1, 'Exactly one directly owned fixture launcher is required');
  assert.equal(direct[0].parent, process.pid);
  if (fixture.runtime === 'node') return { server: direct[0] };
  const owned = [];
  for (const pid of await children(direct[0].pid)) {
    if (await readlink(`/proc/${pid}/cwd`) === expectedCwd) owned.push(await identity(pid));
  }
  assert.equal(owned.length, 1, 'Exactly one managed fixture server is required');
  assert.equal(owned[0].parent, direct[0].pid);
  return { server: owned[0], manager: direct[0] };
}
async function memory(owner) {
  assert.equal((await identity(owner.pid)).started, owner.started, 'Owned PID identity changed');
  const text = await readFile(`/proc/${owner.pid}/status`, 'utf8');
  const result = { pid: owner.pid };
  for (const field of ['VmRSS', 'VmHWM', 'RssAnon', 'VmData', 'Threads']) {
    const match = text.match(new RegExp(`^${field}:\\s+(\\d+)`, 'm'));
    if (match) result[field === 'Threads' ? 'threads' : `${field}KiB`] = Number(match[1]);
  }
  return result;
}
async function usage(fixture) {
  const response = await fetch(`${fixture.url}/api/usage`, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
  });
  assert.equal(response.status, 200, 'Private cost route must succeed');
  const value = await response.json();
  assert.ok(value.today && typeof value.today.date === 'string');
  return value.today;
}

async function measure(runtime) {
  const fixture = await startPortfolioServer({ runtime, durable: false });
  let sampling = true;
  let sampler;
  let samplerError;
  let peakKiB = 0;
  let allPeakKiB = 0;
  const started = performance.now();
  try {
    const owners = await fixtureProcesses(fixture);
    const initial = await usage(fixture);
    assert.equal(initial.messages, 0, 'Fixture must start with no usage records');
    const baseline = await memory(owners.server);
    emit({ kind: 'baseline', runtime, elapsedMs: Math.round(performance.now() - started), memory: baseline,
      manager: owners.manager ? await memory(owners.manager) : null });
    sampler = (async () => {
      while (sampling) {
        const sample = await memory(owners.server);
        peakKiB = Math.max(peakKiB, sample.VmRSSKiB);
        allPeakKiB = Math.max(allPeakKiB, sample.VmRSSKiB);
        if (sample.VmRSSKiB > config.rssLimitKiB) throw new Error('Private fixture RSS exceeded the measurement limit');
        await delay(config.sampleMs);
      }
    })().catch(error => { samplerError = error; abort.abort(error); });
    const projectDir = join(fixture.directory, '.claude', 'projects', 'cost-memory-fixture');
    await mkdir(projectDir, { recursive: true });
    const paths = Array.from({ length: config.files }, (_, i) => join(projectDir, `synthetic-${i}.jsonl`));
    let rows = 0;
    const content = 'x'.repeat(config.lineKiB * 1024);
    async function append(count) {
      for (let i = 0; i < count; i++) {
        const index = rows++;
        const line = JSON.stringify({ type: 'assistant', timestamp: `${initial.date}T12:00:00.000Z`,
          requestId: `synthetic-request-${index}`, message: { id: `synthetic-message-${index}`,
            model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20,
              cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            content: [{ type: 'text', text: content }] } }) + '\n';
        const file = await open(paths[index % paths.length], 'a', 0o600);
        try { await file.writeFile(line); } finally { await file.close(); }
      }
    }
    await append(initialRows);
    const measurements = [];
    for (let cycle = 0; cycle < config.cycles; cycle++) {
      if (cycle > 0) await append(config.files);
      const bytes = (await Promise.all(paths.map(path => stat(path)))).reduce((sum, file) => sum + file.size, 0);
      emit({ kind: 'waiting', runtime, cycle: cycle + 1, bytes, rows, intervalMs: config.intervalMs });
      // Background polling can refresh the cache after our previous response.
      // Expire it from the completed append, not from that older response.
      await wait(config.intervalMs);
      if (samplerError) throw samplerError;
      const before = await memory(owners.server);
      peakKiB = before.VmRSSKiB;
      const requestAt = performance.now();
      const today = await usage(fixture);
      const requestMs = Math.round(performance.now() - requestAt);
      assert.equal(today.date, initial.date, 'Measurement crossed the server local date boundary');
      assert.equal(today.messages, rows, 'All synthetic messages must be accounted for');
      assert.equal(today.inputTokens, rows * 100);
      assert.equal(today.outputTokens, rows * 20);
      assert.equal(today.sessions, config.files);
      await wait(2000);
      const after = await memory(owners.server);
      const record = { kind: 'cycle', runtime, cycle: cycle + 1, bytes, rows,
        elapsedMs: Math.round(performance.now() - started), requestMs, before, after,
        sampledPeakKiB: peakKiB, allSampledPeakKiB: allPeakKiB,
        totals: { messages: today.messages, sessions: today.sessions, inputTokens: today.inputTokens,
          outputTokens: today.outputTokens, apiEquivCost: today.apiEquivCost } };
      measurements.push(record);
      emit(record);
    }
    if (runtime === 'rust' && process.argv.includes('--check-growth')) {
      assert.equal(config.lineKiB, 1, 'Growth regression uses many small rows');
      assert.ok(config.cycles >= 3, 'Growth regression requires a warm-up and two refreshes');
      const previous = measurements.at(-2).after.VmRSSKiB;
      const latest = measurements.at(-1).after.VmRSSKiB;
      assert.ok(latest - previous < 8 * 1024,
        `Rust retained ${latest - previous} KiB after a small log append`);
      emit({ kind: 'growth-check', runtime, passed: true, growthKiB: latest - previous, limitKiB: 8 * 1024 });
    }
    return { runtime, baseline, measurements, allSampledPeakKiB: allPeakKiB };
  } finally {
    sampling = false;
    await sampler;
    await fixture.cleanup();
    emit({ kind: 'cleanup', runtime, completed: true });
  }
}

try {
  emit({ kind: 'configuration', checkedAt: new Date().toISOString(), config, rustBinary,
    buildProfile: rustBuildProfile, productionTouched: false, sampleLimit: 'VmHWM includes any peaks shorter than the RSS sampling interval.' });
  const results = [];
  const runtimes = process.argv.includes('--rust-only') ? ['rust'] : ['node', 'rust'];
  for (const runtime of runtimes) results.push(await measure(runtime));
  emit({ kind: 'complete', checkedAt: new Date().toISOString(), results, productionTouched: false });
} catch (error) {
  emit({ kind: 'failure', message: error.message, productionTouched: false });
  process.exitCode = 1;
}
