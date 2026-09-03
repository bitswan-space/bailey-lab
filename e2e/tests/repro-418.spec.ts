/**
 * Reproduction for issue #418 — "docker compose up failed when creating a new
 * bp on bailey-demo2".
 *
 * The failure on bailey-demo2 was NOT in a hand-driven Deploy: it was the
 * auto-setup deploy the server kicks off as part of creating the business
 * process (NewBusinessProcessDialog watches that task and renders
 * "Setting up <bp>…" → "<bp> ready" / "Failed to set up <bp>: …"). The user saw
 *
 *   Failed to set up bitswan.ai: driver apply failed: docker compose up failed: exit status 1
 *
 * and the gitops log has the matching traceback (deploy_source_set →
 * apply_compose_for_deployments → infra_driver.deploy). So this spec drives the
 * shortest real path to that moment — sign in, claim, create a workspace,
 * create a BP — and asserts the setup deploy actually succeeds.
 *
 * Unlike the walkthrough (which tolerates the toast either way so it can keep
 * shooting the manual), the assertion here is the point: a "Failed to set up"
 * toast fails the test, and the failure message carries the driver's own words.
 *
 * E2E_REPRO_WORKSPACES=n creates n workspaces, each with its own BP, in one
 * run. bailey-demo2 already had a workspace (fakturacniproces) and a coding
 * agent (petr-test) up for 22h when 'website' failed, so if the first BP is
 * fine, a second workspace on the same daemon is the next thing to try.
 */
import { test, expect, ENV, oidcLogin, dashboard, capture, sh, type FrameOrPage } from '../fixtures/bitswan';

const SLA = 60_000;
// The setup deploy builds the frontend/backend images and brings the project
// up. Slow, but it must not go silent — the toast is the progress surface.
const SETUP_TIMEOUT = 12 * 60_000;

// Names taken from the issue: the workspace is `website`, the BP `bitswan.ai`
// (slug bitswan-ai) — the dot is kept because that is the name that failed.
// E2E_REPRO_TAG makes both unique so a second run on the SAME server creates a
// genuinely new BP (and therefore a genuine setup deploy) instead of selecting
// the one a previous run left behind.
const WORKSPACES = Number(process.env.E2E_REPRO_WORKSPACES || 1);
const TAG = process.env.E2E_REPRO_TAG || '';
const wsName = (i: number) => `website${TAG ? '-' + TAG : ''}${i === 0 ? '' : `-${i + 1}`}`;
const bpTitle = (i: number) => `bitswan${TAG ? '-' + TAG : ''}${i === 0 ? '' : `-${i + 1}`}.ai`;

