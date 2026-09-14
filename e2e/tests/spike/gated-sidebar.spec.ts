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
  const failedRequests: string[] = [];
  page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText} ${r.url().slice(0, 110)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 110)}`);
  });
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
    const shown = (await page.locator('body').innerText()).match(/\b(\d{6})\b/)?.[1];
    expect(shown, 'the trust screen shows a pairing code').toBeTruthy();
    let approved = false;
    for (let i = 0; i < 20 && !approved; i++) {
      try {
        const listed = execFileSync('bitswan', ['bailey', 'devices', 'list'], { encoding: 'utf8' });
        if (listed.includes(shown!)) {
          execFileSync('bitswan', ['bailey', 'devices', 'approve', shown!], { stdio: 'pipe' });
          console.log('approved the code this browser is showing:', shown);
          approved = true;
        }
      } catch {
        // daemon may be mid-restart; retry
      }
      if (!approved) await page.waitForTimeout(3000);
    }
    expect(approved, 'this browser\'s own pairing request was approved').toBe(true);
    await expect
      .poll(async () => (await page.locator('body').innerText().catch(() => '')) ?? '', {
        timeout: 60_000,
        intervals: [2000, 3000],
      })
      .not.toMatch(/Waiting for approval/i);
  }

  for (let i = 0; i < 8; i++) {
    await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => undefined);
    await page.waitForTimeout(5_000);
    if (page.url().includes('playground-dashboard')) break;
    console.log('still off the dashboard:', page.url().slice(0, 80));
  }
  await page.waitForTimeout(5_000);

  // The Coding Agent tab lives inside the chrome-wrap iframe; the sidebar is a
  // frame nested inside that. Poll for the sidebar frame itself rather than
  // matching page text — Bailey's own copy contains words like "device".
  const c = page.frameLocator('iframe').first();
  const codingTab = c.getByRole('button', { name: /Coding Agent/i }).first();
  await codingTab.click({ timeout: 60_000 }).catch(() => undefined);
  const sawFrame = await expect
    .poll(() => page.frames().some((f) => f.url().includes('/sidebar/view')), {
      timeout: 120_000,
      intervals: [2000, 3000, 5000],
    })
    .toBe(true)
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(sawFrame ? 20_000 : 2_000);
  console.log('saw sidebar frame :', sawFrame);
  console.log('frames            :', JSON.stringify(page.frames().map((f) => f.url().slice(0, 100)), null, 1));
  const outer = page.frames().find((f) => f.url().includes('--inner'));
  console.log('dashboard text    :', ((await outer?.evaluate(() => document.body.innerText).catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 400));

  const sidebar = page.frames().find((f) => f.url().includes('/sidebar/view'));
  console.log('resting url       :', page.url().slice(0, 90));
  console.log('sidebar frame     :', Boolean(sidebar));
  const detail = sidebar
    ? await sidebar.evaluate(() => ({
        nodes: document.querySelectorAll('*').length,
        editable: document.querySelectorAll('[contenteditable],[role="textbox"]').length,
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 140),
      }))
    : undefined;
  console.log('sidebar detail    :', JSON.stringify(detail));
  const styling = sidebar
    ? await sidebar.evaluate(() => {
        const referenced = new Set<string>();
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList | undefined;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          const walk = (list: CSSRuleList) => {
            for (const rule of Array.from(list)) {
              const nested = (rule as CSSGroupingRule).cssRules;
              if (nested) walk(nested);
              const text = (rule as CSSStyleRule).style?.cssText ?? '';
              for (const m of text.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) referenced.add(m[1]!);
            }
          };
          walk(rules);
        }
        const root = getComputedStyle(document.documentElement);
        const missing = [...referenced].filter((name) => !root.getPropertyValue(name).trim());
        const sheets = Array.from(document.styleSheets).map((s) => ({
          href: s.href ? s.href.slice(-60) : 'inline',
          rules: (() => {
            try {
              return s.cssRules.length;
            } catch {
              return -1;
            }
          })(),
        }));
        return { referenced: referenced.size, missing, sheets };
      })
    : undefined;
  console.log('sidebar styling   :', JSON.stringify(styling, null, 1));

  const xterm = await page
    .frames()
    .find((f) => f.url().includes('--inner') && !f.url().includes('/sidebar/view'))
    ?.evaluate(() => document.querySelectorAll('.xterm').length);
  console.log('xterm in dashboard:', xterm);
  console.log('websockets opened :', JSON.stringify([...new Set(wsOpened)]));
  console.log('failed requests   :', JSON.stringify([...new Set(failedRequests)].slice(0, 12), null, 1));
  console.log('websocket errors  :', JSON.stringify(wsFailures.slice(0, 4)));
  await page.screenshot({ path: 'gated-sidebar.png', fullPage: false });
  const sf = page.frames().find((f) => f.url().includes('/sidebar/view'));
  if (sf) {
    const el = await sf.frameElement().catch(() => null);
    if (el) await el.screenshot({ path: 'gated-sidebar-frame.png' }).catch(() => undefined);
  }

  expect(sidebar, 'the sidebar frame is present').toBeTruthy();
  expect(xterm, 'no terminal is mounted anywhere').toBe(0);
  expect(detail?.nodes ?? 0, 'the sidebar rendered a real UI').toBeGreaterThan(80);
  expect(detail?.editable ?? 0, 'the composer is present, so the chat is usable').toBeGreaterThan(0);
});
