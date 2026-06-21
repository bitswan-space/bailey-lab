/**
 * The canonical Operator's-Handbook template. Pure functions: given the capture
 * manifest produced by the walkthrough, return a self-contained HTML string.
 * The design here is the signed-off one (see design-preview.html): real Bitswan
 * logo, swan-glyph accents, "Bailey is best practice" mark, cover + why-spread +
 * per-feature chapters, each closing with an ISO 27001 / DORA / NIS2 panel.
 *
 * Screenshots are embedded as data URIs so the output is one portable file that
 * renders identically in a browser, inside the product, and through print→PDF.
 */

// --- Brand assets (the real Bitswan logo + swan glyph, from bailey_branding.go) ---
export const WORDMARK = `<svg viewBox="0 0 663.4 154.8" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M612.6,77.7c5.8-5.8,12.4-8.7,19.8-8.7c6.1,0,10.8,1,14,3s4.3,3.7,4.3,7.3v38h12.6V78.6c0-5.6-1.8-9.8-5.4-12.9c-5.6-4.7-13.2-7.1-22.7-7.1c-8.6,0-16.2,3.3-22.7,9.9v-8.6H600v57.5h12.6V77.7z M583.2,117.3V59.8h-12.6V68c-7-6-15.8-9.4-25-9.5c-9,0-16.7,2.6-23,7.9c-3.5,3.1-5.4,7.3-5.4,12.9v18.5c0,5.6,1.8,9.8,5.4,12.9c6.1,5.2,13.8,7.8,23,7.8c9.2,0.2,18.2-3.2,25-9.4v8.1L583.2,117.3z M570.6,98.4c-2.7,3.2-6.2,5.6-10.1,7c-3.8,1.8-8,2.8-12.2,2.9c-4.8,0-9.6-1.3-13.8-3.7c-3.5-2-4.7-3.8-4.7-7.4V80.1c0-3.8,1.1-5.5,4.7-7.4c4.2-2.4,8.9-3.6,13.8-3.6c4.2,0.1,8.4,1,12.2,2.7c4.5,1.8,7.8,4.1,10.1,7V98.4z M491.7,117.3l18.1-57.5h-13.1l-14.2,47.3h-3l-15-47.3h-13.4l-16.3,47.3H432l-13.9-47.3h-13.6l18.2,57.5H443l14.5-42.9l14,42.9H491.7z M360.5,118.4c12.2,0,21.1-1.2,26.5-3.6c6.4-3,9.6-7.6,9.6-13.6v-6.1c0.2-3.8-1.4-7.5-4.2-10c-2.6-2.4-7.2-4.6-14-6.3l-20.1-5.4c-5.6-1.4-9.2-2.8-10.6-4s-2.4-3.3-2.4-6c0-2.9,1-4.9,3-6.2c2.6-1.7,8.4-2.6,17.1-2.6c9.1-0.1,18.1,0.8,27,2.7V46.8c-8.5-1.6-17-2.4-25.6-2.3c-12.7,0-21.8,1.7-27.1,5.3c-4.7,3.1-7,7.1-7,12v5.3c-0.1,3.6,1.3,7,3.9,9.5c3.1,2.9,8.4,5.4,16,7.3l19.2,5.2c9.3,2.3,12.1,4.5,12.1,9.5c0,3.6-1.1,6-3.3,7.2c-3.3,1.7-9.8,2.6-19.4,2.6c-9.5,0.1-18.9-0.9-28.2-2.7v10.7C341.9,117.8,351.1,118.5,360.5,118.4 M323.3,106.7c-4.6,1.3-9.3,1.9-14.1,1.8c-4.7,0-8.4-0.9-11-2.9c-2.4-1.8-3.1-4-3.1-8.6V69.6h28.2v-9.9h-28.1V45.1h-12.6v52.8c0,7.8,1.4,12,5.8,15.7c4.2,3.3,10.6,4.9,19.4,4.9c6.8,0,11.9-0.7,15.6-2.2L323.3,106.7z M266,59.7h-12.6v57.5H266V59.7z M266,36.5h-12.6v13.1H266V36.5z M213,117.3c11.8,0,18-1.3,22.7-5.3c4.5-3.8,6.1-6.5,6.1-12.4v-5c0-6-2.9-10.3-8.7-12.9c-0.9-0.5-1.6-0.8-1.9-0.9l0.4-0.2c5.4-2.2,8-6.3,8-12.4V63c0-5.5-1.4-8.5-5.1-11.8c-4.4-3.7-11.8-5.5-22.4-5.5h-36.3v71.6H213z M215.2,85.9c5,0,8.6,0.8,10.8,2.5s3.3,4.5,3.3,8.4s-1.3,6.5-3.7,8.2c-2.2,1.6-6.3,2.4-12.3,2.4h-25.1V85.9H215.2z M211.2,55.7c6.8,0,11.1,0.9,13.3,2.9c1.7,1.7,2.6,4.2,2.6,7.7c0,3.7-0.9,6.2-2.8,7.7c-2.1,1.5-5,2.3-8.9,2.3h-27.2V55.7H211.2z" fill="currentColor"/><path d="M0,104.5V5l59.9,50L10.3,92.8C6,96,2.5,100,0,104.5z M90.7,80.6l-21.3,18c-7.1,6.2-10.9,14.5-10.9,24c0,8.6,3.4,16.7,9.4,22.8c6.1,6.1,14.2,9.5,22.8,9.5s16.7-3.4,22.8-9.5c6.1-6.1,9.4-14.2,9.4-22.8s-3.3-16.7-9.4-22.7L90.7,80.6z M118.5,15.8l-25,19.5l0,0L13.1,96.6C4.9,102.6,0,112.3,0,122.5c0,8.6,3.4,16.7,9.4,22.8c6.1,6.1,14.2,9.5,22.8,9.5h40.4c-2.9-1.6-5.6-3.7-8.1-6.1c-7-7-10.8-16.3-10.8-26.1c0-10.7,4.4-20.5,12.5-27.6l46-38.7c6.8-5.8,10.8-14.9,10.8-24C123,26.4,121.5,20.8,118.5,15.8z M57.5,0l36.1,29.3L115.7,12c-0.5-0.6-1.3-1.5-2.3-2.7C107,1.6,97.5,0,90.8,0H57.5z" fill="currentColor"/></svg>`;

