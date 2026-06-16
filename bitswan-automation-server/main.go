package main

import (
	"fmt"
	"os"
	"runtime/debug"

	"github.com/bitswan-space/bitswan-workspaces/cmd"
)

// version is injected at release time via -ldflags "-X main.version=...".
// Dev/local builds have no ldflags, so it's resolved from the embedded build
// VCS info instead (a real commit), never left blank.
var version = ""

func main() {
	if err := cmd.Execute(resolveVersion()); err != nil {
		fmt.Fprintf(os.Stderr, "%v", err)
		os.Exit(1)
	}
}

// resolveVersion returns the release version when set, else a real
// build-derived version (git-<short-sha>[+dirty]) from runtime/debug build
// info, else "dev". This keeps the overview's Version field truthful for
// locally-built daemons instead of showing an empty value.
func resolveVersion() string {
	if version != "" {
		return version
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		var rev string
		var dirty bool
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
			case "vcs.modified":
				dirty = s.Value == "true"
			}
		}
		if rev != "" {
			if len(rev) > 12 {
				rev = rev[:12]
			}
			v := "git-" + rev
			if dirty {
				v += "+dirty"
			}
			return v
		}
		if bi.Main.Version != "" && bi.Main.Version != "(devel)" {
			return bi.Main.Version
		}
	}
	return "dev"
}
