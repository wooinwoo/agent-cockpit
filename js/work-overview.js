import { esc, fetchJson } from './utils.js';
import { createSessionManagement, updateSessionManagement, refreshSessionManagement } from './session-management.js';
import { workOverviewRows } from './work-overview-state.js';
import { workerDispatchEnabled } from './worker-settings.js';
import { mountSessionMaintenance } from './session-maintenance.js';

let timer, root, board, terminals = [], summaries = {}, busy = false, lastSuccess = 0, selected = '', filter = 'all';
let approval = null, stoppingApproval = false, approvalVersion = 0;
const age = at => !at ? '보고 없음' : `${Math.max(0, Math.floor((Date.now() - at) / 60000))}분 전 보고`;
const expandedCompleted = new Set();
const dispatchPending = new Set();
let refreshMaintenance;

function renderControlSummary() {
  const reviews = (board?.supervisors || []).filter(review => review.watched.length);
  const active = reviews.filter(review => workerDispatchEnabled(review)).length;
  const independent = reviews.filter(review => workerDispatchEnabled(review) && review.workerDispatch === 'running').length;
  const modes = [independent ? `독립 진행 ${independent}그룹` : '', active > independent ? `감독 연동 ${active - independent}그룹` : ''].filter(Boolean).join(' · ');
  root.querySelector('[data-wo-controls-summary]').textContent = `${modes || (reviews.length ? '자동 진행 정지' : '자동 진행 미설정')} · 승인 ${approval?.state === 'running' ? '실행 중' : approval?.state === 'stopped' ? '중지됨' : '확인 필요'}`;
}

