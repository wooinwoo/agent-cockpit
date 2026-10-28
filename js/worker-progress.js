import { workerProgressAt } from './worker-settings.js';

export const WORKER_PROGRESS_DEADLINE = 5 * 60_000;

// jcode renders the input cursor as "3>" when idle and "3…" while running.
// Accept only the observed empty composer and its context meter, never a draft.
export function jcodeScreenState(lines, inspectComposer = false) {
  const content = lines.map(line => line.trim()).filter(Boolean);
  // 0.91 places the path, context meter, and Claude model below the composer.
  // Strip only that observed status row; wrapped user text must remain blocking.
  if (/^(?:~(?:\/\S*)?|\/\S+)\s+(?:(?:[\w./…-]+|[~?↑↓±]\d+|[▱▰]+)\s+)*\d+%\s+(?:OAuth\s+)?(?:(?:Claude\s+)?(?:Opus|Sonnet|Haiku)\s+[\d.]+|(?:OpenAI\s+)?GPT-[A-Za-z\d.]+(?:\s+[A-Za-z\d.]+)?)\s+(?:low|medium|high|xhigh|max)$/.test(content.at(-1) || '')) content.pop();
  const last = content.at(-1) || '';
  const busy = /^\d+…/.test(last);
  if (busy && !inspectComposer) return 'busy';
  if (lines.some(line => /invalid_request_error|last request failed|Press Ctrl\+Y|permission required|Enter select\s*·\s*Esc cancel/i.test(line))) return 'unknown';
  const empty = /^\d+[>…]\s*(?:(?:[\d.]+[kKmM]?\/[\d.]+[kKmM]?\s+[▱▰]+\s+\d+%)|[\u{f0318}\u{f059f}])?\s*$/u.test(last);
  return empty ? 'idle' : busy ? 'busy' : 'unknown';
}

// This detects missing new reported evidence, not whether the evidence is true.
export function stalledWorkerProgress(review, now = Date.now()) {
  return (review.workerProgress || []).filter(worker =>
    review.watched.some(target => target.termId === worker.termId && target.goal === worker.goal && !target.paused)
    && !['complete', 'reported'].includes(worker.run?.status)
    && now - (workerProgressAt(worker) || worker.startedAt) >= WORKER_PROGRESS_DEADLINE);
}
