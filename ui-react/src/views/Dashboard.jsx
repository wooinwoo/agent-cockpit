import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchJson, postJson } from '../api.js';
import './Dashboard.css';

const STATE_LABEL = {
  busy: '작업 중',
  waiting: '대기 중',
  idle: '유휴',
  no_data: '데이터 없음',
  no_sessions: '세션 없음',
};

const STATE_ORDER = { busy: 0, waiting: 1, idle: 2, no_data: 3, no_sessions: 4 };

function fmtTok(n) {
  n = n || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function timeAgo(v) {
  if (!v) return '—';
  const ms = Date.now() - new Date(v).getTime();
  if (isNaN(ms) || ms < 0) return '—';
  if (ms < 60000) return '방금 전';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}분 전`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}시간 전`;
  return `${Math.floor(ms / 86400000)}일 전`;
}

function parseSSE(e) {
  try {
    return JSON.parse(e.data);
  } catch {
    return null;
  }
}

function StatTile({ label, value, accent = 'accent' }) {
  return (
    <div className="stat-card" data-accent={accent}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function ModelBars({ models, total }) {
  const entries = Object.entries(models || {}).sort(
    (a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0),
  );
  if (!entries.length) return null;
  return (
    <div className="uc-models">
      {entries.map(([name, m]) => {
        const pct = total > 0 ? ((m.outputTokens || 0) / total) * 100 : 0;
        return (
          <div className="uc-model-row" key={name}>
            <span className="name">{name}</span>
            <span className="val">{fmtTok(m.outputTokens || 0)}<span className="pct">{pct.toFixed(1)}%</span></span>
          </div>
        );
      })}
    </div>
  );
}

const CHART_COLORS = ['#818cf8', '#34d399', '#fbbf24', '#f87171', '#60a5fa'];
const CHART_GRID = 'rgba(255,255,255,.08)';
const CHART_TICK = '#9a9cb0';

function DailyTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  return (
    <div className="db-chart-tip">
      <div className="db-chart-tip-title">{p?.fullDate || label}</div>
      <div className="db-chart-tip-row">
        <span>출력 토큰</span>
        <strong>{fmtTok(p?.tokens ?? payload[0]?.value ?? 0)}</strong>
      </div>
    </div>
  );
}

function ModelTooltip({ active, payload, total }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const v = entry?.value || 0;
  const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0';
  return (
    <div className="db-chart-tip">
      <div className="db-chart-tip-title">{entry?.name}</div>
      <div className="db-chart-tip-row">
        <span>{fmtTok(v)} 토큰</span>
        <strong>{pct}%</strong>
      </div>
    </div>
  );
}

function DailyTokensChart({ data }) {
  if (!data.length) return <p className="db-muted">일별 데이터 없음</p>;
  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_GRID} vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: CHART_TICK, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_GRID }}
            minTickGap={28}
          />
          <YAxis
            tickFormatter={(v) => fmtTok(v)}
            tick={{ fill: CHART_TICK, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={46}
          />
          <Tooltip content={<DailyTooltip />} cursor={{ stroke: '#818cf8', strokeOpacity: 0.35 }} />
          <Line
            type="monotone"
            dataKey="tokens"
            name="출력 토큰"
            stroke="#818cf8"
            strokeWidth={2}
            dot={{ r: 1.5, fill: '#818cf8', strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            fill="rgba(129,140,248,.12)"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ModelShareChart({ data }) {
  if (!data.length) return <p className="db-muted">모델별 데이터 없음</p>;
  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="65%"
            outerRadius="90%"
            paddingAngle={2}
            strokeWidth={0}
          >
            {data.map((e, i) => (
              <Cell key={e.name} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<ModelTooltip total={total} />} />
          <Legend
            verticalAlign="bottom"
            height={36}
            formatter={(value) => <span className="db-legend-label">{value}</span>}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function ProjectCard({ p, dev, onDevToggle, onOpenIde, onOpenFolder, busy }) {
  const s = p.session || {};
  const g = p.git || {};
  const prs = p.prs?.prs || [];
  const st = s.state || 'no_data';
  const uncommitted = g.uncommittedCount || 0;
  const devRunning = !!dev;
  const approved = prs.filter((pr) => pr.reviewDecision === 'APPROVED').length;
  const changes = prs.filter((pr) => pr.reviewDecision === 'CHANGES_REQUESTED').length;
  const prCls = changes > 0 ? 'card-badge-pr-changes' : approved > 0 ? 'card-badge-pr-ok' : 'card-badge-pr';

  return (
    <article className="card" data-status={st}>
      <div className="card-accent" style={{ background: p.color || 'var(--accent)', '--card-color': p.color || 'var(--accent)' }} />
      <div className="card-body">
        <div className="card-header">
          <span className="card-name">{p.name}</span>
          {p.stack ? <span className="card-stack">{p.stack}</span> : null}
        </div>
        <div style={{ marginBottom: 4 }}>
          <span className={`status ${st}`}>
            <span className="dot" />{STATE_LABEL[st] || st}
          </span>
        </div>
        {(g.stashCount > 0 || (g.worktrees?.length || 0) > 1 || prs.length > 0) && (
          <div className="card-badges-row">
            {g.stashCount > 0 && <span className="card-badge card-badge-stash">📦 {g.stashCount}</span>}
            {(g.worktrees?.length || 0) > 1 && <span className="card-badge card-badge-wt">🌳 {g.worktrees.length}</span>}
            {prs.length > 0 && <span className={`card-badge ${prCls}`}>PR {prs.length}</span>}
          </div>
        )}
        <p className="card-path" title={p.path}>{p.path}</p>
        <div className="card-info">
          <div className="info-row"><span className="info-label">Branch</span><span className="info-value branch">{g.branch || '-'}</span></div>
          <div className="info-row"><span className="info-label">Uncommitted</span><span className={`info-value${uncommitted > 0 ? ' has-changes' : ''}`}>{g.uncommittedCount ?? '-'}</span></div>
          <div className="info-row"><span className="info-label">Model</span><span className="info-value">{s.model || '-'}</span></div>
          <div className="info-row"><span className="info-label">Last</span><span className="info-value">{s.lastActivity ? timeAgo(s.lastActivity) : '-'}</span></div>
        </div>
        {g.recentCommits?.length > 0 && (
          <ul className="commits">
            {g.recentCommits.slice(0, 3).map((c, i) => (
              <li key={`${c.hash}-${i}`}>
                <span className="commit-hash">{c.hash}</span>{' '}
                <span className="commit-msg">{c.message}</span>
                <span className="commit-ago">{c.ago}</span>
              </li>
            ))}
          </ul>
        )}
        {prs.length > 0 && (
          <div className="pr-list">
            {prs.slice(0, 2).map((pr) => (
              <div className="pr-item" key={pr.number}>
                <span className="pr-num">#{pr.number}</span>
                <span className="pr-title">{pr.title}</span>
                <span className={`pr-review ${pr.reviewDecision || 'PENDING'}`}>
                  {pr.reviewDecision === 'APPROVED' ? 'OK' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes' : 'Pending'}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="card-foot">
          <div className="card-btn-row">
            {p.devCmd && (
              <button className="btn" type="button" disabled={busy} onClick={() => onDevToggle(p, devRunning)}>
                {busy ? '처리 중…' : devRunning ? `Dev 중지${dev.port ? ` :${dev.port}` : ''}` : 'Dev 시작'}
              </button>
            )}
            <button className="btn" type="button" disabled={busy} onClick={() => onOpenIde(p)}>VS Code</button>
            <button className="btn" type="button" disabled={busy} onClick={() => onOpenFolder(p)}>폴더</button>
            {p.github && (
              <a className="btn" href={p.github} target="_blank" rel="noreferrer">GitHub</a>
            )}
          </div>
        </div>
        {devRunning && dev.command && <p className="card-dev-cmd">{dev.command}</p>}
      </div>
    </article>
  );
}

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const [usage, setUsage] = useState(null);
  const [devServers, setDevServers] = useState([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('name');
  const [period, setPeriod] = useState(30);
  const [busyIds, setBusyIds] = useState({});

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [projData, usageData, devData] = await Promise.all([
        fetchJson('/api/projects'),
        fetchJson('/api/usage'),
        fetchJson('/api/dev-servers'),
      ]);
      setProjects(Array.isArray(projData) ? projData : []);
      setUsage(usageData);
      setDevServers(devData.running || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // SSE 실시간 갱신 (마운트 = 화면 표시 중이므로 폴링 폴백 없음)
    const es = new EventSource('/api/events');
    const onInit = (e) => {
      const d = parseSSE(e);
      if (!d) return;
      setConnected(true);
      if (d.costs) setUsage(d.costs);
      if (d.devServers) setDevServers(d.devServers);
      setProjects((prev) =>
        prev.map((p) => ({
          ...p,
          ...(d.sessions?.[p.id] ? { session: d.sessions[p.id] } : null),
          ...(d.git?.[p.id] ? { git: d.git[p.id] } : null),
          ...(d.prs?.[p.id] ? { prs: d.prs[p.id] } : null),
        })),
      );
    };
    const onSession = (e) => {
      const d = parseSSE(e);
      if (!d?.projectId) return;
      setProjects((prev) => prev.map((p) => (p.id === d.projectId ? { ...p, session: d } : p)));
    };
    const onGit = (e) => {
      const d = parseSSE(e);
      if (!d?.projectId) return;
      setProjects((prev) => prev.map((p) => (p.id === d.projectId ? { ...p, git: d } : p)));
    };
    const onPr = (e) => {
      const d = parseSSE(e);
      if (!d?.projectId) return;
      setProjects((prev) => prev.map((p) => (p.id === d.projectId ? { ...p, prs: d } : p)));
    };
    const onCost = (e) => {
      const d = parseSSE(e);
      if (d) setUsage(d);
    };
    const onDev = (e) => {
      const d = parseSSE(e);
      if (d) setDevServers(d.running || []);
    };
    const onErr = () => setConnected(false);
    es.addEventListener('init', onInit);
    es.addEventListener('session:status', onSession);
    es.addEventListener('git:update', onGit);
    es.addEventListener('pr:update', onPr);
    es.addEventListener('cost:update', onCost);
    es.addEventListener('dev:status', onDev);
    es.onerror = onErr;
    return () => {
      es.removeEventListener('init', onInit);
      es.removeEventListener('session:status', onSession);
      es.removeEventListener('git:update', onGit);
      es.removeEventListener('pr:update', onPr);
      es.removeEventListener('cost:update', onCost);
      es.removeEventListener('dev:status', onDev);
      es.close();
    };
  }, []);

  const devByProject = useMemo(() => {
    const m = {};
    for (const ds of devServers) m[ds.projectId] = ds;
    return m;
  }, [devServers]);

  const stats = useMemo(() => {
    let active = 0;
    let prCount = 0;
    let uncommitted = 0;
    for (const p of projects) {
      if (p.session?.state === 'busy' || p.session?.state === 'waiting') active++;
      prCount += p.prs?.prs?.length || 0;
      uncommitted += p.git?.uncommittedCount || 0;
    }
    return { active, prCount, uncommitted, today: usage?.today?.outputTokens || 0 };
  }, [projects, usage]);

  const notices = useMemo(() => {
    const list = [];
    const uncommitted = projects.filter((p) => (p.git?.uncommittedCount || 0) > 0);
    if (uncommitted.length > 0) {
      const total = uncommitted.reduce((s, p) => s + (p.git.uncommittedCount || 0), 0);
      list.push({
        kind: 'warn',
        title: `${total}개 파일 변경됨`,
        desc: uncommitted.slice(0, 3).map((p) => p.name).join(', '),
      });
    }
    const activeList = projects.filter(
      (p) => p.session?.state === 'busy' || p.session?.state === 'waiting',
    );
    if (activeList.length > 0) {
      list.push({
        kind: 'info',
        title: `${activeList.length}개 세션 활성`,
        desc: activeList.slice(0, 3).map((p) => p.name).join(', '),
      });
    }
    const needChanges = [];
    let openPrs = 0;
    for (const p of projects) {
      for (const pr of p.prs?.prs || []) {
        openPrs++;
        if (pr.reviewDecision === 'CHANGES_REQUESTED') needChanges.push(`#${pr.number} ${p.name}`);
      }
    }
    if (needChanges.length > 0) {
      list.push({ kind: 'danger', title: `PR ${needChanges.length}개 수정 요청`, desc: needChanges.slice(0, 3).join(', ') });
    } else if (openPrs > 0) {
      list.push({ kind: 'info', title: `PR ${openPrs}개 오픈`, desc: '' });
    }
    if (usage?.today?.outputTokens > 0) {
      list.push({
        kind: 'neutral',
        title: `오늘 ${fmtTok(usage.today.outputTokens)} 토큰`,
        desc: `${usage.today.messages || 0} 메시지 · ${usage.today.sessions || 0} 세션`,
      });
    }
    return list;
  }, [projects, usage]);

  const visibleProjects = useMemo(() => {
    const q = query.toLowerCase().trim();
    const filtered = projects.filter((p) => {
      const st = p.session?.state || 'no_data';
      const textOk =
        !q ||
        (p.name || '').toLowerCase().includes(q) ||
        (p.stack || '').toLowerCase().includes(q) ||
        (p.path || '').toLowerCase().includes(q);
      const statusOk =
        filter === 'all' ||
        (filter === 'active' && (st === 'busy' || st === 'waiting')) ||
        (filter === 'idle' && (st === 'idle' || st === 'no_data' || st === 'no_sessions'));
      return textOk && statusOk;
    });
    return [...filtered].sort((a, b) => {
      if (sort === 'activity') {
        const oa = STATE_ORDER[a.session?.state] ?? 3;
        const ob = STATE_ORDER[b.session?.state] ?? 3;
        if (oa !== ob) return oa - ob;
      }
      if (sort === 'recent') {
        const ta = a.session?.lastActivity || '';
        const tb = b.session?.lastActivity || '';
        if (ta !== tb) return ta > tb ? -1 : 1;
      }
      if (sort === 'uncommitted') {
        const ua = a.git?.uncommittedCount || 0;
        const ub = b.git?.uncommittedCount || 0;
        if (ua !== ub) return ub - ua;
      }
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [projects, query, filter, sort]);

  const daily = useMemo(() => (usage?.daily || []).slice(-period), [usage, period]);
  const dailyChartData = useMemo(
    () =>
      daily.map((d) => ({
        date: (d.date || '').slice(5) || '',
        fullDate: d.date || '',
        tokens: d.outputTokens || 0,
      })),
    [daily],
  );
  const modelTotals = useMemo(() => {
    const mm = {};
    for (const d of daily) {
      for (const m of d.modelBreakdowns || []) {
        mm[m.modelName || '?'] = (mm[m.modelName || '?'] || 0) + (m.outputTokens || 0);
      }
    }
    return Object.entries(mm).sort((a, b) => b[1] - a[1]);
  }, [daily]);
  const modelChartData = useMemo(
    () => modelTotals.map(([name, value]) => ({ name, value })),
    [modelTotals],
  );

  function setBusy(id, on) {
    setBusyIds((prev) => ({ ...prev, [id]: on }));
  }

  async function handleDevToggle(p, running) {
    setBusy(p.id, true);
    setError('');
    try {
      await postJson(`/api/projects/${p.id}/dev-server/${running ? 'stop' : 'start'}`, {});
      const dev = await fetchJson('/api/dev-servers');
      setDevServers(dev.running || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(p.id, false);
    }
  }

  async function handleOpenIde(p) {
    setBusy(p.id, true);
    setError('');
    try {
      await postJson(`/api/projects/${p.id}/open-ide`, { ide: 'code' });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(p.id, false);
    }
  }

  async function handleOpenFolder(p) {
    setBusy(p.id, true);
    setError('');
    try {
      await postJson('/api/open-folder', { path: p.path });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(p.id, false);
    }
  }

  return (
    <main className="db">
      <h1>대시보드</h1>
      <p className="db-sub">
        <span className={`conn-dot${connected ? '' : ' off'}`} />
        {connected ? '실시간 연결됨' : '연결 중…'} · {projects.length}개 프로젝트{' '}
        <button className="btn" type="button" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
      </p>
      {error && <p className="db-error">오류: {error}</p>}

      <section className="stats-row">
        <StatTile label="활성 세션" value={stats.active} accent="green" />
        <StatTile label="열린 PR" value={stats.prCount} accent="accent" />
        <StatTile label="미커밋 파일" value={stats.uncommitted} accent="yellow" />
        <StatTile label="오늘 출력 토큰" value={fmtTok(stats.today)} accent="blue" />
      </section>

      {notices.length > 0 && (
        <section className="smart-actions">
          {notices.map((n, i) => (
            <div className={`sa-card sa-${n.kind === 'warn' ? 'warning' : n.kind}`} key={i}>
              <span className="sa-icon">
                {n.kind === 'warn' ? '⚠️' : n.kind === 'danger' ? '⛔' : n.kind === 'info' ? 'ℹ️' : '📊'}
              </span>
              <div className="sa-body">
                <div className="sa-title">{n.title}</div>
                {n.desc && <div className="sa-desc">{n.desc}</div>}
              </div>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2 className="section-title">Projects</h2>
        <div className="project-search-bar">
          <input
            type="text"
            placeholder="프로젝트 검색…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="project-filter-btns">
            {['all', 'active', 'idle'].map((f) => (
              <button
                key={f}
                type="button"
                className={`pf-btn${filter === f ? ' active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? '전체' : f === 'active' ? '활성' : '유휴'}
              </button>
            ))}
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value)} title="정렬" className="card-sort-select">
            <option value="name">이름순</option>
            <option value="activity">활성순</option>
            <option value="recent">최근순</option>
            <option value="uncommitted">미커밋순</option>
          </select>
          <span className="project-search-count">{visibleProjects.length}/{projects.length}</span>
        </div>
        {loading && projects.length === 0 ? (
          <p>불러오는 중…</p>
        ) : visibleProjects.length === 0 ? (
          <p className="db-muted">표시할 프로젝트가 없습니다.</p>
        ) : (
          <div className="project-grid">
            {visibleProjects.map((p) => (
              <ProjectCard
                key={p.id}
                p={p}
                dev={devByProject[p.id]}
                busy={!!busyIds[p.id]}
                onDevToggle={handleDevToggle}
                onOpenIde={handleOpenIde}
                onOpenFolder={handleOpenFolder}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="section-title">Cost &amp; Usage</h2>
        {!usage ? (
          <p className="db-muted">사용량 데이터 없음</p>
        ) : (
          <div className="usage-grid">
            <div className="usage-card">
              <div className="uc-header">
                <span className="uc-title">Today</span>
                <span className="uc-sub">{usage.today?.date || ''}</span>
              </div>
              <div className="uc-main">{fmtTok(usage.today?.outputTokens || 0)} 토큰</div>
              <div className="uc-stats">
                <div className="uc-stat-row"><span className="label">메시지</span><span className="val">{usage.today?.messages || 0}</span></div>
                <div className="uc-stat-row"><span className="label">세션</span><span className="val">{usage.today?.sessions || 0}</span></div>
                <div className="uc-stat-row"><span className="label">도구 호출</span><span className="val">{usage.today?.toolCalls || 0}</span></div>
              </div>
              <ModelBars models={usage.today?.models} total={usage.today?.outputTokens || 1} />
              <div className="uc-footer">API 환산 약 ${(usage.today?.apiEquivCost || 0).toFixed(2)}</div>
            </div>
            <div className="usage-card">
              <div className="uc-header">
                <span className="uc-title">This Week</span>
                <span className="uc-sub" />
              </div>
              <div className="uc-main">{fmtTok(usage.week?.outputTokens || 0)} 토큰</div>
              <div className="uc-stats">
                <div className="uc-stat-row"><span className="label">메시지</span><span className="val">{usage.week?.messages || 0}</span></div>
              </div>
              <ModelBars models={usage.week?.models} total={usage.week?.outputTokens || 1} />
              <div className="uc-footer">API 환산 약 ${(usage.week?.apiEquivCost || 0).toFixed(2)}</div>
            </div>
            <div className="chart-card">
              <h3>
                일별 출력 토큰{' '}
                <span className="db-period">
                  {[7, 14, 30].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`pf-btn${period === d ? ' active' : ''}`}
                      onClick={() => setPeriod(d)}
                    >
                      {d}일
                    </button>
                  ))}
                </span>
              </h3>
              <DailyTokensChart data={dailyChartData} />
              {modelTotals.length > 0 && (
                <>
                  <h3>모델별 합계 ({period}일)</h3>
                  <ModelShareChart data={modelChartData} />
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
