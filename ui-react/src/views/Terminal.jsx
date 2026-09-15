import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const FONT_FAMILY = "'JetBrains Mono','Cascadia Code','D2Coding',monospace";
const FONT_KEY = 'dl-term-font-size';
const TREE_KEY = 'rr-term-tree';
const ACTIVE_KEY = 'rr-term-active';
const HIST_LIMIT = 256 * 1024;

function labelOf(t) {
  return t.alias || t.command || t.termId;
}

function hueOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

// ─── js/terminal-group-layout.js 순수 함수 포팅 (캔버스 의존 없음) ───
const GROUP_LAYOUTS = new Set([
  'cols', 'rows', 'grid',
  'main-left', 'main-right', 'main-top', 'main-bottom',
]);

function normalizeTerminalGroupLayout(layout, count) {
  const migrated = layout === 'h' ? 'cols' : layout === 'v' ? 'rows' : layout;
  if (count === 2) return migrated === 'rows' ? 'rows' : 'cols';
  if (count === 3) return GROUP_LAYOUTS.has(migrated) && migrated !== 'grid' ? migrated : 'main-left';
  if (count >= 4) return ['cols', 'rows', 'grid', 'main-left', 'main-right'].includes(migrated) ? migrated : 'grid';
  return 'cols';
}

function terminalGroupLayoutOptions(count) {
  if (count === 2) return [['cols', '좌우 나란히'], ['rows', '상하 쌓기']];
  if (count === 3) return [
    ['cols', '3열'], ['rows', '3행'],
    ['main-left', '메인 좌'], ['main-right', '메인 우'],
    ['main-top', '메인 상'], ['main-bottom', '메인 하'],
  ];
  return [
    ['grid', '2 × 2 격자'], ['cols', `${count}열`], ['rows', `${count}행`],
    ['main-left', '메인 좌'], ['main-right', '메인 우'],
  ];
}

function terminalGroupLayoutLabel(group) {
  return terminalGroupLayoutOptions(group?.termIds.length || group?.children?.length || 0)
    .find(([value]) => value === group?.layout)?.[1] || '그룹 레이아웃';
}

function terminalGroupRects(count, layout, width, height, gap = 16) {
  if (count <= 1) return [{ x: 0, y: 0, w: width, h: height }];
  if (layout === 'cols') {
    const w = (width - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, index) => ({ x: index * (w + gap), y: 0, w, h: height }));
  }
  if (layout === 'rows') {
    const h = (height - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, index) => ({ x: 0, y: index * (h + gap), w: width, h }));
  }
  if (layout === 'grid') {
    const columns = 2;
    const rows = Math.ceil(count / columns);
    const w = (width - gap) / columns;
    const h = (height - gap * (rows - 1)) / rows;
    return Array.from({ length: count }, (_, index) => ({
      x: (index % columns) * (w + gap),
      y: Math.floor(index / columns) * (h + gap),
      w: count === 3 && index === 2 ? width : w,
      h,
    }));
  }
  const secondaryCount = count - 1;
  const horizontalMain = layout === 'main-left' || layout === 'main-right';
  if (horizontalMain) {
    const mainWidth = (width - gap) * 0.64;
    const sideWidth = width - gap - mainWidth;
    const sideHeight = (height - gap * (secondaryCount - 1)) / secondaryCount;
    const mainX = layout === 'main-right' ? sideWidth + gap : 0;
    const sideX = layout === 'main-right' ? 0 : mainWidth + gap;
    return [
      { x: mainX, y: 0, w: mainWidth, h: height },
      ...Array.from({ length: secondaryCount }, (_, index) => ({ x: sideX, y: index * (sideHeight + gap), w: sideWidth, h: sideHeight })),
    ];
  }
  const mainHeight = (height - gap) * 0.64;
  const sideHeight = height - gap - mainHeight;
  const sideWidth = (width - gap * (secondaryCount - 1)) / secondaryCount;
  const mainY = layout === 'main-bottom' ? sideHeight + gap : 0;
  const sideY = layout === 'main-bottom' ? 0 : mainHeight + gap;
  return [
    { x: 0, y: mainY, w: width, h: mainHeight },
    ...Array.from({ length: secondaryCount }, (_, index) => ({ x: index * (sideWidth + gap), y: sideY, w: sideWidth, h: sideHeight })),
  ];
}

// ─── 레이아웃 트리 (js/terminal.js splitAt/removeFromLayoutTree의 React식 순수 함수판) ───
// {type:'split', id, dir:'h'|'v', ratio, children:[a,b]} | {type:'group', id, layout, children:[leaf..]} | {type:'leaf', termId}
let nodeSeq = 1;
function nid(prefix) {
  return `${prefix}${nodeSeq++}_${Date.now().toString(36)}`;
}

