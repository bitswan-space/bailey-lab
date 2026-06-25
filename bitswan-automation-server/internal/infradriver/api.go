package infradriver

// Wire contract between gitops and the driver.
//
// APPLY IS NOT AN RPC. The driver hosts a bare git remote for the workspace's
// deployed state; gitops `git push`es the resolved bitswan.yaml (+ source) and
// the driver's post-receive hook compiles + applies. The push output (the
// hook's stdout, relayed over git's sideband) carries the apply progress, which
// gitops forwards to the dashboard. Because every deploy/promote/swap/scale/
// rollback/backup is a committed push, the git history IS the audit log. (A k8s
// backend is then just ArgoCD/Flux watching the same repo — no custom driver.)
//
// The RPCs are image building plus five operational container primitives,
// served as HTTP over TCP on the internal network and guarded by the same
// shared bearer token as the git endpoint (the driver is reachable only from
// gitops). None are state changes — state changes go through a push:
//
//	POST /v1/build-image        body BuildRequest  → SSE: log* then (image|error)
//	POST /v1/containers/list    body ListBody      → JSON ContainerListResult
//	POST /v1/containers/logs    body LogsBody      → SSE: log* (until EOF/close)
//	POST /v1/containers/events  body EventsBody    → SSE: container-event* (until close)
//	POST /v1/containers/stop    body ContainerBody → JSON OKResult (or error)
//	POST /v1/containers/restart body ContainerBody → JSON OKResult (or error)
//	POST /v1/containers/exec    hdr X-Bitswan-Exec, body=stdin → framed stdout/stderr/exit
//	POST /v1/containers/copy-out body CopyOutBody → raw TAR stream (docker cp c:path -)
//	POST /v1/containers/copy-in  hdr X-Bitswan-Copy, body=TAR → JSON OKResult (docker cp - c:path)
//
// exec is the general escape hatch for imperative container operations that
// aren't a state change and don't fit the narrower primitives — backups
// (pg_dump), restores (psql < dump), MinIO mirrors. gitops orchestrates them;
// the driver executes. Its wire shape is a binary multiplexed stream rather
// than SSE because the payloads are binary and large (DB dumps).
//
// copy-out/copy-in mirror Docker's archive API (raw TAR streams) for the
// tar-less infra images (minio UBI-micro, etc.) where exec'ing `tar` is
// impossible: the daemon does the archiving. copy-out's response body IS the
// TAR; copy-in's request body IS the TAR (metadata rides X-Bitswan-Copy so the
// body stays a pure stream, same as exec's stdin).
//
// build-image exists because, after the cut-over, gitops has no Docker socket:
// it builds an image here, records the tag in bitswan.yaml, then pushes — so
// apply only ever deploys already-built images.
//
// SSE frame names (the `event:` field); `data:` is JSON:
//
//	log             → LogLine        (build/log output)
//	image           → ImageRef       (terminal success of build-image)
//	container-event → ContainerEvent (a workspace container state transition)
//	error           → ErrorResult    (terminal failure)
const (
	PathBuildImage        = "/v1/build-image"
	PathContainersList    = "/v1/containers/list"
	PathContainersEvents  = "/v1/containers/events"
	PathContainersInspect = "/v1/containers/inspect"
	PathContainersLogs    = "/v1/containers/logs"
	PathContainersStop    = "/v1/containers/stop"
	PathContainersRestart = "/v1/containers/restart"
	PathContainersExec    = "/v1/containers/exec"
	PathContainersCopyOut = "/v1/containers/copy-out"
	PathContainersCopyIn  = "/v1/containers/copy-in"
	PathImagesList        = "/v1/images/list"
	PathImagesRemove      = "/v1/images/remove"
	// PathImagesSBOM runs `syft <tag>` against a workspace image (the driver owns
	// docker; gitops doesn't after the cut-over) and returns the syft-json SBOM.
	// Only the small SBOM crosses the wire — NOT the (potentially multi-GB)
	// image. gitops then runs grype on the SBOM locally (no docker needed). The
	// response body is the raw syft-json document.
	PathImagesSBOM = "/v1/images/sbom"
)

