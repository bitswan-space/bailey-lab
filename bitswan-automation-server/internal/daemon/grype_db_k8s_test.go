package daemon

import (
	"strings"
	"testing"
)

// TestTheRefreshJobMatchesTheDockerContract keeps the two paths saying the same
// thing. The database is shared read-only with every workspace, so what writes
// it has to write where they read, with the cache directory they are pointed
// at, using the grype whose schema they scan with.
func TestTheRefreshJobMatchesTheDockerContract(t *testing.T) {
	job := grypeDBJob("bitswan/gitops:pinned", "bailey-config")

	spec, _ := job["spec"].(map[string]interface{})
	tmpl, _ := spec["template"].(map[string]interface{})
	pod, _ := tmpl["spec"].(map[string]interface{})
	containers, _ := pod["containers"].([]interface{})
	if len(containers) != 1 {
		t.Fatalf("the refresh runs %d containers", len(containers))
	}
	c, _ := containers[0].(map[string]interface{})

	// The pinned gitops image, not this daemon's: grype's binary and its
	// database schema have to match what the workspaces scan with.
	if got := c["image"]; got != "bitswan/gitops:pinned" {
		t.Errorf("refresh runs %v, not the pinned gitops image", got)
	}

	var cacheDir string
	for _, e := range c["env"].([]interface{}) {
		em, _ := e.(map[string]interface{})
		if em["name"] == "GRYPE_DB_CACHE_DIR" {
			cacheDir, _ = em["value"].(string)
		}
	}
	if cacheDir != "/grype-db" {
		t.Errorf("refresh writes to %q; the workspaces read /grype-db", cacheDir)
	}

	mounts, _ := c["volumeMounts"].([]interface{})
	var wroteTo string
	for _, m := range mounts {
		mm, _ := m.(map[string]interface{})
		if mm["mountPath"] == "/grype-db" {
			wroteTo, _ = mm["subPath"].(string)
			if ro, _ := mm["readOnly"].(bool); ro {
				t.Error("the refresh mounts the database read-only and cannot write it")
			}
		}
	}
	if wroteTo != grypeDBSubPath {
		t.Errorf("refresh writes subPath %q, workspaces read %q", wroteTo, grypeDBSubPath)
	}

	// The script the Docker path runs, unchanged: update, then make the result
	// readable by the unprivileged user the workspaces scan as.
	cmd, _ := c["command"].([]interface{})
	joined := ""
	for _, a := range cmd {
		joined += " " + a.(string)
	}
	if !strings.Contains(joined, "grype db update") || !strings.Contains(joined, "a+rX") {
		t.Errorf("refresh command is %q", strings.TrimSpace(joined))
	}

	// One failure is a failure. Retrying inside the Job would hide it behind
	// the backoff the caller already has, and report success it did not have.
	if spec["backoffLimit"] != 0 {
		t.Errorf("backoffLimit is %v", spec["backoffLimit"])
	}
}
