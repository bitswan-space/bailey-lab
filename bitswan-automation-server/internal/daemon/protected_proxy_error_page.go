package daemon

import (
	"fmt"
	"html"
)

// protected_proxy_error_page.go builds the Bailey-branded error page that the
// shared oauth2-proxy (bitswan-protected-proxy) renders instead of its stock
// "500 Internal Server Error — Oops! Something went wrong. For more information
// contact your server administrator."
//
// WHY: a real person tried to sign in to a protected endpoint with a Keycloak
// account whose emailVerified was false. oauth2-proxy refuses that at the
// callback, and the only place the reason existed was the proxy's own log
// (`Error redeeming code during OAuth2 callback: email in id_token (…) isn't
// verified`). The person saw a bare 500 with a request ID and no way forward.
//
// WHAT error.html CAN SEE (oauth2-proxy v7.15.3,
// pkg/app/pagewriter/error_page.go WriteErrorPage). The data value is an
// anonymous struct with exactly these fields — nothing else exists, and
// referencing anything else is an execution error:
//
//	.Title       http.StatusText(status)          e.g. "Internal Server Error"
//	.Message     see below
//	.ProxyPrefix the proxy path prefix            e.g. "/oauth2"
//	.StatusCode  int                              e.g. 500
//	.Redirect    where "go back"/"sign in" point  e.g. "/"
//	.RequestID   the UUID also written to the log
//	.Footer      operator-configured footer HTML
//	.Version     oauth2-proxy's version
//
// The functions available inside the template are Go's builtins plus exactly
// ToUpper and ToLower (pkg/app/pagewriter/templates.go loadTemplates) — there is
// no strings.HasPrefix/Contains, which is why the prefix tests below are built
// out of len/slice/eq (see tplHasPrefix).
//
// THE SPECIFIC REASON IS *NOT* NORMALLY REACHABLE. For the failure that started
// this, oauthproxy.go:929 calls
//
//	p.ErrorPage(rw, req, http.StatusInternalServerError, err.Error())
//
// with NO trailing messages. errorPageWriter.getMessage then returns the fixed
// per-status string ("Oops! Something went wrong…"): the real cause travels in
// ErrorPageOpts.AppError, and AppError is not a field of the template data at
// all. The one switch that surfaces it is --show-debug-on-error, which makes
// .Message *be* the raw AppError for every error — internals like
// "dial tcp 172.18.0.9:9080: connect: connection refused" included. Upstream
// warns against it in production, and rightly so.
//
// SO: the proxy runs with show_debug_on_error ON, and this template NEVER
// RENDERS .Message. It only tests it against a short allowlist of prefixes and
// prints Bailey's own copy for the ones we recognise; every other error falls
// through to a generic page that names the handful of concrete, checkable causes
// and the request ID. The raw string cannot reach the browser because no branch
// emits it — protected_proxy_error_page_test.go asserts exactly that for a
// leak-shaped message. (If the template file ever went missing, oauth2-proxy
// would fall back to its stock error.html, which DOES print .Message in debug
// mode; the compose mount is a strict named-volume subpath, so a missing file
// stops the container instead — see CreateProtectedProxyDockerComposeFile.)
//
// The page is styled from sceneBaseCSS and the scene class names (mfa_scene.go),
// so it is the same centred card on a dot grid, with the same Bailey mark and
// host line, as the device-pairing and approval pages.

// oauth2-proxy error strings we recognise. Both are matched as PREFIXES.
const (
	// unverifiedEmailErrPrefix starts the error returned when the id_token
	// carries email_verified=false: fmt.Errorf("email in id_token (%s) isn't
	// verified", ss.Email) — providers/provider_data.go. It reaches the error
	// page unwrapped (Redeem → redeemCode → ErrorPage), so it is a true prefix.
	unverifiedEmailErrPrefix = `email in id_token (`

	// loginFailedErrPrefix starts the messages oauth2-proxy itself writes for a
	// user to read ("Login Failed: Unable to find a valid CSRF token. Please try
	// again.", "Login Failed: The upstream identity provider returned an
	// error: …"). We recognise the prefix but deliberately print our own text
	// rather than echoing theirs: the IdP variant interpolates a query
	// parameter, and reflecting attacker-supplied text on the sign-in domain is
	// a phishing surface we don't need.
	loginFailedErrPrefix = `Login Failed: `
)

