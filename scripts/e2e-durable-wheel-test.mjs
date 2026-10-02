// Isolated browser → xterm → PTY → tmux regression; never touches live AI sessions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import pty from 'node-pty';
import { ensureDurableTerminal, killDurableTerminal } from '../lib/durable-terminal.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'cockpit-wheel-'));
const id = randomBytes(12).toString('hex');
const socket = `cockpit-${id}`;
const tmux = (...args) => execFileSync('/usr/bin/tmux', ['-L', socket, ...args], { encoding: 'utf8' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseline = process.argv.includes('--baseline');
let browser, terminal;
try {
  const options = { id, cwd: dir, env: { ...process.env, TERM: 'xterm-256color' } };
  if (baseline) tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'main', '-c', dir);
  else ensureDurableTerminal(options);
  symlinkSync('/usr/bin/python3', join(dir, 'codex'));
  writeFileSync(join(dir, 'fixture.py'), `import os,tty
tty.setraw(0)
os.write(1,b'\\x1b[?1049h\\x1b[2J\\x1b[HTranscript latest')
while True:
 data=os.read(0,4096)
 with open('input','ab') as f: f.write(data)
 if data==b'm': os.write(1,b'\\x1b[?1003h\\x1b[?1006h')
 if data==b'n': os.write(1,b'\\x1b[?1003l\\x1b[?1006l\\x1b[?1049l')
`);
  terminal = pty.spawn('/usr/bin/tmux', ['-L', socket, 'attach-session', '-t', 'main'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: dir, env: options.env,
  });
  let pending = '';
  terminal.onData(data => { pending += data; });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/home/rst010/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome',
    headless: true, args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent('<div id="term"></div>');
  await page.addStyleTag({ path: join(root, 'vendor/xterm.min.css') });
  await page.addScriptTag({ path: join(root, 'vendor/xterm.min.js') });
  await page.exposeFunction('sendInput', data => terminal.write(data));
  await page.evaluate(() => {
    window.term = new Terminal({ cols: 80, rows: 24 });
    term.open(document.getElementById('term'));
    term.onData(data => window.sendInput(data));
    // Same capture behavior as terminal.js: prevent browser scrolling, then let
    // xterm deliver alternate-screen wheel events using its negotiated mode.
    document.getElementById('term').addEventListener('wheel', e => e.preventDefault(), { capture: true, passive: false });
  });
  async function flush() {
    await sleep(120);
    const data = pending; pending = '';
    await page.evaluate(data => new Promise(resolve => term.write(data, resolve)), data);
  }
  tmux('send-keys', '-t', 'main', '-l', `${dir}/codex fixture.py`);
  tmux('send-keys', '-t', 'main', 'Enter');
  for (let attempt = 0; attempt < 50; attempt++) {
    if (tmux('display-message', '-p', '#{pane_current_command}').trim() === 'codex') break;
    await sleep(100);
  }
  await flush();
  assert.equal(tmux('display-message', '-p', '#{pane_current_command}').trim(), 'codex');
  assert.equal(tmux('display-message', '-p', '#{mouse_any_flag}').trim(), '0');
  const box = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.wheel(0, -40);
  await flush();
  assert.equal(readFileSync(join(dir, 'input'), 'utf8'), '\x1b[5~', 'wheel up must send PageUp, never input-history Up');
  await page.mouse.wheel(0, 40);
  await flush();
  assert.equal(readFileSync(join(dir, 'input'), 'utf8'), '\x1b[5~\x1b[6~');
  console.log('PASS: existing mouse-off Codex receives transcript page keys in both directions');

  // Physical arrow keys remain available for intentional input-history navigation.
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('ArrowUp');
  await flush();
  assert.ok(readFileSync(join(dir, 'input'), 'utf8').endsWith('\x1b[A'));

  terminal.write('m');
  await flush();
  writeFileSync(join(dir, 'input'), '');
  await page.mouse.wheel(0, -40);
  await flush();
  assert.match(readFileSync(join(dir, 'input'), 'utf8'), /^\x1b\[<64;\d+;\d+M$/);
  console.log('PASS: mouse-aware applications receive native wheel coordinates');

  terminal.write('n');
  await flush();
  writeFileSync(join(dir, 'input'), '');
  await page.mouse.wheel(0, -40);
  await flush();
  assert.equal(readFileSync(join(dir, 'input'), 'utf8'), '');
  assert.equal(tmux('display-message', '-p', '#{pane_in_mode}').trim(), '1');
  tmux('send-keys', '-X', 'cancel');
  console.log('PASS: normal-screen wheel enters tmux scrollback without leaking input');

  const pid = tmux('display-message', '-p', '#{pane_pid}').trim();
  ensureDurableTerminal(options);
  assert.equal(tmux('display-message', '-p', '#{pane_pid}').trim(), pid);
  console.log('PASS: reattachment preserves the running process');
} finally {
  await browser?.close();
  terminal?.kill();
  try { killDurableTerminal(id); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
}
