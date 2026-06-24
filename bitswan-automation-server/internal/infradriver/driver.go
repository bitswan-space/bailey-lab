// Package infradriver defines the backend-agnostic infrastructure-driver
// contract: gitops ships declarative intent (a workspace's bitswan.yaml plus a
// small context) and a Driver compiles it to a concrete backend (Docker today,
// Kubernetes later) and reconciles. See README.md for the architecture.
//
// This file is the in-process Go contract. The gRPC server
// (proto/v1/infradriver.proto) is a thin adapter over it, and each backend
// (dockerdriver, k8sdriver) is one implementation — so the wire protocol and
// the backends share one source of truth and a backend swap touches no gitops
// code.
package infradriver

import "context"

// Driver realizes declarative workspace intent against a backend. Every method
// is idempotent where it can be; Apply in particular must be a no-op when the
// running state already matches the declaration.
type Driver interface {
	// Apply compiles ctx+bitswanYAML into desired backend state and reconciles
	// to it (networks, services, sidecars, routes). prog receives streamed
	// progress steps; the returned routes let gitops keep its own view in sync.
	// onlyDeploymentIDs (optional) narrows reconciliation to a single BP/stage.
	Apply(ctx context.Context, req ApplyRequest, prog func(Progress)) ([]Route, error)

	// BuildImage bakes a source tree into an image, content-addressed by
	// SourceSHA (a cache hit returns immediately with CacheHit=true).
	BuildImage(ctx context.Context, req BuildRequest, prog func(string)) (ImageRef, error)

	// Snapshot / Restore dump and load a deployment's data services.
	Snapshot(ctx context.Context, req SnapshotRequest, prog func(Progress)) error
	Restore(ctx context.Context, req RestoreRequest, prog func(Progress)) error

	// Status returns the realized state of the given deployments (all if empty).
	Status(ctx context.Context, req WorkspaceContext, deploymentIDs []string) ([]DeploymentState, error)

	// Logs streams a container's logs to sink until ctx is done (follow) or EOF.
	Logs(ctx context.Context, req WorkspaceContext, container string, tail int, follow bool, sink func(LogLine)) error

	// WatchEvents streams backend state-change events to sink until ctx is done.
	WatchEvents(ctx context.Context, req WorkspaceContext, sink func(Event)) error
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

type BuildRequest struct {
	Ctx        WorkspaceContext `json:"ctx"`
	SourcePath string           `json:"source_path"`
	BaseImage  string           `json:"base_image"`
	MountPath  string           `json:"mount_path"`
	SourceSHA  string           `json:"source_sha"`
}

type SnapshotRequest struct {
	Ctx        WorkspaceContext `json:"ctx"`
	BP         string           `json:"bp"`
	Stage      string           `json:"stage"`
	SnapshotID string           `json:"snapshot_id"`
}

type RestoreRequest struct {
	Ctx        WorkspaceContext `json:"ctx"`
	BP         string           `json:"bp"`
	FromStage  string           `json:"from_stage"`
	ToStage    string           `json:"to_stage"`
	SnapshotID string           `json:"snapshot_id"`
}

// Progress is one step of an Apply/Snapshot/Restore. Step is a stable machine
// key; Message is the human line. Streamed as SSE `event: progress` frames.
type Progress struct {
	Step    string `json:"step"`
	Message string `json:"message"`
}

type Route struct {
	Hostname string `json:"hostname"`
	Upstream string `json:"upstream"`
	Stage    string `json:"stage"`
}

type ImageRef struct {
	FullTag  string `json:"full_tag"`
	ImageID  string `json:"image_id"`
	CacheHit bool   `json:"cache_hit"`
}

type DeploymentState struct {
	DeploymentID string `json:"deployment_id"`
	Stage        string `json:"stage"`
	Image        string `json:"image"`
	Replicas     int    `json:"replicas"`
	Health       string `json:"health"` // "healthy" | "starting" | "not_running" | "unknown"
	Slot         string `json:"slot,omitempty"`
}

type LogLine struct {
	Line   string `json:"line"`
	Stderr bool   `json:"stderr"`
}

type Event struct {
	Container string `json:"container"`
	Action    string `json:"action"`
}
