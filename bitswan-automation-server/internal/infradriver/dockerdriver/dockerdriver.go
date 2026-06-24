// Package dockerdriver implements infradriver.Driver against a local Docker
// daemon. It shells out to the `docker` CLI (the convention used elsewhere in
// internal/docker) rather than pulling in the Docker SDK.
//
// Apply (the bitswan.yaml compiler) lives in compile.go; this file is the five
// operational container primitives (list/logs/stop/restart/exec).
package dockerdriver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// DockerDriver realizes workspace intent on a local Docker daemon.
type DockerDriver struct{}

// New returns a DockerDriver.
func New() *DockerDriver { return &DockerDriver{} }

var _ infradriver.Driver = (*DockerDriver)(nil)

// dockerInspect is the subset of `docker inspect` output we read.
type dockerInspect struct {
	ID      string `json:"Id"`
	Name    string `json:"Name"`
	Created string `json:"Created"` // RFC3339Nano
	State   struct {
		Status string `json:"Status"`
		Health *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
}

// ContainerList returns the workspace's containers, optionally filtered by
// labels. Health is "" when the container declares no healthcheck.
func (d *DockerDriver) ContainerList(ctx context.Context, _ infradriver.WorkspaceContext, filter infradriver.ContainerFilter) ([]infradriver.Container, error) {
	args := []string{"ps", "--all", "--no-trunc", "--quiet"}
	for k, v := range filter.Labels {
		args = append(args, "--filter", "label="+k+"="+v)
	}
	out, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil, nil
	}
	inspectArgs := append([]string{"inspect"}, ids...)
	raw, err := exec.CommandContext(ctx, "docker", inspectArgs...).Output()
	if err != nil {
		return nil, fmt.Errorf("docker inspect: %w", err)
	}
	return parseInspect(raw)
}

// parseInspect maps `docker inspect` JSON to the driver's Container type. Split
// out so it is unit-testable without a Docker daemon.
func parseInspect(raw []byte) ([]infradriver.Container, error) {
	var inspected []dockerInspect
	if err := json.Unmarshal(raw, &inspected); err != nil {
		return nil, fmt.Errorf("parse docker inspect: %w", err)
	}
	containers := make([]infradriver.Container, 0, len(inspected))
	for _, di := range inspected {
		health := ""
		if di.State.Health != nil {
			health = di.State.Health.Status
		}
		var created int64
		if di.Created != "" {
			if t, err := time.Parse(time.RFC3339Nano, di.Created); err == nil {
				created = t.Unix()
			}
		}
		containers = append(containers, infradriver.Container{
			ID:      di.ID,
			Name:    strings.TrimPrefix(di.Name, "/"),
			State:   di.State.Status,
			Health:  health,
			Image:   di.Config.Image,
			Created: created,
			Labels:  di.Config.Labels,
		})
	}
	return containers, nil
}

// ContainerLogs streams a container's logs. tail<=0 means all. follow streams
// until ctx is cancelled or the container stops.
func (d *DockerDriver) ContainerLogs(ctx context.Context, _ infradriver.WorkspaceContext, container string, tail int, follow bool, sink func(infradriver.LogLine)) error {
	args := []string{"logs"}
	if tail > 0 {
		args = append(args, "--tail", fmt.Sprintf("%d", tail))
	} else {
		args = append(args, "--tail", "all")
	}
	if follow {
		args = append(args, "--follow")
	}
	args = append(args, container)
	cmd := exec.CommandContext(ctx, "docker", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("docker logs: %w", err)
	}
	// Pump stdout + stderr concurrently to the sink, tagging stream origin.
	done := make(chan struct{}, 2)
	pump := func(r *bufio.Scanner, isErr bool) {
		for r.Scan() {
			sink(infradriver.LogLine{Line: r.Text(), Stderr: isErr})
		}
		done <- struct{}{}
	}
	go pump(bufio.NewScanner(stdout), false)
	go pump(bufio.NewScanner(stderr), true)
	<-done
	<-done
	if err := cmd.Wait(); err != nil {
		// A cancelled follow or a non-zero exit on a stopped container is not a
		// driver error worth surfacing; only report if ctx is still live.
		if ctx.Err() != nil {
			return nil
		}
	}
	return nil
}

// ContainerStop stops a container.
func (d *DockerDriver) ContainerStop(ctx context.Context, _ infradriver.WorkspaceContext, container string) error {
	if out, err := exec.CommandContext(ctx, "docker", "stop", container).CombinedOutput(); err != nil {
		return fmt.Errorf("docker stop %s: %w: %s", container, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ContainerRestart restarts a container.
func (d *DockerDriver) ContainerRestart(ctx context.Context, _ infradriver.WorkspaceContext, container string) error {
	if out, err := exec.CommandContext(ctx, "docker", "restart", container).CombinedOutput(); err != nil {
		return fmt.Errorf("docker restart %s: %w: %s", container, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ContainerExec runs `docker exec [-i] <container> <cmd...>`, streaming in to
// the process stdin and its stdout/stderr (as raw, binary-safe chunks) to out.
// Returns the command's exit code; a non-zero exit is reported via the code, not
// an error (only a failure to run is an error).
func (d *DockerDriver) ContainerExec(ctx context.Context, _ infradriver.WorkspaceContext, spec infradriver.ExecSpec, in io.Reader, out func(stderr bool, chunk []byte)) (int, error) {
	args := []string{"exec"}
	if in != nil {
		args = append(args, "-i")
	}
	if spec.Tty {
		args = append(args, "-t")
	}
	args = append(args, spec.Container)
	args = append(args, spec.Cmd...)
	cmd := exec.CommandContext(ctx, "docker", args...)
	if in != nil {
		cmd.Stdin = in
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return -1, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return -1, err
	}
	if err := cmd.Start(); err != nil {
		return -1, fmt.Errorf("docker exec %s: %w", spec.Container, err)
	}
	// Pump both streams as raw byte chunks (not line-scanned — pg_dump output is
	// binary). out must be safe to call from two goroutines.
	var wg sync.WaitGroup
	wg.Add(2)
	pump := func(r io.Reader, isErr bool) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, rerr := r.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				out(isErr, chunk)
			}
			if rerr != nil {
				return
			}
		}
	}
	go pump(stdout, false)
	go pump(stderr, true)
	wg.Wait()
	err = cmd.Wait()
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return -1, fmt.Errorf("docker exec %s: %w", spec.Container, err)
}
