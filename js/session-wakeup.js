import { fetchJson } from './utils.js';

export function mountSessionWakeup(root, { termId, draft }) {
  const state = draft.wakeup ||= { dirty: false, busy: false, fetchedAt: 0 };
  root.innerHTML = `<form class="sm-form">
    <div class="sm-fields">
      <label class="sm-pause"><input name="enabled" type="checkbox"><span>PM 깨우기<small>대기·승인 필요·상태 확인 불가·AI 종료가 오래 이어지면 점검을 요청합니다.</small></span></label>
      <label>대기 시간(초)<input name="afterSeconds" type="number" min="1" max="86400" step="1" value="600" required></label>
      <label>PM 웹훅 주소<input name="url" type="url" maxlength="2048" placeholder="http://127.0.0.1:8644/webhooks/cockpit"></label>
      <label>서명 키<input name="secret" type="password" minlength="16" maxlength="512" autocomplete="new-password" placeholder="수신 측과 같은 키 · 비우면 기존 키 유지"></label>
      <p class="sm-hint">실행 중이면 대기 시간을 초기화합니다. 같은 상태가 이어지면 설정한 간격마다 다시 요청합니다. 화면을 닫아도 감시는 계속됩니다.</p>
    </div>
    <p class="sm-message" role="status" data-wakeup-status></p>
    <footer class="sm-save"><span data-wakeup-dirty>세션별로 저장됩니다.</span><button type="submit" class="sm-primary" disabled>깨우기 설정 저장</button></footer>
  </form>`;
  const form = root.querySelector('form'), fields = form.elements;
  const status = root.querySelector('[data-wakeup-status]');
  const endpoint = `/api/terminals/${encodeURIComponent(termId)}/wakeup`;
  let timer;
  const read = () => ({ enabled: fields.enabled.checked, afterSeconds: Number(fields.afterSeconds.value), url: fields.url.value.trim() });
  function render() {
    const value = state.values || state.config;
    if (value) {
      fields.enabled.checked = value.enabled;
      fields.afterSeconds.value = value.afterSeconds;
      fields.url.value = value.url;
    }
    fields.secret.value = state.secret || '';
    fields.url.required = fields.enabled.checked;
    fields.secret.placeholder = state.config?.secretConfigured ? '기존 서명 키 설정됨 · 비우면 유지' : '수신 측과 같은 키 · 선택 사항';
    for (const field of form.elements) field.disabled = state.busy;
    form.querySelector('button').disabled = !state.dirty || state.busy;
    root.querySelector('[data-wakeup-dirty]').textContent = state.dirty ? '저장하지 않은 변경 있음' : '세션별로 저장됩니다.';
    status.textContent = state.message || state.config?.lastError || (state.config?.lastSentAt
      ? `최근 점검 요청 · ${new Date(state.config.lastSentAt).toLocaleString('ko-KR')}`
      : state.config?.enabled ? '감시 중 · 설정한 시간이 지나면 PM에 요청합니다.' : '감시 꺼짐');
  }
  function refresh() {
    render();
    if (!root.isConnected || root.closest('[hidden]') || root.ownerDocument.hidden) return;
    if (!timer) timer = root.ownerDocument.defaultView.setTimeout(() => { timer = null; refresh(); }, 5000);
    if (state.pending || state.busy || Date.now() - state.fetchedAt < 5000) return;
    state.fetchedAt = Date.now();
    state.pending = fetchJson(endpoint).then(config => {
      state.config = config;
      if (!state.dirty) state.values = config;
      state.message = '';
    }).catch(error => { state.message = error.message; }).finally(() => { state.pending = null; render(); });
    return state.pending;
  }
  form.addEventListener('input', () => {
    state.values = { ...read(), afterSeconds: fields.afterSeconds.value }; state.secret = fields.secret.value; state.dirty = true; state.message = ''; render();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.busy || !state.dirty || !form.reportValidity()) return;
    const values = read();
    if (state.secret) values.secret = state.secret;
    state.busy = true; state.message = '저장 중…'; render();
    try {
      state.config = await fetchJson(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      state.values = state.config; state.dirty = false; state.secret = ''; state.message = state.config.enabled ? '저장됨 · 지금부터 대기 시간을 측정합니다.' : '저장됨 · 감시를 껐습니다.';
    } catch (error) { state.message = error.message; }
    finally { state.busy = false; render(); }
  });
  render();
  return refresh;
}