// tplHasPrefix renders a Go-template expression that is true when the string in
// template variable ref starts with prefix. Only builtins are available inside
// oauth2-proxy's templates, so this is len+slice+eq rather than a helper func.
// `and` short-circuits (Go 1.18+), so slice is never evaluated on a string too
// short for it — an out-of-range slice would be a template execution error.
func tplHasPrefix(ref, prefix string) string {
	return fmt.Sprintf("and (ge (len %s) %d) (eq (slice %s 0 %d) %q)",
		ref, len(prefix), ref, len(prefix), prefix)
}

// protectedProxyErrorPageCSS is the page-specific stylesheet, appended to the
// shared sceneBaseCSS. Only additions — every shared token (colours, card,
// buttons, mono font) comes from sceneBaseCSS.
const protectedProxyErrorPageCSS = `
.pp-sec{margin:0 0 18px;padding:14px 16px;background:#fafafa;border:1px solid #e4e4e7;border-radius:10px;}
.pp-sec-t{font-size:11px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:9px;}
.pp-list{margin:0;padding-left:18px;font-size:13px;color:#18181b;line-height:20px;}
.pp-list li+li{margin-top:9px;}
.pp-mono{font-family:'Geist Mono',ui-monospace,monospace;font-size:12.5px;background:#f4f4f5;border-radius:4px;padding:1px 5px;}
.pp-btns{display:flex;gap:10px;}
.pp-btn-f{flex:1;}
.pp-rid{margin-top:9px;color:#a1a1aa;font-size:11px;}
`

// Scene-style icons (lucide outlines, matching sceneHexagonSVG's stroke style).
const (
	ppIconMail   = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`
	ppIconWarn   = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`
	ppIconDanger = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#b91c1c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`
	ppIconServer = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#b91c1c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/></svg>`
)

// protectedProxyErrorTemplate returns the full contents of the error.html the
// proxy is given via --custom-templates-dir. The `{{define "error.html"}}`
// wrapper matches upstream's own default template: oauth2-proxy parses the file
// with ParseFiles and then looks the page up by that name.
func protectedProxyErrorTemplate() string {
	vars := "{{- $msg := .Message -}}\n" +
		"{{- $unverified := " + tplHasPrefix("$msg", unverifiedEmailErrPrefix) + " -}}\n" +
		"{{- $loginFailed := " + tplHasPrefix("$msg", loginFailedErrPrefix) + " -}}\n"

	title := `{{ if $unverified }}Verify your email · Bailey` +
		`{{ else if eq .StatusCode 502 }}Application not responding · Bailey` +
		`{{ else }}Sign-in problem · Bailey{{ end }}`

	return `{{define "error.html"}}
` + vars + `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>` + title + `</title>` + bitswanFavicon + `
<style>` + sceneBaseCSS + protectedProxyErrorPageCSS + `</style></head>
<body>
<div class="sc-grid"></div>
<div class="sc-wrap"><div class="sc-col">
  <div class="sc-brand">
    <div class="sc-mark">` + sceneHexagonSVG + `</div>
    <div class="sc-brand-txt">
      <div class="sc-brand-name">Bailey</div>
      <div class="sc-brand-host">` + html.EscapeString(sceneHost()) + `</div>
    </div>
  </div>
  <div class="sc-card">` + protectedProxyErrorCard + `</div>
</div></div>
</body></html>
{{end}}
`
}

