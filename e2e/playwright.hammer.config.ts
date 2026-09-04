import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/spike',
  testMatch: /gated-spec-hammer\.spec\.ts/,
  timeout: 420_000,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1500, height: 950 } },
});
