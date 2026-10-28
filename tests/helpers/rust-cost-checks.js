import { appendFile, mkdir, readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stable = value => {
  if (typeof value === 'number') return Math.round(value * 1e10) / 1e10;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'burnPerHour').map(([key, value]) => [key, stable(value)]));
  return value;
};
export async function prepareCostChecks({ fixture, sandbox }) {
  const homes = [fixture.directory, join(sandbox, 'home')];
  const stamp = new Date().toISOString();
  const today = stamp.slice(0, 10);
  const row = (id, model, usage, content = []) => ({ type: 'assistant', timestamp: stamp, requestId: 'request', message: { id, model, usage, content } });
  const rows = [
    row('cost-a', 'claude-sonnet-4-6', { input_tokens: 10000, output_tokens: 1500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000 }, [{ type: 'tool_use', name: 'Read' }]),
    row('cost-a', 'claude-sonnet-4-6', { input_tokens: 999999, output_tokens: 999999 }),
    row('cost-b', 'claude-opus-4-8', { input_tokens: 2500, output_tokens: 400 }),
    row('cost-c', 'claude-haiku-4-5-20251001', { input_tokens: 1000, output_tokens: 80 }),
    row('cost-d', 'claude-unpriced-fixture', { input_tokens: 10, output_tokens: 20 }),
    row('cost-e', '<synthetic>', { input_tokens: 999999, output_tokens: 999999 }),
  ];
  // Unknown fields with unpaired surrogates must not make valid usage disappear.
  rows[0].extra = '\ud800';
  const previous = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const history = { daily: { [previous]: { cost: 2, inputTokens: 100, outputTokens: 200, messages: 3, sessions: 1, models: { 'sonnet-history': { cost: 2, outputTokens: 200 } } }, [old]: { cost: 1000 } } };
  const files = [];
  const activity = Array.from({ length: 40 }, (_, i) => ({ display: `검증 ${i} 😀\ud800`, project: i % 2 ? 'C:\\fixture\\project' : '/fixture/project', timestamp: Date.now() - i * 1000, ...(i % 3 ? { sessionId: `s-${i}` } : {}) }));
  for (const [index, home] of homes.entries()) {
    const dir = join(home, '.claude/projects/cost-fixture');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'cost-0001.jsonl'); files.push(file);
    await writeFile(file, rows.map(JSON.stringify).join('\n') + '\n{broken\n');
    await writeFile(join(home, '.claude/stats-cache.json'), JSON.stringify({ fixture: true, totalMessages: 7, unknown: '\udfff' }));
    await writeFile(join(home, '.claude/history.jsonl'), activity.map(JSON.stringify).join('\n') + '\n{broken\n');
    await writeFile(index ? join(sandbox, 'cost-cache.json') : join(fixture.directory, 'app/cost-cache.json'), JSON.stringify(history));
  }
  fixture.costs = { files, homes, today, previous, old, stamp, row };
}

