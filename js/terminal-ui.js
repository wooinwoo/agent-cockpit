// ─── Terminal UI: context menu, headers, layout rendering, mobile, drag/drop,
//     selection toolbar, quick bar, presets, broadcast, command palette,
//     file drop, event delegation ───
import {
  app, getOrderedTerminalEntries, getOrderedTerminalIds, getTerminalPair, getTerminalPairs, notify,
  pairTerminals, setTerminalGroupLayout, setTerminalOrder, unpairTerminal,
} from './state.js';
import { startArenaPick } from './arena.js';
import { copyText, esc, showToast, escapeHtml } from './utils.js';
import { registerClickActions, registerInputActions } from './actions.js';
import { updateAgentWall, WALL_ID } from './agent-wall.js';
import { terminalGroupLayoutLabel, terminalGroupLayoutOptions, terminalGroupRects } from './terminal-group-layout.js';
import {
  createCanvasBoardFrame, createCanvasBoardItem, deleteCanvasBoardItem,
  ensureCanvasBoardItem, updateCanvasBoard,
} from './canvas-board.js';
import { patchXtermImeComposition } from './xterm-ime-guard.js';

// ─── Imports from terminal core (will be set via init) ───
let _core = null;

const CANVAS_KEY = 'dl-terminal-canvas';
const PAIR_TONE_COUNT = 4;
const canvas = loadCanvasState();
let canvasGesture = null;
let canvasSpaceDown = false;
let initialCanvasFocusPending = true;

function pairToneClass(termId) {
  const index = getTerminalPairs().findIndex(pair => pair.termIds.includes(termId));
  return index < 0 ? '' : ` pair-tone-${index % PAIR_TONE_COUNT}`;
}

function loadCanvasState() {
  try {
    const saved = JSON.parse(localStorage.getItem(CANVAS_KEY) || '{}');
    const rawTools = saved.tools && typeof saved.tools === 'object' ? saved.tools : {};
    const tools = {};
    for (const [savedId, value] of Object.entries(rawTools)) {
      const boardId = savedId === 'note' ? 'N-0001' : savedId === 'checklist' ? 'C-0001' : value?.boardId || savedId;
      const type = value?.type || (boardId.startsWith('N-') ? 'note' : boardId.startsWith('C-') ? 'checklist' : '');
      if (!['note', 'checklist'].includes(type)) continue;
      if (type === 'note' ? !/^N-\d{4,}$/.test(boardId) : !/^C-\d{4,}$/.test(boardId)) continue;
      tools[boardId] = { ...value, type, boardId };
    }
    const activeItem = saved.activeItem === 'board:note' ? 'board:N-0001'
      : saved.activeItem === 'board:checklist' ? 'board:C-0001'
        : typeof saved.activeItem === 'string' ? saved.activeItem : '';
    return {
      enabled: saved.enabled !== false,
      zoom: Math.max(0.3, Math.min(1.5, Number(saved.zoom) || 0.7)),
      panX: Number(saved.panX) || 24,
      panY: Number(saved.panY) || 24,
      frames: saved.frames && typeof saved.frames === 'object' ? saved.frames : {},
      tools,
      toolsInitialized: saved.toolsInitialized === true,
      activeItem,
      boardCollapsed: saved.boardCollapsed === true,
    };
  } catch {
    return { enabled: true, zoom: 0.7, panX: 24, panY: 24, frames: {}, tools: {}, toolsInitialized: false, activeItem: '', boardCollapsed: false };
  }
}

function saveCanvasState() {
  try { localStorage.setItem(CANVAS_KEY, JSON.stringify(canvas)); } catch { /* storage unavailable */ }
}

export function initTermUI(core) {
  _core = core;
}

function forceRestoredTerminalRedraw(termId, term) {
  if (document.hidden || !term.agentCommand || app.ws?.readyState !== 1) return;
  const cols = term.xterm.cols;
  const rows = term.xterm.rows;
  if (!cols || !rows) return;
  const bumpedCols = cols < 1000 ? cols + 1 : cols - 1;
  app.ws.send(JSON.stringify({ type: 'resize', termId, cols: bumpedCols, rows }));
  setTimeout(() => {
    if (app.termMap.get(termId) !== term || app.ws?.readyState !== 1) return;
    app.ws.send(JSON.stringify({ type: 'resize', termId, cols, rows }));
  }, 40);
}

function mountTerminal(termId, term) {
  if (term.opened || !term.element.parentNode) return;
  term.xterm.open(term.element);
  patchXtermImeComposition(term.xterm);
  // WebGL renderer: GPU 글리프 래스터라이즈로 한글 폴백 폰트의 셀 폭 어긋남(글자 겹침/씹힘)과
  // 대량 출력 시 DOM 렌더링 병목을 해결. 다만 GPU 여유가 없는 머신에서 컨텍스트 손실이
  // 반복되며 오히려 전체가 느려지는 사례가 있어 opt-in: localStorage 'dl-term-webgl'='1'일 때만.
  // 캔버스보드(줌 transform)에서는 텍스처가 깨져 항상 DOM 렌더러 유지.
  term.renderer = 'dom';
  if (!canvas.enabled && window.WebglAddon && localStorage.getItem('dl-term-webgl') === '1') {
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        // GPU 절전/드라이버 리셋 등으로 컨텍스트가 죽으면 CPU 렌더러로 전환 —
        // 방치하면 터미널이 검은 화면으로 먹통이 되는 사고를 막는다.
        term.renderer = 'dom';
        try { webgl.dispose(); } catch { /* already disposed */ }
        try { term.xterm.refresh(0, term.xterm.rows - 1); } catch { /* terminal gone */ }
        showToast('터미널 GPU 렌더러가 초기화됨 — CPU 렌더러로 전환했습니다', 'warning', 4000);
      });
      term.xterm.loadAddon(webgl);
      term.renderer = 'webgl';
    } catch { /* no WebGL context — DOM fallback */ }
  }
  try { term.xterm.loadAddon(new ImageAddon.ImageAddon()); } catch { /* addon not available */ }
  term.opened = true;
  guardXtermPaste(term, termId);

  // Fit the final frame before replay. Replaying a TUI at xterm's default 80 columns
  // and fitting afterwards reflows ANSI cell backgrounds into large broken blocks.
  _core.fitTerminal(termId, 0);
  const pending = term.pendingBuffer;
  term.pendingBuffer = null;
  if (!pending) return;
  term._replaying = true;
  term.xterm.write(pending, () => {
    term._replaying = false;
    try {
      term.xterm.scrollToBottom();
      term.xterm.refresh(0, Math.max(0, term.xterm.rows - 1));
    } catch { /* terminal was disposed during replay */ }
    // Raw PTY history can begin mid-TUI update after the server buffer is trimmed.
    // A harmless resize bounce asks live Claude/Codex UIs for a clean full redraw.
    forceRestoredTerminalRedraw(termId, term);
  });
}

// ─── Layout Rendering ───
export function renderLayout() {
  syncCanvasToggle();
  const docked = document.getElementById('agent-wall-stage')?.classList.contains('docked');
  if (isMobile() || docked) { renderMobileLayout(!docked); return; }
  const container = document.getElementById('term-panels');
  for (const [, t] of app.termMap) { if (t.element.parentNode) t.element.parentNode.removeChild(t.element); }
  container.innerHTML = '';
  // The compact session strip is shared by desktop and mobile.
  const mobTabs = document.getElementById('mob-term-tabs');
  const mobActions = document.getElementById('mob-term-actions');
  renderSessionTabs(mobTabs);
  if (mobTabs) mobTabs.style.display = '';
  if (mobActions) mobActions.style.display = 'none';
  if (canvas.enabled) {
    if (app.termMap.size || Object.keys(canvas.tools).length) renderCanvasLayout(container);
    else renderEmptyState(container);
    return;
  }
  const visibleLayout = app.terminalFocusMode && app.activeTermId
    ? { type: 'leaf', termId: app.activeTermId }
    : app.layoutRoot;
  if (!visibleLayout) {
    renderEmptyState(container);
    return;
  }
  renderNode(visibleLayout, container);
  app._headCache.clear();
  updateTermHeaders();
  requestAnimationFrame(() => {
    // 마운트를 80ms 간격으로 분산 — 새로고침 시 7개+ 터미널의 리플레이 버퍼가
    // 같은 프레임에 몰려 저사양 머신을 수십 초 얼리던 것을 방지.
    let index = 0;
    for (const [termId, term] of app.termMap) {
      const delay = index++ * 80;
      if (delay === 0) mountTerminal(termId, term);
      else setTimeout(() => { if (app.termMap.get(termId) === term) mountTerminal(termId, term); }, delay);
    }
    setTimeout(() => _core.fitAllTerminals(), 120);
  });
  _core.saveLayout();
}

function syncCanvasToggle() {
  const button = document.querySelector('[data-action="toggle-canvas-view"]');
  if (!button) return;
  button.classList.toggle('active', canvas.enabled);
  button.setAttribute('aria-pressed', String(canvas.enabled));
  button.title = canvas.enabled ? 'Show canvas overview' : 'Open terminal canvas';
}

function toggleCanvasView() {
  if (isMobile()) return;
  if (!app.termMap.size && !Object.keys(canvas.tools).length) return _core.openNewTermModal();
  if (!app.activeTermId) app.activeTermId = getOrderedTerminalIds()[0];
  if (canvas.enabled) {
    fitCanvas();
    showToast('Canvas overview');
    return;
  }
  const webglCount = [...app.termMap.values()].filter(t => t.renderer === 'webgl').length;
  canvas.enabled = true;
  app.terminalFocusMode = true;
  if (webglCount) {
    // 기존 제약: GPU 렌더러 터미널은 줌 transform 아래에서 텍스처가 깨질 수 있음.
    // 런타임 렌더러 교체는 불가하므로 사용자에게 인지시킨다.
    showToast(`확대/축소 중 GPU 렌더러 터미널 ${webglCount}개가 깨져 보일 수 있음 — 100% 축소 시 회복됩니다`, 'warning', 5000);
  }
  saveCanvasState();
  renderLayout();
  setTimeout(() => { fitCanvas(); _core.fitAllTerminals(); }, 120);
}

function ensureCanvasFrames() {
  let toolsAdded = false;
  const ids = getOrderedTerminalIds();
  const live = new Set(ids);
  for (const id of Object.keys(canvas.frames)) if (!live.has(id)) delete canvas.frames[id];
  const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
  ids.forEach((id, index) => {
    const saved = canvas.frames[id];
    if (saved && [saved.x, saved.y, saved.w, saved.h].every(Number.isFinite)) return;
    canvas.frames[id] = {
      x: 32 + (index % cols) * 712,
      y: 32 + Math.floor(index / cols) * 432,
      w: 680,
      h: 400,
      tab: 'terminal',
    };
  });
  for (const [boardId, frame] of Object.entries(canvas.tools)) {
    if (!['note', 'checklist'].includes(frame?.type) || ![frame?.x, frame?.y, frame?.w, frame?.h].every(Number.isFinite)) {
      delete canvas.tools[boardId];
      continue;
    }
    if (!ensureCanvasBoardItem(frame.type, boardId)) delete canvas.tools[boardId];
  }
  if (!canvas.toolsInitialized) {
    const right = Math.max(32, ...Object.values(canvas.frames).map(frame => frame.x + frame.w + 32));
    canvas.tools['N-0001'] = { type: 'note', boardId: 'N-0001', x: right, y: 32, w: 440, h: 320 };
    canvas.tools['C-0001'] = { type: 'checklist', boardId: 'C-0001', x: right, y: 384, w: 520, h: 460 };
    ensureCanvasBoardItem('note', 'N-0001');
    ensureCanvasBoardItem('checklist', 'C-0001');
    canvas.toolsInitialized = true;
    toolsAdded = true;
  }
  return toolsAdded;
}

function canvasItemEntries() {
  return [
    ...Object.entries(canvas.frames),
    ...Object.entries(canvas.tools).map(([boardId, frame]) => [`board:${boardId}`, frame]),
  ];
}

function getCanvasItem(itemId) {
  return itemId.startsWith('board:') ? canvas.tools[itemId.slice(6)] : canvas.frames[itemId];
}

function terminalTopicHTML(termId, topic, className) {
  const value = typeof topic === 'string' ? topic.trim() : '';
  const hint = value ? `${value} · 더블클릭 또는 Enter로 주제 편집` : '더블클릭 또는 Enter로 작업 주제 추가';
  return `<button type="button" class="${className}${value ? '' : ' empty'}" data-terminal-topic="${esc(termId)}" title="${esc(hint)}" aria-label="${esc(hint)}" aria-keyshortcuts="Enter F2">${esc(value || '주제 추가')}</button>`;
}

function createTerminalTopicButton(termId, topic, className) {
  const holder = document.createElement('div');
  holder.innerHTML = terminalTopicHTML(termId, topic, className);
  return holder.firstElementChild;
}

export function startEditTerminalTopic(termId, topicElement) {
  const term = app.termMap.get(termId);
  if (!term || !topicElement || topicElement.matches('input')) return;
  const className = topicElement.classList.contains('canvas-frame-topic') ? 'canvas-frame-topic' : 'th-topic';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-topic-input';
  input.value = term.topic || '';
  input.placeholder = '예: 로그인';
  input.maxLength = 48;
  input.setAttribute('aria-label', `${term.label} 작업 주제`);
  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    if (commit) term.topic = input.value.trim().replace(/\s+/g, ' ').slice(0, 48);
    input.replaceWith(createTerminalTopicButton(termId, term.topic, className));
    app._headCache.delete(termId);
    updateTermHeaders();
    _core.saveLayout();
    if (commit) showToast(term.topic ? `작업 주제 · ${term.topic}` : '작업 주제 삭제됨');
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('dblclick', event => event.stopPropagation());
  topicElement.replaceWith(input);
  input.focus();
  input.select();
}

function canvasFrameHTML(termId, term, frame) {
  const active = termId === app.activeTermId ? ' active' : '';
  const pair = getTerminalPair(termId);
  const tab = frame.tab === 'context' ? 'context' : 'terminal';
  const state = app.state.projects.get(term.projectId)?.session?.state || 'idle';
  const article = document.createElement('article');
  article.className = `terminal-canvas-frame${active}${canvas.activeItem === termId ? ' selected' : ''}${pair ? ` paired${pairToneClass(termId)}` : ''}`;
  article.dataset.canvasFrame = termId;
  article.dataset.canvasItem = termId;
  if (pair) article.dataset.pairDirection = pair.layout;
  article.tabIndex = 0;
  article.setAttribute('aria-label', `${term.label} terminal frame`);
  article.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight');
  article.title = 'Alt + arrow: move · Alt + Shift + arrow: resize';
  article.style.cssText = `left:${frame.x}px;top:${frame.y}px;width:${frame.w}px;height:${frame.h}px;z-index:${canvas.activeItem === termId ? 4 : active ? 2 : 1}`;
  article.innerHTML = `<header class="canvas-frame-head" data-canvas-drag-item="${esc(termId)}">
    <span class="canvas-frame-signal ${esc(state)}" aria-hidden="true"></span>
    <span class="canvas-frame-name">${esc(term.label)}</span>
    ${term.account ? `<span class="term-account-tag ${esc(term.account.provider)}">${esc(term.account.name)}</span>` : ''}
    ${terminalTopicHTML(termId, term.topic, 'canvas-frame-topic')}
    <span class="canvas-frame-tabs" role="tablist" aria-label="${esc(term.label)} view">
      <button role="tab" aria-selected="${tab === 'terminal'}" class="canvas-frame-tab${tab === 'terminal' ? ' active' : ''}" data-action="canvas-tab" data-termid="${esc(termId)}" data-tab="terminal">Terminal</button>
      <button role="tab" aria-selected="${tab === 'context'}" class="canvas-frame-tab${tab === 'context' ? ' active' : ''}" data-action="canvas-tab" data-termid="${esc(termId)}" data-tab="context">Context</button>
    </span>
    <button class="canvas-frame-focus" data-action="canvas-focus" data-termid="${esc(termId)}" title="Focus terminal" aria-label="Focus ${esc(term.label)} terminal">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>
    </button>
    <button class="canvas-frame-close" data-action="canvas-terminal-close" data-termid="${esc(termId)}" title="Close terminal session" aria-label="Close ${esc(term.label)} terminal session">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
      <span>Close</span>
    </button>
  </header>`;
  const body = document.createElement('div');
  body.className = 'canvas-frame-body';
  if (tab === 'context') {
    body.innerHTML = `<div class="canvas-context" data-canvas-context="${esc(termId)}">
      <div class="canvas-context-status" data-context-status>상태 수집 중</div>
      <section><h3>Goal</h3><p data-context-goal>첫 사용자 지시를 기다리는 중</p></section>
      <section><h3>Now</h3><p data-context-task>현재 작업을 분석하는 중</p></section>
      <footer>Agent hook · live context</footer>
    </div>`;
  } else {
    term.element.style.flex = '1';
    body.appendChild(term.element);
  }
  article.appendChild(body);
  const resize = document.createElement('span');
  resize.className = 'canvas-frame-resize';
  resize.dataset.canvasResizeItem = termId;
  resize.setAttribute('aria-hidden', 'true');
  article.appendChild(resize);
  return article;
}

function setCanvasFrameTabContent(termId, tab) {
  const frameEl = [...document.querySelectorAll('[data-canvas-frame]')]
    .find(element => element.dataset.canvasFrame === termId);
  const body = frameEl?.querySelector('.canvas-frame-body');
  const term = app.termMap.get(termId);
  if (!frameEl || !body || !term) return false;
  frameEl.querySelectorAll('[data-action="canvas-tab"]').forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (tab === 'context') {
    body.innerHTML = `<div class="canvas-context" data-canvas-context="${esc(termId)}">
      <div class="canvas-context-status" data-context-status>상태 수집 중</div>
      <section><h3>Goal</h3><p data-context-goal>첫 사용자 지시를 기다리는 중</p></section>
      <section><h3>Now</h3><p data-context-task>현재 작업을 분석하는 중</p></section>
      <footer>Agent hook · live context</footer>
    </div>`;
    updateAgentWall();
    return true;
  }
  const buffer = term.xterm?.buffer?.active;
  const distanceFromBottom = buffer ? Math.max(0, buffer.baseY - buffer.viewportY) : 0;
  body.replaceChildren(term.element);
  term.element.style.flex = '1';
  requestAnimationFrame(() => _core.fitTerminal(termId, distanceFromBottom));
  return true;
}

