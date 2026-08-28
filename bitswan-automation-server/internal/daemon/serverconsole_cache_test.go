package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The console's caching has to answer two different questions, because it
// serves two different kinds of URL:
//
//   - assets/index-<hash>.js — the URL names its own content, so it can never
//     go stale and should be cached as long as possible.
//   - index.html — a fixed URL whose only job is to name the hashed bundle. If
//     that is cached, the browser stays pinned to the old bundle and a deploy
//     that changed everything appears to change nothing.
//
// Getting these the wrong way round is the "I deployed but still see the old
// UI" bug, so each direction is asserted separately.

func TestConsoleCache_HashedAssetsAreImmutable(t *testing.T) {
	for _, p := range []string{
		"assets/index-MHpSpLrB.js",
		"assets/index-NZD4fwrJ.css",
		"assets/some-font.woff2",
	} {
		w := httptest.NewRecorder()
		setConsoleCacheHeaders(w, p)
		cc := w.Header().Get("Cache-Control")
		if !strings.Contains(cc, "immutable") {
			t.Errorf("%s: Cache-Control = %q, want an immutable policy", p, cc)
		}
		if !strings.Contains(cc, "max-age=31536000") {
			t.Errorf("%s: Cache-Control = %q, want a one-year max-age", p, cc)
		}
	}
}

// Everything with a stable filename must be revalidated, whatever it is: the
// shell, the favicon, the handbook. Only the hashed directory is exempt.
func TestConsoleCache_StableNamesAreRevalidated(t *testing.T) {
	for _, p := range []string{
		"",
		"index.html",
		"favicon.svg",
		"handbook/handbook.html",
		"handbook/handbook.pdf",
		// A near-miss on the asset prefix must NOT be treated as hashed.
		"assets-old/index.js",
		"myassets/x.js",
	} {
		w := httptest.NewRecorder()
		setConsoleCacheHeaders(w, p)
		cc := w.Header().Get("Cache-Control")
		if cc != "no-cache" {
			t.Errorf("%q: Cache-Control = %q, want %q", p, cc, "no-cache")
		}
		if strings.Contains(cc, "immutable") {
			t.Errorf("%q: a stable filename was cached as immutable", p)
		}
	}
}

// no-cache means "ask before reusing", so the asking has to be cheap —
// otherwise revalidating the 13 MB handbook means refetching it. That is what
// the ETag is for, and embed.FS gives us no Last-Modified to fall back on.
func TestConsoleCache_ShellCarriesAnETagAndAnswers304(t *testing.T) {
	raw := []byte("<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>")

	first := httptest.NewRecorder()
	writeConsoleShell(first, httptest.NewRequest(http.MethodGet, "https://bailey.example.com/", nil), raw, "console")
	if first.Code != http.StatusOK {
		t.Fatalf("first load = %d, want 200", first.Code)
	}
	if got := first.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("shell Cache-Control = %q, want no-cache", got)
	}
	tag := first.Header().Get("ETag")
	if tag == "" {
		t.Fatal("shell has no ETag, so a revalidation would refetch the whole body")
	}
	if !strings.HasPrefix(tag, `"`) || strings.HasPrefix(tag, "W/") {
		t.Errorf("ETag = %q, want a quoted strong tag", tag)
	}
	if first.Body.Len() == 0 {
		t.Error("first load returned no body")
	}

	// The browser comes back with what it was given.
	second := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/", nil)
	r.Header.Set("If-None-Match", tag)
	writeConsoleShell(second, r, raw, "console")
	if second.Code != http.StatusNotModified {
		t.Fatalf("revalidation = %d, want 304", second.Code)
	}
	if second.Body.Len() != 0 {
		t.Errorf("304 carried a %d-byte body", second.Body.Len())
	}
}

// The point of revalidating the shell: when it changes, the browser must be
// told, or it keeps loading the previous bundle by name.
func TestConsoleCache_ChangedShellGetsANewETag(t *testing.T) {
	oldShell := []byte(`<html><head></head><body><script src="/assets/index-AAAA.js"></script></body></html>`)
	newShell := []byte(`<html><head></head><body><script src="/assets/index-BBBB.js"></script></body></html>`)

	w1 := httptest.NewRecorder()
	writeConsoleShell(w1, httptest.NewRequest(http.MethodGet, "https://bailey.example.com/", nil), oldShell, "console")
	oldTag := w1.Header().Get("ETag")

	// The browser revalidates with the tag it holds, against the NEW shell.
	w2 := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/", nil)
	r.Header.Set("If-None-Match", oldTag)
	writeConsoleShell(w2, r, newShell, "console")

	if w2.Code != http.StatusOK {
		t.Fatalf("a changed shell answered %d; the browser would keep the old bundle", w2.Code)
	}
	if w2.Header().Get("ETag") == oldTag {
		t.Error("a changed shell reused its old ETag")
	}
	if !strings.Contains(w2.Body.String(), "index-BBBB.js") {
		t.Error("the new shell's body was not sent")
	}
}

