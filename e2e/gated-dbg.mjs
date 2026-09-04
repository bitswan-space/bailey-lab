import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
const URL = 'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai&tab=agent&sub=chat';
const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 950 } });
const p = await ctx.newPage();
const netFails = [];
p.on('response', (r) => { if (r.url().includes('sidebar') ) netFails.push(`${r.status()} ${r.url().split('?')[0].slice(-45)}`); });
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.getByText('Bitswan account', { exact: false }).first().click({ timeout: 30000 });
await p.locator('#username').waitFor({ state: 'visible', timeout: 40000 });
await p.locator('#username').fill('timothy.hobbs@harmonum.ai');
await p.locator('#password').fill('145f7e242eb058feb07d5004e45527ff');
await p.locator('button[type="submit"], #kc-login').first().click();
await p.waitForTimeout(9000);
if (/Trust this device/i.test(await p.locator('body').innerText().catch(()=> ''))) {
  for (let i=0;i<15;i++) { try { const l=execFileSync('bitswan',['bailey','devices','list'],{encoding:'utf8'}); const c=l.match(/\b(\d{6})\b/)?.[1]; if(c){execFileSync('bitswan',['bailey','devices','approve',c],{stdio:'pipe'});console.log('approved',c);break;} } catch {} await p.waitForTimeout(3000); }
}
for (let i=0;i<30;i++) { if (!p.url().includes('bailey-onboard')) break; await p.waitForTimeout(2000); }
await p.waitForTimeout(4000);
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForTimeout(15000);
console.log('top url  :', p.url().slice(0,95));
for (const f of p.frames()) console.log('  frame  :', f.url().slice(0,95));
const wrap = p.frames().find((f) => f !== p.mainFrame());
if (wrap) {
  const t = await wrap.evaluate(() => ({ text: (document.body?.innerText||'').replace(/\s+/g,' ').slice(0,300), iframes: document.querySelectorAll('iframe').length, xterm: document.querySelectorAll('.xterm').length })).catch((e)=>({err:String(e).slice(0,90)}));
  console.log('wrap    :', JSON.stringify(t));
}
console.log('sidebar responses:', JSON.stringify([...new Set(netFails)].slice(0,6)));
await p.screenshot({ path: 'gated-dbg.png' });
await b.close();