function renderCanvasLayout(container) {
  const fresh = !Object.keys(canvas.frames).length;
  const toolsAdded = ensureCanvasFrames();
  const viewport = document.createElement('div');
  viewport.className = 'terminal-canvas';
  const layer = document.createElement('div');
  layer.className = 'terminal-canvas-layer';
  for (const [termId, term] of app.termMap) layer.appendChild(canvasFrameHTML(termId, term, canvas.frames[termId]));
  for (const [boardId, frame] of Object.entries(canvas.tools)) {
    const tool = createCanvasBoardFrame(frame.type, boardId, frame);
    if (!tool) continue;
    tool.classList.toggle('selected', canvas.activeItem === `board:${boardId}`);
    tool.style.zIndex = canvas.activeItem === `board:${boardId}` ? '4' : '1';
    layer.appendChild(tool);
  }
  viewport.appendChild(layer);
  viewport.insertAdjacentHTML('beforeend', `<div class="canvas-side-rail"><aside class="canvas-session-board${canvas.boardCollapsed ? ' collapsed' : ''}" aria-label="Session status">
    <header>
      <span class="canvas-session-board-title">Session status</span>
      <span class="canvas-session-count" data-canvas-session-count>${app.termMap.size}</span>
      <button class="canvas-session-group-edit" data-action="canvas-group-edit" type="button" aria-pressed="false" title="Select several terminals as one group">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8H7a4 4 0 0 0 0 8h2M15 8h2a4 4 0 0 1 0 8h-2M8 12h8"/></svg><span>Group</span>
      </button>
      <button data-action="canvas-board-toggle" aria-expanded="${!canvas.boardCollapsed}" title="${canvas.boardCollapsed ? 'Show session status' : 'Hide session status'}" aria-label="Toggle session status">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>
      </button>
    </header>
    <div class="canvas-session-list" data-canvas-session-list><p>Collecting session status…</p></div>
  </aside></div>`);
  viewport.insertAdjacentHTML('beforeend', `<div class="canvas-toolbar" role="toolbar" aria-label="Canvas zoom">
    <button data-action="canvas-zoom-out" title="Zoom out" aria-label="Zoom out"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>
    <button class="canvas-zoom-value" data-action="canvas-reset-zoom" title="Reset zoom">${Math.round(canvas.zoom * 100)}%</button>
    <button data-action="canvas-zoom-in" title="Zoom in" aria-label="Zoom in"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg></button>
    <span class="canvas-toolbar-rule"></span>
    <button class="canvas-fit" data-action="canvas-fit">Fit</button>
    <button class="canvas-fill" data-action="canvas-fill-active" title="Expand the active terminal from its current position into open space">Fill space</button>
    <span class="canvas-group-controls" data-canvas-group-controls hidden>
      <span class="canvas-group-label">Group</span>
      <button class="canvas-group-layout-trigger" data-action="canvas-group-layout-toggle" aria-haspopup="menu" aria-controls="canvas-group-layout-menu" aria-expanded="false">
        <span data-canvas-group-layout-label>Group layout</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>
      </button>
      <button class="canvas-group-remove" data-action="canvas-group-remove" title="Remove the active terminal from this group">Ungroup</button>
    </span>
    <span class="canvas-toolbar-rule"></span>
    <button class="canvas-tool-add" data-action="canvas-board-window-add" data-boardtype="note" title="Add another memo">+ Memo</button>
    <button class="canvas-tool-add" data-action="canvas-board-window-add" data-boardtype="checklist" title="Add another checklist">+ Checklist</button>
    <span class="canvas-toolbar-rule"></span>
    <button class="canvas-keys" data-action="show-shortcut-help" aria-haspopup="dialog" aria-controls="shortcut-overlay" aria-keyshortcuts="?" title="Terminal and canvas keyboard shortcuts">Keys</button>
  </div>`);
  viewport.insertAdjacentHTML('beforeend', '<div class="canvas-group-layout-menu" id="canvas-group-layout-menu" data-canvas-group-layout-menu role="menu" aria-label="Terminal group layout" hidden></div>');
  container.appendChild(viewport);
  applyCanvasTransform();
  syncCanvasPairUI();
  requestAnimationFrame(() => {
    for (const [termId, term] of app.termMap) {
      mountTerminal(termId, term);
    }
    if (fresh || toolsAdded) fitCanvas();
    if (initialCanvasFocusPending && app.activeTermId) {
      initialCanvasFocusPending = false;
      setTimeout(() => jumpToCanvasFrame(app.activeTermId), 100);
    }
    setTimeout(() => _core.fitAllTerminals(), 100);
  });
  updateAgentWall();
  updateCanvasBoard();
  saveCanvasState();
}

function applyCanvasTransform() {
  const layer = document.querySelector('.terminal-canvas-layer');
  if (layer) layer.style.transform = `translate(${canvas.panX}px, ${canvas.panY}px) scale(${canvas.zoom})`;
  const value = document.querySelector('.canvas-zoom-value');
  if (value) value.textContent = `${Math.round(canvas.zoom * 100)}%`;
}

function setCanvasZoom(next, clientX, clientY) {
  const viewport = document.querySelector('.terminal-canvas');
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  const x = (clientX ?? rect.left + rect.width / 2) - rect.left;
  const y = (clientY ?? rect.top + rect.height / 2) - rect.top;
  const old = canvas.zoom;
  const zoom = Math.max(0.3, Math.min(1.5, next));
  canvas.panX = x - ((x - canvas.panX) / old) * zoom;
  canvas.panY = y - ((y - canvas.panY) / old) * zoom;
  canvas.zoom = zoom;
  applyCanvasTransform();
  saveCanvasState();
}

function fitCanvas() {
  const viewport = document.querySelector('.terminal-canvas');
  const frames = canvasItemEntries().map(([, frame]) => frame);
  if (!viewport || !frames.length) return;
  const rect = viewport.getBoundingClientRect();
  const minX = Math.min(...frames.map(frame => frame.x));
  const minY = Math.min(...frames.map(frame => frame.y));
  const maxX = Math.max(...frames.map(frame => frame.x + frame.w));
  const maxY = Math.max(...frames.map(frame => frame.y + frame.h));
  const zoom = Math.max(0.3, Math.min(1, Math.min((rect.width - 56) / (maxX - minX), (rect.height - 72) / (maxY - minY))));
  canvas.zoom = zoom;
  canvas.panX = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
  canvas.panY = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
  applyCanvasTransform();
  saveCanvasState();
}

function getCanvasUsableBounds(viewport) {
  const viewportRect = viewport.getBoundingClientRect();
  const sideRect = document.querySelector('.canvas-side-rail')?.getBoundingClientRect();
  const toolbarRect = document.querySelector('.canvas-toolbar')?.getBoundingClientRect();
  const margin = 16;
  const gap = 12;
  const sideIsTop = sideRect?.width > viewportRect.width * 0.7;
  return {
    left: margin,
    top: Math.max(margin, sideIsTop ? sideRect.bottom - viewportRect.top + gap : margin),
    right: Math.max(margin + 1, sideRect?.width && !sideIsTop ? sideRect.left - viewportRect.left - gap : viewportRect.width - margin),
    bottom: Math.max(margin + 1, toolbarRect?.height ? toolbarRect.top - viewportRect.top - gap : viewportRect.height - margin),
  };
}

