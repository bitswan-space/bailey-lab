//go:build windows

package daemon

import "fmt"

// diskUsage is unsupported on Windows. The daemon only ever runs inside a Linux
// container, but the CLI cross-compiles for Windows, so this stub keeps the
// build green; gatherSystemStats (a daemon-serve-only path) is never invoked
// there.
func diskUsage(path string) (total, free uint64, err error) {
	return 0, 0, fmt.Errorf("disk stats not supported on windows")
}
