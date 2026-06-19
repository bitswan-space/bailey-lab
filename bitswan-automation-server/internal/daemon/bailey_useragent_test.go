package daemon

import "testing"

func TestParseUserAgent(t *testing.T) {
	cases := []struct {
		name              string
		ua                string
		kind, browser, os string
	}{
		{"empty", "", "unknown", "", ""},
		{"chrome on mac",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
			"laptop", "Chrome", "macOS"},
		{"safari on iphone",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
			"phone", "Safari", "iOS"},
		{"firefox on windows",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
			"laptop", "Firefox", "Windows"},
		{"edge on windows",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0",
			"laptop", "Edge", "Windows"},
		{"chrome on android phone",
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
			"phone", "Chrome", "Android"},
		{"android tablet (no Mobile token)",
			"Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
			"tablet", "Chrome", "Android"},
		{"safari on ipad",
			"Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1",
			"tablet", "Safari", "iPadOS"},
		{"unrecognized",
			"SomeRandomBot/1.0",
			"unknown", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			k, b, o := parseUserAgent(c.ua)
			if k != c.kind || b != c.browser || o != c.os {
				t.Errorf("parseUserAgent(%q) = (%q,%q,%q); want (%q,%q,%q)", c.ua, k, b, o, c.kind, c.browser, c.os)
			}
		})
	}
}

func TestUserAgentLabel(t *testing.T) {
	cases := map[string]string{
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/124.0 Safari/537.36": "Chrome on macOS",
		"":                              "",
		"SomeRandomBot/1.0":             "",
		"Mozilla/5.0 (Windows NT 10.0)": "Windows", // OS only, no recognizable browser
	}
	for ua, want := range cases {
		if got := userAgentLabel(ua); got != want {
			t.Errorf("userAgentLabel(%q) = %q; want %q", ua, got, want)
		}
	}
}

// The requesting device's User-Agent must survive a store round-trip and be
// preserved across a later no-UA refresh of the same pending entry.
func TestPendingPairUserAgentRoundTrip(t *testing.T) {
	email := "ua-roundtrip@example.com"
	t.Cleanup(func() { _ = dbDeletePendingPairByEmail(email) })

	ua := "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124.0 Safari/537.36"
	if _, err := generatePendingPairUA(email, ua); err != nil {
		t.Fatal(err)
	}
	got, err := dbLoadPendingPairByEmail(email)
	if err != nil || got == nil {
		t.Fatalf("load: %v (nil=%v)", err, got == nil)
	}
	if got.UserAgent != ua {
		t.Fatalf("UserAgent = %q; want %q", got.UserAgent, ua)
	}

	// A no-UA refresh (e.g. a different code-mint path) must NOT erase it.
	if _, err := generatePendingPair(email); err != nil {
		t.Fatal(err)
	}
	got2, _ := dbLoadPendingPairByEmail(email)
	if got2 == nil || got2.UserAgent != ua {
		t.Fatalf("UA not preserved across no-UA refresh: got %q", func() string {
			if got2 == nil {
				return "<nil>"
			}
			return got2.UserAgent
		}())
	}
}
