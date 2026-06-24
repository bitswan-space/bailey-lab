package dockerdriver

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// BuildImage bakes a source tree into an image (port of gitops
// automation_service._bake_source_image): content-addressed by the caller's
// Tag, so a cache hit (the tag already exists) returns immediately; otherwise
// build `FROM BaseImage` + `COPY . MountPath` over the SourcePath context, tag,
// and return the ref. Build output is streamed to prog.
func (d *DockerDriver) BuildImage(ctx context.Context, req infradriver.BuildRequest, prog func(string)) (infradriver.ImageRef, error) {
	if req.Tag == "" || req.SourcePath == "" {
		return infradriver.ImageRef{}, fmt.Errorf("build: tag and source_path are required")
	}
	if req.Dockerfile == "" && req.BaseImage == "" {
		return infradriver.ImageRef{}, fmt.Errorf("build: base_image is required unless dockerfile is set")
	}
	// Cache hit: the content-addressed tag already exists.
	if id := imageID(ctx, req.Tag); id != "" {
		prog(fmt.Sprintf("cache hit: %s", req.Tag))
		return infradriver.ImageRef{FullTag: req.Tag, ImageID: id, CacheHit: true}, nil
	}

	dockerfilePath := req.Dockerfile
	if dockerfilePath == "" {
		// The source-bake: a generated Dockerfile OUTSIDE the context (so it
		// isn't COPY'd into the image and doesn't perturb the content hash).
		df, err := os.CreateTemp("", "infra-build-*.Dockerfile")
		if err != nil {
			return infradriver.ImageRef{}, err
		}
		defer os.Remove(df.Name())
		mount := req.MountPath
		if mount == "" {
			mount = "/app"
		}
		fmt.Fprintf(df, "FROM %s\nCOPY . %s\n", req.BaseImage, mount)
		if err := df.Close(); err != nil {
			return infradriver.ImageRef{}, err
		}
		dockerfilePath = df.Name()
	} else if !filepath.IsAbs(dockerfilePath) {
		// Dockerfile mode: a path relative to the build context.
		dockerfilePath = filepath.Join(req.SourcePath, dockerfilePath)
	}

	cmd := exec.CommandContext(ctx, "docker", "build", "--pull=false",
		"-t", req.Tag, "-f", dockerfilePath, req.SourcePath)
	if err := streamCombined(cmd, prog); err != nil {
		return infradriver.ImageRef{}, fmt.Errorf("docker build %s: %w", req.Tag, err)
	}
	return infradriver.ImageRef{FullTag: req.Tag, ImageID: imageID(ctx, req.Tag)}, nil
}

// imageID returns the image's id, or "" if it does not exist.
func imageID(ctx context.Context, tag string) string {
	out, err := exec.CommandContext(ctx, "docker", "image", "inspect", "--format", "{{.Id}}", tag).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// streamCombined runs cmd, streaming merged stdout+stderr lines to sink.
func streamCombined(cmd *exec.Cmd, sink func(string)) error {
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		return err
	}
	done := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			sink(sc.Text())
		}
		close(done)
	}()
	err := cmd.Wait()
	_ = pw.Close() // unblock the scanner with EOF
	<-done
	return err
}
