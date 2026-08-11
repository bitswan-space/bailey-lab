package daemon

import (
	"bytes"
	"html/template"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// errorPageData mirrors, field for field, the anonymous struct oauth2-proxy
// v7.15.3 passes to error.html (pkg/app/pagewriter/error_page.go,
// errorPageWriter.WriteErrorPage). If a field here doesn't exist upstream the
// template would still render, but a field the template uses and upstream does
// NOT pass is an execution error at runtime — which is exactly what these tests
// catch.
type errorPageData struct {
	Title       string
	Message     string
	ProxyPrefix string
	StatusCode  int
	Redirect    string
	RequestID   string
	Footer      template.HTML
	Version     string
}

// renderErrorPage parses the generated error.html the way oauth2-proxy does —
// same template name, same (and only these) extra functions, see
// pkg/app/pagewriter/templates.go loadTemplates — and executes it.
func renderErrorPage(t *testing.T, data errorPageData) string {
	t.Helper()
	tmpl, err := template.New("").Funcs(template.FuncMap{
		"ToUpper": strings.ToUpper,
		"ToLower": strings.ToLower,
	}).Parse(protectedProxyErrorTemplate())
	if err != nil {
		t.Fatalf("generated error.html does not parse: %v", err)
	}
	page := tmpl.Lookup("error.html")
	if page == nil {
		t.Fatalf(`generated template defines no "error.html" — oauth2-proxy looks it up by that name`)
	}
	var buf bytes.Buffer
	if err := page.Execute(&buf, data); err != nil {
		t.Fatalf("executing error.html: %v", err)
	}
	return buf.String()
}

// callbackData is the shape of a real failed /oauth2/callback: 500, a redirect
// back to the app, a request ID that also went to the log.
func callbackData(message string) errorPageData {
	return errorPageData{
		Title:       "Internal Server Error",
		Message:     message,
		ProxyPrefix: "/oauth2",
		StatusCode:  500,
		Redirect:    "/",
		RequestID:   "0a3a603d-1f7b-4279-bec0-ead09e42ef55",
		Version:     "v7.15.3",
	}
}

// The reported failure: Keycloak's emailVerified was false, oauth2-proxy refused
// the callback, and the person got a bare 500. The page must now name the cause
// and give both audiences their next step.
func TestErrorPageNamesUnverifiedEmail(t *testing.T) {
	got := renderErrorPage(t, callbackData(`email in id_token (ondrej.maca@harmonum.ai) isn't verified`))

	for _, want := range []string{
		"Verify your email address", // the cause, as a heading
		"never been confirmed",      // what that means
		"verification email",        // what the person does
		"Ask an administrator",      // their fallback
		"Administrators:",           // the operator's half
		"Email verified",            // the exact Keycloak toggle
		"Send verification email",   // the alternative
		"Request ID",                // correlation with the log
		"0a3a603d-1f7b-4279-bec0-ead09e42ef55",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("unverified-email page is missing %q\n---\n%s", want, got)
		}
	}

	// It must NOT read like the generic page.
	if strings.Contains(got, "Usual causes") {
		t.Errorf("unverified-email page fell through to the generic branch:\n%s", got)
	}
}