export async function verifyCostChecks({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl];
  const { files, homes, today, previous, old, row } = fixture.costs;
  const pair = async path => {
    const result = await Promise.all(bases.map(base => request(base, path)));
    check(result.map(r => r.status), [200, 200], `${path} success`);
    check(stable(result[1].data), stable(result[0].data), `${path} Node contract`);
    return result;
  };
  const readFresh = async () => {
    const until = Date.now() + 35_000;
    while (Date.now() < until) {
      const results = await Promise.all(bases.map(base => request(base, '/api/usage')));
      if (results.every(r => r.data.today?.models?.['unpriced-fixture'])) return results;
      await pause(500);
    }
    throw new Error('Usage cache did not refresh');
  };
  await readFresh();
  const usage = (await pair('/api/usage'))[1].data;
  check(usage.today.date, today, 'Cost uses local calendar date');
  check(usage.today.models['sonnet-4-6'].outputTokens >= 1500, true, 'Cost retains real sonnet usage');
  check(usage.today.models['unpriced-fixture'].outputTokens, 20, 'Unknown model estimates retain usage');
  check(usage.unpricedModels.includes('<synthetic>'), false, 'Synthetic models are not billed');
  check(usage.daily.some(d => d.date === previous), true, 'Persisted historical usage survives');
  check(usage.daily.some(d => d.date === old), false, 'History outside 30-day window omitted');
  const insights = await pair('/api/cost/insights');
  check(Math.abs(insights[0].data.burnPerHour - insights[1].data.burnPerHour) < 0.01, true, 'Burn-rate difference bounded to request timing');
  await pair('/api/stats');
  // Account/SSE checks earlier in the suite allow the regular 60-second cost
  // poll to refresh. Hold a client until global caches converge if needed.
  const abort = new AbortController();
  const response = await fetch(`${rustUrl}/api/events`, { signal: abort.signal });
  const frames = [];
  const consume = (async () => {
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      for (let split; (split = pending.indexOf('\n\n')) >= 0;) {
        const frame = pending.slice(0, split); pending = pending.slice(split + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
        if (event && data) frames.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(error => { if (!abort.signal.aborted) throw error; });
  try {
    const until = Date.now() + 65_000;
    while (Date.now() < until) {
      const value = (await request(rustUrl, '/api/cost/daily')).data;
      if (value.today?.models?.['unpriced-fixture']) break;
      await pause(500);
    }
    await pair('/api/cost/daily');
    const activity = await pair('/api/activity');
    check(activity[1].data.length, 30, 'Recent activity limited to last 30 entries');
    check(activity[1].data[0].command.endsWith('\ud800'), true, 'Activity preserves UTF16');
    const next = JSON.stringify({ project: '/fixture/updated', display: 'new activity', timestamp: Date.now() }) + '\n';
    await Promise.all(homes.map(home => appendFile(join(home, '.claude/history.jsonl'), next)));
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !frames.some(f => f.event === 'activity:new' && f.data[0]?.command === 'new activity')) await pause(100);
    check(frames.some(f => f.event === 'activity:new' && f.data[0]?.command === 'new activity'), true, 'Actual activity timer publishes changed history');
    for (const home of homes) await writeFile(join(home, '.claude/stats-cache.json'), '{broken');
    check((await pair('/api/stats'))[1].data, {}, 'Corrupt optional stats cache falls back to empty object');
    const privateFile = join(fixture.directory, 'outside-stats.json');
    await writeFile(privateFile, JSON.stringify({ mustNotExpose: true }));
    const statsPath = join(sandbox, 'home/.claude/stats-cache.json');
    await unlink(statsPath); await symlink(privateFile, statsPath);
    check((await request(rustUrl, '/api/stats')).data, {}, 'Preview stats refuse external symlink');
    await unlink(statsPath);
    // A changed byte count invalidates the incremental file cache after the
    // existing 30-second memory cache expires; unchanged files remain cached.
    const addition = JSON.stringify(row('cost-after-append', 'claude-opus-4-8', { input_tokens: 20, output_tokens: 37 })) + '\n';
    await Promise.all(files.map(file => appendFile(file, addition)));
    const refresh = Date.now() + 35_000;
    while (Date.now() < refresh) {
      const values = await Promise.all(bases.map(base => request(base, '/api/usage')));
      if (values.every(r => r.data.today.models?.['opus-4-8']?.outputTokens >= usage.today.models['opus-4-8'].outputTokens + 37)) break;
      await pause(500);
    }
    const changed = (await pair('/api/usage'))[1].data;
    check(changed.today.models['opus-4-8'].outputTokens, usage.today.models['opus-4-8'].outputTokens + 37, 'Appended usage appears after memory cache expiry');
    const saved = JSON.parse(await readFile(join(sandbox, 'cost-cache.json'), 'utf8'));
    check(saved.daily[today].outputTokens, changed.today.outputTokens, 'Updated usage survives in persistent cache');
  } finally { abort.abort(); await consume; }
}
