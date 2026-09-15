// ─── Dashboard Core: SSE, notifications, stats, views, theme ───
import { app, notify } from './state.js';
import { esc, timeAgo, showToast, fmtTok, timeUntil, row, fetchJson, postJson, simpleMarkdown } from './utils.js';
import { registerClickActions, registerChangeActions, registerInputActions } from './actions.js';
import { restoreTerminalPanels } from './agent-wall.js';

// ─── Re-export from sub-modules ───
export {
  renderCard, cardHTML, renderAllCards, renderSkeletons,
  togglePin, savePins, setProjectSort, sortAndRenderProjects,
  setProjectFilter, filterProjects,
  getProjectTags, setProjectTag, getTagColor, renderTagFilters,
  updateScrollIndicators, jumpToChanges, updateEmptyProjectState,
  fetchAllProjects, pullAllProjects,
  initDashboardCards,
} from './dashboard-cards.js';

export {
  setChartPeriod, renderCosts, fetchUsage, renderUsage, updateUsageTimestamp,
} from './dashboard-charts.js';

// Import for internal use (SSE, action registration, init)
import { renderCard, initDashboardCards, setProjectFilter, filterProjects, setProjectSort } from './dashboard-cards.js';
import { renderCosts, renderUsage, fetchUsage, updateUsageTimestamp, setChartPeriod } from './dashboard-charts.js';

// ─── Notifications ───
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

export function notifySessionChange(projectId, oldState, newState) {
  if (!app.notifyEnabled) return;
  if (!isNotifEnabledForProject(projectId)) return;
  const project = app.projectList.find(p => p.id === projectId);
  const name = project?.name || projectId;
  const wasActive = oldState === 'busy' || oldState === 'waiting';
  let title = '', body = '';
  if (wasActive && newState === 'idle') {
    title = `${name} — Session Complete`;
    body = 'Claude session finished.';
  } else if (wasActive && (newState === 'no_data' || newState === 'no_sessions')) {
    title = `${name} — Session Ended`;
    body = 'Claude session disconnected.';
  }
  if (!title) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, tag: `session-${projectId}`, silent: false });
    } catch { /* notification API unavailable */ }
  }
  playNotifSound();
  flashTitle(title);
}

// ─── Audio notification (reuse single AudioContext) ───
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}

function playNotifSound() {
  try {
    const ctx = getAudioCtx();
    [0, 0.15].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = i === 0 ? 880 : 1100;
      gain.gain.setValueAtTime(0.3, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + offset + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.3);
    });
  } catch { /* audio API unavailable */ }
}

// ─── Title flash ───
let _flashTimer = null;
function flashTitle(msg) {
  if (_flashTimer) clearInterval(_flashTimer);
  const orig = document.title;
  let on = true;
  _flashTimer = setInterval(() => {
    document.title = on ? `🔔 ${msg}` : orig;
    on = !on;
  }, 800);
  const stop = () => {
    if (_flashTimer) { clearInterval(_flashTimer); _flashTimer = null; }
    document.title = orig;
    window.removeEventListener('focus', stop);
  };
  window.addEventListener('focus', stop);
  setTimeout(stop, 10000);
}

