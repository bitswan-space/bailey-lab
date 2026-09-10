package k8sdriver

import (
	"crypto/sha256"
	"encoding/hex"
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
	foundation, workloads, routes, err := c.compile()
	if err != nil {
		t.Fatalf("compile %s: %v", name, err)
	}
	return append(append(k8srender.ObjectSet{}, foundation...), workloads...), routes, sc
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

func TestLiveDevRunsTheWorkingTree(t *testing.T) {
	objs, _, sc := compileScenario(t, "livedev")
	found := false
	for _, o := range objs {
		l := labelsOf(o)
		if kindOf(o) != "Deployment" || l["gitops.stage"] != "live-dev" {
			continue
		}
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

func TestThePruneScopeMatchesTheLabelsItSweeps(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, _, _ := compileScenario(t, name)
			scopes := map[pruneScope]bool{}
			for _, s := range prunableScopes(objs) {
				scopes[s] = true
			}
			for _, o := range objs {
				if k := kindOf(o); k != "Deployment" && k != "Secret" {
					continue
				}
				labels := labelsOf(o)
				bp, _ := labels["gitops.bp"].(string)
				stage, _ := labels["gitops.stage"].(string)
				if bp == "" || stage == "" {
					continue
				}
				if !scopes[pruneScope{bp: bp, stage: stage}] {
					t.Errorf("%s %q is labelled bp=%q stage=%q, which no prune scope selects",
						kindOf(o), nameOf(o), bp, stage)
				}
			}
		})
	}
}

func TestACopyIsSweptByItsBusinessProcessNotItsContext(t *testing.T) {
	objs, _, _ := compileScenario(t, "livedev")
	scopes := prunableScopes(objs)
	if len(scopes) == 0 {
		t.Fatal("a live-dev compile produced no prune scope at all")
	}
	byBP := false
	for _, s := range scopes {
		if strings.HasPrefix(s.bp, "copy-") {
			t.Errorf("prune scope %q is the declaration's context, not its business process", s.bp)
		}
		if s.bp == "acme" {
			byBP = true
		}
	}
	if !byBP {
		t.Errorf("no prune scope for business process \"acme\"; got %v", scopes)
	}
}

func TestCredentialSecretsAreSweptWithTheirWorkload(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			objs, _, _ := compileScenario(t, name)
			byName := map[string]k8srender.Object{}
			for _, o := range objs {
				if kindOf(o) == "Secret" {
					byName[nameOf(o)] = o
				}
			}
			checked := 0
			for _, o := range objs {
				if kindOf(o) != "Deployment" {
					continue
				}
				owner := labelsOf(o)
				bp, _ := owner["gitops.bp"].(string)
				if bp == "" {
					continue
				}
				spec := podSpecOf(o)
				for _, c := range asSlice(spec["containers"]) {
					cm, _ := c.(map[string]interface{})
					for _, ef := range asSlice(cm["envFrom"]) {
						efm, _ := ef.(map[string]interface{})
						ref, _ := efm["secretRef"].(map[string]interface{})
						n, _ := ref["name"].(string)
						sec, ok := byName[n]
						if !ok {
							continue
						}
						checked++
						got := labelsOf(sec)
						for _, key := range []string{"gitops.bp", "gitops.stage", k8srender.WorkspaceLabel} {
							if got[key] != owner[key] {
								t.Errorf("Secret %q has %s=%v but its reader %q has %v; the sweep cannot see it",
									n, key, got[key], nameOf(o), owner[key])
							}
						}
					}
				}
			}
			if checked == 0 {
				t.Skip("no credential Secret in this scenario")
			}
		})
	}
}

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

