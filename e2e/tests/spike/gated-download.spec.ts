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
  let bytes = 0;
  for await (const chunk of body) bytes += (chunk as Buffer).length;
  console.log('downloaded bytes  :', bytes);

  expect(got.suggestedFilename()).toBe('bailey-operators-handbook.pdf');
  expect(bytes).toBe(7856387);
});
