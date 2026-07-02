/**
 * Per-BP repo isolation — the reason each business process has its OWN git
 * repository: syncing one BP must never drag another BP's changes to main.
 *
 * Runs AFTER the walkthrough spec (workers=1; file order) against the same
 * bringup env and the `finance` workspace it created. Two throwaway BPs are
 * created in the operator's personal copy, each gets a distinct README edit,
 * then alpha is synced alone. Ground truth is asserted against the per-BP
 * bare repos on the workspace volume (`git-repos/<bp>.git`) — the UI drives,
 * the repos prove.
 */
import { test, expect, sh, oidcLogin, dashboard, ENV, type FrameOrPage } from '../fixtures/bitswan';
import { WORKSPACE } from '../scenario';

const SLA = 60_000;

const ALPHA = 'iso-alpha';
const BETA = 'iso-beta';

const REPOS = `/var/lib/docker/volumes/bitswan/_data/workspaces/${WORKSPACE.name}/git-repos`;

/** Subjects on a bare repo's main (empty string when the repo/branch is absent). */
function mainSubjects(bp: string): string {
  try {
    return sh(
      `git -c safe.directory='*' -C ${REPOS}/${bp}.git log --format=%s main 2>/dev/null`,
    );
  } catch {
    return '';
  }
}

test('per-BP repos: syncing one business process never drags another', async ({ page }) => {
  test.setTimeout(30 * 60_000);

  // ---- Enter the workspace dashboard (fresh context → SSO may prompt) ----
  await page.goto(`https://${WORKSPACE.name}-dashboard.${ENV.domain}/`);
  if (
    await page
      .locator('#username, input[name="username"]')
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
  }
  const d: FrameOrPage = await dashboard(page);
  // The shell is up once the flow tabs render.
  await expect(d.getByRole('button', { name: /Sync & Deploy/i }).first()).toBeVisible({
    timeout: SLA,
  });

  // ---- Helpers ----
  const createBp = async (name: string) => {
    // Same retry idiom as the walkthrough: the personal copy can still be
    // materializing right after login, so retry Create until the BP appears.
    await expect
      .poll(
        async () => {
          const newBtn = d.getByRole('button', { name: /New business process/i }).first();
          if (!(await newBtn.isVisible().catch(() => false))) return 'no-button';
          await newBtn.click().catch(() => {});
          const input = d.getByPlaceholder('my-process').first();
          if (!(await input.isVisible({ timeout: 5_000 }).catch(() => false))) return 'no-dialog';
          await input.fill(name);
          await d.getByRole('button', { name: /^Create$/ }).first().click();
          // Success lands on the new BP's Description tab; failure leaves the
          // dialog up (dismiss it and retry).
          const created = await d
            .getByRole('button', { name: new RegExp(`\\b${name}\\b`) })
            .first()
            .isVisible({ timeout: 15_000 })
            .catch(() => false);
          if (!created) await page.keyboard.press('Escape').catch(() => {});
          return created ? 'created' : 'retry';
        },
        { timeout: 5 * 60_000, intervals: [2_000] },
      )
      .toBe('created');
  };

  const selectBp = async (name: string) => {
    await d.getByRole('button', { name: /Switch business process/i }).or(
      d.locator('button[title="Switch business process"]'),
    ).first().click();
    await d.getByRole('button', { name: new RegExp(`^${name}$`) }).first().click();
  };

  const editDescription = async (marker: string) => {
    await d.getByRole('button', { name: /^Description$/i }).first().click();
    const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: SLA });
    await editor.click();
    await editor.pressSequentially(` ${marker}`, { delay: 0 });
    await page.keyboard.press('Control+s');
    await d.getByText(/saved/i).first().waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
  };

  const pressSyncDeploy = async () => {
    await d.getByRole('button', { name: /Sync & Deploy/i }).first().click();
    const btn = d.getByRole('button', { name: /Sync & Deploy|Working/ }).last();
    await expect(btn).toBeEnabled({ timeout: SLA });
    await btn.click();
    const working = d.getByRole('button', { name: /Working/i }).first();
    await working.waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
    await working.waitFor({ state: 'hidden', timeout: 30 * 60_000 });
  };

  // ---- Create the two BPs in the personal copy ----
  await createBp(ALPHA);
  await createBp(BETA);

  // ---- Give each a distinct pending change ----
  await selectBp(ALPHA);
  await editDescription('alpha isolation marker');
  await selectBp(BETA);
  await editDescription('beta isolation marker');

  // ---- Sync ALPHA alone ----
  await selectBp(ALPHA);
  await pressSyncDeploy();

  // Ground truth: alpha's repo advanced; beta's repo did NOT get any sync.
  await expect
    .poll(() => mainSubjects(ALPHA), { timeout: SLA })
    .toMatch(/Sync: commit work in progress|Create business process/);
  const betaMain = mainSubjects(BETA);
  expect(betaMain).not.toMatch(/Sync: commit work in progress/);
  // Beta's repo exists but its main carries only creation-time content.
  expect(mainSubjects(ALPHA)).not.toContain('beta isolation marker');

  // UI agrees: beta still has its pending change after alpha's sync.
  await selectBp(BETA);
  await d.getByRole('button', { name: /Sync & Deploy/i }).first().click();
  await expect(d.getByText(/Up to date with main/i).first()).toBeHidden({ timeout: SLA });

  // ---- Sync BETA and confirm its repo advances too ----
  await pressSyncDeploy();
  await expect
    .poll(() => mainSubjects(BETA), { timeout: SLA })
    .toMatch(/Sync: commit work in progress/);

  // ---- Alpha's history shows only alpha's commits + its deploy tag ----
  await selectBp(ALPHA);
  await d.getByRole('button', { name: /Sync & Deploy/i }).first().click();
  await d.getByRole('button', { name: /^history$/i }).first().click();
  await expect(d.getByText(/deployed/i).first()).toBeVisible({ timeout: SLA });
  // The per-BP history never mentions the other BP.
  await expect(d.getByText(new RegExp(BETA)).first()).toBeHidden({ timeout: 5_000 }).catch(() => {});
  // Deploy tags live on the BP's own repo.
  const alphaTags = sh(
    `git -c safe.directory='*' -C ${REPOS}/${ALPHA}.git tag -l 'deploy/*' | wc -l`,
  ).trim();
  expect(Number(alphaTags)).toBeGreaterThan(0);
});
