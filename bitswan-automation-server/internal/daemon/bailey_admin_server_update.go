package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// hostBinaryPath is where the running daemon's binary lives ON THE HOST, as seen
// from inside the daemon container through the /host mount. The daemon runs from
// a read-only bind-mount of the host binary, so it can't overwrite the file it's
// executing — but it CAN write the host copy via /host and then have the
// container restarted, which re-resolves the bind mount to the new file. Verified:
// a running container keeps the old inode; `docker restart` picks up the swap.
func hostBinaryPath() string {
	// The daemon container mounts the host binary at /usr/local/bin/bitswan.
	// Discover the real host source of that mount (robust to non-identity
	// installs) and view it through /host; fall back to the standard path.
	out, err := exec.Command("docker", "inspect", "-f",
		`{{range .Mounts}}{{if eq .Destination "/usr/local/bin/bitswan"}}{{.Source}}{{end}}{{end}}`,
		daemonContainerName).Output()
	src := strings.TrimSpace(string(out))
	if err != nil || src == "" {
		src = "/usr/local/bin/bitswan"
	}
	return filepath.Join(hostRootDir, src)
}

// handleAdminServerUpdate downloads the latest official bitswan binary from the
// AOC, atomically swaps it into place on the host, and restarts the daemon
// container so it runs the new binary — the browser-driven equivalent of
// `bitswan self-update`. Admin-only (gated by the dispatcher). Streams NDJSON
// progress; the final "restarting" event is the last thing the client sees
// before the connection drops (the daemon is replaced), after which it polls
// the version until it flips.
func (s *Server) handleAdminServerUpdate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	var mu sync.Mutex
	emit := func(m map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		line, _ := json.Marshal(m)
		_, _ = w.Write(append(line, '\n'))
		if flusher != nil {
			flusher.Flush()
		}
	}
	fail := func(msg string) { emit(map[string]any{"event": "error", "error": msg}) }

	// Only one self-update at a time: two admins triggering this at once would
	// otherwise race on the download + swap. Reject the second rather than queue.
	if !s.serverUpdateMu.TryLock() {
		fail("a server update is already in progress")
		return
	}
	defer s.serverUpdateMu.Unlock()

	emit(map[string]any{"event": "progress", "fraction": 0.02, "message": "Resolving the latest binary…"})

	settings, err := config.NewAutomationServerConfig().GetAutomationOperationsCenterSettings()
	if err != nil || settings.AOCUrl == "" {
		fail("this server is not registered with an AOC, so there's nowhere to download the official binary from")
		return
	}
	arch := runtime.GOARCH // "amd64" | "arm64" — matches the AOC binary endpoint
	if arch != "amd64" && arch != "arm64" {
		fail("unsupported architecture: " + arch)
		return
	}
	url := strings.TrimRight(settings.AOCUrl, "/") + "/api/automation_server/bitswan?arch=" + arch

	binPath := hostBinaryPath()
	dir := filepath.Dir(binPath)

	// --- download (stream progress by Content-Length) ---
	emit(map[string]any{"event": "progress", "fraction": 0.08, "message": "Downloading the new server binary…"})
	// Dial + response-header timeouts (NOT a total deadline — the body is a large
	// streamed binary) so a black-holed AOC fails fast instead of hanging forever.
	dlClient := &http.Client{Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
		ResponseHeaderTimeout: 30 * time.Second,
	}}
	resp, err := dlClient.Get(url)
	if err != nil {
		fail("download failed: " + err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		fail(fmt.Sprintf("AOC returned %d downloading the binary: %s", resp.StatusCode, strings.TrimSpace(string(body))))
		return
	}
	// Random temp name in the SAME dir (keeps the final rename atomic) so two
	// concurrent updates can't collide on a fixed path.
	tmp, err := os.CreateTemp(dir, ".bitswan-update-*")
	if err != nil {
		fail("cannot write to " + dir + ": " + err.Error())
		return
	}
	tmpPath := tmp.Name()
	total := resp.ContentLength
	var read int64
	buf := make([]byte, 256*1024)
	lastPct := -1.0
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				tmp.Close()
				_ = os.Remove(tmpPath)
				fail("write failed: " + werr.Error())
				return
			}
			read += int64(n)
			if total > 0 {
				// Map download to 0.08 → 0.70 of the overall bar.
				frac := 0.08 + 0.62*(float64(read)/float64(total))
				if frac-lastPct >= 0.02 {
					lastPct = frac
					emit(map[string]any{"event": "progress", "fraction": frac, "message": "Downloading the new server binary…"})
				}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			tmp.Close()
			_ = os.Remove(tmpPath)
			fail("download interrupted: " + rerr.Error())
			return
		}
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		fail("finalize download failed: " + err.Error())
		return
	}

	// --- validate BEFORE swapping: never install a binary that won't run ---
	emit(map[string]any{"event": "progress", "fraction": 0.75, "message": "Verifying the downloaded binary…"})
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		_ = os.Remove(tmpPath)
		fail("chmod failed: " + err.Error())
		return
	}
	verOut, verErr := exec.Command(tmpPath, "version").CombinedOutput()
	if verErr != nil || !strings.Contains(string(verOut), "bitswan") {
		_ = os.Remove(tmpPath)
		fail("the downloaded binary failed a sanity check (did not report a version) — not installing it")
		return
	}

	// --- atomic swap (keep the old one as .bak for `self-update --rollback`) ---
	emit(map[string]any{"event": "progress", "fraction": 0.85, "message": "Installing the new binary…"})
	if cur, err := os.ReadFile(binPath); err == nil {
		_ = os.WriteFile(binPath+".bak", cur, 0o755)
	}
	if err := os.Rename(tmpPath, binPath); err != nil {
		_ = os.Remove(tmpPath)
		fail("install failed (could not replace " + binPath + "): " + err.Error())
		return
	}

	// --- restart the daemon container to run the new binary ---
	// Verified mechanism: `docker restart` re-resolves the binary bind mount to
	// the freshly-swapped file. We emit the terminal event + flush FIRST, then
	// fire the restart after a short delay so the client receives it before the
	// connection drops with the daemon.
	emit(map[string]any{"event": "restarting", "fraction": 0.95,
		"message": "Restarting the server on the new version…", "version": strings.TrimSpace(string(verOut))})
	go func() {
		time.Sleep(1200 * time.Millisecond)
		// dockerd performs the stop+start server-side, so this completes even
		// though it kills the process that launched it.
		_ = exec.Command("docker", "restart", daemonContainerName).Run()
	}()
}
