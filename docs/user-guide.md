# Cockpit 기능·운영 가이드

[프로젝트 소개로 돌아가기](../README.md)

## 주요 기능

### Overview
- **프로젝트 카드** — 세션 상태(active/idle/none), 브랜치, 모델, uncommitted, 최근 커밋, PR 상태를 SSE로 실시간 표시
- **Cost & Usage** — 오늘/이번 주/전체 토큰 사용량, 모델별 비용 추정, Chart.js 차트
- **Dev Server** — 프로젝트별 개발 서버 시작/중지, stdout에서 포트 자동 감지
- **IDE 연동** — VS Code, Cursor, Windsurf, Antigravity, Zed 원클릭 실행
- **검색 & 필터** — 이름/스택/상태(All/Active/Idle) 필터링
- **카드 정렬** — 이름순, 활성도순, 최근활동순, 미커밋순 (드롭다운, localStorage 저장)
- **프로젝트 핀** — 별표로 즐겨찾기, 핀된 프로젝트 앞 정렬

### Terminal
- **Multi-terminal** — 여러 프로젝트의 터미널을 탭으로 관리, 가로/세로 분할, 2x2 그리드 재배치
- **렌더러 선택** — 캔버스 화면은 기본 렌더러를 사용. 일반 화면에서는 `dl-term-webgl=1`로 WebGL을 선택할 수 있고, 컨텍스트 손실 시 폴백
- **세션 복원** — Unix에서 tmux를 사용할 수 있으면 서버 재시작 후 기존 셸에 재접속. tmux가 없거나 Windows 네이티브에서는 메타데이터로 새 셸을 생성. 그룹·분할 레이아웃은 브라우저 localStorage에 저장. [설계와 검증 범위](case-session-restore.md)
- **빈 터미널** — 프로젝트에 묶이지 않는 홈 디렉터리 터미널 (`Ctrl+Shift+T`)
- **Tab Bar** — 빠른 전환, 가운데 클릭으로 닫기, 드래그로 순서 변경
- **Branch/Worktree Picker** — 터미널 생성 시 브랜치나 worktree 경로 선택
- **Search / Export / Font Size** — Ctrl+F 터미널 내 검색, TXT 내보내기, 글꼴 크기 조절
- **모바일 UI** — 탭 바 + 퀵 액션 바(Esc, Tab, ^C, ^D 등) + 스와이프 전환

### Agent Wall — 에이전트 관제
터미널에서 구동 중인 에이전트 세션을 자동 감지·분류하는 관제 패널.

- **멀티 에이전트 감지** — Claude / Codex / OpenCode를 명령어·화면 출력에서 자동 식별
- **상태 분류** — busy(작업 중) / waiting(승인 대기) / idle / done
- **Release Gate** — uncommitted 변경, 현재 커밋의 CI 결과, PR draft 여부를 종합해 READY / HOLD / CHECKING / NO EVIDENCE 판정. HOLD 사유와 이동할 탭(Changes·CI/CD·PR)을 함께 표시
- **그리드/리스트 모드, dock·팝아웃** — Terminal 탭에 도킹하거나 별도 창으로 분리


### Changes
- **2-Column Diff View** — 파일 사이드바 + 파일별 접기/펼치기, old/new 라인넘버 거터
- **Syntax Highlighting** — 정규식 기반 구문 하이라이팅 (JS/TS, Python, CSS, HTML, JSON, Rust, Go, Java, Shell 등 15+ 언어)
- **Stage/Unstage/Discard** — 파일 단위 Git 스테이징 관리 (인디고=staged, 옐로우=unstaged 인디케이터)
- **수동 커밋** — 메시지 입력 후 직접 커밋 + Push
- **Git Operations** — Pull, Fetch, Stash, Stash Pop/List, Branch Create/Delete

### AI Auto Commit
Claude Haiku가 `git status` + `git diff`를 분석해서 관련 파일을 논리적 커밋으로 자동 그룹핑.

