package backup

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFrame emits one [stream][len][payload] exec frame (the driver's wire
// format — writeExecFrame is package-private to infradriver).
func writeFrame(w http.ResponseWriter, stream byte, payload []byte) {
	var hdr [5]byte
	hdr[0] = stream
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	w.Write(hdr[:])
	w.Write(payload)
}

// fakeDriver is an httptest infra-driver: reports one running postgres
// container and answers exec with a canned pg_dumpall result.
func fakeDriver(t *testing.T, ws string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/containers/list":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"containers": []map[string]interface{}{
					{"id": "c1", "name": ws + "__postgres", "state": "running"},
				},
			})
		case "/v1/containers/exec":
			meta, _ := base64.StdEncoding.DecodeString(r.Header.Get("X-Bitswan-Exec"))
			var body struct {
				Spec struct {
					Cmd []string `json:"cmd"`
				} `json:"spec"`
			}
			json.Unmarshal(meta, &body)
			if len(body.Spec.Cmd) > 0 && body.Spec.Cmd[0] == "pg_dumpall" {
				writeFrame(w, 1, []byte("-- PostgreSQL database cluster dump\n"))
			}
			exit := make([]byte, 4)
			writeFrame(w, 3, exit) // exit 0
		default:
			http.NotFound(w, r)
		}
	}))
}

