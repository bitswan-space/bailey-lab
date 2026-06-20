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
    // Creation streams an NDJSON progress log in the modal. Wait for it to FINISH
    // (the 'Creating…' state clears) — not just for the name to appear in the log.
    await expect(page.getByRole('button', { name: /Creating/i })).toBeHidden({ timeout: 12 * 60_000 });
    // Dismiss the modal via whatever terminal action it offers.
    for (const re of [/Open dashboard/i, /^Done$/i, /^Close$/i, /^Open$/i]) {
      const b = page.getByRole('button', { name: re });
      if (await b.count()) { await b.first().click(); break; }
    }
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    await expect(page.getByText(new RegExp(WORKSPACE.name, 'i')).first()).toBeVisible({ timeout: 30_000 });
    await capture(page, 'cover');
  });

  // ---- Console chapters: navigate by SPA route (robust; no sidebar clicks) ----
  for (const [route, slot] of [
    ['/users', 'people-roles'],
    ['/overview', 'server-overview'],
    ['/acl', 'endpoint-access'],
    ['/devices', 'devices'],
  ] as const) {
    await chapter(slot, async () => {
      await page.goto(ENV.onboardUrl + route);
      await page.waitForLoadState('networkidle');
      await capture(page, slot);
    });
  }

  // ---- Open the workspace dashboard (its 'Open' button likely opens a new tab) ----
  let dashPage = page;
  await chapter('open-dashboard', async () => {
    await page.goto(ENV.onboardUrl + '/workspaces');
    await page.waitForLoadState('networkidle');
    const open = page.getByRole('button', { name: /^Open$/ }).or(page.getByRole('link', { name: /^Open$/ })).first();
    const popupP = page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null);
    await open.click();
    const popup = await popupP;
    if (popup) dashPage = popup;
    await dashPage.waitForLoadState('networkidle');
    // The dashboard host may still be coming up right after creation; give it a
    // few reloads before accepting whatever's there (a real 404 will persist).
    for (let i = 0; i < 10; i++) {
      const body = (await dashPage.locator('body').textContent().catch(() => '')) || '';
      if (!/404 page not found/i.test(body)) break;
      await dashPage.waitForTimeout(6_000);
      await dashPage.reload().catch(() => {});
      await dashPage.waitForLoadState('networkidle').catch(() => {});
    }
    await capture(dashPage, 'dashboard-open');
  });

  // ---- Dashboard feature chapters (best-effort; selectors refined per trace) ----
  const d: FrameOrPage = await dashboard(dashPage);
  await chapter('description', async () => {
    await d.getByRole('button', { name: /Description/i }).first().click();
    await capture(dashPage, 'description');
  });
  await chapter('requirements', async () => {
    await d.getByRole('button', { name: /Requirements/i }).first().click();
    await capture(dashPage, 'requirements');
  });
  await chapter('sync-deploy', async () => {
    await d.getByRole('button', { name: /Sync & Deploy/i }).first().click();
    await capture(dashPage, 'sync-deploy');
    await d.getByRole('button', { name: /checks/i }).first().click();
    await capture(dashPage, 'checks-cve');
  });
  await chapter('deployments', async () => {
    await d.getByRole('button', { name: /Deployments/i }).first().click();
    await capture(dashPage, 'deployments-prod');
    for (const [section, slot] of [['supply', 'supply-chain'], ['secrets', 'secrets'], ['backups', 'backups'], ['history', 'history'], ['firewall', 'firewall'], ['recovery', 'dr-rehearse']] as const) {
      await chapter(slot, async () => {
        await d.getByRole('button', { name: new RegExp(`^${section}$`, 'i') }).first().click();
        await capture(dashPage, slot);
      });
    }
  });

  // eslint-disable-next-line no-console
  console.log(`\n=== walkthrough summary: company=${COMPANY.short}, incomplete chapters=${misses.length} ===`);
  misses.forEach((m) => console.log('  · ' + m));
});