1. "AI Commit" 버튼 → Haiku가 변경사항 분석 (응답 시간은 변경량과 CLI 서비스 상태에 따라 다름)
2. 커밋 플랜: 커밋별 메시지 + 파일 목록 + 이유
3. 사용자가 수정: 메시지 편집, 파일 드래그 앤 드롭, 커밋 추가/삭제
4. "Commit All" → 순차 실행 (프로그레스 바)
5. "Push" 버튼으로 원격 푸시

> AI는 `claude -p --model haiku` CLI로 호출 — 별도 API 키 불필요, OAuth 인증 활용

### PR
- **GitHub PR 목록** — 프로젝트별 열린 PR, 리뷰 상태, draft 여부
- Agent Wall의 Release Gate와 연동 (draft PR이면 HOLD)

### CI/CD
- **GitHub Actions** — 파이프라인 상태 모니터링
- **워크플로우 실행/중지** — 직접 트리거

### Workflows
- **커스텀 자동화** — JSON 기반 워크플로우 정의, LangGraph 기반 실행 엔진
- **스케줄링** — 예약 실행
- **실행 이력** — 상세 로그 조회

### Ports
- **시스템 포트 스캔** — 리스닝 포트 + 프로세스 정보, 5초 자동 갱신
- **Dev Server 태깅** — 프로젝트 소유 포트 자동 표시
- **프로세스 Kill** — PID 기반 프로세스 종료

### Jira
- **이슈 목록/보드/타임라인** — Jira REST API 연동
- **드래그 앤 드롭** — 이슈 상태 전환
- **스프린트 관리** — 보드별 스프린트 조회

### Notes
- **마크다운 뷰어/에디터** — 프로젝트별 노트 관리
- **사이드바 트리 + 목차(TOC)** — 계층적 노트 탐색, 자동 목차 생성

### AI 계정
- **Claude / Codex 계정 프로필 관리** — 멀티 프로필 감지·전환, WSL과 Windows 프로필 동시 지원
- **콕핏 내장 계정** — 허브와 무관하게 콕핏이 소유하는 계정 추가/삭제. 추가 후 '로그인 터미널 열기'로 해당 계정 전용 디렉터리(`~/.local/share/cockpit/ai-accounts/`)에 로그인하면 상태가 '사용 가능'로 전환된다
- **로컬 사용량 계산** — Claude 계정은 계정 디렉터리의 대화 로그(`projects/*.jsonl`)에서 주간·5시간 토큰 사용량을 콕핏이 직접 계산해 표시한다(어카운트 허브와 동일 방식, 5분 캐시). Codex 토큰은 미지원
- **터미널 계정 전환** — 터미널 우클릭 → '계정 전환' 메뉴로 실행 중 위치를 선택한 계정 터미널로 교체

### 세션 제어 (ai1 → aiN 오케스트레이션)
터미널 헤더의 `ai1`, `ai2` 태그가 세션 별칭이다(클릭하면 전체 세션 ID 복사). 로컬에서는 이 별칭으로 세션을 직접 제어할 수 있어, 관리자 세션이 다른 세션에 일을 시키는 구성이 가능하다.

```bash
curl -s localhost:3847/api/terminals                                        # 세션 목록(별칭·계정·명령)
curl -s -X POST localhost:3847/api/terminals/ai3/input \
  -H 'Content-Type: application/json' -d '{"data":"버그 수정 진행 상황 알려줘"}'   # ai3에 입력 주입
curl -s 'localhost:3847/api/terminals/ai3/screen?lines=30'                  # ai3 화면 끝 30줄 읽기
```

- 입력 주입·화면 읽기는 localhost 전용이며 분당 60회로 제한된다
- UI에서는 터미널 우클릭 → '다른 세션에 보내기'로 선택 텍스트(또는 직접 입력)를 다른 세션에 즉시 주입할 수 있다
- **세션 자율 협업**: 각 세션 안의 Claude/Codex는 `cockpit-session` CLI(스킬 포함)로 스스로 다른 세션과 대화한다. "서로 대화해서 해"라고 지시하면 세션이 list/say/read로 협의하고 각자 작업한다. 도구 설치/갱신: `node scripts/install-session-toolkit.mjs [--dir <추가 설정 디렉터리>]` — 기본으로 `~/.claude`와 콕핏 내장 계정 전부에 스킬을 심는다. 새 계정은 생성 시 자동 시딩. Codex는 `$CODEX_HOME/skills/`에 같은 형식의 스킬이 들어간다

