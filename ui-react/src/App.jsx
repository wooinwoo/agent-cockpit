import { useEffect, useState } from 'react';
import { fetchJson, postJson } from './api.js';

const LOGIN_CMD = { claude: 'claude login', codex: 'codex login' };

function StateBadge({ state, note }) {
  const label = state === 'ready' ? '사용 가능' : state === 'warning' ? '확인 필요' : '로그인 필요';
  return (
    <span className={`st st-${state}`} title={note || ''}>
      <i />{label}
    </span>
  );
}

function AccountCard({ account, onChanged }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
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

  return (
    <article className={`row ${account.provider}`}>
      <div className="id">
        <span className="mark">{account.provider === 'claude' ? 'C' : 'X'}</span>
        <div>
          <h2>{account.name}</h2>
          <p>{account.email || account.provider} · {account.bridge}</p>
        </div>
      </div>
      {isCockpit && account.state === 'login' && (
        <div className="hint">
          <span>로그인 터미널을 열고 실행:</span>
          <code>{LOGIN_CMD[account.provider]}</code>
          <small>브라우저 인증 후 돌아오면 자동 갱신됩니다</small>
        </div>
      )}
      {result && (
        <div className={`test ${result.ok ? 'pass' : 'fail'}`}>
          {result.checks.map((c) => (
            <div key={c.label}><b>{c.ok ? '✓' : '✗'}</b> {c.label} — {c.detail}</div>
          ))}
        </div>
      )}
      <div className="actions">
        <StateBadge state={account.state} note={account.stateNote} />
        {isCockpit && (
          <button disabled={testing} onClick={runTest}>
            {testing ? '테스트 중…' : '연결 테스트'}
          </button>
        )}
      </div>
    </article>
  );
}

export default function App() {
  const [accounts, setAccounts] = useState([]);
  const [status, setStatus] = useState('불러오는 중…');

  async function load() {
    try {
      const data = await fetchJson('/api/ai-accounts');
      setAccounts(data.accounts || []);
      const ready = (data.accounts || []).filter((a) => a.state === 'ready').length;
      setStatus(`${data.runtime} · ${data.accounts?.length || 0}개 계정 · ${ready}개 실행 가능`);
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

  return (
    <main>
      <h1>AI 계정 (React 파일럿)</h1>
      <p>{status} <button onClick={load}>새로고침</button></p>
      {accounts.map((a) => (
        <AccountCard key={a.id} account={a} onChanged={load} />
      ))}
    </main>
  );
}