function syncCanvasGroupControl() {
  const controls = document.querySelector('[data-canvas-group-controls]');
  const trigger = controls?.querySelector('[data-action="canvas-group-layout-toggle"]');
  const label = trigger?.querySelector('[data-canvas-group-layout-label]');
  const menu = document.querySelector('[data-canvas-group-layout-menu]');
  const group = getTerminalPair(app.activeTermId);
  if (!controls || !trigger || !label || !menu) return;
  controls.hidden = !group;
  if (!group) {
    closeCanvasGroupLayoutMenu();
    return;
  }
  const options = terminalGroupLayoutOptions(group.termIds.length);
  const key = options.map(option => option.join(':')).join('|');
  if (menu.dataset.optionsKey !== key) {
    menu.innerHTML = options.map(([value, optionLabel]) => `<button type="button" role="menuitemradio" data-action="canvas-group-layout" data-layout="${value}">${optionLabel}</button>`).join('');
    menu.dataset.optionsKey = key;
  }
  label.textContent = terminalGroupLayoutLabel(group);
  menu.querySelectorAll('[data-layout]').forEach(button => {
    const active = button.dataset.layout === group.layout;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

function closeCanvasGroupLayoutMenu(restoreFocus = false) {
  const menu = document.querySelector('[data-canvas-group-layout-menu]');
  const trigger = document.querySelector('[data-action="canvas-group-layout-toggle"]');
  if (menu) menu.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus({ preventScroll: true });
}

function toggleCanvasGroupLayoutMenu() {
  const menu = document.querySelector('[data-canvas-group-layout-menu]');
  const trigger = document.querySelector('[data-action="canvas-group-layout-toggle"]');
  if (!menu || !trigger) return;
  const opening = menu.hidden;
  menu.hidden = !opening;
  trigger.setAttribute('aria-expanded', String(opening));
  if (opening) requestAnimationFrame(() => menu.querySelector('.active')?.focus({ preventScroll: true }));
}

function syncCanvasPairUI() {
  document.querySelectorAll('[data-canvas-frame]').forEach(element => {
    const pair = getTerminalPair(element.dataset.canvasFrame);
    for (let index = 0; index < PAIR_TONE_COUNT; index++) element.classList.remove(`pair-tone-${index}`);
    element.classList.toggle('paired', Boolean(pair));
    if (pair) {
      element.dataset.pairDirection = pair.layout;
      element.classList.add(pairToneClass(element.dataset.canvasFrame).trim());
    }
    else delete element.dataset.pairDirection;
  });
  const editButton = document.querySelector('[data-action="canvas-group-edit"]');
  if (editButton) {
    const group = getTerminalPair(app.pairSourceTermId);
    const editing = Boolean(app.pairSourceTermId);
    editButton.classList.toggle('active', editing);
    editButton.setAttribute('aria-pressed', String(editing));
    const label = editButton.querySelector('span');
    if (label) label.textContent = editing ? `Done · ${group?.termIds.length || 1}` : 'Group';
  }
  syncCanvasGroupControl();
  renderSessionTabs(document.getElementById('mob-term-tabs'));
  updateAgentWall();
  saveCanvasState();
}

function preferredPairDirection() {
  const viewport = document.querySelector('.terminal-canvas');
  if (!viewport) return 'h';
  const bounds = getCanvasUsableBounds(viewport);
  return bounds.right - bounds.left >= (bounds.bottom - bounds.top) * 1.15 ? 'h' : 'v';
}

function completeCanvasPair(firstId, secondId) {
  const sourceGroup = getTerminalPair(firstId);
  if (sourceGroup?.termIds.includes(secondId)) {
    app.pairSourceTermId = '';
    syncCanvasPairUI();
    showToast('Those terminals are already in the same group');
    return false;
  }
  const pair = pairTerminals(firstId, secondId, preferredPairDirection());
  if (!pair) {
    app.pairSourceTermId = '';
    syncCanvasPairUI();
    showToast('Could not create terminal group');
    return false;
  }
  app.pairSourceTermId = firstId;
  syncCanvasPairUI();
  showToast(`Terminal group · ${pair.termIds.length} · choose another terminal or press Esc to finish`);
  return true;
}

function finishCanvasGroupEdit() {
  const sourceId = app.pairSourceTermId;
  if (!sourceId) return false;
  const group = getTerminalPair(sourceId);
  if (group) {
    const ordered = getOrderedTerminalIds();
    const firstIndex = Math.min(...group.termIds.map(id => ordered.indexOf(id)).filter(index => index >= 0));
    const grouped = ordered.filter(id => !group.termIds.includes(id));
    grouped.splice(firstIndex, 0, ...group.termIds);
    setTerminalOrder(grouped);
  }
  app.pairSourceTermId = '';
  syncCanvasPairUI();
  if (group) jumpToCanvasFrame(sourceId);
  showToast(group ? `Group complete · ${group.termIds.length} terminals` : 'Group selection cancelled');
  return true;
}

function toggleCanvasPair(termId) {
  if (!app.termMap.has(termId)) return;
  if (!app.pairSourceTermId) {
    app.pairSourceTermId = termId;
    syncCanvasPairUI();
    showToast(`${getTerminalPair(termId) ? 'Add to group' : 'Group mode'} · choose another terminal or press Alt+number`);
    return;
  }
  if (app.pairSourceTermId === termId) {
    const sourceGroup = getTerminalPair(termId);
    if (!sourceGroup) return finishCanvasGroupEdit();
    const nextSource = sourceGroup.termIds.find(id => id !== termId);
    unpairTerminal(termId);
    app.pairSourceTermId = nextSource || '';
    syncCanvasPairUI();
    showToast('Terminal removed from group');
    return;
  }
  const sourceGroup = getTerminalPair(app.pairSourceTermId);
  if (sourceGroup?.termIds.includes(termId)) {
    unpairTerminal(termId);
    syncCanvasPairUI();
    showToast('Terminal removed from group');
    return;
  }
  completeCanvasPair(app.pairSourceTermId, termId);
}

function toggleCanvasGroupEdit() {
  if (app.pairSourceTermId) return finishCanvasGroupEdit();
  const termId = app.activeTermId || getOrderedTerminalIds()[0];
  if (!termId) return showToast('Open a terminal first');
  toggleCanvasPair(termId);
}

function setCanvasGroupLayout(termId, layout) {
  const next = setTerminalGroupLayout(termId, layout);
  if (!next) return showToast('Group this terminal first');
  syncCanvasPairUI();
  closeCanvasGroupLayoutMenu(true);
  jumpToCanvasFrame(termId);
  showToast(`Group layout · ${terminalGroupLayoutLabel(next)}`);
}

function cycleCanvasGroupLayout(termId) {
  const group = getTerminalPair(termId);
  if (!group) return showToast('Group this terminal first');
  const options = terminalGroupLayoutOptions(group.termIds.length);
  const current = Math.max(0, options.findIndex(([value]) => value === group.layout));
  setCanvasGroupLayout(termId, options[(current + 1) % options.length][0]);
}

function removeCanvasGroupMember(termId) {
  if (!unpairTerminal(termId)) return showToast('This terminal is not grouped');
  app.pairSourceTermId = '';
  syncCanvasPairUI();
  jumpToCanvasFrame(termId);
  showToast('Terminal removed from group');
}

function fillActiveCanvasFrame() {
  const viewport = document.querySelector('.terminal-canvas');
  const termId = app.activeTermId;
  const target = termId && canvas.frames[termId];
  if (!viewport || !target) return;
  const bounds = getCanvasUsableBounds(viewport);
  const usableWidth = bounds.right - bounds.left;
  const usableHeight = bounds.bottom - bounds.top;
  const zoom = canvas.zoom;
  const laneGap = 24 / zoom;
  const term = app.termMap.get(termId);
  const buffer = term?.xterm?.buffer?.active;
  const distanceFromBottom = buffer ? Math.max(0, buffer.baseY - buffer.viewportY) : 0;
  const screenLeft = canvas.panX + target.x * zoom;
  const screenTop = canvas.panY + target.y * zoom;
  const left = Math.max(bounds.left, Math.min(screenLeft, bounds.right - Math.min(usableWidth, 420 * zoom)));
  const top = Math.max(bounds.top, Math.min(screenTop, bounds.bottom - Math.min(usableHeight, 280 * zoom)));

  Object.assign(target, {
    x: (left - canvas.panX) / zoom,
    y: (top - canvas.panY) / zoom,
    w: (bounds.right - left) / zoom,
    h: (bounds.bottom - top) / zoom,
  });

  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const others = canvasItemEntries().filter(([otherId]) => otherId !== termId);
  const moved = others.filter(([, frame]) => overlaps(frame, target)).sort((a, b) => a[1].y - b[1].y);
  const placed = others.filter(([, frame]) => !overlaps(frame, target)).map(([, frame]) => frame);
  const laneX = target.x + target.w + 48 / zoom;
  for (const [, frame] of moved) {
    frame.x = laneX;
    frame.y = Math.max(target.y, frame.y);
    let collision;
    while ((collision = placed.find(other => overlaps(frame, other)))) frame.y = collision.y + collision.h + laneGap;
    placed.push(frame);
  }

  applyCanvasTransform();
  document.querySelectorAll('[data-canvas-item]').forEach(element => {
    const frame = getCanvasItem(element.dataset.canvasItem);
    if (!frame) return;
    element.style.left = `${frame.x}px`;
    element.style.top = `${frame.y}px`;
    element.style.width = `${frame.w}px`;
    element.style.height = `${frame.h}px`;
  });
  saveCanvasState();
  requestAnimationFrame(() => _core.fitTerminal(termId, distanceFromBottom));
  showToast(`Active terminal fit · ${moved.length} collision${moved.length === 1 ? '' : 's'} moved`);
}

function focusCanvasTerminal(termId) {
  if (!app.termMap.has(termId)) return;
  app.activeTermId = termId;
  if (canvas.enabled) {
    jumpToCanvasFrame(termId);
    return;
  }
  canvas.enabled = true;
  app.terminalFocusMode = true;
  saveCanvasState();
  renderLayout();
  setTimeout(() => jumpToCanvasFrame(termId), 140);
}

function setCanvasTab(termId, tab) {
  if (!canvas.frames[termId] || !['terminal', 'context'].includes(tab)) return;
  selectCanvasFrame(termId);
  canvas.frames[termId].tab = tab;
  saveCanvasState();
  setCanvasFrameTabContent(termId, tab);
}

export function remapCanvasIds(idMap) {
  for (const [oldId, newId] of Object.entries(idMap || {})) {
    if (canvas.frames[oldId]) canvas.frames[newId] = canvas.frames[oldId];
    delete canvas.frames[oldId];
  }
  saveCanvasState();
}

export function isCanvasMode() {
  return canvas.enabled && !isMobile();
}

export function routeCanvasTerminalWheel(e, xterm) {
  if (!isCanvasMode()) return false;
  if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
    // 플레인 휠은 무조건 xterm 자체 처리에 맡긴다 (normal=스크롤백, alternate=앱 전달).
    // 예전엔 여기서 수동 xterm.scrollLines()를 불렀지만 이 경로가 실환경에서
    // 죽어 캔버스보드 터미널 스크롤이 안 되는 원인이었다. 캔버스 팬/줌은 바탕 휤·Ctrl+휠 유지.
    return false;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.ctrlKey || e.metaKey) {
    setCanvasZoom(canvas.zoom * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
  } else {
    canvas.panX -= e.deltaY || e.deltaX;
    applyCanvasTransform();
    saveCanvasState();
  }
  return true;
}

function renderSessionTabs(container) {
  if (!container) return;
  const scrollLeft = container.scrollLeft;
  const focusedTermId = document.activeElement?.closest('[data-termid]')?.dataset.termid;
  const structureKey = getOrderedTerminalEntries().map(([id, term]) => {
    const pair = getTerminalPair(id);
    return [id, term.label, pair?.layout || '', pair?.termIds.join(':') || ''].join('|');
  }).join('::');
  let html = '<span class="session-strip-label">Sessions</span>';
  let index = 0;
  for (const [id, t] of getOrderedTerminalEntries()) {
    index++;
    const pair = getTerminalPair(id);
    const groupNames = pair?.termIds.filter(termId => termId !== id).map(termId => app.termMap.get(termId)?.label || 'terminal') || [];
    const active = id === app.activeTermId ? ' active' : '';
    const state = app.state.projects.get(t.projectId)?.session?.state;
    const stateLabel = state === 'busy' ? 'running' : state === 'waiting' ? 'attention' : state === 'idle' ? 'idle' : '';
    const signal = stateLabel
      ? `<span class="mob-tab-signal ${state}" title="${stateLabel}" aria-hidden="true"></span>`
      : '';
    const pairLabel = pair ? `, grouped with ${groupNames.join(', ')}, ${terminalGroupLayoutLabel(pair)}` : '';
    const ariaLabel = `Session ${index}: ${t.label}${stateLabel ? `, ${stateLabel}` : ''}${pairLabel}`;
    const pairMark = pair ? `<span class="mob-tab-pair ${['rows', 'main-top', 'main-bottom'].includes(pair.layout) ? 'vertical' : 'horizontal'}" title="Group of ${pair.termIds.length} · ${esc(terminalGroupLayoutLabel(pair))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8H7a4 4 0 0 0 0 8h2M15 8h2a4 4 0 0 1 0 8h-2M8 12h8"/></svg></span>` : '';
    html += `<button class="mob-tab${active}${pair ? ` paired${pairToneClass(id)}` : ''}" role="tab" aria-label="${esc(ariaLabel)}" aria-selected="${id === app.activeTermId}" data-tid="${id}" data-action="mob-switch" data-termid="${id}">` +
      `<span class="mob-tab-index">${String(index).padStart(2, '0')}</span>` +
      `<span class="mob-tab-name">${esc(t.label)}</span>${pairMark}${signal}</button>`;
  }
  html += `<button class="mob-tab mob-tab-add" data-action="new-term" title="New terminal" aria-label="New terminal">+</button>`;
  if (container._cockpitStructureKey === structureKey) {
    syncSessionTabSelection(container);
    return;
  }
  container.innerHTML = html;
  container._cockpitStructureKey = structureKey;
  container.scrollLeft = scrollLeft;
  if (focusedTermId) container.querySelector(`[data-termid="${CSS.escape(focusedTermId)}"]`)?.focus({ preventScroll: true });
}

function syncSessionTabSelection(container) {
  if (!container) return;
  container.querySelectorAll('[data-termid]').forEach((tab, index) => {
    const active = tab.dataset.termid === app.activeTermId;
    tab.classList.toggle('active', active);
    if (tab.getAttribute('aria-selected') !== String(active)) tab.setAttribute('aria-selected', String(active));
    const term = app.termMap.get(tab.dataset.termid);
    const state = app.state.projects.get(term?.projectId)?.session?.state;
    const stateLabel = state === 'busy' ? 'running' : state === 'waiting' ? 'attention' : state === 'idle' ? 'idle' : '';
    const pair = getTerminalPair(tab.dataset.termid);
    const groupNames = pair?.termIds.filter(termId => termId !== tab.dataset.termid).map(termId => app.termMap.get(termId)?.label || 'terminal') || [];
    const pairLabel = pair ? `, grouped with ${groupNames.join(', ')}, ${terminalGroupLayoutLabel(pair)}` : '';
    const ariaLabel = `Session ${index + 1}: ${term?.label || 'terminal'}${stateLabel ? `, ${stateLabel}` : ''}${pairLabel}`;
    if (tab.getAttribute('aria-label') !== ariaLabel) tab.setAttribute('aria-label', ariaLabel);
    let signal = tab.querySelector('.mob-tab-signal');
    if (['busy', 'waiting', 'idle'].includes(state)) {
      if (!signal) {
        signal = document.createElement('span');
        signal.setAttribute('aria-hidden', 'true');
        tab.appendChild(signal);
      }
      const className = `mob-tab-signal ${state}`;
      const title = stateLabel;
      if (signal.className !== className) signal.className = className;
      if (signal.title !== title) signal.title = title;
    } else signal?.remove();
  });
}

function renderEmptyState(container) {
  const boardActions = isMobile() ? '' : `<button class="btn" data-action="canvas-board-window-add" data-boardtype="note">New memo</button>
        <button class="btn" data-action="canvas-board-window-add" data-boardtype="checklist">New checklist</button>`;
  container.innerHTML = `<div class="term-empty">
      <svg class="term-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 5 5-5 5M14 17h4"/></svg>
      <div class="term-empty-title">Start a workspace terminal</div>
      <div class="term-empty-copy">Open a project session or a clean shell. Canvas keeps every session spatially organized.</div>
      <div class="term-empty-actions">
        <button class="btn primary" data-action="new-term">New project terminal</button>
        <button class="btn" data-action="new-home-term">Open clean shell</button>
        ${boardActions}
      </div>
      <div class="term-empty-hint">Ctrl+T · canvas, search, broadcast, export</div>
    </div>`;
}

// ─── Mobile Layout ───
function renderMobileLayout(showMobileControls = true) {
  const container = document.getElementById('term-panels');
  const mobTabs = document.getElementById('mob-term-tabs');
  const mobActions = document.getElementById('mob-term-actions');

  // Detach all terminal elements
  for (const [, t] of app.termMap) { if (t.element.parentNode) t.element.parentNode.removeChild(t.element); }
  container.innerHTML = '';

  if (app.termMap.size === 0) {
    renderEmptyState(container);
    renderSessionTabs(mobTabs);
    if (mobTabs) mobTabs.style.display = showMobileControls ? '' : 'none';
    if (mobActions) mobActions.style.display = 'none';
    return;
  }

  // Show mobile elements
  if (mobTabs) mobTabs.style.display = showMobileControls ? '' : 'none';
  if (mobActions) mobActions.style.display = showMobileControls ? '' : 'none';

  // Ensure activeTermId is valid
  if (!app.activeTermId || !app.termMap.has(app.activeTermId)) {
    app.activeTermId = getOrderedTerminalIds()[0];
  }

  // Render tab bar
  if (mobTabs && showMobileControls) {
    renderSessionTabs(mobTabs);
    // Auto-scroll to active tab
    const activeTab = mobTabs.querySelector('.mob-tab.active');
    if (activeTab) activeTab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  // Render only the active terminal — chat-view 포함된 split-leaf wrapper 안에
  const activeTermId = app.activeTermId;
  const activeT = app.termMap.get(activeTermId);
  if (activeT) {
    const leaf = document.createElement('div');
    leaf.className = 'split-leaf active mobile-leaf';
    leaf.dataset.termId = app.activeTermId;
    leaf.style.position = 'relative';
    leaf.style.display = 'flex';
    leaf.style.flexDirection = 'column';
    leaf.style.flex = '1';
    const p = app.projectList.find(pp => pp.id === activeT.projectId);
    if (p?.path) leaf.dataset.projectPath = p.path;
    activeT.element.style.flex = '1';
    leaf.appendChild(activeT.element);
    container.appendChild(leaf);
    requestAnimationFrame(() => {
      mountTerminal(activeTermId, activeT);
      setTimeout(() => _core.fitTerminal(activeTermId), 80);
    });
  }
  _core.saveLayout();
}

export function mobileSwitchTerm(termId) {
  if (!app.termMap.has(termId)) return;
  app.activeTermId = termId;
  if (isMobile()) {
    renderMobileLayout();
    return;
  }
  if (canvas.enabled) { focusCanvasTerminal(termId); return; }
  app.terminalFocusMode = true;
  renderLayout();
  const term = app.termMap.get(termId);
  term?.xterm?.focus();
}

function selectCanvasFrame(termId) {
  if (!app.termMap.has(termId)) return;
  app.activeTermId = termId;
  document.querySelectorAll('[data-canvas-frame]').forEach(frame => {
    const active = frame.dataset.canvasFrame === termId;
    frame.classList.toggle('active', active);
  });
  selectCanvasItem(termId);
  syncSessionTabSelection(document.getElementById('mob-term-tabs'));
  syncCanvasGroupControl();
  updateAgentWall();
  _core.saveLayout();
}

function focusCanvasFrameInput(termId) {
  const term = app.termMap.get(termId);
  // Older saved canvas frames have no `tab`; the renderer treats those as terminal.
  if (!term || canvas.frames[termId]?.tab === 'context') return false;
  try {
    term.xterm.focus();
    return true;
  } catch {
    return false;
  }
}

function selectCanvasItem(itemId) {
  if (!getCanvasItem(itemId)) return;
  canvas.activeItem = itemId;
  document.querySelectorAll('[data-canvas-item]').forEach(element => {
    const selected = element.dataset.canvasItem === itemId;
    element.classList.toggle('selected', selected);
    element.style.zIndex = selected ? '4' : element.classList.contains('active') ? '2' : '1';
  });
  saveCanvasState();
}

function startCanvasGesture(e) {
  if (!canvas.enabled || isMobile() || !e.target.closest('.terminal-canvas')) return;
  if (e.target.closest('[data-canvas-group-layout-menu]')) return;
  const overCanvasItem = e.target.closest('[data-canvas-item], .canvas-side-rail, .canvas-toolbar');
  const horizontalPan = e.shiftKey && e.button === 0 && !overCanvasItem;
  const blankPan = e.button === 0 && !overCanvasItem;
  const pan = e.button === 1 || (canvasSpaceDown && e.button === 0) || horizontalPan || blankPan;
  if (pan) {
    e.preventDefault();
    e.stopPropagation();
    canvasGesture = { type: 'pan', started: false, horizontal: horizontalPan, startX: e.clientX, startY: e.clientY, panX: canvas.panX, panY: canvas.panY };
    return;
  }
  const frameEl = e.target.closest('[data-canvas-item]');
  if (frameEl && e.button === 0) {
    if (frameEl.dataset.canvasFrame) selectCanvasFrame(frameEl.dataset.canvasFrame);
    else selectCanvasItem(frameEl.dataset.canvasItem);
  }
  const resize = e.target.closest('[data-canvas-resize-item]');
  if (resize && e.button === 0) {
    e.preventDefault();
    const itemId = resize.dataset.canvasResizeItem;
    const frame = getCanvasItem(itemId);
    const term = app.termMap.get(itemId);
    const buffer = term?.xterm?.buffer?.active;
    const distanceFromBottom = buffer ? Math.max(0, buffer.baseY - buffer.viewportY) : 0;
    const boardType = itemId.startsWith('board:') ? frame.type : '';
    canvasGesture = {
      type: 'resize', started: false, itemId, frameEl, startX: e.clientX, startY: e.clientY,
      w: frame.w, h: frame.h, minW: boardType === 'note' ? 320 : boardType === 'checklist' ? 380 : 420,
      minH: boardType === 'note' ? 220 : 280, distanceFromBottom,
    };
    return;
  }
  const head = e.target.closest('[data-canvas-drag-item]');
  if (head && e.button === 0 && !e.target.closest('button, input, textarea, select, [contenteditable="true"]')) {
    e.preventDefault();
    const itemId = head.dataset.canvasDragItem;
    const group = app.termMap.has(itemId) ? getTerminalPair(itemId) : null;
    const moveItems = (group?.termIds || [itemId]).map(id => {
      const frame = getCanvasItem(id);
      const element = [...document.querySelectorAll('[data-canvas-item]')]
        .find(item => item.dataset.canvasItem === id);
      return frame && element ? { frame, element, x: frame.x, y: frame.y } : null;
    }).filter(Boolean);
    try { head.setPointerCapture(e.pointerId); } catch { /* synthetic pointer or unsupported capture */ }
    canvasGesture = {
      type: 'move', started: false, itemId, frameEl, moveItems, captureEl: head, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
    };
  }
}

function moveCanvasGesture(e) {
  if (!canvasGesture) return;
  const screenDx = e.clientX - canvasGesture.startX;
  const screenDy = e.clientY - canvasGesture.startY;
  if (!canvasGesture.started) {
    if (Math.hypot(screenDx, screenDy) < 5) return;
    canvasGesture.started = true;
    const activeClass = { pan: 'canvas-panning', move: 'canvas-moving', resize: 'canvas-resizing' }[canvasGesture.type];
    document.body.classList.add(activeClass);
  }
  e.preventDefault();
  const dx = screenDx / (canvasGesture.type === 'pan' ? 1 : canvas.zoom);
  const dy = screenDy / (canvasGesture.type === 'pan' ? 1 : canvas.zoom);
  if (canvasGesture.type === 'pan') {
    canvas.panX = canvasGesture.panX + dx;
    canvas.panY = canvasGesture.horizontal ? canvasGesture.panY : canvasGesture.panY + dy;
    applyCanvasTransform();
    return;
  }
  const frame = getCanvasItem(canvasGesture.itemId);
  if (!frame) return;
  if (canvasGesture.type === 'move') {
    for (const item of canvasGesture.moveItems) {
      item.frame.x = item.x + dx;
      item.frame.y = item.y + dy;
      item.element.style.left = `${item.frame.x}px`;
      item.element.style.top = `${item.frame.y}px`;
    }
  } else {
    frame.w = Math.max(canvasGesture.minW, canvasGesture.w + dx);
    frame.h = Math.max(canvasGesture.minH, canvasGesture.h + dy);
    canvasGesture.frameEl.style.width = `${frame.w}px`;
    canvasGesture.frameEl.style.height = `${frame.h}px`;
  }
}

function endCanvasGesture() {
  if (!canvasGesture) return;
  const finished = canvasGesture;
  canvasGesture = null;
  try {
    if (finished.captureEl?.hasPointerCapture?.(finished.pointerId)) finished.captureEl.releasePointerCapture(finished.pointerId);
  } catch { /* pointer capture already ended */ }
  document.body.classList.remove('canvas-panning', 'canvas-moving', 'canvas-resizing');
  if (!finished.started) return;
  saveCanvasState();
  if (finished.type === 'resize' && app.termMap.has(finished.itemId)) _core.fitTerminal(finished.itemId, finished.distanceFromBottom);
}

function handleCanvasWheel(e) {
  if (!canvas.enabled || !e.target.closest('.terminal-canvas')) return;
  if (e.target.closest('[data-canvas-group-layout-menu]')) return;
  if (e.target.closest('.xterm, .xterm-wrap') && !e.shiftKey && !e.ctrlKey && !e.metaKey) return;
  if (e.target.closest('.canvas-context') && !e.ctrlKey && !e.metaKey) return;
  if (e.target.closest('.canvas-session-list') && !e.ctrlKey && !e.metaKey && !e.shiftKey) return;
  if (e.target.closest('.canvas-board-window') && !e.ctrlKey && !e.metaKey && !e.shiftKey) return;
  if (e.target.closest('.canvas-side-rail') && !e.ctrlKey && !e.metaKey && !e.shiftKey) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    setCanvasZoom(canvas.zoom * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
  } else if (e.shiftKey) {
    canvas.panX -= e.deltaY || e.deltaX;
    applyCanvasTransform();
    saveCanvasState();
  } else {
    canvas.panX -= e.deltaX;
    canvas.panY -= e.deltaY;
    applyCanvasTransform();
    saveCanvasState();
  }
}

function fitCanvasFocusGroupAt100(termId, pair, bounds) {
  const termIds = pair?.termIds || [termId];
  const frames = termIds.map(id => canvas.frames[id]);
  if (frames.some(frame => !frame)) return null;
  const scrollDistances = new Map(termIds.map(id => {
    const buffer = app.termMap.get(id)?.xterm?.buffer?.active;
    return [id, buffer ? Math.max(0, buffer.baseY - buffer.viewportY) : 0];
  }));
  const usableWidth = bounds.right - bounds.left;
  const usableHeight = bounds.bottom - bounds.top;
  const gap = 16;
  const groupWidth = usableWidth;
  const groupHeight = usableHeight;
  const rects = terminalGroupRects(termIds.length, pair?.layout || 'cols', groupWidth, groupHeight, gap);
  let originX = Math.min(...frames.map(frame => frame.x));
  let originY = Math.min(...frames.map(frame => frame.y));
  const others = canvasItemEntries().filter(([id]) => !termIds.includes(id));
  const overlaps = (frame, group) => frame.x < group.x + group.w && frame.x + frame.w > group.x
    && frame.y < group.y + group.h && frame.y + frame.h > group.y;
  if (others.some(([, frame]) => overlaps(frame, { x: originX, y: originY, w: groupWidth, h: groupHeight }))) {
    originX = Math.max(32, ...others.map(([, frame]) => frame.x + frame.w + 48));
    originY = 32;
  }
  frames.forEach((frame, index) => Object.assign(frame, {
    x: originX + rects[index].x,
    y: originY + rects[index].y,
    w: rects[index].w,
    h: rects[index].h,
  }));
  canvas.zoom = 1;
  canvas.panX = (bounds.left + bounds.right) / 2 - (originX + groupWidth / 2);
  canvas.panY = (bounds.top + bounds.bottom) / 2 - (originY + groupHeight / 2);
  document.querySelectorAll('[data-canvas-item]').forEach(element => {
    const frame = getCanvasItem(element.dataset.canvasItem);
    if (!frame) return;
    element.style.left = `${frame.x}px`;
    element.style.top = `${frame.y}px`;
    element.style.width = `${frame.w}px`;
    element.style.height = `${frame.h}px`;
  });
  applyCanvasTransform();
  saveCanvasState();
  requestAnimationFrame(() => termIds.forEach(id => _core.fitTerminal(id, scrollDistances.get(id))));
  return frames;
}

function jumpToCanvasFrame(termId) {
  const viewport = document.querySelector('.terminal-canvas');
  const pair = getTerminalPair(termId);
  const termIds = pair?.termIds || [termId];
  if (!viewport || termIds.some(id => !canvas.frames[id]) || !app.termMap.has(termId)) return;
  selectCanvasFrame(termId);
  const switchedTabs = termIds.filter(id => canvas.frames[id].tab !== 'terminal');
  for (const id of switchedTabs) {
    canvas.frames[id].tab = 'terminal';
    setCanvasFrameTabContent(id, 'terminal');
  }
  // Keyboard/session-board switches must hand input to xterm synchronously. The
  // delayed pass below is still needed after fitting, but is too late for fast typists.
  focusCanvasFrameInput(termId);
  const revealPrompt = () => {
    const currentViewport = document.querySelector('.terminal-canvas');
    const term = app.termMap.get(termId);
    if (!currentViewport || !term) return;
    const bounds = getCanvasUsableBounds(currentViewport);
    if (!fitCanvasFocusGroupAt100(termId, pair, bounds)) return;
    const scrollPromptIntoView = () => {
      term.xterm.scrollToBottom();
      const terminalViewport = term.element.querySelector('.xterm-viewport');
      if (terminalViewport) terminalViewport.scrollTop = terminalViewport.scrollHeight;
    };
    scrollPromptIntoView();
    focusCanvasFrameInput(termId);
    requestAnimationFrame(scrollPromptIntoView);
    setTimeout(scrollPromptIntoView, 180);
  };
  setTimeout(revealPrompt, switchedTabs.length ? 140 : 0);
}

function toggleCanvasBoard(el) {
  canvas.boardCollapsed = !canvas.boardCollapsed;
  const board = el.closest('.canvas-session-board');
  board?.classList.toggle('collapsed', canvas.boardCollapsed);
  el.setAttribute('aria-expanded', String(!canvas.boardCollapsed));
  el.title = canvas.boardCollapsed ? 'Show session status' : 'Hide session status';
  saveCanvasState();
}

function syncCanvasToolButtons() {
  document.querySelectorAll('[data-action="canvas-board-window-add"]').forEach(button => {
    const label = button.dataset.boardtype === 'note' ? 'memo' : 'checklist';
    const count = Object.values(canvas.tools).filter(frame => frame.type === button.dataset.boardtype).length;
    button.classList.remove('active');
    button.title = `Add another ${label} · ${count} open`;
  });
}

function addCanvasBoardWindow(type) {
  if (!['note', 'checklist'].includes(type)) return;
  const item = createCanvasBoardItem(type);
  if (!item) return;
  const boardId = item.id;
  const itemId = `board:${boardId}`;
  const sameTypeCount = Object.values(canvas.tools).filter(frame => frame.type === type).length;
  const cascade = (sameTypeCount % 7) * 28;
  const viewport = document.querySelector('.terminal-canvas');
  const layer = viewport?.querySelector('.terminal-canvas-layer');
  if (!viewport || !layer) {
    canvas.enabled = true;
    canvas.toolsInitialized = true;
    canvas.tools[boardId] = {
      type, boardId, x: 32 + cascade, y: 32 + cascade,
      ...(type === 'note' ? { w: 440, h: 320 } : { w: 520, h: 460 }),
    };
    canvas.activeItem = itemId;
    saveCanvasState();
    renderLayout();
    requestAnimationFrame(() => document.querySelector(`[data-canvas-board-id="${boardId}"]`)?.focus());
    return;
  }
  const bounds = getCanvasUsableBounds(viewport);
  const size = type === 'note' ? { w: 440, h: 320 } : { w: 520, h: 460 };
  const centerX = ((bounds.left + bounds.right) / 2 - canvas.panX) / canvas.zoom;
  const centerY = ((bounds.top + bounds.bottom) / 2 - canvas.panY) / canvas.zoom;
  const frame = {
    type,
    boardId,
    x: centerX - size.w / 2 + cascade,
    y: centerY - size.h / 2 + cascade,
    ...size,
  };
  canvas.tools[boardId] = frame;
  const element = createCanvasBoardFrame(type, boardId, frame);
  layer.appendChild(element);
  selectCanvasItem(itemId);
  syncCanvasToolButtons();
  updateCanvasBoard();
  showToast(`${type === 'note' ? 'Memo' : 'Checklist'} added to canvas`);
}

function removeCanvasBoardWindow(el) {
  const type = el.dataset.boardtype;
  const boardId = el.dataset.boardid;
  if (!canvas.tools[boardId]) return;
  const label = type === 'note' ? 'Memo' : 'Checklist';
  const suffix = type === 'checklist' ? ' and all of its tasks' : '';
  if (!window.confirm(`Delete ${label} ${boardId}${suffix}? This cannot be undone.`)) return;
  const addButton = document.querySelector(`[data-action="canvas-board-window-add"][data-boardtype="${type}"]`);
  const root = el.closest('[data-canvas-board-frame]');
  delete canvas.tools[boardId];
  root?.remove();
  deleteCanvasBoardItem(type, boardId);
  if (canvas.activeItem === `board:${boardId}`) canvas.activeItem = app.activeTermId || '';
  selectCanvasItem(canvas.activeItem);
  syncCanvasToolButtons();
  saveCanvasState();
  requestAnimationFrame(() => addButton?.focus());
  showToast(`${label} ${boardId} deleted`);
}

export function requestCloseTerminal(termId) {
  const term = app.termMap.get(termId);
  if (!term || !window.confirm(`Close ${term.label} terminal session? Running work in this terminal will stop.`)) return false;
  _core.closeTerminal(termId);
  requestAnimationFrame(() => {
    const activeFrame = [...document.querySelectorAll('[data-canvas-frame]')]
      .find(frame => frame.dataset.canvasFrame === app.activeTermId);
    (activeFrame || document.querySelector('[data-canvas-board-frame]') || document.querySelector('[data-action="new-term"]'))?.focus();
  });
  return true;
}

function closeCanvasTerminal(el) {
  requestCloseTerminal(el.dataset.termid);
}

let sessionOrderDragId = '';

function refreshSessionOrderUI(focusId = '') {
  renderSessionTabs(document.getElementById('mob-term-tabs'));
  const list = document.querySelector('[data-canvas-session-list]');
  if (focusId && list) {
    list.dataset.orderFocusId = focusId;
    list.dataset.orderFocusUntil = String(Date.now() + 800);
    setTimeout(() => {
      if (list.dataset.orderFocusId !== focusId || Number(list.dataset.orderFocusUntil) > Date.now()) return;
      delete list.dataset.orderFocusId;
      delete list.dataset.orderFocusUntil;
    }, 850);
  }
  updateAgentWall();
  if (!focusId) return;
  requestAnimationFrame(() => {
    const handle = [...document.querySelectorAll('[data-session-order-id]')]
      .find(item => item.dataset.sessionOrderId === focusId);
    handle?.focus();
  });
}

function reorderCanvasSession(sourceId, targetId, after = false) {
  if (!sourceId || !targetId || sourceId === targetId) return false;
  const ordered = getOrderedTerminalIds();
  const movingIds = getTerminalPair(sourceId)?.termIds || [sourceId];
  if (movingIds.includes(targetId)) return false;
  const targetIds = getTerminalPair(targetId)?.termIds || [targetId];
  const ids = ordered.filter(id => !movingIds.includes(id));
  const targetIndexes = targetIds.map(id => ids.indexOf(id)).filter(index => index >= 0);
  if (!targetIndexes.length) return false;
  const targetIndex = after ? Math.max(...targetIndexes) + 1 : Math.min(...targetIndexes);
  if (targetIndex < 0) return false;
  ids.splice(targetIndex, 0, ...movingIds);
  setTerminalOrder(ids);
  refreshSessionOrderUI(sourceId);
  showToast('Session order updated');
  return true;
}

function clearSessionOrderDrag() {
  sessionOrderDragId = '';
  document.querySelectorAll('.canvas-session-row.dragging, .canvas-session-row.drop-before, .canvas-session-row.drop-after')
    .forEach(row => row.classList.remove('dragging', 'drop-before', 'drop-after'));
}

function startSessionOrderDrag(e) {
  const handle = e.target.closest('[data-session-order-id]');
  if (!handle) return;
  sessionOrderDragId = handle.dataset.sessionOrderId;
  const movingIds = getTerminalPair(sessionOrderDragId)?.termIds || [sessionOrderDragId];
  document.querySelectorAll('[data-session-order-row]').forEach(row => {
    if (movingIds.includes(row.dataset.sessionOrderRow)) row.classList.add('dragging');
  });
  e.dataTransfer?.setData('text/plain', sessionOrderDragId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function overSessionOrderDrag(e) {
  const row = e.target.closest('[data-session-order-row]');
  const movingIds = getTerminalPair(sessionOrderDragId)?.termIds || [sessionOrderDragId];
  if (!sessionOrderDragId || !row || movingIds.includes(row.dataset.sessionOrderRow)) return;
  e.preventDefault();
  document.querySelectorAll('.canvas-session-row.drop-before, .canvas-session-row.drop-after')
    .forEach(item => item.classList.remove('drop-before', 'drop-after'));
  row.classList.add(e.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2 ? 'drop-after' : 'drop-before');
}

function dropSessionOrder(e) {
  const row = e.target.closest('[data-session-order-row]');
  if (!sessionOrderDragId || !row) return clearSessionOrderDrag();
  e.preventDefault();
  const after = row.classList.contains('drop-after');
  const sourceId = sessionOrderDragId;
  const targetId = row.dataset.sessionOrderRow;
  clearSessionOrderDrag();
  reorderCanvasSession(sourceId, targetId, after);
}

function handleSessionOrderKey(e) {
  const handle = e.target.closest('[data-session-order-id]');
  if (!handle || !e.altKey || e.ctrlKey || e.metaKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const ids = getOrderedTerminalIds();
  const termId = handle.dataset.sessionOrderId;
  const movingIds = getTerminalPair(termId)?.termIds || [termId];
  const indexes = movingIds.map(id => ids.indexOf(id)).filter(index => index >= 0);
  const targetIndex = e.key === 'ArrowUp' ? Math.min(...indexes) - 1 : Math.max(...indexes) + 1;
  if (targetIndex < 0 || targetIndex >= ids.length) return;
  e.preventDefault();
  reorderCanvasSession(termId, ids[targetIndex], e.key === 'ArrowDown');
}

export function getCanvasSessionShortcutTermId(e) {
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return false;
  if (isMobile() || !document.getElementById('terminal-view')?.classList.contains('active')) return false;
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const ids = getOrderedTerminalIds();
  if (/^Digit[1-9]$/.test(e.code)) return ids[Number(e.code.slice(-1)) - 1] || false;
  if (e.code !== 'KeyQ' && e.code !== 'KeyW') return false;
  const current = Math.max(0, ids.indexOf(app.activeTermId));
  const direction = e.code === 'KeyQ' ? -1 : 1;
  return ids[(current + direction + ids.length) % ids.length] || false;
}

export function isCanvasPairShortcut(e) {
  return !e.isComposing && e.key !== 'Process' && e.keyCode !== 229
    && !isMobile()
    && document.getElementById('terminal-view')?.classList.contains('active')
    && e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyG';
}

function handleCanvasPairShortcut(e) {
  if (!isCanvasPairShortcut(e) || !app.activeTermId) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey) cycleCanvasGroupLayout(app.activeTermId);
  else toggleCanvasPair(app.activeTermId);
  return true;
}

function handleCanvasSessionShortcut(e) {
  const termId = getCanvasSessionShortcutTermId(e);
  if (!termId) return false;
  e.preventDefault();
  e.stopPropagation();
  if (app.pairSourceTermId && /^Digit[1-9]$/.test(e.code)) {
    if (termId === app.pairSourceTermId) {
      showToast('Choose a different terminal for the pair');
      return true;
    }
    completeCanvasPair(app.pairSourceTermId, termId);
    return true;
  }
  focusCanvasTerminal(termId);
  return true;
}

function handleCanvasFrameKey(e) {
  if (!canvas.enabled || !e.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return false;
  const frameEl = e.target.closest('[data-canvas-item]');
  if (e.target !== frameEl) return false;
  const itemId = frameEl?.dataset.canvasItem;
  const frame = itemId && getCanvasItem(itemId);
  if (!frame) return false;
  e.preventDefault();
  if (app.termMap.has(itemId)) selectCanvasFrame(itemId);
  else selectCanvasItem(itemId);
  const step = 24 / canvas.zoom;
  const x = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
  const y = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
  if (e.shiftKey) {
    const type = itemId.startsWith('board:') ? frame.type : '';
    frame.w = Math.max(type === 'note' ? 320 : type === 'checklist' ? 380 : 420, frame.w + x);
    frame.h = Math.max(type === 'note' ? 220 : 280, frame.h + y);
    frameEl.style.width = `${frame.w}px`;
    frameEl.style.height = `${frame.h}px`;
    if (app.termMap.has(itemId)) _core.fitTerminal(itemId);
  } else {
    frame.x += x;
    frame.y += y;
    frameEl.style.left = `${frame.x}px`;
    frameEl.style.top = `${frame.y}px`;
  }
  saveCanvasState();
  return true;
}

export function mobileCloseTerm(termId) {
  requestCloseTerminal(termId);
}

// xterm 의 helper textarea 가 native paste 받는 경로 차단 (우클릭 붙여넣기 등)
// — 이미지면 자동 업로드 + path 텍스트, 텍스트 binary 면 차단
// 워크트리 path 에 새 터미널 — 같은 project, cwd 는 워크트리
function openTerminalAtWorktree(projectId, wtPath) {
  if (app.ws?.readyState !== 1) return;
  // cockpit 의 새 터미널 생성 — cwd 지정 (server 가 project path 내부 검증함)
  // 워크트리가 project path 안이면 cwd 그대로 전송. 밖이면 일반 cwd 후 cd 명령.
  const proj = app.projectList.find(p => p.id === projectId);
  const projPath = (proj?.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const wtNorm = wtPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  // boundary 정확히 — 같거나, project path + '/' 로 시작
  const isInside = projPath && (wtNorm === projPath || wtNorm.startsWith(projPath + '/'));
  const cols = 120, rows = 30;
  if (isInside) {
    // 직접 cwd 로 생성
    app.ws.send(JSON.stringify({ type: 'create', projectId, cwd: wtPath, cols, rows }));
    showToast(`새 터미널 → 워크트리 (${wtPath.split('/').pop()})`, 'success');
  } else {
    // project cwd 로 생성 후 cd
    app.ws.send(JSON.stringify({ type: 'create', projectId, cols, rows }));
    // 새 termId 알려면 created 메시지 기다려야 — 마지막에 생성된 거 기준
    // 간단히 0.7초 후 가장 최근 termId 에 cd 명령
    setTimeout(() => {
      const ids = [...app.termMap.keys()];
      const lastId = ids[ids.length - 1];
      if (lastId && app.ws?.readyState === 1) {
        const cmd = `cd ${JSON.stringify(wtPath)}\n`;
        app.ws.send(JSON.stringify({ type: 'input', termId: lastId, data: cmd }));
      }
    }, 700);
    showToast(`새 터미널 + cd → ${wtPath}`, 'success');
  }
}

function guardXtermPaste(t, termId) {
  if (!t || t._pasteGuarded) return;
  const ta = t.element?.querySelector('.xterm-helper-textarea');
  if (!ta) return;
  const tid = termId || [...app.termMap.entries()].find(([, v]) => v === t)?.[0];
  if (!tid) return;
  t._pasteGuarded = true;
  ta.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    // 이미지 우선 처리
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        e.preventDefault(); e.stopPropagation();
        const blob = it.getAsFile();
        if (!blob) return;
        (async () => {
          try {
            const ext = (it.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase();
            const fd = new FormData();
            fd.append('file', new File([blob], `paste.${ext}`, { type: it.type }));
            const r = await fetch('/api/uploads', { method: 'POST', body: fd });
            if (!r.ok) throw new Error('upload ' + r.status);
            const { path } = await r.json();
            if (path && app.ws?.readyState === 1) {
              app.ws.send(JSON.stringify({ type: 'input', termId: tid, data: path + ' ' }));
              showToast(`Image pasted → ${path}`, 'success');
            }
          } catch (err) {
            showToast(`Image paste failed: ${err.message || err}`, 'error');
          }
        })();
        return;
      }
    }
    // 텍스트 — binary 가 들어있으면 차단
    const text = e.clipboardData?.getData('text') || '';
    if (/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 100))) {
      e.preventDefault();
      showToast('이미지 / binary 데이터라 paste 차단됨', 'warning');
    }
    // 일반 텍스트는 xterm 의 기본 처리에 위임
  }, true); // capture phase 로 다른 핸들러 전에
}

function renderNode(node, container) {
  if (node.type === 'leaf' && node.termId === WALL_ID) {
    // 관제 패널 leaf — 터미널 leaf 와 같은 뼈대(head 드래그, drop zone)라서
    // 분할 리사이즈/드래그 이동이 기존 로직 그대로 적용됨
    const leaf = document.createElement('div');
    leaf.className = 'split-leaf agent-wall-leaf'; leaf.dataset.termId = WALL_ID;
    leaf.style.display = 'flex'; leaf.style.flexDirection = 'column';
    leaf.style.position = 'relative';
    const head = document.createElement('div');
    head.className = 'term-head'; head.draggable = true; head.dataset.termId = WALL_ID; head.style.cursor = 'grab';
    head.innerHTML = '<span class="th-name">Agent Wall</span><span class="th-spacer"></span>' +
      '<button class="th-close" data-action="wall-pane-close" title="Close">×</button>';
    leaf.appendChild(head);
    const body = document.createElement('div');
    body.className = 'agent-wall agent-wall-pane'; body.id = 'agent-wall-pane';
    leaf.appendChild(body);
    const overlay = document.createElement('div'); overlay.className = 'drop-overlay';
    ['top', 'bottom', 'left', 'right'].forEach(pos => { const zone = document.createElement('div'); zone.className = `drop-zone ${pos}`; overlay.appendChild(zone); });
    leaf.appendChild(overlay); container.appendChild(leaf);
    updateAgentWall();
    return;
  }
  if (node.type === 'leaf') {
    const t = app.termMap.get(node.termId);
    if (!t) return;
    const leaf = document.createElement('div');
    leaf.className = 'split-leaf'; leaf.dataset.termId = node.termId;
    leaf.style.display = 'flex'; leaf.style.flexDirection = 'column';
    leaf.style.position = 'relative';
    // 프로젝트 path → chat-view 의 session.jsonl 위치 결정
    const p = app.projectList.find(pp => pp.id === t.projectId);
    if (p?.path) leaf.dataset.projectPath = p.path;
    const head = document.createElement('div');
    head.className = 'term-head'; head.draggable = true; head.dataset.termId = node.termId; head.style.cursor = 'grab';
    leaf.appendChild(head); leaf.appendChild(t.element);
    const overlay = document.createElement('div'); overlay.className = 'drop-overlay';
    ['top', 'bottom', 'left', 'right'].forEach(pos => { const zone = document.createElement('div'); zone.className = `drop-zone ${pos}`; overlay.appendChild(zone); });
    leaf.appendChild(overlay); container.appendChild(leaf);
    return;
  }
  const splitEl = document.createElement('div');
  splitEl.className = `split-container ${node.dir === 'h' ? 'horizontal' : 'vertical'}`;
  const prop = node.dir === 'h' ? 'width' : 'height';
  const first = document.createElement('div');
  first.className = 'split-child'; first.style[prop] = `calc(${node.ratio * 100}% - 2px)`;
  first.style[node.dir === 'h' ? 'height' : 'width'] = '100%';
  renderNode(node.children[0], first); splitEl.appendChild(first);
  const divider = document.createElement('div');
  divider.className = `split-divider ${node.dir === 'h' ? 'h' : 'v'}`;
  divider.addEventListener('mousedown', e => startDividerDrag(e, node, splitEl));
  splitEl.appendChild(divider);
  const second = document.createElement('div');
  second.className = 'split-child'; second.style[prop] = `calc(${(1 - node.ratio) * 100}% - 2px)`;
  second.style[node.dir === 'h' ? 'height' : 'width'] = '100%';
  renderNode(node.children[1], second); splitEl.appendChild(second);
  container.appendChild(splitEl);
}

function startDividerDrag(e, node, splitEl) {
  e.preventDefault();
  const isH = node.dir === 'h';
  const rect = splitEl.getBoundingClientRect();
  const totalSize = isH ? rect.width : rect.height;
  const firstChild = splitEl.children[0], secondChild = splitEl.children[2];
  const prop = isH ? 'width' : 'height';
  const cover = document.createElement('div');
  cover.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:' + (isH ? 'col-resize' : 'row-resize');
  document.body.appendChild(cover);
  document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
  document.body.style.userSelect = 'none';
  const onMove = e => {
    const pos = isH ? e.clientX - rect.left : e.clientY - rect.top;
    const ratio = Math.max(0.08, Math.min(0.92, pos / totalSize));
    node.ratio = ratio;
    firstChild.style[prop] = `calc(${ratio * 100}% - 2px)`;
    secondChild.style[prop] = `calc(${(1 - ratio) * 100}% - 2px)`;
    _core.debouncedFit();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    cover.remove(); _core.fitAllTerminals(); _core.saveLayout();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Mobile Detection ───
export function isMobile() {
  return window.innerWidth <= 600 || (window.matchMedia('(hover: none) and (pointer: coarse)').matches && window.innerWidth <= 900);
}

// ─── Terminal Headers ───
export function debouncedUpdateTermHeaders() {
  if (app._termHeaderTimer) return;
  app._termHeaderTimer = requestAnimationFrame(() => { app._termHeaderTimer = null; updateTermHeaders(); });
}

// ─── Duration Formatter ───
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function updateTermHeaders() {
  document.querySelectorAll('.split-leaf').forEach(leaf => {
    const tid = leaf.dataset.termId;
    const t = app.termMap.get(tid);
    if (!t) return;
    leaf.classList.toggle('active', tid === app.activeTermId);
    let head = leaf.querySelector('.term-head');
    if (!head) { head = document.createElement('div'); head.className = 'term-head'; leaf.insertBefore(head, leaf.firstChild); }
    const g = app.state.projects.get(t.projectId)?.git || {};
    const s = app.state.projects.get(t.projectId)?.session || {};
    const model = s.model ? s.model.replace('claude-', '').replace(/-\d{8}$/, '') : '';
    const wt = (g.worktrees || []).filter(w => !w.bare);
    const nv = app.nodeVersion || '';
    const bufUsed = t.xterm.buffer.active.length;
    const bufPct = Math.round(bufUsed / _core.getScrollback() * 100);
    const timerStr = t.createdAt ? fmtDuration(Date.now() - t.createdAt) : '';
    const cacheKey = `${t.label}|${t.topic || ''}|${t.account?.id || ''}|${t.color}|${g.branch || ''}|${g.uncommittedCount || 0}|${model}|${nv}|${wt.length}|${tid === app.activeTermId}|${bufPct}|${timerStr}|${leaf.classList.contains('chat-active') ? 'c' : 's'}`;
    if (app._headCache.get(tid) === cacheKey) return;
    app._headCache.set(tid, cacheKey);
    const p = app.projectList.find(pp => pp.id === t.projectId);
    const pPath = (p?.path || '').replace(/\\/g, '/');
    const currentWt = wt.find(w => w.path === pPath || pPath.endsWith(w.path));
    let wtTag = '';
    if (wt.length > 1) {
      const wtName = currentWt ? currentWt.path.split('/').pop() : wt[0].path.split('/').pop();
      const popoverItems = wt.map(w => { const isCur = w === currentWt; return `<div class="wt-popover-item${isCur ? ' wt-current' : ''}" data-action="wt-open" data-wt-path="${esc(w.path)}" data-pid="${esc(t.projectId)}" title="${isCur ? '\ud604\uc7ac \uc6cc\ud06c\ud2b8\ub9ac' : '\uc0c8 \ud130\ubbf8\ub110 + \uc774 \uc6cc\ud06c\ud2b8\ub9ac\ub85c'}"><span class="wt-branch">${esc(w.branch || '?')}${isCur ? ' \u2190' : ''}</span><span class="wt-path">${esc(w.path)}</span></div>`; }).join('');
      wtTag = `<span class="th-tag th-worktree">${esc(wtName)} <span style="opacity:.5">+${wt.length - 1}</span><div class="wt-popover">${popoverItems}</div></span>`;
    }
    const projectPath = p?.path || '';
    head.title = projectPath;
    head.innerHTML = `<span class="th-dot" style="background:${t.color}"></span>` +
      `<span class="th-name">${esc(t.label)}</span>` +
      (t.account ? `<span class="th-tag th-account ${esc(t.account.provider)}">${esc(t.account.name)}</span>` : '') +
      terminalTopicHTML(tid, t.topic, 'th-topic') +
      (g.branch ? `<span class="th-tag th-branch">${esc(g.branch)}</span>` : '') + wtTag +
      (g.uncommittedCount ? `<span class="th-tag th-changes" data-pid="${t.projectId}">\u00B1${g.uncommittedCount}</span>` : '') +
      (model ? `<span class="th-tag th-model">${esc(model)}</span>` : '') +
      (nv ? `<span class="th-tag th-node" title="Node.js ${nv}">${esc(nv)}</span>` : '') +
      (t.createdAt ? `<span class="th-tag th-timer" title="Session duration">${fmtDuration(Date.now() - t.createdAt)}</span>` : '') +
      (bufPct >= 80 ? `<span class="th-tag th-buf" data-action="clear-buf" style="color:${bufPct >= 95 ? 'var(--red)' : 'var(--yellow)'};font-size:.7rem;cursor:pointer" title="Buffer ${bufPct}% — click to clear">${bufPct}%</span>` : '') +
      `<span class="th-spacer"></span>` +
      `<button class="th-close" data-action="close" title="Close">\u00d7</button>`;
    // \ud604\uc7ac \ubaa8\ub4dc active \uc0c1\ud0dc \ubc18\uc601
    {
      const leafEl = head.parentElement;
      const curMode = leafEl?.dataset?.mode || 'chat';
      head.querySelectorAll('[data-cv-mode]').forEach((b) => {
        b.classList.toggle('active', b.dataset.cvMode === curMode);
      });
    }
    head.onclick = e => {
      if (e.target.dataset.action === 'close') { e.stopPropagation(); requestCloseTerminal(tid); return; }
      if (e.target.dataset.action === 'clear-buf') { e.stopPropagation(); const tt = app.termMap.get(tid); if (tt?.xterm) { tt.xterm.clear(); showToast('Buffer cleared'); updateTermHeaders(); } return; }
      if (e.target.dataset.cvMode) {
        e.stopPropagation();
        const newMode = e.target.dataset.cvMode;
        const leaf2 = head.parentElement;
        if (leaf2) {
          leaf2.dataset.mode = newMode;
          import('./chat-view.js').then((cv) => cv.setChatMode?.(tid, newMode)).catch(() => {});
          setTimeout(() => _core.fitTerminal(tid), 50);
          updateTermHeaders();
        }
        return;
      }
      if (e.target.classList.contains('th-changes')) { e.stopPropagation(); showDiffForProject(e.target.dataset.pid); return; }
    };
    head.ondblclick = e => {
      if (e.target.dataset.action === 'close') return;
      e.stopPropagation();
      const topic = e.target.closest('[data-terminal-topic]');
      if (topic) { startEditTerminalTopic(tid, topic); return; }
      if (e.target.classList.contains('th-name')) { startRenameHeader(tid, head); return; }
      app.activeTermId = tid;
      canvas.enabled = true;
      saveCanvasState();
      showToast('Canvas view');
      updateTermHeaders(); renderLayout();
    };
  });
}

export function startRenameHeader(termId, headEl) {
  const t = app.termMap.get(termId);
  if (!t) return;
  const nameSpan = headEl.querySelector('.th-name');
  const input = document.createElement('input');
  input.type = 'text'; input.value = t.label;
  input.style.cssText = 'font-size:.68rem;padding:1px 4px;background:var(--bg-0);border:1px solid var(--accent);color:var(--text-1);border-radius:3px;width:100px;';
  const finish = () => { const val = input.value.trim(); if (val) t.label = val; updateTermHeaders(); _core.saveLayout(); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') updateTermHeaders(); e.stopPropagation(); });
  input.addEventListener('blur', finish);
  nameSpan.replaceWith(input); input.focus(); input.select();
}

// ─── Context Menu ───
let _ctxDismiss = null;

// SVG icons (13px, stroke-based, explicit size)
const _S = 'width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"';
const _ci = {
  copy:     `<svg ${_S}><rect x="5.5" y="5.5" width="7" height="8" rx="1"/><path d="M3.5 10.5V3.5a1 1 0 011-1h5"/></svg>`,
  paste:    `<svg ${_S}><rect x="4" y="4" width="8.5" height="9.5" rx="1"/><path d="M6.5 4V3a1 1 0 011-1h1a1 1 0 011 1v1"/></svg>`,
  run:      `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3l8 5-8 5V3z"/></svg>`,
  splitH:   `<svg ${_S}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><line x1="8" y1="2.5" x2="8" y2="13.5"/></svg>`,
  splitV:   `<svg ${_S}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><line x1="1.5" y1="8" x2="14.5" y2="8"/></svg>`,
  search:   `<svg ${_S}><circle cx="6.5" cy="6.5" r="4"/><line x1="9.5" y1="9.5" x2="13.5" y2="13.5"/></svg>`,
  clear:    `<svg ${_S}><path d="M3 3l10 10M13 3L3 13"/></svg>`,
  close:    `<svg ${_S}><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>`,
  file:     `<svg ${_S}><path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M9 2v4h4"/></svg>`,
  ide:      `<svg ${_S}><rect x="1.5" y="2" width="13" height="12" rx="1.5"/><path d="M6 6L4 8l2 2M10 6l2 2-2 2"/></svg>`,
  folder:   `<svg ${_S}><path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3a1 1 0 00-1 1z"/></svg>`,
  globe:    `<svg ${_S}><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2.5 2 9.5 0 12M8 2c-2 2.5-2 9.5 0 12"/></svg>`,
  git:      `<svg ${_S}><circle cx="8" cy="4" r="1.5"/><circle cx="8" cy="12" r="1.5"/><line x1="8" y1="5.5" x2="8" y2="10.5"/></svg>`,
  broadcast:`<svg ${_S}><circle cx="8" cy="8" r="2"/><path d="M4.5 4.5a5 5 0 000 7M11.5 4.5a5 5 0 010 7"/></svg>`,
  export:   `<svg ${_S}><path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 11v2h10v-2"/></svg>`,
  rename:   `<svg ${_S}><path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z"/></svg>`,
  cmd:      `<svg ${_S}><path d="M4 5l3 3-3 3"/><line x1="9" y1="11" x2="13" y2="11"/></svg>`,
  newTerm:  `<svg ${_S}><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 7l2 1.5-2 1.5"/><line x1="8" y1="10" x2="11" y2="10"/></svg>`,
  select:   `<svg ${_S}><rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke-dasharray="2 2"/></svg>`,
  chevron:  `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 4l4 4-4 4"/></svg>`,
};
const _ic = (name) => `<span class="ctx-ic">${_ci[name] || ''}</span>`;

export function showTermCtxMenu(e, termId) {
  const menu = document.getElementById('term-ctx-menu');
  const t = app.termMap.get(termId);
  if (!t) return;
  if (_ctxDismiss) _ctxDismiss();
  const trigger = document.activeElement;
  if (trigger?.getAttribute?.('aria-haspopup') === 'menu') trigger.setAttribute('aria-expanded', 'true');
  const g = app.state.projects.get(t.projectId)?.git || {};
  const sel = t.xterm.getSelection();
  const _pName = app.projectList.find(p => p.id === t.projectId)?.name || '';
  const termCount = app.termMap.size;

  // Detect file path at cursor
  let fileInfo = null;
  const wrap = t.element;
  const cellW = t.xterm._core._renderService?.dimensions?.css?.cell?.width || 8;
  const cellH = t.xterm._core._renderService?.dimensions?.css?.cell?.height || 16;
  const screenEl = wrap.querySelector('.xterm-screen');
  const rect = screenEl?.getBoundingClientRect();
  if (rect) {
    const col = Math.floor((e.clientX - rect.left) / cellW);
    const row = t.xterm.buffer.active.viewportY + Math.floor((e.clientY - rect.top) / cellH);
    fileInfo = getFilePathAtPosition(t.xterm, col, row);
  }

  // ── Build menu ──
  let html = '';

  // File context (only when on a file path)
  if (fileInfo) {
    const fp = escapeHtml(fileInfo.path);
    const la = fileInfo.line ? ` data-line="${fileInfo.line}"` : '';
    const ca = fileInfo.column ? ` data-col="${fileInfo.column}"` : '';
    html += `<div class="ctx-label">File</div>`;
    html += `<div class="ctx-item" data-act="preview" data-path="${fp}"${la}>${_ic('file')}Preview</div>`;
    html += `<div class="ctx-item" data-act="open-file-ide" data-ide="code" data-path="${fp}"${la}${ca}>${_ic('ide')}Open in IDE</div>`;
    html += `<div class="ctx-item" data-act="copy-path" data-path="${fp}">${_ic('copy')}Copy Path</div>`;
    html += `<div class="ctx-sep"></div>`;
  }

  // Edit
  if (sel) {
    html += `<div class="ctx-item" data-act="copy">${_ic('copy')}Copy<span class="ctx-key">Ctrl+C</span></div>`;
    html += `<div class="ctx-item" data-act="run-sel">${_ic('run')}Run Selection</div>`;
    html += `<div class="ctx-item" data-act="select-all">${_ic('select')}Select All</div>`;
  } else {
    html += `<div class="ctx-item" data-act="select-all">${_ic('select')}Select All</div>`;
  }
  html += `<div class="ctx-item" data-act="paste">${_ic('paste')}Paste<span class="ctx-key">Ctrl+V</span></div>`;
  html += `<div class="ctx-sep"></div>`;

  // Layout
  html += `<div class="ctx-item" data-act="split-h">${_ic('splitH')}Split Right</div>`;
  html += `<div class="ctx-item" data-act="split-v">${_ic('splitV')}Split Down</div>`;
  html += `<div class="ctx-item" data-act="new-term">${_ic('newTerm')}New Terminal</div>`;
  html += `<div class="ctx-item" data-act="new-home-term">${_ic('newTerm')}빈 터미널 (홈)</div>`;
  html += `<div class="ctx-sep"></div>`;

  // Open ▸
  html += `<div class="ctx-item ctx-toggle" data-sub="open">${_ic('ide')}Open<span class="ctx-chevron">${_ci.chevron}</span></div>`;
  html += `<div class="ctx-panel" data-sub-id="open">`;
  html += `<div class="ctx-item" data-act="ide" data-ide="code">${_ic('ide')}VS Code</div>`;
  html += `<div class="ctx-item" data-act="ide" data-ide="cursor">${_ic('ide')}Cursor</div>`;
  html += `<div class="ctx-item" data-act="ide" data-ide="zed">${_ic('ide')}Zed</div>`;
  html += `<div class="ctx-item" data-act="firefox-dev">${_ic('globe')}Firefox Dev</div>`;
  html += `<div class="ctx-item" data-act="folder">${_ic('folder')}Folder</div>`;
  html += `</div>`;

  // Tools ▸
  html += `<div class="ctx-item ctx-toggle" data-sub="tools">${_ic('cmd')}Tools<span class="ctx-chevron">${_ci.chevron}</span></div>`;
  html += `<div class="ctx-panel" data-sub-id="tools">`;
  html += `<div class="ctx-item" data-act="search">${_ic('search')}Search<span class="ctx-key">Ctrl+F</span></div>`;
  html += `<div class="ctx-item" data-act="broadcast">${_ic('broadcast')}Broadcast</div>`;
  html += `<div class="ctx-item" data-act="quick-bar">${_ic('cmd')}Quick Bar<span class="ctx-key">Ctrl+J</span></div>`;
  html += `<div class="ctx-item" data-act="export">${_ic('export')}Export</div>`;
  html += `<div class="ctx-item" data-act="rename">${_ic('rename')}Rename</div>`;
  html += `<div class="ctx-item" data-act="arena">${_ic('broadcast')}Arena (세션 토론)</div>`;
  html += `<div class="ctx-item" data-act="clear-term">${_ic('clear')}Clear Scrollback</div>`;
  html += `<div class="ctx-item" data-act="copy-on-select">${_ic('select')}Copy on Select${localStorage.getItem('dl-copy-on-select') === '1' ? ' ✓' : ''}</div>`;
  html += `</div>`;

  // Layout ▸ (정리) — 터미널 2개 이상일 때만
  if (termCount > 1) {
    html += `<div class="ctx-item ctx-toggle" data-sub="arrange">${_ic('splitH')}정리<span class="ctx-chevron">${_ci.chevron}</span></div>`;
    html += `<div class="ctx-panel" data-sub-id="arrange">`;
    html += `<div class="ctx-item" data-act="arrange-grid">${_ic('splitH')}그리드 (2x2)</div>`;
    html += `<div class="ctx-item" data-act="arrange-cols">${_ic('splitH')}가로 일렬</div>`;
    html += `<div class="ctx-item" data-act="arrange-rows">${_ic('splitV')}세로 일렬</div>`;
    html += `</div>`;
  }

  html += `<div class="ctx-sep"></div>`;
  if (g.uncommittedCount > 0) html += `<div class="ctx-item" data-act="diff">${_ic('git')}Changes<span class="ctx-badge">${g.uncommittedCount}</span></div>`;
  html += `<div class="ctx-item" data-act="clear">${_ic('clear')}Clear</div>`;
  if (termCount > 1) html += `<div class="ctx-item ctx-danger" data-act="close">${_ic('close')}Close</div>`;

  menu.innerHTML = html;
  menu.setAttribute('role', 'menu');
  menu.querySelectorAll('.ctx-item').forEach(item => {
    item.setAttribute('role', 'menuitem');
    item.tabIndex = 0;
  });
  menu.querySelectorAll('.ctx-toggle').forEach(item => {
    item.setAttribute('aria-haspopup', 'menu');
    item.setAttribute('aria-expanded', 'false');
  });
  menu.querySelectorAll('.ctx-panel').forEach(panel => panel.setAttribute('role', 'menu'));

  // ── Submenu toggle ──
  menu.querySelectorAll('.ctx-toggle').forEach(toggle => {
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const subId = toggle.dataset.sub;
      const panel = menu.querySelector(`.ctx-panel[data-sub-id="${subId}"]`);
      if (!panel) return;
      const isOpen = panel.style.display === 'block';
      menu.querySelectorAll('.ctx-panel').forEach(s => { s.style.display = 'none'; });
      menu.querySelectorAll('.ctx-toggle').forEach(t => { t.classList.remove('ctx-active'); });
      if (!isOpen) {
        panel.style.display = 'block';
        toggle.classList.add('ctx-active');
        toggle.setAttribute('aria-expanded', 'true');
        // Style sub-items
        panel.querySelectorAll('.ctx-item').forEach(el => {
          el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:.76rem;color:#7982a9;cursor:pointer;white-space:nowrap;border-radius:4px;margin:0 2px;';
          el.onmouseenter = () => { el.style.background = 'rgba(99,102,241,.1)'; el.style.color = '#c0caf5'; };
          el.onmouseleave = () => { el.style.background = ''; el.style.color = '#7982a9'; };
        });
      } else toggle.setAttribute('aria-expanded', 'false');
      requestAnimationFrame(() => {
        const mr = menu.getBoundingClientRect();
        if (mr.bottom > window.innerHeight - 8) menu.style.top = Math.max(8, window.innerHeight - mr.height - 8) + 'px';
      });
    });
  });

  // ── Force styles (Tauri WebView workaround) ──
  menu.style.cssText = `
    position:fixed; z-index:10000; display:block;
    background:#1a1b26; border:1px solid #2a2b3d; border-radius:10px;
    padding:4px; min-width:190px; max-width:260px;
    box-shadow:0 12px 48px rgba(0,0,0,.6); font-family:inherit;
  `;
  // Apply item styles
  menu.querySelectorAll('.ctx-item').forEach(el => {
    el.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:.76rem;color:var(--text-2);cursor:pointer;white-space:nowrap;border-radius:3px;`;
    el.onmouseenter = () => { el.style.background = 'var(--bg-3)'; el.style.color = 'var(--text-0)'; };
    el.onmouseleave = () => { el.style.background = ''; el.style.color = el.classList.contains('ctx-danger') ? 'var(--red)' : 'var(--text-2)'; };
    if (el.classList.contains('ctx-danger')) el.style.color = 'var(--red)';
  });
  menu.querySelectorAll('.ctx-sep').forEach(el => { el.style.cssText = 'height:1px;background:var(--border);margin:3px 8px;'; });
  menu.querySelectorAll('.ctx-label').forEach(el => { el.style.cssText = 'padding:6px 10px 3px;font-size:.58rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.09em;font-weight:650;'; });
  menu.querySelectorAll('.ctx-panel').forEach(el => { el.style.cssText = 'display:none;overflow:hidden;margin:2px 4px 2px 10px;padding:2px;border:1px solid var(--border);border-radius:3px;background:var(--bg-1);'; });
  menu.querySelectorAll('.ctx-key').forEach(el => { el.style.cssText = 'margin-left:auto;font-size:.58rem;color:var(--text-3);font-family:var(--mono);padding:1px 5px;background:var(--bg-1);border-radius:3px;border:1px solid var(--border);line-height:1.2;'; });
  menu.querySelectorAll('.ctx-badge').forEach(el => { el.style.cssText = 'margin-left:auto;padding:1px 7px;border-radius:8px;font-size:.58rem;font-weight:700;background:var(--accent-dim);color:var(--text-0);'; });
  menu.querySelectorAll('.ctx-chevron').forEach(el => { el.style.cssText = 'margin-left:auto;width:10px;height:10px;opacity:.4;display:inline-flex;'; });
  menu.querySelectorAll('.ctx-ic').forEach(el => { el.style.cssText = 'width:13px;height:13px;flex-shrink:0;opacity:.45;display:inline-flex;align-items:center;'; });

  // ── Position ──
  const mRect = menu.getBoundingClientRect();
  const vW = window.innerWidth, vH = window.innerHeight;
  let left = e.clientX, top = e.clientY;
  if (left + mRect.width > vW - 8) left = Math.max(8, vW - mRect.width - 8);
  if (top + mRect.height > vH - 8) top = Math.max(8, vH - mRect.height - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  // ── Dismiss ──
  function dismiss() {
    menu.style.display = 'none';
    menu.classList.remove('show');
    menu.onclick = null;
    menu.onkeydown = null;
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onEsc);
    if (trigger?.getAttribute?.('aria-haspopup') === 'menu') trigger.setAttribute('aria-expanded', 'false');
    trigger?.focus?.();
    _ctxDismiss = null;
  }
  function onOutside(ev) { if (!menu.contains(ev.target)) dismiss(); }
  function onEsc(ev) { if (ev.key === 'Escape') dismiss(); }
  _ctxDismiss = dismiss;

  // ── Actions ──
  menu.onclick = ev => {
    const item = ev.target.closest('[data-act]');
    if (!item) return;
    if (item.classList.contains('ctx-toggle')) return;
    dismiss();
    const path = item.dataset.path;
    switch (item.dataset.act) {
      case 'preview': if (path) notify('openFilePreview', path); break;
      case 'open-file-ide': if (path) openInIde(path, item.dataset.ide, t.projectId, item.dataset.line, item.dataset.col); break;
      case 'copy-path': if (path) { copyText(path).then((ok) => showToast(ok ? 'Path copied' : 'Copy failed', ok ? 'success' : 'error')); } break;
      case 'copy': { const s = t.xterm.getSelection(); if (s) { copyText(s).then((ok) => { if (ok) { t.xterm.clearSelection(); showToast('Copied'); } else showToast('Copy failed', 'error'); }); } break; }
      case 'run-sel': { const s = t.xterm.getSelection(); if (s && app.ws?.readyState === 1) { app.ws.send(JSON.stringify({ type: 'input', termId, data: s.trim() + '\r' })); t.xterm.clearSelection(); } break; }
      case 'select-all': t.xterm.selectAll(); break;
      case 'arena': startArenaPick(); break;
      case 'clear-term': t.xterm.clear(); break;
      case 'copy-on-select': {
        const on = localStorage.getItem('dl-copy-on-select') === '1';
        localStorage.setItem('dl-copy-on-select', on ? '0' : '1');
        showToast(`Copy on Select ${on ? 'OFF' : 'ON — 드래그로 선택하면 바로 복사됩니다'}`, 'success');
        break;
      }
      case 'paste': (async () => { try { const items = navigator.clipboard?.read ? await navigator.clipboard.read() : []; for (const ci of items) { const imgT = ci.types.find(x => x.startsWith('image/')); if (imgT) { const blob = await ci.getType(imgT); const r = await fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': imgT }, body: blob }); const { path: p } = await r.json(); if (p && app.ws?.readyState === 1) { app.ws.send(JSON.stringify({ type: 'input', termId, data: p + ' ' })); showToast('Image pasted', 'success'); } return; } } const txt = await navigator.clipboard.readText(); if (txt && app.ws?.readyState === 1) { const bp = t.xterm._core?.coreService?.decPrivateModes?.bracketedPasteMode ?? txt.includes('\n'); const data = bp ? `\x1b[200~${txt}\x1b[201~` : txt; app.ws.send(JSON.stringify({ type: 'input', termId, data })); } } catch { showToast('클립보드 접근이 차단됨 — 터미널에서 Ctrl+V 로 붙여넣으세요', 'warning'); } })(); break;
      case 'split-h': _core.openNewTermModalWithSplit(termId, 'right'); break;
      case 'split-v': _core.openNewTermModalWithSplit(termId, 'bottom'); break;
      case 'new-term': _core.openTermWith(t.projectId); break;
      case 'new-home-term': _core.openHomeTerminal(); break;
      case 'arrange-grid': _core.arrangeTerminals('grid'); break;
      case 'arrange-cols': _core.arrangeTerminals('cols'); break;
      case 'arrange-rows': _core.arrangeTerminals('rows'); break;
      case 'ide': openInIDEProject(t.projectId, item.dataset.ide); break;
      case 'firefox-dev': openInFirefoxDevFromTerm(t.projectId); break;
      case 'folder': fetch('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: app.projectList.find(p => p.id === t.projectId)?.path }) }).catch(() => {}); break;
      case 'search': _core.toggleTermSearch(); break;
      case 'broadcast': toggleBroadcastMode(); break;
      case 'quick-bar': toggleQuickBar(); break;
      case 'export': _core.exportTerminal(); break;
      case 'rename': { const hdr = t.element.closest('.term-panel')?.querySelector('.term-header[data-id="' + termId + '"]'); if (hdr) startRenameHeader(termId, hdr); break; }
      case 'diff': showDiffForProject(t.projectId); break;
      case 'clear': t.xterm.clear(); break;
      case 'close': requestCloseTerminal(termId); break;
    }
  };
  menu.onkeydown = ev => {
    const item = ev.target.closest('[role="menuitem"]');
    if (!item) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      item.click();
      return;
    }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(el => el.offsetParent !== null);
    const current = items.indexOf(item);
    const delta = ev.key === 'ArrowDown' ? 1 : -1;
    items[(current + delta + items.length) % items.length]?.focus();
  };

  setTimeout(() => {
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEsc);
    menu.querySelector('[role="menuitem"]')?.focus();
  }, 50);
}

function openInIDEProject(projectId, ide = 'code') {
  fetch(`/api/projects/${projectId}/open-ide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ide }) }).catch(() => {});
}

function showDiffForProject(projectId) {
  notify('switchView', 'diff');
  // Select the project in the diff dropdown and reload
  setTimeout(() => {
    const sel = document.getElementById('diff-project');
    if (sel && projectId) { sel.value = projectId; sel.dispatchEvent(new Event('change')); }
  }, 100);
}

function openInFirefoxDevFromTerm(projectId) {
  const dsInfo = app.devServerState?.find(d => d.projectId === projectId);
  const url = dsInfo?.port ? `http://localhost:${dsInfo.port}` : null;
  if (url) {
    fetch('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, browser: 'firefox-dev' }) })
      .then(() => showToast(`Firefox Dev → localhost:${dsInfo.port}`))
      .catch(() => showToast('Failed to open', 'error'));
  } else {
    const input = prompt('Enter URL to open in Firefox Developer Edition:', 'http://localhost:3000');
    if (input) {
      fetch('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input, browser: 'firefox-dev' }) })
        .then(() => showToast(`Firefox Dev → ${input}`))
        .catch(() => showToast('Failed to open', 'error'));
    }
  }
}

// ─── File path detection ───
function getFilePathAtPosition(xterm, x, y) {
  const line = xterm.buffer.active.getLine(y)?.translateToString() || '';
  // Match absolute paths, optionally followed by :line:col
  const re = /(?:[A-Za-z]:[\\\/][^\s"'<>|]+|\/(?:home|Users|usr|tmp|var|etc|opt|mnt|app|workspace)[^\s"'<>|]+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (x >= m.index && x < m.index + m[0].length) {
      // Extract path, line, column from "path:line:col"
      const parts = m[0].match(/^(.+?):(\d+)(?::(\d+))?$/);
      if (parts) return { path: parts[1], line: parseInt(parts[2]), column: parseInt(parts[3] || '0') };
      return { path: m[0], line: 0, column: 0 };
    }
  }
  return null;
}

function openInIde(filePath, ide, projectId, line, column) {
  const body = { path: filePath, ide };
  if (projectId) body.projectId = projectId;
  if (line) body.line = parseInt(line);
  if (column) body.column = parseInt(column);
  fetch('/api/open-in-ide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json()).then(d => { if (d.opened) showToast(`Opened in ${ide}`); else showToast(d.error || 'Failed', 'error'); })
    .catch(() => showToast('Failed to open', 'error'));
}

// ─── WS Disconnect Indicator ───
export function showDisconnectIndicator(show) {
  document.querySelectorAll('.term-disconnect').forEach(el => el.remove());
  if (show) {
    document.querySelectorAll('.split-leaf').forEach(leaf => {
      const ind = document.createElement('div'); ind.className = 'term-disconnect'; ind.textContent = 'Disconnected';
      leaf.appendChild(ind);
    });
  }
}

// ─── File Drop ───
export function initFileDrop() {
  const overlay = document.createElement('div');
  overlay.id = 'drop-overlay';
  overlay.innerHTML = '<div class="drop-msg">Drop file to preview</div>';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(99,102,241,.15);backdrop-filter:blur(2px);pointer-events:none;align-items:center;justify-content:center';
  overlay.querySelector('.drop-msg').style.cssText = 'background:var(--bg-2);border:2px dashed var(--accent);color:var(--text-0);padding:20px 40px;border-radius:12px;font-size:16px;font-weight:600';
  document.body.appendChild(overlay);
  document.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); overlay.style.display = 'flex'; overlay.querySelector('.drop-msg').textContent = app.activeTermId ? 'Drop image to paste path / file to preview' : 'Drop file to preview'; } });
  document.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', e => { if (e.relatedTarget === null || e.relatedTarget === document.documentElement) overlay.style.display = 'none'; });
  document.addEventListener('drop', async e => {
    overlay.style.display = 'none';
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    const file = files[0];
    // Image drop → upload & paste path into active terminal
    if (file.type.startsWith('image/') && app.activeTermId && app.ws?.readyState === 1) {
      try {
        const resp = await fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        const { path } = await resp.json();
        if (path) {
          app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: path + ' ' }));
          const thumb = URL.createObjectURL(file);
          showToast(`<img src="${thumb}" style="max-width:120px;max-height:80px;border-radius:6px;vertical-align:middle;margin-right:6px" onload="URL.revokeObjectURL(this.src)">Image dropped`, 'success', 3000, true);
          return;
        }
      } catch { /* upload failed */ }
    }
    notify('openFilePreviewFromFile', file);
  });
}

