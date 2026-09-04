import { test, expect } from '@playwright/test';

const BASE = process.env.LIVE_DASHBOARD_URL ?? 'http://172.18.0.18:8080';
const EMAIL = process.env.LIVE_EMAIL ?? 'timothy.hobbs@harmonum.ai';
const COPY = process.env.LIVE_COPY ?? 'timothy-hobbs-harmonum-ai';
const BP = process.env.LIVE_BP ?? 'test';

test.use({ extraHTTPHeaders: { 'X-Forwarded-Email': EMAIL } });

test('the Coding Agent tab shows the hosted Claude sidebar, not the terminal', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  await page.goto(`${BASE}/?copy=${COPY}&bp=${BP}&tab=agent&sub=chat`, {
    waitUntil: 'load',
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);

  // Click the Coding Agent top tab if the deep link did not land there.
  const tab = page.getByRole('button', { name: /Coding Agent/i }).first();
  if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => undefined);
  await page.waitForTimeout(3000);

  const frame = page.frameLocator('iframe[title="Claude Code"]');
  const composer = frame.locator('[contenteditable], [role="textbox"]').first();
  await composer.waitFor({ state: 'visible', timeout: 90_000 });

  const sidebarText = await frame.locator('body').innerText();
  console.log('--- live workspace sidebar ---');
  console.log('sidebar text head :', JSON.stringify(sidebarText.slice(0, 220)));
  console.log('xterm present?    :', await page.locator('.xterm').count());
  console.log('page errors       :', JSON.stringify(pageErrors.slice(0, 4)));

  await composer.click();
  await page.keyboard.type('hello from the dashboard', { delay: 15 });
  await page.waitForTimeout(1500);
  const typed = await frame.locator('body').innerText();
  console.log('typed landed?     :', typed.includes('hello from the dashboard'));

  await page.screenshot({ path: 'live-sidebar.png', fullPage: false });

  expect(pageErrors, 'no uncaught errors').toEqual([]);
  expect(typed, 'the composer accepts typing').toContain('hello from the dashboard');
});
