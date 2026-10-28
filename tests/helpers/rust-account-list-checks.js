import { mkdir, readFile, writeFile, appendFile, utimes, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, message, timeout = 6000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await delay(50); }
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
async function stream(base, headers = {}) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/events`, { headers, signal: abort.signal });
  const state = { response, frames: [], closed: false, stop: () => abort.abort() };
  state.done = (async () => {
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          state.frames.push(pending.slice(0, end)); pending = pending.slice(end + 2);
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally { state.closed = true; }
  })();
  return state;
}

export async function verifyAccountLists({ fixture, sandbox, rustUrl, request, check }) {
  const bases = [fixture.url, rustUrl];
  const homes = [fixture.directory, join(sandbox, 'home')];
  const stored = [];
  const profiles = [];
  const streams = [];
  const now = Date.now();
  const day = 86_400_000;
  const fixedMtime = new Date(now - 60_000);
  const credential = (provider, home) => join(home, provider === 'claude' ? '.credentials.json' : 'auth.json');
  async function seedUsage(provider, home) {
    const folder = join(home, provider === 'claude' ? 'projects/demo' : 'sessions/2026/10');
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'fixture.jsonl');
    const lines = provider === 'claude' ? [
      { timestamp: new Date(now - 3600_000).toISOString(), message: { content: '\ud800', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9999 } } },
      { timestamp: new Date(now - 2 * day).toISOString(), message: { usage: { input_tokens: 1000, output_tokens: 0 } } },
      { timestamp: new Date(now - 8 * day).toISOString(), message: { usage: { input_tokens: 99999 } } },
    ] : [
      { payload: { rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } } } },
      { unrelated: '\udfff', payload: { rate_limits: { primary: { used_percent: 40, window_minutes: 300, resets_at: Math.floor(now / 1000) - 60 }, secondary: { used_percent: 25, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 3600 } } } },
      { payload: { type: 'agent_message' } },
    ];
    await writeFile(file, lines.map(JSON.stringify).join('\n'));
    await utimes(file, fixedMtime, fixedMtime);
  }
  async function list(index) { const result = await request(bases[index], '/api/ai-accounts'); check(result.status, 200, 'Account list available'); return result.data; }
  const normalized = data => {
    const { usageRefreshSupported, jcodeCosts, ...legacy } = data;
    return { ...legacy, accounts: data.accounts.map(a => {
      const usage = a.usage && { ...a.usage }; if (usage) { delete usage.query; delete usage.cost; }
      return { ...a, usage, id: `<${a.source}:${a.name}>` };
    }) };
  };
  try {
    for (let i = 0; i < 2; i++) {
      const own = [];
      for (const provider of ['claude', 'codex']) {
        const result = await request(bases[i], '/api/ai-accounts', { method: 'POST', body: { name: `목록 ${provider}`, provider, email: 'fixture@example.invalid' } });
        check(result.status, 201, 'Create account list fixture'); own.push(result.data);
        await seedUsage(provider, result.data.homePath);
        if (provider === 'claude') await request(bases[i], `/api/ai-accounts/${result.data.id}/budget`, { method: 'POST', body: { weeklyTokenBudget: 2300 } });
      }
      stored.push(own);
      const hubRoot = join(homes[i], '.codex-account-launcher');
      await mkdir(hubRoot, { recursive: true });
      const entries = [];
      for (const [provider, fresh] of [['claude', true], ['codex', false]]) {
        const home = join(homes[i], `hub-${provider}`); await mkdir(home, { recursive: true });
        await writeFile(credential(provider, home), '{}');
        await seedUsage(provider, home);
        entries.push({ provider, [provider === 'claude' ? 'claudeConfigDir' : 'codexHome']: home,
          name: `허브 ${provider}`, authenticatedEmail: 'hub@example.invalid', accountPlan: 'fixture',
          lastLimitsRefreshUtc: new Date(now - (fresh ? 60_000 : 3 * day)).toISOString(), weeklyLimitUsedPercent: 10, shortLimitUsedPercent: '30',
          weeklyLimitResetUtc: new Date(now - 8 * day).toISOString(), lastLimitsError: provider === 'codex' ? 'fixture warning' : '',
        });
      }
      entries.push({ ...entries[0], name: 'duplicate must not replace first' }, { provider: 'unsupported', codexHome: '/missing' });
      profiles.push(entries);
      const file = join(hubRoot, 'profiles.json');
      await writeFile(file, JSON.stringify({ profiles: entries })); await utimes(file, fixedMtime, fixedMtime);
    }
    const loaded = await Promise.all([0, 1].map(i => until(() => list(i), data => data.accounts.length === 4 && data.accounts.every(a => a.usage), 'Background usage cache')));
    check(normalized(loaded[1]), normalized(loaded[0]), 'Stored and hub public lists, usage and reset dates match Node');
    check(loaded[1].accounts[0].weeklyRemaining, 50, 'Claude local budget fallback excludes cache tokens and old usage');
    check(loaded[1].accounts[0].usage.sessionTokens, 150, 'Five-hour session window');
    check(loaded[1].accounts[1].sessionRemaining, 100, 'Expired Codex rollout window resets');
    check(loaded[1].accounts[2].weeklyRemaining, 90, 'Fresh hub limits take precedence');
    check(loaded[1].accounts[3].weeklyRemaining, 75, 'Stale hub limits use cached local rollout');
    check(loaded[1].accounts[3].state, 'warning', 'Hub status warning retained');
    check(JSON.stringify(loaded[1]).includes(sandbox), false, 'Public summaries never reveal account credential paths');
    check((await request(rustUrl, `/api/ai-accounts/${loaded[1].accounts[2].id}/test`, { method: 'POST', body: {} })).status, 404, 'Stored login-check route cannot invoke hub CLI');

    for (const base of bases) streams.push(await stream(base));
    const accountFrames = s => s.frames.filter(f => f.startsWith('event: ai-accounts:changed\n'));
    for (const s of streams) {
      check(s.response.headers.get('content-type'), 'text/event-stream', 'SSE MIME');
      check(s.response.headers.get('cache-control'), 'no-store', 'SSE cache control');
      await until(() => s.frames, frames => frames.some(f => f.startsWith('event: init\n')), 'SSE initial state');
      const initial = JSON.parse(s.frames.find(f => f.startsWith('event: init\n')).split('\ndata: ')[1]);
      check(Object.keys(initial).sort(), ['sessions', 'git', 'prs', 'costs', 'activity', 'devServers', 'nodeVersion'].sort(), 'SSE initial contract fields');
    }
    await delay(1200); // Let the original watcher finish directory re-arming.
    for(let i=0;i<2;i++) {
      await appendFile(join(stored[i][0].homePath,'projects/demo/fixture.jsonl'),'\n'+JSON.stringify({timestamp:new Date(now).toISOString(),message:{usage:{input_tokens:200}}}));
      check((await list(i)).accounts[0].usage.weeklyTokens,1150,'Fresh usage cache returns immediately without rescanning transcripts');
    }
    const counts = streams.map(s => accountFrames(s).length);
    await Promise.all(stored.map(records => writeFile(credential('claude', records[0].homePath), '{}')));
    for (let i = 0; i < streams.length; i++) {
      await until(() => accountFrames(streams[i]), frames => frames.length > counts[i], 'Login produces account SSE');
      const changed = JSON.parse(accountFrames(streams[i]).at(-1).split('\ndata: ')[1]);
      check(typeof changed.at, 'number', 'Credential event timestamp');
      check((await list(i)).accounts[0].state, 'ready', 'Login is visible without reopening the account tab');
      await until(()=>list(i),data=>data.accounts[0].usage?.weeklyTokens===1350,'Credential change invalidates usage cache');
    }
    const nativeStream = streams[1];
    let count = accountFrames(nativeStream).length;
    await writeFile(join(stored[1][0].homePath, 'unrelated.txt'), 'ignore');
    await delay(1100);
    check(accountFrames(nativeStream).length, count, 'Unrelated account files do not trigger SSE');
    // Watching every hub is intentional: the old Set.add(...targets) only armed the first.
    await writeFile(credential('codex', join(homes[1], 'hub-codex')), JSON.stringify({ last_refresh: '2020-01-01T00:00:00Z' }));
    await until(() => accountFrames(nativeStream), frames => frames.length > count, 'Second hub credential also triggers SSE');
    check((await list(1)).accounts[3].stateNote.includes('30일'), true, 'Hub credential change is reflected');
    count = accountFrames(nativeStream).length;
    profiles[1][0].name = '허브 이름 변경';
    await writeFile(join(homes[1], '.codex-account-launcher/profiles.json'), JSON.stringify(profiles[1]));
    await until(() => accountFrames(nativeStream), frames => frames.length > count, 'Profile array replacement produces SSE');
    check((await list(1)).accounts[2].name, '허브 이름 변경', 'Legacy hub array and edited name');
    const profileFile = join(homes[1], '.codex-account-launcher/profiles.json');
    await writeFile(profileFile, '{broken');
    const broken = await list(1);
    check(broken.accounts.length, 2, 'Malformed hub does not erase stored accounts');
    check(broken.sources[0].error, '프로필 파일을 읽지 못했습니다.', 'Malformed hub source error');
    check(await readFile(profileFile, 'utf8'), '{broken', 'Malformed hub file is preserved');
    await writeFile(profileFile, JSON.stringify(profiles[1]));
    await until(() => nativeStream.frames, frames => frames.includes(':ping'), 'SSE 15-second keepalive', 18_000);

    const extra = [];
    try {
      // Existing nativeStream plus 50 replacements: the oldest must end, newest stays.
      for (let i = 0; i < 50; i++) extra.push(await stream(rustUrl));
      await until(() => nativeStream.closed, value => value, 'Oldest SSE client evicted at 51 connections');
      check(extra.at(-1).closed, false, 'Newest SSE client remains connected');
    } finally { for (const s of extra) s.stop(); await Promise.all(extra.map(s => s.done)); }
    const token = (await readFile(join(sandbox, '.cockpit-token'), 'utf8')).trim();
    check((await request(rustUrl,'/api/events',{headers:{'x-forwarded-for':'192.0.2.3'}})).headers.get('content-type'),'text/html; charset=utf-8','Unauthenticated SSE follows normal login enforcement');
    const remote = await stream(rustUrl, { 'x-forwarded-for': '192.0.2.3', cookie: `cockpit-token=${token}` });
    streams.push(remote); check(remote.response.headers.get('content-type'), 'text/event-stream', 'SSE supports authenticated remote clients');
  } finally {
    for (const s of streams) s.stop(); await Promise.all(streams.map(s => s.done));
    for (let i = 0; i < stored.length; i++) for (const account of stored[i]) await request(bases[i], `/api/ai-accounts/${account.id}`, { method: 'DELETE' });
    for (const home of homes) await unlink(join(home, '.codex-account-launcher/profiles.json')).catch(() => {});
  }
}
