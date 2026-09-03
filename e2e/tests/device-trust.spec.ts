import { test, expect, ENV, oidcLogin } from '../fixtures/bitswan';
import type { Page } from '@playwright/test';

const SLA = 90_000;
const DEVICE_COOKIE = '_bailey_device';

type DocumentHop = { url: string; carriedDeviceCookie: boolean };

function traceDocumentNavigations(page: Page): DocumentHop[] {
  const hops: DocumentHop[] = [];
  page.on('request', (req) => {
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
  });
  return hops;
}

function renderTrace(label: string, hops: DocumentHop[]): string {
  const rows = hops.map((h) => `  ${h.carriedDeviceCookie ? 'HAS ' : 'NONE'}  ${h.url}`);
  return [`${label} — device cookie per document request:`, ...rows].join('\n');
}

async function deviceCookieHosts(page: Page): Promise<string[]> {
  return (await page.context().cookies())
    .filter((c) => c.name === DEVICE_COOKIE)
    .map((c) => c.domain)
    .sort();
}

async function signInThroughKeycloak(page: Page): Promise<boolean> {
  const username = page.locator('#username, input[name="username"]').first();
  const appeared = await username
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
  else await page.waitForLoadState('networkidle').catch(() => {});
  return appeared;
}

test('device trust survives signing out and signing back in (#414)', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const console_ = page.frameLocator('iframe').last();
  const trustPrompt = page.getByRole('heading', { name: /Trust this device/i });
  const workspaces = console_.getByRole('heading', { name: /Workspaces/i });

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
    expect(await deviceCookieHosts(page), 'pairing must leave a device cookie').toContain(
      new URL(ENV.baileyUrl).hostname,
    );
  });

  await test.step('a reload on the same host still sees a trusted device', async () => {
    const hops = traceDocumentNavigations(page);
    await page.goto(ENV.baileyUrl + '/');
    await expect(workspaces, renderTrace('same-host reload', hops)).toBeVisible({ timeout: SLA });
    await expect(trustPrompt).toHaveCount(0);
  });

  const hops = traceDocumentNavigations(page);

  await test.step('sign out through the product, then end the Keycloak session', async () => {
    await page.goto(ENV.baileyUrl + '/bailey/signout');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.goto(ENV.keycloakUrl + '/realms/bitswan/protocol/openid-connect/logout');
    const confirmLogout = page
      .locator('#kc-logout, input[name="confirmLogout"], button[name="confirmLogout"]')
      .or(page.getByRole('button', { name: /^\s*(Sign out|Log ?out|Yes)\s*$/i }))
      .first();
    if (await confirmLogout.isVisible({ timeout: 10_000 }).catch(() => false)) await confirmLogout.click();
    await page.waitForLoadState('networkidle').catch(() => {});
  });

  let credentialsRetyped = false;
  const signInHops = traceDocumentNavigations(page);
  await test.step('sign back in', async () => {
    await page.goto(ENV.baileyUrl + '/');
    credentialsRetyped = await signInThroughKeycloak(page);
    await Promise.race([
      workspaces.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      trustPrompt.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
    ]);
  });

  const hostsAfter = await deviceCookieHosts(page);
  const consoleHost = new URL(ENV.baileyUrl).hostname;
  const onboardHost = new URL(ENV.onboardUrl).hostname;
  const bouncedToPairing = signInHops
    .filter((h) => h.url.includes('/2fa-gate/api/device-grant') || new URL(h.url).hostname === onboardHost)
    .map((h) => h.url);
  const trace = renderTrace('sign-out → sign-in', hops);
  const evidence = [
    trace,
    `  keycloak asked for credentials again: ${credentialsRetyped}`,
    `  device cookie hosts still in the browser jar: ${hostsAfter.join(', ') || '(none)'}`,
    `  resting url: ${page.url()}`,
    `  untrusted-device dance hops during sign-in: ${bouncedToPairing.length}`,
  ].join('\n');
  test.info().annotations.push({ type: 'device-trust evidence', description: evidence });
  process.stdout.write(`\n${evidence}\n\n`);

  expect(hostsAfter, `the device cookie must not be dropped by signing out\n${evidence}`).toContain(consoleHost);
  expect(bouncedToPairing, `signing back in must not run the untrusted-device dance\n${evidence}`).toHaveLength(0);
  await expect(trustPrompt, `signing back in must not re-prompt for device trust\n${evidence}`).toHaveCount(0);
  await expect(workspaces, `signing back in must land on the console\n${evidence}`).toBeVisible({ timeout: SLA });
});
