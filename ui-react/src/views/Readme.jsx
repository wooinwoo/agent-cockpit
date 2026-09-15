import { useMemo, useState } from 'react';
import './Readme.css';

// 원본 js/main.js의 README_CONTENT를 React용으로 압축 이식 (정적 문서, API 없음)
// 전체 원문은 바닐라 대시보드의 README 탭 참조
const README_MD = `# Cockpit

여러 프로젝트의 Claude Code 세션, Git 상태, GitHub PR, 사용량을 한 화면에서 모니터링하고 관리하는 로컬 대시보드.
Tauri 데스크탑 앱 + PWA 모바일 지원.

\`http://localhost:3847\` · LAN: \`http://<IP>:3847\`

---

## Setup — 설치 가이드

### 1. 필수 설치

| 프로그램 | 용도 | 설치 명령 (winget) |
|----------|------|-------------------|
| **Node.js 20+** | 서버 런타임 | \`winget install OpenJS.NodeJS.LTS\` |
| **Git** | 버전 관리 | \`winget install Git.Git\` |
| **Claude Code CLI** | AI 세션 관리 | \`npm install -g @anthropic-ai/claude-code\` |

> Claude Code CLI 설치 후 \`claude\` 명령어로 OAuth 로그인 필요

### 2. 앱 실행

\`\`\`bash
node server.js
# 또는 데스크탑 앱 (인스톨러)
# Cockpit_x.x.x_x64-setup.exe 실행
\`\`\`

### 3. 모바일 접속

같은 WiFi에서 \`http://<PC IP>:3847\` 접속.
헤더의 **Mobile Connect** 버튼으로 QR 코드 확인.

---

## Configuration — API 키 설정

### Jira 연동

| 항목 | 값 |
|------|-----|
| **URL** | Jira Cloud 인스턴스 URL (HTTPS만 허용) |
| **Email** | Atlassian 계정 이메일 |
| **API Token** | Atlassian API 토큰 |

설정 패널(헤더 톱니바퀴) → Jira 섹션 → URL, Email, Token 입력 → Test Connection → Save.

### Gemini API 키 (Workflows)

Google AI Studio에서 발급한 키를 설정 패널 → AI 섹션에 입력 → Save.

### GitHub CLI (PR + CI/CD)

\`\`\`bash
gh auth login
gh auth status
\`\`\`

> \`gh\` 미설치 시 해당 기능만 비활성화, 나머지는 정상 동작

### 토큰 보안

- 모든 API 토큰은 **AES-256-GCM** 암호화 후 저장 (평문 저장 안 함)
- Jira config GET API는 토큰 마지막 4자리만 마스킹 표시

---

## Features — 기능 안내

### Overview (Dashboard)

- **Project Cards** — 세션 상태, 브랜치, 미커밋 수, PR 상태 실시간 표시
- **Cost & Usage** — 토큰 사용량, 모델별 비용 추정, 차트
- **Dev Server** — 프로젝트별 개발 서버 시작/중지
- **IDE 연동** — VS Code, Cursor, Windsurf 원클릭 실행

### Changes (Git Diff)

- **2-Column Diff View** — 파일 사이드바 + 접기/펼치기
- **Stage/Unstage/Discard** — 파일 단위 스테이징 관리
- **AI 커밋 메시지** — Haiku가 변경사항 분석 후 자동 생성

### Notes

- **마크다운 노트** — 프로젝트별 메모 작성/편집
- **사이드바** — 노트 목록, 제목/날짜 표시
- **자동저장** — 입력 후 잠시 뒤 자동 저장

### Workflows

- JSON 기반 멀티 스텝 AI 워크플로우 엔진
- 조건부 순환, 병렬 팬아웃/팬인, 스케줄 반복 실행

---

## Keyboard Shortcuts — 단축키

| 단축키 | 동작 |
|----------|------|
| Ctrl+1 | Overview 탭 |
| Ctrl+7 | Notes 탭 |
| Ctrl+8 | Workflows 탭 |
| Ctrl+9 | README 탭 |
| Ctrl+K | Command Palette |

---

## Architecture — 구조

\`\`\`
Browser / Tauri        Node.js Server (port 3847)
index.html  <--HTTP--> server.js
js/         <--SSE---- poller
xterm.js    <--WS----- node-pty
\`\`\`

- **Frontend** — ES 모듈 분리 (빌드 도구 없음)
- **Backend** — 순수 Node.js HTTP 서버 (프레임워크 없음)
- **실시간** — SSE 폴링 push, WebSocket 터미널 스트리밍

### Data Files

| 파일 | 내용 |
|------|------|
| \`projects.json\` | 프로젝트 목록 |
| \`notes/*.md\` | 마크다운 노트 (JSON 저장) |
| \`workflows/*.json\` | 워크플로우 정의 |

---

## API Endpoints — 노트 API

| Method | Path | 설명 |
|--------|------|------|
| GET | /api/notes | 노트 목록 |
| GET | /api/notes/:id | 노트 상세 |
| POST | /api/notes | 노트 생성 |
| PUT | /api/notes/:id | 노트 수정 |
| DELETE | /api/notes/:id | 노트 삭제 |
`;