test('issue #418: creating a BP runs its setup deploy without a compose failure', async ({ page, context }) => {
  test.setTimeout((10 + WORKSPACES * 20) * 60_000);

  const c = page.frameLocator('iframe').last();

  await test.step('sign in + claim the server', async () => {
    await page.goto(ENV.onboardUrl + '/');
    await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
    const claimPage = page.getByRole('button', { name: /Claim this server/i });
    const claimFrame = c.getByRole('button', { name: /Claim this server/i });
    await Promise.race([
      claimPage.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      claimFrame.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      c.getByRole('heading', { name: /Workspaces/i }).waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
    ]);
    const claim = (await claimPage.isVisible().catch(() => false))
      ? claimPage
      : (await claimFrame.isVisible().catch(() => false))
        ? claimFrame
        : null;
    if (claim) await claim.click();
    // A re-run on an already-claimed server arrives in a FRESH browser profile,
    // so the gate sees an untrusted device and parks us on "Trust this device"
    // with a 6-digit code. That is the product working as designed; approve the
    // code the way an operator with shell access would, so the repro harness is
    // re-runnable instead of one-shot.
    await approveDeviceIfAsked(page);
    await expect(c.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: SLA });
  });

  for (let i = 0; i < WORKSPACES; i++) {
    const ws = wsName(i);
    const bp = bpTitle(i);

    await test.step(`create the ${ws} workspace`, async () => {
      await c.getByRole('button', { name: /Workspaces/i }).first().click();
      await expect(c.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: SLA });
      const existing = c.getByText(new RegExp(`^${ws}$`)).first();
      const empty = c.getByText(/not in any workspace/i).first();
      await Promise.race([
        existing.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
        empty.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      ]);
      if (await existing.isVisible().catch(() => false)) return; // a previous run made it

      await c.getByRole('button', { name: /New workspace/i }).first().click();
      const nameInput = c.getByPlaceholder(/payroll-automation/i).first();
      await nameInput.waitFor({ state: 'visible', timeout: SLA });
      await nameInput.fill(ws);
      await c.getByRole('button', { name: /^Create workspace$/i }).click();

      // Cold-starting a workspace's container stack legitimately runs long; the
      // requirement is that the live log keeps moving.
      const created = c.getByText(new RegExp(`^${ws}$`)).first();
      const already = c.getByText(/already initialized/i).first();
      const logBox = c.getByTestId('ws-create-log');
      let lastLog = '';
      let lastChange = Date.now();
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        if (await created.isVisible().catch(() => false)) break;
        if (await already.isVisible().catch(() => false)) {
          await c.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {});
          break;
        }
        const text = (await logBox.textContent().catch(() => '')) || '';
        const now = Date.now();
        if (text !== lastLog) {
          lastLog = text;
          lastChange = now;
        } else if (now - lastChange > 120_000) {
          throw new Error(`workspace creation went dark: no log progress for >120s\nlast log:\n${text}`);
        }
        if (now > deadline) throw new Error(`workspace ${ws} was not created within 10m\nlast log:\n${text}`);
        await page.waitForTimeout(1000);
      }
    });

    // Each workspace dashboard opens in its own tab.
    let dashPage = page;
    let d: FrameOrPage = page;

    await test.step(`open the ${ws} dashboard`, async () => {
      await c.getByRole('button', { name: /Workspaces/i }).first().click();
      await expect(c.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: SLA });
      // The row for THIS workspace — its own Open button, not another card's.
      const row = c
        .locator('div')
        .filter({ has: c.getByText(new RegExp(`^${ws}$`)) })
        .filter({ has: c.getByRole('button', { name: /^Open$/ }) })
        .last();
      const open = row.getByRole('button', { name: /^Open$/ }).first();
      const bpSwitcher = () => d.getByRole('button', { name: /^Process\b/ }).first();
      let ready = false;
      for (let attempt = 0; attempt < 4 && !ready; attempt++) {
        const popupP = context.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
        await open.click();
        const popup = await popupP;
        if (popup) dashPage = popup;
        d = await dashboard(dashPage);
        ready = await bpSwitcher()
          .waitFor({ state: 'visible', timeout: SLA })
          .then(() => true)
          .catch(() => false);
      }
      expect(ready, `the ${ws} dashboard never rendered the BP switcher`).toBe(true);
      await d.getByText(/Loading business processes/i).first()
        .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    });

    await test.step(`create the ${bp} business process`, async () => {
      const selected = d.getByRole('button', { name: new RegExp(`^Process\\b.*${escapeRe(bp)}`) }).first();
      // A BP that is already there was created by an earlier run, so no setup
      // deploy would be kicked off and there would be nothing to assert. Say so
      // instead of passing vacuously.
      if (await selected.isVisible().catch(() => false)) {
        throw new Error(
          `"${bp}" already exists in "${ws}" — its setup deploy already ran, so this run would assert nothing. ` +
            `Re-run with a fresh E2E_REPRO_TAG (e.g. E2E_REPRO_TAG=r2) to create new names.`,
        );
      }
      const dlg = d.getByRole('dialog');
      const nameInput = dlg.getByLabel(/^Name$/).first();
      // The personal copy is created in the background on first visit; until it
      // lands, create fails — so retry the whole open→fill→Create sequence, the
      // way the walkthrough does.
      await expect(async () => {
        if (await selected.isVisible().catch(() => false)) return;
        if (!(await nameInput.isVisible().catch(() => false))) {
          const newBtn = d.getByRole('button', { name: /New business process/i }).first();
          if (!(await newBtn.isVisible().catch(() => false))) {
            await d.getByRole('button', { name: /^Process\b/ }).first().click({ timeout: 2_000 });
          }
          await newBtn.click({ timeout: 2_000 });
        }
        await expect(nameInput).toBeVisible({ timeout: 2_000 });
        await nameInput.fill(bp);
        await dlg.getByRole('button', { name: /^Create$/ }).first().click({ timeout: 2_000 });
        await expect(selected).toBeVisible({ timeout: 8_000 });
      }).toPass({ timeout: 3 * 60_000, intervals: [300, 500, 1000, 2000] });
    });

    await test.step(`${bp}: the setup deploy succeeds`, async () => {
      // This is the moment from the issue. The create response carries a
      // deploy_task_id and the dialog watches it: "Setting up <bp>…" resolves to
      // "<bp> ready", or to "Failed to set up <bp>: <driver error>".
      const ready = d.getByText(new RegExp(`${escapeRe(bp)} ready`, 'i')).first();
      const failed = d.getByText(new RegExp(`Failed to set up ${escapeRe(bp)}`, 'i')).first();
      const settingUp = d.getByText(new RegExp(`Setting up ${escapeRe(bp)}`, 'i')).first();
      await Promise.race([
        ready.waitFor({ state: 'visible', timeout: SETUP_TIMEOUT }).catch(() => {}),
        failed.waitFor({ state: 'visible', timeout: SETUP_TIMEOUT }).catch(() => {}),
        settingUp.waitFor({ state: 'hidden', timeout: SETUP_TIMEOUT }).catch(() => {}),
      ]);

      if (await failed.isVisible().catch(() => false)) {
        const toastText = ((await failed.textContent().catch(() => '')) || '').trim();
        // The toast truncates the driver's output; the Activity feed keeps the
        // whole progress log, so expand the failed entry and report that too —
        // the compose output is what makes this diagnosable.
        const activity = await activityDetail(d, bp);
        await capture(dashPage, `repro-418-${slugish(bp)}-failed`).catch(() => {});
        throw new Error(
          `#418 reproduced: the setup deploy of "${bp}" in workspace "${ws}" failed.\n` +
            `toast: ${toastText}\n` +
            (activity ? `activity log:\n${activity}\n` : ''),
        );
      }
      await expect(ready, `the setup deploy of "${bp}" never reported ready`).toBeVisible({ timeout: SLA });
      await capture(dashPage, `repro-418-${slugish(bp)}-ready`).catch(() => {});
    });
  }
});

