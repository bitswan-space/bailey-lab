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
// Set once the dashboard is open, so a failed chapter still screenshots the
// blocked state (named dbg-<chapter>) for diagnosis.
let dbgPage: import('@playwright/test').Page | null = null;

async function chapter(name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    try {
      await fn();
    } catch (e) {
      misses.push(`${name}: ${(e as Error).message.split('\n')[0]}`);
      // eslint-disable-next-line no-console
      console.warn(`⚠️  chapter "${name}" incomplete — ${(e as Error).message.split('\n')[0]}`);
      if (dbgPage) await capture(dbgPage, 'dbg-' + name).catch(() => {});
    }
  });
}

test('Bailey product walkthrough → manual screenshots', async ({ page }) => {
  test.setTimeout(55 * 60_000);

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

  // ---- Open the workspace dashboard (its 'Open' button opens a new tab) ----
  // NB: the dashboard holds SSE connections, so never wait for 'networkidle' —
  // wait on real elements instead.
  let dashPage = page;
  let d: FrameOrPage = page;
  await test.step('open the workspace dashboard', async () => {
    await page.goto(ENV.onboardUrl + '/workspaces');
    const open = page.getByRole('button', { name: /^Open$/ }).or(page.getByRole('link', { name: /^Open$/ })).first();
    const popupP = page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null);
    await open.click();
    const popup = await popupP;
    if (popup) dashPage = popup;
    d = await dashboard(dashPage);
    dbgPage = dashPage;
    // Wait for the dashboard chrome to render (the BP switcher / nav).
    await expect(d.getByText(/Business process/i).first()).toBeVisible({ timeout: 120_000 });
    await capture(dashPage, 'dashboard-open');
  });

  const tab = (re: RegExp) => d.getByRole('button', { name: re }).first();
  const settle = (ms = 1200) => dashPage.waitForTimeout(ms);

  // ---- A copy (worktree) is required before a BP can be created ----
  await chapter('create-copy', async () => {
    await d.getByRole('button', { name: /^Copy/ }).first().click();
    const newCopy = d.getByRole('button', { name: /New copy/i });
    if (await newCopy.count()) {
      await newCopy.click();
      await d.getByPlaceholder('my-feature').fill('rollout');
      await d.getByRole('button', { name: /^Create$/ }).click();
      await settle(4_000);
    } else {
      await dashPage.keyboard.press('Escape');
    }
  });

  // Wait for in-flight "Loading…/Preparing…/Working…" spinners to clear.
  const waitLoaded = async () =>
    d.getByText(/Loading|Preparing|Working/i).first().waitFor({ state: 'hidden', timeout: 8 * 60_000 }).catch(() => {});
  const waitHealthy = async () =>
    d.getByText(/Healthy|Current on|Deployed/i).first().waitFor({ timeout: 8 * 60_000 }).catch(() => {});

  // ---- Create the invoice-processing business process ----
  await chapter('create-bp', async () => {
    await d.getByRole('button', { name: /Business process/i }).first().click();
    await capture(dashPage, 'bp-switcher');
    await d.getByRole('button', { name: /New business process/i }).click();
    await d.getByPlaceholder('my-process').fill(BP.slug);
    await capture(dashPage, 'bp-create');
    await d.getByRole('button', { name: /^Create$/ }).click();
    await settle(8_000);
  });

  // Deep-link straight to a Deployments stage/section via the dashboard's own
  // URL params — far more robust than clicking pipeline nodes. The dashboard is a
  // query-driven SPA (?bp=&copy=&tab=&stage=&section=).
  const dashOrigin = new URL(dashPage.url()).origin;
  const deepLink = async (params: Record<string, string>) => {
    const q = new URLSearchParams({ bp: BP.slug, copy: 'rollout', tab: 'deployments', ...params }).toString();
    await dashPage.goto(`${dashOrigin}/?${q}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    d = await dashboard(dashPage);
    await settle(2_500);
    await waitLoaded();
  };

  // Sync & Deploy commits the copy onto main and deploys dev — this is what puts
  // the BP into main so the Deployments pipeline is populated.
  const deployToMain = async () => {
    await tab(/Sync & Deploy/).click();
    await settle();
    const btn = d.getByRole('button', { name: /^Sync & Deploy$/ }).last();
    if (await btn.isEnabled().catch(() => false)) {
      await btn.click();
      await d.getByText(/Working/i).first().waitFor({ state: 'hidden', timeout: 12 * 60_000 }).catch(() => {});
      await settle(3_000);
    }
  };

  // ---- Description: write a real README (Markdown + a Mermaid flowchart) ----
  await chapter('description', async () => {
    await tab(/^Description$/).click();
    await settle(1_500);
    // Paste the Markdown into the ProseMirror editor (in the dashboard iframe) so
    // its clipboard parser renders headings, lists and the fenced ```mermaid
    // block as a diagram — rather than a literal value set.
    const dashFrame =
      dashPage.frames().find((f) => /dashboard/.test(f.url())) || dashPage.mainFrame();
    const pasted = await dashFrame.evaluate((md) => {
      const el = document.querySelector('.ProseMirror, [contenteditable="true"]');
      if (!el) return false;
      el.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      sel.collapseToEnd();
      const dt = new DataTransfer();
      dt.setData('text/plain', md);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    }, BP.readme).catch(() => false);
    if (!pasted) {
      // Fallback: type it in (still substantial, even if Mermaid stays literal).
      const editor = d.getByRole('textbox').first();
      if (await editor.count()) { await editor.click(); await editor.fill(BP.readme).catch(() => {}); }
    }
    await settle(2_500);
    const save = d.getByRole('button', { name: /^Save$/ });
    if (await save.count()) await save.first().click().catch(() => {});
    // Give Mermaid a moment to render the flowchart before shooting.
    await d.locator('svg').first().waitFor({ timeout: 30_000 }).catch(() => {});
    await settle(1_500);
    await capture(dashPage, 'description');
  });

  // ---- Coding Agent (builds the automation, inside the workspace sandbox) ----
  await chapter('coding-agent', async () => {
    await tab(/Coding Agent/).click();
    await settle(2_500);
    await capture(dashPage, 'coding-agent');
  });

  // ---- Sync & Deploy: the Checks/Supply-chain CVE scan works pre-deploy ----
  await chapter('sync-deploy', async () => {
    await tab(/Sync & Deploy/).click();
    await settle();
    await capture(dashPage, 'sync-deploy');
    const checks = d.getByRole('button', { name: /^checks$/ });
    if (await checks.count()) { await checks.click(); await waitLoaded(); await settle(2_000); await capture(dashPage, 'checks-cve'); }
  });

  // ---- Deploy the copy onto main + dev (populates the Deployments pipeline) ----
  await chapter('deploy', async () => { await deployToMain(); });

  // ---- Promote dev → staging → production ----
  await chapter('promote', async () => {
    await deepLink({ stage: 'dev' });
    await waitHealthy();
    for (let i = 0; i < 2; i++) {
      const promote = d.getByRole('button', { name: /^Promote$/ }).first();
      if (await promote.isEnabled().catch(() => false)) { await promote.click(); await waitHealthy(); await settle(2_000); }
    }
  });

  // ---- Deployment sections (deep-linked) ----
  await chapter('deployments-prod', async () => { await deepLink({ stage: 'production' }); await capture(dashPage, 'deployments-prod'); });
  await chapter('supply-chain', async () => { await deepLink({ stage: 'production', section: 'supply' }); await capture(dashPage, 'supply-chain'); });
  await chapter('secrets', async () => { await deepLink({ stage: 'production', section: 'secrets' }); await capture(dashPage, 'secrets'); });
  await chapter('history', async () => { await deepLink({ stage: 'production', section: 'history' }); await capture(dashPage, 'history'); });
  await chapter('firewall', async () => { await deepLink({ stage: 'production', section: 'firewall' }); await capture(dashPage, 'firewall'); });

  // ---- Backups: take a production snapshot ----
  await chapter('backups', async () => {
    await deepLink({ stage: 'production', section: 'backups' });
    const enable = d.getByRole('button', { name: /Enable snapshots/i }).first();
    if (await enable.count()) { await enable.click(); await waitLoaded(); await settle(2_000); }
    const snap = d.getByRole('button', { name: /Create snapshot/i }).first();
    if (await snap.count()) {
      await snap.click();
      const confirm = d.getByRole('button', { name: /Create snapshot/i }).last();
      if (await confirm.count()) await confirm.click();
      await waitLoaded();
      await d.getByText(/\d{4}-\d{2}-\d{2}/).first().waitFor({ timeout: 4 * 60_000 }).catch(() => {});
    }
    await capture(dashPage, 'backups');
  });

  // ---- Disaster Recovery: restore into DR + mark recovery-tested ----
  await chapter('dr-rehearse', async () => {
    await deepLink({ stage: 'dr', section: 'recovery' });
    const restore = d.getByRole('button', { name: /Restore into DR/i }).first();
    if (await restore.count()) {
      await restore.click();
      await d.getByText(/In DR now/i).first().waitFor({ timeout: 4 * 60_000 }).catch(() => {});
      const mark = d.getByRole('button', { name: /Mark recovery-tested/i }).first();
      if (await mark.count()) await mark.click().catch(() => {});
    }
    await capture(dashPage, 'dr-rehearse');
  });

  // eslint-disable-next-line no-console
  console.log(`\n=== walkthrough summary: company=${COMPANY.short}, incomplete chapters=${misses.length} ===`);
  misses.forEach((m) => console.log('  · ' + m));
});
