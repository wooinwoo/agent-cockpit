// ─── Notes 탭: 마크다운 노트 편집기 (자동저장 내장) ───
import { app, notify } from './state.js';
import { registerClickActions, registerInputActions } from './actions.js';
import { esc, fetchJson, postJson, showToast, timeAgo, simpleMarkdown } from './utils.js';

const AUTOSAVE_DELAY = 1200;

let _list = [];
let _currentId = null;
let _dirty = false;
let _saveTimer = null;
let _mode = 'edit'; // edit | preview
let _search = '';

function $(id) { return document.getElementById(id); }

function status() { return $('notes-save-status'); }

function setStatus(text, tone = 'idle') {
  const el = status();
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

function nowHm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function loadList() {
  const data = await fetchJson('/api/notes');
  _list = data.notes || [];
  renderSidebar();
}

function renderSidebar() {
  const wrap = $('notes-sidebar-list');
  if (!wrap) return;
  const q = _search.trim().toLowerCase();
  const items = _list.filter(n => !q || (n.title || '').toLowerCase().includes(q) || (n.preview || '').toLowerCase().includes(q));
  wrap.innerHTML = items.length ? items.map(n => `
    <div class="docs-nav-item ${n.id === _currentId ? 'active' : ''}" data-action="open-note" data-id="${esc(n.id)}" role="button" tabindex="0">
      <strong>${esc(n.title || 'Untitled')}</strong>
      <small>${esc(timeAgo(n.updatedAt))}</small>
    </div>`).join('') : '<p class="docs-nav-empty">노트가 없습니다</p>';
}

function renderToc(content) {
  const toc = $('docs-toc');
  if (!toc) return;
  const heads = [];
  content.split('\n').forEach((line, i) => {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) heads.push({ level: m[1].length, text: m[2].trim(), line: i });
  });
  toc.innerHTML = heads.length
    ? `<div class="docs-toc-title">목차</div>` + heads.map(h =>
      `<div class="docs-toc-item lv${h.level}" data-action="toc-jump" data-line="${h.line}" role="button" tabindex="0">${esc(h.text)}</div>`).join('')
    : '';
}

function renderEditor(note) {
  const main = $('notes-editor');
  if (!main) return;
  if (!note) {
    main.innerHTML = `<div class="docs-empty">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-3)" stroke-width="1"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>
      <div class="docs-empty-title">Notes</div>
      <div class="docs-empty-sub">왼쪽에서 노트를 선택하거나 새로 만드세요</div>
    </div>`;
    return;
  }
  main.innerHTML = `
    <header class="notes-head">
      <input type="text" class="notes-title-input" id="notes-title" value="${esc(note.title || '')}" placeholder="제목" maxlength="200" aria-label="노트 제목">
      <span class="notes-save-status" id="notes-save-status" data-tone="idle"></span>
      <div class="notes-tools">
        <button class="btn" type="button" data-action="notes-mode" data-mode="edit">편집</button>
        <button class="btn" type="button" data-action="notes-mode" data-mode="preview">미리보기</button>
        <button class="btn" type="button" data-action="delete-note" data-id="${esc(note.id)}">삭제</button>
      </div>
    </header>
    <div class="notes-body" id="notes-body">
      <textarea class="notes-textarea" id="notes-content" placeholder="마크다운으로 작성하세요…" aria-label="노트 내용">${esc(note.content || '')}</textarea>
      <div class="notes-preview" id="notes-preview" hidden></div>
    </div>`;
  $('notes-content')?.addEventListener('input', () => { _dirty = true; setStatus('수정됨 — 자동저장 대기', 'pending'); scheduleSave(); });
  $('notes-title')?.addEventListener('input', () => { _dirty = true; setStatus('수정됨 — 자동저장 대기', 'pending'); scheduleSave(); renderSidebar(); });
  setMode(_mode, true);
  setStatus('자동저장 켜짐', 'idle');
  renderToc(note.content || '');
}

