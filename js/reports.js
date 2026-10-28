import { esc, fetchJson, simpleMarkdown, copyText } from './utils.js';

let root, reports = [], selected = '', preview = null, version = 0, refreshVersion = 0, mutating = false;
let libraryCollapsed = false;
const date = at => at ? new Date(at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '파일 확인 필요';

export function reportDocument(content, kind) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">`;
  if (kind === 'html') return `<!doctype html>${policy}${content}`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">${policy}<style>
    *{box-sizing:border-box}body{margin:0;padding:28px;color:#232a31;background:#fff;font:15px/1.75 system-ui,sans-serif;overflow-wrap:anywhere}
    main{max-width:75ch;margin:auto}h1{font-size:26px;line-height:1.35}h2{font-size:21px;margin-top:28px}h3{font-size:18px;margin-top:24px}
    a{color:#285a86;text-underline-offset:3px}table{border-collapse:collapse;display:block;max-width:100%;overflow:auto;font-size:14px}
    th,td{padding:8px 12px;border:1px solid #c9d1d9;text-align:left}th{background:#f1f4f6}pre{padding:14px;background:#f1f4f6;overflow:auto;white-space:pre}
    code{font:13px/1.65 ui-monospace,monospace}blockquote{margin:16px 0;padding:0 16px;border-left:1px solid #8d9dab;color:#52616e}
    @media(max-width:600px){body{padding:18px}h1{font-size:23px}}
  </style></head><body><main>${simpleMarkdown(content)}</main></body></html>`;
}

function message(text, error = false) {
  const element = root.querySelector('[data-report-status]');
  element.textContent = text; element.dataset.error = String(error);
}

function setLibraryCollapsed(collapsed) {
  libraryCollapsed = collapsed;
  root.querySelector('.report-library').hidden = collapsed;
  root.querySelector('[data-report-registration]').hidden = collapsed;
  root.querySelector('.reports-layout').classList.toggle('report-library-collapsed', collapsed);
  const button = root.querySelector('[data-report-toggle-library]');
  button.textContent = collapsed ? '목록 보기' : '목록 접기';
  button.setAttribute('aria-expanded', String(!collapsed));
}

function renderList() {
  const search = root.querySelector('[data-report-search]').value.trim().toLocaleLowerCase();
  const kind = root.querySelector('[data-report-kind]').value;
  const visible = reports.filter(report => (!kind || report.kind === kind)
    && [report.title, report.name, report.path, report.project, report.session].join(' ').toLocaleLowerCase().includes(search));
  root.querySelector('[data-report-count]').textContent = `${visible.length} / ${reports.length}개`;
  const list = root.querySelector('[data-report-list]');
  const scroll = list.scrollTop;
  list.innerHTML = visible.map(report => `<button type="button" class="report-row" data-report-select="${esc(report.id)}" aria-pressed="${selected === report.id}">
    <span class="report-row-top"><strong>${esc(report.title)}</strong><span class="report-format">${report.kind === 'html' ? 'HTML' : 'MD'}</span></span>
    <span class="report-row-meta">${esc(report.project || '프로젝트 확인 필요')}${report.session ? ` · ${esc(report.session)}` : ''}</span>
    <span class="report-row-meta">${report.available ? `수정 ${esc(date(report.modifiedAt))}` : '원본 파일 확인 필요'}</span>
    <span class="report-row-path" title="${esc(report.path)}">${esc(report.name)}</span>
  </button>`).join('') || `<div class="report-empty"><h2>${reports.length ? '검색 결과가 없습니다' : '보고서를 모아두세요'}</h2><p>${reports.length ? '제목·프로젝트·세션·경로로 검색할 수 있습니다.' : 'HTML·MD 파일 경로를 등록하면 이 목록에서 다시 열 수 있습니다.'}</p>${reports.length ? '<button type="button" class="btn" data-report-clear>필터 초기화</button>' : '<button type="button" class="btn" data-report-add>첫 보고서 등록</button>'}</div>`;
  list.scrollTop = scroll;
}

function renderDetail(report) {
  preview = null;
  root.querySelector('[data-report-detail]').innerHTML = report ? `<div class="report-detail-head"><div><h2>${esc(report.title)}</h2><p>${esc(report.project)}${report.session ? ` · ${esc(report.session)}` : ''} · ${esc(date(report.modifiedAt))}</p></div>
    <div class="report-detail-actions"><button type="button" class="btn" data-report-copy>경로 복사</button><button type="button" class="btn" data-report-download disabled>파일 내려받기</button><button type="button" class="btn" data-report-remove title="보고서 목록에서 삭제합니다. 원본 파일은 유지됩니다.">목록에서 삭제</button></div></div>
    <p class="report-source" title="${esc(report.path)}">${esc(report.path)}</p>
    <div class="report-preview" data-report-preview><p class="report-empty" role="status">내용을 불러오는 중…</p></div>
    <p class="report-preview-note">${report.kind === 'html' ? 'HTML은 스크립트 없이 미리봅니다. 동적인 보고서는 파일을 내려받아 열어주세요.' : '원본 파일의 최신 내용입니다.'}</p>`
    : '<div class="report-empty report-detail-empty"><h2>읽을 보고서를 선택하세요</h2><p>목록에서 HTML·MD 보고서를 선택하면 여기에서 내용을 볼 수 있습니다.</p></div>';
}

async function selectReport(id, focus = false) {
  selected = id;
  const report = reports.find(report => report.id === id);
  const requestVersion = ++version;
  renderList(); renderDetail(report);
  if (!report) return;
  if (focus) {
    const detail = root.querySelector('[data-report-detail]');
    detail.focus({ preventScroll: true });
    if (window.innerWidth <= 900) detail.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  try {
    const data = await fetchJson(`/api/file?path=${encodeURIComponent(report.path)}`);
    if (requestVersion !== version || selected !== id) return;
    const frame = document.createElement('iframe');
    frame.title = `${report.title} 미리보기`;
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.srcdoc = reportDocument(data.content, report.kind);
    root.querySelector('[data-report-preview]').replaceChildren(frame);
    preview = { ...data, kind: report.kind, id };
    root.querySelector('[data-report-download]').disabled = false;
  } catch (error) {
    if (requestVersion !== version) return;
    const area = root.querySelector('[data-report-preview]');
    area.replaceChildren();
    const paragraph = document.createElement('p');
    paragraph.className = 'report-empty'; paragraph.setAttribute('role', 'alert');
    paragraph.textContent = `보고서를 열지 못했습니다. ${error.message}`;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn'; button.dataset.reportRetry = ''; button.textContent = '다시 불러오기';
    area.append(paragraph, button);
  }
}

async function refresh() {
  const requestVersion = ++refreshVersion;
  root.querySelector('[data-report-refresh]').disabled = true;
  message('목록 확인 중…');
  try {
    const data = await fetchJson('/api/reports');
    if (requestVersion !== refreshVersion) return;
    reports = data.reports;
    if (!reports.some(report => report.id === selected)) selected = '';
    renderList(); message(`${reports.length}개 보고서 · 원본 파일 기준으로 갱신됨`);
    if (selected) await selectReport(selected);
    else renderDetail(null);
    return true;
  } catch (error) {
    if (requestVersion === refreshVersion) {
      message(`목록을 불러오지 못했습니다. ${error.message}`, true);
      return false;
    }
  }
  finally { if (requestVersion === refreshVersion) root.querySelector('[data-report-refresh]').disabled = false; }
}

export function openReportRegister(path = '') {
  root = document.getElementById('reports-view');
  if (!root.querySelector('[data-report-form]')) mount();
  setLibraryCollapsed(false);
  root.querySelector('[data-report-registration]').open = true;
  const field = root.querySelector('[name="path"]');
  if (path) field.value = path;
  field.focus({ preventScroll: true });
}

async function register(event) {
  event.preventDefault();
  if (mutating) return;
  mutating = true;
  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const feedback = form.querySelector('[data-report-register-status]');
  feedback.textContent = '등록 중…';
  try {
    const data = await fetchJson('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    selected = data.report.id;
    reports = [...reports.filter(report => report.id !== selected), data.report]
      .sort((a, b) => (b.modifiedAt || b.registeredAt) - (a.modifiedAt || a.registeredAt));
    renderList();
    form.reset(); root.querySelector('[data-report-registration]').open = false;
    feedback.textContent = '';
    const refreshed = await refresh();
    if (refreshed) message('보고서가 등록되었습니다. 같은 경로는 중복으로 추가하지 않습니다.');
    else if (refreshed === false) {
      message(`등록은 저장됐습니다. ${root.querySelector('[data-report-status]').textContent}`, true);
      await selectReport(selected);
    }
    root.querySelector('[data-report-detail]').focus({ preventScroll: true });
  } catch (error) { feedback.textContent = `등록하지 못했습니다. ${error.message}`; }
  finally { mutating = false; button.disabled = false; }
}

async function remove() {
  if (mutating || !selected) return;
  const id = selected;
  mutating = true;
  const button = root.querySelector('[data-report-remove]'); button.disabled = true;
  try {
    await fetchJson(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
    reports = reports.filter(report => report.id !== id); renderList();
    if (selected === id) { selected = ''; ++version; renderDetail(null); }
    const refreshed = await refresh();
    if (refreshed) message('목록에서 제거했습니다. 원본 파일은 그대로 있습니다.');
    else if (refreshed === false) message(`목록 제거는 저장됐습니다. ${root.querySelector('[data-report-status]').textContent}`, true);
    root.querySelector(libraryCollapsed ? '[data-report-toggle-library]' : '[data-report-search]').focus({ preventScroll: true });
  } catch (error) { message(`제거하지 못했습니다. ${error.message}`, true); }
  finally { mutating = false; if (button.isConnected) button.disabled = false; }
}

function download() {
  if (!preview || preview.id !== selected) return;
  const url = URL.createObjectURL(new Blob([preview.content], { type: preview.kind === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = preview.name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function mount() {
  root.innerHTML = `<div class="reports-head"><div><h1>보고서 관리</h1><p>여러 세션의 HTML·MD 보고서를 한곳에서 읽습니다.</p></div><div><button type="button" class="btn" data-report-toggle-library aria-controls="report-library" aria-expanded="true">목록 접기</button><button type="button" class="btn" data-report-refresh>새로고침</button><button type="button" class="btn" data-report-add>보고서 등록</button></div></div>
    <details class="report-registration" data-report-registration><summary>파일 경로로 등록</summary><form data-report-form>
      <label class="report-path-field">파일 경로<input name="path" required maxlength="4096" placeholder="/home/.../보고서.md 또는 C:\\...\\보고서.html" autocomplete="off"></label>
      <label>제목 <span>(선택)</span><input name="title" maxlength="200" placeholder="비워두면 파일명을 사용합니다"></label>
      <label>작성 세션 <span>(선택)</span><input name="session" maxlength="80" placeholder="예: ai7" autocomplete="off"></label>
      <button type="submit" class="btn">목록에 등록</button><p class="report-register-hint">등록된 프로젝트 폴더의 HTML·MD 파일을 연결합니다. 목록에서 제거해도 원본은 유지됩니다.</p>
      <p data-report-register-status role="status"></p></form></details>
    <p class="report-status" data-report-status role="status"></p>
    <div class="reports-layout"><section class="report-library" id="report-library" aria-label="보고서 목록"><div class="report-filters"><label>검색<input type="search" data-report-search placeholder="제목·프로젝트·세션·경로"></label><label>형식<select data-report-kind><option value="">전체</option><option value="html">HTML</option><option value="md">MD</option></select></label></div>
      <div class="report-list-heading"><span>최근 수정 순</span><span data-report-count>0개</span></div><div class="report-list" data-report-list></div></section>
      <section class="report-detail" data-report-detail tabindex="-1" aria-label="보고서 미리보기"></section></div>`;
  root.querySelector('[data-report-form]').addEventListener('submit', register);
  root.querySelector('[data-report-search]').addEventListener('input', renderList);
  root.querySelector('[data-report-kind]').addEventListener('change', renderList);
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-report-add')) openReportRegister();
    else if (button.hasAttribute('data-report-toggle-library')) setLibraryCollapsed(!libraryCollapsed);
    else if (button.hasAttribute('data-report-refresh')) refresh();
    else if (button.dataset.reportSelect) selectReport(button.dataset.reportSelect, true);
    else if (button.hasAttribute('data-report-clear')) { root.querySelector('[data-report-search]').value = ''; root.querySelector('[data-report-kind]').value = ''; renderList(); }
    else if (button.hasAttribute('data-report-retry')) selectReport(selected);
    else if (button.hasAttribute('data-report-remove')) remove();
    else if (button.hasAttribute('data-report-download')) download();
    else if (button.hasAttribute('data-report-copy')) { const report = reports.find(report => report.id === selected); if (report) copyText(report.path); }
  });
  setLibraryCollapsed(libraryCollapsed);
  renderList(); renderDetail(null);
}

export async function initReports() {
  root = document.getElementById('reports-view');
  if (!root.querySelector('[data-report-form]')) mount();
  await refresh();
}