/**
 * If the gate parked us on "Trust this device", read the 6-digit code off the
 * page and approve it through the daemon's own CLI
 * (`bitswan bailey devices approve <code>`), then wait to be let through. A
 * no-op when the device is already trusted.
 */
async function approveDeviceIfAsked(page: import('@playwright/test').Page): Promise<void> {
  const trust = page.getByRole('heading', { name: /Trust this device/i }).first();
  if (!(await trust.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false))) return;
  const body = (await page.locator('body').textContent()) || '';
  const code = body.match(/Your code\s*(\d{6})/)?.[1] ?? body.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`device trust was requested but no 6-digit code was on the page:\n${body.slice(0, 800)}`);
  // eslint-disable-next-line no-console
  console.log(`  approving device-trust code ${code} via the daemon CLI`);
  sh(`docker exec bitswan-automation-server-daemon bitswan bailey devices approve ${code}`);
  await trust.waitFor({ state: 'hidden', timeout: 2 * 60_000 });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugish(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Expand the failed entry in the Activity panel and return its text, so the
 * failure carries the driver's streamed progress (including the compose output)
 * and not just the one-line toast.
 */
async function activityDetail(d: FrameOrPage, bp: string): Promise<string> {
  try {
    const row = d.getByText(new RegExp(`Failed to set up ${escapeRe(bp)}`, 'i')).last();
    if (!(await row.isVisible().catch(() => false))) return '';
    await row.click({ timeout: 5_000 }).catch(() => {});
    const panel = d
      .locator('div')
      .filter({ has: d.getByText(/^Activity/) })
      .last();
    return ((await panel.textContent().catch(() => '')) || '').trim().slice(0, 4000);
  } catch {
    return '';
  }
}
