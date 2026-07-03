package dockerdriver

import (
	"os"
	"strings"
	"testing"

	yaml "gopkg.in/yaml.v3"
)

const egressComposeFixture = `
version: "3"
services:
  wraptest-backend-6030-dev:
    image: internal/x:sha111
    network_mode: service:wraptest-fwgw-6030-dev
    labels:
      gitops.deployment_id: backend-test2-dev
  wraptest-fwgw-6030-dev:
    image: bitswan/egress-gateway:latest
    cap_add: [NET_ADMIN]
  wraptest-frontend-6030-dev:
    image: internal/f:sha222
    labels:
      gitops.deployment_id: frontend-test2-dev
`

func TestPrepareComposeForEgress(t *testing.T) {
	out, workers, all, err := prepareComposeForEgress(egressComposeFixture)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	// Only the network_mode:service worker is picked up; gateway + frontend are not.
	if len(workers) != 1 {
		t.Fatalf("workers = %d, want 1 (only the netns-sharing worker)", len(workers))
	}
	w := workers[0]
	if w.name != "wraptest-backend-6030-dev" || w.gateway != "wraptest-fwgw-6030-dev" {
		t.Errorf("worker = %+v, want name=…backend-6030-dev gateway=…fwgw-6030-dev", w)
	}
	if w.desiredHash == "" {
		t.Error("desiredHash empty")
	}
	if len(all) != 3 {
		t.Errorf("allServices = %d, want 3", len(all))
	}

	// The rewritten compose stamps the worker (and only the worker) with the hash
	// label equal to the computed desiredHash.
	var doc map[string]interface{}
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	svcs := doc["services"].(map[string]interface{})
	wlabels := svcs["wraptest-backend-6030-dev"].(map[string]interface{})["labels"].(map[string]interface{})
	if got := wlabels[egressHashLabel]; got != w.desiredHash {
		t.Errorf("stamped label = %v, want %s", got, w.desiredHash)
	}
	if gw, ok := svcs["wraptest-fwgw-6030-dev"].(map[string]interface{})["labels"]; ok {
		if m, _ := gw.(map[string]interface{}); m[egressHashLabel] != nil {
			t.Error("gateway must not be stamped (not an egress worker)")
		}
	}
}

func TestEgressHashStableAndSensitive(t *testing.T) {
	// Same input → same hash (idempotent across applies); a changed image (a real
	// deploy) → different hash (so it WILL be recreated).
	_, w1, _, _ := prepareComposeForEgress(egressComposeFixture)
	_, w2, _, _ := prepareComposeForEgress(egressComposeFixture)
	if w1[0].desiredHash != w2[0].desiredHash {
		t.Error("hash not stable across identical inputs")
	}
	changed := strings.Replace(egressComposeFixture, "sha111", "sha999", 1)
	_, w3, _, _ := prepareComposeForEgress(changed)
	if w3[0].desiredHash == w1[0].desiredHash {
		t.Error("hash did not change when the worker image changed")
	}
}

func TestComposeServiceNames(t *testing.T) {
	dir := t.TempDir()
	p := dir + "/dc.yaml"
	if err := os.WriteFile(p, []byte("services:\n  a:\n    image: x\n  b:\n    image: y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := composeServiceNames(p)
	if !got["a"] || !got["b"] || len(got) != 2 {
		t.Errorf("services = %v, want {a,b}", got)
	}
	if composeServiceNames(dir+"/missing.yaml") != nil {
		t.Error("missing file should yield nil (skip retirement)")
	}
}
