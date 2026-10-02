// Run with: node scripts/verify-supervision-floating.mjs
// Uses an isolated server and real app handlers; never connects to live sessions.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

const fixture = await startPortfolioServer({ durable: false });
let browser;
try {
 browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
 const page = await browser.newPage();
 const errors = [];
 page.on('pageerror', error => errors.push(error.stack));
 await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
 const seeded = await page.request.post(`${fixture.url}/api/board/tasks`, { data: { text: '검증 환경은?', kind: 'question' } });
 assert.ok(seeded.ok());
 for(const width of [1280,390]) {
  await page.setViewportSize({width,height:900});await page.goto(fixture.url);
  await page.evaluate(async()=>{
   window.testAction=(await import('/js/actions.js')).getClickAction;
   const input=document.createElement('input');
   input.id='terminal-test-input';input.style.cssText='position:fixed;left:90px;top:95px;width:160px;z-index:124';
   document.body.append(input);
  });
  await page.locator('#supervision-fab').click();
  await page.locator('#supervision-floating .supervision-columns').waitFor({state:'visible'});
  const panelRect=await page.locator('#supervision-floating').boundingBox();
  const buttonRect=await page.locator('#supervision-fab').boundingBox();
  assert.ok(panelRect.y>=0 && panelRect.y+panelRect.height<=buttonRect.y-8,'panel must fit above shortcut');
  assert.equal(await page.locator('#terminal-view').evaluate(e=>e.classList.contains('active')),true);
  assert.equal(await page.locator('#supervision-floating').evaluate(e=>e.matches(':modal')),false);
  await page.locator('#supervision-floating [name=objective]').fill('접어도 남을 목표');
  await page.locator('#supervision-floating [data-answer] textarea').fill('스테이징');
  await page.locator('#supervision-floating .supervision').evaluate(e=>e.scrollTop=0);
  await page.locator('#terminal-test-input').fill('terminal still accepts input');
  assert.equal(await page.locator('#terminal-test-input').inputValue(),'terminal still accepts input');
  await page.locator('#supervision-floating').dispatchEvent('click');
  assert.equal(await page.locator('#supervision-floating').evaluate(e=>e.open),true,'window surface click must not close the modeless board');
  await page.locator('#supervision-fab').focus();await page.keyboard.press('Escape');
  assert.equal(await page.locator('#supervision-floating').evaluate(e=>e.open),true,'Escape outside the board must leave it open');
  await page.evaluate(()=>document.querySelector('#supervision-floating').close());
  await page.waitForFunction(()=>document.querySelector('#supervision-fab').getAttribute('aria-expanded')==='false');
  await page.locator('#supervision-fab').click();
  assert.equal(await page.locator('#supervision-floating [name=objective]').inputValue(),'접어도 남을 목표');
  await page.evaluate(async()=>{
    document.querySelector('#supervision-floating').close();
    await window.testAction('toggle-floating-supervision')();
    await new Promise(resolve=>setTimeout(resolve,50));
  });
  assert.equal(await page.locator('#supervision-floating').evaluate(e=>e.open),true,'queued close event must not fold a reopened board');
  assert.equal(await page.locator('#supervision-floating [name=objective]').inputValue(),'접어도 남을 목표');
  const head=page.locator('.supervision-floating-head');
  const start=await head.boundingBox();
  await page.mouse.move(start.x+80,start.y+20);await page.mouse.down();
  await page.mouse.move(start.x+20,start.y-35,{steps:5});await page.mouse.up();
  const moved=await page.locator('#supervision-floating').boundingBox();
  const movedButton=await page.locator('#supervision-fab').boundingBox();
  assert.ok(Math.abs((movedButton.y-buttonRect.y)-(moved.y-panelRect.y))<1,'button follows window vertically');
  assert.ok(Math.abs((movedButton.x-buttonRect.x)-(moved.x-panelRect.x))<1,'button follows window horizontally');
  assert.ok(moved.y<panelRect.y-20,'header drag moves the panel');
  if(width>600) assert.ok(moved.x<panelRect.x-20,'desktop drag moves horizontally');
  await head.focus();await page.keyboard.press('ArrowDown');
  const keyed=await page.locator('#supervision-floating').boundingBox();
  assert.ok(keyed.y>moved.y+5,'keyboard moves the panel');
  const h=await head.boundingBox();
  await page.mouse.move(h.x+80,h.y+20);await page.mouse.down();
  await page.mouse.move(-500,-500,{steps:5});await page.mouse.up();
  const clamped=await page.locator('#supervision-floating').boundingBox();
  assert.ok(clamped.x>=0 && clamped.y>=0,'drag cannot lose the window offscreen');
  if(width===390) {
   const touch=await page.context().newCDPSession(page);const header=await head.boundingBox();
   await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:header.x+70,y:header.y+20}]});
   await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:header.x+70,y:header.y+70}]});
   await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   assert.ok((await page.locator('#supervision-floating').boundingBox()).y>clamped.y+20,'touch drag moves window');
   await touch.detach();
  }
  const beforeFold=await page.locator('#supervision-fab').boundingBox();
  await page.locator('[data-action=close-floating-supervision]').click();
  assert.deepEqual(await page.locator('#supervision-fab').boundingBox(),beforeFold,'button stays at moved position when folded');
  assert.equal(await page.locator('#supervision-fab').getAttribute('aria-expanded'),'false');
  await page.locator('#supervision-fab').click();
  assert.equal(await page.locator('#supervision-floating [name=objective]').inputValue(),'접어도 남을 목표');
  await page.locator('#supervision-floating [name=objective]').focus();await page.keyboard.press('Escape');
  assert.equal(await page.locator('#supervision-floating').evaluate(e=>e.open),false);
  assert.equal(await page.locator('#supervision-fab').evaluate(e=>e===document.activeElement),true);
  await page.locator('#supervision-fab').click();
  await page.keyboard.press('Control+7');
  await page.locator('#notes-view.active .supervision').waitFor({state:'visible'});
  assert.equal(await page.locator('#supervision-floating').evaluate(e=>e.open),false);
  assert.equal(await page.locator('#notes-editor [name=objective]').inputValue(),'접어도 남을 목표');
  assert.equal(await page.locator('#notes-editor [data-answer] textarea').inputValue(),'스테이징');
  assert.equal(await page.locator('.supervision').count(),1);
  await page.keyboard.press('Control+2');
  await page.locator('#terminal-view.active').waitFor({state:'visible'});
  await page.evaluate(()=>Promise.all(Array.from({length:8},()=>window.testAction('toggle-floating-supervision')())));
  assert.equal(await page.locator('.supervision').count(),1,'rapid clicks keep one board');
  assert.equal(await page.locator('#supervision-floating [name=objective]').inputValue(),'접어도 남을 목표');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  // Ordinary modal dialogs still dismiss through the application's shared handlers.
  await page.evaluate(()=>{const modal=document.createElement('dialog');modal.id='test-modal';document.body.append(modal);modal.showModal();});
  await page.locator('#test-modal').dispatchEvent('click');
  assert.equal(await page.locator('#test-modal').evaluate(e=>e.open),false);
  await page.locator('#test-modal').evaluate(e=>e.showModal());await page.keyboard.press('Escape');
  assert.equal(await page.locator('#test-modal').evaluate(e=>e.open),false);
  assert.equal(await page.locator('#supervision-floating').evaluate(e=>e.open),true);
  await page.locator('[data-action=close-floating-supervision]').click();
  await page.evaluate(()=>import('/js/supervision.js').then(m=>m.stopSupervision()));
 }
 assert.deepEqual(errors, []);
 console.log('PASS desktop/mobile: shared button movement, native close/reopen, rapid clicks, drafts, Notes transfer and modal dismissal');
} finally {
 await browser?.close();
 await fixture.cleanup();
}
