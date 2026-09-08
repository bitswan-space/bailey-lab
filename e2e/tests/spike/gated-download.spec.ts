import { test, expect } from '@playwright/test';
import { signInThroughGate } from './gated.js';

const FILE = 'test/bailey-operators-handbook.pdf';
const URL_UNDER_TEST =
  'https://playground-dashboard.tims-dev-server.bswn.io/?bp=test&copy=timothy-hobbs-harmonum-ai' +
  `&tab=agent&sub=files&file=${encodeURIComponent(FILE)}`;

test('a file too big to display can still be downloaded', async ({ page }) => {
  await signInThroughGate(page, URL_UNDER_TEST);

  const dash = page.frameLocator('iframe').first();
  const notDisplayed = dash.getByText(/larger than 1 MiB|Binary file/i).first();
  await notDisplayed.waitFor({ timeout: 90_000 });

  const link = dash.getByRole('link', { name: /Download/i }).first();
  await link.waitFor({ timeout: 30_000 });

  const download = page.waitForEvent('download', { timeout: 60_000 });
  await link.click();
  const got = await download;
  console.log('suggested filename:', got.suggestedFilename());
  const body = await got.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  const file = Buffer.concat(chunks);
  console.log('downloaded bytes  :', file.length);

  expect(got.suggestedFilename()).toBe('bailey-operators-handbook.pdf');
  // What matters is that the whole file came down intact, not its exact size:
  // this handbook is rebuilt by the e2e run, so pinning a byte count made the
  // test fail the next time the manual changed. A PDF header, a PDF trailer and
  // a size past the 1 MiB display threshold say the download is complete.
  expect(file.subarray(0, 5).toString()).toBe('%PDF-');
  expect(file.subarray(-1024).toString('latin1')).toMatch(/%%EOF/);
  expect(file.length).toBeGreaterThan(1024 * 1024);
});
