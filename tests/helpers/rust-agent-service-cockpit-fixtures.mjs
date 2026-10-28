// Evaluate the original COCKPIT text/dispatch contract with inert services.
// This helper never imports the application or invokes its filesystem, shell,
// terminal, network, or timer implementations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../lib/agent-tools.js', import.meta.url), 'utf8');
const start = source.indexOf('function fmtBytes(b)');
const end = source.indexOf('const WMO_WEATHER_KO =', start);
assert.ok(start >= 0 && end > start, 'original cockpit tool boundaries');
const now = Date.parse('2026-10-08T12:34:56.000Z');
const clean = value => JSON.parse(JSON.stringify(value));

function parts(argument) {
  const trimmed = typeof argument === 'string' ? argument.trim() : '';
  const newline = trimmed.indexOf('\n');
  const line = newline >= 0 ? trimmed.slice(0, newline).trim() : trimmed;
  const colon = line.indexOf(':');
  return {
    command: (colon < 0 ? line : line.slice(0, colon)).toLowerCase(),
    parameter: colon < 0 ? '' : line.slice(colon + 1).trim(),
    extra: newline < 0 ? '' : trimmed.slice(newline + 1),
  };
}

export async function original(input) {
  const snapshot = input.snapshot;
  const { command, parameter, extra } = parts(input.argument);
  const calls = [];
  const gitCalls = [];
  const timers = [];
  const recorded = new Set();
  const value = operation => Object.hasOwn(snapshot, operation) ? snapshot[operation] : null;
  const record = (operation, parameter, input = null) => {
    calls.push({ operation, parameter, input });
    const response = value(operation);
    if (response && typeof response === 'object' && Object.hasOwn(response, '__error')) throw new Error(response.__error);
    return response;
  };
  const once = operation => {
    if (!recorded.has(operation)) {
      recorded.add(operation);
      return record(operation, parameter);
    }
    const response = value(operation);
    if (response && typeof response === 'object' && Object.hasOwn(response, '__error')) throw new Error(response.__error);
    return response;
  };

  // The native adapter aggregates these cache lookups into one service call.
  const projectsFor = () => {
    if (command === 'projects') return once('projects');
    if (command === 'sessions') return (once('sessions') || []).map((row, index) => ({ id: `session-${index}`, name: row.name }));
    if (command === 'terminals') return value('terminals')?.projects || [];
    if (command === 'prs') {
      const rows = once('prs') || [];
      const names = [...new Set(rows.map(row => row.project))];
      return names.map((name, index) => ({ id: parameter || `prs-${index}`, name }));
    }
    return snapshot.projects || [];
  };
  const poller = { getCached(key) {
    if (command === 'usage' && key === 'cost:daily') return once('usage');
    if (command === 'project') {
      const kind = key.slice(0, key.indexOf(':'));
      return value('project')?.[kind] ?? null;
    }
    if (command === 'sessions' && key.startsWith('session:session-')) return value('sessions')?.[Number(key.slice('session:session-'.length))]?.session ?? null;
    if (command === 'prs' && key.startsWith('prs:')) {
      const rows = value('prs') || [];
      if (parameter) return { prs: rows };
      const index = Number(key.slice('prs:prs-'.length));
      const names = [...new Set(rows.map(row => row.project))];
      return { prs: rows.filter(row => row.project === names[index]) };
    }
    return null;
  } };

  const services = {
    poller,
    computeUsage: async () => once('usage'),
    getProjects: projectsFor,
    getProjectById: id => record('project', id)?.project ?? null,
    listNotes: async () => record('notes', parameter),
    getNote: async id => record('note', id),
    createNote: async body => record('note-create', body.title, body),
    updateNote: async (id, body) => record('note-update', id, body),
    getAllStats: async () => record('system', parameter),
    generateBriefing: () => record('briefing', parameter),
    checkAlerts: () => record('alerts', parameter),
    getRecentActivity: () => record('activity', parameter),
    listWorkflowDefs: async () => record('workflows', parameter),
    getWorkflowDef: async id => record('workflow', id),
    listWorkflowRuns: async () => record('workflow-runs', parameter),
    getWorkflowRunDetail: async id => record('workflow-run', id),
    startWorkflowRun: async (id, body) => record('workflow-start', id, body),
    listTerminals: () => once('terminals')?.terminals || [],
    readTerminalBuffer: id => {
      if (command === 'terminal-read') return record('terminal-read', id);
      if (command === 'terminal-input') return value('terminal-input');
      if (command === 'terminal-create') return value('terminal-create')?.output;
      throw new Error('unexpected fake terminal read');
    },
    writeTerminalInput: (id, body) => record('terminal-input', id, body) !== null,
    createTerminal: (id, body) => record('terminal-create', id, body)?.id,
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [input.now])); }
    static now() { return input.now; }
  }
  const api = vm.runInNewContext(source.slice(start, end) + '\n({ executeCockpit, fmtBytes, fmtNum, timeAgo })', {
    _cockpitServices: services,
    Date: FixedDate,
    setTimeout(callback, milliseconds) { timers.push(milliseconds); callback(); return 1; },
    gitExec: async (path, args) => {
      gitCalls.push({ path, args });
      if (!recorded.has(command)) { recorded.add(command); record(command, parameter, extra); }
      const response = value(command);
      if (response && typeof response === 'object' && Object.hasOwn(response, '__error')) throw new Error(response.__error);
      return args[0] === 'add' ? '' : response;
    },
  }, { timeout: 1000 });
  let expected;
  try { expected = { value: await api.executeCockpit(input.argument) }; }
  catch (error) { expected = { error: error.message }; }
  return clean({ input, expected, calls, gitCalls, timers });
}

