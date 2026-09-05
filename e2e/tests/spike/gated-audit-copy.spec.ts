import { test, expect } from '@playwright/test';
import { signInThroughGate } from './gated.js';

const AUDITS =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai' +
  '&tab=deployments&stage=staging&section=audits';

test('an auditor opens the audit and lands in a copy of the audited version', async ({ page }) => {
  await signInThroughGate(page, AUDITS);
  const d = page.frameLocator('iframe').first();

  const open = d.getByRole('button', { name: /Open the code for auditing/i }).first();
  await open.waitFor({ state: 'visible', timeout: 120_000 });
  await open.click();

  // The auditing banner is the proof they are in the audit copy — and it says
  // the two things that make an audit safe: the frozen image is untouched, and
  // changing this is a proposal rather than an approval.
  const banner = d.getByText(/You are auditing/i).first();
  await banner.waitFor({ state: 'visible', timeout: 180_000 });
  const bannerText = await banner.locator('..').innerText();
  console.log('banner:', bannerText.replace(/\s+/g, ' ').slice(0, 220));
  expect(bannerText).toMatch(/changes nothing that is deployed|proposal/i);
  await page.screenshot({ path: 'gated-audit-copy.png' });

  // The report was seeded into the business process, so there is something to
  // edit rather than a file to invent.
  const url = page.url();
  expect(url, 'the audit copy is the copy in view').toMatch(/copy=audit-/);
});
