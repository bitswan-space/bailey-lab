import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/spike',
  testMatch: /live-sidebar\.spec\.ts/,
  timeout: 180_000,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], ignoreHTTPSErrors: true },
});
