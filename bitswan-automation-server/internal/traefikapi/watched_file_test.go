package traefikapi

import (
	"os"
	"path/filepath"
	"testing"
)

// writeWatchedFile must end up with exactly the new content whether the file
// grows, shrinks, or doesn't exist yet — the shrink case is where a plain
// non-truncating write would leave a stale tail, and the create case is the
// first write for a brand-new (workspace) traefik.
func TestWriteWatchedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dynamic.yml")

	cases := []struct {
		name    string
		content string
	}{
		{"create", "http:\n  routers: {}\n"},
		{"grow", "http:\n  routers:\n    a:\n      rule: Host(`a.example`)\n"},
		{"shrink", "http: {}\n"},
	}
	for _, c := range cases {
		if err := writeWatchedFile(path, []byte(c.content)); err != nil {
			t.Fatalf("%s: writeWatchedFile: %v", c.name, err)
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: read back: %v", c.name, err)
		}
		if string(got) != c.content {
			t.Errorf("%s: content mismatch\n got: %q\nwant: %q", c.name, got, c.content)
		}
	}
}
