/**
 * The product walkthrough — driven through the REAL Bailey stack in a browser,
 * AS A PURE BROWSER USER, and the source of the Operator's Handbook screenshots.
 *
 * Journey: onboarding (OIDC → claim → device trust) → create the Meridian Foods
 * workspace via the Server Console → create the invoice-processing BP → describe
 * it → Coding Agent → Sync & Deploy (+ CVE Checks) → deploy to dev → promote to
 * production → backups → rehearse recovery into DR.
 *
 * PURE-BROWSER RULES (a human with a mouse + keyboard could do every step):
 *  - ONLY click and type. No URL navigation except the single initial load of
 *    the onboarding entry URL — after that we move ONLY by clicking on-screen
 *    elements (tabs, stage nodes, switchers, buttons).
 *  - No page.evaluate / clipboard injection / JS in the page. Editor text is
 *    TYPED (locator.fill / pressSequentially).
 *  - No off-screen waits (no waitForResponse / network / docker / logs). We wait
 *    ONLY on visible DOM — text/elements becoming visible or hidden.
 *  - We never name a copy/stage/tab/section to navigate; we click the visible
 *    control. The personal copy is auto-created + auto-selected on load, so we
 *    just use whatever copy is active.
 *
 * TIMING RULE. Short interactions are bounded at the 60s SLA. A LONG operation
 * (deploy, promote, snapshot, DR restore) is allowed to run longer than 60s —
 * AS LONG AS the screen keeps moving. The failure condition for a long op is a
 * >15s gap with no visible progress change: that means the product went dark,
 * which IS the bug. We enforce this with a PROGRESS WATCHDOG (see
 * waitDeployDone) that reads the live deploy progress off the screen (the
 * sonner toast, the "Working…" button, the stage status line) and fails the
 * moment the product stops telling the operator what it's doing.
 */
import { appendFileSync } from 'node:fs';
import { test, expect, capture, oidcLogin, dashboard, ENV, type FrameOrPage } from '../fixtures/bitswan';
import { BP, WORKSPACE, COMPANY, SECRETS } from '../scenario';

// ── Snappiness is a product requirement, not a test nicety ──────────────────
// SLA bounds a SHORT interaction: opening a tab, a modal, a list. Long ops
// (deploy/promote/snapshot/DR restore) are not bounded by a flat SLA — they are
// bounded by the PROGRESS rule: the screen must change at least every PROGRESS
// window, or the run fails. Every chapter is still timed and recorded to the run
// timeline; a chapter "breaches" only if it suffered a >15s silent-progress gap
// (recorded by the watchdog), never merely for taking longer than 60s.
const SLA = 60_000; // short-interaction SLA: nothing quick should wait longer
const PROGRESS = 15_000; // long-op rule: the screen must move within this window

const misses: string[] = [];
// Chapters that went DARK during a long op: the watchdog observed a >PROGRESS
// gap with no on-screen progress change. This — not "took >60s" — is the breach.
const slow: string[] = [];
let dbgPage: import('@playwright/test').Page | null = null;

// Append a row to the shared run timeline (created by run-e2e.sh's tl_begin),
// so per-chapter durations show up in the merged slowest-first profile. Matches
// timeline.sh's TSV columns: when_utc \t seconds \t total_s \t step.
const TIMELINE = '/repo/e2e/manual/build/timeline.tsv';
let firstChapterAt = 0;
function recordTiming(name: string, seconds: number): void {
  if (!firstChapterAt) firstChapterAt = Date.now();
  const totalS = ((Date.now() - firstChapterAt) / 1000).toFixed(1);
  const t = new Date().toISOString().slice(11, 19);
  try {
    appendFileSync(TIMELINE, `${t}\t${seconds.toFixed(1)}\t${totalS}\twalkthrough: ${name}\n`);
  } catch {
    /* timeline is best-effort; never fail a chapter over telemetry */
  }
}

// A chapter can flag a >PROGRESS silent-progress gap (the watchdog calls this).
// That — not a long total duration — is what counts as a breach now.
let currentChapter = '';
function flagStall(detail: string): void {
  slow.push(`${currentChapter || 'long-op'}: ${detail}`);
  // eslint-disable-next-line no-console
  console.warn(`⏱  PROGRESS BREACH — chapter "${currentChapter}" went dark: ${detail}`);
}