export const GLYPH = `<svg viewBox="0 0 123 154.8" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M0,104.5V5l59.9,50L10.3,92.8C6,96,2.5,100,0,104.5z M90.7,80.6l-21.3,18c-7.1,6.2-10.9,14.5-10.9,24c0,8.6,3.4,16.7,9.4,22.8c6.1,6.1,14.2,9.5,22.8,9.5s16.7-3.4,22.8-9.5c6.1-6.1,9.4-14.2,9.4-22.8s-3.3-16.7-9.4-22.7L90.7,80.6z M118.5,15.8l-25,19.5l0,0L13.1,96.6C4.9,102.6,0,112.3,0,122.5c0,8.6,3.4,16.7,9.4,22.8c6.1,6.1,14.2,9.5,22.8,9.5h40.4c-2.9-1.6-5.6-3.7-8.1-6.1c-7-7-10.8-16.3-10.8-26.1c0-10.7,4.4-20.5,12.5-27.6l46-38.7c6.8-5.8,10.8-14.9,10.8-24C123,26.4,121.5,20.8,118.5,15.8z M57.5,0l36.1,29.3L115.7,12c-0.5-0.6-1.3-1.5-2.3-2.7C107,1.6,97.5,0,90.8,0H57.5z"/></svg>`;

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const glyph = (color) => `<span class="glyph" style="color:${color}">${GLYPH}</span>`;

