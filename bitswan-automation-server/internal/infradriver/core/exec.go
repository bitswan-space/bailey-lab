package core

import (
	"context"
	"time"
)

// Execer is how the provisioner reaches into a running container.
//
// Creating a business process its own database role, cloning a database for a
// blue/green promotion, granting a key on a bucket: all of it is a command run
// inside the container that already holds the credentials, and none of it cares
// whether that container is a Docker container or a pod. This is the one thing
// the two backends have to supply differently, so it is the one thing behind an
// interface.
type Execer interface {
	// Exec runs argv inside the container and returns its output and exit code.
	// A command that ran and failed is a result, not an error, which is why
	// there is no error return: the caller wants the code and the stderr.
	Exec(ctx context.Context, container string, args ...string) (stdout, stderr string, rc int)

	// Running reports whether the container exists and is running.
	Running(ctx context.Context, container string) bool

	// WaitReady blocks until the container is ready to be provisioned, by
	// whatever the backend's notion of ready is — a healthcheck on Docker, a
	// readiness probe on Kubernetes.
	WaitReady(ctx context.Context, container string, timeout time.Duration) error
}

// ContainerInfo is the little a caller has to tell the provisioner about what
// is already running: enough to decide which deployments are new, and nothing
// about how they run.
type ContainerInfo struct {
	ID     string
	State  string
	Labels map[string]string
}
