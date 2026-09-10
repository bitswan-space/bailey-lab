package core

import (
	"context"
	"time"
)

type Execer interface {
	Exec(ctx context.Context, container string, args ...string) (stdout, stderr string, rc int)

	Running(ctx context.Context, container string) bool

	WaitReady(ctx context.Context, container string, timeout time.Duration) error
}

type ContainerInfo struct {
	ID     string
	State  string
	Labels map[string]string
}
