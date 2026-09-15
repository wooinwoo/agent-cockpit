import { useEffect, useState } from 'react';
import { postJson } from '../api.js';
import './ApiTester.css';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const HISTORY_KEY = 'cockpit-api-tester-history';
const HISTORY_LIMIT = 30;
const PROXY_TIMEOUT = 30000;

// body를 보낼 수 있는 메서드 (백엔드: GET/HEAD 제외)
function methodHasBody(method) {
  return method !== 'GET';
}

function validateUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return { ok: false, message: 'URL을 입력하세요.' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: '올바른 URL 형식이 아닙니다. (예: https://api.example.com/users)' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'http:// 또는 https:// URL만 허용됩니다.' };
  }
  return { ok: true, url };
}

function headersToObject(rows) {
  const obj = {};
  for (const r of rows) {
    const k = String(r.key || '').trim();
    if (!k) continue;
    obj[k] = String(r.value ?? '');
  }
  return obj;
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function formatBody(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'object') {
    try {
      return JSON.stringify(body, null, 2);
    } catch {
      return String(body);
    }
  }
  const text = String(body);
  // JSON 문자열이면 pretty-print, 아니면 원문 그대로
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

function statusClass(status) {
  if (typeof status !== 'number') return 'at-status-err';
  if (status >= 200 && status < 300) return 'at-status-ok';
  if (status >= 300 && status < 400) return 'at-status-redirect';
  return 'at-status-err';
}

let headerSeq = 1;
function newHeaderRow() {
  return { id: `h${Date.now()}-${headerSeq++}`, key: '', value: '' };
}

export default function ApiTester() {
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState([newHeaderRow()]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [response, setResponse] = useState(null);
  const [history, setHistory] = useState(loadHistory);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* 저장소 사용 불가 */
    }
  }, [history]);

  function pushHistory(entry) {
    setHistory((prev) => {
      const rest = prev.filter((h) => !(h.method === entry.method && h.url === entry.url));
      return [entry, ...rest].slice(0, HISTORY_LIMIT);
    });
  }

  function updateHeader(id, field, value) {
    setHeaders((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function addHeader() {
    setHeaders((prev) => [...prev, newHeaderRow()]);
  }

  function removeHeader(id) {
    setHeaders((prev) => (prev.length <= 1 ? prev.map((r) => ({ ...r, key: '', value: '' })) : prev.filter((r) => r.id !== id)));
  }

  function loadFromHistory(item) {
    setMethod(item.method || 'GET');
    setUrl(item.url || '');
    const rows = Object.entries(item.headers || {}).map(([key, value]) => ({
      id: `h${Date.now()}-${headerSeq++}`,
      key,
      value: String(value ?? ''),
    }));
    setHeaders(rows.length ? rows : [newHeaderRow()]);
    setBody(item.body || '');
    setError('');
    setResponse(null);
  }

  async function send() {
    const v = validateUrl(url);
    if (!v.ok) {
      setError(v.message);
      return;
    }
    setError('');
    setLoading(true);
    try {
      const payload = {
        method,
        url: v.url,
        headers: headersToObject(headers),
        timeout: PROXY_TIMEOUT,
      };
      if (methodHasBody(method)) payload.body = body;
      // 백엔드 프록시 경유 (routes/api-tester.js → lib/api-tester-service.js executeRequest)
      const result = await postJson('/api/api-tester/execute', payload);
      setResponse(result);
      pushHistory({
        method,
        url: v.url,
        headers: headersToObject(headers),
        body: methodHasBody(method) ? body : '',
        status: result?.status ?? null,
        at: new Date().toISOString(),
      });
    } catch (e) {
      setError(e.message || '요청 실패');
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }

  const hasBody = methodHasBody(method);
  const resHeaders = response?.headers && typeof response.headers === 'object' ? Object.entries(response.headers) : [];

  return (
    <main className="at at-layout">
      <h1>API 테스터</h1>
      <p className="at-sub">백엔드 프록시 경유로 CORS 없이 HTTP 요청을 보냅니다.</p>

      <section className="at-builder at-main">
        <div className="at-request-bar">
          <select
            className="at-method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            aria-label="HTTP 메서드"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <input
            type="text"
            className="at-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder="https://api.example.com/users"
            aria-label="요청 URL"
            spellCheck={false}
          />
          <button className="at-send btn primary" onClick={send} disabled={loading}>
            {loading ? '전송 중…' : '보내기'}
          </button>
        </div>

        <div className="at-section">
          <h2>헤더</h2>
          {headers.map((r) => (
            <div className="at-header-row" key={r.id}>
              <input
                type="text"
                value={r.key}
                onChange={(e) => updateHeader(r.id, 'key', e.target.value)}
                placeholder="키 (예: Content-Type)"
                aria-label="헤더 키"
                spellCheck={false}
              />
              <input
                type="text"
                value={r.value}
                onChange={(e) => updateHeader(r.id, 'value', e.target.value)}
                placeholder="값 (예: application/json)"
                aria-label="헤더 값"
                spellCheck={false}
              />
              <button onClick={() => removeHeader(r.id)} title="헤더 삭제" aria-label="헤더 삭제">✕</button>
            </div>
          ))}
          <button className="at-add" onClick={addHeader}>+ 헤더 추가</button>
        </div>

        <div className="at-section">
          <h2>본문</h2>
          {hasBody ? (
            <textarea
              className="at-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder='{"key": "value"}'
              rows={6}
              spellCheck={false}
            />
          ) : (
            <p className="at-muted">GET 요청은 본문을 보내지 않습니다. POST/PUT/DELETE/PATCH를 선택하면 입력란이 표시됩니다.</p>
          )}
        </div>

        {error && <p className="at-error" role="alert">{error}</p>}
      </section>

      <section className="at-section at-config-panel">
        <h2>응답</h2>
        {!response ? (
          <p className="at-muted at-empty">요청을 보내면 응답이 여기에 표시됩니다.</p>
        ) : (
          <div className="at-response">
            <div className="at-res-meta">
              <span className={`at-status ${statusClass(response.status)}`}>
                {typeof response.status === 'number' ? `${response.status} ${response.statusText || ''}`.trim() : '응답'}
              </span>
              {typeof response.time === 'number' && <span className="at-chip">{response.time}ms</span>}
              {typeof response.size === 'number' && <span className="at-chip">{response.size} bytes</span>}
              {response.contentType && <span className="at-chip">{response.contentType}</span>}
            </div>
            {resHeaders.length > 0 && (
              <details className="at-res-headers" open>
                <summary>응답 헤더 ({resHeaders.length})</summary>
                <dl>
                  {resHeaders.map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
            <pre className="at-res-body">{formatBody(response.body) || '(빈 본문)'}</pre>
          </div>
        )}
      </section>

      <section className="at-section">
        <div className="at-history-head">
          <h2>요청 기록</h2>
          {history.length > 0 && (
            <button className="at-clear" onClick={() => setHistory([])}>전체 삭제</button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="at-muted">아직 보낸 요청이 없습니다. 기록은 이 브라우저에만 저장됩니다.</p>
        ) : (
          <ul className="at-history">
            {history.map((h, idx) => (
              <li key={`${h.at}-${idx}`}>
                <button className="at-history-item" onClick={() => loadFromHistory(h)} title="클릭하면 요청 불러오기">
                  <span className={`at-method-tag at-m-${(h.method || 'GET').toLowerCase()}`}>{h.method}</span>
                  <span className="at-history-url">{h.url}</span>
                  {typeof h.status === 'number' && (
                    <span className={`at-status sm ${statusClass(h.status)}`}>{h.status}</span>
                  )}
                </button>
                <button
                  className="at-history-del"
                  onClick={() => setHistory((prev) => prev.filter((_, i) => i !== idx))}
                  title="기록 삭제"
                  aria-label="기록 삭제"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
