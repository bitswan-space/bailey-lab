import { defineConfig, devices } from '@playwright/test';

/**
 * The spike's gated suite: every `tests/spike/gated-*.spec.ts` drives the real
 * deployment through the real Bailey gate — OIDC sign-in, then approving this
 * browser's own device-pairing code with the operator CLI (tests/spike/gated.ts).
 * Needs GATED_PASSWORD, and GATED_URL when pointing at another deployment.
 * Excluded from the default config (testIgnore: spike/**), so CI never runs it.
 */
export default defineConfig({
  testDir: './tests/spike',
  testMatch: /gated-.*\.spec\.ts/,
  timeout: 600_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    viewport: { width: 1500, height: 950 },
  },
});
