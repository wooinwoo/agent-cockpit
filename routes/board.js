import { updateBoardReview as persistReview, reportBoardReview as persistReport, reportBoardWorker as persistWorkerReport, addBoardSupervisor as persistSupervisor, supervisorBoard } from '../lib/board-service.js';
import { createBoardReviewer } from '../lib/board-review.js';
import { AGENT_PERMISSION_MODES, unattendedCommandReady } from '../js/agent-permissions.js';
import { createApprovalWatcher } from '../lib/approval-watcher.js';

export function register(ctx) {
  const {
    addRoute, json, readBody,
    getBoard, replaceBoardIfRevision, updateBoardNote, appendBoardNote, addBoardTask, updateBoardTask, deleteBoardTask,
  } = ctx;
  const updateBoardReview = ctx.updateBoardReview || persistReview;
  const reportBoardReview = ctx.reportBoardReview || persistReport;
  const approvalWatcher = ctx.approvalWatcher || createApprovalWatcher();

  if (ctx.resolveTerminalRef && ctx.terminalAgent) {
    const tick = createBoardReviewer({ getBoard, updateBoardReview,
      resolveTerminalRef: ctx.resolveTerminalRef, terminalAgent: ctx.terminalAgent, readTerminalScreen: ctx.readTerminalScreen,
      recoverSupervisor: ctx.recoverBoardSupervisor, PORT: ctx.PORT });
    const timer = setInterval(() => {
      try { tick(); } catch (error) { console.warn('[board-review]', error.message); }
    }, 15_000);
    timer.unref();
  }

  const handleError = (res, error) => {
    const status = error.code === 'BOARD_VALIDATION' ? 400
      : error.code === 'BOARD_CONFLICT' ? 409
        : error.code === 'BOARD_BUSY' ? 503 : 500;
    json(res, { error: error.message }, status);
  };

  addRoute('GET', '/api/board', (req, res) => {
    try { const board = getBoard(); json(res, req.query?.supervisorId ? supervisorBoard(board, req.query.supervisorId) : board); }
    catch (error) { handleError(res, error); }
  });

  addRoute('GET', '/api/board/approval-watcher', (req, res) => {
    if (!ctx.isLocalhost?.(req)) return json(res, { error: '승인 스크립트 관리는 로컬에서만 가능합니다.' }, 403);
    try { json(res, approvalWatcher.status()); }
    catch (error) { handleError(res, error); }
  });
  addRoute('POST', '/api/board/approval-watcher/stop', (req, res) => {
    if (!ctx.isLocalhost?.(req)) return json(res, { error: '승인 스크립트 관리는 로컬에서만 가능합니다.' }, 403);
    try { json(res, approvalWatcher.stop()); }
    catch (error) { handleError(res, error); }
  });

  addRoute('POST', '/api/board/supervisors', async (req, res) => {
    if (!ctx.isLocalhost?.(req)) return json(res, { error: '감독 추가는 로컬에서만 가능합니다.' }, 403);
    const body = await readBody(req);
    try { json(res, (ctx.addBoardSupervisor || persistSupervisor)(body.name), 201); }
    catch (error) { handleError(res, error); }
  });

  addRoute('PUT', '/api/board/permissions', async (req, res) => {
    if (!ctx.isLocalhost?.(req)) return json(res, { error: '실행 권한 설정은 로컬에서만 가능합니다.' }, 403);
    const body = await readBody(req);
    if (!Object.entries(AGENT_PERMISSION_MODES).every(([provider, modes]) => modes.includes(body?.[provider]))) {
      return json(res, { error: '지원하는 Codex·Claude 권한 모드를 선택하세요.' }, 400);
    }
    try { json(res, updateBoardReview({ launchPermissions: { codex: body.codex, claude: body.claude } })); }
    catch (error) { handleError(res, error); }
  });

  addRoute('PUT', '/api/board/review', async (req, res) => {
    if (!ctx.isLocalhost?.(req)) return json(res, { error: '관리 세션 설정은 로컬에서만 가능합니다.' }, 403);
    const body = await readBody(req);
    const minutes = body.intervalMinutes ?? 5;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || typeof body.target !== 'string') {
      return json(res, { error: '관리 세션과 확인 간격(1~1440분)을 확인하세요.' }, 400);
    }
    const found = body.target ? ctx.resolveTerminalRef(body.target) : null;
    if (body.target && (!found || !ctx.terminalAgent(found.entry))) {
      return json(res, { error: '실행 중인 AI 세션을 선택하세요.' }, 400);
    }
    try {
      const supervisorId = body.supervisorId || 'S-0001';
      const current = supervisorBoard(getBoard(), supervisorId).review;
      const referencePaths = body.referencePaths ?? current.referencePaths;
      if (!Array.isArray(referencePaths) || referencePaths.length > 30 || referencePaths.some(path => typeof path !== 'string' || !path.trim() || path.length > 2000 || /[\x00-\x1f\x7f]/.test(path))) {
        return json(res, { error: '참고 자료는 한 줄에 경로 하나씩, 최대 30개·각 2000자로 입력하세요.' }, 400);
      }
      const runHours = found ? (body.runHours ?? current.runHours) : 0;
      if (!Number.isInteger(runHours) || runHours < 0 || runHours > 24) return json(res, { error: '야간 운영 시간은 0~24시간으로 지정하세요.' }, 400);
      if (body.autoRecover !== undefined && typeof body.autoRecover !== 'boolean') return json(res, { error: '자동 복구 설정을 확인하세요.' }, 400);
      const autoRecover = Boolean(found && (body.autoRecover ?? current.autoRecover));
      const stallMinutes = found ? (body.stallMinutes ?? current.stallMinutes) : 0;
      if (!Number.isInteger(stallMinutes) || (stallMinutes !== 0 && (stallMinutes < 5 || stallMinutes > 240 || !autoRecover))) {
        return json(res, { error: '보고 기한은 자동 복구를 켠 상태에서 5~240분으로 지정하세요. 0은 강제 재시작 끄기입니다.' }, 400);
      }
      let recoveryTerminal = current.recoveryTerminal;
      if (autoRecover) {
        if (!ctx.prepareBoardRecovery) return json(res, { error: '현재 서버는 자동 복구를 지원하지 않습니다.' }, 400);
        try { recoveryTerminal = ctx.prepareBoardRecovery(found); }
        catch (error) { return json(res, { error: error.message }, 400); }
      }
      if (runHours && (!autoRecover || !stallMinutes || !unattendedCommandReady(found.entry.command))) {
        return json(res, { error: '야간 운영에는 자동 복구·보고 기한과 승인 없는 감독이 필요합니다. 아래에서 Codex 작업 폴더+네트워크 또는 전체 접근, Claude 권한 확인 생략을 선택하고 새 감독 세션을 여세요.' }, 400);
      }
      const objective = body.objective === undefined ? current.objective : body.objective;
      if (typeof objective !== 'string' || objective.length > 4000 || (body.watched !== undefined && !Array.isArray(body.watched))) {
        return json(res, { error: '감독 목표와 감시 대상 목록을 확인하세요.' }, 400);
      }
      let watched = current.watched;
      if (body.watched !== undefined) {
        if (body.watched.length > 12) return json(res, { error: '감시 대상은 최대 12개입니다.' }, 400);
        watched = [];
        for (const item of body.watched) {
          const worker = ctx.resolveTerminalRef(item?.target);
          if (!worker || !ctx.terminalAgent(worker.entry) || worker.id === found?.id
              || watched.some(other => other.termId === worker.id)
              || typeof item.goal !== 'string' || !item.goal.trim() || item.goal.length > 2000) {
            return json(res, { error: '감시 대상은 실행 중인 서로 다른 AI여야 하며, 각각 완료 조건이 필요합니다. 감독 자신은 제외하세요.' }, 400);
          }
          watched.push({ termId: worker.id, alias: worker.entry.alias || '', goal: item.goal.trim() });
        }
      }
      if (found && watched.some(worker => worker.termId === found.id)) return json(res, { error: '감독 세션 자신은 감시 대상이 될 수 없습니다.' }, 400);
      updateBoardReview({
        termId: found?.id || '', alias: found?.entry.alias || '', intervalMinutes: minutes, pendingSince: 0, nextDueAt: Date.now(),
        objective: objective.trim(), referencePaths: referencePaths.map(path => path.trim()), runHours,
        runUntil: runHours ? Date.now() + runHours * 3_600_000 : 0,
        watched, status: found ? 'running' : 'stopped', retryAt: 0, attempts: 0, lastError: '', lastReviewedAt: found ? 0 : current.lastReviewedAt,
        autoRecover, recoveryTerminal, recoveryAttempts: 0, recoveryAfter: 0, stallMinutes, cycleStartedAt: 0,
      }, undefined, supervisorId);
      json(res, getBoard());
    } catch (error) { handleError(res, error); }
  });

  addRoute('POST', '/api/board/review', async (req, res) => {
    if (!ctx.isLocalhost?.(req)) return json(res, { error: '확인 기록은 로컬에서만 가능합니다.' }, 403);
    const body = await readBody(req);
    try {
      const { review } = supervisorBoard(getBoard(), body.supervisorId || 'S-0001');
      if (!body.pendingSince || body.pendingSince !== review.pendingSince) {
        return json(res, { error: '현재 확인 요청의 번호가 아닙니다. 보드를 다시 조회하세요.' }, 409);
      }
      json(res, reportBoardReview(body.pendingSince, { status: body.status, report: body.report, progress: body.progress, supervisorId: body.supervisorId }));
    } catch (error) { handleError(res, error); }
  });

  addRoute('POST', '/api/board/worker-report', async (req, res) => {
    if (!ctx.isLocalhost?.(req)) return json(res, { error: '작업자 보고는 로컬에서만 가능합니다.' }, 403);
    const body = await readBody(req);
    try { json(res, (ctx.reportBoardWorker || persistWorkerReport)(body)); }
    catch (error) { handleError(res, error); }
  });

  addRoute('PUT', '/api/board', async (req, res) => {
    const body = await readBody(req);
    try { json(res, replaceBoardIfRevision(body.board, body.revision, body.base)); }
    catch (error) { handleError(res, error); }
  });

  addRoute('PUT', '/api/board/note', async (req, res) => {
    const body = await readBody(req);
    try { json(res, updateBoardNote(body.content)); }
    catch (error) { handleError(res, error); }
  });

  addRoute('POST', '/api/board/note/append', async (req, res) => {
    const body = await readBody(req);
    try { json(res, appendBoardNote(body.content)); }
    catch (error) { handleError(res, error); }
  });

  addRoute('POST', '/api/board/tasks', async (req, res) => {
    const body = await readBody(req);
    try { json(res, addBoardTask(body.text, body.checklistId, body.kind, body.questionTo, body.supervisorId), 201); }
    catch (error) { handleError(res, error); }
  });

  addRoute('PATCH', '/api/board/tasks/:id', async (req, res) => {
    const body = await readBody(req);
    try {
      const result = updateBoardTask(req.params.id, body);
      json(res, result || { error: 'Task not found' }, result ? 200 : 404);
    } catch (error) { handleError(res, error); }
  });

  addRoute('DELETE', '/api/board/tasks/:id', (req, res) => {
    try {
      const result = deleteBoardTask(req.params.id);
      json(res, result || { error: 'Task not found' }, result ? 200 : 404);
    } catch (error) { handleError(res, error); }
  });
}
