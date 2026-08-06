package daemon

import (
	"fmt"
	"html"
	"io"
	"net/http"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// The "save the backup key to your password manager" page.
//
// There is no escrow, so recovery depends entirely on the operator keeping a
// copy — and the only affordance for that used to be a download that drops a
// plaintext .txt into ~/Downloads forever. Getting the key into a password
// manager instead is strictly better custody, but browsers only offer to save a
// credential under conditions the console could not meet from where it lives:
//
//   - The console SPA runs on the INNER host inside a cross-origin iframe (see
//     chromeWrapMiddleware). navigator.credentials.store() rejects outside a
//     top-level browsing context, and browser-native save prompts are suppressed
//     in cross-origin frames. An in-page form there produced nothing in Firefox
//     and nothing in Chrome until the form later unmounted, which tripped an
//     unrelated "SPA login succeeded" heuristic and prompted long after the fact.
//   - A submit that calls preventDefault() goes nowhere, and a submission without
//     a navigation is the signal browsers largely ignore.
//
// So this is a plain server-rendered document, opened top-level in its own
// window, whose form really does POST and really does navigate. That is the one
// shape both Chrome and Firefox treat as a login worth remembering. No SPA, no
// React, no fetch — the fewer moving parts between the browser and a normal
// login form, the more reliably a manager recognises it.

const keySavePagePath = "/bailey/key-save"

// handleBaileyKeySavePage renders the form. Admin-gated by the caller.
func (s *Server) handleBaileyKeySavePage(w http.ResponseWriter, r *http.Request) {
	// The key reaches the browser in the page body, so it must not linger in
	// the back/forward cache or be re-served from history.
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("Referrer-Policy", "no-referrer")

	switch r.Method {
	case http.MethodGet:
		s.renderKeySaveForm(w)
	case http.MethodPost:
		// The submission exists only so the browser sees a completed login and
		// offers to remember it. The posted key is deliberately read and
		// dropped: this endpoint stores nothing, and must never log the body.
		_, _ = io.Copy(io.Discard, r.Body)
		renderKeySaveDone(w)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) renderKeySaveForm(w http.ResponseWriter) {
	key, err := backup.LoadKey()
	if err != nil || key == "" {
		card := `<div class="sc-pad">
  <h1 class="sc-h1">No backup key yet</h1>
  <p class="sc-sub">This server has not generated a backup encryption key. It is
  created on the first backup run — come back once backups have run at least once.</p>
</div>`
		writeScene(w, http.StatusNotFound, "Backup key", card, "")
		return
	}

	// The username is what the operator will search their vault for during a
	// disaster, so it names the server the way they know it — not the internal
	// --inner hostname this page happens to be served from.
	account := "backup-key@" + keySaveAccountDomain()

	card := fmt.Sprintf(`<div class="sc-pad">
  <h1 class="sc-h1">Save your backup encryption key</h1>
  <p class="sc-sub">This key decrypts every backup, including workspace secrets. It is
  stored <strong>nowhere but this server</strong> — there is no escrow. Save it in your
  password manager now: without your copy, losing this server makes every backup
  permanently unreadable.</p>

  <form method="post" action="%s" class="sc-form">
    <label class="sc-label" for="ks-user">Entry name</label>
    <input class="sc-input" id="ks-user" name="username" type="text"
           autocomplete="username" value="%s" readonly>

    <label class="sc-label" for="ks-key">Backup encryption key</label>
    <input class="sc-input sc-mono" id="ks-key" name="password" type="password"
           autocomplete="new-password" value="%s" readonly>

    <div class="sc-row">
      <button class="sc-btn-ghost" type="button" id="ks-reveal">Reveal</button>
      <button class="sc-btn-ghost" type="button" id="ks-copy">Copy</button>
      <span class="sc-spacer"></span>
      <button class="sc-btn" type="submit">Save to password manager</button>
    </div>
  </form>

  <p class="sc-note">Your password manager should offer to save when you press
  <strong>Save to password manager</strong>. If it does not, copy the key and add it by
  hand — then confirm you have saved it in the console.</p>
</div>`, html.EscapeString(keySavePagePath), html.EscapeString(account), html.EscapeString(key))

	// Reveal/copy only. The save itself is a real form submission with a real
	// navigation, deliberately not scripted: intercepting it is exactly what
	// stopped the browser from noticing last time.
	script := `<script>
document.getElementById('ks-reveal').addEventListener('click', function(){
  var f = document.getElementById('ks-key');
  var show = f.type === 'password';
  f.type = show ? 'text' : 'password';
  this.textContent = show ? 'Hide' : 'Reveal';
});
document.getElementById('ks-copy').addEventListener('click', async function(){
  var f = document.getElementById('ks-key');
  try {
    await navigator.clipboard.writeText(f.value);
    this.textContent = 'Copied';
  } catch (e) {
    // Clipboard blocked (insecure context, permissions): fall back to
    // selecting the text so it can still be copied by hand.
    f.type = 'text';
    f.removeAttribute('readonly');
    f.select();
    this.textContent = 'Select and copy';
  }
});
</script>`
	writeScene(w, http.StatusOK, "Save your backup key", card, script)
}

// renderKeySaveDone is the page the submission lands on. It must contain NO
// password field: a manager decides the login succeeded partly from the next
// document not asking for credentials again.
func renderKeySaveDone(w http.ResponseWriter) {
	card := `<div class="sc-pad">
  <h1 class="sc-h1">Key saved</h1>
  <p class="sc-sub">If your password manager offered to save it, you can close this tab.
  Nothing was sent anywhere: the key never left this server, and this page stored
  nothing.</p>
  <p class="sc-sub">Back in the console, confirm with <strong>I have saved it</strong> so the
  server stops warning that no copy exists.</p>
  <div class="sc-row"><span class="sc-spacer"></span>
    <button class="sc-btn" type="button" onclick="window.close()">Close</button></div>
</div>`
	writeScene(w, http.StatusOK, "Key saved", card, "")
}

// keySaveAccountDomain is the server's public domain, or a usable fallback when
// none is configured yet.
func keySaveAccountDomain() string {
	if d := protectedHostnameDomain(); d != "" {
		return d
	}
	return "this-server"
}

// writeScene renders one of these pages through the shared scene shell, with the
// page-specific form styling the shell does not carry.
func writeScene(w http.ResponseWriter, status int, title, card, extraBody string) {
	extraHead := `<style>
.sc-form{margin-top:18px;display:flex;flex-direction:column;gap:6px;}
.sc-label{font-size:12px;color:#64748b;font-weight:600;margin-top:8px;}
.sc-input{padding:9px 11px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;
  background:#f8fafc;color:#0f172a;width:100%;box-sizing:border-box;}
.sc-mono{font-family:'Geist Mono',ui-monospace,monospace;}
.sc-row{display:flex;align-items:center;gap:8px;margin-top:16px;}
.sc-spacer{flex:1;}
.sc-btn{height:34px;padding:0 14px;border-radius:7px;border:1px solid #093df5;
  background:#093df5;color:#fff;font-size:13px;font-weight:500;cursor:pointer;}
.sc-btn-ghost{height:34px;padding:0 12px;border-radius:7px;border:1px solid transparent;
  background:transparent;color:#0f172a;font-size:13px;cursor:pointer;}
.sc-btn-ghost:hover{background:#f1f5f9;}
.sc-note{margin-top:16px;font-size:12.5px;color:#64748b;line-height:1.5;}
</style>`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprint(w, scenePage(title, "", scenePillTone{}, card, "", extraHead, extraBody))
}
