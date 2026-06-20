/**
 * The product walkthrough — driven through the REAL Bailey stack in a browser.
 *
 * It performs the genuine operator journey and screenshots each beat into the
 * manual's slots: onboarding (OIDC → claim → device trust) → create the Meridian
 * Foods workspace through the Server Console UI → open its dashboard → walk the
 * features. The screenshots are the raw material the manual is written from, so
 * the critical path is hard-asserted; breadth captures are attempted and any
 * miss is logged loudly + summarized (so a single off selector doesn't cost us
 * every later screenshot while we stabilize the suite against real traces).
 */
import { test, expect, capture, oidcLogin, consoleFrame, dashboard, ENV } from '../fixtures/bitswan';
import { BP, WORKSPACE, COMPANY } from '../scenario';

const misses: string[] = [];

/** Attempt a breadth step; never abort the run, but record + log failures. */
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
  test.setTimeout(30 * 60_000);

  // ---- Critical path: onboarding (hard-asserted) ----
  await test.step('onboarding: sign in + claim the server', async () => {
    await page.goto(ENV.onboardUrl + '/');
    // oauth2-proxy bounces an unauthenticated visitor to Keycloak.
    await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
    // Back on the onboarding host: the bootstrap scene offers to claim the server.
    const claim = page.getByRole('button', { name: /Claim this server/i });
    await expect(claim).toBeVisible({ timeout: 30_000 });
    await capture(page, 'onboard-claim');
    await claim.click();
    // After the claim, the device is trusted and we are bounced to the console.
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/bailey\./, { timeout: 30_000 });
  });

  // ---- Cover + workspace creation (hard-asserted) ----
  await test.step('create the Meridian Foods workspace via the console', async () => {
    await page.goto(ENV.baileyUrl + '/');
    await page.waitForLoadState('networkidle');
    const c = consoleFrame(page);
    await expect(c.getByText(/Workspaces/i).first()).toBeVisible({ timeout: 30_000 });
    await capture(page, 'cover'); // the console, freshly claimed

    await c.getByRole('button', { name: /Create workspace|New workspace/i }).first().click();
    await c.getByRole('textbox').first().fill(WORKSPACE.name);
    await capture(page, 'workspace-create');
    await c.getByRole('button', { name: /^(Create|Create workspace)$/i }).last().click();
    // Creation streams progress; wait until the workspace is listed/active.
    await expect(c.getByText(new RegExp(WORKSPACE.name, 'i')).first()).toBeVisible({ timeout: 10 * 60_000 });
  });

  // ---- Open the workspace dashboard (hard-asserted) ----
  await test.step('open the workspace dashboard', async () => {
    const c = consoleFrame(page);
    await c.getByText(new RegExp(WORKSPACE.name, 'i')).first().click();
    await page.waitForLoadState('networkidle');
    const d = dashboard(page);
    await expect(d.getByText(/Business process|Description/i).first()).toBeVisible({ timeout: 60_000 });
  });

  // ---- Breadth: walk the features, capturing each slot ----
  // These selectors are first drafts against the documented UI; they will be
  // tightened once CI produces real traces. Each is best-effort + logged.
  await chapter('description', async () => {
    const d = dashboard(page);
    await d.getByRole('button', { name: new RegExp(BP.title, 'i') }).first().click().catch(() => {});
    await capture(page, 'description');
  });

  await chapter('requirements', async () => {
    const d = dashboard(page);
    await d.getByRole('button', { name: /Requirements/i }).first().click();
    await capture(page, 'requirements');
  });

  await chapter('sync-deploy', async () => {
    const d = dashboard(page);
    await d.getByRole('button', { name: /Sync & Deploy/i }).first().click();
    await capture(page, 'sync-deploy');
    await d.getByRole('button', { name: /checks/i }).first().click().catch(() => {});
    await capture(page, 'checks-cve');
  });

  await chapter('deployments', async () => {
    const d = dashboard(page);
    await d.getByRole('button', { name: /Deployments/i }).first().click();
    await capture(page, 'deployments-prod');
    for (const [section, slot] of [['supply', 'supply-chain'], ['secrets', 'secrets'], ['backups', 'backups'], ['history', 'history'], ['firewall', 'firewall'], ['recovery', 'dr-rehearse']] as const) {
      await chapter(slot, async () => {
        await d.getByRole('button', { name: new RegExp(`^${section}$`, 'i') }).first().click();
        await capture(page, slot);
      });
    }
  });

  await chapter('people-roles', async () => {
    await page.goto(ENV.baileyUrl + '/users');
    await page.waitForLoadState('networkidle');
    await capture(page, 'people-roles');
  });

  // eslint-disable-next-line no-console
  console.log(`\n=== walkthrough summary: company=${COMPANY.short}, incomplete chapters=${misses.length} ===`);
  misses.forEach((m) => console.log('  · ' + m));
});