// ImageListResult is the JSON response of /v1/images/list.
type ImageListResult struct {
	Images []Image `json:"images"`
}

// ImageBody is the POST body for /v1/images/remove.
type ImageBody struct {
	Ctx WorkspaceContext `json:"ctx"`
	Tag string           `json:"tag"`
}

// HeaderExec carries the exec metadata (base64 of an ExecBody JSON) so the
// request body can be pure, streamed stdin (DB dumps are large/binary).
const HeaderExec = "X-Bitswan-Exec"

// ExecBody is the (base64-encoded, header-borne) metadata of an exec request.
type ExecBody struct {
	Ctx  WorkspaceContext `json:"ctx"`
	Spec ExecSpec         `json:"spec"`
}

// CopyOutBody is the POST body for /v1/containers/copy-out. The response body
// is the raw TAR archive of Path inside Container (no envelope — it streams).
type CopyOutBody struct {
	Ctx       WorkspaceContext `json:"ctx"`
	Container string           `json:"container"`
	Path      string           `json:"path"`
}

// HeaderCopy carries the copy-in metadata (base64 of a CopyInBody JSON) so the
// request body can be a pure, streamed TAR (a bucket mirror is large/binary),
// mirroring HeaderExec.
const HeaderCopy = "X-Bitswan-Copy"

// CopyInBody is the (base64-encoded, header-borne) metadata of a copy-in
// request; the request body is the raw TAR extracted into Path.
type CopyInBody struct {
	Ctx       WorkspaceContext `json:"ctx"`
	Container string           `json:"container"`
	Path      string           `json:"path"`
}

// Exec response framing — a binary multiplexed stream (not SSE: stdout is
// binary and large). Each frame is: [1 byte stream][4 byte big-endian length][payload].
// The exit frame's payload is a 4-byte big-endian int32 exit code; the error
// frame's payload is a UTF-8 message. The exit (or error) frame is terminal.
const (
	ExecStreamStdout byte = 1
	ExecStreamStderr byte = 2
	ExecStreamExit   byte = 3
	ExecStreamError  byte = 4
)

// SSE event names (apply progress rides the git push, not SSE).
const (
	EventLog            = "log"
	EventImage          = "image"
	EventContainerState = "container-event"
	EventError          = "error"
)

// ListBody is the POST body for /v1/containers/list.
type ListBody struct {
	Ctx    WorkspaceContext `json:"ctx"`
	Filter ContainerFilter  `json:"filter"`
}

// EventsBody is the POST body for /v1/containers/events. The stream is always
// workspace-scoped by the driver's serve-time --workspace flag (the Ctx is
// carried for symmetry with the other endpoints; the driver ignores it for
// scoping, exactly like ContainerList).
type EventsBody struct {
	Ctx WorkspaceContext `json:"ctx"`
}

// LogsBody is the POST body for /v1/containers/logs.
type LogsBody struct {
	Ctx       WorkspaceContext `json:"ctx"`
	Container string           `json:"container"`
	Tail      int              `json:"tail"`
	Follow    bool             `json:"follow"`
}

// ContainerBody is the POST body for /v1/containers/{stop,restart}.
type ContainerBody struct {
	Ctx       WorkspaceContext `json:"ctx"`
	Container string           `json:"container"`
}

// ContainerListResult is the JSON response of /v1/containers/list.
type ContainerListResult struct {
	Containers []Container `json:"containers"`
}

// OKResult is the JSON response of a successful stop/restart.
type OKResult struct {
	OK bool `json:"ok"`
}

// ErrorResult is the terminal `error` SSE frame (logs) / JSON error envelope.
type ErrorResult struct {
	Error string `json:"error"`
}
