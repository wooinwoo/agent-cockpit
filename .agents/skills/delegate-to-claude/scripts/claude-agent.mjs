#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DELEGATE_STATUS_DIR } from '../../../../lib/delegate-status.js';

const mode = process.argv[2] || 'review';
const model = process.argv[3] || 'sonnet';
const modes = {
  review: {
    permission: 'plan',
    guardrail: 'Investigate and report only. Do not modify files.',
  },
  work: {
    permission: 'acceptEdits',
    guardrail: 'Make only the requested file edits. Do not run tests or write-capable shell commands; the parent Codex agent will verify the result.',
  },
};

if (!modes[mode]) {
  console.error(`usage: ${process.argv[1]} [review|work] [model] < task`);
  process.exit(64);
}

let task = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) task += chunk;
if (!task.trim()) {
  console.error('task is required on stdin');
  process.exit(64);
}

const runId = randomUUID();
const cockpitUrl = (process.env.COCKPIT_URL || 'http://127.0.0.1:3847').replace(/\/$/, '');
const statusBody = state => ({
  runId,
  state,
  model,
  termId: process.env.COCKPIT_TERM_ID || undefined,
  cwd: process.cwd(),
  updatedAt: Date.now(),
});
async function report(state) {
  const body = statusBody(state);
  try {
    await mkdir(DELEGATE_STATUS_DIR, { recursive: true, mode: 0o700 });
    const name = `${runId}-${body.updatedAt}-${randomUUID()}`;
    const temp = join(DELEGATE_STATUS_DIR, `${name}.tmp`);
    await writeFile(temp, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
    await rename(temp, join(DELEGATE_STATUS_DIR, `${name}.json`));
    return;
  } catch { /* Fall back to HTTP when the shared temp directory is unavailable. */ }
  try {
    await fetch(`${cockpitUrl}/api/agent/delegate-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
  } catch { /* Cockpit may not be running; delegation still works. */ }
}
let reportQueue = Promise.resolve();
const queueReport = state => (reportQueue = reportQueue.then(() => report(state)));

const env = { ...process.env };
delete env.CLAUDECODE;
const config = modes[mode];
const args = [
  '-p', '--model', model, '--output-format', 'json',
  '--append-system-prompt', config.guardrail,
  '--permission-mode', config.permission,
];

await queueReport('running');
const heartbeat = setInterval(() => { void queueReport('heartbeat'); }, 5000);
let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: process.cwd(), env, shell: false, windowsHide: true,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
    process.once('SIGINT', () => child.kill('SIGINT'));
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    child.stdin.end(task);
  });
} finally {
  clearInterval(heartbeat);
  await queueReport('done');
}
process.exitCode = exitCode;
