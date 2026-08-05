package cmd

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"
)

// Proving the operator's restic key opens the repository, before anything mutates.
//
// A recovery's first destructive act is exchanging the one-time password, which
// REPLACES the server's access token rather than adding one — so an operator with
// the wrong key used to spend a single-use OTP and cut a possibly-still-live server
// off its AOC before learning the key was wrong. This probe moves that discovery
// ahead of the exchange, authenticating to the AOC's restic proxy with the OTP
// itself (the proxy accepts a live recovery OTP for reads only).
//
// What it proves is narrow and the messages must not overstate it: the repository
// opens with this key. A snapshot can still be missing, corrupt, or too old to
// restore — those surface later.

// restic's documented exit codes. `restic cat` distinguishes exactly the three
// failures worth telling apart here, so match on the code rather than on message
// text, which drifts between versions.
const (
	resticExitNoRepository  = 10
	resticExitRepoLocked    = 11
	resticExitBadPassword   = 12
	dockerExitCodeFloor     = 125 // 125/126/127 are docker's own, not restic's
	recoverServerProbeLimit = 2 * time.Minute
)

// resticProbeArgs is the probe's restic invocation.
//
// `cat config` decrypts the repository config with the master key derived from the
// password: the cheapest operation that cannot succeed with a wrong key, and it
// reads no snapshot, so a failure is unambiguously about the key or the repository
// rather than about the data.
//
// --no-lock is REQUIRED, not an optimisation. restic takes a lock even for a pure
// read, and creating one is a WRITE, which the AOC refuses for an OTP-authenticated
// caller — without it the probe dies on a 403 that says nothing about the key.
// restic documents the flag as exactly this case: "do not lock the repository, this
// allows some operations on read-only repositories". A named var so dropping it is a
// visible edit against this comment rather than a one-word change inside a call.
var resticProbeArgs = []string{"cat", "config", "--no-lock"}

// recoverServerProbeKey verifies that `key` opens this server's backup repository,
// authenticating with `cred` (the recovery OTP, or a stored token when resuming).
// A seam so the preflight ordering can be tested without docker or an AOC.
var recoverServerProbeKey = func(
	ctx context.Context, aocAPI, serverID, cred, key, image, network string,
) error {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, recoverServerProbeLimit)
	defer cancel()

	restic := newDaemonlessRestic(aocAPI, serverID, cred, key, image, network)
	_, _, err := restic.Run(ctx, resticProbeArgs...)
	return err
}

// explainProbeFailure turns a probe error into something an operator can act on at
// 3am. Every branch has to make clear that nothing was changed, because the whole
// value of probing first is that a failure is free.
func explainProbeFailure(err error, serverID string) error {
	switch resticExitCode(err) {
	case resticExitBadPassword:
		return fmt.Errorf("the backup encryption key you supplied does not open this "+
			"server's backup repository. Nothing has been changed and your recovery OTP "+
			"is still valid — re-run with the right key.\n\nThe key is the one saved off "+
			"this server when backups were first enabled (the Server Console shows it "+
			"under Backups → Encryption key). There is no escrow, so no copy of it exists "+
			"in the AOC or in object storage: %w", err)
	case resticExitNoRepository:
		return fmt.Errorf("no backup repository exists for automation server %s. Either "+
			"--server-id names the wrong server, or this one never completed a backup. "+
			"Nothing has been changed and your recovery OTP is still valid: %w", serverID, err)
	case resticExitRepoLocked:
		return fmt.Errorf("this server's backup repository is locked by another "+
			"operation — most likely a backup run still finishing on a server that is "+
			"not as dead as it looks. Nothing has been changed; wait for it to finish, or "+
			"stop the other server, then re-run: %w", err)
	}
	return fmt.Errorf("could not reach this server's backup repository to verify the "+
		"key. Nothing has been changed and your recovery OTP is still valid: %w", err)
}

// resticExitCode extracts restic's exit status, or 0 when the error did not come
// from a finished process.
//
// In the container path the process actually run is `docker`, which propagates the
// container's exit status — but docker's OWN failures (125 could not run, 126 not
// executable, 127 not found) would otherwise be read as restic codes, so anything
// at or above that floor is reported as an unclassified failure instead.
func resticExitCode(err error) int {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return 0
	}
	code := exitErr.ExitCode()
	if code < 0 || code >= dockerExitCodeFloor {
		return 0
	}
	return code
}
