// ─── Main Entry Point: imports, init, keyboard shortcuts, pub/sub wiring ───
import { app, getOrderedTerminalIds, subscribe } from './state.js';
import { copyText, esc, showToast, simpleMarkdown, fetchJson, fetchText, postJson } from './utils.js';
import { getClickAction, getChangeAction, getInputAction, registerClickActions, registerChangeActions, registerInputActions } from './actions.js';
import { openArenaDialog, startArenaFromDialog, stopArena, startArenaPick, arenaPickDone, copyArenaResult, downloadArenaResult } from './arena.js';

// ─── Dashboard module ───
import {
  startClock, connectSSE,
  updateSummaryStats, switchView, renderCard, renderAllCards,
  renderSkeletons, setChartPeriod, fetchUsage,
  updateUsageTimestamp, showConvList, closeConvList, applyTheme, toggleTheme,
  setProjectFilter, fetchAllProjects, pullAllProjects, updateScrollIndicators,
  onVisibilityChange,
  setProjectTag, renderTagFilters,
  setupNavOverflow, updateEmptyProjectState,
  changeViewZoom, resetViewZoom,
} from './dashboard.js';

// ─── Terminal module ───
import {
  connectWS, renderLayout, fitAllTerminals, saveLayout,
  updateTermHeaders, debouncedUpdateTermHeaders, requestCloseTerminal,
  openNewTermModal, openNewTermModalWithSplit, openHomeTerminal, openTermWith,
  toggleTermSearch, closeTermSearch, doTermSearch, exportTerminal,
  changeTermFontSize, resetTermFontSize, setupTermEventDelegation,
  loadBranchesForTerm, initFileDrop,
  setupMobileActions, setupMobileSwipe,
  updateTermTheme,
  mobileSwitchTerm,
  toggleCmdPalette,
  toggleBroadcastMode,
  toggleQuickBar,
} from './terminal.js';

// ─── Diff module ───
import {
  debouncedLoadDiff, loadDiff,
  diffExpandAll, diffCollapseAll,
  doManualCommit,
  renderProjectChips,
} from './diff.js';

// ─── Modals module ───
import {
  closeSettingsPanel,
  editProject, populateProjectSelects,
  promptDevCmd, toggleDevServer, updateDevBadge,
  openIDE, openGitHub,
  resumeLastSession, showShortcutHelp, hideShortcutHelp,
  toggleCommandPalette, closeCommandPalette,
  setupCommandPaletteListeners,
  setupErrorLogCapture,
  openNotifSettings, renderNotifFilterList,
  showGitLog, showSessionHistory,
  openFilePreview, openFilePreviewFromFile, closeFilePreview,
  setupCtxMenuListeners,
} from './modals.js';

// ─── CI/CD module ───
import {
  initCicd, loadCicdRuns,
  closeCicdDetail,
} from './cicd.js';

// ─── Notes module ───

// ─── Workflows module ───
import {
  initWorkflows, loadWorkflowDefs, loadWorkflowRuns,
  handleWorkflowEvent,
} from './workflows.js';

// ─── Dashboard new features ───
import { loadBriefing, checkSmartAlerts } from './dashboard.js';

// ─── PR module ───
import { initPR } from './pr.js';

// ─── Ports module ───
import { initPorts, destroyPorts, refreshPorts, togglePortPause, filterPortSearch, toggleDevFilter } from './ports.js';
import { initAutopilotView } from './autopilot-view.js';
import { initAiAccounts } from './ai-accounts.js';
import { initNotes } from './notes.js';


