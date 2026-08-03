package daemon

import (
	"fmt"
	"html"
)

// Google-Docs-style share dialog. Lives in the chrome-wrap layer (the
// outer page, not inside the iframe) so the overlay covers the
// upstream service. Opens via window.__baileyShareOpen from the wrap
// footer's Share button; closes via the X / Done / clicking the
// backdrop / Escape.
//
// Reads and writes grants through the JSON API at
// /2fa-gate/api/share/<host>, so the dialog works without page
// reloads. The standalone share page (acl_share.go) reuses this exact
// component, pre-opened.
//
// The dialog shows BOTH halves of who can open the endpoint (#251): a
// boxed, clearly-labelled "workspace · inherited" row, expandable to the
// actual member list, and below it the people granted on this endpoint
// alone. It used to show only the latter, so an endpoint reachable by a
// whole workspace read as "1 person, no additional people yet". The
// inherited row is informational — that access is administered in the
// workspace, not here. The add field is free text (any email or
// /group/path) with a click-to-pick list of the server's people underneath
// it, mirroring the workspace sidebar's "Add a member".

const shareModalCSS = `
  /* shadcn/ui-inspired: neutral zinc palette, near-black primary, hairline
     borders, calm muted avatars, subtle focus rings and soft shadows. */
  :root {
    --bl-bg: #ffffff; --bl-fg: #09090b; --bl-muted: #f4f4f5; --bl-muted-fg: #71717a;
    --bl-border: #e4e4e7; --bl-ring: rgba(9,9,11,0.14);
    --bl-primary: #18181b; --bl-primary-fg: #fafafa;
    --bl-destructive: #dc2626; --bl-destructive-soft: #fef2f2;
  }
  .bailey-share-backdrop {
    position: fixed; inset: 0; background: rgba(9,9,11,0.5); backdrop-filter: blur(2px);
    display: none; align-items: center; justify-content: center; padding: 16px;
    z-index: 2147483646;
    font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--bl-fg); -webkit-font-smoothing: antialiased;
  }
  .bailey-share-backdrop.open { display: flex; }
  .bailey-share-card {
    background: var(--bl-bg); border: 1px solid var(--bl-border); border-radius: 12px;
    box-shadow: 0 12px 32px -10px rgba(9,9,11,0.28), 0 2px 6px -2px rgba(9,9,11,0.08);
    width: min(512px, 100%); max-height: 88vh; overflow: hidden;
    display: flex; flex-direction: column;
  }
  .bailey-share-header { padding: 20px 24px 14px; display: flex; align-items: flex-start; gap: 12px; }
  .bailey-share-header h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .bailey-share-header .sub { margin: 4px 0 0; color: var(--bl-muted-fg); font-size: 13px; }
  .bailey-share-header .close {
    margin-left: auto; background: none; border: 0; cursor: pointer;
    width: 28px; height: 28px; border-radius: 6px; color: var(--bl-muted-fg);
    display: flex; align-items: center; justify-content: center; transition: background .12s, color .12s;
  }
  .bailey-share-header .close:hover { background: var(--bl-muted); color: var(--bl-fg); }

  .bailey-share-add { padding: 4px 24px 16px; display: flex; gap: 8px; align-items: center; }
  .bailey-share-add input {
    flex: 1; height: 36px; padding: 0 12px; border: 1px solid var(--bl-border); border-radius: 8px;
    font: inherit; font-size: 13px; color: var(--bl-fg); background: var(--bl-bg); outline: none;
    transition: box-shadow .12s, border-color .12s;
  }
  .bailey-share-add input::placeholder { color: var(--bl-muted-fg); }
  .bailey-share-add input:focus { border-color: #a1a1aa; box-shadow: 0 0 0 3px var(--bl-ring); }
  .bailey-share-add select {
    height: 36px; padding: 0 10px; border: 1px solid var(--bl-border); border-radius: 8px;
    background: var(--bl-bg); font: inherit; font-size: 13px; color: var(--bl-fg); cursor: pointer; outline: none;
  }
  .bailey-share-add select:focus { border-color: #a1a1aa; box-shadow: 0 0 0 3px var(--bl-ring); }
  .bailey-share-add button {
    height: 36px; padding: 0 14px; border: 0; border-radius: 8px;
    background: var(--bl-primary); color: var(--bl-primary-fg); font: inherit; font-size: 13px; font-weight: 500;
    cursor: pointer; transition: opacity .12s;
  }
  .bailey-share-add button:hover { opacity: .9; }
  .bailey-share-add button:disabled { opacity: .5; cursor: not-allowed; }

  .bailey-share-section-title {
    padding: 4px 24px 6px; font-size: 11px; font-weight: 600; color: var(--bl-muted-fg);
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .bailey-share-list { padding: 0 12px 6px; overflow-y: auto; }
  .bailey-share-row { padding: 8px 12px; display: flex; align-items: center; gap: 12px; border-radius: 8px; transition: background .12s; }
  .bailey-share-row:hover { background: var(--bl-muted); }
  .bailey-share-avatar {
    width: 32px; height: 32px; border-radius: 999px; background: var(--bl-muted); color: #52525b;
    display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex-shrink: 0;
    border: 1px solid var(--bl-border);
  }
  .bailey-share-avatar.group { background: #fafafa; }
  /* .person is set wherever the JS overrides the background with a hash of the
     display name (avatarColor): saturated fill needs light text and no border. */
  .bailey-share-avatar.person { color: #fff; border-color: transparent; }
  .bailey-share-meta { flex: 1; min-width: 0; }
  .bailey-share-meta .name { font-size: 13px; font-weight: 500; color: var(--bl-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bailey-share-meta .sub { font-size: 12px; color: var(--bl-muted-fg); }
  .bailey-share-role { font-size: 12px; padding: 3px 10px; border-radius: 6px; background: var(--bl-muted); color: #52525b; flex-shrink: 0; border: 1px solid var(--bl-border); }
  .bailey-share-role.owner { background: var(--bl-muted); color: var(--bl-fg); }
  .bailey-share-role-dropdown {
    height: 30px; padding: 0 8px; border: 1px solid var(--bl-border); border-radius: 6px;
    background: var(--bl-bg); font: inherit; font-size: 12px; color: var(--bl-fg); cursor: pointer; outline: none;
  }
  .bailey-share-role-dropdown:focus { border-color: #a1a1aa; box-shadow: 0 0 0 3px var(--bl-ring); }
  .bailey-share-remove {
    background: none; border: 0; color: var(--bl-muted-fg); cursor: pointer; font: inherit;
    font-size: 12px; font-weight: 500; padding: 5px 8px; border-radius: 6px; transition: background .12s, color .12s;
  }
  .bailey-share-remove:hover { background: var(--bl-destructive-soft); color: var(--bl-destructive); }

  .bailey-share-footer {
    padding: 14px 24px; border-top: 1px solid var(--bl-border);
    display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 4px;
  }
  .bailey-share-footer > span { font-size: 12px; color: var(--bl-muted-fg); }
  .bailey-share-footer button {
    height: 36px; padding: 0 16px; border: 0; border-radius: 8px;
    background: var(--bl-primary); color: var(--bl-primary-fg); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity .12s;
  }
  .bailey-share-footer button:hover { opacity: .9; }
  .bailey-share-error { padding: 0 24px 8px; color: var(--bl-destructive); font-size: 13px; display: none; }
  .bailey-share-error.shown { display: block; }
  .bailey-share-empty { padding: 8px 24px 12px; color: var(--bl-muted-fg); font-size: 13px; }

  /* --- Inherited workspace access (#251) --------------------------------
     Workspace members can already open what their workspace deploys; this
     row says so. Boxed so it reads as a statement about the workspace rather
     than as one more individually-granted person. It is informational:
     membership is managed in the workspace, not here. Uses the shadcn tokens
     above — no accent colour of its own. */
  .bailey-share-inherited {
    margin: 2px 12px 10px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--bl-border); background: var(--bl-muted);
  }
  .bailey-share-inherited-head { display: flex; align-items: center; gap: 12px; }
  .bailey-share-count {
    font: inherit; font-size: 11px; font-weight: 500; padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--bl-border); background: var(--bl-bg); color: var(--bl-muted-fg);
    flex-shrink: 0; cursor: pointer; white-space: nowrap; transition: color .12s, border-color .12s;
  }
  .bailey-share-count:hover { color: var(--bl-fg); border-color: #a1a1aa; }
  .bailey-share-count:focus-visible { outline: 0; box-shadow: 0 0 0 3px var(--bl-ring); }
  .bailey-share-members {
    display: none; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--bl-border);
  }
  .bailey-share-members.open { display: block; }
  .bailey-share-member {
    display: flex; align-items: center; gap: 10px; padding: 4px 0; min-width: 0;
  }
  /* .dot defaults to the same calm avatar the rows above use; personChip()
     overrides the background with a hash of the display name, matching the
     console's Avatar, so people stay individually recognisable. Groups keep
     the default — a group is not a person. */
  .bailey-share-member .dot {
    width: 28px; height: 28px; border-radius: 999px; flex-shrink: 0;
    background: var(--bl-bg); color: #52525b; border: 1px solid var(--bl-border);
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 600; letter-spacing: 0.2px;
  }
  .bailey-share-member .dot.person { color: #fff; border-color: transparent; }
  .bailey-share-member .who { min-width: 0; }
  .bailey-share-member .who .line {
    font-size: 13px; font-weight: 500; color: var(--bl-fg);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bailey-share-member .who .mail {
    font-size: 11.5px; color: var(--bl-muted-fg); font-family: ui-monospace, 'Geist Mono', monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bailey-share-members .note { font-size: 12px; color: var(--bl-muted-fg); padding-top: 8px; }
  .bailey-share-subhead {
    padding: 6px 12px 2px; font-size: 11px; font-weight: 600;
    letter-spacing: 0.05em; text-transform: uppercase; color: var(--bl-muted-fg);
  }

  /* --- People picker (#251) ---------------------------------------------
     Click-to-pick over the server's people directory, mirroring the
     workspace sidebar's "Add a member" list. The free-text field above
     still accepts any email or /group/path. */
  .bailey-share-picker {
    display: none; margin: 0 24px 14px; border: 1px solid var(--bl-border);
    border-radius: 8px; max-height: 168px; overflow-y: auto;
  }
  .bailey-share-picker.open { display: block; }
  .bailey-share-pick {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 8px 10px; text-align: left; font: inherit; color: var(--bl-fg);
    background: none; border: 0; border-bottom: 1px solid var(--bl-border); cursor: pointer;
    transition: background .12s;
  }
  .bailey-share-pick:last-child { border-bottom: 0; }
  .bailey-share-pick:hover { background: var(--bl-muted); }
  .bailey-share-pick .who { flex: 1; min-width: 0; }
  .bailey-share-pick .who .line {
    font-size: 13px; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bailey-share-pick .who .mail {
    font-size: 11px; color: var(--bl-muted-fg);
    font-family: ui-monospace, 'Geist Mono', monospace;
  }
  .bailey-share-pick .tag { font-size: 11px; color: var(--bl-muted-fg); flex-shrink: 0; }
  .bailey-share-picker .note { padding: 8px 10px; font-size: 12px; color: var(--bl-muted-fg); }

  /* Secondary sharing actions: understated text links on one row. */
  .bailey-extras {
    display: flex; align-items: center; flex-wrap: wrap; gap: 4px 16px;
    padding: 12px 24px; border-top: 1px solid var(--bl-border); margin-top: 4px;
  }
  .bailey-extras-label { font-size: 12px; color: var(--bl-muted-fg); margin-right: 2px; }
  .bailey-linkbtn {
    background: none; border: 0; padding: 0; cursor: pointer; font: inherit; font-size: 13px;
    color: var(--bl-fg); font-weight: 500; text-underline-offset: 3px;
  }
  .bailey-linkbtn:hover { text-decoration: underline; }
  .bailey-linkbtn.danger { color: var(--bl-destructive); }
  .bailey-pill { font-size: 11px; font-weight: 500; padding: 2px 9px; border-radius: 999px; border: 1px solid transparent; }
  .bailey-pill.on { background: #f0fdf4; color: #15803d; border-color: #bbf7d0; }
  .bailey-pill.off { background: var(--bl-muted); color: var(--bl-muted-fg); }
  .bailey-extras-detail { padding: 0 24px; }
  .bailey-magic-list-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 12px; color: #52525b; }
  .bailey-magic-list-row .g { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bailey-magic-linkbox { display: flex; gap: 8px; align-items: center; margin: 8px 0 12px; }
  .bailey-magic-linkbox input {
    flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--bl-border); border-radius: 8px;
    font: inherit; font-size: 12px; color: #3f3f46; background: var(--bl-muted); outline: none;
  }
  .bailey-magic-copy {
    height: 34px; padding: 0 12px; border: 1px solid var(--bl-border); border-radius: 8px;
    background: var(--bl-bg); font: inherit; font-size: 13px; font-weight: 500; color: var(--bl-fg); cursor: pointer; white-space: nowrap; transition: background .12s;
  }
  .bailey-magic-copy:hover { background: var(--bl-muted); }

  /* Confirm dialog */
  .bailey-magic-confirm {
    position: fixed; inset: 0; background: rgba(9,9,11,0.5); backdrop-filter: blur(2px); padding: 16px;
    display: none; align-items: center; justify-content: center; z-index: 2147483647;
    font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--bl-fg);
  }
  .bailey-magic-confirm.open { display: flex; }
  .bailey-magic-dialog {
    background: var(--bl-bg); border: 1px solid var(--bl-border); border-radius: 12px;
    box-shadow: 0 12px 32px -10px rgba(9,9,11,0.28); width: min(440px, 100%); padding: 24px;
  }
  .bailey-magic-dialog h3 { margin: 0 0 8px; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .bailey-magic-dialog p { margin: 0 0 12px; color: var(--bl-muted-fg); font-size: 13px; line-height: 1.5; }
  .bailey-magic-dialog input {
    width: 100%; box-sizing: border-box; height: 36px; padding: 0 12px; border: 1px solid var(--bl-border);
    border-radius: 8px; font: inherit; font-size: 13px; color: var(--bl-fg); outline: none;
  }
  .bailey-magic-dialog input:focus { border-color: #a1a1aa; box-shadow: 0 0 0 3px var(--bl-ring); }
  .bailey-magic-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .bailey-magic-cancel {
    height: 36px; padding: 0 16px; border: 1px solid var(--bl-border); border-radius: 8px;
    background: var(--bl-bg); color: var(--bl-fg); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; transition: background .12s;
  }
  .bailey-magic-cancel:hover { background: var(--bl-muted); }
  .bailey-magic-go {
    height: 36px; padding: 0 16px; border: 0; border-radius: 8px;
    background: var(--bl-primary); color: var(--bl-primary-fg); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity .12s;
  }
  .bailey-magic-go:hover { opacity: .9; }
  .bailey-magic-go:disabled { opacity: .5; cursor: not-allowed; }
`

