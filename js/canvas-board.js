import { registerClickActions } from './actions.js';
import { copyText, esc, fetchJson, showToast } from './utils.js';
import { mergeBoardChanges } from './board-merge.js';

const LOCAL_KEY = 'cockpit-canvas-board';
const DIRTY_KEY = 'cockpit-canvas-board-dirty';
const BASE_KEY = 'cockpit-canvas-board-base';
let board = loadLocal();
let syncedBoard = loadBase();
let localDirty = localStorage.getItem(DIRTY_KEY) === '1'
  && Boolean(board.updatedAt || board.notes.some(note => note.content) || board.tasks.length);
let localGeneration = 0;
let apiAvailable = null;
let loading = null;
let noteSaveTimer = null;
let pollTimer = null;
let syncLabel = 'Local';

function emptyBoard() {
  return {
    schemaVersion: 2,
    review: {},
    note: { content: '', updatedAt: 0 },
    notes: [],
    checklists: [],
    tasks: [],
    nextNoteNumber: 1,
    nextChecklistNumber: 1,
    nextTaskNumber: 1,
    revision: 0,
    updatedAt: 0,
  };
}

function normalize(value) {
  const source = value && typeof value === 'object' ? value : emptyBoard();
  const now = Date.now();
  const legacyNote = {
    id: 'N-0001',
    title: 'Memo 1',
    content: String(source.note?.content || '').slice(0, 12_000),
    createdAt: Number(source.note?.updatedAt) || now,
    updatedAt: Number(source.note?.updatedAt) || 0,
  };
  const rawNotes = Array.isArray(source.notes) ? source.notes : [legacyNote];
  const notes = rawNotes
    .filter((item, index, all) => /^N-\d{4,}$/.test(item?.id) && all.findIndex(other => other?.id === item.id) === index)
    .map(item => ({
      id: item.id,
      title: String(item.title || `Memo ${Number(item.id.slice(2))}`).trim().slice(0, 80),
      content: String(item.content || '').slice(0, 12_000),
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || 0,
    }));
  const rawChecklists = Array.isArray(source.checklists)
    ? source.checklists
    : [{ id: 'C-0001', title: 'Checklist 1', createdAt: now, updatedAt: 0 }];
  const checklists = rawChecklists
    .filter((item, index, all) => /^C-\d{4,}$/.test(item?.id) && all.findIndex(other => other?.id === item.id) === index)
    .map(item => ({
      id: item.id,
      title: String(item.title || `Checklist ${Number(item.id.slice(2))}`).trim().slice(0, 80),
      goal: String(item.goal || '').slice(0, 4000),
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || 0,
    }));
  if (!checklists.length && Array.isArray(source.tasks) && source.tasks.some(item => item?.text)) {
    checklists.push({ id: 'C-0001', title: 'Checklist 1', createdAt: now, updatedAt: 0 });
  }
  const checklistIds = new Set(checklists.map(item => item.id));
  const defaultChecklistId = checklists[0]?.id || '';
  const tasks = Array.isArray(source.tasks) ? source.tasks.filter(item => /^T-\d{4,}$/.test(item?.id) && item.text) : [];
  const highest = tasks.reduce((max, item) => Math.max(max, Number(item.id.slice(2)) || 0), 0);
  const highestNote = notes.reduce((max, item) => Math.max(max, Number(item.id.slice(2)) || 0), 0);
  const highestChecklist = checklists.reduce((max, item) => Math.max(max, Number(item.id.slice(2)) || 0), 0);
  const primaryNote = notes[0] || { content: '', updatedAt: 0 };
  return {
    schemaVersion: 2,
    review: source.review || {},
    note: { content: primaryNote.content, updatedAt: primaryNote.updatedAt },
    notes,
    checklists,
    tasks: tasks.map(item => ({
      ...item,
      text: String(item.text).slice(0, 500),
      done: item.done === true,
      kind: item.kind === 'question' ? 'question' : 'task',
      answer: String(item.answer || '').slice(0, 4000),
      checklistId: checklistIds.has(item.checklistId) ? item.checklistId : defaultChecklistId,
    })),
    nextNoteNumber: Math.max(highestNote + 1, Number(source.nextNoteNumber) || 1),
    nextChecklistNumber: Math.max(highestChecklist + 1, Number(source.nextChecklistNumber) || 1),
    nextTaskNumber: Math.max(highest + 1, Number(source.nextTaskNumber) || 1),
    revision: Math.max(0, Number(source.revision) || 0),
    updatedAt: Number(source.updatedAt) || 0,
  };
}

