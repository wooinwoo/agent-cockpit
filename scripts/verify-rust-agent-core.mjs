// Compare fresh original-source fixtures and run native tests without contacting
// production sessions, model providers, Telegram, or desktop applications.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures as parserFixtures } from '../tests/helpers/rust-agent-response-fixtures.mjs';
import { makeFixtures } from '../tests/helpers/rust-agent-tool-fixtures.mjs';
import { makePromptFixtures, makeRuntimeFixtures } from '../tests/helpers/rust-agent-runtime-fixtures.mjs';
import { fixtures as routingFixtures } from '../tests/helpers/rust-agent-routing-fixtures.mjs';
import { fixtures as consultFixtures } from '../tests/helpers/rust-agent-consult-fixtures.mjs';
import { makeFixtures as makeOrchestrationFixtures } from '../tests/helpers/rust-agent-orchestration-fixtures.mjs';
import { fixtures as contextFixtures } from '../tests/helpers/rust-agent-context-fixtures.mjs';
import { fixtures as cockpitServiceFixtures } from '../tests/helpers/rust-agent-service-cockpit-fixtures.mjs';
import { fixtures as externalServiceFixtures } from '../tests/helpers/rust-agent-service-external-fixtures.mjs';
import { fixtures as jiraServiceFixtures } from '../tests/helpers/rust-agent-service-jira-fixtures.mjs';
import { fixtures as monitorFixtures } from '../tests/helpers/rust-monitor-fixtures.mjs';
import { fixtures as monitorJiraFixtures } from '../tests/helpers/rust-monitor-jira-fixtures.mjs';
import { fixtures as autonomyFixtures } from '../tests/helpers/rust-autonomy-schedule-fixtures.mjs';
import { fixtures as qrFixtures } from '../tests/helpers/rust-qr-fixtures.mjs';
import { fixtures as networkFixtures } from '../tests/helpers/rust-network-address-fixtures.mjs';
import { fixtures as launchFixtures } from '../tests/helpers/rust-session-launch-fixtures.mjs';
import { fixtures as ttsFixtures } from '../tests/helpers/rust-tts-fixtures.mjs';
import { fixtures as notifyFixtures } from '../tests/helpers/rust-notify-fixtures.mjs';
import { fixtures as telegramTextFixtures } from '../tests/helpers/rust-telegram-text-fixtures.mjs';
import { fixtures as telegramTodoFixtures } from '../tests/helpers/rust-telegram-todo-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = join(root, 'docs/_local/rust-agent-core-verification.json');
const report = {
  checkedAt: new Date().toISOString(), productionReady: false, scope: 'native agent unit and original-source comparisons; HTTP integration is verified separately',
  status: 'running', parserReferenceCases: 0, toolReferenceCases: 0, policyReferenceCases: 0,
  gitReferenceCases: 0, promptReferenceCases: 0, soloRuntimeReferenceCases: 0,
  profileReferenceCases: 0, routingReferenceCases: 0, consultReferenceCases: 0, orchestrationReferenceCases: 0,
  contextReferenceCases: 0, cockpitServiceReferenceCases: 0, cicdServiceReferenceCases: 0,
  weatherServiceReferenceCases: 0, jiraServiceReferenceCases: 0,
  monitorReferenceCases: 0, monitorJiraReferenceCases: 0, autonomyScheduleReferenceCases: 0,
  qrReferenceCases: 0, networkReferenceCases: 0, sessionLaunchReferenceCases: 0, ttsReferenceCases: 0,
  notificationReferenceCases: 0,
  telegramTextReferenceCases: 0, telegramTodoReferenceCases: 0,
  nativeTests: 0,
};
await mkdir(join(root, 'docs/_local'), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const jsonFile = async path => JSON.parse(await readFile(join(root, path), 'utf8'));

async function nativeTests() {
  const child = spawn(join(homedir(), '.cargo/bin/cargo'), [
    'test', '--manifest-path', join(root, 'rust-server/Cargo.toml'), '--locked', '--offline', '-j', '2', '--', '--test-threads=4',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch {}
  };
  const timer = setTimeout(terminate, 180_000);
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
    });
    assert.equal(code, 0, `${errors}\n${output}`);
    const result = /test result: ok\. (\d+) passed; 0 failed;/.exec(output);
    assert.ok(result, `Native test summary missing\n${output}`);
    return Number(result[1]);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', terminate);
  }
}

