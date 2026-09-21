// End-to-end keyboard verification for bailey-lab#268, driving the real
// RequirementsTable in a headless browser. The unit tests cover the tree
// arithmetic; this covers what they cannot — that real key presses move real
// DOM focus, and that Tab still escapes the grid.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox } from 'playwright';

const HARNESS = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), 'harness-requirements.html'),
).href;

const ENGINE = process.env.BROWSER === 'firefox' ? firefox : chromium;
console.log(`\n=== engine: ${process.env.BROWSER || 'chromium'} ===`);

const browser = await ENGINE.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const failures = [];
let checks = 0;

page.on('pageerror', (e) => failures.push(`PAGE ERROR: ${e.message}`));

await page.goto(HARNESS);
await page.waitForSelector('[role="treegrid"]');

/** A compact description of whatever currently has focus. */
const focused = () =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const row = el.closest('[data-req-id]');
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      self: el.getAttribute('data-req-id'),
      inRow: row ? row.getAttribute('data-req-id') : null,
      id: el.id || null,
      label: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 28),
    };
  });

const ADD_ROW = '__add-root__';
/** Requirement rows only — the add-row is a row too, but not a requirement. */
const visibleRowIds = () =>
  page
    .$$eval('[data-req-id]', (els) => els.map((e) => e.getAttribute('data-req-id')))
    .then((ids) => ids.filter((id) => id !== ADD_ROW));

const ariaOf = (reqId) =>
  page.$eval(`[data-req-id="${reqId}"]`, (el) => ({
    level: el.getAttribute('aria-level'),
    expanded: el.getAttribute('aria-expanded'),
    tabIndex: el.getAttribute('tabindex'),
  }));

async function check(name, fn) {
  checks++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
};

console.log('\n--- semantics ---');
await check('the grid exposes treegrid + rows + gridcells', async () => {
  eq(await page.locator('[role="treegrid"]').count(), 1, 'treegrid count');
  eq(await page.locator('[role="columnheader"]').count(), 4, 'columnheader count');
  eq(
    await page.locator('[role="gridcell"]').count(),
    25,
    'gridcell count (6 requirement rows x 4, plus the add-row)',
  );
});

await check('aria-level carries the depth that padding only draws', async () => {
  eq((await ariaOf('REQ-1')).level, '1', 'REQ-1 level');
  eq((await ariaOf('REQ-1.1')).level, '2', 'REQ-1.1 level');
  eq((await ariaOf('REQ-1.1.1')).level, '3', 'REQ-1.1.1 level');
});

await check('only rows with children claim an expanded state', async () => {
  eq((await ariaOf('REQ-1')).expanded, 'true', 'REQ-1 expanded');
  eq((await ariaOf('REQ-3')).expanded, null, 'REQ-3 (leaf) must not claim expansion');
});

await check('exactly one row is tabbable', async () => {
  const tabbable = await page.$$eval('[data-req-id]', (els) =>
    els.filter((e) => e.getAttribute('tabindex') === '0').map((e) => e.getAttribute('data-req-id')),
  );
  eq(tabbable, ['REQ-1'], 'rows with tabindex=0');
});

await check('no control inside a row is tabbable', async () => {
  const leaked = await page.$$eval('[data-req-id] button', (els) =>
    els.filter((e) => e.getAttribute('tabindex') !== '-1').length,
  );
  eq(leaked, 0, 'controls left in the tab order');
});

console.log('\n--- the tab stop (the actual #268 complaint) ---');
await check('one Tab reaches the grid, one more leaves it', async () => {
  await page.focus('#before');
  await page.keyboard.press('Tab');
  eq((await focused()).self, 'REQ-1', 'after 1st Tab');
  await page.keyboard.press('Tab');
  const f = await focused();
  // The add-row lives inside the grid now, so one Tab clears the entire table
  // — requirements and the add-row together.
  if (f.inRow !== null) throw new Error(`Tab did not escape the grid, landed in ${f.inRow}`);
  eq(f.id, 'after', 'after 2nd Tab');
});

console.log('\n--- navigation ---');
await check('down and up step between rows', async () => {
  await page.focus('[data-req-id="REQ-1"]');
  await page.keyboard.press('ArrowDown');
  eq((await focused()).self, 'REQ-1.1', 'ArrowDown');
  await page.keyboard.press('ArrowDown');
  eq((await focused()).self, 'REQ-1.1.1', 'ArrowDown again');
  await page.keyboard.press('ArrowUp');
  eq((await focused()).self, 'REQ-1.1', 'ArrowUp');
});

