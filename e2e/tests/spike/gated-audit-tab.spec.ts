import { test, expect } from '@playwright/test';
import { signInThroughGate } from './gated.js';

const AUDITS =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai' +
  '&tab=deployments&stage=staging&section=audits';

test('the audit is one door in, and the sign-off lives beside the report', async ({ page }) => {
  await signInThroughGate(page, AUDITS);
  const d = page.frameLocator('iframe').first();

  // The Audits section keeps the record and one way in — no sign-off form, no
  // explainer about where the audit happens.
  const door = d.getByRole('button', { name: /Open the code for auditing/i }).first();
  await door.waitFor({ state: 'visible', timeout: 120_000 });
  await expect(d.getByText(/Add your audit|Update your audit/i)).toHaveCount(0);
  await expect(d.getByText(/The audit happens in a copy/i)).toHaveCount(0);
  await page.screenshot({ path: 'gated-audits-section.png' });
  await door.click();

  // Inside the audit copy, Deploy's place is taken by the Audit report, which
  // carries the report editor and the sign-off.
  await d.getByText(/You are auditing/i).first().waitFor({ state: 'visible', timeout: 180_000 });
  const auditTab = d.getByRole('button', { name: /^Audit report$/ }).first();
  await auditTab.waitFor({ state: 'visible', timeout: 60_000 });
  await expect(d.getByRole('button', { name: /^Deploy$/ })).toHaveCount(0);
  await auditTab.click();

  // The report, in the Description editor.
  const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 120_000 });
  const text = await editor.innerText();
  console.log('report starts:', text.replace(/\s+/g, ' ').slice(0, 120));
  expect(text).toMatch(/Audit/i);
  await page.screenshot({ path: 'gated-audit-report-tab.png' });

  // …and the sign-off, next to it.
  await d.getByRole('button', { name: /^Sign off$/ }).first().click();
  await d.getByText(/Add your audit|Update your audit/i).first().waitFor({ timeout: 60_000 });
  await expect(d.getByRole('button', { name: /^Approve$/ }).first()).toBeVisible();
});
