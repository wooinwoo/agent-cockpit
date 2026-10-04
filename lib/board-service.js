import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeBoardChanges } from '../js/board-merge.js';
import { normalizeLaunchPermissions } from '../js/agent-permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appData = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), '.local', 'share');
const defaultBoardFile = join(appData, 'cockpit', '.cockpit-board.json');
const packagedRoot = join(__dirname, '..');
const legacyBoardFile = process.env.COCKPIT_LEGACY_BOARD_FILE
  || (existsSync(join(packagedRoot, 'package.json')) ? join(packagedRoot, '.cockpit-board.json') : null);
export const BOARD_FILE = process.env.COCKPIT_BOARD_FILE || defaultBoardFile;
let migrationError = null;

class BoardError extends Error {
  constructor(message, code, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BoardError';
    this.code = code;
  }
}

function emptyBoard() {
  return {
    schemaVersion: 2,
    reviewVersion: 1,
    supervisionVersion: 9,
    review: normalizeReview(),
    supervisors: [normalizeReview()],
    note: { content: '', updatedAt: 0 },
    notes: [],
    checklists: [],
    tasks: [],
    nextNoteNumber: 1,
    nextChecklistNumber: 1,
    nextTaskNumber: 1,
    revision: 0,
    updatedAt: 0,
  };
}

function cleanText(value, limit, field) {
  if (typeof value !== 'string') throw new BoardError(`${field} must be a string`, 'BOARD_VALIDATION');
  const text = value.trim();
  if (!text) throw new BoardError(`${field} is required`, 'BOARD_VALIDATION');
  return text.slice(0, limit);
}

function normalizeReview(value = {}) {
  value ??= {};
  return {
    id: typeof value.id === 'string' && /^S-[a-zA-Z0-9-]+$/.test(value.id) ? value.id : 'S-0001',
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : '감독 1',
    termId: typeof value.termId === 'string' ? value.termId.slice(0, 200) : '',
    alias: typeof value.alias === 'string' ? value.alias.slice(0, 80) : '',
    intervalMinutes: Number.isInteger(value.intervalMinutes) && value.intervalMinutes >= 1 && value.intervalMinutes <= 1440 ? value.intervalMinutes : 5,
    pendingSince: Number(value.pendingSince) || 0,
    lastReviewedAt: Number(value.lastReviewedAt) || 0,
    nextDueAt: Number(value.nextDueAt) || 0,
    objective: typeof value.objective === 'string' ? value.objective.slice(0, 4000) : '',
    referencePaths: (Array.isArray(value.referencePaths) ? value.referencePaths : []).filter(path => typeof path === 'string').slice(0, 30).map(path => path.trim().slice(0, 2000)).filter(Boolean),
    runHours: Number.isInteger(value.runHours) && value.runHours >= 1 && value.runHours <= 24 ? value.runHours : 0,
    runUntil: Number.isFinite(value.runUntil) && value.runUntil > 0 ? value.runUntil : 0,
    watched: (Array.isArray(value.watched) ? value.watched : []).slice(0, 12).filter(item => typeof item?.termId === 'string').map(item => ({
      termId: item.termId.slice(0, 200), alias: String(item.alias || '').slice(0, 80), goal: String(item.goal || '').slice(0, 2000),
    })),
    workerProgress: (Array.isArray(value.workerProgress) ? value.workerProgress : []).slice(0, 12).filter(item => typeof item?.termId === 'string').map(item => ({
      termId: item.termId.slice(0, 200), goal: String(item.goal || '').slice(0, 2000),
      startedAt: Number(item.startedAt) || 0, lastProgressAt: Number(item.lastProgressAt) || 0,
      evidence: String(item.evidence || '').slice(0, 2400),
      evidenceKeys: (Array.isArray(item.evidenceKeys) ? item.evidenceKeys : []).filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)),
      blocker: String(item.blocker || '').slice(0, 1000), nextAction: String(item.nextAction || '').slice(0, 1000),
      alertedAt: Number(item.alertedAt) || 0,
      run: {
        status: ['ready', 'active', 'blocked', 'reported', 'complete'].includes(item.run?.status) ? item.run.status : 'ready',
        token: String(item.run?.token || '').slice(0, 80),
        resumeRequestedAt: Number(item.run?.resumeRequestedAt) || 0, resumeSentAt: Number(item.run?.resumeSentAt) || 0, resumeSubmittedAt: Number(item.run?.resumeSubmittedAt) || 0,
        interventionAt: Number(item.run?.interventionAt) || 0, checkQueuedAt: Number(item.run?.checkQueuedAt) || 0,
        remaining: normalizeRemaining(item.run?.remaining),
        lastSentAt: Number(item.run?.lastSentAt) || 0, reportedAt: Number(item.run?.reportedAt) || 0,
        attempts: Math.max(0, Number(item.run?.attempts) || 0),
        summary: String(item.run?.summary || '').slice(0, 2000),
        blocker: String(item.run?.blocker || '').slice(0, 1000), alternatives: String(item.run?.alternatives || '').slice(0, 1000),
        dependencyKey: String(item.run?.dependencyKey || '').slice(0, 64),
        observed: String(item.run?.observed || 'unknown').slice(0, 20), lastError: String(item.run?.lastError || '').slice(0, 500),
      },
    })),
    status: ['running', 'waiting', 'complete', 'stopped'].includes(value.status) ? value.status : (value.termId ? 'running' : 'stopped'),
    attempts: Math.max(0, Number(value.attempts) || 0),
    retryAt: Number(value.retryAt) || 0,
    lastError: typeof value.lastError === 'string' ? value.lastError.slice(0, 500) : '',
    autoRecover: value.autoRecover === true,
    launchPermissions: normalizeLaunchPermissions(value.launchPermissions),
    recoveryAttempts: Math.max(0, Number(value.recoveryAttempts) || 0),
    recoveryAfter: Number(value.recoveryAfter) || 0,
    stallMinutes: Number.isInteger(value.stallMinutes) && value.stallMinutes >= 5 && value.stallMinutes <= 240 ? value.stallMinutes : 0,
    cycleStartedAt: Number(value.cycleStartedAt) || 0,
    recoveryTerminal: value.recoveryTerminal && typeof value.recoveryTerminal === 'object' ? { ...Object.fromEntries(
      ['termId', 'alias', 'projectId', 'command', 'cwd', 'accountId', 'durableId'].map(key => [key, String(value.recoveryTerminal[key] || '').slice(0, 4000)]),
    ), conversationHeld: value.recoveryTerminal.conversationHeld === true } : null,
    reports: (Array.isArray(value.reports) ? value.reports : []).map(item => ({
      at: Number(item.at) || 0, status: String(item.status || '').slice(0, 40), text: String(item.text || '').slice(0, 4000),
    })),
  };
}

