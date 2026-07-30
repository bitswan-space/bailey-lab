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
// The dialog shows BOTH halves of the union ACL (#251): a boxed,
// clearly-labelled "workspace · inherited" row (expandable to the actual
// member list, carrying the switch that turns that half off), and below it
// the people granted on this endpoint alone. The add field is free text —
// any email or /group/path — with a click-to-pick list of the server's
// people underneath it, mirroring the workspace sidebar's "Add a member".

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

  /* --- Inherited workspace access (#251) --------------------------------
     The effective ACL is (all workspace members) ∪ (people added here).
     The workspace half gets its own boxed, tinted row carrying the switch
     that turns it off, so it never reads as just another grantee. */
  .bailey-share-inherited {
    margin: 2px 12px 8px; padding: 10px 12px; border-radius: 10px;
    border: 1px solid #C7D7FE; background: #F5F8FF;
  }
  .bailey-share-inherited.off { border-color: #E4E4E7; background: #FAFAFA; }
  .bailey-share-inherited-head { display: flex; align-items: center; gap: 12px; }
  .bailey-share-inherited .bailey-share-avatar { background: #1E40AF; }
  .bailey-share-inherited.off .bailey-share-avatar { background: #A1A1AA; }
  .bailey-share-count {
    font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 999px;
    border: 1px solid #C7D7FE; background: #DBEAFE; color: #1E40AF;
    flex-shrink: 0; cursor: pointer; white-space: nowrap;
  }
  .bailey-share-count:hover { background: #C7D7FE; }
  .bailey-share-inherited.off .bailey-share-count {
    background: #F4F4F5; color: #52525B; border-color: #E4E4E7;
  }
  .bailey-share-members {
    display: none; margin-top: 10px; padding-top: 8px; border-top: 1px dashed #C7D7FE;
  }
  .bailey-share-members.open { display: block; }
  .bailey-share-member {
    display: flex; align-items: center; gap: 8px; padding: 3px 0;
    font-size: 13px; color: #3F3F46; min-width: 0;
  }
  .bailey-share-member .dot {
    width: 22px; height: 22px; border-radius: 50%; background: #6B7280; color: white;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 600; flex-shrink: 0;
  }
  .bailey-share-member .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bailey-share-members .note { font-size: 12px; color: #71717A; padding-top: 6px; }

  /* Switch. A real checkbox underneath (keyboard + a11y), track/knob drawn
     on top so it reads as an on/off switch rather than a list checkbox. */
  .bailey-share-switch { position: relative; display: inline-flex; flex-shrink: 0; }
  .bailey-share-switch input {
    position: absolute; inset: 0; width: 100%; height: 100%;
    margin: 0; opacity: 0; cursor: pointer;
  }
  .bailey-share-switch .track {
    display: block; width: 38px; height: 22px; border-radius: 999px;
    background: #D4D4D8; transition: background 120ms ease;
  }
  .bailey-share-switch .knob {
    position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
    border-radius: 50%; background: white; box-shadow: 0 1px 2px rgba(0,0,0,0.25);
    transition: transform 120ms ease; pointer-events: none;
  }
  .bailey-share-switch input:checked ~ .track { background: #093DF5; }
  .bailey-share-switch input:checked ~ .knob { transform: translateX(16px); }
  .bailey-share-switch input:focus-visible ~ .track { box-shadow: 0 0 0 3px rgba(9,61,245,0.25); }
  .bailey-share-switch input:disabled ~ .track { opacity: 0.5; }
  .bailey-share-switch input:disabled { cursor: progress; }

  /* --- People picker (#251) ---------------------------------------------
     Click-to-pick over the server's people directory, mirroring the
     workspace sidebar's "Add a member" list. The free-text field above
     still accepts any email or /group/path. */
  .bailey-share-picker {
    display: none; margin: 0 16px 12px; border: 1px solid #E4E4E7;
    border-radius: 8px; max-height: 168px; overflow-y: auto;
  }
  .bailey-share-picker.open { display: block; }
  .bailey-share-pick {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 8px 10px; text-align: left; font: inherit; color: #18181B;
    background: none; border: 0; border-bottom: 1px solid #F4F4F5; cursor: pointer;
  }
  .bailey-share-pick:last-child { border-bottom: 0; }
  .bailey-share-pick:hover { background: #F4F4F5; }
  .bailey-share-pick .who { flex: 1; min-width: 0; }
  .bailey-share-pick .who .line {
    font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bailey-share-pick .who .mail { font-size: 11px; color: #71717A; }
  .bailey-share-pick .tag { font-size: 11px; color: #71717A; flex-shrink: 0; }
  .bailey-share-picker .note { padding: 8px 10px; font-size: 12px; color: #71717A; }
  .bailey-share-subhead {
    padding: 4px 12px 2px; font-size: 11px; font-weight: 600;
    letter-spacing: 0.4px; text-transform: uppercase; color: #A1A1AA;
  }
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

    <div class="bailey-share-footer">
      <span style="font-size:12px;color:#71717A;">Changes save instantly.</span>
      <button type="button" onclick="window.__baileyShareClose()">Done</button>
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
    lastData = data;
    $('bailey-share-title').textContent = 'Share "' + hostLabel + '"';
    // Inherited workspace access goes ABOVE the individual rows, in its own
    // box — it is a different kind of thing from a person you added.
    renderWorkspace(data.workspace);
    var list = $('bailey-share-list');
    list.innerHTML = '';
    var ownerEmail = data.owner_email || '';
    if (data.workspace) {
      list.appendChild(el('div', {class:'bailey-share-subhead', text:'Added to this endpoint'}));
    }
    // Original owner row first (always present, can't be removed).
    list.appendChild(rowFor({principal_type:'email', principal_value:ownerEmail, role:'owner', isOriginalOwner:true}));
    (data.grants||[]).forEach(function(g) { list.appendChild(rowFor(g)); });
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

  // callerHasDirectOwnership: does the caller own this endpoint in its OWN
  // right (recorded owner, or an explicit owner grant), as opposed to owning
  // it only through the workspace inheritance? Used to warn before switching
  // the inheritance off would lock them out of this dialog. An owner grant
  // held via a GROUP can't be checked here (the browser doesn't know the
  // caller's groups), so this can be a false negative — an extra warning,
  // never a missing one.
  function callerHasDirectOwnership(data) {
    if (!data) return false;
    var me = callerEmail.toLowerCase();
    if ((data.owner_email || '').toLowerCase() === me) return true;
    return (data.grants || []).some(function(g) {
      return g.role === 'owner' && g.principal_type === 'email' &&
             (g.principal_value || '').toLowerCase() === me;
    });
  }

  function renderWorkspace(ws) {
    var box = $('bailey-share-workspace');
    box.innerHTML = '';
    var sub = $('bailey-share-sub');
    if (!ws) {
      // Endpoint isn't part of a workspace — there is nothing to inherit.
      sub.textContent = 'Only people you invite can open this endpoint.';
      return;
    }
    var members = ws.members || [];
    var groups  = ws.groups  || [];
    sub.textContent = ws.enabled
      ? 'Everyone in the ' + ws.label + ' workspace can open this endpoint, plus anyone added below.'
      : 'Workspace members are switched off — only the people listed below can open this endpoint.';

    var avatar = el('div', {class:'bailey-share-avatar group', text:'WS'});
    var meta = el('div', {class:'bailey-share-meta'}, [
      el('div', {class:'name', text: ws.label + ' members'}),
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

    // Enumerate the inherited set so an admin can see WHO this admits.
    members.forEach(function(m) {
      panel.appendChild(el('div', {class:'bailey-share-member'}, [
        el('div', {class:'dot', text: initials(m)}),
        el('div', {class:'who', text: m + (m.toLowerCase() === callerEmail.toLowerCase() ? ' (you)' : '')})
      ]));
    });
    groups.forEach(function(gp) {
      panel.appendChild(el('div', {class:'bailey-share-member'}, [
        el('div', {class:'dot', text:'##'}),
        el('div', {class:'who', text: gp + ' (Keycloak group)'})
      ]));
    });
    if (!members.length && !groups.length) {
      panel.appendChild(el('div', {class:'note', text:'This workspace has no members recorded yet.'}));
    }
    panel.appendChild(el('div', {class:'note',
      text:'Managed in the workspace, not here. Removing someone from the workspace removes this access.'}));

    var input = el('input', {type:'checkbox'});
    input.checked = !!ws.enabled;
    input.setAttribute('aria-label', 'Let ' + ws.label + ' workspace members open this endpoint');
    input.onchange = function() { setWorkspaceAccess(ws, input.checked, input); };
    var sw = el('label', {class:'bailey-share-switch', title:'Workspace members can open this endpoint'}, [
      input,
      el('span', {class:'track'}),
      el('span', {class:'knob'})
    ]);

    var head = el('div', {class:'bailey-share-inherited-head'}, [avatar, meta, countBtn, sw]);
    box.appendChild(el('div', {class:'bailey-share-inherited' + (ws.enabled ? '' : ' off')}, [head, panel]));
  }

  function setWorkspaceAccess(ws, enabled, input) {
    showError('');
    var n = (ws.members || []).length;
    var msg;
    if (enabled) {
      msg = 'Let all members of the ' + ws.label + ' workspace (' +
            peopleLabel(n, (ws.groups || []).length) + ') open this endpoint?';
    } else {
      msg = 'Stop ' + ws.label + ' workspace members from opening this endpoint? ' +
            'People added individually keep their access.';
      if (!callerHasDirectOwnership(lastData)) {
        msg += '\n\nWarning: your own access to this endpoint comes from that workspace, ' +
               'so this will lock you out of this dialog.';
      }
    }
    if (!confirm(msg)) { input.checked = !enabled; return; }
    var body = new URLSearchParams();
    body.append('action', 'workspace-access');
    body.append('enabled', enabled ? 'true' : 'false');
    input.disabled = true;
    fetch(apiURL, {method:'POST', credentials:'same-origin',
                   headers:{'Content-Type':'application/x-www-form-urlencoded'},
                   body: body.toString()})
      .then(function(r){ if(!r.ok) return r.json().then(function(d){ throw new Error(d.error||'HTTP '+r.status); }); return r.json(); })
      .then(render)
      .catch(function(e){
        input.disabled = false;
        input.checked = !enabled;
        showError('Could not change workspace access: ' + e.message);
      });
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
      // Workspace members already reach this endpoint while the inheritance
      // is on; offering to re-add them would be noise. With it off they ARE
      // worth offering — an individual grant is how you let one back in.
      if (lastData.workspace && lastData.workspace.enabled) {
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
      box.appendChild(el('button', {
        type:'button', class:'bailey-share-pick',
        title:'Add ' + p.email,
        onclick: function() { pick(p.email); }
      }, [
        el('div', {class:'bailey-share-avatar', text: initials(p.name || p.email)}),
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

  function pick(email) {
    add('email', email, $('bailey-share-role').value).then(function() {
      $('bailey-share-input').value = '';
    });
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
    if (g.isOriginalOwner) {
      children.push(el('span', {class:'bailey-share-role owner', text:'Owner'}));
    } else {
      var sel = el('select', {class:'bailey-share-role-dropdown'}, [
        el('option', {value:'access', text:'User'}),
        el('option', {value:'owner',  text:'Owner'})
      ]);
      sel.value = g.role;
      sel.onchange = function(){ updateRole(g.principal_type, g.principal_value, g.role, sel.value); };
      var rm  = el('button', {class:'bailey-share-remove', text:'Remove', onclick:function(){ revoke(g.principal_type, g.principal_value, g.role); }});
      children.push(sel);
      children.push(rm);
    }
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
    // Picker data is independent of the grant listing, so fetch it in
    // parallel and redraw when it lands.
    loadDirectory().then(renderPicker);
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
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && $('bailey-share-modal').classList.contains('open')) {
      window.__baileyShareClose();
    }
  });
})();`, apiURL, callerEmail, html.UnescapeString(host), gatePathPrefix+"/api/people/directory")
}
