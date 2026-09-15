import { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import './Agent.css';

// 모델 선택 폴백 (GET /api/agent/model·/api/agent/agents 실패 시)
// 값은 백엔드 setModel()이 받는 id(auto/flash/pro), 라벨은 실제 Gemini 모델명.
const FALLBACK_MODELS = [
  { id: 'auto', label: '자동' },
  { id: 'flash', label: 'gemini-2.0-flash' },
  { id: 'pro', label: 'gemini-2.5-pro' },
];

const MAX_LEN = 5000;

// ─── 작은 로컬 마크다운-라이트 렌더러 (Notes.jsx 아이디어 축소판) ───
// HTML 이스케이프 후 code/pre → **bold** → 리스트 순서로 변환.
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
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

export function renderChatMd(md) {
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
  for (const line of lines) {
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
    if (inList && !/^\s*([-*]|\d+\.)\s+/.test(line)) closeList();
    let m;
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
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return new Date(ts).toLocaleDateString('ko-KR');
}

export default function Agent() {
  const [convs, setConvs] = useState([]);
  const [convId, setConvId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [model, setModel] = useState('auto');
  const [modelOpts, setModelOpts] = useState(FALLBACK_MODELS);
  const [keyConfigured, setKeyConfigured] = useState(null); // null=확인 중
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [toolLog, setToolLog] = useState([]);
  const [loading, setLoading] = useState(true);

  const convIdRef = useRef(null);
  convIdRef.current = convId;
  const bottomRef = useRef(null);
  const taRef = useRef(null);

  async function loadList() {
    try {
      const data = await fetchJson('/api/agent/conversations');
      setConvs(Array.isArray(data) ? data : []);
    } catch {
      // 히스토리 조회 실패는 조용히 무시 (세션 전용으로 동작)
    }
  }

  async function loadModel() {
    try {
      const [m, agents] = await Promise.all([
        fetchJson('/api/agent/model').catch(() => null),
        fetchJson('/api/agent/agents').catch(() => null),
      ]);
      if (m?.model) setModel(m.model);
      const opts = [...FALLBACK_MODELS];
      const list = Array.isArray(agents) ? agents : agents?.agents;
      if (Array.isArray(list)) {
        for (const a of list) {
          if (a?.id && !opts.some((o) => o.id === a.id)) {
            opts.push({ id: a.id, label: `${a.emoji ? `${a.emoji} ` : ''}${a.name || a.id}` });
          }
        }
      }
      setModelOpts(opts);
    } catch {
      setModelOpts(FALLBACK_MODELS);
    }
  }

  async function loadKeyState() {
    try {
      const data = await fetchJson('/api/ai/config');
      setKeyConfigured(!!data.configured);
    } catch {
      setKeyConfigured(null);
    }
  }

  async function openConv(id) {
    setConvId(id);
    setErr('');
    setNotice('');
    setToolLog([]);
    setProgress('');
    setBusy(false);
    try {
      const conv = await fetchJson(`/api/agent/conversations/${id}`);
      setMessages(conv.messages || []);
    } catch (e) {
      setErr(e.message || '대화를 불러오지 못했습니다');
      setMessages([]);
    }
  }

  async function newConv() {
    setErr('');
    try {
      const c = await postJson('/api/agent/conversations', {});
      setConvId(c.id);
      setMessages([]);
      setToolLog([]);
      setProgress('');
      setBusy(false);
      await loadList();
      taRef.current?.focus();
    } catch (e) {
      // 생성 실패해도 빈 세션으로 시작 (세션 전용 모드)
      setConvId(null);
      setMessages([]);
    }
  }

  async function deleteConv(id) {
    const target = convs.find((c) => c.id === id);
    if (!window.confirm(`"${target?.lastMessage?.slice(0, 30) || '이 대화'}" 대화를 삭제할까요?`)) return;
    try {
      await fetchJson(`/api/agent/conversations/${id}`, { method: 'DELETE' });
      if (id === convIdRef.current) {
        setConvId(null);
        setMessages([]);
        setToolLog([]);
        setProgress('');
        setBusy(false);
      }
      await loadList();
    } catch (e) {
      setErr(e.message || '삭제 실패');
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    if (text.length > MAX_LEN) {
      setErr(`메시지가 너무 깁니다 (최대 ${MAX_LEN}자)`);
      return;
    }
    setErr('');
    setNotice('');
    let id = convIdRef.current;
    try {
      if (!id) {
        const c = await postJson('/api/agent/conversations', {});
        id = c.id;
        setConvId(id);
        await loadList();
      }
      setInput('');
      setMessages((prev) => [...prev, { role: 'user', content: text, ts: Date.now() }]);
      setBusy(true);
      setProgress('전송 중…');
      setToolLog([]);
      // fire-and-forget: {status:'started'} 반환, 결과는 SSE agent:* 로 수신
      await postJson('/api/agent/chat', { convId: id, message: text });
      loadList();
    } catch (e) {
      setBusy(false);
      setProgress('');
      if (/API key/i.test(e.message || '')) {
        setKeyConfigured(false);
        setErr('Gemini API 키가 필요해요. 아래 안내에 따라 키를 등록해 주세요.');
      } else {
        setErr(e.message || '전송 실패');
      }
    }
  }

  async function stop() {
    const id = convIdRef.current;
    if (!id) return;
    try {
      await postJson('/api/agent/stop', { convId: id });
      setProgress('중단 요청됨…');
    } catch (e) {
      setErr(e.message || '중단 실패');
    }
  }

  async function changeModel(id) {
    setModel(id);
    try {
      const r = await postJson('/api/agent/model', { model: id });
      if (r?.model) setModel(r.model);
    } catch (e) {
      setErr(e.message || '모델 변경 실패');
    }
  }

  async function saveKey() {
    const key = keyInput.trim();
    if (!key) return;
    setSavingKey(true);
    try {
      await postJson('/api/ai/config', { geminiApiKey: key });
      setKeyInput('');
      setKeyConfigured(true);
      setErr('');
      setNotice('API 키가 저장됐습니다. 대화를 시작해 보세요.');
    } catch (e) {
      setErr(e.message || '키 저장 실패');
    } finally {
      setSavingKey(false);
    }
  }

  // ─── SSE: POST /api/agent/chat은 {status:'started'}만 반환하고
  // 실제 결과는 /api/events의 agent:* 이벤트로 푸시된다 (fetch 스트리밍 아님) ───
  useEffect(() => {
    loadList().finally(() => setLoading(false));
    loadModel();
    loadKeyState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/events');
    const parse = (e) => {
      try { return JSON.parse(e.data); } catch { return null; }
    };
    const match = (d) => d && d.convId === convIdRef.current;

    const onStart = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      setBusy(true);
      setProgress(d.agentName ? `${d.agentName} 시작…` : '에이전트 시작…');
    };
    const onStep = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      setBusy(true);
      if (d.text) setProgress(String(d.text).slice(0, 200));
    };
    const onThinking = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      setBusy(true);
      const t = d.thinking || d.text;
      if (t) setProgress(`생각 중… ${String(t).slice(0, 120)}`);
      else setProgress('생각 중…');
    };
    const onStream = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      setBusy(true);
      const t = d.delta || d.text || d.content;
      if (t) setProgress((prev) => `${prev || ''}${String(t)}`.slice(-500));
    };
    const onTool = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      setBusy(true);
      setToolLog((prev) => [...prev.slice(-19), { kind: 'tool', ...d }]);
      if (d.tool) setProgress(`도구 실행 중: ${d.tool}…`);
    };
    const onToolResult = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      setToolLog((prev) => [...prev.slice(-19), { kind: 'tool-result', ...d }]);
    };
    const onWarning = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      if (d.message) setNotice(d.message);
    };
    const onResponse = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: d.content || '',
        ts: Date.now(),
        agentId: d.agentId,
        agentName: d.agentName,
        agentColor: d.agentColor,
      }]);
      setBusy(false);
      setProgress('');
      loadList();
    };
    const onDone = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      setBusy(false);
      setProgress('');
      loadList();
    };
    const onError = (e) => {
      const d = parse(e);
      if (!match(d)) return;
      setBusy(false);
      setProgress('');
      setErr(d.error || '에이전트 오류');
    };

    es.addEventListener('agent:start', onStart);
    es.addEventListener('agent:step', onStep);
    es.addEventListener('agent:thinking', onThinking);
    es.addEventListener('agent:thinking-text', onThinking);
    es.addEventListener('agent:streaming', onStream);
    es.addEventListener('orch:streaming', onStream);
    es.addEventListener('agent:tool', onTool);
    es.addEventListener('agent:tool-result', onToolResult);
    es.addEventListener('agent:warning', onWarning);
    es.addEventListener('agent:response', onResponse);
    es.addEventListener('agent:done', onDone);
    es.addEventListener('agent:error', onError);
    return () => es.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, progress]);

  const current = convs.find((c) => c.id === convId);

  return (
    <main className="ag-layout">
      <nav className="ag-sidebar" aria-label="대화 목록">
        <div className="ag-side-head">
          <button onClick={newConv}>＋ 새 대화</button>
          <button onClick={loadList} title="대화 목록 새로고침">새로고침</button>
        </div>
        <div className="ag-count">{loading ? '불러오는 중…' : `${convs.length}개 대화`}</div>
        <div className="ag-list">
          {convs.length ? convs.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => openConv(c.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') openConv(c.id); }}
              className={`ag-item${c.id === convId ? ' active' : ''}`}
            >
              <strong>{c.lastMessage || '(빈 대화)'}</strong>
              <small>{timeAgo(c.createdAt)}{c.messageCount != null ? ` · ${c.messageCount}개 메시지` : ''}</small>
              <button
                className="ag-del"
                title="대화 삭제"
                onClick={(e) => { e.stopPropagation(); deleteConv(c.id); }}
              >
                ✕
              </button>
            </div>
          )) : (
            !loading && <p className="ag-empty">대화가 없습니다. 새 대화를 시작하세요.</p>
          )}
        </div>
      </nav>

      <section className="ag-main">
        <header className="ag-head">
          <strong>AI 에이전트</strong>
          {current?.lastMessage && <span className="ag-cur" title={current.lastMessage}>{current.lastMessage.slice(0, 40)}</span>}
          <div className="ag-tools">
            <label className="ag-model">
              모델
              <select value={model} onChange={(e) => changeModel(e.target.value)} aria-label="모델 선택">
                {modelOpts.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </label>
            {busy
              ? <button onClick={stop} className="danger">중단</button>
              : <button onClick={newConv} title="현재 화면을 비우고 새 대화 시작">대화 비우기</button>}
          </div>
        </header>

        {keyConfigured === false && (
          <div className="ag-keywarn" role="alert">
            <strong>Gemini API 키 필요</strong>
            <p>AI 에이전트를 쓰려면 Gemini API 키를 먼저 등록해야 합니다. 키는 설정 화면 또는 아래 입력란에서 저장할 수 있습니다.</p>
            <div className="ag-keyrow">
              <input
                type="password"
                placeholder="Gemini API 키 입력"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveKey(); }}
                aria-label="Gemini API 키"
              />
              <button onClick={saveKey} disabled={savingKey || !keyInput.trim()}>
                {savingKey ? '저장 중…' : '키 저장'}
              </button>
            </div>
          </div>
        )}

        {err && <div className="ag-err" role="alert">{err}</div>}
        {notice && <div className="ag-notice">{notice}</div>}

        <div className="ag-msgs" aria-live="polite">
          {!convId && !messages.length ? (
            <div className="ag-empty-box">
              <div className="ag-empty-title">무엇을 도와드릴까요?</div>
              <div className="ag-empty-sub">아래에 메시지를 입력하면 에이전트가 실행됩니다 (Enter 전송 · Shift+Enter 줄바꿈)</div>
              <button onClick={newConv}>＋ 새 대화 시작</button>
            </div>
          ) : messages.map((m, i) => (
            <div key={i} className={`ag-msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
              <div
                className="ag-bubble markdown-body"
                dangerouslySetInnerHTML={{ __html: m.role === 'user' ? esc(m.content).replace(/\n/g, '<br>') : renderChatMd(m.content) }}
              />
              <div className="ag-meta">
                {m.agentName ? `${m.agentName} · ` : ''}{m.ts ? new Date(m.ts).toLocaleTimeString('ko-KR') : ''}
              </div>
              {Array.isArray(m.toolSummary) && m.toolSummary.length > 0 && (
                <details className="ag-tools-detail">
                  <summary>도구 {m.toolSummary.length}개</summary>
                  <pre>{JSON.stringify(m.toolSummary, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
          {busy && (
            <div className="ag-msg assistant">
              <div className="ag-bubble ag-progress">
                <span className="ag-dot" />
                {progress ? (
                  <span className="markdown-body" dangerouslySetInnerHTML={{ __html: renderChatMd(progress) }} />
                ) : '처리 중…'}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {toolLog.length > 0 && (
          <details className="ag-tools-detail">
            <summary>도구 로그 {toolLog.length}개 (raw JSON)</summary>
            <pre>{JSON.stringify(toolLog, null, 2)}</pre>
          </details>
        )}

        <footer className="ag-inputbar">
          <textarea
            ref={taRef}
            value={input}
            maxLength={MAX_LEN}
            rows={3}
            placeholder={busy ? '에이전트 실행 중… (중단 후 입력 가능)' : '메시지 입력… (Enter 전송 · Shift+Enter 줄바꿈)'}
            aria-label="메시지 입력"
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="ag-sendrow">
            <small>{input.length}/{MAX_LEN}</small>
            {busy
              ? <button onClick={stop} className="danger">중단</button>
              : <button onClick={send} disabled={!input.trim()} className="primary">전송</button>}
          </div>
        </footer>
      </section>
    </main>
  );
}
