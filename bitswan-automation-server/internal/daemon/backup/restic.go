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

	// Container, when set, runs restic inside a throwaway container from the
	// automation-server runtime image instead of expecting a restic binary on
	// this machine. See restic_container.go — the machine being rebuilt in a
	// disaster recovery has docker but no restic.
	Container *ContainerExec
}

// NewRestic builds a runner from the loaded AOC target and local key.
func NewRestic(target *AOCTarget, key string) *Restic {
	return &Restic{Target: target, Key: key}
}

// resticEnvVars is the credential environment restic needs: the REST repo URL,
// its Basic-auth pair (username is informational — AOC scopes by token alone),
// and the repo password. Names and values live together here because the
// container path passes only the NAMES to docker, and the two lists must not
// drift apart.
func (r *Restic) resticEnvVars() [][2]string {
	return [][2]string{
		{"RESTIC_REPOSITORY", "rest:" + r.Target.RepoURL()},
		{"RESTIC_REST_USERNAME", r.Target.ServerID},
		{"RESTIC_REST_PASSWORD", r.Target.Token},
		{"RESTIC_PASSWORD", r.Key},
	}
}

// Env is the process environment for a restic run.
func (r *Restic) Env() []string {
	env := os.Environ()
	for _, kv := range r.resticEnvVars() {
		env = append(env, kv[0]+"="+kv[1])
	}
	return env
}

// envNames is the same set of variables, names only.
func (r *Restic) envNames() []string {
	names := make([]string, 0, 4)
	for _, kv := range r.resticEnvVars() {
		names = append(names, kv[0])
	}
	return names
}

// Run executes restic with the given args. Returns combined stdout and
// stderr; err is non-nil on non-zero exit (stderr is folded into the error
// message for direct surfacing in run reports).
func (r *Restic) Run(ctx context.Context, args ...string) (stdout, stderr string, err error) {
	binary, argv := resticBinary, args
	if r.Container != nil {
		binary, argv = dockerBinary, r.Container.argv(r.envNames(), args)
	}
	cmd := exec.CommandContext(ctx, binary, argv...)
	// Either way the credentials arrive through the environment: the container
	// path passes `-e NAME` with no value, so docker takes it from here rather
	// than putting secrets in the process table.
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
