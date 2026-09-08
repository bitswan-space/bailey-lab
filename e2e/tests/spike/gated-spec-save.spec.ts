import { test, expect } from '@playwright/test';
import { signInThroughGate } from './gated.js';

const URL_UNDER_TEST =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai&tab=description';

test('saving the description reports what the server actually said', async ({ page }) => {
  const saves: string[] = [];
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (!/files\/content/.test(r.url())) return;
    const body = await r.text().catch(() => '<unreadable>');
    saves.push(
      `${r.request().method()} ${r.status()} ct=${r.headers()['content-type']} len=${body.length} body=${JSON.stringify(body.slice(0, 400))}`,
    );
  });

  await signInThroughGate(page, URL_UNDER_TEST);
  const d = page.frameLocator('iframe').first();
  const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 120_000 });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Reviewed by the operator.', { delay: 20 });
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(8000);

  const toast = await d.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
  console.log('save requests    :', JSON.stringify(saves, null, 1));
  console.log('toasts           :', JSON.stringify(toast));
  console.log('console errors   :', JSON.stringify(consoleErrors.slice(0, 6), null, 1));

  expect(saves.length, 'the editor issued a save').toBeGreaterThan(0);
  expect(toast.join(' '), 'no save failure surfaced').not.toMatch(/Save failed/i);
});
