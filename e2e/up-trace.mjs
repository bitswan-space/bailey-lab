import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
const URL = 'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai&tab=agent&sub=chat';
const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 950 } });
const p = await ctx.newPage();
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.getByText('Bitswan account', { exact: false }).first().click({ timeout: 30000 });
await p.locator('#username').waitFor({ state: 'visible', timeout: 40000 });
await p.locator('#username').fill('timothy.hobbs@harmonum.ai');
await p.locator('#password').fill('145f7e242eb058feb07d5004e45527ff');
await p.locator('button[type="submit"], #kc-login').first().click();
await p.waitForTimeout(9000);
if (/Trust this device/i.test(await p.locator('body').innerText().catch(()=> ''))) {
  for (let i=0;i<15;i++) { try { const l=execFileSync('bitswan',['bailey','devices','list'],{encoding:'utf8'}); const c=l.match(/\b(\d{6})\b/)?.[1]; if(c){execFileSync('bitswan',['bailey','devices','approve',c],{stdio:'pipe'});break;} } catch {} await p.waitForTimeout(3000); }
}
for (let i=0;i<30;i++) { if (!p.url().includes('bailey-onboard')) break; await p.waitForTimeout(2000); }
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForTimeout(22000);
const f = p.frames().find((fr) => fr.url().includes('/sidebar/view'));
if (!f) { console.log('NO FRAME'); await b.close(); process.exit(1); }
for (let i=0;i<40;i++) {
  const has = await f.evaluate(() => Boolean(document.querySelector('[contenteditable],[role="textbox"]'))).catch(()=>false);
  if (has) break;
  await p.waitForTimeout(2000);
}
console.log('composer ready');
await f.evaluate(async () => {
  const t = document.querySelector('[contenteditable],[role="textbox"]');
  if (!t) throw new Error('composer never appeared');
  const cv = document.createElement('canvas'); cv.width=48; cv.height=48;
  const cx = cv.getContext('2d'); cx.fillStyle='#11aa55'; cx.fillRect(0,0,48,48);
  const blob = await new Promise((r)=>cv.toBlob((x)=>r(x),'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob],'logo.png',{type:'image/png'}));
  t.focus();
  t.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
});
await p.waitForTimeout(3000);
await f.evaluate(() => document.querySelector('[contenteditable],[role="textbox"]')?.focus());
await p.keyboard.type('Tell me the absolute filesystem path of the image I just attached. Do not create or edit files.', { delay: 8 });
await p.waitForTimeout(1000);
await p.keyboard.press('Enter');
await p.waitForTimeout(40000);
console.log('transcript:', JSON.stringify((await f.evaluate(() => (document.body.innerText||'').replace(/\s+/g,' ').slice(-420)))));
await b.close();
