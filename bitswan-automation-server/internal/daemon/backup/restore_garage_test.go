package backup

import (
	"archive/tar"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// garageDriver is a fake infra-driver covering the Garage restore's needs:
// container listing, the garage admin API over exec, rclone over exec, and the
// copy-in that pushes the archive into the toolbox (which mounts no volumes, so
// copy-in is the only route in).
type garageDriver struct {
	mu         sync.Mutex
	execs      [][]string
	copyIn     []string // "container:path" per call
	copyBytes  int
	buckets    []string
	failRclone bool
}

func (g *garageDriver) record(cmd []string) {
	g.mu.Lock()
	g.execs = append(g.execs, cmd)
	g.mu.Unlock()
}

func (g *garageDriver) argvContains(sub string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, cmd := range g.execs {
		if strings.Contains(strings.Join(cmd, " "), sub) {
			return true
		}
	}
	return false
}

func (g *garageDriver) server(t *testing.T, ws string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/containers/list":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"containers": []map[string]interface{}{
					{"id": "c1", "name": ws + "__garage", "state": "running"},
					{"id": "c2", "name": ws + "__garage-toolbox", "state": "running"},
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
			cmd := body.Spec.Cmd
			g.record(cmd)

			joined := strings.Join(cmd, " ")
			exit := 0
			switch {
			case strings.Contains(joined, "ListBuckets"):
				var entries []map[string]interface{}
				for _, b := range g.buckets {
					entries = append(entries, map[string]interface{}{"globalAliases": []string{b}})
				}
				payload, _ := json.Marshal(entries)
				writeFrame(w, 1, payload)
			case strings.Contains(joined, "rclone") && g.failRclone:
				writeFrame(w, 2, []byte("permission denied"))
				exit = 1
			}
			code := make([]byte, 4)
			code[3] = byte(exit)
			writeFrame(w, 3, code)
		case "/v1/containers/copy-in":
			meta, _ := base64.StdEncoding.DecodeString(r.Header.Get("X-Bitswan-Copy"))
			var body struct {
				Container string `json:"container"`
				Path      string `json:"path"`
			}
			json.Unmarshal(meta, &body)
			n, _ := io.Copy(io.Discard, r.Body)
			g.mu.Lock()
			g.copyIn = append(g.copyIn, body.Container+":"+body.Path)
			g.copyBytes += int(n)
			g.mu.Unlock()
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			http.NotFound(w, r)
		}
	}))
}

