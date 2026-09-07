import { app, getOrderedTerminalEntries, getTerminalPair, getTerminalPairs, notify } from './state.js';
import { esc, fetchJson } from './utils.js';
import { filterCicdByProject } from './cicd.js';
import { registerClickActions } from './actions.js';
import { getAgentAttentionForTerm, getAgentGoal, getAgentKind, getAgentState, getAgentTask, getOperationalState, getReleaseGate, getWallSummary } from './agent-wall-state.js';
import { terminalGroupLayoutLabel } from './terminal-group-layout.js';

// 터미널 분할 레이아웃 트리에 들어가는 관제 패널의 센티널 leaf id.
// 실제 터미널이 아니므로 termMap 에는 없고, 트리 유틸들은 이 id 를 항상 유효한 leaf 로 취급한다.
export const WALL_ID = '__wall__';

let timer;
let opsTimer;
let decisions = [];
let agentEvents = [];
let summaries = {}; // termId → { text, at } — 서버 LLM이 요약한 "지금 뭐 하는 중"
const ciByProject = new Map();
const ciFetchedAt = new Map();
const popout = new URLSearchParams(location.search).get('agent-wall') === 'popout';
let mode = localStorage.getItem('cockpit-agent-wall-mode') || 'grid';

function pairToneClass(termId) {
  const index = getTerminalPairs().findIndex(pair => pair.termIds.includes(termId));
  return index < 0 ? '' : ` pair-tone-${index % 4}`;
}

if (popout) document.body.classList.add('agent-wall-popout');

function tail(xterm) {
  const buf = xterm.buffer.active;
  const lines = [];
  for (let i = Math.max(0, buf.length - 5); i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true).trim();
    if (line) lines.push(line);
  }
  return lines.slice(-3).join('\n') || '아직 터미널 출력 없음';
}

function recentLines(xterm) {
  const buf = xterm.buffer.active;
  const lines = [];
  for (let i = Math.max(0, buf.length - 120); i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true);
    if (line?.trim()) lines.push(line);
  }
  return lines;
}

// TUI 는 화면 하단 3줄에 claude/codex 단어가 거의 안 남으므로, 서버 스캔이 모름인
// 플랫폼과 tmux attach 경계에서는 스크롤백(시작 배너·입력한 커맨드 라인)과 hook으로
// 폴백한다. 한 번 잡히면 터미널이 닫힐 때까지 종류만 유지하고 상태는 출력으로 갱신한다.
function detectKind(termId, term, output) {
  const hookKind = () => getAgentKind(agentEvents.find(event => event.termId === termId)?.kind || '', '');
  const knownKind = getAgentKind(term.agentCommand || '', '') || hookKind();
  if (term.agentScanKnown && (!term.durable || knownKind)) return knownKind;
  if (term.agentKindCache) return term.agentKindCache;
  const kind = getAgentKind(term.command || '', output) || bufferKind(term) || knownKind;
  if (kind) term.agentKindCache = kind;
  return kind;
}

function bufferKind(term) {
  const now = Date.now();
  if (now - (term.agentKindScanAt || 0) < 5000) return null;
  term.agentKindScanAt = now;
  const buf = term.xterm?.buffer.active;
  if (!buf) return null;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true);
    if (line) lines.push(line);
  }
  return getAgentKind('', lines.join('\n'));
}

function agentState(term, output, projectAgentCount) {
  return getAgentState({
    exited: term.exited,
    output,
    lastOutputAt: term.lastOutputAt,
    projectState: projectAgentCount === 1 ? app.state.projects.get(term.projectId)?.session?.state : undefined,
  });
}

function freshness(ts) {
  const seconds = Math.max(0, Math.floor((Date.now() - (ts || 0)) / 1000));
  if (!ts) return '기록 없음';
  if (seconds < 10) return '방금';
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return `${Math.floor(seconds / 3600)}시간 전`;
}