const CSS = `
*{box-sizing:border-box} html,body{margin:0;padding:0}
:root{ --ink:#0a1622; --steel:#16344b; --paper:#faf8f3; --paper2:#f1ece1; --line:#e3dccd;
  --amber:#ff7a18; --amber2:#ffb43d; --teal:#36c5b0; --muted:#6f7b88; --maxw:920px; }
body{ font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:#0c1722; background:#33414f; line-height:1.55; -webkit-font-smoothing:antialiased; }
/* Every page is a real A4 sheet (210×297mm) so the manual is uniform on screen
   and prints clean to A4. Dense chapters may flow to a second sheet; short ones
   stay a full page rather than collapsing to their content height. */
.page{ width:210mm; min-height:297mm; margin:16px auto; background:var(--paper);
  box-shadow:0 24px 60px rgba(0,0,0,.35); border-radius:2px; overflow:hidden; position:relative; }
.pad{ padding:22mm 20mm; min-height:297mm; box-sizing:border-box }
@media (max-width:820px){ .page{ width:100%; min-height:0 } .pad{ padding:32px 24px; min-height:0 } }
.logo{display:inline-block;line-height:0} .logo svg{height:30px;width:auto;display:block}
.cover .logo svg{height:34px}
.glyph{display:inline-block;line-height:0;vertical-align:middle} .glyph svg{height:16px;width:auto;display:block}
.cover{ background:radial-gradient(1200px 500px at 80% -10%, rgba(255,122,24,.30), transparent 60%),
  radial-gradient(900px 600px at -10% 110%, rgba(54,197,176,.18), transparent 55%),
  linear-gradient(160deg,#08111c 0%, #0c1f30 60%, #0a1622 100%); color:#eaf1f7; }
.cover-watermark{position:absolute;right:-60px;top:60px;opacity:.05;pointer-events:none}
.cover-watermark svg{height:560px;width:auto;color:#9fd9ce}
.kicker{ display:inline-flex; align-items:center; gap:9px; font-size:12px; font-weight:700;
  letter-spacing:.18em; text-transform:uppercase; color:var(--amber2); border:1px solid rgba(255,180,61,.35);
  padding:7px 13px; border-radius:999px; background:rgba(255,180,61,.06); }
.dot{width:7px;height:7px;border-radius:50%;background:var(--teal);box-shadow:0 0 12px var(--teal)}
.cover h1{ font-size:84px; line-height:.92; margin:26px 0 0; letter-spacing:-.03em; font-weight:800;
  background:linear-gradient(180deg,#ffffff,#bcd0df); -webkit-background-clip:text; background-clip:text; color:transparent; }
.cover .sub{ font-size:25px; font-weight:600; color:#cfe0ee; margin:14px 0 0; letter-spacing:-.01em }
.cover .tag{ font-size:16px; color:#9fb4c6; max-width:520px; margin:22px 0 0 }
.bpmark{ margin:30px 0 0; font-size:34px; font-weight:800; letter-spacing:-.02em; color:#dfeaf2 }
.bpmark span{ color:var(--amber2); position:relative }
.bpmark span::after{ content:""; position:absolute; left:0; right:0; bottom:2px; height:8px; background:rgba(255,122,24,.22); z-index:-1 }
.hero-shot{ margin:40px 0 0; position:relative;
  background:#0a1826; border:1px solid rgba(255,255,255,.10);
  box-shadow:0 30px 60px rgba(0,0,0,.45); overflow:hidden; }
.hero-shot img{width:100%;height:auto;display:block}
.hero-ph{min-height:340px;display:flex;align-items:center;justify-content:center;color:#7fa0ba;font-size:13px;font-weight:600}
.cover-foot{ display:flex; justify-content:space-between; align-items:center; gap:16px; margin-top:40px;
  padding-top:22px; border-top:1px solid rgba(255,255,255,.10); font-size:13px; color:#8ba3b6; }
.live-badge{ color:#bfe9e0; display:inline-flex; gap:8px; align-items:center; font-weight:600 }
.manifesto{ background:linear-gradient(165deg,#0c1f30,#0a1622); color:#e8eff5 }
.manifesto h2{ font-size:15px; letter-spacing:.2em; text-transform:uppercase; color:var(--amber2); margin:0 0 30px; font-weight:700 }
.promises{ display:grid; gap:30px } .promise{ display:grid; grid-template-columns:64px 1fr; gap:22px; align-items:start }
.promise .num{ font-size:40px; font-weight:800; color:transparent; -webkit-text-stroke:1.4px rgba(255,180,61,.55); line-height:1 }
.promise h3{ font-size:26px; margin:0 0 6px; letter-spacing:-.01em; color:#fff } .promise p{ margin:0; color:#a9bccd; font-size:16px }
.chapter-head{ display:flex; align-items:baseline; gap:18px; margin-bottom:8px }
.chapter-num{ font-size:14px; font-weight:800; letter-spacing:.16em; color:#fff; background:var(--ink); padding:6px 12px; border-radius:6px }
.chapter-eyebrow{ font-size:13px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--amber) }
.chapter h2{ font-size:46px; line-height:1.02; letter-spacing:-.025em; margin:8px 0 0; color:var(--ink) }
.lede{ font-size:20px; color:#33404d; margin:20px 0 0; max-width:640px; font-weight:500 }
.shot{ margin:30px 0 8px; position:relative; overflow:hidden; background:#f1f4f7;
  border:1px solid var(--line); box-shadow:0 18px 40px rgba(12,30,48,.12); }
.shot.empty{ min-height:300px; display:flex; align-items:center; justify-content:center }
.shot img{ width:100%; height:auto; display:block }
.shot.dark{ background:#0a1826; border-color:rgba(255,255,255,.08) }
.shotcap{ font-size:12px; font-style:italic; color:var(--muted); margin:0 0 26px }
.shot .ph{ text-align:center; color:#9aa7b3; font-size:14px; font-weight:600; padding:20px }
.two{ display:grid; grid-template-columns:1.1fr .9fr; gap:40px; margin-top:8px }
@media (max-width:680px){ .two{ grid-template-columns:1fr; gap:26px } .cover h1{font-size:54px} .chapter h2{font-size:34px} }
.selltext p{ font-size:16.5px; color:#39454f; margin:0 0 16px } .selltext strong{ color:var(--ink) }
.howto{ background:var(--paper2); border:1px solid var(--line); border-radius:12px; padding:26px 28px }
.howto h4{ margin:0 0 18px; font-size:13px; letter-spacing:.14em; text-transform:uppercase; color:var(--steel) }
.step{ display:grid; grid-template-columns:30px 1fr; gap:14px; margin-bottom:16px } .step:last-child{margin-bottom:0}
.step .s{ width:26px;height:26px;border-radius:50%; background:var(--ink); color:#fff; font-weight:700; font-size:13px; display:flex; align-items:center; justify-content:center }
.step .t{ font-size:15px; color:#2c3a45 } .step .t b{color:var(--ink)}
.callout{ margin-top:34px; border-left:4px solid var(--amber); background:linear-gradient(90deg,rgba(255,122,24,.07),transparent); padding:18px 22px; border-radius:0 10px 10px 0 }
.callout .c-k{ font-size:12px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--amber) }
.callout p{ margin:6px 0 0; font-size:16px; color:#33404d }
.specs{ display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:12px; overflow:hidden; margin-top:30px }
.spec{ background:var(--paper); padding:22px } .spec .v{ font-size:30px; font-weight:800; color:var(--ink); letter-spacing:-.02em } .spec .l{ font-size:13px; color:var(--muted); margin-top:4px }
.std{ margin-top:32px; border:1px solid var(--line); border-radius:14px; overflow:hidden; background:#fff }
.std-h{ display:flex; align-items:center; gap:10px; padding:16px 22px; background:var(--ink); color:#fff; font-size:13.5px; font-weight:700; letter-spacing:.04em }
.std-h .glyph{ color:var(--amber2) } .std-h .glyph svg{ height:18px }
.std ul{ list-style:none; margin:0; padding:8px 0 }
.std li{ display:grid; grid-template-columns:170px 1fr; gap:18px; padding:14px 22px; border-top:1px solid var(--paper2); align-items:start } .std li:first-child{ border-top:none }
.std .code{ font-weight:800; color:var(--ink); font-size:13.5px; line-height:1.35 }
.std .code em{ display:block; font-weight:600; font-style:normal; color:var(--amber); font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; margin-top:3px }
.std .demand{ font-size:14.5px; color:#39454f } .std .demand b{ color:var(--ink) }
.runfoot{ margin-top:46px; padding-top:20px; border-top:1px solid var(--line); display:flex; justify-content:space-between; font-size:12.5px; color:var(--muted) }
.runfoot .brand{ display:inline-flex; align-items:center; gap:8px; color:var(--ink); font-weight:600 }
.matrix table{ width:100%; border-collapse:collapse; margin-top:24px; font-size:14px }
.matrix th{ text-align:left; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); padding:0 12px 10px; border-bottom:2px solid var(--ink) }
.matrix td{ padding:13px 12px; border-bottom:1px solid var(--line); color:#33404d; vertical-align:top }
.matrix td b{ color:var(--ink) }
.guide .ghead{ font-size:13px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--amber) }
.guide h2{ font-size:34px; letter-spacing:-.02em; margin:8px 0 0; color:var(--ink) }
.guide .gblurb{ font-size:15px; color:#39454f; margin:14px 0 0; max-width:680px }
.guide table{ width:100%; border-collapse:collapse; margin-top:22px; font-size:12.5px }
.guide th{ text-align:left; font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); padding:0 10px 9px; border-bottom:2px solid var(--ink) }
.guide td{ padding:11px 10px; border-bottom:1px solid var(--line); color:#39454f; vertical-align:top }
.guide td.ctl{ font-weight:800; color:var(--ink); white-space:nowrap }
.guide td.ch{ font-weight:700; color:var(--steel); white-space:nowrap; text-align:center }
.cov{ display:inline-flex; align-items:center; gap:5px; font-weight:700; font-size:11px; padding:3px 8px; border-radius:999px; white-space:nowrap }
.cov.provided{ color:#15803d; background:#dcfce7 } .cov.partial{ color:#b45309; background:#fef3c7 } .cov.yours{ color:#475569; background:#e7ecf1 }
.scorecards{ display:grid; gap:12px; margin-top:24px }
.scorecard{ display:grid; grid-template-columns:1fr auto auto auto; gap:14px; align-items:center; padding:16px 20px; border:1px solid var(--line); border-radius:12px; background:#fff }
.scorecard .sname{ font-weight:800; color:var(--ink); font-size:16px }
.scorecard .sn{ text-align:center; min-width:84px }
.scorecard .sn b{ display:block; font-size:24px; font-weight:800; line-height:1 }
.scorecard .sn span{ font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted) }
.legend{ display:flex; gap:16px; margin-top:18px; font-size:12px; color:#39454f; flex-wrap:wrap }
.brand-lock{ display:flex; align-items:flex-end; gap:14px }
.brand-lock .brand-bailey{ font-size:31px; font-weight:800; color:#fff; letter-spacing:-.01em; line-height:.82 }
/* ── Table of contents ─────────────────────────────────────────────────────
   The TOC lives on its own sheet. Page numbers are filled by Paged.js via
   target-counter() at print time (real, post-layout page numbers — not a
   render-time guess). On screen the leader/number simply collapse. */
.toc .toc-h{ font-size:13px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--amber) }
.toc h2{ font-size:40px; letter-spacing:-.025em; margin:8px 0 24px; color:var(--ink) }
.toc ol{ list-style:none; margin:0; padding:0; counter-reset:none }
.toc .toc-row{ display:flex; align-items:baseline; gap:10px; padding:11px 0; border-bottom:1px solid var(--line) }
.toc .toc-row.group{ margin-top:22px; border-bottom:2px solid var(--ink); padding-bottom:8px }
.toc .toc-num{ font-weight:800; color:var(--steel); font-size:13px; min-width:38px; letter-spacing:.04em }
.toc .toc-title{ font-weight:600; color:var(--ink); font-size:16px }
.toc .toc-row.group .toc-title{ font-size:13px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--muted) }
.toc .toc-sub{ color:var(--muted); font-size:13.5px; font-weight:500 }
.toc .toc-dots{ flex:1; border-bottom:1.5px dotted var(--line); transform:translateY(-4px); min-width:20px }
.toc .toc-pg{ font-weight:700; color:var(--ink); font-size:13.5px; font-variant-numeric:tabular-nums }
.toc a{ display:flex; align-items:baseline; gap:10px; flex:1; text-decoration:none; color:inherit }
.toc a.toc-pg{ flex:none; text-decoration:none }
.toc a.toc-pg::after{ content:target-counter(attr(href), page); }

@media screen{ .toc .toc-dots, .toc .toc-pg{ display:none } }

@media print{
  body{ background:#fff }
  .page{ box-shadow:none; border-radius:0; margin:0; width:auto; min-height:auto; break-after:page; overflow:visible }
  .page:last-child{ break-after:auto }
  .pad{ min-height:auto }
  /* The cover is a single full-bleed sheet: tighten its rhythm and cap the hero
     screenshot so the whole composition fits one A4 page (no spill). */
  .cover .pad{ padding:18mm 16mm }
  .cover h1{ font-size:62px; margin-top:20px }
  .cover .sub{ font-size:21px }
  .cover .tag{ margin-top:16px }
  .bpmark{ margin-top:22px; font-size:28px }
  .hero-shot{ margin-top:24px }
  .hero-shot img{ max-height:118mm; width:100%; object-fit:cover; object-position:top }
  .cover-foot{ margin-top:22px; padding-top:14px }
}

/* ── Paged.js paged-media: A4 sheets with a running footer + page numbers ────
   Paged.js (injected by the generator) honours these @page margin boxes. The
   cover is its own named page with no footer; every other page shows the
   handbook footer on the left and the page number on the right. */
@page{
  size:A4; margin:14mm 13mm 16mm 13mm;
  @bottom-left{ content:"Bitswan Bailey · The Operator's Handbook"; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:8.5pt; color:#8a93a0; }
  @bottom-right{ content:counter(page); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:9pt; font-weight:700; color:#0c1722; }
}
@page :first{ margin:0; @bottom-left{ content:none } @bottom-right{ content:none } }
@page cover{ margin:0; @bottom-left{ content:none } @bottom-right{ content:none } }
.cover{ page:cover }
/* Paged.js renders each sheet as .pagedjs_page; let full-bleed sections paint
   their dark backgrounds to the edge by neutralising the page margin visually
   on the cover/manifesto via their own padding (.pad). */
.pagedjs_page{ background:#fff }
`;