// ─── Event Delegation Setup ───
export function setupTermEventDelegation() {
  const _termView = document.getElementById('terminal-view');
  if (_termView) {
    _termView.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      switch (el.dataset.action) {
        case 'new-term': _core.openNewTermModal(); break;
        case 'new-home-term': _core.openHomeTerminal(); break;
        case 'mob-switch': mobileSwitchTerm(el.dataset.termid); break;
      }
    });
    _termView.addEventListener('dragstart', startSessionOrderDrag);
    _termView.addEventListener('dragover', overSessionOrderDrag);
    _termView.addEventListener('drop', dropSessionOrder);
    _termView.addEventListener('dragend', clearSessionOrderDrag);
    _termView.addEventListener('keydown', handleSessionOrderKey);
  }
  const _ntModal = document.getElementById('new-term-modal');
  if (_ntModal) {
    _ntModal.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      switch (el.dataset.action) {
        case 'close-modal': _ntModal.close(); break;
        case 'create-terminal': _core.createTerminal(); break;
        case 'select-branch': _core.selectBranch(el); break;
      }
    });
    _ntModal.addEventListener('change', e => {
      if (e.target.dataset.action === 'load-branches') _core.loadBranchesForTerm();
    });
  }
  const _termPanels = document.getElementById('term-panels');
  _termPanels.addEventListener('pointerdown', startCanvasGesture, true);
  _termPanels.addEventListener('wheel', handleCanvasWheel, { passive: false });
  _termPanels.addEventListener('keydown', e => {
    const topic = e.target.closest('[data-terminal-topic]');
    if (topic && (e.key === 'Enter' || e.key === ' ' || e.key === 'F2')) {
      e.preventDefault();
      e.stopPropagation();
      startEditTerminalTopic(topic.dataset.terminalTopic, topic);
      return;
    }
    if (handleCanvasFrameKey(e)) return;
    if (canvas.enabled && e.target.matches('[data-canvas-frame]') && e.key === 'Enter') {
      e.preventDefault();
      focusCanvasTerminal(e.target.dataset.canvasFrame);
    }
  });
  document.addEventListener('pointermove', moveCanvasGesture);
  document.addEventListener('pointerup', endCanvasGesture);
  document.addEventListener('pointercancel', endCanvasGesture);
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('[data-action="canvas-group-layout-toggle"], [data-canvas-group-layout-menu]')) closeCanvasGroupLayoutMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return;
    const groupMenu = document.querySelector('[data-canvas-group-layout-menu]');
    if (e.key === 'Escape' && !groupMenu?.hidden) {
      e.preventDefault();
      closeCanvasGroupLayoutMenu(true);
      return;
    }
    if (e.key === 'Escape' && app.pairSourceTermId) {
      e.preventDefault();
      finishCanvasGroupEdit();
      return;
    }
    if (!groupMenu?.hidden && groupMenu.contains(e.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const items = [...groupMenu.querySelectorAll('[role="menuitemradio"]')];
      const current = Math.max(0, items.indexOf(document.activeElement));
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      e.preventDefault();
      items[next]?.focus({ preventScroll: true });
      return;
    }
    if (handleCanvasPairShortcut(e)) return;
    if (handleCanvasSessionShortcut(e)) return;
    if (e.code !== 'Space' || !canvas.enabled || e.target.closest('input, textarea, [contenteditable="true"]')) return;
    canvasSpaceDown = true;
    document.body.classList.add('canvas-space-ready');
    if (document.getElementById('terminal-view')?.classList.contains('active')) e.preventDefault();
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') { canvasSpaceDown = false; document.body.classList.remove('canvas-space-ready'); }
  });
  window.addEventListener('blur', () => { canvasSpaceDown = false; endCanvasGesture(); });
  _termPanels.addEventListener('mousedown', e => {
    const leaf = e.target.closest('.split-leaf');
    if (leaf) {
      const prevId = app.activeTermId;
      app.activeTermId = leaf.dataset.termId;
      updateTermHeaders();
      // Reload quick bar scripts when switching terminals
      if (prevId !== app.activeTermId && app.quickBar.visible) {
        const t = app.termMap.get(app.activeTermId);
        if (t) loadProjectScripts(t.projectId);
      }
    }
  });
  _termPanels.addEventListener('contextmenu', e => {
    const leaf = e.target.closest('.split-leaf');
    if (leaf) { e.preventDefault(); e.stopPropagation(); showTermCtxMenu(e, leaf.dataset.termId); }
  }, true);
  _termPanels.addEventListener('dblclick', e => {
    const topic = e.target.closest('[data-terminal-topic]');
    if (topic) {
      e.preventDefault();
      e.stopPropagation();
      startEditTerminalTopic(topic.dataset.terminalTopic, topic);
      return;
    }
    const canvasHead = e.target.closest('.canvas-frame-head');
    if (canvas.enabled && canvasHead && !e.target.closest('button')) {
      e.preventDefault();
      focusCanvasTerminal(canvasHead.dataset.canvasDrag);
      return;
    }
    const name = e.target.closest('.th-name'); if (!name) return;
    const head = name.closest('.term-head'); if (!head) return;
    const tid = head.dataset.termId; if (tid) startRenameHeader(tid, head);
  });
  _termPanels.addEventListener('dragstart', e => {
    const head = e.target.closest('.term-head'); if (!head) return;
    const tid = head.dataset.termId; app.draggedTermId = tid;
    head.style.cursor = 'grabbing'; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tid);
    requestAnimationFrame(() => { document.querySelectorAll('.split-leaf').forEach(l => { if (l.dataset.termId !== tid) l.classList.add('drag-over'); }); });
  });
  _termPanels.addEventListener('dragend', e => {
    const head = e.target.closest('.term-head'); if (head) head.style.cursor = 'grab';
    app.draggedTermId = null;
    document.querySelectorAll('.split-leaf').forEach(l => l.classList.remove('drag-over'));
    document.querySelectorAll('.drop-zone').forEach(z => z.classList.remove('active'));
  });
  _termPanels.addEventListener('dragover', e => {
    const zone = e.target.closest('.drop-zone');
    if (zone) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; zone.classList.add('active'); }
  });
  _termPanels.addEventListener('dragleave', e => { const zone = e.target.closest('.drop-zone'); if (zone) zone.classList.remove('active'); });
  _termPanels.addEventListener('drop', e => {
    const zone = e.target.closest('.drop-zone'); if (!zone) return;
    e.preventDefault(); zone.classList.remove('active');
    const leaf = zone.closest('.split-leaf'); if (leaf) leaf.classList.remove('drag-over');
    const targetId = leaf?.dataset.termId;
    const pos = ['top', 'bottom', 'left', 'right'].find(p => zone.classList.contains(p));
    if (app.draggedTermId && targetId && app.draggedTermId !== targetId && pos) {
      _core.removeFromLayoutTree(app.draggedTermId);
      _core.splitAt(targetId, app.draggedTermId, pos);
      // 관제 패널(WALL_ID)은 activeTermId 가 될 수 없음 — 리사이즈/키보드 로직이 termMap 을 전제
      if (app.termMap.has(app.draggedTermId)) app.activeTermId = app.draggedTermId;
      renderLayout(); updateTermHeaders();
    }
  });
  // Selection toolbar event delegation
  const selToolbar = document.getElementById('term-selection-toolbar');
  if (selToolbar) {
    selToolbar.addEventListener('mousedown', e => e.stopPropagation()); // prevent xterm losing selection
    selToolbar.addEventListener('click', e => {
      const btn = e.target.closest('[data-sel-action]');
      if (btn) { e.stopPropagation(); handleSelectionAction(btn.dataset.selAction); }
    });
  }
  // Quick command bar: handle qb-remove click (prevent running the parent qb-run)
  const qbBar = document.getElementById('term-quick-bar');
  if (qbBar) {
    qbBar.addEventListener('click', e => {
      const removeBtn = e.target.closest('[data-action="qb-remove"]');
      if (removeBtn) { e.stopPropagation(); removeQuickCmd(removeBtn.dataset.idx); return; }
    });
  }
  // Hide selection toolbar on click anywhere in term panels
  _termPanels.addEventListener('mousedown', e => {
    if (!e.target.closest('.term-selection-toolbar')) hideSelectionToolbar();
  });
  // 워크트리 popover 항목 클릭 → 새 터미널 + cd to worktree
  _termPanels.addEventListener('click', e => {
    const item = e.target.closest('[data-action="wt-open"]');
    if (!item) return;
    e.preventDefault(); e.stopPropagation();
    const wtPath = item.dataset.wtPath;
    const pid = item.dataset.pid;
    if (!wtPath || !pid || app.ws?.readyState !== 1) return;
    if (item.classList.contains('wt-current')) {
      showToast('이미 이 워크트리에 있는 터미널이 있어요', 'info');
      return;
    }
    openTerminalAtWorktree(pid, wtPath);
  });
  // Resize observer
  const termPanelsObs = new ResizeObserver(() => _core.debouncedFit());
  termPanelsObs.observe(_termPanels);
  window.addEventListener('resize', () => _core.debouncedFit());
  // Initialize quick bar if it was visible
  const qbBarInit = document.getElementById('term-quick-bar');
  if (qbBarInit && app.quickBar.visible) {
    qbBarInit.style.display = 'flex';
    renderQuickBar();
  }
  // Re-render layout when crossing mobile/desktop threshold
  let wasMobile = isMobile();
  window.addEventListener('resize', () => {
    const nowMobile = isMobile();
    if (nowMobile !== wasMobile) { wasMobile = nowMobile; renderLayout(); }
  });
}

