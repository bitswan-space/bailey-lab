import { test, expect, ENV, oidcLogin, dashboard, capture, sh, type FrameOrPage } from '../fixtures/bitswan';
import type { Page } from '@playwright/test';

const SLA = 60_000;
const SETUP_DEPLOY_TIMEOUT = 12 * 60_000;
const WORKSPACE_CREATE_TIMEOUT = 10 * 60_000;
const WORKSPACE_CREATE_LOG_STALL_LIMIT = 120_000;

const WORKSPACES_ON_ONE_DAEMON = Number(process.env.E2E_REPRO_WORKSPACES || 1);
const UNIQUE_RUN_TAG = process.env.E2E_REPRO_TAG || '';

const workspaceName = (i: number) =>
  `website${UNIQUE_RUN_TAG ? '-' + UNIQUE_RUN_TAG : ''}${i === 0 ? '' : `-${i + 1}`}`;
const businessProcessName = (i: number) =>
  `bitswan${UNIQUE_RUN_TAG ? '-' + UNIQUE_RUN_TAG : ''}${i === 0 ? '' : `-${i + 1}`}.ai`;

test('issue #418: creating a business process runs its setup deploy without a compose failure', async ({
  page,
  context,
}) => {
  test.skip(
    !process.env.E2E_REPRO_418,
    'set E2E_REPRO_418=1 to run: it creates its own workspace and business process on the server ' +
      'under test, which would show up in the walkthrough that shoots the handbook',
  );
  test.setTimeout((10 + WORKSPACES_ON_ONE_DAEMON * 25) * 60_000);

  const serverConsole = page.frameLocator('iframe').last();

  await test.step('sign in, claim the server, get the device trusted', async () => {
    await page.goto(ENV.onboardUrl + '/');
    await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
    const claimOnOnboardHost = page.getByRole('button', { name: /Claim this server/i });
    const claimInWrappedConsole = serverConsole.getByRole('button', { name: /Claim this server/i });
    await Promise.race([
      claimOnOnboardHost.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      claimInWrappedConsole.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      serverConsole
        .getByRole('heading', { name: /Workspaces/i })
        .waitFor({ state: 'visible', timeout: SLA })
        .catch(() => {}),
    ]);
    const claim = (await claimOnOnboardHost.isVisible().catch(() => false))
      ? claimOnOnboardHost
      : (await claimInWrappedConsole.isVisible().catch(() => false))
        ? claimInWrappedConsole
        : null;
    if (claim) await claim.click();
    await approveDeviceTrustThroughDaemonCliIfAsked(page);
    await expect(serverConsole.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: SLA });
  });

  for (let i = 0; i < WORKSPACES_ON_ONE_DAEMON; i++) {
    const ws = workspaceName(i);
    const bp = businessProcessName(i);

    await test.step(`create the ${ws} workspace`, async () => {
      await openWorkspacesList(serverConsole);
      const card = serverConsole.getByText(new RegExp(`^${escapeRegExp(ws)}$`)).first();
      const noWorkspacesYet = serverConsole.getByText(/not in any workspace/i).first();
      await Promise.race([
        card.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
        noWorkspacesYet.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      ]);
      if (await card.isVisible().catch(() => false)) return;

      await serverConsole.getByRole('button', { name: /New workspace/i }).first().click();
      const nameInput = serverConsole.getByPlaceholder(/payroll-automation/i).first();
      await nameInput.waitFor({ state: 'visible', timeout: SLA });
      await nameInput.fill(ws);
      await serverConsole.getByRole('button', { name: /^Create workspace$/i }).click();
      await waitForWorkspaceWhileItsCreateLogKeepsMoving(page, serverConsole, ws);
    });

    let dashPage = page;
    let dash: FrameOrPage = page;

    await test.step(`open the ${ws} dashboard`, async () => {
      await openWorkspacesList(serverConsole);
      const cardRow = serverConsole
        .locator('div')
        .filter({ has: serverConsole.getByText(new RegExp(`^${escapeRegExp(ws)}$`)) })
        .filter({ has: serverConsole.getByRole('button', { name: /^Open$/ }) })
        .last();
      const openThisWorkspace = cardRow.getByRole('button', { name: /^Open$/ }).first();
      const bpSwitcher = () => dash.getByRole('button', { name: /^Process\b/ }).first();

      let rendered = false;
      for (let attempt = 1; attempt <= 6 && !rendered; attempt++) {
        const newTab = context.waitForEvent('page', { timeout: 30_000 }).catch(() => null);
        await openThisWorkspace.click();
        const popup = await newTab;
        if (popup) dashPage = popup;
        dash = await dashboard(dashPage);
        rendered = await bpSwitcher()
          .waitFor({ state: 'visible', timeout: SLA })
          .then(() => true)
          .catch(() => false);
        if (!rendered) {
          // eslint-disable-next-line no-console
          console.log(
            `  ${ws} dashboard attempt ${attempt}: url=${dashPage.url()} ` +
              `iframes=${await dashPage.locator('iframe').count().catch(() => -1)}`,
          );
        }
      }
      expect(
        rendered,
        `the ${ws} dashboard never rendered the BP switcher (tab at ${dashPage.url()}); ` +
          `a freshly created workspace serves it only once its gitops is listening on :8079`,
      ).toBe(true);

      await dash
        .getByText(/Loading business processes/i)
        .first()
        .waitFor({ state: 'hidden', timeout: SLA })
        .catch(() => {});
    });

    await test.step(`create the ${bp} business process`, async () => {
      const selected = dash.getByRole('button', { name: new RegExp(`^Process\\b.*${escapeRegExp(bp)}`) }).first();
      if (await selected.isVisible().catch(() => false)) {
        throw new Error(
          `"${bp}" already exists in "${ws}", so its setup deploy has already run and this run would ` +
            `assert nothing. Re-run with a fresh E2E_REPRO_TAG (e.g. E2E_REPRO_TAG=r2).`,
        );
      }
      const dialog = dash.getByRole('dialog');
      const nameInput = dialog.getByLabel(/^Name$/).first();
      await expect(async () => {
        if (await selected.isVisible().catch(() => false)) return;
        if (!(await nameInput.isVisible().catch(() => false))) {
          const newBpButton = dash.getByRole('button', { name: /New business process/i }).first();
          if (!(await newBpButton.isVisible().catch(() => false))) {
            await dash.getByRole('button', { name: /^Process\b/ }).first().click({ timeout: 2_000 });
          }
          await newBpButton.click({ timeout: 2_000 });
        }
        await expect(nameInput).toBeVisible({ timeout: 2_000 });
        await nameInput.fill(bp);
        await dialog.getByRole('button', { name: /^Create$/ }).first().click({ timeout: 2_000 });
        await expect(selected).toBeVisible({ timeout: 8_000 });
      }).toPass({ timeout: 3 * 60_000, intervals: [300, 500, 1000, 2000] });
      await expect(selected).toBeVisible({ timeout: SLA });
    });

    await test.step(`${bp}: the setup deploy its creation kicked off succeeds`, async () => {
      const readyToast = dash.getByText(new RegExp(`${escapeRegExp(bp)} ready`, 'i')).first();
      const failureToast = dash.getByText(new RegExp(`Failed to set up ${escapeRegExp(bp)}`, 'i')).first();
      const settingUpToast = dash.getByText(new RegExp(`Setting up ${escapeRegExp(bp)}`, 'i')).first();
      await Promise.race([
        readyToast.waitFor({ state: 'visible', timeout: SETUP_DEPLOY_TIMEOUT }).catch(() => {}),
        failureToast.waitFor({ state: 'visible', timeout: SETUP_DEPLOY_TIMEOUT }).catch(() => {}),
        settingUpToast.waitFor({ state: 'hidden', timeout: SETUP_DEPLOY_TIMEOUT }).catch(() => {}),
      ]);

      if (await failureToast.isVisible().catch(() => false)) {
        const toastText = ((await failureToast.textContent().catch(() => '')) || '').trim();
        const activityLog = await expandFailedActivityEntry(dash, bp);
        const composeOutput = infraDriverLogTail(ws);
        await capture(dashPage, `repro-418-${asSlug(bp)}-failed`).catch(() => {});
        throw new Error(
          `#418 reproduced: the setup deploy of "${bp}" in workspace "${ws}" failed.\n` +
            `toast: ${toastText}\n` +
            (activityLog ? `activity log:\n${activityLog}\n` : '') +
            (composeOutput ? `infra-driver log (carries the compose output):\n${composeOutput}\n` : ''),
        );
      }

      await expect(readyToast, `the setup deploy of "${bp}" never reported ready`).toBeVisible({ timeout: SLA });
      await capture(dashPage, `repro-418-${asSlug(bp)}-ready`).catch(() => {});
    });
  }
});