// buildGarageTar writes the archive shape dumpGarageStage produces: rooted at
// garage-backup/, with a manifest and one file per bucket.
func buildGarageTar(t *testing.T, path string, buckets []string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tw := tar.NewWriter(f)
	add := func(name string, data []byte) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	manifest, _ := json.Marshal(map[string]interface{}{
		"version": 1, "workspace": "ws1", "format": "rclone_sync",
		"buckets": buckets, "s3_host": "ws1-garage",
	})
	add("garage-backup/manifest.json", manifest)
	for _, b := range buckets {
		if strings.HasPrefix(b, "empty-") {
			continue // rclone writes no directory for a bucket with no objects
		}
		add("garage-backup/"+b+"/obj", []byte("payload-"+b))
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
}

// garageFixture wires HOME, the server config, the workspace secrets, a fake
// restic whose restore drops a prepared tar into --target, and the fake driver.
func garageFixture(t *testing.T, manifestBuckets, liveBuckets []string, failRclone bool) *garageDriver {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeServerConfig(t, "https://aoc.example.com")
	if err := SaveKey("k"); err != nil {
		t.Fatal(err)
	}

	// Workspace secrets: metadata (for the driver client) + the _system key the
	// restore authenticates with + the garage service file for host/port.
	wsDir := workspaceDir("ws1")
	credsDir := filepath.Join(wsDir, "secrets", "garagecreds", "production")
	if err := os.MkdirAll(credsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(credsDir, "_system"),
		[]byte("S3_ACCESS_KEY=GKtest\nS3_SECRET_KEY=secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wsDir, "secrets", "garage"),
		[]byte("S3_HOST=ws1-garage\nS3_PORT=9000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wsDir, "metadata.yaml"),
		[]byte("domain: example.com\ngitops-url: u\ngitops-secret: s\ninfra-driver-token: tok\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The tar the fake restic will "restore".
	srcTar := filepath.Join(home, "garage-src.tar")
	buildGarageTar(t, srcTar, manifestBuckets)
	fakeResticScript(t, `
target=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target="$a"; fi
  prev="$a"
done
if [ "$1" = "restore" ] && [ -n "$target" ]; then
  mkdir -p "$target"
  cp `+srcTar+` "$target/garage-backup-20260729-000000.tar"
fi
exit 0
`)

	driver := &garageDriver{buckets: liveBuckets, failRclone: failRclone}
	srv := driver.server(t, "ws1")
	t.Cleanup(srv.Close)
	old := driverBaseURL
	driverBaseURL = func(string) string { return srv.URL }
	t.Cleanup(func() { driverBaseURL = old })
	return driver
}

func TestRestoreGarageHappyPath(t *testing.T) {
	driver := garageFixture(t, []string{"bp-a", "bp-b"}, []string{"bp-a", "bp-b"}, false)

	out, err := RestoreGarage(context.Background(), "ws1", "production", "garage-snap", false)
	if err != nil {
		t.Fatalf("RestoreGarage: %v (%s)", err, out)
	}

	// The archive must be pushed to /tmp in the TOOLBOX (copy-in appends member
	// names to the destination, and the tar is rooted at garage-backup/).
	if len(driver.copyIn) != 1 || driver.copyIn[0] != "ws1__garage-toolbox:/tmp" {
		t.Errorf("copy-in = %v, want [ws1__garage-toolbox:/tmp]", driver.copyIn)
	}
	if driver.copyBytes == 0 {
		t.Error("copy-in received no bytes")
	}
	// Scratch must be reset before the push.
	if !driver.argvContains("rm -rf /tmp/garage-backup") {
		t.Error("scratch was never reset")
	}
	// rclone must copy (not sync) with the _system credentials.
	if !driver.argvContains("copy /tmp/garage-backup/bp-a :s3:bp-a") {
		t.Errorf("no rclone copy for bp-a: %v", driver.execs)
	}
	if !driver.argvContains("--s3-access-key-id GKtest") || !driver.argvContains("--s3-endpoint http://ws1-garage:9000") {
		t.Error("rclone argv missing the _system credentials or endpoint")
	}
	if driver.argvContains("sync /tmp/garage-backup") {
		t.Error("used sync without --garage-mirror; that would delete live objects")
	}
	if !strings.Contains(out, "bp-a") || !strings.Contains(out, "bp-b") {
		t.Errorf("summary does not name the restored buckets: %q", out)
	}
}

// mirror mode is the opt-in point-in-time restore.
func TestRestoreGarageMirrorUsesSync(t *testing.T) {
	driver := garageFixture(t, []string{"bp-a"}, []string{"bp-a"}, false)

	if _, err := RestoreGarage(context.Background(), "ws1", "production", "garage-snap", true); err != nil {
		t.Fatal(err)
	}
	if !driver.argvContains("sync /tmp/garage-backup/bp-a :s3:bp-a") {
		t.Errorf("mirror did not use sync: %v", driver.execs)
	}
}

// A bucket in the backup whose BP is gone must be reported, not re-created: a
// hand-made bucket would carry no key grants.
func TestRestoreGarageSkipsDepartedBucket(t *testing.T) {
	driver := garageFixture(t, []string{"bp-a", "bp-gone"}, []string{"bp-a"}, false)

	out, err := RestoreGarage(context.Background(), "ws1", "production", "garage-snap", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "bp-gone") || !strings.Contains(out, "skipped") {
		t.Errorf("summary does not report the skipped bucket: %q", out)
	}
	if driver.argvContains(":s3:bp-gone") {
		t.Error("attempted to restore into a bucket that no longer exists")
	}
}

// Unlike the backup direction, a failed bucket must fail the step — silently
// missing object data is data loss.
func TestRestoreGarageFailsOnBucketError(t *testing.T) {
	garageFixture(t, []string{"bp-a"}, []string{"bp-a"}, true)

	_, err := RestoreGarage(context.Background(), "ws1", "production", "garage-snap", false)
	if err == nil {
		t.Fatal("expected an error when a bucket's rclone failed")
	}
	if !strings.Contains(err.Error(), "bp-a") {
		t.Errorf("error does not name the failed bucket: %v", err)
	}
}

// A bucket that existed but held no objects at backup time has no directory in
// the archive (rclone creates none). Restoring it must be a silent no-op, not a
// failure on a missing source directory — a real drill hit exactly this.
func TestRestoreGarageSkipsEmptyBucket(t *testing.T) {
	driver := garageFixture(t, []string{"bp-a", "empty-b"}, []string{"bp-a", "empty-b"}, false)

	out, err := RestoreGarage(context.Background(), "ws1", "production", "garage-snap", false)
	if err != nil {
		t.Fatalf("an empty bucket must not fail the restore: %v", err)
	}
	if !strings.Contains(out, "empty-b") || !strings.Contains(out, "empty at backup time") {
		t.Errorf("summary does not explain the empty bucket: %q", out)
	}
	if driver.argvContains(":s3:empty-b") {
		t.Error("ran rclone for a bucket with no data in the archive")
	}
	if !driver.argvContains(":s3:bp-a") {
		t.Error("the populated bucket was not restored")
	}
}