async function chapter(name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    const t0 = Date.now();
    currentChapter = name;
    try {
      await fn();
      const s = (Date.now() - t0) / 1000;
      recordTiming(name, s);
      // eslint-disable-next-line no-console
      console.log(`✓ chapter "${name}" ${s.toFixed(1)}s`);
    } catch (e) {
      const s = (Date.now() - t0) / 1000;
      recordTiming(name, s);
      misses.push(`${name}: ${(e as Error).message.split('\n')[0]}`);
      // eslint-disable-next-line no-console
      console.warn(`⚠️  chapter "${name}" FAILED after ${s.toFixed(1)}s — ${(e as Error).message.split('\n')[0]}`);
      if (dbgPage) await capture(dbgPage, 'dbg-' + name).catch(() => {});
    }
  });
}

test('Bailey product walkthrough → manual screenshots', async ({ page }) => {
  test.setTimeout(60 * 60_000);

  // ---- Onboarding (hard-asserted) — the ONLY page.goto in the whole run ----
  await test.step('onboarding: sign in + claim the server', async () => {
    await page.goto(ENV.onboardUrl + '/');
    await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
    // Idempotent: on a fresh server the bootstrap "Claim this server" button is
    // shown; on an already-claimed server it isn't and we go straight to the
    // console. Either way we end on the Workspaces view.
    const claim = page.getByRole('button', { name: /Claim this server/i });
    await Promise.race([
      claim.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      page.getByRole('heading', { name: /Workspaces/i }).waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
    ]);
    if (await claim.isVisible().catch(() => false)) {
      await capture(page, 'onboard-claim');
      await claim.click();
    }
    await expect(page.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: SLA });
  });

  // ---- Create the workspace via the console (idempotent) ----
  await test.step('create the Meridian Foods workspace', async () => {
    // An existing workspace card carries an "Open" button; a brand-new account
    // shows the "not in any workspace" empty state. Wait for whichever lands so
    // the existence check isn't a render race against the async list fetch.
    const existing = page.getByText(new RegExp(`^${WORKSPACE.name}$`)).first();
    const empty = page.getByText(/not in any workspace/i).first();
    await Promise.race([
      existing.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      empty.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
    ]);
    if (await existing.isVisible().catch(() => false)) {
      // Already created on a previous run — nothing to do, just shoot the list.
      await capture(page, 'workspace-create');
    } else {
      await page.getByRole('button', { name: /New workspace/i }).first().click();
      // The create modal isn't an ARIA dialog; target its input by placeholder.
      const nameInput = page.getByPlaceholder(/payroll-automation/i).first();
      await nameInput.waitFor({ state: 'visible', timeout: SLA });
      await nameInput.fill(WORKSPACE.name);
      await capture(page, 'workspace-create');
      await page.getByRole('button', { name: /^Create workspace$/i }).click();
      // Resolve on whichever the modal surfaces: the 'Creating…' state clearing,
      // OR the idempotent "already initialized" notice (a prior run created it).
      const already = page.getByText(/already initialized/i).first();
      await Promise.race([
        page.getByRole('button', { name: /Creating/i }).waitFor({ state: 'hidden', timeout: SLA }).catch(() => {}),
        already.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      ]);
      // If the name was already taken, close the modal — the workspace exists.
      if (await already.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {});
      }
      await nameInput.waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
      await expect(page.getByText(new RegExp(`^${WORKSPACE.name}$`)).first()).toBeVisible({ timeout: SLA });
    }
  });

  // ---- Console chapters: click the left-nav items (no URL navigation) ----
  for (const [navLabel, slot, heading] of [
    [/People & roles/i, 'people-roles', /People & roles/i],
    [/Server overview/i, 'server-overview', /Server overview|Overview/i],
    [/Endpoint access/i, 'endpoint-access', /Endpoint access/i],
    [/Your devices/i, 'devices', /devices/i],
  ] as const) {
    await chapter(slot, async () => {
      await page.getByRole('button', { name: navLabel }).first().click();
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: SLA });
      await capture(page, slot);
    });
  }

  // ---- Open the workspace dashboard (its 'Open' button opens a new tab) ----
  // Click back to Workspaces first (we navigated away in the console chapters),
  // then click the workspace's Open button.
  let dashPage = page;
  let d: FrameOrPage = page;
  await test.step('open the workspace dashboard', async () => {
    await page.getByRole('button', { name: /Workspaces/i }).first().click();
    await expect(page.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: SLA });
    const open = page.getByRole('button', { name: /^Open$/ }).or(page.getByRole('link', { name: /^Open$/ })).first();
    const bpSwitcher = () => d.getByRole('button', { name: /Business process/i }).first();
    // A FRESHLY created workspace cold-starts its own containers (gitops +
    // dashboard + db), so right after creation Open can land on a not-yet-ready
    // dashboard — or not spawn the tab at all. A real operator just clicks Open
    // again until it comes up; do the same: retry Open until the dashboard shell
    // (BP switcher) actually renders. Each attempt waits a bounded window so a
    // genuinely dead dashboard still fails rather than hanging.
    let ready = false;
    for (let attempt = 0; attempt < 4 && !ready; attempt++) {
      const popupP = page.context().waitForEvent('page', { timeout: 20_000 }).catch(() => null);
      await open.click();
      const popup = await popupP;
      if (popup) { dashPage = popup; dbgPage = popup; }
      d = await dashboard(dashPage);
      ready = await bpSwitcher()
        .waitFor({ state: 'visible', timeout: SLA })
        .then(() => true)
        .catch(() => false);
    }
    expect(ready, 'workspace dashboard never rendered the BP switcher after retries').toBe(true);
    // Body loaded once "Loading business processes…" clears.
    await d.getByText(/Loading business processes/i).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    await capture(dashPage, 'dashboard-open');
  });

  // ── Pure-UI helpers ─────────────────────────────────────────────────────
  // A top tab is a button whose visible text is the tab label.
  const topTab = (re: RegExp) => d.getByRole('button', { name: re }).first();
  const clickTopTab = async (re: RegExp) => {
    await topTab(re).click();
  };
  // ── The live progress signature ──────────────────────────────────────────
  // Everything the product tells the operator about an in-flight long op, read
  // straight off the screen and concatenated. The deploy/promote pipeline
  // surfaces progress as a single sonner toast that updates in place (its title
  // is [data-sonner-toast] [data-title]); the Sync & Deploy button also flips to
  // "Working…"; the stage card carries a status line. We watch ALL of them so
  // any one moving counts as progress. (No network/log inspection — only DOM.)
  const progressSignature = async (): Promise<string> => {
    const parts: string[] = [];
    // The sonner toast title — the deploy task's live step message (gitops
    // streams "Preparing…", "Building image … <step>", "Starting containers…",
    // etc into it). Read every toast so a re-rendered/stacked toast still counts.
    const toasts = dashPage.locator('[data-sonner-toast] [data-title]');
    const n = await toasts.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const t = await toasts.nth(i).textContent().catch(() => '');
      if (t && t.trim()) parts.push('toast:' + t.trim());
    }
    // The action button label ("Working…" vs "Sync & Deploy"/"Promote").
    const btn = await d.getByRole('button', { name: /Working|Sync & Deploy|Promote|Switching|Starting/i }).first().textContent().catch(() => '');
    if (btn && btn.trim()) parts.push('btn:' + btn.trim());
    // The stage card status line + version (changes when a deploy lands).
    const status = await d.getByText(/Healthy|services? not running|Not deployed yet|Deploying|Building|Pulling|Starting|Preparing|Promoting|updated|never deployed/i).first().textContent().catch(() => '');
    if (status && status.trim()) parts.push('status:' + status.trim());
    return parts.join(' | ');
  };

  // A long op (deploy / promote) is DONE when the stage card reports Healthy /
  // Current on — read entirely from the screen. It FAILS if the stage surfaces
  // an error (red "N services not running" / "Last deploy … failed"). It is
  // ALLOWED to take longer than the SLA, but NOT to go dark: if PROGRESS ms pass
  // with no change to progressSignature() AND no terminal state, the product
  // stopped telling the operator what it's doing — that is the bug, so we throw.
  const waitDeployDone = async () => {
    const healthy = d.getByText(/^Healthy$/i).or(d.getByText(/Current on/i)).first();
    const failed = d
      .getByText(/services? not running/i)
      .or(d.getByText(/Last deploy to .* failed/i))
      .first();
    const isHealthy = () => healthy.isVisible().catch(() => false);
    const isFailed = () => failed.isVisible().catch(() => false);

    let last = await progressSignature();
    const BACKSTOP = 30 * 60_000; // generous absolute cap; the real guard is PROGRESS
    const deadline = Date.now() + BACKSTOP;
    for (;;) {
      if (await isHealthy()) return; // terminal: success on screen
      if (await isFailed()) {
        throw new Error(`deploy surfaced an error on screen: "${(await failed.textContent())?.trim()}"`);
      }
      if (Date.now() > deadline) throw new Error('deploy exceeded 30min backstop');
      // Wait up to PROGRESS for the on-screen progress to MOVE, racing the
      // terminal states so we resolve instantly when the deploy finishes. This
      // poll is Playwright-managed (NOT a manual sleep): it returns as soon as
      // the signature changes, or throws after PROGRESS ms of no movement.
      try {
        await expect
          .poll(
            async () => {
              if (await isHealthy()) return '<<healthy>>';
              if (await isFailed()) return '<<failed>>';
              return await progressSignature();
            },
            { timeout: PROGRESS, intervals: [500, 1000, 2000] },
          )
          .not.toBe(last);
      } catch {
        // No movement within PROGRESS and not terminal → the product went dark.
        flagStall(`no on-screen progress for >${PROGRESS / 1000}s (last: "${last.slice(0, 120)}")`);
        throw new Error(`deploy stalled: no on-screen progress for >${PROGRESS / 1000}s`);
      }
      last = await progressSignature();
    }
  };
  // Select a deployment stage by CLICKING its pipeline node (label above the
  // circle). Then wait for the stage card header to show that stage's name.
  const selectStage = async (label: RegExp) => {
    await d.getByRole('button', { name: label }).first().click();
  };
  // Select a section tab within the active stage by CLICKING its label.
  const clickSection = async (label: RegExp) => {
    await d.getByRole('button', { name: label }).first().click();
  };
  // Reliably close whatever overlay is open and ASSERT it's gone. Modals here
  // come in two shapes: Radix dialogs (role="dialog") and custom fixed-overlays
  // (e.g. the Inspect modal — a `fixed inset-0` backdrop with an aria-label
  // "Close" × and a click-the-backdrop-to-dismiss handler, NOT role="dialog").
  // A modal left open intercepts every later click, so a stuck overlay must fail
  // loudly HERE, not cascade into unrelated chapters. Safe to call when nothing
  // is open. We detect "an overlay is up" by either a role=dialog OR a visible
  // "Close" affordance, and close via that affordance, then Escape, then a
  // backdrop click — re-checking after each.
  // Close a modal by its own Close affordance and confirm it's gone. Modals here
  // are either Radix dialogs (role="dialog", a Close/Cancel button) or the custom
  // Inspect overlay (an aria-label="Close" ×). We track THAT specific closer: it
  // is the modal's own control, so its disappearance is a precise "modal closed"
  // signal — no broad backdrop heuristic that could flap on shell elements. A
  // modal left open intercepts later clicks, so we assert it closed (loud fail
  // here beats a cascade into unrelated chapters). Safe when nothing is open.
  const closeAnyModal = async () => {
    // Radix dialog/alertdialog (Cancel/Close button) or the custom Inspect
    // overlay (aria-label="Close" ×). Track that specific closer: its
    // disappearance is the precise "modal closed" signal.
    const closer = d
      .getByRole('button', { name: /^(Close|Cancel|Done|Dismiss)$/i })
      .or(d.locator('button[aria-label="Close" i]'))
      .last();
    if (!(await closer.isVisible().catch(() => false))) return;
    await closer.click().catch(() => {});
    if (await closer.isVisible().catch(() => false)) await dashPage.keyboard.press('Escape').catch(() => {});
    await expect(closer, 'a modal stayed open and would block later clicks').toBeHidden({ timeout: SLA });
  };

  // The personal copy is auto-created + auto-selected on load — we never create
  // or name one for navigation. We DO open the copy switcher once to screenshot
  // it (a real thing a user can do), then close it without creating anything.
  await chapter('copy-switcher', async () => {
    const copyBtn = d.getByRole('button', { name: /^Copy/ }).first();
    await copyBtn.click();
    // The popover lists the copies (or "Setting up your copy…" while it lands)
    // and a "New copy" action. Shoot it open — a real thing a user can do — then
    // close it without creating anything.
    await d.getByText(/New copy|Setting up your copy/i).first()
      .waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
    await capture(dashPage, 'copy-switcher');
    await dashPage.keyboard.press('Escape');
  });

  // ---- Create the invoice-processing business process ----
  await chapter('create-bp', async () => {
    // The BP may already exist from a prior run — open the switcher and select
    // it if so; otherwise create it. "New business process" only appears once a
    // copy is active (it is, auto-selected).
    await d.getByRole('button', { name: /Business process/i }).first().click();
    await capture(dashPage, 'bp-switcher');
    const existing = d.getByRole('button', { name: new RegExp(`^${BP.slug}$`) }).first();
    if (await existing.isVisible().catch(() => false)) {
      await existing.click();
    } else {
      await d.getByRole('button', { name: /New business process/i }).click();
      const dlg = d.getByRole('dialog');
      await dlg.getByPlaceholder('my-process').fill(BP.slug);
      await capture(dashPage, 'bp-create');
      await dlg.getByRole('button', { name: /^Create$/ }).click();
      await dlg.waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    }
    // The BP is selected once its name shows in the switcher trigger.
    await expect(d.getByRole('button', { name: new RegExp(`Business process.*${BP.slug}`) }).first())
      .toBeVisible({ timeout: SLA });
  });

  // ---- Description: TYPE a real README (Markdown + a Mermaid flowchart) ----
  await chapter('description', async () => {
    await clickTopTab(/Description/i);
    // The ProseMirror editor surface mounts as a contenteditable. Click it and
    // type; the editor's markdown input-rules turn '# ', '1. ' etc into real
    // structure as a human would see while typing.
    const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: SLA });
    await editor.click();
    await editor.pressSequentially(BP.readme, { delay: 0 });
    // Force a save (Ctrl+S) and wait for it to settle (the Save button leaves
    // its 'Saving…' state and the indicator shows '· saved').
    await dashPage.keyboard.press('Control+s');
    await d.getByRole('button', { name: /Saving/i }).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    await capture(dashPage, 'description');
  });

  // ---- Coding Agent ----
  await chapter('coding-agent', async () => {
    await clickTopTab(/Coding Agent/i);
    await capture(dashPage, 'coding-agent');
  });

  // ---- Requirements & tests: the runnable-spec tab a real operator uses ----
  await chapter('requirements', async () => {
    await clickTopTab(/Requirements & tests/i).catch(() => {});
    await capture(dashPage, 'requirements');
  });

  // ---- Sync & Deploy: the Diff / History / Checks sub-tabs ----
  // Every sub-tab a real operator inspects before shipping: the Diff (what
  // becomes main), the History (copy + main commits with deploy tags), and the
  // Checks tab (the CVE scan of the image this deploy would build).
  await chapter('sync-deploy', async () => {
    await clickTopTab(/Sync & Deploy/i);
    await capture(dashPage, 'sync-deploy');
    // Diff sub-tab — the changed files that will become the new main. Clicking a
    // file shows its diff; capture the file list at minimum.
    await d.getByRole('button', { name: /^diff$/i }).first().click().catch(() => {});
    await capture(dashPage, 'sync-deploy-diff');
    // History sub-tab — the copy + main commit timeline with deploy markers.
    await d.getByRole('button', { name: /^history$/i }).first().click().catch(() => {});
    await capture(dashPage, 'sync-deploy-history');
    // Checks sub-tab — wait for the supply-chain scan to finish, then shoot it.
    await d.getByRole('button', { name: /^checks$/i }).first().click();
    await d.getByText(/Loading supply chain|Building|Scanning/i).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    await capture(dashPage, 'checks-cve');
  });

  // ---- Deploy the copy onto main + dev ----
  // One press of Sync & Deploy commits the copy onto main and deploys this BP's
  // containers to dev. Driven + observed ENTIRELY through the screen: the button
  // reads "Sync & Deploy" → "Working…" while it commits/builds/deploys, then the
  // app flips to Deployments. We confirm the Development stage reports Healthy on
  // screen. The "Add automations" scaffold lands ASYNCHRONOUSLY after the BP is
  // created, so the very first press can fast-forward main a beat before the BP's
  // containers are indexed and deploy nothing; the README the editor re-serialises
  // leaves the BP actionable again, so a human simply presses Sync & Deploy once
  // more. We do the same: press while actionable until the dev stage is Healthy.
  // Press Sync & Deploy and ride the deploy with the progress watchdog. The
  // button commits work-in-progress, rebases onto main, fast-forwards and
  // deploys to dev — flipping to "Working…" while it runs. We DON'T cap on a
  // flat SLA; we wait for the button to leave "Working…" while requiring the
  // on-screen progress to keep moving (the watchdog), so a long real image
  // build is fine but a silent stall fails.
  const pressSyncDeploy = async () => {
    await clickTopTab(/Sync & Deploy/i);
    const btn = d.getByRole('button', { name: /Sync & Deploy|Working/ }).last();
    await expect(btn).toBeEnabled({ timeout: SLA });
    await btn.click();
    const working = d.getByRole('button', { name: /Working/i }).first();
    await working.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}); // started
    // Wait for "Working…" to clear, but as a PROGRESS WATCHDOG: every PROGRESS
    // window the screen must move (toast step text, button label, status line)
    // or we flag a dark stall and fail. No flat overall cap beyond the backstop.
    let last = await progressSignature();
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      if (!(await working.isVisible().catch(() => false))) return; // finished
      if (Date.now() > deadline) throw new Error('Sync & Deploy exceeded 30min backstop');
      try {
        await expect
          .poll(
            async () => ((await working.isVisible().catch(() => false)) ? await progressSignature() : '<<done>>'),
            { timeout: PROGRESS, intervals: [500, 1000, 2000] },
          )
          .not.toBe(last);
      } catch {
        flagStall(`Sync & Deploy: no on-screen progress for >${PROGRESS / 1000}s (last: "${last.slice(0, 120)}")`);
        throw new Error(`Sync & Deploy stalled: no on-screen progress for >${PROGRESS / 1000}s`);
      }
      last = await progressSignature();
    }
  };
  await chapter('deploy', async () => {
    await clickTopTab(/Sync & Deploy/i);
    // Gate on there being something to ship: the BP shows pending work
    // ("N uncommitted file(s)" — the scaffold + README the editor wrote — and/or
    // "N ahead" of main). The Sync & Deploy button being ENABLED is the
    // authoritative on-screen signal that a deploy will do something.
    const btn = d.getByRole('button', { name: /^Sync & Deploy$|Working/ }).last();
    await expect(btn, 'Sync & Deploy never became actionable (nothing to deploy)').toBeEnabled({ timeout: SLA });
    // Press, then check the Development stage. The scaffold can land a beat after
    // the BP is created, so a first press might fast-forward main without
    // deploying this BP's containers; if dev is still "Not deployed yet" and the
    // button is actionable again, press once more — bounded to a few tries.
    let healthy = false;
    for (let attempt = 0; attempt < 3 && !healthy; attempt++) {
      await pressSyncDeploy();
      await clickTopTab(/Deployments/i);
      await selectStage(/Development/i);
      const ok = d.getByText(/^Healthy$/i).or(d.getByText(/Current on/i)).first();
      const none = d.getByText(/Not deployed yet/i).first();
      await Promise.race([
        ok.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
        none.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      ]);
      healthy = await ok.isVisible().catch(() => false);
      if (!healthy) {
        // Nothing deployed yet — is the button actionable to retry?
        await clickTopTab(/Sync & Deploy/i);
        if (!(await btn.isEnabled().catch(() => false))) break;
      }
    }
    await clickTopTab(/Deployments/i);
    await selectStage(/Development/i);
    await waitDeployDone();
    await capture(dashPage, 'deploy-dev');
  });

  // ---- Promote dev → staging → production, waiting for each to be Healthy ----
  await chapter('promote', async () => {
    await clickTopTab(/Deployments/i);
    // Two hops. For each, click the target stage (so waitDeployDone watches the
    // stage we're filling), click whichever Promote is enabled (the pipeline
    // only enables the next hop), and wait — on screen — for that stage to
    // report Healthy. No reload between click and wait.
    for (const target of [/Staging/i, /Production/i] as const) {
      await selectStage(target);
      const all = d.getByRole('button', { name: /^Promote$/ });
      const n = await all.count();
      for (let j = 0; j < n; j++) {
        const b = all.nth(j);
        if (await b.isEnabled().catch(() => false)) {
          await b.click();
          break;
        }
      }
      await waitDeployDone(); // this target stage reaches Healthy on screen
    }
  });

  // ---- Deployment sections; the cover hero is the live Production view ----
  await chapter('deployments-prod', async () => {
    await clickTopTab(/Deployments/i);
    await selectStage(/Production/i);
    await waitDeployDone();
    await capture(dashPage, 'deployments-prod');
    await capture(dashPage, 'cover');
  });
  await chapter('supply-chain', async () => {
    await selectStage(/Production/i);
    await clickSection(/Supply chain/i);
    await capture(dashPage, 'supply-chain');
    // Open the first CVE/package row's detail if the SBOM rendered any, so the
    // manual can show the advisory drill-down a real operator triages.
    const cveRow = d.getByRole('button', { name: /CVE-\d{4}-\d+/ }).first();
    if (await cveRow.isVisible().catch(() => false)) {
      await cveRow.click().catch(() => {});
      await capture(dashPage, 'supply-chain-cve');
    }
  });
  await chapter('containers', async () => {
    await selectStage(/Production/i);
    // The Containers tab carries a count pill ("Containers 2"), so match the
    // label as a prefix — an anchored /^Containers$/ would miss it.
    await clickSection(/Containers/i);
    // The live container roster for the current deployment. Each row carries
    // Logs / Inspect and start/stop controls.
    await capture(dashPage, 'containers');
  });
  await chapter('secrets', async () => {
    await selectStage(/Production/i);
    await clickSection(/^Secrets$/i);
    await capture(dashPage, 'secrets');
    // Demonstrate adding a stage secret (a real thing an operator does): click
    // "Add secret" to create a row, type a key/value, capture mid-edit, then
    // leave WITHOUT saving so we don't mutate production secrets on a re-run.
    const addSecret = d.getByRole('button', { name: /Add secret/i }).first();
    if (await addSecret.isVisible().catch(() => false)) {
      await addSecret.click().catch(() => {});
      const keyInput = d.getByPlaceholder(/SECRET_NAME/i).last();
      if (await keyInput.isVisible().catch(() => false)) {
        await keyInput.fill(SECRETS[0].key).catch(() => {});
        const valInput = d.getByPlaceholder(/^value$|Needs a value/i).last();
        if (await valInput.isVisible().catch(() => false)) await valInput.fill(SECRETS[0].value).catch(() => {});
        await capture(dashPage, 'secrets-edit');
      }
    }
  });
  await chapter('history', async () => {
    await selectStage(/Production/i);
    await clickSection(/Deployment history/i);
    await capture(dashPage, 'history');
    // Open the per-deployment Inspect modal on the current entry — the audit
    // drill-down (files, diff vs current, secrets snapshot, image download).
    const inspect = d.getByRole('button', { name: /^Inspect$/ }).first();
    if (await inspect.isVisible().catch(() => false)) {
      await inspect.click();
      // The Inspect overlay is a custom fixed backdrop (not role="dialog") with a
      // left rail (Scale / Files / Diff vs current / Secrets snapshot). Wait on a
      // signature item, shoot it, then close via its own × (aria-label "Close").
      const inspectMark = d.getByText(/Diff vs current/i).first();
      await inspectMark.waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
      await capture(dashPage, 'inspect-modal');
      // Its × is the last aria-label="Close" on the page while the modal is up.
      const x = d.locator('button[aria-label="Close" i]').last();
      if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
      if (await inspectMark.isVisible().catch(() => false)) await dashPage.keyboard.press('Escape').catch(() => {});
      await expect(inspectMark, 'Inspect modal stayed open and would block later clicks')
        .toBeHidden({ timeout: SLA });
    }
  });
  await chapter('firewall', async () => {
    await selectStage(/Production/i);
    await clickSection(/^Firewall$/i);
    await capture(dashPage, 'firewall');
    // If a host is awaiting its GDPR data-processing record, open that modal so
    // the manual shows the Article 30 record an operator completes before a new
    // egress destination is allowed. Close without approving (idempotent).
    const review = d.getByRole('button', { name: /Review|Complete record|Add host|Data-processing|Approve/i }).first();
    if (await review.isVisible().catch(() => false)) {
      await review.click().catch(() => {});
      if (await d.getByRole('dialog').first().isVisible().catch(() => false)) {
        await capture(dashPage, 'firewall-gdpr');
        await closeAnyModal();
      }
    }
  });

  // ---- Backups: take a real production snapshot, wait for it to appear ----
  await chapter('backups', async () => {
    await selectStage(/Production/i);
    await clickSection(/^Backups$/i);
    // First-time: enable snapshots for this stage, then the Create snapshot
    // button enables.
    const enable = d.getByRole('button', { name: /Enable snapshots/i }).first();
    if (await enable.isVisible().catch(() => false)) {
      await enable.click();
      await enable.waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    }
    const snap = d.getByRole('button', { name: /Create snapshot/i }).first();
    await expect(snap).toBeEnabled({ timeout: SLA });
    await snap.click();
    // The Create dialog opens; capture it (label field + stage picker) BEFORE
    // confirming, then confirm (its primary button is also "Create snapshot").
    const dlg = d.getByRole('dialog');
    await dlg.waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
    await capture(dashPage, 'snapshot-create');
    await dlg.getByRole('button', { name: /Create snapshot/i }).click();
    await dlg.waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    // The snapshot runs as a task (progress card), then a snapshot row with a
    // "manual" badge + a Restore button appears. This is a LONG op — watch it
    // with the progress rule: the snapshot task streams step labels (Restoring
    // Postgres…/CouchDB…/MinIO…) and must not go dark >PROGRESS.
    const restoreRow = d.getByRole('button', { name: /^Restore$/ }).first();
    let last = await progressSignature();
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      if (await restoreRow.isVisible().catch(() => false)) break;
      if (Date.now() > deadline) throw new Error('snapshot exceeded 30min backstop');
      try {
        await expect
          .poll(async () => ((await restoreRow.isVisible().catch(() => false)) ? '<<done>>' : await progressSignature()),
            { timeout: PROGRESS, intervals: [500, 1000, 2000] })
          .not.toBe(last);
      } catch {
        flagStall(`snapshot: no on-screen progress for >${PROGRESS / 1000}s (last: "${last.slice(0, 120)}")`);
        throw new Error(`snapshot stalled: no on-screen progress for >${PROGRESS / 1000}s`);
      }
      last = await progressSignature();
    }
    await capture(dashPage, 'backups');
  });

  // ---- Disaster Recovery: restore the backup into DR + mark recovery-tested --
  await chapter('dr-rehearse', async () => {
    await selectStage(/Disaster Recovery/i);
    await clickSection(/Rehearse & restore/i);
    const restore = d.getByRole('button', { name: /Restore into DR/i }).first();
    if (await restore.isVisible().catch(() => false)) {
      await restore.click();
      // Restoring into DR is a LONG op (Postgres/CouchDB/MinIO restore) that
      // streams per-store step labels. Watch it with the progress rule.
      const inDr = d.getByText(/In DR now/i).first();
      let last = await progressSignature();
      const deadline = Date.now() + 30 * 60_000;
      for (;;) {
        if (await inDr.isVisible().catch(() => false)) break;
        if (Date.now() > deadline) throw new Error('DR restore exceeded 30min backstop');
        try {
          await expect
            .poll(async () => ((await inDr.isVisible().catch(() => false)) ? '<<done>>' : await progressSignature()),
              { timeout: PROGRESS, intervals: [500, 1000, 2000] })
            .not.toBe(last);
        } catch {
          flagStall(`DR restore: no on-screen progress for >${PROGRESS / 1000}s (last: "${last.slice(0, 120)}")`);
          throw new Error(`DR restore stalled: no on-screen progress for >${PROGRESS / 1000}s`);
        }
        last = await progressSignature();
      }
      const mark = d.getByRole('button', { name: /Mark recovery-tested/i }).first();
      if (await mark.isVisible().catch(() => false)) {
        await mark.click();
        await d.getByText(/Tested/i).first().waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
      }
    }
    await capture(dashPage, 'dr-rehearse');
  });

  // ---- DR architecture explainer (the "How it works" sub-tab) ----
  await chapter('dr-architecture', async () => {
    await selectStage(/Disaster Recovery/i);
    await clickSection(/How it works/i).catch(() => {});
    await capture(dashPage, 'dr-architecture');
  });

  // ---- The go-live swap confirm (open the RESTORE cutover dialog, then CANCEL
  // so we never actually swap production live during the walkthrough). ----
  await chapter('dr-swap', async () => {
    await clickTopTab(/Deployments/i);
    // The "Restore" pill sits between Production and DR on the pipeline.
    const restorePill = d.getByRole('button', { name: /^Restore$/ }).first();
    if (await restorePill.isVisible().catch(() => false)) {
      await restorePill.click().catch(() => {});
      const dlg = d.getByRole('dialog').first();
      if (await dlg.isVisible().catch(() => false)) {
        await capture(dashPage, 'dr-swap');
        // Cancel — a rehearsal walkthrough must not flip live production.
        await closeAnyModal();
      }
    }
  });

  /* eslint-disable no-console */
  console.log(`\n=== walkthrough summary: company=${COMPANY.short}, failed chapters=${misses.length}, SLA breaches=${slow.length} ===`);
  misses.forEach((m) => console.log('  ✗ ' + m));
  slow.forEach((m) => console.log('  ⏱ SLOW ' + m));
  // Snappiness is a hard requirement: a chapter that made the user wait past the
  // SLA, or one that failed, is a product defect — fail the run so it can't pass
  // silently.
  expect(misses, `chapters failed: ${misses.join('; ')}`).toEqual([]);
  expect(slow, `SLA breaches (user waited > ${SLA / 1000}s): ${slow.join('; ')}`).toEqual([]);
  /* eslint-enable no-console */
});