await check('home and end jump to the ends', async () => {
  await page.keyboard.press('End');
  eq((await focused()).self, ADD_ROW, 'End lands on the add-row, the grid\'s last row');
  await page.keyboard.press('Home');
  eq((await focused()).self, 'REQ-1', 'Home');
});

await check('left collapses, and down then skips the hidden subtree', async () => {
  await page.focus('[data-req-id="REQ-1"]');
  await page.keyboard.press('ArrowLeft');
  eq((await ariaOf('REQ-1')).expanded, 'false', 'REQ-1 after collapse');
  eq(await visibleRowIds(), ['REQ-1', 'REQ-2', 'REQ-3'], 'visible rows after collapse');
  await page.keyboard.press('ArrowDown');
  eq((await focused()).self, 'REQ-2', 'ArrowDown past a collapsed subtree');
});

await check('right enters the folded row, and Enter on the chevron unfolds it', async () => {
  await page.focus('[data-req-id="REQ-1"]');
  await page.keyboard.press('ArrowRight');
  // → is no longer spent on unfolding, so a folded parent's buttons are
  // reachable without dumping its whole subtree on screen.
  eq((await ariaOf('REQ-1')).expanded, 'false', 'REQ-1 still folded after ArrowRight');
  eq(await visibleRowIds(), ['REQ-1', 'REQ-2', 'REQ-3'], 'subtree still hidden');
  const f = await focused();
  eq(f.inRow, 'REQ-1', 'focus stepped into REQ-1');
  eq(f.label, 'Expand REQ-1', 'the chevron is the first control');
  // Unfolding did not disappear — it moved onto that chevron.
  await page.keyboard.press('Enter');
  eq((await ariaOf('REQ-1')).expanded, 'true', 'REQ-1 after Enter on the chevron');
  eq((await visibleRowIds()).length, 6, 'all rows back');
});

await check('left on a closed leaf climbs to the parent', async () => {
  await page.focus('[data-req-id="REQ-1.2"]');
  await page.keyboard.press('ArrowLeft');
  eq((await focused()).self, 'REQ-1', 'ArrowLeft from a leaf');
});

console.log('\n--- entering a row ---');
await check('right on an open row steps into its controls, left returns', async () => {
  await page.focus('[data-req-id="REQ-3"]');
  await page.keyboard.press('ArrowRight');
  let f = await focused();
  eq(f.tag, 'button', 'tag after entering the row');
  eq(f.inRow, 'REQ-3', 'entered the right row');
  await page.keyboard.press('ArrowRight');
  eq((await focused()).tag, 'button', 'still on a control');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  eq((await focused()).self, 'REQ-3', 'ArrowLeft back out to the row');
});

await check('escape from a control returns to the row', async () => {
  await page.focus('[data-req-id="REQ-2"]');
  await page.keyboard.press('ArrowRight');
  eq((await focused()).tag, 'button', 'inside the row');
  await page.keyboard.press('Escape');
  eq((await focused()).self, 'REQ-2', 'after Escape');
});

console.log('\n--- editing ---');
await check('enter opens the editor and focuses the textarea', async () => {
  await page.focus('[data-req-id="REQ-3"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-req-id="REQ-3"] textarea');
  eq((await focused()).tag, 'textarea', 'focus after Enter');
});

await check('escape cancels the edit and hands focus back to the row', async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-req-id="REQ-3"] textarea', { state: 'detached' });
  await page.waitForTimeout(50); // the deferred focus restore
  eq((await focused()).self, 'REQ-3', 'focus after Escape');
});

await check('enter commits an edit and hands focus back', async () => {
  await page.focus('[data-req-id="REQ-3"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-req-id="REQ-3"] textarea');
  await page.keyboard.type('Audit log is written');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-req-id="REQ-3"] textarea', { state: 'detached' });
  await page.waitForTimeout(50);
  eq((await focused()).self, 'REQ-3', 'focus after commit');
  const text = await page.$eval('[data-req-id="REQ-3"]', (el) => el.textContent);
  if (!text.includes('Audit log is written')) throw new Error(`description not saved: ${text}`);
});