function coverShot(shot) {
  if (shot && shot.dataUri) return `<img src="${shot.dataUri}" alt="${esc(shot.caption || '')}">`;
  return `<div class="hero-ph">${glyph('#7fa0ba')}<span style="margin-left:10px">${esc((shot && shot.caption) || 'Cover capture — the Bitswan workspace, live')}</span></div>`;
}

function renderCover(m) {
  return `<section class="page cover">
  <div class="cover-watermark">${glyph('#9fd9ce')}</div>
  <div class="pad">
    <span class="brand-lock"><span class="logo" style="color:#fff">${WORDMARK}</span><span class="brand-bailey">Bailey</span></span>
    <span class="kicker" style="margin-top:22px"><span class="dot"></span> Bitswan Bailey · ${esc(m.subtitle || "The Operator's Handbook")} · ${esc(m.edition || '2026 Edition')}</span>
    <h1>${esc(m.headline || 'Run it like it matters.')}</h1>
    <div class="sub">${esc(m.tagline || 'Business processes on infrastructure that defends itself.')}</div>
    <p class="tag">${esc(m.blurb || '')}</p>
    <div class="bpmark">Bailey is <span>best practice</span>.</div>
    <div class="hero-shot">${coverShot(m.coverShot)}</div>
    <div class="cover-foot">
      <span class="live-badge"><span class="dot"></span> Every screenshot in this manual was captured live, walking the real product${m.generatedAt ? ' on ' + esc(m.generatedAt) : ''}.</span>
      ${m.docNo ? `<span>${esc(m.docNo)}</span>` : ''}
    </div>
  </div>
</section>`;
}