// ─── README Content ───
const README_CONTENT = `# Cockpit

여러 프로젝트의 Claude Code 세션, Git 상태, GitHub PR, 사용량을 한 화면에서 모니터링하고 관리하는 로컬 대시보드.
Tauri 데스크탑 앱 + PWA 모바일 지원.

\`http://localhost:3847\` · LAN: \`http://<IP>:3847\`

---

## Setup — 설치 가이드

### 1. 필수 설치 (Required)

| 프로그램 | 용도 | 설치 명령 (winget) |
|----------|------|-------------------|
| **Node.js 20+** | 서버 런타임 | \`winget install OpenJS.NodeJS.LTS\` |
| **Git** | 버전 관리 | \`winget install Git.Git\` |
| **Claude Code CLI** | AI 세션 관리 | \`npm install -g @anthropic-ai/claude-code\` |
| **Visual Studio Build Tools** | node-pty 네이티브 빌드 | \`winget install Microsoft.VisualStudio.2022.BuildTools\` |

> Claude Code CLI 설치 후 \`claude\` 명령어로 OAuth 로그인 필요

### 2. 권장 설치 (Recommended)

| 프로그램 | 용도 | 설치 명령 |
|----------|------|----------|
| **PowerShell 7** | 터미널 \`&&\` 연산자 지원 | \`winget install Microsoft.PowerShell\` |
| **GitHub CLI** | PR 목록, CI/CD 연동 | \`winget install GitHub.cli\` |
| **Tailscale** | 외부 네트워크 안전 접근 | \`winget install Tailscale.Tailscale\` |

### 3. 원클릭 설치 (PowerShell 관리자)

\`\`\`powershell
# 필수
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Microsoft.VisualStudio.2022.BuildTools

# 권장
winget install Microsoft.PowerShell
winget install GitHub.cli
winget install Tailscale.Tailscale

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude  # OAuth 로그인
\`\`\`

### 4. 앱 실행

\`\`\`bash
# 소스에서 실행
cd dashboard
npm install
node server.js

# 또는 데스크탑 앱 (인스톨러)
# Cockpit_x.x.x_x64-setup.exe 실행
\`\`\`

### 5. 모바일 접속

같은 WiFi에서 \`http://<PC IP>:3847\` 접속
헤더의 **Mobile Connect** 버튼으로 QR 코드 확인

### 6. Windows 자동 시작 (선택)

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\\setup-autostart.ps1
\`\`\`

---

## Configuration — API 키 설정

Cockpit의 기능별로 필요한 외부 서비스 인증 정보. 모든 토큰은 **AES-256-GCM으로 암호화**되어 로컬에 저장됨.

### Jira 연동

Jira 탭을 사용하려면 Atlassian API 토큰이 필요함.

| 항목 | 값 | 예시 |
|------|-----|------|
| **URL** | Jira Cloud 인스턴스 URL (HTTPS만 허용) | \`https://myteam.atlassian.net\` |
| **Email** | Atlassian 계정 이메일 | \`user@company.com\` |
| **API Token** | Atlassian API 토큰 | \`ATATT3x...\` |

**토큰 발급 방법:**
1. [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) 접속
2. "Create API token" → 이름 입력 → 생성
3. 토큰 복사 (한 번만 표시됨)

**Cockpit에서 설정:**
- 설정 패널 (헤더 톱니바퀴) → Jira 섹션 → URL, Email, Token 입력 → Test Connection → Save
- 또는 Jira 탭 첫 진입 시 설정 안내 표시

> 저장 위치: \`jira-config.json\` (토큰은 AES-256-GCM 암호화, \`.encryption-key\`로 복호화)

### Gemini API 키 (Workflows)

Workflows 탭은 Google Gemini API를 사용함.

| 항목 | 값 |
|------|-----|
| **API Key** | Google AI Studio에서 발급한 Gemini API 키 |

**키 발급 방법:**
1. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 접속
2. "Create API Key" → 프로젝트 선택 → 생성
3. 키 복사

**Cockpit에서 설정:**
- 설정 패널 → AI 섹션 → Gemini API Key 입력 → Save

> 저장 위치: \`ai-config.json\` (키는 AES-256-GCM 암호화)

**사용처:**
- **Workflows** — 워크플로우 스텝에서 Gemini 모델 호출 (Google Search grounding 포함)

### GitHub CLI (PR + CI/CD)

GitHub 연동은 별도 API 키 없이 **GitHub CLI (\`gh\`)의 인증**을 그대로 사용.

\`\`\`bash
gh auth login   # 브라우저 OAuth 또는 토큰으로 인증
gh auth status  # 인증 상태 확인
\`\`\`

- **Overview 탭** — 프로젝트별 열린 PR 목록
- **CI/CD 탭** — GitHub Actions 워크플로우 런 조회/리런/취소

> \`gh\` 미설치 시 해당 기능만 비활성화, 나머지는 정상 동작

### Claude Code (AI Auto Commit)

AI Auto Commit은 **Claude Code CLI**를 통해 호출하므로 별도 API 키가 불필요.

\`\`\`bash
claude          # 최초 OAuth 로그인
claude --version # 설치 확인
\`\`\`

> Claude Code의 OAuth 인증 토큰이 자동으로 사용됨

### 토큰 보안

- 모든 API 토큰은 **AES-256-GCM** 암호화 후 저장 (평문 저장 안 함)
- 암호화 키: 최초 실행 시 랜덤 32바이트 생성 → \`.encryption-key\` 파일에 보관
- Jira config GET API는 토큰 마지막 4자리만 마스킹 표시 (\`****xxxx\`)
- Jira URL은 HTTPS만 허용, private IP/localhost 차단

---

## Features

### Overview (Dashboard)
- **Project Cards** — 프로젝트별 Claude 세션 상태 (active/idle/none), 현재 브랜치, 모델, uncommitted 파일 수, 최근 커밋, PR 상태를 실시간 표시
- **Project Search & Filter** — 이름, 스택, 상태(All/Active/Idle)로 필터링
- **Card Sorting** — 이름순, 활성도순, 최근활동순, 미커밋순 정렬 (드롭다운, localStorage 저장)
- **Project Pin** — 카드 별표로 즐겨찾기, 핀된 프로젝트 앞으로 정렬
- **Cost & Usage** — 오늘/이번 주/전체 토큰 사용량, 모델별 비용 추정, Chart.js 차트
- **Dev Server** — 프로젝트별 개발 서버 시작/중지, stdout에서 포트 자동 감지
- **IDE 연동** — VS Code, Cursor, Windsurf, Antigravity 원클릭 실행
- **GitHub** — 프로젝트별 열린 PR 목록 (리뷰 상태, draft 여부)

### Terminal
- **Multi-terminal** — 여러 프로젝트의 터미널을 탭으로 관리, 분할(가로/세로)
- **Tab Bar** — 빠른 전환, 가운데 클릭으로 닫기, 드래그로 순서 변경
- **Branch/Worktree Picker** — 터미널 생성 시 브랜치나 Git worktree 경로 선택
- **Search** — Ctrl+F로 터미널 출력 내 검색
- **Font Size** — 터미널 글꼴 크기 조절 (+/-)
- **Export** — 터미널 출력을 TXT 파일로 내보내기
- **세션 복원** — 서버 재시작 시 터미널 세션 자동 복원
- **모바일 전용 UI** — 탭 바 + 퀵 액션 바 (Esc, Tab, ^C, ^D 등) + 스와이프 전환

### Changes (Git Diff)
- **2-Column Diff View** — 파일 사이드바 + 파일별 접기/펼치기 가능한 diff 패널
- **Syntax Highlighting** — 정규식 기반 구문 하이라이팅 (JS/TS, Python, CSS, HTML, JSON, Rust, Go, Java, Shell, YAML, SQL 등 15+ 언어)
- **Staged/Unstaged** — 컬러 인디케이터로 구분 (인디고=staged, 옐로우=unstaged)
- **Line Numbers** — old/new 라인넘버 거터
- **Stage/Unstage/Discard** — 파일 단위 Git 스테이징 관리
- **수동 커밋** — 메시지 입력 후 직접 커밋 + Push
- **AI 커밋 메시지** — Haiku가 변경사항을 분석해서 커밋 메시지 자동 생성
- **브랜치 표시** — 툴바에 현재 브랜치명과 워크트리 수 표시

### Git Operations
- **Pull/Fetch** — Changes 탭 툴바에서 Git Pull/Fetch 원클릭
- **Stash/Pop** — 작업 중 변경사항 임시 저장 및 복원
- **Stash List** — 전체 stash 목록 보기, 개별 Apply/Pop/Drop
- **Branch Create** — 드롭다운에서 새 브랜치 직접 생성
- **Branch Delete** — 사용 안하는 로컬 브랜치 삭제 (main/master 보호)

### AI Auto Commit
Claude Haiku가 \`git status\` + \`git diff\`를 분석해서 관련 파일을 논리적 커밋으로 자동 그룹핑.

**워크플로우:**
1. "AI Commit" 버튼 → Haiku가 변경사항 분석 (3~5초)
2. 커밋 플랜 표시: 커밋별 메시지 + 파일 목록 + 이유
3. 사용자가 플랜 수정:
   - 커밋 메시지 인라인 편집
   - 파일을 커밋 간 **드래그 앤 드롭**으로 이동
   - 파일을 **대기(Pending)** 영역으로 내려서 커밋에서 제외
   - **새 커밋 추가** / **커밋 삭제** (삭제 시 파일은 대기로 이동)
4. "Commit All" → 순차적으로 커밋 실행 (프로그레스 바)
5. 완료 후 "Push" 버튼으로 원격에 푸시

**안전장치:**
- \`main\`/\`master\` 브랜치에서 커밋 시 확인 다이얼로그
- 파일 없는 빈 커밋은 자동 스킵
- 커밋 실패 시 해당 카드에 에러 표시, 나머지 중단

> AI는 Claude CLI (\`claude -p --model haiku\`)를 통해 호출되므로 별도 API 키 불필요 — 기존 OAuth 인증 그대로 사용

### Jira
Atlassian Jira Cloud와 연동하여 이슈 관리. **Gemini API 키와 별개로 Jira API 토큰이 필요** (설정 방법은 상단 Configuration 참조).

- **이슈 목록** — 프로젝트/스프린트/상태/이슈타입별 필터링, 정렬, 검색
- **보드 뷰 (Kanban)** — 칼럼별 이슈 카드, 드래그 전환
- **타임라인 뷰 (Gantt)** — 스프린트/에픽 기반 간트 차트
- **이슈 상세** — 사이드 패널로 설명, 코멘트, 트랜지션, 첨부 파일 확인
- **트랜지션** — 이슈 상태 변경 (To Do → In Progress → Done)
- **스프린트 바** — 활성 스프린트 퀵 필터 칩

### CI/CD
GitHub Actions 연동. **GitHub CLI (\`gh\`) 인증 필요** (설정 방법은 상단 Configuration 참조).

- **GitHub Actions** — 워크플로우 런 목록, 상태별 필터링
- **런 상세** — 잡/스텝별 상태, 소요 시간, 실행 로그
- **Rerun** — 전체 또는 실패 잡만 재실행
- **Cancel** — 진행 중 런 취소
- **자동 폴링** — In Progress/Queued 런 자동 새로고침

### Notes
- **마크다운 노트** — 프로젝트별 메모 작성/편집
- **사이드바** — 노트 목록, 제목/날짜/프로젝트 표시
- **프로젝트 연결** — 노트를 특정 프로젝트에 태깅

### Workflows (LangGraph)
LangGraph 기반 멀티 스텝 AI 워크플로우 엔진. **Gemini API 키 필요** (설정 방법은 상단 Configuration 참조).

**엔진 특징:**
- JSON 기반 워크플로우 정의 — 스텝(LLM 호출), 엣지(분기/병렬/순환) 조합
- 조건부 순환 — fact_checker, reviewer 등이 품질 미달 시 이전 스텝 재실행 (최대 N회)
- 병렬 팬아웃/팬인 — 여러 스텝을 동시 실행 후 결과 합산
- Google Search grounding — \`tools: ["WebSearch"]\` 지정 시 Gemini가 실시간 웹 검색 결과 활용
- 실시간 진행 상황 — SSE로 스텝별 상태/결과를 실시간 스트리밍

**내장 워크플로우 (12개):**

| 워크플로우 | 설명 | 주요 패턴 |
|-----------|------|----------|
| Deep Research | 주제 심층 조사 (2명 연구자 + 팩트체커 순환) | 병렬 + 순환 |
| PRD Tech Decision | PRD 기반 기술 스택 의사결정 | 순차 |
| Tech Comparison | 기술 A vs B 비교 분석 | 병렬 |
| OSS Evaluation | 오픈소스 라이브러리 평가 | 순차 |
| ADR Generator | Architecture Decision Record 자동 생성 | 순차 |
| Tech Radar | 최신 기술 동향 스캔 (WebSearch 활용) | 순차 + WebSearch |
| Business Plan Review | 사업 계획서 다면 검토 | 병렬 |
| Vendor Comparison | SaaS/벤더 비교 분석 | 병렬 |
| Sprint Retro | 스프린트 회고 퍼실리테이션 | 순차 |
| Incident Postmortem | 장애 사후 분석 (RCA 순환) | 순환 |
| Content Repurpose | 콘텐츠 멀티 포맷 변환 | 병렬 |
| Meeting Prep | 미팅 사전 브리핑 자료 생성 | 순차 |

**스케줄링:**
- 워크플로우별 반복 실행 예약 — 매일(daily) / 매주(weekly) / 매월(monthly)
- 실행 시각, 요일/날짜 지정 가능
- 앱 꺼져있다 재시작하면 놓친 스케줄 자동 보상 실행
- 스케줄 활성/비활성 토글, SSE로 실행 결과 실시간 알림

---

## Desktop App (Tauri)

Tauri로 패키징된 네이티브 Windows 데스크탑 앱.

- **자동 서버 관리** — 앱 시작 시 Node.js 서버 자동 기동, 종료 시 정리
- **시스템 트레이** — 최소화 시 트레이로 이동, 트레이 메뉴 지원
- **Windows 토스트 알림** — 세션 상태 변경 시 WinRT 네이티브 토스트 알림
- **인스톨러** — NSIS 기반 \`Cockpit_x.x.x_x64-setup.exe\`

---

## Mobile / PWA

### LAN 접근
- 서버가 \`0.0.0.0:3847\`에 바인딩 — 같은 네트워크의 모바일에서 접근 가능
- 헤더의 **Mobile Connect** 버튼 → QR 코드 + URL 표시
- 토큰 기반 인증 (쿠키 저장, 재인증 불필요)

### PWA
- **manifest.json** — 홈 화면에 앱 설치 가능
- **Service Worker** — 정적 자산 캐싱, 오프라인 셸 지원

### 모바일 반응형
- **카드** — 768px 이하에서 세로 스택
- **터미널** — 전용 모바일 UI (탭 바 + 퀵 액션 바 + 스와이프)
- **Diff** — 사이드바 상단 접기, 테이블 폰트 축소

### Tailscale (권장)
외부 네트워크에서도 안전하게 접근하려면 Tailscale 설치 후 Tailscale IP로 접속.
WireGuard 기반 E2E 암호화, 포트 포워딩 불필요.

---

## Notifications

3단계 알림 시스템:
1. **WinRT Toast** (데스크탑) — PowerShell WinRT API로 Windows 네이티브 토스트
2. **Audio Chime** (브라우저) — Web Audio API 2-tone 차임 (880Hz → 1100Hz)
3. **Title Flash** (백그라운드 탭) — 탭 제목 깜빡임

- 프로젝트별 알림 ON/OFF 설정 (알림 버튼 우클릭)

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+1 | Overview 탭 |
| Ctrl+2 | Terminal 탭 |
| Ctrl+3 | Changes 탭 |
| Ctrl+4 | PRs 탭 |
| Ctrl+5 | Jira 탭 |
| Ctrl+6 | CI/CD 탭 |
| Ctrl+7 | Notes 탭 |
| Ctrl+8 | Workflows 탭 |
| Ctrl+9 | README 탭 |
| Ctrl+K | Command Palette |
| Ctrl+T | 새 터미널 |
| Ctrl+W | 터미널 닫기 |
| Ctrl+F | 터미널 내 검색 |
| Ctrl+J | 퀵 커맨드 바 |
| Ctrl+B | 브로드캐스트 모드 토글 |
| Ctrl+Tab | 다음 터미널 |
| Ctrl+Shift+Tab | 이전 터미널 |
| Ctrl+[ / ] | 이전/다음 터미널 |
| Alt+K / L | 터미널 3줄 위/아래 (길게 눌러 연속 이동) |
| Alt+Shift+K / L | 터미널 한 화면 위/아래 |
| F5 / Ctrl+R | Cockpit 새로고침 |
| E | Diff 전체 펼치기 |
| C | Diff 전체 접기 |
| R | Diff 새로고침 |
| ? | 단축키 도움말 |
| Escape | 오버레이 / 검색 닫기 |

---

## Architecture

\`\`\`
Browser / Tauri        Node.js Server (port 3847)
┌─────────────┐  HTTP  ┌───────────────────────────────┐
│ index.html  │◄──────►│ server.js                     │
│ style.css   │  SSE   │  ├─ lib/config.js              │
│ js/         │◄───────│  ├─ lib/claude-data.js         │
│  main.js    │  WS    │  ├─ lib/git-service.js         │
│  dashboard  │◄──────►│  ├─ lib/github-service.js      │
│  terminal   │        │  ├─ lib/cost-service.js        │
│  diff       │        │  ├─ lib/session-control.js     │
│  jira       │        │  ├─ lib/jira-service.js        │
│  cicd       │        │  ├─ lib/cicd-service.js        │
│  notes      │        │  ├─ lib/notes-service.js       │
│  workflows  │        │  ├─ lib/workflows-service.js   │
│  agent      │        │  ├─ lib/workflow-scheduler.js  │
│  highlight  │        │  ├─ lib/agent-service.js       │
│  modals     │        │  ├─ lib/notify.js              │
│  state      │        │  ├─ lib/qr.js                  │
│  utils      │        │  └─ lib/poller.js              │
│ xterm.js    │        └──────────┬─────────────────────┘
│ Chart.js    │                   │
└─────────────┘     ┌─────────────┼──────────────────┐
                    │             │                  │
                ~/.claude/    git / gh CLI     Gemini API
                (세션/비용)  (status/diff/PR)  (Agent/Workflows)
\`\`\`

- **Frontend** — ES 모듈 분리 (빌드 도구 없음)
- **Backend** — 순수 Node.js HTTP 서버 (프레임워크 없음)
- **실시간** — SSE로 폴링 데이터 push, WebSocket으로 터미널 스트리밍
- **터미널** — \`node-pty\`로 PTY 프로세스 생성, \`ws\`로 양방향 연결
- **AI** — Claude CLI (OAuth), Gemini API (API Key)
- **데스크탑** — Tauri (Rust) 래퍼, 자동 서버 관리

### Frontend Modules
| Module | 역할 |
|--------|------|
| main.js | 엔트리포인트, 초기화, 이벤트 바인딩 |
| dashboard.js | 프로젝트 카드, 사용량, 차트, 알림 |
| terminal.js | 터미널 생성/분할/탭 관리, 모바일 UI |
| diff.js | Git diff 렌더링, 스테이징, 커밋, stash |
| jira.js | Jira 이슈 목록/보드/타임라인 |
| cicd.js | CI/CD 런 목록/상세/리런 |
| notes.js | 마크다운 노트 CRUD |
| workflows.js | LangGraph 워크플로우 정의/실행/스케줄링 |
| agent.js | Gemini 채팅, 음성입력, TTS, 도구 실행 |
| highlight.js | 정규식 기반 구문 하이라이팅 |
| modals.js | 다이얼로그, 커맨드 팔레트, 설정 |
| state.js | 전역 상태, localStorage 연동 |
| utils.js | 공통 유틸리티 함수 |

### Tech Stack
- \`xterm.js\` (WebGL) — 터미널 렌더링
- \`Chart.js\` — 사용량 차트
- \`node-pty\` — 서버사이드 PTY
- \`ws\` — WebSocket
- \`Tauri\` — 데스크탑 앱 (Rust)
- \`@langchain/google-genai\` — Gemini LLM (Workflows 엔진)

### Data Files
| 파일 | 내용 | 암호화 |
|------|------|--------|
| \`projects.json\` | 프로젝트 목록 | - |
| \`jira-config.json\` | Jira URL, email, API token | token AES-256-GCM |
| \`ai-config.json\` | Gemini API key | key AES-256-GCM |
| \`.encryption-key\` | 토큰 암호화 마스터 키 (랜덤 32B) | - |
| \`cost-cache.json\` | API 비용 캐시 | - |
| \`agent-history.json\` | 에이전트 대화 이력 | - |
| \`workflow-runs.json\` | 워크플로우 실행 기록 | - |
| \`workflow-schedules.json\` | 워크플로우 스케줄 설정 | - |
| \`notes/*.md\` | 마크다운 노트 | - |
| \`workflows/*.json\` | 워크플로우 정의 | - |

---

## API Endpoints

### 프로젝트
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/projects | 프로젝트 목록 |
| POST | /api/projects | 프로젝트 추가 |
| PUT | /api/projects/:id | 프로젝트 수정 |
| DELETE | /api/projects/:id | 프로젝트 삭제 |

### 모니터링
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/events | SSE 실시간 스트림 |
| GET | /api/projects/:id/git | Git 상태 |
| GET | /api/projects/:id/prs | PR 목록 |
| GET | /api/projects/:id/branches | 브랜치/워크트리 |
| GET | /api/usage | 사용량 요약 |
| GET | /api/cost/daily | 일별 비용 |
| GET | /api/activity | 최근 활동 |

### Git 작업
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/projects/:id/diff | Staged + Unstaged diff |
| POST | /api/projects/:id/git/stage | 파일 스테이징 |
| POST | /api/projects/:id/git/unstage | 스테이징 해제 |
| POST | /api/projects/:id/git/discard | 변경사항 버리기 |
| POST | /api/projects/:id/git/commit | 수동 커밋 |
| POST | /api/projects/:id/git/checkout | 브랜치 전환 |
| POST | /api/projects/:id/git/create-branch | 새 브랜치 |
| POST | /api/projects/:id/git/delete-branch | 브랜치 삭제 |
| POST | /api/projects/:id/git/stash | 변경사항 스태시 |
| POST | /api/projects/:id/git/stash-pop | 스태시 복원 |
| POST | /api/projects/:id/git/stash-apply | 스태시 적용 (유지) |
| POST | /api/projects/:id/git/stash-drop | 스태시 삭제 |
| GET | /api/projects/:id/stash-list | 스태시 목록 |
| POST | /api/projects/:id/push | git push |
| POST | /api/projects/:id/pull | git pull |
| POST | /api/projects/:id/fetch | git fetch --all |

### AI Auto Commit
| Method | Path | 설명 |
|--------|------|------|
| POST | /api/projects/:id/auto-commit/plan | Haiku 커밋 플랜 생성 |
| POST | /api/projects/:id/auto-commit/execute | 단일 커밋 실행 |
| POST | /api/projects/:id/auto-commit/gen-msg | AI 커밋 메시지 생성 |

### Dev Server
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/dev-servers | 실행 중인 서버 |
| POST | /api/projects/:id/dev-server/start | 서버 시작 |
| POST | /api/projects/:id/dev-server/stop | 서버 중지 |

### Jira
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/jira/config | 연결 설정 (토큰 마스킹) |
| POST | /api/jira/config | 설정 저장 (토큰 암호화) |
| POST | /api/jira/test | 연결 테스트 |
| GET | /api/jira/projects | Jira 프로젝트 목록 |
| GET | /api/jira/issues | 이슈 목록 (필터 지원) |
| GET | /api/jira/sprints | 스프린트 목록 |
| GET | /api/jira/boards | 보드 목록 |
| GET | /api/jira/issues/:key | 이슈 상세 |
| POST | /api/jira/issues/:key/transition | 이슈 상태 변경 |
| POST | /api/jira/issues/:key/comment | 코멘트 추가 |
| GET | /api/jira/image-proxy | 첨부 이미지 프록시 |

### CI/CD
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/cicd/runs/:projectId | 워크플로우 런 목록 |
| GET | /api/cicd/runs/:projectId/:runId | 런 상세 |
| GET | /api/cicd/runs/:projectId/:runId/jobs | 잡 목록 |
| GET | /api/cicd/runs/:projectId/:runId/logs | 실행 로그 |
| POST | /api/cicd/runs/:projectId/:runId/rerun | 재실행 |
| POST | /api/cicd/runs/:projectId/:runId/cancel | 취소 |
| GET | /api/cicd/workflows/:projectId | 워크플로우 정의 목록 |

### Notes
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/notes | 노트 목록 |
| GET | /api/notes/:id | 노트 상세 |
| POST | /api/notes | 노트 생성 |
| PUT | /api/notes/:id | 노트 수정 |
| DELETE | /api/notes/:id | 노트 삭제 |

### Workflows (LangGraph)
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/workflows | 워크플로우 정의 목록 |
| GET | /api/workflows/schedules | 스케줄 목록 |
| POST | /api/workflows/schedules | 스케줄 추가 |
| PUT | /api/workflows/schedules/:id | 스케줄 수정 |
| DELETE | /api/workflows/schedules/:id | 스케줄 삭제 |
| GET | /api/workflows/:id | 워크플로우 상세 |
| POST | /api/workflows/run | 워크플로우 실행 |
| GET | /api/workflows/runs | 런 히스토리 |
| GET | /api/workflows/runs/:id | 런 상세 |
| POST | /api/workflows/runs/:id/stop | 런 중지 |
`;