function setMode(mode, silent = false) {
  _mode = mode === 'preview' ? 'preview' : 'edit';
  const body = $('notes-preview');
  const ta = $('notes-content');
  if (!body || !ta) return;
  if (_mode === 'preview') {
    body.innerHTML = simpleMarkdown(ta.value);
    body.hidden = false;
    ta.hidden = true;
  } else {
    body.hidden = true;
    ta.hidden = false;
    if (!silent) ta.focus();
  }

  function applyModeButtons() {
    document.querySelectorAll('[data-action="notes-mode"]').forEach(btn => {
      btn.classList.toggle('primary', btn.dataset.mode === _mode);
    });
  }
  applyModeButtons();
}

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSave, AUTOSAVE_DELAY);
}

async function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (!_dirty || !_currentId) return;
  const title = $('notes-title')?.value ?? '';
  const content = $('notes-content')?.value ?? '';
  _dirty = false;
  setStatus(`저장 중… ${nowHm()}`, 'saving');
  try {
    const note = await fetchJson(`/api/notes/${_currentId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }) });
    setStatus(`저장됨 ${nowHm()}`, 'saved');
    renderToc(content);
    const item = _list.find(n => n.id === _currentId);
    if (item) { item.title = note.title; item.updatedAt = note.updatedAt; item.preview = content.slice(0, 120); }
    renderSidebar();
  } catch (err) {
    _dirty = true; // 실패 시 더티 유지 — 다음 입력/이동 때 재시도
    setStatus('저장 실패 — 재시도됩니다', 'error');
    showToast(err.message || '노트 저장 실패', 'error');
  }
}

async function openNote(id) {
  await flushSave();
  try {
    const note = await fetchJson(`/api/notes/${id}`);
    _currentId = id;
    _dirty = false;
    renderEditor(note);
    renderSidebar();
    renderToc(note.content || '');
  } catch (err) {
    showToast(err.message || '노트를 열지 못했습니다', 'error');
  }
}

async function createNewNote() {
  try {
    const note = await postJson('/api/notes', { title: '새 노트', content: '' });
    await loadList();
    await openNote(note.id);
    $('notes-title')?.focus();
    $('notes-title')?.select();
  } catch (err) {
    showToast(err.message || '노트 생성 실패', 'error');
  }
}

async function removeNote(button) {
  const id = button.dataset.id;
  const title = _list.find(n => n.id === id)?.title || '이 노트';
  if (!confirm(`"${title}" 노트를 삭제할까요?`)) return;
  try {
    await fetchJson(`/api/notes/${id}`, { method: 'DELETE' });
    if (_currentId === id) { _currentId = null; _dirty = false; renderEditor(null); }
    await loadList();
    showToast('노트 삭제됨', 'success');
  } catch (err) {
    showToast(err.message || '삭제 실패', 'error');
  }
}

function tocJump(el) {
  const line = parseInt(el.dataset.line, 10);
  const ta = $('notes-content');
  if (_mode === 'preview') {
    // 미리보기 모드: 헤딩 위치로 스크롤은 렌더 후 어려우므로 편집 모드로 전환해 이동
    setMode('edit');
  }
  if (!ta || !Number.isFinite(line)) return;
  const pos = ta.value.split('\n').slice(0, line).join('\n').length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 21;
  ta.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

let _inited = false;
export async function initNotes() {
  if (!_inited) {
    _inited = true;
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
    window.addEventListener('beforeunload', () => { if (_dirty) flushSave(); });
  }
  try {
    await loadList();
    if (!_currentId && _list.length) await openNote(_list[0].id);
    else renderEditor(_currentId ? _list.find(n => n.id === _currentId) : null);
  } catch (err) {
    showToast(err.message || '노트를 불러오지 못했습니다', 'error');
  }
}

registerClickActions({
  'create-new-note': createNewNote,
  'open-note': el => openNote(el.dataset.id),
  'delete-note': removeNote,
  'notes-mode': el => setMode(el.dataset.mode),
  'toc-jump': tocJump,
  'open-ai-doc-gen': () => showToast('AI 문서 생성은 에이전트 채팅에서 "노트로 저장해"라고 요청하세요', 'info'),
});

registerInputActions({
  'search-notes': el => { _search = el.value; renderSidebar(); },
});
