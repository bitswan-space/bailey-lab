package infradriver

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
)

// Server adapts a Driver to the HTTP contract in api.go: the four container
// primitives + build-image under /v1/* (SSE/JSON), and — when GitProjectRoot is
// set — the deploy repo over git smart-HTTP at every other path. Apply itself
// is NOT an endpoint: it is the deploy repo's post-receive hook (see README),
// which runs in this process on push. Everything is guarded by a shared bearer
// token (see tokenAuth).
type Server struct {
	driver Driver
	// GitProjectRoot is the dir containing the bare deploy repo; when non-empty
	// the handler serves git-http-backend for it. Empty disables git serving
	// (primitive-only, e.g. tests).
	GitProjectRoot string
	// Token is the shared secret guarding every endpoint; empty disables the
	// guard (single-host dev/test only).
	Token string
}

func NewServer(d Driver) *Server { return &Server{driver: d} }

// Handler returns the token-guarded mux: /v1/* primitives plus, if
// GitProjectRoot is set, git smart-HTTP for the deploy repo on all other paths.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(PathBuildImage, s.handleBuildImage)
	mux.HandleFunc(PathContainersList, s.handleList)
	mux.HandleFunc(PathContainersLogs, s.handleLogs)
	mux.HandleFunc(PathContainersStop, s.handleStop)
	mux.HandleFunc(PathContainersRestart, s.handleRestart)
	mux.HandleFunc(PathContainersExec, s.handleExec)
	if s.GitProjectRoot != "" {
		// git smart-HTTP lives at the root; /v1/* above takes precedence because
		// ServeMux longest-prefix matches the explicit primitive paths first.
		mux.Handle("/", gitCGIHandler(s.GitProjectRoot))
	}
	return tokenAuth(s.Token, mux)
}

func (s *Server) handleBuildImage(w http.ResponseWriter, r *http.Request) {
	var req BuildRequest
	if !decode(w, r, &req) {
		return
	}
	sse, ok := newSSE(w)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	img, err := s.driver.BuildImage(r.Context(), req, func(line string) { sse.send(EventLog, LogLine{Line: line}) })
	if err != nil {
		sse.send(EventError, ErrorResult{Error: err.Error()})
		return
	}
	sse.send(EventImage, img)
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	var body ListBody
	if !decode(w, r, &body) {
		return
	}
	containers, err := s.driver.ContainerList(r.Context(), body.Ctx, body.Filter)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, ContainerListResult{Containers: containers})
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	var body LogsBody
	if !decode(w, r, &body) {
		return
	}
	sse, ok := newSSE(w)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	if err := s.driver.ContainerLogs(r.Context(), body.Ctx, body.Container, body.Tail, body.Follow,
		func(l LogLine) { sse.send(EventLog, l) }); err != nil {
		sse.send(EventError, ErrorResult{Error: err.Error()})
	}
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	s.containerAction(w, r, func(ctx WorkspaceContext, name string) error {
		return s.driver.ContainerStop(r.Context(), ctx, name)
	})
}

func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	s.containerAction(w, r, func(ctx WorkspaceContext, name string) error {
		return s.driver.ContainerRestart(r.Context(), ctx, name)
	})
}

// handleExec proxies a container exec: metadata in the X-Bitswan-Exec header,
// streamed stdin in the request body, and a binary multiplexed
// stdout/stderr/exit stream in the response (see execframe.go).
func (s *Server) handleExec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	hdr := r.Header.Get(HeaderExec)
	raw, err := base64.StdEncoding.DecodeString(hdr)
	if err != nil {
		http.Error(w, "invalid "+HeaderExec+" header: "+err.Error(), http.StatusBadRequest)
		return
	}
	var body ExecBody
	if err := json.Unmarshal(raw, &body); err != nil {
		http.Error(w, "invalid exec metadata: "+err.Error(), http.StatusBadRequest)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	// Do NOT write the response header yet: the first frame's Write emits the
	// implicit 200. Responding before the request body (streamed stdin) is fully
	// uploaded makes the client abort the upload — and exec output only appears
	// after stdin is consumed (pg_dump has none; psql restore reads it all
	// first), so the first frame naturally lands after the upload completes.

	// Serialize frame writes (two pump goroutines + the terminal frame).
	var mu sync.Mutex
	emit := func(stream byte, payload []byte) {
		mu.Lock()
		defer mu.Unlock()
		_ = writeExecFrame(w, stream, payload)
		fl.Flush()
	}
	code, err := s.driver.ContainerExec(r.Context(), body.Ctx, body.Spec, r.Body, func(stderr bool, chunk []byte) {
		if stderr {
			emit(ExecStreamStderr, chunk)
		} else {
			emit(ExecStreamStdout, chunk)
		}
	})
	if err != nil {
		emit(ExecStreamError, []byte(err.Error()))
		return
	}
	var codeBuf [4]byte
	binary.BigEndian.PutUint32(codeBuf[:], uint32(int32(code)))
	emit(ExecStreamExit, codeBuf[:])
}

func (s *Server) containerAction(w http.ResponseWriter, r *http.Request, run func(WorkspaceContext, string) error) {
	var body ContainerBody
	if !decode(w, r, &body) {
		return
	}
	if err := run(body.Ctx, body.Container); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, OKResult{OK: true})
}

// --- helpers ---

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// sseWriter writes Server-Sent Events frames and flushes each one.
type sseWriter struct {
	w  http.ResponseWriter
	fl http.Flusher
}

func newSSE(w http.ResponseWriter) (*sseWriter, bool) {
	fl, ok := w.(http.Flusher)
	if !ok {
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fl.Flush()
	return &sseWriter{w: w, fl: fl}, true
}

func (s *sseWriter) send(event string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		b, _ = json.Marshal(ErrorResult{Error: "marshal " + event + ": " + err.Error()})
		event = EventError
	}
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, b)
	s.fl.Flush()
}
