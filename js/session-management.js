import { esc, fetchJson } from './utils.js';
import { workerSettings, workerDispatchEnabled, workerAssignment } from './worker-settings.js';
import { mountSessionChecklist } from './session-checklist.js';
import { mountSessionWakeup } from './session-wakeup.js';

const drafts = new Map();
let latestBoard;
let refreshPending, refreshedAt = 0;
const reviewsOf = board => board?.supervisors || (board?.review ? [board.review] : []);
const stamp = at => at ? new Date(at).toLocaleString('ko-KR') : '아직 보고 없음';

window.addEventListener('beforeunload', event => {
  if ([...drafts.values()].some(draft => draft.dirty || draft.busy || draft.checklistText || draft.taskBusy || draft.blockEdit || draft.wakeup?.dirty || draft.wakeup?.busy)) { event.preventDefault(); event.returnValue = ''; }
});

export function updateSessionManagement(board) {
  if (board && !board.projection && (!latestBoard || board.updatedAt >= latestBoard.updatedAt)) latestBoard = board;
  document.querySelectorAll('[data-session-management]').forEach(panel => panel.refresh?.(latestBoard));
}

// Only an open detail editor needs the complete board. Coalesce all panels
// into one refresh so status polling stays small when details are closed.
export function refreshSessionManagement() {
  const visible = [...document.querySelectorAll('[data-session-management]')].some(panel => panel.getClientRects().length
    && panel.querySelector('[data-sm-panel="wakeup"]')?.hidden !== false);
  if (!visible || refreshPending || Date.now() - refreshedAt < 4000) return refreshPending;
  refreshedAt = Date.now();
  refreshPending = fetchJson('/api/board', { timeoutMs: 4000 }).then(updateSessionManagement)
    .catch(() => {}).finally(() => { refreshPending = null; });
  return refreshPending;
}