function renderManifesto(m) {
  if (!m.promises || !m.promises.length) return '';
  const items = m.promises.map((p, i) => `<div class="promise"><div class="num">${String(i + 1).padStart(2, '0')}</div><div><h3>${esc(p.title)}</h3><p>${esc(p.body)}</p></div></div>`).join('');
  return `<section class="page manifesto" id="manifesto"><div class="pad">
    <h2>${esc(m.manifestoTitle || 'Why teams put Bitswan in front of what matters')}</h2>
    <div class="promises">${items}</div></div></section>`;
}

function renderShot(s) {
  const dark = s.dark ? ' dark' : '';
  const cap = s.caption ? `<div class="shotcap">${esc(s.caption)}</div>` : '';
  if (s.dataUri) return `<div class="shot${dark}"><img src="${s.dataUri}" alt="${esc(s.caption || '')}"></div>${cap}`;
  return `<div class="shot empty${dark}"><div class="ph">${glyph(s.dark ? '#6f8ba2' : '#9aa7b3')}<div style="margin-top:10px">${esc(s.caption || 'capture pending')}</div></div></div>${cap}`;
}

function renderStandards(standards) {
  if (!standards || !standards.length) return '';
  const rows = standards.map((s) => `<li><div class="code">${esc(s.code)}<em>${esc(s.clause)}</em></div><div class="demand">${s.demand}</div></li>`).join('');
  return `<div class="std"><div class="std-h">${glyph('#ffb43d')} Bailey is best practice — what the standards ask of you, and how this does it</div><ul>${rows}</ul></div>`;
}

