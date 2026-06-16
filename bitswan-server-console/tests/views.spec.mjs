// views.spec.mjs — Playwright smoke tests for every Bailey Server Console view.
//
// Standalone Node script (no test runner) driven by the Playwright container.
// It loads the built console from a static server, walks every left-nav view
// and every "Preview sign-in states" auth scene, and for each asserts:
//   - the view's <h1> heading renders with the expected text,
//   - a second view-specific landmark is present,
//   - ZERO uncaught page errors fired while that view was on screen.
//
// The backend APIs (/bailey/api/*) deliberately 404 here — the console is
// served in isolation — so the live-wired views are expected to show their
// error / loading banners. Those 404 fetch failures are NOT page errors;
// only uncaught JS exceptions count against a view.
//
// Usage (from inside the playwright container, with the console served on
// BASE_URL): see the header comment in run instructions / the report.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8848/';
const SHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

// ─── Left-nav views ─────────────────────────────────────────────────────────
// navLabel: the text in the sidebar button to click.
// heading:  the exact <h1> text the view renders.
// landmark: a second piece of text that must be on screen for the view.
const VIEWS = [
  {
    id: 'workspaces', navLabel: 'Workspaces', heading: 'Workspaces',
    landmark: 'Each workspace is an isolated set of processes',
  },
  {
    id: 'overview', navLabel: 'Server overview', heading: 'Server overview',
    landmark: 'Recent security activity',
  },
  {
    id: 'users', navLabel: 'People & roles', heading: 'People & roles',
    landmark: 'Everyone with access to this server',
  },
  {
    id: 'approvals', navLabel: 'New user approvals', heading: 'New user approvals',
    landmark: 'Keycloak proves who someone is',
  },
  {
    id: 'devices', navLabel: 'Your devices', heading: 'Your devices',
    landmark: 'Every device signed in to your account',
  },
  {
    id: 'security', navLabel: 'Security & recovery', heading: 'Security & recovery',
    landmark: 'an authenticator app is your way back in',
  },
];

// ─── Auth scenes (Preview sign-in states) ───────────────────────────────────
// menuLabel: the item text inside the "Preview sign-in states" popover.
// heading:   the scene's centered <h1>.
// landmark:  scene-specific text.
const SCENES = [
  {
    id: 'bootstrap', menuLabel: 'First-admin claim', heading: 'Claim this server',
    landmark: 'Log in with Keycloak',
  },
  {
    id: 'approval', menuLabel: 'Awaiting approval', heading: 'Trust this device',
    landmark: 'Signed in as Alex Mráz',
  },
  {
    id: 'recovery', menuLabel: 'Account recovery', heading: 'Recover your account',
    landmark: 'lost access to every trusted device',
  },
];

const results = [];
let pageErrors = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

// Assert a piece of visible text exists; returns true/false.
async function hasText(page, text) {
  return (await page.getByText(text, { exact: false }).count()) > 0;
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Collect uncaught page errors (real JS exceptions). Network 404s do NOT
  // surface here — those are expected in isolation.
  page.on('pageerror', (err) => { pageErrors.push(String(err)); });
  // Also surface console.error for visibility (not counted as failures).
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // Network fetch failures land here as console errors; log but ignore.
      // (Kept quiet to avoid noise; uncomment to debug.)
      // console.log('  [console.error]', msg.text());
    }
  });

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  // App should mount: the sidebar server label + default Workspaces view.
  await page.waitForSelector('h1', { timeout: 15000 });
  record('boot: app mounts (h1 present)', true);

  // ── Walk each nav view ────────────────────────────────────────────────────
  for (const v of VIEWS) {
    pageErrors = []; // reset per-view error capture
    let ok = true;
    const problems = [];
    try {
      // The nav label lives in a <button>; click it.
      const navBtn = page.locator('aside button', { hasText: v.navLabel }).first();
      await navBtn.click();
      // Wait for the heading to settle.
      await page.waitForFunction(
        (h) => {
          const els = [...document.querySelectorAll('h1')];
          return els.some((e) => e.textContent.trim() === h);
        },
        v.heading,
        { timeout: 8000 },
      );
    } catch (e) {
      ok = false;
      problems.push(`heading "${v.heading}" not found (${e.message.split('\n')[0]})`);
    }

    // Landmark check.
    if (ok && !(await hasText(page, v.landmark))) {
      ok = false;
      problems.push(`landmark "${v.landmark}" missing`);
    }

    // Screenshot regardless.
    await page.screenshot({ path: join(SHOT_DIR, `view-${v.id}.png`), fullPage: true });

    // Uncaught page errors?
    if (pageErrors.length) {
      ok = false;
      problems.push(`${pageErrors.length} page error(s): ${pageErrors.join(' | ').slice(0, 300)}`);
    }

    record(`view: ${v.navLabel}`, ok, problems.join('; '));
  }

  // ── Walk each auth scene ──────────────────────────────────────────────────
  for (const s of SCENES) {
    pageErrors = [];
    let ok = true;
    const problems = [];
    try {
      // Open the "Preview sign-in states" popover, then pick the scene.
      const opener = page.locator('aside button', { hasText: 'Preview sign-in states' }).first();
      await opener.click();
      const item = page.locator('button', { hasText: s.menuLabel }).first();
      await item.click();
      await page.waitForFunction(
        (h) => {
          const els = [...document.querySelectorAll('h1')];
          return els.some((e) => e.textContent.trim() === h);
        },
        s.heading,
        { timeout: 8000 },
      );
    } catch (e) {
      ok = false;
      problems.push(`scene heading "${s.heading}" not found (${e.message.split('\n')[0]})`);
    }

    if (ok && !(await hasText(page, s.landmark))) {
      ok = false;
      problems.push(`landmark "${s.landmark}" missing`);
    }

    await page.screenshot({ path: join(SHOT_DIR, `scene-${s.id}.png`), fullPage: true });

    if (pageErrors.length) {
      ok = false;
      problems.push(`${pageErrors.length} page error(s): ${pageErrors.join(' | ').slice(0, 300)}`);
    }

    record(`scene: ${s.menuLabel}`, ok, problems.join('; '));

    // Return to the console shell for the next scene (the scenes have a
    // "Back to sign in" / "Sign out" affordance, but reloading is simplest
    // and keeps each scene independent).
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1', { timeout: 15000 });
  }

  await browser.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('\n──────── SUMMARY ────────');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  console.log(`screenshots: ${SHOT_DIR}`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