// ─── Clock ───
export function updateClock() {
  const now = new Date();
  document.getElementById('header-clock').textContent = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function startClock() {
  app._clockTimer = setInterval(updateClock, 1000);
  updateClock();
}

// ─── Activity Log ───
const MAX_ACTIVITY = 50;
const _activityLog = [];

export function addActivity(icon, text) {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  _activityLog.unshift({ icon, text, time });
  if (_activityLog.length > MAX_ACTIVITY) _activityLog.length = MAX_ACTIVITY;
  renderActivityLog();
}

function renderActivityLog() {
  const section = document.getElementById('activity-log-section');
  const list = document.getElementById('activity-log-list');
  if (!section || !list) return;
  if (_activityLog.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  list.innerHTML = _activityLog.slice(0, 15).map(a =>
    `<div class="al-item"><span class="al-icon">${a.icon}</span><span class="al-text">${esc(a.text)}</span><span class="al-time">${a.time}</span></div>`
  ).join('');
}

// ─── SSE ───
let _currentES = null;
export function connectSSE() {
  setConn('reconnecting');
  if (app._sseReconnTimer) { clearTimeout(app._sseReconnTimer); app._sseReconnTimer = null; }
  if (_currentES) { try { _currentES.close(); } catch { /* already closed */ } _currentES = null; }
  const es = new EventSource('/api/events');
  _currentES = es;
  es.addEventListener('init', e => {
    app._sseBackoff = 1000;
    app._sseConnectedAt = Date.now();
    const d = JSON.parse(e.data);
    if (d.sessions) Object.entries(d.sessions).forEach(([k, v]) => {
      if (v) { upd(k, 'session', v); app.prevSessionStates.set(k, v.state); }
    });
    if (d.git) Object.entries(d.git).forEach(([k, v]) => { if (v) upd(k, 'git', v); });
    if (d.prs) Object.entries(d.prs).forEach(([k, v]) => { if (v) upd(k, 'prs', v); });
    if (d.costs) { app.state.usage = d.costs; renderCosts(); renderUsage(); }
    if (d.devServers) { app.devServerState = d.devServers; notify('updateDevBadge'); }
    if (d.nodeVersion) app.nodeVersion = d.nodeVersion;
    const changedIds = new Set();
    if (d.sessions) Object.keys(d.sessions).forEach(k => changedIds.add(k));
    if (d.git) Object.keys(d.git).forEach(k => changedIds.add(k));
    if (d.prs) Object.keys(d.prs).forEach(k => changedIds.add(k));
    if (changedIds.size > 0) changedIds.forEach(id => renderCard(id));
    else app.projectList.forEach(p => renderCard(p.id));
    updateSummaryStats();
    fetchUsage();
    setConn(true);
  });
  es.addEventListener('session:status', e => {
    const d = JSON.parse(e.data);
    const oldState = app.prevSessionStates.get(d.projectId);
    const newState = d.state;
    if (oldState && oldState !== newState) {
      notifySessionChange(d.projectId, oldState, newState);
      const pName = app.projectList.find(p => p.id === d.projectId)?.name || d.projectId;
      const icons = { busy: '\u25B6', waiting: '\u23F8', idle: '\u23F9', no_data: '\u2013', no_sessions: '\u2013' };
      addActivity(icons[newState] || '\u2022', `${pName}: ${oldState} \u2192 ${newState}`);
    }
    app.prevSessionStates.set(d.projectId, newState);
    upd(d.projectId, 'session', d);
    queueRender(d.projectId);
    notify('debouncedUpdateTermHeaders');
  });
  es.addEventListener('git:update', e => {
    const d = JSON.parse(e.data);
    upd(d.projectId, 'git', d);
    queueRender(d.projectId);
    notify('debouncedUpdateTermHeaders');
    notify('populateProjectSelects');
    notify('renderProjectChips');
    if (document.getElementById('diff-view')?.classList.contains('active')) {
      const sel = document.getElementById('diff-project');
      if (sel?.value === d.projectId) notify('debouncedLoadDiff');
    }
  });
  es.addEventListener('pr:update', e => {
    const d = JSON.parse(e.data);
    upd(d.projectId, 'prs', d);
    queueRender(d.projectId);
  });
  es.addEventListener('cost:update', e => {
    app.state.usage = JSON.parse(e.data);
    renderCosts();
    renderUsage();
    queueStats();
  });
  es.addEventListener('dev:status', e => {
    const d = JSON.parse(e.data);
    const newRunning = d.running || [];
    const runIds = new Set(newRunning.map(ds => ds.projectId));
    for (const key of app._knownPorts) {
      if (!runIds.has(key.split(':')[0])) app._knownPorts.delete(key);
    }
    app.devServerState = newRunning;
    for (const ds of newRunning) {
      if (ds.port && app._devStartTimeouts.has(ds.projectId)) {
        clearTimeout(app._devStartTimeouts.get(ds.projectId));
        app._devStartTimeouts.delete(ds.projectId);
      }
    }
    notify('updateDevBadge');
    app.devServerState.forEach(ds => queueRender(ds.projectId));
    app.projectList.forEach(p => {
      if (!app.devServerState.some(ds => ds.projectId === p.id)) queueRender(p.id);
    });
  });
  es.addEventListener('workflow:update', e => { notify('handleWorkflowEvent', { event: 'workflow:update', data: JSON.parse(e.data) }); });
  es.addEventListener('workflow:complete', e => { notify('handleWorkflowEvent', { event: 'workflow:complete', data: JSON.parse(e.data) }); });
  es.addEventListener('workflow:error', e => { notify('handleWorkflowEvent', { event: 'workflow:error', data: JSON.parse(e.data) }); });
  es.addEventListener('schedule:fired', e => { notify('handleWorkflowEvent', { event: 'schedule:fired', data: JSON.parse(e.data) }); });
  es.addEventListener('schedule:update', e => { notify('handleWorkflowEvent', { event: 'schedule:update', data: JSON.parse(e.data) }); });
  es.addEventListener('schedule:error', e => { notify('handleWorkflowEvent', { event: 'schedule:error', data: JSON.parse(e.data) }); });

  // AI 계정 변화 — 로그인 터미널에서 credential 파일이 생기면 서버가 쏨
  es.addEventListener('ai-accounts:changed', () => { notify('aiAccountsChanged'); });
  // Helper: dispatch DOM event for company view listeners
  const emitDOM = (name, data) => document.dispatchEvent(new CustomEvent(name, { detail: data }));
  es.addEventListener('agent:start', e => { const d = JSON.parse(e.data); notify('handleAgentEvent', { event: 'agent:start', data: d }); emitDOM('agent:start', d); });
  es.addEventListener('agent:thinking', e => { const d = JSON.parse(e.data); notify('handleAgentEvent', { event: 'agent:thinking', data: d }); emitDOM('agent:thinking', d); });
  es.addEventListener('agent:thinking-text', e => { notify('handleAgentEvent', { event: 'agent:thinking-text', data: JSON.parse(e.data) }); });
  es.addEventListener('agent:step', e => { notify('handleAgentEvent', { event: 'agent:step', data: JSON.parse(e.data) }); });
  es.addEventListener('agent:tool', e => { const d = JSON.parse(e.data); notify('handleAgentEvent', { event: 'agent:tool', data: d }); emitDOM('agent:tool', d); });
  es.addEventListener('agent:tool-result', e => { const d = JSON.parse(e.data); notify('handleAgentEvent', { event: 'agent:tool-result', data: d }); emitDOM('agent:tool-result', d); });
  es.addEventListener('agent:response', e => { const d = JSON.parse(e.data); notify('handleAgentEvent', { event: 'agent:response', data: d }); emitDOM('agent:response', d); });
  es.addEventListener('agent:done', e => { const d = JSON.parse(e.data); notify('handleAgentEvent', { event: 'agent:done', data: d }); emitDOM('agent:done', d); });
  es.addEventListener('agent:error', e => { const d = JSON.parse(e.data); notify('handleAgentEvent', { event: 'agent:error', data: d }); emitDOM('agent:error', d); });
  es.addEventListener('agent:streaming', e => { notify('handleAgentEvent', { event: 'agent:streaming', data: JSON.parse(e.data) }); });
  es.addEventListener('agent:warning', e => { notify('handleAgentEvent', { event: 'agent:warning', data: JSON.parse(e.data) }); });
  es.addEventListener('agent:edit-backup', e => { notify('handleAgentEvent', { event: 'agent:edit-backup', data: JSON.parse(e.data) }); });
  es.addEventListener('agent:proactive', e => { const d = JSON.parse(e.data); notify('handleAgentEvent', { event: 'agent:proactive', data: d }); emitDOM('agent:proactive', d); });
  es.addEventListener('monitor:review-start', e => { const d = JSON.parse(e.data); emitDOM('monitor:review-start', d); });
  es.addEventListener('monitor:report', e => { const d = JSON.parse(e.data); emitDOM('monitor:report', d); });
  // Orchestration events
  const orchEvents = ['orch:start','orch:plan','orch:sub-start','orch:sub-thinking','orch:sub-tool','orch:sub-tool-result','orch:sub-streaming','orch:sub-done','orch:sub-error','orch:synthesizing','orch:response','orch:done','orch:streaming'];
  for (const evt of orchEvents) {
    es.addEventListener(evt, e => { const d = JSON.parse(e.data); notify('handleAgentEvent', { event: evt, data: d }); emitDOM(evt, d); });
  }
  // Sprint events
  const sprintEvents = ['sprint:start','sprint:phase','sprint:log','sprint:validate','sprint:done','sprint:error','sprint:stopped','sprint:cost','sprint:agent'];
  for (const evt of sprintEvents) {
    es.addEventListener(evt, e => { const d = JSON.parse(e.data); emitDOM(evt, d); });
  }
  // Project Plan events
  const projectEvents = ['project:plan','project:plan-generating','project:feature-update','project:progress','project:done','project:error','project:log'];
  for (const evt of projectEvents) {
    es.addEventListener(evt, e => { const d = JSON.parse(e.data); notify('handleProjectPlanEvent', { event: evt, data: d }); emitDOM(evt, d); });
  }
  es.onerror = () => {
    setConn(false);
    es.close();
    _currentES = null;
    if (_rafPending) { cancelAnimationFrame(_rafPending); _rafPending = null; }
    _dirtyCards.clear(); _statsDirty = false;
    if (app._sseConnectedAt && Date.now() - app._sseConnectedAt > 30000) app._sseBackoff = 1000;
    const jitter = Math.random() * 500;
    app._sseBackoff = Math.min(app._sseBackoff * 1.5, 10000);
    app._sseReconnTimer = setTimeout(connectSSE, app._sseBackoff + jitter);
  };
}

function upd(id, k, v) {
  if (!app.state.projects.has(id)) app.state.projects.set(id, {});
  app.state.projects.get(id)[k] = v;
}

// ─── RAF-batched rendering: queue dirty cards, flush once per frame ───
const _dirtyCards = new Set();
let _rafPending = null;
let _statsDirty = false;

function queueRender(id) {
  _dirtyCards.add(id);
  _statsDirty = true;
  if (!_rafPending) _rafPending = requestAnimationFrame(flushRenders);
}

function queueStats() {
  _statsDirty = true;
  if (!_rafPending) _rafPending = requestAnimationFrame(flushRenders);
}

function flushRenders() {
  _rafPending = null;
  for (const id of _dirtyCards) renderCard(id);
  _dirtyCards.clear();
  if (_statsDirty) { _statsDirty = false; updateSummaryStats(); }
}

function setConn(status) {
  const connected = status === true || status === 'connected';
  const reconnecting = status === 'reconnecting';
  app.state.connected = connected;
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('connection-status');
  if (dot) dot.className = 'conn-dot' + (connected ? '' : reconnecting ? ' reconnecting' : ' off');
  if (label) label.textContent = connected ? 'Connected' : reconnecting ? 'Reconnecting' : 'Disconnected';
}

// ─── Summary Stats ───
export function updateSummaryStats() {
  let active = 0, totalPrs = 0, totalUncommitted = 0;
  for (const [, p] of app.state.projects) {
    if (p.session?.state === 'busy' || p.session?.state === 'waiting') active++;
    totalPrs += p.prs?.prs?.length || 0;
    totalUncommitted += p.git?.uncommittedCount || 0;
  }
  const elActive = document.getElementById('stat-active');
  const elPrs = document.getElementById('stat-prs');
  const elUncommitted = document.getElementById('stat-uncommitted');
  const elToday = document.getElementById('stat-today');
  if (elActive) elActive.textContent = active;
  if (elPrs) elPrs.textContent = totalPrs;
  if (elUncommitted) elUncommitted.textContent = totalUncommitted;
  if (elToday && app.state.usage?.today) elToday.textContent = fmtTok(app.state.usage.today.outputTokens || 0);
  document.title = active > 0 ? `(${active}) Cockpit` : 'Cockpit';
  updateFavicon(active);
  updateTabBadges(totalUncommitted);
  renderSmartActions();
}

// ─── Smart Actions ───
export function renderSmartActions() {
  const el = document.getElementById('smart-actions');
  if (!el) return;
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      switch (btn.dataset.action) {
        case 'sa-nav': switchView(btn.dataset.view); if (btn.dataset.extra === 'new-term') notify('openNewTermModal'); break;
        case 'sa-conv-list': showConvList(); break;
        case 'sa-cmd-palette': notify('toggleCommandPalette'); break;
      }
    });
  }

  const actions = [];
  const projects = app.state?.projects || new Map();
  const projectList = app.projectList || [];
  const getName = id => projectList.find(p => p.id === id)?.name || id;

  // 1. Uncommitted changes
  const uncommittedProjects = [];
  for (const [id, p] of projects) {
    const cnt = p.git?.uncommittedCount || 0;
    if (cnt > 0) uncommittedProjects.push({ id, name: getName(id), count: cnt, branch: p.git?.branch });
  }
  if (uncommittedProjects.length > 0) {
    const total = uncommittedProjects.reduce((s, p) => s + p.count, 0);
    const names = uncommittedProjects.slice(0, 2).map(p => p.name).join(', ');
    const extra = uncommittedProjects.length > 2 ? ` +${uncommittedProjects.length - 2}` : '';
    actions.push({
      type: 'warning', icon: '📝',
      title: `${total}개 파일 변경됨`,
      desc: `${names}${extra}`,
      label: 'Changes', saAction: 'sa-nav', saView: 'diff'
    });
  }

  // 2. Active sessions
  const activeSessions = [];
  for (const [id, p] of projects) {
    if (p.session?.state === 'busy') activeSessions.push({ id, name: getName(id), model: p.session.model });
    else if (p.session?.state === 'waiting') activeSessions.push({ id, name: getName(id), model: p.session.model, waiting: true });
  }
  if (activeSessions.length > 0) {
    const busy = activeSessions.filter(s => !s.waiting).length;
    const waiting = activeSessions.filter(s => s.waiting).length;
    const parts = [];
    if (busy) parts.push(`${busy} working`);
    if (waiting) parts.push(`${waiting} waiting`);
    actions.push({
      type: 'info', icon: '🤖',
      title: `${activeSessions.length}개 세션 활성`,
      desc: parts.join(', '),
      label: 'Sessions', saAction: 'sa-conv-list'
    });
  }

  // 3. Open PRs
  const allPrs = [];
  for (const [id, p] of projects) {
    for (const pr of (p.prs?.prs || [])) {
      allPrs.push({ ...pr, project: getName(id) });
    }
  }
  const needsReview = allPrs.filter(pr => pr.reviewDecision === 'CHANGES_REQUESTED');
  const approved = allPrs.filter(pr => pr.reviewDecision === 'APPROVED');
  if (needsReview.length > 0) {
    actions.push({
      type: 'danger', icon: '🔴',
      title: `PR ${needsReview.length}개 수정 요청`,
      desc: needsReview.slice(0, 2).map(pr => `#${pr.number} ${pr.project}`).join(', '),
      label: 'View', saAction: 'sa-nav', saView: 'diff'
    });
  } else if (approved.length > 0) {
    actions.push({
      type: 'success', icon: '✅',
      title: `PR ${approved.length}개 승인됨`,
      desc: approved.slice(0, 2).map(pr => `#${pr.number}`).join(', '),
      label: 'Merge', saAction: 'sa-nav', saView: 'diff'
    });
  } else if (allPrs.length > 0) {
    actions.push({
      type: 'info', icon: '🔵',
      title: `PR ${allPrs.length}개 오픈`,
      desc: allPrs.slice(0, 2).map(pr => `#${pr.number} ${pr.project}`).join(', '),
      label: 'View', saAction: 'sa-nav', saView: 'diff'
    });
  }

  // 4. Usage today
  const usage = app.state?.usage?.today;
  if (usage && usage.outputTokens > 0) {
    const cost = typeof usage.apiEquivCost === 'number' ? `$${usage.apiEquivCost.toFixed(2)}` : '';
    actions.push({
      type: 'neutral', icon: '📊',
      title: `오늘 ${fmtTok(usage.outputTokens)} tokens`,
      desc: `${usage.messages || 0} msgs · ${usage.sessions || 0} sessions${cost ? ' · ' + cost : ''}`,
      label: ''
    });
  }

  // 5. No actions — all clear
  if (actions.length === 0) {
    el.innerHTML = `<div class="sa-empty">
      <span class="sa-empty-icon">👋</span>
      <span class="sa-empty-text">모든 프로젝트 상태 정상</span>
      <div class="sa-quick-links">
        <button class="sa-link" data-action="sa-nav" data-view="terminal" data-extra="new-term">Terminal</button>
        <button class="sa-link" data-action="sa-nav" data-view="diff">Changes</button>
        <button class="sa-link" data-action="sa-nav" data-view="jira">Jira</button>
        <button class="sa-link" data-action="sa-cmd-palette">Commands <kbd>Ctrl+K</kbd></button>
      </div>
    </div>`;
    return;
  }

  el.innerHTML = actions.map(a => `<div class="sa-card sa-${a.type}">
    <span class="sa-icon">${a.icon}</span>
    <div class="sa-body">
      <div class="sa-title">${esc(a.title)}</div>
      <div class="sa-desc">${esc(a.desc)}</div>
    </div>
    ${a.label ? `<button class="sa-action" data-action="${a.saAction}"${a.saView ? ` data-view="${a.saView}"` : ''}>${a.label}</button>` : ''}
  </div>`).join('');
}

