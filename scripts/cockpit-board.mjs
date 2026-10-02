#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const baseUrl = (urlIndex >= 0 ? args.splice(urlIndex, 2)[1] : process.env.COCKPIT_URL)
  || `http://127.0.0.1:${process.env.COCKPIT_PORT || 3847}`;
const checklistIndex = args.indexOf('--checklist');
const checklistId = checklistIndex >= 0 ? args.splice(checklistIndex, 2)[1] : undefined;
const toIndex = args.indexOf('--to');
const questionTo = toIndex >= 0 ? args.splice(toIndex, 2)[1] : 'user';

async function request(path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(2500),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

async function backend() {
  let legacyServer = false;
  try {
    const board = await request('/api/board');
    if (args[0] === 'question' && args[1] === 'add' && questionTo === 'supervisor' && !(board.supervisionVersion >= 6)) {
      throw Object.assign(new Error('감독에게 질문하려면 Cockpit 서버를 업데이트하고 다시 시작하세요.'), { status: 409 });
    }
    if (['question', 'review'].includes(args[0]) && board.reviewVersion !== 1) {
      throw Object.assign(new Error('질문·답변 기능을 사용하려면 Cockpit 서버를 업데이트하고 다시 시작하세요.'), { status: 409 });
    }
    return {
      mode: 'api',
      list: () => request('/api/board'),
      note: content => request('/api/board/note', 'PUT', { content }),
      append: content => request('/api/board/note/append', 'POST', { content }),
      add: (text, kind = 'task') => request('/api/board/tasks', 'POST', { text, kind, checklistId, ...(kind === 'question' ? { questionTo } : {}) }),
      review: pendingSince => request('/api/board/review', 'POST', { pendingSince }),
      update: (id, updates) => request(`/api/board/tasks/${encodeURIComponent(id)}`, 'PATCH', updates),
      delete: id => request(`/api/board/tasks/${encodeURIComponent(id)}`, 'DELETE'),
    };
  } catch (error) {
    if (error.status && error.status !== 404) throw error;
    legacyServer = error.status === 404;
  }
  const servicePath = [join(ownRoot, 'lib', 'board-service.js'), join(ownRoot, 'scripts', 'board-service.js')]
    .find(candidate => existsSync(candidate));
  if (!servicePath) throw new Error('Cockpit 보드 저장 모듈을 찾지 못했습니다. 스킬을 다시 설치하세요.');
  const service = await import(`${pathToFileURL(servicePath).href}?cli=${Date.now()}`);
  if (legacyServer) {
    const current = service.getBoard();
    if (!current.revision && !current.updatedAt && !current.note.content && current.tasks.length === 0) {
      try {
        const projects = await request('/api/projects');
        const project = projects.find(item => item.id === 'cockpit' || /claude-code-cockpit[\\/]?$/.test(item.path || ''));
        if (project?.path) {
          const legacyFile = await request(`/api/file?path=${encodeURIComponent(`${project.path}/.cockpit-board.json`)}`);
          service.replaceBoardIfRevision(JSON.parse(legacyFile.content), 0);
        }
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
  }
  return {
    mode: 'file',
    list: () => service.getBoard(),
    note: content => service.updateBoardNote(content),
    append: content => service.appendBoardNote(content),
    add: (text, kind = 'task') => service.addBoardTask(text, checklistId, kind, questionTo),
    review: () => { throw new Error('확인 기록에는 실행 중인 Cockpit 서버가 필요합니다.'); },
    update: (id, updates) => service.updateBoardTask(id, updates),
    delete: id => service.deleteBoardTask(id),
  };
}

function usage() {
  return `Usage:
  cockpit-board list
  cockpit-board note get
  cockpit-board note set <text>
  cockpit-board note append <text>
  cockpit-board task add <text>
  cockpit-board task done <T-ID>
  cockpit-board task reopen <T-ID>
  cockpit-board task edit <T-ID> <text>
  cockpit-board task delete <T-ID>
  cockpit-board question add <text> --checklist <C-ID> [--to user|supervisor]
  cockpit-board question answer <T-ID> <text>
  cockpit-board review <pendingSince>
  task add also accepts --checklist <C-ID>`;
}

async function main() {
  if (!['user', 'supervisor'].includes(questionTo)) throw new Error('--to must be user or supervisor');
  const store = await backend();
  const [group = 'list', action, id, ...rest] = args;
  let result;
  if (group === 'list') result = await store.list();
  else if (group === 'review') result = await store.review(Number(action));
  else if (group === 'question' && action === 'add') result = await store.add([id, ...rest].filter(Boolean).join(' '), 'question');
  else if (group === 'question' && action === 'answer') result = await store.update(id, { answer: rest.join(' ') });
  else if (group === 'note' && action === 'get') result = (await store.list()).note;
  else if (group === 'note' && action === 'set') result = await store.note([id, ...rest].filter(Boolean).join(' '));
  else if (group === 'note' && action === 'append') {
    const extra = [id, ...rest].filter(Boolean).join(' ');
    result = await store.append(extra);
  } else if (group === 'task' && action === 'add') result = await store.add([id, ...rest].filter(Boolean).join(' '));
  else if (group === 'task' && action === 'done') result = await store.update(id, { done: true });
  else if (group === 'task' && action === 'reopen') result = await store.update(id, { done: false });
  else if (group === 'task' && action === 'edit') result = await store.update(id, { text: rest.join(' ') });
  else if (group === 'task' && action === 'delete') result = await store.delete(id);
  else throw new Error(usage());
  if (!result) throw new Error(`대상을 찾지 못했습니다: ${id || ''}`);
  console.log(JSON.stringify({ ok: true, mode: store.mode, result }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message, usage: usage() }, null, 2));
  process.exitCode = 1;
});
