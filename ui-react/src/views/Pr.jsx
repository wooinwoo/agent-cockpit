import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import './Pr.css';

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

function reviewInfo(pr) {
  if (pr.state === 'MERGED') return { cls: 'merged', label: '병합됨' };
  if (pr.state === 'CLOSED') return { cls: 'closed', label: '닫힘' };
  if (pr.isDraft) return { cls: 'draft', label: '초안' };
  if (pr.reviewDecision === 'APPROVED') return { cls: 'approved', label: '승인됨' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { cls: 'changes', label: '수정요청' };
  return { cls: 'pending', label: '리뷰대기' };
}

function PrDetail({ projectId, number, onClose, onChanged }) {
  const [pr, setPr] = useState(null);
  const [error, setError] = useState('');
  const [diff, setDiff] = useState(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setPr(await fetchJson(`/api/projects/${projectId}/prs/${number}`));
    } catch (e) {
      setError(e.message);
    }
  }, [projectId, number]);

  useEffect(() => {
    load();
  }, [load]);

  async function action(label, path, body) {
    setBusy(label);
    try {
      await postJson(path, body || {});
      await load();
      onChanged();
    } catch (e) {
      setError(`${label} 실패: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  async function toggleDiff() {
    if (diffOpen) {
      setDiffOpen(false);
      return;
    }
    setBusy('diff');
    try {
      // diff 엔드포인트는 text/plain 응답이라 네이티브 fetch 사용
      const res = await fetch(`/api/projects/${projectId}/prs/${number}/diff`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDiff(await res.text());
      setDiffOpen(true);
    } catch (e) {
      setError(`diff 로드 실패: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  if (error && !pr) {
    return (
      <div className="row pr-detail open">
        <p>상세 로드 실패: {error}</p>
        <button className="prd-btn" onClick={onClose}>닫기</button>
      </div>
    );
  }
  if (!pr) return <div className="row pr-detail open"><p>불러오는 중…</p></div>;

  const rv = reviewInfo(pr);
  return (
    <div className="row pr-detail open">
      <div className="pr-detail-head">
        <span className={`pr-review-badge pr-rv-${rv.cls}`}>{rv.label}</span>
        <strong className="prd-title">
          #{pr.number} {pr.title}
        </strong>
        <button className="prd-btn" onClick={onClose}>닫기</button>
      </div>
      <p className="prd-meta">
        {pr.author} · <span className="prd-branch">{pr.branch} → {pr.baseBranch || 'main'}</span> · {timeAgo(pr.createdAt)} ·
        <span className="prd-stat-badge"> +{pr.additions} −{pr.deletions}</span> · {pr.changedFiles}개 파일 · {pr.commits}개 커밋
        {pr.mergeable === 'MERGEABLE' && <span className="prd-mergeable"> · 병합가능</span>}
        {pr.mergeable === 'CONFLICTING' && <span className="prd-conflict"> · 충돌</span>}
      </p>
      {error && <p className="pr-error">{error}</p>}
      {pr.state === 'OPEN' && (
        <div className="prd-actions">
          {pr.reviewDecision !== 'APPROVED' && (
            <button className="prd-btn prd-btn-approve" disabled={!!busy} onClick={() => action('승인', `/api/projects/${projectId}/prs/${number}/approve`, {})}>
              승인
            </button>
          )}
          <button
            className="prd-btn prd-btn-changes"
            disabled={!!busy}
            onClick={() => {
              const body = window.prompt('수정 요청 코멘트:');
              if (body) action('수정요청', `/api/projects/${projectId}/prs/${number}/request-changes`, { body });
            }}
          >
            수정 요청
          </button>
          {pr.reviewDecision === 'APPROVED' && pr.mergeable !== 'CONFLICTING' && (
            <button
              className="prd-btn prd-btn-merge"
              disabled={!!busy}
              onClick={() => {
                if (window.confirm(`PR #${number}을(를) 병합할까요?`))
                  action('병합', `/api/projects/${projectId}/prs/${number}/merge`, { method: 'squash' });
              }}
            >
              {busy === '병합' ? '병합 중…' : '병합'}
            </button>
          )}
          <button className="prd-btn prd-btn-diff" disabled={!!busy} onClick={toggleDiff}>
            {busy === 'diff' ? '불러오는 중…' : diffOpen ? 'Diff 숨기기' : 'Diff 보기'}
          </button>
          {pr.url && (
            <button className="prd-btn prd-btn-diff" onClick={() => postJson('/api/open-url', { url: pr.url }).catch(() => window.open(pr.url, '_blank'))}>
              GitHub에서 열기
            </button>
          )}
        </div>
      )}
      {diffOpen && diff !== null && (
        <div className="prd-diff-view">
          <h4>Diff</h4>
          <pre className="prd-diff-pre diff-pre pr-diff">
          {diff.split('\n').map((line, i) => {
            let cls = 'dl-ctx';
            if (line.startsWith('+') && !line.startsWith('+++')) cls = 'dl-add';
            else if (line.startsWith('-') && !line.startsWith('---')) cls = 'dl-del';
            else if (line.startsWith('@@') || line.startsWith('diff ')) cls = 'dl-hunk';
            return (
              <span key={i} className={cls}>
                {line === '' ? ' ' : line}
              </span>
            );
          })}
        </pre>
        </div>
      )}
      {pr.files?.length > 0 && (
        <div className="prd-files">
          <h4>변경 파일 ({pr.files.length})</h4>
          <div className="prd-file-list">
          {pr.files.map((f) => {
            const total = (f.additions || 0) + (f.deletions || 0);
            const pct = total ? ((f.additions || 0) / total) * 100 : 0;
            return (
            <div key={f.path} className="prd-file">
              <span className="prd-file-path">{f.path}</span>
              <span className="prd-file-stats">
                <span className="prd-add">+{f.additions}</span>
                <span className="prd-del">−{f.deletions}</span>
                <span className="prd-file-bar"><span className="prd-bar-add" style={{ width: `${pct}%` }} /></span>
              </span>
            </div>
            );
          })}
          </div>
        </div>
      )}
      {pr.reviews?.length > 0 && (
        <div className="prd-reviews">
          <h4>리뷰</h4>
          {pr.reviews.map((r, i) => (
            <div key={i} className="prd-review">
              <span className={`prd-rv-badge prd-rv-${r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes' : 'commented'}`}>{r.state}</span>
              <span className="prd-rv-author">{r.author}</span>
              <span className="prd-rv-time">{timeAgo(r.submittedAt)}</span>
              {r.body && <div className="prd-rv-body">{r.body}</div>}
            </div>
          ))}
        </div>
      )}
      {pr.comments?.length > 0 && (
        <div className="prd-comments">
          <h4>코멘트 ({pr.comments.length})</h4>
          {pr.comments.map((c, i) => (
            <div key={i} className="prd-comment">
              <div className="prd-comment-head">
                <span className="prd-comment-author">{c.author}</span>
                <span className="prd-comment-time">{timeAgo(c.createdAt)}</span>
              </div>
              <div className="prd-comment-body">{c.body}</div>
            </div>
          ))}
        </div>
      )}
      {pr.state === 'OPEN' && (
        <div className="prd-comment-form">
          <textarea
            className="prd-comment-textarea"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="코멘트 남기기…"
            rows={2}
          />
          <button
            className="prd-btn prd-btn-comment"
            disabled={!!busy || !comment.trim()}
            onClick={async () => {
              await action('코멘트', `/api/projects/${projectId}/prs/${number}/comment`, { body: comment.trim() });
              setComment('');
            }}
          >
            코멘트 등록
          </button>
        </div>
      )}
    </div>
  );
}

export default function Pr() {
  const [projects, setProjects] = useState([]);
  const [list, setList] = useState([]);
  const [projectFilter, setProjectFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('불러오는 중…');
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson(`/api/prs?state=${statusFilter}`);
      const prs = data.prs || [];
      setList(prs);
      const open = prs.filter((p) => p.state === 'OPEN').length;
      setStatus(`전체 ${prs.length}개 · 열림 ${open}개`);
    } catch (e) {
      setStatus(`PR 로드 실패: ${e.message}`);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchJson('/api/projects')
      .then((data) => setProjects(Array.isArray(data) ? data : data.projects || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // SSE: pr 상태 변경 시 재조회 (AiAccounts.jsx 패턴)
    const es = new EventSource('/api/events');
    const onChange = () => {
      if (!document.hidden) load();
    };
    es.addEventListener('pr:update', onChange);
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 30000);
    return () => {
      es.removeEventListener('pr:update', onChange);
      es.close();
      clearInterval(timer);
    };
  }, [load]);

  const filtered = useMemo(() => {
    let prs = [...list];
    if (projectFilter) prs = prs.filter((p) => p.projectId === projectFilter);
    const q = search.toLowerCase().trim();
    if (q) {
      prs = prs.filter(
        (p) =>
          (p.title || '').toLowerCase().includes(q) ||
          `#${p.number}`.includes(q) ||
          (p.author || '').toLowerCase().includes(q) ||
          (p.branch || '').toLowerCase().includes(q),
      );
    }
    return prs;
  }, [list, projectFilter, search]);

  return (
    <main className="pr-view">
      <h1>풀 리퀘스트</h1>
      <div className="pr-toolbar">
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="">전체 프로젝트</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">전체</option>
          <option value="open">열림</option>
          <option value="merged">병합됨</option>
          <option value="closed">닫힘</option>
        </select>
        <input className="pr-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="PR 검색…" />
        <button className="prd-btn prd-btn-diff" onClick={load}>새로고침</button>
      </div>
      <p className="pr-summary">{status}</p>

      {detail && (
        <PrDetail
          projectId={detail.projectId}
          number={detail.number}
          onClose={() => setDetail(null)}
          onChanged={load}
        />
      )}

      {filtered.length === 0 && (
        <div className="pr-empty">
          <div className="pre-title">표시할 풀 리퀘스트가 없습니다</div>
          <div className="pre-sub">필터를 바꾸거나 새로고침해 주세요</div>
        </div>
      )}
      {filtered.map((pr) => {
        const rv = reviewInfo(pr);
        return (
          <article
            key={`${pr.projectId}-${pr.number}`}
            className="row pr-row"
            onClick={() => setDetail({ projectId: pr.projectId, number: pr.number })}
          >
            <div className="pr-row-left">
              <span className={`pr-review-badge pr-rv-${rv.cls}`}>{rv.label}</span>
              <div className="pr-row-main">
                <h2 className="pr-row-title">
                  <span className="pr-proj-tag">{pr.projectName}</span>
                  <span className="pr-number">#{pr.number}</span>
                  <span className="pr-title-text">{pr.title}</span>
                </h2>
                <p className="pr-row-meta">
                  <span className="pr-branch">{pr.branch}</span>
                  <span>{pr.author}</span>
                  <span className="pr-stats">+{pr.additions} −{pr.deletions}</span>
                  <span>{pr.changedFiles}개 파일</span>
                  <span className="pr-updated">{timeAgo(pr.updatedAt)}</span>
                </p>
              </div>
            </div>
          </article>
        );
      })}
    </main>
  );
}