function renderDispatch() {
  const container = root.querySelector('[data-wo-dispatch-controls]');
  if (container.contains(document.activeElement) || dispatchPending.size) return;
  const html = (board?.supervisors || []).filter(review => review.watched.length).map(review => `<label class="wo-dispatch-row"><span><strong>${esc(review.alias || review.name)}</strong><small>작업자 ${review.watched.length}명 · 감독 ${['running', 'waiting'].includes(review.status) ? '운영 중' : '중지됨'}${review.runUntil ? ` · 기한 ${esc(new Date(review.runUntil).toLocaleString('ko-KR'))}` : ''}</small></span>
    <select aria-label="${esc(review.alias || review.name)} 작업자 자동 진행" data-wo-dispatch="${esc(review.id)}" data-expected="${review.workerDispatch || 'linked'}">${[['linked', '감독과 함께 운영'], ['running', '독립 진행 켜짐'], ['paused', '자동 진행 일시정지']].map(([value, text]) => `<option value="${value}" ${value === (review.workerDispatch || 'linked') ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`).join('') || '<p>세션 관리에서 작업 목표를 배정하면 자동 진행을 설정할 수 있습니다.</p>';
  if (container._html !== html) { container.innerHTML = html; container._html = html; }
}

async function changeDispatch(select) {
  const id = select.dataset.woDispatch;
  if (dispatchPending.has(id)) return;
  dispatchPending.add(id); select.disabled = true;
  const message = root.querySelector('[data-wo-dispatch-message]');
  message.textContent = '자동 진행 설정 저장 중…';
  try {
    const nextBoard = await fetchJson('/api/board/worker-dispatch', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supervisorId: id, mode: select.value, expected: select.dataset.expected }) });
    if (!board || nextBoard.updatedAt >= board.updatedAt) board = nextBoard;
    updateSessionManagement(nextBoard);
    select.dataset.expected = select.value;
    message.textContent = select.value === 'running' ? '독립 진행 켜짐 · 감독 응답 없이 각자 목표를 이어갑니다.' : '설정 저장됨 · 실행 중인 작업은 유지합니다.';
  } catch (error) { select.value = select.dataset.expected; message.textContent = error.message; }
  finally { dispatchPending.delete(id); select.disabled = false; render(); }
}

function renderApproval() {
  renderControlSummary();
  const state = root.querySelector('[data-wo-approval-state]');
  const heartbeat = approval?.heartbeat;
  state.textContent = approval ? { running: '실행 중', stopped: '중지됨', unknown: '실행 상태 확인 불가' }[approval.state] : '상태 조회 불가 · 로컬 연결 확인';
  state.dataset.state = approval?.state || 'unknown';
  root.querySelector('[data-wo-approval-detail]').textContent = approval
    ? `대상 ${approval.targets.join(' · ')} · ${approval.intervalSeconds}초 간격 · ${heartbeat ? `최근 기록 ${new Date(heartbeat.at).toLocaleTimeString('ko-KR')}${heartbeat.stale ? ' · 15초 이상 갱신 없음' : ''} · 입력 ${heartbeat.sent ?? '?'}회 / 승인창 사라짐 ${heartbeat.cleared ?? '?'}회` : '상태 기록 없음'}`
    : '승인 스크립트 상태와 중지는 로컬 접속에서 확인할 수 있습니다.';
  root.querySelector('[data-wo-approval-stop]').disabled = stoppingApproval || !approval?.canStop;
}

async function stopApproval() {
  if (stoppingApproval || !approval?.canStop || !confirm('승인 스크립트를 중지할까요? AI 세션의 실행 중인 작업은 계속됩니다.')) return;
  stoppingApproval = true; approvalVersion++; renderApproval();
  const message = root.querySelector('[data-wo-approval-message]');
  message.textContent = '중지 중…';
  try {
    approval = await fetchJson('/api/board/approval-watcher/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    message.textContent = approval.state === 'stopped' ? '승인 스크립트가 중지되었습니다.' : '중지 후 상태를 확인해 주세요.';
  } catch (error) { message.textContent = `중지하지 못했습니다. ${error.message}`; }
  finally { approvalVersion++; stoppingApproval = false; renderApproval(); }
}

function render() {
  if (!board) return;
  const rows = workOverviewRows(board, terminals, Date.now(), summaries);
  const counts = { all: rows.length, attention: rows.filter(row => row.attention).length, busy: rows.filter(row => row.state === 'busy').length, completed: rows.filter(row => row.done > 0).length, done: rows.filter(row => row.goalComplete).length };
  for (const [key, count] of Object.entries(counts)) root.querySelector(`[data-wo-count="${key}"]`).textContent = count;
  const visible = rows.filter(row => filter === 'all' || (filter === 'attention' ? row.attention : filter === 'completed' ? row.done > 0 : filter === 'done' ? row.goalComplete : row.state === filter));
  const list = root.querySelector('.wo-list');
  const html = visible.map(row => `<article class="wo-entry" data-state="${row.state}"><button type="button" class="wo-row" data-wo-session="${esc(row.termId)}" aria-pressed="${row.termId === selected}" title="${esc(row.alias)} 목표·우선순위·체크리스트 관리">
    <span class="wo-identity"><strong>${esc(row.alias)}</strong><small>${esc(row.role)}</small><span class="wo-priority" data-priority="${row.priority}">${['', '높은 우선순위', '보통', '낮은 우선순위'][row.priority]}</span></span>
    <span class="wo-work"><strong title="${esc(row.objective)}">${esc(row.objective)}</strong><span class="wo-now"><b>진행</b><span>${esc(row.task)}</span></span><span class="wo-next"><b>다음</b><span>${esc(row.next)}</span></span>${row.blocker ? `<small class="wo-warning" title="${esc(row.blocker)}">막힘 · ${esc(row.blocker)}</small>` : row.stalled ? '<small class="wo-warning">5분 이상 새 검증 근거 없음</small>' : ''}</span>
    <span class="wo-check"><strong>${row.done}<span> / ${row.total}</span></strong><progress value="${row.done}" max="${row.total || 1}" aria-label="${esc(row.alias)} 체크리스트 완료"></progress><small>${row.total ? `가능 ${row.queue.ready} · 진행 ${row.queue.running} · 막힘 ${row.queue.blocked}` : '체크리스트 없음'}</small></span>
    <span class="wo-status"><span class="wo-badge" data-state="${row.state}" title="${row.runtimeAt ? `${esc(new Date(row.runtimeAt).toLocaleTimeString('ko-KR'))} 관측` : esc(row.runtimeSource)}">${esc(row.label)}</span>${row.supervisorId ? `<small>${row.dispatching ? '자동 진행 켜짐' : '자동 진행 정지'}</small>` : ''}</span>
  </button><div class="wo-entry-footer"><button type="button" class="wo-report-link" data-wo-progress="${esc(row.termId)}">진행·근거 보기 <span>${esc(age(row.reportedAt))}</span></button>${row.completed.length ? `<details class="wo-completed" data-wo-completed="${esc(row.termId)}" ${expandedCompleted.has(row.termId) ? 'open' : ''}>
    <summary data-wo-completed-summary="${esc(row.termId)}">완료한 작업 ${row.done}개</summary>
    <ul>${row.completed.map(task => `<li><span>${esc(task.text)}</span><small>${esc(task.id)}${task.updatedAt ? ` · ${esc(new Date(task.updatedAt).toLocaleString('ko-KR'))} 갱신` : ''}</small></li>`).join('')}</ul>
  </details>` : ''}</div></article>`).join('') || `<p class="wo-empty">${rows.length ? '이 조건에 해당하는 세션이 없습니다.' : '아직 등록된 세션이 없습니다. Terminal에서 세션을 열면 여기에 표시됩니다.'}</p>`;
  if (list._html !== html) {
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused?.dataset.woSession || focused?.dataset.woProgress || focused?.dataset.woCompletedSummary;
    list.innerHTML = html; list._html = html;
    if (focusId) [...list.querySelectorAll(focused.dataset.woSession ? '[data-wo-session]' : focused.dataset.woProgress ? '[data-wo-progress]' : 'summary')].find(item => (item.dataset.woSession || item.dataset.woProgress || item.dataset.woCompletedSummary) === focusId)?.focus({ preventScroll: true });
  }
  updateSessionManagement();
  renderDispatch();
  renderControlSummary();
}

async function refresh() {
  if (busy || !root?.classList.contains('active') || document.hidden) return;
  busy = true;
  refreshSessionManagement();
  refreshMaintenance?.();
  const requestedApprovalVersion = approvalVersion;
  const status = root.querySelector('[data-wo-status]');
  try {
    const [nextBoard, nextTerminals, nextSummaries] = await Promise.all([fetchJson('/api/board?projection=overview', { timeoutMs: 4000 }), fetchJson('/api/terminals?activity=1', { timeoutMs: 4000 }), fetchJson('/api/supervisor/summaries', { timeoutMs: 4000 }).catch(() => null),
      fetchJson('/api/board/approval-watcher', { timeoutMs: 4000 }).catch(() => null).then(next => { if (!stoppingApproval && approvalVersion === requestedApprovalVersion) { approval = next; renderApproval(); } }),
    ]);
    if (!board || nextBoard.updatedAt >= board.updatedAt) board = nextBoard;
    terminals = nextTerminals.terminals; lastSuccess = Date.now();
    if (nextSummaries) summaries = nextSummaries;
    status.textContent = `5초마다 갱신 · ${new Date(lastSuccess).toLocaleTimeString('ko-KR')} 확인`;
    status.dataset.error = 'false'; render();
  } catch {
    status.textContent = `연결 확인 필요 · ${lastSuccess ? `${new Date(lastSuccess).toLocaleTimeString('ko-KR')} 자료 유지 중` : '자료를 불러오지 못했습니다'}`;
    status.dataset.error = 'true';
    render();
  } finally { busy = false; }
}

export function destroyWorkOverview() { clearInterval(timer); timer = null; }

export function initWorkOverview() {
  root = document.getElementById('work-overview-view');
  if (!root.dataset.initialized) {
    root.dataset.initialized = 'true';
    root.innerHTML = `<header class="wo-head"><div><h1>작업 현황</h1><span>누가, 어디까지, 다음에 무엇을 하는지.</span></div><div><p data-wo-status role="status">현황 불러오는 중…</p><button type="button" data-wo-refresh>새로고침</button></div></header>
      <details data-wo-maintenance></details>
      <details class="wo-controls"><summary>자동 진행·승인 설정 <span data-wo-controls-summary>상태 확인 중…</span></summary>
      <section class="wo-automation" aria-label="승인 스크립트 관리"><div><h2>승인 스크립트 <span data-wo-approval-state>확인 중…</span></h2><p data-wo-approval-detail>실제 프로세스와 최근 기록을 확인합니다.</p><p data-wo-approval-message role="status"></p></div><button type="button" data-wo-approval-stop disabled>스크립트 중지</button></section>
      <section class="wo-dispatch" aria-label="작업자 자동 진행 설정"><h2>작업자 자동 진행</h2><p>독립 진행을 켜면 감독이 중지돼도 각자 배정된 목표를 이어갑니다. 사용자 일시정지·승인·로그인·운영 기한은 유지합니다.</p><div data-wo-dispatch-controls></div><p data-wo-dispatch-message role="status"></p></section></details>
      <div class="wo-filters" role="group" aria-label="세션 필터">${[['all', '전체'], ['attention', '확인 필요'], ['busy', '실행 중'], ['completed', '완료 작업'], ['done', '목표 완료']].map(([key, label]) => `<button type="button" data-wo-filter="${key}" aria-pressed="${key === filter}">${label} <strong data-wo-count="${key}">0</strong></button>`).join('')}</div>
      <p class="wo-hint">확인 필요 → 우선순위 순 · 세션을 누르면 목표와 체크리스트를 편집합니다.</p>
      <div class="wo-layout"><section class="wo-board" aria-label="세션별 작업 현황"><div class="wo-columns" aria-hidden="true"><span>담당 세션</span><span>현재 작업 · 다음 순서</span><span>체크리스트</span><span>실행 상태</span></div><div class="wo-list"><p class="wo-empty">현황을 불러오고 있습니다.</p></div></section>
      <aside class="wo-detail" aria-label="선택한 세션 관리" hidden><div class="wo-detail-bar"><span>세션 관리</span><button type="button" data-wo-close>목록으로</button></div><div class="wo-detail-content"></div></aside></div>`;
    refreshMaintenance = mountSessionMaintenance(root.querySelector('[data-wo-maintenance]'), refresh);
    root.addEventListener('toggle', event => {
      const id = event.target.dataset.woCompleted;
      if (!id || !event.target.isConnected) return;
      if (event.target.open) expandedCompleted.add(id); else expandedCompleted.delete(id);
    }, true);
    root.addEventListener('change', event => { if (event.target.dataset.woDispatch) changeDispatch(event.target); });
    root.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-wo-refresh')) refresh();
      if (button.hasAttribute('data-wo-approval-stop')) stopApproval();
      if (button.dataset.woFilter) {
        filter = button.dataset.woFilter;
        root.querySelectorAll('[data-wo-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        render();
      }
      if (button.dataset.woSession || button.dataset.woProgress) {
        selected = button.dataset.woSession || button.dataset.woProgress;
        const row = workOverviewRows(board, terminals).find(item => item.termId === selected);
        const detail = root.querySelector('.wo-detail');
        detail.hidden = false; root.classList.add('wo-selected');
        const content = root.querySelector('.wo-detail-content');
        content.replaceChildren(createSessionManagement(selected, { alias: row.alias }, 'overview-'));
        content.querySelector(`[data-sm-tab="${button.dataset.woProgress ? 'progress' : 'settings'}"]`).click();
        render(); root.querySelector('[data-wo-close]').focus({ preventScroll: true });
      }
      if (button.hasAttribute('data-wo-close')) {
        root.querySelector('.wo-detail').hidden = true; root.classList.remove('wo-selected');
        const previous = selected; selected = ''; render();
        [...root.querySelectorAll('[data-wo-session]')].find(item => item.dataset.woSession === previous)?.focus({ preventScroll: true });
      }
    });
  }
  destroyWorkOverview(); updateSessionManagement(); refresh(); timer = setInterval(refresh, 5000);
}
