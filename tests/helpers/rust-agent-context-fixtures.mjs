// Evaluate only the original context functions. All files, branches and service
// data below are supplied from memory; no project files or providers are touched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(new URL('../../lib/agent-orchestrator.js', import.meta.url), 'utf8');
const start = source.indexOf('export function buildProjectContext()');
const end = source.indexOf('function buildConversationHistory(', start);
assert.ok(start >= 0 && end > start, 'original context function boundaries');
const functions = source.slice(start, end).replaceAll('export function ', 'function ');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function originalContext(input) {
  const snapshot = input.snapshot || {};
  const provider = key => own(snapshot, key) || snapshot[key + 'Error'] ? () => {
    if (snapshot[key + 'Error']) throw new Error(key + ' fixture unavailable');
    return snapshot[key];
  } : null;
  const services = {};
  if (own(snapshot, 'notes')) services.listNotes = () => [];
  if (own(snapshot, 'cost') || snapshot.costError) services.poller = { getCached() {
    if (snapshot.costError) throw new Error('cost fixture unavailable');
    return snapshot.cost;
  } };
  if (own(snapshot, 'serviceProjects') || snapshot.serviceProjectsError) services.getProjects = provider('serviceProjects');
  let nextRoot = 0;
  const context = vm.createContext({
    _getProjectsMeta: provider('projects'), _getProjectRoots: provider('roots'),
    _cockpitServices: services, DATA_DIR: '/fixture/data', join,
    getGitBranchSync(root) {
      // Map the synchronous calls back to the supplied root indices. Empty roots
      // do not cause calls and duplicate root strings remain in original order.
      const roots = snapshot.roots || [];
      while (nextRoot < roots.length && roots[nextRoot] !== root) nextRoot++;
      return (snapshot.branches || [])[nextRoot++];
    },
    readdirSync() {
      if (snapshot.notes?.error) throw new Error('notes directory unavailable');
      return snapshot.notes.files.map(record => record.name);
    },
    readFileSync(path) {
      const record = snapshot.notes.files.find(record => join('/fixture/notes', record.name) === path);
      if (!record || !own(record, 'note')) throw new Error('note read failed');
      return JSON.stringify(record.note);
    },
  });
  const api = vm.runInContext(functions + '\n({ project: buildProjectContext, plan: buildPlanTeamContext, dev: buildDevTeamContext, admin: buildAdminTeamContext, marketing: buildMktTeamContext, design: buildDesignTeamContext })', context, { timeout: 1000 });
  try {
    let value;
    if (input.action === 'project') value = api.project();
    else {
      const team = input.profile?.team;
      value = typeof team === 'string' && ['plan', 'dev', 'admin', 'marketing', 'design'].includes(team) ? api[team]() : '';
    }
    return { value };
  } catch (error) {
    return { error: error.message };
  }
}

const cases = [];
const add = (action, snapshot, profile) => cases.push({ action, snapshot, ...(profile === undefined ? {} : { profile }) });
const project = snapshot => add('project', snapshot);
const team = (team, snapshot) => add('team', snapshot, { team });
const projects = Array.from({ length: 12 }, (_, index) => ({ name: 'p' + index, path: '/project/' + index, stack: index % 2 ? 'Rust' : '' }));
const roots = projects.map(project => project.path);

for (const snapshot of [
  {}, { projects: [] }, { projects, roots, branches: roots.map((_, index) => 'branch' + index) },
  { projects: projects.slice(0, 4), roots: ['', '/b', null, '/d'], branches: ['ignored', 'main', 'ignored', ''] },
  { projects: [{ name: '\ud800😀', path: '/p\udc00', stack: ['A', null, 'B'] }], roots: ['/p'], branches: ['b\ud800'] },
  { projects: [{}, { name: null, path: null, stack: false }, { name: [1, null, ['x']], path: true, stack: {} }] },
  { projects: [null] }, { projects: null }, { projects: 'abc' }, { projects: 3 },
  { projects: { length: 1 } }, { projectsError: true },
  { projects: [], rootsError: true }, { projects: projects.slice(0, 1), rootsError: true },
  { projects: projects.slice(0, 1), roots: null },
  { projects: [{ name: { toString: null }, path: '/p' }] },
]) project(snapshot);