func TestCredentialsRollTheWorkloadExceptInProduction(t *testing.T) {
	c := &compileState{ctx: infradriver.WorkspaceContext{SecretsDir: t.TempDir()}}
	a := c.credentialsFingerprint("", map[string]string{"A": "1"})
	b := c.credentialsFingerprint("", map[string]string{"A": "2"})
	if a == b {
		t.Error("two different credentials produced the same fingerprint; a change would not roll the workload")
	}
	if again := c.credentialsFingerprint("", map[string]string{"A": "1"}); again != a {
		t.Error("the same credentials produced two fingerprints; every apply would roll the workload")
	}
	if got := c.credentialsFingerprint("blue", map[string]string{"A": "1"}); got != "none" {
		t.Errorf("a production slot got fingerprint %q; a live slot must not be recreated in place", got)
	}
}

func TestTheCredentialAnnotationIsNotAnOracle(t *testing.T) {
	content := map[string]string{"PASSWORD": "hunter2"}
	one := &compileState{ctx: infradriver.WorkspaceContext{SecretsDir: t.TempDir()}}
	two := &compileState{ctx: infradriver.WorkspaceContext{SecretsDir: t.TempDir()}}
	got := one.credentialsFingerprint("", content)
	bare := sha256.Sum256([]byte("PASSWORD=hunter2\n"))
	if got == hex.EncodeToString(bare[:])[:16] {
		t.Error("the annotation is a bare digest of the credential content")
	}
	if other := two.credentialsFingerprint("", content); other == got {
		t.Error("two workspaces annotated the same credential identically; the digest is not keyed")
	}
}

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

func TestTheFoundationComesBeforeTheProcess(t *testing.T) {
	for _, name := range scenarios {
		t.Run(name, func(t *testing.T) {
			sc := loadScenario(t, name)
			wctx := buildTree(t, t.TempDir(), sc)
			bs, err := core.ParseBitswanYAML([]byte(sc.BitswanYAML))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			c := &compileState{
				ctx: wctx, bs: bs, workspace: sc.WorkspaceName,
				domain: sc.Domain, claim: os.Getenv("BITSWAN_K8S_VOLUME_CLAIM"),
			}
			foundation, workloads, _, err := c.compile()
			if err != nil {
				t.Fatalf("compile: %v", err)
			}

			for _, o := range foundation {
				switch kindOf(o) {
				case "StatefulSet", "Service", "Secret", "Deployment":
				default:
					t.Errorf("foundation holds a %s, which is not something a process runs on", kindOf(o))
				}
				if l := labelsOf(o); l["gitops.automation_name"] != nil {
					t.Errorf("%s is an automation and belongs in the second phase", nameOf(o))
				}
			}
			for _, o := range workloads {
				if kindOf(o) == "StatefulSet" {
					t.Errorf("%s is a StatefulSet in the workload phase; a database applied "+
						"beside the thing that authenticates against it is the race this split removes",
						nameOf(o))
				}
			}
		})
	}
}

func TestTheLiveSlotCarriesTheBareIdentifier(t *testing.T) {
	objs, _, _ := compileScenario(t, "bluegreen")

	bare, slotted := 0, 0
	for _, o := range objs {
		if kindOf(o) != "Deployment" || labelsOf(o)["gitops.stage"] != "production" {
			continue
		}
		spec, _ := o["spec"].(map[string]interface{})
		tmpl, _ := spec["template"].(map[string]interface{})
		tmeta, _ := tmpl["metadata"].(map[string]interface{})
		ann, _ := tmeta["annotations"].(map[string]interface{})
		id, _ := ann["gitops.bitswan.io/deployment_id"].(string)
		slot, _ := labelsOf(o)["gitops.slot"].(string)
		if slot == "" {
			continue
		}
		if strings.Contains(id, "@") {
			slotted++
			if !strings.HasSuffix(id, "@"+slot) {
				t.Errorf("%s is slot %q but its identifier is %q", nameOf(o), slot, id)
			}
		} else {
			bare++
		}
	}
	if bare == 0 {
		t.Error("no production container carries a bare identifier; gitops would report the stage as empty")
	}
	if slotted == 0 {
		t.Error("no production container carries a slotted identifier; the DR stage would show the live container")
	}
}