// ─── Mobile Quick-Action Keys ───
const KEY_MAP = {
  'escape': '\x1b',
  'tab': '\t',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-z': '\x1a',
  'ctrl-l': '\x0c',
  'ctrl-r': '\x12',
  'ctrl-a': '\x01',
  'ctrl-e': '\x05',
  'up': '\x1b[A',
  'down': '\x1b[B',
};

export function setupMobileActions() {
  const bar = document.getElementById('mob-term-actions');
  if (!bar) return;
  bar.addEventListener('click', e => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    e.preventDefault();
    const key = btn.dataset.key;
    const seq = KEY_MAP[key];
    if (!seq || !app.activeTermId || !app.ws || app.ws.readyState !== 1) return;
    app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: seq }));
    // Focus the terminal after key press
    const t = app.termMap.get(app.activeTermId);
    if (t) t.xterm.focus();
    // Visual feedback
    btn.classList.add('mob-btn-flash');
    setTimeout(() => btn.classList.remove('mob-btn-flash'), 150);
  });
}

// ─── Mobile Swipe to Switch Terminals ───
export function setupMobileSwipe() {
  const container = document.getElementById('term-panels');
  if (!container) return;
  let startX = 0, startY = 0, swiping = false;
  container.addEventListener('touchstart', e => {
    if (!isMobile() || app.termMap.size < 2) return;
    const touch = e.touches[0];
    startX = touch.clientX; startY = touch.clientY; swiping = true;
  }, { passive: true });
  container.addEventListener('touchend', e => {
    if (!swiping || !isMobile()) return;
    swiping = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    // Only horizontal swipe, minimum 60px, must be more horizontal than vertical
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const ids = getOrderedTerminalIds();
    const idx = ids.indexOf(app.activeTermId);
    if (idx < 0) return;
    if (dx < 0 && idx < ids.length - 1) mobileSwitchTerm(ids[idx + 1]); // swipe left → next
    if (dx > 0 && idx > 0) mobileSwitchTerm(ids[idx - 1]); // swipe right → prev
  }, { passive: true });
}

