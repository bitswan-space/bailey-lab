package k8sdriver

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// The Kubernetes compiler is checked against the SAME declarations the Docker
// compiler's goldens use, because the point of the two backends is that they
// realize one declaration. What is asserted here is not a golden manifest —
// that would freeze incidental shape — but the properties Kubernetes and the
// rest of the system actually require of the output.

type scenario struct {
	WorkspaceName string `json:"workspace_name"`
	Domain        string `json:"domain"`
	Sources       []struct {
		Checksum string `json:"checksum"`
		TOML     string `json:"toml"`
	} `json:"sources"`
	SecretsFiles   []string          `json:"secrets_files"`
	SecretsContent map[string]string `json:"secrets_content"`
	BitswanYAML    string            `json:"bitswan_yaml"`
	WorkspaceRepo  map[string]string `json:"workspace_repo"`
}

func loadScenario(t *testing.T, name string) scenario {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "dockerdriver", "testdata", name+".scenario.json"))
	if err != nil {
		t.Fatalf("read scenario %s: %v", name, err)
	}
	var sc scenario
	if err := json.Unmarshal(raw, &sc); err != nil {
		t.Fatalf("parse scenario %s: %v", name, err)
	}
	return sc
}

func buildTree(t *testing.T, root string, sc scenario) infradriver.WorkspaceContext {
	t.Helper()
	gitops := filepath.Join(root, "gitops")
	secrets := filepath.Join(root, "secrets")
	for _, d := range []string{gitops, secrets} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p, content string) {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, s := range sc.Sources {
		write(filepath.Join(gitops, s.Checksum, "automation.toml"), s.TOML)
	}
	for _, sf := range sc.SecretsFiles {
		content := "DUMMY=1\n"
		if c, ok := sc.SecretsContent[sf]; ok {
			content = c
		}
		write(filepath.Join(secrets, sf), content)
	}
	for rel, content := range sc.WorkspaceRepo {
		write(filepath.Join(root, "workspace-repo", rel), content)
	}
	write(filepath.Join(gitops, "bitswan.yaml"), sc.BitswanYAML)

	t.Setenv("BITSWAN_WORKSPACE_REPO_DIR", filepath.Join(root, "workspace-repo"))
	t.Setenv("BITSWAN_K8S_VOLUME_CLAIM", "bailey-config")
	return infradriver.WorkspaceContext{
		WorkspaceName: sc.WorkspaceName,
		Domain:        sc.Domain,
		GitopsDir:     gitops,
		SecretsDir:    secrets,
	}
}

func compileScenario(t *testing.T, name string) (k8srender.ObjectSet, []infradriver.Route, scenario) {
	t.Helper()
	sc := loadScenario(t, name)
	wctx := buildTree(t, t.TempDir(), sc)
	bs, err := core.ParseBitswanYAML([]byte(sc.BitswanYAML))
	if err != nil {
		t.Fatalf("parse bitswan.yaml: %v", err)
	}
	c := &compileState{
		ctx:       wctx,
		bs:        bs,
		workspace: sc.WorkspaceName,
		domain:    sc.Domain,
		claim:     os.Getenv("BITSWAN_K8S_VOLUME_CLAIM"),
	}
	objs, routes, err := c.compile()
	if err != nil {
		t.Fatalf("compile %s: %v", name, err)
	}
	return objs, routes, sc
}

var scenarios = []string{"dev", "bluegreen", "staging", "livedev"}

func kindOf(o k8srender.Object) string { s, _ := o["kind"].(string); return s }
func metaOf(o k8srender.Object) map[string]interface{} {
	m, _ := o["metadata"].(map[string]interface{})
	return m
}
func nameOf(o k8srender.Object) string {
	n, _ := metaOf(o)["name"].(string)
	return n
}

var dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// TestEveryNameIsAddressable is the constraint Kubernetes will not bend on: an
// object whose name is not a DNS label is rejected at apply, and a Service whose
// name is over 63 characters is rejected even though a Deployment's may be
// longer. Both are reachable from a long workspace or automation name.
func TestEveryNameIsAddressable(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, _, _ := compileScenario(t, name)
			for _, o := range objs {
				n := nameOf(o)
				if !dnsLabel.MatchString(n) {
					t.Errorf("%s %q is not a DNS label", kindOf(o), n)
				}
				if len(n) > 63 {
					t.Errorf("%s %q is %d characters, over the 63 a name may have", kindOf(o), n, len(n))
				}
			}
		})
	}
}

