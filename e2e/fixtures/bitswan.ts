/**
 * Fixtures for the real-stack Bailey walkthrough. The suite drives the actual
 * onboarding (OIDC → claim → device trust), creates a workspace through the
 * Server Console UI, and walks every feature — capturing a screenshot at each
 * beat into e2e/manual/build/shots/<slotId>.png. Those screenshots are the raw
 * material the manual generator assembles afterward.
 */
import { test as base, expect, type Page, type Locator, type FrameLocator } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SHOTS_DIR = join(__dirname, '..', 'manual', 'build', 'shots');
mkdirSync(SHOTS_DIR, { recursive: true });

export const ENV = {
  domain: process.env.E2E_DOMAIN || 'bs-e2e.localhost',
  baileyUrl: process.env.E2E_BAILEY_URL || 'https://bailey.bs-e2e.localhost',
  onboardUrl: process.env.E2E_ONBOARD_URL || 'https://bailey-onboard.bs-e2e.localhost',
  keycloakUrl: process.env.E2E_KEYCLOAK_URL || 'http://keycloak.bs-e2e.localhost:8088',
  operatorEmail: process.env.E2E_OPERATOR_EMAIL || 'tomas.novak@meridianfoods.cz',
  operatorPassword: process.env.E2E_OPERATOR_PASSWORD || 'meridian-operator',
};

/** Run a host shell command (for asserting real backend effects). */
export function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' });
}

/**
 * Capture a screenshot into the slot the manual references by id. The generator
 * picks these up by filename (shots/<slotId>.png). Keep slotIds in sync with
 * the slot ids in e2e/manual/content.mjs.
 */
export async function capture(
  page: Page,
  slotId: string,
  opts: { fullPage?: boolean; settleMs?: number; locator?: Locator } = {},
): Promise<void> {
  await page.waitForTimeout(opts.settleMs ?? 450); // let transitions settle
  const path = join(SHOTS_DIR, `${slotId}.png`);
  if (opts.locator) await opts.locator.screenshot({ path });
  else await page.screenshot({ path, fullPage: !!opts.fullPage });
  // eslint-disable-next-line no-console
  console.log(`📸 captured ${slotId}`);
}

/** Fill and submit the Keycloak login form (whatever the realm's theme renders). */
export async function oidcLogin(page: Page, email: string, password: string): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  const user = page.locator('#username, input[name="username"]').first();
  await user.waitFor({ state: 'visible', timeout: 30_000 });
  await user.fill(email);
  await page.locator('#password, input[name="password"]').first().fill(password);
  await page.locator('#kc-login, input[type="submit"], button[type="submit"]').first().click();
  await page.waitForLoadState('networkidle');
}

export type FrameOrPage = Page | FrameLocator;

/**
 * The workspace dashboard root. It may be embedded in an iframe (chrome-wrap) or
 * served top-level depending on the host, so resolve to whichever is present.
 */
export async function dashboard(page: Page): Promise<FrameOrPage> {
  const frames = await page.locator('iframe').count();
  return frames > 0 ? page.frameLocator('iframe').last() : page;
}

export const test = base;
export { expect };