// ─── Tab Badges ───
export function updateTabBadges(uncommitted) {
  const termTab = document.querySelector('.nav-tab[aria-controls="terminal-view"]');
  const diffTab = document.querySelector('.nav-tab[aria-controls="diff-view"]');
  if (termTab) {
    const count = app.termMap?.size || 0;
    let badge = termTab.querySelector('.tab-badge');
    if (count > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'tab-badge'; termTab.appendChild(badge); }
      badge.textContent = count;
    } else if (badge) { badge.remove(); }
  }
  if (diffTab) {
    let badge = diffTab.querySelector('.tab-badge');
    if (uncommitted > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'tab-badge warn'; diffTab.appendChild(badge); }
      badge.textContent = uncommitted;
    } else if (badge) { badge.remove(); }
  }
}

// ─── Dynamic Favicon ───
function updateFavicon(activeCount) {
  if (!app._faviconLink) {
    app._faviconLink = document.querySelector('link[rel="icon"]');
    if (!app._faviconLink) {
      app._faviconLink = document.createElement('link');
      app._faviconLink.rel = 'icon';
      app._faviconLink.type = 'image/svg+xml';
      document.head.appendChild(app._faviconLink);
    }
  }
  const color = activeCount > 0 ? '%2334d399' : '%23818cf8';
  app._faviconLink.href = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="${color}"/>${activeCount > 0 ? `<text x="50" y="68" text-anchor="middle" font-size="50" font-weight="bold" fill="white">${activeCount}</text>` : '<path d="M35 50L45 60L65 40" stroke="white" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>`;
}

// ─── View Switching ───
const _viewInited = new Set(); // Track which views have completed first init
const _viewScrollTops = new WeakMap();

function rememberScrollTree(root) {
  if (!root) return;
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (el.scrollTop) _viewScrollTops.set(el, el.scrollTop);
  }
}

