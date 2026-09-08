# 공개 시연 자료

이 디렉터리의 자료는 실제 Cockpit 서버와 UI를 격리된 샘플 프로젝트로 실행해 촬영한다. 개인 프로젝트·계정·로그를 복사하지 않고, 브라우저의 외부 요청도 차단한다. 터미널과 Git·테스트 출력은 실제 동작 결과다. AI 에이전트의 실행 결과나 외부 CI 성공을 연출하지 않는다.

## 재현

Linux에서 Node.js 22, Git, `/usr/bin/tmux`, `/bin/bash`, node-pty 빌드 도구가 필요하다.

```bash
npm ci
npx playwright-core install chromium
npm run demo:capture
```

이미 설치한 Chromium은 `CHROME_BIN=/absolute/path/to/chrome npm run demo:capture`로 지정할 수 있다. Playwright 영상 녹화용 FFmpeg가 없는 환경에서는 `npx playwright-core install ffmpeg`도 실행한다. 신규 런타임 의존성을 추가하지 않고 기존 playwright-core를 사용한다.

명령은 이 디렉터리의 화면·영상·검증 기록을 새 촬영 결과로 교체한다. 서버 코드와 정적 파일은 임시 디렉터리에 복사하고 node_modules만 연결한다. 테스트용 홈 조회와 데이터·tmux 소켓을 분리하며, 개인 초기화 파일을 읽지 않는 셸을 실행한다. 실행 중인 Cockpit 서버를 재시작하거나 기존 터미널을 종료하지 않는다.

## 파일

| 파일 | 내용 |
|---|---|
| [terminal-workspace.png](terminal-workspace.png) | 두 터미널 그룹에서 Git 변경과 샘플 테스트 결과 확인 |
| [restored-terminals.png](restored-terminals.png) | 서버 재시작 후 같은 셸 변수와 cwd 확인 |
| [cockpit-demo.webm](cockpit-demo.webm) | 약 1분 분량의 실제 실행 영상과 한국어 단계 설명 |
| [verification.json](verification.json) | 촬영 시점·Node/Chromium 버전·검증 결과·단일 실행 시간 |

영상은 터미널 그룹 구성, 실제 샘플 테스트, 서버 재시작, 셸 상태·배치 복원, 별도의 일반 셸에서 휠 스크롤 검증 순서로 진행한다. 단계 설명 자막은 촬영 스크립트가 올리는 안내이며 제품 UI 변경은 아니다. 정지 화면에서는 자막을 숨긴다.

## 증거 해석

복원은 tmux가 켜진 세션에서 검증한다. 일반 버퍼 휠은 tmux를 끈 별도의 서버에서 검증한다. tmux의 alternate buffer·copy mode에서의 휠 동작까지 통과했다고 해석하면 안 된다.

`restartMs`는 정상 종료 요청부터 재기동·브라우저 새로고침·복원된 셸의 출력 확인까지 걸린 시간이다. 단일 로컬 실행이며 이전 버전 대비 개선율이나 다른 장비의 성능을 의미하지 않는다. 촬영 안내를 읽는 대기 시간은 이 측정 구간에 포함하지 않는다.

실제 Windows/macOS IME 입력, 데스크톱 설치, AI 서비스 연결은 이 촬영의 검증 범위 밖이다.