const fixtures = [];
async function add(argument, snapshot = {}, time = now) {
  fixtures.push(await original({ argument, snapshot, now: time }));
}
const project = { id: 'p1', name: '프로젝트😀\ud800', stack: 'Rust', path: '/fixture/project' };
const note = { id: 'n1', title: '노트😀\ud800', content: '첫 줄\n둘째\udc00', tags: ['배포', '검증'], project: 'p1', createdAt: now - 86_400_000, updatedAt: now - 60_000 };
const terminalText = '\u001b[31mhello😀\ud800\u001b[0m\n\u001b]0;window title\u0007done\udc00';
const good = {
  usage: { today: { date: '2026-10-08', outputTokens: 1234567, inputTokens: 7654321, cacheReadTokens: 6000, cacheCreationTokens: 7000, apiEquivCost: 12.345, messages: 17, sessions: 3, toolCalls: 20, models: { flash: { apiCost: 1.25, outputTokens: 1234 }, opus: { apiCost: 11.095, outputTokens: 1233333 } } }, week: { apiEquivCost: 50.123, outputTokens: 9876543, messages: 500, resetAt: '2026-10-12' } },
  projects: [project, { id: 'p2', name: '둘째', stack: '', path: '/fixture/second' }],
  project: { project, session: { state: 'working', model: 'claude', lastActivity: now - 120000 }, git: { branch: 'main', uncommittedCount: 2, recentCommits: [{ message: '검증 완료\ud800', hash: 'abc😀defghi' }] }, prs: { prs: [{ number: 4, title: '수정', reviewDecision: 'APPROVED' }] }, cicd: { runs: [{ name: '빌드', conclusion: 'success', created_at: new Date(now - 3600000).toISOString() }] } },
  prs: [{ number: 4, title: '수정\ud800', reviewDecision: 'APPROVED', project: project.name, author: 'fixture', isDraft: false }, { number: 8, title: '초안', project: '둘째', author: 'fixture2', isDraft: true }],
  sessions: [{ name: project.name, session: { state: 'working', model: 'claude', lastActivity: now - 60000 } }, { name: '둘째', session: null }],
  notes: [{ ...note, preview: '미리 보기\udc00' }, { id: 'n2', title: 'Empty', tags: [], updatedAt: 0 }],
  note,
  'note-create': { id: 'n-new', title: '새 제목' },
  'note-update': { id: 'n1', title: note.title },
  system: { cpu: 12.5, memory: { percent: 55.5, used: 1234567890, total: 8000000000 }, disk: [{ drive: '/', percent: 20, used: 1200000, total: 6000000 }], system: { hostname: 'fixture', platform: 'linux', arch: 'x64', cpuCores: 8, nodeVersion: 'fixture' }, processes: [{ ProcessName: 'cargo', Id: 12, Cpu: 1.5, MemMB: 500 }] },
  briefing: { date: '2026-10-08', totalProjects: 2, attentionCount: 1, cost: { yesterday: 10.12, today: 3.45, weekly: 50 }, items: [{ projectId: 'p1', needsAttention: true, changes: ['CI 실패', '작업 중\ud800'] }, { projectId: 'p2', changes: ['완료'] }] },
  alerts: [{ level: 'warning', message: '예산\ud800' }, { level: 'error', message: '빌드 실패' }],
  activity: [{ timestamp: now - 30000, project: 'p1', summary: '수정' }, { ts: now - 7200000, projectId: 'p2', message: '완료' }, { ts: 0, type: 'test' }],
  workflows: [{ id: 'w1', name: '빌드', description: '설명\ud800', steps: [{ name: 'test' }, { name: 'build' }] }, { id: 'w2', name: 'Empty' }],
  workflow: { id: 'w1', name: '빌드', description: '설명\ud800', steps: [{ name: 'test', model: 'flash', type: 'llm' }, { name: 'build' }] },
  'workflow-runs': [{ id: 'r1', workflowName: '빌드', workflowId: 'w1', status: 'running', startedAt: now - 120000 }, { id: 'r2', workflowId: 'w2', status: 'failed', startedAt: 'invalid', error: 'fixture error' }],
  'workflow-run': { id: 'r1', workflowName: '빌드', workflowId: 'w1', status: 'completed', startedAt: now - 3600000, finishedAt: now - 60000, steps: [{ name: 'test', status: 'completed', duration: 1234 }, { name: 'build', status: 'failed', duration: 0, error: 'fixture error' }] },
  'workflow-start': { id: 'r-new', status: 'running' },
  terminals: { terminals: [{ termId: 't1', projectId: 'p1', command: 'claude' }, { termId: 't2', projectId: 'unknown', command: '' }], projects: [project] },
  'terminal-read': terminalText,
  'terminal-input': terminalText,
  'terminal-create': { id: 't-new', output: terminalText },
  'git-commit': 'fixture commit output\ud800',
  'git-push': 'fixture push output\udc00',
};
const commands = [
  'usage', 'projects', 'project:p1', 'prs', 'prs:p1', 'sessions', 'notes', 'note:n1',
  'note-create:새 제목\n😀\ud800\ncontent', 'note-update:n1\nupdated😀\udc00', 'system', 'briefing', 'alerts', 'activity',
  'workflows', 'workflow:w1', 'workflow-runs', 'workflow-run:r1', 'workflow-start:w1\n{"task":"test😀\\ud800"}',
  'terminals', 'terminal-read:t1', 'terminal-input:t1:printf "a:b"', 'terminal-create:p1:npm test', 'git-commit:p1\nfeat: 검증', 'git-push:p1',
];
for (const argument of commands) {
  const { command, parameter } = parts(argument);
  let snapshot = { [command]: good[command] };
  if (command.startsWith('git-')) snapshot.project = good.project;
  if (command === 'prs' && parameter) snapshot.prs = [good.prs[0]];
  await add(argument, snapshot);
  await add(argument, {});
  const failing = { [command]: { __error: 'fixture service error' } };
  if (command.startsWith('git-')) failing.project = good.project;
  await add(argument, failing);
}

