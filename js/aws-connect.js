import { esc, fetchJson, postJson, copyText } from './utils.js';

let root, data, timer, loading = false, loadFailed = false, mutating = false, selectedLog = '', tab = 'connections';
const databaseSelections = new Map();
try { for (const [id, name] of Object.entries(JSON.parse(localStorage.getItem('cockpit-aws-databases') || '{}'))) databaseSelections.set(id, name); } catch { /* storage unavailable */ }
const phaseNames = { starting: '시작 중', running: '프로세스 실행 중', retrying: '재연결 대기', 'auth-required': '인증·권한 확인', blocked: '포트 사용 중', error: '실행 실패', stopped: '중지됨', external: '기존 실행 감지' };

export function awsConnectionStatus(runtime) {
  if (runtime.phase === 'running' && runtime.portOpen) return '로컬 포트 열림';
  if (runtime.phase === 'running') return '연결 준비 중';
  return phaseNames[runtime.phase] || '상태 확인 필요';
}
function status(text, error = false, inline = null) {
  loadFailed = false;
  const area = root.querySelector('[data-aws-status]');
  area.textContent = text;
  area.dataset.error = String(error);
  if (inline) {
    inline.textContent = text; inline.dataset.error = String(error);
    if (error && inline.offsetParent) inline.scrollIntoView({ block: 'nearest' });
  }
}
function chooseTab(name) {
  tab = name;
  root.querySelectorAll('[data-aws-tab]').forEach(button => {
    const active = button.dataset.awsTab === name;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  root.querySelectorAll('[data-aws-panel]').forEach(panel => { panel.hidden = panel.dataset.awsPanel !== name; });
}
function render() {
  root.querySelector('[data-aws-add]').disabled = mutating;
  root.querySelector('[data-aws-editor]').hidden = false;
  root.querySelector('[data-aws-auth-form]').hidden = false;
  const focusKeys = ['awsStart', 'awsStop', 'awsStopExternal', 'awsLog', 'awsEdit', 'awsCopy', 'awsLogout', 'awsDatabase', 'awsCopyDatabase'];
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const focusedKey = focused && focusKeys.find(key => key in focused.dataset);
  const focusedId = focusedKey ? focused.dataset[focusedKey] : null;
  const targets = data.targets || [];
  const missing = Object.entries({ aws: 'AWS CLI', basti: 'basti', sessionManager: 'Session Manager plugin' }).filter(([key]) => !data.dependencies?.[key]).map(([, name]) => name);
  const dependency = root.querySelector('[data-aws-dependencies]');
  dependency.hidden = !missing.length;
  dependency.textContent = missing.length ? `설치 필요: ${missing.join(', ')}. 콕핏을 실행한 환경의 PATH에서 사용할 수 있어야 합니다.` : '';
  const connectionHtml = targets.map(({ config: c, runtime: r }) => {
    const databases = c.databases || [];
    const selected = databases.includes(databaseSelections.get(c.id)) ? databaseSelections.get(c.id) : databases[0];
    if (selected) databaseSelections.set(c.id, selected);
    return `<article class="aws-row" data-aws-id="${esc(c.id)}">
    <div class="aws-target"><strong>${esc(c.label)}</strong><span>${esc(c.rdsInstance)}</span>${c.customTarget ? `<span>${esc(c.customTarget.host)}:${c.customTarget.port}</span>` : ''}<span>${esc(c.profile)} · ${esc(c.region)}</span></div>
    <div class="aws-endpoint"><button type="button" data-aws-copy="${esc(c.id)}" title="접속 주소 복사">127.0.0.1:${c.localPort}</button><span>MySQL · DB 계정은 클라이언트에서 입력</span>
    ${databases.length ? `<label>서비스 DB · ${databases.length}개<select data-aws-database="${esc(c.id)}">${databases.map(name => `<option value="${esc(name)}"${name === selected ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label><button type="button" data-aws-copy-database="${esc(c.id)}">접속 정보 복사</button>` : '<span>DB 이름은 설정에서 추가할 수 있습니다.</span>'}</div>
    <div class="aws-runtime"><strong data-phase="${esc(r.phase === 'running' && !r.portOpen ? 'starting' : r.phase)}">${esc(awsConnectionStatus(r))}</strong><span>${esc(r.message)}</span>${r.phase === 'running' && r.portOpen ? '<span>DB 쿼리·원격 DB 상태는 미검증</span>' : ''}</div>
    <div class="aws-actions">${r.managed ? `<button type="button" data-aws-stop="${esc(c.id)}" ${mutating ? 'disabled' : ''}>종료</button>` : `<button type="button" class="aws-primary" data-aws-start="${esc(c.id)}" ${mutating || r.portOpen || missing.length ? 'disabled' : ''}>${['error', 'auth-required', 'blocked'].includes(r.phase) ? '다시 시작' : '시작'}</button>`}
    ${r.canStopExternal ? `<button type="button" data-aws-stop-external="${esc(c.id)}" ${mutating ? 'disabled' : ''}>기존 터널 종료</button>` : ''}
    <button type="button" data-aws-log="${esc(c.id)}" aria-expanded="${selectedLog === c.id}">로그</button>
    <button type="button" data-aws-edit="${esc(c.id)}" ${mutating || r.managed ? 'disabled' : ''}>설정</button></div>
  </article>`;
  }).join('') || '<div class="aws-empty">등록된 연결이 없습니다. 연결 추가로 대상을 등록하세요.</div>';
  const list = root.querySelector('[data-aws-connections]');
  if (focused?.matches('[data-aws-database]')) {
    // Keep the focused native menu, while applying runtime and action changes immediately.
    const next = document.createElement('div'); next.innerHTML = connectionHtml;
    const existing = new Map([...list.children].map(row => [row.dataset.awsId, row]));
    for (const row of [...next.children]) {
      const current = existing.get(row.dataset.awsId); existing.delete(row.dataset.awsId);
      const select = row.querySelector('[data-aws-database]');
      const sameChoices = select && focused.closest('[data-aws-id]') === current
        && JSON.stringify([...select.options].map(option => option.value)) === JSON.stringify([...focused.options].map(option => option.value));
      if (sameChoices) {
        for (const selector of ['.aws-target', '.aws-runtime', '.aws-actions']) current.querySelector(selector).replaceWith(row.querySelector(selector));
        current.querySelector('[data-aws-copy]').textContent = row.querySelector('[data-aws-copy]').textContent;
      } else if (current) current.replaceWith(row);
      else list.append(row);
    }
    for (const row of existing.values()) row.remove();
  } else list.innerHTML = connectionHtml;
  const log = root.querySelector('[data-aws-log-panel]');
  const target = targets.find(row => row.config.id === selectedLog);
  log.hidden = !target;
  if (target) {
    root.querySelector('[data-aws-log-title]').textContent = `${target.config.label} · 최근 실행 로그`;
    const pre = root.querySelector('[data-aws-log-text]');
    const follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 35;
    pre.textContent = target.runtime.logs?.join('\n') || '콕핏에서 시작한 실행의 로그가 여기에 표시됩니다. 기존 외부 실행 로그는 읽지 않습니다.';
    if (follow) pre.scrollTop = pre.scrollHeight;
  }
  const profile = root.querySelector('[name="profile"]');
  const previous = profile.value;
  const names = data.profiles || [];
  const profileOptions = names.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('') || '<option value="">로컬 AWS 프로필 없음</option>';
  if (profile.dataset.options !== profileOptions) { profile.innerHTML = profileOptions; profile.dataset.options = profileOptions; }
  if (names.some(p => p.name === previous)) profile.value = previous;
  if (!previous || profile.value !== previous) profileChanged();
  const active = data.sessions || [];
  root.querySelector('[data-aws-sessions]').innerHTML = active.map(s => {
    const expired = s.expiresAt && s.expiresAt <= Date.now();
    const remaining = s.expiresAt ? Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 60000)) : null;
    return `<div class="aws-session"><div><strong>${esc(s.profile)}</strong><span>${s.mfa ? expired ? 'MFA 만료 · 재인증 필요' : `MFA 인증됨 · ${remaining}분 남음` : '기존 프로필 확인됨 · 만료 시각 미조회'}</span><span>${esc(s.identity)}</span></div><button type="button" data-aws-logout="${esc(s.profile)}" ${mutating ? 'disabled' : ''}>인증 해제·터널 종료</button></div>`;
  }).join('') || '<p class="aws-empty">인증 확인 내역이 없습니다. 저장된 프로필로 DB 터널을 바로 시작할 수 있습니다.</p>';
  const targetProfile = root.querySelector('[name="targetProfile"]');
  const previousTargetProfile = targetProfile.value;
  if (targetProfile.dataset.options !== profileOptions) { targetProfile.innerHTML = profileOptions; targetProfile.dataset.options = profileOptions; }
  if (previousTargetProfile) targetProfile.value = names.some(p => p.name === previousTargetProfile) ? previousTargetProfile : '';
  root.querySelectorAll('form input, form select, form textarea, form button').forEach(control => { control.disabled = mutating; });
  root.querySelectorAll('[data-aws-auth-form] input, [data-aws-auth-form] select, [data-aws-auth-form] button').forEach(control => { control.disabled = mutating || !names.length; });
  if (focusedKey) {
    const replacement = [...root.querySelectorAll('button,select')].find(button => button.dataset[focusedKey] === focusedId && !button.disabled);
    if (replacement) replacement.focus({ preventScroll: true });
    else root.querySelector(`[data-aws-tab="${tab}"]`).focus({ preventScroll: true });
  }
}
async function refresh(announce = false) {
  if (loading || mutating) return;
  loading = true;
  try {
    data = await fetchJson('/api/aws-connect', { timeoutMs: 12000 });
    render();
    if (announce || loadFailed) status('현재 실행 상태를 확인했습니다.');
    loadFailed = false;
    root.querySelector('[data-aws-updated]').textContent = `갱신 ${new Date().toLocaleTimeString('ko-KR')}`;
  } catch (error) {
    status(`연결 상태를 불러오지 못했습니다. ${error.message}`, true);
    loadFailed = true;
    if (!data) {
      const list = root.querySelector('[data-aws-connections]');
      const message = document.createElement('p'); message.className = 'aws-empty';
      message.textContent = '연결 목록을 불러오지 못했습니다. 새로고침으로 다시 시도하세요.';
      list.replaceChildren(message);
      root.querySelector('[data-aws-sessions]').textContent = 'AWS 프로필을 불러오지 못했습니다. 새로고침으로 다시 시도하세요.';
    }
  } finally { loading = false; }
}
async function action(name, body, success) {
  if (mutating) return false;
  const inline = name === 'auth' ? root.querySelector('[data-aws-auth-status]') : ['save', 'delete'].includes(name) ? root.querySelector('[data-aws-edit-status]') : null;
  mutating = true;
  root.querySelectorAll('form input, form select, form textarea, form button, [data-aws-add], [data-aws-edit], [data-aws-start], [data-aws-stop], [data-aws-stop-external], [data-aws-logout]').forEach(control => { control.disabled = true; });
  status('요청 처리 중…', false, inline);
  let ok = false;
  try {
    await postJson(`/api/aws-connect/${name}`, body, { timeoutMs: 35000 });
    status(success, false, inline); ok = true;
  } catch (error) { status(error.message || '요청을 처리하지 못했습니다.', true, inline); }
  finally {
    mutating = false;
    await refresh();
  }
  return ok;
}
function profileChanged() {
  const form = root.querySelector('[data-aws-auth-form]');
  const profile = data?.profiles?.find(p => p.name === form.elements.profile.value);
  form.elements.region.value = profile ? profile.region || 'ap-northeast-2' : '';
  form.elements.mfaArn.value = profile?.mfaArn || '';
  form.elements.code.value = '';
  root.querySelector('[data-aws-mfa]').open = false;
  root.querySelector('[data-aws-auth-status]').textContent = '';
}
function editTarget(id = '') {
  if (mutating) return;
  const details = root.querySelector('[data-aws-editor]');
  const form = root.querySelector('[data-aws-target-form]');
  const target = data?.targets?.find(row => row.config.id === id)?.config;
  form.reset();
  root.querySelector('[data-aws-edit-status]').textContent = '';
  form.elements.targetId.value = target?.id || `db-${Date.now().toString(36)}`;
  form.elements.label.value = target?.label || '';
  form.elements.targetProfile.value = target?.profile || data?.profiles?.[0]?.name || '';
  form.elements.targetRegion.value = target?.region || 'ap-northeast-2';
  form.elements.rdsInstance.value = target?.rdsInstance || '';
  form.elements.localPort.value = target?.localPort || 13308;
  form.elements.databases.value = (target?.databases || []).join('\n');
  form.elements.customVpc.value = target?.customTarget?.vpcId || '';
  form.elements.customHost.value = target?.customTarget?.host || '';
  form.elements.customPort.value = target?.customTarget?.port || 3306;
  root.querySelector('[data-aws-custom]').open = Boolean(target?.customTarget);
  root.querySelector('[data-aws-delete]').hidden = !target;
  details.open = true;
  form.elements.label.focus();
  details.scrollIntoView({ block: 'nearest' });
}
function mount() {
  root.innerHTML = `<header class="aws-head"><div><h1>AWS 연결</h1><p>저장된 AWS 프로필로 DB 터널을 시작하고 관리합니다.</p></div><div class="aws-toolbar"><span data-aws-updated></span><button type="button" data-aws-refresh>새로고침</button><button type="button" data-aws-add disabled>연결 추가</button></div></header>
    <div class="aws-tabs" role="tablist" aria-label="AWS 연결 메뉴"><button type="button" id="aws-connections-tab" role="tab" aria-controls="aws-connections-panel" aria-selected="true" data-aws-tab="connections">DB 터널</button><button type="button" id="aws-auth-tab" role="tab" aria-controls="aws-auth-panel" aria-selected="false" tabindex="-1" data-aws-tab="auth">AWS 인증</button></div>
    <p class="aws-notice" data-aws-dependencies hidden></p><p class="aws-status" data-aws-status role="status" aria-live="polite">연결 상태 확인 중…</p>
    <section id="aws-connections-panel" role="tabpanel" aria-labelledby="aws-connections-tab" data-aws-panel="connections">
      <p class="aws-hint">터널을 시작한 뒤 서비스 DB를 선택하고 접속 정보를 복사하세요. DBeaver·Navicat에서 붙여 넣고 DB 계정을 입력합니다. 주소는 콕핏 서버가 실행되는 컴퓨터 기준입니다.</p>
      <div class="aws-list" data-aws-connections><p class="aws-empty">등록된 연결을 불러오는 중…</p></div>
      <aside class="aws-log" data-aws-log-panel hidden><div><h2 data-aws-log-title>실행 로그</h2><button type="button" data-aws-close-log>로그 닫기</button></div><pre data-aws-log-text tabindex="0" aria-label="터널 실행 로그"></pre></aside>
      <details class="aws-editor" data-aws-editor hidden><summary>연결 설정</summary><form data-aws-target-form><input type="hidden" name="targetId">
        <label>표시 이름<input name="label" required maxlength="80" placeholder="예: 주문 DB 운영"></label><label>AWS 프로필<select name="targetProfile" required></select></label>
        <label>리전<input name="targetRegion" required value="ap-northeast-2" placeholder="ap-northeast-2"></label><label>RDS 인스턴스 ID<input name="rdsInstance" required maxlength="63" placeholder="예: orders-prod"></label>
        <label>로컬 포트<input name="localPort" type="number" min="1024" max="65535" required value="13308"></label>
        <label class="aws-wide">DB 목록<textarea name="databases" rows="3" placeholder="DB 이름을 줄마다 하나씩 입력하세요"></textarea><span class="aws-hint">같은 터널에서 사용할 DB 이름입니다. 실제 DB를 생성하거나 권한을 변경하지 않습니다.</span></label>
        <details class="aws-mfa aws-wide" data-aws-custom><summary>기존 VPC로 직접 연결 · 읽기 전용 주소 등</summary><div class="aws-mfa-fields">
        <label>VPC ID<input name="customVpc" maxlength="21" placeholder="vpc-0123456789abcdef0"></label><label class="aws-wide">DB 호스트<input name="customHost" maxlength="253" placeholder="DB의 DNS 주소"></label><label>DB 포트<input name="customPort" type="number" min="1" max="65535" value="3306"></label>
        <p class="aws-hint aws-wide">VPC와 호스트를 함께 입력하면 RDS ID 대신 이 주소로 연결합니다. 해당 VPC에 설정된 기존 경유 서버를 사용합니다.</p>
        </div></details>
        <div class="aws-form-actions"><button type="submit" class="aws-primary" data-aws-mutate>설정 저장</button><button type="button" data-aws-delete hidden>연결 삭제</button><button type="button" data-aws-cancel-edit>닫기</button></div>
        <p class="aws-inline-status aws-wide" data-aws-edit-status></p>
        <p class="aws-hint">설정에는 대상·프로필·포트만 저장합니다. 시작하면 basti가 지정한 RDS의 접속 경로를 엽니다. AWS 프로필 권한에 따라 접속용 리소스를 준비할 수 있습니다.</p>
      </form></details>
      <p class="aws-footnote">콕핏 실행은 프로세스 종료 시 최대 5회 재연결합니다. 인증·권한 오류는 자동 재시도를 멈춥니다. 기존 외부 실행은 자동으로 종료하거나 인수하지 않습니다.</p>
    </section>
    <section id="aws-auth-panel" role="tabpanel" aria-labelledby="aws-auth-tab" data-aws-panel="auth" hidden>
      <form class="aws-auth-form" data-aws-auth-form autocomplete="off" hidden>
        <label>AWS 프로필<select name="profile" required></select></label><label>리전<input name="region" required value="ap-northeast-2"></label>
        <div class="aws-form-actions aws-wide"><button type="button" class="aws-primary" data-aws-check-profile data-aws-mutate>기존 인증 확인</button></div>
        <p class="aws-hint aws-wide">MFA가 없는 프로필은 코드를 입력할 필요가 없습니다. DB 터널 탭에서 바로 시작할 수 있습니다.</p>
        <details class="aws-mfa aws-wide" data-aws-mfa><summary>MFA 코드로 인증 (필요한 경우)</summary><div class="aws-mfa-fields">
        <label class="aws-wide">MFA 기기 ARN<input name="mfaArn" maxlength="256" placeholder="arn:aws:iam::123456789012:mfa/device"></label>
        <label>6자리 MFA 코드<input name="code" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
        <div class="aws-form-actions"><button type="submit" data-aws-mutate>MFA 인증</button></div>
        <p class="aws-hint aws-wide">임시 인증은 서버 메모리에만 보관하며 서버 재시작 시 해제됩니다.</p>
        </div></details>
        <p class="aws-inline-status aws-wide" data-aws-auth-status></p>
      </form>
      <div data-aws-sessions></div>
    </section>`;
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    const d = button.dataset;
    if ('awsTab' in d) chooseTab(d.awsTab);
    if ('awsRefresh' in d) await refresh(true);
    if ('awsAdd' in d) { chooseTab('connections'); editTarget(); }
    if ('awsEdit' in d) editTarget(d.awsEdit);
    if ('awsCancelEdit' in d) root.querySelector('[data-aws-editor]').open = false;
    if ('awsStart' in d) await action('start', { id: d.awsStart }, '시작 요청을 받았습니다. 실행 상태와 로그를 확인하세요.');
    if ('awsStop' in d) await action('stop', { id: d.awsStop }, '콕핏에서 시작한 터널을 종료했습니다.');
    if ('awsStopExternal' in d) await action('stop-external', { id: d.awsStopExternal }, '확인된 기존 터널 프로세스를 종료했습니다.');
    if ('awsLogout' in d) await action('logout', { profile: d.awsLogout }, '인증과 해당 프로필의 콕핏 터널을 해제했습니다.');
    if ('awsCopy' in d) { const row = data.targets.find(row => row.config.id === d.awsCopy); const copied = await copyText(`127.0.0.1:${row.config.localPort}`); status(copied ? '접속 주소를 복사했습니다.' : '복사하지 못했습니다. 표시된 접속 주소를 직접 복사하세요.', !copied); }
    if ('awsCopyDatabase' in d) {
      const row = data.targets.find(row => row.config.id === d.awsCopyDatabase);
      const database = databaseSelections.get(row.config.id);
      if (!row.config.databases?.includes(database)) { status('사용할 DB를 선택하세요.', true); return; }
      const copied = await copyText(`Host: 127.0.0.1\nPort: ${row.config.localPort}\nDatabase: ${database}`);
      status(copied ? `${database} 접속 정보를 복사했습니다. DB 클라이언트에서 계정을 입력하세요.` : '복사하지 못했습니다. 화면의 주소·포트·DB 이름을 직접 입력하세요.', !copied);
    }
    if ('awsLog' in d) { selectedLog = selectedLog === d.awsLog ? '' : d.awsLog; render(); }
    if ('awsCloseLog' in d) { selectedLog = ''; render(); }
    if ('awsCheckProfile' in d) {
      const form = root.querySelector('[data-aws-auth-form]');
      await action('auth', { profile: form.elements.profile.value, region: form.elements.region.value, code: '' }, '기존 AWS 프로필로 사용자를 확인했습니다.');
    }
    if ('awsDelete' in d) {
      const form = root.querySelector('[data-aws-target-form]');
      if (await action('delete', { id: form.elements.targetId.value }, '연결 설정을 삭제했습니다. AWS 리소스는 변경하지 않았습니다.')) root.querySelector('[data-aws-editor]').open = false;
    }
  });
  root.addEventListener('change', event => {
    const select = event.target.closest('[data-aws-database]');
    if (!select) return;
    databaseSelections.set(select.dataset.awsDatabase, select.value);
    try { localStorage.setItem('cockpit-aws-databases', JSON.stringify(Object.fromEntries(databaseSelections))); } catch { /* storage unavailable */ }
  });
  root.querySelector('.aws-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); chooseTab(event.key === 'Home' ? 'connections' : event.key === 'End' ? 'auth' : tab === 'auth' ? 'connections' : 'auth');
    root.querySelector(`[data-aws-tab="${tab}"]`).focus();
  });
  root.querySelector('[name="profile"]').addEventListener('change', profileChanged);
  root.querySelector('[data-aws-mfa]').addEventListener('toggle', event => { if (!event.target.open) root.querySelector('[name="code"]').value = ''; });
  root.querySelector('[data-aws-auth-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    if (!root.querySelector('[data-aws-mfa]').open) {
      await action('auth', { profile: form.elements.profile.value, region: form.elements.region.value, code: '' }, '기존 AWS 프로필로 사용자를 확인했습니다.');
      return;
    }
    const request = { profile: form.elements.profile.value, region: form.elements.region.value, mfaArn: form.elements.mfaArn.value.trim(), code: form.elements.code.value };
    if (!request.code || !request.mfaArn) { status('MFA 기기 ARN과 6자리 코드를 입력하세요.', true, root.querySelector('[data-aws-auth-status]')); return; }
    form.elements.code.value = '';
    await action('auth', request, 'MFA 인증을 완료했습니다. DB 터널에서 시작할 연결을 선택하세요.');
  });
  root.querySelector('[data-aws-target-form]').addEventListener('submit', async event => {
    event.preventDefault(); const f = event.target.elements;
    const request = { id: f.targetId.value, label: f.label.value.trim(), profile: f.targetProfile.value, region: f.targetRegion.value.trim(), rdsInstance: f.rdsInstance.value.trim(), localPort: Number(f.localPort.value), databases: f.databases.value.split(/[\n,]/).map(name => name.trim()).filter(Boolean) };
    if (f.customVpc.value.trim() || f.customHost.value.trim()) request.customTarget = { vpcId: f.customVpc.value.trim(), host: f.customHost.value.trim(), port: Number(f.customPort.value) };
    if (await action('save', request, '연결 설정을 저장했습니다.')) root.querySelector('[data-aws-editor]').open = false;
  });
}
export function initAwsConnect() {
  root = document.getElementById('aws-connect-view');
  if (!root.querySelector('[data-aws-connections]')) mount();
  refresh(true);
  if (!timer) timer = setInterval(() => { if (root.classList.contains('active') && !document.hidden) refresh(); }, 3000);
}
export function destroyAwsConnect() {
  clearInterval(timer); timer = null;
  const code = root?.querySelector('[name="code"]');
  if (code) code.value = '';
}
