package infradriver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
)

const (
	DefaultApplyLockTimeout = 15 * time.Minute
	ApplyLockDirName        = ".apply-locks"

	applyLockPollInterval   = 200 * time.Millisecond
	applyLockNotifyInterval = 5 * time.Second
)

var applyLockUnsafeChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func ApplyLockDirFor(gitDir string) string {
	return filepath.Join(filepath.Dir(gitDir), ApplyLockDirName)
}

func ApplyLockPath(lockDir, workspace string) string {
	name := applyLockUnsafeChars.ReplaceAllString(workspace, "-")
	if name == "" {
		name = "workspace"
	}
	return filepath.Join(lockDir, name+".lock")
}

func ApplyLockTimeout() time.Duration {
	if raw := os.Getenv("BITSWAN_APPLY_LOCK_TIMEOUT"); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			return d
		}
	}
	return DefaultApplyLockTimeout
}

func LockWorkspaceApply(
	ctx context.Context,
	lockDir, workspace string,
	timeout time.Duration,
	whileWaiting func(waited time.Duration),
) (release func(), err error) {
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir apply-lock dir %s: %w", lockDir, err)
	}
	path := ApplyLockPath(lockDir, workspace)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open apply lock %s: %w", path, err)
	}
	release = func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}

	start := time.Now()
	deadline := start.Add(timeout)
	var lastNotify time.Time
	for {
		lockErr := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if lockErr == nil {
			return release, nil
		}
		if !errors.Is(lockErr, syscall.EWOULDBLOCK) {
			release()
			return nil, fmt.Errorf("flock %s: %w", path, lockErr)
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			release()
			return nil, ctxErr
		}
		if time.Now().After(deadline) {
			release()
			return nil, fmt.Errorf(
				"another apply for workspace %q still holds %s after %s; refusing to reconcile the same compose project concurrently",
				workspace, path, timeout,
			)
		}
		if whileWaiting != nil && time.Since(lastNotify) >= applyLockNotifyInterval {
			lastNotify = time.Now()
			whileWaiting(time.Since(start).Round(time.Second))
		}
		time.Sleep(applyLockPollInterval)
	}
}
