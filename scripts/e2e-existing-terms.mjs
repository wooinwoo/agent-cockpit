import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/home/rst010/.local/bin/google-chrome-stable', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:3847/', { waitUntil: 'networkidle' });
await page.waitForSelector('.xterm-wrap', { timeout: 15000 });
await page.waitForTimeout(3000);

const terms = await page.evaluate(() => {
  const wraps = document.querySelectorAll('.xterm-wrap');
  return [...wraps].map((w, i) => {
    const vp = w.querySelector('.xterm-viewport');
    const rect = w.getBoundingClientRect();
    return {
      i, label: w.closest('[data-term-id]')?.dataset?.termId?.slice(0, 18) || w.parentElement?.className?.slice(0, 24) || '?',
      scrollH: vp?.scrollHeight, clientH: vp?.clientHeight, scrollTop: vp?.scrollTop,
      onScreen: rect.x > -50 && rect.x < 1400 && rect.width > 100,
      w: Math.round(rect.width), h: Math.round(rect.height),
    };
  });
});
console.table ? console.table(terms) : console.log(JSON.stringify(terms, null, 1));

// 화면 안 + 스크롤 영역 있는 첫 터미널에 휠
const cand = terms.find(t => t.onScreen && t.scrollH > t.clientH + 1);
if (!cand) {
  console.log('✖ 스크롤 영역(scrollH > clientH)인 화면 내 터미널이 없음 — 이게 원인');
  await browser.close(); process.exit(2);
}
const b = await page.locator('.xterm-wrap').nth(cand.i).boundingBox();
const before = await page.evaluate(i => ({
  top: document.querySelectorAll('.xterm-wrap .xterm-viewport')[i].scrollTop,
  row: document.querySelectorAll('.xterm-wrap .xterm-rows')[i]?.textContent?.slice(0, 30),
}), cand.i);
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
for (let k = 0; k < 5; k++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(60); }
const after = await page.evaluate(i => ({
  top: document.querySelectorAll('.xterm-wrap .xterm-viewport')[i].scrollTop,
  row: document.querySelectorAll('.xterm-wrap .xterm-rows')[i]?.textContent?.slice(0, 30),
}), cand.i);
console.log('before:', JSON.stringify(before));
console.log('after :', JSON.stringify(after));
console.log(before.top !== after.top || before.row !== after.row ? '✔ EXISTING-TERM SCROLL WORKS' : '✖ EXISTING-TERM DEAD');
await browser.close();
