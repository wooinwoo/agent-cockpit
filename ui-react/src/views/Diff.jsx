import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import './Diff.css';

// ─── diff 텍스트 → 파일별 청크 분리 (js/diff.js parseDiffToFiles 포트) ───
function parseDiffToFiles(diffText) {
  if (!diffText || !diffText.trim()) return [];
  return diffText
    .split(/(?=^diff --git )/m)
    .filter((c) => c.startsWith('diff '))
    .map((chunk) => {
      const lines = chunk.split('\n');
      const m = lines[0].match(/b\/(.+)$/);
      return { path: m ? m[1] : '?', lines };
    });
}

function statusLetter(status) {
  const s = (status || 'M').charAt(0).toUpperCase();
  return s === 'A' || s === 'D' || s === 'R' || s === '?' ? s : 'M';
}

// ─── 줄 단위 diff 렌더 (highlight.js 없이 plain <pre> + 클래스) ───
function DiffLines({ lines }) {
  return (
    <pre className="diff-pre">
      {lines.map((line, i) => {
        let cls = 'dl-ctx';
        if (line.startsWith('@@')) cls = 'dl-hunk';
        else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'dl-add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'dl-del';
        else if (
          line.startsWith('diff ') ||
          line.startsWith('index ') ||
          line.startsWith('---') ||
          line.startsWith('+++')
        )
          cls = 'dl-meta';
        return (
          <span key={i} className={cls}>
            {line === '' ? ' ' : line}
          </span>
        );
      })}
    </pre>
  );
}

function FilePanel({ file, chunk, section, busy, onStage, onUnstage, onDiscard }) {
  const st = statusLetter(file.status);
  const [open, setOpen] = useState(true);
  const staged = section === 'staged';
  return (
    <section className={open ? 'diff-panel' : 'diff-panel collapsed'}>
      <header className="diff-panel-head" onClick={() => setOpen((v) => !v)}>
        <span className="dp-chevron">{open ? '▼' : '▶'}</span>
        <span className={`dp-status st-${st}`}>{st}</span>
        <span className="dp-path" title={file.file}>
          {file.file}
        </span>
        <span className="dp-stat">
          {file.additions ? <span className="ps-add">+{file.additions}</span> : null}
          {file.deletions ? <span className="ps-del">-{file.deletions}</span> : null}
        </span>
        <span className={`dp-badge ${staged ? 'staged' : 'unstaged'}`}>
          {staged ? '스테이징됨' : '미스테이징'}
        </span>
        <span
          className="dp-actions"
          onClick={(e) => e.stopPropagation()}
        >
          {!staged && (
            <>
              <button className="dp-action fa-stage" disabled={!!busy} onClick={() => onStage(file.file)} title="스테이징">
                +
              </button>
              <button className="dp-action fa-discard" disabled={!!busy} onClick={() => onDiscard(file.file)} title="변경 버리기">
                ↺
              </button>
            </>
          )}
          {staged && (
            <button className="dp-action fa-unstage" disabled={!!busy} onClick={() => onUnstage(file.file)} title="언스테이징">
              −
            </button>
          )}
        </span>
      </header>
      {open && (
        <div className="diff-panel-body">
          {chunk ? (
            <DiffLines lines={chunk.lines} />
          ) : (
            <div className="diff-nochunk">추적되지 않은 파일 — 스테이징하면 diff가 표시됩니다</div>
          )}
        </div>
      )}
    </section>
  );
}