function elapsed(ts) {
  if (!ts) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  return minutes < 1 ? '<1분' : minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function tileHTML({ termId, term, kind, output, state, attention, gate, branch }) {
  const stateLabel = state === 'busy' ? '작업 중' : state === 'waiting' ? '입력 필요' : state === 'done' ? '완료' : '대기';
  const summary = getAgentTask(summaries[termId]?.text, recentLines(term.xterm));
  const reason = attention?.reason || gate.reason;
  const action = attention ? '응답하기' : gate.state === 'hold' ? '확인하기' : gate.label;
  return `<article class="agent-tile ${esc(state)}">
    <button class="agent-tile-main" data-term-id="${esc(termId)}" title="터미널로 이동">
      <span class="agent-tile-head"><span class="agent-tile-dot"></span><span class="agent-tile-name">${esc(term.label)}</span><span class="agent-tile-kind">${kind}</span><span class="agent-tile-state">${stateLabel}</span></span>
      <span class="agent-tile-meta"><span>브랜치 <b>${esc(branch || '없음')}</b></span><span>실행 <b>${elapsed(term.createdAt)}</b></span><span>활동 <b>${freshness(term.lastOutputAt)}</b></span></span>
      <span class="agent-tile-section-label">현재 작업</span>
      <span class="agent-tile-summary">${esc(summary)}</span>
      <span class="agent-tile-section-label">최신 출력</span>
      <pre class="agent-tile-output">${esc(output)}</pre>
    </button>
    <span class="agent-tile-signals">${attention ? '<span class="agent-signal attention">조치 필요</span>' : ''}<span class="agent-gate-reason">${esc(reason)}</span><button class="agent-signal gate ${esc(gate.state)}" data-gate-project="${esc(term.projectId)}" data-gate-target="${esc(gate.target)}" title="${esc(reason)}">${esc(action)}</button></span>
  </article>`;
}

function kanbanHTML(agents) {
  const groups = [
    ['Working', agents.filter(a => a.state === 'busy')],
    ['Waiting', agents.filter(a => a.state === 'waiting')],
    ['Done', agents.filter(a => a.state !== 'busy' && a.state !== 'waiting')],
  ];
  return groups.map(([label, items]) => `<section class="agent-kanban-col">
    <div class="agent-kanban-head"><span>${label}</span><span>${items.length}</span></div>
    <div class="agent-kanban-list">${items.length ? items.map(tileHTML).join('') : '<div class="agent-kanban-empty">No agents</div>'}</div>
  </section>`).join('');
}

function setMode(next) {
  mode = next === 'kanban' ? 'kanban' : 'grid';
  localStorage.setItem('cockpit-agent-wall-mode', mode);
  document.querySelectorAll('[data-agent-wall-action="mode"]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  });
  render();
}

function setDocked(on) {
  const panels = document.getElementById('term-panels');
  const dock = document.getElementById('agent-terminal-dock');
  const stage = document.getElementById('agent-wall-stage');
  if (!panels || !dock || !stage) return;
  if (on) dock.appendChild(panels);
  else restoreTerminalPanels();
  stage.classList.toggle('docked', on);
  document.querySelector('[data-agent-wall-action="dock"]')?.classList.toggle('active', on);
  notify('renderLayout');
  setTimeout(() => notify('fitAllTerminals'), 100);
}

export function restoreTerminalPanels() {
  const panels = document.getElementById('term-panels');
  const home = document.getElementById('term-panels-home');
  if (panels && home && panels.previousElementSibling !== home) home.after(panels);
  document.getElementById('agent-wall-stage')?.classList.remove('docked');
  document.querySelector('[data-agent-wall-action="dock"]')?.classList.remove('active');
}

function setupEvents(wall) {
  setupSectionEvents();
  if (wall.dataset.ready) return;
  wall.dataset.ready = '1';
  wall.addEventListener('click', e => {
    const gate = e.target.closest('[data-gate-project]');
    if (gate) {
      e.stopPropagation();
      const target = gate.dataset.gateTarget;
      if (target === 'terminal') {
        app.activeTermId = gate.closest('.agent-tile')?.querySelector('[data-term-id]')?.dataset.termId;
        notify('switchView', 'terminal');
      } else if (target === 'changes') {
        notify('switchView', 'diff');
        const select = document.getElementById('diff-project');
        if (select) select.value = gate.dataset.gateProject;
        notify('loadDiff');
      } else if (target === 'pr') {
        notify('switchView', 'pr');
      } else {
        notify('switchView', 'cicd');
        filterCicdByProject(gate.dataset.gateProject);
      }
      return;
    }
    const tile = e.target.closest('[data-term-id]');
    if (!tile || !app.termMap.has(tile.dataset.termId)) return;
    if (popout && window.opener) {
      window.opener.postMessage({ type: 'cockpit-open-terminal', termId: tile.dataset.termId }, location.origin);
      window.opener.focus();
      return;
    }
    app.activeTermId = tile.dataset.termId;
    if (!document.getElementById('agent-wall-stage')?.classList.contains('docked')) notify('switchView', 'terminal');
    notify('renderLayout');
    setTimeout(() => notify('fitAllTerminals'), 100);
  });
}

// 섹션 헤더 버튼은 문서에 하나뿐 — 패널(#agent-wall-pane)이 renderLayout 마다
// 재생성돼도 리스너가 중복 바인딩되지 않게 분리
function setupSectionEvents() {
  const section = document.getElementById('agent-wall-section');
  if (!section || section.dataset.ready) return;
  section.dataset.ready = '1';
  section.addEventListener('click', e => {
    const button = e.target.closest('[data-agent-wall-action]');
    if (!button) return;
    if (button.dataset.agentWallAction === 'mode') setMode(button.dataset.mode);
    if (button.dataset.agentWallAction === 'dock') setDocked(!document.getElementById('agent-wall-stage')?.classList.contains('docked'));
    if (button.dataset.agentWallAction === 'popout') window.open(`${location.pathname}?agent-wall=popout`, 'cockpit-agent-wall', 'popup,width=1100,height=760');
    if (button.dataset.agentWallAction === 'focus') {
      const wall = document.getElementById('agent-wall');
      (wall?.querySelector('.agent-tile.waiting [data-term-id]') || wall?.querySelector('.agent-signal.gate.hold'))?.click();
    }
  });
}

function wallInLayout(node) {
  if (!node) return false;
  if (node.type === 'leaf') return node.termId === WALL_ID;
  return wallInLayout(node.children[0]) || wallInLayout(node.children[1]);
}

// 관제를 터미널 분할 레이아웃의 패널로 넣고 빼기 — 터미널 박스처럼 리사이즈/드래그 가능
export function toggleWallPane() {
  if (wallInLayout(app.layoutRoot)) {
    if (app.layoutRoot.type === 'leaf') { app.layoutRoot = null; }
    else {
      const collapse = node => {
        if (node.type !== 'split') return node;
        for (let i = 0; i < 2; i++) { if (node.children[i].type === 'leaf' && node.children[i].termId === WALL_ID) return node.children[1 - i]; }
        return { ...node, children: [collapse(node.children[0]), collapse(node.children[1])] };
      };
      app.layoutRoot = collapse(app.layoutRoot);
    }
  } else {
    app.layoutRoot = app.layoutRoot
      ? { type: 'split', dir: 'h', ratio: 0.7, children: [app.layoutRoot, { type: 'leaf', termId: WALL_ID }] }
      : { type: 'leaf', termId: WALL_ID };
  }
  try { localStorage.setItem('dl-tree', JSON.stringify(app.layoutRoot)); } catch { /* storage unavailable */ }
  notify('renderLayout');
  setTimeout(() => notify('fitAllTerminals'), 100);
  render();
}
registerClickActions({ 'wall-pane-close': () => toggleWallPane() });

// 터미널 탭 상단 요약 스트립 — 탭 이동 없이 상태 확인 + 클릭으로 패널 포커스
function renderStrip(agents) {
  const strip = document.getElementById('agent-strip');
  if (!strip) return;
  strip.style.display = agents.length ? '' : 'none';
  if (wallInLayout(app.layoutRoot)) {
    queueMicrotask(toggleWallPane);
    return;
  }
  const html = agents.map(({ termId, term, kind, state }) => {
    const name = app.projectList.find(p => p.id === term.projectId)?.name || term.projectId;
    const task = getAgentTask(summaries[termId]?.text, recentLines(term.xterm));
    const stateLabel = state === 'busy' ? '작업 중' : state === 'waiting' ? '입력 필요' : state === 'done' ? '완료' : '대기';
    return `<li><button type="button" class="agent-strip-item ${state}${termId === app.activeTermId ? ' current' : ''}"
      data-strip-term="${esc(termId)}" title="${esc(name)} · ${kind} · ${state}${task ? ` · ${esc(task)}` : ''}">
      <span class="agent-strip-dot" aria-hidden="true"></span>
      <span class="agent-strip-name">${esc(name)}</span>
      <span class="agent-strip-meta">${kind} · ${stateLabel} · ${elapsed(term.createdAt)}</span>
      <span class="agent-strip-task">${esc(task)}</span>
    </button></li>`;
  }).join('');
  if (strip._cockpitRenderHtml !== html) {
    strip.innerHTML = html;
    strip._cockpitRenderHtml = html;
  }
  if (!strip.dataset.ready) {
    strip.dataset.ready = '1';
    strip.addEventListener('click', e => {
      const item = e.target.closest('[data-strip-term]');
      if (!item || !app.termMap.has(item.dataset.stripTerm)) return;
      app.activeTermId = item.dataset.stripTerm;
      notify('renderLayout');
      setTimeout(() => notify('fitAllTerminals'), 100);
      render();
    });
  }
}

function renderCanvasContexts(agents) {
  document.querySelectorAll('[data-canvas-context]').forEach(panel => {
    const termId = panel.dataset.canvasContext;
    const term = app.termMap.get(termId);
    const agent = agents.find(item => item.termId === termId);
    const lines = term ? recentLines(term.xterm) : [];
    const summary = summaries[termId] || {};
    const task = agent ? getAgentTask(summary.text, lines) : '일반 셸 세션';
    const goal = getAgentGoal(summary.goal, lines) || '첫 사용자 지시를 기다리는 중';
    const stateLabel = agent?.state === 'busy' ? '작업 중' : agent?.state === 'waiting' ? '입력 필요' : agent?.state === 'done' ? '완료' : '대기';
    const nextState = agent?.state || 'idle';
    if (panel.dataset.state !== nextState) panel.dataset.state = nextState;
    const values = [
      [panel.querySelector('[data-context-goal]'), goal],
      [panel.querySelector('[data-context-task]'), task],
      [panel.querySelector('[data-context-status]'), `${agent?.kind || 'Shell'} · ${stateLabel}`],
    ];
    for (const [element, value] of values) if (element && element.textContent !== value) element.textContent = value;
  });
}

function renderCanvasSessionBoard(agents) {
  const list = document.querySelector('[data-canvas-session-list]');
  if (!list) return;
  const activeElement = document.activeElement;
  const canRestoreOrderFocus = !activeElement || activeElement === document.body || Boolean(activeElement.dataset.sessionOrderId);
  const requestedFocusId = canRestoreOrderFocus && Number(list.dataset.orderFocusUntil) > Date.now() ? list.dataset.orderFocusId : '';
  const focusedOrderId = requestedFocusId;
  if (list.dataset.orderFocusId && (requestedFocusId || !canRestoreOrderFocus)) {
    delete list.dataset.orderFocusId;
    delete list.dataset.orderFocusUntil;
  }
  const agentByTerm = new Map(agents.map(agent => [agent.termId, agent]));
  const sessions = getOrderedTerminalEntries().filter(([, term]) => !term.exited);
  const editingGroup = getTerminalPair(app.pairSourceTermId);
  const count = document.querySelector('[data-canvas-session-count]');
  if (count && count.textContent !== String(sessions.length)) count.textContent = String(sessions.length);
  const html = sessions.map(([termId, term], index) => {
    const agent = agentByTerm.get(termId);
    const pair = getTerminalPair(termId);
    const pairSource = app.pairSourceTermId === termId;
    const groupSelected = pairSource || Boolean(editingGroup?.termIds.includes(termId));
    const lines = recentLines(term.xterm);
    const summary = summaries[termId] || {};
    const inferredTask = agent ? getAgentTask(summary.text, lines) : '일반 셸 세션';
    const unhelpful = inferredTask === '작업 정보 없음' || /^[•◦─\s]+$/.test(inferredTask) || /Worked for \d+/i.test(inferredTask);
    const task = unhelpful ? (getAgentGoal(summary.goal, lines) || inferredTask) : inferredTask;
    const state = agent?.state || 'idle';
    const stateLabel = state === 'busy' ? '작업 중' : state === 'waiting' ? '입력 필요' : state === 'done' ? '완료' : '대기';
    const shortcut = index < 9 ? `Alt+${index + 1}` : '';
    return `<div class="canvas-session-row ${esc(state)}${termId === app.activeTermId ? ' current' : ''}${pair ? ` paired${pairToneClass(termId)}` : ''}${pairSource ? ' pair-source' : ''}${app.pairSourceTermId ? ' group-editing' : ''}${groupSelected ? ' group-selected' : ''}" data-session-order-row="${esc(termId)}">
      <span class="canvas-session-order" draggable="true" tabindex="0" role="button" data-session-order-id="${esc(termId)}" aria-label="Reorder ${esc(term.label)} session" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="Drag to reorder · Alt+↑/↓">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="1"/><circle cx="15" cy="7" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="17" r="1"/><circle cx="15" cy="17" r="1"/></svg>
      </span>
      <button type="button" class="canvas-session-main" data-action="${app.pairSourceTermId ? 'canvas-pair-toggle' : 'canvas-jump'}" data-termid="${esc(termId)}" title="${app.pairSourceTermId ? `${groupSelected ? 'Remove from' : 'Add to'} group` : `${shortcut ? `${shortcut} · ` : ''}${esc(term.label)} · ${esc(task)}`}"${!app.pairSourceTermId && shortcut ? ` aria-keyshortcuts="${shortcut}"` : ''}>
        <span class="canvas-session-dot" aria-hidden="true"></span>
        <span class="canvas-session-copy">
          <span class="canvas-session-name">${esc(term.label)}</span>
          <span class="canvas-session-meta">${esc(agent?.kind || 'Shell')} · ${stateLabel}${pair ? ` · GROUP ${pair.termIds.length} · ${terminalGroupLayoutLabel(pair)}` : ''}</span>
          <span class="canvas-session-task">${esc(task)}</span>
        </span>
        ${app.pairSourceTermId ? `<span class="canvas-session-group-choice" aria-hidden="true">${groupSelected ? '✓' : '+'}</span>` : shortcut ? `<kbd class="canvas-session-shortcut">${shortcut}</kbd>` : ''}
      </button>
      <span class="canvas-session-actions">
        <button type="button" class="canvas-session-pair${pair || pairSource ? ' active' : ''}" data-action="canvas-pair-toggle" data-termid="${esc(termId)}" title="${pairSource ? 'Cancel group selection' : pair ? 'Add another terminal to this group' : `Group ${esc(term.label)} with another terminal`}" aria-label="${pairSource ? 'Cancel group selection' : pair ? 'Add another terminal to this group' : `Group ${esc(term.label)} with another terminal`}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8H7a4 4 0 0 0 0 8h2M15 8h2a4 4 0 0 1 0 8h-2M8 12h8"/></svg>
        </button>
        ${pair ? `<button type="button" class="canvas-session-direction" data-action="canvas-pair-direction" data-termid="${esc(termId)}" title="Next group layout · ${terminalGroupLayoutLabel(pair)}" aria-label="Choose next group layout"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9v14H4zM16 5h4v6h-4zM16 14h4v5h-4z"/></svg></button><button type="button" class="canvas-session-ungroup" data-action="canvas-group-remove" data-termid="${esc(termId)}" title="Remove ${esc(term.label)} from group" aria-label="Remove ${esc(term.label)} from group"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8H7a4 4 0 0 0 0 8h2M15 8h2a4 4 0 0 1 0 8h-2M8 12h8M5 5l14 14"/></svg></button>` : ''}
        <button type="button" class="canvas-session-focus" data-action="canvas-focus" data-termid="${esc(termId)}" title="Open ${esc(term.label)} in Focus" aria-label="Open ${esc(term.label)} in Focus">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>
        </button>
      </span>
    </div>`;
  }).join('') || '<p>No active sessions</p>';
  const structureKey = sessions.map(([termId, term], index) => {
    const pair = getTerminalPair(termId);
    return [termId, term.label, index, pair?.layout || '', pair?.termIds.join(':') || '', app.pairSourceTermId === termId].join('|');
  }).join('::') || 'empty';
  if (list._cockpitStructureKey !== structureKey) {
    const scrollTop = list.scrollTop;
    list.innerHTML = html;
    list._cockpitStructureKey = structureKey;
    list._cockpitRenderHtml = html;
    list.scrollTop = scrollTop;
  } else if (sessions.length && list._cockpitRenderHtml !== html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const nextRows = [...template.content.children];
    [...list.children].forEach((row, index) => {
      const next = nextRows[index];
      if (!next) return;
      if (row.className !== next.className) row.className = next.className;
      const currentMain = row.querySelector('.canvas-session-main');
      const nextMain = next.querySelector('.canvas-session-main');
      if (currentMain && nextMain && currentMain.title !== nextMain.title) currentMain.title = nextMain.title;
      for (const selector of ['.canvas-session-name', '.canvas-session-meta', '.canvas-session-task']) {
        const current = row.querySelector(selector);
        const value = next.querySelector(selector)?.textContent || '';
        if (current && current.textContent !== value) current.textContent = value;
      }
    });
    list._cockpitRenderHtml = html;
  }
  list.dataset.initialized = '1';
  if (focusedOrderId) requestAnimationFrame(() => {
    const handle = [...list.querySelectorAll('[data-session-order-id]')]
      .find(item => item.dataset.sessionOrderId === focusedOrderId);
    handle?.focus();
  });
}

function render() {
  const wall = document.getElementById('agent-wall');
  const section = document.getElementById('agent-wall-section');
  if (!wall || !section) return;
  const detected = [];
  for (const [termId, term] of app.termMap) {
    if (term.exited) continue;
    const output = tail(term.xterm);
    const kind = detectKind(termId, term, output);
    if (!kind) continue;
    detected.push({ termId, term, kind, output });
  }
  const projectCounts = new Map();
  for (const { term } of detected) projectCounts.set(term.projectId, (projectCounts.get(term.projectId) || 0) + 1);
  const agents = detected.map(({ termId, term, kind, output }) => {
    const project = app.projectList.find(p => p.id === term.projectId);
    const hook = agentEvents.find(event => event.termId === termId);
    const projectAgentCount = projectCounts.get(term.projectId);
    const attention = getAgentAttentionForTerm({ hook, decisions, projectPath: project?.path, projectAgentCount, lastOutputAt: term.lastOutputAt });
    const rawState = hook?.state === 'busy' ? 'busy' : hook?.state === 'done' ? 'done' : agentState(term, output, projectAgentCount);
    const projectState = app.state.projects.get(term.projectId);
    const gate = getReleaseGate({ git: projectState?.git, prs: projectState?.prs?.prs, runs: ciByProject.get(term.projectId), attention });
    const state = getOperationalState(rawState, gate.state, attention);
    return { termId, term, kind, output, state, attention, gate, hook, branch: projectState?.git?.branch };
  }).sort((a, b) => Number(Boolean(b.attention)) - Number(Boolean(a.attention))
    || ['waiting', 'busy', 'idle', 'done'].indexOf(a.state) - ['waiting', 'busy', 'idle', 'done'].indexOf(b.state));
  renderCanvasContexts(agents);
  renderCanvasSessionBoard(agents);
  renderStrip(agents);
  section.style.display = agents.length || popout ? '' : 'none';
  const live = agents.filter(agent => agent.hook).length;
  const scanned = agents.length - live;
  const count = document.getElementById('agent-wall-count');
  const countText = agents.length
    ? `${agents.length} online · ${live ? `${live} live hooks` : ''}${live && scanned ? ' · ' : ''}${scanned ? `${scanned} terminal scan` : ''}`
    : '';
  if (count.textContent !== countText) count.textContent = countText;
  const summary = getWallSummary(agents);
  const summaryElement = document.getElementById('agent-wall-summary');
  const summaryHtml = `
    <span><b>${summary.working}</b> working</span>
    <span class="${summary.waiting ? 'attention' : ''}"><b>${summary.waiting}</b> needs input</span>
    <span class="${summary.hold ? 'danger' : ''}"><b>${summary.hold}</b> release hold</span>
    <span class="${summary.ready ? 'ready' : ''}"><b>${summary.ready}</b> ready</span>`;
  if (summaryElement._cockpitRenderHtml !== summaryHtml) {
    summaryElement.innerHTML = summaryHtml;
    summaryElement._cockpitRenderHtml = summaryHtml;
  }
  document.querySelector('[data-agent-wall-action="focus"]').hidden = !summary.waiting && !summary.hold;
  wall.classList.toggle('kanban', mode === 'kanban');
  const wallHtml = agents.length ? (mode === 'kanban' ? kanbanHTML(agents) : agents.map(tileHTML).join('')) : '<div class="agent-kanban-empty">No Claude or Codex agents running</div>';
  if (wall._cockpitRenderHtml !== wallHtml) {
    wall.innerHTML = wallHtml;
    wall._cockpitRenderHtml = wallHtml;
  }
  const pane = document.getElementById('agent-wall-pane');
  if (pane) {
    const paneHtml = agents.length ? agents.map(tileHTML).join('') : '<div class="agent-kanban-empty">No Claude or Codex agents running</div>';
    if (pane._cockpitRenderHtml !== paneHtml) {
      pane.innerHTML = paneHtml;
      pane._cockpitRenderHtml = paneHtml;
    }
    setupEvents(pane);
  }
  document.querySelectorAll('[data-agent-wall-action="mode"]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  });
  setupEvents(wall);
}

export function updateAgentWall() {
  if (!opsTimer) {
    const refreshOps = async () => {
      // 관제 벽을 화면에서 안 보는 동안엔 API 폴링·전체 재렌더를 쉰다 —
      // 터미널 작업 중 상시 CPU·네트워크 부하의 원인이었음.
      const stage = document.getElementById('agent-wall-stage');
      if (!stage || stage.offsetParent === null) return;
      const [nextDecisions, nextAgentEvents, nextSummaries] = await Promise.all([
        fetchJson('/api/supervisor/recent?n=30', { timeoutMs: 3000 }).catch(() => null),
        fetchJson('/api/supervisor/agents', { timeoutMs: 3000 }).catch(() => null),
        fetchJson('/api/supervisor/summaries', { timeoutMs: 3000 }).catch(() => null),
      ]);
      if (Array.isArray(nextDecisions)) decisions = nextDecisions;
      if (Array.isArray(nextAgentEvents)) agentEvents = nextAgentEvents;
      if (nextSummaries && typeof nextSummaries === 'object') summaries = nextSummaries;
      render();
      const projectIds = [...new Set([...app.termMap.entries()]
        .filter(([termId, t]) => !t.exited && detectKind(termId, t, tail(t.xterm)))
        .map(([, t]) => t.projectId))];
      const staleProjectIds = projectIds.filter(id => Date.now() - (ciFetchedAt.get(id) || 0) > 30_000);
      await Promise.all(staleProjectIds.map(async id => {
        ciFetchedAt.set(id, Date.now());
        const branch = app.state.projects.get(id)?.git?.branch;
        const query = new URLSearchParams({ limit: '20', ...(branch ? { branch } : {}) });
        try { ciByProject.set(id, await fetchJson(`/api/cicd/runs/${encodeURIComponent(id)}?${query}`, { timeoutMs: 10_000 })); }
        catch { ciByProject.set(id, null); }
      }));
      if (staleProjectIds.length) render();
    };
    refreshOps();
    opsTimer = setInterval(refreshOps, 5000);
  }
  const sessionList = document.querySelector('[data-canvas-session-list]');
  if (sessionList && sessionList.dataset.initialized !== '1') {
    render();
    return;
  }
  if (timer) return;
  timer = setTimeout(() => { timer = null; render(); }, 250);
}

window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.data?.type !== 'cockpit-open-terminal' || !app.termMap.has(e.data.termId)) return;
  app.activeTermId = e.data.termId;
  notify('switchView', 'terminal');
  notify('renderLayout');
});
