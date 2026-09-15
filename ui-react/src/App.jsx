import { useEffect, useState } from 'react';
import AiAccounts from './views/AiAccounts.jsx';
import Dashboard from './views/Dashboard.jsx';
import TerminalView from './views/Terminal.jsx';
import Diff from './views/Diff.jsx';
import Pr from './views/Pr.jsx';
import Notes from './views/Notes.jsx';
import Readme from './views/Readme.jsx';
import Cicd from './views/Cicd.jsx';
import Workflows from './views/Workflows.jsx';
import Autopilot from './views/Autopilot.jsx';
import Ports from './views/Ports.jsx';
import Jira from './views/Jira.jsx';
import Agent from './views/Agent.jsx';
import ApiTester from './views/ApiTester.jsx';
import CanvasBoard from './views/CanvasBoard.jsx';
import { ToastProvider, Toasts, useToast } from './components/Toast.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';

// 바닐라 .nav-tab 순서. board/timeline/list는 jira 서브패널이라 제외.
// Jira·API테스터 백엔드는 의도적 cut 상태(76fa3ee·651377a)라 해당 뷰는 대기 표시.
const TABS = [
  { id: 'dashboard', label: '대시보드', View: Dashboard },
  { id: 'terminal', label: '터미널', View: TerminalView },
  { id: 'diff', label: '변경사항', View: Diff },
  { id: 'pr', label: 'PR', View: Pr },
  { id: 'notes', label: '노트', View: Notes },
  { id: 'readme', label: '읽기', View: Readme },
  { id: 'cicd', label: 'CI/CD', View: Cicd },
  { id: 'workflows', label: '워크플로우', View: Workflows },
  { id: 'autopilot', label: '오토파일럿', View: Autopilot },
  { id: 'ports', label: '포트', View: Ports },
  { id: 'ai-accounts', label: 'AI 계정', View: AiAccounts },
  { id: 'jira', label: 'Jira', View: Jira },
  { id: 'agent', label: 'AI 채팅', View: Agent },
  { id: 'api-tester', label: 'API 테스터', View: ApiTester },
  { id: 'canvas', label: '캔버스', View: CanvasBoard },
];

const VIEW_KEY = 'dl-view';
const THEME_KEY = 'dl-theme';

// 탭별 줌(%) — 바닐라 dl-view-zoom 단일 JSON과 달리 탭별 키(dl-zoom-<id>) 사용.
const zoomStorageKey = (id) => `dl-zoom-${id}`;

function loadZoom(id) {
  try {
    const v = parseInt(localStorage.getItem(zoomStorageKey(id)), 10);
    if (Number.isFinite(v) && v >= 50 && v <= 200) return v;
  } catch { /* 저장소 사용 불가 */ }
  return 100;
}

function saveZoom(id, value) {
  try {
    if (value === 100) localStorage.removeItem(zoomStorageKey(id));
    else localStorage.setItem(zoomStorageKey(id), String(value));
  } catch { /* 저장소 사용 불가 */ }
}

// 입력 중이거나 xterm 포커스 중이면 단축키를 가로채지 않는다.
function isTypingTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  if (typeof el.closest === 'function' && el.closest('.xterm')) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function loadView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (TABS.some((t) => t.id === v)) return v;
  } catch { /* 저장소 사용 불가 */ }
  return 'dashboard';
}

function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'dark';
  } catch { /* 저장소 사용 불가 */ }
  return 'dark';
}