// The whole reason show_debug_on_error is safe here: .Message carries the raw
// internal error, and no branch of the template may render it.
func TestErrorPageNeverLeaksTheRawError(t *testing.T) {
	leaky := []string{
		`dial tcp 172.18.0.9:9080: connect: connection refused`,
		`failed to get token: oauth2: "invalid_client" "Invalid client or Invalid client credentials"`,
		`unexpected status "401 Unauthorized": {"error":"unauthorized_client"}`,
		`Session validation failed`,
	}
	for _, msg := range leaky {
		got := renderErrorPage(t, callbackData(msg))
		if strings.Contains(got, msg) {
			t.Errorf("page rendered the raw error %q verbatim", msg)
		}
		// Even a fragment would be a leak.
		for _, frag := range []string{"172.18.0.9", "invalid_client", "unauthorized_client", "dial tcp"} {
			if strings.Contains(msg, frag) && strings.Contains(got, frag) {
				t.Errorf("page leaked %q from the raw error %q", frag, msg)
			}
		}
		// …and it must still be useful: the honest generic page.
		for _, want := range []string{
			"Sign-in couldn't be completed",
			"Usual causes",
			"Email verified",                      // cause 1 + its fix
			"disabled",                            // cause 2
			"clock has drifted",                   // cause 3
			"docker logs bitswan-protected-proxy", // where the exact reason is
			"Request ID",
		} {
			if !strings.Contains(got, want) {
				t.Errorf("generic page for %q is missing %q\n---\n%s", msg, want, got)
			}
		}
	}
}

// A raw error is untrusted text (the IdP-error variant interpolates a query
// parameter). Even though we never print it, a matched prefix must not let
// markup through.
func TestErrorPageDoesNotRenderMarkupFromTheError(t *testing.T) {
	got := renderErrorPage(t, callbackData(`email in id_token (<script>alert(1)</script>) isn't verified`))
	if strings.Contains(got, "<script>alert(1)</script>") {
		t.Errorf("page emitted unescaped markup from the error message:\n%s", got)
	}
	if !strings.Contains(got, "Verify your email address") {
		t.Errorf("prefix match broke on a hostile message:\n%s", got)
	}
}

// oauth2-proxy's own "Login Failed: …" messages are recognised, but we print our
// own copy rather than echoing text that can carry an IdP-supplied string.
func TestErrorPageMapsLoginFailedWithoutEchoingIt(t *testing.T) {
	data := callbackData(`Login Failed: The upstream identity provider returned an error: call +1-555-0100 for support`)
	data.StatusCode = 403
	data.Title = "Forbidden"
	got := renderErrorPage(t, data)

	if strings.Contains(got, "+1-555-0100") {
		t.Errorf("page echoed IdP-supplied text back to the browser:\n%s", got)
	}
	if !strings.Contains(got, "Sign-in didn't complete") {
		t.Errorf(`403 "Login Failed:" did not map to the stale-attempt page:\n%s`, got)
	}
	if !strings.Contains(got, "docker logs bitswan-protected-proxy") {
		t.Errorf("page does not tell an operator where the exact reason is:\n%s", got)
	}
}

// A 502 is the other page people actually hit: they are signed in and the app
// behind the proxy is down. It must not talk about signing in.
func TestErrorPageHandlesBadGateway(t *testing.T) {
	got := renderErrorPage(t, errorPageData{
		Title:       "Bad Gateway",
		Message:     "There was a problem connecting to the upstream server.",
		ProxyPrefix: "/oauth2",
		StatusCode:  502,
		RequestID:   "5d9f0d21-1111-2222-3333-444455556666",
		Version:     "v7.15.3",
	})
	if !strings.Contains(got, "isn't responding") {
		t.Errorf("502 page does not name the cause:\n%s", got)
	}
	if strings.Contains(got, "Sign-in couldn't be completed") {
		t.Errorf("502 page blames sign-in:\n%s", got)
	}
	// No .Redirect on an upstream error, so no buttons.
	if strings.Contains(got, "Try signing in again") {
		t.Errorf("502 page offers a sign-in button with no redirect target:\n%s", got)
	}
}

// The buttons are what makes the page a way out rather than a dead end.
func TestErrorPageOffersAWayOut(t *testing.T) {
	got := renderErrorPage(t, callbackData(`email in id_token (a@b.c) isn't verified`))
	for _, want := range []string{
		`action="/oauth2/sign_in"`,
		`name="rd" value="/"`,
		"Try signing in again",
		"Go back",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("page is missing %q\n---\n%s", want, got)
		}
	}
}

