import { test, expect } from '@playwright/test';
import { signInThroughGate } from './gated.js';

const URL_UNDER_TEST =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai&tab=description';

test('inserting a flowchart and saving it does not fail', async ({ page }) => {
  const responses: string[] = [];
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 250));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 250)}`));
  page.on('response', async (r) => {
    if (!/files\/content|files\/upload/.test(r.url())) return;
    const body = await r.text().catch(() => '<unreadable>');
    responses.push(
      `${r.request().method()} ${r.status()} ct=${r.headers()['content-type']} len=${body.length} head=${JSON.stringify(body.slice(0, 200))}`,
    );
  });

  await signInThroughGate(page, URL_UNDER_TEST);
  const d = page.frameLocator('iframe').first();
  const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 120_000 });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');

  await d.getByRole('button', { name: /Insert flowchart/i }).first().click({ timeout: 30_000 });
  const modal = d.locator('[role="dialog"]').first();
  await modal.waitFor({ timeout: 30_000 });
  for (const label of [/Add process/i, /Add decision/i]) {
    await modal.getByRole('button', { name: label }).first().click({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await modal.getByRole('button', { name: /Save diagram/i }).first().click({ timeout: 20_000 });
  await page.waitForTimeout(4000);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(8000);

  const toasts = await d.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
  console.log('file writes    :', JSON.stringify(responses, null, 1));
  console.log('toasts         :', JSON.stringify(toasts));
  console.log('console errors :', JSON.stringify(consoleErrors.slice(0, 8), null, 1));
  await page.screenshot({ path: 'gated-flowchart.png' });

  expect(toasts.join(' '), 'no save failure surfaced').not.toMatch(/Save failed/i);
});
