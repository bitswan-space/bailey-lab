package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Issue #425: whether a request is a top-level document navigation decides
// whether the gate may answer it with an HTML scene, whether the outer host
// serves the chrome wrap, and whether a trusted device is bounced off the
// onboarding host. Asking `Accept` was the bug: it states what a client will
// ACCEPT, not what the request IS, and privacy extensions and proxies rewrite
// it to `*/*` on real navigations. Sec-Fetch-Dest is set by the browser itself
// and states the answer outright.
func TestIsTopLevelHTMLGet(t *testing.T) {
	for _, tc := range []struct {
		name   string
		method string
		dest   string
		accept string
		want   bool
	}{
		{"document navigation, conventional accept", http.MethodGet, "document", "text/html,application/xhtml+xml", true},
		{"document navigation, accept rewritten to */*", http.MethodGet, "document", "*/*", true},
		{"document navigation, accept stripped entirely", http.MethodGet, "document", "", true},
		{"document navigation, accept is xhtml only", http.MethodGet, "document", "application/xhtml+xml", true},
		{"iframe navigation (the chrome wrap's own frame)", http.MethodGet, "iframe", "*/*", true},
		{"frame navigation", http.MethodGet, "frame", "*/*", true},

		{"background fetch, even when it claims to accept html", http.MethodGet, "empty", "text/html", false},
		{"script subresource", http.MethodGet, "script", "text/html", false},
		{"stylesheet subresource", http.MethodGet, "style", "text/html", false},
		{"image subresource", http.MethodGet, "image", "text/html", false},

		{"no sec-fetch-dest, conventional accept: the legacy fallback", http.MethodGet, "", "text/html,application/xhtml+xml", true},
		{"no sec-fetch-dest, accept rewritten: indistinguishable, so no", http.MethodGet, "", "*/*", false},

		{"POST is never a top-level document GET", http.MethodPost, "document", "text/html", false},
		{"HEAD is never a top-level document GET", http.MethodHead, "document", "text/html", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "https://host.example.com/", nil)
			if tc.dest != "" {
				r.Header.Set("Sec-Fetch-Dest", tc.dest)
			}
			if tc.accept != "" {
				r.Header.Set("Accept", tc.accept)
			}
			if got := isTopLevelHTMLGet(r); got != tc.want {
				t.Errorf("isTopLevelHTMLGet() = %v, want %v (Sec-Fetch-Dest=%q Accept=%q)",
					got, tc.want, tc.dest, tc.accept)
			}
		})
	}
}

// The consequence #425 was actually reported as: a browser that rewrites
// `Accept` could not reach the console at all. The onboarding page hands a
// trusted device to the console host, and that host answered a real page load
// with 404 whenever `Accept` did not mention text/html — so the operator was
// stranded no matter which way they were sent.
func TestConsoleHostServesNavigationWithRewrittenAccept(t *testing.T) {
	domain := writeTestConfig(t)
	console := serverConsoleHost(domain)

	for _, tc := range []struct {
		name   string
		dest   string
		accept string
	}{
		{"accept rewritten to */*", "document", "*/*"},
		{"accept stripped entirely", "document", ""},
		{"accept is xhtml only", "document", "application/xhtml+xml"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "https://"+console+"/", nil)
			r.Host = console
			r.Header.Set("Sec-Fetch-Dest", tc.dest)
			if tc.accept != "" {
				r.Header.Set("Accept", tc.accept)
			}
			r.Header.Set("X-Forwarded-Email", "op@example.com")
			w := httptest.NewRecorder()
			wrappedHandler(t).ServeHTTP(w, trust(t, r, "op@example.com"))

			if w.Code == http.StatusNotFound {
				t.Fatalf("console host answered a real page load with 404 (Accept=%q)", tc.accept)
			}
			if w.Code != http.StatusOK {
				t.Fatalf("console host status = %d, want 200 (Accept=%q)", w.Code, tc.accept)
			}
			if !strings.Contains(w.Body.String(), "Protected by Bitswan") {
				t.Error("console host did not serve the chrome wrap")
			}
		})
	}
}