### Autopilot — 무인 운전 제어
- **attended / unattended 모드** — 기본은 `attended`(안전 모드), `unattended`로 전환하면 무인 운전 정책 적용
- **결정적 정책 분류기** (`lib/autopilot-policy.js`) — 안전 자동 실행 / 승격 / 거부를 룰로 분류. 고정 입력의 회귀 테스트를 제공하며, 과거 이력 재생 테스트는 로컬 `logs/decisions.jsonl`이 있을 때만 실행한다. 공개 clone에서는 해당 이력 테스트를 건너뛴다.
- **텔레그램 승격** — 판단이 모호하면 폰으로 승격 요청, 실패·타임아웃 시 안전하게 거부(deny)
- **브리핑** — 현재 상태 요약 조회

### Supervisor — 권한 자동 결정 + 원격 승인
Claude Code의 `PreToolUse` 훅을 받아 **도구 실행을 자동으로 승인·차단**하고, 모호한 건 사람에게 묻는 시스템.

- **3단 판단** — ① 안전/위험 룰(safelist·blacklist) 즉시 결정 → ② 모호하면 LLM(Gemini)이 평가 → ③ LLM도 모호하면 사용자에게 질문
- **텔레그램 원격 승인** — `away` 모드에서 위험 도구는 텔레그램으로 승인 / 거부 / 더 묻기 버튼 발송, 답하면 그대로 실행/차단
- **here / away 모드** — `here`(자리에 있음)면 알림 끄고 화면 프롬프트로, `away`면 폰으로 적극 질문
- **결정 이력 뷰** — 승인/차단/질문 타임라인 (도구·명령·프로젝트·LLM 판단 근거·신뢰도)
- **위험 패턴 차단** — `rm -rf /`, `mkfs`, fork bomb, 시스템 경로/`.ssh`/`.env` 직접 수정 등은 룰에서 즉시 차단

> Claude Code 훅(`~/.claude/settings.json` PreToolUse/Notification 등)에 `/api/supervisor/*`로 POST하는 셸 스크립트를 걸어 연동.

### AI Agent (Gemini)
- **Gemini 채팅** — Gemini 2.0 Flash / 2.5 Pro 모델 선택
- **9-Tool 에이전트** — BASH, READ, WRITE, EDIT, GLOB, GREP, GIT_DIFF, GIT_LOG, OPEN 도구 자동 실행
- **Agentic Loop** — 도구 호출 → 결과 피드백 → 다음 도구 자동 실행 (최대 25회)
- **음성 입력 / TTS** — 웨이크워드 감지 + Web Speech API, Edge TTS 음성 합성 (볼륨/속도/피치 조절)
- **대화 이력** — 멀티턴 대화, 이력 저장/로드
- **Arena** — 열려 있는 세션 2~3개를 골라 주제 하나로 턴제 토론시키는 관전 모드

### System Monitor
- **CPU 사용률** — 300ms 샘플링
- **메모리 / 디스크** — 전체/사용/여유, 드라이브별 사용량
- **Top 프로세스** — 메모리 상위 15개

### API Tester
- **HTTP 요청 프록시** — GET/POST/PUT/DELETE 등 모든 메서드
- **요청 저장** — 재사용 가능한 요청 CRUD, 헤더/JSON 바디 편집

---

## 아키텍처

```
Tauri Shell (cockpit.exe / Cockpit.app)
  └─ WebView (index.html + ES Modules)
       ↕ HTTP / WS
  └─ Node.js Server (server.js, port 3847)
       ├─ node-pty (터미널 멀티플렉서)
       ├─ SSE (프로젝트 상태 폴링)
       ├─ WebSocket (터미널 I/O)
       ├─ routes/ (API 라우트 모듈, 170+ 라우트)
       └─ lib/ (서비스 모듈들)
```

