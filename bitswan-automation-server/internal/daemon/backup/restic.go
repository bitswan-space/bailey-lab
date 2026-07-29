package backup

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// resticBinary is a var so tests can point it at a fake.
var resticBinary = "restic"

// Restic runs the restic CLI against this server's repo through the AOC
// REST proxy. All credentials travel via env, never argv.
type Restic struct {
	Target *AOCTarget
	Key    string // repo encryption key (RESTIC_PASSWORD)
}

// NewRestic builds a runner from the loaded AOC target and local key.
func NewRestic(target *AOCTarget, key string) *Restic {
	return &Restic{Target: target, Key: key}
}

// Env is the restic environment: the REST repo URL and its Basic-auth
// credentials (username is informational — AOC scopes by token alone).
func (r *Restic) Env() []string {
	return append(os.Environ(),
		"RESTIC_REPOSITORY=rest:"+r.Target.RepoURL(),
		"RESTIC_REST_USERNAME="+r.Target.ServerID,
		"RESTIC_REST_PASSWORD="+r.Target.Token,
		"RESTIC_PASSWORD="+r.Key,
	)
}

// Run executes restic with the given args. Returns combined stdout and
// stderr; err is non-nil on non-zero exit (stderr is folded into the error
// message for direct surfacing in run reports).
func (r *Restic) Run(ctx context.Context, args ...string) (stdout, stderr string, err error) {
	cmd := exec.CommandContext(ctx, resticBinary, args...)
	cmd.Env = r.Env()
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err = cmd.Run()
	stdout = outBuf.String()
	stderr = errBuf.String()
	if err != nil {
		err = fmt.Errorf("restic %s: %w: %s", args[0], err, strings.TrimSpace(stderr))
	}
	return stdout, stderr, err
}

// BackupArgs are the flags every `restic backup` gets: an explicit host
// (the container hostname changes across daemon recreations, and retention
// groups by host,tags) and the series tags.
func (r *Restic) BackupArgs(tags []string, paths ...string) []string {
	args := []string{"backup", "--host", r.Target.ServerID}
	for _, t := range tags {
		args = append(args, "--tag", t)
	}
	return append(args, paths...)
}

// EnsureRepo initializes the repo, tolerating one that already exists.
// (restic init against the REST proxy also lazily creates the S3 bucket via
// POST ?create=true.)
func (r *Restic) EnsureRepo(ctx context.Context) error {
	_, stderr, err := r.Run(ctx, "init")
	if err == nil {
		return nil
	}
	// restic's message for an existing repo has varied across versions;
	// match loosely.
	msg := strings.ToLower(stderr)
	if strings.Contains(msg, "already initialized") || strings.Contains(msg, "already exists") ||
		strings.Contains(msg, "config file already exists") {
		return nil
	}
	return err
}

// Unlock clears stale repo locks. The daemon is the repo's only writer, so
// any lock present outside a running operation is a leftover from an
// interrupted one and is safe to remove.
func (r *Restic) Unlock(ctx context.Context) error {
	_, _, err := r.Run(ctx, "unlock")
	return err
}
