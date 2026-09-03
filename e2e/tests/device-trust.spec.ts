import { test, expect, ENV, oidcLogin } from '../fixtures/bitswan';
import type { Page, Request } from '@playwright/test';

const SLA = 90_000;
const DEVICE_COOKIE = '_bailey_device';

type DocumentHop = { url: string; carriedDeviceCookie: boolean };
type HopTrace = { hops: DocumentHop[]; stop: () => void };

function traceDocumentNavigations(page: Page): HopTrace {
  const hops: DocumentHop[] = [];
  const onRequest = (req: Request) => {
    if (req.resourceType() !== 'document') return;
    req
      .allHeaders()
      .then((h) => {
        hops.push({
          url: req.url(),
          carriedDeviceCookie: (h['cookie'] || '').includes(DEVICE_COOKIE + '='),
        });
      })
      .catch(() => {});
  };
  page.on('request', onRequest);
  return { hops, stop: () => page.off('request', onRequest) };
}

function renderTrace(label: string, hops: DocumentHop[]): string {
  return [
    `${label} — device cookie per document request:`,
    ...hops.map((h) => `  ${h.carriedDeviceCookie ? 'HAS ' : 'NONE'}  ${h.url}`),
  ].join('\n');
}

function grantHops(hops: DocumentHop[]): string[] {
  return hops.filter((h) => h.url.includes('/2fa-gate/api/device-grant')).map((h) => h.url);
}

function onboardingPageHops(hops: DocumentHop[]): string[] {
  const onboardHost = new URL(ENV.onboardUrl).hostname;
  return hops
    .filter((h) => new URL(h.url).hostname === onboardHost && !h.url.includes('/2fa-gate/api/'))
    .map((h) => h.url);
}

async function deviceCookieHosts(page: Page): Promise<string[]> {
  return (await page.context().cookies())
    .filter((c) => c.name === DEVICE_COOKIE)
    .map((c) => c.domain)
    .sort();
}

async function fillKeycloakFormIfShown(page: Page): Promise<boolean> {
  const username = page.locator('#username, input[name="username"]').first();
  const shown = await username
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (shown) await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
  else await page.waitForLoadState('networkidle').catch(() => {});
  return shown;
}

async function endKeycloakSession(page: Page) {
  await page.goto(ENV.keycloakUrl + '/realms/bitswan/protocol/openid-connect/logout');
  const confirmLogout = page
    .locator('#kc-logout, input[name="confirmLogout"], button[name="confirmLogout"]')
    .or(page.getByRole('button', { name: /^\s*(Sign out|Log ?out|Yes)\s*$/i }))
    .first();
  if (await confirmLogout.isVisible({ timeout: 10_000 }).catch(() => false)) await confirmLogout.click();
  await page.waitForLoadState('networkidle').catch(() => {});
}

type RoundTrip = {
  trace: string;
  grants: string[];
  onboardingPages: string[];
  credentialsRetyped: boolean;
  restingUrl: string;
  cookieHosts: string[];
};

async function signOutAndBackIn(
  page: Page,
  label: string,
  opts: { endIdpSession: boolean },
  settle: () => Promise<void>,
): Promise<RoundTrip> {
  await page.goto(ENV.baileyUrl + '/bailey/signout');
  await page.waitForLoadState('networkidle').catch(() => {});
  if (opts.endIdpSession) await endKeycloakSession(page);

  const { hops, stop } = traceDocumentNavigations(page);
  await page.goto(ENV.baileyUrl + '/');
  const credentialsRetyped = await fillKeycloakFormIfShown(page);
  await settle();
  stop();

  return {
    trace: renderTrace(label, hops),
    grants: grantHops(hops),
    onboardingPages: onboardingPageHops(hops),
    credentialsRetyped,
    restingUrl: page.url(),
    cookieHosts: await deviceCookieHosts(page),
  };
}

function renderEvidence(r: RoundTrip): string {
  return [
    r.trace,
    `  keycloak asked for credentials again: ${r.credentialsRetyped}`,
    `  device-grant hops: ${r.grants.length}`,
    `  onboarding pages rendered: ${r.onboardingPages.length}`,
    `  device cookie hosts still in the browser jar: ${r.cookieHosts.join(', ') || '(none)'}`,
    `  resting url: ${r.restingUrl}`,
  ].join('\n');
}

test('device trust survives signing out and signing back in (#414)', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const console_ = page.frameLocator('iframe').last();
  const trustPrompt = page.getByRole('heading', { name: /Trust this device/i });
  const workspaces = console_.getByRole('heading', { name: /Workspaces/i });
  const consoleHost = new URL(ENV.baileyUrl).hostname;

  const settle = async () => {
    await Promise.race([
      workspaces.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      trustPrompt.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
    ]);
  };

  await test.step('pair this device: sign in and claim the server', async () => {
    await page.goto(ENV.onboardUrl + '/');
    await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
    const claimOnPage = page.getByRole('button', { name: /Claim this server/i });
    const claimInConsole = console_.getByRole('button', { name: /Claim this server/i });
    await Promise.race([
      claimOnPage.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      claimInConsole.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      workspaces.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
    ]);
    const claim = (await claimOnPage.isVisible().catch(() => false))
      ? claimOnPage
      : (await claimInConsole.isVisible().catch(() => false))
        ? claimInConsole
        : null;
    if (claim) await claim.click();
    await expect(workspaces).toBeVisible({ timeout: SLA });
    expect(await deviceCookieHosts(page), 'pairing must leave a device cookie').toContain(consoleHost);
  });

  let silent!: RoundTrip;
  await test.step('sign out of Bailey only, and let the live IdP session sign us back in', async () => {
    silent = await signOutAndBackIn(page, 'silent re-auth', { endIdpSession: false }, settle);
    await expect(workspaces).toBeVisible({ timeout: SLA });
  });

  let retyped!: RoundTrip;
  await test.step('sign out of Bailey and the IdP, then sign back in for real', async () => {
    retyped = await signOutAndBackIn(page, 'sign-out → credentials → sign-in', { endIdpSession: true }, settle);
  });

  const evidence = `${renderEvidence(silent)}\n\n${renderEvidence(retyped)}`;
  test.info().annotations.push({ type: 'device-trust evidence', description: evidence });
  process.stdout.write(`\n${evidence}\n\n`);

  expect(silent.grants, `a silent re-auth must not need the device-grant dance\n${evidence}`).toHaveLength(0);
  expect(silent.onboardingPages, `a silent re-auth must not visit the onboarding host\n${evidence}`).toHaveLength(0);

  expect(retyped.cookieHosts, `the device cookie must not be dropped by signing out\n${evidence}`).toContain(consoleHost);
  expect(retyped.onboardingPages, `signing back in must never park the user on the onboarding host\n${evidence}`).toHaveLength(0);
  expect(retyped.grants.length, `the device-grant dance must settle in one pass\n${evidence}`).toBeLessThanOrEqual(1);
  await expect(trustPrompt, `signing back in must not re-prompt for device trust\n${evidence}`).toHaveCount(0);
  await expect(workspaces, `signing back in must land on the console\n${evidence}`).toBeVisible({ timeout: SLA });
});