export default function Diff() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [staged, setStaged] = useState({ diff: '', files: [] });
  const [unstaged, setUnstaged] = useState({ diff: '', files: [] });
  const [gitInfo, setGitInfo] = useState(null);
  const [stashes, setStashes] = useState([]);
  const [showStash, setShowStash] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [filter, setFilter] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [status, setStatus] = useState('불러오는 중…');
  const [busy, setBusy] = useState('');

  const loadDiff = useCallback(
    async (pid) => {
      const id = pid || projectId;
      if (!id) return;
      try {
        const data = await fetchJson(`/api/projects/${id}/diff`);
        setStaged(data.staged || { diff: '', files: [] });
        setUnstaged(data.unstaged || { diff: '', files: [] });
        const n =
          (data.staged?.files?.length || 0) + (data.unstaged?.files?.length || 0);
        setStatus(n ? `${n}개 파일 변경됨` : '변경 없음 — 워킹 트리 깨끗함');
      } catch (e) {
        setStatus(`diff 로드 실패: ${e.message}`);
      }
    },
    [projectId],
  );

  const loadGitInfo = useCallback(
    async (pid) => {
      const id = pid || projectId;
      if (!id) return;
      try {
        setGitInfo(await fetchJson(`/api/projects/${id}/git`));
      } catch {
        setGitInfo(null);
      }
    },
    [projectId],
  );

  // 프로젝트 목록
  useEffect(() => {
    (async () => {
      try {
        const data = await fetchJson('/api/projects');
        const list = Array.isArray(data) ? data : data.projects || [];
        setProjects(list);
        if (list.length && !projectId) {
          setProjectId(list[0].id);
          loadDiff(list[0].id);
          loadGitInfo(list[0].id);
        }
      } catch (e) {
        setStatus(`프로젝트 로드 실패: ${e.message}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SSE + 폴링 자동갱신 (AiAccounts.jsx 패턴)
  useEffect(() => {
    if (!projectId) return;
    const es = new EventSource('/api/events');
    const onChange = () => {
      if (!document.hidden) {
        loadDiff();
        loadGitInfo();
      }
    };
    es.addEventListener('git:update', onChange);
    const timer = setInterval(() => {
      if (!document.hidden) loadDiff();
    }, 30000);
    return () => {
      es.removeEventListener('git:update', onChange);
      es.close();
      clearInterval(timer);
    };
  }, [projectId, loadDiff, loadGitInfo]);

  async function gitAction(label, path, body, after = true) {
    setBusy(label);
    try {
      await postJson(path, body || {});
      if (after) {
        await loadDiff();
        await loadGitInfo();
      }
    } catch (e) {
      setStatus(`${label} 실패: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  const stageFile = (f) => gitAction('스테이징', `/api/projects/${projectId}/git/stage`, { files: [f] });
  const unstageFile = (f) =>
    gitAction('언스테이징', `/api/projects/${projectId}/git/unstage`, { files: [f] });
  const discardFile = (f) => {
    if (!window.confirm(`"${f}"의 변경을 버릴까요? 되돌릴 수 없습니다.`)) return;
    gitAction('버리기', `/api/projects/${projectId}/git/discard`, { files: [f] });
  };

  async function doCommit() {
    const message = commitMsg.trim();
    if (!message) {
      setStatus('커밋 메시지를 입력하세요');
      return;
    }
    setBusy('커밋');
    try {
      await postJson(`/api/projects/${projectId}/git/commit`, { message });
      setCommitMsg('');
      setStatus(`커밋 완료: ${message}`);
      await loadDiff();
      await loadGitInfo();
    } catch (e) {
      setStatus(`커밋 실패: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  async function genCommitMsg() {
    setBusy('AI생성');
    try {
      const data = await postJson(`/api/projects/${projectId}/generate-commit-msg`, {});
      if (data.message) {
        setCommitMsg(data.message);
        setStatus('AI가 커밋 메시지를 생성했습니다');
      }
    } catch (e) {
      setStatus(`AI 생성 실패: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  async function loadStashes() {
    try {
      const data = await fetchJson(`/api/projects/${projectId}/stash-list`);
      setStashes(data.stashes || []);
    } catch (e) {
      setStatus(`stash 목록 실패: ${e.message}`);
    }
  }

  async function createBranch() {
    const branch = newBranch.trim();
    if (!branch) {
      setStatus('새 브랜치 이름을 입력하세요');
      return;
    }
    if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
      setStatus('브랜치 이름이 올바르지 않습니다');
      return;
    }
    await gitAction('브랜치생성', `/api/projects/${projectId}/git/create-branch`, { branch });
    setNewBranch('');
  }

  const q = filter.toLowerCase().trim();
  const matchFilter = (f) => !q || (f.file || '').toLowerCase().includes(q);
  const stagedParsed = useMemo(() => parseDiffToFiles(staged.diff), [staged.diff]);
  const unstagedParsed = useMemo(() => parseDiffToFiles(unstaged.diff), [unstaged.diff]);
  const findChunk = (parsed, file) =>
    parsed.find((p) => p.path === file || p.path.endsWith(file));
  const totalAdd = [...staged.files, ...unstaged.files].reduce((s, f) => s + (f.additions || 0), 0);
  const totalDel = [...staged.files, ...unstaged.files].reduce((s, f) => s + (f.deletions || 0), 0);

  function switchProject(id) {
    setProjectId(id);
    setCommitMsg('');
    setStashes([]);
    setShowStash(false);
    loadDiff(id);
    loadGitInfo(id);
  }

  return (
    <main className="diff-view">
      <h1>변경사항</h1>
      <div className="diff-toolbar">
        <select value={projectId} onChange={(e) => switchProject(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {gitInfo && (
          <span className="diff-branch-info" title="현재 브랜치">
            <span className="dbi-branch">⎇ {gitInfo.branch || 'unknown'}</span>
            {gitInfo.stashCount > 0 && <span className="dbi-wt"> · stash {gitInfo.stashCount}</span>}
          </span>
        )}
        <span className="diff-summary">
          {staged.files.length + unstaged.files.length > 0 && (
            <>
              <span className="ds-files">{staged.files.length + unstaged.files.length}개 파일</span>
              {totalAdd > 0 && <span className="ds-add"> +{totalAdd}</span>}
              {totalDel > 0 && <span className="ds-del"> −{totalDel}</span>}
            </>
          )}
        </span>
        <button className="dt-act-btn" disabled={!!busy} onClick={() => { loadDiff(); loadGitInfo(); }}>
          새로고침
        </button>
      </div>

      <div className="diff-actions">
        <button className="dt-act-btn" disabled={!!busy} onClick={() => gitAction('전체스테이징', `/api/projects/${projectId}/git/stage`, { files: ['--all'] })}>
          전체 스테이징
        </button>
        <button className="dt-act-btn" disabled={!!busy} onClick={() => gitAction('전체언스테이징', `/api/projects/${projectId}/git/unstage`, { files: ['--all'] })}>
          전체 언스테이징
        </button>
        <button className="dt-act-btn" disabled={!!busy} onClick={() => gitAction('푸시', `/api/projects/${projectId}/push`, {})}>
          {busy === '푸시' ? '푸시 중…' : 'Push'}
        </button>
        <button className="dt-act-btn" disabled={!!busy} onClick={() => gitAction('풀', `/api/projects/${projectId}/pull`, {})}>
          {busy === '풀' ? '풀 중…' : 'Pull'}
        </button>
        <button className="dt-act-btn" disabled={!!busy} onClick={() => gitAction('페치', `/api/projects/${projectId}/fetch`, {})}>
          Fetch
        </button>
        <button
          className="dt-act-btn"
          disabled={!!busy}
          onClick={() => gitAction('스태시저장', `/api/projects/${projectId}/git/stash`, { includeUntracked: true })}
        >
          Stash 저장
        </button>
        <button className="dt-act-btn" disabled={!!busy} onClick={() => gitAction('스태시팝', `/api/projects/${projectId}/git/stash-pop`, {})}>
          Stash 팝
        </button>
        <button
          className="dt-act-btn"
          disabled={!!busy}
          onClick={() => {
            const next = !showStash;
            setShowStash(next);
            if (next) loadStashes();
          }}
        >
          Stash 목록
        </button>
      </div>

      <div className="diff-branch-row">
        <input
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          placeholder="새 브랜치 이름…"
        />
        <button className="dt-act-btn" disabled={!!busy} onClick={createBranch}>
          브랜치 생성
        </button>
      </div>

      {showStash && (
        <div className="row stash-list">
          <h2>Stash 목록</h2>
          {stashes.length === 0 && <p>stash가 없습니다</p>}
          {stashes.map((s) => (
            <div key={s.ref} className="stash-item">
              <span className="stash-ref">{s.ref}</span>
              <span>{s.message}</span>
              <span className="stash-ago">{s.ago}</span>
              <span className="stash-actions">
                <button className="btn" disabled={!!busy} onClick={() => gitAction('적용', `/api/projects/${projectId}/git/stash-apply`, { ref: s.ref })}>
                  적용
                </button>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() => gitAction('팝', `/api/projects/${projectId}/git/stash-pop`, { ref: s.ref })}
                >
                  팝
                </button>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() => {
                    if (!window.confirm(`${s.ref}을(를) 삭제할까요?`)) return;
                    gitAction('삭제', `/api/projects/${projectId}/git/stash-drop`, { ref: s.ref }).then(loadStashes);
                  }}
                >
                  삭제
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="row commit-box diff-commit-box">
        <h2>커밋</h2>
        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doCommit();
          }}
          placeholder="커밋 메시지 (Ctrl+Enter로 커밋)"
          rows={2}
        />
        <div className="dcb-row">
          <span className="dcb-staged-count">{staged.files.length > 0 ? `${staged.files.length}개 스테이징됨` : '스테이징된 파일 없음'}</span>
          <button className="ac-btn" disabled={!!busy} onClick={genCommitMsg}>
            {busy === 'AI생성' ? 'AI 생성 중…' : '✦ AI 메시지 생성'}
          </button>
          <button className="dcb-commit-btn" disabled={!!busy || staged.files.length === 0} onClick={doCommit}>
            {busy === '커밋' ? '커밋 중…' : '커밋'}
          </button>
        </div>
      </div>

      <p>
        {status}{' '}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="파일 필터…"
          className="diff-filter"
        />
      </p>

      {staged.files.filter(matchFilter).length > 0 && (
        <>
          <h2 className="diff-section-label">스테이징됨 ({staged.files.filter(matchFilter).length})</h2>
          {staged.files.filter(matchFilter).map((f) => (
            <FilePanel
              key={`staged-${f.file}`}
              file={f}
              chunk={findChunk(stagedParsed, f.file)}
              section="staged"
              busy={busy}
              onStage={stageFile}
              onUnstage={unstageFile}
              onDiscard={discardFile}
            />
          ))}
        </>
      )}

      {unstaged.files.filter(matchFilter).length > 0 && (
        <>
          <h2 className="diff-section-label">미스테이징 ({unstaged.files.filter(matchFilter).length})</h2>
          {unstaged.files.filter(matchFilter).map((f) => (
            <FilePanel
              key={`unstaged-${f.file}`}
              file={f}
              chunk={findChunk(unstagedParsed, f.file)}
              section="unstaged"
              busy={busy}
              onStage={stageFile}
              onUnstage={unstageFile}
              onDiscard={discardFile}
            />
          ))}
        </>
      )}

      {staged.files.length === 0 && unstaged.files.length === 0 && (
        <div className="diff-empty">
          <span className="de-title">변경 사항이 없습니다</span>
          <span className="de-sub">워킹 트리가 깨끗합니다</span>
        </div>
      )}
    </main>
  );
}