- **프론트엔드**: Vanilla JS ES Modules, 프레임워크 없음. `<script type="module" src="js/main.js">`
- **백엔드**: Node.js 순수 `http` 모듈, 자체 라우터 (`addRoute(method, pattern, handler)`)
- **실시간 이원화**: SSE(프로젝트·Git·세션 상태 push) + WebSocket(터미널 I/O)
- **크로스 플랫폼 추상화**: Windows·macOS·Linux·WSL의 셸·경로·프로세스·포트 차이를 `lib/platform.js` 한 곳으로 격리

---

## 빠른 시작

```bash
git clone https://github.com/wooinwoo/claude-code-cockpit.git
cd claude-code-cockpit
npm install
npm start          # = node server.js  →  http://localhost:3847
```

**모바일 접속** — 같은 WiFi에서 `http://<PC의 IP>:3847` 접속. 헤더의 **Mobile Connect** 버튼으로 QR 코드 확인.

**데스크톱 앱 빌드 (Tauri)**:

```bash
npm run build      # Tailwind 빌드 → ncc 번들 → 인스톨러 생성
```

- Windows: `Cockpit_x.x.x_x64-setup.exe` (NSIS 인스톨러)
- macOS: `Cockpit_x.x.x_aarch64.dmg`

> 런타임은 빌드 도구 없이 ES 모듈을 직접 서빙합니다. Tailwind/ncc는 배포 인스톨러 빌드에만 사용됩니다.

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | Vanilla JS ES Modules — 프레임워크·번들러·트랜스파일러 없음 |
| 서버 | Node.js (순수 `http` 모듈, 자체 라우터) |
| 런타임 의존성 | `ws`, `node-pty`, `msedge-tts`, `@langchain/*` (Gemini/Workflows) 최소 구성 |
| 터미널 | `node-pty` (서버 PTY) + `xterm.js` (클라이언트), 일반 화면에서 WebGL 선택 가능 |
| 실시간 | Server-Sent Events (SSE) + WebSocket |
| 데스크톱 | Tauri 2 (Rust, Windows + macOS) |
| 차트 | Chart.js 4.4.7 (`vendor/` 로컬 번들) |
| AI (커밋) | Claude CLI (`claude -p --model haiku`) via OAuth |
| AI (에이전트) | Gemini 2.0 Flash / 2.5 Pro (Google AI API) |
| TTS | Edge TTS (`msedge-tts`) |
| 이슈트래커 | Jira REST API |
| CI/CD | GitHub Actions API |

---

## 테스트

```bash
npm test          # node --test tests/lib/*.test.js tests/routes/*.test.js
```

- **단위·회귀 테스트** (`node:test`), 외부 러너 없음
- 커버 영역: Autopilot 정책(로컬 이력 파일이 있으면 이력 재생도 검증), Agent Wall 상태 분류, durable 터미널, 라우트 검증, UI 셸 정합성 등
- `npm run test:watch` — lib/routes/tests 변경 감지 자동 재실행

---

## Desktop App (Tauri)

Tauri 2로 패키징된 네이티브 데스크탑 앱.

| 플랫폼 | 인스톨러 | 비고 |
|--------|----------|------|
| Windows | NSIS `.exe` | WebView2 사용 |
| macOS | `.dmg` | 최소 macOS 11.0 |

- **자동 서버 관리** — 앱 시작 시 Node.js 서버 자동 기동, 종료 시 정리
- **네이티브 알림** — Windows 토스트 / macOS 알림 센터
- **인스톨러 빌드** — `npm run build`

## Mobile / PWA

- **LAN 접근** — `0.0.0.0:3847` 바인딩, 같은 네트워크에서 접근 가능
- **QR 코드** — Mobile Connect 버튼 → QR + URL (토큰 기반 인증)
- **PWA** — manifest.json + Service Worker, 홈 화면 설치 가능
- **반응형** — 카드/터미널/diff 모바일 최적화
- **Tailscale** — 외부 네트워크에서도 WireGuard E2E 암호화로 안전 접근

