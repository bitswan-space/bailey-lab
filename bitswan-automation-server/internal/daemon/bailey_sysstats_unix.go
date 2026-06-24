//go:build !windows

package daemon

import "syscall"

// diskUsage returns the total and available bytes of the filesystem holding
// path, via statfs. Unix only (Linux/darwin) — the daemon runs in a Linux
// container; the Windows build gets a stub so the CLI binary still compiles.
func diskUsage(path string) (total, free uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize)
	return st.Blocks * bs, st.Bavail * bs, nil
}
