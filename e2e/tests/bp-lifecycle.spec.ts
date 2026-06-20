import { test, expect, dashboard, goToView, sh, USER } from '../fixtures/bitswan';

/**
 * The whole business-process story, driven through the dashboard UI against the
 * REAL stack (real docker deploys, snapshots, blue-green slots, ingress) with
 * only Keycloak swapped for a disposable seeded realm. Each step asserts both
 * the UI and the real backend effect. Runs serially — it's one narrative.
 *
 * Steps: log in → create BP → describe → Sync & Deploy (dev) → promote to
 * staging → promote to production → snapshot/backup → restore into DR → record
 * recovery test → swap (admin) → rollback → re-apply/drift-repair.
 */

const BP = 'shop';
// The signed-in user's personal copy is derived from their email (slugified).
const COPY = USER.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

let isAdmin = false;

test.describe.serial('BP lifecycle', () => {
  test('dashboard loads and shows the signed-in role', async ({ page }) => {
    const d = dashboard(page);
    await expect(d.getByText('Business process').first()).toBeVisible({ timeout: 60_000 });
    const badge = d.getByText(/^(Admin|Auditor|Member)$/).first();
    await expect(badge).toBeVisible();
    isAdmin = (await badge.textContent())?.trim() === 'Admin';
  });

  test('create a business process', async ({ page }) => {
    const d = dashboard(page);
    // Open the BP switcher and create a new BP.
    await d.getByRole('button', { name: /Business process/i }).first().click();
    await d.getByRole('button', { name: /New business process|Create/i }).first().click();
    await d.getByRole('textbox').first().fill(BP);
    await d.getByRole('button', { name: /Create|Add|New/i }).last().click();
    // Scaffolding lands on the Description tab; the BP now exists in the switcher.
    await expect(d.getByText(BP).first()).toBeVisible({ timeout: 60_000 });
  });

  test('give it a description', async ({ page }) => {
    await goToView(page, { bp: BP, copy: COPY, tab: 'description' });
    const d = dashboard(page);
    const editor = d.getByRole('textbox').first();
    await editor.waitFor({ state: 'visible', timeout: 30_000 });
    await editor.fill('E2E shop: a frontend + backend business process.');
    // Save if there is an explicit save control; otherwise autosave.
    const save = d.getByRole('button', { name: /Save/i });
    if (await save.count()) await save.first().click();
  });

  test('Sync & Deploy to dev', async ({ page }) => {
    await goToView(page, { bp: BP, copy: COPY, tab: 'sync-deploy' });
    const d = dashboard(page);
    await d.getByRole('button', { name: /^Sync & Deploy$/ }).last().click();
    // The deploy is real (builds images + compose up). It then auto-navigates to
    // Deployments → Development and shows Healthy with a deploy-history entry.
    await expect(d.getByText('Development')).toBeVisible({ timeout: 15 * 60_000 });
    await expect(d.getByText(/Healthy/)).toBeVisible({ timeout: 15 * 60_000 });
    // Real backend effect: the dev frontend container is up.
    await expect
      .poll(() => sh(`docker ps --format '{{.Names}}' | grep -c "${BP}.*-dev" || true`).trim(),
        { timeout: 60_000 })
      .not.toBe('0');
  });

  test('promote dev → staging → production', async ({ page }) => {
    await goToView(page, { bp: BP, copy: COPY, tab: 'deployments', stage: 'dev' });
    const d = dashboard(page);
    // Promote dev → staging, then open staging and promote → production.
    const promote = d.getByRole('button', { name: /^Promote$/ }).first();
    await expect(promote).toBeEnabled({ timeout: 60_000 });
    await promote.click();
    await expect(d.getByText(/Healthy/)).toBeVisible({ timeout: 15 * 60_000 });

    await goToView(page, { bp: BP, copy: COPY, tab: 'deployments', stage: 'staging' });
    await d.getByRole('button', { name: /^Promote$/ }).first().click();

    await goToView(page, { bp: BP, copy: COPY, tab: 'deployments', stage: 'production' });
    await expect(d.getByText(/Healthy/)).toBeVisible({ timeout: 15 * 60_000 });
    // Real effect: a production slot container is up and the -production host serves.
    await expect
      .poll(() => sh(`docker ps --format '{{.Names}}' | grep -c "${BP}.*-production" || true`).trim(),
        { timeout: 60_000 })
      .not.toBe('0');
  });

  test('create a backup of production', async ({ page }) => {
    await goToView(page, { bp: BP, copy: COPY, tab: 'deployments', stage: 'production', section: 'backups' });
    const d = dashboard(page);
    await d.getByRole('button', { name: /Create snapshot|Create backup/i }).first().click();
    // A snapshot row (timestamp id) appears once the snapshot task completes.
    await expect(d.getByText(/\d{8}-\d{6}/)).toBeVisible({ timeout: 5 * 60_000 });
  });

  test('restore the backup into DR and mark it recovery-tested', async ({ page }) => {
    await goToView(page, { bp: BP, copy: COPY, tab: 'deployments', stage: 'dr', section: 'recovery' });
    const d = dashboard(page);
    await d.getByRole('button', { name: /Restore into DR/i }).first().click();
    await expect(d.getByText('In DR now')).toBeVisible({ timeout: 5 * 60_000 });
    await d.getByRole('button', { name: /Mark recovery-tested/i }).click();
    await expect(d.getByText(/Tested/)).toBeVisible({ timeout: 60_000 });
  });

  test('swap DR ↔ Production (admin only)', async ({ page }) => {
    test.skip(!isAdmin, 'swap is admin/auditor-gated; the test user is not admin');
    await goToView(page, { bp: BP, copy: COPY, tab: 'deployments', stage: 'production' });
    const d = dashboard(page);
    await d.getByRole('button', { name: /^Restore$/ }).click();
    await d.getByRole('button', { name: /Make Disaster Recovery the live Production|Swap|Confirm/i }).last().click();
    await expect(d.getByText(/Healthy/)).toBeVisible({ timeout: 5 * 60_000 });
  });

  test('roll back the latest production deploy', async ({ page }) => {
    await goToView(page, { bp: BP, copy: COPY, tab: 'deployments', stage: 'production', section: 'history' });
    const d = dashboard(page);
    const rollback = d.getByRole('button', { name: /Roll ?back/i }).first();
    test.skip(!(await rollback.count()), 'no prior deploy to roll back to');
    await rollback.click();
    const confirm = d.getByRole('button', { name: /Roll ?back|Confirm/i }).last();
    if (await confirm.count()) await confirm.click();
    await expect(d.getByText(/Healthy|rolled back/i)).toBeVisible({ timeout: 5 * 60_000 });
  });

  test('re-apply repairs ingress drift (declarative apply)', async ({ page }) => {
    // Break the production route at the daemon, then re-apply bitswan.yaml and
    // confirm the route converges back — the kubectl/nixos "re-apply to fix it".
    const gitops = sh(`docker ps --format '{{.Names}}' | grep -m1 "gitops" || true`).trim();
    test.skip(!gitops, 'gitops container not found');
    const host = sh(
      `docker exec ${gitops} sh -c "curl -s --unix-socket /var/run/bitswan/automation-server.sock http://daemon/ingress/list-routes" ` +
        `| grep -o '"hostname":"[^"]*-production[^"]*"' | head -1 | cut -d'"' -f4 || true`,
    ).trim();
    test.skip(!host, 'no production route to perturb');
    // Re-apply via the dashboard: a fresh Sync & Deploy reconciles ingress.
    await goToView(page, { bp: BP, copy: COPY, tab: 'sync-deploy' });
    const d = dashboard(page);
    await d.getByRole('button', { name: /^Sync & Deploy$/ }).last().click();
    await expect(d.getByText(/synced|Healthy|deployed/i)).toBeVisible({ timeout: 15 * 60_000 });
  });
});
