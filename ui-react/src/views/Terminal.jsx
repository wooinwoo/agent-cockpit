import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { fetchJson } from '../api.js';
import './Terminal.css';

// 바닐라(js/terminal.js addTerminal)의 다크 팔레트.
// background만 앱 셸의 --bg-1(#0d1117)에 맞춤.
const DARK_THEME = {
  background: '#0d1117',
  foreground: '#f5f1e8',
  cursor: '#7ee8fb',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(126,232,251,.25)',
  selectionForeground: '#ffffff',
  black: '#1c1e26',
  red: '#ff8088',
  green: '#8fef8b',
  yellow: '#ffd866',
  blue: '#82b0ff',
  magenta: '#ff8fb8',
  cyan: '#7ee8fb',
  white: '#f5f1e8',
  brightBlack: '#6e7281',
  brightRed: '#ffa7ad',
  brightGreen: '#aff5ad',
  brightYellow: '#ffe39c',
  brightBlue: '#a8c8ff',
  brightMagenta: '#ffb1d0',
  brightCyan: '#a8f0ff',
  brightWhite: '#ffffff',
};

function labelOf(t) {
  return t.alias || t.command || t.termId;
}

export default function TerminalView() {
  const [terms, setTerms] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [unread, setUnread] = useState({});
  const [status, setStatus] = useState('연결 중…');

  const boxRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const activeRef = useRef(null);
  const termsRef = useRef([]);
  const buffersRef = useRef(new Map());
  const pendingCreateRef = useRef(false);
  const backoffRef = useRef(1000);
  const closedRef = useRef(false);

  function replaceTerms(next) {
    termsRef.current = next;
    setTerms(next);
  }

  function upsertTerm(t) {
    const cur = termsRef.current;
    const i = cur.findIndex((x) => x.termId === t.termId);
    const merged = { ...(i >= 0 ? cur[i] : {}), ...t, exited: false };
    const next = i >= 0 ? cur.map((x) => (x.termId === t.termId ? merged : x)) : [...cur, merged];
    replaceTerms(next);
  }

  function send(obj) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function dims() {
    const t = termRef.current;
    return { cols: t ? t.cols : 120, rows: t ? t.rows : 30 };
  }

  // 단일 xterm 인스턴스에 해당 터미널 내용을 표시.
  // 서버가 'terminals' 메시지에 실어준 buffer + 비활성 중 쌓인 출력을 재생.
  function activate(id) {
    const term = termRef.current;
    const t = termsRef.current.find((x) => x.termId === id);
    if (!t) return;
    activeRef.current = id;
    setActiveId(id);
    setUnread((u) => {
      if (!u[id]) return u;
      const next = { ...u };
      delete next[id];
      return next;
    });
    if (term) {
      term.clear();
      const replay = buffersRef.current.get(id);
      if (replay) {
        buffersRef.current.delete(id);
        term.write(replay);
      }
      term.focus();
    }
    const { cols, rows } = dims();
    send({ type: 'focus', termId: id, cols, rows });
  }

  function handleMessage(msg) {
    const term = termRef.current;
    switch (msg.type) {
      case 'terminals': {
        // WS 접속 시 전체 목록 + 재생 버퍼 (server.js activeTerminalsPayload)
        for (const t of msg.active || []) {
          if (t.buffer && t.termId !== activeRef.current) {
            buffersRef.current.set(t.termId, (buffersRef.current.get(t.termId) || '') + t.buffer);
          }
          upsertTerm(t);
        }
        if (!activeRef.current && (msg.active || []).length > 0) {
          activate(msg.active[0].termId);
        }
        break;
      }
      case 'created': {
        upsertTerm(msg);
        if (pendingCreateRef.current) {
          pendingCreateRef.current = false;
          activate(msg.termId);
        } else if (!activeRef.current) {
          activate(msg.termId);
        }
        break;
      }
      case 'output': {
        if (msg.termId === activeRef.current) {
          term?.write(msg.data);
        } else {
          buffersRef.current.set(msg.termId, (buffersRef.current.get(msg.termId) || '') + msg.data);
          setUnread((u) => (u[msg.termId] ? u : { ...u, [msg.termId]: true }));
        }
        break;
      }
      case 'exit': {
        replaceTerms(termsRef.current.map((t) =>
          t.termId === msg.termId ? { ...t, exited: true } : t,
        ));
        if (msg.termId === activeRef.current) {
          term?.write('\r\n\x1b[90m[프로세스 종료]\x1b[0m\r\n');
        }
        break;
      }
      case 'error':
        setStatus(msg.message || '터미널 오류');
        break;
      default:
        break;
    }
  }

  function connect() {
    if (closedRef.current) return;
    let ws;
    try {
      ws = new WebSocket(`ws://${location.host}/ws-term`);
    } catch {
      setStatus('WebSocket 생성 실패 — 재시도 중…');
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;
    ws.onopen = () => {
      backoffRef.current = 1000;
      setStatus('연결됨');
    };
    ws.onmessage = (e) => {
      try {
        handleMessage(JSON.parse(e.data));
      } catch { /* malformed JSON — 무시 */ }
    };
    ws.onerror = () => {
      setStatus('연결 오류 — 재시도 중…');
    };
    ws.onclose = () => {
      if (wsRef.current !== ws || closedRef.current) return;
      setStatus('연결 끊김 — 재시도 중…');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    const delay = Math.min(backoffRef.current, 10000);
    backoffRef.current = Math.min(backoffRef.current * 1.5, 10000);
    setTimeout(() => {
      if (!closedRef.current) connect();
    }, Math.round(delay + Math.random() * 500));
  }

  // xterm 생명주기: 마운트 시 open → ResizeObserver로 fit → 언마운트 시 dispose
  useEffect(() => {
    closedRef.current = false;
    const term = new Terminal({
      theme: DARK_THEME,
      fontFamily: "'JetBrains Mono','Cascadia Code','D2Coding',monospace",
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    term.open(boxRef.current);
    try {
      fit.fit();
    } catch { /* 컨테이너가 아직 측정 불가 */ }
    term.write('\x1b[90m터미널에 연결 중…\x1b[0m\r\n');

    term.onData((data) => {
      const id = activeRef.current;
      if (!id) return;
      const { cols, rows } = dims();
      // 바닐라와 동일: 입력에 현재 크기를 동봉해 pty 크기를 함께 확정
      if (!send({ type: 'input', termId: id, data, cols, rows })) {
        setStatus('연결 복구 중이라 입력을 받지 않았어요');
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch { return; }
      const id = activeRef.current;
      if (id) send({ type: 'resize', termId: id, cols: term.cols, rows: term.rows });
    });
    if (boxRef.current) ro.observe(boxRef.current);

    fetchJson('/api/terminals')
      .then((data) => {
        for (const t of data.terminals || []) upsertTerm(t);
        if (!activeRef.current && (data.terminals || []).length > 0) {
          activate(data.terminals[0].termId);
        }
      })
      .catch((e) => setStatus(e.message));

    connect();

    return () => {
      closedRef.current = true;
      ro.disconnect();
      try {
        wsRef.current?.close();
      } catch { /* 이미 닫힘 */ }
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function createTerminal() {
    const { cols, rows } = dims();
    pendingCreateRef.current = true;
    if (!send({ type: 'create', projectId: '__home__', cols, rows })) {
      pendingCreateRef.current = false;
      setStatus('연결되지 않음 — 잠시 후 다시 시도하세요');
    }
  }

  function killTerminal(id) {
    send({ type: 'kill', termId: id });
    buffersRef.current.delete(id);
    const rest = termsRef.current.filter((t) => t.termId !== id);
    replaceTerms(rest);
    setUnread((u) => {
      if (!u[id]) return u;
      const next = { ...u };
      delete next[id];
      return next;
    });
    if (activeRef.current === id) {
      activeRef.current = null;
      setActiveId(null);
      termRef.current?.clear();
      if (rest.length > 0) activate(rest[0].termId);
    }
  }

  return (
    <main className="term-tab">
      <div className="term-toolbar">
        <h1>터미널</h1>
        <span className="term-status">{status}</span>
        <span style={{ flex: 1 }} />
        <button onClick={createTerminal}>+ 새 터미널</button>
      </div>
      <div className="term-body">
        <ul className="term-list">
          {terms.length === 0 && <li className="term-empty">터미널 없음</li>}
          {terms.map((t) => (
            <li
              key={t.termId}
              className={`term-item${t.termId === activeId ? ' active' : ''}${t.exited ? ' exited' : ''}`}
              onClick={() => (t.termId === activeId ? termRef.current?.focus() : activate(t.termId))}
              title={t.termId}
            >
              <span className="term-name">
                {unread[t.termId] && <i className="term-dot" />}
                {labelOf(t)}
              </span>
              <span className="term-meta">{t.projectId === '__home__' ? '홈' : t.projectId}</span>
              <button
                className="term-kill"
                title="종료"
                onClick={(e) => {
                  e.stopPropagation();
                  killTerminal(t.termId);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="term-screen" ref={boxRef} onClick={() => termRef.current?.focus()} />
      </div>
    </main>
  );
}