func writeWorkspace(t *testing.T, ws string, withPostgres bool) {
	t.Helper()
	wsDir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces", ws)
	for _, sub := range []string{"secrets", "deployment", "workspace"} {
		if err := os.MkdirAll(filepath.Join(wsDir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	metadata := "domain: example.com\ngitops-url: u\ngitops-secret: s\ninfra-driver-token: tok\n"
	if err := os.WriteFile(filepath.Join(wsDir, "metadata.yaml"), []byte(metadata), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wsDir, "workspace", "app.py"), []byte("print('hi')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if withPostgres {
		secrets := "POSTGRES_USER=admin\nPOSTGRES_PASSWORD=pw\n"
		if err := os.WriteFile(filepath.Join(wsDir, "secrets", "postgres"), []byte(secrets), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// aocStub accepts every restic-proxy/key-mirror call the engine makes.
func aocStub(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/backups/restic-key") && r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
}

func TestEngineRunAll(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	aoc := aocStub(t)
	defer aoc.Close()
	writeServerConfig(t, aoc.URL)
	argvFile, _ := fakeRestic(t, 0, "")

	writeWorkspace(t, "ws1", true)
	driver := fakeDriver(t, "ws1")
	defer driver.Close()
	oldBase := driverBaseURL
	driverBaseURL = func(ws string) string { return driver.URL }
	defer func() { driverBaseURL = oldBase }()

	var engine Engine
	var logs []string
	report, err := engine.RunAll(context.Background(), func(line string) { logs = append(logs, line) })
	if err != nil {
		t.Fatalf("RunAll: %v (logs: %v)", err, logs)
	}
	if !report.OK {
		t.Fatalf("report not OK: %+v", report)
	}

	ws1 := report.Workspaces["ws1"]
	if !ws1["files"].Success {
		t.Errorf("files step failed: %+v", ws1["files"])
	}
	if !ws1["postgres"].Success || !strings.Contains(ws1["postgres"].Output, "production") {
		t.Errorf("postgres step = %+v", ws1["postgres"])
	}
	if !strings.Contains(ws1["couchdb"].Output, "not enabled") {
		t.Errorf("couchdb should be skipped: %+v", ws1["couchdb"])
	}
	if !report.ServerState.Success {
		t.Errorf("server state step failed: %+v", report.ServerState)
	}

	argv, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(argv)), "\n")
	var sawFiles, sawPostgres, sawServer, sawForget bool
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "forget"):
			sawForget = strings.Contains(line, "--prune") &&
				strings.Contains(line, "--group-by host,tags") &&
				strings.Contains(line, "--keep-daily 30") &&
				strings.Contains(line, "--keep-monthly 12")
		case strings.Contains(line, "--tag files --tag ws:ws1"):
			sawFiles = strings.Contains(line, "workspaces/ws1")
		case strings.Contains(line, "--tag postgres --tag ws:ws1 --tag stage:production"):
			sawPostgres = strings.Contains(line, "postgres.sql")
		case strings.Contains(line, "--tag server-config"):
			sawServer = true
		}
	}
	if !sawFiles || !sawPostgres || !sawServer || !sawForget {
		t.Errorf("restic argv missing steps (files=%v postgres=%v server=%v forget=%v):\n%s",
			sawFiles, sawPostgres, sawServer, sawForget, argv)
	}

	// Every backup line pins the host to the server id.
	for _, line := range lines {
		if strings.HasPrefix(line, "backup") && !strings.Contains(line, "--host srv-123") {
			t.Errorf("backup without --host: %s", line)
		}
	}

	last, err := LoadLastRun()
	if err != nil || last == nil || !last.OK {
		t.Errorf("last run not persisted: %+v, %v", last, err)
	}

	// Staging must not linger (it may hold DB dumps).
	if _, err := os.Stat(stagingRoot()); !os.IsNotExist(err) {
		t.Error("staging dir left behind")
	}
}

// One workspace's unreachable driver must not abort the run: its dump steps
// fail, its files step and every other workspace still succeed.
func TestEngineRunIsolatesWorkspaceFailures(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	aoc := aocStub(t)
	defer aoc.Close()
	writeServerConfig(t, aoc.URL)
	fakeRestic(t, 0, "")

	writeWorkspace(t, "ws-good", false) // no services enabled
	writeWorkspace(t, "ws-bad", true)   // postgres enabled, driver unreachable

	oldBase := driverBaseURL
	driverBaseURL = func(ws string) string { return "http://127.0.0.1:1" } // refused
	defer func() { driverBaseURL = oldBase }()

	var engine Engine
	report, err := engine.RunAll(context.Background(), func(string) {})
	if err != nil {
		t.Fatalf("RunAll must not abort on per-workspace failure: %v", err)
	}
	if report.OK {
		t.Error("report.OK should be false with a failed step")
	}
	if !report.Workspaces["ws-good"]["files"].Success {
		t.Errorf("healthy workspace affected: %+v", report.Workspaces["ws-good"])
	}
	if !report.Workspaces["ws-bad"]["files"].Success {
		t.Errorf("files step should not need the driver: %+v", report.Workspaces["ws-bad"])
	}
	if report.Workspaces["ws-bad"]["postgres"].Success {
		t.Error("postgres step should fail with unreachable driver")
	}
}

func TestEngineRejectsConcurrentRuns(t *testing.T) {
	var engine Engine
	if err := engine.begin(); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.RunAll(context.Background(), func(string) {}); err != ErrAlreadyRunning {
		t.Errorf("second run = %v, want ErrAlreadyRunning", err)
	}
	engine.end()
}

// TestRunAllReportsTheVersion pins that every run tells the AOC which binary made
// it. The AOC's copy of the version is the only one a disaster recovery can read
// before it has a binary — the manifest's copy is inside the encrypted repo — so a
// run that captures a new recovery point without reporting would leave the AOC
// naming a build that no longer matches the newest snapshot.
func TestRunAllReportsTheVersion(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	aoc := aocStub(t)
	defer aoc.Close()
	writeServerConfig(t, aoc.URL)
	fakeRestic(t, 0, "")

	writeWorkspace(t, "ws1", true)
	driver := fakeDriver(t, "ws1")
	defer driver.Close()
	oldBase := driverBaseURL
	driverBaseURL = func(ws string) string { return driver.URL }
	defer func() { driverBaseURL = oldBase }()

	reported := 0
	engine := Engine{VersionReporter: func() { reported++ }}
	if _, err := engine.RunAll(context.Background(), func(string) {}); err != nil {
		t.Fatalf("RunAll: %v", err)
	}
	if reported != 1 {
		t.Fatalf("expected exactly one version report per run, got %d", reported)
	}
}

// TestRunAllWithoutAVersionReporter guards the nil hook: the CLI and tests build
// an Engine directly, and a run must not depend on the daemon having wired it.
func TestRunAllWithoutAVersionReporter(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	aoc := aocStub(t)
	defer aoc.Close()
	writeServerConfig(t, aoc.URL)
	fakeRestic(t, 0, "")

	var engine Engine
	if _, err := engine.RunAll(context.Background(), func(string) {}); err != nil {
		t.Fatalf("RunAll with no VersionReporter: %v", err)
	}
}