function findLeaf(node, termId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.termId === termId ? node : null;
  for (const c of node.children || []) {
    const f = findLeaf(c, termId);
    if (f) return f;
  }
  return null;
}

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children || []) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

function collectLeaves(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') {
    acc.push(node.termId);
    return acc;
  }
  for (const c of node.children || []) collectLeaves(c, acc);
  return acc;
}

// 활성 창 옆에 새 leaf 추가 (새 창은 오른쪽/아래). 명중 없으면 {node, hit:false}.
function splitTree(node, targetTermId, newTermId, dir) {
  if (!node) return { node, hit: false };
  if (node.type === 'leaf') {
    if (node.termId !== targetTermId) return { node, hit: false };
    return {
      hit: true,
      node: {
        type: 'split', id: nid('s'), dir, ratio: 0.5,
        children: [node, { type: 'leaf', termId: newTermId }],
      },
    };
  }
  let hit = false;
  const children = node.children.map((c) => {
    const r = splitTree(c, targetTermId, newTermId, dir);
    if (r.hit) hit = true;
    return r.node;
  });
  return { node: hit ? { ...node, children } : node, hit };
}

function removeFromTree(node, termId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.termId === termId ? null : node;
  const kids = (node.children || []).map((c) => removeFromTree(c, termId)).filter(Boolean);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0]; // split 붕괴 (바닐라 collapse와 동일)
  return { ...node, children: kids };
}

function addToTree(root, termId, activeId) {
  if (!root) return { type: 'leaf', termId };
  if (activeId && findLeaf(root, activeId)) {
    return splitTree(root, activeId, termId, 'h').node;
  }
  return { type: 'split', id: nid('s'), dir: 'h', ratio: 0.5, children: [root, { type: 'leaf', termId }] };
}

function setRatio(node, id, ratio) {
  if (!node || node.type === 'leaf') return node;
  if (node.id === id && node.type === 'split') return { ...node, ratio };
  return { ...node, children: node.children.map((c) => setRatio(c, id, ratio)) };
}

function replaceLeaf(node, termId, newNode) {
  if (!node) return node;
  if (node.type === 'leaf') return node.termId === termId ? newNode : node;
  return { ...node, children: node.children.map((c) => replaceLeaf(c, termId, newNode)) };
}

function buildBalanced(termIds, dir = 'h') {
  function bal(nodes, d) {
    if (nodes.length === 1) return nodes[0];
    const mid = Math.ceil(nodes.length / 2);
    return {
      type: 'split', id: nid('s'), dir: d, ratio: mid / nodes.length,
      children: [bal(nodes.slice(0, mid), d === 'h' ? 'v' : 'h'), bal(nodes.slice(mid), d === 'h' ? 'v' : 'h')],
    };
  }
  return bal(termIds.map((t) => ({ type: 'leaf', termId: t })), dir);
}

function makeGroup(root, termIds, layout) {
  const group = {
    type: 'group', id: nid('g'),
    layout: normalizeTerminalGroupLayout(layout, termIds.length),
    children: termIds.map((t) => ({ type: 'leaf', termId: t })),
  };
  if (!root) return group;
  if (!findLeaf(root, termIds[0])) {
    return { type: 'split', id: nid('s'), dir: 'h', ratio: 0.5, children: [root, group] };
  }
  let next = replaceLeaf(root, termIds[0], group);
  for (let i = 1; i < termIds.length; i++) next = removeFromTree(next, termIds[i]);
  return next;
}

function setGroupLayout(node, id, layout) {
  if (!node || node.type === 'leaf') return node;
  if (node.id === id && node.type === 'group') {
    return { ...node, layout: normalizeTerminalGroupLayout(layout, node.children.length) };
  }
  return { ...node, children: node.children.map((c) => setGroupLayout(c, id, layout)) };
}

function ungroupNode(node, id) {
  if (!node) return node;
  if (node.type !== 'leaf' && node.id === id && node.type === 'group') {
    return buildBalanced(node.children.map((c) => c.termId), 'h');
  }
  if (node.type === 'leaf') return node;
  const children = node.children.map((c) => ungroupNode(c, id));
  if (node.type === 'split' && children.length === 2) return { ...node, children };
  if (children.length === 1) return children[0];
  return { ...node, children };
}

