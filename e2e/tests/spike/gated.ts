import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';

export const DASHBOARD_URL =
  process.env.GATED_URL ??
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai&tab=agent&sub=chat';
export const USER = process.env.GATED_EMAIL ?? 'timothy.hobbs@harmonum.ai';
const PASS = process.env.GATED_PASSWORD ?? '';

function pendingDeviceCodes(): string {
  try {
    return execFileSync('bitswan', ['bailey', 'devices', 'list'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

export async function signInThroughGate(page: Page, url = DASHBOARD_URL): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  await page.getByText('Bitswan account', { exact: false }).first().click({ timeout: 30_000 });

  const user = page.locator('#username');
  await user.waitFor({ state: 'visible', timeout: 40_000 });
  await user.fill(USER);
  await page.locator('#password').fill(PASS);
  await page.locator('button[type="submit"], #kc-login').first().click();

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
      if (pendingDeviceCodes().includes(shown!)) {
        execFileSync('bitswan', ['bailey', 'devices', 'approve', shown!], { stdio: 'pipe' });
        console.log('approved the code this browser is showing:', shown);
        approved = true;
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => undefined);
    await page.waitForTimeout(5_000);
    if (page.url().includes('playground-dashboard')) break;
    console.log('still off the dashboard:', page.url().slice(0, 80));
  }
  await page.waitForTimeout(5_000);

}

export async function openSidebarFrame(page: Page) {
  const chrome = page.frameLocator('iframe').first();
  await chrome
    .getByRole('button', { name: /Coding Agent/i })
    .first()
    .click({ timeout: 60_000 })
    .catch(() => undefined);
  await expect
    .poll(() => page.frames().some((f) => f.url().includes('/sidebar/view')), {
      timeout: 120_000,
      intervals: [2000, 3000, 5000],
    })
    .toBe(true);
  await page.waitForTimeout(15_000);
  const frame = page.frames().find((f) => f.url().includes('/sidebar/view'));
  expect(frame, 'the sidebar frame is present').toBeTruthy();
  return frame!;
}

/**
 * Whether the playground's staging stage is frozen right now.
 *
 * Every audit spec needs a frozen image to audit, and the playground loses one
 * the moment the audited image reaches production — staging unfreezes itself on
 * release. Without this the specs waited two minutes for a button that is
 * correctly absent and then blamed the UI.
 */
export async function stagingIsFrozen(page: Page): Promise<boolean> {
  const d = page.frameLocator('iframe').first();
  return d
    .getByRole('button', { name: /^Unfreeze$/ })
    .first()
    .isVisible({ timeout: 60_000 })
    .catch(() => false);
}
