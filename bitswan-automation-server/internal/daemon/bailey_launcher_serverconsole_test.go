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

// A handbook the build does not carry must come back as a 404, not as the SPA
// shell. The shell fallback made the absence invisible: "GET
// /handbook/handbook.pdf" answered 200 text/html, so "Download PDF" saved the
// console's own HTML under a .pdf name and "Read the handbook" just rendered
// the console again in a new tab.
func TestServeServerConsole_MissingAssetIsNotDisguisedAsTheShell(t *testing.T) {
	writeTestConfig(t)
	saved := serverConsoleRoot
	serverConsoleRoot = fstest.MapFS{
		"index.html":        {Data: []byte("<html><head></head><body>console-shell</body></html>")},
		"assets/app.js":     {Data: []byte("console.log('bundle')")},
		"handbook/.gitkeep": {Data: []byte("")},
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

	// Missing files inside a real dist directory are honest 404s.
	for _, path := range []string{"/handbook/handbook.html", "/handbook/handbook.pdf", "/assets/gone.js"} {
		w := get(path)
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: code=%d body=%q, want 404", path, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "console-shell") {
			t.Errorf("%s: served the SPA shell instead of 404", path)
		}
	}
	// Client-side routes are untouched — including /handbook itself, and a
	// deep link whose param contains dots (an email), which must never be
	// mistaken for a file.
	for _, path := range []string{"/handbook", "/handbook/", "/users", "/users/ada@example.com", "/assets"} {
		w := get(path)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "console-shell") {
			t.Errorf("%s: code=%d body=%q, want the SPA shell", path, w.Code, w.Body.String())
		}
	}
}

// The console cannot discover whether a handbook exists by fetching for it, so
// the daemon declares what it carries in the shell HTML. The tag is always
// present; an empty value is the honest "this build has none".
func TestHandbookFormats_DeclaredInTheShell(t *testing.T) {
	writeTestConfig(t)
	saved := serverConsoleRoot
	t.Cleanup(func() { serverConsoleRoot = saved })

	shell := map[string]*fstest.MapFile{
		"index.html": {Data: []byte("<html><head></head><body>console-shell</body></html>")},
	}
	cases := []struct {
		name    string
		files   map[string]*fstest.MapFile
		want    []string
		wantTag string
	}{
		{
			name:    "no handbook staged",
			files:   map[string]*fstest.MapFile{"handbook/.gitkeep": {Data: []byte("")}},
			want:    nil,
			wantTag: `<meta name="bitswan-handbook" content="">`,
		},
		{
			name:    "html only",
			files:   map[string]*fstest.MapFile{"handbook/handbook.html": {Data: []byte("<html>doc</html>")}},
			want:    []string{"html"},
			wantTag: `<meta name="bitswan-handbook" content="html">`,
		},
		{
			name: "html and pdf",
			files: map[string]*fstest.MapFile{
				"handbook/handbook.html": {Data: []byte("<html>doc</html>")},
				"handbook/handbook.pdf":  {Data: []byte("%PDF-fake")},
			},
			want:    []string{"html", "pdf"},
			wantTag: `<meta name="bitswan-handbook" content="html,pdf">`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fsys := fstest.MapFS{}
			for k, v := range shell {
				fsys[k] = v
			}
			for k, v := range tc.files {
				fsys[k] = v
			}
			serverConsoleRoot = fsys

			got := handbookFormats()
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("handbookFormats() = %v, want %v", got, tc.want)
			}
			r := httptest.NewRequest(http.MethodGet, "https://bailey.test.example.com/handbook", nil)
			r.Host = "bailey.test.example.com"
			w := httptest.NewRecorder()
			serveServerConsole(w, r)
			if !strings.Contains(w.Body.String(), tc.wantTag) {
				t.Errorf("shell missing %s\ngot: %s", tc.wantTag, w.Body.String())
			}
		})
	}
}
