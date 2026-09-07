// ─── Autopilot control view ───
import { app } from './state.js';
import { esc, fetchJson, postJson, showToast } from './utils.js';

export function initAutopilotView() {
  if (!app._autopilotInit) {
    app._autopilotInit = true;
    document.getElementById('autopilot-view')?.addEventListener('click', onClick);
  }
  load();
  if (!app._autopilotTimer) {
    app._autopilotTimer = setInterval(() => {
      // Autopilot 뷰를 벗어난 동안엔 API 폴링을 쉰다
      if (document.getElementById('autopilot-view')?.classList.contains('active')) load();
    }, 5000);
  }
}

export function destroyAutopilotView() {
  if (app._autopilotTimer) { clearInterval(app._autopilotTimer); app._autopilotTimer = null; }
}

async function onClick(e) {
  const b = e.target.closest('[data-ap-mode]');
  if (!b) return;
  const mode = b.dataset.apMode;
  try {
    await postJson('/api/autopilot/mode', { mode });
    showToast(mode === 'unattended' ? '무인 운영 켜짐 — 위험한 것만 폰으로' : '대면 모드 — 화면에서 확인', 'success');
    load();
  } catch { showToast('모드 변경 실패', 'error'); }
}

async function load() {
  let status, briefing;
  try {
    [status, briefing] = await Promise.all([
      fetchJson('/api/autopilot/status'),
      fetchJson('/api/autopilot/briefing'),
    ]);
  } catch { return; }
  render(status, briefing);
}

const ACTION_META = {
  auto: { label: '자동', cls: 'ap-auto' },
  escalate: { label: '에스컬', cls: 'ap-esc' },
  block: { label: '차단', cls: 'ap-block' },
  review: { label: '검토', cls: 'ap-review' },
};
const DECISION_ICON = { approve: '✅', deny: '⛔', ask: '⏸' };

function tile(label, value, cls = '') {
  return `<div class="ap-tile ${cls}"><div class="ap-tile-n">${value}</div><div class="ap-tile-k">${label}</div></div>`;
}

function render(s, b) {
  const el = document.getElementById('autopilot-view');
  if (!el) return;
  const m = s.metrics || {};
  const mode = s.mode || 'attended';
  const recent = (s.recent || []).slice().reverse();

  el.innerHTML = `
    <div class="ap-head">
      <div>
        <h2 class="ap-title">Autopilot</h2>
        <p class="ap-sub">에이전트 도구 호출을 정책으로 게이트 — 안전한 건 자동, 위험한 건 확인.</p>
      </div>
      <div class="ap-mode" role="group" aria-label="mode">
        <button class="ap-mode-btn ${mode === 'attended' ? 'active' : ''}" data-ap-mode="attended">대면 (화면 확인)</button>
        <button class="ap-mode-btn ${mode === 'unattended' ? 'active' : ''}" data-ap-mode="unattended">무인 (폰 승인)</button>
      </div>
    </div>

    <div class="ap-tiles">
      ${tile('자동 실행', m.auto || 0, 'ap-auto')}
      ${tile('검토 위임', m.review || 0, 'ap-review')}
      ${tile('에스컬', m.escalate || 0, 'ap-esc')}
      ${tile('차단', m.block || 0, 'ap-block')}
      ${tile('폰 승인', m.approved || 0)}
      ${tile('폰 거부', (m.denied || 0) + (m.timedOut || 0))}
    </div>

    <div class="ap-cols">
      <div class="ap-panel">
        <div class="ap-panel-h">최근 결정</div>
        <div class="ap-list">
          ${recent.length ? recent.map(r => `
            <div class="ap-row">
              <span class="ap-badge ${ACTION_META[r.action]?.cls || ''}">${ACTION_META[r.action]?.label || r.action}</span>
              <span class="ap-dec">${DECISION_ICON[r.decision] || ''}</span>
              <code class="ap-snip">${esc(r.snippet || r.tool || '')}</code>
            </div>`).join('') : '<div class="ap-empty">아직 결정 없음. 훅을 켜면 여기 실시간으로 쌓입니다.</div>'}
        </div>
      </div>
      <div class="ap-panel">
        <div class="ap-panel-h">브리핑</div>
        <pre class="ap-brief">${esc(b?.summary || '—')}</pre>
      </div>
    </div>
  `;
}
