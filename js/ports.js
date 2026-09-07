// ─── Port Manager Module ───
import { app } from './state.js';
import { esc, showToast, fetchJson, postJson, preserveScroll } from './utils.js';

// ─── Init ───
export function initPorts() {
  const guardedLoad = () => {
    // Ports 뷰를 벗어난 동안엔 5초 스캔 API를 부르지 않는다
    if (document.getElementById('ports-view')?.classList.contains('active')) loadPorts();
  };
  if (app._portsInitialized) {
    if (app.portsData.length) renderPorts();
    // Restart timer if it was cleared by destroyPorts()
    if (!app._portsTimer) {
      app._portsTimer = setInterval(guardedLoad, 5000);
    }
    return;
  }
  app._portsInitialized = true;
  loadPorts();
  app._portsTimer = setInterval(guardedLoad, 5000);
}

export function destroyPorts() {
  if (app._portsTimer) { clearInterval(app._portsTimer); app._portsTimer = null; }
}

// ─── Load ───
async function loadPorts() {
  if (app._portsPaused) return;
  try {
    const data = await fetchJson('/api/ports');
    app.portsData = Array.isArray(data) ? data : [];
    renderPorts();
  } catch { /* silent */ }
}

export function refreshPorts() { loadPorts(); }

export function togglePortPause() {
  app._portsPaused = !app._portsPaused;
  const btn = document.getElementById('port-pause-btn');
  if (btn) {
    btn.title = app._portsPaused ? 'Resume' : 'Pause';
    btn.classList.toggle('monitor-paused', app._portsPaused);
    btn.innerHTML = app._portsPaused
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  }
}

export function filterPortSearch(query) {
  app.ports.search = query;
  renderPorts();
}

export function toggleDevFilter(checked) {
  app.ports.devOnly = checked;
  renderPorts();
}

export function sortPortsBy(col) {
  if (app.ports.sortCol === col) app.ports.sortAsc = !app.ports.sortAsc;
  else { app.ports.sortCol = col; app.ports.sortAsc = true; }
  renderPorts();
}

export async function killPort(pid, name) {
  if (!confirm(`Kill process "${name}" (PID ${pid})?`)) return;
  try {
    await postJson('/api/ports/kill', { pid });
    showToast(`Killed PID ${pid}`, 'success');
    loadPorts();
  } catch (err) {
    showToast(err.message || 'Failed to kill process', 'error');
  }
}

export function openPortInBrowser(port) {
  postJson('/api/open-url', { url: `http://localhost:${port}` }).catch(() => {
    window.open(`http://localhost:${port}`, '_blank');
  });
}

// ─── Render ───
function renderPorts() {
  const el = document.getElementById('port-content');
  if (!el) return;
  const data = app.portsData;

  // Filter
  let filtered = data;
  if (app.ports.devOnly) filtered = filtered.filter(p => p.isDevServer);
  const q = app.ports.search.toLowerCase();
  if (q) filtered = filtered.filter(p =>
    String(p.port).includes(q) ||
    p.processName.toLowerCase().includes(q) ||
    (p.projectName || '').toLowerCase().includes(q)
  );

  // Sort
  const { sortCol, sortAsc } = app.ports;
  filtered = [...filtered].sort((a, b) => {
    let va, vb;
    if (sortCol === 'port') { va = a.port; vb = b.port; }
    else if (sortCol === 'process') { va = a.processName.toLowerCase(); vb = b.processName.toLowerCase(); }
    else if (sortCol === 'pid') { va = a.pid; vb = b.pid; }
    else { va = a.port; vb = b.port; }
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });

  const sortIcon = (col) => sortCol === col ? (sortAsc ? ' ▲' : ' ▼') : '';
  const devCount = data.filter(p => p.isDevServer).length;

  preserveScroll(el, () => {
    el.innerHTML = `
    <table class="port-table">
      <thead><tr>
        <th class="port-sortable" data-action="port-sort" data-col="port">Port${sortIcon('port')}</th>
        <th class="port-sortable" data-action="port-sort" data-col="process">Process${sortIcon('process')}</th>
        <th class="port-sortable" data-action="port-sort" data-col="pid">PID${sortIcon('pid')}</th>
        <th>Address</th>
        <th>Project</th>
        <th>Actions</th>
      </tr></thead>
      <tbody>${filtered.length ? filtered.map(p => `<tr class="${p.isDevServer ? 'port-row-dev' : ''}">
        <td class="port-num">${p.port}</td>
        <td class="port-pname">${esc(p.processName)}</td>
        <td class="port-pid">${p.pid}</td>
        <td class="port-addr">${esc(p.address)}</td>
        <td>${p.isDevServer ? `<span class="port-badge-dev">${esc(p.projectName || p.projectId)}</span>` : ''}</td>
        <td class="port-actions">
          ${p.port >= 1024 ? `<button class="dt-icon-btn port-action-btn" data-action="port-open" data-port="${p.port}" title="Open in browser"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>` : ''}
          <button class="dt-icon-btn port-action-btn port-kill-btn" data-action="port-kill" data-pid="${p.pid}" data-name="${esc(p.processName)}" title="Kill process"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </td>
      </tr>`).join('') : '<tr><td colspan="6" class="port-empty">No listening ports found</td></tr>'}</tbody>
    </table>
    <div class="port-summary">${data.length} ports · ${devCount} dev servers</div>
  `;
  });

  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'port-sort') sortPortsBy(btn.dataset.col);
      else if (btn.dataset.action === 'port-kill') killPort(+btn.dataset.pid, btn.dataset.name);
      else if (btn.dataset.action === 'port-open') openPortInBrowser(+btn.dataset.port);
    });
  }
}
