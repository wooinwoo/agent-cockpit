# Vendor 번들 관리

CDN을 쓰지 않는 프로젝트 원칙에 따라 모든 프론트엔드 라이브러리를 `vendor/`에 로컬 번들로 유지한다. 이 문서는 각 번들의 출처, 적용된 로컬 조정, 교체(업그레이드) 절차를 기록한다.

## 번들 목록

| 파일 | 원본 패키지 | 비고 |
|------|------------|------|
| `xterm.min.js` | @xterm/xterm | 버전 스트링이 번들에 없음 — 아래 "식별 정보" 참고 |
| `addon-fit.min.js` | @xterm/addon-fit | sourceMappingURL 라인 제거됨 |
| `addon-web-links.min.js` | @xterm/addon-web-links | |
| `addon-search.min.js` | @xterm/addon-search | sourceMappingURL 라인 제거됨 |
| `addon-webgl.min.js` | @xterm/addon-webgl | |
| `addon-image.min.js` | @xterm/addon-image | |
| `addon-unicode11.min.js` | @xterm/addon-unicode11@0.9.0 | |
| `chart.min.js` | chart.js@4.4.7 | |
| `marked.min.js`, `highlight.min.js` 등 | 각 공식 배포본 | |

### xterm.min.js 식별 정보

번들에 버전 상수가 노출되지 않아 아래 특징으로 기준을 파악한다:

- `Viewport`가 `SmoothScrollableElement` + `Scrollable`(스무스 스크롤) 구조 — xterm **5.6 이상**의 신규 뷰포트 구조
- `IntersectionObserver`로 일시정지(Pause) 처리 포함
- `overviewRuler` 옵션 지원 포함

브라우저 콘솔에서 `Terminal`이 전역 노출되지 않는 UMD 형태이다 (브라우저 `<script>` 로딩 시 `window.Terminal`로 노출됨 — Node `require`로는 확인 불가).

### 로컬 조정 이력

- `xterm.min.js`, `addon-fit.min.js`, `addon-search.min.js`: 번들 끝의 `//# sourceMappingURL=...` 라인 제거 (`.map` 파일이 없어 404 경고 방지). **로직 패치는 없음.**
- `js/xterm-ime-guard.js`: xterm.js#6089(IME 조합) 및 Windows TSF textarea 교체 이슈의 런타임 패치. **업스트림 xterm에 두 수정이 모두 포함된 버전으로 교체하면 이 파일과 `terminal-ui.js`의 `patchXtermImeComposition()` 호출을 제거한다.**

## 업그레이드 절차

1. 새 버전 수령: `npm pack @xterm/<pkg>` → 압축 해제 후 `lib/` 의 브라우저 번들을 `vendor/`로 복사
2. `sourceMappingURL` 라인 제거 (필요 시)
3. **자동 검증**: `npm test`
   - `tests/lib/xterm-behavior.test.js`가 실제 번들을 jsdom으로 구동해 아래를 검증:
     - 한글 와이드 문자 셀 폭 (2/0 정렬 — 한글 씹힘 회귀 감지)
     - unicode11 애드온 활성 상태의 동일 검증
     - alt-screen 진입/복귀 (`?1049h/l`)
     - OSC 52 이벤트 전달
   - `npm run test:integration`은 실제 서버·tmux·Chromium에서 세션 복원을 검증하고, tmux를 끈 별도의 일반 셸에서 휠 스크롤을 검증한다.
   - TUI 마우스 모드별 휠 전달과 실제 OS 입력기는 아래 수동 체크리스트로 확인한다. 현재 jsdom 테스트에서 이 경로를 검증한다고 간주하지 않는다.
4. **수동 체크리스트** (jsdom은 DOM scroll 이벤트를 발화하지 않아 Viewport 스크롤 체인은 자동 검증 불가):
   - [ ] 일반 셸에서 대량 출력 후 휠 스크롤 동작
   - [ ] `Alt+K/L` (3줄), `Shift+Alt+K/L` (페이지) 스크롤 동작
   - [ ] opencode/Claude Code TUI 내 휠 스크롤
   - [ ] 한글 IME 조합 입력 (IME 가드가 여전히 필요한지 확인)
   - [ ] WebGL 렌더러 정상 (GPU 컨텍스트 손실 폴백은 로그로 확인)
5. Windows 실행 디렉토리(`%LOCALAPPDATA%/Cockpit/vendor/`)로 복사
