package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// The save page exists because the console cannot get a browser to offer to save
// a credential from where it lives — inside a cross-origin iframe on the inner
// host. Everything asserted here is a property that, if lost, silently returns it
// to producing no prompt at all, which is exactly how the first attempt failed.

func TestKeySavePageServesALoginFormTheBrowserCanRecognise(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := backup.SaveKey("THE-BACKUP-KEY"); err != nil {
		t.Fatal(err)
	}

	var s Server
	w := httptest.NewRecorder()
	s.handleBaileyKeySavePage(w, httptest.NewRequest(http.MethodGet, keySavePagePath, nil))

	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	body := w.Body.String()

	for _, want := range []string{
		// A real submit to a real path. The previous attempt called
		// preventDefault(), and a submission without a navigation is the signal
		// browsers ignore.
		`method="post"`,
		`action="/bailey/key-save"`,
		`type="submit"`,
		// Managers key off a form holding a username AND a new-password field.
		`autocomplete="username"`,
		`autocomplete="new-password"`,
		`type="password"`,
		"THE-BACKUP-KEY",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("save page missing %q", want)
		}
	}

	// The key is in the document, so it must not be retained by the browser.
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store: the key is in this page", cc)
	}
}

// The page the submit lands on decides whether the browser believes the login
// succeeded. A password field here reads as "asked again", i.e. failed.
func TestKeySaveSubmitLandsOnAPageWithNoPasswordField(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := backup.SaveKey("THE-BACKUP-KEY"); err != nil {
		t.Fatal(err)
	}

	var s Server
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, keySavePagePath,
		strings.NewReader("username=backup-key%40x&password=THE-BACKUP-KEY"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	s.handleBaileyKeySavePage(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("the submit must land on a real page, got %d", w.Code)
	}
	body := w.Body.String()
	if strings.Contains(body, `type="password"`) {
		t.Error("the landing page must not contain a password field")
	}
	// The endpoint stores nothing; echoing the key back would put it somewhere
	// new for no reason.
	if strings.Contains(body, "THE-BACKUP-KEY") {
		t.Error("the posted key must not be echoed into the response")
	}
}

func TestKeySavePageWithoutAKeyExplainsItself(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var s Server
	w := httptest.NewRecorder()
	s.handleBaileyKeySavePage(w, httptest.NewRequest(http.MethodGet, keySavePagePath, nil))

	if w.Code != http.StatusNotFound {
		t.Errorf("code = %d, want 404", w.Code)
	}
	if !strings.Contains(w.Body.String(), "No backup key yet") {
		t.Errorf("body should say why there is nothing to save: %s", w.Body.String())
	}
}

// Without this the SPA catch-all serves index.html for the path, the popup shows
// the console instead of the form, and the feature is silently back to broken.
func TestKeySavePageIsRoutedToTheDaemonNotTheSPA(t *testing.T) {
	if !isBaileyDataPath(keySavePagePath) {
		t.Error("the save page must bypass the SPA index.html fallback")
	}
}
