# Dashboard browser tests

The client's `npm test` runs `node --test` over `src/lib/*.test.ts` — pure logic
only. There is no component-test stack (no jsdom, no testing-library), so
behaviour that *only* exists in a real browser — where focus actually goes when
a key is pressed — has nowhere else to be tested.

These tests bundle a real component into a standalone page with esbuild and
drive it with Playwright. No stack, no auth, no containers: they open a local
file. (That is the point — the live dashboard sits behind oauth2-proxy and
cannot be driven directly.)

This directory is deliberately **not** an npm workspace of the dashboard and is
**not** copied into the Docker image, so Playwright never reaches the shipped
runtime. It installs and runs on its own.

## Running

```sh
npm install
npx playwright install chromium     # once; add `firefox` for npm run test:firefox
npm test
```

The dashboard's own dependencies must already be installed (`npm install` in
`bitswan-workspace-dashboard`), since the bundle pulls React and the client's
component tree from there.

On a Linux box missing Chromium's shared libraries, Playwright will name the
ones it needs; install those system packages first.

## What is covered

`treegrid-keyboard.mjs` — the requirements table's ARIA `treegrid` keyboard
support (issue #268). It asserts the WAI-ARIA key contract (arrows, Home/End,
Enter, Escape), that the grid is a **single tab stop** with no control leaking
into the tab order, that `Tab` still escapes rather than being trapped, that
`aria-level` reports tree depth, and that collapsing a subtree never strands
focus on `<body>`.

Adding a case? Assert on focus via `document.activeElement`, and note the trap
documented in the script: `page.click()` focuses the element it clicks, which
can mask exactly the focus bug you are trying to catch. Use
`page.dispatchEvent(sel, 'click')` when the click must not move focus.