async function openWorkspacesList(serverConsole: FrameOrPage): Promise<void> {
  await serverConsole.getByRole('button', { name: /Workspaces/i }).first().click();
  await expect(serverConsole.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: SLA });
}

async function waitForWorkspaceWhileItsCreateLogKeepsMoving(
  page: Page,
  serverConsole: FrameOrPage,
  ws: string,
): Promise<void> {
  const card = serverConsole.getByText(new RegExp(`^${escapeRegExp(ws)}$`)).first();
  const alreadyInitialized = serverConsole.getByText(/already initialized/i).first();
  const createLog = serverConsole.getByTestId('ws-create-log');
  let lastLog = '';
  let lastChange = Date.now();
  const deadline = Date.now() + WORKSPACE_CREATE_TIMEOUT;
  for (;;) {
    if (await card.isVisible().catch(() => false)) return;
    if (await alreadyInitialized.isVisible().catch(() => false)) {
      await serverConsole.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {});
      return;
    }
    const text = (await createLog.textContent().catch(() => '')) || '';
    const now = Date.now();
    if (text !== lastLog) {
      lastLog = text;
      lastChange = now;
    } else if (now - lastChange > WORKSPACE_CREATE_LOG_STALL_LIMIT) {
      throw new Error(
        `creating workspace "${ws}" went dark: its live log made no progress for ` +
          `>${WORKSPACE_CREATE_LOG_STALL_LIMIT / 1000}s\nlast log:\n${text}`,
      );
    }
    if (now > deadline) {
      throw new Error(
        `workspace "${ws}" was not created within ${WORKSPACE_CREATE_TIMEOUT / 60_000}m\nlast log:\n${text}`,
      );
    }
    await page.waitForTimeout(1000);
  }
}