// README state
let _rmSections = [];
let _rmActiveSection = 0;

function renderReadme() {
  const mainEl = document.getElementById('readme-content');
  const sidebarEl = document.getElementById('rm-sidebar');
  const tocEl = document.getElementById('rm-toc');
  if (!mainEl) return;

  // 1. Parse markdown into sections (split by ## headings)
  const lines = README_CONTENT.split('\n');
  _rmSections = [];
  let current = { title: '', id: '', lines: [], md: '' };
  for (const line of lines) {
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      if (current.title || current.lines.length) _rmSections.push(current);
      const id = 'rm-' + h2[1].toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/-+$/, '');
      current = { title: h2[1], id, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.title || current.lines.length) _rmSections.push(current);

  // Build markdown per section
  for (const sec of _rmSections) {
    sec.md = (sec.title ? `## ${sec.title}\n` : '') + sec.lines.join('\n');
  }

  // 2. Left sidebar — page navigation
  if (sidebarEl) {
    let navHtml = '<div class="rm-sidebar-title">Cockpit</div><div class="rm-nav">';
    _rmSections.forEach((sec, i) => {
      if (!sec.title) return;
      const icon = _rmSectionIcon(sec.title);
      navHtml += `<div class="rm-nav-section">
        <a class="rm-nav-item${i === _rmActiveSection ? ' active' : ''}" data-page="${i}">${icon}<span>${esc(sec.title)}</span></a>
      </div>`;
    });
    navHtml += '</div>';
    sidebarEl.innerHTML = navHtml;

    sidebarEl.addEventListener('click', e => {
      const link = e.target.closest('a[data-page]');
      if (!link) return;
      e.preventDefault();
      _rmShowPage(parseInt(link.dataset.page));
    });
  }

  // 3. Render first page
  _rmShowPage(_rmActiveSection);

  // 4. Scroll spy for right TOC
  mainEl.addEventListener('scroll', () => {
    if (!tocEl) return;
    const article = mainEl.querySelector('.rm-article');
    if (!article) return;
    const headings = [...article.querySelectorAll('h3, h4')];
    let activeId = '';
    for (const h of headings) {
      if (h.getBoundingClientRect().top < 140) activeId = h.id;
    }
    if (activeId) {
      tocEl.querySelectorAll('.rm-toc-link').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + activeId));
    }
  });
}

