import { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../api.js';

const STATUS_LABEL = {
  success: '성공',
  failure: '실패',
  cancelled: '취소됨',
  skipped: '건너뜀',
  in_progress: '실행 중',
  queued: '대기 중',
};

const STATUS_CLASS = {
  success: 'st-ready',
  failure: 'st-login',
  cancelled: 'st-warning',
  in_progress: 'st-warning',
  queued: 'st-warning',
};

function statusOf(r) {
  return r.status === 'completed' ? (r.conclusion || 'unknown') : r.status;
}

function StatusBadge({ run }) {
  const key = statusOf(run);
  return (
    <span className={`st ${STATUS_CLASS[key] || ''}`} title={key}>
      <i />{STATUS_LABEL[key] || key}
    </span>
  );
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

function timeAgo(ts) {
  if (!ts) return '-';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function ghErrorMessage(msg) {
  if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('gh:')) {
    return 'gh CLI를 찾을 수 없습니다. 설치 후 gh auth login을 실행하세요.';
  }
  if (msg.includes('auth') || msg.includes('401') || msg.includes('login')) {
    return 'gh 인증이 필요합니다. 터미널에서 gh auth login을 실행하세요.';
  }
  return `불러오기 실패: ${msg}`;
}

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export default function Cicd() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [runs, setRuns] = useState([]);
  const [wfFilter, setWfFilter] = useState('');
  const [detail, setDetail] = useState(null);
  const [logs, setLogs] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadProjects() {
    try {
      const data = await fetchJson('/api/projects');
      const list = Array.isArray(data) ? data : [];
      setProjects(list);
      // 바닐라(js/cicd.js)와 동일: 첫 프로젝트 자동 선택
      if (!projectId && list.length) setProjectId(list[0].id);
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadRuns(pid, silent = false) {
    if (!pid) return;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const [runList] = await Promise.all([
        fetchJson(`/api/cicd/runs/${pid}`),
        fetchJson(`/api/cicd/workflows/${pid}`).catch(() => []),
      ]);
      setRuns(Array.isArray(runList) ? runList : []);
      if (!silent) setError('');
    } catch (e) {
      if (!silent) setError(ghErrorMessage(e.message || ''));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setDetail(null);
    setLogs(null);
    setWfFilter('');
    if (projectId) loadRuns(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 바닐라와 동일: 실행 중/대기 중 run이 있을 때만 10초 폴링. SSE 미사용.
  const hasRunning = runs.some((r) => r.status === 'in_progress' || r.status === 'queued');
  useEffect(() => {
    if (!hasRunning || !projectId) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) loadRuns(projectId, true);
    }, 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRunning, projectId]);

  const wfNames = useMemo(
    () => [...new Set(runs.map((r) => r.workflowName).filter(Boolean))],
    [runs]
  );

  const filtered = wfFilter ? runs.filter((r) => r.workflowName === wfFilter) : runs;

  const stats = useMemo(() => ({
    total: filtered.length,
    success: filtered.filter((r) => r.conclusion === 'success').length,
    failed: filtered.filter((r) => r.conclusion === 'failure').length,
    running: filtered.filter((r) => r.status === 'in_progress').length,
  }), [filtered]);

  async function showDetail(runId) {
    setLogs(null);
    setDetail({ loading: true, databaseId: runId });
    try {
      const d = await fetchJson(`/api/cicd/runs/${projectId}/${runId}`);
      setDetail(d);
    } catch (e) {
      setDetail({ loading: false, error: e.message, databaseId: runId });
    }
  }

  async function rerun(runId, failed) {
    try {
      await postJson(`/api/cicd/runs/${projectId}/${runId}/rerun`, { failed });
      setNotice(failed ? '실패한 잡을 다시 실행합니다…' : '전체 잡을 다시 실행합니다…');
      setTimeout(() => loadRuns(projectId, true), 2000);
    } catch (e) {
      setNotice(`재실행 실패: ${e.message}`);
    }
  }

  async function cancelRun(runId) {
    try {
      await postJson(`/api/cicd/runs/${projectId}/${runId}/cancel`, {});
      setNotice('실행을 취소했습니다');
      setTimeout(() => loadRuns(projectId, true), 1000);
    } catch (e) {
      setNotice(`취소 실패: ${e.message}`);
    }
  }

  async function viewLogs(runId) {
    setLogs('로그를 가져오는 중…');
    try {
      setLogs(await fetchText(`/api/cicd/runs/${projectId}/${runId}/logs`));
    } catch {
      setLogs('로그를 불러오지 못했습니다');
    }
  }

  return (
    <main>
      <h1>CI/CD</h1>
      <p>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ marginRight: 8 }}>
          <option value="">프로젝트 선택</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={wfFilter} onChange={(e) => setWfFilter(e.target.value)} style={{ marginRight: 8 }}>
          <option value="">전체 워크플로</option>
          {wfNames.map((n) => (
            <option key={n} value={n}>{n.replace('.github/workflows/', '')}</option>
          ))}
        </select>
        <button onClick={() => loadRuns(projectId)}>새로고침</button>
      </p>
      {stats.total > 0 && (
        <p style={{ color: '#8b949e', fontSize: '0.8rem' }}>
          전체 {stats.total} · 성공 {stats.success} · 실패 {stats.failed}
          {stats.running > 0 && <> · 실행 중 {stats.running}</>}
          {hasRunning && ' · 10초마다 자동 새로고침'}
        </p>
      )}
      {notice && <p style={{ color: '#fbbf24' }}>{notice}</p>}
      {error && <p style={{ color: '#f87171' }}>{error}</p>}
      {loading && <p>워크플로 실행 기록을 불러오는 중…</p>}
      {!loading && !error && projectId && filtered.length === 0 && (
        <p>워크플로 실행 기록이 없습니다</p>
      )}
      {!projectId && !error && <p>CI/CD 파이프라인을 보려면 프로젝트를 선택하세요</p>}

      {filtered.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>워크플로</th>
              <th style={{ textAlign: 'left' }}>브랜치</th>
              <th style={{ textAlign: 'left' }}>상태</th>
              <th style={{ textAlign: 'left' }}>소요</th>
              <th style={{ textAlign: 'left' }}>업데이트</th>
              <th style={{ textAlign: 'left' }}>액션</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.databaseId} onClick={() => showDetail(r.databaseId)} style={{ cursor: 'pointer' }}>
                <td>
                  <div>{r.displayTitle || r.name || '실행'}</div>
                  <div style={{ color: '#8b949e', fontSize: '0.75rem' }}>
                    {(r.workflowName || '').replace('.github/workflows/', '')}
                  </div>
                </td>
                <td>{r.headBranch || '-'}</td>
                <td><StatusBadge run={r} /></td>
                <td>{r.updatedAt && r.createdAt ? formatDuration(new Date(r.updatedAt) - new Date(r.createdAt)) : '-'}</td>
                <td>{r.updatedAt ? timeAgo(r.updatedAt) : '-'}</td>
                <td>
                  <div className="actions" onClick={(e) => e.stopPropagation()}>
                    {r.status === 'in_progress' && (
                      <button onClick={() => cancelRun(r.databaseId)} title="취소">취소</button>
                    )}
                    {r.conclusion === 'failure' && (
                      <button onClick={() => rerun(r.databaseId, true)} title="실패한 잡 재실행">재실행</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && (
        <section className="row" style={{ marginTop: 16 }}>
          {detail.loading && <p>실행 상세를 불러오는 중…</p>}
          {detail.error && <p style={{ color: '#f87171' }}>{detail.error} <button onClick={() => setDetail(null)}>닫기</button></p>}
          {!detail.loading && !detail.error && (
            <>
              <div className="id">
                <div>
                  <h2>{detail.displayTitle || detail.name} #{detail.databaseId}</h2>
                  <p>
                    {detail.workflowName || ''} · {detail.headBranch || '-'} · {detail.event || '-'} ·{' '}
                    {(detail.headSha || '').slice(0, 7)} ·{' '}
                    {detail.createdAt ? new Date(detail.createdAt).toLocaleString() : '-'}
                  </p>
                </div>
                <StatusBadge run={detail} />
              </div>
              <h3 style={{ margin: '8px 0 4px', fontSize: '0.9rem' }}>잡 ({(detail.jobs || []).length})</h3>
              {(detail.jobs || []).map((j) => (
                <details key={j.id || j.name}>
                  <summary>
                    <StatusBadge run={j} /> {j.name}{' '}
                    <span style={{ color: '#8b949e' }}>
                      {j.completedAt && j.startedAt ? formatDuration(new Date(j.completedAt) - new Date(j.startedAt)) : ''}
                    </span>
                  </summary>
                  {(j.steps || []).map((s, i) => (
                    <div key={i} style={{ fontSize: '0.8rem', paddingLeft: 16 }}>
                      {s.conclusion === 'success' ? '✓' : s.conclusion === 'failure' ? '✕' : s.conclusion === 'skipped' ? '→' : '○'}{' '}
                      {s.name}
                    </div>
                  ))}
                </details>
              ))}
              <div className="actions">
                <button onClick={() => rerun(detail.databaseId, false)}>전체 재실행</button>
                {detail.conclusion === 'failure' && (
                  <button onClick={() => rerun(detail.databaseId, true)}>실패만 재실행</button>
                )}
                <button onClick={() => viewLogs(detail.databaseId)}>전체 로그 보기</button>
                <button onClick={() => { setDetail(null); setLogs(null); }}>닫기</button>
              </div>
              {logs && (
                <pre style={{
                  background: '#161b22', border: '1px solid #30363d', borderRadius: 6,
                  padding: 8, fontSize: '0.75rem', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto',
                }}>{logs}</pre>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
