import { test, expect } from '@playwright/test';
import { signInThroughGate } from './gated.js';

const AUDITS =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai' +
  '&tab=deployments&stage=staging&section=audits';

test('"Write it with the agent" arrives in the agent as a prompt', async ({ page }) => {
  await signInThroughGate(page, AUDITS);
  const d = page.frameLocator('iframe').first();

  const door = d.getByRole('button', { name: /Open the code for auditing/i }).first();
  await door.waitFor({ state: 'visible', timeout: 120_000 });
  await door.click();
  await d.getByText(/You are auditing/i).first().waitFor({ state: 'visible', timeout: 180_000 });

  await d.getByRole('button', { name: /^Audit report$/ }).first().click();
  await d.locator('.ProseMirror, [contenteditable="true"]').first()
    .waitFor({ state: 'visible', timeout: 120_000 });
  await d.getByRole('button', { name: /Write it with the agent/i }).first().click();

  // The agent's panel reloads with the prompt already in its composer.
  const composed = await expect
    .poll(
      async () => {
        const sidebar = page.frames().find((f) => f.url().includes('/sidebar/view'));
        if (!sidebar) return '';
        return sidebar
          .evaluate(() =>
            Array.from(document.querySelectorAll('[contenteditable],[role="textbox"],textarea'))
              .map((el) => (el instanceof HTMLTextAreaElement ? el.value : el.textContent) || '')
              .join(' ')
              .replace(/\s+/g, ' '),
          )
          .catch(() => '');
      },
      { timeout: 180_000, intervals: [3000, 5000] },
    )
    .toMatch(/AUDIT\.md/i)
    .then(() => true)
    .catch(() => false);
  const sidebar = page.frames().find((f) => f.url().includes('/sidebar/view'));
  console.log(
    'composer:',
    (
      (await sidebar
        ?.evaluate(() =>
          Array.from(document.querySelectorAll('[contenteditable],[role="textbox"],textarea'))
            .map((el) => (el instanceof HTMLTextAreaElement ? el.value : el.textContent) || '')
            .join(' | '),
        )
        .catch(() => '')) ?? ''
    )
      .replace(/\s+/g, ' ')
      .slice(0, 400),
  );
  await page.screenshot({ path: 'gated-agent-prompt.png' });
  expect(composed, 'the prompt reached the agent').toBe(true);
});