// ─── 터미널 내 찾기: SearchAddon 없이 버퍼 API로 직접 탐색 ───
// 줄바꿈(wrap)된 물리 행은 논리 행으로 이어붙여 검색. col은 셀 근사치(CJK 와이드 문자에서 어긋날 수 있음).
function scanBufferMatches(term, query, caseSensitive) {
  const out = [];
  if (!term || !query) return out;
  let buf;
  try {
    buf = term.buffer.active;
  } catch {
    return out;
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  let text = '';
  let rowOf = 0;
  const flush = () => {
    if (!text) return;
    const hay = caseSensitive ? text : text.toLowerCase();
    let from = 0;
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      out.push({ row: rowOf, col: i, len: query.length });
      from = i + Math.max(1, needle.length);
      if (out.length >= 500) break;
    }
    text = '';
  };
  for (let r = 0; r < buf.length; r++) {
    const line = buf.getLine(r);
    if (!line) {
      flush();
      continue;
    }
    const s = line.translateToString(true);
    if (line.isWrapped && text) {
      text += s;
    } else {
      flush();
      text = s;
      rowOf = r;
    }
    if (out.length >= 500) break;
  }
  flush();
  return out;
}

// ─── 개별 xterm 창 (pane) ───
function TermPane({ termId, active, fontSize, ctx }) {
  const elRef = useRef(null);
  const apiRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return undefined;
    const term = new Terminal({
      theme: DARK_THEME,
      fontFamily: FONT_FAMILY,
      fontSize,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // IME 가드 (js/xterm-ime-guard.js 핵심 로직 포팅):
    // 조합 중(isComposing / key 'Process' / keyCode 229)에는 어떤 단축키도 가로채지 않고 IME에 통과.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.isComposing || ev.key === 'Process' || ev.keyCode === 229) return true;
      return true;
    });
    // 벨 → 시각적 플래시 (오디오 없음)
    term.onBell(() => {
      el.classList.remove('bell-flash');
      void el.offsetWidth;
      el.classList.add('bell-flash');
      setTimeout(() => el.classList.remove('bell-flash'), 650);
    });
    // 스크롤 추적: xterm은 기본적으로 위에서 보는 중엔 출력이 와도 뷰포트를 유지(따라가지 않음).
    term.onScroll(() => {
      try {
        const b = term.buffer.active;
        setAtBottom(b.viewportY >= b.baseY);
      } catch { /* disposed */ }
    });
    term.onData((data) => {
      ctx.sendInput(termId, data, term.cols, term.rows);
    });
    // Ctrl/⌘+휠 → 폰트 줌 (바닐라 changeTermFontSize 대응, 전체 pane 공통 적용)
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.zoom(e.deltaY < 0 ? 1 : -1);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });

    let sentSize = false;
    const doFit = (notify) => {
      if (!el.isConnected || el.clientWidth < 40 || el.clientHeight < 24) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (notify || !sentSize) {
        sentSize = true;
        ctx.sendResize(termId, term.cols, term.rows);
      }
    };
    const ro = new ResizeObserver(() => doFit(true));
    ro.observe(el);

    // 세션 히스토리 재생 (분할/재배치로 리마운트돼도 내용 유지)
    const hist = ctx.getHistory(termId);
    if (hist) {
      term.write(hist);
    } else {
      term.write('\x1b[90m터미널에 연결 중…\x1b[0m\r\n');
    }
    requestAnimationFrame(() => {
      doFit(false);
      const anchor = ctx.getAnchor(termId);
      try {
        if (anchor > 0) {
          const b = term.buffer.active;
          term.scrollToLine(Math.max(0, b.baseY - anchor));
          setAtBottom(false);
        } else {
          term.scrollToBottom();
        }
      } catch { /* disposed */ }
      if (ctx.isActive(termId)) {
        setTimeout(() => {
          try {
            term.focus();
          } catch { /* disposed */ }
        }, 30);
      }
    });

    const api = {
      write: (d) => {
        try {
          term.write(d);
        } catch { /* disposed */ }
      },
      fit: () => doFit(true),
      focus: () => {
        try {
          term.focus();
        } catch { /* disposed */ }
      },
      getTerm: () => term,
      scrollToBottom: () => {
        try {
          term.scrollToBottom();
        } catch { /* disposed */ }
      },
    };
    apiRef.current = api;
    ctx.registerPane(termId, api);
    return () => {
      ctx.unregisterPane(termId);
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
      term.dispose();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  // 폰트 줌이 바뀌면 기존 인스턴스에 적용 후 refit
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    try {
      api.getTerm().options.fontSize = fontSize;
      api.fit();
    } catch { /* disposed */ }
  }, [fontSize]);

  useEffect(() => {
    if (active) apiRef.current?.focus();
  }, [active]);

  return (
    <div className="pane-screen xterm-wrap" ref={elRef}>
      {!atBottom && (
        <button
          className="pane-bottom term-scroll-bottom"
          title="맨 아래로 스크롤"
          onClick={() => {
            apiRef.current?.scrollToBottom();
            setAtBottom(true);
          }}
        >
          ↓ 맨 아래
        </button>
      )}
    </div>
  );
}

