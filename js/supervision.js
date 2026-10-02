import { esc, fetchJson, showToast } from './utils.js';
import { agentPermissionCommand, unattendedCommandReady } from './agent-permissions.js';
import { stalledWorkerProgress } from './worker-progress.js';

let timer;
let generation = 0;
let hasUnsavedInput = () => false;
let saving = () => false;
const labels = { running: '감독 중', waiting: '확인 필요', complete: '목표 달성 보고됨', stopped: '중지됨', interrupted: '보고 기한 초과 · 재시작 요청' };
const stamp = value => value ? new Date(value).toLocaleString('ko-KR') : '아직 없음';
const send = (url, method, body) => fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function canLeaveSupervision() {
  if (saving()) { showToast('저장이 끝난 뒤 이동하세요.', 'info'); return false; }
  return !hasUnsavedInput() || confirm('저장하지 않은 감독 설정 또는 답변이 있습니다. 버리고 이동할까요?');
}

window.addEventListener('beforeunload', event => {
  if (hasUnsavedInput() || saving()) { event.preventDefault(); event.returnValue = ''; }
});

export function stopSupervision() {
  clearInterval(timer);
  generation++;
  hasUnsavedInput = () => false;
  saving = () => false;
}

export function mountSupervision(main) {
  stopSupervision();
  const mounted = generation;
  const tabs = [['progress', '감독'], ['work', '작업'], ['questions', '질문'], ['config', '설정']];
  main.innerHTML = `<div class="supervision">
    <header><h1>감독 보드</h1></header>
    <div class="supervision-tabs" role="tablist" aria-label="감독 보드 메뉴" hidden>
      ${tabs.map(([id, label]) => `<button type="button" role="tab" id="supervision-tab-${id}" aria-controls="supervision-panel-${id}" aria-selected="${id === 'progress'}" tabindex="${id === 'progress' ? 0 : -1}" data-supervision-tab="${id}">${label}</button>`).join('')}
    </div>
    <p class="supervision-notice" role="status">보드 불러오는 중…</p>
    <div class="supervision-content" hidden>
      <section role="tabpanel" id="supervision-panel-config" aria-labelledby="supervision-tab-config" hidden><h2>맡길 일 설정</h2>
        <div class="supervision-config-update" role="status" hidden><p>다른 세션에서 설정을 변경했습니다. 작성 중인 내용은 유지했습니다. 감독 탭에서 저장된 완료 조건을 확인하세요.</p><button class="btn" type="button" data-reload-config>최신 설정 불러오기</button></div>
        <form class="supervision-config">
        <label>전체 목표<textarea name="objective" rows="2" maxlength="4000" placeholder="예: 아침까지 로그인과 결제 오류 수정"></textarea></label>
        <details class="supervision-options"><summary>참고 자료 경로 · 링크</summary>
        <label>참고 자료 경로 · 링크<textarea name="referencePaths" rows="3" maxlength="60030" placeholder="/home/user/project/docs/requirements.md&#10;C:\\자료\\설계서.pdf"></textarea></label>
        <small>한 줄에 파일·폴더 경로 또는 링크 하나씩, 최대 30개. 저장된 자료 목록을 감독이 매 점검과 재시작 후 다시 확인합니다.</small></details>
        <h3>작업 AI별 완료 조건</h3>
        <div class="supervision-workers"></div>
        <button class="btn" type="button" data-add-worker>작업 AI 추가</button>
        <small>작업 AI마다 무엇을 확인해야 완료인지 적어주세요. 최대 12개입니다.</small>
        <h3>감독과 운영 시간</h3>
        <label>감독 AI<input name="target" list="supervision-terminals" placeholder="예: ai8" required maxlength="200"></label>
        <datalist id="supervision-terminals"></datalist>
        <small>감시할 작업 AI와 다른 세션을 선택하세요. 기존 작업 세션의 권한은 바꾸지 않습니다.</small>
        <label>점검 간격 (분)<input name="interval" type="number" min="1" max="1440" value="5" required></label>
        <details class="supervision-options"><summary>자동 복구 · 야간 운영</summary>
        <label class="supervision-recovery"><input name="autoRecover" type="checkbox">감독 AI 종료 시 자동 복구</label>
        <small>tmux 터미널에서 지원. 종료된 감독을 같은 실행 명령으로 최대 3회 재시도하고, 보고가 도착하면 횟수를 초기화합니다. 승인·로그인·사용량 제한은 자동으로 해제하지 않습니다.</small>
        <label>보고 기한 초과 시 감독 강제 재시작 (분)<input name="stallMinutes" type="number" min="0" max="240" value="0" required></label>
        <small>0이면 끔. 자동 복구를 켜고 5~240분을 지정하면 응답 없는 감독과 그 안의 실행 중 명령을 중단하고 재시작합니다. 직전 화면을 기록하며 감시 대상 AI는 종료하지 않습니다.</small>
        <label>야간 운영 시간 (시간)<input name="runHours" type="number" min="0" max="24" value="0" required></label>
        <small>0이면 기존 3회 복구 제한. 1~24시간을 지정하면 3회 실패 후 30분 쉬고 다시 시도하며 종료 시간에 감독을 중지합니다. 자동 복구·보고 기한과 승인 없는 감독 실행 설정이 필요합니다. 막힌 작업은 질문으로 남기고 다른 작업을 계속하도록 지시합니다.</small></details>
        <div class="supervision-readiness" aria-live="polite"></div>
        <button class="btn" type="button" data-permissions>새 감독의 실행 권한 준비하기</button>
        <div class="supervision-actions"><button class="btn primary" type="submit">감독 시작</button><button class="btn" type="button" data-stop>감독 중지</button></div>
        <small>콕핏 서버와 AI 세션이 켜져 있는 동안 점검합니다. 응답이 없으면 간격을 늘려 재요청합니다. 중지는 다음 점검과 지시를 막으며, 이미 실행 중인 작업은 계속됩니다.</small>
      </form>
    <details class="supervision-permissions supervision-options"><summary>새 AI 세션의 실행 권한</summary>
      <p>저장 후 콕핏에서 새로 여는 기본 Codex·Claude 세션에 적용합니다. 직접 작성한 실행 명령과 이미 실행 중인 세션은 기존 권한을 유지합니다.</p>
      <form class="supervision-permission-form">
        <label>Codex<select name="codex"><option value="default">기존 CLI 설정 유지</option><option value="workspace">작업 폴더 자동 실행 · 승인 요청 없음</option><option value="network">작업 폴더 + 네트워크 · 승인 요청 없음</option><option value="full">전체 접근 · 승인 요청 없음</option></select></label>
        <small>작업 폴더 모드는 범위 밖 작업·제한된 네트워크 요청을 거부합니다. 네트워크 포함 모드는 콕핏 통신과 인터넷 연결을 허용하고 파일 쓰기는 작업 폴더로 제한합니다. 전체 접근은 파일·네트워크 제한을 해제하므로 격리 환경에서 사용하세요. 네트워크·전체 접근 모드는 시작 시 업데이트 확인을 생략합니다. CLI 업데이트는 작업 종료 후 진행하세요.</small>
        <label>Claude<select name="claude"><option value="default">기존 CLI 설정 유지</option><option value="edits">파일 편집 자동 허용 · 명령은 추가 승인 가능</option><option value="auto">자동 판단 · 지원 계정에서 사용</option><option value="full">권한 확인 생략 · 격리 환경용</option></select></label>
        <small>권한 확인 생략은 폭넓은 파일·명령 실행을 허용합니다. 조직 정책·명시적 차단·로그인·사용량 제한은 별도로 적용됩니다.</small>
        <button class="btn" type="submit">새 세션 권한 저장</button>
        <p>현재 세션은 해당 터미널에서 <code>/permissions</code>로 변경하세요. 작업 진행 여부를 묻는 대화는 도구 권한과 별개입니다. 승인 없이 진행할 작업 범위는 설정 탭의 전체 목표에 적어두세요.</p>
        <details><summary>실행 명령 보기</summary><div class="supervision-launch-commands"></div></details>
      </form>
    </details>
      </section>
      <section role="tabpanel" id="supervision-panel-progress" aria-labelledby="supervision-tab-progress">
        <div class="supervision-next" hidden aria-live="polite"></div>
        <details class="supervision-saved-goals" hidden><summary>저장된 목표·완료 조건</summary><div></div></details>
        <h2>진행 기록</h2><div class="supervision-status" aria-live="polite"></div><div class="supervision-reports"></div>
      </section>
    <section class="supervision-work" role="tabpanel" id="supervision-panel-work" aria-labelledby="supervision-tab-work" hidden><h2>작업 체크리스트</h2><p>실행할 일과 완료 조건을 관리합니다. 질문은 질문 탭에 따로 모입니다.</p>
      <div class="supervision-lists"></div>
      <form class="supervision-new-list"><label>새 체크리스트<input name="title" maxlength="120" required placeholder="프로젝트 또는 작업 묶음"></label><button class="btn" type="submit">체크리스트 추가</button></form>
    </section>
    <section role="tabpanel" id="supervision-panel-questions" aria-labelledby="supervision-tab-questions" hidden>
      <section class="supervision-question-section"><h2>내가 감독에게 묻기</h2>
        <p>감독이 실행 중일 때 다음 점검에서 답변합니다.</p>
        <form class="supervision-ask"><label>내 질문<textarea name="text" rows="2" required maxlength="500" placeholder="예: 지금 가장 오래 막힌 작업과 이유가 뭐야?"></textarea></label><button class="btn primary" type="submit">감독에게 질문 남기기</button></form>
        <div data-question-list="supervisor"></div>
      </section>
      <section class="supervision-question-section"><h2>감독이 내게 묻기</h2><p>내 결정이나 정보가 필요한 질문입니다. 답변을 저장하면 다음 점검에 전달됩니다.</p><div data-question-list="user"></div></section>
    </section>
    </div>
  </div>`;
  const root = main.querySelector('.supervision');
  const tablist = root.querySelector('[role="tablist"]');
  function selectTab(id, focus = false) {
    for (const tab of tablist.querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.supervisionTab === id;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      root.querySelector(`#${tab.getAttribute('aria-controls')}`).hidden = !selected;
      if (selected && focus) tab.focus({ preventScroll: true });
    }
    root.scrollTop = 0;
  }
  tablist.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...tablist.querySelectorAll('[role="tab"]')];
    const current = buttons.indexOf(event.target);
    if (current < 0 || event.target.disabled) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); event.stopPropagation();
    selectTab(buttons[next].dataset.supervisionTab, true);
  });
  const config = root.querySelector('.supervision-config');
  config.addEventListener('invalid', event => {
    selectTab('config');
    const details = event.target.closest('details');
    if (details) details.open = true;
  }, true);
  const notice = root.querySelector('.supervision-notice');
  const lists = root.querySelector('.supervision-lists');
  const permissionForm = root.querySelector('.supervision-permission-form');
  const permissionDetails = root.querySelector('.supervision-permissions');
  const questionLists = [...root.querySelectorAll('[data-question-list]')];
  const workerRows = root.querySelector('.supervision-workers');
  const workerRow = (target = '', goal = '') => `<div class="supervision-worker"><label>작업 AI<input name="workerTarget" list="supervision-terminals" required maxlength="200" value="${esc(target)}" placeholder="예: ai1"></label><label>완료 조건<textarea name="workerGoal" rows="2" required maxlength="2000" placeholder="예: 로그인 오류 수정 후 회귀 테스트 통과">${esc(goal)}</textarea></label><button class="btn" type="button" data-remove-worker aria-label="이 작업 AI 제외">제외</button></div>`;
  const watchedInputs = () => [...workerRows.children].map(row => ({ target: row.querySelector('input').value.trim(), goal: row.querySelector('textarea').value.trim() }));
  const permissionSelection = () => ({ codex: permissionForm.elements.codex.value, claude: permissionForm.elements.claude.value });
  const previewPermissions = () => {
    root.querySelector('.supervision-launch-commands').innerHTML = ['codex', 'claude'].map(provider => `<p><code>${esc(agentPermissionCommand(provider, permissionSelection()))}</code></p>`).join('');
  };
  let board;
  let availableTerminals = null;
  let configDirty = false;
  let loadedConfig = '';
  const configUpdate = root.querySelector('.supervision-config-update');
  const configSignature = review => JSON.stringify([review.termId, review.alias, review.objective, review.referencePaths,
    review.watched, review.intervalMinutes, review.autoRecover, review.stallMinutes, review.runHours]);
  function applyConfig(review) {
    config.elements.target.value = review.alias || review.termId;
    config.elements.objective.value = review.objective;
    config.elements.referencePaths.value = review.referencePaths.join('\n');
    workerRows.innerHTML = review.watched.length ? review.watched.map(w => workerRow(w.alias || w.termId, w.goal)).join('') : workerRow();
    config.elements.interval.value = review.intervalMinutes;
    config.elements.autoRecover.checked = review.autoRecover === true;
    config.elements.stallMinutes.value = review.stallMinutes || 0;
    config.elements.runHours.value = review.runHours || 0;
    loadedConfig = configSignature(review);
    configUpdate.hidden = true;
  }
  let permissionsDirty = false;
  const dirtyForms = new Set();
  let busy = false;
  let refreshId = 0;
  let listSignature = '';
  hasUnsavedInput = () => configDirty || permissionsDirty || dirtyForms.size > 0 || Boolean(root.querySelector('.supervision-new-list input').value || root.querySelector('.supervision-ask textarea').value);
  saving = () => busy;
  const active = () => mounted === generation && root.isConnected;
  const error = err => { notice.hidden = false; notice.textContent = err.message || '저장하지 못했습니다. 다시 시도하세요.'; showToast(notice.textContent, 'error'); };
  const updateReadiness = () => {
    const target = config.elements.target.value.trim();
    const pinned = board?.review.alias && target === board.review.alias ? board.review.termId : '';
    const selected = availableTerminals?.find(terminal => pinned ? terminal.termId === pinned : terminal.alias === target || terminal.termId === target);
    const hours = Number(config.elements.runHours.value);
    const problems = [];
    if (!target) problems.push('감독 AI를 선택하세요.');
    else if (availableTerminals && !selected) problems.push('선택한 감독 세션이 없습니다. 실행 중인 세션을 선택하세요.');
    const watched = watchedInputs();
    if (!watched.length || watched.some(worker => !worker.target || !worker.goal)) problems.push('작업 AI와 완료 조건을 모두 적어주세요.');
    if (target && watched.some(worker => worker.target === target)) problems.push('감독 AI와 작업 AI는 서로 다른 세션을 선택하세요.');
    if (hours > 0) {
      if (!config.elements.autoRecover.checked || Number(config.elements.stallMinutes.value) < 5) problems.push('야간 운영에는 자동 복구와 5분 이상의 보고 기한이 필요합니다.');
      if (selected && (!selected.durable || !unattendedCommandReady(selected.command))) problems.push('이 세션은 야간 실행 준비가 확인되지 않았습니다. 설정 탭에서 새 세션 권한을 저장한 뒤 터미널 탭에서 새 감독 AI를 열어 선택하세요. 기존 작업 AI는 그대로 두세요.');
    }
    const html = `<strong>시작 전 확인</strong>${problems.length ? `<ul>${problems.map(problem => `<li>${esc(problem)}</li>`).join('')}</ul>` : '<p>입력 준비가 됐습니다. 시작 시 서버가 AI 실행 상태를 다시 확인합니다.</p>'}${availableTerminals === null ? '<p>세션 목록 확인 전입니다. 시작 시 서버에서 확인합니다.</p>' : ''}<small>시작은 감독 설정을 저장합니다. 실제 점검 여부는 첫 보고로 확인하세요.</small>`;
    const readiness = root.querySelector('.supervision-readiness');
    if (readiness.innerHTML !== html) readiness.innerHTML = html;
    return problems;
  };

  const taskRow = task => `<div class="supervision-task" data-task-row="${esc(task.id)}"><label><input type="checkbox" data-task="${esc(task.id)}" ${task.done ? 'checked' : ''}>${esc(task.text)} <small>${esc(task.id)}</small></label><button class="btn" type="button" data-delete-task="${esc(task.id)}">삭제</button></div>`;
  const questionRow = task => `<article class="supervision-question" data-task-row="${esc(task.id)}"><p><strong>${esc(task.text)}</strong></p><small>${esc(task.id)} · ${task.done ? '해결됨' : task.answer?.trim() ? '답변 있음' : '답변 대기'}</small>
    ${task.questionTo === 'supervisor' || task.done ? `<div class="supervision-answer"><strong>${task.questionTo === 'supervisor' ? '감독 답변' : '내 답변'}</strong><p>${esc(task.answer || '아직 답변이 없습니다.')}</p></div>` : `<form data-answer="${esc(task.id)}"><label>내 답변<textarea name="answer" rows="2" maxlength="4000">${esc(task.answer || '')}</textarea></label><button class="btn" type="submit">답변 저장</button></form>`}
    <div class="supervision-actions"><button class="btn" type="button" data-question-state="${esc(task.id)}" data-done="${!task.done}">${task.done ? '미해결로 되돌리기' : '해결됨으로 이동'}</button><button class="btn" type="button" data-delete-task="${esc(task.id)}">삭제</button></div></article>`;

  async function refresh() {
    const requestId = ++refreshId;
    try {
      const [next, terminalList] = await Promise.all([fetchJson('/api/board'), fetchJson('/api/terminals').catch(() => null)]);
      if (!active() || requestId !== refreshId) return;
      board = next;
      availableTerminals = Array.isArray(terminalList?.terminals) ? terminalList.terminals : null;
      if (board.supervisionVersion !== 6) {
        notice.hidden = false;
        notice.innerHTML = '서버 업데이트가 필요합니다. 진행 중인 중요한 작업을 마친 뒤 적용하세요. <button class="btn" type="button" data-restart>서버 업데이트…</button>';
        return;
      }
      root.querySelector('.supervision-content').hidden = false;
      tablist.hidden = false;
      const review = board.review;
      root.querySelector('#supervision-terminals').innerHTML = (availableTerminals || []).map(terminal => `<option value="${esc(terminal.alias || terminal.termId)}">${esc(terminal.projectId || '')}</option>`).join('');
      if (!permissionsDirty && !permissionForm.contains(document.activeElement)) {
        permissionForm.elements.codex.value = review.launchPermissions.codex;
        permissionForm.elements.claude.value = review.launchPermissions.claude;
        previewPermissions();
      }
      const noticeText = review.lastError || '설정과 질문·답변은 저장되며, 채팅 기록과 별개로 유지됩니다.';
      notice.hidden = !review.lastError;
      if (notice.textContent !== noticeText) notice.textContent = noticeText;
      if (!configDirty && !config.contains(document.activeElement)) applyConfig(review);
      configUpdate.hidden = !loadedConfig || configSignature(review) === loadedConfig;
      const savedGoals = root.querySelector('.supervision-saved-goals');
      savedGoals.hidden = !review.objective && !review.watched.length;
      const goalsHtml = `${review.objective ? `<h3>전체 목표</h3><p>${esc(review.objective)}</p>` : ''}${review.watched.map(worker => `<h3>${esc(worker.alias || worker.termId)} · 완료 조건</h3><p>${esc(worker.goal)}</p>`).join('')}`;
      if (savedGoals.querySelector('div').innerHTML !== goalsHtml) savedGoals.querySelector('div').innerHTML = goalsHtml;
      const status = root.querySelector('.supervision-status');
      const running = !['complete', 'stopped'].includes(review.status);
      const unanswered = board.tasks.filter(task => task.kind === 'question' && task.questionTo !== 'supervisor' && !task.done && !task.answer?.trim()).length;
      const unfinished = board.tasks.filter(task => task.kind !== 'question' && !task.done).length;
      const stalled = running ? stalledWorkerProgress(review) : [];
      const nextAction = review.status === 'complete' ? '목표 달성 보고가 도착했습니다. 보고 근거와 남은 항목을 확인하세요.'
        : stalled.length ? `${stalled.length}개 작업 AI에서 30분간 새 결과 근거가 없습니다. 진행 기록의 원인과 다음 조치를 확인하세요.`
        : running && !review.lastReviewedAt ? '설정은 저장됐습니다. 아직 첫 보고가 없습니다. 진행 기록에서 실제 점검 응답을 확인하세요.'
        : running ? '마지막 보고와 확인이 필요한 질문을 살펴보세요.' : '목표와 감독을 설정한 뒤 감독 시작을 누르세요.';
      const nextPanel = root.querySelector('.supervision-next');
      nextPanel.hidden = false;
      const nextHtml = `<p>${esc(nextAction)}</p><p>미완료 할 일 ${unfinished}개 · 답변할 질문 ${unanswered}개</p><div class="supervision-actions">${unanswered ? '<button class="btn" type="button" data-questions>답변할 질문 보기</button>' : ''}<button class="btn" type="button" data-supervision-tab="config">${running ? '설정 변경' : '목표·감독 설정'}</button>${running ? '<button class="btn" type="button" data-stop>감독만 중지</button>' : ''}</div>`;
      if (nextPanel.innerHTML !== nextHtml) nextPanel.innerHTML = nextHtml;
      config.querySelector('button[type="submit"]').textContent = running ? '설정 적용' : '감독 시작';
      updateReadiness();
      const nextCheckAt = review.recoveryAfter > Date.now() ? review.recoveryAfter : (review.pendingSince ? review.retryAt : review.nextDueAt);
      const stateLabel = running && review.recoveryAfter > Date.now() ? '복구 재시도 대기' : running && !review.lastReviewedAt ? '첫 보고 대기' : labels[review.status] || '중지됨';
      const statusHtml = `<strong>${esc(stateLabel)}</strong><p>감독 ${esc(review.alias || review.termId || '미지정')} · 대상 ${review.watched.length}개</p><p>자동 복구: ${review.autoRecover ? `켜짐 · ${review.recoveryAttempts || 0}/3회 시도` : '꺼짐'}</p>${review.runUntil ? `<p>야간 운영 종료: ${esc(stamp(review.runUntil))}</p>` : ''}<p>마지막 보고: ${esc(stamp(review.lastReviewedAt))}</p><p>${review.pendingSince ? '응답 대기 · 재요청' : '다음 점검'}: ${['complete', 'stopped'].includes(review.status) ? '없음' : esc(stamp(nextCheckAt))}</p>`;
      const progressHtml = (review.workerProgress || []).map(worker => {
        const target = review.watched.find(target => target.termId === worker.termId);
        return `<p><strong>${esc(target?.alias || worker.termId)}</strong> · ${stalled.some(item => item.termId === worker.termId) ? '진전 확인 필요 · ' : ''}마지막 새 근거: ${esc(stamp(worker.lastProgressAt))}${worker.blocker ? `<br>원인: ${esc(worker.blocker)}` : ''}${worker.nextAction ? `<br>다음 조치: ${esc(worker.nextAction)}` : ''}</p>`;
      }).join('');
      const progressStatus = statusHtml + (progressHtml ? `<p>보고 수신과 결과 진전은 별개입니다. 근거는 감독이 확인하며 서버가 진위를 검증하지는 않습니다.</p>${progressHtml}` : '');
      if (status.innerHTML !== progressStatus) status.innerHTML = progressStatus;
      root.querySelector('.supervision-reports').innerHTML = review.reports.length ? review.reports.slice().reverse().map(r => `<article><small>${esc(stamp(r.at))} · ${esc(labels[r.status] || r.status)}</small><p>${esc(r.text)}</p></article>`).join('') : '<p>아직 보고가 없습니다. 감독을 시작하면 여기에 쌓입니다.</p>';
      const signature = JSON.stringify([board.checklists, board.tasks.filter(task => task.kind !== 'question')]);
      if (![...dirtyForms].some(form => lists.contains(form)) && !lists.contains(document.activeElement) && signature !== listSignature) {
        lists.innerHTML = board.checklists.map(list => `<article data-list="${esc(list.id)}"><h3>${esc(list.title)} <small>${esc(list.id)}</small></h3>
          <form data-goal><label>목표 / 완료 조건<textarea name="goal" rows="2" maxlength="4000">${esc(list.goal || '')}</textarea></label><button class="btn" type="submit">목표 저장</button></form>
          ${board.tasks.filter(t => t.checklistId === list.id && t.kind !== 'question' && !t.done).map(taskRow).join('')}
          <details class="supervision-resolved"><summary>완료한 작업 ${board.tasks.filter(t => t.checklistId === list.id && t.kind !== 'question' && t.done).length}개</summary>${board.tasks.filter(t => t.checklistId === list.id && t.kind !== 'question' && t.done).map(taskRow).join('')}</details>
          <form data-add><label>할 일<input name="text" required maxlength="500"></label><button class="btn" type="submit">할 일 추가</button></form>
        </article>`).join('') || '<p>체크리스트를 만들고 할 일과 완료 조건을 적어두세요.</p>';
        listSignature = signature;
      }
      for (const container of questionLists) {
        const questions = board.tasks.filter(task => task.kind === 'question' && (task.questionTo || 'user') === container.dataset.questionList);
        const html = questions.filter(task => !task.done).map(questionRow).join('') || '<p class="supervision-empty">미해결 질문이 없습니다.</p>';
        const resolved = questions.filter(task => task.done);
        const content = html + `<details class="supervision-resolved"><summary>해결된 질문 ${resolved.length}개</summary>${resolved.map(questionRow).join('')}</details>`;
        if (container._questionsHtml !== content) {
          const focused = container.contains(document.activeElement) ? document.activeElement : null;
          const selection = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
          const preserved = [...container.querySelectorAll('[data-task-row]')].filter(row => row.contains(focused) || [...dirtyForms].some(form => row.contains(form)));
          const wasOpen = container.querySelector('.supervision-resolved')?.open;
          container.innerHTML = content;
          for (const row of preserved) {
            const replacement = [...container.querySelectorAll('[data-task-row]')].find(item => item.dataset.taskRow === row.dataset.taskRow);
            if (replacement) replacement.replaceWith(row);
            else container.prepend(row); // Keep a draft even if another client deleted its question.
          }
          container.querySelector('.supervision-resolved').open = Boolean(wasOpen);
          focused?.focus({ preventScroll: true });
          if (selection) focused.setSelectionRange(...selection);
          container._questionsHtml = preserved.length ? '' : content;
        }
      }
    } catch (err) { if (active()) error(err); }
  }

  async function save(operation, done, failed) {
    if (busy) return;
    busy = true;
    ++refreshId;
    const controls = [...root.querySelectorAll('input, textarea, select, button')];
    controls.forEach(control => { control.disabled = true; });
    try { await operation(); if (active()) { done?.(); await refresh(); showToast('저장됨', 'success'); } }
    catch (err) { if (active()) { failed?.(); error(err); } }
    finally { controls.forEach(control => { control.disabled = false; }); busy = false; }
  }

  config.addEventListener('input', () => { configDirty = true; updateReadiness(); });
  permissionForm.addEventListener('input', () => { permissionsDirty = true; previewPermissions(); });
  permissionForm.addEventListener('submit', event => {
    event.preventDefault();
    save(() => send('/api/board/permissions', 'PUT', permissionSelection()), () => { permissionsDirty = false; });
  });
  root.addEventListener('input', event => { const form = event.target.closest('[data-answer], [data-goal], [data-add]'); if (form) dirtyForms.add(form); });
  config.addEventListener('submit', event => {
    event.preventDefault();
    if (!configUpdate.hidden) return error(new Error('다른 세션의 최신 설정이 있습니다. 작성 중인 내용을 보관하고 최신 설정을 불러온 뒤 다시 적용하세요.'));
    const problems = updateReadiness();
    if (problems.length) {
      root.querySelector('.supervision-readiness').scrollIntoView({ block: 'center' });
      return error(new Error(problems[0]));
    }
    const watched = watchedInputs();
    if (!watched.length || watched.length > 12 || watched.some(w => !w.target || !w.goal)) return error(new Error('작업 AI와 완료 조건을 확인하세요. 최대 12개입니다.'));
    // Retain stable IDs when reapplying a saved configuration after alias renumbering.
    const target = config.elements.target.value.trim();
    const resolveSaved = alias => board.review.watched.find(w => alias === w.alias || alias === w.termId)?.termId || alias;
    save(() => send('/api/board/review', 'PUT', { target: target === board.review.alias ? board.review.termId : target,
      objective: config.elements.objective.value, watched: watched.map(w => ({ ...w, target: resolveSaved(w.target) })),
      referencePaths: config.elements.referencePaths.value.split('\n').map(path => path.trim()).filter(Boolean),
      intervalMinutes: Number(config.elements.interval.value), autoRecover: config.elements.autoRecover.checked,
      stallMinutes: Number(config.elements.stallMinutes.value), runHours: Number(config.elements.runHours.value) }), () => { configDirty = false; });
  });
  root.addEventListener('click', async event => {
    if (event.target.closest('[data-reload-config]')) {
      if (configDirty && !confirm('작성 중인 감독 설정을 버리고 서버에 저장된 최신 설정을 불러올까요?')) return;
      configDirty = false;
      applyConfig(board.review);
      updateReadiness();
    }
    const tab = event.target.closest('[data-supervision-tab]');
    if (tab) selectTab(tab.dataset.supervisionTab, !tablist.contains(tab));
    if (event.target.closest('[data-add-worker]')) {
      if (workerRows.children.length >= 12) return error(new Error('작업 AI는 최대 12개까지 지정할 수 있습니다.'));
      workerRows.insertAdjacentHTML('beforeend', workerRow());
      configDirty = true; updateReadiness(); workerRows.lastElementChild.querySelector('input').focus();
    }
    if (event.target.closest('[data-remove-worker]')) {
      event.target.closest('.supervision-worker').remove();
      configDirty = true; updateReadiness();
    }
    if (event.target.closest('[data-permissions]')) { selectTab('config'); permissionDetails.open = true; permissionForm.elements.codex.focus(); }
    if (event.target.closest('[data-questions]')) {
      selectTab('questions');
      const findQuestion = () => [...root.querySelectorAll('[data-answer]')].find(form => board.tasks.some(task => task.id === form.dataset.answer && !task.done && !task.answer?.trim()));
      if (!findQuestion() && ![...dirtyForms].some(form => form.matches('[data-answer]'))) await refresh();
      const first = findQuestion();
      if (first) first.querySelector('textarea').focus();
      else {
        notice.hidden = false;
        notice.textContent = '새 질문이 도착했습니다. 작성 중인 항목을 저장하면 질문 목록이 갱신됩니다. 입력은 유지했습니다.';
        showToast(notice.textContent, 'info');
        [...dirtyForms].find(form => form.matches('[data-answer]'))?.querySelector('textarea')?.focus();
      }
    }
    const resolve = event.target.closest('[data-question-state]');
    if (resolve) {
      const form = resolve.closest('[data-task-row]').querySelector('form');
      if (dirtyForms.has(form)) return error(new Error('작성 중인 답변을 먼저 저장하세요.'));
      save(() => send(`/api/board/tasks/${resolve.dataset.questionState}`, 'PATCH', { done: resolve.dataset.done === 'true' }), () => resolve.blur());
    }
    const remove = event.target.closest('[data-delete-task]');
    if (remove) {
      const task = board.tasks.find(task => task.id === remove.dataset.deleteTask);
      if (!task) return error(new Error('이미 삭제된 항목입니다. 작성 중인 내용을 보관하고 보드를 다시 여세요.'));
      if (!confirm(task.kind === 'question' ? '이 질문과 답변을 삭제할까요? 삭제 후에는 되돌릴 수 없습니다.' : '이 작업을 삭제할까요? 삭제 후에는 되돌릴 수 없습니다.')) return;
      const row = remove.closest('[data-task-row]');
      save(() => send(`/api/board/tasks/${task.id}`, 'DELETE'), () => { dirtyForms.delete(row.querySelector('form')); row.remove(); });
    }
    if (event.target.closest('[data-stop]')) save(() => send('/api/board/review', 'PUT', { target: '', intervalMinutes: board.review.intervalMinutes }));
    if (event.target.closest('[data-restart]')) {
      if (!confirm('감독 기능을 적용하기 위해 콕핏 서버를 재시작할까요? 연결이 잠시 끊길 수 있습니다.')) return;
      try { await send('/api/server/restart', 'POST', {}); notice.textContent = '업데이트 적용 중… 연결되면 설정 화면이 열립니다.'; }
      catch (err) { error(err); }
    }
  });
  root.addEventListener('change', event => {
    if (!event.target.matches('[data-task]')) return;
    const checkbox = event.target;
    const checked = checkbox.checked;
    save(() => send(`/api/board/tasks/${checkbox.dataset.task}`, 'PATCH', { done: checked }), () => checkbox.blur(), () => { checkbox.checked = !checked; });
  });
  async function changeBoard(change) {
    const base = await fetchJson('/api/board');
    const next = structuredClone(base);
    change(next);
    return send('/api/board', 'PUT', { board: next, base, revision: base.revision });
  }
  function editedValue(field, current) {
    if (current !== field.defaultValue && current !== field.value) {
      throw new Error('다른 곳에서 같은 항목을 수정했습니다. 입력은 유지했습니다. 최신 내용을 확인한 뒤 다시 편집하세요.');
    }
    return field.value;
  }
  root.addEventListener('submit', event => {
    const form = event.target;
    if (form === config || form === permissionForm) return;
    event.preventDefault();
    const listId = form.closest('[data-list]')?.dataset.list;
    let operation;
    if (form.matches('[data-answer]')) operation = () => changeBoard(next => {
      const task = next.tasks.find(t => t.id === form.dataset.answer);
      if (!task) throw new Error('질문이 삭제되었습니다.');
      task.answer = editedValue(form.elements.answer, task.answer || '');
    });
    if (form.matches('[data-add]')) operation = () => send('/api/board/tasks', 'POST', { checklistId: listId, kind: 'task', text: form.elements.text.value });
    if (form.matches('.supervision-ask')) operation = () => send('/api/board/tasks', 'POST', { kind: 'question', questionTo: 'supervisor', text: form.elements.text.value });
    if (form.matches('[data-goal]')) operation = () => changeBoard(next => { const list = next.checklists.find(l => l.id === listId); if (!list) throw new Error('체크리스트가 삭제되었습니다.'); list.goal = editedValue(form.elements.goal, list.goal || ''); });
    if (form.matches('.supervision-new-list')) operation = () => changeBoard(next => { next.checklists.push({ id: `C-${String(next.nextChecklistNumber++).padStart(4, '0')}`, title: form.elements.title.value, goal: '' }); });
    if (operation) save(operation, () => {
      dirtyForms.delete(form);
      const field = form.querySelector('textarea');
      if (field && !form.matches('.supervision-ask')) field.defaultValue = field.value;
      if (form.matches('[data-add], .supervision-new-list, .supervision-ask')) form.reset();
      if (form.contains(document.activeElement)) document.activeElement.blur();
    });
  });
  refresh();
  timer = setInterval(() => { if (active() && !busy) refresh(); }, 5000);
}
