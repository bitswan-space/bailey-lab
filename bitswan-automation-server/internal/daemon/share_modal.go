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

    <div class="bailey-share-error" id="bailey-share-error"></div>

    <div class="bailey-share-section-title" id="bailey-share-requests-title" style="display:none;">Pending access requests</div>
    <div class="bailey-share-list" id="bailey-share-requests" style="display:none;"></div>

    <div class="bailey-share-section-title">People with access</div>
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
  function initials(s) {
    s = String(s || '').replace(/[^a-zA-Z0-9]/g,' ').trim();
    if (!s) return '?';
    var parts = s.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0]+parts[1][0]).toUpperCase();
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
    $('bailey-share-title').textContent = 'Share "' + hostLabel + '"';
    var list = $('bailey-share-list');
    list.innerHTML = '';
    var ownerEmail = (data.owner_email || '').toLowerCase();
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
      p.textContent = 'No additional people or groups yet.';
      list.appendChild(p);
    }
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
  function requestRowFor(req) {
    var avatar = el('div', {class: 'bailey-share-avatar', text: initials(req.email)});
    var meta = el('div', {class:'bailey-share-meta'}, [
      el('div', {class:'name', text: req.email}),
      el('div', {class:'sub',  text: 'Requested ' + (req.requested_at || '')})
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
    var avatar  = el('div', {class: 'bailey-share-avatar' + (isGroup ? ' group' : ''), text: isGroup ? '##' : initials(g.principal_value)});
    var meta    = el('div', {class:'bailey-share-meta'}, [
      el('div', {class:'name', text: g.principal_value + (isMe ? ' (you)' : '')}),
      el('div', {class:'sub',  text: isGroup ? 'Keycloak group' : 'Email'})
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
    setTimeout(function(){ $('bailey-share-input').focus(); }, 30);
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
    add(pType, v, role).then(function(){ $('bailey-share-input').value = ''; });
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
})();`, apiURL, callerEmail, html.UnescapeString(host))
}