await check('arrow keys inside the editor are left to the textarea', async () => {
  await page.focus('[data-req-id="REQ-1"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-req-id="REQ-1"] textarea');
  await page.keyboard.press('ArrowDown');
  eq((await focused()).tag, 'textarea', 'focus must stay in the editor');
  await page.keyboard.press('Escape');
});


console.log('\n--- collapse must not strand focus ---');
await check('collapsing a subtree moves focus to the nearest visible ancestor', async () => {
  await page.focus('[data-req-id="REQ-1.1.1"]');
  // dispatchEvent fires the click WITHOUT focusing the chevron, reproducing
  // engines (Safari) that do not focus a button on click. Chromium/Firefox
  // would otherwise mask the bug by moving focus to the chevron themselves.
  await page.dispatchEvent('[aria-label="Collapse REQ-1"]', 'click');
  await page.waitForTimeout(50);
  const f = await focused();
  if (f.tag === 'body') throw new Error('focus fell to <body> — keyboard user stranded');
  eq(f.self, 'REQ-1', 'focus after the subtree was hidden');
  eq(await visibleRowIds(), ['REQ-1', 'REQ-2', 'REQ-3'], 'subtree actually hidden');
  await page.click('[aria-label="Expand REQ-1"]');
});

await check('collapsing elsewhere leaves unrelated focus alone', async () => {
  await page.focus('[data-req-id="REQ-3"]');
  await page.dispatchEvent('[aria-label="Collapse REQ-1"]', 'click');
  await page.waitForTimeout(50);
  eq((await focused()).self, 'REQ-3', 'focus must not be stolen');
  await page.click('[aria-label="Expand REQ-1"]');
});


console.log('\n--- the add-row is part of the grid ---');
await check('down from the last requirement reaches "New requirement"', async () => {
  await page.focus('[data-req-id="REQ-3"]');
  await page.keyboard.press('ArrowDown');
  eq((await focused()).self, '__add-root__', 'ArrowDown past the last requirement');
  await page.keyboard.press('ArrowUp');
  eq((await focused()).self, 'REQ-3', 'ArrowUp back off it');
});

await check('End lands on it and Enter creates a requirement', async () => {
  const before = (await visibleRowIds()).length;
  await page.focus('[data-req-id="REQ-1"]');
  await page.keyboard.press('End');
  eq((await focused()).self, '__add-root__', 'End');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  const after = (await visibleRowIds()).length;
  if (after !== before + 1) throw new Error(`expected a new row, went ${before} -> ${after}`);
  // It opens in edit mode, as RequirementsTab does; close it for later checks.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
});

await check('the grid is still a single tab stop with the add-row inside', async () => {
  const tabbable = await page.$$eval('[data-req-id]', (els) =>
    els.filter((e) => e.getAttribute('tabindex') === '0').length,
  );
  eq(tabbable, 1, 'rows with tabindex=0');
  const leaked = await page.$$eval('[data-req-id] button', (els) =>
    els.filter((e) => e.getAttribute('tabindex') !== '-1').length,
  );
  eq(leaked, 0, 'controls left in the tab order');
});

console.log('\n--- vertical movement from inside a row ---');
await check('up and down move rows even when focus is on a control', async () => {
  await page.focus('[data-req-id="REQ-1.2"]');
  await page.keyboard.press('ArrowRight'); // step into the row's controls
  eq((await focused()).tag, 'button', 'inside the row');
  await page.keyboard.press('ArrowDown');
  eq((await focused()).self, 'REQ-2', 'ArrowDown from a control');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  eq((await focused()).self, 'REQ-1.2', 'ArrowUp from a control');
});

await check('left and right still move between controls, not rows', async () => {
  await page.focus('[data-req-id="REQ-3"]');
  await page.keyboard.press('ArrowRight');
  const first = await focused();
  await page.keyboard.press('ArrowRight');
  const second = await focused();
  eq(second.inRow, 'REQ-3', 'still in the same row');
  if (first.label === second.label) throw new Error('ArrowRight did not move between controls');
});

console.log('\n--- the three actions reported missing in review ---');

/**
 * → from a row until the control with this accessible name holds focus.
 * Walking rather than seeking the button directly is the point: it proves the
 * control is *reachable* by key, not merely that it exists in the DOM.
 */