function Shell() {
  const [view, setView] = useState(loadView);
  const [theme, setTheme] = useState(loadTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zoom, setZoom] = useState(() => loadZoom(loadView()));
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const toast = useToast();
  const Active = (TABS.find((t) => t.id === view) || TABS[0]).View;

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* 저장소 사용 불가 */ }
  }, [view]);

  // 외부(AI 계정 탭 등)에서 탭 전환 요청
  useEffect(() => {
    const onSwitch = (e) => {
      const id = e.detail;
      if (TABS.some((t) => t.id === id)) setView(id);
    };
    window.addEventListener('cockpit:switch-view', onSwitch);
    return () => window.removeEventListener('cockpit:switch-view', onSwitch);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* 저장소 사용 불가 */ }
  }, [theme]);

  // 탭 전환 시 해당 탭의 저장된 줌 복원.
  useEffect(() => {
    setZoom(loadZoom(view));
  }, [view]);

  const applyZoom = (next) => {
    const clamped = Math.max(50, Math.min(200, next));
    saveZoom(view, clamped);
    setZoom(clamped);
  };

  const resetZoom = () => {
    saveZoom(view, 100);
    setZoom(100);
  };

  const pickTheme = (next) => {
    setTheme(next);
    toast.info(next === 'light' ? '라이트 테마로 변경' : '다크 테마로 변경');
  };

  // POST /api/server/restart — routes/system.js에 존재 확인됨.
  const doRestart = async () => {
    setRestarting(true);
    try {
      const res = await fetch('/api/server/restart', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setConfirmRestart(false);
      setSettingsOpen(false);
      toast.success('서버 재시작 중… 잠시 후 새로고침해 주세요');
    } catch (err) {
      toast.error(`서버 재시작 실패: ${err.message}`);
    } finally {
      setRestarting(false);
    }
  };

  // 키보드 단축키: Ctrl+1..9 탭 전환(탭 바 순서), Ctrl+, 설정,
  // Ctrl+Plus/Minus/0 활성 뷰 줌. 입력 중·xterm 포커스 중에는 무시.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        if (confirmRestart) {
          if (!restarting) setConfirmRestart(false);
          return;
        }
        if (settingsOpen && !isTypingTarget(e.target)) setSettingsOpen(false);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
        if (isTypingTarget(e.target)) return;
        const idx = Number(e.key) - 1;
        if (idx < TABS.length) {
          e.preventDefault();
          setView(TABS[idx].id);
        }
        return;
      }
      if (!e.shiftKey && e.key === ',') {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (!e.shiftKey && (e.key === '=' || e.key === '+')) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        applyZoom(loadZoom(view) + 10);
        return;
      }
      if (!e.shiftKey && e.key === '-') {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        applyZoom(loadZoom(view) - 10);
        return;
      }
      if (!e.shiftKey && e.key === '0') {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        resetZoom();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-logo logo">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
            <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" opacity=".3" />
          </svg>
          <span className="logo-word">Cockpit</span>
        </div>
        <nav className="tab-bar nav-tabs" role="tablist" aria-label="대시보드 탐색">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={view === t.id}
              onClick={() => setView(t.id)}
              title={i < 9 ? `${t.label} (Ctrl+${i + 1})` : t.label}
              className={`nav-tab${view === t.id ? ' active' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="header-right">
          <button className="settings-btn" onClick={() => setSettingsOpen(true)} title="설정 (Ctrl+,)">설정</button>
        </div>
      </header>
      <main className="app-main" style={zoom !== 100 ? { fontSize: `${zoom}%` } : undefined}>
        <Active />
      </main>
      {zoom !== 100 && (
        <div className="zoom-indicator" role="status">
          <span>{zoom}% · Ctrl+0으로 초기화</span>
          <button type="button" onClick={resetZoom} aria-label="줌 초기화">×</button>
        </div>
      )}
      {settingsOpen && (
        <>
          <div
            className="settings-overlay open"
            onClick={() => setSettingsOpen(false)}
          />
          <div
            className="settings-panel open"
            role="dialog"
            aria-modal="true"
            aria-label="설정"
          >
            <div className="settings-header">
              <h2>설정</h2>
              <button className="modal-close" onClick={() => setSettingsOpen(false)} aria-label="설정 닫기">×</button>
            </div>
            <div className="settings-body">
              <div className="settings-theme-row">
                <span>테마</span>
                <button onClick={() => pickTheme('light')} aria-pressed={theme === 'light'}>라이트</button>
                <button onClick={() => pickTheme('dark')} aria-pressed={theme === 'dark'}>다크</button>
              </div>
              <div className="settings-section-divider" />
              <h3 className="settings-section-title">서버</h3>
              <div className="settings-server-rowbox">
                <span>서버</span>
                <button onClick={() => setConfirmRestart(true)}>서버 재시작</button>
              </div>
              <div className="settings-origin">
                <span>서버 주소: </span>
                <code>{window.location.origin}</code>
              </div>
              <div className="settings-shortcuts">
                단축키: Ctrl+1..9 탭 전환 · Ctrl+, 설정 · Ctrl+Plus/Minus/0 줌
              </div>
            </div>
            <div className="settings-footer">
              <button onClick={() => setSettingsOpen(false)}>닫기</button>
            </div>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmRestart}
        title="서버 재시작"
        message="Cockpit 서버를 재시작할까요? 진행 중인 터미널 세션이 끊길 수 있습니다."
        confirmLabel={restarting ? '재시작 중…' : '재시작'}
        busy={restarting}
        danger
        onCancel={() => {
          if (!restarting) setConfirmRestart(false);
        }}
        onConfirm={doRestart}
      />
      <Toasts />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
