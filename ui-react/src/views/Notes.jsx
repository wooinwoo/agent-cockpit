import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import './Notes.css';

const AUTOSAVE_DELAY = 1200;

// ─── 작은 로컬 마크다운 렌더러 (의존성 없음: HTML 이스케이프 후 변환) ───
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMd(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(((?:\([^)]*\)|[^)])*)\)/g, (_, text, url) => {
      const raw = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      return /^https?:\/\//.test(raw) ? `<a href="${url}" target="_blank" rel="noreferrer">${text}</a>` : text;
    });
}

export function renderMarkdown(md) {
  const lines = String(md ?? '').split('\n');
  let html = '';
  let inCode = false;
  let codeBuf = '';
  let inList = false;
  let listTag = '';
  const closeList = () => {
    if (inList) {
      html += `</${listTag}>`;
      inList = false;
      listTag = '';
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (inCode) {
        html += `<pre><code>${codeBuf}</code></pre>`;
        codeBuf = '';
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf += `${esc(line)}\n`;
      continue;
    }
    if (inList && !/^(\s*[-*]|\s*\d+\.)\s+/.test(line)) closeList();
    let m;
    if ((m = /^###\s+(.*)/.exec(line))) { html += `<h3>${inlineMd(m[1])}</h3>`; continue; }
    if ((m = /^##\s+(.*)/.exec(line))) { html += `<h2>${inlineMd(m[1])}</h2>`; continue; }
    if ((m = /^#\s+(.*)/.exec(line))) { html += `<h1>${inlineMd(m[1])}</h1>`; continue; }
    if (/^---\s*$/.test(line)) { html += '<hr>'; continue; }
    if ((m = /^>\s?(.*)/.exec(line))) { html += `<blockquote><p>${inlineMd(m[1])}</p></blockquote>`; continue; }
    if (/^\|(.+)\|$/.test(line)) {
      let tbl = '<table>';
      let first = true;
      while (i < lines.length && /^\|(.+)\|$/.test(lines[i])) {
        // 양 끝 빈 셀 제거
        const parts = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        const isSep = parts.length > 0 && parts.every((c) => /^:?-{1,}:?$/.test(c));
        if (isSep) { i++; continue; }
        if (isSep) { i++; continue; }
        const tag = first ? 'th' : 'td';
        tbl += `<tr>${parts.map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join('')}</tr>`;
        first = false;
        i++;
      }
      i--;
      html += `${tbl}</table>`;
      continue;
    }
    if ((m = /^\s*[-*]\s+(.+)/.exec(line))) {
      if (!inList || listTag !== 'ul') { closeList(); html += '<ul>'; inList = true; listTag = 'ul'; }
      html += `<li>${inlineMd(m[1])}</li>`;
      continue;
    }
    if ((m = /^\s*\d+\.\s+(.+)/.exec(line))) {
      if (!inList || listTag !== 'ol') { closeList(); html += '<ol>'; inList = true; listTag = 'ol'; }
      html += `<li>${inlineMd(m[1])}</li>`;
      continue;
    }
    if (!line.trim()) continue;
    html += `<p>${inlineMd(line)}</p>`;
  }
  if (inCode) html += `<pre><code>${codeBuf}</code></pre>`;
  closeList();
  return html;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}일 전`;
  return new Date(ts).toLocaleDateString('ko-KR');
}

function tocFrom(content) {
  const out = [];
  String(content ?? '').split('\n').forEach((line, i) => {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i });
  });
  return out;
}

export default function Notes() {
  const [list, setList] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState('edit'); // edit | preview
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState({ text: '불러오는 중…', tone: 'idle' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);
  const timerRef = useRef(null);
  const stateRef = useRef({ currentId: null, title: '', content: '' });
  stateRef.current = { currentId, title, content };
  const taRef = useRef(null);

  async function loadList() {
    const data = await fetchJson('/api/notes');
    setList(data.notes || []);
    return data.notes || [];
  }

  async function refresh(openFirstIfNone = false) {
    try {
      const items = await loadList();
      setStatus({ text: '자동저장 켜짐', tone: 'idle' });
      if (openFirstIfNone && !stateRef.current.currentId && items.length) {
        await openNote(items[0].id);
      }
    } catch (e) {
      setStatus({ text: e.message, tone: 'error' });
    } finally {
      setLoading(false);
    }
  }

  async function flushSave() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const { currentId: id, title: t, content: c } = stateRef.current;
    if (!dirtyRef.current || !id) return;
    dirtyRef.current = false;
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setStatus({ text: `저장 중… ${hm}`, tone: 'saving' });
    try {
      const note = await fetchJson(`/api/notes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t, content: c }),
      });
      setStatus({ text: `저장됨 ${hm}`, tone: 'saved' });
      setList((prev) => prev.map((n) => (n.id === id
        ? { ...n, title: note.title, updatedAt: note.updatedAt, preview: c.slice(0, 120) }
        : n)));
    } catch (e) {
      dirtyRef.current = true;
      setStatus({ text: '저장 실패 — 재시도됩니다', tone: 'error' });
    }
  }

  function scheduleSave() {
    dirtyRef.current = true;
    setStatus({ text: '수정됨 — 자동저장 대기', tone: 'pending' });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flushSave, AUTOSAVE_DELAY);
  }

  async function openNote(id) {
    await flushSave();
    try {
      const note = await fetchJson(`/api/notes/${id}`);
      dirtyRef.current = false;
      setCurrentId(id);
      setTitle(note.title || '');
      setContent(note.content || '');
      setStatus({ text: '자동저장 켜짐', tone: 'idle' });
    } catch (e) {
      setStatus({ text: e.message || '노트를 열지 못했습니다', tone: 'error' });
    }
  }

  async function createNote() {
    await flushSave();
    setBusy(true);
    try {
      const note = await postJson('/api/notes', { title: '새 노트', content: '' });
      const items = await loadList();
      void items;
      await openNote(note.id);
    } catch (e) {
      setStatus({ text: e.message || '노트 생성 실패', tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function deleteNote() {
    if (!currentId) return;
    const target = list.find((n) => n.id === currentId);
    if (!window.confirm(`"${target?.title || '이 노트'}" 노트를 삭제할까요?`)) return;
    setBusy(true);
    try {
      await fetchJson(`/api/notes/${currentId}`, { method: 'DELETE' });
      if (timerRef.current) clearTimeout(timerRef.current);
      dirtyRef.current = false;
      setCurrentId(null);
      setTitle('');
      setContent('');
      await loadList();
      setStatus({ text: '노트 삭제됨', tone: 'saved' });
    } catch (e) {
      setStatus({ text: e.message || '삭제 실패', tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function tocJump(line) {
    if (mode === 'preview') {
      const el = document.querySelector(`#nt-preview [data-hline="${line}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const ta = taRef.current;
    if (!ta || !Number.isFinite(line)) return;
    const pos = ta.value.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
    ta.focus();
    ta.setSelectionRange(pos, pos);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 21;
    ta.scrollTop = Math.max(0, (line - 3) * lh);
  }

  useEffect(() => {
    refresh(true);
    const onHide = () => { if (document.hidden) flushSave(); };
    const onUnload = () => { if (dirtyRef.current) flushSave(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onUnload);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((n) => (n.title || '').toLowerCase().includes(q) || (n.preview || '').toLowerCase().includes(q));
  }, [list, search]);

  const toc = useMemo(() => tocFrom(content), [content]);

  // 미리보기 헤딩에 줄 번호 부여 (TOC 점프용)
  const previewHtml = useMemo(() => {
    if (mode !== 'preview') return '';
    // 헤딩 태그에 data-hline 마커 삽입
    const tocLines = tocFrom(content);
    let html = renderMarkdown(content);
    let k = 0;
    html = html.replace(/<(h[1-3])>/g, (mm, tag) => {
      const t = tocLines[k++];
      return t ? `<${tag} data-hline="${t.line}">` : mm;
    });
    return html;
  }, [mode, content]);

  const current = list.find((n) => n.id === currentId);

  return (
    <main className="nt-layout">
      <nav className="nt-sidebar" aria-label="노트 목록">
        <div className="nt-side-head">
          <input
            type="text"
            className="nt-search"
            placeholder="노트 검색…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="노트 검색"
          />
          <button onClick={createNote} disabled={busy} title="새 노트">
            ＋ 새 노트
          </button>
        </div>
        <div className="nt-count">{filtered.length}개 노트</div>
        <div className="nt-list">
          {loading ? (
            <p className="nt-empty">불러오는 중…</p>
          ) : filtered.length ? filtered.map((n) => (
            <div
              key={n.id}
              role="button"
              tabIndex={0}
              onClick={() => openNote(n.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') openNote(n.id); }}
              className={`nt-item${n.id === currentId ? ' active' : ''}`}
            >
              <strong>{n.title || '제목 없음'}</strong>
              <small>{timeAgo(n.updatedAt)}{n.project ? ` · ${n.project}` : ''}</small>
              {n.preview ? <span className="nt-preview-line">{n.preview.slice(0, 60)}</span> : null}
            </div>
          )) : (
            <p className="nt-empty">노트가 없습니다</p>
          )}
        </div>
      </nav>

      <section className="nt-main">
        {!currentId ? (
          <div className="nt-empty-box">
            <div className="nt-empty-title">Notes</div>
            <div className="nt-empty-sub">왼쪽에서 노트를 선택하거나 새로 만드세요</div>
            <button onClick={createNote} disabled={busy}>＋ 새 노트 만들기</button>
          </div>
        ) : (
          <>
            <header className="nt-head">
              <input
                type="text"
                className="nt-title"
                value={title}
                maxLength={200}
                placeholder="제목"
                aria-label="노트 제목"
                onChange={(e) => { setTitle(e.target.value); scheduleSave(); }}
              />
              <span className={`nt-status tone-${status.tone}`}>{status.text}</span>
              <div className="nt-tools">
                <button
                  className={mode === 'edit' ? 'primary' : ''}
                  onClick={() => setMode('edit')}
                >
                  편집
                </button>
                <button
                  className={mode === 'preview' ? 'primary' : ''}
                  onClick={() => setMode('preview')}
                >
                  미리보기
                </button>
                <button onClick={flushSave} disabled={busy}>저장</button>
                <button onClick={() => refresh(false)} disabled={busy}>새로고침</button>
                <button onClick={deleteNote} disabled={busy}>삭제</button>
              </div>
            </header>
            {mode === 'edit' ? (
              <textarea
                ref={taRef}
                className="nt-textarea"
                value={content}
                placeholder="마크다운으로 작성하세요…"
                aria-label="노트 내용"
                onChange={(e) => { setContent(e.target.value); scheduleSave(); }}
              />
            ) : (
              <div
                id="nt-preview"
                className="nt-preview markdown-body"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            )}
            {current?.tags?.length ? (
              <div className="nt-tags">{current.tags.map((t) => <span key={t} className="nt-tag">#{t}</span>)}</div>
            ) : null}
          </>
        )}
      </section>

      <aside className="nt-toc" aria-label="목차">
        {toc.length ? (
          <>
            <div className="nt-toc-title">목차</div>
            {toc.map((h) => (
              <div
                key={h.line}
                role="button"
                tabIndex={0}
                onClick={() => tocJump(h.line)}
                onKeyDown={(e) => { if (e.key === 'Enter') tocJump(h.line); }}
                className={`nt-toc-item lv${h.level}`}
              >
                {h.text}
              </div>
            ))}
          </>
        ) : null}
      </aside>
    </main>
  );
}
