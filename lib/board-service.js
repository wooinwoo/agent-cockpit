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
    supervisionVersion: 5,
    review: normalizeReview(),
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
    recoveryTerminal: value.recoveryTerminal && typeof value.recoveryTerminal === 'object' ? Object.fromEntries(
      ['termId', 'alias', 'projectId', 'command', 'cwd', 'accountId', 'durableId'].map(key => [key, String(value.recoveryTerminal[key] || '').slice(0, 4000)]),
    ) : null,
    reports: (Array.isArray(value.reports) ? value.reports : []).map(item => ({
      at: Number(item.at) || 0, status: String(item.status || '').slice(0, 40), text: String(item.text || '').slice(0, 4000),
    })),
  };
}

function normalizeBoard(input) {
  const source = input && typeof input === 'object' ? input : {};
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
      title: (typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `Checklist ${Number(match[1])}`).slice(0, 80),
      goal: typeof item.goal === 'string' ? item.goal.slice(0, 4000) : '',
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || 0,
    });
  }
  if (!checklists.length && Array.isArray(source.tasks) && source.tasks.some(item => item?.text)) {
    checklists.push({ id: 'C-0001', title: 'Checklist 1', createdAt: now, updatedAt: 0 });
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
    supervisionVersion: 5,
    review: normalizeReview(source.review),
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

export function createBoardService(filePath = BOARD_FILE) {
  const ensureReady = () => {
    if (filePath === BOARD_FILE && migrationError) throw migrationError;
  };
  const mutate = change => {
    ensureReady();
    return withFileLock(filePath, change);
  };
  return {
    getBoard: () => {
      ensureReady();
      return snapshot(readBoard(filePath));
    },
    replaceBoard(value) {
      return mutate(() => {
        const next = normalizeBoard(value);
        return { board: next, result: saved => snapshot(saved) };
      });
    },
    updateBoardReview(updates, expectedReview) {
      return mutate(next => {
        // Schedulers compare the full snapshot: a stop or target change can keep
        // pendingSince at zero. Retain numeric tokens for existing ACK clients.
        const changed = expectedReview && typeof expectedReview === 'object'
          ? JSON.stringify(next.review) !== JSON.stringify(expectedReview)
          : expectedReview !== undefined && (next.review.pendingSince || 0) !== expectedReview;
        if (changed) {
          throw new BoardError('The board review request changed; read the board again', 'BOARD_CONFLICT');
        }
        const previous = next.review;
        next.review = normalizeReview({ ...previous, ...updates,
          ...(updates.termId !== undefined && updates.status === undefined ? { status: updates.termId ? 'running' : 'stopped' } : {}),
        });
        next.review.workerProgress = next.review.watched.map(worker => {
          const saved = previous.objective === next.review.objective && next.review.workerProgress.find(item => item.termId === worker.termId && item.goal === worker.goal);
          return saved || { termId: worker.termId, goal: worker.goal, startedAt: Date.now(), lastProgressAt: 0,
            evidence: '', evidenceKeys: [], blocker: '', nextAction: '', alertedAt: 0 };
        });
        // Review metadata is preserved under the lock by browser replacements.
        // Keep its writes out of the content revision so a reminder cannot block editing.
        return { board: next, metadataOnly: true, result: saved => snapshot(saved) };
      });
    },
    reportBoardReview(pendingSince, { status = 'running', report = '', progress = [] } = {}) {
      if (!['running', 'waiting', 'complete'].includes(status) || typeof report !== 'string' || report.length > 4000) {
        throw new BoardError('점검 상태와 보고 내용(4000자 이하)을 확인하세요.', 'BOARD_VALIDATION');
      }
      return mutate(next => {
        const review = next.review;
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
        }
        if (status === 'complete' && review.watched.some(worker => !progress.some(item =>
          item.termId === worker.termId && item.artifact?.trim() && item.version?.trim() && item.result?.trim()))) {
          throw new BoardError('완료 보고에는 모든 대상의 결과물과 검증 근거를 포함하세요.', 'BOARD_VALIDATION');
        }
        if (report.trim()) review.reports.push({ at: now, status, text: report.trim() });
        Object.assign(review, { status, pendingSince: 0, retryAt: 0, attempts: 0, lastError: '', lastReviewedAt: now,
          recoveryAttempts: 0, recoveryAfter: 0, cycleStartedAt: 0,
          nextDueAt: now + review.intervalMinutes * 60_000 });
        return { board: next, metadataOnly: true, result: saved => snapshot(saved) };
      });
    },
    replaceBoardIfRevision(value, expectedRevision, base) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new BoardError('revision must be a non-negative integer', 'BOARD_VALIDATION');
      }
      return mutate(current => {
        if (current.revision !== expectedRevision && (!base || base.revision !== expectedRevision)) {
          throw new BoardError('Cockpit board changed on another client', 'BOARD_CONFLICT');
        }
        const next = current.revision === expectedRevision ? normalizeBoard(value)
          : normalizeBoard(mergeBoardChanges(normalizeBoard(base), normalizeBoard(value), current));
        // A browser snapshot must not reset delivery or acknowledgement state.
        next.review = current.review;
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
    addBoardTask(text, checklistId, kind = 'task') {
      const clean = cleanText(text, 500, 'text');
      if (!['task', 'question'].includes(kind)) throw new BoardError('Invalid task kind', 'BOARD_VALIDATION');
      return mutate(next => {
        const now = Date.now();
        let checklist = checklistId && next.checklists.find(item => item.id === checklistId);
        if (checklistId && !checklist) throw new BoardError('checklist not found', 'BOARD_VALIDATION');
        if (!checklist) checklist = next.checklists[0];
        if (!checklist) {
          checklist = {
            id: `C-${String(next.nextChecklistNumber++).padStart(4, '0')}`,
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
export const replaceBoard = service.replaceBoard;
export const replaceBoardIfRevision = service.replaceBoardIfRevision;
export const updateBoardNote = service.updateBoardNote;
export const appendBoardNote = service.appendBoardNote;
export const addBoardTask = service.addBoardTask;
export const updateBoardTask = service.updateBoardTask;
export const deleteBoardTask = service.deleteBoardTask;
export const updateBoardReview = service.updateBoardReview;
export const reportBoardReview = service.reportBoardReview;
