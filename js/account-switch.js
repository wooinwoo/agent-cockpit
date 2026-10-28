import { esc, fetchJson } from './utils.js';

export function mountAccountSwitch(panel, { onPending, onStatus, onChanged, onClose, onAccounts } = {}) {
  let target, accounts = [], pending = false;
  const report = message => {
    onStatus?.(message);
    const status = panel.querySelector('[data-maint-account-status]');
    if (status) status.textContent = message;
  };
  const setPending = value => {
    pending = value;
    panel.querySelectorAll('button, select').forEach(control => { control.disabled = value; });
    onPending?.(value);
  };
  async function open(next, selectedId) {
    if (pending) return;
    const focusOrigin = document.activeElement;
    target = next;
    accounts = [];
    onAccounts?.([]);
    panel.hidden = false;
    panel.textContent = '계정 목록을 불러오고 있습니다.';
    setPending(true);
    report('등록된 계정 확인 중…');
    try {
      const result = await fetchJson(`/api/terminals/${encodeURIComponent(target.termId)}/accounts`, { timeoutMs: 8000 });
      accounts = result.accounts;
      if (onAccounts) {
        panel.textContent = '';
        onAccounts(accounts, selectedId);
        report('현재 모델과 같은 제공자의 계정에서 전환을 누르세요.');
        return;
      }
      panel.innerHTML = `<strong>${esc(target.alias || target.termId)} · 저장 계정으로 전환</strong>
        <p class="wo-maint-note">현재 모델과 같은 제공자의 계정을 선택하세요. 첫 연결은 대화를 저장한 뒤 다시 연결하며 목표·체크리스트를 유지합니다. 모델은 바뀌지 않습니다.</p>
        ${accounts.length ? `<label>사용할 계정 <select data-maint-account-select>${accounts.map((account, index) => `<option value="${index}" ${account.available ? '' : 'disabled'}>${esc(`${account.provider === 'claude' ? 'Claude' : 'OpenAI'} · ${account.name || account.email || account.label}${account.name && account.email ? ` · ${account.email}` : ''} · ${account.source === 'cockpit' ? '콕핏 등록' : 'jcode 저장'}${account.isDefault ? ' (기본)' : ''}${account.available ? '' : account.source === 'cockpit' ? ' (연결 확인 필요)' : ' (로그인 필요)'}`)}</option>`).join('')}</select></label><button class="btn" type="button" data-maint-account-switch>선택 계정으로 전환</button>` : '<p>저장된 로그인이 없습니다. AI 계정 탭에서 계정을 등록하세요.</p>'}
        <p class="wo-maint-status" role="status" data-maint-account-status></p>
        <p class="wo-maint-note">${accounts.some(account=>account.authEngine==='jcode') ? 'jcode 인증 계정은 계정별 실행 환경에 다시 연결합니다. 다른 계정의 세션에는 영향을 주지 않습니다.' : '공용 기본 계정도 바뀌어 같은 jcode 서버의 다른 세션에 영향을 줄 수 있습니다. ‘기본’은 저장값으로 현재 연결 계정과 다를 수 있습니다.'}</p>
        <p class="wo-maint-note">빈 입력창에서 전환합니다. 작업·승인·작성 중인 입력은 먼저 마무리하세요. 멈춘 작업은 전환 후 재개하며 취소된 인증은 재로그인이 필요합니다.</p>
        <button class="btn" type="button" data-maint-account-close>닫기</button>`;
      const select = panel.querySelector('select');
      if (select) {
        const selected = accounts.findIndex(account => account.available && account.id === selectedId);
        const defaultIndex = accounts.findIndex(account => account.available && account.isDefault);
        select.value = String(selected >= 0 ? selected : defaultIndex >= 0 ? defaultIndex : accounts.findIndex(account => account.available));
        if (document.activeElement === focusOrigin || (document.activeElement === document.body && !focusOrigin.isConnected)) select.focus();
      }
      report(`저장 계정 ${accounts.length}개 확인`);
    } catch (error) {
      panel.innerHTML = `<p class="wo-maint-status" role="status" data-maint-account-status></p><button class="btn" type="button" data-maint-account-retry>다시 불러오기</button><button class="btn" type="button" data-maint-account-close>닫기</button>`;
      report(`계정 조회 실패 · ${error.message}`);
    } finally {
      setPending(false);
      const button = panel.querySelector('[data-maint-account-switch]');
      if (button) button.disabled = !accounts.some(account => account.available);
    }
  }
  async function switchAccount(accountId) {
    const account = typeof accountId === 'string' ? accounts.find(item => item.id === accountId)
      : accounts[Number(panel.querySelector('select')?.value)];
    if (pending || !account?.available) return;
    const current = target;
    setPending(true);
    report(account.requiresConnection ? '대화 저장 후 계정 연결 중… 최대 40초 걸릴 수 있습니다.' : '전환 명령 전달 중…');
    let connected = false, message;
    try {
      const result = await fetchJson(`/api/terminals/${encodeURIComponent(current.termId)}/account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(account.source === 'cockpit' ? { accountId: account.id } : { provider: account.provider, label: account.label, selectionKey: account.selectionKey }), timeoutMs: 50000 });
      message = result.message || '전환 명령 전달됨 · 터미널의 계정 전환 결과를 확인하세요.';
      connected = result.connected === true;
      if (connected) onChanged?.();
    } catch (error) { message = `계정 전환 보류 · ${error.message}`; }
    finally {
      setPending(false);
      if (connected || account.requiresConnection || onAccounts) await open(current, account.id);
      report(message);
    }
  }
  function close() {
    if (pending) return;
    const visible = !panel.hidden;
    panel.hidden = true;
    accounts = [];
    onAccounts?.([]);
    target = null;
    if (visible) onClose?.();
  }
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || pending) return;
    if (button.hasAttribute('data-maint-account-switch')) switchAccount();
    else if (button.hasAttribute('data-maint-account-retry')) open(target);
    else if (button.hasAttribute('data-maint-account-close')) close();
  });
  return { open, close, switchAccount, get pending() { return pending; } };
}
