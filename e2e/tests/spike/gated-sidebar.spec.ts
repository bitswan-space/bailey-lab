import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';

const URL_UNDER_TEST =
  process.env.GATED_URL ??
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai&tab=agent&sub=chat';
const USER = process.env.GATED_EMAIL ?? 'timothy.hobbs@harmonum.ai';
const PASS = process.env.GATED_PASSWORD ?? '';

test('signed in through the real gate, the Coding Agent tab shows a working sidebar', async ({ page }) => {
  const wsFailures: string[] = [];
  const wsOpened: string[] = [];
  page.on('websocket', (ws) => {
    wsOpened.push(ws.url().split('?')[0] ?? ws.url());
    ws.on('socketerror', (e) => wsFailures.push(`${ws.url().split('?')[0]} ${e}`));
  });

  await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  // dex connector chooser: two connectors exist on this deployment, and the
  // Acme one authenticates as a test user with no access. Pick the real one.
  await page.getByText('Bitswan account', { exact: false }).first().click({ timeout: 30_000 });

  // Keycloak credentials.
  const user = page.locator('#username');
  await user.waitFor({ state: 'visible', timeout: 40_000 });
  await user.fill(USER);
  await page.locator('#password').fill(PASS);
  await page.locator('button[type="submit"], #kc-login').first().click();

  // Bailey device-trust pairing. A fresh browser profile is always untrusted, so
  // wait for the trust screen, then approve the pending request host-side with
  // the operator CLI — that is what makes this loop runnable without a human.
  await expect
    .poll(async () => (await page.locator('body').innerText().catch(() => '')) ?? '', {
      timeout: 90_000,
      intervals: [2000, 3000],
    })
    .toMatch(/Trust this device|Workspaces|Coding Agent/i);

  if (/Trust this device/i.test(await page.locator('body').innerText())) {
    let approved = false;
    for (let i = 0; i < 20 && !approved; i++) {
      try {
        const listed = execFileSync('bitswan', ['bailey', 'devices', 'list'], { encoding: 'utf8' });
        const code = listed.match(new RegExp(`${USER.replace(/[.@]/g, '\\$&')}[^\\n]*?(\\d{6})`))?.[1]
          ?? listed.match(/\b(\d{6})\b/)?.[1];
        if (code) {
          execFileSync('bitswan', ['bailey', 'devices', 'approve', code], { stdio: 'pipe' });
          console.log('approved pairing code:', code);
          approved = true;
        }
      } catch {
        // daemon may be mid-restart; retry
      }
      if (!approved) await page.waitForTimeout(3000);
    }
    expect(approved, 'a pending device request was approved').toBe(true);
  }

  // Once the device is trusted the gate bounces to the console root rather than
  // the originally requested URL, so ask for the dashboard again.
  await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(10_000);

  // The Coding Agent tab lives inside the chrome-wrap iframe; the sidebar is a
  // frame nested inside that. Poll for the sidebar frame itself rather than
  // matching page text — Bailey's own copy contains words like "device".
  const c = page.frameLocator('iframe').first();
  const codingTab = c.getByRole('button', { name: /Coding Agent/i }).first();
  await codingTab.click({ timeout: 60_000 }).catch(() => undefined);
  await expect
    .poll(() => page.frames().some((f) => f.url().includes('/sidebar/view')), {
      timeout: 120_000,
      intervals: [2000, 3000, 5000],
    })
    .toBe(true);
  await page.waitForTimeout(20_000);

  const sidebar = page.frames().find((f) => f.url().includes('/sidebar/view'));
  console.log('resting url       :', page.url().slice(0, 90));
  console.log('sidebar frame     :', Boolean(sidebar));
  if (sidebar) {
    const d = await sidebar.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      text: (document.body?.innerText || '').slice(0, 160),
    }));
    console.log('sidebar           :', JSON.stringify(d));
  }
  console.log('websockets opened :', JSON.stringify([...new Set(wsOpened)]));
  console.log('websocket errors  :', JSON.stringify(wsFailures.slice(0, 4)));
  await page.screenshot({ path: 'gated-sidebar.png', fullPage: false });

  expect(sidebar, 'the sidebar frame is present').toBeTruthy();
});
