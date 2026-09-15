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
  success: 'st-success',
  failure: 'st-failure',
  cancelled: 'st-cancelled',
  skipped: 'st-queued',
  in_progress: 'st-running',
  queued: 'st-queued',
};

const STATUS_ICON = {
  success: '✓',
  failure: '✕',
  cancelled: '⊘',
  skipped: '→',
  in_progress: '⟳',
  queued: '○',
};

function statusOf(r) {
  return r.status === 'completed' ? (r.conclusion || 'unknown') : r.status;
}

function statusIconOf(run) {
  return STATUS_ICON[statusOf(run)] || '○';
}

function statusIconClass(key) {
  if (key === 'success') return 'ci-success';
  if (key === 'failure') return 'ci-failure';
  if (key === 'in_progress') return 'ci-running';
  if (key === 'cancelled') return 'ci-cancelled';
  if (key === 'queued') return 'ci-queued';
  if (key === 'skipped') return 'ci-skipped';
  return 'ci-unknown';
}

function rowTone(run) {
  const key = statusOf(run);
  if (key === 'failure') return 'row-failure';
  if (key === 'success') return 'row-success';
  return '';
}

function stepTone(step) {
  if (step.conclusion === 'success') return 'step-ok';
  if (step.conclusion === 'failure') return 'step-fail';
  if (step.conclusion === 'skipped') return 'step-skip';
  return '';
}

function stepIcon(step) {
  if (step.conclusion === 'success') return '✓';
  if (step.conclusion === 'failure') return '✕';
  if (step.conclusion === 'skipped') return '→';
  return '○';
}