function restoreScrollTree(root) {
  if (!root) return;
  const restore = () => {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!_viewScrollTops.has(el)) continue;
      const top = _viewScrollTops.get(el);
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.min(top, maxTop);
    }
  };
  restore();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
}

export function switchView(name) {
  if (['agent', 'company', 'supervisor'].includes(name)) name = 'dashboard';
  const currentView = document.querySelector('.view.active');
  const currentName = currentView?.id?.replace('-view', '');
  if (currentName === name) {
    if (name === 'terminal') restoreTerminalPanels();
    applyViewZoom(name);
    setupNavOverflow();
    try { localStorage.setItem('dl-view', name); } catch { /* storage unavailable */ }
    return;
  }
  if (name === 'terminal') restoreTerminalPanels();
  rememberScrollTree(currentView);
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const viewEl = document.getElementById(`${name}-view`);
  if (viewEl) viewEl.classList.add('active');
  restoreScrollTree(viewEl);
  // Apply per-tab zoom level
  applyViewZoom(name);
  document.querySelectorAll('.nav-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  const activeTab = document.querySelector(`.nav-tab[aria-controls="${name}-view"]`);
  if (activeTab) { activeTab.classList.add('active'); activeTab.setAttribute('aria-selected', 'true'); }
  setupNavOverflow();
  const safeInit = (fn) => { try { const r = fn(); if (r?.catch) r.catch(e => console.error('[View]', name, e)); } catch (e) { console.error('[View]', name, e); } };
  // Cleanup timers from views we're leaving
  if (name !== 'ports') try { notify('destroyPorts'); } catch { /* cleanup failed */ }
  // Always-refresh views (need update on every visit)
  if (name === 'terminal') { safeInit(() => notify('renderLayout')); setTimeout(() => notify('fitAllTerminals'), 200); }
  if (name === 'diff') safeInit(() => notify('loadDiff'));
  if (name === 'ai-accounts') safeInit(() => notify('initAiAccounts'));
  if (name === 'notes') safeInit(() => notify('initNotes'));
  // First-visit-only init views (each module also has internal guards)
  const viewInitMap = { pr: 'initPR', cicd: 'initCicd', workflows: 'initWorkflows', ports: 'initPorts', autopilot: 'initAutopilotView' };
  if (name in viewInitMap) {
    if (!_viewInited.has(name)) {
      _viewInited.add(name);
      safeInit(() => notify(viewInitMap[name]));
    } else if (name === 'ports') {
      // Ports needs restart on re-visit (timer re-init)
      safeInit(() => notify('initPorts'));
    }
  }
  try { localStorage.setItem('dl-view', name); } catch { /* storage unavailable */ }
}

// ─── Per-Tab Zoom ───

function _getActiveViewName() {
  const el = document.querySelector('.view.active');
  return el?.id?.replace('-view', '') || null;
}

export function applyViewZoom(name) {
  const viewEl = document.getElementById(`${name}-view`);
  if (!viewEl) return;
  const zoom = app.viewZoom[name] || 100;
  viewEl.style.zoom = zoom === 100 ? '' : `${zoom}%`;
  _showZoomIndicator(zoom);
}

export function changeViewZoom(delta) {
  const name = _getActiveViewName();
  if (!name) return;
  const current = app.viewZoom[name] || 100;
  const next = Math.max(50, Math.min(200, current + delta));
  app.viewZoom[name] = next;
  try { localStorage.setItem('dl-view-zoom', JSON.stringify(app.viewZoom)); } catch { /* storage unavailable */ }
  applyViewZoom(name);
  // Refit terminals if terminal tab
  if (name === 'terminal') setTimeout(() => notify('fitAllTerminals'), 100);
}

export function resetViewZoom() {
  const name = _getActiveViewName();
  if (!name) return;
  delete app.viewZoom[name];
  try { localStorage.setItem('dl-view-zoom', JSON.stringify(app.viewZoom)); } catch { /* storage unavailable */ }
  applyViewZoom(name);
  if (name === 'terminal') setTimeout(() => notify('fitAllTerminals'), 100);
}

function _showZoomIndicator(zoom) {
  let el = document.getElementById('zoom-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'zoom-indicator';
    el.style.cssText = 'position:fixed;bottom:60px;right:20px;background:var(--bg-2);color:var(--text-1);border:1px solid var(--border);padding:4px 12px;border-radius:8px;font-size:13px;font-weight:600;z-index:9999;opacity:0;transition:opacity .2s;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = `${zoom}%`;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.style.opacity = '0', 1200);
}

// ─── Recent Conversations ───
export async function showConvList() {
  const overlay = document.getElementById('conv-overlay');
  if (!overlay.dataset.delegated) {
    overlay.dataset.delegated = '1';
    overlay.addEventListener('click', e => {
      const el = e.target.closest('[data-action="open-conv"]');
      if (el) { closeConvList(); window.openTermWith?.(el.dataset.pid, 'claude --continue'); }
    });
  }
  const body = document.getElementById('conv-body');
  body.innerHTML = '<div class="conv-empty">Loading...</div>';
  overlay.classList.remove('hidden');
  try {
    const data = await fetchJson('/api/activity');
    if (!data.length) { body.innerHTML = '<div class="conv-empty">No recent conversations</div>'; return; }
    let html = '', lastDate = '';
    for (const e of data) {
      const d = e.timestamp?.slice(0, 10) || '';
      if (d !== lastDate) {
        const label = d === new Date().toISOString().slice(0, 10) ? 'Today' : d === new Date(Date.now() - 86400000).toISOString().slice(0, 10) ? 'Yesterday' : d;
        html += `<div class="conv-group-date">${label}</div>`;
        lastDate = d;
      }
      const msg = (e.command || '').replace(/\[Pasted text[^\]]*\]\s*/g, '').trim() || '(no message)';
      const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
      const proj = app.projectList.find(p => e.projectPath && p.path.replace(/\\/g, '/').toLowerCase() === e.projectPath.toLowerCase());
      const pid = proj ? proj.id : '';
      html += `<div class="conv-item${pid ? ' clickable' : ''}" ${pid ? `data-action="open-conv" data-pid="${pid}" style="cursor:pointer" title="Open terminal with --continue"` : ''}>
        <span class="conv-project" title="${esc(e.projectPath || '')}">${esc(e.project || '?')}</span>
        <div class="conv-info">
          <div class="conv-msg" title="${esc(msg)}">${esc(msg)}</div>
          <div class="conv-time">${time}</div>
        </div>
      </div>`;
    }
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="conv-empty">Error: ${esc(err.message)}</div>`;
  }
}

export function closeConvList() {
  document.getElementById('conv-overlay').classList.add('hidden');
}

// ─── Theme Toggle ───
export function applyTheme(theme) {
  app.currentTheme = theme;
  document.body.classList.toggle('light-theme', theme === 'light');
  document.getElementById('theme-icon-dark').style.display = theme === 'dark' ? '' : 'none';
  document.getElementById('theme-icon-light').style.display = theme === 'light' ? '' : 'none';
}

export function toggleTheme() {
  app._themeManual = true;
  applyTheme(app.currentTheme === 'dark' ? 'light' : 'dark');
  localStorage.setItem('dl-theme', app.currentTheme);
  notify('updateTermTheme');
  showToast(`${app.currentTheme === 'light' ? 'Light' : 'Dark'} theme`, 'info');
}

// ─── Notification Toggle ───
export function toggleNotifications() {
  app.notifyEnabled = !app.notifyEnabled;
  localStorage.setItem('dl-notify', app.notifyEnabled);
  const btn = document.getElementById('notify-toggle');
  if (btn) {
    btn.textContent = app.notifyEnabled ? 'On' : 'Off';
    btn.className = 'btn' + (app.notifyEnabled ? '' : ' off-btn');
  }
  showToast(app.notifyEnabled ? 'Notifications enabled' : 'Notifications disabled', 'info');
  postJson('/api/notify/toggle', { enabled: app.notifyEnabled }).catch(() => {});
}

// ─── Notification Filter (per-project) ───
export function isNotifEnabledForProject(projectId) {
  return app._notifFilter[projectId] !== false;
}

export function saveNotifFilter() {
  localStorage.setItem('dl-notif-filter', JSON.stringify(app._notifFilter));
}

export function toggleProjectNotif(projectId) {
  app._notifFilter[projectId] = !isNotifEnabledForProject(projectId);
  saveNotifFilter();
  notify('renderNotifFilterList');
}

// ─── Adaptive Polling ───
export function onVisibilityChange() {
  if (document.hidden) {
    clearInterval(app._clockTimer); app._clockTimer = null;
    if (app.usageTimer) { clearInterval(app.usageTimer); app.usageTimer = null; }
  } else {
    if (!app._clockTimer) app._clockTimer = setInterval(updateClock, 1000);
    updateClock();
    if (!app.usageTimer) app.usageTimer = setInterval(fetchUsage, 60000);
  }
  postJson('/api/polling-speed', { multiplier: document.hidden ? 5 : 1 }).catch(() => {});
}

// ─── Tab Overflow "More" Dropdown ───
export function setupNavOverflow() {
  const wrap = document.getElementById('nav-more-wrap');
  if (!wrap) return;
  const tabs = [...document.querySelectorAll('.nav-tabs > .nav-tab')];
  const menu = document.getElementById('nav-more-menu');
  if (!menu) return;
  if (document.body.classList.contains('terminal-first-shell') && !window.matchMedia('(max-width: 600px)').matches) {
    tabs.forEach(t => t.classList.remove('overflow-hidden'));
    menu.innerHTML = '';
    menu.classList.remove('open');
    wrap.style.display = 'none';
    return;
  }
  const header = document.querySelector('header');
  const logo = document.querySelector('.logo');
  const headerRight = document.querySelector('.header-right');
  if (!header || !headerRight) return;

  // 1. Show all tabs + More to measure
  tabs.forEach(t => t.classList.remove('overflow-hidden'));
  wrap.classList.add('visible');
  wrap.style.display = 'block';

  // 2. Calculate available space for tabs
  const headerW = header.clientWidth;
  const logoW = logo ? logo.offsetWidth : 0;
  const rightW = headerRight.offsetWidth;
  const moreBtn = document.getElementById('nav-more-btn');
  const moreBtnW = moreBtn ? moreBtn.offsetWidth + 8 : 60;
  const headerGap = 10; // gap between logo, tabs, right
  const available = headerW - logoW - rightW - moreBtnW - headerGap * 3;

  // 3. Find how many tabs fit
  let usedW = 0;
  let threshold = tabs.length;
  for (let i = 0; i < tabs.length; i++) {
    usedW += tabs[i].offsetWidth + 1; // +1 for gap
    if (usedW > available) {
      threshold = i;
      break;
    }
  }
  if (window.matchMedia('(max-width: 600px)').matches) threshold = Math.min(threshold, 4);

  // 4. Apply
  menu.innerHTML = '';
  let hasOverflow = false;
  tabs.forEach((tab, i) => {
    if (i >= threshold) {
      hasOverflow = true;
      tab.classList.add('overflow-hidden');
      const item = document.createElement('button');
      item.className = 'nav-more-item' + (tab.classList.contains('active') ? ' active' : '');
      item.innerHTML = tab.querySelector('svg')?.outerHTML + '<span>' + (tab.querySelector('.tab-label')?.textContent || tab.textContent.trim()) + '</span>';
      item.onclick = () => { tab.click(); closeNavMore(); };
      menu.appendChild(item);
    }
  });
  wrap.classList.toggle('visible', hasOverflow);
  if (!hasOverflow) wrap.style.display = '';
  // Show More btn highlight if any overflow tab is active
  if (moreBtn) moreBtn.classList.toggle('active', tabs.slice(threshold).some(t => t.classList.contains('active')));

  // Add Settings item (visible on mobile where header-right is hidden)
  if (window.matchMedia('(max-width: 600px)').matches) {
    const divider = document.createElement('div');
    divider.className = 'nav-more-divider';
    menu.appendChild(divider);
    const settingsItem = document.createElement('button');
    settingsItem.className = 'nav-more-item';
    settingsItem.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg><span>Settings</span>';
    settingsItem.onclick = () => { document.querySelector('[data-action="open-settings"]')?.click(); closeNavMore(); };
    menu.appendChild(settingsItem);
  }
}

export function toggleNavMore() {
  const menu = document.getElementById('nav-more-menu');
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  menu.classList.toggle('open', !isOpen);
  if (!isOpen) {
    // Update active states in menu
    const tabs = document.querySelectorAll('.nav-tabs > .nav-tab');
    const items = menu.querySelectorAll('.nav-more-item');
    let idx = 0;
    tabs.forEach((tab, i) => {
      if (tab.classList.contains('overflow-hidden') && items[idx]) {
        items[idx].classList.toggle('active', tab.classList.contains('active'));
        idx++;
      }
    });
    // Close on outside click
    setTimeout(() => {
      const handler = (e) => { if (!menu.contains(e.target) && e.target.id !== 'nav-more-btn') { closeNavMore(); document.removeEventListener('click', handler); } };
      document.addEventListener('click', handler);
    }, 0);
  }
}

function closeNavMore() {
  const menu = document.getElementById('nav-more-menu');
  if (menu) menu.classList.remove('open');
}

// ──────────── Session Timeline ────────────

export async function showSessionTimeline(projectId, sessionId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal timeline-modal"><div class="modal-header"><h3>Session Timeline</h3><button class="modal-close" data-action="close-overlay">&times;</button></div><div class="modal-body"><div class="timeline-loading">Loading timeline...</div></div></div>`;
  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-action="close-overlay"]')) overlay.remove();
  });
  document.body.appendChild(overlay);

  try {
    const data = await fetchJson(`/api/projects/${projectId}/sessions/${sessionId}/timeline`);
    if (data.error) throw new Error(data.error);

    const body = overlay.querySelector('.modal-body');
    const s = data.summary;
    const events = data.events || [];

    body.innerHTML = `
      <div class="tl-summary">
        <div class="tl-sum-row"><span>Model</span><span>${esc(s?.model || '-')}</span></div>
        <div class="tl-sum-row"><span>Messages</span><span>${s?.messageCount || 0}</span></div>
        <div class="tl-sum-row"><span>Tokens</span><span>${formatK(s?.tokens?.input || 0)} in / ${formatK(s?.tokens?.output || 0)} out</span></div>
        <div class="tl-sum-row"><span>Cost</span><span>$${(s?.cost || 0).toFixed(2)}</span></div>
        ${s?.filesChanged?.length ? `<div class="tl-files"><strong>Files Changed:</strong> ${s.filesChanged.map(f => `<span class="tl-file">${esc(f.path)}</span>`).join(', ')}</div>` : ''}
      </div>
      <div class="tl-events">
        ${events.length === 0 ? '<div class="tl-empty">No tool events in this session</div>' : events.map(ev => {
          const time = ev.ts ? new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          const icon = { Read: '📄', Edit: '✏️', Write: '📝', Bash: '⚡', Grep: '🔍', Glob: '📂', Task: '🤖', commit: '📦' }[ev.name || ev.type] || '🔧';
          return `<div class="tl-event"><span class="tl-time">${time}</span><span class="tl-icon">${icon}</span><span class="tl-name">${esc(ev.name || ev.type)}</span><span class="tl-detail">${esc((ev.detail || '').slice(0, 100))}</span></div>`;
        }).join('')}
      </div>`;
  } catch (err) {
    overlay.querySelector('.modal-body').innerHTML = `<div class="tl-error">Error: ${esc(err.message)}</div>`;
  }
}

