import { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import './Workflows.css';

const STEP_ICON = { llm: '⬡', shell: '⌘', http: '⇄', condition: '◇' };
const RUN_ICON = { running: '⟳', done: '✓', error: '✗', stopped: '■', pending: '○' };
const RUN_LABEL = { running: '실행 중', done: '완료', error: '오류', stopped: '중단됨', pending: '대기 중' };
const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

function timeAgo(v) {
  if (!v) return '—';
  const t = new Date(v).getTime();
  if (isNaN(t)) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(s, 0)}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function formatDuration(ms) {
  if (ms == null || ms < 0) return '-';
  if (ms < 1000) return '1초 미만';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
}

function putJson(path, body) {
  return fetchJson(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function delJson(path) {
  return fetchJson(path, { method: 'DELETE' });
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// 바닐라 js/workflows.js _getAutoFill()과 동일: 입력 키 → 자동 채움 소스
function autoFillFor(key) {
  const k = String(key || '').toLowerCase();
  if (['code', 'diff', 'codebase'].includes(k)) return { type: 'diff', label: 'Git Diff', icon: '⎇' };
  if (['commits', 'log', 'git_log'].includes(k)) return { type: 'log', label: 'Git Log', icon: '⏱' };
  if (['project_name', 'projectname'].includes(k)) return { type: 'project_name', label: '프로젝트명', icon: '📁' };
  return null;
}

function stepName(steps, id) {
  if (id === 'END') return 'END';
  return steps.find((s) => s.id === id)?.name || id;
}

// 정의 상세: 단계 흐름(선형 + 분기/병렬 표기). 바닐라 buildGraphViz()의 축소판.
function FlowViz({ def }) {
  const steps = def.steps || [];
  const edges = def.edges || [];
  if (!steps.length) return null;
  return (
    <div className="wf-flow wf-graph-viz">
      <div className="wf-flow-start wf-gv-start">START</div>
      {steps.map((s, i) => {
        const edge = edges.find((e) => e.from === s.id);
        return (
          <div key={s.id || i}>
            <div className="wf-flow-conn wf-gv-connector"><span className="wf-gv-line" /><span className="wf-gv-arrowhead">▾</span></div>
            <div className={`wf-flow-node wf-gv-node wf-t-${s.type} wf-gvn-${s.type}`}>
              <span className="wf-flow-num wf-gv-num">{i + 1}</span>
              <span className={`wf-flow-icon wf-gv-icon wf-gv-${s.type}`}>{STEP_ICON[s.type] || '●'}</span>
              <span className="wf-flow-name wf-gv-name">{s.name}</span>
              {s.provider && s.model && (
                <span className={`wf-model wf-model-badge wf-mb-${s.provider}-${s.model}`}>{s.provider}:{s.model}</span>
              )}
              {s.role && <span className="wf-flow-role wf-gv-role">{s.role}</span>}
            </div>
            {edge?.condition && (
              <div className="wf-flow-branch wf-gv-branch">
                <div className="wf-gv-cond-label">조건: <code>{String(edge.condition.pattern || '').slice(0, 40)}</code></div>
                <div className="wf-gv-cond-yes">✓ 일치 → {stepName(steps, edge.condition.true)}</div>
                <div className="wf-gv-cond-no">✗ 불일치 → {Array.isArray(edge.condition.false)
                  ? edge.condition.false.map((t) => stepName(steps, t)).join(', ')
                  : stepName(steps, edge.condition.false)}</div>
              </div>
            )}
            {edge && !edge.condition && edge.to && (
              Array.isArray(edge.to) ? (
                <div className="wf-flow-edge wf-gv-parallel">
                  <div className="wf-gv-parallel-label">병렬 ∥</div>
                  <div className="wf-gv-parallel-nodes">
                    {edge.to.map((t) => (
                      <div key={t} className="wf-gv-pnode">
                        <div className="wf-gv-node"><span className="wf-gv-name">{stepName(steps, t)}</span></div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="wf-flow-edge wf-gv-edge">
                  → {stepName(steps, edge.to)}
                </div>
              )
            )}
          </div>
        );
      })}
      <div className="wf-gv-connector"><span className="wf-gv-line" /></div>
      <div className="wf-gv-end">END</div>
    </div>
  );
}

function Progress({ run }) {
  const steps = run.steps || [];
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'done').length;
  const errors = steps.filter((s) => s.status === 'error').length;
  const pct = total ? Math.round(((done + errors) / total) * 100) : 0;
  let text = `${done}/${total} 단계`;
  if (run.status === 'done') text = `완료 · ${done}/${total} 단계`;
  else if (run.status === 'error') text = `오류 · ${done + errors}/${total} 단계`;
  else if (run.status === 'stopped') text = `중단됨 · ${done}/${total} 단계`;
  else if (run.status === 'running') {
    const cur = steps.find((s) => s.status === 'running');
    text = cur ? `${cur.name}… · ${done}/${total}` : `${done}/${total} 단계`;
  }
  return (
    <div className="wf-progress">
      <div className="wf-progress-head wf-progress-header"><span className="wf-progress-text">{text}</span></div>
      <div className="wf-progress-track wf-progress-bar">
        <div className={`wf-progress-fill wf-pf-${run.status}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SchedulePanel({ workflowId, workflowName, currentInputs, schedules, onChanged, notify }) {
  const existing = schedules.find((s) => s.workflowId === workflowId);
  const [preset, setPreset] = useState(existing?.preset || 'weekly');
  const [hour, setHour] = useState(existing?.hour ?? 9);
  const [day, setDay] = useState(existing?.day ?? 1);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (existing) {
        await putJson(`/api/workflows/schedules/${existing.id}`, { preset, hour, day, inputs: currentInputs });
        notify('스케줄 수정됨');
      } else {
        await postJson('/api/workflows/schedules', { workflowId, workflowName, inputs: currentInputs, preset, hour, day });
        notify('스케줄 등록됨');
      }
      onChanged();
    } catch (e) {
      notify(`스케줄 저장 실패: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (!existing) return;
    try {
      await putJson(`/api/workflows/schedules/${existing.id}`, { enabled: !existing.enabled });
      notify(existing.enabled ? '스케줄 일시정지' : '스케줄 활성화');
      onChanged();
    } catch (e) {
      notify(`실패: ${e.message}`);
    }
  }

  async function remove() {
    if (!existing) return;
    try {
      await delJson(`/api/workflows/schedules/${existing.id}`);
      notify('스케줄 삭제됨');
      onChanged();
    } catch (e) {
      notify(`삭제 실패: ${e.message}`);
    }
  }

  return (
    <div className="wf-sched wf-schedule-panel">
      <div className="wf-sched-header">스케줄</div>
      <div className="wf-sched-body">
      <div className="wf-sched-row">
        <label>반복</label>
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="daily">매일</option>
          <option value="weekly">매주</option>
          <option value="monthly">매월</option>
        </select>
      </div>
      {preset !== 'daily' && (
        <div className="wf-sched-row">
          <label>{preset === 'monthly' ? '날짜' : '요일'}</label>
          {preset === 'monthly' ? (
            <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {Array.from({ length: 28 }, (_, i) => (
                <option key={i + 1} value={i + 1}>{i + 1}일</option>
              ))}
            </select>
          ) : (
            <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {DAY_LABELS.map((d, i) => <option key={i} value={i}>{d}요일</option>)}
            </select>
          )}
        </div>
      )}
      <div className="wf-sched-row">
        <label>시간</label>
        <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
          {Array.from({ length: 24 }, (_, i) => (
            <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
          ))}
        </select>
      </div>
      {existing && (
        <div className="wf-sched-row">
          <label>상태</label>
          <span className={`wf-sched-status ${existing.enabled ? 'active' : 'paused'}`}>{existing.enabled ? '활성' : '일시정지'}</span>
          {existing.nextRunAt && (
            <span className="wf-muted wf-sched-next">다음: {new Date(existing.nextRunAt).toLocaleString('ko-KR')}</span>
          )}
        </div>
      )}
      <div className="actions wf-sched-actions">
        <button className="btn-sm" disabled={busy} onClick={save}>💾 {existing ? '수정' : '저장'}</button>
        {existing && (
          <>
            <button className="btn-sm" onClick={toggle}>{existing.enabled ? '⏸ 일시정지' : '▶ 활성화'}</button>
            <button className="btn-sm btn-danger" onClick={remove}>삭제</button>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

export default function Workflows() {
  const [defs, setDefs] = useState([]);
  const [runs, setRuns] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [projects, setProjects] = useState([]);
  const [activeDefId, setActiveDefId] = useState(null);
  const [fullDef, setFullDef] = useState(null);
  const [inputs, setInputs] = useState({});
  const [projectSel, setProjectSel] = useState('');
  const [activeRunId, setActiveRunId] = useState(null);
  const [runDetail, setRunDetail] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [runFilter, setRunFilter] = useState('');
  const [schedOpen, setSchedOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [autofilling, setAutofilling] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const activeRunIdRef = useRef(null);
  activeRunIdRef.current = activeRunId;

  async function loadDefs() {
    try { setDefs(await fetchJson('/api/workflows')); }
    catch { setDefs([]); }
  }

  async function loadRuns(silent = false) {
    if (!silent) setLoading(true);
    try { setRuns(await fetchJson('/api/workflows/runs')); }
    catch { if (!silent) setRuns([]); }
    finally { if (!silent) setLoading(false); }
  }

  async function loadSchedules() {
    try { setSchedules(await fetchJson('/api/workflows/schedules')); }
    catch { setSchedules([]); }
  }

  async function loadProjects() {
    try {
      const data = await fetchJson('/api/projects');
      setProjects(Array.isArray(data) ? data : []);
    } catch { setProjects([]); }
  }

  async function loadRunDetail(runId, silent = false) {
    if (!silent) setRunDetail({ loading: true });
    try {
      setRunDetail(await fetchJson(`/api/workflows/runs/${runId}`));
    } catch {
      if (!silent) setRunDetail({ error: '실행 상세를 불러오지 못했습니다' });
    }
  }

  useEffect(() => {
    loadDefs();
    loadRuns();
    loadSchedules();
    loadProjects();
    // 바닐라 handleWorkflowEvent()와 동일: /api/events SSE로 실시간 반영
    const es = new EventSource('/api/events');
    const parse = (e) => { try { return JSON.parse(e.data); } catch { return null; } };
    const refreshFor = (d) => {
      loadRuns(true);
      if (d?.runId && d.runId === activeRunIdRef.current) loadRunDetail(d.runId, true);
    };
    const onUpdate = (e) => refreshFor(parse(e));
    const onComplete = (e) => {
      const d = parse(e);
      refreshFor(d);
      setNotice('워크플로 완료');
    };
    const onError = (e) => {
      const d = parse(e);
      refreshFor(d);
      setNotice(`워크플로 오류: ${d?.error || '알 수 없음'}`);
    };
    const onSchedFired = (e) => {
      const d = parse(e);
      setNotice(`⏰ 스케줄 실행: ${d?.workflowName || ''}`);
      loadRuns(true);
    };
    const onSchedChanged = () => loadSchedules();
    const onSchedError = (e) => {
      const d = parse(e);
      setNotice(`⏰ 스케줄 실행 실패: ${d?.error || '알 수 없음'}`);
    };
    es.addEventListener('workflow:update', onUpdate);
    es.addEventListener('workflow:complete', onComplete);
    es.addEventListener('workflow:error', onError);
    es.addEventListener('schedule:fired', onSchedFired);
    es.addEventListener('schedule:update', onSchedChanged);
    es.addEventListener('schedule:error', onSchedError);
    return () => {
      es.removeEventListener('workflow:update', onUpdate);
      es.removeEventListener('workflow:complete', onComplete);
      es.removeEventListener('workflow:error', onError);
      es.removeEventListener('schedule:fired', onSchedFired);
      es.removeEventListener('schedule:update', onSchedChanged);
      es.removeEventListener('schedule:error', onSchedError);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 실행 중인 run이 있으면 10초 폴링 (SSE 보조)
  const hasRunning = runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = setInterval(() => {
      if (document.hidden) return;
      loadRuns(true);
      if (activeRunIdRef.current) loadRunDetail(activeRunIdRef.current, true);
    }, 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRunning]);

  async function selectDef(id) {
    setActiveDefId(id);
    setActiveRunId(null);
    setRunDetail(null);
    setSchedOpen(false);
    setFullDef({ loading: true });
    try {
      const def = await fetchJson(`/api/workflows/${id}`);
      setFullDef(def);
      const init = {};
      for (const inp of (def.inputs || [])) init[inp.key] = inp.default ?? '';
      if (!init.projectPath && projects.length) init.projectPath = projects[0].path || '';
      if (projects.length === 1) {
        setProjectSel(projects[0].id);
        if ('project_name' in init && !init.project_name) {
          init.project_name = projects[0].name || projects[0].id || '';
        }
      }
      setInputs(init);
    } catch {
      setFullDef({ error: '워크플로를 불러오지 못했습니다' });
    }
  }

  function onProjectChange(pid) {
    setProjectSel(pid);
    const project = projects.find((p) => p.id === pid);
    if (!project) return;
    setInputs((prev) => {
      const next = { ...prev };
      if ('project_name' in next && !next.project_name) {
        next.project_name = project.name || project.id || '';
      }
      if ('projectPath' in next) next.projectPath = project.path || '';
      return next;
    });
  }

  async function autofill(key, type) {
    const project = projects.find((p) => p.id === projectSel);
    if (!project && type !== 'project_name') {
      setNotice('먼저 프로젝트를 선택하세요');
      return;
    }
    setAutofilling(key);
    try {
      if (type === 'diff') {
        const data = await fetchJson(`/api/projects/${project.id}/diff`);
        let text = '';
        if (data.staged?.diff) text += data.staged.diff;
        if (data.unstaged?.diff) text += (text ? '\n\n' : '') + data.unstaged.diff;
        setInputs((prev) => ({ ...prev, [key]: text }));
        const n = (data.staged?.files?.length || 0) + (data.unstaged?.files?.length || 0);
        setNotice(n ? `Diff 로드됨 (${n}개 파일)` : '변경 사항 없음');
      } else if (type === 'log') {
        const data = await fetchJson(`/api/projects/${project.id}/git/log?limit=30`);
        const commits = data.commits || [];
        setInputs((prev) => ({
          ...prev,
          [key]: commits.map((c) => `${c.short || c.hash?.slice(0, 7) || '???'} ${c.message || ''}`).join('\n'),
        }));
        setNotice(`${commits.length}개 커밋 로드됨`);
      } else if (type === 'project_name') {
        setInputs((prev) => ({ ...prev, [key]: project?.name || project?.id || '' }));
        setNotice('프로젝트명 입력됨');
      }
    } catch (e) {
      setNotice(`자동 채움 실패: ${e.message}`);
    } finally {
      setAutofilling('');
    }
  }

  async function startRun() {
    if (!activeDefId || !fullDef || fullDef.loading || starting) return;
    setStarting(true);
    try {
      const { runId } = await postJson('/api/workflows/run', { workflowId: activeDefId, inputs });
      setNotice('워크플로 시작됨');
      // 즉시 진행 화면 (바닐라 showImmediateProgress와 동일)
      setActiveDefId(null);
      setActiveRunId(runId);
      setExpanded({});
      setRunDetail({
        runId,
        workflowId: fullDef.id,
        workflowName: fullDef.name,
        status: 'running',
        startedAt: Date.now(),
        inputs: { ...inputs },
        steps: (fullDef.steps || []).map((s) => ({
          ...s, status: 'pending', iterations: 0, startedAt: null, endedAt: null, output: null, error: null,
        })),
        error: null,
      });
      setTimeout(() => loadRuns(true), 500);
    } catch (e) {
      setNotice(`시작 실패: ${e.message}`);
    } finally {
      setStarting(false);
    }
  }

  function selectRun(runId) {
    setActiveDefId(null);
    setActiveRunId(runId);
    setExpanded({});
    loadRunDetail(runId);
  }

  async function stopRun(runId) {
    try {
      await postJson(`/api/workflows/runs/${runId}/stop`, {});
      setNotice('워크플로 중단됨');
    } catch {
      setNotice('중단 실패');
    }
  }

  async function rerun(runId) {
    try {
      const run = await fetchJson(`/api/workflows/runs/${runId}`);
      if (!run?.workflowId) { setNotice('실행 정보 없음'); return; }
      const { runId: newId } = await postJson('/api/workflows/run', {
        workflowId: run.workflowId,
        inputs: run.inputs || {},
      });
      setNotice('다시 실행 시작됨');
      selectRun(newId);
      setTimeout(() => loadRuns(true), 500);
    } catch (e) {
      setNotice(`재실행 실패: ${e.message}`);
    }
  }

  async function copyOutput(text) {
    setNotice((await copyText(text)) ? '복사됨' : '복사 실패');
  }

  const q = runFilter.toLowerCase().trim();
  const filteredRuns = q
    ? runs.filter((r) => `${r.workflowName || r.workflowId || ''} ${r.status || ''}`.toLowerCase().includes(q))
    : runs;
  const hasAutoFill = (fullDef?.inputs || []).some((inp) => autoFillFor(inp.key));
  const lastDoneOutput = runDetail?.status === 'done'
    ? [...(runDetail.steps || [])].reverse().find((s) => s.status === 'done' && s.output)?.output
    : null;

  return (
    <main className="wf">
      <h1>워크플로</h1>
      <p className="wf-toolbar">
        <button onClick={() => { loadDefs(); loadRuns(); loadSchedules(); }}>새로고침</button>
        {notice && <span className="wf-notice">{notice}</span>}
      </p>
      <div className="wf-layout">
        <aside className="wf-side wf-sidebar">
          <section className="wf-section">
            <h2 className="wf-section-hdr"><span>Workflows {defs.length > 0 && <span className="wf-count wf-count-badge">{defs.length}</span>}</span></h2>
            <div className="wf-def-list">
            {loading && defs.length === 0 && <p>불러오는 중…</p>}
            {!loading && defs.length === 0 && <p className="wf-muted">워크플로 없음</p>}
            {defs.map((d) => (
              <div
                key={d.id}
                className={`wf-item wf-def-item${activeDefId === d.id ? ' active' : ''}`}
                onClick={() => selectDef(d.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') selectDef(d.id); }}
              >
                <div className="wf-item-name wf-def-name">
                  <span className="wf-def-icon">{d.hasCycles ? '⟲' : '⬡'}</span> {d.name}
                  {schedules.some((s) => s.workflowId === d.id && s.enabled) && (
                    <span className="wf-sched-badge" title="스케줄 활성"> ⏰</span>
                  )}
                </div>
                {d.description && <div className="wf-muted wf-def-desc">{d.description}</div>}
                <div className="wf-muted wf-def-meta">
                  {d.stepCount || 0} agents
                  {d.maxIterations ? ` · 최대 ${d.maxIterations} cycles` : ''}
                  {d.models?.length ? ` · ${d.models.join(', ')}` : ''}
                </div>
              </div>
            ))}
            </div>
          </section>
          <section className="wf-section">
            <h2 className="wf-section-hdr"><span>실행 기록 {runs.length > 0 && <span className="wf-count wf-count-badge">{runs.length}</span>}</span></h2>
            <div className="wf-run-search">
            <input
              className="wf-filter"
              placeholder="실행 검색…"
              value={runFilter}
              onChange={(e) => setRunFilter(e.target.value)}
            />
            </div>
            <div className="wf-run-list">
            {filteredRuns.length === 0 && <p className="wf-muted wf-empty-msg">실행 기록 없음</p>}
            {filteredRuns.map((r) => (
              <div
                key={r.runId}
                className={`wf-item wf-run-item${activeRunId === r.runId ? ' active' : ''}`}
                onClick={() => selectRun(r.runId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') selectRun(r.runId); }}
              >
                <span className={`wf-st wf-st-${r.status} wf-run-status wf-st-${r.status}`}>{RUN_ICON[r.status] || '?'}</span>{' '}
                <span className="wf-run-info">
                  <span className="wf-run-name">{r.workflowName || r.workflowId}</span>
                  <div className="wf-muted wf-run-time">{timeAgo(r.startedAt)}</div>
                </span>
              </div>
            ))}
            </div>
          </section>
        </aside>

        <section className="wf-main">
          {!activeDefId && !activeRunId && (
            <div className="wf-empty">
              <div className="wf-empty-graph">
                <div className="wf-empty-node wf-en-1" />
                <div className="wf-empty-edge" />
                <div className="wf-empty-node wf-en-2" />
                <div className="wf-empty-edge" />
                <div className="wf-empty-node wf-en-3" />
              </div>
              <h2 className="wf-empty-title">Multi-Agent Workflows</h2>
              <p className="wf-empty-desc">LLM 에이전트·셸 명령·조건 분기로 자동화 파이프라인을 실행합니다. 왼쪽에서 워크플로를 선택하세요.</p>
              <div className="wf-empty-hints">
                <div className="wf-empty-hint"><span className="wf-eh-icon">⬡</span> LLM 에이전트</div>
                <div className="wf-empty-hint"><span className="wf-eh-icon">⌘</span> 셸 명령</div>
                <div className="wf-empty-hint"><span className="wf-eh-icon">◇</span> 조건 분기</div>
              </div>
            </div>
          )}

          {activeDefId && fullDef?.loading && <p>불러오는 중…</p>}
          {activeDefId && fullDef?.error && <p className="wf-error">{fullDef.error}</p>}
          {activeDefId && fullDef && !fullDef.loading && !fullDef.error && (
            <>
              <div className="wf-detail-head">
                <h2 className="wf-detail-title">{fullDef.name}</h2>
                {fullDef.description && <p className="wf-muted wf-detail-desc">{fullDef.description}</p>}
              </div>
              <FlowViz def={fullDef} />
              <div className="wf-inputs">
              <h3 className="wf-section-label">입력</h3>
              {hasAutoFill && projects.length > 0 && (
                <div className="wf-field wf-input-row wf-project-picker">
                  <label>프로젝트 컨텍스트</label>
                  <select value={projectSel} onChange={(e) => onProjectChange(e.target.value)}>
                    <option value="">— 프로젝트 선택 —</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
                  </select>
                </div>
              )}
              {(fullDef.inputs || []).map((inp) => {
                const af = autoFillFor(inp.key);
                return (
                  <div className="wf-field wf-input-row" key={inp.key}>
                    <div className="wf-field-head wf-input-label-row">
                      <label>{inp.label}{inp.required ? ' *' : ''}</label>
                      {af && (
                        <button className="wf-autofill-btn" disabled={autofilling === inp.key} onClick={() => autofill(inp.key, af.type)}>
                          {autofilling === inp.key ? '…' : `${af.icon} ${af.label}`}
                        </button>
                      )}
                    </div>
                    {inp.type === 'select' ? (
                      <select value={inputs[inp.key] ?? ''} onChange={(e) => setInputs((p) => ({ ...p, [inp.key]: e.target.value }))}>
                        {(inp.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : inp.type === 'textarea' ? (
                      <textarea
                        rows={6}
                        placeholder={inp.label}
                        value={inputs[inp.key] ?? ''}
                        onChange={(e) => setInputs((p) => ({ ...p, [inp.key]: e.target.value }))}
                      />
                    ) : (
                      <input
                        type="text"
                        placeholder={inp.label}
                        value={inputs[inp.key] ?? ''}
                        onChange={(e) => setInputs((p) => ({ ...p, [inp.key]: e.target.value }))}
                      />
                    )}
                  </div>
                );
              })}
              <div className="actions wf-actions">
                <button className="btn wf-run-btn" disabled={starting} onClick={startRun}>{starting ? '시작 중…' : '▶ 실행'}</button>
                <button className="wf-schedule-btn" onClick={() => setSchedOpen((v) => !v)}>⏰ 스케줄{schedules.some((s) => s.workflowId === activeDefId && s.enabled) && <span className="wf-sched-badge"> ●</span>}</button>
              </div>
              </div>
              {schedOpen && (
                <SchedulePanel
                  key={activeDefId}
                  workflowId={activeDefId}
                  workflowName={fullDef.name}
                  currentInputs={inputs}
                  schedules={schedules}
                  notify={setNotice}
                  onChanged={loadSchedules}
                />
              )}
            </>
          )}

          {activeRunId && runDetail?.loading && <p>불러오는 중…</p>}
          {activeRunId && runDetail?.error && <p className="wf-error">{runDetail.error}</p>}
          {activeRunId && runDetail && !runDetail.loading && !runDetail.error && (
            <>
              <div className="wf-run-head">
                <h2 className="wf-run-title">{runDetail.workflowName || runDetail.workflowId} <span className="wf-muted wf-run-id">#{String(runDetail.runId).slice(0, 8)}</span></h2>
                <span className={`wf-badge wf-run-status-badge wf-st-${runDetail.status}`}>
                  {RUN_LABEL[runDetail.status] || runDetail.status}
                </span>
                {runDetail.status === 'running' && (
                  <button className="btn wf-stop-btn" onClick={() => stopRun(runDetail.runId)}>■ 중단</button>
                )}
                {runDetail.status !== 'running' && (
                  <button className="btn wf-rerun-btn" onClick={() => rerun(runDetail.runId)}>↻ 재실행</button>
                )}
                {runDetail.startedAt && runDetail.endedAt && (
                  <span className="wf-muted wf-est-badge">소요 {formatDuration(runDetail.endedAt - runDetail.startedAt)}</span>
                )}
              </div>
              <Progress run={runDetail} />
              <div className="wf-steps">
                {(runDetail.steps || []).map((s) => {
                  const open = !!expanded[s.id];
                  const clickable = s.status === 'done' || s.status === 'error';
                  return (
                    <div className={`wf-step wf-step-card wf-sc-${s.status}${open ? ' expanded' : ''}`} key={s.id}>
                      <div
                        className="wf-step-head wf-sc-head"
                        role={clickable ? 'button' : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        onClick={() => { if (clickable) setExpanded((p) => ({ ...p, [s.id]: !p[s.id] })); }}
                        onKeyDown={(e) => { if (clickable && e.key === 'Enter') setExpanded((p) => ({ ...p, [s.id]: !p[s.id] })); }}
                      >
                        <span className="wf-sc-status-icon">{RUN_ICON[s.status] || '○'}</span>
                        <span className="wf-sc-name">{clickable ? (open ? '▾' : '▸') : ''} {s.name}</span>
                        {s.iterations > 1 && <span className="wf-sc-iter">×{s.iterations}</span>}
                        <span className="wf-muted wf-sc-type">{s.type}</span>
                        {s.provider && s.model && <span className="wf-model wf-model-badge">{s.provider}:{s.model}</span>}
                        <span className="wf-muted wf-sc-duration">
                          {s.startedAt && s.endedAt ? `${((s.endedAt - s.startedAt) / 1000).toFixed(1)}초` : s.startedAt ? '…' : ''}
                        </span>
                        <span className="wf-sc-expand-icon">{clickable ? (open ? '▾' : '▸') : ''}</span>
                      </div>
                      {s.role && <div className="wf-muted wf-sc-role">{s.role}</div>}
                      {open && (s.output || s.error) && (
                        <div className="wf-sc-output">
                          <pre className={`wf-output wf-sc-output-body${s.error ? ' wf-output-error' : ''}`}>{s.output || s.error}</pre>
                          {s.output && <button className="wf-sc-copy-btn" onClick={() => copyOutput(s.output)}>복사</button>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {lastDoneOutput && (
                <div className="wf-final wf-final-output">
                  <h3 className="wf-section-label">최종 출력</h3>
                  <pre className="wf-output wf-output-body">{lastDoneOutput}</pre>
                  <div className="wf-final-actions"><button className="btn" onClick={() => copyOutput(lastDoneOutput)}>복사</button></div>
                </div>
              )}
              {runDetail.error && (
                <div className="wf-final wf-final-error wf-final-output">
                  <h3 className="wf-section-label">오류</h3>
                  <pre className="wf-output wf-output-body wf-output-error">{runDetail.error}</pre>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
