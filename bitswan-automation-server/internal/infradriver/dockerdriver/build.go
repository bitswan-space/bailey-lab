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

	// Content-global cache hit: the tag NAME embeds the BP (internal/<ws>-<bp>-
	// <auto>:sha<H>), so a brand-new BP misses the exact-tag check above even
	// when a byte-identical image was already built for another BP. The `:sha<H>`
	// suffix is a pure content address, so if any image in this workspace's
	// namespace carries the same suffix, retag it (instant) instead of rebuilding.
	if sha := contentSHA(req); sha != "" {
		if found, id := d.findImageByContentSHA(ctx, sha, req.Tag); found != "" {
			if out, err := exec.CommandContext(ctx, "docker", "tag", found, req.Tag).CombinedOutput(); err != nil {
				return infradriver.ImageRef{}, fmt.Errorf("docker tag %s %s: %w: %s", found, req.Tag, err, strings.TrimSpace(string(out)))
			}
			prog(fmt.Sprintf("cache hit (retagged from %s): %s", found, req.Tag))
			return infradriver.ImageRef{FullTag: req.Tag, ImageID: id, CacheHit: true}, nil
		}
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
		// If the source ships a build.sh, run it as a FINAL layer so build steps
		// (vite build, go build, …) happen ONCE here at image-build time — the
		// deployed container then serves the pre-built artifact and starts fast,
		// instead of building on every startup. Optional + backward-compatible:
		// sources without a build.sh are unaffected. A failing build.sh fails the
		// image build (and thus the deploy) loudly, which is correct.
		fmt.Fprintf(df, "RUN if [ -f %s/build.sh ]; then cd %s && sh ./build.sh; fi\n", mount, mount)
		if err := df.Close(); err != nil {
			return infradriver.ImageRef{}, err
		}
		dockerfilePath = df.Name()
	} else if !filepath.IsAbs(dockerfilePath) {
		// Dockerfile mode: a path relative to the build context.
		dockerfilePath = filepath.Join(req.SourcePath, dockerfilePath)
	}

	args := []string{"build", "--pull=false", "-t", req.Tag, "-f", dockerfilePath}
	// Optional: route package downloads through the automation-server's shared
	// read-through package proxies (a Go module proxy + an npm registry proxy),
	// so npm install / go mod download hit a warm local cache instead of the
	// internet on every per-BP build. The proxies are PURE READ-THROUGH (clients
	// only GET verified upstream artifacts; no publish/write), so they cannot be
	// a cross-workspace communication or contamination vector. All opt-in via
	// env, so a deployment without them builds exactly as before. Integrity stays
	// client-side (GOSUMDB + npm lockfile), so a bad proxy can't swap content.
	//   BITSWAN_BUILD_NETWORK — a docker network the build joins to reach the
	//                           proxies (and only them — not bitswan_network / other
	//                           workspaces, so builds can't talk cross-workspace).
	//   BITSWAN_GOPROXY        — GOPROXY value (e.g. http://<athens>:3000,direct).
	//   BITSWAN_NPM_REGISTRY   — npm registry URL (the Verdaccio proxy).
	// The template Dockerfiles declare matching ARGs (default empty ⇒ direct).
	if net := os.Getenv("BITSWAN_BUILD_NETWORK"); net != "" {
		args = append(args, "--network", net)
	}
	if gp := os.Getenv("BITSWAN_GOPROXY"); gp != "" {
		args = append(args, "--build-arg", "GOPROXY="+gp)
	}
	if reg := os.Getenv("BITSWAN_NPM_REGISTRY"); reg != "" {
		args = append(args, "--build-arg", "NPM_CONFIG_REGISTRY="+reg)
	}
	args = append(args, req.SourcePath)
	cmd := exec.CommandContext(ctx, "docker", args...)
	if err := streamCombined(cmd, prog); err != nil {
		return infradriver.ImageRef{}, fmt.Errorf("docker build %s: %w", req.Tag, err)
	}
	return infradriver.ImageRef{FullTag: req.Tag, ImageID: imageID(ctx, req.Tag)}, nil
}

// contentSHA is the pure content address of a build: the SourceSHA the caller
// sent, or (fallback) the `sha…` suffix of the requested tag. "" if neither.
func contentSHA(req infradriver.BuildRequest) string {
	if req.SourceSHA != "" {
		return req.SourceSHA
	}
	if i := strings.LastIndex(req.Tag, ":sha"); i != -1 {
		return req.Tag[i+len(":sha"):]
	}
	return ""
}

// findImageByContentSHA returns (tag, id) of an existing image in this
// workspace's namespace whose tag ends with the given content sha, or ("","")
// if none. `exclude` (the tag we're about to produce) is skipped. The `:sha<H>`
// suffix is content-addressed, so any match is byte-identical and safe to retag.
func (d *DockerDriver) findImageByContentSHA(ctx context.Context, sha, exclude string) (string, string) {
	// docker's reference-filter glob does not cross '/', so scope by the
	// workspace prefix (internal/<ws>-*) rather than a bare '*'. Fall back to
	// '*/*' (any internal/<repo>) when the workspace is unknown.
	prefix := d.imageTagPrefix()
	ref := "*/*:sha" + sha
	if prefix != "" {
		ref = prefix + "*:sha" + sha
	}
	out, err := exec.CommandContext(ctx, "docker", "images", "--no-trunc",
		"--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}",
		"--filter", "reference="+ref).Output()
	if err != nil {
		return "", "" // a listing hiccup must never block the build; fall through.
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		tag, id, ok := strings.Cut(line, "\t")
		if !ok || tag == "" || tag == exclude || strings.HasSuffix(tag, ":<none>") {
			continue
		}
		// Belt-and-braces: confirm the content sha suffix (guards against any
		// glob surprise) and the workspace scope.
		if !strings.HasSuffix(tag, ":sha"+sha) {
			continue
		}
		if prefix != "" && !strings.HasPrefix(tag, prefix) {
			continue
		}
		return tag, id
	}
	return "", ""
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
