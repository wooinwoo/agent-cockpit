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

// 바닐라 .nav-tab 순서. board/timeline/list는 jira 서브패널이라 제외
// (jira/api-tester/agent는 프론트 드라이버가 없어 미이식).
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
];

const VIEW_KEY = 'dl-view';
const THEME_KEY = 'dl-theme';

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

export default function App() {
  const [view, setView] = useState(loadView);
  const [theme, setTheme] = useState(loadTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const Active = (TABS.find((t) => t.id === view) || TABS[0]).View;

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* 저장소 사용 불가 */ }
  }, [view]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* 저장소 사용 불가 */ }
  }, [theme]);

  return (
    <div>
      <header style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '12px 16px', flexWrap: 'wrap' }}>
        <strong>Cockpit</strong>
        <nav role="tablist" aria-label="대시보드 탐색" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={view === t.id}
              onClick={() => setView(t.id)}
              style={view === t.id ? { borderColor: 'var(--accent)' } : undefined}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button onClick={() => setSettingsOpen(true)} style={{ marginLeft: 'auto' }}>설정</button>
      </header>
      <main><Active /></main>
      {settingsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="설정"
          onClick={() => setSettingsOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, minWidth: 280, display: 'grid', gap: 12 }}
          >
            <h2 style={{ margin: 0, fontSize: '1rem' }}>설정</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>테마</span>
              <button onClick={() => setTheme('light')} style={theme === 'light' ? { borderColor: 'var(--accent)' } : undefined}>라이트</button>
              <button onClick={() => setTheme('dark')} style={theme === 'dark' ? { borderColor: 'var(--accent)' } : undefined}>다크</button>
            </div>
            <div style={{ fontSize: '0.8rem' }}>
              <span>서버 주소: </span>
              <code style={{ fontFamily: 'var(--mono)' }}>{window.location.origin}</code>
            </div>
            <button onClick={() => setSettingsOpen(false)}>닫기</button>
          </div>
        </div>
      )}
    </div>
  );
}