// TestEveryLabelValueIsLegal guards the case that forced the annotation twins:
// a deployment identifier carries an "@" once a slot is involved, and a content
// hash is longer than a label value may be. Either one makes the whole apply
// fail, not just the object carrying it.
func TestEveryLabelValueIsLegal(t *testing.T) {
	legal := regexp.MustCompile(`^[a-zA-Z0-9]([-a-zA-Z0-9_.]*[a-zA-Z0-9])?$`)
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, _, _ := compileScenario(t, name)
			for _, o := range objs {
				for k, v := range labelsOf(o) {
					s, ok := v.(string)
					if !ok {
						t.Errorf("%s %q label %s is not a string", kindOf(o), nameOf(o), k)
						continue
					}
					if s == "" {
						continue
					}
					if len(s) > 63 || !legal.MatchString(s) {
						t.Errorf("%s %q label %s=%q is not a legal label value", kindOf(o), nameOf(o), k, s)
					}
				}
			}
		})
	}
}

// TestEveryRouteHasAService is what the ingress depends on: the daemon writes
// the upstream into Traefik's file provider verbatim, so an upstream naming
// something that was not created is a 502 with nothing in any log to explain it.
func TestEveryRouteHasAService(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, routes, _ := compileScenario(t, name)
			services := map[string]bool{}
			for _, o := range objs {
				if kindOf(o) == "Service" {
					services[nameOf(o)] = true
				}
			}
			for _, r := range routes {
				host, _, ok := strings.Cut(r.Upstream, ":")
				if !ok {
					t.Errorf("route %s has upstream %q with no port", r.Hostname, r.Upstream)
					continue
				}
				if !services[host] {
					t.Errorf("route %s points at %q, which no Service in this compile is named",
						r.Hostname, host)
				}
			}
		})
	}
}

// TestOneRoutePerHostname is the blue/green invariant. Both slots run; exactly
// one answers. Two routes for one hostname is a coin toss over which version a
// request reaches — the precise failure a promote exists to avoid.
func TestOneRoutePerHostname(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			_, routes, _ := compileScenario(t, name)
			seen := map[string]string{}
			for _, r := range routes {
				if prev, dup := seen[r.Hostname]; dup {
					t.Errorf("hostname %s is claimed by both %s and %s", r.Hostname, prev, r.Upstream)
				}
				seen[r.Hostname] = r.Upstream
			}
		})
	}
}

// TestProductionRunsBothSlots asserts the topology a promote needs to exist
// before it can use it: a production automation is two workloads, not one.
func TestProductionRunsBothSlots(t *testing.T) {
	objs, _, _ := compileScenario(t, "bluegreen")
	slots := map[string]int{}
	for _, o := range objs {
		if kindOf(o) != "Deployment" {
			continue
		}
		l := labelsOf(o)
		if l["gitops.stage"] != "production" {
			continue
		}
		slot, _ := l["gitops.slot"].(string)
		if slot != "" {
			slots[slot]++
		}
	}
	if len(slots) < 2 {
		t.Errorf("production compiled %d slot(s), want both: %v", len(slots), slots)
	}
}

