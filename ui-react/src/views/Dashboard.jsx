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

function StatTile({ label, value }) {
  return (
    <div className="db-stat">
      <span className="db-stat-val">{value}</span>
      <span className="db-stat-label">{label}</span>
    </div>
  );
}

function ModelBars({ models, total }) {
  const entries = Object.entries(models || {}).sort(
    (a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0),
  );
  if (!entries.length) return <p className="db-muted">모델별 데이터 없음</p>;
  return (
    <div className="db-bars">
      {entries.map(([name, m]) => {
        const pct = total > 0 ? ((m.outputTokens || 0) / total) * 100 : 0;
        return (
          <div className="db-bar-row" key={name}>
            <span className="db-bar-name">{name}</span>
            <span className="db-bar-track">
              <span className="db-bar-fill" style={{ width: `${pct.toFixed(1)}%` }} />
            </span>
            <span className="db-bar-val">{fmtTok(m.outputTokens || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

const CHART_COLORS = ['#818cf8', '#34d399', '#fbbf24', '#f87171', '#60a5fa'];
const CHART_GRID = 'rgba(255,255,255,.08)';
const CHART_TICK = '#8b949e';

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
    <div className="db-chart-wrap">
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
    <div className="db-chart-wrap">
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

  return (
    <article className="db-card">
      <div className="db-card-accent" style={{ background: p.color || 'var(--accent, #6366f1)' }} />
      <div className="db-card-body">
        <div className="db-card-head">
          <strong>{p.name}</strong>
          <span className={`db-badge db-${st}`}>
            <i />{STATE_LABEL[st] || st}
          </span>
        </div>
        <p className="db-path" title={p.path}>{p.path}</p>
        <dl className="db-info">
          <div><dt>브랜치</dt><dd>{g.branch || '-'}</dd></div>
          <div>
            <dt>미커밋</dt>
            <dd className={uncommitted > 0 ? 'db-warn' : ''}>{g.uncommittedCount ?? '-'}</dd>
          </div>
          <div><dt>모델</dt><dd>{s.model || '-'}</dd></div>
          <div><dt>최근 활동</dt><dd>{s.lastActivity ? timeAgo(s.lastActivity) : '-'}</dd></div>
          {g.stashCount > 0 && <div><dt>스태시</dt><dd>{g.stashCount}</dd></div>}
          {g.worktrees?.length > 1 && <div><dt>워크트리</dt><dd>{g.worktrees.length}</dd></div>}
          {prs.length > 0 && (
            <div>
              <dt>PR</dt>
              <dd>{prs.length}개{changes > 0 ? ` (수정요청 ${changes})` : approved > 0 ? ` (승인 ${approved})` : ''}</dd>
            </div>
          )}
        </dl>
        {g.recentCommits?.length > 0 && (
          <ul className="db-commits">
            {g.recentCommits.slice(0, 3).map((c, i) => (
              <li key={`${c.hash}-${i}`}>
                <code>{c.hash}</code> {c.message} <span>({c.ago})</span>
              </li>
            ))}
          </ul>
        )}
        {prs.length > 0 && (
          <ul className="db-prs">
            {prs.slice(0, 2).map((pr) => (
              <li key={pr.number}>
                <span>#{pr.number}</span> {pr.title}
              </li>
            ))}
          </ul>
        )}
        <div className="db-card-actions">
          {p.devCmd && (
            <button disabled={busy} onClick={() => onDevToggle(p, devRunning)}>
              {busy ? '처리 중…' : devRunning ? `Dev 중지${dev.port ? ` :${dev.port}` : ''}` : 'Dev 시작'}
            </button>
          )}
          <button disabled={busy} onClick={() => onOpenIde(p)}>VS Code</button>
          <button disabled={busy} onClick={() => onOpenFolder(p)}>폴더</button>
          {p.github && (
            <a className="db-link-btn" href={p.github} target="_blank" rel="noreferrer">GitHub</a>
          )}
        </div>
        {devRunning && dev.command && <p className="db-muted">{dev.command}</p>}
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
        <span className={`db-conn ${connected ? 'on' : 'off'}`} />
        {connected ? '실시간 연결됨' : '연결 중…'} · {projects.length}개 프로젝트{' '}
        <button onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
      </p>
      {error && <p className="db-error">오류: {error}</p>}

      <section className="db-stats">
        <StatTile label="활성 세션" value={stats.active} />
        <StatTile label="열린 PR" value={stats.prCount} />
        <StatTile label="미커밋 파일" value={stats.uncommitted} />
        <StatTile label="오늘 출력 토큰" value={fmtTok(stats.today)} />
      </section>

      {notices.length > 0 && (
        <section className="db-notices">
          {notices.map((n, i) => (
            <div className={`db-notice db-${n.kind}`} key={i}>
              <strong>{n.title}</strong>
              {n.desc && <span>{n.desc}</span>}
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>프로젝트</h2>
        <div className="db-toolbar">
          <input
            type="text"
            placeholder="프로젝트 검색…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {['all', 'active', 'idle'].map((f) => (
            <button
              key={f}
              className={filter === f ? 'active' : ''}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? '전체' : f === 'active' ? '활성' : '유휴'}
            </button>
          ))}
          <select value={sort} onChange={(e) => setSort(e.target.value)} title="정렬">
            <option value="name">이름순</option>
            <option value="activity">활성순</option>
            <option value="recent">최근순</option>
            <option value="uncommitted">미커밋순</option>
          </select>
          <span className="db-muted">{visibleProjects.length}/{projects.length}</span>
        </div>
        {loading && projects.length === 0 ? (
          <p>불러오는 중…</p>
        ) : visibleProjects.length === 0 ? (
          <p className="db-muted">표시할 프로젝트가 없습니다.</p>
        ) : (
          <div className="db-grid">
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
        <h2>비용 및 사용량</h2>
        {!usage ? (
          <p className="db-muted">사용량 데이터 없음</p>
        ) : (
          <div className="db-usage">
            <div className="db-usage-card">
              <h3>오늘 {usage.today?.date ? `(${usage.today.date})` : ''}</h3>
              <p className="db-big">{fmtTok(usage.today?.outputTokens || 0)} 토큰</p>
              <p className="db-muted">
                {usage.today?.messages || 0} 메시지 · {usage.today?.sessions || 0} 세션 ·{' '}
                {usage.today?.toolCalls || 0} 도구 호출
              </p>
              <ModelBars models={usage.today?.models} total={usage.today?.outputTokens || 1} />
              <p className="db-muted">API 환산 약 ${(usage.today?.apiEquivCost || 0).toFixed(2)}</p>
            </div>
            <div className="db-usage-card">
              <h3>이번 주</h3>
              <p className="db-big">{fmtTok(usage.week?.outputTokens || 0)} 토큰</p>
              <p className="db-muted">{usage.week?.messages || 0} 메시지</p>
              <ModelBars models={usage.week?.models} total={usage.week?.outputTokens || 1} />
              <p className="db-muted">API 환산 약 ${(usage.week?.apiEquivCost || 0).toFixed(2)}</p>
            </div>
            <div className="db-usage-card">
              <h3>
                일별 출력 토큰{' '}
                <span className="db-period">
                  {[7, 14, 30].map((d) => (
                    <button
                      key={d}
                      className={period === d ? 'active' : ''}
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
