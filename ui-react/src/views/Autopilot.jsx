import { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import './Autopilot.css';

const ACTION_META = {
  auto: { label: '자동', cls: 'ap-auto' },
  escalate: { label: '에스컬', cls: 'ap-esc' },
  block: { label: '차단', cls: 'ap-block' },
  review: { label: '검토', cls: 'ap-review' },
};
const DECISION_ICON = { approve: '✅', deny: '⛔', ask: '⏸' };

function Tile({ label, value, cls = '' }) {
  return (
    <div className={`ap-tile ${cls}`}>
      <div className="ap-tile-n">{value}</div>
      <div className="ap-tile-k">{label}</div>
    </div>
  );
}

export default function Autopilot() {
  const [status, setStatus] = useState(null);
  const [briefing, setBriefing] = useState(null);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [notice, setNotice] = useState('');

  async function load(silent = false) {
    try {
      const [s, b] = await Promise.all([
        fetchJson('/api/autopilot/status'),
        fetchJson('/api/autopilot/briefing'),
      ]);
      setStatus(s);
      setBriefing(b);
      if (!silent) setError('');
    } catch (e) {
      if (!silent) setError(e.message);
    }
  }

  useEffect(() => {
    load();
    // 바닐라(js/autopilot-view.js)와 동일: 5초 폴링. 별도 SSE 이벤트 없음.
    const timer = setInterval(() => {
      if (!document.hidden) load(true);
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setMode(mode) {
    setSwitching(true);
    try {
      await postJson('/api/autopilot/mode', { mode });
      setNotice(mode === 'unattended' ? '무인 운영 켜짐 — 위험한 것만 폰으로' : '대면 모드 — 화면에서 확인');
      load(true);
    } catch {
      setNotice('모드 변경 실패');
    } finally {
      setSwitching(false);
    }
  }

  async function resetSession() {
    try {
      await postJson('/api/autopilot/reset', {});
      setNotice('세션 통계 초기화됨');
      load(true);
    } catch {
      setNotice('초기화 실패');
    }
  }

  const m = status?.metrics || {};
  const mode = status?.mode || 'attended';
  const recent = status?.recent ? [...status.recent].reverse() : [];

  return (
    <main className="ap">
      <div className="ap-head">
        <div>
          <h1>Autopilot</h1>
          <p className="ap-sub">에이전트 도구 호출을 정책으로 게이트 — 안전한 건 자동, 위험한 건 확인.</p>
        </div>
        <div className="ap-mode" role="group" aria-label="운영 모드">
          <button
            className={`ap-mode-btn ${mode === 'attended' ? 'active' : ''}`}
            disabled={switching || mode === 'attended'}
            onClick={() => setMode('attended')}
          >
            대면 (화면 확인)
          </button>
          <button
            className={`ap-mode-btn ${mode === 'unattended' ? 'active' : ''}`}
            disabled={switching || mode === 'unattended'}
            onClick={() => setMode('unattended')}
          >
            무인 (폰 승인)
          </button>
        </div>
      </div>

      <p className="ap-toolbar">
        <button onClick={() => load()}>새로고침</button>
        <button onClick={resetSession}>세션 초기화</button>
        {notice && <span className="ap-notice">{notice}</span>}
      </p>
      {error && <p className="ap-error">{error}</p>}
      {!status && !error && <p>불러오는 중…</p>}

      {status && (
        <>
          <div className="ap-tiles">
            <Tile label="자동 실행" value={m.auto || 0} cls="ap-auto" />
            <Tile label="검토 위임" value={m.review || 0} cls="ap-review" />
            <Tile label="에스컬" value={m.escalate || 0} cls="ap-esc" />
            <Tile label="차단" value={m.block || 0} cls="ap-block" />
            <Tile label="폰 승인" value={m.approved || 0} />
            <Tile label="폰 거부" value={(m.denied || 0) + (m.timedOut || 0)} />
          </div>

          <div className="ap-cols">
            <section className="ap-panel">
              <h2>최근 결정</h2>
              <div className="ap-list">
                {recent.length ? recent.map((r, i) => (
                  <div className="ap-row" key={`${r.ts || ''}-${i}`}>
                    <span className={`ap-badge ${ACTION_META[r.action]?.cls || ''}`}>
                      {ACTION_META[r.action]?.label || r.action}
                    </span>
                    <span className="ap-dec">{DECISION_ICON[r.decision] || ''}</span>
                    <code className="ap-snip">{r.snippet || r.tool || ''}</code>
                  </div>
                )) : <div className="ap-empty">아직 결정 없음. 훅을 켜면 여기 실시간으로 쌓입니다.</div>}
              </div>
            </section>
            <section className="ap-panel">
              <h2>브리핑</h2>
              <pre className="ap-brief">{briefing?.summary || '—'}</pre>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