// The page must look like the rest of Bailey, not like a different product:
// same stylesheet and same brand chrome as the gate/pairing scenes.
func TestErrorPageUsesTheSharedSceneChrome(t *testing.T) {
	got := renderErrorPage(t, callbackData("anything"))
	for _, want := range []string{
		".sc-card{",        // sceneBaseCSS itself, not a copy
		sceneHexagonSVG,    // the Bailey mark
		`class="sc-brand"`, // the brand row
		`class="sc-card"`,  // the centred card
		`class="sc-btn"`,   // the shared primary button
		`class="sc-grid"`,  // the dot-grid surface
	} {
		if !strings.Contains(got, want) {
			t.Errorf("page does not use the shared scene chrome (%q missing)", want)
		}
	}
	// Self-contained: the stock template pulls bulma + font-awesome off
	// {{.ProxyPrefix}}/static, which the strict CSP on these hosts forbids.
	if strings.Contains(got, "bulma.min.css") || strings.Contains(got, "all.min.css") {
		t.Errorf("page references oauth2-proxy's stock stylesheets")
	}
}

// tplHasPrefix is the only way to prefix-match inside oauth2-proxy's templates
// (no strings.HasPrefix in the func map). It must be true for a match, false
// otherwise, and — critically — must not blow up on a message SHORTER than the
// prefix, which is what the length guard is for.
func TestTplHasPrefix(t *testing.T) {
	tmpl := template.Must(template.New("t").Parse(
		"{{ if " + tplHasPrefix(".Message", "email in id_token (") + " }}yes{{ else }}no{{ end }}"))

	cases := map[string]string{
		`email in id_token (a@b.c) isn't verified`: "yes",
		`email in id_token (`:                      "yes",
		`email in id_token`:                        "no", // shorter than the prefix
		``:                                         "no",
		`x`:                                        "no",
		`the email in id_token (a@b.c) isn't verified`: "no", // prefix, not contains
	}
	for msg, want := range cases {
		var buf bytes.Buffer
		if err := tmpl.Execute(&buf, struct{ Message string }{msg}); err != nil {
			t.Fatalf("executing prefix test for %q: %v", msg, err)
		}
		if buf.String() != want {
			t.Errorf("prefix test for %q = %s, want %s", msg, buf.String(), want)
		}
	}
}

// writeProtectedProxyTemplates is what actually ships the page: the compose mount
// is a STRICT volume subpath, so a missing directory or file stops the proxy
// container. And the file has to be loadable the way oauth2-proxy loads it —
// ParseFiles, then Lookup("error.html") (pkg/app/pagewriter/templates.go).
func TestWriteProtectedProxyTemplates(t *testing.T) {
	proxyDir := t.TempDir()
	if err := writeProtectedProxyTemplates(proxyDir); err != nil {
		t.Fatalf("writeProtectedProxyTemplates: %v", err)
	}

	path := filepath.Join(proxyDir, "templates", "error.html")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("error.html not written where the compose subpath mount expects it: %v", err)
	}
	if !info.Mode().IsRegular() {
		// oauth2-proxy's isFile() rejects anything else and silently falls back
		// to its stock page.
		t.Fatalf("error.html is not a regular file: %v", info.Mode())
	}

	tmpl, err := template.New("").Funcs(template.FuncMap{
		"ToUpper": strings.ToUpper,
		"ToLower": strings.ToLower,
	}).ParseFiles(path)
	if err != nil {
		t.Fatalf("oauth2-proxy could not ParseFiles the written template: %v", err)
	}
	if tmpl.Lookup("error.html") == nil {
		t.Fatalf(`written template is not registered as "error.html"`)
	}

	// Re-running a provision must be idempotent, not append or fail.
	if err := writeProtectedProxyTemplates(proxyDir); err != nil {
		t.Fatalf("second writeProtectedProxyTemplates: %v", err)
	}
	again, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if string(again) != protectedProxyErrorTemplate() {
		t.Errorf("re-provision did not leave the current template on disk")
	}
}