---

# 상세 가이드

## 설치 가이드

### Windows

```powershell
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
```

### macOS

```bash
# 필수
brew install node git

# 권장
brew install gh
brew install --cask tailscale

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude  # OAuth 로그인
```

> macOS는 Xcode Command Line Tools 필요: `xcode-select --install`

### Windows 자동 시작 (선택)

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-autostart.ps1
```

해제: `schtasks /delete /tn ClaudeCodeDashboard /f`

---

## 아키텍처 상세

```
Browser / Tauri WebView        Node.js Server (port 3847)
┌──────────────────┐   HTTP   ┌─────────────────────────────┐
│ index.html       │◄────────►│ server.js (라우터, WS, SSE)  │
│ style.css        │   SSE    │   ├─ routes/                 │
│ js/              │◄─────────│   │  ├─ system.js            │
│  main.js         │   WS     │   │  ├─ git.js               │
│  dashboard.js    │◄────────►│   │  ├─ projects.js          │
│  terminal.js     │          │   │  ├─ sessions.js          │
│  terminal-ui.js  │          │   │  ├─ agent.js             │
│  agent-wall.js   │          │   │  ├─ supervisor.js        │
│  diff.js         │          │   │  ├─ autopilot.js         │
│  pr.js           │          │   │  ├─ ai-accounts.js       │
│  cicd.js         │          │   │  ├─ board.js             │
│  workflows.js    │          │   │  ├─ telegram.js          │
│  ports.js        │          │   │  ├─ pr.js                │
│  modals.js       │          │   │  └─ ...                  │
│  state.js        │          │   └─ lib/                    │
│  highlight.js    │          │      ├─ platform.js          │
│  utils.js        │          │      ├─ config.js            │
│ vendor/          │          │      ├─ claude-data.js       │
│  xterm.js        │          │      ├─ git-service.js       │
│  chart.js        │          │      ├─ github-service.js    │
└──────────────────┘          │      ├─ cost-service.js      │
                              │      ├─ agent-service.js     │
                              │      ├─ supervisor-*.js      │
                              │      ├─ autopilot*.js        │
                              │      ├─ ai-accounts-service  │
                              │      ├─ durable-terminal.js  │
                              │      ├─ process-agent.js     │
                              │      ├─ jira-service.js      │
                              │      ├─ cicd-service.js      │
                              │      ├─ workflows-service.js │
                              │      ├─ monitor-service.js   │
                              │      ├─ ports-service.js     │
                              │      ├─ session-control.js   │
                              │      ├─ telegram-bridge.js   │
                              │      └─ ...                  │
                              └──────────┬──────────────────┘
                                         │
                     ┌────────────────────┬┴──────────────────┐
                 ~/.claude/           git CLI          claude CLI
                 (세션/비용)        (status/diff)     (AI commit)
                 opencode.db         gh CLI           Gemini API
                 (opencode 세션)     (PR/Actions)     (Agent/Autopilot)
