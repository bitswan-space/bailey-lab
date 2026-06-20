/**
 * The product walkthrough — driven through the REAL Bailey stack in a browser.
 *
 * The genuine operator journey, screenshotting each beat into the manual's
 * slots: onboarding (OIDC → claim → device trust) → create the Meridian Foods
 * workspace through the Server Console → open its dashboard → walk the features.
 * The screenshots are the raw material the manual is written from, so the
 * critical path is hard-asserted; breadth captures are attempted and any miss is
 * logged + summarized (so one off selector doesn't cost every later screenshot
 * while the suite stabilizes against real traces).
 *
 * Observed truth: the Server Console renders top-level (no iframe) on the
 * onboard host; the workspace dashboard is embedded — see dash().
 */
import { test, expect, capture, oidcLogin, dashboard, ENV, type FrameOrPage } from '../fixtures/bitswan';
import { BP, WORKSPACE, COMPANY } from '../scenario';

const misses: string[] = [];

async function chapter(name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    try {
      await fn();
    } catch (e) {
      misses.push(`${name}: ${(e as Error).message.split('\n')[0]}`);
      // eslint-disable-next-line no-console
      console.warn(`⚠️  chapter "${name}" incomplete — ${(e as Error).message.split('\n')[0]}`);
    }
  });
}

test('Bailey product walkthrough → manual screenshots', async ({ page }) => {
  test.setTimeout(35 * 60_000);

  // ---- Onboarding (hard-asserted) ----
  await test.step('onboarding: sign in + claim the server', async () => {
    await page.goto(ENV.onboardUrl + '/');
    await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
    const claim = page.getByRole('button', { name: /Claim this server/i });
    await expect(claim).toBeVisible({ timeout: 30_000 });
    await capture(page, 'onboard-claim');
    await claim.click();
    // The console's Workspaces view renders once the device is trusted.
    await expect(page.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: 30_000 });
  });

  // ---- Create the workspace via the console (hard-asserted) ----
  await test.step('create the Meridian Foods workspace', async () => {
    await page.getByRole('button', { name: /New workspace/i }).first().click();
    await page.getByRole('textbox').first().fill(WORKSPACE.name);
    await capture(page, 'workspace-create');
    await page.getByRole('button', { name: /^(Create|Create workspace)$/i }).last().click();
    // Creation streams progress; wait until the workspace is listed/active.
    await expect(page.getByText(new RegExp(WORKSPACE.name, 'i')).first()).toBeVisible({ timeout: 12 * 60_000 });
    await capture(page, 'cover');
  });

  // ---- Console chapters (top-level, best-effort) ----
  await chapter('people-roles', async () => {
    await page.getByRole('link', { name: /People & roles/i }).click();
    await page.waitForLoadState('networkidle');
    await capture(page, 'people-roles');
  });
  await chapter('server-overview', async () => {
    await page.getByRole('link', { name: /Server overview/i }).click();
    await page.waitForLoadState('networkidle');
    await capture(page, 'server-overview');
  });
  await chapter('endpoint-access', async () => {
    await page.getByRole('link', { name: /Endpoint access/i }).click();
    await page.waitForLoadState('networkidle');
    await capture(page, 'endpoint-access');
  });
  await chapter('devices', async () => {
    await page.getByRole('link', { name: /Your devices/i }).click();
    await page.waitForLoadState('networkidle');
    await capture(page, 'devices');
  });

  // ---- Open the workspace dashboard ----
  await chapter('open-dashboard', async () => {
    await page.getByRole('link', { name: /^Workspaces$/i }).click();
    await page.getByText(new RegExp(WORKSPACE.name, 'i')).first().click();
    await page.waitForLoadState('networkidle');
    await capture(page, 'dashboard-open');
  });

  // ---- Dashboard feature chapters (best-effort; selectors refined per trace) ----
  const d: FrameOrPage = await dashboard(page);
  await chapter('description', async () => {
    await d.getByRole('button', { name: /Description/i }).first().click();
    await capture(page, 'description');
  });
  await chapter('requirements', async () => {
    await d.getByRole('button', { name: /Requirements/i }).first().click();
    await capture(page, 'requirements');
  });
  await chapter('sync-deploy', async () => {
    await d.getByRole('button', { name: /Sync & Deploy/i }).first().click();
    await capture(page, 'sync-deploy');
    await d.getByRole('button', { name: /checks/i }).first().click();
    await capture(page, 'checks-cve');
  });
  await chapter('deployments', async () => {
    await d.getByRole('button', { name: /Deployments/i }).first().click();
    await capture(page, 'deployments-prod');
    for (const [section, slot] of [['supply', 'supply-chain'], ['secrets', 'secrets'], ['backups', 'backups'], ['history', 'history'], ['firewall', 'firewall'], ['recovery', 'dr-rehearse']] as const) {
      await chapter(slot, async () => {
        await d.getByRole('button', { name: new RegExp(`^${section}$`, 'i') }).first().click();
        await capture(page, slot);
      });
    }
  });

  // eslint-disable-next-line no-console
  console.log(`\n=== walkthrough summary: company=${COMPANY.short}, incomplete chapters=${misses.length} ===`);
  misses.forEach((m) => console.log('  · ' + m));
});