// shareModalHTML returns the modal markup. Hidden by default
// (backdrop display:none); JS toggles .open.
func shareModalHTML() string {
	return `
<div id="bailey-share-modal" class="bailey-share-backdrop" onclick="if(event.target===this)window.__baileyShareClose()">
  <div class="bailey-share-card" role="dialog" aria-modal="true" aria-labelledby="bailey-share-title">
    <div class="bailey-share-header">
      <div>
        <h2 id="bailey-share-title">Share endpoint</h2>
        <p class="sub" id="bailey-share-sub">Only people you invite can open this endpoint.</p>
      </div>
      <button class="close" type="button" onclick="window.__baileyShareClose()" aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>

    <div class="bailey-share-add">
      <input id="bailey-share-input" type="text" placeholder="Add people, groups, or emails" autocomplete="off">
      <select id="bailey-share-role">
        <option value="access">User</option>
        <option value="owner">Owner</option>
      </select>
      <button type="button" id="bailey-share-add-btn" onclick="window.__baileyShareAdd()">Add</button>
    </div>

    <div class="bailey-share-picker" id="bailey-share-picker"></div>

    <div class="bailey-share-error" id="bailey-share-error"></div>

    <div class="bailey-share-section-title" id="bailey-share-requests-title" style="display:none;">Pending access requests</div>
    <div class="bailey-share-list" id="bailey-share-requests" style="display:none;"></div>

    <div class="bailey-share-section-title">People with access</div>
    <div id="bailey-share-workspace"></div>
    <div class="bailey-share-list" id="bailey-share-list">
      <p class="bailey-share-empty">Loading…</p>
    </div>

    <div id="bailey-extras" class="bailey-extras" style="display:none;">
      <span class="bailey-extras-label">More ways to share:</span>
      <button type="button" id="bailey-magic-create" class="bailey-linkbtn" onclick="window.__baileyMagicConfirm()">Create magic link</button>
      <button type="button" id="bailey-public-make" class="bailey-linkbtn" onclick="window.__baileyPublicConfirm()">Make public</button>
      <span id="bailey-public-pill" class="bailey-pill on" style="display:none;">Public</span>
      <button type="button" id="bailey-public-revoke" class="bailey-linkbtn danger" style="display:none;" onclick="window.__baileyPublicRevoke()">Make private</button>
    </div>
    <div class="bailey-extras-detail">
      <div id="bailey-magic-list"></div>
      <div id="bailey-magic-new" class="bailey-magic-linkbox" style="display:none;"></div>
      <div id="bailey-public-new" class="bailey-magic-linkbox" style="display:none;"></div>
    </div>

    <div class="bailey-share-footer">
      <span style="font-size:12px;color:#71717A;">Changes save instantly.</span>
      <button type="button" onclick="window.__baileyShareClose()">Done</button>
    </div>
  </div>
</div>
<div id="bailey-magic-confirm" class="bailey-magic-confirm" onclick="if(event.target===this)window.__baileyMagicCancel()">
  <div class="bailey-magic-dialog" role="dialog" aria-modal="true" aria-labelledby="bailey-magic-confirm-title">
    <h3 id="bailey-magic-confirm-title">Create a magic link?</h3>
    <p>Anyone who opens this link and signs in gets their browser device-trusted for <b>this endpoint only</b>. Use it only for low-sensitivity production endpoints — the access list still applies, so a magic link does not grant access on its own.</p>
    <div class="bailey-magic-dialog-actions">
      <button type="button" class="bailey-magic-cancel" onclick="window.__baileyMagicCancel()">Cancel</button>
      <button type="button" class="bailey-magic-go" onclick="window.__baileyMagicCreate()">Create link</button>
    </div>
  </div>
</div>
<div id="bailey-public-confirm" class="bailey-magic-confirm" onclick="if(event.target===this)window.__baileyPublicCancel()">
  <div class="bailey-magic-dialog" role="dialog" aria-modal="true" aria-labelledby="bailey-public-confirm-title">
    <h3 id="bailey-public-confirm-title">Make this endpoint public?</h3>
    <p>This publishes <b id="bailey-public-confirm-host"></b> at a <b>public URL served with no Bailey login</b>. Anyone on the internet can reach it, and the app will see every visitor as <code>anon@example.com</code>. The endpoint keeps its normal protected URL — this only adds a public one. Only do this for a production frontend that is meant to be public.</p>
    <p style="margin-bottom:6px;">Type the endpoint hostname to confirm:</p>
    <input type="text" id="bailey-public-confirm-input" autocomplete="off" autocapitalize="off" spellcheck="false" oninput="window.__baileyPublicCheck()">
    <div class="bailey-magic-dialog-actions">
      <button type="button" class="bailey-magic-cancel" onclick="window.__baileyPublicCancel()">Cancel</button>
      <button type="button" class="bailey-magic-go" id="bailey-public-go" disabled onclick="window.__baileyPublicCreate()">Make public</button>
    </div>
  </div>
</div>`
}