```

### Frontend Modules (주요)

| Module | 역할 |
|--------|------|
| main.js | 엔트리포인트, 초기화, 이벤트 위임, 키보드 단축키 |
| state.js | 전역 상태 (`app` 객체), pub/sub, localStorage |
| utils.js | XSS 방지(`esc`), 토스트, 시간 포맷, 마크다운 |
| dashboard.js (+ cards/charts) | 프로젝트 카드, SSE 연결, 비용 차트, 알림 |
| terminal.js / terminal-ui.js | 터미널 생성/분할/탭 관리, WS I/O, 모바일 UI |
| terminal-group-layout.js | 터미널 그룹·분할 레이아웃 복원 |
| agent-wall.js / agent-wall-state.js | Agent Wall 관제 패널, 상태·릴리스 게이트 분류 |
| xterm-ime-guard.js | IME(한글 등) 입력 보정 |
| diff.js | Git diff 렌더링, 스테이징, 커밋, stash, 브랜치 |
| highlight.js | 정규식 기반 구문 하이라이팅 |
| pr.js | PR 목록 뷰 |
| cicd.js | GitHub Actions 파이프라인 뷰 |
| workflows.js | 워크플로우 정의/실행/스케줄링 |
| ports.js | 포트 스캔 UI, 프로세스 kill |
| arena.js | 멀티세션 턴제 토론 관전 |
| ai-accounts.js | Claude/Codex 계정 프로필 UI |
| autopilot-view.js | Autopilot 제어 뷰 |
| modals.js | 다이얼로그, 커맨드 팔레트, 설정 패널 |

### Server Lib Modules (주요)

| Module | 역할 |
|--------|------|
| platform.js | 크로스 플랫폼 헬퍼 (셸, 프로세스 kill, URL/폴더 열기, IDE 경로) |
| config.js | 설정 관리 (projects.json, API keys, 포트) |
| claude-data.js | Claude 세션(jsonl) + opencode 세션(SQLite) 파서, 상태 병합 |
| git-service.js | git 명령어 래퍼 (WSL 투명 지원) |
| github-service.js | GitHub API (PR) |
| cost-service.js | 토큰 사용량/비용 추적 |
| agent-service.js (+ tools/orchestrator) | Gemini API 클라이언트, 9-Tool 에이전트 시스템 |
| supervisor-service.js (+ llm) | PreToolUse 권한 판단, 결정 이력 |
| autopilot.js (+ policy) | 무인 운전 엔진, 결정적 정책 분류기 |
| telegram-bridge.js | 텔레그램 원격 승인 버튼 |
| ai-accounts-service.js | Claude/Codex 멀티 프로필 감지·전환 |
| durable-terminal.js | durable 터미널 ID·cwd 복원 |
| process-agent.js | 프로세스에서 claude/codex/opencode 감지 |
| jira-service.js | Jira REST API 클라이언트 |
| cicd-service.js | GitHub Actions API |
| workflows-service.js (+ scheduler) | 워크플로우 엔진, 예약 실행 |
| monitor-service.js | CPU/메모리/디스크/프로세스 모니터링 |
| ports-service.js | 포트 스캔 + 프로세스 관리 |
| session-control.js | Claude 세션 시작/재개 (터미널 앱 실행) |
| batch-service.js | 배치 명령 실행 (다중 프로젝트 동시) |
| briefing-service.js | 일일 브리핑/알림 생성 |
| notify.js | 네이티브 알림 (Windows/macOS/Linux) |
| poller.js | 주기적 데이터 폴링 + SSE 브로드캐스트 |
| wsl-utils.js | WSL 경로 변환, WSL 프로젝트 지원 |
| qr.js | QR 코드 SVG 생성 |

---

## 크로스 플랫폼

`lib/platform.js`에서 OS별 분기를 중앙 관리:

| 기능 | Windows | macOS | Linux |
|------|---------|-------|-------|
| 기본 셸 | pwsh / powershell | zsh / bash | bash |
| 알림 | PowerShell WinRT Toast | osascript | notify-send |
| URL 열기 | `cmd /c start` | `open` | `xdg-open` |
| 폴더 열기 | `explorer /select` | `open -R` | `xdg-open` |
| 프로세스 kill | `taskkill /T /F` | `kill -SIGTERM` | `kill -SIGTERM` |
| 포트 스캔 | `netstat -ano` | `lsof -iTCP` | `lsof` / `ss` |
| 디스크 정보 | `wmic` | `df -k` | `df -k` |
| 프로세스 목록 | PowerShell `Get-Process` | `ps -eo` | `ps -eo` |
| Claude 세션 | Windows Terminal | Terminal.app (AppleScript) | gnome-terminal / konsole |
| IDE (Zed) | `%LOCALAPPDATA%/Programs/Zed/bin/zed.exe` | `/Applications/Zed.app/Contents/MacOS/cli` | `zed` |
| Firefox Dev | `%ProgramFiles%/Firefox Developer Edition/firefox.exe` | `/Applications/Firefox Developer Edition.app/.../firefox` | `firefox-developer-edition` |

---

## 알림

3단계 알림 시스템:
1. **네이티브 알림** — Windows 토스트 / macOS 알림 센터 / Linux notify-send
2. **Audio Chime** (브라우저) — Web Audio API 2-tone 차임
3. **Title Flash** (백그라운드 탭) — 탭 제목 깜빡임

프로젝트별 알림 ON/OFF 설정 가능 (알림 버튼 우클릭)

---

## 키보드 단축키

| Shortcut | Action |
|----------|--------|
| Ctrl+1 | Overview 탭 |
| Ctrl+2 | Terminal 탭 |
| Ctrl+3 | Changes 탭 |
| Ctrl+4 | PR 탭 |
| Ctrl+5 | Jira 탭 |
| Ctrl+6 | CI/CD 탭 |
| Ctrl+7 | Notes 탭 |
| Ctrl+8 | Workflows 탭 |
| Ctrl+9 | README 탭 |
| Ctrl+K | Command Palette |
| Ctrl+T | 새 터미널 |
| Ctrl+Shift+T | 빈 터미널 (홈) |
| Ctrl+W | 터미널 닫기 |
| Ctrl+F | 터미널 내 검색 |
| Ctrl+Tab | 다음 터미널 |
| Ctrl+Shift+Tab | 이전 터미널 |
| E | Diff 전체 펼치기 |
| C | Diff 전체 접기 |
| R | Diff 새로고침 |
| ? | 단축키 도움말 |
| Escape | 오버레이 / 검색 닫기 |

---

## 프로젝트 등록

### UI에서 등록
Overview 탭 설정(톱니바퀴) → "Add Project" 또는 "Discover"로 자동 검색

### 직접 편집
`projects.json`:

```json
{
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "path": "/home/you/projects/my-project",
      "stack": "react-next",
      "color": "#3B82F6",
      "devCmd": "npm run dev"
    }
  ]
}
```

| 필드 | 필수 | 설명 |
|------|------|------|
| `id` | 자동 | 프로젝트 고유 ID |
| `name` | O | 표시 이름 |
| `path` | O | 프로젝트 루트 경로 |
| `stack` | X | `react-next` \| `nestjs` 등 |
| `color` | 자동 | 카드 색상 |
| `devCmd` | X | 개발 서버 명령어 |
| `github` | X | GitHub 레포 (`owner/repo`) — PR/CI 연동 |

---

## 데이터 저장소

| 파일 | 내용 | 암호화 |
|------|------|--------|
| `projects.json` | 프로젝트 목록 (id, name, path, color, devCmd, github, stack) | - |
| `jira-config.json` | Jira 연결 설정 (url, email, token) | token AES-256-GCM |
| `ai-config.json` | Gemini API key | key AES-256-GCM |
| `.encryption-key` | 토큰 암호화 마스터 키 (랜덤 32B) | - |
| `cost-cache.json` | API 비용 캐시 | - |
| `session-state.json` | 세션 상태 | - |
| `agent-history.json` | 에이전트 대화 이력 | - |
| `workflow-runs.json` | 워크플로우 실행 기록 | - |
| `workflow-schedules.json` | 워크플로우 스케줄 설정 | - |
| `notes/*.md` | 마크다운 노트 | - |
| `workflows/*.json` | 워크플로우 정의 | - |

---

## 보안

- **LAN 토큰 인증** — localhost 외 접근 시 토큰 필요 (자동 생성, 쿠키 저장)
- **localhost 무인증** — 로컬 접근은 토큰 불필요
- **경로 검증** — 등록된 프로젝트 내부 경로만 파일 접근 허용 (`isInsideAnyProject()`)
- **IDE 화이트리스트** — code, cursor, windsurf, antigravity, zed만 허용
- **API Tester** — localhost에서만 실행 가능
- **포트 킬** — 보호 PID (0, 4, 자기 자신) 거부
- **환경 변수 불필요** — Claude OAuth는 CLI가 자체 관리
- **Autopilot 안전 기본값** — `attended` 모드가 기본. 승격 실패·타임아웃은 거부(deny) 처리
