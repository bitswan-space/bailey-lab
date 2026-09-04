import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/spike',
  testMatch: /gated-paste\.spec\.ts/,
  timeout: 600_000,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], ignoreHTTPSErrors: true, viewport: { width: 1500, height: 950 } },
});