function normalizeBoard(input) {
  const source = input && typeof input === 'object' ? input : {};
  const primary = normalizeReview({ ...(source.review || source.supervisors?.[0]), id: 'S-0001' });
  const supervisors = [primary, ...(Array.isArray(source.supervisors) ? source.supervisors : [])
    .filter((item, index, all) => item?.id !== 'S-0001' && /^S-[a-zA-Z0-9-]+$/.test(item?.id) && all.findIndex(other => other.id === item.id) === index)
    .map(normalizeReview)];
  const now = Date.now();
  const legacyNote = {
    id: 'N-0001',
    title: 'Memo 1',
    content: typeof source.note?.content === 'string' ? source.note.content.slice(0, 12_000) : '',
    createdAt: Number(source.note?.updatedAt) || now,
    updatedAt: Number(source.note?.updatedAt) || 0,
  };
  const notes = [];
  const seenNotes = new Set();
  let highestNote = 0;
  const noteSource = Array.isArray(source.notes) ? source.notes : [legacyNote];
  for (const item of noteSource) {
    const match = /^N-(\d{4,})$/.exec(String(item?.id || ''));
    if (!match || seenNotes.has(item.id)) continue;
    seenNotes.add(item.id);
    highestNote = Math.max(highestNote, Number(match[1]));
    notes.push({
      id: item.id,
      title: (typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `Memo ${Number(match[1])}`).slice(0, 80),
      content: typeof item.content === 'string' ? item.content.slice(0, 12_000) : '',
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || 0,
    });
  }
  const checklists = [];
  const seenChecklists = new Set();
  let highestChecklist = 0;
  const checklistSource = Array.isArray(source.checklists)
    ? source.checklists
    : [{ id: 'C-0001', title: 'Checklist 1', createdAt: now, updatedAt: 0 }];
  for (const item of checklistSource) {
    const match = /^C-(\d{4,})$/.exec(String(item?.id || ''));
    if (!match || seenChecklists.has(item.id)) continue;
    seenChecklists.add(item.id);
    highestChecklist = Math.max(highestChecklist, Number(match[1]));
    checklists.push({
      id: item.id,
      supervisorId: supervisors.some(supervisor => supervisor.id === item.supervisorId) ? item.supervisorId : 'S-0001',
      title: (typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `Checklist ${Number(match[1])}`).slice(0, 80),
      goal: typeof item.goal === 'string' ? item.goal.slice(0, 4000) : '',
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || 0,
    });
  }
  if (!checklists.length && Array.isArray(source.tasks) && source.tasks.some(item => item?.text)) {
    checklists.push({ id: 'C-0001', supervisorId: 'S-0001', title: 'Checklist 1', createdAt: now, updatedAt: 0 });
    seenChecklists.add('C-0001');
    highestChecklist = 1;
  }
  const defaultChecklistId = checklists[0]?.id || '';
  const seen = new Set();
  let highest = 0;
  const tasks = [];
  for (const item of Array.isArray(source.tasks) ? source.tasks : []) {
    const match = /^T-(\d{4,})$/.exec(String(item?.id || ''));
    const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 500) : '';
    if (!match || !text || seen.has(item.id)) continue;
    seen.add(item.id);
    highest = Math.max(highest, Number(match[1]));
    tasks.push({
      id: item.id,
      text,
      done: item.done === true,
      kind: item.kind === 'question' ? 'question' : 'task',
      ...(item.kind === 'question' ? { questionTo: item.questionTo === 'supervisor' ? 'supervisor' : 'user' } : {}),
      answer: typeof item.answer === 'string' ? item.answer.slice(0, 4000) : '',
      checklistId: seenChecklists.has(item.checklistId) ? item.checklistId : defaultChecklistId,
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || now,
    });
  }
  const primaryNote = notes[0] || { content: '', updatedAt: 0 };
  return {
    schemaVersion: 2,
    reviewVersion: 1,
    supervisionVersion: 9,
    review: primary,
    supervisors,
    // Kept as a projection of the first memo for older CLI clients.
    note: { content: primaryNote.content, updatedAt: primaryNote.updatedAt },
    notes,
    checklists,
    tasks,
    nextNoteNumber: Math.max(highestNote + 1, Number(source.nextNoteNumber) || 1),
    nextChecklistNumber: Math.max(highestChecklist + 1, Number(source.nextChecklistNumber) || 1),
    nextTaskNumber: Math.max(highest + 1, Number(source.nextTaskNumber) || 1),
    revision: Math.max(0, Number(source.revision) || 0),
    updatedAt: Number(source.updatedAt) || 0,
  };
}

