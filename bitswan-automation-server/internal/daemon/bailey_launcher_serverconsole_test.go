package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// --- chrome_launcher.go -------------------------------------------------

func TestAOCFrontendURL(t *testing.T) {
	cases := map[string]string{
		"":                                "",
		"https://api.acme.bswn.io":        "https://aoc.acme.bswn.io/",
		"https://api.acme.bswn.io/v2?x=1": "https://aoc.acme.bswn.io/",
		"https://custom.example.com":      "https://custom.example.com/",
		"::::not a url":                   "::::not a url",
	}
	for in, want := range cases {
		if got := aocFrontendURL(in); got != want {
			t.Errorf("aocFrontendURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestServerConsoleHost(t *testing.T) {
	if got := serverConsoleHost("acme.bswn.io"); got != "bailey.acme.bswn.io" {
		t.Errorf("serverConsoleHost = %q", got)
	}
	if got := serverConsoleHost(".acme.bswn.io"); got != "bailey.acme.bswn.io" {
		t.Errorf("serverConsoleHost(leading dot) = %q", got)
	}
}

func TestLauncherButtonAndItemHTML(t *testing.T) {
	btn := baileyLauncherButtonHTML()
	if !strings.Contains(btn, "bailey-launch-btn") || !strings.Contains(btn, bitswanMarkSVG) {
		t.Error("launcher button missing id/mark")
	}
	item := launcherItem(launchIconAOC, "Label <x>", "https://h/?a=b&c=d", "item")
	if !strings.Contains(item, "Label &lt;x&gt;") {
		t.Error("launcher item did not HTML-escape label")
	}
	if !strings.Contains(item, "https://h/?a=b&amp;c=d") {
		t.Error("launcher item did not escape URL")
	}
}

func TestBaileyLauncherData_BuildsMenu(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "launcher-owner@example.com"

	// A workspace endpoint owned by the caller.
	wsHost := "lws-dashboard." + domain
	if _, err := registerEndpoint(wsHost, owner, "My Workspace", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	// A production frontend whose parent is the workspace.
	feHost := "lws-app." + domain
	if _, err := registerEndpoint(feHost, owner, "App Frontend", wsHost, endpointKindFrontend, "production"); err != nil {
		t.Fatal(err)
	}
	// A non-production frontend that must NOT appear in the launcher.
	devHost := "lws-dev." + domain
	if _, err := registerEndpoint(devHost, owner, "Dev Frontend", wsHost, endpointKindFrontend, "dev"); err != nil {
		t.Fatal(err)
	}

	d := baileyLauncherData(owner, nil)
	if d.DashboardURL == "" {
		t.Error("DashboardURL not set from configured domain")
	}
	var grp *launcherWorkspace
	for i := range d.Workspaces {
		if strings.Contains(d.Workspaces[i].URL, "lws-dashboard") {
			grp = &d.Workspaces[i]
		}
	}
	if grp == nil {
		t.Fatalf("workspace group not built: %+v", d.Workspaces)
	}
	if grp.Name != "My Workspace" {
		t.Errorf("group name = %q", grp.Name)
	}
	var sawProd, sawDev bool
	for _, fe := range grp.Frontends {
		if fe.Name == "App Frontend" {
			sawProd = true
		}
		if fe.Name == "Dev Frontend" {
			sawDev = true
		}
	}
	if !sawProd {
		t.Error("production frontend missing from launcher")
	}
	if sawDev {
		t.Error("non-production frontend leaked into launcher")
	}

	// Menu HTML renders the AOC/dashboard rows + the group + the frontend.
	menu := baileyLauncherMenuHTML(d)
	if !strings.Contains(menu, "Bailey dashboard") {
		t.Error("menu missing dashboard row")
	}
	if !strings.Contains(menu, "My Workspace") || !strings.Contains(menu, "App Frontend") {
		t.Error("menu missing workspace/frontend entries")
	}
}

func TestBaileyLauncherMenuHTML_EmptyGroupShowsNoFrontends(t *testing.T) {
	d := launcherData{
		Workspaces: []launcherWorkspace{
			{Name: "Lonely", URL: "https://lonely.example.com"},
		},
	}
	menu := baileyLauncherMenuHTML(d)
	if !strings.Contains(menu, "No frontends you can open") {
		t.Error("empty group did not render the no-frontends note")
	}
}

// --- serverconsole.go ---------------------------------------------------

func TestIsServerConsoleHost(t *testing.T) {
	domain := writeTestConfig(t)
	if !isServerConsoleHost("bailey." + domain) {
		t.Error("bailey.<domain> not recognised as console host")
	}
	if isServerConsoleHost("app." + domain) {
		t.Error("app host wrongly recognised as console host")
	}
	if !isServerConsoleHost("BAILEY." + strings.ToUpper(domain)) {
		// EqualFold should accept different casing.
		t.Error("case-insensitive console host match failed")
	}
}

// Regression test for #150: reloading a client-side console route whose
// path is ALSO a real directory in the dist (e.g. /handbook — a console
// route AND the handbook/ asset dir) must serve the SPA shell, never a
// FileServer directory listing.
func TestServeServerConsole_SPAFallbackNeverListsDirectories(t *testing.T) {
	writeTestConfig(t)
	saved := serverConsoleRoot
	serverConsoleRoot = fstest.MapFS{
		"index.html":             {Data: []byte("<html><body>console-shell</body></html>")},
		"assets/app.js":          {Data: []byte("console.log('bundle')")},
		"handbook/handbook.html": {Data: []byte("<html><body>handbook doc</body></html>")},
		"handbook/handbook.pdf":  {Data: []byte("%PDF-fake")},
	}
	t.Cleanup(func() { serverConsoleRoot = saved })

	get := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "https://bailey.test.example.com"+path, nil)
		r.Host = "bailey.test.example.com"
		w := httptest.NewRecorder()
		serveServerConsole(w, r)
		return w
	}

	// (a) A real static asset is served as-is.
	if w := get("/assets/app.js"); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), "console.log('bundle')") {
		t.Errorf("/assets/app.js: code=%d body=%q, want the asset bytes", w.Code, w.Body.String())
	}
	// A real file inside the shadowed directory is still served as-is.
	if w := get("/handbook/handbook.html"); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), "handbook doc") {
		t.Errorf("/handbook/handbook.html: code=%d body=%q, want the file", w.Code, w.Body.String())
	}

	// (b) A client-route-looking path with no matching file falls back to
	// the SPA shell with 200.
	if w := get("/users"); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), "console-shell") {
		t.Errorf("/users: code=%d body=%q, want index.html shell", w.Code, w.Body.String())
	}

	// (c) A path that names a real DIRECTORY must serve the shell too,
	// never a directory listing (#150).
	for _, path := range []string{"/handbook", "/handbook/", "/assets"} {
		w := get(path)
		if w.Code != http.StatusOK {
			t.Errorf("%s: code=%d, want 200", path, w.Code)
			continue
		}
		body := w.Body.String()
		if !strings.Contains(body, "console-shell") {
			t.Errorf("%s: body=%q, want index.html shell", path, body)
		}
		if strings.Contains(body, "handbook.pdf") || strings.Contains(body, "<pre>") {
			t.Errorf("%s: served a directory listing: %q", path, body)
		}
	}
}

func TestServeServerConsole_ServesSPAAndSetsCSP(t *testing.T) {
	writeTestConfig(t)
	for _, path := range []string{"/", "/some/spa/route", "/index.html"} {
		r := httptest.NewRequest(http.MethodGet, "https://bailey.test.example.com"+path, nil)
		r.Host = "bailey.test.example.com"
		w := httptest.NewRecorder()
		serveServerConsole(w, r)
		if w.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", path, w.Code)
		}
		csp := w.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "frame-ancestors") {
			t.Errorf("%s: CSP missing frame-ancestors: %q", path, csp)
		}
		if w.Header().Get("X-Frame-Options") != "" {
			t.Errorf("%s: X-Frame-Options should be deleted", path)
		}
	}
}