function _rmShowPage(idx) {
  const mainEl = document.getElementById('readme-content');
  const sidebarEl = document.getElementById('rm-sidebar');
  const tocEl = document.getElementById('rm-toc');
  if (!mainEl || idx < 0 || idx >= _rmSections.length) return;

  _rmActiveSection = idx;
  const sec = _rmSections[idx];

  // Update sidebar active
  if (sidebarEl) {
    sidebarEl.querySelectorAll('.rm-nav-item').forEach(a => a.classList.toggle('active', parseInt(a.dataset.page) === idx));
  }

  // Render main content (single section)
  mainEl.innerHTML = `<article class="rm-article">${simpleMarkdown(sec.md)}</article>`;
  mainEl.scrollTop = 0;

  // Inject IDs into headings
  const article = mainEl.querySelector('.rm-article');
  if (article) {
    article.querySelectorAll('h2, h3, h4').forEach(h => {
      h.id = 'rm-' + h.textContent.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/-+$/, '');
    });
  }

  // Update right TOC with h3/h4 from current page
  if (tocEl && article) {
    const headings = [...article.querySelectorAll('h3, h4')];
    if (headings.length > 0) {
      let tocHtml = '<div class="rm-toc-title">On this page</div><ul class="rm-toc-list">';
      for (const h of headings) {
        const level = h.tagName === 'H4' ? 4 : 3;
        tocHtml += `<li class="rm-toc-item rm-toc-l${level}"><a class="rm-toc-link" href="#${h.id}">${esc(h.textContent)}</a></li>`;
      }
      tocHtml += '</ul>';
      tocEl.innerHTML = tocHtml;
      tocEl.style.display = '';

      tocEl.querySelectorAll('.rm-toc-link').forEach(link => {
        link.addEventListener('click', e => {
          e.preventDefault();
          const target = document.getElementById(link.getAttribute('href').slice(1));
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    } else {
      tocEl.innerHTML = '';
      tocEl.style.display = 'none';
    }
  }

  // Prev/Next navigation at bottom
  if (article) {
    const nav = document.createElement('div');
    nav.className = 'rm-page-nav';
    const prev = idx > 0 ? _rmSections[idx - 1] : null;
    const next = idx < _rmSections.length - 1 ? _rmSections[idx + 1] : null;
    nav.innerHTML = `
      ${prev ? `<a class="rm-page-link rm-page-prev" data-page="${idx - 1}"><span class="rm-page-dir">← Previous</span><span class="rm-page-label">${esc(prev.title)}</span></a>` : '<span></span>'}
      ${next ? `<a class="rm-page-link rm-page-next" data-page="${idx + 1}"><span class="rm-page-dir">Next →</span><span class="rm-page-label">${esc(next.title)}</span></a>` : '<span></span>'}
    `;
    nav.addEventListener('click', e => {
      const link = e.target.closest('a[data-page]');
      if (link) { e.preventDefault(); _rmShowPage(parseInt(link.dataset.page)); }
    });
    article.appendChild(nav);
  }
}

function _rmSectionIcon(title) {
  const t = title.toLowerCase();
  if (t.includes('feature')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
  if (t.includes('desktop') || t.includes('tauri')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
  if (t.includes('mobile') || t.includes('pwa')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
  if (t.includes('notification')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>';
  if (t.includes('keyboard') || t.includes('shortcut')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6.01" y2="8"/><line x1="10" y1="8" x2="10.01" y2="8"/><line x1="14" y1="8" x2="14.01" y2="8"/><line x1="18" y1="8" x2="18.01" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="18" y1="16" x2="18.01" y2="16"/></svg>';
  if (t.includes('architecture') || t.includes('arch')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
  if (t.includes('api') || t.includes('endpoint')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>';
  if (t.includes('setup') || t.includes('설치')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  if (t.includes('config') || t.includes('api 키') || t.includes('설정')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><circle cx="12" cy="16" r="1"/></svg>';
  if (t.includes('data')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

// ─── Cross-module pub/sub wiring (replaces window.xxx globals) ───
async function hardRefresh() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations();
    if (regs) for (const r of regs) await r.unregister();
    const keys = await caches?.keys();
    if (keys) for (const k of keys) await caches.delete(k);
  } catch { /* cache API unavailable */ }
  location.reload(true);
}

// Dashboard
subscribe('switchView', (name) => switchView(name));
subscribe('renderCard', (id) => renderCard(id));
subscribe('renderAllCards', (list) => renderAllCards(list));
subscribe('showConvList', () => showConvList());
subscribe('toggleTheme', () => toggleTheme());
subscribe('setProjectFilter', (filter) => setProjectFilter(filter));
subscribe('setProjectTag', ({ id, tag }) => setProjectTag(id, tag));
subscribe('fetchAllProjects', () => fetchAllProjects());
subscribe('pullAllProjects', () => pullAllProjects());
subscribe('updateSummaryStats', () => updateSummaryStats());

// Terminal
subscribe('renderLayout', () => renderLayout());
subscribe('saveLayout', () => saveLayout());
subscribe('fitAllTerminals', () => fitAllTerminals());
subscribe('updateTermHeaders', () => updateTermHeaders());
subscribe('debouncedUpdateTermHeaders', () => debouncedUpdateTermHeaders());
subscribe('openNewTermModal', () => openNewTermModal());
subscribe('openTermWith', (opts) => openTermWith(opts));
subscribe('exportTerminal', () => exportTerminal());
subscribe('loadBranchesForTerm', () => loadBranchesForTerm());
subscribe('updateTermTheme', () => updateTermTheme());

// Diff
subscribe('loadDiff', () => loadDiff());
subscribe('debouncedLoadDiff', () => debouncedLoadDiff());
subscribe('renderProjectChips', () => renderProjectChips());

// Modals
subscribe('populateProjectSelects', () => populateProjectSelects());
subscribe('updateDevBadge', () => updateDevBadge());
subscribe('renderNotifFilterList', () => renderNotifFilterList());
subscribe('editProject', (id) => editProject(id));
subscribe('resumeLastSession', (id) => resumeLastSession(id));
subscribe('toggleDevServer', (id) => toggleDevServer(id));
subscribe('promptDevCmd', (id) => promptDevCmd(id));
subscribe('openIDE', ({ id, ide }) => openIDE(id, ide));
subscribe('openGitHub', (id) => openGitHub(id));
subscribe('showSessionHistory', (id) => showSessionHistory(id));
subscribe('showGitLog', (id) => showGitLog(id));

// File preview
subscribe('openFilePreview', (pathOrTerm) => openFilePreview(pathOrTerm));
subscribe('openFilePreviewFromFile', (file) => openFilePreviewFromFile(file));

subscribe('toggleCommandPalette', () => toggleCommandPalette());

// Workflows
subscribe('handleWorkflowEvent', ({ event, data }) => handleWorkflowEvent(event, data));

// Lazy init
subscribe('initCicd', () => initCicd());
subscribe('initPR', () => initPR());
subscribe('initWorkflows', () => initWorkflows());
subscribe('initPorts', () => initPorts());
subscribe('initNotes', () => initNotes());
subscribe('initAutopilotView', () => initAutopilotView());
subscribe('initAiAccounts', () => initAiAccounts());
subscribe('aiAccountsChanged', () => initAiAccounts());
subscribe('destroyPorts', () => destroyPorts());

async function showMobileConnect() {
  const dlg = document.getElementById('mobile-connect-dialog');
  if (!dlg) return;
  try {
    const info = await fetchJson('/api/lan-info');
    if (!info.ips?.length) {
      document.getElementById('mobile-connect-url').textContent = 'No network interface found';
      dlg.showModal();
      return;
    }
    // Prefer Tailscale (works anywhere), fallback to LAN
    const primary = info.ips[0]; // already sorted: tailscale first
    const url = `http://${primary.ip}:${info.port}?token=${info.token}`;
    const label = primary.type === 'tailscale' ? 'Tailscale (anywhere)' : 'LAN (same WiFi)';

    const urlEl = document.getElementById('mobile-connect-url');
    urlEl.textContent = url;

    // Show all available networks
    const body = dlg.querySelector('.mobile-connect-body');
    let infoHtml = `<div class="mobile-connect-nets">`;
    for (const { ip, type } of info.ips) {
      const badge = type === 'tailscale' ? 'Tailscale' : 'LAN';
      infoHtml += `<span class="net-badge net-${type}">${badge}: ${ip}</span>`;
    }
    infoHtml += `</div>`;
    const existing = body.querySelector('.mobile-connect-nets');
    if (existing) existing.remove();
    body.querySelector('.mobile-connect-desc').insertAdjacentHTML('afterend', infoHtml);

    dlg.querySelector('.mobile-connect-desc').textContent =
      `Scan QR or copy URL — ${label}`;

    // Fetch QR SVG and inject directly
    const qrContainer = document.getElementById('qr-container');
    try {
      const svgText = await fetchText(`/api/qr-code?data=${encodeURIComponent(url)}`);
      qrContainer.innerHTML = svgText;
      // Force SVG to fit container
      const svgEl = qrContainer.querySelector('svg');
      if (svgEl) { svgEl.style.width = '100%'; svgEl.style.height = '100%'; }
    } catch { qrContainer.textContent = 'QR generation failed'; }
    dlg.showModal();
  } catch {
    showToast('Failed to get LAN info');
  }
}

function copyMobileUrl() {
  const el = document.getElementById('mobile-connect-url');
  if (!el) return;
  copyText(el.textContent).then((ok) => showToast(ok ? 'Copied!' : 'Copy failed', ok ? 'success' : 'error'));
}


// ─── Register main.js-local actions ───
registerClickActions({
  'show-mobile-connect': showMobileConnect,
  'copy-mobile-url': copyMobileUrl,
  'hard-refresh': hardRefresh,
  // ⚔️ Arena
  'arena-open': openArenaDialog,
  'arena-pick': startArenaPick,
  'arena-pick-done': arenaPickDone,
  'arena-start': startArenaFromDialog,
  'arena-stop': stopArena,
  'arena-copy-result': copyArenaResult,
  'arena-download-result': downloadArenaResult,
  // Ports
  'port-refresh': refreshPorts,
  'port-toggle-pause': togglePortPause,
});
registerInputActions({
  'port-search': (el) => filterPortSearch(el.value),
});
registerChangeActions({
  'port-filter-dev': (el) => toggleDevFilter(el.checked),
});

// ─── Global Event Delegation (registry-based) ───
document.addEventListener('click', e => {
  // 모달 backdrop 클릭 = 바깥 클릭 닫기 — 걸린 dialog를 마우스만으로 복구
  if (e.target.tagName === 'DIALOG' && e.target.open && !e.target.hasAttribute('data-persistent')) {
    try { e.target.close(); } catch { /* non-modal */ }
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = getClickAction(el.dataset.action);
  if (handler) {
    try { handler(el, e); }
    catch (err) { console.error('[Action]', el.dataset.action, err); }
  }
});
document.addEventListener('change', e => {
  const a = e.target.dataset.action;
  if (!a) return;
  const handler = getChangeAction(a);
  if (handler) handler(e.target, e);
});
document.addEventListener('input', e => {
  const a = e.target.dataset.action;
  if (!a) return;
  const handler = getInputAction(a);
  if (handler) handler(e.target, e);
});
document.addEventListener('keydown', e => {
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return;
  const a = e.target.dataset.action;
  if (a === 'term-search-input') {
    if (e.key === 'Enter') { doTermSearch(e.shiftKey ? 'prev' : 'next'); e.preventDefault(); }
    if (e.key === 'Escape') closeTermSearch();
  }
  if (a === 'commit-msg-input' && e.ctrlKey && e.key === 'Enter') { e.preventDefault(); doManualCommit(); }
}, true);
document.addEventListener('contextmenu', e => {
  const el = e.target.closest('[data-contextaction]');
  if (!el) return;
  e.preventDefault();
  const a = el.dataset.contextaction;
  if (a === 'open-notif-settings') openNotifSettings();
});

// ─── Keyboard Shortcuts ───
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'F5' || (mod && e.code === 'KeyR' && !e.altKey)) { e.preventDefault(); location.reload(); return; }
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return;
  // Esc 탈출구: 입력창 밖에서 누르면 열린 모달을 전부 닫아 걸린 UI를 즉시 복구
  if (e.key === 'Escape'
    && !e.target.closest?.('.xterm')
    && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
    const open = document.querySelectorAll('dialog[open]');
    if (open.length) open.forEach(d => { try { d.close(); } catch { /* non-modal */ } });
  }
  if (mod && e.key === '1') { e.preventDefault(); switchView('dashboard'); return; }
  if (mod && e.key === '2') { e.preventDefault(); switchView('terminal'); return; }
  if (mod && e.key === '3') { e.preventDefault(); switchView('diff'); return; }
  if (mod && e.key === '4') { e.preventDefault(); switchView('pr'); return; }
  if (mod && e.key === '5') { e.preventDefault(); switchView('jira'); return; }
  if (mod && e.key === '6') { e.preventDefault(); switchView('cicd'); return; }
  if (mod && e.key === '7') { e.preventDefault(); switchView('notes'); return; }
  if (mod && e.key === '8') { e.preventDefault(); switchView('workflows'); return; }
  if (mod && e.key === '9') { e.preventDefault(); switchView('readme'); return; }
  if (mod && e.key === 'Tab') {
    if (document.getElementById('terminal-view').classList.contains('active') && app.termMap.size > 1) {
      e.preventDefault();
      const ids = getOrderedTerminalIds();
      const cur = ids.indexOf(app.activeTermId);
      const next = e.shiftKey ? (cur <= 0 ? ids.length - 1 : cur - 1) : (cur >= ids.length - 1 ? 0 : cur + 1);
      mobileSwitchTerm(ids[next]);
      return;
    }
  }
  if (mod && (e.key === '[' || e.key === ']')) {
    if (document.getElementById('terminal-view').classList.contains('active') && app.termMap.size > 1) {
      e.preventDefault();
      const ids = getOrderedTerminalIds();
      const cur = ids.indexOf(app.activeTermId);
      const next = e.key === '[' ? (cur <= 0 ? ids.length - 1 : cur - 1) : (cur >= ids.length - 1 ? 0 : cur + 1);
      mobileSwitchTerm(ids[next]);
      return;
    }
  }
  if (mod && e.key === 't' && !e.shiftKey) {
    if (document.getElementById('terminal-view').classList.contains('active')) { e.preventDefault(); openNewTermModal(); return; }
  }
  if (mod && (e.key === 't' || e.key === 'T') && e.shiftKey) {
    e.preventDefault(); openHomeTerminal(); return;
  }
  if (mod && e.key === 'w' && !e.shiftKey) {
    if (document.getElementById('terminal-view').classList.contains('active') && app.activeTermId) { e.preventDefault(); requestCloseTerminal(app.activeTermId); return; }
  }
  if (mod && e.key === 'r' && !e.shiftKey) {
    if (document.getElementById('terminal-view').classList.contains('active') && app.activeTermId) { e.preventDefault(); toggleCmdPalette(); return; }
  }
  if (mod && e.key === 'b' && !e.shiftKey) {
    if (document.getElementById('terminal-view').classList.contains('active')) { e.preventDefault(); toggleBroadcastMode(); return; }
  }
  if (mod && (e.code === 'KeyJ' || e.key === 'j') && !e.shiftKey) {
    // 터미널 포커스 중엔 terminal.js 커스텀 키 핸들러가 이미 토글함 — 여기서 또 하면 이중 토글로 무효화됨
    if (e.target?.closest?.('.xterm')) return;
    if (document.getElementById('terminal-view').classList.contains('active')) { e.preventDefault(); toggleQuickBar(); return; }
  }
  if (mod && e.key === 'k') { e.preventDefault(); toggleCommandPalette(); return; }
  if (mod && e.shiftKey && e.key === 'P') { e.preventDefault(); toggleCommandPalette(); return; }
  if (mod && e.key === 'f') {
    if (document.getElementById('terminal-view').classList.contains('active') && app.activeTermId) { e.preventDefault(); toggleTermSearch(); return; }
  }
  if (mod && e.shiftKey && (e.key === '\\' || e.code === 'Backslash')) {
    if (document.getElementById('terminal-view').classList.contains('active') && app.activeTermId) { e.preventDefault(); openNewTermModalWithSplit(app.activeTermId, 'right'); return; }
  }
  if (mod && e.shiftKey && (e.key === '-' || e.code === 'Minus')) {
    if (document.getElementById('terminal-view').classList.contains('active') && app.activeTermId) { e.preventDefault(); openNewTermModalWithSplit(app.activeTermId, 'bottom'); return; }
  }
  if (mod && !e.shiftKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    if (document.getElementById('terminal-view').classList.contains('active')) changeTermFontSize(1);
    else changeViewZoom(10);
    return;
  }
  if (mod && !e.shiftKey && e.key === '-') {
    e.preventDefault();
    if (document.getElementById('terminal-view').classList.contains('active')) changeTermFontSize(-1);
    else changeViewZoom(-10);
    return;
  }
  if (mod && !e.shiftKey && e.key === '0') {
    e.preventDefault();
    if (document.getElementById('terminal-view').classList.contains('active')) resetTermFontSize();
    else resetViewZoom();
    return;
  }
  if (mod && e.key === 'Enter') {
    if (document.getElementById('diff-view').classList.contains('active')) {
      e.preventDefault();
      const msg = document.getElementById('diff-commit-msg')?.value?.trim();
      if (msg) doManualCommit(); else document.getElementById('diff-commit-msg')?.focus();
      return;
    }
  }
  if (e.key === 'r' && !mod && !e.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    if (document.getElementById('diff-view').classList.contains('active')) { e.preventDefault(); loadDiff(); return; }
    if (document.getElementById('cicd-view').classList.contains('active')) { e.preventDefault(); loadCicdRuns(); return; }
    if (document.getElementById('workflows-view').classList.contains('active')) { e.preventDefault(); loadWorkflowDefs(); loadWorkflowRuns(); return; }
  }
  if (!mod && !e.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    if (document.getElementById('diff-view').classList.contains('active')) {
      if (e.key === 'e') { e.preventDefault(); diffExpandAll(); return; }
      if (e.key === 'c') { e.preventDefault(); diffCollapseAll(); return; }
    }
  }
  if (e.key === '/' && !mod && !e.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    if (document.getElementById('dashboard-view')?.classList.contains('active')) {
      e.preventDefault(); const si = document.getElementById('project-search'); if (si) si.focus(); return;
    }
  }
  if (e.key === '?' && !mod && !e.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    e.preventDefault(); showShortcutHelp(); return;
  }
  if (e.key === 'Escape') {
    const nm = document.getElementById('nav-more-menu');
    if (nm?.classList.contains('open')) { nm.classList.remove('open'); return; }
    const cp = document.getElementById('cmd-palette');
    if (cp && !cp.classList.contains('hidden')) { closeCommandPalette(); return; }
    const cv = document.getElementById('conv-overlay');
    if (cv && !cv.classList.contains('hidden')) { closeConvList(); return; }
    const fp = document.getElementById('file-preview-overlay');
    if (fp && !fp.classList.contains('hidden')) { closeFilePreview(); return; }
    const so = document.getElementById('shortcut-overlay');
    if (so && !so.classList.contains('hidden')) { hideShortcutHelp(); return; }
    const cd = document.getElementById('cicd-detail');
    if (cd?.classList.contains('open')) { closeCicdDetail(); return; }
    const sb = document.getElementById('term-search-bar');
    if (sb?.classList.contains('open')) { closeTermSearch(); return; }
  }
});

// ─── OS Theme Change Listener ───
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
  if (!app._themeManual) applyTheme(e.matches ? 'light' : 'dark');
});

// ─── Visibility Change (adaptive polling) ───
document.addEventListener('visibilitychange', onVisibilityChange);

// ─── Commit Message Persistence ───
const _commitMsgKey = 'cockpit-commit-msg';
const _commitMsgObserver = new MutationObserver(() => {
  const el = document.getElementById('commit-msg-input');
  if (el && !el.dataset.persisted) {
    el.dataset.persisted = '1';
    const saved = localStorage.getItem(_commitMsgKey);
    if (saved && !el.value) el.value = saved;
    el.addEventListener('input', () => {
      if (el.value.trim()) localStorage.setItem(_commitMsgKey, el.value);
    });
    _commitMsgObserver.disconnect();
  }
});
_commitMsgObserver.observe(document.body, { childList: true, subtree: true });

// ─── Usage Timestamp Timer ───
setInterval(updateUsageTimestamp, 15000);

// ─── Error Log Capture ───
setupErrorLogCapture();

// ─── Context Menu Listeners ───
setupCtxMenuListeners();

// ─── Init ───
async function init() {
  applyTheme(app.currentTheme);
  renderSkeletons(6);
  window.addEventListener('resize', setupNavOverflow);
  setupNavOverflow();
  try { app.projectList = await fetchJson('/api/projects'); } catch (e) {
    const msg = e.status ? `Server error ${e.status}` : 'Server unreachable — check if Cockpit server is running on port 3847';
    document.querySelector('.projects-grid').innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-2)">${msg}</div>`;
    return;
  }
  if (app.pinnedProjects.size > 0) {
    app.projectList.sort((a, b) => {
      const ap = app.pinnedProjects.has(a.id) ? 0 : 1;
      const bp = app.pinnedProjects.has(b.id) ? 0 : 1;
      return ap - bp;
    });
  }
  renderAllCards(app.projectList);
  app.projectList.forEach(p => {
    app.state.projects.set(p.id, { session: p.session, git: p.git, prs: p.prs });
    renderCard(p.id);
  });
  populateProjectSelects();
  renderProjectChips();
  renderTagFilters();
  updateSummaryStats();
  try { await fetchJson('/api/stats'); } catch { /* request failed */ }
  // (SSE/WS moved to top-level — must connect even if project fetch fails)
  startClock();
  renderReadme();
  // Scroll indicators
  const pgrid = document.getElementById('project-grid');
  if (pgrid) pgrid.addEventListener('scroll', updateScrollIndicators);
  window.addEventListener('resize', updateScrollIndicators);
  updateScrollIndicators();
  setupNavOverflow();
  updateEmptyProjectState();
  // Restore notify toggle state
  const nb = document.getElementById('notify-toggle');
  if (nb) {
    nb.textContent = app.notifyEnabled ? 'On' : 'Off';
    nb.className = 'btn' + (app.notifyEnabled ? '' : ' off-btn');
  }
  postJson('/api/notify/toggle', { enabled: app.notifyEnabled }).catch(() => {});
  // Restore chart period
  if (app.chartPeriod !== 30) setChartPeriod(app.chartPeriod);
  // Restore card sort
  const sortSel = document.getElementById('card-sort-select');
  if (sortSel) sortSel.value = app._cardSortBy || 'name';
  // Restore terminal font size display
  const fse = document.getElementById('term-font-size');
  if (fse) fse.textContent = app.termFontSize;
  // Terminal is the primary workspace. Secondary views remain one action away.
  switchView('terminal');
  // File drop
  initFileDrop();
  // (moved to top-level module scope — no server data dependency)
  // Usage polling
  app.usageTimer = setInterval(fetchUsage, 60000);
  // Defer non-critical init tasks to idle time
  const _idle = (fn) => (typeof requestIdleCallback === 'function')
    ? requestIdleCallback(() => fn(), { timeout: 5000 })
    : setTimeout(fn, 300);
  // Morning briefing & smart alerts: non-critical, defer to idle
  _idle(() => { loadBriefing(); checkSmartAlerts(); });
  setInterval(checkSmartAlerts, 120000); // check every 2 min
}

// ─── Must run even if init() fails ───
// 전역 에러 수집 — 처리 안 된 Promise 거부/스크립트 에러가 콘솔에만 묻히지 않게.
// 토스트는 도배 방지로 최소 간격을 두고, 상세는 항상 콘솔에 남긴다.
const _globalErrorToastAt = { last: 0 };
function reportGlobalError(kind, detail) {
  console.error(`[global:${kind}]`, detail);
  const now = Date.now();
  if (now - _globalErrorToastAt.last < 10_000) return;
  _globalErrorToastAt.last = now;
  const message = kind === 'unhandledrejection'
    ? '비동기 작업 실패 — 콘솔 로그 확인'
    : '스크립트 오류 발생 — 콘솔 로그 확인';
  showToast(message, 'error', 4000);
}
window.addEventListener('error', e => reportGlobalError('error', e.error || e.message));
window.addEventListener('unhandledrejection', e => reportGlobalError('unhandledrejection', e.reason));

connectSSE();
connectWS();
setupCommandPaletteListeners();
setupTermEventDelegation();
setupMobileActions();
setupMobileSwipe();

init();

// ─── Service Worker Registration (deferred to idle) ───
if ('serviceWorker' in navigator) {
  const _swReg = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
  (typeof requestIdleCallback === 'function') ? requestIdleCallback(_swReg) : setTimeout(_swReg, 1000);
}
