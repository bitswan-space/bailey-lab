package k8sdriver

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

func (d *K8sDriver) BuildImage(ctx context.Context, req infradriver.BuildRequest, prog func(string)) (infradriver.ImageRef, error) {
	if req.Tag == "" || req.SourcePath == "" {
		return infradriver.ImageRef{}, fmt.Errorf("build: tag and source_path are required")
	}
	if req.Dockerfile == "" && req.BaseImage == "" {
		return infradriver.ImageRef{}, fmt.Errorf("build: base_image is required unless dockerfile is set")
	}

	ref := registryRef(req.Tag)

	if digest := d.manifestDigest(ctx, ref); digest != "" {
		prog(fmt.Sprintf("cache hit: %s", req.Tag))
		return infradriver.ImageRef{FullTag: req.Tag, ImageID: digest, CacheHit: true}, nil
	}

	dockerfilePath, cleanup, err := dockerfileFor(req)
	if err != nil {
		return infradriver.ImageRef{}, err
	}
	defer cleanup()

	args := []string{
		"--addr", buildkitAddr(),
		"build",
		"--frontend", "dockerfile.v0",
		"--local", "context=" + req.SourcePath,
		"--local", "dockerfile=" + filepath.Dir(dockerfilePath),
		"--opt", "filename=" + filepath.Base(dockerfilePath),
		"--output", fmt.Sprintf("type=image,name=%s,push=true%s", ref, buildkitInsecure()),
		"--export-cache", "type=registry,mode=max" + buildkitInsecure() + ",ref=" + cacheRef(),
		"--import-cache", "type=registry" + buildkitInsecure() + ",ref=" + cacheRef(),
	}
	if gp := os.Getenv("BITSWAN_GOPROXY"); gp != "" {
		args = append(args, "--opt", "build-arg:GOPROXY="+gp)
	}
	if reg := os.Getenv("BITSWAN_NPM_REGISTRY"); reg != "" {
		args = append(args, "--opt", "build-arg:NPM_CONFIG_REGISTRY="+reg)
	}

	cmd := exec.CommandContext(ctx, "buildctl", args...)
	if err := streamOutput(cmd, prog); err != nil {
		return infradriver.ImageRef{}, fmt.Errorf("build %s: %w", req.Tag, err)
	}

	digest := d.manifestDigest(ctx, ref)
	return infradriver.ImageRef{FullTag: req.Tag, ImageID: digest}, nil
}

func registryRef(tag string) string {
	registry := envOr("BITSWAN_K8S_REGISTRY", "bitswan-registry:5000")
	return registry + "/" + strings.TrimPrefix(tag, "/")
}

func splitRef(ref string) (host, repo, tag string, ok bool) {
	name := ref
	if i := strings.LastIndex(ref, ":"); i > strings.LastIndex(ref, "/") {
		name, tag = ref[:i], ref[i+1:]
	}
	if tag == "" {
		return "", "", "", false
	}
	host, repo, ok = strings.Cut(name, "/")
	if !ok {
		return "", "", "", false
	}
	return host, repo, tag, true
}

func cacheRef() string {
	registry := envOr("BITSWAN_K8S_REGISTRY", "bitswan-registry:5000")
	return registry + "/internal/buildcache"
}

func buildkitAddr() string {
	return envOr("BITSWAN_BUILDKIT_ADDR", "tcp://bitswan-buildkit:1234")
}

func (d *K8sDriver) manifestDigest(ctx context.Context, ref string) string {
	_, repo, tag, ok := splitRef(ref)
	if !ok {
		return ""
	}
	resp, err := registryRequest(ctx, http.MethodHead, "/v2/"+repo+"/manifests/"+url.PathEscape(tag))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	return resp.Header.Get("Docker-Content-Digest")
}

func dockerfileFor(req infradriver.BuildRequest) (string, func(), error) {
	if req.Dockerfile != "" {
		path := req.Dockerfile
		if !filepath.IsAbs(path) {
			path = filepath.Join(req.SourcePath, path)
		}
		return path, func() {}, nil
	}

	dir, err := os.MkdirTemp("", "infra-build-*")
	if err != nil {
		return "", func() {}, err
	}
	mount := req.MountPath
	if mount == "" {
		mount = "/app"
	}
	body := fmt.Sprintf("FROM %s\nCOPY . %s\n", resolveImage(req.BaseImage), mount)
	body += fmt.Sprintf("RUN if [ -f %s/build.sh ]; then cd %s && sh ./build.sh; fi\n", mount, mount)
	path := filepath.Join(dir, "Dockerfile")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		os.RemoveAll(dir)
		return "", func() {}, err
	}
	return path, func() { os.RemoveAll(dir) }, nil
}

func streamOutput(cmd *exec.Cmd, prog func(string)) error {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		if prog != nil {
			prog(sc.Text())
		}
	}
	return cmd.Wait()
}

func buildkitInsecure() string {
	if registryInsecure() {
		return ",registry.insecure=true"
	}
	return ""
}
