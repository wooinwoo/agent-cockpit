import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';

const PORT = 3847;
const WSL_ARGS = ['-d', 'Ubuntu', '-u', 'rst010', '--', 'sh', '-lc'];
const WSL_START_COMMAND = `curl -fsS http://127.0.0.1:${PORT}/api/health >/dev/null 2>&1 || /usr/bin/systemctl --user start cockpit-prod.service`;

export function parseDiscovery(output) {
  const lines = output.split(/\r?\n/);
  const host = lines.find((line) => line.startsWith('COCKPIT_HOST='))?.slice(13).trim();
  const token = lines.find((line) => line.startsWith('COCKPIT_TOKEN='))?.slice(14).trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host || '') && (token?.length || 0) >= 16
    ? { host, token }
    : null;
}

function discoverWslCockpit() {
  try {
    return parseDiscovery(execFileSync('wsl.exe', [
      '-d', 'Ubuntu', '-u', 'rst010', '--', 'sh', '-lc',
      'printf "COCKPIT_HOST=%s\\n" "$(hostname -I | awk \'{print $1}\')"; printf "COCKPIT_TOKEN="; cat "$HOME/.local/share/cockpit/.cockpit-token"; printf "\\n"',
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true }));
  } catch {
    return null;
  }
}

function startWslCockpit() {
  execFile('wsl.exe', [...WSL_ARGS,
    WSL_START_COMMAND,
  ], { timeout: 15000, windowsHide: true }, () => {});
}

function isReachable(host) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: PORT });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

export function isInitialNavigation(req) {
  const site = req.headers['sec-fetch-site'];
  const dest = req.headers['sec-fetch-dest'];
  const referer = req.headers.referer;
  let sameOriginReferer = !referer;
  try { sameOriginReferer ||= new URL(referer).host === req.headers.host; } catch { /* invalid */ }
  return req.method === 'GET'
    && req.url === '/'
    && !req.headers.origin
    && sameOriginReferer
    && (site === 'none' || site === 'same-origin')
    && req.headers['sec-fetch-mode'] === 'navigate'
    && (dest === 'document' || dest === 'empty');
}

if (process.argv.includes('--self-test')) {
  assert.equal(WSL_START_COMMAND.startsWith(`curl -fsS http://127.0.0.1:${PORT}/api/health >/dev/null 2>&1 || `), true);
  assert.equal(WSL_START_COMMAND.endsWith('/usr/bin/systemctl --user start cockpit-prod.service'), true);
  assert.equal(WSL_START_COMMAND.includes('nohup'), false);
  assert.equal(WSL_START_COMMAND.includes('node server.js'), false);
  assert.deepEqual(parseDiscovery('notice\nCOCKPIT_HOST=172.20.1.2\nCOCKPIT_TOKEN=0123456789abcdef\n'), {
    host: '172.20.1.2', token: '0123456789abcdef',
  });
  assert.equal(parseDiscovery('bad\nshort\n'), null);
  assert.equal(isInitialNavigation({ method: 'GET', url: '/', headers: {
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'empty',
  } }), true);
  assert.equal(isInitialNavigation({ method: 'GET', url: '/', headers: {
    'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
  } }), false);
  assert.equal(isInitialNavigation({ method: 'GET', url: '/', headers: {
    host: 'localhost:3847', referer: 'http://localhost:3847/',
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'empty',
  } }), true);
  console.log('cockpit-wsl-app-bridge self-test: ok');
  process.exit(0);
}

let target = process.platform === 'win32' ? discoverWslCockpit() : null;

if (process.argv.includes('--diagnose')) {
  console.log(JSON.stringify({
    platform: process.platform,
    discovered: Boolean(target),
    host: target?.host || null,
    tokenLength: target?.token.length || 0,
    reachable: target ? await isReachable(target.host) : false,
  }));
  process.exit(0);
}

if (target && !await isReachable(target.host)) target = null;
if (!target) startWslCockpit();

let checking = false;
const refreshTarget = async () => {
  if (target || checking) return;
  checking = true;
  const found = discoverWslCockpit();
  if (found && await isReachable(found.host)) target = found;
  checking = false;
};
const retryTimer = setInterval(refreshTarget, 1500);
setInterval(() => {}, 60_000); // Keep Tauri's child PID valid until the app exits.

const server = createServer((req, res) => {
  if (!isInitialNavigation(req)) {
    res.writeHead(403, { 'Cache-Control': 'no-store' });
    res.end('Forbidden');
    return;
  }
  if (!target) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1"><title>Cockpit</title><body style="background:#090d10;color:#d8e0e5;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">WSL Cockpit 시작을 기다리는 중...</body>');
    return;
  }
    const location = `http://${target.host}:${PORT}/?token=${encodeURIComponent(target.token)}`;
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
    clearInterval(retryTimer);
    server.close();
}).listen(PORT, '127.0.0.1');
