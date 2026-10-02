import { computeUsage, getStatsCache, getCostInsights } from '../lib/cost-service.js';
import { getRecentActivity, discoverProjects } from '../lib/claude-data.js';
import { generateQRSvg } from '../lib/qr.js';
import { checkAlerts, generateBriefing, getAlertPrefs, saveAlertPrefs } from '../lib/briefing-service.js';
import { getWhitelist, executeBatch, stopBatch, getBatchStatus } from '../lib/batch-service.js';
import { IS_WIN, getIdeBin, getIdeSpawnOpts, getFirefoxDevBin, openUrl as platformOpenUrl, openFolder as platformOpenFolder, safeSpawnDetached } from '../lib/platform.js';

export function register(ctx) {
  const { addRoute, json, readBody, rateLimit, getProjects, getProjectById, addProject, poller, LAN_TOKEN, isInsideAnyProject, isLocalhost, authCookie, toWinPath, PORT, LIMITS, join, resolve, normalize, readFile, readdir, stat, writeFile, mkdir, spawn, tmpdir, randomBytes, timingSafeEqual } = ctx;

  // ──────────── Inline helpers ────────────

  // Paste image temp directory
  const PASTE_DIR = join(tmpdir(), 'cockpit-paste');

  // Auto-cleanup paste images older than 1 hour (runs every 30 min)
  async function cleanupPasteImages() {
    try {
      const { unlinkSync } = await import('node:fs');
      const files = await readdir(PASTE_DIR);
      const now = Date.now();
      for (const f of files) {
        if (!f.startsWith('paste-')) continue;
        const fp = join(PASTE_DIR, f);
        const s = await stat(fp);
        if (now - s.mtimeMs > 60 * 60 * 1000) try { unlinkSync(fp); } catch { /* file already removed */ }
      }
    } catch { /* cleanup failed */ }
  }
  setInterval(cleanupPasteImages, 30 * 60 * 1000);
  setTimeout(cleanupPasteImages, 5000);

  // Alias for path validation
  const isInsideProject = isInsideAnyProject;

  // Mutable notification toggle state
  let _notifyEnabled = true;
  ctx.getNotifyEnabled = () => _notifyEnabled;

  // ──────────── Auth ────────────

  addRoute('POST', '/api/auth/login', async (req, res) => {
    // Rate limit: 10 attempts per minute per IP
    const clientIP = req.socket.remoteAddress || 'unknown';
    if (!rateLimit(`auth:${clientIP}`, 10)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many login attempts. Try again in 1 minute.' }));
      return;
    }
    const body = await readBody(req);
    const token = body.token;
    if (!token || token.length !== LAN_TOKEN.length) return json(res, { error: 'Invalid token' }, 401);
    try {
      if (!timingSafeEqual(Buffer.from(token), Buffer.from(LAN_TOKEN))) {
        return json(res, { error: 'Invalid token' }, 401);
      }
    } catch { return json(res, { error: 'Invalid token' }, 401); }
    res.writeHead(200, {
      'Set-Cookie': authCookie(req),
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify({ success: true }));
  });

  // ──────────── Upload ────────────

  // Upload clipboard image → temp file, return absolute path
  // MAJOR-5: Image upload with size limit (10 MB)
  addRoute('POST', '/api/upload-image', async (req, res) => {
    const chunks = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > LIMITS.imageUploadBytes) return json(res, { error: 'File too large (max 10 MB)' }, 413);
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) return json(res, { error: 'empty body' }, 400);
    await mkdir(PASTE_DIR, { recursive: true });
    const ext = (req.headers['content-type'] || '').includes('png') ? 'png' : 'jpg';
    const name = `paste-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
    const filePath = join(PASTE_DIR, name);
    await writeFile(filePath, buf);
    json(res, { path: filePath });
  });

  // ──────────── Health ────────────

  // Health check (for PM2, uptime monitors, etc.)
  addRoute('GET', '/api/health', (_req, res) => {
    json(res, {
      status: 'ok',
      version: ctx.PKG_VERSION,
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
      projects: getProjects().length,
      terminals: ctx.terminals?.size ?? 0,
      durableTerminals: Boolean(ctx.durableTerminalsEnabled?.()),
      sseClients: poller.sseClients.size
    });
  });

  addRoute('POST', '/api/server/restart', async (_req, res) => {
    try {
      const result = await ctx.requestServerRestart?.();
      if (!result) return json(res, { error: '서버 재시작 기능을 사용할 수 없습니다.' }, 501);
      json(res, { restarting: true, ...result });
    } catch (error) {
      json(res, { error: error.message }, 409);
    }
  });

  // ──────────── LAN info & QR code ────────────

  addRoute('GET', '/api/lan-info', (req, res) => {
    if (!isLocalhost(req)) { json(res, { error: 'Forbidden' }, 403); return; }
    json(res, { token: LAN_TOKEN, ips: ctx.getNetworkIPs(), port: PORT });
  });

  addRoute('GET', '/api/qr-code', (req, res) => {
    if (!isLocalhost(req)) { res.writeHead(403); res.end(); return; }
    const data = req.query.data;
    if (!data) { res.writeHead(400); res.end('Missing data param'); return; }
    const svg = generateQRSvg(data);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(svg);
  });

  // ──────────── Cost / Stats / Activity ────────────

  addRoute('GET', '/api/cost/daily', async (_req, res) => {
    const cached = poller.getCached('cost:daily');
    json(res, cached || await computeUsage());
  });

  // Cost advisor: per-session attribution, burn rate, savings ceiling.
  addRoute('GET', '/api/cost/insights', async (_req, res) => {
    try { json(res, await getCostInsights()); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  // Stats cache
  addRoute('GET', '/api/stats', (_req, res) => {
    json(res, getStatsCache() || {});
  });

  // Activity
  addRoute('GET', '/api/activity', (_req, res) => {
    const cached = poller.getCached('activity');
    json(res, cached || getRecentActivity());
  });

  // ──────────── File access ────────────

  // File preview (read-only, for drag-drop file viewer)
  addRoute('GET', '/api/file', async (req, res) => {
    const filePath = new URL(req.url, 'http://localhost').searchParams.get('path');
    if (!filePath) return json(res, { error: 'Missing path' }, 400);
    // Path traversal guard: resolve to absolute and check against registered projects
    if (!isInsideAnyProject(filePath)) return json(res, { error: 'Access denied: path outside project directories' }, 403);
    // m4: Use resolved path for actual I/O to prevent TOCTOU via symlinks
    const resolved = resolve(normalize(filePath));
    try {
      const st = await stat(resolved);
      if (st.size > LIMITS.filePreviewBytes) return json(res, { error: 'File too large (>2MB)' }, 413);
      const content = await readFile(resolved, 'utf8');
      json(res, { path: filePath, name: filePath.replace(/\\/g, '/').split('/').pop(), size: st.size, content });
    } catch (e) { json(res, { error: e.message }, 404); }
  });

  // ──────────── IDE / URL / Folder openers ────────────

  // Open a file in IDE
  addRoute('POST', '/api/open-in-ide', async (req, res) => {
    const body = await readBody(req);
    let filePath = body.path;
    const ide = body.ide || 'code';
    const line = parseInt(body.line) || 0;
    const column = parseInt(body.column) || 0;
    if (!filePath) return json(res, { error: 'Missing path' }, 400);
    // Resolve relative paths against project root if projectId provided
    if (body.projectId && !/^[A-Za-z]:/.test(filePath) && !filePath.startsWith('/')) {
      const proj = getProjectById(body.projectId);
      if (proj) filePath = join(IS_WIN ? toWinPath(proj.path) : proj.path, filePath);
    }
    if (!isInsideProject(filePath)) return json(res, { error: 'Path outside project directories' }, 403);
    const known = ['code', 'cursor', 'windsurf', 'antigravity', 'zed'];
    if (!known.includes(ide)) return json(res, { error: 'Unknown IDE' }, 400);
    const resolvedPath = IS_WIN ? toWinPath(filePath) : filePath;
    // Zed uses its own exe path and different CLI args
    if (ide === 'zed') {
      const zedBin = getIdeBin('zed');
      const args = line > 0 ? [`${resolvedPath}:${line}`] : [resolvedPath];
      safeSpawnDetached(zedBin, args, { shell: false, windowsHide: true });
    } else {
      // VS Code/Cursor support --goto file:line:column
      const args = [];
      if (line > 0) { args.push('--goto', `${resolvedPath}:${line}${column > 0 ? ':' + column : ''}`); }
      else { args.push(resolvedPath); }
      const ideBin = getIdeBin(ide);
      safeSpawnDetached(ideBin, args, getIdeSpawnOpts());
    }
    json(res, { opened: true });
  });

  // Open URL in default browser
  addRoute('POST', '/api/open-url', async (req, res) => {
    const body = await readBody(req);
    const url = body.url;
    if (!url || typeof url !== 'string') return json(res, { error: 'Missing url' }, 400);
    if (!/^https?:\/\//i.test(url)) return json(res, { error: 'Only http/https URLs allowed' }, 400);
    const browser = body.browser || 'default';
    if (browser === 'firefox-dev') {
      const ffBin = getFirefoxDevBin();
      safeSpawnDetached(ffBin, [url], { shell: false, windowsHide: true });
    } else {
      platformOpenUrl(url);
    }
    json(res, { opened: true });
  });

  // Open containing folder in file manager
  addRoute('POST', '/api/open-folder', async (req, res) => {
    const body = await readBody(req);
    if (!body.path) return json(res, { error: 'Missing path' }, 400);
    if (!isInsideProject(body.path)) return json(res, { error: 'Path outside project directories' }, 403);
    const resolvedPath = IS_WIN ? toWinPath(body.path) : body.path;
    platformOpenFolder(resolvedPath);
    json(res, { opened: true });
  });

  // ──────────── Notifications toggle ────────────

  addRoute('POST', '/api/notify/toggle', async (req, res) => {
    const body = await readBody(req);
    _notifyEnabled = body.enabled !== false;
    json(res, { enabled: _notifyEnabled });
  });

  // ──────────── Settings export/import ────────────

  addRoute('GET', '/api/settings/export', (_req, res) => {
    json(res, { projects: getProjects() });
  });

  // Settings import
  addRoute('POST', '/api/settings/import', async (req, res) => {
    try {
      const body = await readBody(req);
      const imported = body.projects || [];
      let added = 0;
      const existingPaths = new Set(getProjects().map(p => p.path.replace(/\\/g, '/').toLowerCase()));
      for (const p of imported) {
        if (!p.name || !p.path) continue;
        const normalPath = p.path.replace(/\\/g, '/');
        if (existingPaths.has(normalPath.toLowerCase())) continue;
        const project = addProject({ name: p.name, path: normalPath, stack: p.stack, devCmd: p.devCmd, github: p.github, color: p.color });
        ctx.registerProjectPollers(project);
        existingPaths.add(normalPath.toLowerCase());
        added++;
      }
      json(res, { success: true, imported: added });
    } catch (err) { json(res, { error: err.message }, 500); }
  });

  // ──────────── Discover projects ────────────

  addRoute('GET', '/api/discover-projects', (_req, res) => {
    const existingPaths = getProjects().map(p => p.path.replace(/\\/g, '/'));
    json(res, discoverProjects(existingPaths));
  });

  // Bulk add discovered projects
  addRoute('POST', '/api/discover-projects/add', async (req, res) => {
    const body = await readBody(req);
    const paths = body.projects; // array of { path, name }
    if (!paths?.length) return json(res, { error: 'projects required' }, 400);
    let added = 0;
    const existingPaths = new Set(getProjects().map(p => p.path.replace(/\\/g, '/').toLowerCase()));
    for (const p of paths) {
      if (!p.path || !p.name) continue;
      const normalPath = p.path.replace(/\\/g, '/');
      if (existingPaths.has(normalPath.toLowerCase())) continue;
      const project = addProject({ name: p.name, path: normalPath });
      ctx.registerProjectPollers(project);
      existingPaths.add(normalPath.toLowerCase());
      added++;
    }
    json(res, { success: true, added });
  });

  // ──────────── Briefing & Alerts ────────────

  addRoute('GET', '/api/briefing', (_req, res) => {
    const projectStates = {};
    for (const p of getProjects()) {
      projectStates[p.id] = {
        session: poller.getCached('session:' + p.id),
        git: poller.getCached('git:' + p.id),
        prs: poller.getCached('prs:' + p.id),
        cicd: poller.getCached('cicd:' + p.id),
      };
    }
    const costData = poller.getCached('cost:daily');
    json(res, generateBriefing(projectStates, costData));
  });

  addRoute('GET', '/api/alerts', (_req, res) => {
    const projectStates = {};
    for (const p of getProjects()) {
      projectStates[p.id] = {
        session: poller.getCached('session:' + p.id),
        git: poller.getCached('git:' + p.id),
        cicd: poller.getCached('cicd:' + p.id),
      };
    }
    const costData = poller.getCached('cost:daily');
    json(res, checkAlerts(projectStates, costData));
  });

  addRoute('GET', '/api/alerts/prefs', (_req, res) => { json(res, getAlertPrefs()); });
  addRoute('POST', '/api/alerts/prefs', async (req, res) => {
    const body = await readBody(req);
    saveAlertPrefs(body);
    json(res, { ok: true });
  });

  // ──────────── Batch Commands ────────────

  addRoute('GET', '/api/batch/whitelist', (_req, res) => { json(res, getWhitelist()); });

  addRoute('GET', '/api/batch/status', (_req, res) => { json(res, getBatchStatus()); });

  addRoute('POST', '/api/batch/execute', async (req, res) => {
    const body = await readBody(req);
    if (!body.commandId || !Array.isArray(body.projectIds)) return json(res, { error: 'commandId and projectIds required' }, 400);
    const projects = body.projectIds.map(id => {
      const p = getProjectById(id);
      return p ? { id: p.id, name: p.name, path: p.path } : null;
    }).filter(Boolean);
    if (projects.length === 0) return json(res, { error: 'No valid projects' }, 400);
    try {
      const result = await executeBatch(body.commandId, projects, { parallel: body.parallel, maxConcurrent: body.maxConcurrent });
      json(res, result);
    } catch (err) { json(res, { error: err.message }, 400); }
  });

  addRoute('POST', '/api/batch/stop', (_req, res) => { json(res, { stopped: stopBatch() }); });
}
