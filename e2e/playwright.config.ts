import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// e2e/.env is written by bringup.sh; load it so the config picks up the live
// dashboard URL, falling back to a sensible default when only listing tests.

const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const DASHBOARD_URL =
  process.env.E2E_DASHBOARD_URL || 'https://e2e-dashboard.bs-e2e.localhost';

export default defineConfig({
  testDir: './tests',
  // The lifecycle is one ordered story (create → … → rollback); run serially.
  fullyParallel: false,
  workers: 1,
  // Real deploys build images and bring up containers — minutes per step.
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: DASHBOARD_URL,
    // Traefik serves trusted mkcert certs, but keep this on so the suite is
    // robust to the CI cert setup.
    ignoreHTTPSErrors: true,
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 60_000,
    navigationTimeout: 90_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
