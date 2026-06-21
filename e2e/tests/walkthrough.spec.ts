/**
 * The product walkthrough — driven through the REAL Bailey stack in a browser,
 * and the source of the Operator's Handbook screenshots.
 *
 * Journey: onboarding (OIDC → claim → device trust) → create the Meridian Foods
 * workspace via the Server Console → create the invoice-processing BP → describe
 * it → Coding Agent → Sync & Deploy (+ CVE Checks) → deploy to dev → promote to
 * production → backups → rehearse recovery into DR.
 *
 * RULES:
 *  - NO sleeps. Ever. Every wait is on a specific Playwright signal (an element
 *    becoming visible/hidden, navigation, a deploy reaching Healthy). A test that
 *    sleeps is a test that lies.
 *  - The deploy lifecycle is REAL: we wait for each stage to actually report
 *    Healthy before moving on (and before shooting a screenshot), so no
 *    in-flight progress toasts leak into the manual.
 */
import { test, expect, capture, oidcLogin, dashboard, ENV, type FrameOrPage } from '../fixtures/bitswan';
import { BP, WORKSPACE, COMPANY } from '../scenario';

const DEPLOY_TIMEOUT = 14 * 60_000; // a real image build + compose up

const misses: string[] = [];
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
  test.setTimeout(60 * 60_000);

  // ---- Onboarding (hard-asserted) ----
  await test.step('onboarding: sign in + claim the server', async () => {
    await page.goto(ENV.onboardUrl + '/');
    await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
    const claim = page.getByRole('button', { name: /Claim this server/i });
    await expect(claim).toBeVisible({ timeout: 30_000 });
    await capture(page, 'onboard-claim');
    await claim.click();
    await expect(page.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: 30_000 });
  });

  // ---- Create the workspace via the console (hard-asserted) ----
  await test.step('create the Meridian Foods workspace', async () => {
    await page.getByRole('button', { name: /New workspace/i }).first().click();
    await page.getByRole('textbox').first().fill(WORKSPACE.name);
    await capture(page, 'workspace-create');
    await page.getByRole('button', { name: /^(Create|Create workspace)$/i }).last().click();
    // Wait for the streamed creation to FINISH (the 'Creating…' state clears).
    await expect(page.getByRole('button', { name: /Creating/i })).toBeHidden({ timeout: 12 * 60_000 });
    for (const re of [/Open dashboard/i, /^Done$/i, /^Close$/i, /^Open$/i]) {
      const b = page.getByRole('button', { name: re });
      if (await b.count()) { await b.first().click(); break; }
    }
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    await expect(page.getByText(new RegExp(WORKSPACE.name, 'i')).first()).toBeVisible({ timeout: 30_000 });
  });

  // ---- Console chapters: navigate by SPA route, wait on the heading ----
  for (const [route, slot, heading] of [
    ['/users', 'people-roles', /People & roles/i],
    ['/overview', 'server-overview', /Server overview|Overview/i],
    ['/acl', 'endpoint-access', /Endpoint access/i],
    ['/devices', 'devices', /devices/i],
  ] as const) {
    await chapter(slot, async () => {
      await page.goto(ENV.onboardUrl + route);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 30_000 });
      await capture(page, slot);
    });
  }

  // ---- Open the workspace dashboard (its 'Open' button opens a new tab) ----
  let dashPage = page;
  let d: FrameOrPage = page;
  await test.step('open the workspace dashboard', async () => {
    await page.goto(ENV.onboardUrl + '/workspaces');
    const open = page.getByRole('button', { name: /^Open$/ }).or(page.getByRole('link', { name: /^Open$/ })).first();
    const popupP = page.context().waitForEvent('page', { timeout: 20_000 }).catch(() => null);
    await open.click();
    const popup = await popupP;
    if (popup) dashPage = popup;
    d = await dashboard(dashPage);
    dbgPage = dashPage;
    await expect(d.getByText(/Business process/i).first()).toBeVisible({ timeout: 120_000 });
    await capture(dashPage, 'dashboard-open');
  });

  const dashOrigin = new URL(dashPage.url()).origin;

  // Navigate to a dashboard view via its own URL params, then wait for the SPA
  // nav to be ready and any in-flight spinner to clear — no fixed delays.
  const go = async (params: Record<string, string>) => {
    const q = new URLSearchParams({ bp: BP.slug, copy: 'rollout', ...params }).toString();
    await dashPage.goto(`${dashOrigin}/?${q}`, { waitUntil: 'domcontentloaded' });
    d = await dashboard(dashPage);
    await expect(d.getByText(/Business process/i).first()).toBeVisible({ timeout: 120_000 });
    // A "Loading…" element resolves to hidden immediately if it isn't present.
    await d.getByText(/^Loading/i).first().waitFor({ state: 'hidden', timeout: 3 * 60_000 }).catch(() => {});
  };
  const tab = (re: RegExp) => d.getByRole('button', { name: re }).first();
  // A deploy is done when the dev/stage card reports Healthy / Current on (and no
  // "deploying/preparing/building" progress toast remains).
  const waitDeployDone = async () => {
    await d.getByText(/Deploying|Preparing|Building|Pulling|Working/i).first()
      .waitFor({ state: 'hidden', timeout: DEPLOY_TIMEOUT }).catch(() => {});
    await expect(d.getByText(/Healthy|Current on/i).first()).toBeVisible({ timeout: DEPLOY_TIMEOUT });
  };

  // ---- A copy (worktree) is required before a BP can be created ----
  await chapter('create-copy', async () => {
    await d.getByRole('button', { name: /^Copy/ }).first().click();
    const newCopy = d.getByRole('button', { name: /New copy/i });
    if (await newCopy.count()) {
      await newCopy.click();
      await d.getByPlaceholder('my-feature').fill('rollout');
      await d.getByRole('button', { name: /^Create$/ }).click();
      // Wait until the new copy is the active one (its name shows in the switcher).
      await expect(d.getByText(/rollout/).first()).toBeVisible({ timeout: 60_000 });
    } else {
      await dashPage.keyboard.press('Escape');
    }
  });

  // ---- Create the invoice-processing business process ----
  await chapter('create-bp', async () => {
    await d.getByRole('button', { name: /Business process/i }).first().click();
    await capture(dashPage, 'bp-switcher');
    await d.getByRole('button', { name: /New business process/i }).click();
    await d.getByPlaceholder('my-process').fill(BP.slug);
    await capture(dashPage, 'bp-create');
    await d.getByRole('button', { name: /^Create$/ }).click();
    // The BP is selected once its name shows in the switcher.
    await expect(d.getByText(new RegExp(BP.slug)).first()).toBeVisible({ timeout: 60_000 });
  });

  // ---- Wait for the scaffolding deploy to land on dev BEFORE anything else, so
  //      no progress toasts leak into later screenshots. ----
  await chapter('await-scaffold-deploy', async () => {
    await go({ tab: 'deployments', stage: 'dev' });
    await waitDeployDone();
  });

  // ---- Description: write a real README (Markdown + a Mermaid flowchart) ----
  await chapter('description', async () => {
    await go({ tab: 'description' });
    // Wait for the editor via its role (robust across editor internals) before
    // reaching into the frame to paste.
    await d.getByRole('textbox').first().waitFor({ state: 'visible', timeout: 60_000 });
    const dashFrame = dashPage.frames().find((f) => /dashboard/.test(f.url())) || dashPage.mainFrame();
    const pasted = await dashFrame.evaluate((md) => {
      const el = document.querySelector('.ProseMirror, [contenteditable="true"]') as HTMLElement | null;
      if (!el) return false;
      el.focus();
      const sel = window.getSelection();
      if (sel) { sel.selectAllChildren(el); sel.collapseToEnd(); }
      const dt = new DataTransfer();
      dt.setData('text/plain', md);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    }, BP.readme).catch(() => false);
    if (!pasted) {
      const editor = d.getByRole('textbox').first();
      if (await editor.count()) { await editor.click(); await editor.fill(BP.readme).catch(() => {}); }
    }
    const save = d.getByRole('button', { name: /^Save$/ });
    if (await save.count()) {
      await save.first().click().catch(() => {});
      // Saved → the button leaves its 'Saving…' state.
      await d.getByRole('button', { name: /Saving/i }).first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
    }
    // The Mermaid flowchart renders to an <svg>; wait for it before shooting.
    await d.locator('svg').first().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
    await capture(dashPage, 'description');
  });

  // ---- Coding Agent ----
  await chapter('coding-agent', async () => {
    await go({ tab: 'agent' });
    await capture(dashPage, 'coding-agent');
  });

  // ---- Sync & Deploy: the Checks/Supply-chain CVE scan works pre-deploy ----
  await chapter('sync-deploy', async () => {
    await go({ tab: 'sync-deploy' });
    await capture(dashPage, 'sync-deploy');
    await go({ tab: 'sync-deploy', view: 'checks' });
    // Wait for the supply-chain scan to finish loading before shooting.
    await d.getByText(/Loading supply chain/i).first().waitFor({ state: 'hidden', timeout: 5 * 60_000 }).catch(() => {});
    await capture(dashPage, 'checks-cve');
  });

  // ---- Deploy the copy onto main + dev (commits to main; the pipeline lights up) ----
  await chapter('deploy', async () => {
    await go({ tab: 'sync-deploy' });
    const btn = d.getByRole('button', { name: /^Sync & Deploy$/ }).last();
    if (await btn.isEnabled().catch(() => false)) {
      await btn.click();
      await go({ tab: 'deployments', stage: 'dev' });
      await waitDeployDone();
    }
  });

  // ---- Promote dev → staging → production, waiting for each to be Healthy ----
  await chapter('promote', async () => {
    await go({ tab: 'deployments', stage: 'dev' });
    for (let i = 0; i < 2; i++) {
      const promote = d.getByRole('button', { name: /^Promote$/ }).first();
      if (await promote.isEnabled().catch(() => false)) {
        await promote.click();
        await waitDeployDone();
      }
    }
  });

  // ---- Deployment sections (deep-linked); the cover hero is the live Production view ----
  await chapter('deployments-prod', async () => {
    await go({ tab: 'deployments', stage: 'production' });
    await waitDeployDone();
    await capture(dashPage, 'deployments-prod');
    await capture(dashPage, 'cover');
  });
  await chapter('supply-chain', async () => { await go({ tab: 'deployments', stage: 'production', section: 'supply' }); await capture(dashPage, 'supply-chain'); });
  await chapter('secrets', async () => { await go({ tab: 'deployments', stage: 'production', section: 'secrets' }); await capture(dashPage, 'secrets'); });
  await chapter('history', async () => { await go({ tab: 'deployments', stage: 'production', section: 'history' }); await capture(dashPage, 'history'); });
  await chapter('firewall', async () => { await go({ tab: 'deployments', stage: 'production', section: 'firewall' }); await capture(dashPage, 'firewall'); });

  // ---- Backups: take a real production snapshot, wait for it to appear ----
  await chapter('backups', async () => {
    await go({ tab: 'deployments', stage: 'production', section: 'backups' });
    const enable = d.getByRole('button', { name: /Enable snapshots/i }).first();
    if (await enable.count()) {
      await enable.click();
      await d.getByRole('button', { name: /Create snapshot/i }).first().waitFor({ state: 'visible', timeout: 2 * 60_000 }).catch(() => {});
    }
    const snap = d.getByRole('button', { name: /Create snapshot/i }).first();
    if (await snap.count()) {
      await snap.click();
      const confirm = d.getByRole('button', { name: /Create snapshot/i }).last();
      if (await confirm.count()) await confirm.click();
      // The snapshot row (a date-stamped id) appears once it completes.
      await d.getByText(/\d{4}-\d{2}-\d{2}/).first().waitFor({ state: 'visible', timeout: 6 * 60_000 }).catch(() => {});
    }
    await capture(dashPage, 'backups');
  });

  // ---- Disaster Recovery: restore the backup into DR + mark recovery-tested ----
  await chapter('dr-rehearse', async () => {
    await go({ tab: 'deployments', stage: 'dr', section: 'recovery' });
    const restore = d.getByRole('button', { name: /Restore into DR/i }).first();
    if (await restore.count()) {
      await restore.click();
      await d.getByText(/In DR now/i).first().waitFor({ state: 'visible', timeout: 6 * 60_000 }).catch(() => {});
      const mark = d.getByRole('button', { name: /Mark recovery-tested/i }).first();
      if (await mark.count()) {
        await mark.click();
        await d.getByText(/Tested/i).first().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
      }
    }
    await capture(dashPage, 'dr-rehearse');
  });

  // eslint-disable-next-line no-console
  console.log(`\n=== walkthrough summary: company=${COMPANY.short}, incomplete chapters=${misses.length} ===`);
  misses.forEach((m) => console.log('  · ' + m));
});