function infraDriverLogTail(ws: string): string {
  try {
    const name = sh(`docker ps -a --format '{{.Names}}' | grep -m1 -- '${ws}-site-.*infra-driver' || true`).trim();
    if (!name) return '';
    return sh(`docker logs --tail 120 ${name} 2>&1 | tail -60`).trim().slice(0, 6000);
  } catch {
    return '';
  }
}

async function approveDeviceTrustThroughDaemonCliIfAsked(page: Page): Promise<void> {
  const trustThisDevice = page.getByRole('heading', { name: /Trust this device/i }).first();
  const asked = await trustThisDevice
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!asked) return;
  const body = (await page.locator('body').textContent()) || '';
  const code = body.match(/Your code\s*(\d{6})/)?.[1] ?? body.match(/\b(\d{6})\b/)?.[1];
  if (!code) {
    throw new Error(`device trust was requested but no 6-digit code was on the page:\n${body.slice(0, 800)}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  approving device-trust code ${code} through the daemon CLI`);
  sh(`docker exec bitswan-automation-server-daemon bitswan bailey devices approve ${code}`);
  await trustThisDevice.waitFor({ state: 'hidden', timeout: 2 * 60_000 });
}

async function expandFailedActivityEntry(dash: FrameOrPage, bp: string): Promise<string> {
  try {
    const entry = dash.getByText(new RegExp(`Failed to set up ${escapeRegExp(bp)}`, 'i')).last();
    if (!(await entry.isVisible().catch(() => false))) return '';
    await entry.click({ timeout: 5_000 }).catch(() => {});
    const panel = dash
      .locator('div')
      .filter({ has: dash.getByText(/^Activity/) })
      .last();
    return ((await panel.textContent().catch(() => '')) || '').trim().slice(0, 4000);
  } catch {
    return '';
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
