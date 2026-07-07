package daemon

import (
	"strings"
	"testing"
)

// The iframe must be sized with percentages (which track the dynamic layout
// viewport), never vh: on tablets 100vh is the largest viewport, so a
// vh-derived height overflows the visible area when the browser bar is shown
// and the app's bottom-anchored UI lands behind the Bailey footer (issue #78).
func TestChromeWrapIframeSizedByPercentagesNotVh(t *testing.T) {
	html := baileyChromeHTML("a@b.c", "app.example.com", "https://inner.example.com/", false, launcherData{})
	iframeRule := "iframe.bailey-content { position: fixed; inset: 0 0 28px 0; width: 100%; height: calc(100% - 28px);"
	if !strings.Contains(html, iframeRule) {
		t.Fatalf("iframe CSS rule not rendered as expected")
	}
	if strings.Contains(html, "%!") {
		t.Fatalf("format verb error in rendered HTML")
	}
}
