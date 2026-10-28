import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

const helper = fileURLToPath(new URL('../skills/cockpit-report/scripts/register.py', import.meta.url));
const checks = [];
let fixture;
try {
  fixture = await startPortfolioServer({ durable: false, runtime: 'rust' });
  const path = join(fixture.project, "한글 공백 '& 보고서.md");
  await writeFile(path, '# 보고서 등록 도우미 시험\n공개 시험 자료입니다.\n');
  async function register(file) {
    return JSON.parse((await promisify(execFile)('/usr/bin/python3', [helper, file, '--title', '진행 시험 보고서', '--session', 'ai-fixture'],
      { env: { ...process.env, COCKPIT_URL: fixture.url } })).stdout);
  }
  const first = await register(path);
  assert.equal(first.ok, true);
  assert.equal(first.report.path, path);
  assert.equal(first.report.session, 'ai-fixture');
  checks.push('The helper registers an actual local Markdown file in the native report library');
  await writeFile(path, '# 갱신한 보고서\n원본 수정 시험입니다.\n');
  const updated = await register(path);
  assert.equal(updated.report.id, first.report.id);
  assert.equal((await (await fetch(fixture.url + '/api/reports')).json()).reports.length, 1);
  checks.push('An updated report keeps one entry with the same ID');
  await assert.rejects(register(join(fixture.directory, 'outside.md')), error => JSON.parse(error.stdout).ok === false);
  assert.match(await readFile(path, 'utf8'), /갱신한 보고서/);
  checks.push('Out-of-project paths are rejected and the saved report source remains intact');
  const result = { status: 'passed', checkedAt: new Date().toISOString(), checks, runtime: 'rust', buildProfile: process.argv.includes('--release') ? 'release' : 'debug' };
  await writeFile(new URL('../docs/_local/report-skill-verification.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await fixture?.cleanup();
}