try {
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-response.json'), JSON.parse(JSON.stringify(parserFixtures)), 'Parser fixtures must still match the original JavaScript');
  const { policy, cases, policies, gitCases } = await makeFixtures();
  assert.deepEqual(await jsonFile('rust-server/src/agent_tool_policy.json'), policy, 'Embedded policy must match original source before native strengthening');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-tools.json'), { cases, policies, gitCases }, 'Tool fixtures must still match original isolated execution');
  const prompts = makePromptFixtures(), runtime = await makeRuntimeFixtures();
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-prompt.json'), prompts, 'Prompt fixtures must still match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-runtime.json'), runtime, 'Solo runtime fixtures must still match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-routing.json'), routingFixtures, 'Routing fixtures must still match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-consult.json'), consultFixtures, 'Consult fixtures must still match original source');
  const orchestration = await makeOrchestrationFixtures();
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-orchestration.json'), orchestration, 'Orchestration fixtures must still match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-context.json'), contextFixtures, 'Project and team context fixtures must still match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-service-cockpit.json'), cockpitServiceFixtures, 'COCKPIT service fixtures must still match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-service-external.json'), externalServiceFixtures, 'CI/CD and weather service fixtures must still match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-agent-service-jira.json'), jiraServiceFixtures, 'Jira service fixtures must still match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-monitor.json'), monitorFixtures, 'Monitor fixtures retain original behavior and documented corrections');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-monitor-jira.json'), monitorJiraFixtures, 'Monitor Jira fixtures must match actual source requests');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-autonomy-schedule.json'), autonomyFixtures, 'Schedule fixtures must match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-qr.json'), qrFixtures, 'QR fixtures retain the original reference and documented standard corrections');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-network-address.json'), networkFixtures, 'Network discovery fixtures must match original source');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-session-launch.json'), launchFixtures, 'Launcher fixtures retain original options and documented quoting corrections');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-tts.json'), ttsFixtures, 'Speech fixtures retain the installed provider protocol and documented validation corrections');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-notify.json'), notifyFixtures, 'Desktop notification fixtures retain the original commands and documented quoting corrections');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-telegram-text.json'), telegramTextFixtures, 'Telegram text fixtures retain source behavior and documented masking corrections');
  assert.deepEqual(await jsonFile('tests/fixtures/rust-telegram-todo.json'), telegramTodoFixtures, 'Telegram todo fixtures retain source storage behavior and reject corruption');
  Object.assign(report, { parserReferenceCases: parserFixtures.length, toolReferenceCases: cases.length, policyReferenceCases: policies.length, gitReferenceCases: gitCases.length,
    promptReferenceCases: prompts.length, soloRuntimeReferenceCases: runtime.length,
    profileReferenceCases: routingFixtures.helperCases.length,
    routingReferenceCases: routingFixtures.routingCases.reduce((sum, test) => sum + test.steps.length, 0),
    consultReferenceCases: consultFixtures.length, orchestrationReferenceCases: orchestration.length,
    contextReferenceCases: contextFixtures.length, cockpitServiceReferenceCases: cockpitServiceFixtures.length,
    cicdServiceReferenceCases: externalServiceFixtures.cicd.length, weatherServiceReferenceCases: externalServiceFixtures.weather.length,
    jiraServiceReferenceCases: jiraServiceFixtures.length, monitorReferenceCases: monitorFixtures.length,
    monitorJiraReferenceCases: monitorJiraFixtures.length, autonomyScheduleReferenceCases: autonomyFixtures.length,
    qrReferenceCases: qrFixtures.length, networkReferenceCases: networkFixtures.length,
    sessionLaunchReferenceCases: launchFixtures.length, ttsReferenceCases: ttsFixtures.hashes.length+ttsFixtures.requests.length+ttsFixtures.frames.length,
    notificationReferenceCases: notifyFixtures.length,
    telegramTextReferenceCases: telegramTextFixtures.length, telegramTodoReferenceCases: telegramTodoFixtures.length });
  console.log(JSON.stringify({ stage: 'original-source-fixtures', ...report }));
  report.nativeTests = await nativeTests();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  throw error;
} finally {
  report.checkedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