function formatK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n; }

// ──────────── Morning Briefing Banner ────────────

export async function loadBriefing() {
  const banner = document.getElementById('briefing-banner');
  if (!banner) return;
  if (!banner.dataset.delegated) {
    banner.dataset.delegated = '1';
    banner.addEventListener('click', e => {
      if (e.target.closest('[data-action="toggle-briefing"]')) banner.classList.toggle('collapsed');
    });
  }

  try {
    const data = await fetchJson('/api/briefing');
    if (!data || data.items?.length === 0) { banner.style.display = 'none'; return; }

    banner.style.display = '';
    banner.innerHTML = `
      <div class="briefing-header" data-action="toggle-briefing">
        <span class="briefing-icon">☀️</span>
        <span class="briefing-title">Morning Briefing</span>
        <span class="briefing-meta">${data.attentionCount || 0} need attention · $${(data.cost?.today || 0).toFixed(2)} today · ${data.totalProjects} projects</span>
        <span class="briefing-toggle">▼</span>
      </div>
      <div class="briefing-body">
        ${data.items.map(item => `
          <div class="briefing-item ${item.needsAttention ? 'attention' : ''}">
            <span class="briefing-proj">${esc(item.projectId)}</span>
            <span class="briefing-changes">${item.changes.map(c => esc(c)).join(' · ')}</span>
          </div>
        `).join('')}
        <div class="briefing-cost">
          Yesterday: $${(data.cost?.yesterday || 0).toFixed(2)} · Weekly: $${(data.cost?.weekly || 0).toFixed(2)}
        </div>
      </div>`;
  } catch {
    banner.style.display = 'none';
  }
}