// ─── Command History Palette ───
const CMD_HISTORY_KEY = 'dl-cmd-history';
const MAX_CMD_HISTORY = 200;

function getCmdHistory() {
  try { return JSON.parse(localStorage.getItem(CMD_HISTORY_KEY) || '[]'); } catch { return []; }
}

export function addCmdHistory(cmd) {
  if (!cmd || cmd.length < 2) return;
  // Skip single control chars, pure whitespace
  if (/^[\x00-\x1f]+$/.test(cmd)) return;
  const hist = getCmdHistory().filter(h => h !== cmd);
  hist.unshift(cmd);
  if (hist.length > MAX_CMD_HISTORY) hist.length = MAX_CMD_HISTORY;
  try { localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(hist)); } catch { /* storage unavailable */ }
}

let _cmdPaletteOpen = false;

export function toggleCmdPalette() {
  if (_cmdPaletteOpen) { closeCmdPalette(); return; }
  if (!app.activeTermId) return;
  _cmdPaletteOpen = true;
  let overlay = document.getElementById('hist-palette-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'hist-palette-overlay';
    overlay.className = 'hist-palette-overlay';
    overlay.innerHTML = `<div class="hist-palette">
      <input type="text" class="hist-palette-input" placeholder="Search command history..." autofocus />
      <div class="hist-palette-list"></div>
      <div class="hist-palette-hint">\u2191\u2193 Navigate \u00B7 Enter Send \u00B7 Esc Close</div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeCmdPalette(); });
  }
  overlay.style.display = ''; // Reset inline style from close
  overlay.classList.add('open');
  const input = overlay.querySelector('.hist-palette-input');
  const list = overlay.querySelector('.hist-palette-list');
  let selected = -1;
  const render = (filter) => {
    let hist = getCmdHistory();
    if (filter) {
      const lf = filter.toLowerCase();
      hist = hist.filter(h => h.toLowerCase().includes(lf));
    }
    list.innerHTML = hist.slice(0, 50).map((h, i) =>
      `<div class="hist-palette-item${i === selected ? ' selected' : ''}" data-idx="${i}" data-cmd="${escapeHtml(h)}">${escapeHtml(h)}</div>`
    ).join('') || '<div class="hist-palette-empty">No commands found</div>';
  };
  render('');
  input.value = '';
  input.focus();
  input.oninput = () => { selected = -1; render(input.value); };
  input.onkeydown = e => {
    const items = list.querySelectorAll('.hist-palette-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, items.length - 1); render(input.value); items[selected]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); render(input.value); items[selected]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = selected >= 0 ? items[selected]?.dataset.cmd : input.value;
      if (cmd && app.ws?.readyState === 1 && app.activeTermId) {
        app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: cmd + '\r' }));
        const t = app.termMap.get(app.activeTermId);
        if (t) t.xterm.focus();
      }
      closeCmdPalette();
    }
    else if (e.key === 'Escape') { closeCmdPalette(); }
  };
  list.onclick = e => {
    const item = e.target.closest('.hist-palette-item');
    if (!item) return;
    const cmd = item.dataset.cmd;
    if (cmd && app.ws?.readyState === 1 && app.activeTermId) {
      app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: cmd + '\r' }));
      const t = app.termMap.get(app.activeTermId);
      if (t) t.xterm.focus();
    }
    closeCmdPalette();
  };
}

export function closeCmdPalette() {
  _cmdPaletteOpen = false;
  const overlay = document.getElementById('hist-palette-overlay');
  if (overlay) { overlay.classList.remove('open'); overlay.style.display = 'none'; }
  // Refocus terminal
  const t = app.termMap.get(app.activeTermId);
  if (t) setTimeout(() => t.xterm.focus(), 50);
}

// ─── Terminal Presets ───
const PRESETS_KEY = 'dl-term-presets';

function getPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); } catch { /* malformed JSON */ return []; }
}

function savePresets(presets) {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch { /* storage unavailable */ }
}

export function addPreset(name, command, projectId) {
  const presets = getPresets();
  presets.push({ name, command, projectId: projectId || '', id: Date.now().toString(36) });
  savePresets(presets);
  showToast(`Preset "${name}" saved`);
}

export function removePreset(presetId) {
  const presets = getPresets().filter(p => p.id !== presetId);
  savePresets(presets);
}

export function runPreset(presetId) {
  const preset = getPresets().find(p => p.id === presetId);
  if (!preset) return;
  const projectId = preset.projectId || app.projectList[0]?.id;
  if (!projectId) { showToast('No project available', 'error'); return; }
  _core.openTermWith(projectId, preset.command);
}

export function showPresetsDialog() {
  let dlg = document.getElementById('presets-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'presets-dialog';
    dlg.className = 'presets-dialog';
    // Append inside themed container for proper CSS variable inheritance
    (document.getElementById('app') || document.body).appendChild(dlg);
  }
  const presets = getPresets();
  // Resolve CSS vars for top-layer dialog (doesn't inherit from DOM)
  const cs = getComputedStyle(document.documentElement);
  const bg2 = cs.getPropertyValue('--bg-2').trim();
  const txt1 = cs.getPropertyValue('--text-1').trim();
  const txt3 = cs.getPropertyValue('--text-3').trim();
  const bdr = cs.getPropertyValue('--border').trim();
  const bg0 = cs.getPropertyValue('--bg-0').trim();
  const bg1 = cs.getPropertyValue('--bg-1').trim();
  dlg.style.cssText = `background:${bg2};color:${txt1};border:1px solid ${bdr};border-radius:10px;padding:0;width:480px;max-width:90vw;box-shadow:0 12px 32px rgba(0,0,0,.4)`;
  dlg.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid ${bdr}">
      <h3 style="font-size:1.05rem;font-weight:600;margin:0">Terminal Presets</h3>
      <button data-action="close-dialog" style="background:none;border:none;color:${txt3};cursor:pointer;font-size:1.1rem;padding:4px 8px;border-radius:4px">&times;</button>
    </div>
    <div style="max-height:300px;overflow-y:auto;padding:8px 0">${presets.length ? presets.map(p => `
      <div class="preset-item" style="display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid ${bg1};cursor:pointer">
        <div style="flex:1;min-width:0" data-action="run-preset" data-pid="${p.id}">
          <div style="font-weight:600;font-size:.84rem;color:${txt1}">${escapeHtml(p.name)}</div>
          <div style="font-family:var(--mono);font-size:.76rem;color:${txt3};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.command)}</div>
        </div>
        <button data-action="delete-preset" data-pid="${p.id}" title="Delete" style="background:none;border:none;color:${txt3};cursor:pointer;font-size:1rem;padding:4px 8px">&times;</button>
      </div>
    `).join('') : `<div style="padding:24px 16px;text-align:center;color:${txt3};font-size:.82rem">No presets yet. Save one from the form below.</div>`}
    </div>
    <div style="display:flex;gap:6px;padding:12px 16px;border-top:1px solid ${bdr};flex-wrap:wrap">
      <input type="text" id="preset-name" placeholder="Name (e.g., Dev Server)" style="flex:1;min-width:100px;padding:6px 10px;background:${bg0};color:${txt1};border:1px solid ${bdr};border-radius:4px;font-size:.8rem;outline:none" />
      <input type="text" id="preset-cmd" placeholder="Command (e.g., npm run dev)" style="flex:1;min-width:100px;padding:6px 10px;background:${bg0};color:${txt1};border:1px solid ${bdr};border-radius:4px;font-size:.8rem;font-family:var(--mono);outline:none" />
      <select id="preset-project" style="flex:1;min-width:100px;padding:6px 10px;background:${bg0};color:${txt1};border:1px solid ${bdr};border-radius:4px;font-size:.8rem"><option value="">Any Project</option>${app.projectList.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn btn-sm" data-action="save-preset">Save</button>
    </div>`;
  if (!dlg.dataset.delegated) {
    dlg.dataset.delegated = '1';
    dlg.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      switch (el.dataset.action) {
        case 'close-dialog': dlg.close(); break;
        case 'run-preset': runPreset(el.dataset.pid); dlg.close(); break;
        case 'delete-preset': removePreset(el.dataset.pid); showPresetsDialog(); break;
        case 'save-preset': {
          const n = document.getElementById('preset-name').value.trim();
          const c = document.getElementById('preset-cmd').value.trim();
          if (!n || !c) { showToast('Name and command required', 'error'); return; }
          addPreset(n, c, document.getElementById('preset-project').value);
          showPresetsDialog();
          break;
        }
      }
    });
  }
  dlg.showModal();
}

