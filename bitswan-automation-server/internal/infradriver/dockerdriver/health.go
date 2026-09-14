package dockerdriver

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// waitForHealthy blocks until the container reports a healthy healthcheck,
// consuming Docker's health-status EVENT stream — never a poll loop or a sleep.
// It subscribes to `docker events` first, then does ONE inspect to catch a
// container that was already healthy (the event can fire before we subscribe);
// thereafter it blocks on the stream. Fails loudly on timeout, and on a
// container that declares no healthcheck (a misconfig we must not silently wait
// out — the infra services now all declare one, see infra.go).
func waitForHealthy(ctx context.Context, container string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Fast path: already healthy (the common warm-service case) → skip the
	// `docker events` subscription entirely. Forking + connecting a `docker
	// events` stream is real overhead on a busy daemon, and provisioning waits
	// on already-running Postgres/Garage several times per deploy. If NOT yet
	// healthy we fall through to the race-safe subscribe-first-then-inspect path
	// below (an event could fire between this check and the subscription).
	if containerHealth(ctx, container) == "healthy" {
		return nil
	}

	ev := exec.CommandContext(ctx, "docker", "events",
		"--filter", "type=container",
		"--filter", "container="+container,
		"--filter", "event=health_status",
		"--format", "{{.Status}}")
	stdout, err := ev.StdoutPipe()
	if err != nil {
		return fmt.Errorf("docker events pipe for %s: %w", container, err)
	}
	if err := ev.Start(); err != nil {
		return fmt.Errorf("docker events for %s: %w", container, err)
	}
	defer func() { _ = ev.Process.Kill(); _ = ev.Wait() }()

	switch containerHealth(ctx, container) {
	case "healthy":
		return nil
	case "none":
		return fmt.Errorf("container %s declares no healthcheck — cannot wait on a readiness event", container)
	}

	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			lines <- strings.TrimSpace(sc.Text())
		}
		close(lines)
	}()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("container %s not healthy within %s: %w", container, timeout, ctx.Err())
		case line, ok := <-lines:
			if !ok {
				// `docker events` exited before we saw a healthy event (a daemon
				// hiccup, or the container being recreated mid-wait closes the
				// stream bound to the old instance). Don't fail on a single
				// re-check — fall back to polling the container's health until the
				// same deadline, so a container that becomes healthy moments later
				// still passes.
				tick := time.NewTicker(500 * time.Millisecond)
				defer tick.Stop()
				for {
					switch containerHealth(context.Background(), container) {
					case "healthy":
						return nil
					case "none":
						return fmt.Errorf("container %s declares no healthcheck — cannot wait on a readiness event", container)
					}
					select {
					case <-ctx.Done():
						return fmt.Errorf("container %s not healthy within %s: %w", container, timeout, ctx.Err())
					case <-tick.C:
					}
				}
			}
			// Status is "health_status: healthy" | "health_status: unhealthy".
			if strings.Contains(line, "healthy") && !strings.Contains(line, "unhealthy") {
				return nil
			}
		}
	}
}

// containerHealth returns "healthy" | "starting" | "unhealthy" | "none" (no
// healthcheck declared) | "unknown" (inspect failed).
func containerHealth(ctx context.Context, container string) string {
	out, err := exec.CommandContext(ctx, "docker", "inspect", "-f",
		"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container).Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}
