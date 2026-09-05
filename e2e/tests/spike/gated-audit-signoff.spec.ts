import { test, expect } from '@playwright/test';
import { signInThroughGate } from './gated.js';

const AUDITS =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai' +
  '&tab=deployments&stage=staging&section=audits';

const MARK = `Checked the ledger client and the inbound bucket ${Date.now()}.`;

test('a verdict is given on the report, and the report is what gets recorded', async ({ page }) => {
  await signInThroughGate(page, AUDITS);
  const d = page.frameLocator('iframe').first();

  const door = d.getByRole('button', { name: /Open the code for auditing/i }).first();
  await door.waitFor({ state: 'visible', timeout: 120_000 });
  await door.click();
  await d.getByText(/You are auditing/i).first().waitFor({ state: 'visible', timeout: 180_000 });

  await d.getByRole('button', { name: /^Audit report$/ }).first().click();
  const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 120_000 });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(MARK, { delay: 5 });
  await page.keyboard.press('Control+s');
  await d.getByRole('button', { name: /Saving/i }).first()
    .waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined);

  await d.getByRole('button', { name: /^Approve$/ }).first().click();
  await expect(
    d.getByText(/You approved this image/i).first(),
    'the tab did not come back showing my verdict',
  ).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: 'gated-audit-signoff.png' });

  // What was recorded is the document, not a summary of it.
  await d.getByRole('button', { name: /^Deployments$/ }).first().click();
  await d.getByRole('button', { name: /Audits (off|\d+\/\d+)/i }).first().click();
  const kept = d.getByText(/The report as it was signed off/i).first();
  await kept.waitFor({ state: 'visible', timeout: 120_000 });
  await kept.click();
  await expect(d.getByText(MARK, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: 'gated-audit-log.png' });
});
