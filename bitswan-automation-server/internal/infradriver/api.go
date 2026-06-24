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
// The only RPCs are four operational container primitives, served as HTTP over
// the private UNIX socket (never network-reachable). They are transient actions
// / reads, NOT state changes — state changes go through a push:
//
//	POST /v1/containers/list    body ListBody      → JSON ContainerListResult
//	POST /v1/containers/logs    body LogsBody      → SSE: log* (until EOF/close)
//	POST /v1/containers/stop    body ContainerBody → JSON OKResult (or error)
//	POST /v1/containers/restart body ContainerBody → JSON OKResult (or error)
//
// SSE frame names (the `event:` field) for /v1/containers/logs; `data:` is JSON:
//
//	log   → LogLine
//	error → ErrorResult   (terminal failure)
const (
	PathContainersList    = "/v1/containers/list"
	PathContainersLogs    = "/v1/containers/logs"
	PathContainersStop    = "/v1/containers/stop"
	PathContainersRestart = "/v1/containers/restart"
)

// SSE event names (logs only — apply progress rides the git push, not SSE).
const (
	EventLog   = "log"
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
