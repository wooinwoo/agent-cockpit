---
name: cockpit-session
description: Use when the user asks this session to talk with, coordinate with, delegate to, or check other AI sessions running in Cockpit terminals — e.g. "서로 대화해서 해", "ai2한테 물어봐", "다른 세션 상황 어때". Provides list/say/read commands for peer-to-peer session control. Also use when an input starting with "[콕핏 세션 메시지" arrives from another session.
---

# 콕핏 세션 상호 통신

이 머신의 콕핏 터미널에서 실행 중인 다른 AI 세션과 직접 대화·협업할 수 있다.
모든 명령은 로컬 HTTP API(포트 3847)를 통해 즉시 반영된다.

## 명령

```bash
cockpit-session list                  # 활성 세션 목록 (ai1, ai2 ... 별칭 · 프로젝트 · 계정)
cockpit-session me                    # 내 세션 별칭 확인
cockpit-session say <대상> "<메시지>"  # 대상 세션 입력창에 메시지 주입 (보낸이 자동 서명)
cockpit-session read <대상> [줄수=20]  # 대상 세션 화면 끝부분 읽기
cockpit-session read <대상> --new     # 변화 없으면 한 줄만 반환 — 폴링은 반드시 이걸로 (토큰 절약)
```

대상은 별칭(`ai3`) 또는 세션 ID. 메시지는 상대의 입력창에 그대로 들어가 전송된다.
read 결과는 내 컨텍스트에 쌓여 매 턴 재청구되므로 — **폴링은 `--new`, 줄수는 최소(15~20), 자세히 볼 필요가 있을 때만 크게**.

## 협업 패턴

### 사용자 대화 보호

사용자가 "지금 나랑 대화 중이니 다른 AI는 말 걸지 마"라고 요청하면 먼저 본인의 고정 ID를 확인한 뒤 `cockpit-session conversation <본인 고정 ID> on`을 실행한다. 감독과 작업자 모두 사용할 수 있다. 사용자 대화와 진행 중인 실행은 유지되며, 새 AI 메시지·키 입력·감독 자동 지시는 차단된다. 보호 상태는 서버 재시작 후에도 유지된다.

사용자가 대화를 마치고 감독 연결을 재개하라고 명시하거나 화면의 **대화 끝 · 재개**를 누르면 `cockpit-session conversation <본인 고정 ID> off`로 해제한다. 답변 종료나 잠깐의 무입력을 대화 종료로 추정하지 않는다. 다른 AI가 작업 진행을 원한다는 이유로 보호를 해제하지 않는다.

보호된 세션으로 보낸 메시지는 전달되지 않고 `CONVERSATION_HELD` 오류를 반환한다. 반복 전송하거나 다른 입력 경로로 우회하지 않는다. 필요한 결과·막힘은 감독보드에 기록하고 가능한 본인 작업을 계속한다. 재개 후 감독은 최신 보드로 다시 점검한다. 이전 메시지나 키 입력은 자동 재생하지 않는다. 이미 전달된 입력은 회수하지 않는다.

1. **질문/지시**: `list`로 상대 확인 → `say`로 명확한 요청 전송 → 30~60초 뒤 `read <대상> --new`로 응답 확인. "변화 없음"이면 상대가 작업 중일 수 있으니 잠시 후 다시.
2. **수신 응답**: `[콕핏 세션 메시지 | 보낸 세션: ai1]` 형식의 입력이 오면 다른 세션이 보낸 것이다. 요청을 이행하거나, 답장이 필요하면 `cockpit-session say ai1 "답장 내용"`으로 회신한다.
3. **"서로 대화해서 해"**: 상대에게 맥락·요구사항을 담은 명확한 메시지를 보내고, `read --new` 폴링으로 대화를 이어가며(필요시 2~3회 왕복), 합의된 내용을 종합해 사용자에게 보고한다. 각자 직접 작업해야 할 부분은 나눠서 진행한다.
4. **장기 작업 위임**: `say`로 과제를 전달한 뒤 주기적으로 `read <대상> --new`로 진행 상황 확인.

## 프롬프트 대리 응답 (다른 세션의 1/2/3 선택·체크박스 처리)

상대 세션이 선택 프롬프트("1. Yes / 2. No", 권한 확인, 체크박스)에서 멈춰 있으면 화면을 읽고 키를 대신 눌러준다:

```bash
cockpit-session read ai2 15        # 프롬프트 확인 (예: "❯ 1. Yes  2. No")
cockpit-session key ai2 2          # 2번 선택
cockpit-session key ai2 space enter  # 체크박스: 토글 후 확인
cockpit-session key ai2 enter      # 기본값 확정
cockpit-session key ai2 esc        # 작업 중단 요청
cockpit-session key ai2 ctrlc      # 강제 중단
```

- 판단 기준(무엇을 선택할지)은 반드시 사용자의 지시나 합의된 정책에 따른다. 임의로 위험한 선택을 하지 않는다.
- 선택 후 `read`로 결과가 반영됐는지 확인한다.
- 사용자가 "프롬프트 떠 있으면 알아서 처리해"라고 지시한 경우에만 자동 응답한다.

## 주의

- 메시지는 짧고 명확하게 — 상대 입력창에 직접 삽입된다.
- 상대 세션을 임의로 조종하지 말고 대화로 합의한다. 긴급한 개입(입력 취소 등)은 사용자가 직접 하도록 보고한다.
- 내가 어떤 세션인지 모르겠으면 `cockpit-session me`로 확인.