// Stable anchor ids so the TOC's target-counter() can resolve each page number.
const chapterAnchor = (ch, idx) => `ch-${ch.num || String(idx + 1).padStart(2, '0')}`;
const guideAnchor = (g, i) => `guide-${i}`;

function renderToc(m) {
  const rows = [];
  rows.push(
    `<li class="toc-row"><a href="#manifesto"><span class="toc-num">·</span><span class="toc-title">Why teams put Bitswan in front of what matters</span><span class="toc-dots"></span></a><a class="toc-pg" href="#manifesto"></a></li>`,
  );
  rows.push(`<li class="toc-row group"><span class="toc-title">The walkthrough</span></li>`);
  (m.chapters || []).forEach((ch, idx) => {
    const a = chapterAnchor(ch, idx);
    rows.push(
      `<li class="toc-row"><a href="#${a}"><span class="toc-num">CH ${esc(ch.num || String(idx + 1).padStart(2, '0'))}</span><span class="toc-title">${esc(ch.title)}</span> <span class="toc-sub">— ${esc(ch.eyebrow || '')}</span><span class="toc-dots"></span></a><a class="toc-pg" href="#${a}"></a></li>`,
    );
  });
  rows.push(`<li class="toc-row group"><span class="toc-title">Compliance reference</span></li>`);
  rows.push(
    `<li class="toc-row"><a href="#matrix"><span class="toc-num">REF</span><span class="toc-title">Standards → features</span><span class="toc-dots"></span></a><a class="toc-pg" href="#matrix"></a></li>`,
  );
  rows.push(
    `<li class="toc-row"><a href="#glance"><span class="toc-num">REF</span><span class="toc-title">What Bailey gives you — at a glance</span><span class="toc-dots"></span></a><a class="toc-pg" href="#glance"></a></li>`,
  );
  (m.controlGuides || []).forEach((g, i) => {
    const a = guideAnchor(g, i);
    rows.push(
      `<li class="toc-row"><a href="#${a}"><span class="toc-num">REF</span><span class="toc-title">${esc(g.standard)}</span><span class="toc-dots"></span></a><a class="toc-pg" href="#${a}"></a></li>`,
    );
  });
  return `<section class="page toc"><div class="pad">
    <div class="toc-h">Contents</div>
    <h2>The Operator's Handbook</h2>
    <ol>${rows.join('')}</ol>
    <div class="runfoot"><span class="brand">${glyph('var(--ink)')}Bitswan Bailey · The Operator's Handbook</span><span>Contents</span></div>
  </div></section>`;
}

