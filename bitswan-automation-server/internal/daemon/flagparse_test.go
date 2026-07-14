package daemon

import (
	"flag"
	"io"
	"testing"
)

// parseFlagsInterspersed must honour flags regardless of their position
// relative to positionals — the CLI forwards raw argv and std flag alone
// stops at the first non-flag token, silently dropping trailing flags
// (`workspace init zztest --dev` used to ignore --dev).
func TestParseFlagsInterspersed(t *testing.T) {
	newFS := func() (*flag.FlagSet, *bool, *string) {
		fs := flag.NewFlagSet("t", flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		dev := fs.Bool("dev", false, "")
		domain := fs.String("domain", "", "")
		return fs, dev, domain
	}

	cases := []struct {
		name string
		args []string
	}{
		{"flags before name", []string{"--dev", "--domain", "d.io", "zztest"}},
		{"flags after name", []string{"zztest", "--dev", "--domain", "d.io"}},
		{"flags around name", []string{"--domain", "d.io", "zztest", "--dev"}},
		{"equals form after name", []string{"zztest", "--domain=d.io", "--dev"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fs, dev, domain := newFS()
			pos, err := parseFlagsInterspersed(fs, tc.args)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if len(pos) != 1 || pos[0] != "zztest" {
				t.Errorf("positionals = %v, want [zztest]", pos)
			}
			if !*dev {
				t.Error("--dev not parsed")
			}
			if *domain != "d.io" {
				t.Errorf("--domain = %q, want d.io", *domain)
			}
		})
	}

	// Multiple positionals keep their order.
	fs, _, _ := newFS()
	pos, err := parseFlagsInterspersed(fs, []string{"a", "--dev", "b", "c"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(pos) != 3 || pos[0] != "a" || pos[1] != "b" || pos[2] != "c" {
		t.Errorf("positionals = %v, want [a b c]", pos)
	}

	// Unknown flags still error.
	fs2, _, _ := newFS()
	if _, err := parseFlagsInterspersed(fs2, []string{"zztest", "--nope"}); err == nil {
		t.Error("expected error for unknown flag after positional")
	}
}