func TestClientHasETag(t *testing.T) {
	const tag = `"abc123"`
	yes := []string{
		tag,
		"*",
		`"other", ` + tag,
		"W/" + tag,
		` ` + tag + ` `,
	}
	for _, inm := range yes {
		r := httptest.NewRequest(http.MethodGet, "https://x/", nil)
		r.Header.Set("If-None-Match", inm)
		if !clientHasETag(r, tag) {
			t.Errorf("If-None-Match: %q should match %s", inm, tag)
		}
	}

	no := []string{"", `"nope"`, `"abc12"`, `"abc1234"`}
	for _, inm := range no {
		r := httptest.NewRequest(http.MethodGet, "https://x/", nil)
		if inm != "" {
			r.Header.Set("If-None-Match", inm)
		}
		if clientHasETag(r, tag) {
			t.Errorf("If-None-Match: %q should NOT match %s", inm, tag)
		}
	}

	// No tag to compare against can never be a match, even for "*".
	r := httptest.NewRequest(http.MethodGet, "https://x/", nil)
	r.Header.Set("If-None-Match", "*")
	if clientHasETag(r, "") {
		t.Error("an empty ETag matched *")
	}
}

func TestETagFor_DistinguishesContent(t *testing.T) {
	a := etagFor([]byte("one"))
	b := etagFor([]byte("two"))
	if a == b {
		t.Error("different content produced the same ETag")
	}
	if a != etagFor([]byte("one")) {
		t.Error("the same content produced different ETags")
	}
	for _, tag := range []string{a, b} {
		if !strings.HasPrefix(tag, `"`) || !strings.HasSuffix(tag, `"`) {
			t.Errorf("ETag %q is not quoted, which makes it invalid in the header", tag)
		}
	}
}

// The map is built from the embedded tree. The repo ships that tree as a lone
// .gitkeep (make console fills it), so this asserts the mechanism rather than
// a particular bundle: every regular file present gets a tag, and lookups for
// files that aren't there simply yield none.
func TestConsoleETags_CoversEmbeddedFilesOnly(t *testing.T) {
	tags := consoleETags()
	for p, tag := range tags {
		if tag == "" {
			t.Errorf("%s mapped to an empty ETag", p)
		}
		if strings.HasSuffix(p, "/") {
			t.Errorf("%s looks like a directory; only files should be tagged", p)
		}
	}
	if _, ok := tags["assets/definitely-not-in-the-bundle.js"]; ok {
		t.Error("a file that isn't embedded has an ETag")
	}

	// A path with no tag must still get a Cache-Control — the policy is
	// decided by the URL shape, not by whether we could hash the file.
	w := httptest.NewRecorder()
	setConsoleCacheHeaders(w, "assets/definitely-not-in-the-bundle.js")
	if !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Error("an untagged asset lost its cache policy")
	}
	if w.Header().Get("ETag") != "" {
		t.Error("an untagged asset was given an ETag out of nowhere")
	}
}

// The same "/" serves a DIFFERENT document on the onboarding host than on the
// console host — the mode meta the SPA obeys (#403). The ETag is computed after
// that injection, so the two can never be conflated into one cache entry.
func TestConsoleCache_ShellETagCoversTheConsoleMode(t *testing.T) {
	raw := []byte("<!doctype html><html><head></head><body></body></html>")
	req := func() *http.Request {
		return httptest.NewRequest(http.MethodGet, "https://bailey.example.com/", nil)
	}

	consoleW := httptest.NewRecorder()
	writeConsoleShell(consoleW, req(), raw, "console")
	onboardW := httptest.NewRecorder()
	writeConsoleShell(onboardW, req(), raw, "onboarding")

	if consoleW.Header().Get("ETag") == onboardW.Header().Get("ETag") {
		t.Fatal("the console and onboarding shells share an ETag; one could be served for the other")
	}
	if !strings.Contains(consoleW.Body.String(), `content="console"`) {
		t.Error("console shell is missing its mode statement")
	}
	if !strings.Contains(onboardW.Body.String(), `content="onboarding"`) {
		t.Error("onboarding shell is missing its mode statement")
	}

	// Revalidating with the OTHER host's tag must return the right document,
	// not a 304 that would leave the wrong mode in place.
	r := req()
	r.Header.Set("If-None-Match", onboardW.Header().Get("ETag"))
	w := httptest.NewRecorder()
	writeConsoleShell(w, r, raw, "console")
	if w.Code != http.StatusOK {
		t.Fatalf("cross-mode revalidation = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), `content="console"`) {
		t.Error("cross-mode revalidation did not send the console shell")
	}
}