function renderChapter(ch, idx) {
  const num = ch.num || String(idx + 1).padStart(2, '0');
  const shots = (ch.shots || []).map(renderShot);
  const leadShot = shots.shift() || '';
  const sell = (ch.sell || []).map((p) => `<p>${p}</p>`).join('');
  const steps = (ch.steps || []).map((t, i) => `<div class="step"><div class="s">${i + 1}</div><div class="t">${t}</div></div>`).join('');
  const howto = steps ? `<div class="howto"><h4>${esc(ch.howtoTitle || 'How to')}</h4>${steps}</div>` : '';
  const two = (sell || howto) ? `<div class="two"><div class="selltext">${sell}</div>${howto}</div>` : '';
  const callout = ch.callout ? `<div class="callout"><span class="c-k">${esc(ch.callout.kind || 'Why it matters')}</span><p>${ch.callout.text}</p></div>` : '';
  const specs = (ch.specs && ch.specs.length) ? `<div class="specs">${ch.specs.map((s) => `<div class="spec"><div class="v">${s.v}</div><div class="l">${esc(s.l)}</div></div>`).join('')}</div>` : '';
  const extraShots = shots.join('');
  return `<section class="page chapter" id="${chapterAnchor(ch, idx)}"><div class="pad">
    <div class="chapter-head"><span class="chapter-num">CH ${esc(num)}</span><span class="chapter-eyebrow">${esc(ch.eyebrow || '')}</span></div>
    <h2>${esc(ch.title)}</h2>
    ${ch.lede ? `<p class="lede">${esc(ch.lede)}</p>` : ''}
    ${leadShot}
    ${two}
    ${callout}
    ${specs}
    ${extraShots}
    ${renderStandards(ch.standards)}
    <div class="runfoot"><span class="brand">${glyph('var(--ink)')}Bitswan Bailey · The Operator's Handbook</span><span>${esc(ch.title)} — ${esc(num)}</span></div>
  </div></section>`;
}

