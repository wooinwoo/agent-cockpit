import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoardService } from '../../lib/board-service.js';

describe('board-service', () => {
  let dir;
  let file;
  let service;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cockpit-board-'));
    file = join(dir, 'board.json');
    service = createBoardService(file);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('assigns stable task IDs and persists task state', () => {
    const first = service.addBoardTask('첫 작업');
    const second = service.addBoardTask('둘째 작업');
    assert.equal(first.task.id, 'T-0001');
    assert.equal(second.task.id, 'T-0002');

    const completed = service.updateBoardTask(first.task.id, { done: true });
    assert.equal(completed.task.done, true);
    assert.equal(createBoardService(file).getBoard().tasks[0].done, true);
  });

  it('stores a sticky note and removes a task by ID', () => {
    service.updateBoardNote('잊지 말 것');
    const { task } = service.addBoardTask('삭제할 작업');
    assert.equal(service.deleteBoardTask(task.id).task.id, 'T-0001');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.note.content, '잊지 말 것');
    assert.deepEqual(saved.tasks, []);
  });

  it('rejects empty tasks and returns null for unknown IDs', () => {
    assert.throws(() => service.addBoardTask('   '), /text is required/);
    assert.equal(service.updateBoardTask('T-9999', { done: true }), null);
    assert.equal(service.deleteBoardTask('T-9999'), null);
  });

  it('normalizes imported state and advances the ID sequence', () => {
    service.replaceBoard({
      note: { content: 'memo' },
      tasks: [{ id: 'T-0042', text: 'existing', done: false }],
      nextTaskNumber: 2,
    });
    assert.equal(service.addBoardTask('next').task.id, 'T-0043');
  });

  it('migrates the legacy singleton board into the first memo and checklist', () => {
    service.replaceBoard({
      note: { content: 'legacy memo', updatedAt: 123 },
      tasks: [{ id: 'T-0007', text: 'legacy task', done: false }],
    });
    const saved = service.getBoard();
    assert.equal(saved.schemaVersion, 2);
    assert.equal(saved.notes[0].id, 'N-0001');
    assert.equal(saved.notes[0].content, 'legacy memo');
    assert.equal(saved.checklists[0].id, 'C-0001');
    assert.equal(saved.tasks[0].checklistId, 'C-0001');
  });

  it('keeps multiple memos and checklist tasks independent', () => {
    service.replaceBoard({
      schemaVersion: 2,
      notes: [
        { id: 'N-0001', title: 'Memo 1', content: 'first' },
        { id: 'N-0002', title: 'Memo 2', content: 'second' },
      ],
      checklists: [
        { id: 'C-0001', title: 'Checklist 1' },
        { id: 'C-0002', title: 'Checklist 2' },
      ],
      tasks: [{ id: 'T-0001', checklistId: 'C-0001', text: 'first list', done: false }],
    });
    const created = service.addBoardTask('second list', 'C-0002');
    const saved = service.getBoard();
    assert.equal(saved.notes[0].content, 'first');
    assert.equal(saved.notes[1].content, 'second');
    assert.equal(created.task.checklistId, 'C-0002');
    assert.deepEqual(saved.tasks.map(task => task.checklistId), ['C-0001', 'C-0002']);
  });

  it('re-reads under a file lock so separate writers do not lose tasks', () => {
    const other = createBoardService(file);
    assert.equal(service.addBoardTask('first').task.id, 'T-0001');
    assert.equal(other.addBoardTask('second').task.id, 'T-0002');
    assert.deepEqual(service.getBoard().tasks.map(task => task.text), ['first', 'second']);
  });

  it('recovers a lock whose writer was killed, preserving the previous board', { timeout: 15_000 }, async () => {
    service.addBoardTask('보존할 작업');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createBoardService } from ${JSON.stringify(new URL('../../lib/board-service.js', import.meta.url).href)};
      import { writeSync } from 'node:fs';
      createBoardService(process.argv[1]).replaceBoard({ get notes() {
        writeSync(1, 'locked\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }});
    `, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      await Promise.race([once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }), exited.then(() => { throw new Error('Writer exited before acquiring the lock'); })]);
      child.kill('SIGKILL');
      await exited;
      service.addBoardTask('복구 후 작업');
      assert.deepEqual(service.getBoard().tasks.map(task => task.text), ['보존할 작업', '복구 후 작업']);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  });

  it('never steals a lock from a live writer or an unidentified legacy writer', () => {
    mkdirSync(`${file}.lock`);
    const marker = join(`${file}.lock`, `owner-${process.pid}-12345678-1234-1234-1234-123456789abc`);
    writeFileSync(marker, '');
    assert.throws(() => service.addBoardTask('must wait'), error => error.code === 'BOARD_BUSY');
    assert.equal(readFileSync(marker, 'utf8'), '');
    rmSync(marker);
    assert.throws(() => service.addBoardTask('unknown owner'), error => error.code === 'BOARD_BUSY');
    assert.equal(service.getBoard().tasks.length, 0);
  });

  it('serializes simultaneous processes without losing tasks or assigning duplicate IDs', { timeout: 15_000 }, async () => {
    const children = Array.from({ length: 4 }, (_, index) => spawn(process.execPath, ['--input-type=module', '-e', `
      import { createBoardService } from ${JSON.stringify(new URL('../../lib/board-service.js', import.meta.url).href)};
      const board = createBoardService(process.argv[1]);
      for (let i = 0; i < 10; i++) board.addBoardTask(process.argv[2] + '-' + i);
    `, file, String(index)], { stdio: ['ignore', 'ignore', 'pipe'] }));
    const diagnostics = children.map(child => {
      const chunks = [];
      child.stderr.on('data', chunk => chunks.push(chunk));
      return () => Buffer.concat(chunks).toString();
    });
    try {
      const results = await Promise.all(children.map(child => once(child, 'exit', { signal: AbortSignal.timeout(10_000) })));
      assert.ok(results.every(([code]) => code === 0), diagnostics.map(read => read()).join('\n'));
      const tasks = service.getBoard().tasks;
      assert.equal(tasks.length, 40);
      assert.equal(new Set(tasks.map(task => task.id)).size, 40);
      assert.equal(new Set(tasks.map(task => task.text)).size, 40);
    } finally {
      await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(async child => {
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      }));
    }
  });

  it('refuses to overwrite corrupt JSON', () => {
    writeFileSync(file, '{not json', 'utf8');
    assert.throws(() => service.getBoard(), /corrupt JSON/);
    assert.throws(() => service.addBoardTask('must not overwrite'), /corrupt JSON/);
    assert.equal(readFileSync(file, 'utf8'), '{not json');
  });

  it('appends notes atomically through the service mutation path', () => {
    service.updateBoardNote('first');
    service.appendBoardNote('second');
    assert.equal(service.getBoard().note.content, 'first\nsecond');
    assert.equal(service.getBoard().revision, 2);
  });

  it('rejects an append that would truncate the new content', () => {
    service.updateBoardNote('x'.repeat(12_000));
    assert.throws(() => service.appendBoardNote('must remain whole'), /12000 character note limit/);
    assert.equal(service.getBoard().note.content.length, 12_000);
    assert.equal(service.getBoard().revision, 1);
  });

  it('imports a local snapshot only when the expected revision still matches', () => {
    const imported = service.replaceBoardIfRevision({
      note: { content: 'offline' },
      tasks: [{ id: 'T-0007', text: 'keep this ID', done: false }],
    }, 0);
    assert.equal(imported.revision, 1);
    assert.equal(imported.tasks[0].id, 'T-0007');
    assert.throws(() => service.replaceBoardIfRevision({ tasks: [] }, 0), error => error.code === 'BOARD_CONFLICT');
    assert.equal(service.getBoard().tasks[0].id, 'T-0007');
  });

  it('merges an answer while the manager adds another question and completes a task', () => {
    const question = service.addBoardTask('어디에 배포?', undefined, 'question').task;
    const task = service.addBoardTask('검증 실행').task;
    const base = service.getBoard();
    const edited = structuredClone(base);
    edited.tasks[0].answer = '스테이징';
    edited.checklists[0].goal = '배포 후 상태 확인';
    const added = service.addBoardTask('언제 배포?', undefined, 'question').task;
    service.updateBoardTask(task.id, { done: true });
    const merged = service.replaceBoardIfRevision(edited, base.revision, base);
    assert.equal(merged.tasks.find(item => item.id === question.id).answer, '스테이징');
    assert.equal(merged.tasks.find(item => item.id === task.id).done, true);
    assert.ok(merged.tasks.some(item => item.id === added.id));
    assert.equal(merged.checklists[0].goal, '배포 후 상태 확인');
  });

  it('preserves legacy questions and round-trips answers, resolution, reopening and deletion', () => {
    service.replaceBoard({ tasks: [{ id: 'T-0042', kind: 'question', text: '기존 질문', answer: '기존 답변', done: true }] });
    assert.equal(service.getBoard().tasks[0].questionTo, 'user');
    const { task } = service.addBoardTask('진행 상황은?', undefined, 'question', 'supervisor');
    assert.equal(task.id, 'T-0043');
    service.updateBoardTask(task.id, { answer: '검증 중' });
    assert.equal(service.getBoard().tasks[1].done, false);
    service.updateBoardTask(task.id, { done: true });
    const saved = createBoardService(file).getBoard();
    assert.equal(saved.tasks[0].answer, '기존 답변');
    assert.equal(saved.tasks[0].done, true);
    assert.equal(saved.tasks[1].questionTo, 'supervisor');
    assert.equal(saved.tasks[1].answer, '검증 중');
    assert.equal(saved.tasks[1].done, true);
    service.updateBoardTask(task.id, { done: false });
    assert.equal(service.getBoard().tasks[1].answer, '검증 중');
    service.deleteBoardTask(task.id);
    assert.deepEqual(service.getBoard().tasks.map(item => item.id), ['T-0042']);
    assert.throws(() => service.addBoardTask('invalid', undefined, 'question', 'worker'), error => error.code === 'BOARD_VALIDATION');
  });

  it('retains question direction when older clients omit it from current and stale replacements', () => {
    service.addBoardTask('내 질문', undefined, 'question', 'supervisor');
    const legacy = service.getBoard();
    delete legacy.tasks[0].questionTo;
    legacy.checklists[0].goal = '이전 클라이언트 목표 수정';
    service.replaceBoardIfRevision(legacy, legacy.revision);
    assert.equal(service.getBoard().tasks[0].questionTo, 'supervisor');
    const base = service.getBoard();
    delete base.tasks[0].questionTo;
    const local = structuredClone(base);
    local.checklists[0].goal = '동시 수정';
    service.updateBoardTask(base.tasks[0].id, { answer: '새 답변' });
    const merged = service.replaceBoardIfRevision(local, base.revision, base);
    assert.equal(merged.tasks[0].questionTo, 'supervisor');
    assert.equal(merged.tasks[0].answer, '새 답변');
    assert.equal(merged.checklists[0].goal, '동시 수정');
  });

  it('never overwrites a conflicting answer or a concurrently added question on list deletion', () => {
    const { task } = service.addBoardTask('배포 대상?', undefined, 'question');
    const base = service.getBoard();
    const local = structuredClone(base);
    local.tasks[0].answer = '스테이징';
    service.updateBoardTask(task.id, { answer: '운영' });
    assert.throws(() => service.replaceBoardIfRevision(local, base.revision, base), error => error.code === 'BOARD_CONFLICT');
    assert.equal(service.getBoard().tasks[0].answer, '운영');
    const current = service.getBoard();
    service.addBoardTask('보존 기간?', undefined, 'question');
    assert.throws(() => service.replaceBoardIfRevision({ ...current, checklists: [], tasks: [] }, current.revision, current), error => error.code === 'BOARD_CONFLICT');
    assert.equal(service.getBoard().tasks.length, 2);
  });
});
