import test from 'node:test';
import assert from 'node:assert/strict';
import { getSessionActivity } from '../../js/agent-wall-state.js';

const now = 1_000_000;
function board() {
  return { supervisors: [{ id: 'S-1', name: '배포 감독', termId: 'supervisor', status: 'running', objective: '배포 검증',
    watched: [{ termId: 'worker', goal: '설치 검증' }],
    workerProgress: [{ termId: 'worker', goal: '설치 검증', startedAt: now - 600_000, lastProgressAt: now - 360_000,
      evidence: '검증 영수증', nextAction: '인증 연결', run: { status: 'blocked', observed: 'idle', summary: '설치 확인 완료',
        blocker: '등록 정보 필요', reportedAt: now - 30_000 } }],
    reports: [{ text: '작업자 결과 취합 중', at: now - 10_000 }],
  }] };
}

test('keeps reports, actual evidence age and blockers separate from a working spinner', () => {
  const activity = getSessionActivity({ termId: 'worker', board: board(), now, lines: ['◦ Working (3m • esc to interrupt)'] });
  assert.equal(activity.label, '실행 중');
  assert.equal(activity.source, '최근 보고');
  assert.equal(activity.task, '설치 확인 완료');
  assert.equal(activity.reportedAt, now - 30_000);
  assert.equal(activity.progressAt, now - 360_000);
  assert.equal(activity.stalled, true);
  assert.equal(activity.blocker, '등록 정보 필요');
});

test('does not attribute other sessions or obsolete goal reports to a worker', () => {
  const b = board();
  b.supervisors[0].workerProgress[0].goal = '이전 목표';
  const activity = getSessionActivity({ termId: 'worker', board: b, now });
  assert.equal(activity.task, '설치 검증');
  assert.equal(activity.source, '목표');
  assert.equal(activity.blocker, '');
  assert.equal(activity.progressAt, 0);
  assert.equal(getSessionActivity({ termId: 'other', board: b, now }).task, '아직 작업 보고가 없습니다.');
});

test('shows supervisor reports and keeps paused or completed states distinct', () => {
  assert.equal(getSessionActivity({ termId: 'supervisor', board: board(), now }).task, '작업자 결과 취합 중');
  const b = board();
  const run = b.supervisors[0].workerProgress[0].run;
  run.status = 'reported';
  assert.equal(getSessionActivity({ termId: 'worker', board: b, now }).label, '완료 검증 대기');
  run.status = 'complete';
  const complete = getSessionActivity({ termId: 'worker', board: b, now });
  assert.equal(complete.label, '목표 완료 확인');
  assert.equal(complete.stalled, false);
  assert.equal(complete.blocker, '');
  assert.equal(getSessionActivity({ termId: 'other', lines: ['GPT-6-Sol Goal paused (/goal resume)'], now }).label, '목표 일시정지');
});

test('uses current screen activity for unassigned sessions, never a composer placeholder', () => {
  const activity = getSessionActivity({ termId: 'other', now,
    summary: { text: '오래된 요약', at: 123 },
    lines: ['• Running npm test', '› Ask Codex to do anything', 'GPT-6.1-Sol xhigh'] });
  assert.equal(activity.task, '• Running npm test');
  assert.equal(activity.source, '최근 화면');
  assert.equal(activity.reportedAt, 0);
  assert.equal(activity.progressAt, 0);
  assert.equal(activity.label, '입력 대기');
});

test('prefers an active assignment over a stopped supervisor with newer history', () => {
  const b = board();
  const stopped = structuredClone(b.supervisors[0]);
  stopped.id = 'S-2'; stopped.status = 'stopped'; stopped.workerProgress[0].run.reportedAt = now;
  stopped.workerProgress[0].run.summary = '중지된 감독의 보고';
  b.supervisors.unshift(stopped);
  assert.equal(getSessionActivity({ termId: 'worker', board: b, now }).task, '설치 확인 완료');
  stopped.status = 'complete';
  assert.equal(getSessionActivity({ termId: 'worker', board: b, now }).task, '설치 확인 완료');
  stopped.reports[0].text = '이전 감독 보고';
  assert.equal(getSessionActivity({ termId: 'supervisor', board: b, now }).task, '작업자 결과 취합 중');
});

test('recognizes a supervisor approval dialog but ignores a quoted dialog above the composer', () => {
  const lines = ['Would you like to run the following command?', '› 1. Yes, proceed (y)', '  2. No (esc)'];
  assert.equal(getSessionActivity({ termId: 'supervisor', board: board(), lines, now }).label, '승인 대기');
  lines.push('› Ask Codex to do anything');
  assert.equal(getSessionActivity({ termId: 'supervisor', board: board(), lines, now }).label, '입력 대기');
});