function renderMatrix(m) {
  const all = [];
  (m.chapters || []).forEach((ch) => (ch.standards || []).forEach((s) => all.push({ ...s, feature: ch.title })));
  if (!all.length) return '';
  const rows = all.map((s) => `<tr><td><b>${esc(s.code)}</b><br><span style="color:var(--amber);font-size:12px">${esc(s.clause)}</span></td><td>${s.demand}</td><td><b>${esc(s.feature)}</b></td></tr>`).join('');
  return `<section class="page matrix" id="matrix"><div class="pad">
    <div class="chapter-head"><span class="chapter-num">REF</span><span class="chapter-eyebrow">Compliance at a glance</span></div>
    <h2 style="font-size:40px;letter-spacing:-.025em;margin:8px 0 0;color:var(--ink)">Standards → features</h2>
    <p class="lede">One page for your auditor: the controls ISO 27001, SOC 2, DORA, NIS2 and GDPR ask for, and the Bitswan feature that delivers each.</p>
    <table><thead><tr><th>Standard &amp; clause</th><th>What it asks of you</th><th>Delivered by</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="runfoot"><span class="brand">${glyph('var(--ink)')}Bitswan Bailey · The Operator's Handbook</span><span>Bailey is best practice</span></div>
  </div></section>`;
}

const COV = {
  provided: ['✓', 'Provided'],
  partial: ['◑', 'Partial'],
  yours: ['○', 'Your part'],
};
const covPill = (s) => `<span class="cov ${s}">${(COV[s] || COV.yours)[0]} ${(COV[s] || COV.yours)[1]}</span>`;

function renderAtAGlance(m) {
  const guides = m.controlGuides || [];
  if (!guides.length) return '';
  const cards = guides.map((g) => {
    const n = (st) => (g.rows || []).filter((r) => r.status === st).length;
    return `<div class="scorecard">
      <div class="sname">${esc(g.standard)}</div>
      <div class="sn" style="color:#15803d"><b>${n('provided')}</b><span>Provided</span></div>
      <div class="sn" style="color:#b45309"><b>${n('partial')}</b><span>Partial</span></div>
      <div class="sn" style="color:#475569"><b>${n('yours')}</b><span>Your part</span></div>
    </div>`;
  }).join('');
  return `<section class="page guide" id="glance"><div class="pad">
    <div class="ghead">Technical-controls guide</div>
    <h2>What Bailey gives you — at a glance</h2>
    <p class="gblurb">For each standard, how many technical controls Bailey provides outright, supports in part, or leaves to you to operate. The pages that follow break each down control-by-control, with a pointer to the chapter that shows it working.</p>
    <div class="scorecards">${cards}</div>
    <div class="legend">${covPill('provided')} delivered by the platform &nbsp; ${covPill('partial')} platform supports it; you complete it &nbsp; ${covPill('yours')} your organization operates it</div>
    <div class="runfoot"><span class="brand">${glyph('var(--ink)')}Bitswan Bailey · The Operator's Handbook</span><span>Controls · at a glance</span></div>
  </div></section>`;
}

function renderGuide(g, i) {
  const rows = (g.rows || []).map((r) => `<tr>
    <td class="ctl">${esc(r.control)}</td>
    <td>${esc(r.req)}</td>
    <td>${covPill(r.status)}</td>
    <td>${r.status === 'yours' ? '<span style="color:var(--muted)">—</span>' : esc(r.bailey)}</td>
    <td>${r.yours && r.yours !== '—' ? esc(r.yours) : '<span style="color:var(--muted)">—</span>'}</td>
    <td class="ch">${r.ch ? esc(r.ch) : '—'}</td>
  </tr>`).join('');
  return `<section class="page guide" id="${guideAnchor(g, i)}"><div class="pad">
    <div class="ghead">Technical-controls guide</div>
    <h2>${esc(g.standard)}</h2>
    <p class="gblurb">${esc(g.blurb || '')}</p>
    <table>
      <thead><tr><th>Control</th><th>What it requires</th><th>Status</th><th>Bailey gives you</th><th>Your part</th><th>Ch.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="runfoot"><span class="brand">${glyph('var(--ink)')}Bitswan Bailey · The Operator's Handbook</span><span>${esc(g.standard)}</span></div>
  </div></section>`;
}

/** Build the full handbook HTML from a manifest whose shots already carry dataUri. */
export function renderHandbook(m) {
  const chapters = (m.chapters || []).map(renderChapter).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title || "Bitswan — The Operator's Handbook")}</title>
<style>${CSS}</style></head><body>
${renderCover(m)}
${renderToc(m)}
${renderManifesto(m)}
${chapters}
${renderMatrix(m)}
${renderAtAGlance(m)}
${(m.controlGuides || []).map(renderGuide).join('\n')}
</body></html>`;
}
