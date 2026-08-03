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
  /* Modal overlay — sits above the iframe, dimmed backdrop */
  .bailey-share-backdrop {
    position: fixed; inset: 0; background: rgba(15, 18, 30, 0.55);
    display: none; align-items: center; justify-content: center;
    z-index: 2147483646;
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #18181B;
  }
  .bailey-share-backdrop.open { display: flex; }
  .bailey-share-card {
    background: white; border-radius: 12px; box-shadow: 0 24px 60px rgba(0,0,0,0.25);
    width: min(560px, 92vw); max-height: 90vh; overflow: hidden;
    display: flex; flex-direction: column;
  }
  .bailey-share-header {
    padding: 18px 20px 14px; display: flex; align-items: flex-start; gap: 12px;
    border-bottom: 1px solid #EFEFF1;
  }
  .bailey-share-header h2 { margin: 0; font-size: 18px; font-weight: 600; }
  .bailey-share-header .sub { margin: 4px 0 0; color: #71717A; font-size: 13px; }
  .bailey-share-header .close {
    margin-left: auto; background: none; border: 0; cursor: pointer;
    width: 32px; height: 32px; border-radius: 8px; color: #71717A;
    display: flex; align-items: center; justify-content: center;
  }
  .bailey-share-header .close:hover { background: #F4F4F5; color: #18181B; }

  .bailey-share-add {
    padding: 12px 16px; border-bottom: 1px solid #EFEFF1;
    display: flex; gap: 8px; align-items: center;
  }
  .bailey-share-add input {
    flex: 1; padding: 10px 12px; border: 1px solid #E4E4E7; border-radius: 8px;
    font: inherit; outline: none;
  }
  .bailey-share-add input:focus { border-color: #093DF5; box-shadow: 0 0 0 3px rgba(9,61,245,0.15); }
  .bailey-share-add select {
    padding: 10px 8px; border: 1px solid #E4E4E7; border-radius: 8px;
    background: white; font: inherit; cursor: pointer;
  }
  .bailey-share-add button {
    padding: 10px 16px; border: 0; border-radius: 8px;
    background: #093DF5; color: white; font: inherit; font-weight: 500; cursor: pointer;
  }
  .bailey-share-add button:hover { background: #0731C4; }
  .bailey-share-add button:disabled { opacity: 0.5; cursor: not-allowed; }

  .bailey-share-section-title {
    padding: 12px 20px 4px; font-size: 13px; font-weight: 600; color: #3F3F46;
  }
  .bailey-share-list { padding: 0 8px 8px; overflow-y: auto; flex: 1; }
  .bailey-share-row {
    padding: 10px 12px; display: flex; align-items: center; gap: 12px; border-radius: 8px;
  }
  .bailey-share-row:hover { background: #FAFAFA; }
  .bailey-share-avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: #093DF5; color: white;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 600; flex-shrink: 0;
  }
  .bailey-share-avatar.group { background: #6B7280; }
  .bailey-share-meta { flex: 1; min-width: 0; }
  .bailey-share-meta .name {
    font-size: 14px; color: #18181B; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bailey-share-meta .sub  { font-size: 12px; color: #71717A; }
  .bailey-share-role {
    font-size: 12px; padding: 4px 10px; border-radius: 999px;
    background: #F4F4F5; color: #3F3F46; flex-shrink: 0;
  }
  .bailey-share-role.owner { background: #DBEAFE; color: #1E40AF; }
  .bailey-share-role-dropdown {
    padding: 4px 8px; border: 1px solid #E4E4E7; border-radius: 6px;
    background: white; font: inherit; font-size: 12px; cursor: pointer;
  }
  .bailey-share-remove {
    background: none; border: 0; color: #b00020; cursor: pointer;
    font-size: 12px; padding: 4px 8px; border-radius: 6px;
  }
  .bailey-share-remove:hover { background: #FEE2E2; }

  .bailey-share-footer {
    padding: 14px 20px; border-top: 1px solid #EFEFF1;
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
  }
  .bailey-share-footer button {
    padding: 10px 18px; border: 0; border-radius: 8px;
    background: #093DF5; color: white; font: inherit; font-weight: 500; cursor: pointer;
  }
  .bailey-share-footer button:hover { background: #0731C4; }
  .bailey-share-error {
    padding: 8px 20px; color: #b00020; font-size: 13px; display: none;
  }
  .bailey-share-error.shown { display: block; }
  .bailey-share-empty { padding: 16px 20px; color: #71717A; font-size: 13px; text-align: center; }

  /* Magic link: one unobtrusive button; the risk copy lives in a confirm dialog. */
  .bailey-magic-btn {
    margin: 2px 20px 10px; padding: 9px 14px; border: 1px solid #093DF5; border-radius: 8px;
    background: white; color: #093DF5; font: inherit; font-weight: 500; cursor: pointer;
  }
  .bailey-magic-btn:hover { background: #EEF2FF; }
  .bailey-magic-linkbox { display: flex; gap: 8px; align-items: center; padding: 0 20px 10px; }
  .bailey-magic-linkbox input {
    flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid #E4E4E7; border-radius: 8px;
    font: inherit; font-size: 12px; color: #3F3F46; background: #FAFAFA; outline: none;
  }
  .bailey-magic-copy {
    padding: 8px 12px; border: 1px solid #E4E4E7; border-radius: 8px;
    background: white; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
  }
  .bailey-magic-copy:hover { background: #F4F4F5; }
  /* Secondary confirm dialog */
  .bailey-magic-confirm {
    position: fixed; inset: 0; background: rgba(15,18,30,0.5);
    display: none; align-items: center; justify-content: center; z-index: 2147483647;
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #18181B;
  }
  .bailey-magic-confirm.open { display: flex; }
  .bailey-magic-dialog {
    background: white; border-radius: 12px; box-shadow: 0 24px 60px rgba(0,0,0,0.3);
    width: min(420px, 92vw); padding: 22px 22px 18px;
  }
  .bailey-magic-dialog h3 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
  .bailey-magic-dialog p { margin: 0 0 18px; color: #52525B; font-size: 13px; line-height: 1.5; }
  .bailey-magic-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .bailey-magic-cancel {
    padding: 9px 16px; border: 1px solid #E4E4E7; border-radius: 8px;
    background: white; color: #3F3F46; font: inherit; font-weight: 500; cursor: pointer;
  }
  .bailey-magic-cancel:hover { background: #F4F4F5; }
  .bailey-magic-go {
    padding: 9px 16px; border: 0; border-radius: 8px;
    background: #093DF5; color: white; font: inherit; font-weight: 500; cursor: pointer;
  }
  .bailey-magic-go:hover { background: #0731C4; }
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

    <div id="bailey-magic-section" style="display:none;border-top:1px solid #EFEFF1;margin-top:6px;padding-top:6px;">
      <div class="bailey-share-section-title">Magic links</div>
      <div class="bailey-share-list" id="bailey-magic-list"></div>
      <div id="bailey-magic-new" class="bailey-magic-linkbox" style="display:none;"></div>
      <button type="button" id="bailey-magic-create" class="bailey-magic-btn" onclick="window.__baileyMagicConfirm()">Create magic link</button>
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
  }
  var magicCreateURL = '/2fa-gate/api/magic-link/create';
  var magicRevokeURL = '/2fa-gate/api/magic-link/revoke';
  function renderMagic(data) {
    var sec = $('bailey-magic-section');
    if (!data.can_mint_magic_link) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    var list = $('bailey-magic-list');
    list.innerHTML = '';
    var links = data.magic_links || [];
    if (!links.length) {
      var p = document.createElement('p');
      p.className = 'bailey-share-empty';
      p.textContent = 'No magic links yet.';
      list.appendChild(p);
    }
    links.forEach(function(m){
      var meta = el('div', {class:'bailey-share-meta'}, [
        el('div', {class:'name', text:'Magic link'}),
        el('div', {class:'sub',  text:'by ' + (m.created_by||'') + ' · expires ' + String(m.expires_at||'').slice(0,10)})
      ]);
      var rm = el('button', {class:'bailey-share-remove', text:'Revoke', onclick:function(){ revokeMagic(m.id); }});
      list.appendChild(el('div', {class:'bailey-share-row'}, [meta, rm]));
    });
  }
  function revokeMagic(id) {
    showError('');
    fetch(magicRevokeURL, {method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:id})})
      .then(function(r){ if(!r.ok) return r.text().then(function(t){throw new Error(t||('HTTP '+r.status));}); return r.json(); })
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
      .then(function(r){ if(!r.ok) return r.text().then(function(t){throw new Error(t||('HTTP '+r.status));}); return r.json(); })
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
      .then(function(r){ if(!r.ok) return r.text().then(function(t){throw new Error(t||('HTTP '+r.status));}); return r.json(); })
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
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    if ($('bailey-magic-confirm').classList.contains('open')) { window.__baileyMagicCancel(); return; }
    if ($('bailey-share-modal').classList.contains('open')) { window.__baileyShareClose(); }
  });
})();`, apiURL, callerEmail, html.UnescapeString(host))
}
