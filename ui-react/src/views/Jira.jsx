import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import './Jira.css';

// routes/jira.js (커밋 76fa3ee 이전 삭제본 기준) 엔드포인트 사용.
// 현재 브랜치 server.js에는 Jira 라우트가 미등록이므로,
// 모든 /api/jira/* 호출 실패는 "미연결" 안내로 처리한다.

const NOT_CONFIGURED = 'Not configured';
const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

function isMissingConfig(err) {
  const m = String(err?.message || '');
  return m.includes(NOT_CONFIGURED) || m.includes('HTTP 404') || m.includes('Not Found');
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

function catOf(issue) {
  return issue.status?.category || 'undefined';
}

function IssueDetail({ issueKey, onClose, onChanged }) {
  const [issue, setIssue] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [comment, setComment] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await fetchJson(`/api/jira/issues/${encodeURIComponent(issueKey)}`);
      setIssue(data.issue || null);
    } catch (e) {
      setError(e.message);
    }
  }, [issueKey]);

  useEffect(() => {
    load();
  }, [load]);

  async function runTransition(t) {
    setBusy(t.id);
    setError('');
    try {
      await postJson(`/api/jira/issues/${encodeURIComponent(issueKey)}/transition`, {
        transitionId: t.id,
      });
      await load();
      onChanged();
    } catch (e) {
      setError(`상태 전환 실패: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  async function submitComment() {
    const body = comment.trim();
    if (!body) return;
    setBusy('comment');
    setError('');
    try {
      await postJson(`/api/jira/issues/${encodeURIComponent(issueKey)}/comment`, {
        comment: body,
      });
      setComment('');
      await load();
    } catch (e) {
      setError(`코멘트 등록 실패: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="row jira-detail open">
      <div className="actions jira-detail-head">
        <strong>{issueKey}</strong>
        <button onClick={onClose}>닫기</button>
      </div>
      {error && <p className="jira-error">{error}</p>}
      {!issue && !error && <p>불러오는 중…</p>}
      {issue && (
        <>
          <h2 className="jira-detail-title">{issue.summary}</h2>
          <p className="jira-meta">
            <span className={`jira-badge jb-${catOf(issue)}`}>{issue.status?.name || '상태 없음'}</span>
            {issue.type?.name && <span> · {issue.type.name}</span>}
            {issue.priority?.name && <span> · 우선순위 {issue.priority.name}</span>}
            {issue.assignee?.displayName && <span> · 담당 {issue.assignee.displayName}</span>}
            {issue.updated && <span> · {timeAgo(issue.updated)} 업데이트</span>}
          </p>
          {(issue.sprint || issue.dueDate) && (
            <p className="jira-meta">
              {issue.sprint?.name && <span>스프린트: {issue.sprint.name} ({issue.sprint.state})</span>}
              {issue.dueDate && <span> · 마감 {issue.dueDate}</span>}
            </p>
          )}
          {issue.transitions?.length > 0 && (
            <>
              <h3>상태 전환 (클릭 방식 — 드래그앤드롭 미지원)</h3>
              <div className="actions jira-transitions">
                {issue.transitions.map((t) => (
                  <button key={t.id} disabled={!!busy} onClick={() => runTransition(t)}>
                    {busy === t.id ? '전환 중…' : t.to ? `${t.name} → ${t.to}` : t.name}
                  </button>
                ))}
              </div>
            </>
          )}
          {issue.comments?.length > 0 && (
            <>
              <h3>코멘트 ({issue.comments.length})</h3>
              {issue.comments.map((c) => (
                <div key={c.id} className="jira-comment">
                  <b>{c.author}</b> · {timeAgo(c.created)}
                  <p>{c.body}</p>
                </div>
              ))}
            </>
          )}
          <div className="jira-comment-form">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="코멘트 남기기…"
              rows={2}
            />
            <button disabled={!!busy || !comment.trim()} onClick={submitComment}>
              {busy === 'comment' ? '등록 중…' : '코멘트 등록'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function Jira() {
  const [phase, setPhase] = useState('loading'); // loading | unconfigured | ready
  const [config, setConfig] = useState(null);
  const [issues, setIssues] = useState([]);
  const [projects, setProjects] = useState([]);
  const [boards, setBoards] = useState([]);
  const [sprints, setSprints] = useState([]);
  const [projectFilter, setProjectFilter] = useState('');
  const [boardFilter, setBoardFilter] = useState('');
  const [sprintFilter, setSprintFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('list'); // list | board
  const [selectedKey, setSelectedKey] = useState(null);
  const [status, setStatus] = useState('불러오는 중…');

  const loadIssues = useCallback(async (project, sprint) => {
    const params = new URLSearchParams();
    if (project) params.set('project', project);
    if (sprint) params.set('sprint', sprint);
    const qs = params.toString();
    // GET /api/jira/issues?project=&sprint=&status=
    const data = await fetchJson(`/api/jira/issues${qs ? `?${qs}` : ''}`);
    const list = data.issues || [];
    setIssues(list);
    const done = list.filter((i) => catOf(i) === 'done').length;
    setStatus(`전체 ${list.length}개 · 완료 ${done}개`);
    return list;
  }, []);

  const boot = useCallback(async () => {
    setPhase('loading');
    setStatus('불러오는 중…');
    try {
      // GET /api/jira/config → { configured: false } 또는 설정 정보
      const cfg = await fetchJson('/api/jira/config');
      if (!cfg.configured) {
        setPhase('unconfigured');
        return;
      }
      setConfig(cfg);
      const [pdata, bdata, sdata] = await Promise.all([
        // GET /api/jira/projects
        fetchJson('/api/jira/projects').catch(() => ({ projects: [] })),
        // GET /api/jira/boards
        fetchJson('/api/jira/boards').catch(() => ({ boards: [] })),
        // GET /api/jira/sprints (boardId 없음 → 전체 활성 스프린트)
        fetchJson('/api/jira/sprints').catch(() => ({ sprints: [] })),
      ]);
      setProjects(pdata.projects || []);
      setBoards(bdata.boards || []);
      setSprints(sdata.sprints || []);
      await loadIssues('', '');
      setPhase('ready');
    } catch (e) {
      if (isMissingConfig(e)) {
        setPhase('unconfigured');
      } else {
        setPhase('ready');
        setStatus(`Jira 로드 실패: ${e.message}`);
      }
    }
  }, [loadIssues]);

  useEffect(() => {
    boot();
  }, [boot]);

  async function changeProject(v) {
    setProjectFilter(v);
    setSelectedKey(null);
    try {
      const bdata = await fetchJson(`/api/jira/boards${v ? `?project=${encodeURIComponent(v)}` : ''}`).catch(
        () => ({ boards: [] }),
      );
      setBoards(bdata.boards || []);
      await loadIssues(v, sprintFilter);
    } catch (e) {
      if (isMissingConfig(e)) setPhase('unconfigured');
      else setStatus(`이슈 로드 실패: ${e.message}`);
    }
  }

  async function changeBoard(v) {
    setBoardFilter(v);
    setSprintFilter('');
    try {
      // GET /api/jira/sprints?boardId= (숫자 ID만 허용)
      const sdata = await fetchJson(`/api/jira/sprints${v ? `?boardId=${encodeURIComponent(v)}` : ''}`);
      setSprints(sdata.sprints || []);
    } catch (e) {
      if (isMissingConfig(e)) setPhase('unconfigured');
      else setStatus(`스프린트 로드 실패: ${e.message}`);
    }
  }

  async function changeSprint(v) {
    setSprintFilter(v);
    setSelectedKey(null);
    try {
      await loadIssues(projectFilter, v);
    } catch (e) {
      if (isMissingConfig(e)) setPhase('unconfigured');
      else setStatus(`이슈 로드 실패: ${e.message}`);
    }
  }

  async function refresh() {
    if (phase !== 'ready') {
      await boot();
      return;
    }
    try {
      await loadIssues(projectFilter, sprintFilter);
    } catch (e) {
      if (isMissingConfig(e)) setPhase('unconfigured');
      else setStatus(`이슈 로드 실패: ${e.message}`);
    }
  }

  const statusOptions = useMemo(() => {
    const names = new Map();
    issues.forEach((i) => {
      const n = i.status?.name;
      if (n && !names.has(n)) names.set(n, catOf(i));
    });
    return [...names.entries()];
  }, [issues]);

  const filtered = useMemo(() => {
    let list = [...issues];
    if (statusFilter) list = list.filter((i) => i.status?.name === statusFilter);
    const q = search.toLowerCase().trim();
    if (q) {
      list = list.filter(
        (i) =>
          (i.key || '').toLowerCase().includes(q) ||
          (i.summary || '').toLowerCase().includes(q) ||
          (i.assignee?.displayName || '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [issues, statusFilter, search]);

  const boardCols = useMemo(() => {
    const order = { new: 0, undefined: 0, indeterminate: 1, done: 2 };
    const map = new Map();
    filtered.forEach((i) => {
      const name = i.status?.name || '상태 없음';
      if (!map.has(name)) map.set(name, { name, cat: catOf(i), list: [] });
      map.get(name).list.push(i);
    });
    return [...map.values()].sort((a, b) => (order[a.cat] ?? 1) - (order[b.cat] ?? 1));
  }, [filtered]);

  if (phase === 'loading') {
    return (
      <main className="jira-view">
        <h1>Jira</h1>
        <p>불러오는 중…</p>
      </main>
    );
  }

  if (phase === 'unconfigured') {
    return (
      <main className="jira-view">
        <h1>Jira</h1>
        <div className="row jira-setup jira-setup-card">
          <h2>Jira 미연결 — 서버 설정 필요</h2>
          <p>
            서버에 Jira 연결 설정이 없습니다. 아래 정보를 서버에 저장한 뒤 다시 확인하세요
            (<span className="jira-mono">POST /api/jira/config</span> — 본문:{' '}
            <span className="jira-mono">url, email, token</span>).
          </p>
          <ol className="jira-setup-steps">
            <li>
              <a href={TOKEN_URL} target="_blank" rel="noreferrer">
                Atlassian API 토큰 발급하기
              </a>{' '}
              에서 토큰을 생성합니다.
            </li>
            <li>
              사이트 URL(<span className="jira-mono">https://팀명.atlassian.net</span>), 이메일, 토큰을 서버
              설정에 저장합니다.
            </li>
            <li>아래 [다시 확인] 버튼을 눌러 연결을 확인합니다.</li>
          </ol>
          <div className="actions">
            <button onClick={boot}>다시 확인</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="jira-view">
      <h1>Jira</h1>
      <div className="jira-toolbar">
        <select value={projectFilter} onChange={(e) => changeProject(e.target.value)}>
          <option value="">전체 프로젝트</option>
          {projects.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key} · {p.name}
            </option>
          ))}
        </select>
        <select value={boardFilter} onChange={(e) => changeBoard(e.target.value)}>
          <option value="">전체 보드</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.type})
            </option>
          ))}
        </select>
        <select value={sprintFilter} onChange={(e) => changeSprint(e.target.value)}>
          <option value="">전체 스프린트</option>
          {sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.state})
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">전체 상태</option>
          {statusOptions.map(([name]) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="키·요약·담당자 검색…" />
        <div className="jira-view-toggle">
          <button className="jira-view-btn" data-view="list" onClick={() => setView('list')} aria-pressed={view === 'list'} style={view === 'list' ? { borderColor: 'var(--accent)' } : undefined}>
            목록
          </button>
          <button className="jira-view-btn" data-view="board" onClick={() => setView('board')} aria-pressed={view === 'board'} style={view === 'board' ? { borderColor: 'var(--accent)' } : undefined}>
            보드
          </button>
        </div>
        <button onClick={refresh} title="새로고침">새로고침</button>
      </div>
      <div className="jira-summary-bar">
        <p>
          {status}
          {config?.url && <span className="jira-meta"> · {config.url}</span>}
        </p>
      </div>
      <div className="jira-content">

      {selectedKey && (
        <IssueDetail
          issueKey={selectedKey}
          onClose={() => setSelectedKey(null)}
          onChanged={() => loadIssues(projectFilter, sprintFilter).catch(() => {})}
        />
      )}

      {view === 'board' && (
        <p className="jira-meta">드래그앤드롭 미지원 — 카드를 클릭하면 상세에서 상태 전환 버튼으로 이동합니다.</p>
      )}

      {filtered.length === 0 && (
        <div className="row">
          <p>표시할 이슈가 없습니다. 필터를 변경해 보세요.</p>
        </div>
      )}

      {view === 'list' ? (
        <div className="jira-list-view">
        {filtered.map((i) => (
          <article key={i.key} className="row jira-row" onClick={() => setSelectedKey(i.key)}>
            <div className="id">
              <span className={`jira-badge jb-${catOf(i)}`}>{i.status?.name || '상태 없음'}</span>
              <div>
                <h2>
                  <span className="jira-key">{i.key}</span> {i.summary}
                </h2>
                <p>
                  {i.type?.name && `${i.type.name} · `}
                  {i.assignee?.displayName ? `${i.assignee.displayName} · ` : '미배정 · '}
                  {i.sprint?.name ? `${i.sprint.name} · ` : ''}
                  {i.updated ? timeAgo(i.updated) : ''}
                  {i.dueDate ? ` · 마감 ${i.dueDate}` : ''}
                </p>
              </div>
            </div>
          </article>
        ))}
        </div>
      ) : (
        <div className="jira-board jira-board-view">
          {boardCols.map((c) => (
            <section key={c.name} className={`jira-col jira-board-col jira-col-${c.cat}`}>
              <header>
                <span>{c.name}</span> <span className="jira-col-count">{c.list.length}</span>
              </header>
              {c.list.map((i) => (
                <article key={i.key} className="jira-card" onClick={() => setSelectedKey(i.key)}>
                  <div className="jira-card-key">{i.key}</div>
                  <div className="jira-card-summary">{i.summary}</div>
                  <div className="jira-card-foot">
                    {i.type?.name && <span>{i.type.name}</span>}
                    {i.assignee?.displayName && <span> · {i.assignee.displayName}</span>}
                    {i.dueDate && <span> · {i.dueDate}</span>}
                  </div>
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
      </div>
    </main>
  );
}