// ─── 작은 로컬 마크다운 렌더러 (Notes.jsx와 동일, 의존성 없음) ───
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

function renderMarkdown(md) {
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
        const parts = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        const isSep = parts.length > 0 && parts.every((c) => /^:?-{1,}:?$/.test(c));
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

function slug(s) {
  return `rm-${String(s).toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/-+$/, '')}`;
}

// ## 기준 섹션 분리 (원본 renderReadme와 동일 방식)
function parseSections(md) {
  const sections = [];
  let cur = { title: '', lines: [] };
  for (const line of md.split('\n')) {
    const h2 = /^## (.+)/.exec(line);
    if (h2) {
      if (cur.title || cur.lines.length) sections.push(cur);
      cur = { title: h2[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.title || cur.lines.length) sections.push(cur);
  return sections.map((s) => ({
    ...s,
    id: s.title ? slug(s.title) : 'rm-top',
    md: (s.title ? `## ${s.title}\n` : '') + s.lines.join('\n'),
  }));
}

function tocFromSection(md) {
  const out = [];
  md.split('\n').forEach((line) => {
    const m = /^(#{3,4})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), id: slug(m[2].trim()) });
  });
  return out;
}

export default function Readme() {
  const [active, setActive] = useState(0);
  const sections = useMemo(() => parseSections(README_MD), []);

  const idx = Math.min(Math.max(active, 0), sections.length - 1);
  const sec = sections[idx];
  const toc = useMemo(() => tocFromSection(sec.md), [sec]);

  const html = useMemo(() => {
    let out = renderMarkdown(sec.md);
    // h2/h3/h4에 앵커 id 부여 (TOC 점프용)
    out = out.replace(/<(h[234])>(.*?)<\/h[234]>/g, (mm, tag, inner) => {
      const text = inner.replace(/<[^>]+>/g, '');
      return `<${tag} id="${slug(text)}">${inner}</${tag}>`;
    });
    return out;
  }, [sec]);

  function jump(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const prev = idx > 0 ? sections[idx - 1] : null;
  const next = idx < sections.length - 1 ? sections[idx + 1] : null;

  return (
    <main className="rm-layout">
      <nav className="rm-sidebar" aria-label="문서 목차">
        <div className="rm-sidebar-title">Cockpit</div>
        <div className="rm-nav">
          {sections.map((s, i) => (
            s.title ? (
              <div key={s.id} className="rm-nav-section">
                <a
                  href={`#${s.id}`}
                  className={`rm-nav-item${i === idx ? ' active' : ''}`}
                  onClick={(e) => { e.preventDefault(); setActive(i); }}
                >
                  <span>{s.title}</span>
                </a>
              </div>
            ) : null
          ))}
        </div>
      </nav>

      <article
        className="rm-article markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <aside className="rm-toc" aria-label="이 페이지 목차">
        {toc.length ? (
          <>
            <div className="rm-toc-title">이 페이지</div>
            <ul className="rm-toc-list">
              {toc.map((h) => (
                <li key={h.id} className={`rm-toc-item rm-toc-l${h.level}`}>
                  <a
                    className="rm-toc-link"
                    href={`#${h.id}`}
                    onClick={(e) => { e.preventDefault(); jump(h.id); }}
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <div className="rm-page-nav">
          {prev ? (
            <button className="rm-page-link" onClick={() => setActive(idx - 1)}>
              <span className="rm-page-dir">← 이전</span>
              <span className="rm-page-label">{prev.title || '처음'}</span>
            </button>
          ) : <span />}
          {next ? (
            <button className="rm-page-link" onClick={() => setActive(idx + 1)}>
              <span className="rm-page-dir">다음 →</span>
              <span className="rm-page-label">{next.title}</span>
            </button>
          ) : <span />}
        </div>
      </aside>
    </main>
  );
}
