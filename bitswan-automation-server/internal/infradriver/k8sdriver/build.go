package k8sdriver

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// BuildImage bakes a source tree into an image the kubelet can pull.
//
// On Docker the driver builds into the daemon's own image store, and the store
// the kubelet — there is none — would read is the same one. Here they are two
// different things: buildkit builds, a registry in the namespace holds the
// result, and the kubelet pulls from that registry. So a build is a push, and
// the tag a workload names has to be a reference the kubelet can resolve.
//
// The cache semantics are the Docker driver's, because gitops depends on them:
// the tag is content-addressed, so an existing tag is a hit and needs no work,
// and a byte-identical image already built for another business process is a
// retag rather than a rebuild.
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
		"--output", fmt.Sprintf("type=image,name=%s,push=true,registry.insecure=true", ref),
		// A layer cache that outlives the builder pod, and is shared across
		// business processes: the expensive layers are the dependency installs,
		// and they are identical between them.
		//
		// registry.insecure belongs on the cache refs too, not only on the
		// output: the cache is written to the same plain-HTTP registry, and
		// without it the export half of a successful build fails the whole
		// build on "server gave HTTP response to HTTPS client".
		"--export-cache", "type=registry,mode=max,registry.insecure=true,ref=" + cacheRef(),
		"--import-cache", "type=registry,registry.insecure=true,ref=" + cacheRef(),
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

// registryRef is the reference a built image is pushed to and a workload names.
//
// One reference for both, deliberately. The kubelet resolves image names through
// the NODE's resolver, where a Service name means nothing, so the cluster is
// configured to mirror this registry's name to where the node can reach it. The
// alternative — one name to push to and another to pull by — puts a node-local
// address inside a tag recorded in bitswan.yaml.
func registryRef(tag string) string {
	registry := envOr("BITSWAN_K8S_REGISTRY", "bitswan-registry:5000")
	return registry + "/" + strings.TrimPrefix(tag, "/")
}

// splitRef takes a reference apart the way a registry client does: the tag is
// after the LAST colon, not the first, because the host carries a port. Cutting
// at the first colon turns bitswan-registry:5000/x:sha into host
// "bitswan-registry" and tag "5000/x:sha", which no registry has ever heard of.
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

// manifestDigest reports the digest of a reference already in the registry, or
// "" when it is not there. That is the cache check: the tag is a content
// address, so its presence means the work is done.
func (d *K8sDriver) manifestDigest(ctx context.Context, ref string) string {
	// The registry is asked directly rather than through buildkit, which has no
	// command for "does this tag exist" — and an image already pushed is a hit
	// whether or not the builder happens to be up.
	host, repo, tag, ok := splitRef(ref)
	if !ok {
		return ""
	}
	url := fmt.Sprintf("http://%s/v2/%s/manifests/%s", host, repo, tag)
	resp, err := exec.CommandContext(ctx, "curl", "-fsS", "-o", "/dev/null",
		"-w", "%{http_code}", "-H", "Accept: application/vnd.oci.image.manifest.v1+json",
		"-H", "Accept: application/vnd.docker.distribution.manifest.v2+json", url).Output()
	if err != nil || strings.TrimSpace(string(resp)) != "200" {
		return ""
	}
	digest, err := exec.CommandContext(ctx, "curl", "-fsS", "-D", "-", "-o", "/dev/null",
		"-H", "Accept: application/vnd.oci.image.manifest.v1+json",
		"-H", "Accept: application/vnd.docker.distribution.manifest.v2+json", url).Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(digest), "\n") {
		if strings.HasPrefix(strings.ToLower(line), "docker-content-digest:") {
			return strings.TrimSpace(strings.SplitN(line, ":", 2)[1])
		}
	}
	return "present"
}

// dockerfileFor produces the Dockerfile a build uses: the one the source ships,
// or the generated source-bake.
//
// The generated one is written OUTSIDE the build context, so it is not copied
// into the image and does not perturb the content address — the same reason the
// Docker driver puts it in a temp file.
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
	body := fmt.Sprintf("FROM %s\nCOPY . %s\n", req.BaseImage, mount)
	// A build.sh runs as the final layer so the work happens once, here, and the
	// deployed workload serves what was built rather than building on every
	// start. A failing build.sh fails the build, which is correct.
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
