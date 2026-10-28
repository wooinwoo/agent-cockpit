# jcode 계정별 비용 기록

AI 계정의 금액은 확인된 요청 토큰을 일반 API 단가로 환산한 추정치입니다. 구독료나 공급자의 청구 내역이 아닙니다. 오늘은 UTC 날짜, 최근 7일은 조회 시점부터의 구간입니다.

기존 jcode journal에는 요청별 계정 정보가 없습니다. 공용 journal 추정치와 새 계정별 요청 기록은 서로 겹칠 수 있으므로 합산하지 않습니다. 과거 journal을 현재 기본 로그인이나 재사용 가능한 label로 계정에 배분하지 않습니다.

## jcode 수정본

- 기준: upstream `1jehuang/jcode` 0.91.0, commit `d2ffcd62c9bc540dd913a046d62cdc0307b5e189`.
- 패치: `patches/jcode-0.91.0-account-usage.patch`.
- 요청 시작 때 실제 전송 인증정보와 일치하는 고유 계정의 이메일을 고정합니다. OpenAI는 워크스페이스 계정 ID도 고정합니다. 일치가 불명확하면 미귀속으로 남깁니다.
- OpenAI SSE/웹소켓 및 Anthropic SSE에서 종료 사용량을 받은 뒤 소비자에게 전달하기 전에 `JCODE_HOME/account_usage.jsonl`에 기록합니다. EOF만으로 완료를 추정하지 않습니다.
- 파일은 소유자 전용이며 동시 append를 OS 잠금으로 직렬화합니다. 인증 토큰, 요청 내용, 답변 내용, 도구 입력은 기록하지 않습니다.
- 콕핏은 계정 이메일이 중복되지 않고 OpenAI 계정 ID까지 현재 등록과 일치할 때만 비용을 배정합니다. 누락 토큰·캐시 상세·미확인 단가는 미산정으로 표시합니다.

상류 소스의 해당 commit에서 `git apply /절대경로/patches/jcode-0.91.0-account-usage.patch`를 실행한 다음 기존 기능을 유지하는 기본 feature로 빌드합니다. 실행 중인 daemon은 바이너리 파일만 교체해도 바뀌지 않습니다. 작업 중 daemon을 강제로 재시작하지 말고 수정본 적용 여부와 별개로 확인해야 합니다.

## 검증

콜백·전송부의 계정 고정, SSE 메타데이터, 단회 기록, 파일 권한·심볼릭 링크·동시 기록, 미완료 사용량을 jcode의 관련 crate 테스트로 검증합니다. 콕핏은 `scripts/verify-account-usage.mjs --release`로 실제 격리 Rust 서버에서 서로 다른 워크스페이스·중복 이메일·공용 집계 분리를 검증합니다. UI 검증은 `scripts/verify-session-maintenance-ui.mjs --release`를 사용하며 실제 작업 터미널을 조작하지 않습니다.

단가 확인일: 2026-10-16. 출처: [OpenAI 모델 단가](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Claude API 단가](https://platform.claude.com/docs/en/about-claude/pricing). 일반 API 환산이므로 실제 서비스 티어·지역 가산·구독 조건에 따른 결제액을 주장하지 않습니다.
