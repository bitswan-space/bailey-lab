package daemon

import "strings"

// parseUserAgent derives a human-facing (deviceKind, browser, os) from a
// device's self-reported User-Agent. This is presentation of what the device
// told us at pairing time — not an inference about identity or relationships.
// A UA is the only place this information exists, and UAs are imprecise, so an
// unrecognized field comes back empty/"unknown" and the UI shows an honest
// "Unknown device" rather than guessing.
//
// deviceKind is one of: "phone", "tablet", "laptop", "unknown".
// browser/os are "" when not recognized.
func parseUserAgent(ua string) (deviceKind, browser, os string) {
	if strings.TrimSpace(ua) == "" {
		return "unknown", "", ""
	}
	l := strings.ToLower(ua)

	// OS — order matters (iOS/Android before the desktop families).
	switch {
	case strings.Contains(l, "iphone") || strings.Contains(l, "ipod"):
		os = "iOS"
	case strings.Contains(l, "ipad"):
		os = "iPadOS"
	case strings.Contains(l, "android"):
		os = "Android"
	case strings.Contains(l, "cros"):
		os = "ChromeOS"
	case strings.Contains(l, "windows"):
		os = "Windows"
	case strings.Contains(l, "mac os x") || strings.Contains(l, "macintosh"):
		os = "macOS"
	case strings.Contains(l, "linux"):
		os = "Linux"
	}

	// Browser — check the disambiguating tokens first (Edge and Chrome both
	// contain "safari"; Chrome contains "safari"; CriOS/FxiOS are the iOS
	// builds of Chrome/Firefox).
	switch {
	case strings.Contains(l, "edg/") || strings.Contains(l, "edga/") || strings.Contains(l, "edgios/"):
		browser = "Edge"
	case strings.Contains(l, "opr/") || strings.Contains(l, "opera"):
		browser = "Opera"
	case strings.Contains(l, "firefox/") || strings.Contains(l, "fxios/"):
		browser = "Firefox"
	case strings.Contains(l, "crios/") || strings.Contains(l, "chrome/"):
		browser = "Chrome"
	case strings.Contains(l, "safari/"):
		browser = "Safari"
	}

	// Device kind. Android with "mobile" is a phone; Android without is a
	// tablet (Google's documented convention). iPad → tablet; iPhone → phone.
	switch {
	case strings.Contains(l, "ipad") || (strings.Contains(l, "tablet")):
		deviceKind = "tablet"
	case strings.Contains(l, "iphone") || strings.Contains(l, "ipod"):
		deviceKind = "phone"
	case strings.Contains(l, "android"):
		if strings.Contains(l, "mobile") {
			deviceKind = "phone"
		} else {
			deviceKind = "tablet"
		}
	case strings.Contains(l, "mobile"):
		deviceKind = "phone"
	case strings.Contains(l, "windows") || strings.Contains(l, "macintosh") ||
		strings.Contains(l, "mac os x") || strings.Contains(l, "linux") || strings.Contains(l, "cros"):
		deviceKind = "laptop"
	default:
		deviceKind = "unknown"
	}
	return deviceKind, browser, os
}

// userAgentLabel is a short "Browser on OS" summary, with graceful degradation
// when only one half is known. "" when nothing is recognizable (the caller
// shows "Unknown device").
func userAgentLabel(ua string) string {
	_, browser, os := parseUserAgent(ua)
	switch {
	case browser != "" && os != "":
		return browser + " on " + os
	case browser != "":
		return browser
	case os != "":
		return os
	default:
		return ""
	}
}