// A background fetch must NOT be handed an HTML document, whatever it claims to
// accept — that is the shell-smuggling shape #403 closed, and the fix must not
// re-open it while making navigations work.
func TestConsoleHostStillRefusesBackgroundFetch(t *testing.T) {
	domain := writeTestConfig(t)
	console := serverConsoleHost(domain)

	r := httptest.NewRequest(http.MethodGet, "https://"+console+"/", nil)
	r.Host = console
	r.Header.Set("Sec-Fetch-Dest", "empty")
	r.Header.Set("Accept", "text/html")
	r.Header.Set("X-Forwarded-Email", "op@example.com")
	w := httptest.NewRecorder()
	wrappedHandler(t).ServeHTTP(w, trust(t, r, "op@example.com"))

	if w.Code != http.StatusNotFound {
		t.Fatalf("background fetch status = %d, want 404 — it was served a document", w.Code)
	}
}

// gate-state tells the onboarding SPA where a trusted device belongs, so the
// SPA can navigate there instead of re-requesting its own document and hoping
// for a redirect. The server keeps owning the destination.
func TestGateStateNamesWhereATrustedDeviceGoes(t *testing.T) {
	domain := writeTestConfig(t)
	onboard := serverConsoleOnboardHost(domain)
	console := serverConsoleHost(domain)
	const email = "op@example.com"

	read := func(t *testing.T, host string, origin string) gateState {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "https://"+host+"/bailey/api/gate-state", nil)
		r.Host = host
		r.Header.Set("X-Forwarded-Email", email)
		r = trust(t, r, email)
		if origin != "" {
			r.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: origin})
		}
		w := httptest.NewRecorder()
		handleGateState(w, r, email, nil)
		var gs gateState
		if err := json.Unmarshal(w.Body.Bytes(), &gs); err != nil {
			t.Fatalf("gate-state is not JSON: %v (%s)", err, w.Body.String())
		}
		return gs
	}

	t.Run("defaults to the console root", func(t *testing.T) {
		gs := read(t, onboard, "")
		if !gs.Trusted {
			t.Fatal("test device should be trusted")
		}
		if want := "https://" + console + "/"; gs.LeaveTo != want {
			t.Errorf("leave_to = %q, want %q", gs.LeaveTo, want)
		}
	})

	t.Run("prefers the origin the device was bounced from", func(t *testing.T) {
		deep := "https://app." + domain + "/secret"
		if gs := read(t, onboard, deep); gs.LeaveTo != deep {
			t.Errorf("leave_to = %q, want the stashed origin %q", gs.LeaveTo, deep)
		}
	})

	t.Run("never points back at the onboarding host", func(t *testing.T) {
		planted := "https://" + onboard + "/?invite=x"
		gs := read(t, onboard, planted)
		if strings.Contains(gs.LeaveTo, onboard) {
			t.Errorf("leave_to = %q — a planted cookie bounced the device back to onboarding", gs.LeaveTo)
		}
	})

	t.Run("is empty off the onboarding host", func(t *testing.T) {
		if gs := read(t, console, ""); gs.LeaveTo != "" {
			t.Errorf("leave_to = %q on the console host, want empty", gs.LeaveTo)
		}
	})
}

// rememberOrigin scopes _bailey_origin to the protected domain, so the deletion
// has to name the same Domain or it expires a different (host-only) cookie and
// the real one survives to hijack the next gate clearance.
func TestOriginCookieIsClearedAtTheDomainItWasSetOn(t *testing.T) {
	writeTestConfig(t)
	wantDomain := cookieDomainForProtected()
	if wantDomain == "" {
		t.Skip("no cookie domain for the test config")
	}

	w := httptest.NewRecorder()
	clearOriginCookie(w)

	for _, c := range w.Result().Cookies() {
		if c.Name != gateOriginCookie {
			continue
		}
		if c.MaxAge >= 0 {
			t.Errorf("MaxAge = %d, want negative (an expiry)", c.MaxAge)
		}
		if !strings.EqualFold(strings.TrimPrefix(c.Domain, "."), strings.TrimPrefix(wantDomain, ".")) {
			t.Errorf("clearing Domain = %q, want %q — the domain-scoped cookie survives", c.Domain, wantDomain)
		}
		return
	}
	t.Fatal("no _bailey_origin cookie was set to clear it")
}
