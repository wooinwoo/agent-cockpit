import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeCheckpoint(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, file);
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(file), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function summaryOf(snapshot) {
  const lines = [`콕핏 작업 기록 · ${new Date(snapshot.savedAt).toLocaleString('ko-KR')}`, '',
    '이 파일은 저장된 업무 상태입니다. 재부팅 전 명령이 성공했다는 뜻은 아닙니다.',
    '다시 시작할 때 실행 중이던 외부 작업의 결과부터 확인하고 중복 실행하지 마세요.', ''];
  for (const review of snapshot.board.supervisors || []) {
    lines.push(`${review.id} · ${review.alias || review.name} · ${review.status}`, `전체 목표: ${review.objective || '없음'}`, `자동 진행: ${review.workerDispatch || 'linked'}`);
    for (const target of review.watched || []) {
      const worker = review.workerProgress?.find(item => item.termId === target.termId && item.goal === target.goal);
      const run = worker?.run || {};
      lines.push('', `${target.alias || target.termId} · ${target.termId}`, `목표: ${target.objective || target.goal}`,
        `완료 조건: ${target.goal}`, `우선순위: ${target.priority || 2} · 일시정지: ${Boolean(target.paused)}`,
        `저장 상태: ${run.status || 'ready'}`, `최근 결과: ${run.summary || '없음'}`,
        `다음 작업: ${run.nextAction || worker?.nextAction || '없음'}`, `막힘: ${run.blocker || worker?.blocker || '없음'}`,
        `작업자 보고 근거: ${run.evidence || '없음'}`, `검증 근거: ${worker?.evidence || '없음'}`);
    }
    lines.push('');
  }
  lines.push('체크리스트·질문');
  for (const task of snapshot.board.tasks || []) lines.push(`[${task.done ? 'x' : ' '}] ${task.id} · ${task.termId || task.supervisorId || ''} · ${task.text}${task.answer ? `\n답변: ${task.answer}` : ''}`);
  lines.push('', '세션 배치');
  for (const terminal of snapshot.sessionState.terminals) lines.push(`${terminal.alias || terminal.termId} · ${terminal.termId} · ${terminal.cwd || ''} · 대화 보호 ${Boolean(terminal.conversationHeld)}`);
  return `${lines.join('\n')}\n`;
}

export function saveRecoveryHistory(directory, { board, sessionState, projects, now = Date.now() }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Keep only project registration fields; credentials and terminal output are not collected.
  const snapshot = { schemaVersion: 1, savedAt: now, board, sessionState,
    projects: { projects: projects.map(({ id, name, path, color, stack }) => ({ id, name, path, color, stack })) } };
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  writeCheckpoint(join(directory, 'latest.json'), json);
  writeCheckpoint(join(directory, '작업요약.txt'), summaryOf(snapshot));
  if (!existsSync(join(directory, '안내.txt'))) writeCheckpoint(join(directory, '안내.txt'),
    '콕핏 복구 히스토리\n\nlatest.json: 마지막 저장 시점의 목표, 체크리스트, 질문·답변, 작업 보고, 세션 배치, 프로젝트 등록 정보입니다. 서버 실행 중 약 30초마다 갱신합니다.\n작업요약.txt: 최근 결과, 다음 작업, 막힌 이유를 읽기 위한 요약입니다.\n날짜_시간.json: UTC 기준 각 시간의 첫 저장본입니다. 최근 50개를 보관합니다.\n\n일반 재부팅 뒤에는 콕핏을 실행하면 원래 데이터 폴더의 설정과 작업 배치를 복원합니다. 저장된 일시정지·대화 보호·운영 기한도 유지합니다. 전원이 꺼질 때 실행 중이던 명령은 완료 여부를 별도로 확인해야 합니다.\n\n데이터가 손상되면 설치 폴더의 scripts/cockpit-history.mjs에 복구본 JSON 절대경로와 새 출력 폴더 절대경로를 전달하세요. 기존 데이터를 덮어쓰지 않고 복구 파일과 안내를 생성합니다.\n\n계정 인증 파일, API 키 설정, 터미널 출력, 채팅 원문과 프로젝트 실제 파일은 수집하지 않습니다. 기존 홈 폴더와 프로젝트를 유지하세요.\n');
  // The first checkpoint in each UTC hour is immutable; retain the latest 50 hours with activity.
  const hourly = `${new Date(now).toISOString().slice(0, 13).replace('T', '_')}.json`;
  if (!existsSync(join(directory, hourly))) writeCheckpoint(join(directory, hourly), json);
  const history = readdirSync(directory).filter(name => /^\d{4}-\d{2}-\d{2}_\d{2}\.json$/.test(name)).sort();
  for (const name of history.slice(0, Math.max(0, history.length - 50))) unlinkSync(join(directory, name));
  return join(directory, 'latest.json');
}

export function exportRecovery(snapshotFile, outputDirectory) {
  if (!isAbsolute(snapshotFile) || !isAbsolute(outputDirectory)) throw new Error('복구본과 출력 폴더는 절대경로로 지정하세요.');
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  if (snapshot.schemaVersion !== 1 || !Number.isFinite(snapshot.savedAt) || !Array.isArray(snapshot.board?.supervisors)
      || !Array.isArray(snapshot.board?.tasks) || !Array.isArray(snapshot.sessionState?.terminals) || !Array.isArray(snapshot.projects?.projects)) {
    throw new Error('지원하는 콕핏 복구본이 아닙니다.');
  }
  // Export only to a new folder. A running server's state must never be replaced here.
  mkdirSync(outputDirectory, { mode: 0o700 });
  for (const [name, value] of [['.cockpit-board.json', snapshot.board], ['session-state.json', snapshot.sessionState], ['projects.json', snapshot.projects]]) {
    writeCheckpoint(join(outputDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  writeCheckpoint(join(outputDirectory, '작업요약.txt'), summaryOf(snapshot));
  writeCheckpoint(join(outputDirectory, '복구안내.txt'), '일반 재부팅은 원래 데이터 폴더를 그대로 읽습니다. 이 내보내기는 데이터 손상 때 사용합니다.\n콕핏 서버를 종료한 뒤 현재 데이터 폴더를 별도로 보관하고, 위 JSON 3개를 데이터 폴더에 복사하세요. COCKPIT_BOARD_FILE을 지정했다면 보드 파일만 그 경로를 사용합니다.\n계정 로그인, 설치된 AI CLI, 프로젝트 실제 파일과 대화 원문은 이 복구본에 포함되지 않습니다. 기존 홈 폴더와 프로젝트를 유지하세요.\n재시작 후 완료 여부가 불확실한 외부 작업부터 확인하세요. 승인 스크립트는 별도로 확인해야 합니다.\n');
  return outputDirectory;
}
