// Package infradriver defines the backend-agnostic infrastructure-driver
// contract: gitops ships declarative intent (a workspace's bitswan.yaml plus a
// small context) and a Driver compiles it to a concrete backend (Docker today,
// Kubernetes later) and reconciles. See README.md for the architecture.
//
// The surface is deliberately minimal. There is ONE declarative entry point —
// Apply, the bitswan.yaml compiler — plus four operational container
// primitives (list/logs/stop/restart). Everything orchestration-shaped is a
// bitswan.yaml mutation followed by Apply: deploy is a write+Apply, promote is
// adding a stage's deployment+Apply, swap is flipping the live slot/db+Apply,
// scale is changing replicas+Apply, rollback is pinning the version+Apply, and
// backup/restore is the bitswan.yaml backup state the compiler realizes. If a
// flow doesn't fit, the fix is to make bitswan.yaml more expressive — NOT to
// add a driver command. Image building folds into Apply (the compiler builds
// the images its declaration needs).
//
// This file is the in-process Go contract. The HTTP/SSE server (api.go) is a
// thin adapter over it, and each backend (dockerdriver, k8sdriver) is one
// implementation — so the wire protocol and the backends share one source of
// truth and a backend swap touches no gitops code.
package infradriver

import "context"

// Driver realizes declarative workspace intent against a backend.
type Driver interface {
	// Apply compiles ctx+bitswanYAML into desired backend state and reconciles
	// to it: ensure networks, generate and bring up the compose project, install
	// CA certs + oauth2 sidecars, and realize the data state the declaration
	// implies (blue-green DB seeding, restores). It NEVER builds images — it
	// deploys the already-built, tagged images bitswan.yaml references (built via
	// BuildImage first). Idempotent — a no-op when the running state already
	// matches. prog receives streamed progress; the returned routes let gitops
	// keep its own view in sync. onlyDeploymentIDs (optional) narrows the set.
	Apply(ctx context.Context, req ApplyRequest, prog func(Progress)) ([]Route, error)

	// BuildImage bakes a source tree into an image, content-addressed by
	// SourceSHA (a cache hit returns immediately with CacheHit=true). gitops
	// calls this BEFORE pushing — it records the resulting tag in bitswan.yaml,
	// so Apply only ever deploys already-built images. After the cut-over gitops
	// has no Docker socket, so this is its only way to build. prog receives the
	// build log lines.
	BuildImage(ctx context.Context, req BuildRequest, prog func(string)) (ImageRef, error)

	// ContainerList returns the workspace's containers (optionally filtered by
	// label/stage). gitops derives deployment status from this — health, image,
	// replica count, blue-green slot are all read off the containers + labels.
	ContainerList(ctx context.Context, req WorkspaceContext, filter ContainerFilter) ([]Container, error)

	// ContainerLogs streams a container's logs to sink until ctx is done
	// (follow) or EOF.
	ContainerLogs(ctx context.Context, req WorkspaceContext, container string, tail int, follow bool, sink func(LogLine)) error

	// ContainerStop / ContainerRestart are operational primitives — a transient
	// action on one container, NOT a state change (state changes go through a
	// bitswan.yaml mutation + Apply).
	ContainerStop(ctx context.Context, req WorkspaceContext, container string) error
	ContainerRestart(ctx context.Context, req WorkspaceContext, container string) error
}

// WorkspaceContext is everything the compiler needs that is not in bitswan.yaml.
// Secrets are referenced by path on the shared (read-only) secrets volume;
// plaintext is never marshalled.
type WorkspaceContext struct {
	WorkspaceName string `json:"workspace_name"`
	Domain        string `json:"domain"`
	GitopsDir     string `json:"gitops_dir"`  // shared volume: bitswan.yaml + copies/ + repo
	SecretsDir    string `json:"secrets_dir"` // shared volume: decrypted secret material
	WrapAvailable bool   `json:"wrap_available"`
}

type ApplyRequest struct {
	Ctx               WorkspaceContext `json:"ctx"`
	BitswanYAML       string           `json:"bitswan_yaml"`
	OnlyDeploymentIDs []string         `json:"only_deployment_ids,omitempty"`
}

// BuildRequest bakes a source tree (on the shared volume) into an image.
type BuildRequest struct {
	Ctx        WorkspaceContext `json:"ctx"`
	Tag        string           `json:"tag"`         // full content-addressed image tag gitops wants (e.g. internal/acme-frontend:sha…)
	SourcePath string           `json:"source_path"` // build context on the shared volume
	BaseImage  string           `json:"base_image"`
	MountPath  string           `json:"mount_path"` // where the source is COPY'd in the image
	SourceSHA  string           `json:"source_sha"` // content address (informational; Tag already encodes it)
}

// ImageRef is the result of a BuildImage.
type ImageRef struct {
	FullTag  string `json:"full_tag"`
	ImageID  string `json:"image_id"`
	CacheHit bool   `json:"cache_hit"`
}

// ContainerFilter narrows ContainerList. Empty fields are ignored; Labels are
// matched as exact key=value pairs (e.g. gitops.deployment.id, gitops.stage).
type ContainerFilter struct {
	Labels map[string]string `json:"labels,omitempty"`
}

// Container is one realized container.
type Container struct {
	ID     string            `json:"id"`
	Name   string            `json:"name"`
	State  string            `json:"state"`  // "running" | "exited" | "created" | ...
	Health string            `json:"health"` // "healthy" | "starting" | "unhealthy" | "" (no healthcheck)
	Image  string            `json:"image"`
	Labels map[string]string `json:"labels,omitempty"`
}

// Progress is one step of an Apply. Step is a stable machine key; Message is the
// human line. Streamed as SSE `event: progress` frames.
type Progress struct {
	Step    string `json:"step"`
	Message string `json:"message"`
}

type Route struct {
	Hostname string `json:"hostname"`
	Upstream string `json:"upstream"`
	Stage    string `json:"stage"`
}

type LogLine struct {
	Line   string `json:"line"`
	Stderr bool   `json:"stderr"`
}
