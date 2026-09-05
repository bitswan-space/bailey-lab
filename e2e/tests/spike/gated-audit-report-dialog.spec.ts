import { test, expect } from '@playwright/test';
import { signInThroughGate } from './gated.js';

const PROD =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai' +
  '&tab=deployments&stage=production&section=history';

test('the audited-by chip opens the report, rendered', async ({ page }) => {
  await signInThroughGate(page, PROD);
  const d = page.frameLocator('iframe').first();

  const chip = d.getByRole('button', { name: /timothy\.hobbs@harmonum\.ai/i }).first();
  await chip.waitFor({ state: 'visible', timeout: 120_000 });
  await chip.click();

  // A dialog, not text under the chip — and the markdown is rendered: the
  // headings are headings, and a table is a table rather than pipes.
  const dialog = d.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 60_000 });
  // The dialog is a real surface, not a translucent one mid-animation.
  await page.waitForTimeout(600);
  await expect(dialog.getByText(/^Audit report$/).first()).toBeVisible();
  const headings = await dialog.locator('h1, h2, h3').count();
  const raw = await dialog.innerText();
  console.log('headings:', headings, '| starts:', raw.replace(/\s+/g, ' ').slice(0, 140));
  expect(headings, 'the report rendered as a document').toBeGreaterThan(1);
  expect(raw, 'no raw markdown headings survived').not.toMatch(/^##\s/m);
  await page.screenshot({ path: 'gated-audit-report-dialog.png' });
});