// protectedProxyErrorCard is the card body: one branch per condition we can
// name, then a generic branch. NOTE: no branch prints $msg — see the file
// header. Nothing here may render .Message.
const protectedProxyErrorCard = `
  <div class="sc-pad">
  {{ if $unverified }}
    <div class="sc-icon" style="background:#fef3c7;">` + ppIconMail + `</div>
    <h1 class="sc-h1">Verify your email address</h1>
    <p class="sc-sub">Your sign-in worked, but the email address on your account has never been confirmed. Bailey won't accept an unconfirmed address: until someone proves they can read that mailbox, the address is no evidence of who they are.</p>
    <div class="pp-sec">
      <div class="pp-sec-t">What to do</div>
      <ul class="pp-list">
        <li>Look for a verification email for your account and open the link in it — then come back and sign in again.</li>
        <li>Nothing in your inbox or spam folder? Ask an administrator of this server to verify your account. It takes them a few seconds.</li>
      </ul>
    </div>
  {{ else if $loginFailed }}
    <div class="sc-icon" style="background:#fef3c7;">` + ppIconWarn + `</div>
    <h1 class="sc-h1">Sign-in didn't complete</h1>
    <p class="sc-sub">The sign-in attempt was rejected before it finished. This is usually a stale attempt: a login page left open too long, or the same login started in more than one tab.</p>
    <div class="pp-sec">
      <div class="pp-sec-t">What to do</div>
      <ul class="pp-list">
        <li>Close the other tabs and start again from this one.</li>
        <li>If it still fails, an administrator can read the exact reason in the server log (below).</li>
      </ul>
    </div>
  {{ else if eq .StatusCode 502 }}
    <div class="sc-icon" style="background:#fee2e2;">` + ppIconServer + `</div>
    <h1 class="sc-h1">This application isn't responding</h1>
    <p class="sc-sub">You're signed in, but the service behind this address didn't answer. It may be starting up, stopped, or restarting.</p>
    <div class="pp-sec">
      <div class="pp-sec-t">What to do</div>
      <ul class="pp-list">
        <li>Wait a few seconds and reload.</li>
        <li>If it keeps failing, ask an administrator to check the deployment's containers and logs.</li>
      </ul>
    </div>
  {{ else }}
    <div class="sc-icon" style="background:#fee2e2;">` + ppIconDanger + `</div>
    <h1 class="sc-h1">Sign-in couldn't be completed</h1>
    <p class="sc-sub">Bailey couldn't finish the sign-in handshake with the identity provider. The exact reason is in the server log; these are the causes worth checking, in order.</p>
    <div class="pp-sec">
      <div class="pp-sec-t">Usual causes</div>
      <ul class="pp-list">
        <li><b>The account's email address isn't verified.</b> An administrator fixes it in Keycloak: Users &rarr; the person &rarr; set <span class="pp-mono">Email verified</span> to On, or send the verification email again.</li>
        <li><b>The account is disabled, or has an action still pending</b> — a forced password change or OTP set-up that was never completed.</li>
        <li><b>This server's clock has drifted</b> from the identity provider's, so the token it issued looks expired, or issued in the future.</li>
      </ul>
    </div>
  {{ end }}
  {{ if .Redirect }}
    <div class="pp-btns">
      <form method="GET" action="{{.ProxyPrefix}}/sign_in" class="pp-btn-f">
        <input type="hidden" name="rd" value="{{.Redirect}}">
        <button type="submit" class="sc-btn">Try signing in again</button>
      </form>
      <form method="GET" action="{{.Redirect}}" class="pp-btn-f">
        <button type="submit" class="sc-btn sc-btn-ghost">Go back</button>
      </form>
    </div>
  {{ end }}
  </div>
  <div class="sc-card-foot"><div>
  {{ if $unverified }}
    <b>Administrators:</b> in Keycloak open Users &rarr; this person and switch <span class="pp-mono">Email verified</span> to On — or use Credentials &rarr; Send verification email and let them confirm it themselves. Nothing needs changing on Bailey: they can sign in as soon as the address is verified.
  {{ else }}
    <b>Administrators:</b> the exact reason isn't shown here. Run <span class="pp-mono">docker logs bitswan-protected-proxy</span> on the server and read the error logged at this page's time.
  {{ end }}
  {{ if .RequestID }}<div class="pp-rid">{{ if .StatusCode }}HTTP {{.StatusCode}} &middot; {{ end }}Request ID <span class="pp-mono">{{.RequestID}}</span></div>{{ end }}
  </div></div>
`