// ─── Broadcast Input Mode ───
let _broadcastMode = false;
let _broadcastTargets = new Set();

export function toggleBroadcastMode() {
  _broadcastMode = !_broadcastMode;
  if (_broadcastMode) {
    // Select all terminals by default
    _broadcastTargets = new Set(app.termMap.keys());
    showToast(`Broadcast mode ON \u2014 typing to ${_broadcastTargets.size} terminals`, 'info');
  } else {
    _broadcastTargets.clear();
    showToast('Broadcast mode OFF');
  }
  updateBroadcastUI();
}

export function toggleBroadcastTarget(termId) {
  if (_broadcastTargets.has(termId)) _broadcastTargets.delete(termId);
  else _broadcastTargets.add(termId);
  updateBroadcastUI();
}

function updateBroadcastUI() {
  // Update header badges
  document.querySelectorAll('.split-leaf').forEach(leaf => {
    const tid = leaf.dataset.termId;
    leaf.classList.toggle('broadcast-target', _broadcastMode && _broadcastTargets.has(tid));
  });
  // Update broadcast indicator
  const ind = document.getElementById('broadcast-indicator');
  if (ind) {
    ind.style.display = _broadcastMode ? 'flex' : 'none';
    ind.querySelector('.bc-count').textContent = _broadcastTargets.size;
  }
}

