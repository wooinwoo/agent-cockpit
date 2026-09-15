import { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import './AiAccounts.css';

const LOGIN_CMD = { claude: 'claude login', codex: 'codex login' };

// ─── Presentational formatters (same output as vanilla js/ai-accounts.js) ───
function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function fmtReset(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMinutes()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function resetLabel(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '초기화 정보 없음';
  const minutes = Math.max(0, Math.round((date.getTime() - Date.now()) / 60000));
  let relative;
  if (minutes < 60) relative = `${minutes}분 후`;
  else if (minutes < 1440) relative = `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 후`;
  else relative = `${Math.floor(minutes / 1440)}일 ${Math.floor((minutes % 1440) / 60)}시간 후`;
  return `${relative} · ${fmtReset(value)}`;
}

function Metric({ label, value, resetAt, tone }) {
  const known = Number.isFinite(value);
  const width = known ? Math.max(0, Math.min(100, value)) : 0;
  const parts = resetLabel(resetAt).split('·');
  const relative = parts[0]?.trim() || '';
  const absolute = parts[1]?.trim() || '';
  const resetText = resetAt
    ? <>{relative}{absolute ? <> <i className="abs">{absolute}</i></> : null}</>
    : (known ? '' : '정보 없음');
  return (
    <div className="ai-account-metric">
      <div><span>{label}</span><strong>{known ? `${Math.round(value)}%` : '—'}</strong></div>
      <div
        className="ai-account-meter"
        role="progressbar"
        aria-label={label}
        aria-valuemin="0"
        aria-valuemax="100"
        {...(known ? { 'aria-valuenow': Math.round(width) } : { 'aria-valuetext': '정보 없음' })}
      >
        <span className={tone} style={{ width: `${width}%` }} />
      </div>
      <small>{resetText}</small>
    </div>
  );
}

function StateBadge({ state, note }) {
  const label = state === 'ready' ? '사용 가능' : state === 'warning' ? '확인 필요' : '로그인 필요';
  return (
    <span className={`ai-account-state ${state}`} title={note || ''}>
      <i />{label}
    </span>
  );
}

function AccountCard({ account, onChanged }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetM, setBudgetM] = useState(account.weeklyTokenBudget ? Math.round(account.weeklyTokenBudget / 1e6) : 40);
  const isCockpit = account.source === 'cockpit';

  async function runTest() {
    setTesting(true);
    try {
      const r = await postJson(`/api/ai-accounts/${account.id}/test`, {});
      setResult(r);
      onChanged();
    } finally {
      setTesting(false);
    }
  }

  async function copyLoginCmd() {
    try {
      await navigator.clipboard.writeText(LOGIN_CMD[account.provider] || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 클립보드 사용 불가 */ }
  }

  function openTerminal() {
    const loginMode = isCockpit && account.state === 'login';
    window.dispatchEvent(new CustomEvent('cockpit:open-terminal', {
      detail: { accountId: account.id, loginMode },
    }));
    window.dispatchEvent(new CustomEvent('cockpit:switch-view', { detail: 'terminal' }));
  }

  async function deleteAccount() {
    if (!window.confirm(`"${account.name}" 계정을 삭제할까요? 콕핏이 만든 로그인 정보도 함께 삭제됩니다.\n이 계정으로 열린 터미널이 있으면 로그인이 풀려 동작이 멈출 수 있습니다.`)) return;
    try {
      await fetchJson(`/api/ai-accounts/${account.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      alert(e.message);
    }
  }

  async function saveBudget() {
    const m = Math.round(parseFloat(budgetM));
    if (!Number.isFinite(m) || m < 0) return;
    try {
      await postJson(`/api/ai-accounts/${account.id}/budget`, { weeklyTokenBudget: m * 1_000_000 });
      setEditingBudget(false);
      onChanged();
    } catch (e) {
      alert(e.message);
    }
  }

  // 콕핏 계정은 주간 예산 기준으로만 %를 앎 — 5시간 미터는 데이터가 없으니 숨김
  const showSessionMeter = !isCockpit && (Number.isFinite(account.sessionRemaining) || account.sessionResetAt);
  const noWeeklyData = !Number.isFinite(account.weeklyRemaining);
  const showBudgetHint = isCockpit && !account.weeklyTokenBudget && noWeeklyData;
  const showCollectingHint = isCockpit && account.weeklyTokenBudget && noWeeklyData;

  return (
    <article className={`ai-account-row ${account.provider}`}>
      <div className="ai-account-identity">
        <span className="ai-account-mark" aria-hidden="true">{account.provider === 'claude' ? 'C' : 'X'}</span>
        <div>
          <h2>{account.name}</h2>
          <p>{account.email || account.provider}</p>
        </div>
      </div>
      <div className="ai-account-meta">
        <span>{account.provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
        {account.plan ? <span>{account.plan}</span> : null}
        <span>{account.bridge}</span>
      </div>
      <div className="ai-account-limits">
        {showBudgetHint ? (
          <div className="ai-account-nobudget">주간 잔여량 — <strong>예산 미설정</strong><small>예산을 설정하면 사용량 %가 표시됩니다</small></div>
        ) : showCollectingHint ? (
          <div className="ai-account-nobudget">주간 잔여량 — <strong>집계 중</strong><small>터미널 사용 기록이 쌓이면 표시됩니다</small></div>
        ) : (
          <Metric label="주간 잔여량" value={account.weeklyRemaining} resetAt={account.weeklyResetAt} tone="weekly" />
        )}
        {showSessionMeter ? (
          <Metric label="5시간 잔여량" value={account.sessionRemaining} resetAt={account.sessionResetAt} tone="session" />
        ) : null}
        {account.usage ? (
          <div className="ai-account-usage">
            주간 사용 {fmtTokens(account.usage.weeklyTokens)}토큰
            {account.weeklyTokenBudget ? ` / ${fmtTokens(account.weeklyTokenBudget)} (예산)` : ''} · 5시간 {fmtTokens(account.usage.sessionTokens)}토큰
            {account.usage.weeklyResetAt ? ` · 주간 풀림(추정) ${fmtReset(account.usage.weeklyResetAt)}` : ''}
            <small>콕핏 로컬 계산</small>
          </div>
        ) : null}
        {isCockpit && account.state === 'login' && (
          <div className="ai-account-login-hint">
            <span>로그인 터미널을 열면 자동 실행:</span>
            <code>{LOGIN_CMD[account.provider]}</code>
            <button className="btn" type="button" onClick={copyLoginCmd}>{copied ? '복사됨' : '복사'}</button>
            <small>브라우저 인증 후 돌아오면 자동 갱신됩니다</small>
          </div>
        )}
        {!isCockpit && account.state === 'login' && (
          <div className="ai-account-login-hint">
            <span>허브 프로필에 로그인 정보가 없습니다.</span>
            <small>허브(.codex-account-launcher) 도구에서 로그인하세요</small>
          </div>
        )}
        {result && (
          <div className={`ai-account-test ${result.ok ? 'pass' : 'fail'}`}>
            {result.checks.map((c) => (
              <div key={c.label}><b>{c.ok ? '✓' : '✗'}</b> {c.label} — {c.detail}</div>
            ))}
          </div>
        )}
        {account.provider === 'claude' && (editingBudget ? (
          <div className="ai-account-budget-edit">
            <input
              type="number" min="0" step="1" value={budgetM}
              onChange={(e) => setBudgetM(e.target.value)}
              aria-label="주간 토큰 예산 (백만 단위)"
            />
            <span>M 토큰/주</span>
            <button className="btn primary" type="button" onClick={saveBudget}>저장</button>
            <button className="btn" type="button" onClick={() => setEditingBudget(false)}>취소</button>
          </div>
        ) : (
          <button className="btn ai-account-budget" type="button" onClick={() => setEditingBudget(true)}>
            {account.weeklyTokenBudget ? '예산 변경' : '예산 설정'}
          </button>
        ))}
      </div>
      <div className="ai-account-action">
        <StateBadge state={account.state} note={account.stateNote} />
        {(isCockpit || account.state === 'ready') && (
          <button className="btn primary" type="button" onClick={openTerminal}>
            {isCockpit && account.state === 'login' ? '로그인 터미널 열기' : '터미널 열기'}
          </button>
        )}
        {isCockpit && (
          <button className="btn" type="button" disabled={testing} onClick={runTest}>
            {testing ? '테스트 중…' : '연결 테스트'}
          </button>
        )}
        {isCockpit && (
          <button className="btn" type="button" onClick={deleteAccount}>삭제</button>
        )}
      </div>
    </article>
  );
}

export default function AiAccounts() {
  const [accounts, setAccounts] = useState([]);
  const [status, setStatus] = useState('불러오는 중…');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newProvider, setNewProvider] = useState('claude');

  async function load() {
    try {
      const data = await fetchJson('/api/ai-accounts');
      setAccounts(data.accounts || []);
      const ready = (data.accounts || []).filter((a) => a.state === 'ready').length;
      setStatus(
        (data.accounts || []).length
          ? `${data.runtime} · ${data.accounts?.length || 0}개 계정 · ${ready}개 실행 가능`
          : `${data.runtime || '로컬'} · 등록된 AI 계정이 없습니다. 위에서 계정을 추가하세요.`,
      );
    } catch (e) {
      setStatus(e.message);
    }
  }

  useEffect(() => {
    load();
    // SSE: 서버 감시자가 credential 변화를 쏘면 재조회
    const es = new EventSource('/api/events');
    const onChange = () => load();
    es.addEventListener('ai-accounts:changed', onChange);
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 30000);
    return () => {
      es.removeEventListener('ai-accounts:changed', onChange);
      es.close();
      clearInterval(timer);
    };
  }, []);

  async function addAccount() {
    if (!newName.trim()) return;
    try {
      await postJson('/api/ai-accounts', { name: newName.trim(), provider: newProvider, email: newEmail.trim() });
      setNewName('');
      setNewEmail('');
      load();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <main className="ai-accounts-view">
      <section className="ai-accounts-shell" aria-labelledby="ai-accounts-title">
        <header className="ai-accounts-head">
          <div>
            <h1 id="ai-accounts-title">AI 계정</h1>
            <p>계정과 작업 위치를 선택해 독립된 Claude·Codex 터미널을 엽니다.</p>
          </div>
          <div className="ai-accounts-tools">
            <div className="ai-tools-group">
              <button className="btn" type="button" onClick={load}>새로고침</button>
            </div>
            <div className="ai-tools-group">
              <label htmlFor="ai-account-provider">새 계정</label>
              <select id="ai-account-provider" value={newProvider} onChange={(e) => setNewProvider(e.target.value)}>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
              <input
                type="text" placeholder="계정 이름" maxLength="40" value={newName}
                onChange={(e) => setNewName(e.target.value)} aria-label="새 AI 계정 이름"
              />
              <input
                type="text" placeholder="이메일(선택)" maxLength="120" value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)} aria-label="새 AI 계정 이메일"
              />
              <button className="btn primary" type="button" onClick={addAccount}>추가</button>
            </div>
          </div>
        </header>
        <div className="ai-accounts-status" role="status">{status}</div>
        <div className="ai-account-list" aria-live="polite">
          {accounts.length ? (
            accounts.map((a) => (
              <AccountCard key={a.id} account={a} onChanged={load} />
            ))
          ) : (
            <div className="ai-accounts-empty">
              <strong>계정을 찾지 못했습니다.</strong>
              <span>새 계정을 추가하거나 허브(.codex-account-launcher) 프로필을 확인하세요.</span>
            </div>
          )}
        </div>
        <p className="ai-accounts-footnote">계정 전환은 새 터미널에만 적용됩니다. 기존 터미널과 전역 로그인은 바뀌지 않습니다.</p>
      </section>
    </main>
  );
}
