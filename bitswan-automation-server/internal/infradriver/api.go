package infradriver

// HTTP/SSE wire contract between gitops (client) and the driver (server).
//
// Transport mirrors what gitops + the daemon already use elsewhere (plain HTTP
// for request/response, Server-Sent Events for streamed progress/logs/events) —
// no gRPC, no codegen. The driver listens on a private UNIX socket shared only
// with its paired gitops (and the daemon); it is never network-reachable.
//
// Request bodies are the JSON-tagged structs in driver.go. Long operations
// stream SSE frames and end with exactly one terminal frame:
//
//	POST /v1/apply         body ApplyRequest    → SSE: progress* then (done|error)
//	POST /v1/build-image   body BuildRequest    → SSE: log*      then (image|error)
//	POST /v1/snapshot      body SnapshotRequest → SSE: progress* then (done|error)
//	POST /v1/restore       body RestoreRequest  → SSE: progress* then (done|error)
//	POST /v1/status        body StatusBody      → JSON DeploymentStatus (not streamed)
//	POST /v1/logs          body LogsBody        → SSE: log*      (until EOF/close)
//	POST /v1/events        body WorkspaceContext→ SSE: event*    (until close)
//
// SSE frame names (the `event:` field); `data:` is the JSON payload:
//
//	progress → Progress
//	log      → LogLine
//	event    → Event
//	image    → ImageRef   (terminal success of build-image)
//	done     → ApplyResult (terminal success of apply/snapshot/restore)
//	error    → ErrorResult (terminal failure of any streamed op)
//
// A terminal frame is always the last frame; the client stops on done|image|error.
const (
	PathApply      = "/v1/apply"
	PathBuildImage = "/v1/build-image"
	PathSnapshot   = "/v1/snapshot"
	PathRestore    = "/v1/restore"
	PathStatus     = "/v1/status"
	PathLogs       = "/v1/logs"
	PathEvents     = "/v1/events"
)

// SSE event names.
const (
	EventProgress = "progress"
	EventLog      = "log"
	EventEvent    = "event"
	EventImage    = "image"
	EventDone     = "done"
	EventError    = "error"
)

// StatusBody is the POST body for /v1/status.
type StatusBody struct {
	Ctx           WorkspaceContext `json:"ctx"`
	DeploymentIDs []string         `json:"deployment_ids,omitempty"`
}

// LogsBody is the POST body for /v1/logs.
type LogsBody struct {
	Ctx       WorkspaceContext `json:"ctx"`
	Container string           `json:"container"`
	Tail      int              `json:"tail"`
	Follow    bool             `json:"follow"`
}

// ApplyResult is the terminal `done` frame of an apply/snapshot/restore: the
// routes the driver realized, so gitops can keep its own view in sync.
type ApplyResult struct {
	Routes []Route `json:"routes,omitempty"`
}

// ErrorResult is the terminal `error` frame of any streamed op.
type ErrorResult struct {
	Error string `json:"error"`
}

// DeploymentStatus is the (non-streamed) JSON response of /v1/status.
type DeploymentStatus struct {
	States []DeploymentState `json:"states"`
}
