import { WORKER_PROGRESS_DEADLINE } from './worker-progress.js';

export function getAgentKind(command, text) {
  const value = `${command} ${text}`.toLowerCase();
  if (/\bcodex\b/.test(value)) return 'Codex';
  if (/\bclaude\b/.test(value)) return 'Claude';
  if (/\bopencode\b/.test(value)) return 'OpenCode';
  return null;
}

export function getAgentTask(summary, lines) {
  if (summary?.trim()) return summary.trim();
  const prompts = [...lines].reverse().map(line => line.trim()).filter(Boolean);
  const prompt = prompts.find(line => /^[›❯>]\s*\S/.test(line));
  return (prompt ? prompt.replace(/^[›❯>]\s*/, '') : prompts[0])?.slice(0, 120) || '작업 정보 없음';
}

export function getAgentGoal(goal, lines) {
  if (goal?.trim()) return goal.trim();
  const prompt = lines.map(line => line.trim()).find(line => /^[›❯>]\s*\S/.test(line));
  return prompt?.replace(/^[›❯>]\s*/, '').slice(0, 240) || '';
}

// Presentation only: reports are not proof that a process is making progress.
export function getSessionActivity({ termId, board, summary = {}, lines = [], now = Date.now() }) {
  const reviews = board?.supervisors || (board?.review ? [board.review] : []);
  const active = review => ['running', 'waiting'].includes(review.status);
  const assignments = reviews.flatMap(review => {
    const target = review.watched?.find(item => item.termId === termId);
    const worker = target && review.workerProgress?.find(item => item.termId === termId && item.goal === target.goal);
    return target ? [{ review, target, worker }] : [];
  }).sort((a, b) => Number(active(b.review)) - Number(active(a.review))
    || (b.worker?.run?.reportedAt || 0) - (a.worker?.run?.reportedAt || 0));
  const { review, target, worker } = assignments[0] || {};
  const managed = reviews.filter(item => item.termId === termId).sort((a, b) => Number(active(b)) - Number(active(a))
    || (b.reports?.at(-1)?.at || 0) - (a.reports?.at(-1)?.at || 0))[0];
  const run = worker?.run || {};
  const report = managed?.reports?.at(-1);
  const liveLine = [...lines].reverse().map(line => line.trim()).find(line =>
    /^(?:[•◦]\s*)?(?:Running |Ran |Exploring\b|Explored\b)/.test(line)
    || /^•\s+[가-힣]/.test(line));
  const task = run.summary || report?.text || liveLine || summary.text || target?.goal || managed?.objective || '아직 작업 보고가 없습니다.';
  const source = run.summary || report?.text ? '최근 보고' : liveLine ? '최근 화면' : summary.text ? '화면 요약' : target?.goal || managed?.objective ? '목표' : '작업';
  const reportedAt = run.summary ? run.reportedAt : report?.text ? report.at : summary.text && !liveLine ? summary.at : 0;
  const busy = lines.some(line => /^\s*[•◦]?\s*Working\s*\(/.test(line));
  const paused = lines.some(line => /^\s*GPT-\S+.*Goal paused\b/.test(line));
  const composer = lines.findLastIndex(line => /^\s*[›❯>]\s*(?:Ask Codex to do anything)?\s*$/.test(line));
  const choice = lines.findLastIndex(line => /^\s*[›❯>]?\s*1\.\s*(?:Yes|Allow|Trust|Update)\b/i.test(line));
  // Ignore approval examples quoted above a later live composer.
  const approval = choice > composer && lines.slice(choice + 1).some(line => /^\s*[›❯>]?\s*2\.\s*\S/.test(line));
  let state = 'idle', label = '상태 확인 중';
  if (approval) { state = 'waiting'; label = '승인 대기'; }
  else if (busy) { state = 'busy'; label = '실행 중'; }
  else if (paused || run.observed === 'paused') { state = 'waiting'; label = '목표 일시정지'; }
  else if (run.observed === 'approval') { state = 'waiting'; label = '승인·로그인 확인'; }
  else if (run.status === 'blocked') { state = 'waiting'; label = '막힘 보고'; }
  else if (run.status === 'reported') { label = '완료 검증 대기'; }
  else if (run.status === 'complete') { state = 'done'; label = '목표 완료 확인'; }
  else if (run.observed === 'idle' || lines.some(line => /^\s*[›❯>]\s*(?:Ask Codex to do anything)?\s*$/.test(line))) label = '입력 대기';
  const progressAt = worker?.lastProgressAt || 0;
  const stalled = Boolean(worker && !['complete', 'stopped'].includes(review.status) && run.status !== 'complete'
    && now - (progressAt || worker.startedAt || now) >= WORKER_PROGRESS_DEADLINE);
  return {
    role: managed ? '감독' : target ? `작업자 · ${review.name || review.id}` : '개별 세션',
    state, label, task, source, reportedAt, progressAt, stalled,
    blocker: run.status === 'blocked' ? run.blocker || worker?.blocker || '' : '',
    nextAction: worker?.nextAction || '', evidence: worker?.evidence || '',
    goal: target?.goal || managed?.objective || summary.goal || '',
    supervisionStopped: Boolean((review || managed)?.status === 'stopped'),
  };
}

export function getAgentState({ exited, output, projectState, lastOutputAt, now = Date.now() }) {
  if (exited) return 'done';
  if (/\b(approve|permission|confirm|continue\?|waiting for input|press enter)\b/i.test(output)) return 'waiting';
  if (/\besc to interrupt\b/i.test(output)) return 'busy';
  if (Number.isFinite(lastOutputAt) && now - lastOutputAt < 5000) return 'busy';
  return projectState === 'busy' || projectState === 'waiting' ? projectState : 'idle';
}

export function getAgentAttention(decisions, projectPath, now = Date.now()) {
  const root = String(projectPath || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  if (!root) return null;
  const latest = [...decisions].reverse().find(d => {
    const cwd = String(d.cwd || '').replace(/\\/g, '/').toLowerCase();
    const ts = new Date(d.ts).getTime();
    return (cwd === root || cwd.startsWith(`${root}/`))
      && Number.isFinite(ts) && now - ts < 10 * 60_000;
  });
  return latest && ['ask', 'block', 'deny'].includes(latest.decision) ? latest : null;
}

export function getAgentAttentionForTerm({ hook, decisions, projectPath, projectAgentCount, lastOutputAt, now = Date.now() }) {
  const resumedAfterPrompt = Number.isFinite(lastOutputAt) && lastOutputAt > hook?.updatedAt + 1500;
  if (hook?.state === 'waiting' && !resumedAfterPrompt) return { decision: 'ask', reason: hook.reason, ts: hook.updatedAt };
  return projectAgentCount === 1 ? getAgentAttention(decisions, projectPath, now) : null;
}

export function getOperationalState(agentState, gateState, attention) {
  if (attention) return 'waiting';
  return agentState;
}

export function getWallSummary(agents) {
  return {
    total: agents.length,
    working: agents.filter(agent => agent.state === 'busy').length,
    waiting: agents.filter(agent => agent.state === 'waiting').length,
    hold: agents.filter(agent => agent.gate.state === 'hold').length,
    ready: agents.filter(agent => agent.gate.state === 'ready').length,
  };
}

export function getReleaseGate({ git, prs = [], runs, attention }) {
  if (attention) return { state: 'hold', label: 'HOLD', reason: attention.decision === 'ask' ? 'Approval needed' : 'Blocked by policy', target: 'terminal' };
  if (!git) return { state: 'unknown', label: 'NO EVIDENCE', reason: 'Git status unavailable', target: 'changes' };
  if (git.uncommittedCount) return { state: 'hold', label: 'HOLD', reason: `${git.uncommittedCount} uncommitted changes`, target: 'changes' };

  const head = git.recentCommits?.[0]?.hash;
  if (!head || !Array.isArray(runs)) return { state: 'unknown', label: 'NO EVIDENCE', reason: 'CI status unavailable', target: 'cicd' };
  const sameCommit = runs.filter(r => r.headBranch === git.branch && r.headSha && (r.headSha.startsWith(head) || head.startsWith(r.headSha)));
  if (!sameCommit.length) return { state: 'unknown', label: 'NO EVIDENCE', reason: 'No CI run for current commit', target: 'cicd' };

  const latestByWorkflow = [...sameCommit]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .filter((run, i, all) => all.findIndex(x => (x.workflowName || x.name) === (run.workflowName || run.name)) === i);
  if (latestByWorkflow.some(r => r.status === 'queued' || r.status === 'in_progress')) return { state: 'checking', label: 'CHECKING', reason: 'CI is running', target: 'cicd' };
  if (latestByWorkflow.some(r => r.conclusion !== 'success')) return { state: 'hold', label: 'HOLD', reason: 'Current commit CI did not pass', target: 'cicd' };

  const pr = prs.find(p => p.branch === git.branch && p.state === 'OPEN');
  if (pr?.isDraft) return { state: 'hold', label: 'HOLD', reason: 'Pull request is draft', target: 'pr' };
  if (pr?.mergeable === 'CONFLICTING') return { state: 'hold', label: 'HOLD', reason: 'Pull request has conflicts', target: 'pr' };
  if (pr?.reviewDecision !== undefined && pr.reviewDecision !== 'APPROVED') return { state: 'hold', label: 'HOLD', reason: pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Review pending', target: 'pr' };
  if (pr?.checks?.some(c => !['SUCCESS', 'success'].includes(c.conclusion))) return { state: 'hold', label: 'HOLD', reason: 'Pull request checks did not pass', target: 'pr' };
  return { state: 'ready', label: 'READY', reason: pr ? 'Clean, reviewed, current commit CI passed' : 'Clean, current commit CI passed', target: 'cicd' };
}
