// Original CI/weather tool contracts, with inert service and fetch adapters.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../lib/agent-tools.js', import.meta.url), 'utf8');
const ciStart = source.indexOf('async function executeCicd(arg)');
const ciEnd = source.indexOf('function executeOpen(arg)', ciStart);
const weatherStart = source.indexOf('const WMO_WEATHER_KO =');
const weatherEnd = source.indexOf('let _runSubAgentLoop', weatherStart);
assert.ok(ciStart >= 0 && ciEnd > ciStart && weatherStart >= 0 && weatherEnd > weatherStart);
const clean = value => JSON.parse(JSON.stringify(value));

async function run(kind, input) {
  const calls = [];
  const responses = [...(input.responses || [])];
  const service = Object.fromEntries(['getWorkflowRuns', 'getRunDetail', 'rerunWorkflow', 'cancelRun'].map(method => [method, async (...args) => {
    calls.push({ method, args });
    if (Object.hasOwn(input, 'error')) throw new Error(input.error);
    return input.response;
  }]));
  const context = vm.createContext({
    getPrimaryRoot: () => input.root,
    getCicdService: async () => service,
    AbortSignal: { timeout: milliseconds => { assert.equal(milliseconds, 5000); return {}; } },
    fetch: async url => {
      calls.push(url);
      assert.ok(responses.length, 'fixture has a response for every request');
      const response = responses.shift();
      if (Object.hasOwn(response, 'error')) throw new Error(response.error);
      return { json: async () => response.value };
    },
  });
  const api = vm.runInContext(source.slice(ciStart, ciEnd) + '\n' + source.slice(weatherStart, weatherEnd) + '\n({ executeCicd, executeWeather })', context, { timeout: 1000 });
  let expected;
  try { expected = { value: await api[kind === 'cicd' ? 'executeCicd' : 'executeWeather'](input.arg) }; }
  catch (error) { expected = { error: error.message }; }
  return clean({ input, expected, calls });
}

const cicd = [];
async function ci(arg, response = [], options = {}) { cicd.push(await run('cicd', { arg, root: '/fixture/project', response, ...options })); }
for (const arg of ['status', ' STATUS\ufeff', 'detail:123', 'DETAIL: 00012', 'rerun:9', 'cancel:9999999999999999999999', 'detail:', 'rerun:-1', 'cancel:1;pwd', 'detail:１２３', '', 'unknown', null, false, 42, []]) {
  await ci(arg, {});
  await ci(arg, {}, { root: null });
}
for (const status of ['success', 'failure', 'in_progress', 'queued', 'cancelled', null, '', 'timed_out', ['success']]) {
  await ci('status', [{ databaseId: 1, workflowName: '빌드😀\ud800', name: 'fallback', headBranch: 'main\udc00', status, createdAt: '2026-10-08' }]);
  await ci('status', [{ databaseId: 2, name: 'CI', headBranch: 'topic', status: 'completed', conclusion: status, createdAt: null }]);
}
for (const response of [[], {}, null, '', 'bad', [null], [{}], [{ databaseId: 0, workflowName: '', name: ['a', null], headBranch: true, status: null }]]) await ci('status', response);
for (const response of [
  {}, null, { jobs: null }, { jobs: true }, { headSha: 123 },
  { databaseId: 15, displayTitle: '첫 배포😀\ud800', name: 'fallback', workflowName: 'Build', headBranch: 'main', headSha: 'ab😀cd\ud800ef', status: 'completed', conclusion: 'success', createdAt: 'today', jobs: [] },
  { databaseId: 16, name: 'Fallback', workflowName: '테스트', headBranch: 'branch', headSha: '0123456789', status: 'in_progress', createdAt: 'yesterday', jobs: [{ name: 'one', status: 'completed', conclusion: 'success' }, { name: 'two', status: 'completed', conclusion: 'failure' }, { name: 'three', status: 'queued' }] },
  { jobs: [null] },
]) await ci('detail:12', response);
for (const arg of ['status', 'detail:12', 'rerun:12', 'cancel:12']) await ci(arg, null, { error: 'fixture CI error' });

const weather = [];
const place = { name: '서울', country: '대한민국', latitude: 37.566, longitude: 126.978 };
const current = { temperature_2m: 20, apparent_temperature: 19.5, relative_humidity_2m: 60, wind_speed_10m: 4.2, wind_direction_10m: 90, precipitation: 0, weather_code: 0 };
async function wx(arg, geo = { results: [place] }, data = { current }) {
  weather.push(await run('weather', { arg, responses: [{ value: geo }, { value: data }] }));
}
for (const arg of [null, '', '\ufeff \n', false, 42, [], ' 서울 ', "A !'()*~_-.+/?: 😀", '\ud800', '\udc00']) await wx(arg);
for (const geo of [{}, { results: [] }, { results: null }, null, { results: [null] }, { results: [{ latitude: 1, longitude: 2 }] }, { results: [{ ...place, name: '\ud800😀', country: '\udc00' }] }]) await wx('서울', geo);
for (const code of [0, 1, 2, 3, 45, 48, 51, 53, 55, 61, 63, 65, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99, -1, 100, null, '0', 'unknown']) await wx('서울', { results: [place] }, { current: { ...current, weather_code: code } });
for (const wind of [-720, -360, -22.5, -11.25, -0.1, 0, 11.249, 11.25, 22.5, 90, 180, 270, 348.75, 359, 360, 720, null, '90', 'bad']) await wx('서울', { results: [place] }, { current: { ...current, wind_direction_10m: wind } });
for (const data of [
  {}, null, { current: null }, { current: {} },
  { current, daily: { time: ['2026-10-08', '2026-10-09', '2026-10-10'], temperature_2m_min: [10, 11, 12], temperature_2m_max: [20, 21, 22], weather_code: [0, 61, 99] } },
  { current, daily: { time: [] } }, { current, daily: { time: ['date'] } },
  { current, daily: { time: ['date'], temperature_2m_min: [], temperature_2m_max: [], weather_code: [] } },
  { current, daily: { time: ['date'], temperature_2m_min: null, temperature_2m_max: [], weather_code: [] } },
]) await wx('서울', { results: [place] }, data);
weather.push(await run('weather', { arg: '서울', responses: [{ error: 'fake geo failure' }] }));
weather.push(await run('weather', { arg: '서울', responses: [{ value: { results: [place] } }, { error: 'fake forecast failure' }] }));

export const fixtures = { cicd, weather };
if (process.argv.includes('--emit')) process.stdout.write(JSON.stringify(fixtures, null, 2) + '\n');
