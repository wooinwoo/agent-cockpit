import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson } from '../api.js';

export default function Ports() {
  const [ports, setPorts] = useState([]);
  const [search, setSearch] = useState('');
  const [devOnly, setDevOnly] = useState(false);
  const [sortCol, setSortCol] = useState('port');
  const [sortAsc, setSortAsc] = useState(true);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  async function load(silent = true) {
    try {
      const data = await fetchJson('/api/ports');
      setPorts(Array.isArray(data) ? data : []);
      setError('');
    } catch (e) {
      if (!silent) setError(e.message);
    }
  }

  useEffect(() => {
    load(false);
    // 바닐라(js/ports.js)와 동일: 5초 폴링(일시정지 시 중단). SSE 미사용.
    const timer = setInterval(() => {
      if (!document.hidden && !pausedRef.current) load(true);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  function toggleSort(col) {
    if (sortCol === col) setSortAsc((v) => !v);
    else { setSortCol(col); setSortAsc(true); }
  }

  async function killPort(pid, name) {
    if (!window.confirm(`프로세스 "${name}" (PID ${pid})를 종료할까요?`)) return;
    try {
      await postJson('/api/ports/kill', { pid });
      load(true);
    } catch (e) {
      setError(e.message);
    }
  }

  function openInBrowser(port) {
    const url = `http://localhost:${port}`;
    postJson('/api/open-url', { url }).catch(() => {
      window.open(url, '_blank');
    });
  }

  const devCount = useMemo(() => ports.filter((p) => p.isDevServer).length, [ports]);

  const filtered = useMemo(() => {
    let rows = ports;
    if (devOnly) rows = rows.filter((p) => p.isDevServer);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((p) =>
        String(p.port).includes(q) ||
        (p.processName || '').toLowerCase().includes(q) ||
        (p.projectName || '').toLowerCase().includes(q)
      );
    }
    const val = (p) => {
      if (sortCol === 'process') return (p.processName || '').toLowerCase();
      if (sortCol === 'pid') return p.pid;
      return p.port;
    };
    return [...rows].sort((a, b) => {
      const va = val(a); const vb = val(b);
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [ports, search, devOnly, sortCol, sortAsc]);

  const icon = (col) => (sortCol === col ? (sortAsc ? ' ▲' : ' ▼') : '');

  return (
    <main>
      <h1>포트</h1>
      <p>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="포트 또는 프로세스로 필터…"
          style={{ marginRight: 8 }}
        />
        <label style={{ marginRight: 8 }}>
          <input
            type="checkbox"
            checked={devOnly}
            onChange={(e) => setDevOnly(e.target.checked)}
          />{' '}
          Dev만
        </label>
        <button onClick={() => setPaused((v) => !v)} style={{ marginRight: 8 }}>
          {paused ? '계속' : '일시정지'}
        </button>
        <button onClick={() => load(false)}>새로고침</button>
      </p>
      {error && <p style={{ color: '#f87171' }}>{error}</p>}
      {paused && <p style={{ color: '#fbbf24' }}>자동 새로고침 일시정지됨</p>}
      {filtered.length === 0 ? (
        <p>수신 대기 중인 포트가 없습니다</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <th><button onClick={() => toggleSort('port')}>포트{icon('port')}</button></th>
              <th><button onClick={() => toggleSort('process')}>프로세스{icon('process')}</button></th>
              <th><button onClick={() => toggleSort('pid')}>PID{icon('pid')}</button></th>
              <th>주소</th>
              <th>프로젝트</th>
              <th>액션</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={`${p.port}-${p.pid}`}>
                <td><b>{p.port}</b></td>
                <td>{p.processName}</td>
                <td style={{ fontFamily: 'var(--mono, monospace)' }}>{p.pid}</td>
                <td>{p.address}</td>
                <td>{p.isDevServer ? <span className="st st-ready"><i />{p.projectName || p.projectId}</span> : ''}</td>
                <td>
                  <div className="actions">
                    {p.port >= 1024 && (
                      <button onClick={() => openInBrowser(p.port)} title="브라우저에서 열기">열기</button>
                    )}
                    <button onClick={() => killPort(p.pid, p.processName)} title="프로세스 종료">종료</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ color: '#8b949e', fontSize: '0.8rem' }}>{ports.length}개 포트 · {devCount}개 dev 서버</p>
    </main>
  );
}