// ──────────── Smart Alerts ────────────

export async function checkSmartAlerts() {
  try {
    const alerts = await fetchJson('/api/alerts');
    if (!Array.isArray(alerts) || alerts.length === 0) return;

    const prefs = await fetchJson('/api/alerts/prefs');
    if (!prefs.enabled) return;
    const disabled = new Set(prefs.disabledProjects || []);

    for (const alert of alerts) {
      if (disabled.has(alert.projectId)) continue;
      if (alert.level === 'urgent') {
        showToast(`🔴 ${alert.message}`, 8000);
        playNotifSound();
      } else {
        showToast(alert.message, 4000);
      }
    }
  } catch { /* request failed */ }
}

// ──────────── Batch Commands ────────────

export async function showBatchModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal batch-modal"><div class="modal-header"><h3>Batch Commands</h3><button class="modal-close" data-action="close-overlay">&times;</button></div><div class="modal-body"><div class="batch-loading">Loading...</div></div></div>`;
  overlay.addEventListener('click', e => {
    if (e.target === overlay) { overlay.remove(); return; }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'close-overlay': overlay.remove(); break;
      case 'batch-all': toggleBatchAll(true); break;
      case 'batch-none': toggleBatchAll(false); break;
      case 'batch-cancel': overlay.remove(); break;
      case 'batch-execute': executeBatchCmd(); break;
    }
  });
  document.body.appendChild(overlay);

  try {
    const whitelist = await fetchJson('/api/batch/whitelist');
    const projects = app.projectList || [];

    overlay.querySelector('.modal-body').innerHTML = `
      <div class="batch-form">
        <div class="batch-field">
          <label>Command</label>
          <select id="batch-command">${whitelist.map(c => `<option value="${esc(c.id)}">${esc(c.label)} (${c.category})</option>`).join('')}</select>
        </div>
        <div class="batch-field">
          <label>Projects <button class="btn-sm" data-action="batch-all">All</button> <button class="btn-sm" data-action="batch-none">None</button></label>
          <div class="batch-project-list" id="batch-project-list">
            ${projects.map(p => `<label class="batch-proj-item"><input type="checkbox" value="${esc(p.id)}" checked> ${esc(p.name)}</label>`).join('')}
          </div>
        </div>
        <div class="batch-field">
          <label><input type="checkbox" id="batch-parallel"> Parallel execution (max 3 concurrent)</label>
        </div>
        <div class="batch-actions">
          <button class="btn" data-action="batch-cancel">Cancel</button>
          <button class="btn primary" data-action="batch-execute">Execute</button>
        </div>
      </div>
      <div id="batch-results" class="batch-results" style="display:none"></div>`;
  } catch (err) {
    overlay.querySelector('.modal-body').innerHTML = `<div class="batch-error">Error: ${esc(err.message)}</div>`;
  }
}

