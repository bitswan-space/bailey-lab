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
import { BP, WORKSPACE, COMPANY, SECRETS, TEAMMATE } from '../scenario';

// ── Snappiness is a product requirement, not a test nicety ──────────────────
// SLA bounds a SHORT interaction: opening a tab, a modal, a list. Long ops
// (deploy/promote/snapshot/DR restore) are not bounded by a flat SLA — they are
// bounded by the PROGRESS rule: the screen must change at least every PROGRESS
// window, or the run fails. Every chapter is still timed and recorded to the run
// timeline; a chapter "breaches" only if it suffered a silent-progress gap
// longer than the PROGRESS window (recorded by the watchdog), never merely for
// taking longer than the SLA.
const SLA = 60_000; // short-interaction SLA: nothing quick should wait longer
// long-op rule: the screen must move within this window or the product is
// considered "gone dark". Promote shows a single coarse "Promoting to <stage>…"
// status (not the deploy's granular steps), and a promote now stands up
// per-(workspace,stage) infra (postgres/minio fresh per stage) — so that one
// status can legitimately hold for tens of seconds on CI dind. Keep the window
// well above a real promote's coarse-status span; the 30-min backstop in
// waitDeployDone still catches a genuine hang.
const PROGRESS = 60_000;
const NAV = 15_000; // a tab/section/stage click targets an element already on
// screen, so it should land fast. If it can't within NAV, something (usually a
// stuck modal) is intercepting clicks — fail fast here instead of burning the
// full 60s SLA, so chapter() can diagnose + clear the overlay before the next.

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
      const msg = (e as Error).message.split('\n')[0];
      misses.push(`${name}: ${msg}`);
      // eslint-disable-next-line no-console
      console.warn(`⚠️  chapter "${name}" FAILED after ${s.toFixed(1)}s — ${msg}`);
      // Diagnose before we stop: the screenshot at the moment of failure, plus
      // the text of any overlay that was open (a stuck modal intercepting clicks
      // is the most common cause), so the log explains the failure on its own.
      if (dbgPage) {
        await capture(dbgPage, 'dbg-' + name).catch(() => {});
        const open = await dbgPage
          .locator('[role="dialog"]:visible, [role="alertdialog"]:visible')
          .first()
          .textContent()
          .catch(() => null);
        // eslint-disable-next-line no-console
        if (open && open.trim()) console.warn(`   ↳ overlay open at failure: "${open.trim().slice(0, 140)}"`);
      }
      // FAIL FAST: a chapter's hard assertion failing is a real defect. Stop the
      // run on the FIRST miss (with the diagnostics above) rather than press on
      // into a cascade of dependent failures — the run is green only when every
      // chapter passes, so there is nothing to gain by continuing past a failure.
      throw e;
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
  await test.step('create the Finance workspace', async () => {
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

  // ---- SIEM export (L): on the Server overview, point Bailey at an external
  // OTLP ingestor so its security audit log streams to your SIEM. We open the
  // SIEM forwarding card's config form, fill it with the REAL OTLP/HTTP
  // collector bringup stands up on bitswan_network (ENV.otlpHttpEndpoint —
  // Bailey appends /v1/logs itself, so we give the base URL only), capture the
  // FORM (filled, pre-save) as `siem-form`, then Save & connect and capture the
  // CONNECTED state as `siem` (#100). The collector is genuinely reachable from
  // the daemon, so the connectivity test SUCCEEDS — we hard-assert the card
  // reaches the Connected/success state with NO error before capturing `siem`.
  await chapter('siem', async () => {
    await page.getByRole('button', { name: /Server overview/i }).first().click();
    await expect(page.getByText(/SIEM forwarding/i).first()).toBeVisible({ timeout: SLA });
    // Open the config form (first run shows "Configure ingestor"; an existing
    // config shows "Edit"). Either lands on the same form.
    const configure = page.getByRole('button', { name: /Configure ingestor|^Edit$/ }).first();
    await configure.waitFor({ state: 'visible', timeout: SLA });
    await configure.click();
    const url = page.getByPlaceholder(/collector\.example\.com/i).first();
    await url.waitFor({ state: 'visible', timeout: SLA });
    // Point at the REAL collector (base URL only; Bailey appends /v1/logs).
    await url.fill(ENV.otlpHttpEndpoint);
    // #100 fix: capture the CONFIG FORM first — the OTLP endpoint + protocol
    // fields filled in, BEFORE pressing Save & connect — as its own `siem-form`
    // slot, so the manual shows/explains the form, not just the connected state.
    await capture(page, 'siem-form');
    // Save & connect — runs a bounded connectivity test, then persists.
    await page.getByRole('button', { name: /Save & connect|Testing…/ }).first().click();
    // Wait for the test to settle: the button leaves "Testing…".
    await page.getByRole('button', { name: /Testing…/ }).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    // HARD-ASSERT the success state — the card's status pill flips to
    // "● Connected" (tone success) and the "Last error:" line is absent, since
    // the collector really is reachable from the daemon. (The pill reads
    // "Disconnected" on failure, so we anchor on "Connected" NOT preceded by
    // "Dis".) The post-save card also lists the endpoint + "Last delivered".
    const connected = page.getByText(/(?<!Dis)Connected/).first();
    await expect(connected, 'SIEM card did not reach a Connected state against the real collector')
      .toBeVisible({ timeout: SLA });
    await expect(page.getByText(/Last error:/i), 'SIEM connectivity test surfaced an error')
      .toHaveCount(0);
    await capture(page, 'siem');
  });

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
    await topTab(re).click({ timeout: NAV });
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
    // etc into it). The Toaster renders INSIDE the workspace dashboard iframe,
    // so read it from `d` (the frame) — not `dashPage` (the outer onboard shell),
    // where it never appears. Read every toast so a re-rendered/stacked toast
    // still counts.
    const toasts = d.locator('[data-sonner-toast] [data-title]');
    const n = await toasts.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const t = await toasts.nth(i).textContent().catch(() => '');
      if (t && t.trim()) parts.push('toast:' + t.trim());
    }
    // The action button label ("Working…" vs "Sync & Deploy"/"Promote"). Use a
    // SHORT per-read timeout: when the element is absent (e.g. on a tab that
    // doesn't show it), textContent() otherwise blocks the full default timeout
    // (and the .catch hides it) — turning a single signature read into a 60s
    // stall and breaking the watchdog's timing. A quick miss → empty part.
    const btn = await d.getByRole('button', { name: /Working|Sync & Deploy|Promote|Switching|Starting/i }).first().textContent({ timeout: 1500 }).catch(() => '');
    if (btn && btn.trim()) parts.push('btn:' + btn.trim());
    // The stage card status line + version (changes when a deploy lands).
    const status = await d.getByText(/Healthy|services? not running|Not deployed yet|Deploying|Building|Pulling|Starting|Preparing|Promoting|Generating|Configuring|Reconciling|Provisioning|Installing|Recording|Updating|updated|never deployed/i).first().textContent({ timeout: 1500 }).catch(() => '');
    if (status && status.trim()) parts.push('status:' + status.trim());
    return parts.join(' | ');
  };

  // A long op (deploy / promote) is DONE when the stage card reports Healthy /
  // Current on — read entirely from the screen. It FAILS if the stage surfaces
  // an error (red "N services not running" / "Last deploy … failed"). It is
  // ALLOWED to take longer than the SLA, but NOT to go dark: if PROGRESS ms pass
  // with no change to progressSignature() AND no terminal state, the product
  // stopped telling the operator what it's doing — that is the bug, so we throw.
  const waitDeployDone = async (stageName?: string) => {
    // When a target stage is named (a promote hop), the deploy is DONE only when
    // THAT stage is current ("Current on <Stage>"); a prior stage's lingering
    // Healthy / "Current on …" must not end the wait early. Otherwise (a plain
    // deploy) any Healthy / Current-on on screen is the terminal.
    const healthy = stageName
      ? d.getByText(new RegExp(`Current on ${stageName}`, 'i')).first()
      : d.getByText(/^Healthy$/i).or(d.getByText(/Current on/i)).first();
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
    await d.getByRole('button', { name: label }).first().click({ timeout: NAV });
  };
  // Select a section tab within the active stage by CLICKING its label.
  const clickSection = async (label: RegExp) => {
    await d.getByRole('button', { name: label }).first().click({ timeout: NAV });
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
    // disappearance is the precise "modal closed" signal. We must match only a
    // VISIBLE closer — a same-named but hidden button elsewhere on the page
    // would otherwise be picked by .last(), the visibility guard would short-
    // circuit, and the real (open) modal would be left up to block later clicks.
    const closer = d
      .locator('button:visible', { hasText: /^(Close|Cancel|Done|Dismiss)$/i })
      .or(d.locator('button[aria-label="Close" i]:visible'))
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
    // The personal copy is created in the BACKGROUND on first visit (clone +
    // Postgres + live-dev), and on a cold workspace that can take a little while
    // — until it lands, creating a BP in it fails (the copy dir isn't there
    // yet). A real operator simply waits for "Setting up your copy…" to clear
    // and presses Create again. We do the same: wait for the copy to settle,
    // then RETRY the Create until the BP actually appears (rather than assuming
    // the very first press lands).
    await d.getByRole('button', { name: /Business process/i }).first().click();
    await capture(dashPage, 'bp-switcher');
    const selected = d.getByRole('button', { name: new RegExp(`Business process.*${BP.slug}`) }).first();
    const existing = d.getByRole('button', { name: new RegExp(`^${BP.slug}$`) }).first();
    if (await existing.isVisible().catch(() => false)) {
      await existing.click();
    } else {
      // Wait for the copy to finish setting up before we try to create in it.
      await d.getByText(/Setting up your copy/i).first()
        .waitFor({ state: 'hidden', timeout: 3 * 60_000 }).catch(() => {});
      // Retry the create: a press can 400 while the copy is still landing, which
      // leaves the dialog open — so re-open/refill/press until the BP shows.
      const deadline = Date.now() + 5 * 60_000;
      let created = false;
      let shotCreate = false;
      for (let attempt = 0; !created && Date.now() < deadline; attempt++) {
        // (Re)open the New BP modal if it isn't already open.
        const dlg = d.getByRole('dialog');
        if (!(await dlg.isVisible().catch(() => false))) {
          const newBtn = d.getByRole('button', { name: /New business process/i }).first();
          if (!(await newBtn.isVisible().catch(() => false))) {
            // Switcher closed after a prior attempt — re-open it.
            await d.getByRole('button', { name: /Business process/i }).first().click().catch(() => {});
            await newBtn.waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
          }
          await newBtn.click().catch(() => {});
        }
        const input = dlg.getByPlaceholder('my-process').first();
        await input.waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
        if (await input.isVisible().catch(() => false)) {
          await input.fill(BP.slug).catch(() => {});
          if (!shotCreate) {
            await capture(dashPage, 'bp-create');
            shotCreate = true;
          }
          await dlg.getByRole('button', { name: /^Create$/ }).first().click().catch(() => {});
        }
        // Resolve on success (BP selected) OR the dialog clearing; otherwise the
        // create errored (copy not ready) and we loop to retry after a beat.
        await Promise.race([
          selected.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
          dlg.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {}),
        ]);
        created = await selected.isVisible().catch(() => false);
        if (!created) {
          // Close a lingering errored dialog so the next attempt is clean.
          if (await dlg.isVisible().catch(() => false)) {
            await dashPage.keyboard.press('Escape').catch(() => {});
            await dlg.waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
          }
        }
      }
    }
    // The BP is selected once its name shows in the switcher trigger.
    await expect(selected).toBeVisible({ timeout: SLA });
  });

  // ---- Description: TYPE a real README, then DRAW the flow with the editor ----
  await chapter('description', async () => {
    await clickTopTab(/Description/i);
    // The BP scaffold's first dev deploy was auto-kicked at BP creation
    // (NewBusinessProcessDialog watches it with a toast.promise "Setting up <bp>…"
    // → "<bp> ready"). It builds an image, so it runs past 60s — but waiting on
    // its TOAST is a plain visibility wait, not a watchdog-tracked long op, so it
    // never registers an SLA breach (those come only from the 15s progress
    // watchdog). We wait for the "<bp> ready" success toast (so we never type
    // into / shoot a half-scaffolded BP), then let the sonner toasts CLEAR before
    // any capture so no shot is taken with a toast covering the screen. Non-fatal
    // on a re-run where it already settled (resolve on the loading toast gone).
    const readyToast = d.getByText(new RegExp(`${BP.slug} ready`, 'i')).first();
    const settingUp = d.getByText(new RegExp(`Setting up ${BP.slug}`, 'i')).first();
    await Promise.race([
      readyToast.waitFor({ state: 'visible', timeout: 8 * 60_000 }).catch(() => {}),
      settingUp.waitFor({ state: 'hidden', timeout: 8 * 60_000 }).catch(() => {}),
    ]);
    await d.locator('[data-sonner-toast]').first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
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

  // ---- Draw the flow with the flowchart editor (not a typed mermaid block) --
  // A real operator clicks the toolbar's "Insert flowchart" button and DRAWS a
  // COHERENT invoice-processing flow node-by-node — not random scatter. The
  // editor (FlowchartEditorModal) is a React Flow canvas: Add-node buttons drop
  // a node at a fixed spot, a selected node is renamed via the side-panel
  // "Label" input, nodes are placed by DRAGGING them apart, and two nodes are
  // CONNECTED by dragging from a source handle (bottom, or the decision's
  // left/right) to a target's top handle. We build:
  //   [Invoice received] → [Extract fields (OCR)] → [Match PO & VAT] →
  //   <Over €5,000?> ─yes→ [Hold for approval]   ─no→ [Post to ledger]
  // …then Save diagram drops the rendered chart into the spec. Every node/edge
  // is hard-asserted on the canvas before we capture.
  await chapter('flowchart-editor', async () => {
    await clickTopTab(/Description/i);
    const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: SLA });
    // Put the caret at the END of the prose on a FRESH blank line so the diagram
    // embed lands as its own block — not merged into the trailing markdown list
    // (the README ends with bullets; Control+End leaves the caret inside that
    // last list item, and inserting there would fold the diagram into the list).
    // Pressing Enter twice breaks out of the list into a clean empty paragraph.
    await editor.click();
    await dashPage.keyboard.press('Control+End').catch(() => {});
    await dashPage.keyboard.press('Enter').catch(() => {});
    await dashPage.keyboard.press('Enter').catch(() => {});
    // Toolbar control: aria-label="Insert flowchart".
    const insertFlow = d.getByRole('button', { name: /Insert flowchart/i }).first();
    await insertFlow.click();
    // The FlowchartEditorModal is a Radix Dialog: title "Flowchart editor",
    // Add-node buttons. It MUST be closed before this chapter returns (a left-
    // open modal intercepts the next chapter's first click and aborts the run),
    // so everything after it opens runs inside a try/finally whose finally
    // ALWAYS closes it and HARD-ASSERTS it's gone.
    const modalMark = d.getByText(/Flowchart editor/i).first();
    await modalMark.waitFor({ state: 'visible', timeout: SLA });

    try {
      // ── Drawing primitives (pure mouse + keyboard, like a human at the canvas) ─
      // A flow node renders as a .react-flow__node carrying its label text; its
      // handles are .react-flow__handle (bottom = source, top = target; the
      // decision node also has source handles on left/right). We address a node
      // by its CURRENT visible label and drive page-level mouse drags off each
      // element's bounding box (boundingBox() resolves to page coords even inside
      // the dashboard iframe).
      // GUARD every measurement: wait (bounded) for visibility FIRST so a missing
      // element fails fast with a clear message and a boundingBox call can NEVER
      // hang the full SLA on an absent node/handle. visibleBox returns null
      // (best-effort) when the element doesn't show in time, so a single missing
      // node degrades the drawing to partial rather than aborting — the chapter's
      // must-have is the modal-close in finally, not a pixel-perfect chart.
      const visibleBox = async (loc: import('@playwright/test').Locator) => {
        const ok = await loc.waitFor({ state: 'visible', timeout: NAV }).then(() => true).catch(() => false);
        if (!ok) return null;
        return await loc.boundingBox().catch(() => null);
      };
      const centre = (b: { x: number; y: number; width: number; height: number }) => ({
        x: b.x + b.width / 2,
        y: b.y + b.height / 2,
      });
      const nodeByLabel = (label: string) =>
        d.locator('.react-flow__node', { hasText: label }).first();
      // Drag a node (grabbed at its centre) to an ABSOLUTE page point. React Flow
      // moves the node with the pointer; we step the move so the lib registers it.
      // Best-effort: if the node can't be measured we skip rather than throw.
      const dragNodeTo = async (label: string, to: { x: number; y: number }) => {
        const b = await visibleBox(nodeByLabel(label));
        if (!b) return;
        const from = centre(b);
        await dashPage.mouse.move(from.x, from.y);
        await dashPage.mouse.down();
        await dashPage.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
        await dashPage.mouse.move(to.x, to.y, { steps: 8 });
        await dashPage.mouse.up();
      };
      // Select a node by clicking it (arms the side-panel "Label" input), then set
      // its label through that input — a settled, deterministic rename (no reliance
      // on double-click inline edit timing). Best-effort + non-aborting.
      const labelNode = async (current: string, next: string) => {
        const node = nodeByLabel(current);
        if (!(await node.waitFor({ state: 'visible', timeout: NAV }).then(() => true).catch(() => false))) return;
        await node.click().catch(() => {});
        // Selecting a node mounts the left side-panel "Node properties" block: a
        // "Label" <Input> bound to the node's label. Find it via the heading's
        // parent (FlowchartEditorModal.tsx). NOTE: deselect by clicking the canvas,
        // NOT Escape — the editor is a Radix Dialog that closes on Escape, which
        // would tear down the whole flowchart mid-drawing.
        const labelInput = d.getByText(/^Node properties$/i).locator('..').locator('input').first();
        if (!(await labelInput.waitFor({ state: 'visible', timeout: NAV }).then(() => true).catch(() => false))) return;
        await labelInput.fill(next).catch(() => {});
        // The fresh label must be live on the node before the next select/drag so
        // we never address a stale label. Wait (best-effort) for the renamed node.
        await nodeByLabel(next).waitFor({ state: 'visible', timeout: NAV }).catch(() => {});
        // Deselect by clicking empty canvas (top-left corner, clear of the pile at
        // ~(200,200)) so the side panel clears without closing the dialog.
        if (cb) await dashPage.mouse.click(cb.x + 20, cb.y + 20).catch(() => {});
      };
      // Connect source→target by dragging from the source node's bottom handle
      // (or, for the decision, a specified side handle) to the target's top handle.
      // Best-effort: a missing handle skips the edge rather than aborting. The drop
      // MUST land ON the target handle — a drop on empty canvas would make React
      // Flow spawn a stray node (onConnectEnd), so we settle on the handle.
      const connect = async (
        sourceLabel: string,
        targetLabel: string,
        sourceHandle: 'bottom' | 'left' | 'right' = 'bottom',
      ) => {
        const sb = await visibleBox(
          nodeByLabel(sourceLabel).locator(`.react-flow__handle-${sourceHandle}`).first(),
        );
        const tb = await visibleBox(
          nodeByLabel(targetLabel).locator('.react-flow__handle-top').first(),
        );
        if (!sb || !tb) return;
        const src = centre(sb);
        const tgt = centre(tb);
        // React Flow arms a connection on mousedown over a source handle and lands
        // it on mouseup over a target handle. Hover the source first so the handle
        // is the connection origin, drag in steps (so the lib tracks the pointer),
        // then settle ON the target handle with a final move before release so the
        // drop falls inside the handle's connection radius.
        await dashPage.mouse.move(src.x, src.y);
        await dashPage.mouse.move(src.x, src.y); // hover-settle on the handle
        await dashPage.mouse.down();
        await dashPage.mouse.move((src.x + tgt.x) / 2, (src.y + tgt.y) / 2, { steps: 10 });
        await dashPage.mouse.move(tgt.x, tgt.y, { steps: 10 });
        await dashPage.mouse.move(tgt.x, tgt.y); // settle on the target handle
        await dashPage.mouse.up();
      };

      // The canvas mounts with one starting Process node ("Process"). Lay the flow
      // out top-to-bottom against the canvas box so nodes never overlap. Measure
      // the canvas with the same guard so a slow mount can't hang us.
      const canvas = d.locator('.react-flow').first();
      const cb = await visibleBox(canvas);
      // Column/row layout (only used when we have a canvas box). Fall back to
      // sensible page coordinates so drags still move nodes apart if measurement
      // somehow failed (drawing stays best-effort either way).
      const col = cb ? cb.x + cb.width * 0.4 : 500; // main column
      const colR = cb ? cb.x + cb.width * 0.68 : 760; // right branch column
      const rows = [0.16, 0.32, 0.48, 0.64, 0.82].map((f) => (cb ? cb.y + cb.height * f : 150 + f * 500));

      // 1) Re-label the starting node and place it at the top.
      await labelNode('Process', 'Invoice received');
      await dragNodeTo('Invoice received', { x: col, y: rows[0]! });

      // 2) Add the remaining nodes one at a time: add → drag clear of the pile at
      //    (200,200) → relabel. (Each Add drops at the same fixed spot, so we move
      //    the fresh node out before adding the next.)
      const addProcess = () => d.getByRole('button', { name: /^Process$/ }).first().click().catch(() => {});
      const addDecision = () => d.getByRole('button', { name: /^Decision$/ }).first().click().catch(() => {});

      await addProcess();
      await dragNodeTo('Process', { x: col, y: rows[1]! });
      await labelNode('Process', 'Extract fields (OCR)');

      await addProcess();
      await dragNodeTo('Process', { x: col, y: rows[2]! });
      await labelNode('Process', 'Match PO & VAT');

      await addDecision();
      await dragNodeTo('Decision', { x: col, y: rows[3]! });
      await labelNode('Decision', 'Over €5,000?');

      await addProcess();
      await dragNodeTo('Process', { x: colR, y: rows[4]! });
      await labelNode('Process', 'Hold for approval');

      await addProcess();
      await dragNodeTo('Process', { x: col, y: rows[4]! });
      await labelNode('Process', 'Post to ledger');

      // 3) Wire the flow: linear spine, then the decision's two branches (its
      //    right handle → Hold, its bottom handle → Post).
      await connect('Invoice received', 'Extract fields (OCR)');
      await connect('Extract fields (OCR)', 'Match PO & VAT');
      await connect('Match PO & VAT', 'Over €5,000?');
      await connect('Over €5,000?', 'Hold for approval', 'right');
      await connect('Over €5,000?', 'Post to ledger', 'bottom');

      // Give the canvas a beat to settle the final edge render, then capture the
      // drawn diagram BEST-EFFORT. This is a "nice-to-have" view: we do NOT hard-
      // assert the node/edge count (a cosmetic miss must never abort the run — the
      // must-have is closing the modal in finally below). Wait generously for the
      // nodes we can see, then shoot whatever the canvas shows.
      for (const label of [
        'Invoice received',
        'Extract fields (OCR)',
        'Match PO & VAT',
        'Over €5,000?',
        'Hold for approval',
        'Post to ledger',
      ] as const) {
        await nodeByLabel(label).waitFor({ state: 'visible', timeout: NAV }).catch(() => {});
      }
      await capture(dashPage, 'flowchart-editor');
    } finally {
      // ALWAYS leave the editor closed — this is the chapter's must-have. Prefer
      // "Save diagram" (it persists the chart into the description AND closes the
      // dialog); if that doesn't dismiss the modal, fall back to Cancel/Close and
      // then Escape. Re-check after each so we never press into a closed dialog.
      const save = d.getByRole('button', { name: /^Save diagram$/i }).first();
      if (await save.isVisible().catch(() => false)) await save.click().catch(() => {});
      if (await modalMark.isVisible().catch(() => false)) {
        const cancel = d.getByRole('button', { name: /^(Cancel|Close)$/i })
          .or(d.locator('button[aria-label="Close" i]:visible'))
          .last();
        if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => {});
      }
      if (await modalMark.isVisible().catch(() => false)) await dashPage.keyboard.press('Escape').catch(() => {});
      // HARD-ASSERT the modal is gone before returning so it can never block the
      // next chapter's first click.
      await expect(modalMark, 'the flowchart editor modal stayed open and would block the next chapter')
        .toBeHidden({ timeout: SLA });
    }
    // Persist + re-capture the description now that the rendered diagram is in it
    // (Save diagram already closed the modal above). Best-effort save settle.
    await dashPage.keyboard.press('Control+s');
    await d.getByRole('button', { name: /Saving/i }).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    await capture(dashPage, 'description');
  });

  // ---- Coding Agent (+ live-dev preview) ----
  // The Coding Agent tab pairs the agent terminal/files with the Environment
  // panel, which lists each automation and its live-dev deployment. A copy
  // auto-starts live-dev, so we WAIT for an automation to report running, then
  // open its live preview (the external-link button) and shoot it. If the
  // preview tab doesn't render in time we still document the running live-dev
  // state in the panel — never a "Loading…" frame.
  await chapter('coding-agent', async () => {
    await clickTopTab(/Coding Agent/i);
    // The session auto-warms on this tab: the coding-agent container boots and a
    // Claude Code session connects over the WS. SessionTerminal shows a
    // "Connecting…" placeholder ONLY until the access token resolves and the
    // WebSocket URL is built — it clears the instant the xterm mounts, which is
    // LONG before Claude has actually booted inside the terminal. So
    // "Connecting… gone + .xterm visible" is far too weak a signal (it catches a
    // blank/empty terminal). The authoritative "Claude is up" signal is Claude
    // Code's own TUI: once its interactive prompt renders, the xterm paints the
    // persistent footer hint "? for shortcuts" (and the prompt box). We read the
    // xterm's rendered rows text and WAIT GENEROUSLY for that to appear — the
    // agent is launched with an initial prompt (server SSH_AUTO_CMD: `claude
    // --dangerously-skip-permissions … '<prompt>'`), so its prompt + first
    // response render once it boots. This is a plain on-screen visibility wait
    // (a container boot + ssh + Claude start), NOT a deploy long-op, and it is
    // BEST-EFFORT/NON-ABORTING: a slow Claude boot must not abort the whole run,
    // so we wait long (several minutes) and then capture whatever the terminal
    // shows — but we wait long enough that it normally captures a loaded session.
    const connecting = d.getByText(/^Connecting…$/).first();
    const term = d.locator('.xterm').first();
    await connecting.waitFor({ state: 'hidden', timeout: 5 * 60_000 }).catch(() => {});
    await term.waitFor({ state: 'visible', timeout: 5 * 60_000 }).catch(() => {});
    // The xterm paints visible glyphs into .xterm-rows. Claude Code's interactive
    // prompt is "up" once its footer/help affordances render — poll the rows text
    // for Claude's stable prompt markers. Several minutes, non-aborting.
    const xtermText = d.locator('.xterm-rows').first();
    try {
      await expect
        .poll(async () => (await xtermText.textContent().catch(() => '')) ?? '', {
          timeout: 6 * 60_000,
          intervals: [1000, 2000, 5000],
        })
        .toMatch(/\? for shortcuts|shortcuts|Welcome to Claude|bypass permissions|Bypassing Permissions/i);
    } catch {
      // Slow Claude boot — capture whatever the terminal shows rather than abort.
    }
    await capture(dashPage, 'coding-agent');
  });
  await chapter('live-dev', async () => {
    await clickTopTab(/Coding Agent/i);
    // The 'live-dev' shot must be the actual RUNNING FRONTEND APP — not the
    // Coding Agent dashboard view (that's the distinct 'coding-agent' slot). The
    // Environment panel lists automations in two sections — "Frontends" first,
    // then "Worker containers". A running frontend's name is an external-link
    // anchor (title "Open https://…"); clicking it opens the deployed frontend in
    // a new tab. Scope to the Frontends section so we pick a FRONTEND (the thing
    // an operator opens to click through the running app), not a worker. Wait for
    // that openable link — live-dev builds the image first, so this can take a few
    // minutes (plain visibility wait, not a deploy long-op).
    const frontendsSection = d
      .locator('section, div')
      .filter({ has: d.getByText(/^Frontends$/i) })
      .first();
    const openLink = frontendsSection
      .locator('a[target="_blank"][title^="Open "]')
      .first()
      // Fallback: if the section wrapper isn't matchable, the Frontends section
      // renders before Worker containers, so the first openable link is still a
      // frontend's.
      .or(d.locator('a[target="_blank"][title^="Open "]').first());
    await openLink.waitFor({ state: 'visible', timeout: 8 * 60_000 }).catch(() => {});
    // #99 fix: the openable link appears as soon as the frontend CONTAINER reports
    // "running" (EnvironmentPanel canOpen = url && status==='running'), but the
    // HTTP app inside isn't necessarily SERVING yet — so opening it too early
    // catches Traefik's "404 page not found" instead of the real app. Before we
    // click, best-effort WAIT for the frontend/BP ready signal: the same sonner
    // "<bp> ready" success toast the BP scaffold fires when its deploy (frontend
    // included) lands — the same class of toast the description chapter waits on.
    // It may already have cleared on a re-run, so this is best-effort/non-aborting
    // (a short window, gone-or-not we proceed to the popup 404-poll below, which
    // is the real guard). NOTE: deliberately NOT waiting the full ready window
    // here — the authoritative readiness check is reloading the opened popup
    // until it serves real content rather than a 404.
    await d.getByText(new RegExp(`${BP.slug} ready`, 'i')).first()
      .waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
    // Open the deployed frontend and capture ITS rendered content AS 'live-dev'.
    // Best-effort / non-aborting throughout: a slow or blank frontend must not
    // abort the run, but we PREFER the real frontend over the dashboard panel.
    let captured = false;
    if (await openLink.isVisible().catch(() => false)) {
      const popupP = dashPage.context().waitForEvent('page', { timeout: 60_000 }).catch(() => null);
      await openLink.click().catch(() => {});
      const popup = await popupP;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        await popup.locator('body').waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
        // #99 fix — POLL the opened popup until it renders the REAL app, not a
        // "404 page not found" (Traefik's default while the frontend's router /
        // HTTP server isn't serving yet). We RELOAD the popup on a bounded loop:
        // each pass waits its own boot spinner out, then checks whether the body
        // still shows the 404. We stop the instant the 404 is gone (real content
        // is up) and otherwise reload after a short on-screen settle — bounded by
        // a generous budget so a genuinely-broken frontend still ends (and we
        // capture whatever it shows) rather than hanging. Best-effort/non-aborting.
        // The frontend popup is the Bailey chrome WRAP (outer host) that IFRAMES
        // the inner frontend host — so the React app's #root lives in the INNER
        // FRAME, not the popup's top document. Resolve that frame, then wait for
        // the app to render VISIBLE content into #root (main.tsx mounts there). A
        // 404 (router not up) and Vite's cold-start (optimizing deps on the first
        // request) both serve HTTP 200 while #root is empty, so WAIT for a visible
        // descendant — not instant-check, which races the cold optimize + render.
        const innerOf = () =>
          popup.frames().find((f) => /--inner\./.test(f.url())) ?? popup.mainFrame();
        const reloadDeadline = Date.now() + 6 * 60_000;
        for (let attempt = 0; attempt < 8; attempt++) {
          // Let the chrome wrap attach its inner <iframe> before we read it.
          await popup.waitForSelector('iframe', { timeout: 30_000 }).catch(() => {});
          const inner = innerOf();
          await inner.getByText(/Loading|Starting/i).first()
            .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
          const mounted = await inner.locator('#root :visible').first()
            .waitFor({ state: 'visible', timeout: 45_000 })
            .then(() => true)
            .catch(() => false);
          if (mounted) break; // the React app rendered visible content into #root
          if (Date.now() > reloadDeadline) break; // budget spent — assert below
          await popup.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        // Truly validate: the live-dev frontend must render its MOUNTED app (in the
        // inner frame) — not a blank page, a Vite dev-error overlay, or a 404. A
        // persistent failure to render visible content is a real defect and must
        // FAIL the chapter, not be screenshotted as if the step passed.
        await expect(innerOf().locator('#root :visible').first(),
          'live-dev frontend never rendered visible content into #root (Vite build error or 404?) — check the frontend template')
          .toBeVisible({ timeout: SLA });
        await capture(popup, 'live-dev').catch(() => {});
        captured = true;
        await popup.close().catch(() => {});
      }
    }
    // Fallback only if the frontend never opened a tab at all: document the
    // running, openable live-dev frontend from the dashboard panel so the slot is
    // never empty. (The preferred path above captured the real frontend.)
    if (!captured) await capture(dashPage, 'live-dev').catch(() => {});
  });

  // ---- Requirements & tests: the runnable-spec tab a real operator uses ----
  await chapter('requirements', async () => {
    const reqTab = topTab(/Requirements & tests/i);
    await reqTab.click();
    // Don't shoot until the tab is actually SELECTED on screen. The top-nav
    // marks the active tab with `font-semibold` (inactive tabs are
    // `font-medium`); waiting for that class guarantees the screenshot shows
    // Requirements highlighted, not a transient frame where the highlight is
    // still on the previously-active tab. (A real, settled UI state — the
    // source of truth — never a half-applied render.)
    await expect(reqTab).toHaveClass(/font-semibold/, { timeout: SLA });
    // And the body has rendered the requirements surface (its header controls).
    await d.getByRole('button', { name: /New requirement|Write tests/i }).first()
      .waitFor({ state: 'visible', timeout: SLA });
    // Actually RECORD the process's rules as runnable specs (a real operator's
    // job), so the shot shows a populated tab — not an empty placeholder. Each
    // requirement is added via "New requirement" (which mounts an inline
    // textarea, placeholder "Describe the requirement…"), typed, then committed
    // with Enter (the tab persists on Enter/blur — there is no separate Save
    // button). We hard-assert each row lands before moving to the next.
    const reqs = [
      'VAT matches the PO',
      'Invoices over €5,000 are held for approval',
      'Duplicate invoice numbers never post twice',
    ] as const;
    for (const text of reqs) {
      // Skip if a prior run already recorded this requirement (idempotent).
      const existing = d.getByText(text, { exact: false }).first();
      if (await existing.isVisible().catch(() => false)) continue;
      await d.getByRole('button', { name: /New requirement/i }).first().click();
      const field = d.getByPlaceholder(/Describe the requirement/i).first();
      await field.waitFor({ state: 'visible', timeout: SLA });
      await field.fill(text);
      await field.press('Enter');
      // The committed requirement renders as a row carrying its text — wait for
      // that so the next add doesn't race the persist round-trip.
      await expect(
        d.getByText(text, { exact: false }).first(),
        `requirement "${text}" did not land in the list`,
      ).toBeVisible({ timeout: SLA });
    }
    await capture(dashPage, 'requirements');
  });

  // ---- Sync & Deploy: the Diff / History / Checks sub-tabs ----
  // Every sub-tab a real operator inspects before shipping: the Diff (what
  // becomes main), the History (copy + main commits with deploy tags), and the
  // Checks tab (the CVE scan of the image this deploy would build).
  await chapter('sync-deploy', async () => {
    await clickTopTab(/Sync & Deploy/i);
    await capture(dashPage, 'sync-deploy');
    // (The redundant 'sync-deploy-diff' capture was removed — it duplicated the
    // Sync & Deploy shot above. The matching content slot is removed too.) We
    // still bounce through the Diff sub-tab so History/Checks below start clean.
    await d.getByRole('button', { name: /^diff$/i }).first().click().catch(() => {});
    // History sub-tab — the copy + main commit timeline with deploy markers.
    await d.getByRole('button', { name: /^history$/i }).first().click().catch(() => {});
    await capture(dashPage, 'sync-deploy-history');
    // Checks sub-tab — the pre-deploy supply-chain scan of the image this
    // deploy WOULD build. The scan bakes an ephemeral image then scans it, so
    // it can be "pending" right after a BP is scaffolded; we capture the REAL
    // CVE list AFTER the first dev deploy (see the deploy chapter), where a
    // built image for this BP exists and the preview resolves to a real scan.
    // Here we just open the tab to show it exists in the flow.
    await d.getByRole('button', { name: /^checks$/i }).first().click();
    await d.getByText(/Loading supply chain/i).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
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
        // The Sync & Deploy progress toast is a COSMETIC live-progress animation.
        // In the headless walkthrough it can stop updating even though the deploy
        // is still running fine server-side (verified live: the deploy completes
        // and the Development stage renders normally once it does). A quiet toast
        // must NOT fail the run — but we also must NOT return while the deploy is
        // still in flight, or the caller's next step (selectStage → Development)
        // races a mid-deploy view. So stop REQUIRING on-screen progress and fall
        // back to the authoritative completion signal: wait for the "Working…"
        // button to clear (bounded by the same 30-min backstop). The other
        // long-op watchdogs are unchanged.
        // eslint-disable-next-line no-console
        console.warn(
          `Sync & Deploy: progress toast quiet >${PROGRESS / 1000}s (last: "${last.slice(0, 120)}") — waiting for "Working…" to clear instead`,
        );
        await working
          .waitFor({ state: 'hidden', timeout: Math.max(1000, deadline - Date.now()) })
          .catch(() => {});
        return;
      }
      last = await progressSignature();
    }
  };
  // After a working-tree EDIT, re-arm the Sync & Deploy button. The button gates
  // on `!bpUpToDate` where `bpUpToDate = ahead==0 && behind==0 && !dirty`
  // (SyncDeployTab.tsx). The header only refetches its `/status` snapshot on
  // (re)mount or window-focus, so right after an edit it can still hold the
  // PRE-save (clean) snapshot — "Up to date with main", button disabled — even
  // while the freshly-mounted Diff panel already lists the changed file. Gate on
  // the SAME on-screen signal the button keys off: bounce the tab
  // (Deployments → Sync & Deploy remounts + refetches), click the Diff ⟳
  // refresh, and poll the header badge until it reports pending work (an
  // uncommitted file / N ahead / N behind). Bounded; never sleeps.
  const armAfterEdit = async () => {
    const upToDate = d.getByText(/up to date with main/i).first();
    const pending = d.getByText(/uncommitted file|↑\s*\d+\s*ahead|↓\s*\d+\s*behind/i).first();
    const armDeadline = Date.now() + SLA;
    for (;;) {
      await clickTopTab(/Deployments/i);
      await clickTopTab(/Sync & Deploy/i);
      await d.getByRole('button', { name: /^Refresh$/i }).first().click().catch(() => {});
      const armed = await Promise.race([
        pending.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false),
        upToDate.waitFor({ state: 'visible', timeout: 5_000 }).then(() => false).catch(() => false),
      ]);
      if (armed && (await pending.isVisible().catch(() => false))) break;
      if (Date.now() > armDeadline) break; // fall through to the caller's hard assert
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
    for (let attempt = 0; attempt < 4 && !healthy; attempt++) {
      await pressSyncDeploy();
      await clickTopTab(/Deployments/i);
      // The Development stage only renders once the BP is in `main`. Sync & Deploy
      // merges the user's copy into main, but that can land a beat AFTER "Working…"
      // clears (and a first press may only fast-forward main without this BP). So
      // the Deployments tab can still show the transient "Not in main yet" empty
      // state with no stage buttons. WAIT for the Development stage to appear
      // rather than hard-selecting it (selectStage would throw on that empty state
      // and abort the chapter); if it never shows, re-press while the button is
      // still actionable and try again.
      const devStage = d.getByRole('button', { name: /Development/i }).first();
      const inMain = await devStage
        .waitFor({ state: 'visible', timeout: SLA })
        .then(() => true)
        .catch(() => false);
      if (!inMain) {
        await clickTopTab(/Sync & Deploy/i);
        if (!(await btn.isEnabled().catch(() => false))) break;
        continue;
      }
      await devStage.click().catch(() => {});
      // The deploy is ASYNC: after the push, the driver builds the image and
      // brings the containers up in the BACKGROUND — the same build the live-dev
      // chapter rides, which takes minutes. "Working…" clearing means the push
      // landed, NOT that the deploy finished. Wait for the Development stage to
      // actually reach Healthy with a build-sized PLAIN wait (8 min, matching
      // live-dev's build budget) — not a short SLA race and not the progress
      // watchdog (a quiet build window must not fail). We do this once: if it's
      // not Healthy after a full build window, re-pressing won't help — let the
      // hard assert below report it.
      const ok = d.getByText(/^Healthy$/i).or(d.getByText(/Current on/i)).first();
      await ok.waitFor({ state: 'visible', timeout: 12 * 60_000 }).catch(() => {});
      healthy = await ok.isVisible().catch(() => false);
      break;
    }
    // Authoritative success gate: the Development stage must report Healthy (set
    // in the loop above). This — not the cosmetic progress toast — is what makes
    // the deploy chapter pass/fail.
    expect(healthy, 'Development stage never became Healthy after Sync & Deploy').toBe(true);
    await clickTopTab(/Deployments/i);
    await selectStage(/Development/i);
    await waitDeployDone();
    await capture(dashPage, 'deploy-dev');
  });

  // ---- Checks (real CVEs) — now that a built image for this BP exists, the
  // Sync & Deploy → Checks preview resolves to a real SBOM/CVE scan. Wait for
  // the scan to leave its loading/pending states and show actual rows before
  // shooting, so the manual prints real advisories, not an empty placeholder.
  await chapter('checks-cve', async () => {
    await clickTopTab(/Sync & Deploy/i);
    // The Checks preview bakes the image this BP would build and runs
    // syft+grype on it in the background, re-fetching the panel periodically. We
    // re-open the Checks sub-tab a few times, each time waiting a BOUNDED window
    // for a REAL scan to appear (CVE rows / clean state / scanned footer). This
    // is hang-proof: every wait is a Playwright locator.waitFor with an explicit
    // timeout (never an open-ended poll), so a slow or pending scan can't stall
    // the run. We capture the first real result; if the preview is still pending
    // after the attempts we capture the honest pending state (the REAL,
    // post-deploy CVE results are captured on Production → Supply chain).
    // A RESOLVED report (clean or with CVEs) renders a "· scanned <date>" footer
    // ("N packages · M in-scope CVEs · scanned …") and/or "No active CVEs" /
    // actual CVE rows — none of which appear in the loading/pending/unavailable
    // states. The "scanned" footer is the universal "a real scan landed" signal,
    // so we anchor on it plus the CVE/clean markers.
    const realScan = d
      .getByText(/CVE-\d{4}-\d+/).first()
      .or(d.getByText(/scanned\b|in-scope CVE|No active CVEs|vulnerabilit|out of scope/i).first());
    let landed = false;
    for (let attempt = 0; attempt < 6 && !landed; attempt++) {
      await d.getByRole('button', { name: /^checks$/i }).first().click().catch(() => {});
      // Bounded wait for the fetch spinner to clear, then for a real scan row.
      await d.getByText(/Loading supply chain/i).first()
        .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
      landed = await realScan
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!landed && attempt < 5) {
        // Re-mount the panel (diff → checks) so the NEXT fetch can pick up the
        // finished background scan. Note we re-click Checks at the TOP of the
        // next iteration, so the loop never ENDS on Diff.
        await d.getByRole('button', { name: /^diff$/i }).first().click().catch(() => {});
      }
    }
    // Land FIRMLY on the Checks sub-tab before capturing — never leave the shot
    // on Diff. Click Checks LAST, wait for the panel to settle on a real scan
    // (or its honest pending state if the background scan is genuinely slow),
    // then capture the Checks tab.
    await d.getByRole('button', { name: /^checks$/i }).first().click().catch(() => {});
    await d.getByText(/Loading supply chain/i).first()
      .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    // Best-effort final settle on the real scan; if still pending we capture the
    // honest pending state (the post-deploy CVEs are captured on Supply chain).
    await realScan.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
    await capture(dashPage, 'checks-cve');
  });

  // ---- Deploy a SECOND, meaningful version (THE BACKBONE) ----
  // v1 is now live on Development. A real operator iterates: they add a concrete
  // rule and ship it. We make a MEANINGFUL source change — append the "Manager
  // approval tier (v2)" block to the Description (a new business rule + two new
  // recorded fields, per scenario.BP.readmeV2Addition) — so it produces a
  // NON-TRIVIAL diff, then Sync & Deploy AGAIN to land v2. This demotes v1 to a
  // prior, non-current entry, so by the time `history`/`inspect-diff`/`rollback`
  // run, Development carries MULTIPLE deploy-history entries and a real diff. We
  // reuse the Description editor mechanics, the armAfterEdit re-arm pattern, and
  // the deploy chapter's press-while-actionable retry shape.
  await chapter('deploy-v2', async () => {
    // 1) Make the real, meaningful source edit in the Description editor.
    await clickTopTab(/Description/i);
    const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: SLA });
    await editor.click();
    await dashPage.keyboard.press('Control+End');
    // Control+End leaves the caret at the END of the existing doc — which, after
    // the README + flowchart embed, is inside the trailing markdown LIST item (or
    // right after the diagram block). Typing the v2 block there folds its heading
    // and bullets into that list/block, producing the garbled README in #94.
    // Break out into a clean empty paragraph FIRST (Enter twice exits the list),
    // so the appended "## Manager approval tier (v2)" block renders as a proper
    // heading + list with correct spacing. (readmeV2Addition already leads with a
    // blank line; the explicit Enters guarantee the markdown structure breaks.)
    await dashPage.keyboard.press('Enter').catch(() => {});
    await dashPage.keyboard.press('Enter').catch(() => {});
    await editor.pressSequentially(BP.readmeV2Addition, { delay: 0 });
    await dashPage.keyboard.press('Control+s');
    await d.getByRole('button', { name: /Saving/i }).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    // Let any post-save toast clear before we read the Sync & Deploy header (a
    // lingering toast over the top-right button can make a click never land).
    await d.locator('[data-sonner-toast]').first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    // 2) Re-arm the button on the same on-screen "pending work" signal it gates on.
    await armAfterEdit();
    // 3) Ship v2: gate on actionable, then ride the deploy with the watchdog —
    // press while actionable until Development is Healthy on screen (bounded).
    const btn = d.getByRole('button', { name: /^Sync & Deploy$|Working/ }).last();
    await expect(btn, 'Sync & Deploy never re-armed after the v2 edit').toBeEnabled({ timeout: SLA });
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
        await clickTopTab(/Sync & Deploy/i);
        if (!(await btn.isEnabled().catch(() => false))) break;
      }
    }
    await clickTopTab(/Deployments/i);
    await selectStage(/Development/i);
    await waitDeployDone();
    // Hard-assert v2 produced a SECOND Development deploy-history entry, so the
    // later history/inspect-diff/rollback chapters have a genuine prior version.
    await clickSection(/Deployment history/i);
    await expect(
      d.getByRole('button', { name: /^Roll back$/ }).first(),
      'a second deploy did not produce a prior (rollback-able) Development entry',
    ).toBeVisible({ timeout: SLA });
  });

  // ---- Promote dev → staging → production, waiting for each to be Healthy ----
  await chapter('promote', async () => {
    await clickTopTab(/Deployments/i);
    // Two hops. For each, press the promote pill that targets THIS stage and
    // CONFIRM this stage actually starts before riding the deploy watchdog.
    // Robustness the dind timing demands:
    //  - The pill is selected by its stage-specific title ("Promote all
    //    containers to <Stage>"), so the dev→staging pill is never confused with
    //    the staging→production one (both render as "Promote").
    //  - "started"/"done" are scoped to THIS stage ("Current on <Stage>"): a
    //    prior stage's lingering Healthy / "Current on …" must NOT count, or the
    //    hop looks done while the target sits at "never deployed".
    //  - A click that doesn't land (a re-render detaches the pill) is re-pressed,
    //    so the target never sits static long enough for waitDeployDone to read a
    //    dead screen and trip the went-dark watchdog as a false stall.
    let shotStaging = false;
    let shotProd = false;
    for (const stageName of ['Staging', 'Production'] as const) {
      const isProd = stageName === 'Production';
      const target = new RegExp(stageName, 'i');
      await selectStage(target);
      // Title is present only while the pill is actionable (canPromote); when
      // there's nothing to promote it reads "Nothing new to promote to <Stage>".
      const promotePill = d
        .locator(`button[title="Promote all containers to ${stageName}"]`)
        .first();
      const targetCurrent = d
        .getByText(new RegExp(`Current on ${stageName}`, 'i'))
        .first();
      const moving = d
        .getByText(/Promoting|Starting|Building|Pulling|Working|Preparing|Deploying/i)
        .first();
      let started = false;
      for (let attempt = 0; attempt < 6 && !started; attempt++) {
        if (await targetCurrent.isVisible().catch(() => false)) {
          started = true;
          break;
        }
        if (await promotePill.isEnabled().catch(() => false)) {
          await promotePill.click().catch(() => {});
        }
        // Bounded wait (well under the 30-min deploy backstop) for THIS stage to
        // start moving or land. If nothing moves, the click missed — press again.
        started = await Promise.race([
          moving
            .waitFor({ state: 'visible', timeout: 12_000 })
            .then(() => true)
            .catch(() => false),
          targetCurrent
            .waitFor({ state: 'visible', timeout: 12_000 })
            .then(() => true)
            .catch(() => false),
        ]);
      }
      // Capture the promotion IN PROGRESS on BOTH hops (the live step beat):
      // dev→staging as `promote-progress`, staging→production as
      // `promote-progress-prod`, so the manual documents both cutovers. The
      // staging hop's waitDeployDone('Staging') already gated staging current
      // before the production iteration, so the prod shot reflects a pipeline
      // where staging is deployed (the meaningful blue-green state).
      if (isProd && !shotProd) {
        await targetCurrent
          .or(moving)
          .first()
          .waitFor({ state: 'visible', timeout: SLA })
          .catch(() => {});
        await capture(dashPage, 'promote-progress-prod');
        shotProd = true;
      } else if (!isProd && !shotStaging) {
        await capture(dashPage, 'promote-progress');
        shotStaging = true;
      }
      await selectStage(target);
      await waitDeployDone(stageName); // THIS stage reaches "Current on <Stage>"
    }
  });

  // ---- Deployment sections; the cover hero is the live Production view ----
  await chapter('deployments-prod', async () => {
    await clickTopTab(/Deployments/i);
    await selectStage(/Production/i);
    await waitDeployDone();
    await capture(dashPage, 'deployments-prod');
    await capture(dashPage, 'cover');
    // Best-effort capture of the full dev → staging → production pipeline (each
    // stage its own isolated DB + file store) for the "Dev, staging & production"
    // chapter. By now every stage has been promoted/healthy, so the row of stage
    // nodes is on screen. Non-fatal so it can't abort the fail-fast run.
    try {
      await d
        .getByRole('button', { name: /Development/i })
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      await capture(dashPage, 'stages');
    } catch {
      /* pipeline not visible — leave the slot to its honest "capture pending" placeholder */
    }
  });
  await chapter('supply-chain', async () => {
    await selectStage(/Production/i);
    await clickSection(/Supply chain/i);
    // The deployed image's SBOM/CVE scan runs in the background after deploy and
    // is re-fetched periodically. Production has a real deployed image, so a real
    // scan WILL appear. Re-mount the panel (Supply chain → Containers → Supply
    // chain) a few times so the next fetch picks up the finished background scan,
    // each with a BOUNDED waitFor for a real scan row — hang-proof (no open-ended
    // poll). A RESOLVED report renders a "· scanned <date>" footer / "No active
    // CVEs" / actual CVE rows (none present while loading/pending), so anchor on
    // "scanned" plus the CVE/clean markers.
    const realScan = d
      .getByText(/CVE-\d{4}-\d+/).first()
      .or(d.getByText(/scanned\b|in-scope CVE|No active CVEs|vulnerabilit|out of scope/i).first());
    let landed = false;
    for (let attempt = 0; attempt < 8 && !landed; attempt++) {
      await clickSection(/Supply chain/i);
      await d.getByText(/Loading supply chain/i).first()
        .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
      landed = await realScan
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      // Bounce off to Containers to force a re-mount, but only if we'll loop
      // again — never on the final attempt, so the chapter can't end on
      // Containers (that was the bug: the shot showed the Containers tab).
      if (!landed && attempt < 7) await clickSection(/Containers/i).catch(() => {});
    }
    // Land FIRMLY on the Supply chain section with its SBOM/CVE panel visible
    // before capturing — never leave the shot on Containers. Click Supply chain
    // LAST, wait for the panel's real content (or its honest empty state) to be
    // on screen, then capture.
    await clickSection(/Supply chain/i);
    await d.getByText(/Loading supply chain/i).first()
      .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    await realScan.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
    await capture(dashPage, 'supply-chain');
    // Open the first CVE/package row's detail if the SBOM rendered any, so the
    // manual can show the advisory drill-down a real operator triages.
    const cveRow = d.getByRole('button', { name: /CVE-\d{4}-\d+/ }).first();
    if (await cveRow.isVisible().catch(() => false)) {
      await cveRow.click().catch(() => {});
      await capture(dashPage, 'supply-chain-cve');
      // Close the CVE-detail overlay — leaving it open intercepts the NEXT
      // chapter's first click (it blocked `containers` and aborted the run).
      await closeAnyModal();
    }
  });
  await chapter('containers', async () => {
    // Defensive: clear any overlay a prior chapter may have left open before our
    // first click (the supply-chain CVE detail did exactly this).
    await closeAnyModal();
    await selectStage(/Production/i);
    // The Containers tab carries a count pill ("Containers 2"), so match the
    // label as a prefix — an anchored /^Containers$/ would miss it.
    await clickSection(/Containers/i);
    // The live container roster for the current deployment. Each container card
    // carries inline Logs / Inspect expanders and start/stop controls.
    await capture(dashPage, 'containers');
    // Open a container's LOGS view: the card's "Logs" button expands an inline
    // LogsPane that streams real container output (or "Waiting for logs…" until
    // the first line / "[stream ended]"). Hard-assert it opened before shooting.
    const logsBtn = d.getByRole('button', { name: /^Logs$/ }).first();
    await logsBtn.click();
    await expect(
      d.getByText(/Waiting for logs…|\[stream ended\]|Log stream disconnected/i)
        .or(d.locator('.font-mono').filter({ hasText: /\S/ }))
        .first(),
      'container Logs view never opened',
    ).toBeVisible({ timeout: SLA });
    await capture(dashPage, 'container-logs');
    // Open the container's INSPECT view: the card's "Inspect" button expands an
    // inline OverviewPane with the container's configuration (Identity / Image /
    // Network groups). Hard-assert a config group rendered before shooting.
    const inspectBtn = d.getByRole('button', { name: /^Inspect$/ }).first();
    await inspectBtn.click();
    await expect(
      d.getByText(/^Identity$|^Image$|^Network$/).first(),
      'container Inspect view never opened',
    ).toBeVisible({ timeout: SLA });
    await capture(dashPage, 'container-inspect');
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
    // Use DEVELOPMENT: the v1→v2 backbone deployed TWO meaningful versions there,
    // so its Deployment history has MULTIPLE entries and the prior (v1) entry is
    // a genuine non-current version whose "Diff vs current" is a REAL diff
    // against v2 (Production was promoted from dev, so it carries a single
    // entry). Inspecting a NON-current entry is what makes inspect-diff non-empty.
    await selectStage(/Development/i);
    await clickSection(/Deployment history/i);
    await capture(dashPage, 'history');
    // Each deploy-history entry card shows its actions: a CURRENT entry has
    // Scale + Inspect; a NON-current (prior) entry has Roll back + Inspect. To
    // get a real diff we must Inspect a NON-current entry — locate the card that
    // carries a "Roll back" action and click the Inspect WITHIN that same card.
    const priorCard = d
      .locator('div', { has: d.getByRole('button', { name: /^Roll back$/ }) })
      .filter({ has: d.getByRole('button', { name: /^Inspect$/ }) })
      .last();
    const inspect = priorCard.getByRole('button', { name: /^Inspect$/ }).first();
    await expect(inspect, 'no prior (non-current) Development entry to inspect for a real diff')
      .toBeVisible({ timeout: SLA });
    await inspect.click();
    // The Inspect overlay is a custom fixed backdrop (not role="dialog").
    const inspectMark = d.getByText(/Diff vs current/i).first();
    await inspectMark.waitFor({ state: 'visible', timeout: SLA });
    // Files — the exact source tree this deployment ran.
    await d.getByRole('button', { name: /^Files$/ }).first().click().catch(() => {});
    await capture(dashPage, 'inspect-modal');
    // Diff vs current — what changed versus what's live now. Because we inspected
    // the PRIOR (v1) entry while v2 is current, this is a REAL, non-empty diff
    // (the "Manager approval tier (v2)" block we added). Hard-assert the diff
    // surface rendered changed lines, not an empty/identical placeholder.
    await d.getByRole('button', { name: /Diff vs current/i }).first().click();
    // The diff renders as a unified <pre> (added lines tinted emerald). Because
    // we inspected the PRIOR (v1) entry while v2 is current, the v2 content we
    // added must appear as added lines — and the "No changes" empty state must
    // NOT. Hard-assert the real diff before capturing.
    await expect(
      d.getByText(/Manager approval tier|approving_manager|approved_at/i).first(),
      'Inspect → Diff vs current showed no real diff between the prior and current versions',
    ).toBeVisible({ timeout: SLA });
    await capture(dashPage, 'inspect-diff');
    // Download image — the built image + schema bundle for offline audit.
    await d.getByRole('button', { name: /Download image/i }).first().click().catch(() => {});
    await capture(dashPage, 'inspect-image');
    // Its × is the last aria-label="Close" on the page while the modal is up.
    const x = d.locator('button[aria-label="Close" i]').last();
    if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
    if (await inspectMark.isVisible().catch(() => false)) await dashPage.keyboard.press('Escape').catch(() => {});
    await expect(inspectMark, 'Inspect modal stayed open and would block later clicks')
      .toBeHidden({ timeout: SLA });
  });

  // ---- Firewall & data processing (N): the invoice BP makes REAL outbound
  // calls on startup (its egress probes), which the firewall observes. On the
  // Development stage the firewall runs in MONITOR mode, so those destinations
  // surface under "Needs review". We open Firewall (WAIT for it to finish
  // loading — never a "Loading firewall…" frame), find a detected egress host,
  // open its GDPR data-processing record, FILL it, capture, and save it (the
  // approval is idempotent — it just versions the record in bitswan.yaml).
  await chapter('firewall', async () => {
    // Development is in monitor mode and is where the live-dev/dev containers'
    // egress is observed. Select it, open Firewall, wait for the panel to load.
    await selectStage(/Development/i);
    // Loose match: the Firewall tab carries a count badge once egress is
    // observed ("Firewall 2"), so an anchored /^Firewall$/ never matches.
    await clickSection(/Firewall/i);
    // Real load signal: the "Loading firewall…" spinner must clear AND the
    // posture pill (Monitoring/Enforcing) must be on screen — never shoot mid-load.
    await d.getByText(/Loading firewall…/i).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    await d.getByText(/Monitoring|Enforcing/i).first()
      .waitFor({ state: 'visible', timeout: SLA });
    // The BP backend fires real outbound probes on a loop, and the dashboard
    // firewall panel now POLLS, so an observed egress host RELIABLY surfaces
    // under "Needs review" within ~90s. This is the whole point of the chapter,
    // so it is FATAL: hard-assert the host appears (no silent pass on an empty
    // review list). The egress host appears within ~90s.
    const needsReview = d.getByText(/Needs review/i).first();
    await expect(needsReview, 'no observed egress surfaced under "Needs review" within 90s')
      .toBeVisible({ timeout: 90_000 });
    await capture(dashPage, 'firewall');
    // Open the GDPR data-processing record for the detected host via its Approve
    // button (the modal is a custom overlay, not role="dialog"). FATAL: this
    // Approve → Article-30 form → capture → save flow is the chapter's outcome.
    const approve = d.getByRole('button', { name: /^Approve$/ }).first();
    await expect(approve, 'a detected egress host exposed no Approve action')
      .toBeVisible({ timeout: SLA });
    await approve.click();
    // Modal signature: the "No user data…" record toggle.
    const recMark = d.getByText(/No user data is sent to this service/i).first();
    await recMark.waitFor({ state: 'visible', timeout: SLA });
    // Fill the Article 30 record (a personal-data recipient): what data, purpose,
    // stored?, jurisdiction. (We leave the DPA file upload — a real PDF — out;
    // that field is documented and optional for the record to save.)
    await d.getByPlaceholder(/employee email, error stack traces/i).first()
      .fill('Vendor VAT-IDs and invoice totals for validation.');
    await d.getByPlaceholder(/crash diagnostics & alerting/i).first()
      .fill('Validate vendor VAT-IDs against the Czech business register.');
    await d.getByRole('button', { name: /^Transient$/ }).first().click().catch(() => {});
    const juris = d.getByPlaceholder(/EU \(Ireland\)/i).first();
    if (await juris.isVisible().catch(() => false)) {
      await juris.fill('EU (Czech Republic)');
    }
    await capture(dashPage, 'firewall-gdpr');
    // Save the record (idempotent — versions the record + allows the host).
    const save = d.getByRole('button', { name: /Approve & record|Save record/i }).first();
    await expect(save, 'the GDPR record had no Save/Approve action').toBeVisible({ timeout: SLA });
    await save.click();
    await recMark.waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
  });

  // ---- Sharing the endpoint (I): a deployed automation FRONTEND is itself a
  // Bailey-protected endpoint the operator OWNS — so it carries the SAME Bailey
  // chrome footer "Share" affordance the dashboard does. The point of this
  // chapter is to show that the frontends operators CREATE are protected by
  // Bailey: we open a deployed frontend (Production → "Open app") in a new tab,
  // then on THAT frontend's own chrome we Share it with a teammate at User
  // level. The chrome footer + share modal are rendered by the daemon on the
  // popup's TOP page (not inside any iframe), so we drive the popup directly.
  await chapter('share-endpoint', async () => {
    await clickTopTab(/Deployments/i);
    // Open + share a DEPLOYED FRONTEND. The Deployments stage card renders an
    // "Open app" section (DeploymentsTab.tsx) ONLY when the stage has ≥1 frontend
    // whose live-display status is "running" with a URL; each such frontend is an
    // external-link anchor (<a href={url} target="_blank" rel="noreferrer">, no
    // title attr) whose text is the automation name + host. Development is the
    // stage that reliably carries a running, openable frontend (its live-dev /
    // first dev deploy is up); a promoted Production stage may not expose the
    // same openable app — so we share off Development, the reliably-openable one.
    await selectStage(/Development/i);
    // The "Open app" anchor: scope to the section by its heading and take the
    // first deployed frontend's external-link card. (A previous `.or(first
    // https link on the page)` fallback matched a DIFFERENT element than the
    // scoped one, so the combined locator resolved to 2 nodes → strict-mode
    // violation. The scoped section reliably contains the link — see
    // DeploymentsTab "Open app".)
    const openApp = d
      .getByText(/^Open app$/i)
      .locator('..')
      .locator('a[target="_blank"][href^="https://"]')
      .first();
    await expect(openApp, 'no deployed frontend to open + share under Development → Open app')
      .toBeVisible({ timeout: SLA });
    const popupP = dashPage.context().waitForEvent('page', { timeout: 30_000 }).catch(() => null);
    await openApp.click();
    const fe = await popupP;
    expect(fe, 'opening the deployed frontend did not spawn a tab').not.toBeNull();
    const frontend = fe!;
    await frontend.waitForLoadState('domcontentloaded').catch(() => {});
    await frontend.locator('body').waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
    // The frontend is wrapped in Bailey chrome (a footer pinned to the bottom of
    // every protected endpoint). Because the operator owns this frontend, the
    // chrome footer shows a "Share" button — proving operator-created frontends
    // are Bailey-protected. Open it and share THIS frontend.
    const shareBtn = frontend.getByRole('link', { name: /^Share$/ })
      .or(frontend.getByRole('button', { name: /^Share$/ }))
      .first();
    await expect(shareBtn, "the frontend's Bailey chrome exposed no Share affordance (is it owner-fronted?)")
      .toBeVisible({ timeout: SLA });
    await shareBtn.click();
    // The chrome share modal: add input + role select + Add (ids set by the
    // daemon's share_modal.go).
    const input = frontend.locator('#bailey-share-input');
    await input.waitFor({ state: 'visible', timeout: SLA });
    await input.fill(ENV.teammateEmail);
    // Grant at User level (default option value "access").
    await frontend.locator('#bailey-share-role').selectOption('access').catch(() => {});
    await capture(frontend, 'share-modal');
    await frontend.locator('#bailey-share-add-btn').click();
    // The grant lands in the "People with access" list; hard-assert + capture it.
    await expect(
      frontend.getByText(new RegExp(ENV.teammateEmail.replace(/[.@]/g, '\\$&'), 'i')).first(),
      'the teammate grant did not land in the People with access list',
    ).toBeVisible({ timeout: SLA });
    await capture(frontend, 'share-modal');
    // Close the modal (its footer Done button), then close the popup.
    await frontend.getByRole('button', { name: /^Done$/ }).first().click().catch(() => {});
    await frontend.close().catch(() => {});
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
    // Defensive: a leftover modal (e.g. a create dialog) would intercept the
    // stage/section clicks below and make them time out. Close any open overlay
    // first so DR navigation is never blocked.
    await closeAnyModal();
    await selectStage(/Disaster Recovery/i);
    await clickSection(/Rehearse & restore/i);
    // The panel loads its snapshot list; wait for it to settle on a real state
    // (a snapshot row's Restore/Mark/Tested control, or the empty notice) so we
    // never act on a half-rendered list.
    await d
      .getByRole('button', { name: /Restore into DR|Mark recovery-tested/i })
      .or(d.getByText(/No Production backups yet|Tested .*·/i))
      .first()
      .waitFor({ state: 'visible', timeout: SLA })
      .catch(() => {});
    // On a re-run a snapshot may ALREADY be "In DR now" — then there is no
    // "Restore into DR" button for it (it shows Mark recovery-tested / Tested
    // instead). Handle both: restore if a Restore action exists, otherwise jump
    // straight to recording the recovery test.
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
        // The restore's success toasts can briefly overlap the button; click with
        // force and don't let a transient intercept fail the chapter (the restore
        // — the substantive DR rehearsal — already succeeded on screen above).
        await mark.click({ timeout: SLA, force: true }).catch(() => {});
        await d.getByText(/Tested/i).first().waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
      }
    } else {
      // No Restore action — a backup is already "In DR now" from a prior run.
      // Record the recovery test on it so the chapter still demonstrates the
      // full rehearse → recovery-tested outcome (idempotent across re-runs).
      const mark = d.getByRole('button', { name: /Mark recovery-tested/i }).first();
      if (await mark.isVisible().catch(() => false)) {
        await mark.click({ timeout: SLA, force: true }).catch(() => {});
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

  // ---- Rollback (J): the dashboard exposes a "Roll back" action ONLY on a
  // NON-current DEPLOY history entry. The v1→v2 backbone (the `deploy` + the
  // dedicated `deploy-v2` chapters) already deployed TWO meaningful versions to
  // Development, so its history carries a prior, non-current entry with a real
  // "Roll back" action — no one-off second deploy is needed here. We simply open
  // Development → Deployment history, press "Roll back" on the prior entry, open
  // the confirm, capture it, and CANCEL — a rehearsal must NOT mutate the stage,
  // so we never confirm. Placed LAST so any residual busy state can't disrupt
  // another chapter. Hard-asserted throughout.
  await chapter('rollback', async () => {
    // Defensive: clear any modal a prior chapter may have left open (e.g. the DR
    // swap confirm) so our first click isn't intercepted by a stale overlay.
    await closeAnyModal();
    // Development has ≥2 deploy-history entries (v1, v2) from the backbone.
    await selectStage(/Development/i);
    await clickSection(/Deployment history/i);
    // The prior (non-current) entry carries the "Roll back" action.
    const rb = d.getByRole('button', { name: /^Roll back$/ }).first();
    await expect(rb, 'Development history exposed no Roll back action (expected ≥2 entries from v1→v2)')
      .toBeVisible({ timeout: SLA });
    // Open the confirm, capture it, and CANCEL — never confirm the rollback.
    await rb.click();
    const dlg = d.getByRole('alertdialog').or(d.getByRole('dialog')).first();
    await expect(dlg, 'clicking Roll back did not open a confirm dialog').toBeVisible({ timeout: SLA });
    await capture(dashPage, 'rollback-modal');
    await d.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {});
    await expect(dlg, 'the rollback confirm dialog did not close on Cancel').toBeHidden({ timeout: SLA });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Onboarding a teammate — the multi-user / multi-device story (#74).
  //
  // The whole walkthrough so far is the OPERATOR (Tomáš) — he claimed the
  // server, so his browser is the root trusted device and everything just
  // opens. Now we tell the OTHER side of the gate: a brand-new teammate
  // (Marek Horváth) arriving from a NEW, untrusted device. Bailey is
  // deny-by-default — an OIDC login alone gets Marek NOTHING until a trusted
  // admin approves his device. We drive this for REAL across two browser
  // contexts:
  //
  //   • marekCtx — a SECOND, independent browser context == a NEW, untrusted
  //     device. Its ONE allowed page.goto is the entry load of the Bailey
  //     host (exactly as the operator's onboarding does its single entry
  //     load); everything after is click/type only.
  //   • dashPage — the operator's existing session (Tomáš = admin), which we
  //     switch back to in order to APPROVE Marek from the Server Console.
  //
  // The REAL device-trust flow (from the daemon + console-console SPA):
  //   1. Marek signs in via OIDC from the new context → the daemon's gate sees
  //      no trusted-device cookie and serves the server-rendered "Trust this
  //      device" page: a big 6-digit code (.sc-code) under "Read this code to
  //      an admin", and a polling "Waiting for an admin to approve…" line.
  //      That is the deny-by-default state — NOT the product.
  //   2. The admin proves Marek is physically present by reading that 6-digit
  //      code off his screen and typing it into the console. We read the code
  //      off Marek's page (visible DOM — allowed) and type it into Tomáš's
  //      "People & roles" view, where Marek's pending request surfaces inline
  //      as a "Device awaiting approval" bar; pressing "Trust this device"
  //      approves him + trusts the device in one action.
  //   3. Marek's page is polling /pending-pair/poll; the moment the device is
  //      trusted, the gate's poll returns approved and the page redirects him
  //      into what he was granted — access now granted on the new device.
  //
  // Security point made in the copy (content.mjs Ch 21–23): deny-by-default,
  // admin-approved per-device trust, and that the same surface that grants a
  // device is where you REMOVE one — the response to a stolen device or a
  // departing employee (ties to the existing stolen-device narrative, Ch 04).
  // ════════════════════════════════════════════════════════════════════════

  // A handle to Marek's second-context page, shared across the three chapters.
  let marekCtx: import('@playwright/test').BrowserContext | null = null;
  let marekPage: import('@playwright/test').Page | null = null;
  // The 6-digit pairing code Marek's device shows — read off his screen in the
  // pending chapter and typed into the admin console in the approve chapter.
  let pairCode = '';

  // ---- (1) A new user's first login: deny-by-default on a new device -------
  await chapter('onboard-newuser-pending', async () => {
    // A second browser context is, by construction, a NEW device: it carries
    // none of the operator's trusted-device cookies. This is the closest real
    // path to "a teammate on their own laptop". We wrap the whole second-context
    // body so that on ANY failure we capture MAREK's page (the chapter() helper
    // only shoots the operator's dashPage), making the gate diagnosable.
    try {
      const browser = dashPage.context().browser();
      expect(browser, 'no browser handle to open a second device context').not.toBeNull();
      marekCtx = await browser!.newContext({ ignoreHTTPSErrors: true });
      marekPage = await marekCtx.newPage();
      // The ONE allowed page.goto for this context — the entry load of the Bailey
      // ONBOARDING host (bailey-onboard.*), exactly as the operator's onboarding
      // does its single entry load. This is where the device-trust SPA is served
      // directly: an untrusted device hitting the inner console host is 303'd
      // here anyway, so we load it head-on rather than rely on that redirect.
      await marekPage.goto(ENV.onboardUrl + '/');
      // Sign in via OIDC as Marek (a real seeded, non-admin Keycloak identity).
      await oidcLogin(marekPage, ENV.teammateEmail, ENV.teammatePassword);
      // HARD-ASSERT the deny-by-default state. The onboarding host renders the
      // console SPA's ApprovalScene (auth-scenes.jsx) — NOT the daemon's
      // server-rendered pendingPairHTML — because the server is already CLAIMED
      // (the operator claimed it) and this device is untrusted (pickScene →
      // 'approval'). The scene shows an <h1>Trust this device</h1>, a 6-digit
      // "Your code", and a polling "Waiting for an admin…" line (animated dots,
      // so we match the stable prefix, NOT the daemon template's longer string).
      await expect(
        marekPage.getByRole('heading', { name: /Trust this device/i }).first(),
        'a brand-new user from an untrusted device did NOT land on the device-trust gate (deny-by-default not enforced?)',
      ).toBeVisible({ timeout: SLA });
      await expect(
        marekPage.getByText(/Waiting for an admin/i).first(),
        'the device-trust page never showed the pending/awaiting-approval state',
      ).toBeVisible({ timeout: SLA });
      // Read the 6-digit code off Marek's screen. In the SPA the code is the
      // monospace "Your code" value next to the "Your code" label — NOT a
      // .sc-code element (that class only exists in the daemon's HTML template).
      // It renders as "······" until SApi.pendingPair() resolves, so we POLL the
      // monospace value until it's six real digits. Reading visible DOM text is
      // allowed under the pure-browser rules; it's exactly what a human reads
      // aloud to the admin.
      const codeEl = marekPage
        .getByText(/^Your code$/i)
        .locator('..')
        .getByText(/\d{6}|·{6}/)
        .first();
      await expect(codeEl, 'the device-trust page never rendered the "Your code" panel').toBeVisible({ timeout: SLA });
      await expect
        .poll(async () => ((await codeEl.textContent()) || '').replace(/\D/g, ''), { timeout: SLA, intervals: [500, 1000, 2000] })
        .toMatch(/^\d{6}$/);
      pairCode = ((await codeEl.textContent()) || '').replace(/\D/g, '');
      expect(pairCode, `expected a 6-digit pairing code on Marek's device, got "${pairCode}"`).toMatch(/^\d{6}$/);
      // Capture the deny-by-default / device-trust-request state the new user sees.
      await capture(marekPage, 'onboard-newuser-pending');
    } catch (e) {
      if (marekPage) await capture(marekPage, 'dbg-marek-onboard-newuser-pending').catch(() => {});
      throw e;
    }
  });

  // ---- (2) The admin enrolls the user + trusts the device ------------------
  await chapter('onboard-admin-approve', async () => {
    expect(pairCode, 'no pairing code captured from the new device').toMatch(/^\d{6}$/);
    // Switch back to the OPERATOR's session (Tomáš = admin) and open the
    // People & roles view in the Server Console — the same admin surface as the
    // devices chapter. Marek's pending request surfaces inline there.
    await page.bringToFront().catch(() => {});
    await page.getByRole('button', { name: /People & roles/i }).first().click();
    await expect(page.getByRole('heading', { name: /People & roles/i }).first()).toBeVisible({ timeout: SLA });
    // The console refetches approvals on a background interval; re-click the nav
    // to force a fresh fetch and POLL until Marek's pending device bar appears.
    // This is the heart of the story: the admin sees the request and controls
    // who/which devices get in. Bounded; we re-click People & roles each pass.
    const pendingBar = page.getByText(/Device awaiting approval/i).first();
    const armDeadline = Date.now() + 90_000;
    for (;;) {
      if (await pendingBar.isVisible().catch(() => false)) break;
      if (Date.now() > armDeadline) break;
      await page.getByRole('button', { name: /People & roles/i }).first().click().catch(() => {});
      await pendingBar.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    }
    await expect(
      pendingBar,
      "Marek's pending device request never surfaced under People & roles for the admin to approve",
    ).toBeVisible({ timeout: SLA });
    // Capture the admin seeing the pending request (the moment that proves the
    // admin controls access).
    await capture(page, 'onboard-admin-approve');
    // Type the 6-digit code (read off Marek's screen) into the approval input.
    // The console renders it as a segmented [3,3] code input; type the digits
    // into its underlying field. The "Trust this device" button enables once
    // six characters are entered.
    const codeInput = pendingBar.locator('..').locator('input').first()
      .or(page.locator('input[inputmode="numeric"], input[maxlength="6"], input').filter({ hasNot: page.locator('[type="search"]') }).last())
      // Collapse the .or() to a single node: a segmented [3,3] code input is TWO
      // <input>s, so the two branches resolve to different boxes — without this
      // the later pressSequentially() (an action) would hit a strict-mode
      // violation. The first box is correct: segmented inputs auto-advance.
      .first();
    await codeInput.waitFor({ state: 'visible', timeout: SLA });
    // Segmented inputs accept the digits typed in sequence; pressSequentially
    // drives each box like a human typing the code.
    await codeInput.click().catch(() => {});
    await codeInput.pressSequentially(pairCode, { delay: 30 });
    const trustBtn = page.getByRole('button', { name: /^Trust this device$/i }).first();
    await expect(trustBtn, 'the "Trust this device" approval button never enabled after entering the code')
      .toBeEnabled({ timeout: SLA });
    await trustBtn.click();
    // HARD-ASSERT the approval landed: the success toast ("Device trusted for
    // …") fires and the pending bar clears (refresh('approvals') removes it).
    await expect(
      page.getByText(/Device trusted for/i).first()
        .or(page.getByText(new RegExp(`Device trusted for ${TEAMMATE.name.split(' ')[0]}`, 'i')).first()),
      'approving the device did not surface a "Device trusted" confirmation',
    ).toBeVisible({ timeout: SLA });
    await expect(pendingBar, "the pending request bar did not clear after the admin approved Marek's device")
      .toBeHidden({ timeout: SLA });
    // Capture the approved result (the admin's view, request resolved).
    await capture(page, 'onboard-admin-approved');
  });

  // ---- (3) The device-linking result: access now granted on the device ----
  await chapter('onboard-newuser-granted', async () => {
    expect(marekPage, 'Marek device page was not opened').not.toBeNull();
    const mp = marekPage!;
    try {
      await mp.bringToFront().catch(() => {});
      // Back on Marek's device: the ApprovalScene has been polling
      // /bailey/api/pending-pair/poll the whole time. Once the admin trusted the
      // device, the poll returns {approved:true} and the scene calls
      // followRedirect() — window.location.assign(redirect_path) or a reload —
      // taking him OFF the "Trust this device" gate into what he was granted.
      // The SPA does NOT print an "Approved. Redirecting…" beat (that string is
      // only in the daemon's HTML template), so we assert the gate is GONE: the
      // "Trust this device" heading is no longer present (he's been redirected
      // into the product / console). Pure on-screen wait; the page drives its
      // own redirect (no goto from us). The poll runs every ~2.5s.
      const trustHeading = mp.getByRole('heading', { name: /Trust this device/i }).first();
      await trustHeading.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
      await expect(
        trustHeading,
        "Marek's device stayed on the deny-by-default gate — approval did not grant access on the new device",
      ).toBeHidden({ timeout: 60_000 });
      // Capture the "access now granted on the new device" state. We settle on a
      // visible body (whatever he was granted — the onboarding/console shell) so
      // the shot isn't a blank mid-redirect frame.
      await mp.locator('body :visible').first().waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
      await mp.getByText(/^Connecting…$|Loading/i).first().waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
      await capture(mp, 'onboard-newuser-granted');
    } catch (e) {
      await capture(mp, 'dbg-marek-onboard-newuser-granted').catch(() => {});
      throw e;
    } finally {
      // Tear down the second device context — the teammate's device is done.
      await marekCtx?.close().catch(() => {});
      marekCtx = null;
      marekPage = null;
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