export default function TerminalView() {
  const [terms, setTerms] = useState([]);
  const [layoutRoot, setLayoutRoot] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [unread, setUnread] = useState({});
  const [status, setStatus] = useState('연결 중…');
  const [fontSize, setFontSize] = useState(() => {
    const v = parseInt(localStorage.getItem(FONT_KEY), 10);
    return v >= 8 && v <= 24 ? v : 14;
  });
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCase, setFindCase] = useState(false);
  const [findPos, setFindPos] = useState({ i: 0, n: 0 });
  const [selected, setSelected] = useState([]);

  const stageRef = useRef(null);
  const wsRef = useRef(null);
  const activeRef = useRef(null);
  const layoutRef = useRef(null);
  const termsRef = useRef([]);
  const panesRef = useRef(new Map());
  const historyRef = useRef(new Map());
  const anchorsRef = useRef(new Map());
  const pendingRef = useRef(null);
  const backoffRef = useRef(1000);
  const closedRef = useRef(false);
  const restoredRef = useRef(false);
  const findMatchesRef = useRef([]);

  const termsById = useMemo(() => {
    const m = {};
    for (const t of terms) m[t.termId] = t;
    return m;
  }, [terms]);

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

  // 출력 히스토리 누적 (리마운트 재생 + 상한 256KB, 줄 경계에서 절단)
  function appendHistory(id, data) {
    let h = (historyRef.current.get(id) || '') + data;
    if (h.length > HIST_LIMIT) {
      const cut = h.indexOf('\n', h.length - HIST_LIMIT);
      h = h.slice(cut >= 0 ? cut + 1 : h.length - HIST_LIMIT);
    }
    historyRef.current.set(id, h);
  }

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }, []);

  // pane 공용 콜백 (TermPane에 전달 — ref만 써서 stable)
  const ctx = useMemo(() => ({
    sendInput: (termId, data, cols, rows) => {
      if (!send({ type: 'input', termId, data, cols, rows })) {
        setStatus('연결 복구 중이라 입력을 받지 않았어요');
      }
    },
    sendResize: (termId, cols, rows) => send({ type: 'resize', termId, cols, rows }),
    registerPane: (termId, api) => panesRef.current.set(termId, api),
    unregisterPane: (termId) => {
      if (panesRef.current.get(termId)) panesRef.current.delete(termId);
    },
    getHistory: (termId) => historyRef.current.get(termId) || '',
    getAnchor: (termId) => anchorsRef.current.get(termId) || 0,
    isActive: (termId) => activeRef.current === termId,
    zoom: (d) => {
      setFontSize((f) => {
        const n = Math.max(8, Math.min(24, f + d));
        try {
          localStorage.setItem(FONT_KEY, String(n));
        } catch { /* storage unavailable */ }
        return n;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // 구조 변경 전 스크롤 앵커 스냅샷 (위로 보고 있던 창이 리마운트 후에도 위치 유지)
  function snapshotAnchors() {
    for (const [id, api] of panesRef.current) {
      try {
        const b = api.getTerm().buffer.active;
        anchorsRef.current.set(id, Math.max(0, b.baseY - b.viewportY));
      } catch { /* disposed */ }
    }
  }

  function focusPane(id) {
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
    const api = panesRef.current.get(id);
    if (api) {
      const term = api.getTerm();
      api.focus();
      send({ type: 'focus', termId: id, cols: term.cols, rows: term.rows });
    }
  }

  function fitAllPanes() {
    for (const api of panesRef.current.values()) {
      try {
        api.fit();
      } catch { /* disposed */ }
    }
  }

  // ─── 찾기 ───
  function activeXterm() {
    try {
      return panesRef.current.get(activeRef.current)?.getTerm?.() || null;
    } catch {
      return null;
    }
  }

  function stepFind(dir) {
    const m = findMatchesRef.current;
    if (!m.length) return;
    let i = findMatchesRef.current._idx ?? -1;
    i += dir;
    if (i < 0) i = m.length - 1;
    if (i >= m.length) i = 0;
    findMatchesRef.current._idx = i;
    const term = activeXterm();
    if (!term) return;
    const mt = m[i];
    try {
      term.scrollToLine(Math.max(0, mt.row - Math.floor(term.rows / 2)));
    } catch { /* disposed */ }
    try {
      term.select(mt.col, mt.row, mt.len);
    } catch { /* disposed */ }
    setFindPos({ i: i + 1, n: m.length });
  }

  useEffect(() => {
    const term = activeXterm();
    if (findOpen && findQuery && term) {
      findMatchesRef.current = scanBufferMatches(term, findQuery, findCase);
      findMatchesRef.current._idx = -1;
      setFindPos({ i: 0, n: findMatchesRef.current.length });
      stepFind(1);
    } else {
      findMatchesRef.current = [];
      setFindPos({ i: 0, n: 0 });
      if (!findOpen) {
        try {
          term?.clearSelection();
        } catch { /* disposed */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, findCase, activeId]);

  function closeFind() {
    setFindOpen(false);
  }

  // ─── WS 메시지 (서버 shapes 재사용: terminals/created/output/exit/error) ───
  function handleMessage(msg) {
    switch (msg.type) {
      case 'terminals': {
        const known = new Set(termsRef.current.map((t) => t.termId));
        for (const t of msg.active || []) {
          if (!known.has(t.termId)) {
            if (t.buffer) historyRef.current.set(t.termId, t.buffer);
            upsertTerm(t);
            known.add(t.termId);
          }
        }
        // 끊긴 동안 서버에서 사라진 터미널의 잔여 상태 정리
        for (const id of [...historyRef.current.keys()]) {
          if (!known.has(id)) {
            historyRef.current.delete(id);
            anchorsRef.current.delete(id);
          }
        }
        setUnread((u) => {
          const next = {};
          for (const [k, v] of Object.entries(u)) if (known.has(k)) next[k] = v;
          return next;
        });
        // 트리 정합: 사라진 leaf 제거, 새 터미널 편입, 첫 동기화 때 저장된 트리 복원
        setLayoutRoot((prev) => {
          let next = prev;
          if (!restoredRef.current) {
            restoredRef.current = true;
            try {
              const saved = JSON.parse(localStorage.getItem(TREE_KEY) || 'null');
              const ids = new Set([...known]);
              const valid = (n) => {
                if (!n) return false;
                if (n.type === 'leaf') return ids.has(n.termId);
                return (n.children || []).every(valid);
              };
              if (saved && valid(saved)) next = saved;
            } catch { /* malformed JSON */ }
          }
          const inTree = new Set(collectLeaves(next));
          for (const id of [...inTree]) {
            if (!known.has(id)) next = removeFromTree(next, id);
          }
          const active = activeRef.current;
          for (const t of msg.active || []) {
            if (!findLeaf(next, t.termId)) next = addToTree(next, t.termId, active);
          }
          return next;
        });
        if (!activeRef.current && (msg.active || []).length > 0) {
          focusPane(msg.active[0].termId);
        } else if (activeRef.current) {
          try {
            const savedActive = localStorage.getItem(ACTIVE_KEY);
            if (savedActive && known.has(savedActive)) focusPane(savedActive);
          } catch { /* storage unavailable */ }
        }
        break;
      }
      case 'created': {
        upsertTerm(msg);
        const pend = pendingRef.current;
        pendingRef.current = null;
        if (pend?.kind === 'split') {
          snapshotAnchors();
          setLayoutRoot((prev) => {
            if (prev && findLeaf(prev, pend.targetTermId)) {
              return splitTree(prev, pend.targetTermId, msg.termId, pend.dir).node;
            }
            return addToTree(prev, msg.termId, activeRef.current);
          });
        } else {
          setLayoutRoot((prev) => addToTree(prev, msg.termId, pend?.kind === 'create' ? activeRef.current : null));
        }
        focusPane(msg.termId);
        break;
      }
      case 'output': {
        appendHistory(msg.termId, msg.data);
        const api = panesRef.current.get(msg.termId);
        if (api) {
          api.write(msg.data);
        }
        if (msg.termId !== activeRef.current) {
          setUnread((u) => (u[msg.termId] ? u : { ...u, [msg.termId]: true }));
        }
        break;
      }
      case 'exit': {
        replaceTerms(termsRef.current.map((t) =>
          t.termId === msg.termId ? { ...t, exited: true } : t,
        ));
        panesRef.current.get(msg.termId)?.write('\r\n\x1b[90m[프로세스 종료]\x1b[0m\r\n');
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

  // WS 생명주기: 컴포넌트당 단일 WS, pane들은 termId로 메시지 라우팅
  useEffect(() => {
    closedRef.current = false;
    fetchJson('/api/terminals')
      .then((data) => {
        for (const t of data.terminals || []) upsertTerm(t);
        setLayoutRoot((prev) => {
          let next = prev;
          for (const t of data.terminals || []) {
            if (!findLeaf(next, t.termId)) next = addToTree(next, t.termId, null);
          }
          return next;
        });
        if (!activeRef.current && (data.terminals || []).length > 0) {
          focusPane(data.terminals[0].termId);
        }
      })
      .catch((e) => setStatus(e.message));
    connect();
    return () => {
      closedRef.current = true;
      try {
        wsRef.current?.close();
      } catch { /* 이미 닫힘 */ }
      wsRef.current = null;
      panesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 트리/active 영속화
  useEffect(() => {
    layoutRef.current = layoutRoot;
    try {
      if (layoutRoot) localStorage.setItem(TREE_KEY, JSON.stringify(layoutRoot));
      else localStorage.removeItem(TREE_KEY);
    } catch { /* storage unavailable */ }
  }, [layoutRoot]);
  useEffect(() => {
    try {
      if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
    } catch { /* storage unavailable */ }
  }, [activeId]);

  function requestCreate(projectId = '__home__', split = null, extra = {}) {
    pendingRef.current = split ? { kind: 'split', ...split } : { kind: 'create' };
    if (!send({ type: 'create', projectId, cols: 120, rows: 30, ...extra })) {
      pendingRef.current = null;
      setStatus('연결되지 않음 — 잠시 후 다시 시도하세요');
    }
  }

  // AI 계정 탭 등 외부에서 터미널 열기 요청 (accountId + loginMode 전달)
  useEffect(() => {
    const onOpen = (e) => {
      const { accountId, loginMode } = e.detail || {};
      if (!accountId) return;
      requestCreate('__home__', null, { accountId, ...(loginMode ? { loginMode: true } : {}) });
    };
    window.addEventListener('cockpit:open-terminal', onOpen);
    return () => window.removeEventListener('cockpit:open-terminal', onOpen);
  }, []);

  function createTerminal() {
    requestCreate('__home__');
  }

  // 활성 창 분할: 같은 프로젝트로 새 터미널을 만들어 옆/아래에 배치
  function splitActive(dir) {
    const target = activeRef.current;
    if (!target) {
      requestCreate('__home__');
      return;
    }
    const t = termsRef.current.find((x) => x.termId === target);
    requestCreate(t?.projectId || '__home__', { targetTermId: target, dir });
  }

  function killTerminal(id) {
    send({ type: 'kill', termId: id });
    historyRef.current.delete(id);
    anchorsRef.current.delete(id);
    panesRef.current.delete(id);
    snapshotAnchors();
    const rest = termsRef.current.filter((t) => t.termId !== id);
    replaceTerms(rest);
    setUnread((u) => {
      if (!u[id]) return u;
      const next = { ...u };
      delete next[id];
      return next;
    });
    setSelected((s) => s.filter((x) => x !== id));
    setLayoutRoot((prev) => removeFromTree(prev, id));
    if (activeRef.current === id) {
      const leaves = collectLeaves(removeFromTree(layoutRef.current, id));
      const fallback = rest.find((t) => leaves.includes(t.termId)) || rest[0];
      activeRef.current = null;
      setActiveId(null);
      if (fallback) focusPane(fallback.termId);
    }
  }

  function groupSelected() {
    const ids = selected.filter((id) => termsRef.current.some((t) => t.termId === id));
    if (ids.length < 2) return;
    snapshotAnchors();
    setLayoutRoot((prev) => makeGroup(prev, ids, 'cols'));
    setSelected([]);
  }

  function cycleGroupLayout(groupId) {
    snapshotAnchors();
    setLayoutRoot((prev) => {
      const g = findNode(prev, groupId);
      if (!g || g.type !== 'group') return prev;
      const opts = terminalGroupLayoutOptions(g.children.length);
      const cur = Math.max(0, opts.findIndex(([v]) => v === g.layout));
      return setGroupLayout(prev, groupId, opts[(cur + 1) % opts.length][0]);
    });
  }

  function ungroup(groupId) {
    snapshotAnchors();
    setLayoutRoot((prev) => ungroupNode(prev, groupId));
  }

  function toggleSelect(id) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  // Alt+방향키로 이웃 창으로 포커스 이동 (기하학적 최근접)
  function moveFocus(code) {
    const stage = stageRef.current;
    if (!stage || !activeRef.current) return;
    const els = [...stage.querySelectorAll('[data-pane-id]')];
    const curEl = els.find((el) => el.dataset.paneId === activeRef.current);
    if (!curEl) return;
    const cr = curEl.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const el of els) {
      if (el === curEl) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const dx = x - cx;
      const dy = y - cy;
      let primary = 0;
      let secondary = 0;
      if (code === 'ArrowLeft') {
        if (dx >= -8) continue;
        primary = -dx;
        secondary = Math.abs(dy);
      } else if (code === 'ArrowRight') {
        if (dx <= 8) continue;
        primary = dx;
        secondary = Math.abs(dy);
      } else if (code === 'ArrowUp') {
        if (dy >= -8) continue;
        primary = -dy;
        secondary = Math.abs(dx);
      } else {
        if (dy <= 8) continue;
        primary = dy;
        secondary = Math.abs(dx);
      }
      const score = primary + secondary * 2;
      if (score < bestScore) {
        bestScore = score;
        best = el.dataset.paneId;
      }
    }
    if (best) focusPane(best);
  }

  // 스테이지 키보드 단축키 (IME 조합 중엔 전부 통과)
  function onStageKeyDown(e) {
    const ne = e.nativeEvent || e;
    if (ne.isComposing || ne.keyCode === 229 || e.key === 'Process') return;
    const target = e.target;
    if (target?.closest?.('.term-find')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        closeFind();
      }
      return;
    }
    const inXterm = !!target?.closest?.('.xterm');
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (e.code === 'KeyH') {
        e.preventDefault();
        splitActive('h');
        return;
      }
      if (e.code === 'KeyV') {
        e.preventDefault();
        splitActive('v');
        return;
      }
      if (e.code === 'KeyW') {
        e.preventDefault();
        if (activeRef.current) killTerminal(activeRef.current);
        return;
      }
    }
    if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && inXterm) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
        e.preventDefault();
        moveFocus(e.code);
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyF') {
      e.preventDefault();
      setFindOpen((o) => !o);
    }
  }

  function startDividerDrag(e, nodeId) {
    e.preventDefault();
    const container = e.currentTarget.parentElement;
    const rect = container.getBoundingClientRect();
    const isH = e.currentTarget.classList.contains('h');
    const move = (ev) => {
      const pos = isH ? ev.clientX - rect.left : ev.clientY - rect.top;
      const total = isH ? rect.width : rect.height;
      if (total <= 0) return;
      const ratio = Math.max(0.08, Math.min(0.92, pos / total));
      setLayoutRoot((prev) => setRatio(prev, nodeId, ratio));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      fitAllPanes();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ─── 트리 렌더 ───
  function paneHeader(t, compact) {
    const id = t.termId;
    return (
      <div className={`pane-head term-head${compact ? ' compact' : ''}`}>
        <span className="pane-dot th-dot" style={{ background: `hsl(${hueOf(id)} 70% 60%)` }} />
        <span className="pane-title th-name" title={id}>
          {unread[id] && <i className="term-dot" />}
          {labelOf(t)}
        </span>
        {t.exited && <span className="pane-exited th-tag">종료됨</span>}
        <span className="th-spacer" style={{ flex: 1 }} />
        {!compact && (
          <>
            <button className="pane-btn" title="이 창을 좌우로 분할 (Alt+Shift+H)" onClick={() => { activeRef.current = id; setActiveId(id); splitActive('h'); }}>◫</button>
            <button className="pane-btn" title="이 창을 상하로 분할 (Alt+Shift+V)" onClick={() => { activeRef.current = id; setActiveId(id); splitActive('v'); }}>◧</button>
          </>
        )}
        <button className="pane-btn danger th-close" title="창 닫기 (Alt+Shift+W)" onClick={() => killTerminal(id)}>✕</button>
      </div>
    );
  }

  function renderNode(node) {
    if (!node) return null;
    if (node.type === 'leaf') {
      const t = termsById[node.termId];
      if (!t) return null;
      const isActive = node.termId === activeId;
      return (
        <div
          key={node.termId}
          data-pane-id={node.termId}
          className={`pane-leaf split-leaf${isActive ? ' active' : ''}`}
          onMouseDown={() => {
            if (activeRef.current !== node.termId) focusPane(node.termId);
          }}
        >
          {paneHeader(t, false)}
          <div className="pane-body">
            <TermPane termId={node.termId} active={isActive} fontSize={fontSize} ctx={ctx} />
          </div>
        </div>
      );
    }
    if (node.type === 'group') {
      const kids = node.children.filter((c) => termsById[c.termId]);
      if (!kids.length) return null;
      const rects = terminalGroupRects(kids.length, node.layout || 'cols', 100, 100, 1.5);
      const label = terminalGroupLayoutLabel({ layout: node.layout, termIds: kids.map((c) => c.termId) });
      return (
        <div key={node.id} className="pane-group">
          <div className="pane-head compact group-head">
            <span className="pane-title">👥 그룹 {kids.length} · {label}</span>
            <span style={{ flex: 1 }} />
            <button className="pane-btn" title="다음 그룹 레이아웃" onClick={() => cycleGroupLayout(node.id)}>⇄</button>
            <button className="pane-btn" title="그룹 해제" onClick={() => ungroup(node.id)}>해제</button>
          </div>
          <div className="group-body">
            {kids.map((c, i) => {
              const r = rects[i];
              const t = termsById[c.termId];
              const isActive = c.termId === activeId;
              return (
                <div
                  key={c.termId}
                  data-pane-id={c.termId}
                  className={`group-cell${isActive ? ' active' : ''}`}
                  style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
                  onMouseDown={() => {
                    if (activeRef.current !== c.termId) focusPane(c.termId);
                  }}
                >
                  {paneHeader(t, true)}
                  <div className="pane-body">
                    <TermPane termId={c.termId} active={isActive} fontSize={fontSize} ctx={ctx} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    const isH = node.dir === 'h';
    const prop = isH ? 'width' : 'height';
    const cross = isH ? 'height' : 'width';
    return (
      <div key={node.id} className={`split-container ${isH ? 'horizontal' : 'vertical'}`}>
        <div className="split-child" style={{ [prop]: `calc(${node.ratio * 100}% - 3px)`, [cross]: '100%' }}>
          {renderNode(node.children[0])}
        </div>
        <div
          className={`split-divider ${isH ? 'h' : 'v'}`}
          title="드래그로 크기 조절"
          onMouseDown={(e) => startDividerDrag(e, node.id)}
        />
        <div className="split-child" style={{ [prop]: `calc(${(1 - node.ratio) * 100}% - 3px)`, [cross]: '100%' }}>
          {renderNode(node.children[1])}
        </div>
      </div>
    );
  }

  return (
    <main className="term-tab" id="terminal-view">
      <div className="term-toolbar">
        <h1>터미널</h1>
        <span className="term-status">{status}</span>
        <span style={{ flex: 1 }} />
        <button className="term-tool-btn primary" onClick={createTerminal}>+ 새 터미널</button>
        <button className="term-tool-btn" title="활성 창을 좌우로 분할 (Alt+Shift+H)" onClick={() => splitActive('h')} disabled={!activeId}>◫ 좌우 분할</button>
        <button className="term-tool-btn" title="활성 창을 상하로 분할 (Alt+Shift+V)" onClick={() => splitActive('v')} disabled={!activeId}>◧ 상하 분할</button>
        <button className="term-tool-btn" title="터미널 내 찾기 (Ctrl+Shift+F)" onClick={() => setFindOpen((o) => !o)}>🔍 찾기</button>
        <span className="term-font" title="Ctrl+휠로도 조절">
          <button title="글자 작게" onClick={() => ctx.zoom(-1)}>A−</button>
          <button
            className="term-font-size"
            title="글자 크기 초기화 (14)"
            onClick={() => {
              setFontSize(14);
              try {
                localStorage.setItem(FONT_KEY, '14');
              } catch { /* storage unavailable */ }
            }}
          >
            {fontSize}
          </button>
          <button title="글자 크게" onClick={() => ctx.zoom(1)}>A+</button>
        </span>
      </div>
      {findOpen && (
        <div className="term-find term-search open">
          <input
            autoFocus
            placeholder="터미널에서 찾기… (Enter 다음, Shift+Enter 이전)"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
          />
          <button className="ts-btn" title="이전 (Shift+Enter)" onClick={() => stepFind(-1)}>↑</button>
          <button className="ts-btn" title="다음 (Enter)" onClick={() => stepFind(1)}>↓</button>
          <button
            className={`ts-toggle${findCase ? ' active on' : ''}`}
            title="대소문자 구분"
            onClick={() => setFindCase((c) => !c)}
          >
            Aa
          </button>
          <span className="term-find-count ts-count">
            {findQuery ? (findPos.n ? `${findPos.i}/${findPos.n}` : '일치 없음') : ''}
          </span>
          <button className="ts-btn" title="닫기 (Esc)" onClick={closeFind}>✕</button>
        </div>
      )}
      <div className="term-body">
        <ul className="term-list mob-term-tabs">
          {terms.length === 0 && <li className="term-empty">터미널 없음</li>}
          {terms.map((t) => (
            <li
              key={t.termId}
              className={`term-item mob-tab${t.termId === activeId ? ' active' : ''}${t.exited ? ' exited' : ''}${selected.includes(t.termId) ? ' picked' : ''}`}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) toggleSelect(t.termId);
                else if (t.termId === activeId) panesRef.current.get(t.termId)?.focus();
                else focusPane(t.termId);
              }}
              title={`${t.termId} (Ctrl+클릭으로 그룹 선택)`}
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
        <div className="term-stage-wrap">
          {selected.length >= 2 && (
            <div className="term-group-bar">
              <span>{selected.length}개 선택됨</span>
              <button className="term-tool-btn" onClick={groupSelected}>👥 그룹으로 묶기</button>
              <button className="term-tool-btn" onClick={() => setSelected([])}>선택 해제</button>
            </div>
          )}
          <div className="term-stage term-panels" ref={stageRef} onKeyDown={onStageKeyDown}>
            {layoutRoot ? (
              renderNode(layoutRoot)
            ) : (
              <div className="term-empty-stage term-empty">
                <p className="term-empty-title">터미널 없음</p>
                <button className="btn primary" onClick={createTerminal}>+ 새 터미널</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