for (const id of ['dev', 'marketing', 'design']) {
  for (const snapshot of [
    {}, { projects: [], roots: [] }, { projects, roots },
    { projectsError: true, rootsError: true }, { projects: null, roots: null },
    { projects: [{ name: 'first', path: '/first' }, null, { name: 'unseen' }], roots: ['/first', { toString: null }, '/unseen'] },
    { projects: 'A😀B\ud800C', roots: 'A😀B\ud800C' },
    { projects: { length: 1 }, roots: { length: 1 } },
    { projects: [{ name: '\ud800', stack: ['x'], path: '\udc00' }], roots: ['\ud800', ['a', null], false, 1e21, null, '/sixth'] },
  ]) team(id, snapshot);
}

for (const snapshot of [
  {}, { notes: { files: [] } }, { notes: { error: true } },
  { notes: { files: [{ name: 'ignored.txt' }, { name: 'ignored.JSON' }] } },
  { notes: { files: [{ name: 'valid.json', note: { id: 'N-1', title: '문서', content: '😀\ud800' } }, { name: 'empty.json', note: {} }, { name: 'bad.json' }, { name: 'null.json', note: null }] } },
  { notes: { files: [false, 0, true, 1, '', 'text', [], {}, { id: null, title: 0, content: 0 }, { id: ['a'], title: [], content: [1, null] }, { title: { toString: false } }, { content: { length: '\ud800' } }, { content: 5 }].map((note, index) => ({ name: index + '.json', note })) } },
  { notes: { files: Array.from({ length: 26 }, (_, index) => ({ name: index + (index % 5 ? '.json' : '.txt'), note: { id: index } })) } },
  { notes: { files: [...Array.from({ length: 22 }, (_, index) => ({ name: index + '.json', note: {} })), { name: 1 }] } },
]) team('plan', snapshot);

for (const snapshot of [
  {}, { cost: null }, { cost: {} }, { cost: { today: null } }, { costError: true },
  { serviceProjects: [] }, { serviceProjects: projects }, { serviceProjects: null },
  { serviceProjects: {} }, { serviceProjects: { length: null } }, { serviceProjects: '😀' },
  { serviceProjects: { length: '\ud800' } }, { serviceProjectsError: true },
  { cost: { today: { apiEquivCost: 12.0625, messages: ['a', null], sessions: { x: 1 } } }, serviceProjects: projects },
  { cost: { today: { apiEquivCost: 1, messages: { toString: null } } }, serviceProjects: [] },
]) team('admin', snapshot);

for (const value of [null, false, true, '', '1.5', [], {}, 0, -0, 0.0625, -0.0625, 1.0005, -1.0005, 0.0005, -0.0005, 0.0015, 1.005, 2.675, 1000000000000000128, 1e20, 1e21, -1e21, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MIN_VALUE * 100, 2.2250738585072014e-308]) {
  team('admin', { cost: { today: { apiEquivCost: value, messages: 3, sessions: 2 } } });
}
let seed = 0x51c07;
for (let index = 0; index < 160; index++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const sign = index % 2 ? -1 : 1;
  const value = sign * (seed / 0x100000000) * 10 ** ((index % 36) - 12);
  team('admin', { cost: { today: { apiEquivCost: value } } });
}
for (const profile of [null, false, {}, { team: null }, { team: '' }, { team: 'unknown' }, { team: ['dev'] }]) add('team', { projects, roots }, profile);

// Persisted fixtures use JSON input semantics, including -0 becoming 0.
export const fixtures = cases.map(value => JSON.parse(JSON.stringify(value))).map(input => ({ input, expected: originalContext(input) }));
export function makeFixtures() { return fixtures; }
if (process.argv.includes('--emit') || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(fixtures) + '\n');
}