export function toggleBatchAll(checked) {
  document.querySelectorAll('#batch-project-list input[type="checkbox"]').forEach(cb => cb.checked = checked);
}

export async function executeBatchCmd() {
  const commandId = document.getElementById('batch-command')?.value;
  const projectIds = [...document.querySelectorAll('#batch-project-list input:checked')].map(cb => cb.value);
  const parallel = document.getElementById('batch-parallel')?.checked;

  if (projectIds.length === 0) return showToast('Select at least one project');

  const resultsEl = document.getElementById('batch-results');
  if (resultsEl) {
    resultsEl.style.display = '';
    resultsEl.innerHTML = '<div class="batch-running">Executing...</div>';
  }

  try {
    const result = await postJson('/api/batch/execute', { commandId, projectIds, parallel });

    if (result.error) throw new Error(result.error);

    if (resultsEl) {
      resultsEl.innerHTML = `
        <div class="batch-summary">${result.success}/${result.total} succeeded</div>
        ${(result.results || []).map(r => `
          <div class="batch-result-item ${r.status}">
            <span class="batch-result-icon">${r.status === 'success' ? '✅' : '❌'}</span>
            <span class="batch-result-name">${esc(r.projectName)}</span>
            <span class="batch-result-time">${r.duration}ms</span>
            <pre class="batch-result-output">${esc((r.output || '').slice(0, 500))}</pre>
          </div>
        `).join('')}`;
    }
  } catch (err) {
    if (resultsEl) resultsEl.innerHTML = `<div class="batch-error">Error: ${esc(err.message)}</div>`;
  }
}