async function walkTo(reqId, label, max = 12) {
  await page.focus(`[data-req-id="${reqId}"]`);
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('ArrowRight');
    if ((await focused()).label === label) return i + 1;
  }
  throw new Error(`never reached "${label}" from ${reqId} in ${max} presses`);
}
const callsSince = async (fn) => {
  await page.evaluate(() => { window.__calls.length = 0; });
  await fn();
  return page.evaluate(() => window.__calls);
};

await check('an individual test runs from the keyboard', async () => {
  const calls = await callsSince(async () => {
    await walkTo('REQ-3', 'Run test for REQ-3');
    await page.keyboard.press('Enter');
  });
  eq(calls, ['runTest:REQ-3'], 'onRunTest after Enter');
});

await check('a child requirement is added from the keyboard', async () => {
  const calls = await callsSince(async () => {
    await walkTo('REQ-2', 'Add child requirement');
    await page.keyboard.press('Enter');
  });
  eq(calls, ['addChild:REQ-2'], 'onAddChild after Enter');
  // And it lands in the tree as a child, not a sibling.
  if (!(await visibleRowIds()).includes('REQ-2.NEW')) throw new Error('the child row never appeared');
  eq((await ariaOf('REQ-2.NEW')).level, '2', 'the new child sits one level deeper');
});

await check('a folded parent runs its test without being unfolded', async () => {
  await page.focus('[data-req-id="REQ-1"]');
  await page.keyboard.press('ArrowLeft');
  eq((await ariaOf('REQ-1')).expanded, 'false', 'REQ-1 folded');
  const before = (await visibleRowIds()).length;
  const calls = await callsSince(async () => {
    await walkTo('REQ-1', 'Run test for REQ-1');
    await page.keyboard.press('Enter');
  });
  eq(calls, ['runTest:REQ-1'], 'onRunTest on a folded row');
  eq((await ariaOf('REQ-1')).expanded, 'false', 'still folded afterwards');
  eq((await visibleRowIds()).length, before, 'no subtree rows appeared');
});

console.log('\n--- "+" adds a requirement ---');

// Playwright reads "+" as its own modifier separator, so the literal key is
// pressed by name: Shift+Equal yields key="+" and Equal yields key="=".
const PLUS = 'Shift+Equal';
const rowCount = async () => (await visibleRowIds()).length;
/** Dismiss the editor the new requirement opens in, as RequirementsTab does. */
const settle = async () => {
  await page.waitForTimeout(50);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
};

await check('+ on a row adds a requirement', async () => {
  const before = await rowCount();
  await page.focus('[data-req-id="REQ-2"]');
  await page.keyboard.press(PLUS);
  await page.waitForTimeout(50);
  eq(await rowCount(), before + 1, 'rows after "+"');
  await settle();
});

await check('= does the same, so a US layout need not hold Shift', async () => {
  const before = await rowCount();
  await page.focus('[data-req-id="REQ-2"]');
  await page.keyboard.press('Equal');
  await page.waitForTimeout(50);
  eq(await rowCount(), before + 1, 'rows after "="');
  await settle();
});

await check('+ works from inside a row as well as on it', async () => {
  const before = await rowCount();
  await page.focus('[data-req-id="REQ-2"]');
  await page.keyboard.press('ArrowRight');
  eq((await focused()).tag, 'button', 'focus is on a control');
  await page.keyboard.press(PLUS);
  await page.waitForTimeout(50);
  eq(await rowCount(), before + 1, 'rows after "+" from a control');
  await settle();
});

await check('Ctrl and + is left alone, so the browser can still zoom', async () => {
  const before = await rowCount();
  await page.focus('[data-req-id="REQ-2"]');
  await page.keyboard.press('Control+Shift+Equal');
  await page.waitForTimeout(50);
  eq(await rowCount(), before, 'a modified "+" must add nothing');
});

await check('+ inside the description editor types a character', async () => {
  const before = await rowCount();
  await page.focus('[data-req-id="REQ-3"]');
  await page.keyboard.press('Enter');
  if (!(await page.$('textarea'))) throw new Error('the editor did not open');
  await page.keyboard.type('a+b');
  eq(await page.$eval('textarea', (el) => el.value.endsWith('a+b')), true, 'the + was typed');
  eq(await rowCount(), before, 'no requirement added while editing');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
});

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
await browser.close();
process.exit(failures.length ? 1 : 0);
