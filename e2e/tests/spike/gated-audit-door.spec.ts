import { test, expect } from '@playwright/test';
import { signInThroughGate, stagingIsFrozen } from './gated.js';

const AUDITS =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai' +
  '&tab=deployments&stage=staging&section=audits';

/**
 * Unlike the other audit specs, this one makes its own frozen image if the
 * playground has none — an audited image reaching production unfreezes staging,
 * so the door is often gone — and puts the stage back as it found it.
 */
test('the door into an audit opens the code, not the page it was pressed from', async ({ page }) => {
  await signInThroughGate(page, AUDITS);
  const d = page.frameLocator('iframe').first();

  const wasFrozen = await stagingIsFrozen(page);
  if (!wasFrozen) {
    await d.getByRole('button', { name: /^Freeze$/ }).first().click();
    await d
      .getByRole('button', { name: /^Unfreeze$/ })
      .first()
      .waitFor({ state: 'visible', timeout: 120_000 });
  }

  try {
    const door = d.getByRole('button', { name: /Open the code for auditing/i }).first();
    await door.waitFor({ state: 'visible', timeout: 120_000 });
    await door.click();

    await d.getByText(/You are auditing/i).first().waitFor({ state: 'visible', timeout: 180_000 });
    // The Coding Agent tab, which is the only place these sub-tabs exist, and
    // its Files view: the button promises the code, so the code is what opens.
    await expect(d.getByRole('button', { name: /^Files$/ }).first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(d.getByRole('button', { name: /^Containers$/ }).first()).toBeVisible();
    await expect(d.getByPlaceholder(/Search in files/i).first()).toBeVisible({ timeout: 60_000 });
    expect(page.url(), 'the URL says the same').toMatch(/tab=agent/);
    expect(page.url()).toMatch(/sub=files/);
    await page.screenshot({ path: 'gated-audit-door.png' });
  } finally {
    if (!wasFrozen) {
      await d.getByRole('button', { name: /^Deployments$/ }).first().click().catch(() => undefined);
      await d
        .getByRole('button', { name: /^Unfreeze$/ })
        .first()
        .click({ timeout: 60_000 })
        .catch(() => undefined);
      await d
        .getByRole('button', { name: /^Freeze$/ })
        .first()
        .waitFor({ state: 'visible', timeout: 120_000 })
        .catch(() => undefined);
    }
  }
});