// TestNothingEscapesTheSandbox is the assertion pass: a compiler that can be
// talked into a host mount or a privileged container has handed the namespace
// away, and every one of these is reachable from tenant-writable declaration
// fields.
func TestNothingEscapesTheSandbox(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, _, _ := compileScenario(t, name)
			for _, o := range objs {
				spec := podSpecOf(o)
				if spec == nil {
					continue
				}
				for _, forbidden := range []string{"hostNetwork", "hostPID", "hostIPC", "nodeName"} {
					if _, bad := spec[forbidden]; bad {
						t.Errorf("%s %q sets %s", kindOf(o), nameOf(o), forbidden)
					}
				}
				for _, v := range asSlice(spec["volumes"]) {
					vm, _ := v.(map[string]interface{})
					if _, bad := vm["hostPath"]; bad {
						t.Errorf("%s %q mounts a host path", kindOf(o), nameOf(o))
					}
				}
				for _, key := range []string{"containers", "initContainers"} {
					for _, c := range asSlice(spec[key]) {
						cm, _ := c.(map[string]interface{})
						sc, _ := cm["securityContext"].(map[string]interface{})
						if sc == nil {
							continue
						}
						if priv, _ := sc["privileged"].(bool); priv {
							t.Errorf("%s %q runs %v privileged", kindOf(o), nameOf(o), cm["name"])
						}
					}
					for _, c := range asSlice(spec[key]) {
						cm, _ := c.(map[string]interface{})
						for _, p := range asSlice(cm["ports"]) {
							pm, _ := p.(map[string]interface{})
							if _, bad := pm["hostPort"]; bad {
								t.Errorf("%s %q binds a host port", kindOf(o), nameOf(o))
							}
						}
					}
				}
			}
		})
	}
}

// TestOnlyTheRuleInstallerIsCapable states the arrangement plainly: NET_ADMIN
// exists in exactly one place, an init container that has exited by the time
// tenant code runs.
func TestOnlyTheRuleInstallerIsCapable(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, _, _ := compileScenario(t, name)
			for _, o := range objs {
				spec := podSpecOf(o)
				if spec == nil {
					continue
				}
				for _, c := range asSlice(spec["containers"]) {
					cm, _ := c.(map[string]interface{})
					sc, _ := cm["securityContext"].(map[string]interface{})
					if sc == nil {
						continue
					}
					if caps, _ := sc["capabilities"].(map[string]interface{}); caps != nil {
						if add := asSlice(caps["add"]); len(add) > 0 {
							t.Errorf("%s %q gives the app container %v", kindOf(o), nameOf(o), add)
						}
					}
				}
			}
		})
	}
}

// TestLiveDevRunsTheWorkingTree is the property that makes live-dev live: the
// author's tree is what runs, mounted read-only, rather than a built image.
func TestLiveDevRunsTheWorkingTree(t *testing.T) {
	objs, _, sc := compileScenario(t, "livedev")
	found := false
	for _, o := range objs {
		l := labelsOf(o)
		if kindOf(o) != "Deployment" || l["gitops.stage"] != "live-dev" {
			continue
		}
		// The firewall proxy shares the stage and writes its attempts log to
		// this same volume; it is not the automation.
		if l["gitops.firewall_proxy"] == "true" {
			continue
		}
		spec := podSpecOf(o)
		for _, c := range asSlice(spec["containers"]) {
			cm, _ := c.(map[string]interface{})
			for _, m := range asSlice(cm["volumeMounts"]) {
				mm, _ := m.(map[string]interface{})
				sub, _ := mm["subPath"].(string)
				if strings.HasPrefix(sub, fmt.Sprintf("workspaces/%s/", sc.WorkspaceName)) {
					found = true
					if ro, _ := mm["readOnly"].(bool); !ro {
						t.Errorf("live-dev mounts %s writable", sub)
					}
				}
			}
		}
	}
	if !found {
		t.Error("no live-dev workload mounts the author's working tree")
	}
}

func labelsOf(o k8srender.Object) map[string]interface{} {
	l, _ := metaOf(o)["labels"].(map[string]interface{})
	if l == nil {
		return map[string]interface{}{}
	}
	return l
}

func podSpecOf(o k8srender.Object) map[string]interface{} {
	spec, _ := o["spec"].(map[string]interface{})
	tmpl, _ := spec["template"].(map[string]interface{})
	ps, _ := tmpl["spec"].(map[string]interface{})
	return ps
}

func asSlice(v interface{}) []interface{} {
	s, _ := v.([]interface{})
	return s
}