// ─── Admin Report ───
let _reportSSE = false;
let _reportState = null;

async function generateAdminReport() {
  const btn = document.querySelector('[data-action="generate-admin-report"]');
  if (btn) { btn.disabled = true; btn.textContent = '생성 중...'; }

  try {
    const conv = await postJson('/api/agent/conversations', {});
    _reportState = { convId: conv.id };

    const projects = app.projectList || [];
    const projectSummary = projects.map(p => `- ${p.name} (${p.stack || '?'}): ${p.sessionState || 'idle'}`).join('\n');

    const prompt = `주간 보고서를 작성해줘.

등록된 프로젝트 (${projects.length}개):
${projectSummary || '(없음)'}

다음 내용을 포함해:
1. **프로젝트 현황 요약**: 각 프로젝트 상태, 최근 활동
2. **리소스 사용량**: COCKPIT:usage로 토큰/비용 현황 조회
3. **시스템 상태**: COCKPIT:system으로 CPU/메모리 확인
4. **주요 이슈 및 리스크**: 비용 급등, 시스템 부하 등
5. **다음 주 권장 사항**

작성 완료 후 COCKPIT:note-create 로 "주간 보고서 - [오늘 날짜]" 제목으로 저장해.
한국어, 마크다운 형식으로 작성.`;

    await postJson('/api/agent/chat', { convId: conv.id, message: prompt, agentId: 'admin_teamlead' });

    if (!_reportSSE) {
      _reportSSE = true;
      for (const evt of ['agent:response', 'agent:done', 'agent:error', 'agent:tool-result']) {
        document.addEventListener(evt, e => _onReportEvent(evt, e.detail));
      }
    }
  } catch (err) {
    showToast('보고서 생성 실패: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '📊 주간 보고서'; }
  }
}

async function _onReportEvent(evt, data) {
  if (!_reportState || !data) return;
  if (data.convId && data.convId !== _reportState.convId) return;

  const btn = document.querySelector('[data-action="generate-admin-report"]');

  if (evt === 'agent:tool-result' && data.result) {
    // Capture note ID from COCKPIT:note-create result
    const m = data.result.match(/\[([a-f0-9]+)\]/);
    if (m) _reportState.noteId = m[1];
  } else if (evt === 'agent:response' || evt === 'agent:done') {
    if (btn) { btn.disabled = false; btn.textContent = '📊 주간 보고서'; }
    if (!_reportState) return; // already handled
    const captured = _reportState;
    _reportState = null; // clear immediately to prevent double-fire
    // Fetch actual note content if we captured an ID
    if (captured.noteId) {
      try {
        const note = await fetchJson(`/api/notes/${captured.noteId}`);
        if (note?.content) _showReportResult(note.content);
        else if (data.content) _showReportResult(data.content);
      } catch { if (data.content) _showReportResult(data.content); }
    } else if (data.content) {
      _showReportResult(data.content);
    }
  } else if (evt === 'agent:error') {
    showToast('보고서 생성 실패: ' + (data.error || ''), 'error');
    if (btn) { btn.disabled = false; btn.textContent = '📊 주간 보고서'; }
    _reportState = null;
  }
}

function _showReportResult(content) {
  const section = document.getElementById('smart-actions');
  if (!section) return;

  section.querySelector('.admin-report-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'admin-report-overlay';
  const rendered = simpleMarkdown(content);
  overlay.innerHTML = `
    <div class="adm-header">
      <span class="adm-title">📊 주간 보고서</span>
      <span style="background:#14b8a6;color:#fff;padding:2px 8px;border-radius:4px;font-size:.75rem">경영지원</span>
      <button class="adm-close" onclick="this.closest('.admin-report-overlay').remove()">✕</button>
    </div>
    <div class="adm-body">${rendered}</div>
    <div class="adm-actions">
      <button class="btn primary" data-action="switch-view" data-view="notes" onclick="this.closest('.admin-report-overlay').remove()">Notes에서 보기</button>
      <button class="btn" onclick="this.closest('.admin-report-overlay').remove()">닫기</button>
    </div>`;
  section.insertBefore(overlay, section.firstChild);
}

// ─── Action Registration ───
registerClickActions({
  'switch-view': (el) => {
    // 자가 복구: 닫히지 않은 모달의 backdrop이 화면 조작을 가리는 사고 방지 —
    // 탭 클릭은 명확한 탐색 의도이므로 열려있는 dialog를 정리한다.
    document.querySelectorAll('dialog[open]').forEach(d => {
      if (!d.contains(el)) { try { d.close(); } catch { /* non-modal */ } }
    });
    switchView(el.dataset.view);
  },
  'toggle-nav-more': toggleNavMore,
  'toggle-notifications': toggleNotifications,
  'toggle-theme': toggleTheme,
  'set-project-filter': (el) => setProjectFilter(el.dataset.filterVal),
  'set-chart-period': (el) => setChartPeriod(Number(el.dataset.period)),
  'toggle-activity-log': () => document.getElementById('activity-log-list')?.classList.toggle('collapsed'),
  'close-conv-overlay': (el, e) => { if (e.target === el) closeConvList(); },
  'close-conv-list': closeConvList,
  'generate-admin-report': generateAdminReport,
});
registerChangeActions({
  'set-project-sort': (el) => setProjectSort(el.value),
});
registerInputActions({
  'filter-projects': filterProjects,
});

// ─── Initialize sub-modules ───
initDashboardCards({ switchView });
