package core

import "os"

// A secrets file the driver writes has to be readable by gitops, which runs as
// a different user: a root-owned 0600 credentials file is silently unreadable
// to it, and the failure surfaces much later as an apply that 502s.
const GitopsUID = 1000

// OwnForGitops best-effort chowns driver-created secrets paths to the gitops
// user. A failing chown is a no-op where the driver runs unprivileged (unit
// tests): there the paths already belong to the writing uid.
func OwnForGitops(paths ...string) {
	for _, p := range paths {
		_ = os.Chown(p, GitopsUID, GitopsUID)
	}
}