// shareModalJS returns the dialog's JS, wired to the share API URL for
// the given endpoint. The JS opens/closes the modal, fetches the grant
// list on open, posts new grants, and DELETEs revoked ones — all
// without leaving the page.
func shareModalJS(host, callerEmail, apiURL string) string {
	return fmt.Sprintf(`(function(){
  var apiURL = %q;
  var callerEmail = %q;
  var hostLabel = %q;
  // People directory for the picker — the same endpoint the server console's
  // "Add a member" list uses, routed under the gate prefix so it is reachable
  // from an app host. Loaded lazily on first open; a failure degrades to
  // free-text entry only.
  var directoryURL = %q;
  var directory = null;      // null = not loaded, [] = loaded/failed-empty
  var directoryFailed = false;
  var lastData = null;       // most recent listing, for the picker's filter
  var membersOpen = false;   // is the inherited members list expanded?

  function $(id) { return document.getElementById(id); }
  function el(tag, props, children) {
    var n = document.createElement(tag);
    for (var k in (props||{})) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k === 'onclick') n.onclick = props[k];
      else if (k === 'value') n.value = props[k];
      else n.setAttribute(k, props[k]);
    }
    (children||[]).forEach(function(c) { if (c) n.appendChild(c); });
    return n;
  }
  // avatarColor / initialsFor are ported verbatim from the server console's
  // Avatar (console-ui.jsx), so a person's chip looks the same here as in the
  // workspace member list: a filled circle in a colour hashed from their
  // display name, with up to two initials.
  //
  // The console additionally loads a real photo from the AOC and a real display
  // name from its identity directory. Neither is reachable from this dialog:
  // the chrome wrap's CSP is img-src 'self' data: <inner host> and connect-src
  // 'self', so a cross-origin avatar/name fetch is blocked — and widening a
  // security header on every protected page for a nicer avatar is not a trade
  // worth making. Initials + the name Bailey knows is the honest rendering.
  function avatarColor(s) {
    var h = 0;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'hsl(' + (h %% 360) + ' 52%% 45%%)';
  }
  function initialsFor(s) {
    // Split on spaces AND email/handle separators, so "jane@acme.com" → "JA".
    // Character class and fallback match console-ui.jsx exactly — a different
    // split would give the same person different initials in the two UIs.
    var name = String(s || '');
    var parts = name.split(/[\s@._-]+/).filter(Boolean);
    var out = parts.map(function(w) { return w[0]; }).slice(0, 2).join('').toUpperCase();
    return out || (name[0] || '?').toUpperCase();
  }
  // personChip builds the avatar + name/email pair used for every human in
  // this dialog. displayName falls back to the email, and the mono email line
  // is dropped when it would just repeat the name (same rule as UserChip).
  function personChip(email, name) {
    var display = name || email;
    var dot = el('div', {class:'dot person', text: initialsFor(display)});
    dot.style.background = avatarColor(display);
    var lines = [el('div', {class:'line', text: display +
      (String(email).toLowerCase() === callerEmail.toLowerCase() ? ' (you)' : '')})];
    if (display !== email) lines.push(el('div', {class:'mail', text: email, title: email}));
    return [dot, el('div', {class:'who'}, lines)];
  }
  // nameFor looks a person's display name up in the people directory the picker
  // already loaded. Returns '' when unknown (directory still loading, failed,
  // or the person isn't on this server) — callers then show the bare email.
  function nameFor(email) {
    if (!directory || !email) return '';
    var key = String(email).toLowerCase();
    for (var i = 0; i < directory.length; i++) {
      if (String(directory[i].email).toLowerCase() === key) return directory[i].name || '';
    }
    return '';
  }
  function showError(msg) {
    var e = $('bailey-share-error');
    if (msg) { e.textContent = msg; e.classList.add('shown'); }
    else     { e.textContent = ''; e.classList.remove('shown'); }
  }
  // Extract a clean human message from an error response — the JSON {error}
  // field, or a short plain-text body, but NEVER a raw HTML page.
  function readErr(r) {
    return r.text().then(function(t){
      try { var j = JSON.parse(t); return j.error || j.detail || ('HTTP ' + r.status); }
      catch (e) {
        t = String(t || '').trim();
        if (t && t.length < 200 && t.charAt(0) !== '<') return t;
        return 'HTTP ' + r.status;
      }
    });
  }
  function render(data) {
    showError('');
    lastData = data;
    $('bailey-share-title').textContent = 'Share "' + hostLabel + '"';
    // Inherited workspace access goes ABOVE the individual rows, in its own
    // box — it is a different kind of thing from a person you added.
    renderWorkspace(data.workspace);
    var list = $('bailey-share-list');
    list.innerHTML = '';
    var ownerEmail = (data.owner_email || '').toLowerCase();
    // With an inherited workspace row above, label what follows so the two
    // halves of the union ACL can't be read as one flat list.
    if (data.workspace) {
      list.appendChild(el('div', {class:'bailey-share-subhead', text:'Added to this endpoint'}));
    }
    // Owner is a role, not a fixed property: the recorded owner_email is shown
    // first and is editable exactly like any grant (promote/demote/remove).
    // The backend refuses to remove the last owner.
    if (data.owner_email) {
      list.appendChild(rowFor({principal_type:'email', principal_value:data.owner_email, role:'owner'}));
    }
    // Skip a grant that merely duplicates the recorded owner — one owner row.
    (data.grants||[]).forEach(function(g) {
      if (g.principal_type === 'email' && g.role === 'owner' &&
          g.principal_value.toLowerCase() === ownerEmail) return;
      list.appendChild(rowFor(g));
    });
    if ((data.grants||[]).length === 0) {
      var p = document.createElement('p');
      p.className = 'bailey-share-empty';
      p.textContent = data.workspace
        ? 'No additional people yet — beyond the workspace above.'
        : 'No additional people or groups yet.';
      list.appendChild(p);
    }
    renderPicker();
    // Pending requests: people who hit the endpoint without a grant
    // and clicked "Request access" on the denied page. Rendered above
    // the access list with Approve / Deny buttons.
    var requests = data.requests || [];
    var reqBox = $('bailey-share-requests');
    var reqTitle = $('bailey-share-requests-title');
    reqBox.innerHTML = '';
    if (requests.length) {
      requests.forEach(function(r) { reqBox.appendChild(requestRowFor(r)); });
      reqBox.style.display = '';
      reqTitle.style.display = '';
    } else {
      reqBox.style.display = 'none';
      reqTitle.style.display = 'none';
    }
    renderMagic(data);
    renderPublic(data);
  }
  var magicCreateURL = '/2fa-gate/api/magic-link/create';
  var magicRevokeURL = '/2fa-gate/api/magic-link/revoke';
  var publicCreateURL = '/2fa-gate/api/public/create';
  var publicRevokeURL = '/2fa-gate/api/public/revoke';
  function updateExtras(data) {
    var any = data.can_mint_magic_link || data.can_make_public || data.is_public;
    $('bailey-extras').style.display = any ? '' : 'none';
  }
  function renderPublic(data) {
    var pill = $('bailey-public-pill');
    var makeBtn = $('bailey-public-make');
    var revokeBtn = $('bailey-public-revoke');
    var box = $('bailey-public-new');
    if (data.is_public && data.public_url) {
      pill.style.display = '';
      makeBtn.style.display = 'none';
      revokeBtn.style.display = data.can_make_public ? '' : 'none';
      box.style.display = ''; box.innerHTML = '';
      var inp = el('input', {type:'text', value:data.public_url, readonly:'readonly'});
      inp.onclick = function(){ inp.select(); };
      var copy = el('button', {class:'bailey-magic-copy', type:'button', text:'Copy', onclick:function(){ inp.select(); try{document.execCommand('copy');}catch(e){} copy.textContent='Copied'; }});
      box.appendChild(inp); box.appendChild(copy);
    } else {
      pill.style.display = 'none';
      makeBtn.style.display = data.can_make_public ? '' : 'none';
      revokeBtn.style.display = 'none';
      box.style.display = 'none'; box.innerHTML = '';
    }
    updateExtras(data);
  }
  function renderMagic(data) {
    $('bailey-magic-create').style.display = data.can_mint_magic_link ? '' : 'none';
    var list = $('bailey-magic-list');
    list.innerHTML = '';
    if (data.can_mint_magic_link) {
      (data.magic_links || []).forEach(function(m){
        var g = el('div', {class:'g', text:'Magic link · expires ' + String(m.expires_at||'').slice(0,10)});
        var rm = el('button', {class:'bailey-share-remove', text:'Revoke', onclick:function(){ revokeMagic(m.id); }});
        list.appendChild(el('div', {class:'bailey-magic-list-row'}, [g, rm]));
      });
    }
    updateExtras(data);
  }
  function revokeMagic(id) {
    showError('');
    fetch(magicRevokeURL, {method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:id})})
      .then(function(r){ if(!r.ok) return readErr(r).then(function(m){throw new Error(m);}); return r.json(); })
      .then(load).catch(function(e){ showError('Failed to revoke link: '+e); });
  }
  // --- Inherited workspace access (#251) ---

  // peopleLabel describes the size of the inherited set, groups included.
  // Groups can't be expanded to individuals without querying Keycloak, so
  // they are counted separately rather than folded into the head count.
  function peopleLabel(n, groups) {
    var parts = [];
    if (n) parts.push(n + (n === 1 ? ' person' : ' people'));
    if (groups) parts.push(groups + (groups === 1 ? ' group' : ' groups'));
    if (!parts.length) return 'no members yet';
    return parts.join(' + ');
  }

  function renderWorkspace(ws) {
    var box = $('bailey-share-workspace');
    box.innerHTML = '';
    var sub = $('bailey-share-sub');
    if (!ws) {
      // Endpoint isn't part of a workspace — there is nothing inherited.
      sub.textContent = 'Only people you invite can open this endpoint.';
      return;
    }
    var members = ws.members || [];
    var groups  = ws.groups  || [];
    sub.textContent = 'Everyone in the ' + ws.label +
      ' workspace can open this endpoint, plus anyone added below.';

    var avatar = el('div', {class:'bailey-share-avatar group', text:'WS'});
    var meta = el('div', {class:'bailey-share-meta'}, [
      el('div', {class:'name', text: 'Members of ' + ws.label + ' have access'}),
      el('div', {class:'sub',  text: 'workspace · inherited from ' + ws.endpoint})
    ]);
    var panel = el('div', {class:'bailey-share-members' + (membersOpen ? ' open' : '')});
    var countBtn = el('button', {
      type:'button',
      class:'bailey-share-count',
      text: peopleLabel(members.length, groups.length),
      title:'Show who that is',
      onclick: function() {
        membersOpen = !membersOpen;
        if (membersOpen) panel.classList.add('open'); else panel.classList.remove('open');
      }
    });

    // Enumerate the inherited set — the whole point of this row is that an
    // admin can see exactly WHO "workspace members" means.
    members.forEach(function(m) {
      panel.appendChild(el('div', {class:'bailey-share-member'}, personChip(m, nameFor(m))));
    });
    groups.forEach(function(gp) {
      // A group is not a person — keep the neutral marker, no hashed colour.
      panel.appendChild(el('div', {class:'bailey-share-member'}, [
        el('div', {class:'dot', text:'##'}),
        el('div', {class:'who'}, [
          el('div', {class:'line', text: gp}),
          el('div', {class:'mail', text:'Keycloak group'})
        ])
      ]));
    });
    if (!members.length && !groups.length) {
      panel.appendChild(el('div', {class:'note', text:'This workspace has no members recorded yet.'}));
    }
    // Say where this access is administered, since it can't be edited here.
    panel.appendChild(el('div', {class:'note',
      text:'Managed in the workspace, not here — removing someone from the workspace removes this access.'}));

    var head = el('div', {class:'bailey-share-inherited-head'}, [avatar, meta, countBtn]);
    box.appendChild(el('div', {class:'bailey-share-inherited'}, [head, panel]));
  }

  // --- People picker (#251) ---

  function loadDirectory() {
    if (directory !== null) return Promise.resolve(directory);
    return fetch(directoryURL, {credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(d){ directory = (d && d.people) ? d.people : []; return directory; })
      .catch(function(){ directory = []; directoryFailed = true; return directory; });
  }

  // renderPicker draws the click-to-pick list: everyone on this server who
  // does not already have access here, narrowed by whatever is typed in the
  // add field. The field itself stays free-text — an email that isn't on the
  // server yet is still addable by typing it and pressing Add.
  function renderPicker() {
    var box = $('bailey-share-picker');
    box.innerHTML = '';
    if (directory === null) { box.classList.remove('open'); return; }
    if (directoryFailed) {
      box.appendChild(el('div', {class:'note',
        text:'Could not load the people list — type an email address instead.'}));
      box.classList.add('open');
      return;
    }
    var taken = {};
    if (lastData) {
      if (lastData.owner_email) taken[lastData.owner_email.toLowerCase()] = true;
      (lastData.grants || []).forEach(function(g) {
        if (g.principal_type === 'email') taken[(g.principal_value||'').toLowerCase()] = true;
      });
      // Workspace members already reach this endpoint, so offering to add
      // them again would be noise.
      if (lastData.workspace) {
        (lastData.workspace.members || []).forEach(function(m) { taken[m.toLowerCase()] = true; });
      }
    }
    var q = $('bailey-share-input').value.trim().toLowerCase();
    var matches = directory.filter(function(p) {
      if (!p.email || taken[p.email.toLowerCase()]) return false;
      if (!q) return true;
      return p.email.toLowerCase().indexOf(q) >= 0 ||
             (p.name || '').toLowerCase().indexOf(q) >= 0;
    });
    if (!matches.length) {
      box.classList.remove('open');
      return;
    }
    var shown = matches.slice(0, 8);
    shown.forEach(function(p) {
      var named = p.name && p.name !== p.email;
      var who = el('div', {class:'who'}, [
        el('div', {class:'line', text: named ? p.name : p.email}),
        named ? el('div', {class:'mail', text: p.email}) : null
      ]);
      var pickAvatar = el('div', {class:'bailey-share-avatar person', text: initialsFor(p.name || p.email)});
      pickAvatar.style.background = avatarColor(p.name || p.email);
      box.appendChild(el('button', {
        type:'button', class:'bailey-share-pick',
        title:'Add ' + p.email,
        onclick: function() { pick(p.email); }
      }, [
        pickAvatar,
        who,
        el('span', {class:'tag', text: p.invited ? 'Invited' : ''})
      ]));
    });
    if (matches.length > shown.length) {
      box.appendChild(el('div', {class:'note',
        text: (matches.length - shown.length) + ' more — keep typing to narrow the list.'}));
    }
    box.classList.add('open');
  }

  // redrawWithNames re-renders the parts whose labels come from the people
  // directory. No-op until the grant listing has arrived (render() draws them
  // from scratch anyway, with whatever the directory holds by then).
  function redrawWithNames() {
    if (lastData) render(lastData); else renderPicker();
  }

  function pick(email) {
    add('email', email, $('bailey-share-role').value).then(function() {
      $('bailey-share-input').value = '';
    });
  }

  function requestRowFor(req) {
    var display = nameFor(req.email) || req.email;
    var avatar = el('div', {class: 'bailey-share-avatar person', text: initialsFor(display)});
    avatar.style.background = avatarColor(display);
    var meta = el('div', {class:'bailey-share-meta'}, [
      el('div', {class:'name', text: display}),
      el('div', {class:'sub',  text: (display === req.email ? '' : req.email + ' · ') +
                                     'requested ' + (req.requested_at || '')})
    ]);
    var approve = el('button', {
      class:'bailey-share-remove',
      text:'Approve',
      onclick: function(){ approveRequest(req.email); }
    });
    // Same visual weight as Remove, recoloured so Approve reads as
    // positive, not destructive.
    approve.style.color = '#0a7d24';
    var deny = el('button', {
      class:'bailey-share-remove',
      text:'Deny',
      onclick: function(){ denyRequest(req.email); }
    });
    return el('div', {class:'bailey-share-row'}, [avatar, meta, approve, deny]);
  }
  function approveRequest(email) {
    add('email', email, 'access');
  }
  function denyRequest(email) {
    showError('');
    if (!confirm('Deny access request from ' + email + '? They\'ll need to request again.')) return;
    var body = new URLSearchParams();
    body.append('action', 'deny-request');
    body.append('email', email);
    fetch(apiURL, {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString()})
      .then(function(r){ if(!r.ok) return r.json().then(function(d){ throw new Error(d.error||'HTTP '+r.status); }); return r.json(); })
      .then(render)
      .catch(function(e){ showError('Could not deny: '+e.message); });
  }
  function rowFor(g) {
    var isGroup = g.principal_type === 'group';
    var isMe    = !isGroup && g.principal_value.toLowerCase() === callerEmail.toLowerCase();
    // Same identity chip as the inherited member list, so one dialog doesn't
    // render two different kinds of person.
    var display = (isGroup ? '' : nameFor(g.principal_value)) || g.principal_value;
    var avatar  = el('div', {class: 'bailey-share-avatar' + (isGroup ? ' group' : ' person'),
                             text: isGroup ? '##' : initialsFor(display)});
    if (!isGroup) avatar.style.background = avatarColor(display);
    var meta    = el('div', {class:'bailey-share-meta'}, [
      el('div', {class:'name', text: display + (isMe ? ' (you)' : '')}),
      el('div', {class:'sub',  text: isGroup ? 'Keycloak group'
                                            : (display === g.principal_value ? 'Email' : g.principal_value)})
    ]);
    var children = [avatar, meta];
    var sel = el('select', {class:'bailey-share-role-dropdown'}, [
      el('option', {value:'access', text:'User'}),
      el('option', {value:'owner',  text:'Owner'})
    ]);
    sel.value = g.role;
    sel.onchange = function(){ updateRole(g.principal_type, g.principal_value, g.role, sel.value); };
    var rm  = el('button', {class:'bailey-share-remove', text:'Remove', onclick:function(){ revoke(g.principal_type, g.principal_value, g.role); }});
    children.push(sel);
    children.push(rm);
    return el('div', {class:'bailey-share-row'}, children);
  }
  function load() {
    showError('');
    fetch(apiURL, {credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(render)
      .catch(function(e){ showError('Could not load grants: '+e); });
  }
  function add(pType, pVal, role) {
    showError('');
    var body = new URLSearchParams();
    body.append('principal_type', pType);
    body.append('principal_value', pVal);
    body.append('role', role);
    return fetch(apiURL, {method:'POST', credentials:'same-origin',
                          headers:{'Content-Type':'application/x-www-form-urlencoded'},
                          body: body.toString()})
      .then(function(r){ if(!r.ok) return readErr(r).then(function(m){throw new Error(m);}); return r.json(); })
      .then(render)
      .catch(function(e){ showError('Failed to add: '+e); });
  }
  function revoke(pType, pVal, role) {
    var body = new URLSearchParams();
    body.append('principal_type', pType);
    body.append('principal_value', pVal);
    body.append('role', role);
    fetch(apiURL, {method:'DELETE', credentials:'same-origin',
                   headers:{'Content-Type':'application/x-www-form-urlencoded'},
                   body: body.toString()})
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(render)
      .catch(function(e){ showError('Failed to remove: '+e); });
  }
  function updateRole(pType, pVal, oldRole, newRole) {
    if (oldRole === newRole) return;
    // Add new role then remove old role — the DB key includes role,
    // so both rows coexist until the revoke lands.
    add(pType, pVal, newRole).then(function(){ revoke(pType, pVal, oldRole); });
  }

  window.__baileyShareOpen = function() {
    $('bailey-share-modal').classList.add('open');
    load();
    // Picker data is independent of the grant listing, so fetch it in parallel.
    // It also supplies the display names for the member/grant chips, so redraw
    // those too once it lands — whichever request finishes second wins.
    loadDirectory().then(redrawWithNames);
    var inp = $('bailey-share-input');
    inp.oninput = renderPicker;
    setTimeout(function(){ inp.focus(); }, 30);
  };
  window.__baileyShareClose = function() {
    $('bailey-share-modal').classList.remove('open');
  };
  window.__baileyShareAdd = function() {
    var v = $('bailey-share-input').value.trim();
    var role = $('bailey-share-role').value;
    if (!v) return;
    // Heuristic: starts with / → Keycloak group path, otherwise email.
    var pType = (v[0] === '/') ? 'group' : 'email';
    add(pType, v, role).then(function(){
      $('bailey-share-input').value = '';
      renderPicker();
    });
  };
  window.__baileyMagicConfirm = function(){ $('bailey-magic-confirm').classList.add('open'); };
  window.__baileyMagicCancel = function(){ $('bailey-magic-confirm').classList.remove('open'); };
  window.__baileyMagicCreate = function() {
    $('bailey-magic-confirm').classList.remove('open');
    showError('');
    fetch(magicCreateURL, {method:'POST', credentials:'same-origin'})
      .then(function(r){ if(!r.ok) return readErr(r).then(function(m){throw new Error(m);}); return r.json(); })
      .then(function(res){
        var box = $('bailey-magic-new');
        box.style.display = ''; box.innerHTML = '';
        var inp = el('input', {type:'text', value:res.url, readonly:'readonly'});
        inp.onclick = function(){ inp.select(); };
        var copy = el('button', {class:'bailey-magic-copy', type:'button', text:'Copy link', onclick:function(){ inp.select(); try{document.execCommand('copy');}catch(e){} copy.textContent='Copied'; }});
        box.appendChild(inp);
        box.appendChild(copy);
        load();
      })
      .catch(function(e){ showError('Failed to create magic link: '+e); });
  };
  window.__baileyPublicConfirm = function(){
    $('bailey-public-confirm-host').textContent = hostLabel;
    var inp = $('bailey-public-confirm-input');
    inp.value = ''; inp.placeholder = hostLabel;
    $('bailey-public-go').disabled = true;
    $('bailey-public-confirm').classList.add('open');
    setTimeout(function(){ inp.focus(); }, 30);
  };
  window.__baileyPublicCancel = function(){ $('bailey-public-confirm').classList.remove('open'); };
  window.__baileyPublicCheck = function(){
    var v = $('bailey-public-confirm-input').value.trim().toLowerCase();
    $('bailey-public-go').disabled = (v !== String(hostLabel).toLowerCase());
  };
  window.__baileyPublicCreate = function(){
    if ($('bailey-public-confirm-input').value.trim().toLowerCase() !== String(hostLabel).toLowerCase()) return;
    $('bailey-public-confirm').classList.remove('open');
    showError('');
    fetch(publicCreateURL, {method:'POST', credentials:'same-origin'})
      .then(function(r){ if(!r.ok) return readErr(r).then(function(m){throw new Error(m);}); return r.json(); })
      .then(function(){ load(); })
      .catch(function(e){ showError('Failed to make public: '+e); });
  };
  window.__baileyPublicRevoke = function(){
    showError('');
    if (!confirm('Make ' + hostLabel + ' private again? Its public URL will stop working.')) return;
    fetch(publicRevokeURL, {method:'POST', credentials:'same-origin'})
      .then(function(r){ if(!r.ok) return readErr(r).then(function(m){throw new Error(m);}); return r.json(); })
      .then(function(){ load(); })
      .catch(function(e){ showError('Failed to make private: '+e); });
  };
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    if ($('bailey-public-confirm').classList.contains('open')) { window.__baileyPublicCancel(); return; }
    if ($('bailey-magic-confirm').classList.contains('open')) { window.__baileyMagicCancel(); return; }
    if ($('bailey-share-modal').classList.contains('open')) { window.__baileyShareClose(); }
  });
})();`, apiURL, callerEmail, html.UnescapeString(host), gatePathPrefix+"/api/people/directory")
}