// TestEveryEnvFromExists is referential integrity for the credentials: a
// workload that names a Secret which was not created starts with none of its
// environment — no database URL, no bucket key — and fails at its first query
// rather than at apply, which is far from where the mistake is.
func TestEveryEnvFromExists(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, _, _ := compileScenario(t, name)
			secrets := map[string]bool{}
			for _, o := range objs {
				if kindOf(o) == "Secret" {
					secrets[nameOf(o)] = true
				}
			}
			for _, o := range objs {
				spec := podSpecOf(o)
				if spec == nil {
					continue
				}
				for _, c := range asSlice(spec["containers"]) {
					cm, _ := c.(map[string]interface{})
					for _, ef := range asSlice(cm["envFrom"]) {
						efm, _ := ef.(map[string]interface{})
						ref, _ := efm["secretRef"].(map[string]interface{})
						n, _ := ref["name"].(string)
						if !secrets[n] {
							t.Errorf("%s %q reads env from Secret %q, which this compile does not create",
								kindOf(o), nameOf(o), n)
						}
					}
				}
			}
		})
	}
}

// TestAScopedBackendGetsItsCredentials states the point of the whole
// credentials pass: a process with a database of its own must actually be told
// how to reach it.
//
// Frontends are excluded, and deliberately: they carry the resource names for
// display but never the credentials, because a frontend is served to a browser
// and the code that talks to the database is behind it. The Docker compiler
// draws the line in the same place.
func TestAScopedBackendGetsItsCredentials(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, _, _ := compileScenario(t, name)
			for _, o := range objs {
				spec := podSpecOf(o)
				if spec == nil || labelsOf(o)["gitops.intended_exposed"] == "true" {
					continue
				}
				for _, c := range asSlice(spec["containers"]) {
					cm, _ := c.(map[string]interface{})
					scoped := false
					for _, e := range asSlice(cm["env"]) {
						em, _ := e.(map[string]interface{})
						if n, _ := em["name"].(string); n == "POSTGRES_DB" {
							if v, _ := em["value"].(string); v != "" {
								scoped = true
							}
						}
					}
					if scoped && len(asSlice(cm["envFrom"])) == 0 {
						t.Errorf("%s %q names a database of its own but is given no credentials for it",
							kindOf(o), nameOf(o))
					}
				}
			}
		})
	}
}

// TestCredentialsRollTheWorkloadExceptInProduction states both halves of how a
// changed secret reaches a running process. Kubernetes does not restart a pod
// when a Secret it reads through envFrom changes, so the content's fingerprint
// rides in the pod template — except on a production slot, which must not be
// recreated in place.
func TestCredentialsRollTheWorkloadExceptInProduction(t *testing.T) {
	a := credentialsFingerprint("", map[string]string{"A": "1"})
	b := credentialsFingerprint("", map[string]string{"A": "2"})
	if a == b {
		t.Error("two different credentials produced the same fingerprint; a change would not roll the workload")
	}
	if again := credentialsFingerprint("", map[string]string{"A": "1"}); again != a {
		t.Error("the same credentials produced two fingerprints; every apply would roll the workload")
	}
	if got := credentialsFingerprint("blue", map[string]string{"A": "1"}); got != "none" {
		t.Errorf("a production slot got fingerprint %q; a live slot must not be recreated in place", got)
	}
}

// TestEveryMountHasAVolume is the invariant a hand-written pod spec breaks
// silently: a volumeMount naming a volume the pod does not declare is accepted
// by the apply and rejected by the pod, so the object exists, looks right in a
// listing, and never produces a running container. Nothing in the compile can
// see it; only the StatefulSet's events say so.
func TestEveryMountHasAVolume(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, _, _ := compileScenario(t, name)
			for _, o := range objs {
				spec := podSpecOf(o)
				if spec == nil {
					continue
				}
				declared := map[string]bool{}
				for _, v := range asSlice(spec["volumes"]) {
					vm, _ := v.(map[string]interface{})
					if n, _ := vm["name"].(string); n != "" {
						declared[n] = true
					}
				}
				// A StatefulSet's claim templates are volumes too.
				sp, _ := o["spec"].(map[string]interface{})
				for _, ct := range asSlice(sp["volumeClaimTemplates"]) {
					cm, _ := ct.(map[string]interface{})
					meta, _ := cm["metadata"].(map[string]interface{})
					if n, _ := meta["name"].(string); n != "" {
						declared[n] = true
					}
				}
				for _, key := range []string{"containers", "initContainers"} {
					for _, c := range asSlice(spec[key]) {
						cm, _ := c.(map[string]interface{})
						for _, m := range asSlice(cm["volumeMounts"]) {
							mm, _ := m.(map[string]interface{})
							n, _ := mm["name"].(string)
							if !declared[n] {
								t.Errorf("%s %q container %v mounts volume %q, which the pod does not declare",
									kindOf(o), nameOf(o), cm["name"], n)
							}
						}
					}
				}
			}
		})
	}
}

