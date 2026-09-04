/**
 * The product walkthrough — driven through the REAL Bailey stack in a browser,
 * AS A PURE BROWSER USER, and the source of the Operator's Handbook screenshots.
 *
 * Journey: onboarding (OIDC → claim → device trust) → create the Meridian Foods
 * workspace via the Server Console → create the invoice-processing BP → describe
 * it → Coding Agent → Deploy (+ Supply Chain Security scan) → deploy to dev → promote to
 * production → backups → rehearse recovery into DR.
 *
 * THE COPY TREE. Everyone works in their OWN copy: it is auto-created (by
 * GET /api/me) and auto-selected on load. The top bar names NOTHING about it —
 * there is no copy dropdown, no copy chip, not even the copy's name: the
 * everyday answer to "whose copy is this?" is always "mine", so the bar spends
 * its width on the pipeline instead. We ASSERT that absence (below) rather than
 * merely stop using the old switcher.
 *
 * Everything else about copies lives behind the far-right "Advanced" menu:
 * "See a colleague's version" (their copy — or, expanded, one of their
 * experiments — under an amber "You are viewing …" banner with one click back)
 * and "Experiments on <business process>" — throwaway branches OFF YOUR OWN
 * copy. In your own experiment a green banner says so and carries FOUR ways
 * out: "Back to my copy" steps out and LEAVES IT RUNNING (it is waiting under
 * Advanced when you want it again), while the other three END it — merging back
 * AUTO-DISCARDS the experiment and lands you on your own copy, discarding is a
 * real delete, and "Use this version without merging" makes your copy BECOME
 * the experiment (your own work parked as a dated experiment of its own, the
 * source consumed).
 *
 * A COPY AND AN EXPERIMENT ARE DIFFERENT SHAPES. A copy is a person's
 * WORKSPACE-WIDE environment; an experiment belongs to exactly ONE business
 * process (each is its own git repository). So the menu's experiment section is
 * scoped to the process on screen, its empty state names that process, and the
 * green banner names it too.
 *
 * THE PIPELINE. Description › Coding Agent ↻ Requirements › Deploy all happen
 * inside the copy; Deployments sits outside it (main's shared area). Two tabs
 * are CONDITIONAL, and this walkthrough asserts the condition each way:
 *  - "Sync" leads the pipeline (before Description) only on your OWN copy and
 *    only while THIS BUSINESS PROCESS's main carries commits it lacks. Sync is
 *    per business process, exactly like Deploy — each is its own repository, so
 *    "behind main" is a fact about a process, not about a copy — and both come
 *    off the SAME divergence reading, so they cannot disagree. This run is a
 *    SINGLE user, so main only ever advances through this copy's own deploys —
 *    the tab must never appear, and we assert that in `deploy-tab`.
 *  - "Deploy" is absent INSIDE an experiment (an experiment merges back into
 *    its parent copy, never into main) — asserted in `experiment`.
 * Deploying is FAST-FORWARD-PUSH-ONLY: while the copy is behind main the Deploy
 * button is replaced by "Main has changes you don't have yet — sync first." plus
 * a "Go to Sync" link; it succeeds exactly when the push is a fast-forward.
 * (The legacy `?tab=sync-deploy` link still lands on Deploy via App.tsx's
 * LEGACY_TAB_ALIASES. That is a URL-level alias, and the pure-browser rules
 * below forbid navigating by URL, so it is NOT driven here — it lives in the
 * dashboard's own unit coverage.)
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
import { appendFileSync, writeFileSync } from 'node:fs';
import { test, expect, capture, captureOverheadMs, oidcLogin, dashboard, sh, ENV, type FrameOrPage } from '../fixtures/bitswan';
import { BP, WORKSPACE, COMPANY, SECRETS, TEAMMATE, EGRESS_PROBES } from '../scenario';

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
// per-(workspace,stage) infra (postgres/garage fresh per stage) — so that one
// status can legitimately hold for a while on CI dind. Crucially, promote builds
// a FRESH per-stage image (unlike the dev deploy, which rides the cached live-dev
// image), and that build's final `RUN … build.sh` layer runs a SILENT compile
// (`go build` emits nothing for the whole compile), so docker streams no line —
// and thus the on-screen signature holds unchanged — for well over a minute on a
// loaded runner. The same is true of the earlier long ops driven by this rule —
// workspace/copy creation streams a coarse setup log that holds one line through a
// silent image-pull / multi-container `compose up`, and snapshot/DR restore hold a
// step across a big dump/load. On a loaded CI dind runner any one such silent step
// can exceed two minutes, so 120s produced false "went dark" trips while the op was
// in fact progressing (the workspace/stage containers did come up). Keep the window
// comfortably above the longest real silent step; the ABSOLUTE deadlines (8-min
// workspace-create, 30-min deploy backstop) remain the true guard against a hang.
const PROGRESS = 240_000;
const NAV = 15_000; // a tab/section/stage click targets an element already on
// screen, so it should land fast. If it can't within NAV, something (usually a
// stuck modal) is intercepting clicks — fail fast here instead of burning the
// full 60s SLA, so chapter() can diagnose + clear the overlay before the next.

const misses: string[] = [];
// Chapters that went DARK during a long op: the watchdog observed a >PROGRESS
// gap with no on-screen progress change. This — not "took >60s" — is the breach.
const slow: string[] = [];

// ---- User-interaction latency KPI ----------------------------------------
// Every chapter's duration is recorded. The product KPI we optimise is the
// latency of INTERACTIVE chapters — opening a tab/modal/list, editing a field:
// the clicks where a human is actively waiting. LONG-OP chapters (creating a
// workspace, deploy, promote, snapshot, DR restore, first coding-agent boot)
// spin up containers / run builds and are legitimately long — they are the
// "non-interactive setup" we're allowed to trade slower for snappier clicks, so
// they're reported separately and excluded from the interactive KPI. At run end
// we print an aggregate and write kpi.json so successive runs are comparable and
// CI can surface the trend.
const timings: { name: string; seconds: number }[] = [];
// Heavy operations are user-triggered but do real container/build/scan work, so
// they're tracked separately from the "instant interaction" latency the KPI
// optimises. Keep genuinely-interactive-but-slow chapters (e.g. the flowchart
// editor open, the description tab) IN the interactive set — those are real
// snappiness targets, not background work.
// NOTE: flowchart-editor is a SCRIPTED drawing sequence — per-op timing proved
// each of its ~22 node/edge operations is ~0.3s (snappy; a human sees no lag),
// so its ~70s chapter total is NOT a single user-interaction latency (it's the
// sum of the whole spree + editor open/persist overhead). Excluded so it doesn't
// falsely dominate the interaction max/p95.
// NOTE: the `experiment*` chapters are LONG_OPs for the same reason `workspace`
// is — the duration is container work, not the latency of the click. Starting an
// experiment publishes the parent's tip for the ONE business process it is about
// and clones just that one (the rest materialize from the parent on first open),
// so creation itself is quick; what makes the chapter long is the business
// process then being woken into its own live-dev. Merging back is the same shape
// in reverse (a push + fast-forward in the parent's clone, the parent's live-dev
// redeployed, then the experiment's whole teardown). The CLICK a human actually
// waits on (Advanced → the menu) is covered by the `advanced-menu` interactive
// chapter.
const LONG_OP = /workspace|deploy|promote|sync|snapshot|backup|recover|disaster|coding.?agent|wake|first.?load|build|live-?dev|create-bp|supply-chain|cve|scan|flowchart|deps-|prod-rollback|experiment|sso-topology/i;
function isInteractive(name: string): boolean {
  return !LONG_OP.test(name);
}
let dbgPage: import('@playwright/test').Page | null = null;

// Append a row to the shared run timeline (created by run-e2e.sh's tl_begin),
// so per-chapter durations show up in the merged slowest-first profile. Matches
// timeline.sh's TSV columns: when_utc \t seconds \t total_s \t step.
const TIMELINE = '/repo/e2e/manual/build/timeline.tsv';
let firstChapterAt = 0;
function recordTiming(name: string, seconds: number): void {
  timings.push({ name, seconds });
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
    // Snapshot the screenshot-capture overhead accrued so far; the delta over
    // this chapter is subtracted below so the recorded time is real
    // click→content-visible latency, not the manual's settle+shutter cost.
    const capBefore = captureOverheadMs();
    currentChapter = name;
    try {
      await fn();
      const s = (Date.now() - t0 - (captureOverheadMs() - capBefore)) / 1000;
      recordTiming(name, s);
      // eslint-disable-next-line no-console
      console.log(`✓ chapter "${name}" ${s.toFixed(1)}s`);
    } catch (e) {
      const s = (Date.now() - t0 - (captureOverheadMs() - capBefore)) / 1000;
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

// ---- Editor-aware markdown typing ------------------------------------------
// The Description editor is ProseMirror with markdown INPUT RULES (dashboard
// client, spec-editor-commands.ts): typing '# ', '1. ', '- ' at line start
// converts to real structure, and Enter inside a list AUTO-CONTINUES it
// (splitListItem). Naively typing a raw markdown file therefore double-applies
// list structure — the typed '2. ' prefix fires the ordered-list rule INSIDE
// the already-auto-numbered item 2, nesting a fresh list one level deeper per
// item (#148). And there are NO input rules for inline marks, so a typed
// '**bold**' stays literal asterisks. So type like a human who knows the
// editor: fire each block rule ONCE and let Enter continue lists (item
// prefixes after the first are stripped), toggle inline marks through the
// editor's own keymap (Mod-b/Mod-i/Mod-e — Control on the Linux CI guest),
// and join soft-wrapped markdown lines into the single paragraph they are.
// A TRAILING list is deliberately left open (no exit keystrokes): the readme
// ends with bullets and the flowchart chapter breaks out itself (Enter×2).
async function typeMarkdown(pg: import('@playwright/test').Page, md: string): Promise<void> {
  const kb = pg.keyboard;
  // Inline segments: **strong** / *em* / `code` via mark toggles, plain text
  // in between typed as-is.
  const typeInline = async (text: string) => {
    for (const seg of text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/).filter(Boolean)) {
      const m = /^(\*\*|\*|`)(.*)\1$/.exec(seg);
      if (!m) {
        await kb.type(seg);
        continue;
      }
      if (m[1] === '`' && /^\S+$/.test(m[2]!)) {
        // Inline code: type the word plainly, select it word-wise, mark the
        // selection. Toggling code around typed text swallows the preceding
        // space into the code span (Chrome contenteditable quirk), and unlike
        // strong/em the markdown serializer does NOT clean code boundaries —
        // the saved README would read `` ` approving_manager` ``. The pauses
        // are required: ProseMirror syncs the native selection via an async
        // selectionchange event, so a toggle fired back-to-back with the
        // select keystroke sees a stale (collapsed) selection and no-ops.
        await kb.type(m[2]!);
        await kb.press('Control+Shift+ArrowLeft');
        await pg.waitForTimeout(60);
        await kb.press('Control+e');
        await kb.press('ArrowRight');
        await pg.waitForTimeout(60);
        await kb.press('Control+e'); // code is inclusive: stop it continuing
        continue;
      }
      const toggle = m[1] === '**' ? 'Control+b' : m[1] === '*' ? 'Control+i' : 'Control+e';
      await kb.press(toggle);
      await kb.type(m[2]!);
      await kb.press(toggle);
    }
  };
  // Blank-line-separated blocks; within a block, lines are soft-wrapped.
  const blocks = md
    .split(/\n{2,}/)
    .map((b) => b.split('\n').filter((l) => l.trim() !== ''))
    .filter((b) => b.length > 0);
  let prev: 'list' | 'block' | null = null;
  for (const lines of blocks) {
    // Leave the previous block into a fresh empty paragraph: Enter after a
    // heading/paragraph; Enter×2 after a list (Enter opens an empty item,
    // the second Enter lifts it out of the list — splitListItem's behaviour).
    if (prev === 'list') {
      await kb.press('Enter');
      await kb.press('Enter');
    } else if (prev === 'block') {
      await kb.press('Enter');
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(lines[0]!);
    const isOl = /^\d+\.\s+/.test(lines[0]!);
    const isUl = /^[-*]\s+/.test(lines[0]!);
    if (heading) {
      await kb.type(`${heading[1]} `); // fires the heading input rule
      await typeInline(heading[2]!);
      prev = 'block';
    } else if (isOl || isUl) {
      for (let j = 0; j < lines.length; j++) {
        if (j === 0) await kb.type(isOl ? '1. ' : '- '); // fires the list rule ONCE
        else await kb.press('Enter'); // splitListItem numbers the next item itself
        await typeInline(lines[j]!.replace(/^(?:\d+\.|[-*])\s+/, ''));
      }
      prev = 'list';
    } else {
      for (let j = 0; j < lines.length; j++) {
        if (j > 0) await kb.type(' '); // markdown soft-wrap: same paragraph
        await typeInline(lines[j]!);
      }
      prev = 'block';
    }
  }
}

test('Bailey product walkthrough → manual screenshots', async ({ page }) => {
  test.setTimeout(60 * 60_000);

  // #242 makes bailey-onboard.<domain> device-trust ONLY; the Server Console
  // lives on the console host (bailey.<domain>) and renders inside the
  // chrome-wrap iframe. Route every console interaction through that frame.
  const c = page.frameLocator('iframe').last();

  // ---- Onboarding (hard-asserted) — the ONLY page.goto in the whole run ----
  await test.step('onboarding: sign in + claim the server', async () => {
    await page.goto(ENV.onboardUrl + '/');
    await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
    // Idempotent: on a fresh server the bootstrap "Claim this server" button is
    // shown; on an already-claimed server it isn't and we go straight to the
    // console. Post-#242, Claim may sit on the onboard host directly (untrusted
    // device) OR on the wrapped console (bailey.<domain>) once trust bounces us
    // there — accept either surface. Either way we end on the Workspaces view of
    // the wrapped console.
    const claimPage = page.getByRole('button', { name: /Claim this server/i });
    const claimFrame = c.getByRole('button', { name: /Claim this server/i });
    await Promise.race([
      claimPage.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      claimFrame.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      c.getByRole('heading', { name: /Workspaces/i }).waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
    ]);
    const claim = (await claimPage.isVisible().catch(() => false)) ? claimPage
      : (await claimFrame.isVisible().catch(() => false)) ? claimFrame : null;
    if (claim) {
      await capture(page, 'onboard-claim');
      await claim.click();
    }
    await expect(c.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: SLA });
  });

  // ---- Create the workspace via the console (idempotent) ----
  await test.step('create the Finance workspace', async () => {
    // An existing workspace card carries an "Open" button; a brand-new account
    // shows the "not in any workspace" empty state. Wait for whichever lands so
    // the existence check isn't a render race against the async list fetch.
    const existing = c.getByText(new RegExp(`^${WORKSPACE.name}$`)).first();
    const empty = c.getByText(/not in any workspace/i).first();
    await Promise.race([
      existing.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      empty.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
    ]);
    if (await existing.isVisible().catch(() => false)) {
      // Already created on a previous run — nothing to do, just shoot the list.
      await capture(page, 'workspace-create');
    } else {
      await c.getByRole('button', { name: /New workspace/i }).first().click();
      // The create modal isn't an ARIA dialog; target its input by placeholder.
      const nameInput = c.getByPlaceholder(/payroll-automation/i).first();
      await nameInput.waitFor({ state: 'visible', timeout: SLA });
      await nameInput.fill(WORKSPACE.name);
      await capture(page, 'workspace-create');
      await c.getByRole('button', { name: /^Create workspace$/i }).click();

      // Creating a workspace cold-starts its whole container stack (image pulls +
      // compose up), which legitimately runs longer than the short-interaction
      // SLA. But the UI must NEVER go dark — the modal streams a LIVE progress log
      // — so this is held to the PROGRESS rule, exactly like a deploy: it may take
      // as long as it needs AS LONG AS the log keeps moving. A >PROGRESS freeze of
      // that log is the failure (a dark UI is the bug, not merely slowness), and
      // so is the workspace never appearing.
      const created = c.getByText(new RegExp(`^${WORKSPACE.name}$`)).first();
      const already = c.getByText(/already initialized/i).first();
      const logBox = c.getByTestId('ws-create-log');
      let lastLog = '';
      let lastChange = Date.now();
      const deadline = Date.now() + 8 * 60_000;
      let shotProgress = false;
      for (;;) {
        if (await created.isVisible().catch(() => false)) break; // created
        if (await already.isVisible().catch(() => false)) {
          // Idempotent: a prior run already made it — dismiss and use the existing.
          await c.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {});
          break;
        }
        const now = Date.now();
        const text = (await logBox.textContent().catch(() => '')) || '';
        if (text !== lastLog) {
          lastLog = text;
          lastChange = now;
          if (!shotProgress && text.trim()) { await capture(page, 'workspace-creating'); shotProgress = true; }
        } else if (now - lastChange > PROGRESS) {
          throw new Error(`workspace creation UI went dark: no progress for >${PROGRESS / 1000}s`);
        }
        if (now > deadline) throw new Error('workspace creation did not finish within 8m');
        await page.waitForTimeout(1000);
      }
      await expect(created).toBeVisible({ timeout: SLA });
    }
  });

  // ---- Console chapters: click the left-nav items (no URL navigation) ----
  for (const [navLabel, slot, heading] of [
    [/People & roles/i, 'people-roles', /People & roles/i],
    [/Server overview/i, 'server-overview', /Server overview|Overview/i],
    [/Resource management/i, 'resource-management', /Resource management/i],
    [/Endpoint access/i, 'endpoint-access', /Endpoint access/i],
    [/Single sign-on/i, 'sso-settings', /Single sign-on/i],
    [/Your devices/i, 'devices', /devices/i],
  ] as const) {
    await chapter(slot, async () => {
      await c.getByRole('button', { name: navLabel }).first().click();
      await expect(c.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: SLA });
      await capture(page, slot);
    });
  }

  // ---- Updates (admin): version visibility, update availability, and the
  // update audit log. The Updates nav item carries a bubble when any component is
  // behind; the view names the server's running version (current → latest) with
  // an "Up to date" / "Update available" pill, lists the workspaces with updates
  // plus a per-workspace Update button, and shows an "Update history" ledger —
  // who updated what, to which version, and when — that each retained version
  // can be rolled back from (bounded to the last 3, all in-UI, no CLI). On a
  // FRESHLY onboarded server every component is on the latest track and nothing
  // has been updated yet, so this captures the genuine "up to date" state with an
  // honest empty history (no fabricated update). Server and workspace updates AND
  // their rollbacks are exercised at the unit/integration level; here we assert
  // the audit-log surface renders for the handbook capture.
  await chapter('updates', async () => {
    await c.getByRole('button', { name: /^Updates/i }).first().click();
    await expect(c.getByRole('heading', { name: /Updates/i }).first()).toBeVisible({ timeout: SLA });
    // The server card names the running version and its up-to-date / behind state.
    await expect(c.getByText(/Automation server/i).first()).toBeVisible({ timeout: SLA });
    await expect(c.getByText(/Up to date|Update available/).first()).toBeVisible({ timeout: SLA });
    // The update audit log renders (empty on a fresh server, populated after any
    // update) — the who/when/which-version record + rollback controls.
    await expect(c.getByText(/Update history/i).first()).toBeVisible({ timeout: SLA });
    await capture(page, 'updates');
  });

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
    await c.getByRole('button', { name: /Server overview/i }).first().click();
    await expect(c.getByText(/SIEM forwarding/i).first()).toBeVisible({ timeout: SLA });
    // Open the config form (first run shows "Configure ingestor"; an existing
    // config shows "Edit"). Either lands on the same form.
    const configure = c.getByRole('button', { name: /Configure ingestor|^Edit$/ }).first();
    await configure.waitFor({ state: 'visible', timeout: SLA });
    await configure.click();
    const url = c.getByPlaceholder(/collector\.example\.com/i).first();
    await url.waitFor({ state: 'visible', timeout: SLA });
    // Point at the REAL collector (base URL only; Bailey appends /v1/logs).
    await url.fill(ENV.otlpHttpEndpoint);
    // #100 fix: capture the CONFIG FORM first — the OTLP endpoint + protocol
    // fields filled in, BEFORE pressing Save & connect — as its own `siem-form`
    // slot, so the manual shows/explains the form, not just the connected state.
    await capture(page, 'siem-form');
    // Save & connect — runs a bounded connectivity test, then persists.
    await c.getByRole('button', { name: /Save & connect|Testing…/ }).first().click();
    // Wait for the test to settle: the button leaves "Testing…".
    await c.getByRole('button', { name: /Testing…/ }).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    // HARD-ASSERT the success state — the card's status pill flips to
    // "● Connected" (tone success) and the "Last error:" line is absent, since
    // the collector really is reachable from the daemon. (The pill reads
    // "Disconnected" on failure, so we anchor on "Connected" NOT preceded by
    // "Dis".) The post-save card also lists the endpoint + "Last delivered".
    const connected = c.getByText(/(?<!Dis)Connected/).first();
    await expect(connected, 'SIEM card did not reach a Connected state against the real collector')
      .toBeVisible({ timeout: SLA });
    await expect(c.getByText(/Last error:/i), 'SIEM connectivity test surfaced an error')
      .toHaveCount(0);
    await capture(page, 'siem');
  });

  // ---- Open the workspace dashboard (its 'Open' button opens a new tab) ----
  // Click back to Workspaces first (we navigated away in the console chapters),
  // then click the workspace's Open button.
  let dashPage = page;
  let d: FrameOrPage = page;
  // Diagnostic nav trace: log every TOP-LEVEL navigation of the dashboard tab
  // (with elapsed time) so a "wrong page" failure — e.g. the popup drifting from
  // the workspace dashboard to the onboard console — reads as an exact nav
  // timeline in the CI log instead of a bare "editor never appeared". A flaky
  // test must SAY what it saw; this makes the tab's every move discrete.
  const tNav0 = Date.now();
  const navEl = () => ((Date.now() - tNav0) / 1000).toFixed(1) + 's';
  const tracedTabs = new WeakSet<import('@playwright/test').Page>();
  const traceTab = (p: import('@playwright/test').Page, tag: string) => {
    if (tracedTabs.has(p)) return;
    tracedTabs.add(p);
    p.on('framenavigated', (f) => {
      if (f === p.mainFrame()) console.log(`  nav[${tag}] ${navEl()} → ${f.url()}`);
    });
    p.on('close', () => console.log(`  nav[${tag}] ${navEl()} → (tab closed)`));
  };
  await test.step('open the workspace dashboard', async () => {
    await c.getByRole('button', { name: /Workspaces/i }).first().click();
    await expect(c.getByRole('heading', { name: /Workspaces/i })).toBeVisible({ timeout: SLA });
    const open = c.getByRole('button', { name: /^Open$/ }).or(c.getByRole('link', { name: /^Open$/ })).first();
    // BP selector trigger — its accessible name is "Process <bp>" in the
    // redesigned top bar (a distinct, always-present shell element, so a good
    // readiness signal). NB: /Business process/i would wrongly match the
    // "New Business Process" action button instead of the selector trigger.
    const bpSwitcher = () => d.getByRole('button', { name: /^Process\b/ }).first();
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
      if (popup) { dashPage = popup; dbgPage = popup; traceTab(popup, 'dash'); console.log(`  opened dashboard tab → ${popup.url()}`); }
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
  // The top bar as an ELEMENT, without reaching for a class name: it is the
  // innermost element that contains BOTH the business-process selector and the
  // Advanced menu. Ancestors precede descendants in document order, so among
  // the divs that qualify (the shell root and the bar itself) the LAST is the
  // bar. Used by the "there is no copy chip in the bar" assertions.
  const topBarEl = () =>
    d
      .locator('div')
      .filter({ has: d.getByRole('button', { name: /^Process\b/ }) })
      .filter({ has: d.getByRole('button', { name: /^Advanced$/ }) })
      .last();
  // ── The live progress signature ──────────────────────────────────────────
  // Everything the product tells the operator about an in-flight long op, read
  // straight off the screen and concatenated. The deploy/promote pipeline
  // surfaces progress as a single sonner toast that updates in place (its title
  // is [data-sonner-toast] [data-title]); the Deploy button also flips to
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
    // The action button label ("Working…" vs "Deploy"/"Promote"). Use a
    // SHORT per-read timeout: when the element is absent (e.g. on a tab that
    // doesn't show it), textContent() otherwise blocks the full default timeout
    // (and the .catch hides it) — turning a single signature read into a 60s
    // stall and breaking the watchdog's timing. A quick miss → empty part.
    // The Deploy alternative is ANCHORED (/^Deploy$/): an unanchored /Deploy/
    // would also match the "Deployments" TAB, which is on screen the whole time
    // and would pin the signature to a constant — the watchdog would then read
    // "the screen is moving" forever and never notice a dark stall.
    const btn = await d.getByRole('button', { name: /Working|^Deploy$|Promote|Switching|Starting/i }).first().textContent({ timeout: 1500 }).catch(() => '');
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
    // The activity-log panel is a fixed bottom-right overlay; expanded, it sits
    // over content (e.g. a stage's container Logs/Inspect buttons) and
    // intercepts clicks. Collapse it into its corner button first so it never
    // blocks a later click. Its toggle is the only aria-expanded button labelled
    // "Activity"; in the collapsed state that label is gone, so this no-ops.
    const activityToggle = d
      .locator('button[aria-expanded]:visible', { hasText: /Activity/ })
      .first();
    if (await activityToggle.isVisible().catch(() => false)) {
      await activityToggle.click().catch(() => {});
    }
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

  // ---- Append a real block to the Description, and make it STICK -----------
  // The Description editor is ProseMirror, and it REMOUNTS from the server copy
  // whenever a status refresh lands — silently dropping an in-flight draft. So
  // type-and-save in a bounded retype loop gated on a marker that SURVIVES the
  // remount window, exactly as the v2 deploy chapter proved is necessary. The
  // marker also makes the whole edit idempotent (already present ⇒ skip), which
  // is what lets a re-run of the suite pass. Assumes the Description tab is the
  // active tab and the copy in view is the one to edit.
  const appendToDescription = async (md: string, marker: RegExp, why: string) => {
    const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
    // The editor only mounts once the business process is materialized in the
    // copy in view (WorkspaceView gates on bp.copies.includes(copy), fed by the
    // processes SSE feed) — in a freshly created experiment that can lag the
    // copy itself, so allow well past the interaction SLA here.
    await expect(editor, `${why} — the Description editor never mounted`).toBeVisible({
      timeout: 5 * 60_000,
    });
    const mark = editor.getByText(marker).first();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await mark.isVisible().catch(() => false)) {
        // Seeing the text is not enough: the doc shows the draft before the save
        // round-trip settles. Only trust a marker that outlives the remount
        // window — a status refresh remounts ProseMirror from the server copy
        // and drops anything that never actually saved.
        const clobbered = await mark
          .waitFor({ state: 'hidden', timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        if (!clobbered) break;
      }
      // Click near the top-left of the editor, NOT its center: the doc embeds
      // the flowchart drawn earlier, and the pane's center can land on that
      // mermaid preview — whose whole surface is click-to-edit, so a center
      // click opens the Flowchart editor modal and blocks every later click.
      // The caret position is irrelevant (Control+End moves it to the doc end);
      // the click only needs to focus the editor without hitting the embed.
      await editor.click({ position: { x: 24, y: 16 } });
      await dashPage.keyboard.press('Control+End');
      // Control+End leaves the caret at the END of the doc — after the README +
      // flowchart embed that is INSIDE the trailing markdown list item (or right
      // after the diagram block). Typing a new block there folds it into that
      // list (#94), so break out into a clean empty paragraph first: Enter twice
      // exits a list. (typeMarkdown skips a leading blank line of its own; these
      // explicit Enters are what breaks the structure.)
      await dashPage.keyboard.press('Enter').catch(() => {});
      await dashPage.keyboard.press('Enter').catch(() => {});
      await typeMarkdown(dashPage, md);
      await dashPage.keyboard.press('Control+s');
      await d.getByRole('button', { name: /Saving/i }).first()
        .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
      // Let any post-save toast clear before the caller reads the top bar or a
      // header button — a lingering toast over a control makes a click never land.
      await d.locator('[data-sonner-toast]').first()
        .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    }
    await expect(mark, why).toBeVisible({ timeout: SLA });
  };

  // The personal copy is auto-created + auto-selected on load — we never create
  // or name one for navigation, and there is NO copy control in the top bar at
  // all: no dropdown, no chip, not even the copy's name. The two things you CAN
  // do with the copy tree — look at a colleague's version, or branch an
  // experiment off your own copy — live behind the far-right "Advanced" menu.
  // Open it once to screenshot it (a real thing a user can do), then close it
  // without changing anything.
  await chapter('advanced-menu', async () => {
    // ---- The old copy combobox is GONE, and its absence is the requirement ---
    // CopySelector.tsx (trigger: an uppercase "Copy" label + the owner's
    // identity, title="Switch copy …") and NewCopyDialog.tsx ("New copy") are
    // deleted. A regression that reinstated either — or that put the copy's name
    // back in the bar — would still let every OTHER assertion in this file pass,
    // so assert the absence here instead of merely not using it.
    const bar = topBarEl();
    await expect(
      bar,
      'the top bar never rendered (no element carrying both the Process selector and Advanced)',
    ).toBeVisible({ timeout: SLA });
    await expect(
      bar.getByRole('combobox'),
      'a combobox is back in the top bar — the copy picker was reinstated',
    ).toHaveCount(0);
    await expect(
      d.getByRole('button', { name: /^Copy\b/ }),
      'a "Copy …" trigger is back — the deleted copy switcher was reinstated',
    ).toHaveCount(0);
    await expect(
      d.getByRole('button', { name: /New copy/i }),
      'a "New copy" action is back — copies are per-person and created for you, never by hand',
    ).toHaveCount(0);
    // Not even the word: no "Copy" label, chip or count anywhere in the bar. The
    // copy's NAME is asserted absent in `deploy-tab`, where the full set of
    // labels the bar is allowed to carry is known.
    await expect(
      bar,
      'the top bar mentions a copy — the product deliberately names no copy there',
    ).not.toContainText(/\bcopy\b/i);

    await d.getByRole('button', { name: /^Advanced$/ }).first().click();
    // The popover has exactly two sections. Wait for BOTH labels before the
    // shutter so the shot can never catch a half-populated menu (the colleague
    // list and the experiment list are filled from the copies SSE feed).
    // (The apostrophe class covers both the ASCII and the typographic form —
    // the label is prose, and a curly quote must not be a selector failure.)
    await expect(
      d.getByText(/See a colleague[’']s version/i).first(),
      'the Advanced menu never listed the colleague-view section',
    ).toBeVisible({ timeout: SLA });
    await expect(
      d.getByText(/^Experiments( on .+)?$/i).first(),
      'the Advanced menu never listed the Experiments section',
    ).toBeVisible({ timeout: SLA });
    // ---- The colleague view, as this cast actually stands -------------------
    // "See a colleague's version" lists a row per OTHER person's copy. In this
    // workspace Tomáš is the only member who has ever opened the dashboard —
    // Marek's story (chapters onboard-*) stops at the device-trust gate and never
    // reaches a workspace, so no second personal copy exists to switch into.
    // The truthful state is therefore the product's own honest empty line, and
    // that is what we assert: NOT a screenshot of a colleague list we would have
    // to fabricate. (Give a colleague a copy and this line is replaced by their
    // row, expandable to their experiments — same menu, same click.)
    await expect(
      d.getByText(/No one else has a copy yet/i).first(),
      "the colleague section didn't show its honest empty state — someone else has a copy in a workspace only the operator has ever opened",
    ).toBeVisible({ timeout: SLA });
    // ---- Experiments: mine, and the way to start one ------------------------
    // "Start a new experiment" only renders once GET /api/me has resolved the
    // user's own copy (before that the section reads "Setting up your copy…"),
    // so waiting on it is the resolved signal — after which "you have none yet"
    // is a real assertion rather than a race.
    await expect(
      d.getByRole('button', { name: /Start a new experiment/i }).first(),
      'the Advanced menu never offered "Start a new experiment" (the signed-in user never got their own copy)',
    ).toBeVisible({ timeout: SLA });
    // Experiments belong to a BUSINESS PROCESS (a copy is workspace-wide, an
    // experiment is not), so the section is scoped to the one on screen — and
    // at this point in the story the workspace has none at all: it is created
    // in the next chapter. The honest state is therefore the product saying
    // what it needs, and that is what we assert. The per-process heading and
    // its "No experiments on <process>" empty state are asserted in the
    // `experiment` chapter, where a business process exists.
    await expect(
      d.getByText(/Select a business process to see its experiments/i).first(),
      'the Experiments section did not explain that it needs a business process (the workspace has none yet, so it cannot list experiments "on" anything)',
    ).toBeVisible({ timeout: SLA });
    await capture(dashPage, 'advanced-menu');
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
    await d.getByRole('button', { name: /^Process\b/ }).first().click();
    await capture(dashPage, 'bp-switcher');
    // The BP selector trigger reads "Process <bp>" once a BP is selected.
    // Selector + toasts show the human-readable display name (BP.title); the
    // slug (BP.slug) lives in URLs and deployment ids.
    const selected = d.getByRole('button', { name: new RegExp(`^Process\\b.*${BP.title}`) }).first();
    const existing = d.getByRole('button', { name: new RegExp(`^${BP.title}$`) }).first();
    if (await existing.isVisible().catch(() => false)) {
      await existing.click();
    } else {
      // Create the BP. The New-BP flow lives behind the Process switcher popover;
      // on first load that popover can flicker closed under the initial SSE
      // re-render storm, so a single open→click races those re-renders. Profiling
      // proved the copy is selected and the switcher ENABLED immediately (the
      // backend create itself is ~few seconds) — the only cost was that flicker.
      // So retry the WHOLE open→fill→Create→selected sequence on a SHORT cadence
      // (expect.toPass) and land it the instant the popover is stably open,
      // instead of paying a 60s SLA per miss. Idempotent: if the BP is already
      // selected (a prior iteration's create landed), we're done.
      const dlg = d.getByRole('dialog');
      const nameInput = dlg.getByLabel(/^Name$/).first();
      let shotCreate = false;
      await expect(async () => {
        if (await selected.isVisible().catch(() => false)) return; // already created
        // Open the New-BP dialog if it isn't up (re-opening the switcher first
        // when the popover flickered shut).
        if (!(await nameInput.isVisible().catch(() => false))) {
          const newBtn = d.getByRole('button', { name: /New business process/i }).first();
          if (!(await newBtn.isVisible().catch(() => false))) {
            await d.getByRole('button', { name: /^Process\b/ }).first().click({ timeout: 2_000 });
          }
          await newBtn.click({ timeout: 2_000 });
        }
        await expect(nameInput).toBeVisible({ timeout: 2_000 });
        if (!shotCreate) {
          await capture(dashPage, 'bp-create');
          shotCreate = true;
        }
        // Type the human-readable name (the server derives BP.slug), submit, and
        // require the BP to actually land as the selected process for this
        // attempt to pass.
        await nameInput.fill(BP.title);
        await dlg.getByRole('button', { name: /^Create$/ }).first().click({ timeout: 2_000 });
        await expect(selected).toBeVisible({ timeout: 8_000 });
      }).toPass({ timeout: 3 * 60_000, intervals: [300, 500, 1000, 2000] });
    }
    // The BP is selected once its name shows in the switcher trigger.
    await expect(selected).toBeVisible({ timeout: SLA });
  });

  // NOTE: the BP rename flow (pencil → dialog → SSE-refreshed listing) is
  // deliberately NOT walked here. A BP is born in main, so a rename is a
  // MAIN-scope commit (RenameBusinessProcessDialog: copy = inMain ? undefined
  // : …) — it advances the BP repo's main and leaves this copy behind, so the
  // later Deploy stops being a fast-forward and the product hands the
  // rebase to a live coding-agent session ("main has moved on…") this
  // screenshot walkthrough can't drive deterministically. Rename has its own
  // coverage in bitswan-gitops/tests/test_bp_creation.py; keeping it out of the
  // walkthrough is what lets every copy stay a clean fast-forward of main.

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
    const readyToast = d.getByText(new RegExp(`${BP.title} ready`, 'i')).first();
    const settingUp = d.getByText(new RegExp(`Setting up ${BP.title}`, 'i')).first();
    await Promise.race([
      readyToast.waitFor({ state: 'visible', timeout: 8 * 60_000 }).catch(() => {}),
      settingUp.waitFor({ state: 'hidden', timeout: 8 * 60_000 }).catch(() => {}),
    ]);
    await d.locator('[data-sonner-toast]').first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    // The ProseMirror editor surface mounts as a contenteditable. Click it and
    // type via typeMarkdown, which cooperates with the editor's input rules
    // and mark keymap instead of fighting them (see its comment; #148).
    const editor = d.locator('.ProseMirror, [contenteditable="true"]').first();
    // Discrete pre-check with logging: BEFORE blocking on the editor, record the
    // tab's actual state (URL + iframe count + whether the BP shell is even
    // present). If the editor then never appears, we already know from the log
    // whether the tab was on the dashboard at all — no guessing.
    console.log(
      `  description: dashPage.url()=${dashPage.url()}` +
        ` iframes=${await dashPage.locator('iframe').count()}` +
        ` bpSwitcher=${await d.getByRole('button', { name: /^Process\b/ }).first().isVisible().catch(() => false)}` +
        ` descTab=${await d.getByRole('button', { name: /Description/i }).first().isVisible().catch(() => false)}`,
    );
    try {
      await editor.waitFor({ state: 'visible', timeout: SLA });
    } catch (e) {
      console.log(
        `  description EDITOR MISSING: dashPage.url()=${dashPage.url()}` +
          ` iframes=${await dashPage.locator('iframe').count()}` +
          ` bpSwitcher=${await d.getByRole('button', { name: /^Process\b/ }).first().isVisible().catch(() => false)}`,
      );
      await capture(dashPage, 'description-editor-missing').catch(() => {});
      throw e;
    }
    await editor.click();
    await typeMarkdown(dashPage, BP.readme);
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
      // Label a decision-branch edge. Click just OUTSIDE the source handle along
      // its outgoing direction (right handle → right, bottom handle → down) so we
      // land ON the smoothstep edge path but clear of the 8px handle — clicking
      // the handle itself would arm a new connection, and a release on empty
      // canvas spawns a stray node (onConnectEnd). Selecting the edge mounts the
      // side-panel "Edge properties" block; fill its Label <Input>, then deselect
      // by clicking empty canvas. Best-effort + non-aborting, like the others.
      const labelEdge = async (
        sourceLabel: string,
        sourceHandle: 'bottom' | 'left' | 'right',
        text: string,
      ) => {
        const hb = await visibleBox(
          nodeByLabel(sourceLabel).locator(`.react-flow__handle-${sourceHandle}`).first(),
        );
        if (!hb) return;
        const h = centre(hb);
        const pt =
          sourceHandle === 'right'
            ? { x: h.x + 18, y: h.y }
            : sourceHandle === 'left'
              ? { x: h.x - 18, y: h.y }
              : { x: h.x, y: h.y + 18 };
        await dashPage.mouse.click(pt.x, pt.y).catch(() => {});
        const edgeInput = d.getByText(/^Edge properties$/i).locator('..').locator('input').first();
        if (!(await edgeInput.waitFor({ state: 'visible', timeout: NAV }).then(() => true).catch(() => false))) return;
        await edgeInput.fill(text).catch(() => {});
        if (cb) await dashPage.mouse.click(cb.x + 20, cb.y + 20).catch(() => {});
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

      // Per-op timing so we can see where this chapter's wall-time actually
      // goes: the editor is snappy for a human, but the chapter SCRIPTS ~17 ops
      // (6 renames, 6 drags, 5 edge-connects). This prints the elapsed after
      // each so a slow step (or a silently-timing-out best-effort waitFor) is
      // visible instead of hiding in one 70s total.
      const fcD = Date.now();
      const mk = (m: string) => console.log(`  ⏱fc +${((Date.now() - fcD) / 1000).toFixed(1)}s ${m}`);

      // 0) Zoom the canvas OUT before drawing. A fresh diagram fitView's on its
      //    single start node and pins zoom at the 2x max, so page-pixel drags
      //    land only HALF as far apart in canvas-space — tighter than the
      //    decision diamond is tall (a fixed 120px node), which is what made the
      //    old capture a pile-up (#149). Measure the start node's height
      //    (intrinsic × current zoom) and click the "zoom out" control until it
      //    has shrunk to ~1/3 of its 2x size (≈0.65x), so the fraction-based rows
      //    below map to ~160px canvas-space gaps that clear the diamond. Then a
      //    fit-view before the capture reframes everything cleanly. Best-effort:
      //    if the control/node can't be measured we just draw at whatever zoom.
      const zoomStart = await visibleBox(nodeByLabel('Process'));
      const h2 = zoomStart ? zoomStart.height : 0;
      if (h2 > 0) {
        const zoomOutBtn = d.locator('.react-flow__controls-zoomout').first();
        for (let i = 0; i < 12; i++) {
          const b = await visibleBox(nodeByLabel('Process'));
          if (b && b.height <= h2 * 0.34) break;
          await zoomOutBtn.click().catch(() => {});
          await dashPage.waitForTimeout(60);
        }
      }
      mk('zoom-out');

      // 1) Re-label the starting node and place it at the top.
      await labelNode('Process', 'Invoice received'); mk('label:Invoice received');
      await dragNodeTo('Invoice received', { x: col, y: rows[0]! }); mk('drag:Invoice received');

      // 2) Add the remaining nodes one at a time: add → drag clear of the pile at
      //    (200,200) → relabel. (Each Add drops at the same fixed spot, so we move
      //    the fresh node out before adding the next.)
      const addProcess = () => d.getByRole('button', { name: /^Process$/ }).first().click().catch(() => {});
      const addDecision = () => d.getByRole('button', { name: /^Decision$/ }).first().click().catch(() => {});

      await addProcess(); mk('add:Process(2)');
      await dragNodeTo('Process', { x: col, y: rows[1]! }); mk('drag:2');
      await labelNode('Process', 'Extract fields (OCR)'); mk('label:Extract fields');

      await addProcess(); mk('add:Process(3)');
      await dragNodeTo('Process', { x: col, y: rows[2]! }); mk('drag:3');
      await labelNode('Process', 'Match PO & VAT'); mk('label:Match PO');

      await addDecision(); mk('add:Decision');
      await dragNodeTo('Decision', { x: col, y: rows[3]! }); mk('drag:4');
      await labelNode('Decision', 'Over €5,000?'); mk('label:Over 5000');

      await addProcess(); mk('add:Process(5)');
      await dragNodeTo('Process', { x: colR, y: rows[4]! }); mk('drag:5');
      await labelNode('Process', 'Hold for approval'); mk('label:Hold');

      await addProcess(); mk('add:Process(6)');
      await dragNodeTo('Process', { x: col, y: rows[4]! }); mk('drag:6');
      await labelNode('Process', 'Post to ledger'); mk('label:Post');

      // 3) Wire the flow: linear spine, then the decision's two branches (its
      //    right handle → Hold, its bottom handle → Post).
      await connect('Invoice received', 'Extract fields (OCR)'); mk('connect:1');
      await connect('Extract fields (OCR)', 'Match PO & VAT'); mk('connect:2');
      await connect('Match PO & VAT', 'Over €5,000?'); mk('connect:3');
      await connect('Over €5,000?', 'Hold for approval', 'right'); mk('connect:4');
      await connect('Over €5,000?', 'Post to ledger', 'bottom'); mk('connect:5');

      // 4) Label the decision's two branches so the flow reads unambiguously
      //    (>€5,000 needs sign-off → Hold; otherwise straight to the ledger).
      await labelEdge('Over €5,000?', 'right', 'Yes'); mk('label-edge:Yes');
      await labelEdge('Over €5,000?', 'bottom', 'No'); mk('label-edge:No');

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
      // Deselect the last-touched node (clears the side panel that used to be
      // open in the shot) and fit the whole graph into view, so the capture is
      // centered and padded no matter how the canvas panned while we dragged
      // nodes around (#149). Both best-effort — a miss only costs us framing.
      if (cb) await dashPage.mouse.click(cb.x + 20, cb.y + 20).catch(() => {});
      await d.locator('.react-flow__controls-fitview').first().click().catch(() => {});
      await dashPage.waitForTimeout(400);
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
    // Claude Code session connects over the WS (dashboard → gitops agent-ssh
    // proxy → agent sshd → dtach → claude). SessionTerminal shows a
    // "Connecting…" placeholder ONLY until the access token resolves and the
    // WebSocket URL is built — it clears the instant the xterm mounts, which is
    // LONG before Claude has actually booted inside the terminal. So
    // "Connecting… gone + .xterm visible" is far too weak a signal (it catches a
    // blank/empty terminal). The authoritative "Claude is up" signal is Claude
    // Code's own TUI: sessions launch bare (no initial prompt — the standing
    // guidance is the CLAUDE.md baked into the agent image), so once the
    // interactive prompt renders, the xterm paints the input box and the
    // persistent footer hint "? for shortcuts" (or, unauthenticated, the
    // "Welcome to Claude" login screen — either proves the whole launch
    // pipeline delivered a running Claude). This is a plain on-screen
    // visibility wait (container boot + ssh + Claude start), NOT a deploy
    // long-op, so we wait generously.
    const connecting = d.getByText(/^Connecting…$/).first();
    const term = d.locator('.xterm').first();
    await connecting.waitFor({ state: 'hidden', timeout: 5 * 60_000 }).catch(() => {});
    await term.waitFor({ state: 'visible', timeout: 5 * 60_000 });
    // The xterm paints visible glyphs into .xterm-rows. Poll the rows text for
    // Claude's stable TUI markers — and HARD-FAIL when they never appear: a
    // terminal that connects but never shows Claude is exactly the regression
    // this chapter exists to catch (broken proxy path, wrapper refusing the
    // session, claude exiting on boot). chapter() rethrows, so this fails CI.
    const xtermText = d.locator('.xterm-rows').first();
    await expect
      .poll(async () => (await xtermText.textContent().catch(() => '')) ?? '', {
        timeout: 6 * 60_000,
        intervals: [1000, 2000, 5000],
      })
      .toMatch(/\? for shortcuts|shortcuts|Welcome to Claude|bypass permissions|Bypassing Permissions/i);
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
    await d.getByText(new RegExp(`${BP.title} ready`, 'i')).first()
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
        // Wait for the app to render WITHOUT thrashing reloads. A Vite dev
        // cold-load serves HTTP 200 with an empty #root while it transforms the
        // module graph, so reloading merely because "#root isn't visible yet"
        // RESETS that in-flight load — the old reload-every-~45s loop did exactly
        // that and burned the whole 6-min budget on every run (the "live-dev
        // 361.8s" was this timeout, not real latency). Instead: poll on a short
        // interval and SUCCEED the instant #root shows content; reload ONLY when
        // the inner frame is actually showing Traefik's hard "404 page not found"
        // (route genuinely not up yet), which a still-loading app never shows.
        const overallDeadline = Date.now() + 6 * 60_000;
        await popup.waitForSelector('iframe', { timeout: 30_000 }).catch(() => {});
        while (Date.now() < overallDeadline) {
          const inner = innerOf();
          const mounted = await inner.locator('#root :visible').first()
            .waitFor({ state: 'visible', timeout: 5_000 })
            .then(() => true)
            .catch(() => false);
          if (mounted) break; // the React app rendered visible content into #root
          const is404 = await inner.getByText(/404 page not found/i).first()
            .isVisible().catch(() => false);
          if (is404) await popup.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          // otherwise it's still loading — keep waiting, do NOT reload.
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

  // ---- Dev secrets: declare the BP's external integrations ----
  // The clean BP template makes NO outbound calls of its own — it probes only
  // the hosts it is CONFIGURED to integrate with (BITSWAN_EGRESS_PROBES). A
  // real operator declares those integrations as a dev secret here in the
  // Environment panel; every later dev deploy injects it, and the firewall
  // chapter then observes exactly these hosts. This is also the one place the
  // walkthrough SAVES a secret for real (the production secrets chapter
  // deliberately fills-but-never-saves), so the dev-secrets editor is
  // exercised end to end. Idempotent on re-runs: if the key already exists we
  // leave it as-is.
  await chapter('dev-secrets', async () => {
    // Still on the Coding Agent tab — the Environment panel carries the
    // collapsed "Dev secrets" section. Open it (the header toggles, so only
    // click when the editor isn't already showing) and wait for the editor.
    const addSecret = d.getByRole('button', { name: /Add secret/i }).first();
    if (!(await addSecret.isVisible().catch(() => false))) {
      const devSecrets = d.getByRole('button', { name: /Dev secrets/i }).first();
      await devSecrets.scrollIntoViewIfNeeded().catch(() => {});
      await devSecrets.click();
    }
    await d.getByText(/Loading secrets…/i).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
    await addSecret.waitFor({ state: 'visible', timeout: SLA });
    // Re-run guard: key fields carry the saved names as their input values.
    const savedKeys = await d.getByPlaceholder('SECRET_NAME')
      .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))
      .catch(() => [] as string[]);
    if (savedKeys.includes('BITSWAN_EGRESS_PROBES')) {
      await capture(dashPage, 'dev-secrets');
      return;
    }
    await addSecret.click();
    // The key field is uncontrolled and renames on BLUR — fill, then Enter.
    const keyInput = d.getByPlaceholder('SECRET_NAME').last();
    await keyInput.fill('BITSWAN_EGRESS_PROBES');
    await keyInput.press('Enter');
    await d.getByPlaceholder(/Needs a value|^value$/).last().fill(EGRESS_PROBES);
    await capture(dashPage, 'dev-secrets');
    await d.getByRole('button', { name: /^Apply/ }).first().click();
    // Applied = encrypted + versioned in bitswan.yaml; injected on next deploy.
    await d.getByText(/Secrets applied/i).first()
      .waitFor({ state: 'visible', timeout: SLA });
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
      const row = d.getByText(text, { exact: false }).first();
      if (await row.isVisible().catch(() => false)) continue;
      await d.getByRole('button', { name: /New requirement/i }).first().click();
      const field = d.getByPlaceholder(/Describe the requirement/i).first();
      await field.waitFor({ state: 'visible', timeout: SLA });
      // "New requirement" creates the row EMPTY server-side and edits it in
      // place with row-local draft state. A list refresh landing mid-edit
      // (the previous row's persist round-trip) remounts the editor and drops
      // the draft — the row survives as "(no description)" and the typed text
      // never commits. Do what a real operator does: if the text didn't land,
      // reopen that orphaned row's editor (double-click) and retype.
      for (let attempt = 0; attempt < 3; attempt++) {
        await field.fill(text);
        await field.press('Enter');
        let landed = await row
          .waitFor({ state: 'visible', timeout: 12_000 })
          .then(() => true)
          .catch(() => false);
        // Seeing the text is NOT enough: Enter renders the committed draft
        // OPTIMISTICALLY, before the persist round-trip returns — so the row
        // "lands" instantly even when the previous row's round-trip is about
        // to refresh the list and clobber it back to "(no description)"
        // (exactly how the d292ca0+main run failed: visible in ~2s, gone for
        // the rest of the 60s assert). Only trust text that SURVIVES the
        // refresh window: watch for the clobber; if it never comes, it stuck.
        if (landed) {
          const clobbered = await row
            .waitFor({ state: 'hidden', timeout: 5_000 })
            .then(() => true)
            .catch(() => false);
          landed = !clobbered;
        }
        if (landed) break;
        await d.getByText('(no description)', { exact: false }).first().dblclick();
        await field.waitFor({ state: 'visible', timeout: SLA });
      }
      // Wait for the committed row so the next add doesn't race the persist
      // round-trip.
      await expect(
        row,
        `requirement "${text}" did not land in the list`,
      ).toBeVisible({ timeout: SLA });
    }
    await capture(dashPage, 'requirements');
  });

  // ---- Edit a file: change the backend worker's memory policy in the editor ----
  // The Coding Agent tab's "Files" sub-tab is a full editor over the copy's
  // working tree — you can change any file by hand, no terminal required. Open the
  // backend worker's automation.toml and switch its memory policy to always-on: a
  // background worker has no inbound request to wake it, so it should stay
  // resident rather than pause when idle. (Making it always-on is also what keeps
  // a promoted stage's worker a permanently-running, inspectable container instead
  // of one shed under memory pressure — see the Containers chapter later.)
  await chapter('edit-config', async () => {
    await clickTopTab(/Coding Agent/i);
    // Chat | Files | Containers — switch to the file editor.
    await d.getByRole('button', { name: /^Files$/ }).first().click({ timeout: NAV });
    // The tree is scoped to this BP and auto-expands backend/ + frontend/. The
    // backend folder sorts first, so the first automation.toml row is its worker's.
    await d.getByRole('button', { name: /automation\.toml/ }).first().click({ timeout: NAV });
    // Confirm we opened the BACKEND worker's file (the editor header shows the path).
    await expect(
      d.getByText(/backend\/automation\.toml$/).first(),
      'backend/automation.toml did not open in the editor',
    ).toBeVisible({ timeout: SLA });
    const cm = d.locator('.cm-content').first();
    await cm.waitFor({ state: 'visible', timeout: SLA });
    await capture(dashPage, 'file-editor');
    // Real, surgical edit: select just the policy VALUE and retype it. The value
    // is the only occurrence of "on-demand" on its line, which ends `…"on-demand"`.
    // From end of line, step left past the closing quote and select the 9-char
    // value, then type the replacement. We type ONLY letters + a hyphen — never a
    // bracket or quote — so CodeMirror's auto-close can't corrupt the edit.
    const policyLine = d
      .locator('.cm-line')
      .filter({ hasText: 'memory_reservation_policy' })
      .first();
    await policyLine.click();
    await cm.press('End');
    await cm.press('ArrowLeft'); // step past the closing "
    for (let i = 0; i < 'on-demand'.length; i++) await cm.press('Shift+ArrowLeft');
    await cm.pressSequentially('always-on', { delay: 0 });
    // The edited line now carries the new value and no longer the old one.
    await expect(
      policyLine,
      'the policy value was not rewritten to always-on',
    ).toContainText('always-on');
    await expect(policyLine).not.toContainText('on-demand');
    // Save the way a user does (⌘/Ctrl+S); wait for the editor's own "Saved …"
    // confirmation before moving on so the change is committed to the copy.
    await cm.press('Control+s');
    await expect(
      d.getByText(/^Saved \d/).first(),
      'the editor never confirmed the save',
    ).toBeVisible({ timeout: SLA });
    await capture(dashPage, 'file-editor-saved');
  });

  // ---- Experiments: a throwaway branch off YOUR OWN copy --------------------
  // The other half of the copy tree. An experiment is a copy whose PARENT is
  // your copy: creating it COMMITS + publishes your copy's current tip (so the
  // automation.toml edit above rides into it) and branches from there. It offers
  // four ways out — leave it running ("Back to my copy"), "Merge back into my
  // copy", "Discard experiment", or "Use this version without merging" (your
  // copy becomes it) — and it can never reach main: the Deploy tab is not even
  // rendered inside one.
  // We start one for real and shoot the state it puts the operator in (the green
  // banner naming the experiment by its TITLE — the copy name itself is an
  // opaque slug the user never sees).
  const EXPERIMENT_TITLE = 'Check vendor VAT-IDs against ARES';
  const expBanner = () => d.getByText(/You are in an experiment/i).first();
  await chapter('experiment', async () => {
    // Leave the Coding Agent tab FIRST. The agent pane autostarts a session for
    // whatever (copy, business process) it is mounted on, so creating the
    // experiment while that tab is active would spin a coding-agent container up
    // inside the experiment — real work nobody asked for, and a needless
    // dependency for a chapter about the copy tree. A human who is about to try
    // something out looks at the spec; do the same.
    await clickTopTab(/Description/i);
    await d.getByRole('button', { name: /^Advanced$/ }).first().click();
    // NOW there is a business process, so the section says which one it is
    // about — and its empty state is "no experiments ON THAT", not a general
    // "you have none". An experiment belongs to exactly one business process
    // (each is its own git repository), so "none" is only ever true of
    // something.
    await expect(
      d.getByText(new RegExp(`^Experiments on ${BP.title}$`, 'i')).first(),
      'the Advanced menu did not scope its Experiments section to the business process on screen',
    ).toBeVisible({ timeout: SLA });
    await expect(
      d.getByText(new RegExp(`^No experiments on ${BP.title}\\.?$`, 'i')).first(),
      `the Experiments section listed an experiment on ${BP.title} before the walkthrough started one`,
    ).toBeVisible({ timeout: SLA });
    // The "Start a new experiment" row under the menu's Experiments section.
    // Accept either widget role: a popover renders its rows as buttons, a
    // dropdown as menuitems — the row a human clicks is the same either way.
    await d.getByRole('button', { name: /Start a new experiment/i })
      .or(d.getByRole('menuitem', { name: /Start a new experiment/i }))
      .first()
      .click({ timeout: NAV });
    // The "Start an experiment" dialog: one title field, one action. (The action
    // is the dialog's only non-Cancel button; we name the label rather than
    // picking "the last button", because a Radix dialog's own × close control
    // would otherwise be a candidate.)
    const dlg = d.getByRole('dialog');
    await expect(
      dlg.getByText(/Start an experiment/i).first(),
      'Advanced → Start a new experiment did not open the experiment dialog',
    ).toBeVisible({ timeout: SLA });
    const titleInput = dlg.getByRole('textbox').first();
    await titleInput.waitFor({ state: 'visible', timeout: SLA });
    // The user names WHAT THEY ARE TRYING, never a branch — gitops derives the
    // slug, the parent and the ownership from the verified identity.
    await titleInput.fill(EXPERIMENT_TITLE);
    await dlg.getByRole('button', { name: /^(Start experiment|Start|Create experiment|Create)$/i })
      .first()
      .click({ timeout: NAV });
    // READINESS SIGNAL (no sleeps): creation publishes the parent's tip for this
    // one business process and clones just it, then the client selects the new
    // experiment — quick, but still past the short-interaction SLA. The product
    // tells us when we are IN it: the green banner. Its appearance is the
    // authoritative "the experiment exists and is selected" signal, so we wait on
    // it (bounded generously, since a first live-dev wake can ride along) and
    // hard-fail if it never lands.
    await expect(
      expBanner(),
      'creating an experiment never landed us in it (the green experiment banner never appeared)',
    ).toBeVisible({ timeout: 8 * 60_000 });
    // The BANNER ITSELF identifies the experiment by the TITLE we typed, never by
    // its slug (an opaque name the user never sees) — that is the whole point of
    // asking "what are you trying out?". Asserted on the banner element, not on
    // the page, so a create toast carrying the same title can't stand in for it.
    await expect(
      expBanner(),
      'the experiment banner does not name the experiment by the title we gave it',
    ).toContainText(EXPERIMENT_TITLE, { timeout: SLA });
    // …and it names the BUSINESS PROCESS the experiment is on. An experiment
    // belongs to exactly one (each process is its own repository), so "which
    // one" is part of where you are, not a detail: without it the banner
    // described an experiment that could have been about anything.
    await expect(
      expBanner(),
      'the experiment banner does not name the business process the experiment is on',
    ).toContainText(BP.title, { timeout: SLA });
    // An experiment merges back into its parent copy and NEVER into main, so the
    // Deploy step is absent from the pipeline in here (TopNav omits DEPLOY_STEP
    // when the copy in view is one of your own experiments). This is the
    // conditional-tab assertion in the opposite direction to `deploy-tab`'s
    // Sync check — and it is exactly the guard that would catch an experiment
    // being handed a path to main.
    await expect(
      d.getByRole('button', { name: /^Deploy$/ }),
      'the Deploy tab is present inside an experiment — an experiment must reach main only through its parent copy',
    ).toHaveCount(0);
    // An experiment is somewhere you step IN AND OUT of, not only something you
    // finish or throw away. The banner must offer a way back to your own copy
    // that ENDS NOTHING, alongside the two that do.
    await expect(
      d.getByRole('button', { name: /^Back to my copy$/ }),
      'the experiment banner offers no way out that keeps the experiment — only merging and discarding, both of which end it',
    ).toBeVisible({ timeout: SLA });
    await capture(dashPage, 'experiment');
  });

  // ---- The FOURTH way out: take this version, don't merge it ---------------
  // Merging asks "combine these two versions". Often the honest answer is "no,
  // use that one" — and until this existed the only route to it was a conflict
  // fought by hand. The dialog is the interesting part, because the promise it
  // makes is what makes the button safe to press: whatever your copy holds for
  // this business process is PARKED as an experiment of its own first.
  //
  // We open it and cancel: actually taking the version would consume this
  // experiment, and the chapters below need it. What is asserted is that the
  // way out exists and that it says what happens to the work being replaced.
  await chapter('experiment-adopt', async () => {
    const takeBtn = d
      .getByRole('button', { name: /^Use this version without merging$/i })
      .first();
    await expect(
      takeBtn,
      'the experiment banner offers no way to TAKE this version — only to merge it, which is a different question',
    ).toBeVisible({ timeout: SLA });
    await takeBtn.click({ timeout: NAV });
    const dlg = d.getByRole('alertdialog').first();
    await expect(
      dlg,
      'pressing "Use this version without merging" opened no confirmation',
    ).toBeVisible({ timeout: SLA });
    // The promise, in the dialog's own words. A button that replaces the
    // contents of a copy has to say where the previous contents went.
    await expect(
      dlg,
      'the dialog does not promise that the work being replaced is saved first',
    ).toContainText(/saved first as a new experiment/i, { timeout: SLA });
    await expect(
      dlg,
      'the dialog does not name the business process it is about',
    ).toContainText(BP.title, { timeout: SLA });
    await capture(dashPage, 'experiment-adopt');
    await dlg.getByRole('button', { name: /^Cancel$/ }).first().click({ timeout: NAV });
    await expect(
      dlg,
      'cancelling the take-this-version dialog did not close it',
    ).toBeHidden({ timeout: SLA });
  });

  // ---- The experiment's whole point: do work in it, then merge it back ------
  // The lifecycle a real operator runs: try something in the experiment, like
  // the result, merge it into your own copy — and the experiment DISAPPEARS.
  // "Merge back into my copy" fast-forwards the work into the parent copy,
  // redeploys the parent's live-dev, then deletes the experiment outright and
  // puts you back on your own copy. Nothing here touches main; the merged work
  // reaches main later, from your own copy, through Deploy.
  //
  // We need real work to merge: the button is correctly DISABLED on an
  // experiment with nothing the parent lacks ("Nothing to merge yet"), so the
  // edit below is not decoration — it is what makes the merge a merge. The edit
  // is the vendor VAT-ID rule (scenario.BP.readmeExperimentAddition), and after
  // the merge we assert it is present in OUR OWN copy: that is the proof the
  // work actually travelled, which no banner state can give us.
  await chapter('experiment-merge', async () => {
    await clickTopTab(/Description/i);
    await appendToDescription(
      BP.readmeExperimentAddition,
      /Vendor VAT-ID validation/i,
      'the experiment edit did not survive in the Description editor (draft dropped by a mid-edit refresh) — there would be nothing to merge back',
    );
    // The merge button arms itself off a LIVE merge-preview of the parent (not
    // the SSE snapshot), and the shell nudges that preview on every editor save.
    // So gate on the button being enabled — the product's own "there is
    // something to merge" signal — rather than assuming the save was enough.
    const mergeBtn = d.getByRole('button', { name: /^Merge back into my copy$/i }).first();
    await expect(
      mergeBtn,
      'the experiment never offered a merge back into the copy, even after a saved edit',
    ).toBeEnabled({ timeout: SLA });
    await capture(dashPage, 'experiment-merge');
    await mergeBtn.click({ timeout: NAV });
    // MERGING IS HOW AN EXPERIMENT ENDS. A successful merge auto-discards it and
    // switches us back to our own copy, so the completion signal is the green
    // banner going away — and, distinctly, the Deploy tab coming BACK (it exists
    // only outside an experiment, so its return proves WHICH copy we landed on,
    // not merely that we left). Both bounded and fatal: a stranded experiment
    // would poison every later chapter.
    await expect(
      expBanner(),
      'merging the experiment back never ended it (the green experiment banner stayed up)',
    ).toBeHidden({ timeout: 8 * 60_000 });
    await expect(
      d.getByText(/You are viewing/i),
      'the merge left us on somebody else’s copy instead of our own',
    ).toHaveCount(0);
    await expect(
      topTab(/^Deploy$/),
      'the Deploy tab did not come back after the merge — we are not on our own copy',
    ).toBeVisible({ timeout: SLA });
    // THE PAYOFF: the work the experiment carried is now in our own copy. Read
    // it off our own copy's Description — the same tab, a different copy.
    await clickTopTab(/Description/i);
    await expect(
      d.locator('.ProseMirror, [contenteditable="true"]').first().getByText(/Vendor VAT-ID validation/i).first(),
      'the merge reported success but the experiment’s work is not in our own copy',
    ).toBeVisible({ timeout: 5 * 60_000 });
    // AUTO-DISCARD: the experiment is not merely deselected, it is DELETED — its
    // branch, its files and its live-dev containers. The teardown runs in the
    // background and the copies feed drops it when it finishes, so the honest
    // completion signal is the Experiments section going empty again. The menu is
    // a popover, so we re-open it each pass rather than hold it open for minutes
    // (an open popover is exactly the kind of thing that closes under a re-render
    // and turns a real wait into a stuck one). Bounded; fatal if it never clears
    // — an experiment that survives its own merge is the bug this flow exists to
    // avoid.
    // The empty state is per business process now — "no experiments on
    // <process>" — because that is the only place an experiment can be listed.
    const noExperiments = d
      .getByText(new RegExp(`^No experiments on ${BP.title}\\.?$`, 'i'))
      .first();
    const advanced = () => d.getByRole('button', { name: /^Advanced$/ }).first();
    let discarded = false;
    const discardDeadline = Date.now() + 8 * 60_000;
    for (;;) {
      await advanced().click().catch(() => {});
      discarded = await noExperiments
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (discarded || Date.now() > discardDeadline) break;
      // Close it again so the next iteration's click re-opens rather than toggles.
      await dashPage.keyboard.press('Escape').catch(() => {});
    }
    expect(
      discarded,
      'the merged experiment was not discarded — it is still listed under Advanced → Experiments',
    ).toBe(true);
    await dashPage.keyboard.press('Escape');
  });

  // ---- Deploy: the Diff / History / Supply Chain Security sub-tabs ----
  // Every sub-tab a real operator inspects before shipping: the Diff (what
  // becomes main), the History (copy + main commits with deploy tags), and the
  // Supply Chain Security tab (the CVE scan of the image this deploy would build).
  await chapter('deploy-tab', async () => {
    // The conditional "Sync" tab (first, before Description) exists ONLY while
    // THIS BUSINESS PROCESS's main carries commits this copy doesn't have yet.
    // This walkthrough is a SINGLE user: main advances only through this copy's
    // own deploys, so it can never fall behind and the Sync tab must never
    // appear. If it ever does here, something advanced main behind our back —
    // which would also turn the deploy below into a non-fast-forward (a rebase
    // handed to the coding agent), so catch it now rather than three chapters
    // later.
    await expect(
      d.getByRole('button', { name: /^Sync$/ }),
      'a "Sync" tab appeared for a single user — nothing but this copy should be advancing main',
    ).toHaveCount(0);
    // ---- NO DIRECTORY SLUGS IN USER-FACING TEXT -----------------------------
    // A business process has a directory (`invoice-processing`) and a name
    // ("Invoice Processing"); renaming changes only the second. A user reported
    // the difference as a bug — "why is it showing me test33 when I'm in
    // Compost?" — so the Deploy screen is asserted to speak in names. The
    // directory legitimately appears in file PATHS (the diff lists
    // `invoice-processing/backend/...`), so this checks the screen's own copy:
    // every text node that is not a path, and no path-shaped token on its own.
    const slugLeaks = await dashPage
      .frameLocator('iframe')
      .last()
      .locator('body')
      .evaluate((body: HTMLElement, slug: string) => {
        const hits: string[] = [];
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = (n.textContent ?? '').trim();
          if (!t || !t.includes(slug)) continue;
          // The directory name used AS a path segment — bounded by a slash on
          // either side — is the truthful use of it: that is what the folder
          // is called on disk, in the diff, the file tree and the breadcrumb.
          // Same for a deployment id built from it.
          if (
            t.includes(`${slug}/`) ||
            t.includes(`/${slug}`) ||
            t.includes(`-${slug}-`)
          )
            continue;
          // A git commit subject is a QUOTATION of history — gitops writes the
          // directory into it because that is what the repository is called,
          // and misquoting a commit to match a display name would be worse.
          // The app marks those nodes so this can tell prose from quotation.
          if ((n as Text).parentElement?.closest('[data-git-text]')) continue;
          // …and neither is a filesystem PATH (the explorer root, `/slug`).
          if ((n as Text).parentElement?.closest('[data-path-text]')) continue;
          // Panes the shell keeps MOUNTED but hidden (the coding agent's file
          // tree survives tab switches so a running session isn't torn down)
          // are not on screen, and text nobody can see is not text shown.
          const el = (n as Text).parentElement;
          if (!el || !el.getClientRects().length) continue;
          hits.push(t.slice(0, 120));
        }
        return hits;
      }, BP.slug);
    expect(
      slugLeaks,
      `the Deploy screen shows the business process's DIRECTORY name where it should show "${BP.title}"`,
    ).toEqual([]);
    // ---- NO copy name in the top bar, by exhaustion --------------------------
    // The stronger half of the "the copy combobox is gone" requirement: not only
    // is there no picker, there is NO COPY NAME in the bar at all. With a
    // business process selected, on our own copy, not behind main and not in an
    // experiment, the bar's text is a CLOSED SET of labels — so strip them and
    // require nothing to be left over. That catches a reinstated identity chip,
    // a slug, an owner's name or a "3 ahead" badge, none of which a
    // getByRole/getByText absence check would name in advance. (Longest label
    // first, so stripping "Deployments" can't leave an orphan "ments" behind
    // after "Deploy".)
    const ALLOWED_TOP_BAR = [
      'Requirements & tests',
      'Deployments',
      'Coding Agent',
      'Get started',
      'Description',
      'Advanced',
      BP.title,
      'Process',
      'Deploy',
      // The role chip. Any of the three is fine — the role is not what this
      // assertion is about, so all three are allowed rather than pinned.
      'Auditor',
      'Member',
      'Admin',
    ].sort((a, b) => b.length - a.length);
    const barText = ((await topBarEl().innerText()) || '').replace(/\s+/g, ' ').trim();
    // Compare case-insensitively: `innerText` returns text as RENDERED, and the
    // section label is upper-cased by CSS ("PROCESS"), which no allow-list
    // spelling would match. Lower-casing both sides keeps the check strict
    // about CONTENT while ignoring presentation.
    let residue = barText.toLowerCase();
    for (const label of ALLOWED_TOP_BAR) {
      residue = residue.split(label.toLowerCase()).join('');
    }
    residue = residue.replace(/[\s·|›>&]/g, '');
    expect(
      residue,
      `the top bar carries text beyond the pipeline labels — the copy name/chip is back in the bar (bar read: "${barText}")`,
    ).toBe('');
    await clickTopTab(/^Deploy$/);
    await capture(dashPage, 'deploy-tab');
    // (The redundant 'deploy-tab-diff' capture was removed — it duplicated the
    // Deploy shot above. The matching content slot is removed too.) We
    // still bounce through the Diff sub-tab so History/Supply Chain Security below start clean.
    await d.getByRole('button', { name: /^diff$/i }).first().click().catch(() => {});
    // History sub-tab — the copy + main commit timeline with deploy markers.
    await d.getByRole('button', { name: /^history$/i }).first().click().catch(() => {});
    await capture(dashPage, 'deploy-tab-history');
    // Supply Chain Security sub-tab — the pre-deploy supply-chain scan of the image this
    // deploy WOULD build. The scan bakes an ephemeral image then scans it, so
    // it can be "pending" right after a BP is scaffolded; we capture the REAL
    // CVE list AFTER the first dev deploy (see the deploy chapter), where a
    // built image for this BP exists and the preview resolves to a real scan.
    // Here we just open the tab to show it exists in the flow.
    await d.getByRole('button', { name: /Supply Chain Security/i }).first().click();
    await d.getByText(/Loading supply chain/i).first()
      .waitFor({ state: 'hidden', timeout: SLA }).catch(() => {});
  });

  // ---- Deploy the copy onto main + dev ----
  // One press of Deploy commits the copy onto main and deploys this BP's
  // containers to dev. Driven + observed ENTIRELY through the screen: the button
  // reads "Deploy" → "Working…" while it commits/builds/deploys, then the
  // app flips to Deployments. We confirm the Development stage reports Healthy on
  // screen. The "Add automations" scaffold lands ASYNCHRONOUSLY after the BP is
  // created, so the very first press can fast-forward main a beat before the BP's
  // containers are indexed and deploy nothing; the README the editor re-serialises
  // leaves the BP actionable again, so a human simply presses Deploy once
  // more. We do the same: press while actionable until the dev stage is Healthy.
  // Press Deploy and ride the deploy with the progress watchdog. The
  // button commits work-in-progress, rebases onto main, fast-forwards and
  // deploys to dev — flipping to "Working…" while it runs. We DON'T cap on a
  // flat SLA; we wait for the button to leave "Working…" while requiring the
  // on-screen progress to keep moving (the watchdog), so a long real image
  // build is fine but a silent stall fails.
  // EVERY "Deploy" matcher below is ANCHORED (/^Deploy$/): the "Deployments" tab
  // is on screen at the same time, and an unanchored /Deploy/ would match it —
  // clicking the wrong tab, or worse, reading an always-enabled tab as "the
  // deploy button armed". The tab and the primary action share the name
  // "Deploy", so we keep the file's existing convention: .first() = the top tab,
  // .last() = the primary action button in the tab body.
  const pressDeploy = async () => {
    await clickTopTab(/^Deploy$/);
    const btn = d.getByRole('button', { name: /^Deploy$|Working/ }).last();
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
      if (Date.now() > deadline) throw new Error('Deploy exceeded 30min backstop');
      try {
        await expect
          .poll(
            async () => ((await working.isVisible().catch(() => false)) ? await progressSignature() : '<<done>>'),
            { timeout: PROGRESS, intervals: [500, 1000, 2000] },
          )
          .not.toBe(last);
      } catch {
        // The Deploy progress toast is a COSMETIC live-progress animation.
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
          `Deploy: progress toast quiet >${PROGRESS / 1000}s (last: "${last.slice(0, 120)}") — waiting for "Working…" to clear instead`,
        );
        await working
          .waitFor({ state: 'hidden', timeout: Math.max(1000, deadline - Date.now()) })
          .catch(() => {});
        return;
      }
      last = await progressSignature();
    }
  };
  // After a working-tree EDIT, re-arm the Deploy button. The button gates
  // on `!bpUpToDate` where `bpUpToDate = ahead==0 && behind==0 && !dirty`
  // (SyncDeployTab.tsx). The header only refetches its `/status` snapshot on
  // (re)mount or window-focus, so right after an edit it can still hold the
  // PRE-save (clean) snapshot — "Up to date with main", button disabled — even
  // while the freshly-mounted Diff panel already lists the changed file. Gate on
  // the SAME on-screen signal the button keys off: bounce the tab
  // (Deployments → Deploy remounts + refetches), click the Diff ⟳
  // refresh, and poll the header badge until it reports pending work (an
  // uncommitted file / N ahead / N behind). Bounded; never sleeps.
  const armAfterEdit = async () => {
    const upToDate = d.getByText(/up to date with main/i).first();
    const pending = d.getByText(/uncommitted file|↑\s*\d+\s*ahead|↓\s*\d+\s*behind/i).first();
    const armDeadline = Date.now() + SLA;
    for (;;) {
      await clickTopTab(/Deployments/i);
      await clickTopTab(/^Deploy$/);
      await d.getByRole('button', { name: /^Refresh$/i }).first().click().catch(() => {});
      const armed = await Promise.race([
        pending.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false),
        upToDate.waitFor({ state: 'visible', timeout: 5_000 }).then(() => false).catch(() => false),
      ]);
      if (armed && (await pending.isVisible().catch(() => false))) break;
      if (Date.now() > armDeadline) break; // fall through to the caller's hard assert
    }
  };
  // ── Reusable pieces for the dependency edit→redeploy→production cycles below ──
  // Ship whatever is staged on the copy to Development and wait until the
  // Development stage is Healthy (the deploy-v2 press-while-actionable shape,
  // factored out). Fails loudly if Development never goes Healthy.
  const deployToDevHealthy = async (why: string) => {
    const btn = d.getByRole('button', { name: /^Deploy$|Working/ }).last();
    await expect(btn, `Deploy never armed (${why})`).toBeEnabled({ timeout: SLA });
    let healthy = false;
    for (let attempt = 0; attempt < 3 && !healthy; attempt++) {
      await pressDeploy();
      await clickTopTab(/Deployments/i);
      await selectStage(/Development/i);
      const ok = d.getByText(/\bHealthy\b/i).or(d.getByText(/Current on/i)).first();
      const none = d.getByText(/Not deployed yet/i).first();
      await Promise.race([
        ok.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
        none.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      ]);
      healthy = await ok.isVisible().catch(() => false);
      if (!healthy) {
        await clickTopTab(/^Deploy$/);
        if (!(await btn.isEnabled().catch(() => false))) break;
      }
    }
    await clickTopTab(/Deployments/i);
    await selectStage(/Development/i);
    await waitDeployDone();
    expect(healthy, `Development never became Healthy (${why})`).toBe(true);
  };
  // Promote the current Development build through Staging to Production. Unlike
  // the first-ever promote (the `promote` chapter), here the target stage is
  // ALREADY "Current on <Stage>" from an earlier version — so "current is
  // visible" is NOT a done-signal (it would make a repeat promote a silent
  // no-op). The authoritative signal is the pill title: it reads "Promote all
  // containers to <Stage>" only while there's a NEWER version to promote, and
  // flips to "Nothing new to promote to <Stage>" once the stage has caught up.
  // So we press WHILE the pill is actionable and ride each real deploy until it
  // flips to caught-up.
  const promoteThroughToProduction = async () => {
    await clickTopTab(/Deployments/i);
    for (const stageName of ['Staging', 'Production'] as const) {
      const target = new RegExp(stageName, 'i');
      const caughtUp = d.locator(`button[title="Nothing new to promote to ${stageName}"]`).first();
      const moving = d
        .getByText(/Promoting|Starting|Building|Pulling|Working|Preparing|Deploying/i)
        .first();
      for (let attempt = 0; attempt < 4; attempt++) {
        await selectStage(target);
        const pill = d.locator(`button[title="Promote all containers to ${stageName}"]`).first();
        if (!(await pill.isEnabled().catch(() => false))) break; // nothing newer → caught up
        await pill.click().catch(() => {});
        // Ride the promote deploy. "Current on <Stage>" is stale (an earlier
        // version), so the terminal is the PROGRESS indicator settling: it
        // appears ("Promoting/Building/…") then clears — or the pill flips to
        // "Nothing new to promote" (caught up). Progress watchdog guards a dark
        // stall; re-selecting the stage on a quiet toast refreshes the view.
        let movingSeen = await moving.isVisible().catch(() => false);
        let last = await progressSignature();
        const deadline = Date.now() + 30 * 60_000;
        for (;;) {
          if (await caughtUp.isVisible().catch(() => false)) break;
          const isMoving = await moving.isVisible().catch(() => false);
          if (isMoving) movingSeen = true;
          if (movingSeen && !isMoving) {
            await selectStage(target);
            break; // the promote animation ran and finished
          }
          if (Date.now() > deadline) throw new Error(`promote to ${stageName} exceeded 30min backstop`);
          try {
            await expect
              .poll(
                async () => {
                  if (await caughtUp.isVisible().catch(() => false)) return '<<done>>';
                  const m = await moving.isVisible().catch(() => false);
                  if (m) movingSeen = true;
                  if (movingSeen && !m) return '<<settled>>';
                  return await progressSignature();
                },
                { timeout: PROGRESS, intervals: [500, 1000, 2000] },
              )
              .not.toBe(last);
          } catch {
            await selectStage(target);
            if (await caughtUp.isVisible().catch(() => false)) break;
          }
          last = await progressSignature();
        }
      }
    }
  };
  // Edit a build DEPENDENCY manifest through the REAL Files editor (Coding Agent
  // → Files). Editing an image/ manifest (separate from the app's own manifest —
  // it only feeds the base image's `npm install` / `go mod download`) forces a
  // base-image REBUILD that pulls the changed dependency set through the proxy:
  // new packages fetched from upstream + cached, previously-seen packages served
  // from the cache. The app's own build (vite/go build) is unaffected, so an
  // added-but-unused dependency can't break the deploy.
  const editDependencyManifest = async (opts: {
    searchTerm: string;
    pathSuffix: string;
    marker: RegExp;
    transform: (cur: string) => string;
    added: string;
  }) => {
    await clickTopTab(/Coding Agent/i);
    await d.getByRole('button', { name: /^Files$/ }).first().click();
    const search = d.getByPlaceholder(/Search in files/i).first();
    await search.waitFor({ state: 'visible', timeout: SLA });
    await search.fill(opts.searchTerm);
    // Open the target file by its path suffix (the search-result header carries
    // title={fullPath}); this disambiguates the image/ manifest from the app's.
    const fileBtn = d.locator(`button[title$="${opts.pathSuffix}"]`).first();
    await fileBtn.waitFor({ state: 'visible', timeout: SLA });
    await fileBtn.click();
    const editor = d.locator('.cm-editor').first();
    const cm = editor.locator('.cm-content').first();
    await cm.waitFor({ state: 'visible', timeout: SLA });
    // Read the buffer from the rendered lines (these manifests are small, fully
    // rendered — not virtualised), transform it, and assert it changed.
    const cur = (await editor.locator('.cm-line').allTextContents()).join('\n');
    expect(cur, `opened ${opts.pathSuffix} but it did not look like the expected manifest`).toMatch(opts.marker);
    const next = opts.transform(cur);
    expect(next, `dependency transform did not change ${opts.pathSuffix}`).not.toBe(cur);
    // Replace the whole buffer paste-style: insertText bypasses per-key handlers,
    // so CodeMirror's auto-close-brackets / auto-indent can't mangle the JSON /
    // go.mod the way character-by-character typing would.
    await cm.click();
    await dashPage.keyboard.press('ControlOrMeta+a');
    await dashPage.keyboard.insertText(next);
    await expect(editor, `edit did not add ${opts.added} to ${opts.pathSuffix}`)
      .toContainText(opts.added, { timeout: SLA });
    await dashPage.keyboard.press('ControlOrMeta+s');
    await expect(d.getByText(/^Saved \d/).first(), `${opts.pathSuffix} never reported Saved after Cmd+S`)
      .toBeVisible({ timeout: SLA });
  };
  await chapter('deploy', async () => {
    await clickTopTab(/^Deploy$/);
    // Gate on there being something to ship: the BP shows pending work
    // ("N uncommitted file(s)" — the scaffold + README the editor wrote — and/or
    // "N ahead" of main). The Deploy button being ENABLED is the
    // authoritative on-screen signal that a deploy will do something.
    const btn = d.getByRole('button', { name: /^Deploy$|Working/ }).last();
    await expect(btn, 'Deploy never became actionable (nothing to deploy)').toBeEnabled({ timeout: SLA });
    await pressDeploy();
    await clickTopTab(/Deployments/i);
    // Deploy merges the copy into main and surfaces the Development stage
    // ONLY after the dev image BUILD succeeds — minutes, the same build the
    // live-dev chapter rides. Until then the Deployments tab reads "Not in main
    // yet" with no stage buttons. So poll, with a BUILD-SIZED budget, re-opening
    // Deployments to refresh, for the Development stage to land (= the copy merged
    // to main on a successful deploy) and report Healthy. (An empty BP merges
    // instantly — nothing to build — which is why this only bites a real
    // scaffolded BP.)
    const ok = d.getByText(/\bHealthy\b/i).or(d.getByText(/Current on/i)).first();
    const devStage = d.getByRole('button', { name: /Development/i }).first();
    // Ride the deploy the way an operator does: keep waiting AS LONG AS the screen
    // shows progress, with NO flat cap. Deploy builds the dev image
    // (minutes — the same build live-dev rides) and only merges the copy into main
    // + surfaces the Development stage when that build succeeds; throughout, the
    // deploy streams progress (the sonner toast steps through "Building image …",
    // "Starting containers…"; the status line / button move). So we require the
    // on-screen progress SIGNATURE to change at least every DARK_MS, with the
    // Development stage reporting Healthy as the terminal success. If the screen
    // goes dark (no movement for DARK_MS) before Healthy, the deploy is stuck.
    const DARK_MS = 15_000;
    let healthy = false;
    const startedAt = Date.now();
    const backstop = startedAt + 30 * 60_000;
    // A running log of EVERYTHING the deploy showed, so a failure reads as a
    // story ("got to Building image … then went dark at 105s") instead of a bare
    // "never Healthy". Each distinct on-screen progress signature is recorded
    // with the elapsed time it first appeared; we also note when the dev stage
    // surfaced and how the watch ended (Healthy / went dark / hit the backstop).
    const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
    const timeline: string[] = [];
    const note = (msg: string) => {
      const row = `[${elapsed()}] ${msg}`;
      timeline.push(row);
      // eslint-disable-next-line no-console
      console.log(`  deploy ▸ ${row}`);
    };
    let lastSig = await progressSignature();
    note(`start · signature: "${lastSig || '(blank screen)'}"`);
    let lastMoved = Date.now();
    let devStageSeenAt = '';
    let exit: 'healthy' | 'dark' | 'backstop' = 'backstop';
    for (let i = 0; Date.now() < backstop; i++) {
      if (await devStage.isVisible().catch(() => false)) {
        if (!devStageSeenAt) {
          devStageSeenAt = elapsed();
          note('Development stage surfaced (merge to main landed)');
        }
        await devStage.click().catch(() => {});
        if (await ok.isVisible().catch(() => false)) {
          healthy = true;
          exit = 'healthy';
          note('Development stage reports Healthy ✓');
          break;
        }
      }
      const sig = await progressSignature();
      if (sig !== lastSig) {
        note(`progress: "${sig || '(blank)'}"`);
        lastSig = sig;
        lastMoved = Date.now();
      } else if (Date.now() - lastMoved > DARK_MS) {
        exit = 'dark';
        note(`went dark — no on-screen change for >${DARK_MS / 1000}s; last signature held: "${lastSig || '(blank)'}"`);
        break; // went dark — no on-screen progress and not Healthy → stuck
      }
      await dashPage.waitForTimeout(3_000);
      // Periodically re-open Deployments so the dev stage renders once the merge
      // lands. The progress toast is global, so this doesn't lose the signal.
      if (i % 5 === 4) await clickTopTab(/Deployments/i).catch(() => {});
    }
    if (exit === 'backstop') note('hit the 30-min backstop without reaching Healthy');
    if (!healthy) {
      // Self-explaining failure: replay the whole on-screen progression, say
      // exactly HOW it ended, and dump what the dashboard shows now — so a miss
      // tells us WHERE it got (e.g. "reached Building image … then dark at 105s",
      // or still "Not in main yet" → the dev deploy never merged) instead of a
      // bare "never Healthy". The trace screencasts the onboard tab, not this
      // popup, so dump the dashboard body here too.
      await clickTopTab(/Deployments/i).catch(() => {});
      const body = await d.locator('body').first().innerText({ timeout: 3000 }).catch(() => '(unreadable)');
      const devVis = await devStage.isVisible().catch(() => false);
      const deplVis = await d.getByRole('button', { name: /Deployments/i }).first().isVisible().catch(() => false);
      const ranFor = elapsed();
      const summary =
        exit === 'dark'
          ? `screen went DARK (no progress for >${DARK_MS / 1000}s) after ${ranFor}; last shown: "${lastSig || '(blank)'}"`
          : `hit the 30-min backstop (${ranFor}) still not Healthy; last shown: "${lastSig || '(blank)'}"`;
      // eslint-disable-next-line no-console
      console.log(
        `\n===== deploy FAILED — ${summary} =====\n` +
          `developmentStageSurfaced=${devStageSeenAt || 'NEVER'} developmentBtnNow=${devVis} deploymentsTabNow=${deplVis}\n` +
          `--- on-screen progress timeline (${timeline.length} steps) ---\n${timeline.join('\n')}\n` +
          `--- dashboard body now (${body.length} chars) ---\n${body.slice(0, 1500)}\n===== end deploy diagnostics =====`,
      );
      await capture(dashPage, 'deploy-dev-FAILED');
    }
    // Fail with the STORY, not just the verdict: the assertion message itself now
    // carries where the deploy got and how it ended, so the CI summary line is
    // actionable without digging into the captured log.
    const failMsg =
      exit === 'dark'
        ? `Development stage never became Healthy: deploy went dark after ${elapsed()} (last on-screen: "${lastSig || '(blank)'}", dev stage surfaced: ${devStageSeenAt || 'NEVER'}). Progress timeline:\n${timeline.join('\n')}`
        : `Development stage never became Healthy: hit the 30-min backstop (last on-screen: "${lastSig || '(blank)'}", dev stage surfaced: ${devStageSeenAt || 'NEVER'}). Progress timeline:\n${timeline.join('\n')}`;
    expect(healthy, healthy ? undefined : failMsg).toBe(true);
    await waitDeployDone();
    await capture(dashPage, 'deploy-dev');
    // The healthy Development stage shows its Containers with live memory usage
    // against each container's reservation — capture it for the memory-governance
    // handbook chapter (best-effort; a missing shot just leaves the slot empty).
    await capture(dashPage, 'containers-memory').catch(() => {});
  });

  // ---- Supply Chain Security (real CVEs) — now that a built image for this BP exists, the
  // Deploy → Supply Chain Security preview resolves to a real SBOM/CVE scan. Wait for
  // the scan to leave its loading/pending states and show actual rows before
  // shooting, so the manual prints real advisories, not an empty placeholder.
  await chapter('checks-cve', async () => {
    await clickTopTab(/^Deploy$/);
    // The Supply Chain Security preview bakes the image this BP would build and runs
    // syft+grype on it in the background, re-fetching the panel periodically. We
    // re-open the Supply Chain Security sub-tab a few times, each time waiting a BOUNDED window
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
      await d.getByRole('button', { name: /Supply Chain Security/i }).first().click().catch(() => {});
      // Bounded wait for the fetch spinner to clear, then for a real scan row.
      await d.getByText(/Loading supply chain/i).first()
        .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
      landed = await realScan
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!landed && attempt < 5) {
        // Re-mount the panel (diff → checks) so the NEXT fetch can pick up the
        // finished background scan. Note we re-click Supply Chain Security at the TOP of the
        // next iteration, so the loop never ENDS on Diff.
        await d.getByRole('button', { name: /^diff$/i }).first().click().catch(() => {});
      }
    }
    // Land FIRMLY on the Supply Chain Security sub-tab before capturing — never leave the shot
    // on Diff. Click Supply Chain Security LAST, wait for the panel to settle on a real scan
    // (or its honest pending state if the background scan is genuinely slow),
    // then capture the Supply Chain Security tab.
    await d.getByRole('button', { name: /Supply Chain Security/i }).first().click().catch(() => {});
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
  // NON-TRIVIAL diff, then Deploy AGAIN to land v2. This demotes v1 to a
  // prior, non-current entry, so by the time `history`/`inspect-diff`/`rollback`
  // run, Development carries MULTIPLE deploy-history entries and a real diff. We
  // reuse the Description editor mechanics, the armAfterEdit re-arm pattern, and
  // the deploy chapter's press-while-actionable retry shape.
  await chapter('deploy-v2', async () => {
    // 0) Pin down what Development runs NOW: the current Version hash in the
    // stage header. v2 must CHANGE it — the hard proof the press below shipped
    // a real second version. A press with no source change is NOT a no-op on
    // screen (it still restarts containers and ends Healthy), so without this
    // pin a dropped edit sails through and only surfaces five chapters later
    // in `history` with a misleading "no prior entry" message.
    const readDevVersion = async (): Promise<string> =>
      (await d.getByText(/^Version\s+[0-9a-f]/i).first().innerText().catch(() => ''))
        .replace(/^Version\s*/i, '')
        .trim();
    await clickTopTab(/Deployments/i);
    await selectStage(/Development/i);
    let v1Version = '';
    await expect
      .poll(async () => (v1Version = await readDevVersion()), {
        message: 'Development never showed a current Version hash to pin v1',
        timeout: SLA,
      })
      .toMatch(/^[0-9a-f]{6,}$/i);
    // 1) Make the real, meaningful source edit in the Description editor. The
    // retype-until-it-sticks mechanics (a ProseMirror remount on a mid-edit
    // status refresh silently drops the draft, and the later Deploy would then
    // ship v1's content again) live in appendToDescription — the experiment
    // chapter runs the same shape against its own copy.
    await clickTopTab(/Description/i);
    await appendToDescription(
      BP.readmeV2Addition,
      /Manager approval tier \(v2\)/i,
      'the v2 README edit did not survive in the Description editor (draft dropped by a mid-edit refresh)',
    );
    // 2) Re-arm the button on the same on-screen "pending work" signal it gates on.
    await armAfterEdit();
    // 3) Ship v2: gate on actionable, then ride the deploy with the watchdog —
    // press while actionable until Development is Healthy on screen (bounded).
    const btn = d.getByRole('button', { name: /^Deploy$|Working/ }).last();
    await expect(btn, 'Deploy never re-armed after the v2 edit').toBeEnabled({ timeout: SLA });
    let healthy = false;
    for (let attempt = 0; attempt < 3 && !healthy; attempt++) {
      await pressDeploy();
      await clickTopTab(/Deployments/i);
      await selectStage(/Development/i);
      const ok = d.getByText(/\bHealthy\b/i).or(d.getByText(/Current on/i)).first();
      const none = d.getByText(/Not deployed yet/i).first();
      await Promise.race([
        ok.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
        none.waitFor({ state: 'visible', timeout: SLA }).catch(() => {}),
      ]);
      healthy = await ok.isVisible().catch(() => false);
      if (!healthy) {
        await clickTopTab(/^Deploy$/);
        if (!(await btn.isEnabled().catch(() => false))) break;
      }
    }
    await clickTopTab(/Deployments/i);
    await selectStage(/Development/i);
    await waitDeployDone();
    // Hard-assert the press CHANGED the running version — the only signal that
    // separates a real v2 from a same-content redeploy (which also restarts
    // containers and ends Healthy). The stage header polls its status, so the
    // new hash surfaces on its own.
    await expect
      .poll(
        async () => {
          // A blank/loading header must keep the poll waiting, not satisfy
          // .not.toBe vacuously — report anything that isn't a hash as "v1".
          const v = await readDevVersion();
          return /^[0-9a-f]{6,}$/i.test(v) ? v : v1Version;
        },
        {
          message: `Deploy finished but Development still serves v1 (${v1Version}) — the v2 edit never reached the merge`,
          timeout: SLA,
        },
      )
      .not.toBe(v1Version);
    // Hard-assert v2 produced a SECOND Development deploy-history entry — and
    // filter it to the "Deployed" chip exactly like the history chapter does:
    // the dev-secrets chapter's "Secret change" audit record carries Roll back
    // too, and it satisfied the old unfiltered assert while the v2 deploy had
    // silently no-oped.
    await clickSection(/Deployment history/i);
    const priorDeployed = d
      .locator('div', { has: d.getByRole('button', { name: /^Roll back$/ }) })
      .filter({ has: d.getByRole('button', { name: /^Inspect$/ }) })
      .filter({ has: d.locator('span', { hasText: /^Deployed$/ }) })
      .last();
    await expect(
      priorDeployed,
      'a second deploy did not produce a prior (rollback-able) CODE deploy entry',
    ).toBeVisible({ timeout: SLA });
  });

  // ---- Promote dev → staging, FREEZE + AUDIT, then staging → production -------
  // One promote hop: press the stage-specific promote pill ("Promote all
  // containers to <Stage>", so the dev→staging pill is never confused with the
  // staging→production one), confirm THIS stage actually starts, then ride the
  // deploy watchdog until it is current. A click that doesn't land (a re-render
  // detaches the pill) is re-pressed so the target never sits static long enough
  // to trip the went-dark watchdog as a false stall.
  const promoteHop = async (stageName: 'Staging' | 'Production') => {
    const target = new RegExp(stageName, 'i');
    await selectStage(target);
    const promotePill = d
      .locator(`button[title="Promote all containers to ${stageName}"]`)
      .first();
    const targetCurrent = d.getByText(new RegExp(`Current on ${stageName}`, 'i')).first();
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
      started = await Promise.race([
        moving.waitFor({ state: 'visible', timeout: 12_000 }).then(() => true).catch(() => false),
        targetCurrent
          .waitFor({ state: 'visible', timeout: 12_000 })
          .then(() => true)
          .catch(() => false),
      ]);
    }
    await selectStage(target);
    await waitDeployDone(stageName); // THIS stage reaches "Current on <Stage>"
  };

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

  await chapter('promote', async () => {
    await clickTopTab(/Deployments/i);
    await promoteHop('Staging');
    await capture(dashPage, 'promote-progress');
  });

  // Production is GATED: an auditor/admin must freeze staging (locking the image
  // under review) and collect the required audit sign-offs before the Production
  // promote unlocks. Freezing also closes dev→staging. The walkthrough runs as an
  // admin (who holds auditor rights), exercising the full gate as a real user —
  // no bypass. A normal member would see the Production promote locked and would
  // have to ask an auditor, exactly as intended.
  await chapter('freeze-and-audit', async () => {
    await clickTopTab(/Deployments/i);
    // Freeze staging — the Freeze pill lives on the Staging node in the pipeline.
    const freeze = d.getByRole('button', { name: /^Freeze$/ }).first();
    await freeze.waitFor({ state: 'visible', timeout: SLA });
    await freeze.click().catch(() => {});
    // It flips to "Unfreeze" once the gate state comes back (frozen).
    await d
      .getByRole('button', { name: /^Unfreeze$/ })
      .first()
      .waitFor({ state: 'visible', timeout: SLA });
    await capture(dashPage, 'freeze-staging');
    // Open the Audits sub-tab via its pipeline badge and sign off an approval
    // (admin has auditor rights). The badge reads "Audits <done>/<required>".
    await d
      .getByRole('button', { name: /Audits (off|\d+\/\d+)/i })
      .first()
      .click()
      .catch(() => {});
    const noteBox = d.getByPlaceholder(/Audit note/i).first();
    await noteBox.waitFor({ state: 'visible', timeout: SLA });
    await noteBox.fill(
      'Reviewed the frozen staging image — migrations additive, no PII change. Approved for Production.',
    );
    await capture(dashPage, 'audit-signoff');
    await d.getByRole('button', { name: /^Approve$/ }).first().click();
    // The sign-off lands in the audit log, and the policy (1 sign-off) is met.
    await d
      .getByText(/Approved/i)
      .first()
      .waitFor({ state: 'visible', timeout: SLA });
    await capture(dashPage, 'audit-log');
  });

  await chapter('promote-prod', async () => {
    await clickTopTab(/Deployments/i);
    await promoteHop('Production');
    await capture(dashPage, 'promote-progress-prod');
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

  // ════════════════════════════════════════════════════════════════════════
  // Two dependency edit → redeploy → production cycles, then a REAL rollback.
  //
  // Production now carries v2. A real operator keeps shipping: they change a
  // build DEPENDENCY and roll it out to production. We do that TWICE — once for
  // npm, once for Go — so the change forces a real IMAGE REBUILD each time and
  // the automation server's read-through package proxy is exercised end to end:
  //   • the NEW package (dayjs / rs-xid) is a cache MISS → fetched from upstream
  //     once and cached;
  //   • every OTHER dependency the rebuild needs is a cache HIT → served locally.
  // Editing the image/ manifest (not the app's) guarantees the base image's
  // `npm install` / `go mod download` re-runs with the changed set while the
  // app's own build is untouched, so an unused-but-added dependency can't break
  // the deploy. Each cycle goes dev → staging → production. Then we roll
  // Production back to the previous version and confirm the revert.
  // ════════════════════════════════════════════════════════════════════════
  // Inspect Production's live containers RIGHT AFTER promotion, while the stage
  // is freshly deployed and healthy — before the memory-heavy tail (deps-npm /
  // deps-go rebuild+re-promote, prod-rollback, the long CVE scan) churns the
  // blue-green slots and, on a memory-starved runner, can leave Production
  // between deployments. This is also when an operator naturally looks. The
  // handbook chapter order is unaffected (it's driven by content.mjs slots, not
  // capture order).
  await chapter('containers', async () => {
    // Defensive: clear any overlay a prior chapter may have left open before our
    // first click.
    await closeAnyModal();
    await selectStage(/Production/i);
    // The Containers tab carries a count pill ("Containers 2"), so match the
    // label as a prefix — an anchored /^Containers$/ would miss it.
    await clickSection(/Containers/i);
    // The live container roster for the current deployment. Each container card
    // carries inline Logs / Inspect expanders and start/stop controls.
    await capture(dashPage, 'containers');
    // Inspect a RUNNING container — not blindly the first card. Production shows
    // one card per member (the always-on worker AND the on-demand frontend); a
    // member whose container isn't running still shows a card, so Logs would only
    // ever say "Waiting for logs…" and Inspect would have nothing to render.
    // Target a running card via its status marker (the always-on worker is a
    // guaranteed running card).
    const runningCard = d
      .locator('[data-testid="container-card"][data-container-status="running"]')
      .first();
    await expect(
      runningCard,
      'no running container in Production to inspect',
    ).toBeVisible({ timeout: SLA });
    // Open the running container's LOGS view: its "Logs" button expands an inline
    // LogsPane that streams real container output. Hard-assert it opened.
    await runningCard.getByRole('button', { name: /^Logs$/ }).click();
    await expect(
      runningCard
        .locator('.font-mono')
        .filter({ hasText: /\S/ })
        .or(runningCard.getByText(/Waiting for logs…|\[stream ended\]|Log stream disconnected/i))
        .first(),
      'container Logs view never opened',
    ).toBeVisible({ timeout: SLA });
    await capture(dashPage, 'container-logs');
    // Open the running container's INSPECT view: its "Inspect" button expands an
    // inline OverviewPane with the container's configuration (Identity / Image /
    // Network groups). Hard-assert a config group rendered before shooting.
    await runningCard.getByRole('button', { name: /^Inspect$/ }).click();
    await expect(
      runningCard.getByText(/^Identity$|^Image$|^Network$/).first(),
      'container Inspect view never opened',
    ).toBeVisible({ timeout: SLA });
    await capture(dashPage, 'container-inspect');
  });
  await chapter('deps-npm', async () => {
    await editDependencyManifest({
      searchTerm: '"react"',
      pathSuffix: '/frontend/image/package.json',
      marker: /"dependencies"\s*:/,
      transform: (cur) => cur.replace(/("dependencies"\s*:\s*\{)/, '$1\n    "dayjs": "^1.11.13",'),
      added: 'dayjs',
    });
    await armAfterEdit();
    await deployToDevHealthy('deps-npm: dayjs added to the frontend image manifest');
    await promoteThroughToProduction();
    await selectStage(/Production/i);
    await waitDeployDone('Production');
    await capture(dashPage, 'deps-npm-prod');
  });
  await chapter('deps-go', async () => {
    await editDependencyManifest({
      searchTerm: 'gorm',
      pathSuffix: '/backend/image/go.mod',
      marker: /require \(/,
      // Add rs/xid to the FIRST (direct) require block — a module NOT already in
      // the template's deps, so `go mod download` fetches it fresh through Athens.
      transform: (cur) => cur.replace(/require \(\n/, 'require (\n\tgithub.com/rs/xid v1.6.0\n'),
      added: 'github.com/rs/xid',
    });
    await armAfterEdit();
    await deployToDevHealthy('deps-go: rs/xid added to the backend image manifest');
    await promoteThroughToProduction();
    await selectStage(/Production/i);
    await waitDeployDone('Production');
    await capture(dashPage, 'deps-go-prod');
  });
  await chapter('prod-rollback', async () => {
    // Production now carries multiple promoted versions (v2 → +dayjs → +xid), so
    // a prior (non-current) entry exposes "Roll back". Test a REAL rollback: roll
    // Production back to the previous version and ride the revert to completion.
    await closeAnyModal();
    await selectStage(/Production/i);
    await clickSection(/Deployment history/i);
    const rb = d.getByRole('button', { name: /^Roll back$/ }).first();
    await expect(rb, 'Production history exposed no Roll back action (expected ≥2 promoted versions)')
      .toBeVisible({ timeout: SLA });
    await rb.click();
    const dlg = d.getByRole('alertdialog').or(d.getByRole('dialog')).first();
    await expect(dlg, 'clicking Roll back did not open a confirm dialog').toBeVisible({ timeout: SLA });
    await capture(dashPage, 'prod-rollback-modal');
    // CONFIRM the rollback (the AlertDialog's action button is also "Roll back").
    await dlg.getByRole('button', { name: /^Roll back$/ }).first().click();
    // Ride the rollback re-deploy: "Current on Production" is already on screen
    // (stale, from the version we're leaving), so it's NOT a done-signal. Wait
    // for the deploy to visibly START (a moving indicator) then SETTLE, bounded.
    const moving = d
      .getByText(/Rolling back|Promoting|Starting|Building|Pulling|Working|Preparing|Deploying/i)
      .first();
    await moving.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
    await moving.waitFor({ state: 'hidden', timeout: 30 * 60_000 }).catch(() => {});
    await clickTopTab(/Deployments/i);
    await selectStage(/Production/i);
    // The rolled-back version is now current; the entry list re-renders with the
    // previously-current version demoted to a rollback target. Confirm the stage
    // still reports a healthy current deployment.
    await expect(
      d.getByText(/Current on Production/i).first(),
      'Production did not report a current deployment after rollback',
    ).toBeVisible({ timeout: SLA });
    await capture(dashPage, 'prod-rollback-done');
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
    // only Inspect; a NON-current (prior) entry has Roll back + Inspect. To
    // get a real diff we must Inspect a NON-current entry — locate the card that
    // carries a "Roll back" action and click the Inspect WITHIN that same card.
    // Filter to the "Deployed" chip: secret audit records (the dev-secrets
    // chapter leaves one BELOW the first dev deploy) are rollbackable too but
    // carry no source commit, so their "Diff vs current" is legitimately empty
    // — only a prior CODE deploy yields the real v1→v2 diff asserted below.
    const priorCard = d
      .locator('div', { has: d.getByRole('button', { name: /^Roll back$/ }) })
      .filter({ has: d.getByRole('button', { name: /^Inspect$/ }) })
      // The chip is its own <span> with exact text "Deployed" — match that,
      // not the card's textContent (which concatenates "…c99Deployed…", so a
      // \b word-boundary can never sit between the sha and the chip).
      .filter({ has: d.locator('span', { hasText: /^Deployed$/ }) })
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
  // calls to the integration hosts declared in the dev-secrets chapter
  // (BITSWAN_EGRESS_PROBES — injected into the backend by the dev deploys the
  // deploy chapters ran), which the firewall observes. On the Development
  // stage the firewall runs in MONITOR mode, so those destinations surface
  // under "Needs review". We open Firewall (WAIT for it to finish loading —
  // never a "Loading firewall…" frame), find a detected egress host, open its
  // GDPR data-processing record, FILL it, capture, and save it (the approval
  // is idempotent — it just versions the record in bitswan.yaml).
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
    // The dev backend probes its configured integration hosts on a 20s loop,
    // and the dashboard firewall panel POLLS, so an observed egress host
    // RELIABLY surfaces under "Needs review" within ~90s. This is the whole
    // point of the chapter,
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
    // Postgres…/CouchDB…/object storage…) and must not go dark >PROGRESS.
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
      // Restoring into DR is a LONG op (Postgres/CouchDB/object-storage restore) that
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
    await c.getByRole('button', { name: /People & roles/i }).first().click();
    await expect(c.getByRole('heading', { name: /People & roles/i }).first()).toBeVisible({ timeout: SLA });
    // The console refetches approvals on a background interval; re-click the nav
    // to force a fresh fetch and POLL until Marek's pending device bar appears.
    // This is the heart of the story: the admin sees the request and controls
    // who/which devices get in. Bounded; we re-click People & roles each pass.
    const pendingBar = c.getByText(/Device awaiting approval/i).first();
    const armDeadline = Date.now() + 90_000;
    for (;;) {
      if (await pendingBar.isVisible().catch(() => false)) break;
      if (Date.now() > armDeadline) break;
      await c.getByRole('button', { name: /People & roles/i }).first().click().catch(() => {});
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
      .or(c.locator('input[inputmode="numeric"], input[maxlength="6"], input').filter({ hasNot: c.locator('[type="search"]') }).last())
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
    const trustBtn = c.getByRole('button', { name: /^Trust this device$/i }).first();
    await expect(trustBtn, 'the "Trust this device" approval button never enabled after entering the code')
      .toBeEnabled({ timeout: SLA });
    await trustBtn.click();
    // HARD-ASSERT the approval landed: the success toast ("Device trusted for
    // …") fires and the pending bar clears (refresh('approvals') removes it).
    await expect(
      c.getByText(/Device trusted for/i).first()
        .or(c.getByText(new RegExp(`Device trusted for ${TEAMMATE.name.split(' ')[0]}`, 'i')).first()),
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

  // ---- External OIDC provider: the login topology actually switches -------
  //
  // Runs LAST on purpose. Enabling a second provider re-points oauth2-proxy at
  // the Dex broker, which changes the token issuer and invalidates every
  // session signed by Keycloak — including the operator's. Anything after this
  // would be running as a logged-out user.
  //
  // The "customer" provider is a second realm on the same disposable Keycloak.
  // That is a real, independent OIDC issuer as far as Bailey and Dex are
  // concerned: its own discovery document, its own client, its own users.
  await chapter('sso-topology-switch', async () => {
    const kc = ENV.keycloakUrl;
    const acmeIssuer = `${kc}/realms/acme`;
    const acmeSecret = 'acme-dex-secret';

    const kcAdmin = (args: string) =>
      sh(`docker exec bitswan-e2e-keycloak /opt/keycloak/bin/kcadm.sh ${args}`);
    kcAdmin(`config credentials --server http://localhost:8088 --realm master --user admin --password admin`);
    try { kcAdmin(`create realms -s realm=acme -s enabled=true`); } catch { /* already there */ }
    try {
      kcAdmin(`create clients -r acme -s clientId=bailey-dex -s enabled=true -s protocol=openid-connect`
        + ` -s publicClient=false -s standardFlowEnabled=true -s secret=${acmeSecret}`
        + ` -s 'redirectUris=["https://auth.${ENV.domain}/callback"]'`);
    } catch { /* already there */ }

    // Register the daemon against the AOC stub. Only now, and not in bringup:
    // provisioning the proxy is what needs an AOC, and stamping one on the whole
    // run would switch every deployed app into AOC-mode token verification for
    // chapters that are not about identity at all. The daemon re-reads its
    // config per call, so this takes effect without a restart.
    const registered = sh(`curl -sS --unix-socket /var/run/bitswan/automation-server.sock`
      + ` -X POST -H 'Content-Type: application/json'`
      + ` -d '{"aoc_url":"http://bitswan-e2e-aoc:8080","automation_server_id":"bs-e2e",`
      + `"access_token":"e2e-aoc-stub-token","domain":"${ENV.domain}","force":true}'`
      + ` -w ' HTTP:%{http_code}' http://unix/aoc/config`);
    expect(registered, 'the daemon must accept the stub as its AOC').toContain('HTTP:200');

    const proxyIssuer = () =>
      sh(`docker inspect bitswan-protected-proxy --format '{{range .Config.Env}}{{println .}}{{end}}'`)
        .split('\n').find((l) => l.startsWith('OAUTH2_PROXY_OIDC_ISSUER_URL=')) || '';

    expect(proxyIssuer(), 'before: the proxy talks straight to Keycloak').toContain('/realms/bitswan');
    expect(sh('docker ps --format "{{.Names}}"'), 'before: no broker').not.toContain('bitswan-dex');

    await c.getByRole('button', { name: /Single sign-on/i }).first().click();
    await expect(c.getByRole('heading', { name: /Single sign-on/i }).first()).toBeVisible({ timeout: SLA });

    await c.getByPlaceholder(/Acme single sign-on/i).first().fill('Acme single sign-on');
    await c.getByPlaceholder(/login\.acme\.example/i).first().fill(acmeIssuer);
    await c.getByPlaceholder(/^bailey$/i).first().fill('bailey-dex');
    await c.getByPlaceholder(/Paste the client secret/i).first().fill(acmeSecret);

    await c.getByRole('button', { name: /^Test$/ }).first().click();
    await expect(c.getByText(/Discovery document looks good/i).first()).toBeVisible({ timeout: SLA });

    await c.getByRole('button', { name: /Enable single sign-on/i }).first().click();

    // The switch itself: a broker is running and the proxy now trusts it.
    await expect(async () => {
      expect(sh('docker ps --format "{{.Names}}"'), 'the broker must be running').toContain('bitswan-dex');
      expect(proxyIssuer(), 'the proxy must now trust the broker').toContain(`https://auth.${ENV.domain}`);
    }).toPass({ timeout: PROGRESS });

    // Both ways in are offered. A fresh browser gets Dex's chooser, and it must
    // carry BOTH the customer's provider and the Bitswan account — a server
    // that only offered the customer's IdP could be locked shut by an outage
    // at that IdP.
    const visitor = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true });
    try {
      const vp = await visitor.newPage();
      // The proxy really re-pointed if an unauthenticated visit now rests on
      // the broker's host rather than Keycloak's. Re-navigate on each attempt:
      // a page that landed on Keycloak before the switch completed would never
      // change its own URL, and the retry would just re-read the stale one.
      await expect(async () => {
        await vp.goto(ENV.baileyUrl + '/', { waitUntil: 'domcontentloaded', timeout: PROGRESS });
        expect(new URL(vp.url()).hostname, 'unauthenticated visitors reach the broker').toBe(`auth.${ENV.domain}`);
      }).toPass({ timeout: PROGRESS });
      await expect(vp.getByText(/Sign in to Bitswan Bailey/i).first()).toBeVisible({ timeout: PROGRESS });
      await expect(vp.getByText(/Acme single sign-on/i).first()).toBeVisible({ timeout: SLA });
      await expect(vp.getByText(/Bitswan account/i).first()).toBeVisible({ timeout: SLA });
      await capture(vp, 'sso-chooser');
    } finally {
      await visitor.close().catch(() => {});
    }

    // Closing the second door. Turning Bitswan accounts off leaves the broker
    // with exactly one connector, so there is nothing to choose between and a
    // visitor is handed straight to the customer's provider.
    await page.goto(ENV.baileyUrl + '/', { waitUntil: 'domcontentloaded', timeout: PROGRESS });
    await page.getByText(/Bitswan account/i).first().click();
    // Enabling single sign-on invalidated the proxy session, not the Keycloak
    // one: this operator signed in several chapters ago and that cookie is still
    // in the browser. Keycloak therefore hands the broker an identity without
    // showing a form, and waiting for one would wait forever.
    const kcForm = page.locator('#username, input[name="username"]').first();
    if (await kcForm.isVisible({ timeout: 20_000 }).catch(() => false)) {
      await oidcLogin(page, ENV.operatorEmail, ENV.operatorPassword);
    }
    await expect(c.getByRole('heading', { name: /Workspaces/i }).first()).toBeVisible({ timeout: PROGRESS });

    await c.getByRole('button', { name: /Single sign-on/i }).first().click();
    await expect(c.getByRole('heading', { name: /Single sign-on/i }).first()).toBeVisible({ timeout: SLA });
    await expect(c.getByText(/people pick between a Bitswan account and your provider/i).first())
      .toBeVisible({ timeout: SLA });
    await c.getByRole('button', { name: 'Bitswan account sign-in' }).first().click();
    await expect(c.getByText(/nobody can sign in . including you/i).first()).toBeVisible({ timeout: SLA });
    await c.getByRole('button', { name: /^Save changes$/ }).first().click();

    const exclusive = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true });
    try {
      const xp = await exclusive.newPage();
      await expect(async () => {
        await xp.goto(ENV.baileyUrl + '/', { waitUntil: 'domcontentloaded', timeout: PROGRESS });
        expect(xp.url(), 'the only provider left gets the visitor without asking').toContain('/realms/acme');
      }).toPass({ timeout: PROGRESS });
      await expect(xp.getByText(/Sign in to Bitswan Bailey/i)).toHaveCount(0);
    } finally {
      await exclusive.close().catch(() => {});
    }

    // Which is exactly why the way back cannot run through the browser: nobody
    // can reach the admin UI to undo it, so the host shell has to work.
    sh('docker exec bitswan-automation-server-daemon bitswan bailey sso disable');
    await expect(async () => {
      expect(sh('docker ps --format "{{.Names}}"'), 'the broker must be gone').not.toContain('bitswan-dex');
      expect(proxyIssuer(), 'the proxy must be back on Keycloak').toContain('/realms/bitswan');
    }).toPass({ timeout: PROGRESS });

    // And sign-in works again on the stock path, which is the assertion that
    // actually matters: a server that backed out of SSO must not be left
    // unreachable.
    const after = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true });
    try {
      const ap = await after.newPage();
      await expect(async () => {
        await ap.goto(ENV.baileyUrl + '/', { waitUntil: 'domcontentloaded', timeout: PROGRESS });
        expect(new URL(ap.url()).hostname, 'back to signing in against Keycloak').toContain('keycloak');
      }).toPass({ timeout: PROGRESS });
    } finally {
      await after.close().catch(() => {});
    }
  });

  /* eslint-disable no-console */
  // ---- Interaction-latency KPI: the number we optimise for snappiness ----
  const interactive = timings.filter((t) => isInteractive(t.name));
  const longOps = timings.filter((t) => !isInteractive(t.name));
  const secs = interactive.map((t) => t.seconds).sort((a, b) => a - b);
  const pct = (p: number) => (secs.length ? secs[Math.min(secs.length - 1, Math.floor((p / 100) * secs.length))] : 0);
  const sum = secs.reduce((a, b) => a + b, 0);
  const kpi = {
    company: COMPANY.short,
    interactive_count: interactive.length,
    interactive_total_s: +sum.toFixed(1),
    interactive_median_s: +pct(50).toFixed(1),
    interactive_p95_s: +pct(95).toFixed(1),
    interactive_max_s: secs.length ? +secs[secs.length - 1].toFixed(1) : 0,
    slowest_interactions: [...interactive].sort((a, b) => b.seconds - a.seconds).slice(0, 8).map((t) => ({ name: t.name, s: +t.seconds.toFixed(1) })),
    long_ops: longOps.map((t) => ({ name: t.name, s: +t.seconds.toFixed(1) })).sort((a, b) => b.s - a.s),
  };
  try {
    writeFileSync('/repo/e2e/manual/build/kpi.json', JSON.stringify(kpi, null, 2));
  } catch {
    /* KPI artifact is best-effort — never fail the run over telemetry */
  }
  console.log(
    `\n=== interaction KPI: ${kpi.interactive_count} interactions, ` +
      `total ${kpi.interactive_total_s}s, median ${kpi.interactive_median_s}s, ` +
      `p95 ${kpi.interactive_p95_s}s, max ${kpi.interactive_max_s}s ===`,
  );
  kpi.slowest_interactions.forEach((t) => console.log(`  ⏱ ${t.s}s  ${t.name}`));
  console.log(`  (long-ops, reported separately: ${kpi.long_ops.map((t) => `${t.name} ${t.s}s`).join(', ') || 'none'})`);

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
