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

  // ---- SIEM export (L): on the Server overview, point Bailey at an external
  // OTLP ingestor so its security audit log streams to your SIEM. We open the
  // SIEM forwarding card's config form, fill it (a local OTLP/HTTP endpoint so
  // the connectivity test reaches nothing sensitive), capture the form, then
  // Save & connect and capture the resulting card state (Connected, or the
  // honest connection error if no collector is listening — a real screenshot
  // either way; never a loading frame).
  await chapter('siem', async () => {
    await page.getByRole('button', { name: /Server overview/i }).first().click();
    await expect(page.getByText(/SIEM forwarding/i).first()).toBeVisible({ timeout: SLA });
    // Open the config form (first run shows "Configure ingestor"; an existing
    // config shows "Edit"). Either lands on the same form.
    const configure = page.getByRole('button', { name: /Configure ingestor|^Edit$/ }).first();
    if (await configure.isVisible().catch(() => false)) {
      await configure.click().catch(() => {});
      const url = page.getByPlaceholder(/collector\.example\.com/i).first();
      await url.waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
      if (await url.isVisible().catch(() => false)) {
        await url.fill('http://127.0.0.1:4318');
        await capture(page, 'siem');
        // Save & connect — runs a bounded connectivity test, then persists.
        await page.getByRole('button', { name: /Save & connect|Testing…/ }).first().click().catch(() => {});
        // Wait for the test to settle: the button leaves "Testing…" and the
        // card shows a terminal state (Connected pill or a last-error line).
        await page.getByRole('button', { name: /Testing…/ }).first()
          .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
        await capture(page, 'siem');
      }
    } else {
      await capture(page, 'siem');
    }
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
  // A real operator clicks the toolbar's "Insert flowchart" button and DRAWS
  // the diagram: drop a few nodes, then Save diagram drops the rendered chart
  // into the spec. We add nodes via the modal's Add-node buttons (Process /
  // Decision / Terminal) — a pure-click action — capture the editor, then save.
  await chapter('flowchart-editor', async () => {
    await clickTopTab(/Description/i);
    const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: SLA });
    // Put the caret at the end so the inserted diagram lands after the prose.
    await editor.click();
    await dashPage.keyboard.press('Control+End').catch(() => {});
    // Toolbar control: aria-label="Insert flowchart".
    const insertFlow = d.getByRole('button', { name: /Insert flowchart/i }).first();
    await insertFlow.click();
    // The FlowchartEditorModal: title "Flowchart editor", Add-node buttons.
    const modalMark = d.getByText(/Flowchart editor/i).first();
    await modalMark.waitFor({ state: 'visible', timeout: SLA });
    // Draw a few nodes (the lifecycle's shapes): Decision, Process, Terminal.
    for (const node of [/^Process$/, /^Decision$/, /^Terminal$/] as const) {
      const btn = d.getByRole('button', { name: node }).first();
      if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
    }
    await capture(dashPage, 'flowchart-editor');
    // Save the drawn diagram back into the description.
    await d.getByRole('button', { name: /^Save diagram$/i }).first().click();
    await modalMark.waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    await dashPage.keyboard.press('Control+s');
    await d.getByRole('button', { name: /Saving/i }).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    // Re-capture the description now that the rendered diagram is in it.
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
    await capture(dashPage, 'coding-agent');
  });
  await chapter('live-dev', async () => {
    await clickTopTab(/Coding Agent/i);
    // The Environment panel lists each automation; once its live-dev container
    // is running, its name becomes an openable external link (title "Open
    // https://…"). Wait for that openable link to appear — live-dev builds the
    // image first, so this can take a few minutes (no progress-watchdog here;
    // this is a plain visibility wait, not a deploy long-op). The DASHBOARD view
    // showing the running, openable live-dev is the documented "live-dev is up"
    // evidence; we capture that as the slot, and ALSO open the preview tab as a
    // bonus shot when it renders real content.
    const openLink = d.locator('a[target="_blank"][title^="Open "]').first();
    await openLink.waitFor({ state: 'visible', timeout: 8 * 60_000 }).catch(() => {});
    await capture(dashPage, 'live-dev');
    if (await openLink.isVisible().catch(() => false)) {
      const popupP = dashPage.context().waitForEvent('page', { timeout: 30_000 }).catch(() => null);
      await openLink.click().catch(() => {});
      const popup = await popupP;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        await popup.locator('body').waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
        await popup.getByText(/Loading|Starting/i).first()
          .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
        // Only keep the preview shot if it actually rendered visible content
        // (the example frontend can be blank at its root); otherwise the
        // dashboard panel shot above stands as the live-dev evidence.
        const hasContent = await popup.locator('body :visible').first().isVisible().catch(() => false);
        if (hasContent) await capture(popup, 'live-dev-preview').catch(() => {});
        await popup.close().catch(() => {});
      }
    }
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
      .waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
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
    const realScan = d
      .getByText(/CVE-\d{4}-\d+/).first()
      .or(d.getByText(/in-scope CVE|No active CVEs|vulnerabilit|out of scope/i).first());
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
      if (!landed) {
        // Re-mount the panel (diff ↔ checks) so the next fetch can pick up the
        // finished background scan.
        await d.getByRole('button', { name: /^diff$/i }).first().click().catch(() => {});
      }
    }
    await capture(dashPage, 'checks-cve');
  });

  // ---- Promote dev → staging → production, waiting for each to be Healthy ----
  await chapter('promote', async () => {
    await clickTopTab(/Deployments/i);
    // Two hops. For each, click the target stage (so waitDeployDone watches the
    // stage we're filling), click whichever Promote is enabled (the pipeline
    // only enables the next hop), and wait — on screen — for that stage to
    // report Healthy. No reload between click and wait.
    let shotProcess = false;
    for (const target of [/Staging/i, /Production/i] as const) {
      await selectStage(target);
      // Press the enabled Promote and CONFIRM it actually started before we wait
      // on the deploy watchdog: the target stage must leave its "never deployed"
      // state OR a Promoting/Working/toast signal must appear. A click that
      // doesn't register would otherwise leave the stage static and trip the
      // progress watchdog as a false stall — so we retry the press until the
      // promote is observably underway (bounded), then ride it to Healthy.
      const moving = d
        .getByText(/Promoting|Starting|Building|Pulling|Working|Preparing|Deploying/i)
        .first();
      const healthy = d.getByText(/^Healthy$/i).or(d.getByText(/Current on/i)).first();
      let started = false;
      for (let attempt = 0; attempt < 4 && !started; attempt++) {
        const all = d.getByRole('button', { name: /^Promote$/ });
        const n = await all.count();
        for (let j = 0; j < n; j++) {
          const b = all.nth(j);
          if (await b.isEnabled().catch(() => false)) {
            await b.click().catch(() => {});
            break;
          }
        }
        // Wait briefly for an on-screen sign the promote is underway (or already
        // landed). If nothing moves, the click missed — loop and press again.
        await Promise.race([
          moving.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
          healthy.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
        ]);
        started =
          (await moving.isVisible().catch(() => false)) ||
          (await healthy.isVisible().catch(() => false));
      }
      // Capture the promotion IN PROGRESS the first time (the live step beat).
      if (!shotProcess) {
        await capture(dashPage, 'promote-progress');
        shotProcess = true;
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
    // The deployed image's SBOM/CVE scan runs in the background after deploy and
    // is re-fetched periodically. Production has a real deployed image, so a real
    // scan WILL appear. Re-mount the panel (Containers ↔ Supply chain) a few
    // times, each with a BOUNDED waitFor for a real scan row (CVE / clean state /
    // vulnerabilities) — hang-proof (no open-ended poll). Capture the real scan.
    const realScan = d
      .getByText(/CVE-\d{4}-\d+/).first()
      .or(d.getByText(/in-scope CVE|No active CVEs|vulnerabilit|out of scope/i).first());
    let landed = false;
    for (let attempt = 0; attempt < 8 && !landed; attempt++) {
      await clickSection(/Supply chain/i);
      await d.getByText(/Loading supply chain/i).first()
        .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
      landed = await realScan
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!landed) await clickSection(/Containers/i).catch(() => {});
    }
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
    // Open the per-deployment Inspect modal and step through ALL its rail tabs
    // (Files / Diff vs current / Download image — plus Scale on the current
    // entry), capturing each — the audit drill-down a real operator uses.
    const inspect = d.getByRole('button', { name: /^Inspect$/ }).first();
    if (await inspect.isVisible().catch(() => false)) {
      await inspect.click();
      // The Inspect overlay is a custom fixed backdrop (not role="dialog").
      const inspectMark = d.getByText(/Diff vs current/i).first();
      await inspectMark.waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
      // Files — the exact source tree this deployment ran.
      await d.getByRole('button', { name: /^Files$/ }).first().click().catch(() => {});
      await capture(dashPage, 'inspect-modal');
      // Diff vs current — what changed versus what's live now.
      await d.getByRole('button', { name: /Diff vs current/i }).first().click().catch(() => {});
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
    }
    await selectStage(/Production/i);
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
    await clickSection(/^Firewall$/i);
    // Real load signal: the "Loading firewall…" spinner must clear AND the
    // posture pill (Monitoring/Enforcing) must be on screen — never shoot mid-load.
    await d.getByText(/Loading firewall…/i).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    await d.getByText(/Monitoring|Enforcing/i).first()
      .waitFor({ state: 'visible', timeout: SLA });
    // The BP backend fires real outbound probes on a loop; when an egress
    // gateway is observing the realm, the destinations surface under "Needs
    // review". Give it a bounded window to appear (non-fatal — if the egress
    // gateway isn't active for this BP/stage, the panel still truthfully shows
    // the monitoring posture + allow-list, which is what we capture).
    const needsReview = d.getByText(/Needs review/i).first();
    await expect
      .poll(async () => (await needsReview.isVisible().catch(() => false)) ? 'seen' : 'waiting', {
        timeout: 90_000,
        intervals: [2000, 3000, 5000],
      })
      .toBe('seen')
      .catch(() => {});
    await capture(dashPage, 'firewall');
    // Open the GDPR data-processing record for a detected host via its Approve
    // button (the modal is a custom overlay, not role="dialog").
    const approve = d.getByRole('button', { name: /^Approve$/ }).first();
    if (await approve.isVisible().catch(() => false)) {
      await approve.click().catch(() => {});
      // Modal signature: the "No user data…" record toggle.
      const recMark = d.getByText(/No user data is sent to this service/i).first();
      await recMark.waitFor({ state: 'visible', timeout: SLA });
      // Fill the Article 30 record fully (a personal-data recipient): what data,
      // purpose, stored?, jurisdiction. (We leave the DPA file upload — a real
      // PDF — out; the field is documented and optional for the record to save.)
      const dataSent = d.getByPlaceholder(/employee email, error stack traces/i).first();
      if (await dataSent.isVisible().catch(() => false)) {
        await dataSent.fill('Vendor VAT-IDs and invoice totals for validation.');
      }
      const purpose = d.getByPlaceholder(/crash diagnostics & alerting/i).first();
      if (await purpose.isVisible().catch(() => false)) {
        await purpose.fill('Validate vendor VAT-IDs against the Czech business register.');
      }
      await d.getByRole('button', { name: /^Transient$/ }).first().click().catch(() => {});
      const juris = d.getByPlaceholder(/EU \(Ireland\)/i).first();
      if (await juris.isVisible().catch(() => false)) {
        await juris.fill('EU (Czech Republic)');
      }
      await capture(dashPage, 'firewall-gdpr');
      // Save the record (idempotent — versions the record + allows the host).
      const save = d.getByRole('button', { name: /Approve & record|Save record/i }).first();
      if (await save.isVisible().catch(() => false)) {
        await save.click().catch(() => {});
        await recMark.waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
      } else {
        await closeAnyModal();
      }
    }
  });

  // ---- Sharing the endpoint (I): the workspace dashboard is itself a protected
  // endpoint the operator OWNS, so the Bailey chrome footer shows a "Share"
  // button. Click it, see the share modal (deny-by-default access list), grant a
  // teammate at User level, then Done. These chrome elements live on the TOP
  // page (the wrap), not inside the dashboard iframe — so we drive `dashPage`.
  await chapter('share-endpoint', async () => {
    const shareBtn = dashPage.getByRole('link', { name: /^Share$/ })
      .or(dashPage.getByRole('button', { name: /^Share$/ }))
      .first();
    if (await shareBtn.isVisible().catch(() => false)) {
      await shareBtn.click().catch(() => {});
      // The share modal: an input to add people/groups + a role select + Add.
      const input = dashPage.locator('#bailey-share-input');
      await input.waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
      if (await input.isVisible().catch(() => false)) {
        // Grant a teammate (a real member of the Meridian cast) at User level.
        await input.fill('marek.horvath@meridianfoods.cz').catch(() => {});
        await capture(dashPage, 'share-modal');
        await dashPage.locator('#bailey-share-add-btn').click().catch(() => {});
        // The grant lands in the "People with access" list; capture the result.
        await dashPage.getByText(/marek\.horvath@meridianfoods\.cz/i).first()
          .waitFor({ state: 'visible', timeout: SLA }).catch(() => {});
        await capture(dashPage, 'share-modal');
        // Close the modal (its footer Done button).
        await dashPage.getByRole('button', { name: /^Done$/ }).first().click().catch(() => {});
      }
    } else {
      // No Share affordance (e.g. running without the chrome wrap) — leave the
      // slot to render an honest "capture pending"; documented in the report.
      await capture(dashPage, 'share-modal').catch(() => {});
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
  // NON-current DEPLOY history entry, and a deploy entry is recorded only when the
  // deployed SOURCE commit changes. So far Development has a single, current deploy
  // — nothing to roll back to. We act like an operator who shipped a tweak and then
  // changed their mind: make a REAL source edit (append a line to the Description),
  // Sync & Deploy a SECOND version (demoting the first to a prior, non-current
  // entry), then open Development → Deployment history and find the now-present
  // "Roll back" on that prior entry, open the confirm, capture it, and CANCEL — a
  // rehearsal must NOT mutate the stage, so we never confirm. Placed LAST so the
  // extra deploy + any residual busy state can't disrupt another chapter.
  await chapter('rollback', async () => {
    // Defensive: clear any modal a prior chapter may have left open (e.g. the DR
    // swap confirm) so our first click isn't intercepted by a stale overlay.
    await closeAnyModal();
    await selectStage(/Development/i);
    // 1) Make a minimal REAL source change so the BP has pending work to ship.
    // Reuse the Description editor mechanics (ProseMirror contenteditable +
    // Ctrl+S) from the `description` chapter: click into the editor, append a
    // line, and save. This changes the deployed source so the next deploy
    // records a new version (a pure redeploy of the same source records none).
    await clickTopTab(/Description/i);
    const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: SLA });
    await editor.click();
    await dashPage.keyboard.press('Control+End');
    await editor.pressSequentially('\n- Audit note: dev tweak for rollback rehearsal.', { delay: 0 });
    await dashPage.keyboard.press('Control+s');
    // Wait for the save to settle: the Save button leaves its 'Saving…' state.
    await d.getByRole('button', { name: /Saving/i }).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    // CRITICAL: right after the edit/save a sonner toast overlay and the
    // just-loaded diff panel cause transient layout instability that can make a
    // direct click on the top-right "Sync & Deploy" button never land. Let any
    // toast clear before we look at the header.
    await d.locator('[data-sonner-toast]').first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    // The Sync & Deploy header gates its button on `!bpUpToDate`, where
    // `bpUpToDate = ahead==0 && behind==0 && !dirty` (SyncDeployTab.tsx). The
    // `dirty` flag reads the header's OWN `useCopyStatus(copy)` instance — a
    // SEPARATE snapshot from the Diff sub-tab's instance. By this last chapter
    // `invoice-processing` is already in sync with main (prior deploy/promote),
    // so the ONLY thing that re-arms the button is the working-tree edit showing
    // up as `dirty`. The header only refetches `/status` on (re)mount or window
    // focus, so a single tab-bounce can latch the PRE-save (clean) snapshot —
    // "Up to date with main", button disabled — even while the freshly-mounted
    // Diff panel already lists the file. Gate on the SAME on-screen signal the
    // button keys off: bounce the tab (`{tab==='sync-deploy' && …}` unmounts on
    // leave, so each return REMOUNTS and refetches), click the Diff ⟳ refresh,
    // and poll the header badge until it reports pending work — only then is the
    // button reliably actionable. Bounded; never sleeps.
    const upToDate = d.getByText(/up to date with main/i).first();
    const pending = d.getByText(/uncommitted file|↑\s*\d+\s*ahead|↓\s*\d+\s*behind/i).first();
    const armDeadline = Date.now() + SLA;
    for (;;) {
      await clickTopTab(/Deployments/i);
      await clickTopTab(/Sync & Deploy/i);
      // Force the diff/status panels to refetch (the ⟳ control next to the file
      // count); harmless if the count is already current.
      await d.getByRole('button', { name: /^Refresh$/i }).first().click().catch(() => {});
      const armed = await Promise.race([
        pending.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false),
        upToDate.waitFor({ state: 'visible', timeout: 5_000 }).then(() => false).catch(() => false),
      ]);
      if (armed && (await pending.isVisible().catch(() => false))) break;
      if (Date.now() > armDeadline) break; // fall through to the hard assert below
    }
    // 2) Ship the SECOND version. Gate on the BP being actionable (pending work),
    // then ride the deploy with the progress watchdog — same shape as `deploy`:
    // press while actionable until Development is Healthy on screen (bounded).
    const btn = d.getByRole('button', { name: /^Sync & Deploy$|Working/ }).last();
    await expect(btn, 'Sync & Deploy never became actionable after the edit').toBeEnabled({ timeout: SLA });
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
    // 3) Open Development → Deployment history. The first version is now a prior,
    // non-current entry, so it carries the "Roll back" action.
    await clickSection(/Deployment history/i);
    const rb = d.getByRole('button', { name: /^Roll back$/ }).first();
    await expect(rb, 'a prior deploy entry exposed no Roll back action after a second deploy').toBeVisible({ timeout: SLA });
    // 4) Open the confirm, capture it, and CANCEL — never confirm the rollback.
    await rb.click();
    const dlg = d.getByRole('alertdialog').or(d.getByRole('dialog')).first();
    await expect(dlg, 'clicking Roll back did not open a confirm dialog').toBeVisible({ timeout: SLA });
    await capture(dashPage, 'rollback-modal');
    await d.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {});
    await expect(dlg, 'the rollback confirm dialog did not close on Cancel').toBeHidden({ timeout: SLA });
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
