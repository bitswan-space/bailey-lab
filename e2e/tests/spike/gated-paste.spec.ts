import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { openSidebarFrame, signInThroughGate } from './gated.js';

const DASHBOARD_CONTAINER = 'playground-dashboard-bitswan-dashboard-1';

const IMAGE_BASE64 = fs.readFileSync('fixtures/claude-orange-32.png').toString('base64');

function insideContainer(script: string): string {
  try {
    return execFileSync('docker', ['exec', DASHBOARD_CONTAINER, 'sh', '-c', script], {
      encoding: 'utf8',
    });
  } catch (err) {
    return `failed: ${String(err).slice(0, 200)}`;
  }
}

test('a pasted image reaches the agent and lands somewhere it can read', async ({ page }) => {
  await signInThroughGate(page);
  const sidebar = await openSidebarFrame(page);

  const composer = sidebar.locator('[contenteditable="true"], [role="textbox"]').first();
  await composer.click({ timeout: 30_000 });

  const pasted = await sidebar.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'claude-orange-32.png', { type: 'image/png' });
    const target =
      document.querySelector('[contenteditable="true"]') ??
      document.querySelector('[role="textbox"]');
    if (!target) return 'no composer';
    const data = new DataTransfer();
    data.items.add(file);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return 'dispatched';
  }, IMAGE_BASE64);
  console.log('paste            :', pasted);
  await page.waitForTimeout(6_000);

  const afterPaste = await sidebar.evaluate(() => ({
    images: [...document.querySelectorAll('img')].map((i) => (i.getAttribute('src') ?? '').slice(0, 60)),
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
  }));
  console.log('panel after paste:', JSON.stringify(afterPaste, null, 1));

  await composer.type('Reply with only the hex colour of the image I just pasted, nothing else.', {
    delay: 10,
  });
  await composer.press('Enter');

  await expect
    .poll(
      async () =>
        (await sidebar.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))) ?? '',
      { timeout: 180_000, intervals: [3000, 5000, 5000] },
    )
    .toMatch(/#[0-9a-f]{6}\b|could not be processed|isn't on disk|not on disk|no image/i);

  const reply = await sidebar.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
  console.log('conversation     :', reply.slice(0, 900));
  await page.screenshot({ path: 'gated-paste.png' });

  console.log(
    'attachment files :',
    insideContainer(
      "find /tmp /claude-config /workspace/workspace/copies/timothy-hobbs-harmonum-ai/test -mmin -5 -type f " +
        "\\( -name '*.png' -o -name '*.jpg' -o -name '*image*' \\) 2>/dev/null | head -20",
    ),
  );

  expect(reply, 'the image was not rejected by the API').not.toMatch(/could not be processed/i);
  expect(reply, 'the agent did not report a missing file').not.toMatch(/isn't on disk|not on disk/i);
  expect(reply, 'the agent read a colour out of the pasted image').toMatch(/#[0-9a-f]{6}\b/i);
});
