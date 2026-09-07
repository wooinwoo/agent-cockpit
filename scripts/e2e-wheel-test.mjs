/**
 * 실브라우저 터미널 휠 E2E — 사용자 보고 "휠 스크롤 안 됨"의 실증 재현/검증.
 * 새 Home 셸 터미널을 UI 경로로 만들고, 대량 출력 후 휠을 올려 viewportY가
 * 변하는지 실측한다. 실행: node scripts/e2e-wheel-test.mjs
 */
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_BIN || '/home/rst010/.local/bin/google-chrome-stable';
const URL = process.env.COCKPIT_URL || 'http://localhost:3847/';

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.xterm-wrap', { timeout: 15000 });

// 1) 새 Home 셸 터미널 생성 (UI 경로 그대로)
await page.click('[data-action="new-term"]');
await page.waitForSelector('#new-term-modal[open]', { timeout: 5000 });
await page.evaluate(() => {
  const sel = document.getElementById('nt-project');
  const home = [...sel.options].find(o => o.value === '__home__');
  if (home) sel.value = '__home__';
  document.getElementById('nt-cmd').value = '';
});
await page.click('#new-term-modal .modal-footer .btn.primary');
await page.waitForTimeout(2000); // 마운트+replay

// 2) 새 터미널(마지막 xterm-wrap) 찾아 화면 안 박스 확인
const count = await page.locator('.xterm-wrap').count();
console.log('terminals:', count);
let target = null;
for (let i = count - 1; i >= 0; i--) {
  const b = await page.locator('.xterm-wrap').nth(i).boundingBox();
  if (b && b.x >= 0 && b.y >= 0 && b.width > 200 && b.height > 120) { target = { i, b }; break; }
}
if (!target) { console.log('✖ no visible terminal'); await browser.close(); process.exit(1); }
console.log('target terminal idx:', target.i, JSON.stringify(target.b));

// 3) 대량 출력 쌓기 — 새 터미널 클릭 후 타이핑
const termLoc = page.locator('.xterm-wrap').nth(target.i);
await termLoc.click();
await page.keyboard.type('seq 1 300', { delay: 5 });
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);

// 4) 스크롤 영역 실측
const probe = await page.evaluate(idx => {
  const vps = document.querySelectorAll('.xterm-wrap .xterm-viewport');
  const vp = vps[idx];
  return { scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight, scrollTop: vp.scrollTop };
}, target.i);
console.log('scroll area:', JSON.stringify(probe));

// 5) 휠 전후 비교
const readState = async () => page.evaluate(idx => {
  const vps = document.querySelectorAll('.xterm-wrap .xterm-viewport');
  const rows = document.querySelectorAll('.xterm-wrap .xterm-rows');
  return { scrollTop: vps[idx].scrollTop, firstRow: rows[idx]?.textContent?.slice(0, 30) || '' };
}, target.i);
const before = await readState();
const cx = target.b.x + target.b.width / 2, cy = target.b.y + target.b.height / 2;
await page.mouse.move(cx, cy);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(60); }
const after = await readState();
console.log('before:', JSON.stringify(before));
console.log('after :', JSON.stringify(after));
const scrolled = after.scrollTop !== before.scrollTop || after.firstRow !== before.firstRow;
console.log(scrolled ? '✔ WHEEL SCROLL WORKS' : '✖ WHEEL STILL DEAD');
if (errors.length) console.log('page errors:', errors.slice(0, 3));

// 6) 테스트 터미널 정리 (프로세스 exit)
await page.keyboard.type('exit', { delay: 5 });
await page.keyboard.press('Enter');
await browser.close();
process.exit(scrolled ? 0 : 2);