function StatusBadge({ run }) {
  const key = statusOf(run);
  return (
    <span className={`cicd-status ${STATUS_CLASS[key] || 'st-queued'}`} title={key}>
      {STATUS_LABEL[key] || key}
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
    <main className="cicd-view">
      <h1>CI/CD</h1>
      <div className="cicd-toolbar">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">프로젝트 선택</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={wfFilter} onChange={(e) => setWfFilter(e.target.value)}>
          <option value="">전체 워크플로</option>
          {wfNames.map((n) => (
            <option key={n} value={n}>{n.replace('.github/workflows/', '')}</option>
          ))}
        </select>
        <button onClick={() => loadRuns(projectId)}>새로고침</button>
        {stats.total > 0 && (
          <div className="cicd-summary">
            <span className="cs-stat">전체 <span className="cs-num">{stats.total}</span></span>
            <span className="cs-stat cs-success">성공 <span className="cs-num">{stats.success}</span></span>
            <span className={`cs-stat cs-fail${stats.failed ? '' : ' cs-dim'}`}>실패 <span className="cs-num">{stats.failed}</span></span>
            {stats.running > 0 && <span className="cs-stat cs-running">실행 중 <span className="cs-num">{stats.running}</span></span>}
            <span className="cs-progress">
              <span
                className="cs-bar cs-bar-pass"
                style={{ width: `${stats.total ? Math.round((stats.success / stats.total) * 100) : 0}%` }}
              />
              <span
                className="cs-bar cs-bar-fail"
                style={{ width: `${stats.total ? Math.round((stats.failed / stats.total) * 100) : 0}%` }}
              />
            </span>
          </div>
        )}
      </div>
      {hasRunning && <div className="cicd-poll-indicator">실행 중 · 10초마다 자동 새로고침</div>}
      {notice && <p className="cicd-notice">{notice}</p>}
      {error && <p className="cicd-error">{error}</p>}
      {loading && <div className="cicd-loading">워크플로 실행 기록을 불러오는 중…</div>}
      {!loading && !error && projectId && filtered.length === 0 && (
        <div className="cicd-empty">워크플로 실행 기록이 없습니다</div>
      )}
      {!projectId && !error && <div className="cicd-empty">CI/CD 파이프라인을 보려면 프로젝트를 선택하세요</div>}

      {filtered.length > 0 && (
        <div className="cicd-content">
        <div className="cicd-table-wrap">
        <table className="cicd-table">
          <thead>
            <tr>
              <th className="cicd-icon"></th>
              <th>워크플로</th>
              <th>브랜치</th>
              <th>상태</th>
              <th>소요</th>
              <th>업데이트</th>
              <th>액션</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.databaseId} onClick={() => showDetail(r.databaseId)} className={`cicd-run-row ${rowTone(r)}`}>
                <td className="cicd-icon"><span className={`ci-icon ${statusIconClass(statusOf(r))}`}>{statusIconOf(r)}</span></td>
                <td>
                  <div className="cr-title">{r.displayTitle || r.name || '실행'}</div>
                  <div className="cr-workflow">
                    {(r.workflowName || '').replace('.github/workflows/', '')}
                  </div>
                </td>
                <td><span className="cr-branch">{r.headBranch || '-'}</span></td>
                <td><StatusBadge run={r} /></td>
                <td><span className="cr-duration">{r.updatedAt && r.createdAt ? formatDuration(new Date(r.updatedAt) - new Date(r.createdAt)) : '-'}</span></td>
                <td><span className="cr-updated">{r.updatedAt ? timeAgo(r.updatedAt) : '-'}</span></td>
                <td>
                  <div className="cr-actions" onClick={(e) => e.stopPropagation()}>
                    {r.status === 'in_progress' && (
                      <button className="cr-act-btn" onClick={() => cancelRun(r.databaseId)} title="취소">취소</button>
                    )}
                    {r.conclusion === 'failure' && (
                      <button className="cr-act-btn" onClick={() => rerun(r.databaseId, true)} title="실패한 잡 재실행">재실행</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        </div>
      )}

      {detail && (
        <section className="cicd-detail">
          {detail.loading && <div className="cicd-loading">실행 상세를 불러오는 중…</div>}
          {detail.error && (
            <div className="cd-body">
              <p className="cicd-error">{detail.error}</p>
              <div className="cd-actions"><button onClick={() => setDetail(null)}>닫기</button></div>
            </div>
          )}
          {!detail.loading && !detail.error && (
            <>
              <div className="cd-head">
                <div className="cd-head-left">
                  <span className={`cd-status-icon ${statusIconClass(statusOf(detail))}`}>{statusIconOf(detail)}</span>
                  <div>
                    <div className="cd-title">{detail.displayTitle || detail.name} #{detail.databaseId}</div>
                    <div className="cd-sub">
                      {detail.workflowName || ''} · {detail.headBranch || '-'} · {detail.event || '-'} ·{' '}
                      {(detail.headSha || '').slice(0, 7)} ·{' '}
                      {detail.createdAt ? new Date(detail.createdAt).toLocaleString() : '-'}
                    </div>
                  </div>
                </div>
                <StatusBadge run={detail} />
              </div>
              <div className="cd-body">
                <div className="cd-meta">
                  <span className="cd-meta-label">워크플로</span>
                  <span className="cd-meta-value">{detail.workflowName || '-'}</span>
                  <span className="cd-meta-label">브랜치</span>
                  <span className="cd-meta-value cd-mono">{detail.headBranch || '-'}</span>
                  <span className="cd-meta-label">커밋</span>
                  <span className="cd-meta-value cd-mono">{(detail.headSha || '').slice(0, 7) || '-'}</span>
                </div>
                <div className="cd-jobs-title">잡 ({(detail.jobs || []).length})</div>
                {(detail.jobs || []).map((j) => (
                  <details className="cd-job" key={j.id || j.name}>
                    <summary className="cd-job-head">
                      <StatusBadge run={j} />
                      <span className="cd-job-name">{j.name}</span>
                      <span className="cd-job-dur">
                        {j.completedAt && j.startedAt ? formatDuration(new Date(j.completedAt) - new Date(j.startedAt)) : ''}
                      </span>
                    </summary>
                    <div className="cd-job-steps">
                      {(j.steps || []).length === 0 && <div className="cd-no-steps">스텝 정보 없음</div>}
                      {(j.steps || []).map((s, i) => (
                        <div key={i} className={`cd-step ${stepTone(s)}`}>
                          <span className="cd-step-icon">{stepIcon(s)}</span>
                          <span className="cd-step-name">{s.name}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
                <div className="cd-actions">
                  <button onClick={() => rerun(detail.databaseId, false)}>전체 재실행</button>
                  {detail.conclusion === 'failure' && (
                    <button onClick={() => rerun(detail.databaseId, true)}>실패만 재실행</button>
                  )}
                  <button onClick={() => viewLogs(detail.databaseId)}>전체 로그 보기</button>
                  <button onClick={() => { setDetail(null); setLogs(null); }}>닫기</button>
                </div>
                {logs && <pre className="cd-logs">{logs}</pre>}
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
