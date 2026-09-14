import { test, expect } from '@playwright/test';
import { signInThroughGate } from './gated.js';

const URL_UNDER_TEST =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai&tab=description';

const PARAS = [
  'Ingest vendor invoices from the inbound bucket.',
  'Validate totals and VAT against the purchase order.',
  'Route anything over 5000 EUR for approval.',
  'Post the rest to the ledger, then archive the source document.',
];

test('a long description typed fast and saved repeatedly never fails', async ({ page }) => {
  const bad: string[] = [];
  page.on('response', async (r) => {
    if (!/files\/content/.test(r.url())) return;
    const body = await r.text().catch(() => '<unreadable>');
    let parseError = '';
    try {
      JSON.parse(body);
    } catch (e) {
      parseError = String(e).slice(0, 120);
    }
    if (parseError || r.status() >= 400) {
      bad.push(`${r.request().method()} ${r.status()} parse=${parseError} head=${JSON.stringify(body.slice(0, 200))}`);
    }
  });

  await signInThroughGate(page, URL_UNDER_TEST);
  const d = page.frameLocator('iframe').first();
  const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 120_000 });
  await editor.click();
  await page.keyboard.press('Control+End');

  for (const p of PARAS) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(p, { delay: 8 });
    await page.keyboard.press('Control+s');
  }
  await page.waitForTimeout(10_000);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(6000);

  const toasts = await d.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
  console.log('bad responses:', JSON.stringify(bad, null, 1));
  console.log('toasts       :', JSON.stringify(toasts));
  expect(bad, 'every save response was clean JSON').toEqual([]);
  expect(toasts.join(' ')).not.toMatch(/Save failed/i);
});