for (const argument of [null, false, 0, '', ' \ufeff\n ', true, 1, [], {}, 'unknown:thing', 'USAGE', ' usage \n ignored', 'project:', 'note:', 'note-create:', 'note-update:', 'workflow:', 'workflow-run:', 'workflow-start:', 'terminal-read:', 'terminal-input:', 'terminal-input:t1', 'terminal-create:', 'terminal-create: :cmd', 'git-commit:', 'git-push:']) await add(argument, good);
for (const command of ['projects', 'prs', 'sessions', 'notes', 'alerts', 'activity', 'workflows', 'workflow-runs']) await add(command, { [command]: [] });
await add('usage', { usage: {} });
await add('project:p1', { project: { project } });
await add('project:p1', { project: { project, session: {}, git: { recentCommits: [{}] }, prs: { prs: [{}] }, cicd: { runs: [{}] } } });
await add('notes', { notes: [{}] });
await add('note:n1', { note: {} });
await add('note-create:タイトル\n\ufeff\n😀\ud800  ', { 'note-create': { id: 'n-new', title: 'タイトル\ud800' } });
await add('note-update: n1 \n\n😀\udc00  ', { 'note-update': { id: 'n1', title: '題名' } });
await add('system', { system: {} });
await add('briefing', { briefing: {} });
await add('workflow:w1', { workflow: {} });
await add('workflow-run:r1', { 'workflow-run': {} });
for (const raw of ['', '{broken', 'null', '[]', 'true', '1', '{"x":"\\ud800"}', '{"__proto__":{"x":1}}']) await add('workflow-start:w1\n' + raw, { 'workflow-start': {} });
for (const argument of ['terminal-input: t1 :   npm test', 'terminal-input::', 'terminal-create:p1', 'terminal-create: p1 : echo a:b ', 'git-commit:p1', 'git-commit:p1\n  \ufeff  ']) await add(argument, good);
for (const command of ['terminal-read', 'terminal-input', 'terminal-create']) {
  const argument = command === 'terminal-input' ? 'terminal-input:t1:cmd' : command === 'terminal-create' ? 'terminal-create:p1:cmd' : 'terminal-read:t1';
  for (const length of [999, 1000, 1001, 1999, 2000, 2001, 2999, 3000, 3001]) {
    const output = 'x'.repeat(length) + '😀\ud800';
    await add(argument, { [command]: command === 'terminal-create' ? { id: 't-new', output } : output });
  }
  await add(argument, { [command]: command === 'terminal-create' ? { id: 't-new', output: '' } : '' });
}
for (const command of ['git-commit', 'git-push']) await add(command + ':p1\n  메시지  ', { project: good.project, [command]: 'a'.repeat(499) + '😀\ud800tail' });

