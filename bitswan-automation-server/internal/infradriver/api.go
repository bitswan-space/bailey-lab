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
//	POST /v1/containers/stop    body ContainerBody → JSON OKResult (or error)
//	POST /v1/containers/restart body ContainerBody → JSON OKResult (or error)
//	POST /v1/containers/exec    hdr X-Bitswan-Exec, body=stdin → framed stdout/stderr/exit
//
// exec is the general escape hatch for imperative container operations that
// aren't a state change and don't fit the narrower primitives — backups
// (pg_dump), restores (psql < dump), MinIO mirrors. gitops orchestrates them;
// the driver executes. Its wire shape is a binary multiplexed stream rather
// than SSE because the payloads are binary and large (DB dumps).
//
// build-image exists because, after the cut-over, gitops has no Docker socket:
// it builds an image here, records the tag in bitswan.yaml, then pushes — so
// apply only ever deploys already-built images.
//
// SSE frame names (the `event:` field); `data:` is JSON:
//
//	log   → LogLine    (build/log output)
//	image → ImageRef   (terminal success of build-image)
//	error → ErrorResult (terminal failure)
const (
	PathBuildImage        = "/v1/build-image"
	PathContainersList    = "/v1/containers/list"
	PathContainersInspect = "/v1/containers/inspect"
	PathContainersLogs    = "/v1/containers/logs"
	PathContainersStop    = "/v1/containers/stop"
	PathContainersRestart = "/v1/containers/restart"
	PathContainersExec    = "/v1/containers/exec"
)

// HeaderExec carries the exec metadata (base64 of an ExecBody JSON) so the
// request body can be pure, streamed stdin (DB dumps are large/binary).
const HeaderExec = "X-Bitswan-Exec"

// ExecBody is the (base64-encoded, header-borne) metadata of an exec request.
type ExecBody struct {
	Ctx  WorkspaceContext `json:"ctx"`
	Spec ExecSpec         `json:"spec"`
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
	EventLog   = "log"
	EventImage = "image"
	EventError = "error"
)

// ListBody is the POST body for /v1/containers/list.
type ListBody struct {
	Ctx    WorkspaceContext `json:"ctx"`
	Filter ContainerFilter  `json:"filter"`
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
