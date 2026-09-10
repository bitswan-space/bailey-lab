package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8sctl"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

const (
	goProxyWorkload  = "bitswan-goproxy"
	npmProxyWorkload = "bitswan-npmproxy"
	goProxyPort      = 3000
	npmProxyPort     = 4873
	buildProxySubDir = "build-proxy"
)

func goProxyURLK8s() string {
	return fmt.Sprintf("http://%s:%d|direct", goProxyWorkload, goProxyPort)
}

func npmRegistryURLK8s() string {
	return fmt.Sprintf("http://%s:%d", npmProxyWorkload, npmProxyPort)
}

func buildProxyPath(parts ...string) string {
	return filepath.Join(append([]string{os.Getenv("HOME"), ".config", "bitswan", buildProxySubDir}, parts...)...)
}

func buildProxySubPath(parts ...string) string {
	return filepath.Join(append([]string{buildProxySubDir}, parts...)...)
}

func startBuildProxiesK8s() {
	if os.Getenv("BITSWAN_GOPROXY") != "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if err := seedBuildProxyState(); err != nil {
			fmt.Printf("Warning: could not lay out the build proxy state: %v\n", err)
			return
		}
		if err := k8sctl.Apply(ctx, buildProxyObjects()); err != nil {
			fmt.Printf("Warning: could not apply the build proxies: %v\n", err)
			return
		}
		if err := k8sctl.WaitAvailable(ctx, goProxyWorkload, buildProxyReadyTimeout); err != nil {
			fmt.Printf("Warning: the Go module proxy did not become available: %v\n", err)
		}
		if err := k8sctl.WaitAvailable(ctx, npmProxyWorkload, buildProxyReadyTimeout); err != nil {
			fmt.Printf("Warning: the npm registry proxy did not become available; builds will fetch packages directly: %v\n", err)
			return
		}
		adoptBuildProxyEnvK8s(ctx)
		fmt.Println("Shared read-through build proxies ready (Athens + Verdaccio, namespace-managed)")
	}()
}

const buildProxyReadyTimeout = 5 * time.Minute

// adoptBuildProxyEnvK8s wires the build path only to what is actually serving.
// The Go proxy carries its own `|direct` fallback so an absent one costs speed;
// npm has no such fallback, and naming a registry that does not answer turns
// every build that installs a package into a failure.
func adoptBuildProxyEnvK8s(ctx context.Context) {
	if os.Getenv("BITSWAN_GOPROXY") == "" && k8sctl.Available(ctx, goProxyWorkload) {
		_ = os.Setenv("BITSWAN_GOPROXY", goProxyURLK8s())
	}
	if os.Getenv("BITSWAN_NPM_REGISTRY") == "" && k8sctl.Available(ctx, npmProxyWorkload) {
		_ = os.Setenv("BITSWAN_NPM_REGISTRY", npmRegistryURLK8s())
	}
}

// seedBuildProxyState writes what a container cannot create for itself. A
// subPath mount of a file the volume does not hold is refused by the kubelet,
// and a directory the kubelet does create is root-owned 0755 — unwritable by
// the unprivileged user each of these images runs as, which is why the modes
// are widened here rather than by running the proxies as root.
func seedBuildProxyState() error {
	for _, dir := range []string{
		buildProxyPath("athens"),
		buildProxyPath("verdaccio", "conf"),
		buildProxyPath("verdaccio", "storage"),
	} {
		if err := os.MkdirAll(dir, 0o777); err != nil {
			return err
		}
		if err := os.Chmod(dir, 0o777); err != nil {
			return err
		}
	}
	conf := filepath.Join(buildProxyPath("verdaccio", "conf"), "config.yaml")
	if err := os.WriteFile(conf, []byte(verdaccioConfig), 0o666); err != nil {
		return err
	}
	return os.Chmod(conf, 0o666)
}

func buildProxyObjects() k8srender.ObjectSet {
	claim := k8sWorkspaceVolumeClaim()
	objs := k8srender.Deployment(k8srender.Workload{
		Name:          goProxyWorkload,
		ContainerName: goProxyWorkload,
		Image:         envOrDefault("BITSWAN_GOPROXY_IMAGE", athensImage),
		PullPolicy:    k8sPullPolicy(),
		VolumeClaim:   claim,
		Ports:         []k8srender.Port{{Name: "http", Port: goProxyPort}},
		Env: map[string]string{
			"ATHENS_DOWNLOAD_MODE":     "sync",
			"ATHENS_STORAGE_TYPE":      "disk",
			"ATHENS_DISK_STORAGE_ROOT": "/var/lib/athens",
		},
		Mounts: []k8srender.Mount{
			{Path: "/var/lib/athens", SubPath: buildProxySubPath("athens")},
		},
		Readiness: &k8srender.Probe{TCPPort: goProxyPort, PeriodSeconds: 3, Failures: 100},
	})
	return append(objs, k8srender.Deployment(k8srender.Workload{
		Name:          npmProxyWorkload,
		ContainerName: npmProxyWorkload,
		Image:         envOrDefault("BITSWAN_NPM_PROXY_IMAGE", verdaccioImage),
		PullPolicy:    k8sPullPolicy(),
		VolumeClaim:   claim,
		Ports:         []k8srender.Port{{Name: "http", Port: npmProxyPort}},
		Mounts: []k8srender.Mount{
			{Path: "/verdaccio/conf", SubPath: buildProxySubPath("verdaccio", "conf")},
			{Path: "/verdaccio/storage", SubPath: buildProxySubPath("verdaccio", "storage")},
		},
		Readiness: &k8srender.Probe{TCPPort: npmProxyPort, PeriodSeconds: 3, Failures: 100},
	})...)
}