// Text limits retain the displayed total while showing only the first entries.
await add('system', { system: { ...good.system, processes: Array.from({ length: 10 }, (_, i) => ({ ProcessName: 'proc-' + i, Id: i, Cpu: i, MemMB: i * 10 })) } });
await add('activity', { activity: Array.from({ length: 17 }, (_, i) => ({ ts: now - i * 60000, projectId: 'p' + i, type: 'work' })) });
await add('workflow-runs', { 'workflow-runs': Array.from({ length: 17 }, (_, i) => ({ id: 'r' + i, workflowId: 'w' + i, status: 'running', startedAt: now - i * 60000 })) });

for (const time of [0, null, now + 60000, now, now - 59999, now - 60000, now - 3599999, now - 3600000, now - 86399999, now - 86400000, '2026-10-08', '2026-10-08T12:34:00.000Z', '2026-10-08T21:34:00+09:00', 'invalid']) {
  await add('sessions', { sessions: [{ name: 'time', session: { lastActivity: time } }] });
}
for (const value of [0, 1, -1, 999, 1000, 1234567, 1.0625, -1.0625, 2.125, 1.2345, 1e-7, 1e20, 1e21, null]) {
  await add('usage', { usage: { today: { outputTokens: value, inputTokens: value, apiEquivCost: value, models: { sample: { apiCost: value, outputTokens: value } } }, week: { outputTokens: value, apiEquivCost: value } } });
  await add('briefing', { briefing: { date: 'date', totalProjects: 0, attentionCount: 0, cost: { yesterday: value, today: value, weekly: value } } });
}
for (const value of [0, 499, 500, 1500, 2500, 999999, 1000000, 1050000, 1250000, 999999999, 1000000000, 1250000000, -500, null]) await add('system', { system: { cpu: 0, memory: { percent: 0, used: value, total: value } } });
await add('usage', { usage: { today: { outputTokens: '1,000', inputTokens: true, cacheReadTokens: [1, 2], models: {} } } });
await add('alerts', { alerts: [{ level: 'ßıﬃ', message: 'Unicode upper' }, { level: 'warning', message: '\ud800😀\udc00' }] });

export { fixtures };
if (process.argv.includes('--emit')) process.stdout.write(JSON.stringify(fixtures, null, 2) + '\n');
