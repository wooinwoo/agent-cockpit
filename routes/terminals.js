// ─── 세션 제어 API — ai1 같은 별칭 또는 termId로 터미널 조회·주입 ───
// 입력 주입·화면 읽기는 로컬(세션 CLI의 curl) 전용.

export function register(ctx) {
  const { addRoute, json, readBody, rateLimit, isLocalhost, resolveTerminalRef, terminalSummaryList, readTerminalScreen } = ctx;

  addRoute('GET', '/api/terminals', (_req, res) => {
    json(res, { terminals: terminalSummaryList() });
  });

  addRoute('PUT', '/api/terminals/:ref/conversation', async (req, res) => {
    const body = await readBody(req);
    if (typeof body.held !== 'boolean') return json(res, { error: 'held는 true 또는 false여야 합니다.' }, 400);
    const found = resolveTerminalRef(req.params.ref);
    if (!found) return json(res, { error: 'Terminal not found' }, 404);
    const previous = found.entry.conversationHeld === true;
    try {
      if (previous !== body.held) {
        // Keep the guard closed until persisted scheduling changes are complete.
        found.entry.conversationHeld = true;
        const board = ctx.getBoard();
        for (const review of board.supervisors || [board.review]) {
          if (review.termId !== found.id && !review.watched.some(worker => worker.termId === found.id)) continue;
          const scheduling = ['stopped', 'complete'].includes(review.status) ? {} : {
            nextDueAt: Date.now(), retryAt: 0, pendingSince: 0, cycleStartedAt: 0, recoveryAfter: 0,
            workerProgress: review.workerProgress.map(worker => worker.termId !== found.id ? worker : {
              ...worker, run: { ...worker.run, lastSentAt: 0, attempts: 0,
                resumeRequestedAt: 0, resumeSentAt: 0, resumeSubmittedAt: 0 },
            }),
          };
          ctx.updateBoardReview({ ...scheduling,
            ...(review.termId === found.id && review.recoveryTerminal
              ? { recoveryTerminal: { ...review.recoveryTerminal, conversationHeld: body.held } } : {}),
          }, review, review.id);
        }
        found.entry.conversationHeld = body.held;
        ctx.saveTerminalStateNow(true);
      }
      json(res, { ok: true, termId: found.id, conversationHeld: body.held });
    } catch (error) {
      found.entry.conversationHeld = previous;
      json(res, { error: `대화 보호 저장 실패: ${error.message}` }, 500);
    }
  });

  addRoute('GET', '/api/terminals/:ref/screen', (req, res) => {
    if (!isLocalhost?.(req)) return json(res, { error: 'Forbidden — 로컬에서만 읽을 수 있습니다.' }, 403);
    const lines = Number(req.query.lines) || 50;
    const screen = readTerminalScreen(req.params.ref, lines);
    if (!screen) return json(res, { error: 'Terminal not found' }, 404);
    json(res, screen);
  });

  addRoute('POST', '/api/terminals/:ref/input', async (req, res) => {
    if (!isLocalhost?.(req)) return json(res, { error: 'Forbidden — 로컬에서만 주입할 수 있습니다.' }, 403);
    if (!rateLimit(`term-input:${req.socket?.remoteAddress}`, 60)) {
      return json(res, { error: 'Too many requests' }, 429);
    }
    const body = await readBody(req);
    const data = typeof body.data === 'string' ? body.data : '';
    if (!data || data.length > 100_000) {
      return json(res, { error: 'data 필드(1~100000자 문자열)가 필요합니다.' }, 400);
    }
    const found = resolveTerminalRef(req.params.ref);
    if (!found) return json(res, { error: 'Terminal not found' }, 404);
    if (found.entry.conversationHeld) return json(res, {
      error: '사용자와 대화 중입니다. 메시지는 전달되지 않았습니다. 결과·막힘은 감독보드에 기록하고 가능한 본인 작업을 계속하세요. 사용자가 대화 보호를 해제한 뒤 최신 상황으로 다시 연결하세요.',
      code: 'CONVERSATION_HELD', termId: found.id,
    }, 409);
    try {
      // 멀티라인은 브래킷 페이스트로 감싸 TUI가 붙여넣기로 처리하게 함 (줄바꿈마다 제출되는 것 방지)
      const payload = data.includes('\n') ? `\x1b[200~${data}\x1b[201~` : data;
      found.entry.pty.write(body.enter === false ? payload : payload + '\r');
      json(res, { ok: true, termId: found.id, alias: found.entry.alias || '' });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });
}
