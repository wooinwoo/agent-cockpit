import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Use the production 15-second timer, private tmux panes, and fake Codex TTYs.
// No test clock, injected tick endpoint, account, or external AI is involved.
export async function verifyWorkerTerminals({ api, check, until, observed, directory, fixture, monitor, checkpoint, tmux, restart, connect, url }) {
  const folder = join(fixture.project, 'workers');
  await mkdir(folder);
  const eventsPath = join(folder, 'events');
  await writeFile(eventsPath, '');
  const labels = ['low', 'high', 'held', 'paused'];
  for (const label of labels) await writeFile(join(folder, `mode-${label}`), 'idle');
  await writeFile(join(folder, 'codex'), `#!${process.execPath}
import fs from 'node:fs';
const label=process.argv[2], folder=${JSON.stringify(folder)};
const screens={idle:['› Ask Codex to do anything','GPT-6.1-Sol xhigh'],busy:['Working (esc to interrupt)','›'],paused:['›','GPT-6.1-Sol Goal paused'],resume:['› /goal resume','GPT-6.1-Sol Goal paused']};
let current='',composer='',buffer='';
function render(mode){composer=mode;process.stdout.write('\\x1b[2J\\x1b[H'+screens[mode].join('\\r\\n'));}
function poll(){const next=fs.readFileSync(folder+'/mode-'+label,'utf8');if(next!==current){current=next;render(next.split('\\n')[0]);}}
function record(kind,data){fs.appendFileSync(folder+'/events',JSON.stringify({label,kind,data,at:Date.now()})+'\\n');}
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();process.stdout.write('\\x1b[?2004h');poll();setInterval(poll,20);
process.stdin.on('data',chunk=>{buffer+=chunk.toString();
  const resume='\\x1b[200~/goal resume\\x1b[201~';
  if(buffer===resume){record('resume-draft',buffer);buffer='';render('resume');return;}
  if(buffer==='\\r'&&composer==='resume'){record('resume-enter',buffer);buffer='';render('idle');return;}
  if(buffer.endsWith('\\x1b[201~\\r')){const data=buffer;buffer='';record(data.includes('[콕핏 작업자 정체 점검]')?'stall':'assignment',data);render('busy');}
});
`, { mode: 0o700 });
  const boardPath = join(directory, '.cockpit-board.json');
  const original = Buffer.from(JSON.stringify((await api('/api/board')).data));
  const terminals = {};
  const send = (method, route, body) => api(`/api/board/${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const readBoard = async () => (await api('/api/board')).data;
  const saveBoard = board => { board.review = board.supervisors[0]; return writeFile(boardPath, JSON.stringify(board)); };
  const events = async () => (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const assignments = async label => (await events()).filter(event => event.label === label && event.kind === 'assignment');
  const setMode = async (label, mode) => {
    const path = join(folder, `mode-${label}`); await writeFile(path + '.next', `${mode}\n${Date.now()}`); await rename(path + '.next', path);
    await observed(terminals[label].termId, mode === 'paused' ? 'paused' : mode);
  };
  const configureWorker = async (label, patch) => {
    const current = (await readBoard()).review.watched.find(worker => worker.termId === terminals[label].termId);
    const expected = Object.fromEntries(['objective', 'goal', 'priority', 'paused'].map(key => [key, current[key]]));
    check((await send('PATCH', 'worker-settings', { termId: current.termId, expected, settings: { ...expected, ...patch } })).status, 200, 'Update worker settings');
  };
  const run = (board, label) => board.review.workerProgress.find(worker => worker.termId === terminals[label].termId).run;
  const wait = (fn, label, timeout = 55_000) => until(fn, label, timeout);
  let failure;
  try {
    for (const label of labels) {
      const cursor = monitor.messages.length;
      monitor.send({ type: 'create', projectId: 'sample', command: `node workers/codex ${label}`, cols: 140, rows: 35 });
      terminals[label] = await until(() => monitor.messages.slice(cursor).find(m => m.type === 'created'), `Worker ${label}`);
      await observed(terminals[label].termId, 'idle');
    }
    check((await send('PUT', 'review', { target: '', objective: '감독 없이 저장된 목표 진행', referencePaths: ['/fixture/참고 자료', 'https://example.invalid/reference'],
      watched: labels.map(label => ({ target: terminals[label].termId, goal: `${label} 완료 조건` })) })).status, 200, 'Configure workers without a manager');
    for (const label of labels) await configureWorker(label, { objective: `${label} 독립 본업`, priority: label === 'high' ? 1 : label === 'low' ? 3 : 2, paused: label === 'paused' });
    for (let i = 0; i < 9; i++) check((await send('POST', 'tasks', { text: `검증할 체크리스트 ${i}`, termId: terminals.high.termId })).status, 201, 'Create worker checklist');
    const lowTask = (await send('POST', 'tasks', { text: 'low 독립 구현', termId: terminals.low.termId })).data.task;
    const dependency = (await send('POST', 'tasks', { text: 'fixture dependency answer', kind: 'question', questionTo: 'user' })).data.task;
    check((await api(`/api/terminals/${terminals.held.termId}/conversation`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ held: true }) })).status, 200, 'Hold conversation before automatic dispatch');
    const previousDispatch = (await readBoard()).review.workerDispatch;
    check((await send('PATCH', 'worker-dispatch', { mode: 'running', expected: previousDispatch })).status, 200, 'Enable independent dispatch');
    const initial = await readBoard();
    const revision = initial.revision;
    await wait(async () => (await assignments('high')).length === 1 && (await assignments('low')).length === 1, 'Independent worker assignments');
    let board = await readBoard();
    check(board.review.status, 'stopped', 'Workers run while manager is stopped');
    check(board.revision, revision, 'Scheduler preserves content revision');
    const first = (await events()).filter(event => event.kind === 'assignment');
    check(first.map(event => event.label), ['high', 'low'], 'Priority controls dispatch order; held and paused workers excluded');
    for (const label of ['high', 'low']) {
      check(first.find(event => event.label === label).data.includes(`보고 token: ${run(board, label).token}`), true, 'Persist token before delivery');
      check(run(board, label).attempts, 1, 'Claim one initial attempt');
    }

    // Generate the original Node message using only memory-backed stubs in the
    // copied app and its isolated home. Compare complete wire bytes, not keywords.
    const oracle = join(folder, 'oracle.mjs');
    const oracleInput = join(folder, 'oracle.json');
    await writeFile(oracleInput, JSON.stringify({ board: initial, time: run(board, 'high').lastSentAt,
      held: terminals.held.termId, port: Number(new URL(url()).port) }));
    await writeFile(oracle, `import fs from 'node:fs';
import { createBoardWorkerRunner } from ${JSON.stringify(new URL('file://' + join(fixture.directory, 'app/lib/board-workers.js')).href)};
const input=JSON.parse(fs.readFileSync(${JSON.stringify(oracleInput)},'utf8'));let board=input.board,time=input.time-15001;const writes=[];
const tick=createBoardWorkerRunner({getBoard:()=>board,updateBoardReview:(updates,_expected,id)=>{const review={...board.supervisors.find(r=>r.id===id),...updates};board.supervisors=board.supervisors.map(r=>r.id===id?review:r);board.review=board.supervisors[0];return {...board,review};},
resolveTerminalRef:id=>({id,entry:{conversationHeld:id===input.held}}),terminalAgent:()=> 'codex',readTerminalScreen:()=>({current:true,lines:['› Ask Codex to do anything','GPT-6.1-Sol xhigh']}),sendAgentInput:(id,data)=>writes.push({id,data}),PORT:input.port,now:()=>time});
tick(board.review.id);time=input.time;tick(board.review.id);process.stdout.write(JSON.stringify({writes,workers:board.review.workerProgress}));
`);
    const expected = JSON.parse(execFileSync(process.execPath, ['--import', join(fixture.directory, 'isolate-home.mjs'), oracle], { env: fixture.env, encoding: 'utf8', timeout: 5000 }));
    for (const event of first) {
      const message = expected.writes.find(item => item.id === terminals[event.label].termId).data;
      const token = /보고 token: ([^\n]+)/.exec(message)[1];
      check(event.data, message.replaceAll(token, run(board, event.label).token), 'Native worker instruction matches complete Node wire message');
      check(run(board, event.label).taskDispatchKey, expected.workers.find(item => item.termId === terminals[event.label].termId).run.taskDispatchKey, 'Native one-shot dispatch identity matches Node');
    }
    console.log(JSON.stringify({ phase: 'worker-priority-and-message', status: 'passed' }));

    for (const task of board.tasks.filter(task => task.termId === terminals.high.termId)) {
      check((await send('PATCH', `tasks/${task.id}`, { done: true })).status, 200, 'Verified high checklist completion');
    }
    check((await send('POST', 'worker-report', { termId: terminals.low.termId, token: run(board, 'low').token,
      status: 'blocked', summary: '성급한 전체 대기', blocker: 'fixture answer', alternatives: '대기 주장',
      remaining: [{ condition: 'low 완료 조건', blocker: 'fixture answer', nextAction: '답변 적용' }] })).status, 400, 'Ready checklist rejects whole-worker waiting');
    check((await send('PATCH', `tasks/${lowTask.id}`, { status: 'blocked', blocker: 'fixture answer', waitFor: [dependency.id] })).status, 200, 'Link task to a real dependency');
    check((await send('POST', 'worker-report', { termId: terminals.high.termId, token: run(board, 'high').token,
      status: 'complete', summary: '가짜 작업 결과', artifact: '/fixture/result', version: 'v1', result: 'PASS' })).status, 200, 'Worker reports completion evidence');
    check((await send('POST', 'worker-report', { termId: terminals.low.termId, token: run(board, 'low').token,
      status: 'blocked', summary: '확인 답변 필요', blocker: 'fixture answer', alternatives: '다른 완료 조건 없음',
      remaining: [{ condition: 'low 완료 조건', blocker: 'fixture answer', nextAction: '답변 적용' }] })).status, 200, 'Worker reports all remaining dependencies');
    board = await readBoard();
    const waitingWorker = board.review.workerProgress.find(worker => worker.termId === terminals.low.termId);
    waitingWorker.run.reportedAt = Date.now() - 3_600_000;
    waitingWorker.run.lastSentAt = Date.now() - 3_600_000;
    waitingWorker.startedAt = Date.now() - 3_600_000;
    waitingWorker.lastProgressAt = 0; waitingWorker.run.progressAt = 0; waitingWorker.run.interventionAt = 0;
    board.supervisors[0] = board.review; await saveBoard(board);
    await setMode('high', 'idle'); await setMode('low', 'idle');
    check((await send('PATCH', `tasks/${dependency.id}`, { text: '같은 외부 조건의 질문 문구만 정리' })).status, 200, 'Edit unanswered dependency wording');
    check((await readBoard()).tasks.find(task => task.id === lowTask.id).status, 'blocked', 'Question wording cannot release a blocked task');
    check((await api(`/api/terminals/${terminals.held.termId}/conversation`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ held: false }) })).status, 200, 'Release worker conversation');
    await wait(async () => (await assignments('held')).length === 1, 'Released worker resumes independently');
    board = await readBoard();
    check(run(board, 'high').status, 'reported', 'Worker completion awaits manager verification');
    check((await assignments('high')).length, 1, 'Reported completion is not redispatched');
    check((await assignments('low')).length, 1, 'Hour-old unchanged blocked dependency does not poll the model');
    check(run(board, 'low').interventionAt, 0, 'Known unchanged blocker does not trigger repeated stall reviews');
    check((await assignments('paused')).length, 0, 'User-paused worker stays idle across ticks');
    const blockedToken = run(board, 'low').token;
    check((await send('PATCH', `tasks/${dependency.id}`, { answer: '진행 가능' })).status, 200, 'Record dependency answer');
    await setMode('held', 'paused');
    await wait(async () => (await assignments('low')).length === 2, 'Changed dependency bypasses blocked cooldown');
    board = await readBoard();
    check(run(board, 'low').token !== blockedToken, true, 'Redispatch claims a fresh token');
    check(run(board, 'low').taskId, lowTask.id, 'Dispatcher selects the released task');
    check(board.tasks.find(task => task.id === lowTask.id).status, 'ready', 'Dependency answer releases the queued task');
    check((await events()).some(event => event.kind.startsWith('resume')), false, 'Paused CLI never resumes without explicit request');
    check((await send('POST', 'worker-resume', { termId: terminals.held.termId, goal: 'held 완료 조건', token: run(board, 'held').token })).status, 200, 'Explicit one-shot worker resume');

    // Persist old evidence timestamps as after a long-running task or restart.
    board = await readBoard();
    const low = board.review.workerProgress.find(worker => worker.termId === terminals.low.termId);
    low.startedAt = Date.now() - 360_000; low.lastProgressAt = 0; low.run.progressAt = 0;
    low.run.lastSentAt = Date.now() - 360_000;
    low.run.interventionAt = 0; low.run.checkQueuedAt = 0;
    board.supervisors[0] = board.review; await saveBoard(board);
    await wait(async () => (await events()).some(event => event.kind === 'resume-draft'), 'Resume command placed in composer');
    await wait(async () => (await events()).some(event => event.kind === 'resume-enter'), 'Resume submitted only after exact composer');
    await observed(terminals.held.termId, 'idle');
    const actions = await events();
    check(actions.filter(event => event.kind.startsWith('resume')).map(event => event.kind), ['resume-draft', 'resume-enter'], 'Resume uses one ordered two-step sequence');
    check(actions.filter(event => event.kind === 'stall').length, 1, 'Stalled busy worker receives one follow-up');
    board = await readBoard();
    check(run(board, 'low').interventionAt > 0 && run(board, 'low').checkQueuedAt > 0, true, 'Stall intervention persisted');
    check(board.review.nextDueAt <= Date.now(), true, 'Stall requests manager review');
    check((await send('POST', 'worker-report', { termId: terminals.low.termId, token: run(board, 'low').token,
      status: 'working', summary: '격리된 새 중간 결과', artifact: '/fixture/idle-result', version: 'v2', result: 'PASS' })).status, 200, 'New evidence opens a separate diagnostic interval');
    board = await readBoard();
    const quiet = board.review.workerProgress.find(worker => worker.termId === terminals.low.termId);
    quiet.startedAt = Date.now() - 360_000; quiet.lastProgressAt = 0;
    quiet.run.progressAt = Date.now() - 360_000; quiet.run.lastSentAt = Date.now() - 360_000;
    quiet.run.interventionAt = 0; quiet.run.checkQueuedAt = 0;
    board.supervisors[0] = board.review; await saveBoard(board);
    await setMode('low', 'idle');
    await wait(async () => (await events()).filter(event => event.label === 'low' && event.kind === 'stall').length === 2, 'Idle unfinished queue receives one diagnosis without a manager');
    const diagnosis = (await events()).filter(event => event.label === 'low' && event.kind === 'stall').at(-1);
    check(diagnosis.data.includes(lowTask.id), true, 'Idle diagnosis names the actual queued task');
    check(diagnosis.data.includes('[콕핏 작업자 목표 계속 실행]'), false, 'Idle diagnosis never replays the full goal');
    console.log(JSON.stringify({ phase: 'worker-dependency-resume-and-stall', status: 'passed' }));
    board.review.runUntil = Date.now() - 1; board.supervisors[0] = board.review; await saveBoard(board);
    const countAtExpiry = (await events()).length;
    await new Promise(resolve => setTimeout(resolve, 17_000));
    check((await events()).length, countAtExpiry, 'Expired operating deadline prevents every automatic input');

    board = await readBoard(); board.review.runUntil = 0; board.supervisors[0] = board.review; await saveBoard(board);
    await configureWorker('high', { goal: '재시작 후 새 완료 조건' });
    check((await send('PATCH', `tasks/${lowTask.id}`, { status: 'blocked', blocker: '추가 원전 확인 필요', waitFor: [dependency.id] })).status, 200, 'Park only after consuming the current answer');
    board = await readBoard();
    check((await send('POST', 'worker-report', { termId: terminals.low.termId, token: run(board, 'low').token,
      status: 'blocked', summary: '새 의존성 대기', blocker: '추가 원전 확인 필요', alternatives: '남은 등록 작업은 동일 조건에 의존',
      remaining: [{ condition: 'low 완료 조건', blocker: '추가 원전 확인 필요', nextAction: '다음 원전 적용' }] })).status, 200, 'Persist current queue wait before restart');
    await setMode('low', 'idle');
    const beforeRestart = (await checkpoint()).terminals.find(t => t.termId === terminals.high.termId);
    const pane = tmux(beforeRestart.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']);
    const lowToken = run(await readBoard(), 'low').token;
    await restart();
    // Deliberately leave every browser websocket disconnected until dispatch.
    await wait(async () => (await assignments('high')).length === 2, 'Headless restart restores and dispatches saved worker goal');
    check(tmux(beforeRestart.durableId, ['display-message', '-p', '-t', 'main', '#{pane_pid}']), pane, 'Headless restore attaches existing worker process');
    check((await assignments('high'))[1].data.includes('재시작 후 새 완료 조건'), true, 'Headless dispatch uses saved goal');
    check((await assignments('high'))[1].data.includes(`http://127.0.0.1:${new URL(url()).port}/api/board`), true, 'Restored worker receives current server port');
    check(run(await readBoard(), 'low').token, lowToken, 'Restart preserves the unchanged queue wait and token');
    check((await assignments('low')).length, 2, 'Restart does not duplicate a blocked task');
    check((await assignments('paused')).length, 0, 'Restart preserves individual pause');

    await configureWorker('high', { paused: true });
    await setMode('high', 'idle');
    const pausedRun = run(await readBoard(), 'high');
    await new Promise(resolve => setTimeout(resolve, 17_000));
    check((await assignments('high')).length, 2, 'Individually paused assignment never continues automatically');
    await configureWorker('high', { paused: false });
    board = await readBoard();
    check(run(board, 'high').token, pausedRun.token, 'Unpausing preserves the current report token until delivery');
    check(run(board, 'high').taskDispatchKey, '', 'Unpausing clears only the resumed dispatch identity');
    check(run(board, 'low').token, lowToken, 'Unpausing another worker preserves the blocked worker token');
    await wait(async () => (await assignments('high')).length === 3, 'Individual unpause continues the same saved assignment once');
    await setMode('high', 'idle');
    await configureWorker('high', { paused: false });
    await new Promise(resolve => setTimeout(resolve, 17_000));
    check((await assignments('high')).length, 3, 'Later ticks and unchanged settings never duplicate a resume');
    check((await assignments('low')).length, 2, 'Individual unpause never redispatches another worker');
    console.log(JSON.stringify({ phase: 'worker-individual-unpause', status: 'passed' }));
  } catch (error) { failure = error; }
  finally {
    try {
      await writeFile(boardPath, original);
      if (monitor.ws.readyState !== 1) monitor = await connect();
      for (const terminal of Object.values(terminals)) {
        monitor.send({ type: 'kill', termId: terminal.termId, confirm: true });
        const receipt = await monitor.wait(m => m.type === 'kill-result' && m.termId === terminal.termId);
        check(receipt.accepted, true, 'Private worker close is acknowledged');
      }
    } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
}
