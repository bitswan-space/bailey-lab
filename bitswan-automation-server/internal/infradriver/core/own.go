package core

import "os"

const GitopsUID = 1000

func OwnForGitops(paths ...string) {
	for _, p := range paths {
		_ = os.Chown(p, GitopsUID, GitopsUID)
	}
}