function snapshot(board) {
  return structuredClone(board);
}

export function supervisorBoard(board, supervisorId = 'S-0001') {
  const review = (board.supervisors || [board.review]).find(item => (item.id || 'S-0001') === supervisorId);
  if (!review) throw new BoardError('감독을 찾지 못했습니다.', 'BOARD_VALIDATION');
  const checklists = board.checklists.filter(list => (list.supervisorId || 'S-0001') === supervisorId);
  return { ...board, scopeSupervisorId: supervisorId, review, checklists, tasks: board.tasks.filter(task => checklists.some(list => list.id === task.checklistId)) };
}

function storageError(action, error) {
  if (error instanceof BoardError) return error;
  return new BoardError(`Unable to ${action} Cockpit board: ${error.message}`, 'BOARD_STORAGE', error);
}

function readBoard(filePath) {
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyBoard();
    throw storageError('read', error);
  }
  try { return normalizeBoard(JSON.parse(raw)); }
  catch (error) {
    throw new BoardError(`Cockpit board is corrupt JSON: ${error.message}`, 'BOARD_CORRUPT', error);
  }
}

function persistBoard(filePath, board) {
  const directory = dirname(filePath);
  const temp = join(directory, `.${fileURLToPath(import.meta.url).split(/[\\/]/).pop()}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    mkdirSync(directory, { recursive: true });
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, filePath);
    if (process.platform !== 'win32') {
      const directoryFd = openSync(directory, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temp); } catch { /* temp did not exist */ }
    throw storageError('write', error);
  }
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function releaseDeadWriter(lockPath) {
  try {
    const entries = readdirSync(lockPath);
    const owner = entries.length === 1 && /^owner-([1-9]\d*)-[a-f0-9-]{36}$/.exec(entries[0]);
    // ponytail: legacy/partially created locks have no provable owner. Leave them
    // for inspection rather than expiring a potentially live writer by age.
    if (!owner || !Number.isSafeInteger(Number(owner[1]))) return;
    try { process.kill(Number(owner[1]), 0); return; }
    catch (error) { if (error.code !== 'ESRCH') return; }
    // Only the contender that removes this unique marker may remove its folder.
    // Other contenders must not delete the lock of a subsequent writer.
    unlinkSync(join(lockPath, owner[0]));
    rmdirSync(lockPath);
  } catch { /* Another writer can acquire/release the lock while we inspect it. */ }
}

function withFileLock(filePath, mutate) {
  const lockPath = `${filePath}.lock`;
  const ownerPath = join(lockPath, `owner-${process.pid}-${randomUUID()}`);
  const deadline = Date.now() + 3000;
  mkdirSync(dirname(filePath), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw storageError('lock', error);
      if (Date.now() >= deadline) throw new BoardError('Cockpit board is busy; try again', 'BOARD_BUSY');
      releaseDeadWriter(lockPath);
      Atomics.wait(lockWait, 0, 0, 20);
    }
  }
  try {
    writeFileSync(ownerPath, '', { flag: 'wx', mode: 0o600 });
    const current = readBoard(filePath);
    const mutation = mutate(snapshot(current));
    if (!mutation) return null;
    mutation.board.revision = current.revision + (mutation.metadataOnly ? 0 : 1);
    mutation.board.updatedAt = Date.now();
    persistBoard(filePath, mutation.board);
    return mutation.result(mutation.board);
  } finally {
    try { unlinkSync(ownerPath); } catch { /* owner marker was not created */ }
    try { rmdirSync(lockPath); } catch { /* lock cleanup is best effort */ }
  }
}

if (!process.env.COCKPIT_BOARD_FILE && legacyBoardFile && !existsSync(BOARD_FILE) && existsSync(legacyBoardFile)) {
  try {
    withFileLock(BOARD_FILE, current => {
      if (current.revision || current.updatedAt || current.note.content || current.tasks.length) return null;
      const legacy = readBoard(legacyBoardFile);
      return { board: legacy, result: saved => snapshot(saved) };
    });
  } catch (error) {
    migrationError = storageError('migrate', error);
  }
}

function normalizeRemaining(value) {
  return (Array.isArray(value) ? value : []).slice(0, 30).map(item => ({
    condition: String(item?.condition || '').slice(0, 1000),
    blocker: String(item?.blocker || '').slice(0, 1000),
    nextAction: String(item?.nextAction || '').slice(0, 1000),
  }));
}

function validateBlocked(blocker, alternatives, remaining) {
  if (typeof blocker !== 'string' || !blocker.trim() || typeof alternatives !== 'string' || !alternatives.trim()
      || alternatives.length > 1000 || !Array.isArray(remaining) || !remaining.length || remaining.length > 30
      || remaining.some(item => !item || typeof item.condition !== 'string' || !item.condition.trim() || item.condition.length > 1000
        || typeof item.blocker !== 'string' || !item.blocker.trim() || item.blocker.length > 1000
        || typeof item.nextAction !== 'string' || !item.nextAction.trim() || item.nextAction.length > 1000)) {
    throw new BoardError('전체 대기에는 blocker, alternatives와 모든 남은 조건별 remaining[{condition,blocker,nextAction}]이 필요합니다. 가능한 조건은 계속 실행하세요.', 'BOARD_VALIDATION');
  }
}

export function workerDependencyKey(board, termId) {
  return createHash('sha256').update(JSON.stringify([
    board.tasks.map(task => [task.id, task.answer || '', task.done]),
    board.review.workerProgress.filter(worker => worker.termId !== termId).map(worker => [worker.termId, worker.evidence]),
  ])).digest('hex');
}

export function createBoardService(filePath = BOARD_FILE) {
  const ensureReady = () => {
    if (filePath === BOARD_FILE && migrationError) throw migrationError;
  };
  const mutate = change => {
    ensureReady();
    return withFileLock(filePath, change);
  };
  return {
    getBoard: supervisorId => {
      ensureReady();
      const board = readBoard(filePath);
      return snapshot(supervisorId ? supervisorBoard(board, supervisorId) : board);
    },
    addBoardSupervisor(name) {
      const clean = cleanText(name, 80, 'name');
      return mutate(next => {
        if (next.supervisors.length >= 12) throw new BoardError('감독은 최대 12개입니다.', 'BOARD_VALIDATION');
        const supervisor = normalizeReview({ id: `S-${randomUUID()}`, name: clean });
        next.supervisors.push(supervisor);
        return { board: next, result: saved => ({ board: snapshot(saved), supervisor }) };
      });
    },
    replaceBoard(value) {
      return mutate(() => {
        const next = normalizeBoard(value);
        return { board: next, result: saved => snapshot(saved) };
      });
    },
    updateBoardReview(updates, expectedReview, supervisorId = 'S-0001') {
      return mutate(next => {
        const selected = supervisorBoard(next, supervisorId).review;
        // Schedulers compare the full snapshot: a stop or target change can keep
        // pendingSince at zero. Retain numeric tokens for existing ACK clients.
        const changed = expectedReview && typeof expectedReview === 'object'
          ? JSON.stringify(selected) !== JSON.stringify(expectedReview)
          : expectedReview !== undefined && (selected.pendingSince || 0) !== expectedReview;
        if (changed) {
          throw new BoardError('The board review request changed; read the board again', 'BOARD_CONFLICT');
        }
        const previous = selected;
        const review = normalizeReview({ ...previous, ...updates, id: supervisorId,
          ...(updates.termId !== undefined && updates.status === undefined ? { status: updates.termId ? 'running' : 'stopped' } : {}),
        });
        if (review.termId && !['stopped', 'complete'].includes(review.status)) {
          const assigned = new Set([review.termId, ...review.watched.map(worker => worker.termId)]);
          if (next.supervisors.some(other => other.id !== supervisorId && other.termId && !['stopped', 'complete'].includes(other.status)
            && [other.termId, ...other.watched.map(worker => worker.termId)].some(id => assigned.has(id)))) {
            throw new BoardError('다른 실행 중인 감독에 배정된 AI입니다. 기존 감독을 중지하거나 다른 AI를 선택하세요.', 'BOARD_VALIDATION');
          }
        }
        review.workerProgress = review.watched.map(worker => {
          const saved = previous.objective === review.objective && review.workerProgress.find(item => item.termId === worker.termId && item.goal === worker.goal);
          return saved || { termId: worker.termId, goal: worker.goal, startedAt: Date.now(), lastProgressAt: 0,
            evidence: '', evidenceKeys: [], blocker: '', nextAction: '', alertedAt: 0 };
        });
        // A stop or reassignment revokes old worker report tokens as well as supervisor requests.
        if (previous.termId !== review.termId || ['stopped', 'complete'].includes(review.status)) {
          review.workerProgress.forEach(worker => { if (worker.run) { worker.run.token = ''; worker.run.resumeRequestedAt = 0; worker.run.resumeSentAt = 0; worker.run.resumeSubmittedAt = 0; } });
        }
        next.supervisors[next.supervisors.findIndex(item => item.id === supervisorId)] = review;
        next.review = next.supervisors[0];
        // Review metadata is preserved under the lock by browser replacements.
        // Keep its writes out of the content revision so a reminder cannot block editing.
        return { board: next, metadataOnly: true, result: saved => snapshot(supervisorBoard(saved, supervisorId)) };
      });
    },
    reportBoardReview(pendingSince, { status = 'running', report = '', progress = [], supervisorId = 'S-0001' } = {}) {
      if (!['running', 'waiting', 'complete'].includes(status) || typeof report !== 'string' || report.length > 4000) {
        throw new BoardError('점검 상태와 보고 내용(4000자 이하)을 확인하세요.', 'BOARD_VALIDATION');
      }
      return mutate(next => {
        const review = supervisorBoard(next, supervisorId).review;
        if (!pendingSince || review.pendingSince !== pendingSince || !review.termId) {
          throw new BoardError('현재 점검 요청이 아닙니다. 보드를 다시 조회하세요.', 'BOARD_CONFLICT');
        }
        if ((review.watched.length || status === 'complete') && !report.trim()) {
          throw new BoardError('점검 결과와 완료 판단의 근거를 기록하세요.', 'BOARD_VALIDATION');
        }
        const now = Date.now();
        if (!Array.isArray(progress) || progress.length > 12) throw new BoardError('대상별 진전 기록은 최대 12개입니다.', 'BOARD_VALIDATION');
        const seen = new Set();
        for (const item of progress) {
          const worker = review.workerProgress.find(worker => worker.termId === item?.termId);
          if (!worker || seen.has(item.termId) || ['artifact', 'version', 'result', 'blocker', 'nextAction'].some(key =>
            item[key] !== undefined && (typeof item[key] !== 'string' || item[key].length > 1000))) {
            throw new BoardError('진전 기록의 대상과 근거·원인·다음 조치(각 1000자 이하)를 확인하세요.', 'BOARD_VALIDATION');
          }
          seen.add(item.termId);
          const artifact = (item.artifact || '').trim();
          const version = (item.version || '').trim();
          const result = (item.result || '').trim();
          if (item.workState !== undefined && !['ready', 'blocked', 'complete'].includes(item.workState)) {
            throw new BoardError('작업자 상태는 ready, blocked, complete 중 하나입니다.', 'BOARD_VALIDATION');
          }
          if (item.workState === 'complete' && !(artifact && version && result)) {
            throw new BoardError('작업자 완료 확정에는 검증한 결과물과 버전, 결과가 필요합니다.', 'BOARD_VALIDATION');
          }
          if (item.workState === 'blocked') validateBlocked(item.blocker, item.alternatives, item.remaining);
          if ((artifact || version || result) && !(artifact && version && result)) {
            throw new BoardError('새 결과 근거에는 artifact, version, result가 모두 필요합니다.', 'BOARD_VALIDATION');
          }
          if (artifact) {
            // A repeated result, including A → B → A, must not reset the clock.
            // The supervisor must verify this identity against the actual artifact.
            const key = createHash('sha256').update(JSON.stringify([artifact, version])).digest('hex');
            if (!worker.evidenceKeys.includes(key)) {
              worker.evidenceKeys.push(key);
              worker.lastProgressAt = now;
              worker.alertedAt = 0;
              worker.evidence = `${artifact}\n${version}\n${result}`.slice(0, 2400);
            }
          }
          worker.blocker = (item.blocker || '').trim();
          worker.nextAction = (item.nextAction || '').trim();
          if (item.workState) {
            worker.run = { ...worker.run, status: item.workState,
              token: item.workState === 'ready' ? worker.run.token : '',
              ...(item.workState === 'blocked' ? { blocker: item.blocker, alternatives: item.alternatives, remaining: normalizeRemaining(item.remaining), reportedAt: now } : {}),
              ...(item.workState === 'ready' ? { blocker: '', alternatives: '', remaining: [] } : {}),
              dependencyKey: workerDependencyKey(supervisorBoard(next, supervisorId), worker.termId) };
          }
        }
        if (status === 'complete' && review.watched.some(worker => !progress.some(item =>
          item.termId === worker.termId && item.artifact?.trim() && item.version?.trim() && item.result?.trim()))) {
          throw new BoardError('완료 보고에는 모든 대상의 결과물과 검증 근거를 포함하세요.', 'BOARD_VALIDATION');
        }
        if (report.trim()) review.reports.push({ at: now, status, text: report.trim() });
        Object.assign(review, { status, pendingSince: 0, retryAt: 0, attempts: 0, lastError: '', lastReviewedAt: now,
          recoveryAttempts: 0, recoveryAfter: 0, cycleStartedAt: 0,
          nextDueAt: now + review.intervalMinutes * 60_000 });
        return { board: next, metadataOnly: true, result: saved => snapshot(supervisorBoard(saved, supervisorId)) };
      });
    },
    reportBoardWorker({ supervisorId = 'S-0001', termId, token, status, summary, blocker = '', alternatives = '', remaining = [] }) {
      if (!['working', 'blocked', 'complete'].includes(status) || typeof summary !== 'string' || !summary.trim() || summary.length > 2000
          || typeof blocker !== 'string' || blocker.length > 1000 || typeof alternatives !== 'string' || alternatives.length > 1000
          || (status === 'blocked' && (!blocker.trim() || !alternatives.trim()))) {
        throw new BoardError('작업자 보고에는 상태와 근거가 필요하며, blocked에는 원인과 독립 대안 검토 결과가 필요합니다.', 'BOARD_VALIDATION');
      }
      if (status === 'blocked') validateBlocked(blocker, alternatives, remaining);
      return mutate(next => {
        const board = supervisorBoard(next, supervisorId);
        const review = board.review;
        const worker = review.workerProgress.find(item => item.termId === termId);
        if (!review.termId || ['complete', 'stopped'].includes(review.status) || (review.runUntil && review.runUntil <= Date.now())
            || !worker || !token || worker.run.token !== token || !review.watched.some(item => item.termId === termId && item.goal === worker.goal)) {
          throw new BoardError('현재 작업자 요청이 아닙니다. 보드를 다시 조회하세요.', 'BOARD_CONFLICT');
        }
        worker.run = { ...worker.run, status: status === 'complete' ? 'reported' : status === 'working' ? 'active' : 'blocked',
          summary: summary.trim(), blocker: blocker.trim(), alternatives: alternatives.trim(), remaining: status === 'blocked' ? normalizeRemaining(remaining) : [],
          reportedAt: Date.now(), attempts: 0, dependencyKey: workerDependencyKey(board, termId) };
        // Worker claims wake the aggregator, but never count as verified goal progress.
        review.nextDueAt = Date.now();
        return { board: next, metadataOnly: true, result: saved => snapshot(supervisorBoard(saved, supervisorId)) };
      });
    },
    resumeBoardWorker({ supervisorId = 'S-0001', termId }) {
      return mutate(next => {
        const review = supervisorBoard(next, supervisorId).review;
        const worker = review.workerProgress.find(item => item.termId === termId);
        if (!worker || !review.termId || ['stopped', 'complete'].includes(review.status)
            || (review.runUntil && review.runUntil <= Date.now())) {
          throw new BoardError('실행 중인 감독의 작업자만 재개할 수 있습니다.', 'BOARD_CONFLICT');
        }
        worker.run = { ...worker.run, resumeRequestedAt: Date.now(), resumeSentAt: 0, resumeSubmittedAt: 0, lastError: '' };
        review.nextDueAt = Date.now();
        return { board: next, metadataOnly: true, result: saved => snapshot(supervisorBoard(saved, supervisorId)) };
      });
    },
    replaceBoardIfRevision(value, expectedRevision, base) {
      if (value?.scopeSupervisorId || base?.scopeSupervisorId) throw new BoardError('감독별 조회 결과로 전체 보드를 덮어쓸 수 없습니다. 항목별 API를 사용하세요.', 'BOARD_VALIDATION');
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new BoardError('revision must be a non-negative integer', 'BOARD_VALIDATION');
      }
      return mutate(current => {
        if (current.revision !== expectedRevision && (!base || base.revision !== expectedRevision)) {
          throw new BoardError('Cockpit board changed on another client', 'BOARD_CONFLICT');
        }
        // Older clients omit questionTo; their unrelated edits must retain the recipient.
        const retainRecipients = board => ({ ...board, tasks: board?.tasks?.map(task => task.kind === 'question' && task.questionTo === undefined
          ? { ...task, questionTo: current.tasks.find(saved => saved.id === task.id)?.questionTo || 'user' } : task) });
        const next = current.revision === expectedRevision ? normalizeBoard(retainRecipients(value))
          : normalizeBoard(mergeBoardChanges(normalizeBoard(retainRecipients(base)), normalizeBoard(retainRecipients(value)), current));
        // A browser snapshot must not reset delivery or acknowledgement state.
        next.review = current.review;
        next.supervisors = current.supervisors;
        for (const list of next.checklists) {
          const saved = current.checklists.find(item => item.id === list.id);
          if (saved) list.supervisorId = saved.supervisorId;
        }
        return { board: next, result: saved => snapshot(saved) };
      });
    },
    updateBoardNote(content) {
      if (typeof content !== 'string') throw new BoardError('content must be a string', 'BOARD_VALIDATION');
      return mutate(next => {
        const now = Date.now();
        const note = next.notes[0] || {
          id: `N-${String(next.nextNoteNumber++).padStart(4, '0')}`,
          title: 'Memo 1',
          content: '',
          createdAt: now,
          updatedAt: 0,
        };
        if (!next.notes.length) next.notes.push(note);
        note.content = content.slice(0, 12_000);
        note.updatedAt = now;
        next.note = { content: note.content, updatedAt: note.updatedAt };
        return { board: next, result: saved => snapshot(saved) };
      });
    },
    appendBoardNote(content) {
      const extra = cleanText(content, 12_000, 'content');
      return mutate(next => {
        const now = Date.now();
        const note = next.notes[0] || {
          id: `N-${String(next.nextNoteNumber++).padStart(4, '0')}`,
          title: 'Memo 1',
          content: '',
          createdAt: now,
          updatedAt: 0,
        };
        if (!next.notes.length) next.notes.push(note);
        const separator = note.content ? '\n' : '';
        if (note.content.length + separator.length + extra.length > 12_000) {
          throw new BoardError('content exceeds the 12000 character note limit', 'BOARD_VALIDATION');
        }
        note.content = `${note.content}${separator}${extra}`;
        note.updatedAt = now;
        next.note = { content: note.content, updatedAt: note.updatedAt };
        return { board: next, result: saved => snapshot(saved) };
      });
    },
    addBoardTask(text, checklistId, kind = 'task', questionTo = 'user', supervisorId) {
      const clean = cleanText(text, 500, 'text');
      if (!['task', 'question'].includes(kind)) throw new BoardError('Invalid task kind', 'BOARD_VALIDATION');
      if (!['user', 'supervisor'].includes(questionTo)) throw new BoardError('Invalid question recipient', 'BOARD_VALIDATION');
      return mutate(next => {
        const now = Date.now();
        let checklist = checklistId && next.checklists.find(item => item.id === checklistId);
        if (checklistId && !checklist) throw new BoardError('checklist not found', 'BOARD_VALIDATION');
        const owner = supervisorId || checklist?.supervisorId || 'S-0001';
        supervisorBoard(next, owner);
        if (checklist && (checklist.supervisorId || 'S-0001') !== owner) throw new BoardError('다른 감독의 체크리스트입니다.', 'BOARD_VALIDATION');
        if (!checklist) checklist = next.checklists.find(list => (list.supervisorId || 'S-0001') === owner);
        if (!checklist) {
          checklist = {
            id: `C-${String(next.nextChecklistNumber++).padStart(4, '0')}`,
            supervisorId: owner,
            title: 'Checklist 1',
            createdAt: now,
            updatedAt: 0,
          };
          next.checklists.push(checklist);
        }
        const task = {
          id: `T-${String(next.nextTaskNumber++).padStart(4, '0')}`,
          text: clean,
          done: false,
          kind,
          ...(kind === 'question' ? { questionTo } : {}),
          answer: '',
          checklistId: checklist.id,
          createdAt: now,
          updatedAt: now,
        };
        next.tasks.push(task);
        return { board: next, result: saved => ({ board: snapshot(saved), task: { ...task } }) };
      });
    },
    updateBoardTask(id, updates = {}) {
      return mutate(next => {
        const task = next.tasks.find(item => item.id === id);
        if (!task) return null;
        if (updates.text !== undefined) task.text = cleanText(updates.text, 500, 'text');
        if (updates.done !== undefined) task.done = updates.done === true;
        if (updates.answer !== undefined) {
          if (task.kind !== 'question' || typeof updates.answer !== 'string' || updates.answer.length > 4000) {
            throw new BoardError('A question answer must be a string of at most 4000 characters', 'BOARD_VALIDATION');
          }
          task.answer = updates.answer;
        }
        task.updatedAt = Date.now();
        return { board: next, result: saved => ({ board: snapshot(saved), task: { ...task } }) };
      });
    },
    deleteBoardTask(id) {
      return mutate(next => {
        const index = next.tasks.findIndex(item => item.id === id);
        if (index < 0) return null;
        const [task] = next.tasks.splice(index, 1);
        return { board: next, result: saved => ({ board: snapshot(saved), task }) };
      });
    },
  };
}

const service = createBoardService();
export const getBoard = service.getBoard;
export const addBoardSupervisor = service.addBoardSupervisor;
export const replaceBoard = service.replaceBoard;
export const replaceBoardIfRevision = service.replaceBoardIfRevision;
export const updateBoardNote = service.updateBoardNote;
export const appendBoardNote = service.appendBoardNote;
export const addBoardTask = service.addBoardTask;
export const updateBoardTask = service.updateBoardTask;
export const deleteBoardTask = service.deleteBoardTask;
export const updateBoardReview = service.updateBoardReview;
export const reportBoardReview = service.reportBoardReview;
export const reportBoardWorker = service.reportBoardWorker;

export const resumeBoardWorker = service.resumeBoardWorker;
