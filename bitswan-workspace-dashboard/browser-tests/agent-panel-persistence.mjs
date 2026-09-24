// The Coding Agent panel must survive navigation, verified in a real browser.
//
// The panel is an iframe hosting the Claude Code webview, and the extension
// behind it reads a reloaded page as a fresh client: it closes every live
// channel, killing whatever the agent was doing. Switching business processes
// used to reload it, so coming back to a BP ended the run that had been going
// on while you were away — a conversation that reads as finished, with no
// live stream, while the work carried on unseen.
//
// Nothing about that is visible to the unit tests: `lib/agentPanels.test.ts`
// covers which panels stay mounted, but "React did not re-create the iframe"
// is a DOM fact. So this drives the real provider in Chromium and counts what
// the server is asked for — a reload is a second GET of /sidebar/view, and a
// panel that survived answers with the nonce it was first served.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));

const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Agent panels (persistence harness)</title>
<style>body { font: 14px system-ui, sans-serif; margin: 0; }</style>
</head>
<body><div id="root"></div><script src="/bundle-agent-panels.js"></script></body>
</html>`;

/** One served panel page, told apart from a re-served one by its nonce. */
function panelPage(nonce, scope) {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>panel</title></head>
<body data-nonce="${nonce}" data-scope="${scope}">panel ${scope} #${nonce}</body></html>`;
}

/** Every /sidebar/view the client asked for, in order. */
const views = [];
let nonce = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (url.pathname === '/bundle-agent-panels.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(readFileSync(resolve(here, 'bundle-agent-panels.js')));
    return;
  }
  // The panel asks whether there is an extension before mounting anything.
  if (url.pathname === '/api/coding-agent/sidebar/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ available: true }));
    return;
  }
  if (url.pathname === '/api/coding-agent/sidebar/view') {
    const scope = `${url.searchParams.get('copy')}/${url.searchParams.get('bp')}`;
    nonce += 1;
    views.push(scope);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(panelPage(nonce, scope));
    return;
  }
  // /oauth2/auth included: no token here, which the client handles by sending
  // none. The websocket upgrade is likewise left unanswered — the bridge
  // failing to connect is not what this test is about, and the panel stays
  // mounted through it.
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();

const ENGINE = process.env.BROWSER === 'firefox' ? firefox : chromium;
console.log(`\n=== engine: ${process.env.BROWSER || 'chromium'} ===`);
const browser = await ENGINE.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const failures = [];
let checks = 0;

page.on('pageerror', (e) => failures.push(`PAGE ERROR: ${e.message}`));

async function check(name, fn) {
  checks++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const frameFor = (bp) => `iframe[src*="bp=${bp}"]`;

/** The nonce the panel for `bp` was served with — a reload changes it. */
async function nonceOf(bp) {
  return page.frameLocator(frameFor(bp)).locator('body').getAttribute('data-nonce');
}

/** Switch business process and wait for its panel to be the visible one. */
async function switchTo(bp) {
  await page.click(`#bp-${bp}`);
  await page.waitForFunction((name) => document.querySelector('#current')?.textContent === name, bp);
  await page.waitForSelector(`${frameFor(bp)}:visible`);
}

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector(frameFor('alpha'));
const firstAlpha = await nonceOf('alpha');

await check('the panel is served once for the BP you land on', async () => {
  eq(views.length, 1, 'views served');
  eq(views[0], 'mine/alpha', 'the scope served');
});

await check('switching BP leaves the first panel mounted and untouched', async () => {
  await switchTo('beta');
  eq(await page.locator(frameFor('alpha')).count(), 1, 'the alpha panel is still in the DOM');
  eq(await nonceOf('alpha'), firstAlpha, 'the alpha panel was not re-served');
  eq(views.length, 2, 'views served');
});

await check('only the BP being looked at is shown', async () => {
  eq(await page.locator(frameFor('beta')).isVisible(), true, 'beta is visible');
  eq(await page.locator(frameFor('alpha')).isVisible(), false, 'alpha is hidden, not shown');
});

await check('switching back shows the original panel — it never reloaded', async () => {
  await switchTo('alpha');
  eq(await nonceOf('alpha'), firstAlpha, 'the alpha panel kept its page');
  eq(views.length, 2, 'no new view was served');
  eq(await page.locator(frameFor('alpha')).isVisible(), true, 'alpha is visible again');
});

await check('leaving the tab entirely hides the panel without dropping it', async () => {
  await page.click('#toggle-tab');
  await page.waitForSelector(`${frameFor('alpha')}:visible`, { state: 'hidden' });
  eq(await page.locator(frameFor('alpha')).count(), 1, 'the panel is still mounted');
  await page.click('#toggle-tab');
  await page.waitForSelector(`${frameFor('alpha')}:visible`);
  eq(await nonceOf('alpha'), firstAlpha, 'coming back did not reload it');
  eq(views.length, 2, 'no new view was served');
});

await check('past the cap the stalest panel is dropped, and only that one', async () => {
  for (const bp of ['gamma', 'delta', 'epsilon']) await switchTo(bp);
  // alpha, beta, gamma, delta, epsilon is five for a cap of four: beta, the
  // least recently shown, is the one that goes.
  eq(await page.locator(frameFor('beta')).count(), 0, 'beta was evicted');
  eq(await page.locator(frameFor('alpha')).count(), 1, 'alpha is still mounted');
  eq(await nonceOf('alpha'), firstAlpha, 'and still the page it was served');
  eq(views.length, 5, 'views served');
});

await check('an evicted panel reloads on the next visit, like any first visit', async () => {
  await switchTo('beta');
  eq(views.length, 6, 'beta was served again');
  eq(views[5], 'mine/beta', 'and it is beta that was served');
});

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
