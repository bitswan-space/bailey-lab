import { test as base, expect, type Page, type FrameLocator } from '@playwright/test';
import { execSync } from 'node:child_process';

const USER = process.env.E2E_USER || 'e2e-admin@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'e2e-admin-password';

/**
 * Log in through the REAL (disposable) Keycloak login form — the same flow as
 * production, just against the seeded test realm. The dashboard then renders
 * inside the Bailey wrap's iframe, so `dashboard()` returns that frame.
 */
async function login(page: Page) {
  await page.goto('/');
  // Keycloak presents a username/password form. (Already-authenticated reloads
  // skip straight to the app, so the form is optional.)
  const username = page.locator('#username');
  try {
    await username.waitFor({ state: 'visible', timeout: 15_000 });
    await username.fill(USER);
    await page.locator('#password').fill(PASSWORD);
    await Promise.all([
      page.waitForNavigation({ timeout: 45_000 }).catch(() => {}),
      page.locator('#kc-login, input[type=submit], button[type=submit]').first().click(),
    ]);
  } catch {
    // No login form — assume an existing session.
  }
  // The SPA loads inside the protected-wrap iframe; wait for it to mount.
  await page.locator('iframe').first().waitFor({ state: 'attached', timeout: 60_000 });
}

/** The dashboard SPA frame (it lives inside the Bailey chrome-wrap iframe). */
function dashboard(page: Page): FrameLocator {
  return page.frameLocator('iframe').first();
}

/** Drive the dashboard by its URL state (bp / copy / tab / stage / section). */
async function goToView(
  page: Page,
  q: { bp?: string; copy?: string; tab?: string; stage?: string; section?: string },
) {
  const params = new URLSearchParams(
    Object.entries(q).filter(([, v]) => v != null) as [string, string][],
  );
  await page.goto('/?' + params.toString());
  await page.locator('iframe').first().waitFor({ state: 'attached', timeout: 60_000 });
}

/** Run a shell command on the host (for asserting REAL backend effects). */
function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', timeout: 60_000 });
}

export const test = base.extend<{ login: void }>({
  login: [
    async ({ page }, use) => {
      await login(page);
      await use();
    },
    { auto: true },
  ],
});

export { expect, dashboard, goToView, sh, USER };
