import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './CanvasBoard.css';

// Terminal.jsx는 탭 전체(목록 + 단일 공유 xterm/공유 WS 멀티플렉싱)라
// 프레임 임베드에 맞지 않는다. 그래서 프레임당 xterm 1개 + WS 1개를 갖는
// 최소 인라인 터미널(CanvasTermFrame)을 이 파일 안에 직접 구현한다.
// WS 프로토콜(create/input/resize/kill/focus, output/created/exit/error)은
// Terminal.jsx와 동일하며, 서버는 여러 WS 동시 접속을 허용한다.

// 바닐라 js/terminal.js 계열과 동일한 다크 팔레트.
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

const LS_KEY = 'react-canvas-board-v1';
const GRID = 8;
const MIN_W = 360;
const MIN_H = 220;
const DEF_W = 560;
const DEF_H = 360;
const MIN_Z = 0.3;
const MAX_Z = 1.5;
const MAX_FRAMES = 12;

function uid() {
  return `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!s || typeof s !== 'object') return null;
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const frames = Array.isArray(s.frames)
      ? s.frames
          .filter((f) => f && typeof f.id === 'string')
          .map((f) => ({
            id: f.id,
            title: String(f.title || '터미널'),
            x: num(f.x, 32),
            y: num(f.y, 32),
            w: Math.max(MIN_W, num(f.w, DEF_W)),
            h: Math.max(MIN_H, num(f.h, DEF_H)),
            termId: typeof f.termId === 'string' ? f.termId : null,
          }))
          .slice(0, MAX_FRAMES)
      : [];
    return {
      frames,
      pan: { x: num(s.pan?.x, 24), y: num(s.pan?.y, 24) },
      zoom: Math.max(MIN_Z, Math.min(MAX_Z, num(s.zoom, 0.8))),
      snapOn: s.snapOn !== false,
    };
  } catch {
    return null;
  }
}

// ─── js/terminal-group-layout.js terminalGroupRects의 축소 포팅 ───
// 바닐라의 cols/rows/grid 수식 그대로. main-left/right/top/bottom 등
// 그룹-페어 전용 변형은 제외(본 보드는 자유 배치 + 정렬 버튼만 제공).
function groupRects(count, layout, W, H, gap = 16) {
  if (count <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  if (layout === 'rows') {
    const h = (H - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, i) => ({ x: 0, y: i * (h + gap), w: W, h }));
  }
  if (layout === 'grid') {
    const cols = 2;
    const rows = Math.ceil(count / cols);
    const w = (W - gap) / cols;
    const h = (H - gap * (rows - 1)) / rows;
    return Array.from({ length: count }, (_, i) => ({
      x: (i % cols) * (w + gap),
      y: Math.floor(i / cols) * (h + gap),
      w,
      h,
    }));
  }
  const w = (W - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({ x: i * (w + gap), y: 0, w, h: H }));
}

function CanvasTermFrame({ frame, zoom, snapOn, active, onActivate, onMove, onResize, onTermId, onRemove }) {
  const boxRef = useRef(null);
  const ctlRef = useRef(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const [conn, setConn] = useState('연결 중…');
  const [termId, setTermId] = useState(frame.termId);
  const [epoch, setEpoch] = useState(0);

  // 프레임당 xterm + WS 1개. 마운트(또는 재시작) 시 1회 연결.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let ws = null;
    let closed = false;
    let backoff = 1000;
    let id = frameRef.current.termId || null;
    let pendingCreate = false;
    let terminalsTimer = 0;

    const term = new Terminal({
      theme: DARK_THEME,
      fontFamily: "'JetBrains Mono','Cascadia Code','D2Coding',monospace",
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box);
    try {
      fit.fit();
    } catch {
      /* 컨테이너 측정 전 */
    }
    term.write('\x1b[90m터미널에 연결 중…\x1b[0m\r\n');

    const dims = () => ({ cols: term.cols || 120, rows: term.rows || 30 });
    function send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }
    function adopt(nextId) {
      id = nextId;
      setTermId(nextId);
      onTermId(frameRef.current.id, nextId);
    }
    function create() {
      pendingCreate = true;
      const { cols, rows } = dims();
      if (!send({ type: 'create', projectId: '__home__', cols, rows })) {
        pendingCreate = false;
        setConn('연결되지 않음 — 재시도 중…');
      }
    }
    function handleMessage(msg) {
      if (msg.type === 'terminals') {
        // 재접속 시 기존 pty 생존 확인용. 죽어 있으면 새로 만든다.
        if (id && !(msg.active || []).some((t) => t.termId === id)) {
          id = null;
          setTermId(null);
          create();
        }
        return;
      }
      if (msg.type === 'created') {
        if (pendingCreate) {
          pendingCreate = false;
          adopt(msg.termId);
          const { cols, rows } = dims();
          send({ type: 'focus', termId: msg.termId, cols, rows });
        }
        return;
      }
      if (!id || msg.termId !== id) return;
      switch (msg.type) {
        case 'output':
          term.write(msg.data);
          break;
        case 'exit':
          term.write('\r\n\x1b[90m[프로세스 종료 — ↻ 재시작으로 새 셸을 열 수 있습니다]\x1b[0m\r\n');
          setConn('종료됨');
          break;
        case 'error':
          setConn(msg.message || '터미널 오류');
          break;
        default:
          break;
      }
    }
    function retry() {
      if (closed) return;
      const delay = Math.min(backoff, 10000);
      backoff = Math.min(backoff * 1.5, 10000);
      setTimeout(() => {
        if (!closed) connect();
      }, Math.round(delay + Math.random() * 500));
    }
    function connect() {
      if (closed) return;
      try {
        ws = new WebSocket(`ws://${location.host}/ws-term`);
      } catch {
        setConn('WebSocket 실패 — 재시도 중…');
        retry();
        return;
      }
      ws.onopen = () => {
        backoff = 1000;
        setConn('연결됨');
        const { cols, rows } = dims();
        if (id) send({ type: 'focus', termId: id, cols, rows });
        else create();
        // 서버가 'terminals' 목록을 보내지 않는 구현이면 fallback으로 생성.
        clearTimeout(terminalsTimer);
        terminalsTimer = setTimeout(() => {
          if (!closed && !id && !pendingCreate) create();
        }, 1500);
      };
      ws.onmessage = (e) => {
        try {
          handleMessage(JSON.parse(e.data));
        } catch {
          /* malformed JSON — 무시 */
        }
      };
      ws.onerror = () => setConn('연결 오류 — 재시도 중…');
      ws.onclose = () => {
        if (closed) return;
        setConn('연결 끊김 — 재시도 중…');
        retry();
      };
    }

    term.onData((data) => {
      if (!id) return;
      const { cols, rows } = dims();
      if (!send({ type: 'input', termId: id, data, cols, rows })) {
        setConn('연결 복구 중이라 입력을 받지 않았어요');
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (id) send({ type: 'resize', termId: id, cols: term.cols, rows: term.rows });
    });
    ro.observe(box);
    connect();

    ctlRef.current = {
      focus: () => {
        try {
          term.focus();
        } catch {
          /* dispose 후 */
        }
      },
      refit: () => {
        try {
          fit.fit();
        } catch {
          return;
        }
        if (id) send({ type: 'resize', termId: id, cols: term.cols, rows: term.rows });
      },
      kill: () => {
        try {
          if (id) send({ type: 'kill', termId: id });
        } catch {
          /* 이미 닫힘 */
        }
      },
      shutdown: () => {
        closed = true;
        clearTimeout(terminalsTimer);
        try {
          ws?.close();
        } catch {
          /* 이미 닫힘 */
        }
      },
    };
    return () => {
      // 탭 전환 등 언마운트 시 WS만 닫고 pty는 살려둔다(서버 durable).
      // 재마운트 시 저장된 termId로 focus 재접속한다.
      closed = true;
      clearTimeout(terminalsTimer);
      ro.disconnect();
      try {
        ws?.close();
      } catch {
        /* 이미 닫힘 */
      }
      term.dispose();
      ctlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  function snap(v) {
    return snapOn ? Math.round(v / GRID) * GRID : v;
  }

  function onHeadPointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, textarea, select')) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate(frame.id);
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = frame.x;
    const oy = frame.y;
    const move = (ev) => {
      onMove(frame.id, snap(ox + (ev.clientX - sx) / zoom), snap(oy + (ev.clientY - sy) / zoom));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onResizePointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate(frame.id);
    const sx = e.clientX;
    const sy = e.clientY;
    const ow = frame.w;
    const oh = frame.h;
    const move = (ev) => {
      onResize(
        frame.id,
        Math.max(MIN_W, snap(ow + (ev.clientX - sx) / zoom)),
        Math.max(MIN_H, snap(oh + (ev.clientY - sy) / zoom)),
      );
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ctlRef.current?.refit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function remove() {
    if (!window.confirm(`“${frame.title}” 프레임을 삭제할까요? 터미널 프로세스도 종료됩니다.`)) return;
    try {
      ctlRef.current?.kill();
    } catch {
      /* 무시 */
    }
    try {
      ctlRef.current?.shutdown();
    } catch {
      /* 무시 */
    }
    onRemove(frame.id);
  }

  function restart() {
    try {
      ctlRef.current?.kill();
    } catch {
      /* 무시 */
    }
    try {
      ctlRef.current?.shutdown();
    } catch {
      /* 무시 */
    }
    onTermId(frame.id, null);
    setTermId(null);
    setConn('연결 중…');
    setEpoch((n) => n + 1);
  }

  const shortId = termId ? termId.slice(0, 8) : '대기 중';
  const dotClass = conn === '연결됨' ? 'ok' : conn === '종료됨' ? 'dead' : 'busy';
  // 바닐라 canvas-frame-signal 매핑 (표시용 별칭 — 기존 dotClass 로직은 유지).
  const signalClass = dotClass === 'ok' ? 'busy' : dotClass === 'busy' ? 'waiting' : 'idle';

  return (
    <article
      className={`cb-frame terminal-canvas-frame${active ? ' active' : ''}`}
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
      onPointerDown={() => onActivate(frame.id)}
      aria-label={`${frame.title} 터미널 프레임`}
    >
      <header className="cb-frame-head canvas-frame-head" onPointerDown={onHeadPointerDown} title="드래그로 이동">
        <span className={`cb-dot canvas-frame-signal ${dotClass} ${signalClass}`} aria-hidden="true" />
        <span className="cb-frame-title canvas-frame-name">{frame.title}</span>
        <span className="cb-frame-sub" title={termId || ''}>
          {shortId} · {conn}
        </span>
        <span style={{ flex: 1 }} />
        {conn === '종료됨' && (
          <button type="button" onClick={restart} title="새 셸 열기">
            ↻ 재시작
          </button>
        )}
        <button type="button" className="canvas-frame-focus" onClick={() => ctlRef.current?.refit()} title="터미널 크기를 프레임에 맞춤">
          맞춤
        </button>
        <button type="button" className="cb-kill canvas-frame-close" onClick={remove} title="프레임 삭제(프로세스 종료)">
          ✕
        </button>
      </header>
      <div ref={boxRef} className="cb-term canvas-frame-body xterm-wrap" onClick={() => ctlRef.current?.focus()} />
      <span className="cb-resize canvas-frame-resize" onPointerDown={onResizePointerDown} aria-hidden="true" />
    </article>
  );
}

export default function CanvasBoard() {
  const saved = useRef(null);
  if (saved.current === null) saved.current = loadSaved();

  const [frames, setFrames] = useState(saved.current?.frames ?? []);
  const [pan, setPan] = useState(saved.current?.pan ?? { x: 24, y: 24 });
  const [zoom, setZoom] = useState(saved.current?.zoom ?? 0.8);
  const [snapOn, setSnapOn] = useState(saved.current?.snapOn ?? true);
  const [activeId, setActiveId] = useState(null);

  const viewportRef = useRef(null);
  const panRef = useRef(pan);
  panRef.current = pan;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const snapRef = useRef(snapOn);
  snapRef.current = snapOn;
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const spaceRef = useRef(false);
  const gestureRef = useRef(null);

  // 위치/줌/스냅을 localStorage에 유지 (termId 포함 — 재접속용).
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ frames, pan, zoom, snapOn }));
    } catch {
      /* 저장소 사용 불가 */
    }
  }, [frames, pan, zoom, snapOn]);

  // Space+드래그용 스페이스 추적. xterm 입력(textarea)과 폼 필드에서는 제외.
  useEffect(() => {
    const isFormTarget = (t) => t?.closest?.('input, textarea, select, [contenteditable="true"]');
    const down = (e) => {
      if (e.code === 'Space' && !e.repeat && !isFormTarget(e.target)) {
        spaceRef.current = true;
        viewportRef.current?.classList.add('space');
      }
    };
    const up = (e) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        viewportRef.current?.classList.remove('space');
      }
    };
    const blur = () => {
      spaceRef.current = false;
      gestureRef.current = null;
      viewportRef.current?.classList.remove('space');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const zoomAt = useCallback((next, cx, cy) => {
    const z0 = zoomRef.current;
    const z = Math.max(MIN_Z, Math.min(MAX_Z, next));
    if (z === z0) return;
    const p = panRef.current;
    setPan({ x: cx - ((cx - p.x) / z0) * z, y: cy - ((cy - p.y) / z0) * z });
    setZoom(z);
  }, []);

  // 휠: Ctrl/⌘+휠=줌(커서 기준). 터미널 위 일반 휠은 xterm 스크롤백에 양보.
  // 배경 위 일반 휠=팬, Shift+휠=가로 팬. 바닐라 routeCanvasTerminalWheel 대응.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = vp.getBoundingClientRect();
        zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
      } else if (e.shiftKey) {
        e.preventDefault();
        const d = e.deltaY || e.deltaX;
        setPan((p) => ({ ...p, x: p.x - d }));
      } else {
        if (e.target.closest?.('.cb-term')) return;
        e.preventDefault();
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  function startPan(e) {
    e.preventDefault();
    gestureRef.current = { sx: e.clientX, sy: e.clientY, pan: { ...panRef.current }, moved: false };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 캡처 미지원 */
    }
  }

  function onViewportPointerDown(e) {
    if (e.target.closest('.cb-toolbar')) return;
    if (e.button === 1) {
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    if (spaceRef.current && !e.target.closest('input, textarea, select, button')) {
      startPan(e);
      return;
    }
    if (!e.target.closest('.cb-frame')) startPan(e);
  }

  function onViewportPointerMove(e) {
    const g = gestureRef.current;
    if (!g) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    setPan({ x: g.pan.x + dx, y: g.pan.y + dy });
  }

  function onViewportPointerUp() {
    gestureRef.current = null;
  }

  function snapV(v) {
    return snapRef.current ? Math.round(v / GRID) * GRID : v;
  }

  const addFrame = useCallback(() => {
    const id = uid();
    setFrames((fs) => {
      if (fs.length >= MAX_FRAMES) return fs;
      const vp = viewportRef.current?.getBoundingClientRect();
      const z = zoomRef.current;
      const p = panRef.current;
      const cx = vp ? (vp.width / 2 - p.x) / z : 400;
      const cy = vp ? (vp.height / 2 - p.y) / z : 300;
      const off = (fs.length % 5) * 32;
      const next = {
        id,
        title: `터미널 ${fs.length + 1}`,
        x: snapV(cx - DEF_W / 2 + off),
        y: snapV(cy - DEF_H / 2 + off),
        w: DEF_W,
        h: DEF_H,
        termId: null,
      };
      return [...fs, next];
    });
    setActiveId(id);
  }, []);

  const removeFrame = useCallback((id) => {
    setFrames((fs) => fs.filter((f) => f.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  const moveFrame = useCallback((id, x, y) => {
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, x, y } : f)));
  }, []);

  const resizeFrame = useCallback((id, w, h) => {
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, w, h } : f)));
  }, []);

  const setFrameTermId = useCallback((id, termId) => {
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, termId } : f)));
  }, []);

  const zoomStep = useCallback(
    (d) => {
      const r = viewportRef.current?.getBoundingClientRect();
      zoomAt(zoomRef.current + d, (r?.width ?? 800) / 2, (r?.height ?? 600) / 2);
    },
    [zoomAt],
  );

  const resetZoom = useCallback(() => {
    const r = viewportRef.current?.getBoundingClientRect();
    zoomAt(1, (r?.width ?? 800) / 2, (r?.height ?? 600) / 2);
  }, [zoomAt]);

  // 바닐라 fitCanvas 대응: 모든 프레임이 들어오도록 줌·팬 조정.
  const fitAll = useCallback(() => {
    const vp = viewportRef.current;
    const fs = framesRef.current;
    if (!vp || !fs.length) return;
    const r = vp.getBoundingClientRect();
    const minX = Math.min(...fs.map((f) => f.x));
    const minY = Math.min(...fs.map((f) => f.y));
    const maxX = Math.max(...fs.map((f) => f.x + f.w));
    const maxY = Math.max(...fs.map((f) => f.y + f.h));
    const z = Math.max(
      MIN_Z,
      Math.min(1, Math.min((r.width - 56) / Math.max(1, maxX - minX), (r.height - 72) / Math.max(1, maxY - minY))),
    );
    setZoom(z);
    setPan({
      x: (r.width - (maxX - minX) * z) / 2 - minX * z,
      y: (r.height - (maxY - minY) * z) / 2 - minY * z,
    });
  }, []);

  // 자유 배치된 프레임들을 cols/rows/grid로 자동 정렬 (수식은 groupRects 포팅).
  const arrange = useCallback((layout) => {
    const fs = framesRef.current;
    if (!fs.length) return;
    const W = 1400;
    const H = 800;
    const rects = groupRects(fs.length, layout, W, H, 16);
    const ox = Math.min(...fs.map((f) => f.x));
    const oy = Math.min(...fs.map((f) => f.y));
    const doSnap = snapRef.current;
    const s = (v) => (doSnap ? Math.round(v / GRID) * GRID : v);
    setFrames(
      fs.map((f, i) => ({
        ...f,
        x: s(ox + rects[i].x),
        y: s(oy + rects[i].y),
        w: Math.max(MIN_W, Math.round(rects[i].w)),
        h: Math.max(MIN_H, Math.round(rects[i].h)),
      })),
    );
  }, []);

  return (
    <main className="cb-root">
      <div className="cb-toolbar">
        <h1>캔버스 보드</h1>
        <span className="cb-status">
          {frames.length}개 프레임 · {Math.round(zoom * 100)}%
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="cb-tool-btn primary" onClick={addFrame} disabled={frames.length >= MAX_FRAMES}>
          ＋ 프레임 추가
        </button>
        <button type="button" className="cb-tool-btn" onClick={() => zoomStep(-0.1)} title="축소">
          －
        </button>
        <button type="button" className="cb-tool-btn" onClick={resetZoom} title="100%로 되돌리기">
          100%
        </button>
        <button type="button" className="cb-tool-btn" onClick={() => zoomStep(0.1)} title="확대">
          ＋
        </button>
        <button type="button" className="cb-tool-btn" onClick={fitAll} disabled={!frames.length} title="모든 프레임이 보이게">
          맞춤
        </button>
        <span className="cb-sep" aria-hidden="true" />
        <button type="button" className="cb-tool-btn" onClick={() => arrange('cols')} disabled={!frames.length} title="가로로 나란히 배치">
          가로 정렬
        </button>
        <button type="button" className="cb-tool-btn" onClick={() => arrange('rows')} disabled={!frames.length} title="세로로 쌓기">
          세로 정렬
        </button>
        <button type="button" className="cb-tool-btn" onClick={() => arrange('grid')} disabled={!frames.length} title="격자로 배치">
          격자 정렬
        </button>
        <label className="cb-snap">
          <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} />
          스냅
        </label>
      </div>
      <div
        ref={viewportRef}
        className="cb-viewport terminal-canvas"
        role="application"
        aria-label="터미널 캔버스. 배경 드래그로 이동, Ctrl+휠로 확대/축소."
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={onViewportPointerUp}
        onPointerCancel={onViewportPointerUp}
      >
        <div className="cb-layer terminal-canvas-layer" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {frames.map((f) => (
            <CanvasTermFrame
              key={f.id}
              frame={f}
              zoom={zoom}
              snapOn={snapOn}
              active={f.id === activeId}
              onActivate={setActiveId}
              onMove={moveFrame}
              onResize={resizeFrame}
              onTermId={setFrameTermId}
              onRemove={removeFrame}
            />
          ))}
        </div>
        {frames.length === 0 && (
          <div className="cb-empty term-empty">
            <div className="cb-empty-title term-empty-title">프레임 없음</div>
            <div className="cb-empty-copy term-empty-copy">프레임을 추가하면 각자 동작하는 터미널이 열립니다.</div>
            <button type="button" className="btn primary" onClick={addFrame}>
              ＋ 프레임 추가
            </button>
          </div>
        )}
      </div>
      <div className="cb-hint canvas-toolbar-hint">
        배경 드래그·중클릭·Space+드래그: 이동 · Ctrl+휠: 확대/축소 · 헤더 드래그: 프레임 이동 · 우하단 모서리:
        크기 조절 · 위치·줌은 자동 저장
      </div>
    </main>
  );
}