function loadLocal() {
  try { return normalize(JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')); }
  catch { return emptyBoard(); }
}

function saveLocal() {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(board)); } catch { /* storage unavailable */ }
}

function loadBase() {
  try {
    const value = JSON.parse(localStorage.getItem(BASE_KEY) || 'null');
    return value ? normalize(value) : null;
  } catch { return null; }
}

function rememberSynced(value) {
  syncedBoard = normalize(value);
  try { localStorage.setItem(BASE_KEY, JSON.stringify(syncedBoard)); } catch { /* storage unavailable */ }
}

function setLocalDirty(value) {
  localDirty = value;
  try { localStorage.setItem(DIRTY_KEY, value ? '1' : '0'); } catch { /* storage unavailable */ }
}

async function request(path, method = 'GET', body) {
  return fetchJson(path, {
    method,
    timeoutMs: 2500,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function readLegacyBoard() {
  const projects = await fetchJson('/api/projects', { timeoutMs: 2500 });
  const cockpit = projects.find(project => project.id === 'cockpit' || /claude-code-cockpit[\\/]?$/.test(project.path || ''));
  if (!cockpit?.path) return null;
  const file = await fetchJson(`/api/file?path=${encodeURIComponent(`${cockpit.path}/.cockpit-board.json`)}`, { timeoutMs: 2500 });
  return normalize(JSON.parse(file.content));
}

function applyBoard(value, source, force = false) {
  const incoming = normalize(value);
  rememberSynced(incoming);
  if (force || incoming.updatedAt >= board.updatedAt || !board.updatedAt) board = incoming;
  syncLabel = source;
  saveLocal();
  renderCanvasBoard();
}

function markLocalChange() {
  localGeneration++;
  setLocalDirty(true);
}

function continueSync() {
  setTimeout(() => updateCanvasBoard(), 0);
}

export async function updateCanvasBoard() {
  if (loading) return loading;
  loading = (async () => {
    const generation = localGeneration;
    const dirtyAtStart = localDirty;
    const localSnapshot = normalize(board);
    const baseSnapshot = syncedBoard;
    try {
      const rawRemote = await request('/api/board');
      const modernApi = rawRemote?.schemaVersion >= 2 && Array.isArray(rawRemote.notes) && Array.isArray(rawRemote.checklists);
      let remote = normalize(rawRemote);
      apiAvailable = true;
      if (dirtyAtStart) {
        if (!modernApi || (rawRemote.reviewVersion !== 1 && (board.checklists.some(item => item.goal) || board.tasks.some(item => item.kind === 'question')))) {
          apiAvailable = false;
          syncLabel = 'Local · restart to sync';
          renderCanvasBoard();
          return;
        }
        try {
          remote = normalize(await request('/api/board', 'PUT', { board: localSnapshot, revision: localSnapshot.revision, base: baseSnapshot }));
        } catch (error) {
          syncLabel = error.status === 409 ? `Sync conflict · ${error.message}` : '저장 실패 · 재시도 중';
          renderCanvasBoard();
          return;
        }
        if (generation !== localGeneration) {
          try { board = normalize(mergeBoardChanges(localSnapshot, normalize(board), remote)); }
          catch (error) {
            syncLabel = `Sync conflict · ${error.message}`;
            saveLocal();
            renderCanvasBoard();
            return;
          }
          rememberSynced(remote);
          syncLabel = 'Syncing…';
          saveLocal();
          renderCanvasBoard();
          continueSync();
          return;
        }
        setLocalDirty(false);
      } else if (generation !== localGeneration || localDirty) {
        continueSync();
        return;
      }
      applyBoard(remote, 'Synced', true);
    } catch {
      apiAvailable = false;
      try {
        const legacy = await readLegacyBoard();
        if (legacy && !localDirty) applyBoard(legacy, 'File sync');
        else renderCanvasBoard();
      } catch { renderCanvasBoard(); }
    }
  })().finally(() => { loading = null; });
  if (!pollTimer) pollTimer = setInterval(() => { if (document.querySelector('[data-canvas-board-frame]')) updateCanvasBoard(); }, 5000);
  return loading;
}

function findBoardItem(type, boardId) {
  return (type === 'note' ? board.notes : board.checklists).find(item => item.id === boardId);
}

function syncLegacyNote() {
  const primary = board.notes[0] || { content: '', updatedAt: 0 };
  board.note = { content: primary.content, updatedAt: primary.updatedAt };
}

export function ensureCanvasBoardItem(type, boardId) {
  if (!['note', 'checklist'].includes(type)) return null;
  const existing = findBoardItem(type, boardId);
  if (existing) return existing;
  const prefix = type === 'note' ? 'N' : 'C';
  if (!new RegExp(`^${prefix}-\\d{4,}$`).test(boardId)) return null;
  const now = Date.now();
  const number = Number(boardId.slice(2));
  const item = {
    id: boardId,
    title: `${type === 'note' ? 'Memo' : 'Checklist'} ${number}`,
    ...(type === 'note' ? { content: '' } : {}),
    createdAt: now,
    updatedAt: 0,
  };
  (type === 'note' ? board.notes : board.checklists).push(item);
  if (type === 'note') board.nextNoteNumber = Math.max(board.nextNoteNumber, number + 1);
  else board.nextChecklistNumber = Math.max(board.nextChecklistNumber, number + 1);
  syncLegacyNote();
  saveLocal();
  return item;
}

export function createCanvasBoardItem(type) {
  if (!['note', 'checklist'].includes(type)) return null;
  const now = Date.now();
  const nextKey = type === 'note' ? 'nextNoteNumber' : 'nextChecklistNumber';
  const prefix = type === 'note' ? 'N' : 'C';
  const number = board[nextKey]++;
  const item = {
    id: `${prefix}-${String(number).padStart(4, '0')}`,
    title: `${type === 'note' ? 'Memo' : 'Checklist'} ${number}`,
    ...(type === 'note' ? { content: '' } : {}),
    createdAt: now,
    updatedAt: now,
  };
  (type === 'note' ? board.notes : board.checklists).push(item);
  localTouch();
  updateCanvasBoard();
  return item;
}

export function deleteCanvasBoardItem(type, boardId) {
  if (!findBoardItem(type, boardId)) return false;
  if (type === 'note') board.notes = board.notes.filter(item => item.id !== boardId);
  else {
    board.checklists = board.checklists.filter(item => item.id !== boardId);
    board.tasks = board.tasks.filter(task => task.checklistId !== boardId);
  }
  syncLegacyNote();
  localTouch();
  updateCanvasBoard();
  return true;
}

export function createCanvasBoardFrame(type, boardId, frame) {
  if (!['note', 'checklist'].includes(type) || !boardId) return null;
  const itemId = `board:${boardId}`;
  const item = ensureCanvasBoardItem(type, boardId);
  if (!item) return null;
  const label = item.title;
  const icon = type === 'note'
    ? '<path d="M6 3h9l3 3v15H6zM15 3v4h4M9 11h6M9 15h6"/>'
    : '<path d="m5 7 2 2 3-4M12 7h7M5 14l2 2 3-4M12 14h7"/>';
  const body = type === 'note'
    ? `<label class="canvas-sticky-note">
        <textarea data-canvas-note maxlength="12000" placeholder="빠르게 메모하세요…" aria-label="Memo"></textarea>
        <small><span data-canvas-note-state>Saved locally</span><span data-canvas-board-sync>Local</span></small>
      </label>`
    : `<section class="canvas-checklist" aria-label="Checklist">
        <header><span data-canvas-task-count>0 open</span><span data-canvas-board-sync>Local</span></header>
        <label class="canvas-board-field">목표 · 완료 기준
          <textarea data-canvas-goal maxlength="4000" rows="2" placeholder="무엇이 되면 완료인가요?"></textarea>
        </label>
        <details class="canvas-board-review">
          <summary>전체 보드 관리 · <span data-review-state>자동 확인 꺼짐</span></summary>
          <form data-review-form>
            <label>관리 세션 <input name="target" placeholder="ai1" autocomplete="off"></label>
            <label>확인 간격(분) <input name="minutes" type="number" min="1" max="1440" value="5" required></label>
            <button type="submit">설정 저장</button>
            <button type="button" data-review-stop>자동 확인 끄기</button>
          </form>
          <small>모든 체크리스트·목표·질문 답변을 확인합니다. 새 항목도 포함되며, AI 확인 전에는 중복 알림을 보내지 않습니다.</small>
          <p data-review-feedback role="status"></p>
        </details>
        <form data-canvas-task-form>
          <select name="kind" aria-label="항목 종류"><option value="task">할 일</option><option value="question">질문</option></select>
          <input name="task" maxlength="500" autocomplete="off" placeholder="새 태스크…" aria-label="New checklist task">
          <button type="submit" title="Add task" aria-label="Add task">+</button>
        </form>
        <div class="canvas-task-list" data-canvas-task-list><p>태스크 없음</p></div>
      </section>`;
  const article = document.createElement('article');
  article.className = `canvas-board-window canvas-board-${type}`;
  article.dataset.canvasItem = itemId;
  article.dataset.canvasBoardFrame = type;
  article.dataset.canvasBoardId = boardId;
  article.tabIndex = 0;
  article.setAttribute('aria-label', `${label} canvas window`);
  article.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight');
  article.style.cssText = `left:${frame.x}px;top:${frame.y}px;width:${frame.w}px;height:${frame.h}px`;
  article.innerHTML = `<header class="canvas-board-window-head" data-canvas-drag-item="${itemId}">
    <svg class="canvas-board-window-icon" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>
    <span>${esc(label)}</span>
    <span class="canvas-board-type">${esc(boardId)}</span>
    <button type="button" class="canvas-board-window-close" data-action="canvas-board-window-remove" data-boardtype="${type}" data-boardid="${esc(boardId)}" title="Delete ${esc(label)} and its content" aria-label="Delete ${esc(label)} and its content">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
      <span>Delete</span>
    </button>
  </header><div class="canvas-board-window-body">${body}</div>`;
  const resize = document.createElement('span');
  resize.className = 'canvas-frame-resize';
  resize.dataset.canvasResizeItem = itemId;
  resize.setAttribute('aria-hidden', 'true');
  article.appendChild(resize);
  hydrateCanvasBoardFrame(article);
  return article;
}

function hydrateCanvasBoardFrame(root) {
  const type = root.dataset.canvasBoardFrame;
  const boardId = root.dataset.canvasBoardId;
  const item = ensureCanvasBoardItem(type, boardId);
  const textarea = root.querySelector('[data-canvas-note]');
  if (textarea && document.activeElement !== textarea) textarea.value = item?.content || '';
  const goal = root.querySelector('[data-canvas-goal]');
  if (goal && document.activeElement !== goal) goal.value = item?.goal || '';
  const reviewState = root.querySelector('[data-review-state]');
  if (reviewState) {
    const review = board.review || {};
    reviewState.textContent = review.status === 'complete' ? '목표 달성 보고됨' : !review.termId || review.status === 'stopped' ? '자동 확인 꺼짐' : review.pendingSince
      ? 'AI 확인 대기' : `${review.intervalMinutes}분마다 확인${review.lastReviewedAt ? ` · 최근 ${new Date(review.lastReviewedAt).toLocaleTimeString()}` : ''}`;
    const form = root.querySelector('[data-review-form]');
    if (!form.contains(document.activeElement)) {
      form.elements.target.value = review.alias || review.termId || '';
      form.elements.minutes.value = review.intervalMinutes || 5;
    }
  }
  root.querySelectorAll('[data-canvas-board-sync]').forEach(sync => {
    if (sync.textContent !== syncLabel) sync.textContent = syncLabel;
  });
  const checklistTasks = board.tasks.filter(task => task.checklistId === boardId);
  const open = checklistTasks.filter(task => !task.done).length;
  const count = root.querySelector('[data-canvas-task-count]');
  if (count && count.textContent !== `${open} open`) count.textContent = `${open} open`;
  const list = root.querySelector('[data-canvas-task-list]');
  if (list) {
    const ordered = [...checklistTasks].sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt - b.createdAt);
    const html = ordered.map(task => `<div class="canvas-task${task.done ? ' done' : ''}" data-task-id="${esc(task.id)}">
      <button type="button" class="canvas-task-check" data-action="canvas-task-toggle" data-taskid="${esc(task.id)}" aria-pressed="${task.done}" aria-label="${task.done ? 'Reopen' : 'Complete'} ${esc(task.id)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12 4 4 8-9"/></svg>
      </button>
      <button type="button" class="canvas-task-id" data-action="canvas-task-copy" data-taskid="${esc(task.id)}" title="Copy task ID">${esc(task.id)}</button>
      <div class="canvas-task-text">${task.kind === 'question' ? '<strong>질문</strong> ' : ''}${esc(task.text)}
        ${task.kind === 'question' ? `<label class="canvas-board-field">답변
          <textarea data-task-answer="${esc(task.id)}" maxlength="4000" rows="2" placeholder="답변을 남기면 관리 세션이 확인합니다.">${esc(task.answer || '')}</textarea>
        </label>` : ''}
      </div>
      <button type="button" class="canvas-task-delete" data-action="canvas-task-delete" data-taskid="${esc(task.id)}" title="Delete ${esc(task.id)}" aria-label="Delete ${esc(task.id)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
        <span>Delete</span>
      </button>
    </div>`).join('') || '<p>태스크 없음</p>';
    const editingAnswer = document.activeElement?.matches('[data-task-answer]') && list.contains(document.activeElement);
    if (list._cockpitRenderHtml !== html && !editingAnswer) {
      const scrollTop = list.scrollTop;
      list.innerHTML = html;
      list._cockpitRenderHtml = html;
      list.scrollTop = scrollTop;
    }
  }
  setupBoardEvents(root);
}

function renderCanvasBoard() {
  document.querySelectorAll('[data-canvas-board-frame]').forEach(hydrateCanvasBoardFrame);
}

function localTouch() {
  board.updatedAt = Date.now();
  syncLegacyNote();
  markLocalChange();
  saveLocal();
  renderCanvasBoard();
}

async function addTask(text, checklistId, kind = 'task') {
  const clean = text.trim();
  if (!clean || !findBoardItem('checklist', checklistId)) return;
  const now = Date.now();
  board.tasks.push({
    id: `T-${String(board.nextTaskNumber++).padStart(4, '0')}`,
    text: clean,
    done: false,
    kind,
    answer: '',
    checklistId,
    createdAt: now,
    updatedAt: now,
  });
  localTouch();
  updateCanvasBoard();
}

async function toggleTask(id) {
  const task = board.tasks.find(item => item.id === id);
  if (!task) return;
  task.done = !task.done;
  task.updatedAt = Date.now();
  localTouch();
  updateCanvasBoard();
}

async function deleteTask(id) {
  board.tasks = board.tasks.filter(item => item.id !== id);
  localTouch();
  updateCanvasBoard();
}

function confirmDeleteTask(el) {
  const id = el.dataset.taskid;
  if (!board.tasks.some(task => task.id === id) || !window.confirm(`Delete ${id}? This cannot be undone.`)) return;
  const row = el.closest('[data-task-id]');
  const nextId = row?.nextElementSibling?.dataset.taskId || row?.previousElementSibling?.dataset.taskId;
  deleteTask(id);
  requestAnimationFrame(() => {
    const nextRow = [...document.querySelectorAll('[data-task-id]')].find(item => item.dataset.taskId === nextId);
    (nextRow?.querySelector('.canvas-task-delete') || document.querySelector('[data-canvas-task-form] input'))?.focus();
  });
}

function setupBoardEvents(root) {
  if (root.dataset.ready) return;
  root.dataset.ready = '1';
  const type = root.dataset.canvasBoardFrame;
  const boardId = root.dataset.canvasBoardId;
  root.querySelector('[data-canvas-task-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    const input = event.currentTarget.elements.task;
    const text = input.value;
    input.value = '';
    addTask(text, boardId, event.currentTarget.elements.kind.value);
    input.focus();
  });
  root.querySelector('[data-canvas-goal]')?.addEventListener('input', event => {
    const checklist = findBoardItem('checklist', boardId);
    if (!checklist) return;
    checklist.goal = event.target.value;
    checklist.updatedAt = Date.now();
    localTouch();
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(updateCanvasBoard, 450);
  });
  root.querySelector('[data-canvas-task-list]')?.addEventListener('input', event => {
    const id = event.target.dataset.taskAnswer;
    const task = board.tasks.find(item => item.id === id);
    if (!task) return;
    task.answer = event.target.value;
    task.updatedAt = Date.now();
    localTouch();
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(updateCanvasBoard, 450);
  });
  const reviewForm = root.querySelector('[data-review-form]');
  async function saveReview(target) {
    const feedback = root.querySelector('[data-review-feedback]');
    feedback.textContent = '저장 중…';
    try {
      if (target) {
        await updateCanvasBoard();
        if (localDirty || !apiAvailable) throw new Error('보드 동기화 후 다시 시도하세요.');
      }
      const saved = await request('/api/board/review', 'PUT', {
        target, intervalMinutes: target ? Number(reviewForm.elements.minutes.value) : (board.review.intervalMinutes || 5),
      });
      if (!localDirty) applyBoard(saved, 'Synced', true);
      else { board.review = saved.review; saveLocal(); }
      feedback.textContent = target ? '자동 확인을 설정했습니다.' : '자동 확인을 껐습니다.';
    } catch (error) { feedback.textContent = error.message; }
  }
  reviewForm?.addEventListener('submit', event => {
    event.preventDefault();
    saveReview(reviewForm.elements.target.value.trim());
  });
  root.querySelector('[data-review-stop]')?.addEventListener('click', () => saveReview(''));
  root.querySelector('[data-canvas-note]')?.addEventListener('input', event => {
    const content = event.currentTarget.value;
    const now = Date.now();
    const note = findBoardItem(type, boardId) || ensureCanvasBoardItem(type, boardId);
    if (!note) return;
    note.content = content;
    note.updatedAt = now;
    syncLegacyNote();
    board.updatedAt = now;
    markLocalChange();
    saveLocal();
    const state = root.querySelector('[data-canvas-note-state]');
    if (state) state.textContent = 'Saving…';
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(async () => {
      await updateCanvasBoard();
      if (state?.isConnected) state.textContent = apiAvailable ? 'Saved' : 'Saved locally';
    }, 450);
  });
}

registerClickActions({
  'canvas-task-toggle': el => toggleTask(el.dataset.taskid),
  'canvas-task-copy': el => copyText(el.dataset.taskid).then(ok => { if (ok) showToast(`${el.dataset.taskid} copied`); }),
  'canvas-task-delete': confirmDeleteTask,
});
