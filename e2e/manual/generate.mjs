#!/usr/bin/env node
/**
 * Build the Operator's Handbook from editorial content + screenshots captured
 * during the live walkthrough.
 *
 *   node e2e/manual/generate.mjs
 *
 * Inputs:
 *   - content.mjs ................ editorial copy + standards mappings (in repo)
 *   - build/shots.json ........... { "<slotId>": "shots/<file>.png", ... } written
 *                                  by the Playwright run (absent ⇒ slots render
 *                                  an honest "capture pending" placeholder)
 *   - build/shots/*.png .......... the live screenshots
 *
 * Outputs (build/):
 *   - handbook.html .............. one self-contained file (screenshots inlined)
 *   - handbook.pdf ............... print-rendered via headless Chromium
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MANUAL } from './content.mjs';
import { renderHandbook } from './template.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, 'build');
const SHOTS = join(BUILD, 'shots');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function dataUriFor(file) {
  const abs = join(SHOTS, file);
  if (!existsSync(abs)) return null;
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`unsupported screenshot type: ${file}`);
  return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
}

function loadShotsMap() {
  const f = join(BUILD, 'shots.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  // No manifest yet — fall back to convention: <slotId>.png in build/shots.
  if (!existsSync(SHOTS)) return {};
  const map = {};
  for (const file of readdirSync(SHOTS)) {
    const id = file.slice(0, file.lastIndexOf('.'));
    if (id) map[id] = file;
  }
  return map;
}

function attachShots(manual, shots) {
  const slotShot = (slot) => {
    const file = shots[slot.id];
    return { label: slot.label, caption: slot.caption, dark: !!slot.dark, dataUri: file ? dataUriFor(file) : null };
  };
  return {
    ...manual,
    generatedAt: process.env.MANUAL_DATE || new Date().toISOString().slice(0, 10),
    coverShot: manual.coverShot ? slotShot(manual.coverShot) : null,
    chapters: (manual.chapters || []).map((ch) => ({ ...ch, shots: (ch.slots || []).map(slotShot) })),
  };
}

// Paged.js turns the document's CSS paged-media (@page margin boxes, the TOC's
// target-counter() page numbers) into a real, numbered A4 layout BEFORE we
// print. We run the polyfill inside the headless browser, wait for it to finish
// chunking the flow into .pagedjs_page sheets, then PDF the paginated result.
async function renderPdf(htmlPath, pdfPath) {
  const { chromium } = await import('@playwright/test');
  const polyfill = join(HERE, '..', 'node_modules', 'pagedjs', 'dist', 'paged.polyfill.js');
  if (!existsSync(polyfill)) {
    throw new Error(`Paged.js polyfill not found at ${polyfill} — cannot number pages.`);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Auto-running is disabled so we can await the 'rendered' promise ourselves.
    await page.addInitScript(() => {
      window.PagedConfig = { auto: false };
    });
    await page.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
    await page.addScriptTag({ path: polyfill });
    // Run Paged.js and resolve once the whole book is laid out into numbered
    // sheets. previewer.preview() returns a flow with the final page count.
    const pages = await page.evaluate(async () => {
      const previewer = new window.Paged.Previewer();
      const flow = await previewer.preview();
      return flow.total;
    });
    console.log(`Paged.js: laid out ${pages} numbered A4 pages.`);
    await page.emulateMedia({ media: 'print' });
    // Paged.js sized each .pagedjs_page to A4 already; print at that size.
    await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  const shots = loadShotsMap();
  const manual = attachShots(MANUAL, shots);
  const present = Object.keys(shots).length;
  const slots = (MANUAL.chapters || []).reduce((n, c) => n + (c.slots ? c.slots.length : 0), 0) + (MANUAL.coverShot ? 1 : 0);
  console.log(`Handbook: ${manual.chapters.length} chapters, ${present}/${slots} screenshot slots filled.`);

  const html = renderHandbook(manual);
  const htmlPath = join(BUILD, 'handbook.html');
  writeFileSync(htmlPath, html);
  console.log('Wrote ' + htmlPath);

  const pdfPath = join(BUILD, 'handbook.pdf');
  if (process.env.MANUAL_NO_PDF === '1') {
    console.log('MANUAL_NO_PDF=1 — skipping PDF.');
  } else {
    await renderPdf(htmlPath, pdfPath);
    console.log('Wrote ' + pdfPath);
  }

  // Publish into the Server Console so the manual is built INTO the product:
  // the console serves these as static assets (/handbook/handbook.{html,pdf})
  // behind its "Handbook" nav item.
  const consoleDir = join(HERE, '..', '..', 'bitswan-server-console');
  if (existsSync(consoleDir)) {
    const pub = join(consoleDir, 'public', 'handbook');
    mkdirSync(pub, { recursive: true });
    copyFileSync(htmlPath, join(pub, 'handbook.html'));
    if (existsSync(pdfPath)) copyFileSync(pdfPath, join(pub, 'handbook.pdf'));
    console.log('Published handbook into the Server Console (' + pub + ').');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
