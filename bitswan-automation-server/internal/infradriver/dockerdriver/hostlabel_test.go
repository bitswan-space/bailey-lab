package dockerdriver

import (
	"strings"
	"testing"
)

func TestMakeHostnameLabel_63Cap(t *testing.T) {
	// Short names keep the readable format and stay under the limit.
	short := makeHostnameLabel("wraptest", "frontend", "test2", "production", "green")
	if len(short) > maxLabelLen {
		t.Errorf("short label %q len %d > %d", short, len(short), maxLabelLen)
	}
	if !strings.HasSuffix(short, "-green") {
		t.Errorf("short label %q lost its slot suffix", short)
	}

	// Worst case: long workspace + automation names + production + a long color
	// slot. Must stay <= 63 AND keep the slot suffix (so slots stay distinct).
	lws := strings.Repeat("w", 40)
	lan := strings.Repeat("a", 40)
	purple := makeHostnameLabel(lws, lan, "somecontext", "production", "purple")
	if len(purple) > maxLabelLen {
		t.Errorf("worst-case label len %d > %d: %q", len(purple), maxLabelLen, purple)
	}
	if !strings.HasSuffix(purple, "-purple") {
		t.Errorf("worst-case label dropped slot suffix: %q", purple)
	}
	// A different slot on the same long names must yield a DIFFERENT label.
	blue := makeHostnameLabel(lws, lan, "somecontext", "production", "blue")
	if blue == purple {
		t.Error("blue and purple collapsed to the same label under truncation")
	}
	if len(blue) > maxLabelLen {
		t.Errorf("blue label len %d > %d", len(blue), maxLabelLen)
	}
}