// TestGarageCarriesItsTooling guards the other half of the same hand-written
// spec: the sidecar snapshots exec into, the config file without which the
// process exits on its first line, and a volume for every mount.
//
// The renderer is called directly rather than through a fixture, because none
// of the four declares an object store — a test that only runs when a fixture
// happens to want one is a test that silently does not run.
func TestGarageCarriesItsTooling(t *testing.T) {
	t.Setenv("BITSWAN_K8S_VOLUME_CLAIM", "bailey-config")
	c := &compileState{workspace: "ws", claim: "bailey-config"}
	objs, err := c.infraService("garage", "dev")
	if err != nil {
		t.Fatalf("render garage: %v", err)
	}

	var sts k8srender.Object
	for _, o := range objs {
		if kindOf(o) == "StatefulSet" {
			sts = o
		}
	}
	if sts == nil {
		t.Fatal("garage rendered no StatefulSet")
	}
	spec := podSpecOf(sts)

	names := map[string]bool{}
	for _, con := range asSlice(spec["containers"]) {
		cm, _ := con.(map[string]interface{})
		n, _ := cm["name"].(string)
		names[n] = true
	}
	if !names["toolbox"] {
		t.Errorf("garage has containers %v and no toolbox; snapshots have nowhere to run rclone", names)
	}

	declared := map[string]bool{}
	for _, v := range asSlice(spec["volumes"]) {
		vm, _ := v.(map[string]interface{})
		if n, _ := vm["name"].(string); n != "" {
			declared[n] = true
		}
	}
	sp, _ := sts["spec"].(map[string]interface{})
	for _, ct := range asSlice(sp["volumeClaimTemplates"]) {
		cm, _ := ct.(map[string]interface{})
		meta, _ := cm["metadata"].(map[string]interface{})
		if n, _ := meta["name"].(string); n != "" {
			declared[n] = true
		}
	}

	var config bool
	for _, key := range []string{"containers", "initContainers"} {
		for _, con := range asSlice(spec[key]) {
			cm, _ := con.(map[string]interface{})
			for _, m := range asSlice(cm["volumeMounts"]) {
				mm, _ := m.(map[string]interface{})
				path, _ := mm["mountPath"].(string)
				n, _ := mm["name"].(string)
				if path == "/etc/garage.toml" {
					config = true
				}
				if !declared[n] {
					t.Errorf("container %v mounts volume %q, which the pod does not declare — "+
						"the apply is accepted and no pod is ever created", cm["name"], n)
				}
			}
		}
	}
	if !config {
		t.Error("garage has no configuration mounted; it exits on its first line")
	}

	// Without --single-node there is no cluster layout, and every request is
	// answered "Layout not ready" — an object store that is up and refuses
	// everything, which reads at the client as a credentials problem.
	var single bool
	for _, con := range asSlice(spec["containers"]) {
		cm, _ := con.(map[string]interface{})
		for _, arg := range cm["command"].([]string) {
			if arg == "--single-node" {
				single = true
			}
		}
	}
	if !single {
		t.Error("garage is started without --single-node; it will have no cluster layout")
	}

	// The Service has to publish what the config binds, or a client handed
	// S3_PORT dials a port nothing is listening on.
	var published []interface{}
	for _, o := range objs {
		if kindOf(o) == "Service" {
			svcSpec, _ := o["spec"].(map[string]interface{})
			published = asSlice(svcSpec["ports"])
		}
	}
	var hasS3 bool
	for _, p := range published {
		pm, _ := p.(map[string]interface{})
		if n, _ := pm["port"].(int); n == garageS3Port {
			hasS3 = true
		}
	}
	if !hasS3 {
		t.Errorf("the object store's Service publishes %v, not the S3 port %d it binds", published, garageS3Port)
	}
}