export function broadcastInput(fromTermId, data) {
  if (!_broadcastMode || !app.ws || app.ws.readyState !== 1) return false;
  if (_broadcastTargets.size <= 1) return false;
  for (const tid of _broadcastTargets) {
    if (tid !== fromTermId) {
      app.ws.send(JSON.stringify({ type: 'input', termId: tid, data }));
    }
  }
  return true;
}

export function isBroadcastMode() { return _broadcastMode; }

// ═══════════════════════════════════════════
// Selection Floating Toolbar
// ═══════════════════════════════════════════

let _selToolbarTimer = null;

export function showSelectionToolbar(termId) {
  const t = app.termMap.get(termId);
  if (!t) return;
  const sel = t.xterm.getSelection();
  if (!sel || !sel.trim()) { hideSelectionToolbar(); return; }

  const toolbar = document.getElementById('term-selection-toolbar');
  if (!toolbar) return;
  const termView = document.getElementById('terminal-view');
  if (!termView) return;

  // Reset transform before measuring
  toolbar.style.transform = '';
  toolbar.style.display = 'flex';

  const screen = t.element.querySelector('.xterm-screen');
  const viewRect = termView.getBoundingClientRect();
  const tbRect = toolbar.getBoundingClientRect();

  let left, top;

  // Try xterm's selection position API
  const selPos = t.xterm.getSelectionPosition?.();
  if (selPos && screen) {
    const screenRect = screen.getBoundingClientRect();
    const cellW = t.xterm._core._renderService?.dimensions?.css?.cell?.width || 8;
    const cellH = t.xterm._core._renderService?.dimensions?.css?.cell?.height || 16;
    const startY = screenRect.top + (selPos.start.y - t.xterm.buffer.active.viewportY) * cellH;
    const startX = screenRect.left + selPos.start.x * cellW;
    const endX = screenRect.left + selPos.end.x * cellW;
    const centerX = (startX + endX) / 2;
    left = centerX - tbRect.width / 2 - viewRect.left;
    top = startY - tbRect.height - 8 - viewRect.top;
    if (top < 4) top = startY + cellH + 4 - viewRect.top;
  } else if (screen) {
    // Fallback: position near the mouse / center of screen element
    const screenRect = screen.getBoundingClientRect();
    left = (screenRect.left + screenRect.width / 2) - tbRect.width / 2 - viewRect.left;
    top = screenRect.top - viewRect.top + 12;
  } else {
    left = (viewRect.width - tbRect.width) / 2;
    top = 12;
  }

  // Clamp inside view
  left = Math.max(4, Math.min(left, viewRect.width - tbRect.width - 4));
  top = Math.max(4, top);
  toolbar.style.left = left + 'px';
  toolbar.style.top = top + 'px';

  // Show/hide "Open URL" button based on URL in selection
  const urlBtn = toolbar.querySelector('[data-sel-action="open-url"]');
  const urlMatch = sel.match(/https?:\/\/\S+/);
  if (urlBtn) urlBtn.style.display = urlMatch ? '' : 'none';

  // Store current selection context
  toolbar.dataset.termId = termId;
  toolbar.dataset.selText = sel;
  if (urlMatch) toolbar.dataset.selUrl = urlMatch[0];
  else delete toolbar.dataset.selUrl;
}

export function hideSelectionToolbar() {
  const toolbar = document.getElementById('term-selection-toolbar');
  if (toolbar) toolbar.style.display = 'none';
}

function handleSelectionAction(action) {
  const toolbar = document.getElementById('term-selection-toolbar');
  if (!toolbar) return;
  const text = toolbar.dataset.selText || '';
  const termId = toolbar.dataset.termId;
  const t = app.termMap.get(termId);

  switch (action) {
    case 'copy':
      copyText(text).then((ok) => {
        if (ok) { showToast('Copied'); if (t) t.xterm.clearSelection(); }
        else showToast('Copy failed', 'error');
      });
      break;
    case 'search':
      // Open terminal search with selected text
      if (termId) app.activeTermId = termId;
      _core.toggleTermSearch();
      setTimeout(() => {
        const input = document.querySelector('#term-search-bar input');
        if (input) { input.value = text; _core.doTermSearch('next'); }
      }, 50);
      break;
    case 'run':
      if (text.trim() && app.ws?.readyState === 1 && termId) {
        app.ws.send(JSON.stringify({ type: 'input', termId, data: text.trim() + '\r' }));
        showToast('Command sent');
      }
      break;
    case 'open-url': {
      const url = toolbar.dataset.selUrl;
      if (url) {
        fetch('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
          .then(() => showToast(`Opening ${url}`)).catch(() => window.open(url, '_blank'));
      }
      break;
    }
  }
  hideSelectionToolbar();
}

// ═══════════════════════════════════════════
// Quick Command Bar
// ═══════════════════════════════════════════

const BUILT_IN_CMDS = [
  { label: 'git status', cmd: 'git status', type: 'builtin' },
  { label: 'git diff --stat', cmd: 'git diff --stat', type: 'builtin' },
  { label: 'clear', cmd: 'clear', type: 'builtin' },
];

export function toggleQuickBar() {
  app.quickBar.visible = !app.quickBar.visible;
  localStorage.setItem('dl-quick-bar-visible', JSON.stringify(app.quickBar.visible));
  const bar = document.getElementById('term-quick-bar');
  if (bar) bar.style.display = app.quickBar.visible ? 'flex' : 'none';
  if (app.quickBar.visible) renderQuickBar();
  // Re-fit terminals since space changed
  setTimeout(() => _core.fitAllTerminals(), 50);
}

export function renderQuickBar() {
  const container = document.getElementById('qb-cmds');
  if (!container) return;

  let html = '';
  // Built-in commands
  for (const c of BUILT_IN_CMDS) {
    html += `<button class="qb-chip" data-action="qb-run" data-cmd="${escapeHtml(c.cmd)}" title="${escapeHtml(c.cmd)}">${escapeHtml(c.label)}</button>`;
  }

  // npm scripts (cached)
  if (app._quickBarScripts) {
    for (const [name, script] of Object.entries(app._quickBarScripts)) {
      html += `<button class="qb-chip qb-npm" data-action="qb-run" data-cmd="npm run ${escapeHtml(name)}" title="${escapeHtml(script)}">npm run ${escapeHtml(name)}</button>`;
    }
  }

  // Custom commands
  for (const c of app.quickBar.customCmds) {
    html += `<button class="qb-chip" data-action="qb-run" data-cmd="${escapeHtml(c.cmd)}" title="${escapeHtml(c.cmd)}">${escapeHtml(c.label)}<span class="qb-x" data-action="qb-remove" data-idx="${c.id}">&times;</span></button>`;
  }

  container.innerHTML = html;
}

export async function loadProjectScripts(projectId) {
  if (!projectId) { app._quickBarScripts = null; renderQuickBar(); return; }
  const project = app.projectList.find(p => p.id === projectId);
  if (!project?.path) { app._quickBarScripts = null; renderQuickBar(); return; }
  try {
    const res = await fetch(`/api/scripts-by-path?path=${encodeURIComponent(project.path)}`);
    const data = await res.json();
    app._quickBarScripts = data.scripts || {};
  } catch {
    app._quickBarScripts = null;
  }
  renderQuickBar();
}

function runQuickCmd(cmd) {
  if (!cmd || !app.ws || app.ws.readyState !== 1 || !app.activeTermId) {
    showToast('No active terminal', 'error');
    return;
  }
  app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: cmd + '\r' }));
  const t = app.termMap.get(app.activeTermId);
  if (t) t.xterm.focus();
}

function addQuickCmd() {
  const label = prompt('Command label (e.g., "build"):');
  if (!label) return;
  const cmd = prompt('Command to run:', label);
  if (!cmd) return;
  const entry = { id: Date.now().toString(36), label, cmd };
  app.quickBar.customCmds.push(entry);
  localStorage.setItem('dl-quick-cmds', JSON.stringify(app.quickBar.customCmds));
  renderQuickBar();
  showToast(`Quick command "${label}" added`);
}

function removeQuickCmd(id) {
  app.quickBar.customCmds = app.quickBar.customCmds.filter(c => c.id !== id);
  localStorage.setItem('dl-quick-cmds', JSON.stringify(app.quickBar.customCmds));
  renderQuickBar();
}

// ═══════════════════════════════════════════
// Scroll-to-Bottom + Output Annotations
// ═══════════════════════════════════════════

// Track new lines since user scrolled up
const _scrollState = new Map(); // termId -> { scrolledUp, newLines }

function getScrollState(termId) {
  if (!_scrollState.has(termId)) _scrollState.set(termId, { scrolledUp: false, newLines: 0 });
  return _scrollState.get(termId);
}

export function updateScrollIndicator(termId) {
  const t = app.termMap.get(termId);
  if (!t) return;
  const buf = t.xterm.buffer.active;
  // viewportY is the scroll offset from top; baseY is max scrollable
  const delta = buf.baseY - buf.viewportY;
  const ss = getScrollState(termId);

  if (delta <= 1) {
    ss.scrolledUp = false;
    ss.newLines = 0;
    if (termId === app.activeTermId) hideScrollIndicator();
  } else if (delta > 3) {
    // TUI(Claude Code 등) 재렌더링으로 스크롤이 2~3줄 순간 출렁이는 건 무시 —
    // 진짜 사용자가 위로 스크롤했을 때만 인디케이터를 arm
    ss.scrolledUp = true;
  }
}

function showScrollIndicator(count) {
  const btn = document.getElementById('term-scroll-bottom');
  if (!btn) return;
  btn.style.display = 'flex';
  const countEl = document.getElementById('tsb-count');
  if (countEl) countEl.textContent = count > 99 ? '99+' : count;
}

function hideScrollIndicator() {
  const btn = document.getElementById('term-scroll-bottom');
  if (btn) btn.style.display = 'none';
}

export function scrollToBottom(termId = app.activeTermId) {
  if (!termId) return;
  const t = app.termMap.get(termId);
  if (!t) return;
  delete t._resizeScrollAnchor;
  t._focusBottomUntil = Date.now() + 1000;
  if (t.xterm.buffer.active.type === 'alternate' && app.ws?.readyState === 1) {
    const data = t.xterm.modes.applicationCursorKeysMode ? '\x1bOF' : '\x1b[F';
    app.ws.send(JSON.stringify({ type: 'input', termId, data, cols: t.xterm.cols, rows: t.xterm.rows }));
  } else {
    t.xterm.scrollToBottom();
  }
  const ss = getScrollState(termId);
  ss.scrolledUp = false;
  ss.newLines = 0;
  hideScrollIndicator();
  t.xterm.focus();
}

// Output annotation patterns
const ERROR_RE = /\b(error|Error|ERROR|FAIL|failed|FAILED|ERR!|ERR:|panic|PANIC|exception|Exception|FATAL|fatal|TypeError|ReferenceError|SyntaxError|Cannot find|not found|No such file|ENOENT|EACCES|ECONNREFUSED|segfault|Segmentation fault)\b/;
const SUCCESS_RE = /\b(success|Success|SUCCESS|passed|PASSED|PASS|\u2713|done|Done|DONE|completed|Completed|\u2714|ok\b|OK\b)\b/;

export function addOutputDecoration(xterm, lineNum, type) {
  try {
    // registerMarker(0) = current cursor line, negative = lines above cursor
    const cursorAbsLine = xterm.buffer.active.baseY + xterm.buffer.active.cursorY;
    const offset = lineNum - cursorAbsLine;
    const marker = xterm.registerMarker(offset);
    if (!marker || marker.line < 0) return;
    const deco = xterm.registerDecoration({
      marker,
      width: 1,
      overviewRulerOptions: {
        color: type === 'error' ? '#f87171' : '#34d399',
        position: 'full',
      },
    });
    if (deco) {
      deco.onRender(el => {
        el.className = type === 'error' ? 'term-gutter-error' : 'term-gutter-success';
        el.style.width = '3px';
        el.style.height = '100%';
      });
    }
  } catch { /* addon not available */ }
}

// Enhanced bufferWrite with output scanning
export function scanOutput(t, data, termId) {
  // Skip ANSI control sequences for pattern matching
  const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const lines = clean.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;
    const curLine = t.xterm.buffer.active.baseY + t.xterm.buffer.active.cursorY;

    if (ERROR_RE.test(line)) {
      addOutputDecoration(t.xterm, curLine, 'error');
    } else if (SUCCESS_RE.test(line)) {
      addOutputDecoration(t.xterm, curLine, 'success');
    }
  }

  // Track scroll state for new output
  const ss = getScrollState(termId);
  if (ss.scrolledUp) {
    const lineCount = (clean.match(/\n/g) || []).length + 1;
    ss.newLines += lineCount;
    if (termId === app.activeTermId) showScrollIndicator(ss.newLines);
  }
}

// ─── Action Registration ───
registerClickActions({
  'toggle-broadcast': toggleBroadcastMode,
  'new-term': () => _core.openNewTermModal(),
  'new-home-term': () => _core.openHomeTerminal(),
  'ts-toggle-case': (el) => { el.classList.toggle('active'); _core.doTermSearch('next'); },
  'ts-toggle-regex': (el) => { el.classList.toggle('active'); _core.doTermSearch('next'); },
  'term-search-prev': () => _core.doTermSearch('prev'),
  'term-search-next': () => _core.doTermSearch('next'),
  'close-term-search': () => _core.closeTermSearch(),
  'font-size-down': () => _core.changeTermFontSize(-1),
  'font-size-up': () => _core.changeTermFontSize(1),
  'export-terminal': () => _core.exportTerminal(),
  'term-scroll-bottom': () => scrollToBottom(),
  'toggle-canvas-view': toggleCanvasView,
  'canvas-tab': (el) => setCanvasTab(el.dataset.termid, el.dataset.tab),
  'canvas-jump': (el) => jumpToCanvasFrame(el.dataset.termid),
  'canvas-focus': (el) => focusCanvasTerminal(el.dataset.termid),
  'canvas-pair-toggle': (el) => toggleCanvasPair(el.dataset.termid),
  'canvas-group-edit': toggleCanvasGroupEdit,
  'canvas-pair-direction': (el) => cycleCanvasGroupLayout(el.dataset.termid),
  'canvas-group-layout-toggle': toggleCanvasGroupLayoutMenu,
  'canvas-group-layout': (el) => setCanvasGroupLayout(app.activeTermId, el.dataset.layout),
  'canvas-group-remove': (el) => removeCanvasGroupMember(el.dataset.termid || app.activeTermId),
  'canvas-board-toggle': toggleCanvasBoard,
  'canvas-board-window-add': (el) => addCanvasBoardWindow(el.dataset.boardtype),
  'canvas-board-window-remove': removeCanvasBoardWindow,
  'canvas-terminal-close': closeCanvasTerminal,
  'canvas-zoom-out': () => setCanvasZoom(canvas.zoom - 0.1),
  'canvas-zoom-in': () => setCanvasZoom(canvas.zoom + 0.1),
  'canvas-reset-zoom': () => setCanvasZoom(1),
  'canvas-fit': fitCanvas,
  'canvas-fill-active': fillActiveCanvasFrame,
  'open-term-search': () => app.activeTermId ? _core.toggleTermSearch() : showToast('No active terminal', 'error'),
  'mobile-term-tools': (el) => {
    if (!app.activeTermId) return showToast('No active terminal', 'error');
    const rect = el.getBoundingClientRect();
    showTermCtxMenu({ clientX: rect.left, clientY: Math.max(8, rect.top - 8) }, app.activeTermId);
  },
  'qb-toggle': toggleQuickBar,
  'qb-add-cmd': addQuickCmd,
  'qb-run': (el) => runQuickCmd(el.dataset.cmd),
  'qb-remove': (el, e) => { e?.stopPropagation(); removeQuickCmd(el.dataset.idx); },
});
registerInputActions({
  'term-search-input': () => _core.doTermSearch('next'),
});
