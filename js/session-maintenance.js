import { esc, fetchJson } from './utils.js';
import { mountAccountSwitch } from './account-switch.js';
import { subscribe } from './state.js';

const labels = { busy: '실행 중', idle: '입력 대기', offline: 'AI 종료·셸 대기', approval: '승인·로그인 대기', limited: '한도 소진', paused: '일시정지', unknown: '상태 확인 불가', interrupted: '중단됨' };
const memory = kib => Number.isFinite(kib) ? `${(kib / 1024).toFixed(1)} MiB` : '측정 불가';
const stamp = at => at ? new Date(at).toLocaleString('ko-KR') : '기록 없음';
const reasons = { too_young: '시작 후 10분 이내 · 보호 중', unverified_session: '종료된 콕핏 세션 소유인지 확인 불가' };

export function mountSessionMaintenance(root, onChanged) {
  let snapshot, loading = false, pending = false, tab = 'sessions', checkedAt = 0, accountTermId = '';
  root.disposeMaintenance?.();
  const closedIds = new Set(), latestIncarnations = new Map();
  const key = session => `${session.termId}:${session.incarnation || ''}`;
  const offClosed = subscribe('terminalClosedIncarnation', session => {
    if (!session?.termId || !session.incarnation) return;
    const { termId: id, incarnation } = session;
    closedIds.add(key(session));
    if (!snapshot) return;
    snapshot.sessions = snapshot.sessions.filter(current => key(current) !== key(session));
    for (const row of list.querySelectorAll('[data-maint-session]')) {
      if (row.dataset.maintSession === id && row.dataset.maintIncarnation === incarnation) row.remove();
    }
    if (accountTermId === id && !snapshot.sessions.some(current => current.termId === id)) { accountSwitch.close(); accountTermId = ''; }
    render();
  });
  const offCreated = subscribe('terminalIncarnation', session => {
    latestIncarnations.set(session.termId, session.incarnation);
    if (snapshot) snapshot.sessions = snapshot.sessions.filter(old => old.termId !== session.termId || old.incarnation === session.incarnation);
  });
  root.disposeMaintenance = () => { offClosed(); offCreated(); };
  root.className = 'wo-maintenance';
  root.innerHTML = `<summary>세션·메모리 관리 <span data-maint-summary>종료 세션 보관 · 재개 · 잔여 MCP 정리</span></summary>
    <div class="wo-maint-body"><div class="wo-maint-toolbar"><div role="group" aria-label="세션 관리 목록">${[['sessions', '열린 세션'], ['archived', '보관 기록'], ['processes', '잔여 프로세스']].map(([key, label]) => `<button type="button" data-maint-tab="${key}" aria-pressed="${key === tab}">${label}</button>`).join('')}</div><button type="button" data-maint-refresh>새로고침</button></div>
    <p class="wo-maint-status" role="status">펼치면 현재 프로세스를 확인합니다.</p><div class="wo-maint-list"></div><section class="wo-maint-accounts" aria-label="저장 계정 선택" hidden></section><pre class="wo-maint-history" tabindex="0" aria-label="보관된 터미널 기록" hidden></pre></div>`;
  const list = root.querySelector('.wo-maint-list');
  const status = root.querySelector('[role="status"]');
  const history = root.querySelector('pre');
  const accountPanel = root.querySelector('.wo-maint-accounts');
  const accountSwitch = mountAccountSwitch(accountPanel, {
    onPending: value => { pending = value; render(); },
    onStatus: message => { status.textContent = message; }, onChanged,
    onClose: () => {
      const button = [...list.querySelectorAll('[data-maint-action="accounts"]')].find(item => item.dataset.termId === accountTermId);
      accountTermId = '';
      (button || root.querySelector('[data-maint-refresh]')).focus();
    },
  });
  const action = (name, id, label, disabled = false) => {
    const session = [...snapshot.sessions, ...snapshot.archived].find(item => item.termId === id);
    return `<button type="button" data-maint-action="${name}" data-term-id="${esc(id)}" data-incarnation="${esc(session?.incarnation || '')}" ${disabled || pending ? 'disabled' : ''}>${label}</button>`;
  };
  function render() {
    if (!snapshot) return;
    const { sessions, archived, processes } = snapshot;
    root.querySelector('[data-maint-summary]').textContent = `열림 ${sessions.length} · 보관 ${archived.length} · 정리 가능 ${processes.orphans.filter(item => item.eligible).length}`;
    list.querySelectorAll('[data-maint-action]').forEach(button => {
      const session = [...sessions, ...archived].find(item => item.termId === button.dataset.termId);
      button.disabled = pending || (button.dataset.maintAction === 'resume' && !session?.canResume)
        || (button.dataset.maintAction === 'archive' && !session?.canArchive);
    });
    if (list.contains(document.activeElement) && !pending) return;
    if (tab === 'sessions') {
      list.innerHTML = sessions.map(session => `<article class="wo-maint-row" data-maint-session="${esc(session.termId)}" data-maint-incarnation="${esc(session.incarnation || '')}"><div><strong>${esc(session.alias || session.termId)}</strong><span>${esc(labels[session.activity?.state] || labels.unknown)}</span><small>${esc(session.account?.name ? `실행 설정 · ${session.account.name}` : '기본 로그인 확인')} · 마지막 출력 ${esc(stamp(session.lastOutputAt))}</small></div><span class="wo-maint-memory">${memory(session.rssKiB)}</span><div class="wo-maint-actions">${session.activity?.agent === 'jcode' ? action('accounts', session.termId, '계정 전환') : ''}${action('resume', session.termId, '다시 실행', !session.canResume)}${action('archive', session.termId, '보관', !session.canArchive)}</div></article>`).join('') || '<p>열린 세션이 없습니다.</p>';
      const accountRow = [...list.querySelectorAll('[data-maint-session]')].find(item => item.dataset.maintSession === accountTermId);
      if (accountRow) accountRow.appendChild(accountPanel);
      else if (accountTermId && !pending) { accountSwitch.close(); accountTermId = ''; }
      list.insertAdjacentHTML('beforeend', '<p class="wo-maint-note">프로세스가 종료된 세션만 보관·재개합니다. 셸이 남아 있으면 작업을 마무리하고 터미널의 닫기 버튼을 누르세요. 출력은 보관 기록에 남습니다. 다시 실행하면 목표·체크리스트는 유지되며, 대화 이어가기는 AI의 기록 선택이 필요할 수 있습니다. 메모리는 세션 프로세스 합계로 공유 페이지가 중복될 수 있습니다.</p>');
    } else if (tab === 'archived') {
      list.innerHTML = [...archived].reverse().map(session => `<article class="wo-maint-row"><div><strong>${esc(session.alias || session.termId)}</strong><small>${esc(stamp(session.archivedAt))} · ${session.reason === 'exited' ? '프로세스 종료' : '보관됨'}</small></div><div class="wo-maint-actions">${action('history', session.termId, '기록 보기')}${action('resume', session.termId, '다시 열기', !session.canResume)}${action('delete', session.termId, '기록 삭제')}</div></article>`).join('') || '<p>보관된 세션이 없습니다. 종료하거나 보관한 세션의 마지막 출력이 여기에 남습니다.</p>';
    } else {
      list.innerHTML = processes.orphans.map(item => `<article class="wo-maint-row"><div><strong>${esc(item.name)} <small>PID ${item.pid}</small></strong><span>${esc(item.eligible ? '종료된 콕핏 세션의 잔여 MCP' : reasons[item.reason] || '소유권 확인 필요')}</span></div><span class="wo-maint-memory">${memory(item.rssKiB)}</span><div class="wo-maint-actions"><button type="button" data-maint-cleanup="${item.pid}" data-start-ticks="${esc(item.startTicks)}" ${pending || !item.eligible ? 'disabled' : ''}>정리</button></div></article>`).join('') || '<p>발견된 고아 MCP가 없습니다.</p>';
      list.insertAdjacentHTML('beforeend', `<p class="wo-maint-note">종료 세션 소유가 확인된 MCP만 30분마다 자동 정리합니다. 시작 후 10분 이내 프로세스와 사용 중인 세션은 보호합니다.</p><p>좀비 프로세스 ${processes.zombies.length}개 · RSS 0 MiB</p><p class="wo-maint-note">좀비는 종료됐지만 부모가 아직 회수하지 않은 기록입니다. 부모 세션을 강제로 종료하지 않습니다.</p>`);
    }
  }
  async function refresh(force = false) {
    if (!root.open || loading || pending || document.hidden || (!force && Date.now() - checkedAt < 15000)) return;
    loading = true;
    try {
      snapshot = await fetchJson('/api/terminals/maintenance', { timeoutMs: 8000 });
      snapshot.sessions = snapshot.sessions.filter(session => !closedIds.has(key(session))
        && (!latestIncarnations.has(session.termId) || latestIncarnations.get(session.termId) === session.incarnation));
      checkedAt = Date.now();
      status.textContent = `${new Date(checkedAt).toLocaleTimeString('ko-KR')} 확인 · 열린 동안 15초마다 갱신`;
      render();
    } catch (error) { status.textContent = `세션 관리 조회 실패 · ${error.message}`; }
    finally { loading = false; }
  }
  async function run(button) {
    if (pending || loading) return;
    const name = button.dataset.maintAction || 'cleanup';
    if (name === 'delete' && !confirm('보관된 터미널 출력 기록을 삭제할까요? 목표와 체크리스트는 유지됩니다.')) return;
    const payload = name === 'cleanup' ? { action: name, processes: [{ pid: Number(button.dataset.maintCleanup), startTicks: button.dataset.startTicks }] }
      : { action: name, termId: button.dataset.termId, incarnation: button.dataset.incarnation };
    pending = true; status.textContent = '처리 중…'; render();
    let message = '';
    try {
      const result = await fetchJson('/api/terminals/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 15000 });
      if (name === 'history') { history.hidden = false; history.textContent = result.output || '남아 있는 터미널 출력이 없습니다.'; history.focus(); }
      else { history.hidden = true; onChanged?.(); }
      message = name === 'cleanup' ? `종료 요청 ${result.signalled.length}개 · 상태가 달라져 제외 ${result.skipped.length}개` : '처리 완료';
    } catch (error) { message = error.message; }
    finally { pending = false; checkedAt = 0; if (name !== 'history') await refresh(true); else render(); status.textContent = message; }
  }
  root.addEventListener('toggle', () => { if (root.open) refresh(true); });
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.maintTab) {
      tab = button.dataset.maintTab; history.hidden = true; accountPanel.hidden = true;
      root.querySelectorAll('[data-maint-tab]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      render();
    } else if (button.hasAttribute('data-maint-refresh')) refresh(true);
    else if (button.dataset.maintAction === 'accounts') {
      if (pending || loading) return;
      accountTermId = button.dataset.termId;
      button.closest('[data-maint-session]').appendChild(accountPanel);
      accountSwitch.open(snapshot.sessions.find(item => item.termId === accountTermId));
    }
    else if (button.dataset.maintAction || button.dataset.maintCleanup) run(button);
  });
  return refresh;
}
