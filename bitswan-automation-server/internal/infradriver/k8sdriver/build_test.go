package k8sdriver

import "testing"

func TestSplitRefTakesTheTagAfterTheLastColon(t *testing.T) {
	for _, tc := range []struct {
		ref             string
		host, repo, tag string
		ok              bool
	}{
		{"bitswan-registry:5000/bitswan/inv:abc123", "bitswan-registry:5000", "bitswan/inv", "abc123", true},
		{"registry:5000/x:1", "registry:5000", "x", "1", true},
		{"example.com/x:1", "example.com", "x", "1", true},
		{"bitswan-registry:5000/bitswan/inv", "", "", "", false},
		{"noslash:1", "", "", "", false},
	} {
		host, repo, tag, ok := splitRef(tc.ref)
		if ok != tc.ok || host != tc.host || repo != tc.repo || tag != tc.tag {
			t.Errorf("splitRef(%q) = (%q,%q,%q,%v), want (%q,%q,%q,%v)",
				tc.ref, host, repo, tag, ok, tc.host, tc.repo, tc.tag, tc.ok)
		}
	}
}