export function createSessionManagement(termId, term, namespace = '') {
  const panelId = namespace + termId;
  const draft = drafts.get(termId) || { dirty: false, busy: false, tab: 'settings' };
  drafts.set(termId, draft);
  const root = document.createElement('div');
  root.className = 'session-management';
  root.dataset.sessionManagement = termId;
  root.innerHTML = `<header class="sm-head"><div><h2>${esc(term.alias || term.label)} <span>세션 관리</span></h2><p data-sm-owner>보드 불러오는 중…</p></div><span class="sm-state" data-sm-state>확인 중</span></header>
    <div class="sm-tabs" role="tablist" aria-label="세션 관리 메뉴">
      <button type="button" role="tab" id="sm-settings-${esc(panelId)}" aria-controls="sm-settings-panel-${esc(panelId)}" data-sm-tab="settings" aria-selected="true">목표·설정</button>
      <button type="button" role="tab" id="sm-checklist-${esc(panelId)}" aria-controls="sm-checklist-panel-${esc(panelId)}" data-sm-tab="checklist" aria-selected="false">체크리스트</button>
      <button type="button" role="tab" id="sm-progress-${esc(panelId)}" aria-controls="sm-progress-panel-${esc(panelId)}" data-sm-tab="progress" aria-selected="false">진행·근거</button>
      <button type="button" role="tab" id="sm-wakeup-${esc(panelId)}" aria-controls="sm-wakeup-panel-${esc(panelId)}" data-sm-tab="wakeup" aria-selected="false">PM 깨우기</button>
    </div>
    <div class="sm-message" role="status" data-sm-message></div>
    <form class="sm-form" role="tabpanel" id="sm-settings-panel-${esc(panelId)}" aria-labelledby="sm-settings-${esc(panelId)}" data-sm-panel="settings">
      <div class="sm-fields"><div class="sm-controls"><label>담당 감독<select name="supervisor" required></select></label><label>작업 우선순위<select name="priority"><option value="1">높음 · 먼저 처리</option><option value="2">보통</option><option value="3">낮음 · 여유 있을 때</option></select></label></div>
      <label>현재 목표<textarea name="objective" rows="2" maxlength="2000" placeholder="이번 세션이 맡을 일을 적어주세요"></textarea></label>
      <label>완료 조건<textarea name="goal" rows="4" required maxlength="2000" placeholder="어떤 결과를 확인하면 완료인지 적어주세요"></textarea></label>
      <label class="sm-pause"><input name="paused" type="checkbox"><span>자동 지시 일시정지<small>실행 중인 명령은 유지하고, 새 지시를 멈춥니다.</small></span></label>
      <p class="sm-hint">우선순위는 다음 자동 지시·감독 배정 순서에 반영됩니다.</p></div>
      <footer class="sm-save"><span data-sm-dirty>감독보드와 함께 저장됩니다.</span><button type="button" data-sm-reset>최신 설정</button><button type="submit" class="sm-primary" disabled>변경 저장</button></footer>
    </form>
    <div class="sm-progress" role="tabpanel" id="sm-progress-panel-${esc(panelId)}" aria-labelledby="sm-progress-${esc(panelId)}" data-sm-panel="progress" hidden></div>
    <div class="sm-checklist" role="tabpanel" id="sm-checklist-panel-${esc(panelId)}" aria-labelledby="sm-checklist-${esc(panelId)}" data-sm-panel="checklist" hidden></div>
    <div role="tabpanel" id="sm-wakeup-panel-${esc(panelId)}" aria-labelledby="sm-wakeup-${esc(panelId)}" data-sm-panel="wakeup" hidden></div>
    <div class="sm-supervisor" hidden><p data-sm-supervisor-goal></p><button type="button" data-action="toggle-floating-supervision">감독보드에서 관리</button></div>`;
  const form = root.querySelector('form');
  const fields = form.elements;
  const message = root.querySelector('[data-sm-message]');
  const setMessage = value => { draft.message = value; message.textContent = value; };
  setMessage(draft.message || '');
  const dirtyLabel = root.querySelector('[data-sm-dirty]');
  let board = latestBoard;
  let review;
  let assignment;
  const updateChecklist = mountSessionChecklist(root.querySelector('.sm-checklist'), { termId, draft,
    getSupervisorId: () => reviewsOf(board).find(item => item.termId === termId)?.id || draft.supervisorId,
    onSaved: next => { if (next) board = next; updateSessionManagement(next); },
  });
  const refreshWakeup = mountSessionWakeup(root.querySelector('[data-sm-panel="wakeup"]'), { termId, draft });
  const selectTab = tab => {
    draft.tab = tab;
    message.hidden = tab !== 'settings';
    root.querySelectorAll('[data-sm-tab]').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.smTab === tab));
      button.tabIndex = button.dataset.smTab === tab ? 0 : -1;
    });
    root.querySelectorAll('[data-sm-panel]').forEach(panel => { panel.hidden = panel.dataset.smPanel !== tab; });
  };
  function readValues() {
    return { objective: fields.objective.value, goal: fields.goal.value, priority: Number(fields.priority.value), paused: fields.paused.checked };
  }
  function fillValues(values) {
    for (const key of ['objective', 'goal', 'priority']) fields[key].value = values[key];
    fields.paused.checked = values.paused;
  }
  function refresh(next) {
    refreshWakeup();
    if (!next || draft.busy || (board && next.updatedAt < board.updatedAt)) return;
    board = next;
    updateChecklist(board);
    message.textContent = draft.message || '';
    form.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = false; });
    const reviews = reviewsOf(board);
    const managed = reviews.find(item => item.termId === termId);
    const assigned = reviews.filter(item => item.watched.some(worker => worker.termId === termId))
      .sort((a, b) => Number(['running', 'waiting'].includes(b.status)) - Number(['running', 'waiting'].includes(a.status)));
    review = ((draft.dirty || draft.supervisorSelected) && reviews.find(item => item.id === draft.supervisorId)) || workerAssignment(reviews, termId)
      || reviews.find(item => item.id === draft.supervisorId) || reviews.find(item => item.termId) || reviews[0];
    if (!review) return;
    assignment = review.watched.find(worker => worker.termId === termId);
    const choices = assigned.length ? assigned : reviews.filter(item => item.termId !== termId);
    const options = choices.map(item => `<option value="${esc(item.id)}">${esc(item.alias || item.name)} · ${['running', 'waiting'].includes(item.status) ? '운영 중' : '중지됨'}</option>`).join('');
    if (fields.supervisor.innerHTML !== options) fields.supervisor.innerHTML = options;
    fields.supervisor.value = review.id;
    draft.supervisorId = review.id;
    const current = assignment ? workerSettings(assignment) : null;
    if (!draft.dirty) {
      draft.expected = current;
      draft.values = current || workerSettings();
      fillValues(draft.values);
    } else if (draft.values) {
      // Terminal and overview panels share one draft, including its field values.
      fillValues(draft.values);
    }
    const changed = JSON.stringify(draft.expected) !== JSON.stringify(current);
    dirtyLabel.textContent = draft.dirty ? changed ? '서버 설정 변경됨 · 최신 설정 확인 필요' : '저장하지 않은 변경 있음' : '감독보드와 함께 저장됩니다.';
    root.querySelector('[data-sm-owner]').textContent = managed ? `감독 · ${managed.name}` : assignment ? `${review.alias || review.name} 담당 · ${workerDispatchEnabled(review) && !assignment.paused ? '자동 지시 켜짐' : '자동 지시 정지'}` : '미배정 · 목표를 저장해 작업자로 연결하세요';
    const worker = review.workerProgress.find(item => item.termId === termId);
    const run = worker?.run || {};
    const state = managed ? managed.status : assignment?.paused ? 'paused' : run.status;
    const labels = { ready: '시작 대기', active: '진행 보고 있음', blocked: '막힘 보고', reported: '완료 검증 대기', complete: '완료 확인', paused: '자동 지시 정지', running: '감독 운영 중', waiting: '확인 필요', stopped: '감독 중지' };
    const badge = root.querySelector('[data-sm-state]');
    badge.textContent = labels[state] || '미배정';
    badge.dataset.state = state || 'unassigned';
    const progress = root.querySelector('.sm-progress');
    const progressHTML = `<p class="sm-report-time">최근 보고 · ${esc(stamp(run.reportedAt || managed?.lastReviewedAt))}</p>
      <section><h3>현재까지 수행한 일</h3><p>${esc(run.summary || managed?.reports?.at(-1)?.text || '아직 작업 보고가 없습니다.')}</p></section>
      <section><h3>막힌 이유</h3><p>${esc(run.blocker || worker?.blocker || '보고된 막힘 없음')}</p></section>
      <section><h3>다음 작업</h3><p>${esc(run.nextAction || worker?.nextAction || (assignment?.paused ? '자동 지시 일시정지를 해제하면 이어갑니다.' : '등록된 다음 작업이 없습니다.'))}</p></section>
      ${run.remaining?.length ? `<section><h3>남은 완료 조건</h3><ul>${run.remaining.map(item => `<li><strong>${esc(item.condition)}</strong><p>${esc(item.blocker)}</p><p>다음: ${esc(item.nextAction)}</p></li>`).join('')}</ul></section>` : ''}
      ${run.evidence ? `<section><h3>작업자가 보고한 근거 · 완료 확인 전</h3><p>${esc(run.evidence)}</p></section>` : ''}
      <section><h3>검증 근거</h3><p>${esc(worker?.evidence || '아직 검증 근거가 없습니다.')}</p></section>`;
    if (progress.innerHTML !== progressHTML) progress.innerHTML = progressHTML;
    form.hidden = Boolean(managed) || draft.tab !== 'settings';
    root.querySelector('.sm-supervisor').hidden = !managed || draft.tab !== 'settings';
    root.querySelector('[data-sm-supervisor-goal]').textContent = managed?.objective || '등록된 감독 목표가 없습니다.';
    form.querySelector('button[type="submit"]').disabled = !draft.dirty || changed;
  }
  root.refresh = refresh;
  root.querySelectorAll('[data-sm-tab]').forEach(button => {
    button.addEventListener('click', () => { selectTab(button.dataset.smTab); refresh(board); });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const tabs = ['settings', 'checklist', 'progress', 'wakeup'];
      const tab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
        : tabs[(tabs.indexOf(draft.tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(tab); refresh(board); root.querySelector(`[data-sm-tab="${tab}"]`).focus();
    });
  });
  form.addEventListener('input', event => {
    draft.editVersion = (draft.editVersion || 0) + 1;
    if (event.target === fields.supervisor) return;
    draft.values = readValues(); draft.dirty = true; setMessage('');
    refresh(board);
  });
  fields.supervisor.addEventListener('change', () => {
    draft.editVersion = (draft.editVersion || 0) + 1;
    if (draft.dirty && assignment) {
      fields.supervisor.value = draft.supervisorId;
      setMessage('작성 중인 변경을 저장하거나 최신 설정을 불러온 뒤 감독을 바꾸세요.');
      return;
    }
    draft.supervisorId = fields.supervisor.value;
    draft.supervisorSelected = true;
    if (assignment) draft.dirty = false;
    refresh(board);
  });
  root.querySelector('[data-sm-reset]').addEventListener('click', async () => {
    if (draft.dirty && !confirm('작성 중인 변경을 버리고 최신 설정을 불러올까요?')) return;
    const editVersion = draft.editVersion || 0;
    try {
      const next = await fetchJson('/api/board');
      if ((draft.editVersion || 0) !== editVersion || draft.busy) return;
      draft.dirty = false; setMessage(''); refresh(next);
    }
    catch (error) { setMessage(error.message); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (draft.busy || !draft.dirty) return;
    draft.busy = true;
    const controls = [...form.querySelectorAll('input, textarea, select, button')];
    controls.forEach(control => { control.disabled = true; });
    setMessage('저장 중…');
    try {
      const next = await fetchJson('/api/board/worker-settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supervisorId: draft.supervisorId, termId, expected: draft.expected, settings: readValues() }) });
      draft.dirty = false; board = next; latestBoard = next; setMessage('저장됨 · 다음 자동 지시부터 반영됩니다.');
    } catch (error) { setMessage(error.message); }
    finally { draft.busy = false; controls.forEach(control => { control.disabled = false; }); refresh(board); updateSessionManagement(); }
  });
  selectTab(draft.tab);
  if (draft.values) fillValues(draft.values);
  if (draft.busy) form.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = true; });
  refresh(board);
  fetchJson('/api/board').then(next => { if (root.isConnected) refresh(next); }).catch(error => { setMessage(`보드를 불러오지 못했습니다. ${error.message}`); });
  return root;
}
