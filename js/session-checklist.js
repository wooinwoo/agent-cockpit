import { esc, fetchJson } from './utils.js';

export function mountSessionChecklist(panel, { termId, draft, getSupervisorId, onSaved }) {
  panel.innerHTML = `<header class="sc-heading"><div><h3>내 작업 체크리스트</h3><p data-sc-count>불러오는 중…</p></div><progress max="1" value="0" aria-label="체크리스트 완료 항목"></progress></header>
    <form class="sc-add"><label>할 일 추가<input name="text" required maxlength="500" placeholder="다음에 수행할 일을 적어주세요" autocomplete="off"></label><button type="submit">추가</button></form>
    <p class="sc-notice" role="status"></p><div class="sc-items" data-sc-open></div>
    <details class="sc-completed"><summary>완료한 작업 <span data-sc-done-count>0</span></summary><div class="sc-items" data-sc-done></div></details>
    <p class="sm-hint">세션별 최대 50개. 새 항목 추가 시 오래된 완료 항목부터 정리됩니다. 미완료 작업은 유지합니다.</p>`;
  const form = panel.querySelector('form');
  const input = form.elements.text;
  const notice = panel.querySelector('.sc-notice');
  const setNotice = value => { draft.taskMessage = value; notice.textContent = value; };
  setNotice(draft.taskMessage || '');
  input.value = draft.checklistText || '';
  input.addEventListener('input', () => { draft.checklistText = input.value; });
  let tasks = [], lastBoard;
  const status = task => task.done ? 'done' : task.status || 'ready';
  const labels = { ready: '실행 가능', running: '진행 중', blocked: '막힘', done: '완료' };
  const focusKeys = ['scToggle', 'scDelete', 'scState', 'scEdit', 'scBlocker', 'scDependency', 'scBlockSave', 'scBlockCancel'];
  function update(board) {
    lastBoard = board;
    notice.textContent = draft.taskMessage || '';
    if (input.value !== (draft.checklistText || '')) input.value = draft.checklistText || '';
    tasks = (board?.tasks || []).filter(task => task.termId === termId && task.kind !== 'question');
    const done = tasks.filter(task => task.done);
    panel.querySelector('[data-sc-count]').textContent = `${done.length} / ${tasks.length} 완료 · 가능 ${tasks.filter(t => status(t) === 'ready').length} · 진행 ${tasks.filter(t => status(t) === 'running').length} · 막힘 ${tasks.filter(t => status(t) === 'blocked').length}`;
    panel.querySelector('[data-sc-done-count]').textContent = String(done.length);
    const progress = panel.querySelector('progress');
    progress.max = tasks.length || 1; progress.value = done.length;
    const orphaned = draft.blockEdit && !tasks.some(task => task.id === draft.blockEdit.id && !task.done);
    const row = task => {
      const state = status(task), editor = !task.done && draft.blockEdit?.id === task.id ? draft.blockEdit : null;
      const options = selected => {
        const candidates = (board?.tasks || []).filter(item => item.id !== task.id && (!item.done || item.id === selected));
        return '<option value="">대기 항목 선택</option>' + candidates.map(item => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.id)} · ${esc(item.text.slice(0, 80))}</option>`).join('')
          + (selected && !candidates.some(item => item.id === selected) ? `<option value="${esc(selected)}" selected>${esc(selected)} · 현재 목록에 없는 항목</option>` : '');
      };
      return `<div class="sc-row" data-sc-id="${esc(task.id)}" data-sc-status="${state}"><label><input type="checkbox" data-sc-toggle="${esc(task.id)}" ${task.done ? 'checked' : ''}><span>${esc(task.text)}<small>${esc(task.id)} · ${labels[state]}</small>${state === 'blocked' ? `<small class="sc-wait">${esc(task.blocker || '')} · ${(task.waitFor || []).map(esc).join(', ')}</small>` : ''}</span></label><button type="button" data-sc-delete="${esc(task.id)}" aria-label="${esc(task.text)} 삭제">삭제</button>
        ${!task.done && task.status ? `<div class="sc-task-controls"><select data-sc-state="${esc(task.id)}" aria-label="${esc(task.text)} 작업 상태">${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${state === value ? 'selected' : ''}>${label}</option>`).join('')}</select>${state === 'blocked' ? `<button type="button" data-sc-edit="${esc(task.id)}">대기 조건</button>` : ''}</div>` : ''}
        ${editor ? `<form class="sc-block-edit" data-sc-block-form="${esc(task.id)}"><h4>막힘 조건</h4><label>어떤 결과가 필요한가요?<textarea data-sc-blocker="${esc(task.id)}" required maxlength="1000" rows="2">${esc(editor.blocker)}</textarea></label>${editor.waitFor.map((id, index) => `<label>기다리는 작업·질문 ${index + 1}<select data-sc-dependency="${esc(task.id)}" data-sc-index="${index}">${options(id)}</select></label>`).join('')}<p>선택한 항목의 답변이나 결과가 바뀌면 재점검합니다. 실행 권한은 별도로 확인합니다.</p><div class="sc-block-actions">${editor.waitFor.length < 10 ? `<button type="button" data-sc-add-dependency="${esc(task.id)}">항목 추가</button>` : ''}<button type="button" data-sc-block-cancel="${esc(task.id)}">취소</button><button type="submit" data-sc-block-save="${esc(task.id)}">막힘 저장</button></div></form>` : ''}</div>`;
    };
    for (const [selector, items, empty] of [['[data-sc-open]', tasks.filter(task => !task.done), '미완료 작업이 없습니다. 다음 할 일을 추가하세요.'], ['[data-sc-done]', done.slice().reverse(), '완료 체크한 작업이 여기에 남습니다.']]) {
      const list = panel.querySelector(selector);
      const recovery = selector === '[data-sc-open]' && orphaned ? `<div class="sc-block-edit"><h4>작성 중인 대기 조건 보관</h4><p>대상 ${esc(draft.blockEdit.id)}이 완료되거나 삭제됐습니다. 입력은 남아 있습니다. 필요한 내용을 복사한 뒤 닫으세요.</p><textarea data-sc-blocker="${esc(draft.blockEdit.id)}" aria-label="보관된 대기 사유" rows="3">${esc(draft.blockEdit.blocker)}</textarea><p>대기 항목: ${draft.blockEdit.waitFor.map(esc).join(', ')}</p><button type="button" data-sc-block-cancel="${esc(draft.blockEdit.id)}">보관된 입력 닫기</button></div>` : '';
      const html = recovery + (items.map(row).join('') || `<p class="sc-empty">${empty}</p>`);
      // Preserve focus and pending checkbox state while reports are polling.
      if (!draft.taskBusy && list._html !== html) {
        const focus = list.contains(document.activeElement) ? document.activeElement : null;
        const key = focusKeys.find(key => focus?.dataset[key]);
        const id = key && focus.dataset[key], index = focus?.dataset.scIndex;
        list.innerHTML = html; list._html = html;
        if (id) [...list.querySelectorAll('button, input, select, textarea')].find(el => el.dataset[key] === id && el.dataset.scIndex === index)?.focus({ preventScroll: true });
      }
    }
    panel.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = Boolean(draft.taskBusy); });
  }
  async function change(url, method, body, added = false) {
    if (draft.taskBusy) return;
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const focusedKey = focusKeys.find(key => focused?.dataset[key]);
    const focusedId = focusedKey && focused.dataset[focusedKey];
    let failed = false;
    draft.taskBusy = true; setNotice('저장 중…');
    panel.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = true; });
    try {
      const result = await fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (body?.status && !result.task?.status) throw new Error('작업 상태 저장을 지원하는 서버로 갱신한 뒤 다시 시도하세요.');
      if (added) { input.value = ''; draft.checklistText = ''; }
      if (body?.status && draft.blockEdit && url.endsWith(`/${draft.blockEdit.id}`)) draft.blockEdit = null;
      draft.taskBusy = false; setNotice('저장됨');
      onSaved(result.board);
    } catch (error) {
      failed = true; draft.taskBusy = false; setNotice(error.message);
      onSaved();
      for (const task of tasks) {
        const checkbox = [...panel.querySelectorAll('[data-sc-toggle]')].find(el => el.dataset.scToggle === task.id);
        if (checkbox) checkbox.checked = task.done;
        const select = [...panel.querySelectorAll('[data-sc-state]')].find(el => el.dataset.scState === task.id);
        if (select) select.value = status(task);
      }
    } finally {
      panel.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = false; });
      if (focused && panel.isConnected && (document.activeElement === document.body || document.activeElement === focused)) {
        const original = failed && focused.isConnected ? focused : [...panel.querySelectorAll('button, input, select, textarea')].find(el => el.dataset[focusedKey] === focusedId && !el.closest('details:not([open])'));
        (added ? input : original || panel.querySelector('[data-sc-open] input') || input).focus({ preventScroll: true });
      }
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (input.value.trim()) change('/api/board/tasks', 'POST', { text: input.value.trim(), termId, supervisorId: getSupervisorId() }, true);
  });
  panel.addEventListener('change', event => {
    const id = event.target.dataset.scToggle || event.target.dataset.scState;
    const task = tasks.find(task => task.id === id);
    if (event.target.dataset.scDependency && draft.blockEdit) draft.blockEdit.waitFor[Number(event.target.dataset.scIndex)] = event.target.value;
    if (!task) return;
    const expected = { expectedUpdatedAt: task.updatedAt, expectedStatus: status(task) };
    if (event.target.dataset.scToggle) change(`/api/board/tasks/${id}`, 'PATCH', { done: event.target.checked, ...expected });
    else if (event.target.value === 'blocked') {
      draft.blockEdit = { id, blocker: task.blocker || '', waitFor: task.waitFor?.length ? [...task.waitFor] : [''], ...expected };
      setNotice('대기 항목과 해제 조건을 선택하고 저장하세요.');
      update(lastBoard);
      panel.querySelector('[data-sc-blocker]')?.focus({ preventScroll: true });
    } else change(`/api/board/tasks/${id}`, 'PATCH', { status: event.target.value, ...expected });
  });
  panel.addEventListener('input', event => { if (event.target.dataset.scBlocker && draft.blockEdit) draft.blockEdit.blocker = event.target.value; });
  panel.addEventListener('submit', event => {
    if (!event.target.dataset.scBlockForm || !draft.blockEdit) return;
    event.preventDefault();
    const task = tasks.find(task => task.id === draft.blockEdit.id);
    const waitFor = draft.blockEdit.waitFor.filter(Boolean);
    if (!waitFor.length) { setNotice('기다리는 작업이나 질문을 하나 이상 선택하세요.'); return; }
    if (task) change(`/api/board/tasks/${task.id}`, 'PATCH', { status: 'blocked', blocker: draft.blockEdit.blocker, waitFor,
      expectedUpdatedAt: draft.blockEdit.expectedUpdatedAt, expectedStatus: draft.blockEdit.expectedStatus });
  });
  panel.addEventListener('click', event => {
    if (event.target.closest('[data-sc-block-cancel]')) { draft.blockEdit = null; update(lastBoard); return; }
    if (event.target.closest('[data-sc-add-dependency]') && draft.blockEdit) { draft.blockEdit.waitFor.push(''); update(lastBoard); return; }
    const edit = event.target.closest('[data-sc-edit]');
    if (edit) {
      const task = tasks.find(task => task.id === edit.dataset.scEdit);
      if (task) { draft.blockEdit = { id: task.id, blocker: task.blocker || '', waitFor: task.waitFor?.length ? [...task.waitFor] : [''], expectedUpdatedAt: task.updatedAt, expectedStatus: status(task) }; update(lastBoard); panel.querySelector('[data-sc-blocker]')?.focus({ preventScroll: true }); }
      return;
    }
    const button = event.target.closest('[data-sc-delete]');
    if (button && confirm('이 체크리스트 항목을 삭제할까요?')) change(`/api/board/tasks/${button.dataset.scDelete}`, 'DELETE');
  });
  return update;
}
