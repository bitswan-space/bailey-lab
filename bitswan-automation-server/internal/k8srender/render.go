// Package k8srender turns the things a Bailey runs into Kubernetes objects.
//
// It is deliberately the only place that knows that shape. Two callers need it —
// the daemon, which brings up a workspace's own services, and the Kubernetes
// infra driver, which compiles a workspace's automations — and if each grew its
// own renderer they would drift on exactly the details that are hard to see in a
// diff: which label carries the workspace, whether a mount is a subPath, how a
// name is shortened when it runs past a DNS label.
//
// Objects are built as maps and marshalled, which is how the Docker driver builds
// compose. That keeps the renderer a pure function with no client and no cluster,
// so its whole output is a golden test.
package k8srender

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"

	yaml "gopkg.in/yaml.v3"
)

const (
	// A Service name is a DNS label, so 63 characters. A workload's name has to
	// leave room for the suffixes Kubernetes appends to build a pod name from it
	// (a ten-character template hash and a five-character ordinal), because the
	// pod's hostname is a DNS label too.
	ServiceNameMax  = 63
	WorkloadNameMax = 47

	// LabelValueMax is the Kubernetes limit on a label VALUE. Annotations have no
	// such limit, which is why anything that can exceed it — a content hash, an
	// identifier with a slot suffix — is carried as an annotation and only
	// mirrored into a label when it happens to fit.
	LabelValueMax = 63

	ManagedByLabel = "app.kubernetes.io/managed-by"
	ManagedBy      = "bitswan"
	NameLabel      = "app.kubernetes.io/name"
	WorkspaceLabel = "bitswan.io/workspace"
	// ContainerNameLabel carries the name this thing has on a Docker host, so
	// that the identifiers gitops already passes around keep resolving.
	ContainerNameLabel = "bitswan.io/container-name"
)

var (
	notLabelSafe = regexp.MustCompile(`[^-A-Za-z0-9_.]`)
	notNameSafe  = regexp.MustCompile(`[^a-z0-9-]`)
	dashRun      = regexp.MustCompile(`-{2,}`)
)

// Object is one Kubernetes object, kept as a map so the renderer stays a pure
// function of its input and its output is diffable.
type Object map[string]interface{}

// ObjectSet is an ordered set of objects. The order is the apply order — what
// must exist before a workload starts comes first — and it is stable, so the
// rendered YAML of an unchanged declaration is unchanged.
type ObjectSet []Object

// Marshal renders the set as a multi-document YAML stream.
func (s ObjectSet) Marshal() ([]byte, error) {
	var out strings.Builder
	for _, o := range s {
		b, err := yaml.Marshal(map[string]interface{}(o))
		if err != nil {
			return nil, fmt.Errorf("marshal %s/%s: %w", o.kind(), o.name(), err)
		}
		out.WriteString("---\n")
		out.Write(b)
	}
	return []byte(out.String()), nil
}

func (o Object) kind() string {
	k, _ := o["kind"].(string)
	return k
}

func (o Object) name() string {
	meta, _ := o["metadata"].(map[string]interface{})
	n, _ := meta["name"].(string)
	return n
}

// Name shortens a logical name to fit a Kubernetes name of at most max
// characters, and makes it a legal DNS label.
//
// A name that already fits and is already legal is returned unchanged, so the
// common case reads as itself. Anything else is truncated and given six
// characters of the hash of the ORIGINAL name, so two names that shorten to the
// same prefix stay distinct and the same name always shortens the same way.
func Name(logical string, max int) string {
	clean := dashRun.ReplaceAllString(notNameSafe.ReplaceAllString(strings.ToLower(logical), "-"), "-")
	clean = strings.Trim(clean, "-")
	if clean == "" {
		clean = "x"
	}
	if clean == strings.ToLower(logical) && len(clean) <= max {
		return clean
	}
	if len(clean) <= max {
		return clean
	}
	sum := sha256.Sum256([]byte(logical))
	keep := max - 7
	if keep < 1 {
		keep = 1
	}
	return strings.Trim(clean[:keep], "-") + "-" + hex.EncodeToString(sum[:])[:6]
}

// LabelValue projects a value into something a label can hold.
//
// It is lossy, and that is fine because it is never read back: the raw value
// lives in an annotation. What matters is that it is applied identically when a
// label is STAMPED and when a selector is BUILT from a caller's filter, so the
// round trip matches even though the projection does not invert. A deployment
// identifier like "backend-test@green" is the case that forces this — "@" is not
// a legal label value, and gitops selects on that exact string.
func LabelValue(v string) string {
	clean := notLabelSafe.ReplaceAllString(v, "-")
	clean = strings.Trim(clean, "-_.")
	if clean == "" {
		clean = "x"
	}
	if clean == v && len(clean) <= LabelValueMax {
		return clean
	}
	if len(clean) <= LabelValueMax {
		return clean
	}
	sum := sha256.Sum256([]byte(v))
	return strings.Trim(clean[:LabelValueMax-7], "-_.") + "-" + hex.EncodeToString(sum[:])[:6]
}

// HashHex is the hex sha256 of s, used wherever a value has to be derived the
// same way every time from something that is not itself safe to expose.
func HashHex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// Mount is one path a workload sees, taken from a subdirectory of the
// workspace's volume — the same shape the Docker driver mounts as a named-volume
// subpath.
type Mount struct {
	Path     string
	SubPath  string
	ReadOnly bool
}

// Port is a port a workload listens on. Name is required by Kubernetes when a
// workload has more than one.
type Port struct {
	Name string
	Port int
}

// Probe is a readiness check. Kubernetes ignores an image's own HEALTHCHECK, so
// anything that had one on Docker needs this or it is silently unchecked — and
// the difference matters: a Service with no ready pods sends no traffic, which is
// what keeps the ingress off a workload that is still starting.
type Probe struct {
	TCPPort       int
	Exec          []string
	PeriodSeconds int
	Failures      int
	InitialDelay  int
}

// Workload is one thing to run: an image, what it needs to run, and how to tell
// whether it is up.
type Workload struct {
	Name        string
	Workspace   string
	Image       string
	PullPolicy  string
	Command     []string
	Args        []string
	Env         map[string]string
	EnvFrom     []string
	Mounts      []Mount
	Ports       []Port
	Replicas    int
	RequestsMem string
	Readiness   *Probe
	Labels      map[string]string
	Annotations map[string]string
	// ContainerName is what this is called on a Docker host, carried so the
	// identifiers gitops passes around keep resolving to something.
	ContainerName string
	// ServiceAccount is left empty for anything that must not reach the API
	// server, which is everything a workspace runs.
	ServiceAccount string
	VolumeClaim    string
	// InitContainers run to completion before the workload starts. This is
	// where anything privileged belongs: it does its work and exits, so the
	// container that runs tenant code never holds the capability.
	InitContainers []InitContainer
}

// InitContainer is a step that must finish before the workload starts.
type InitContainer struct {
	Name string
	// Image is the tool, PullPolicy how hard to look for it.
	Image      string
	PullPolicy string
	Command    []string
	Env        map[string]string
	Mounts     []Mount
	// Capabilities are added to an otherwise capability-less container. The
	// egress firewall needs NET_ADMIN to write rules into the pod's network
	// namespace — and because this exits before the app container starts, the
	// app cannot undo them.
	Capabilities []string
}

// Deployment renders a workload as a Deployment plus, when it listens on
// anything, a Service named for it.
//
// The Service is named with the workload's logical name unshortened where it
// fits, because that name is what routes point at: an upstream is
// "<name>:<port>", and in a namespace a bare Service name resolves.
func Deployment(w Workload) ObjectSet {
	objName := Name(w.Name, WorkloadNameMax)
	svcName := Name(w.Name, ServiceNameMax)

	selector := map[string]interface{}{NameLabel: svcName}
	labels := map[string]interface{}{
		NameLabel:      svcName,
		ManagedByLabel: ManagedBy,
	}
	if w.Workspace != "" {
		labels[WorkspaceLabel] = LabelValue(w.Workspace)
	}
	if w.ContainerName != "" {
		labels[ContainerNameLabel] = LabelValue(w.ContainerName)
	}
	for k, v := range w.Labels {
		labels[k] = LabelValue(v)
	}

	annotations := map[string]interface{}{}
	if w.ContainerName != "" {
		annotations["bitswan.io/name"] = w.ContainerName
	}
	for k, v := range w.Annotations {
		annotations[k] = v
	}

	container := map[string]interface{}{
		"name":  Name(w.Name, ServiceNameMax),
		"image": w.Image,
	}
	if w.PullPolicy != "" {
		container["imagePullPolicy"] = w.PullPolicy
	}
	if len(w.Command) > 0 {
		container["command"] = w.Command
	}
	if len(w.Args) > 0 {
		container["args"] = w.Args
	}
	if len(w.Env) > 0 {
		container["env"] = envList(w.Env)
	}
	if len(w.EnvFrom) > 0 {
		refs := make([]interface{}, 0, len(w.EnvFrom))
		for _, name := range w.EnvFrom {
			refs = append(refs, map[string]interface{}{
				"secretRef": map[string]interface{}{"name": name},
			})
		}
		container["envFrom"] = refs
	}
	if len(w.Mounts) > 0 {
		mounts := make([]interface{}, 0, len(w.Mounts))
		for _, m := range w.Mounts {
			vm := map[string]interface{}{"name": "workspace", "mountPath": m.Path}
			if m.SubPath != "" {
				vm["subPath"] = m.SubPath
			}
			if m.ReadOnly {
				vm["readOnly"] = true
			}
			mounts = append(mounts, vm)
		}
		container["volumeMounts"] = mounts
	}
	if len(w.Ports) > 0 {
		ports := make([]interface{}, 0, len(w.Ports))
		for _, p := range w.Ports {
			cp := map[string]interface{}{"containerPort": p.Port}
			if p.Name != "" {
				cp["name"] = p.Name
			}
			ports = append(ports, cp)
		}
		container["ports"] = ports
	}
	if w.RequestsMem != "" {
		container["resources"] = map[string]interface{}{
			"requests": map[string]interface{}{"memory": w.RequestsMem},
		}
	}
	if w.Readiness != nil {
		container["readinessProbe"] = probe(w.Readiness)
	}

	podSpec := map[string]interface{}{
		"containers": []interface{}{container},
	}
	if len(w.InitContainers) > 0 {
		inits := make([]interface{}, 0, len(w.InitContainers))
		for _, ic := range w.InitContainers {
			inits = append(inits, initContainer(ic))
		}
		podSpec["initContainers"] = inits
	}
	if w.ServiceAccount != "" {
		podSpec["serviceAccountName"] = w.ServiceAccount
	} else {
		// Nothing a workspace runs has any business reaching the API server, and
		// a token it never asked for is a token that can leak.
		podSpec["automountServiceAccountToken"] = false
	}
	initMounts := 0
	for _, ic := range w.InitContainers {
		initMounts += len(ic.Mounts)
	}
	if w.VolumeClaim != "" && (len(w.Mounts) > 0 || initMounts > 0) {
		podSpec["volumes"] = []interface{}{
			map[string]interface{}{
				"name": "workspace",
				"persistentVolumeClaim": map[string]interface{}{
					"claimName": w.VolumeClaim,
				},
			},
		}
	}

	replicas := w.Replicas
	if replicas < 1 {
		replicas = 1
	}

	dep := Object{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]interface{}{
			"name":   objName,
			"labels": labels,
		},
		"spec": map[string]interface{}{
			"replicas": replicas,
			"selector": map[string]interface{}{"matchLabels": selector},
			"template": map[string]interface{}{
				"metadata": map[string]interface{}{
					"labels":      labels,
					"annotations": annotations,
				},
				"spec": podSpec,
			},
		},
	}

	out := ObjectSet{dep}
	if len(w.Ports) > 0 {
		out = append(out, Service(svcName, labels, selector, w.Ports))
	}
	return out
}

// Service exposes a workload under a name other things resolve.
func Service(name string, labels, selector map[string]interface{}, ports []Port) Object {
	sp := make([]interface{}, 0, len(ports))
	for _, p := range ports {
		e := map[string]interface{}{"port": p.Port, "targetPort": p.Port}
		if p.Name != "" {
			e["name"] = p.Name
		}
		sp = append(sp, e)
	}
	return Object{
		"apiVersion": "v1",
		"kind":       "Service",
		"metadata": map[string]interface{}{
			"name":   name,
			"labels": labels,
		},
		"spec": map[string]interface{}{
			"selector": selector,
			"ports":    sp,
		},
	}
}

// PVC is a volume for a workspace's own state, the analogue of the subtree of
// the shared Docker volume a workspace owns today.
func PVC(name, size, storageClass string) Object {
	spec := map[string]interface{}{
		"accessModes": []interface{}{"ReadWriteOnce"},
		"resources": map[string]interface{}{
			"requests": map[string]interface{}{"storage": size},
		},
	}
	// An empty class is left OUT rather than set: the empty string means "no
	// dynamic provisioning" and the claim would never bind, where absence means
	// the cluster's default class.
	if storageClass != "" {
		spec["storageClassName"] = storageClass
	}
	return Object{
		"apiVersion": "v1",
		"kind":       "PersistentVolumeClaim",
		"metadata": map[string]interface{}{
			"name": name,
			"labels": map[string]interface{}{
				NameLabel:      name,
				ManagedByLabel: ManagedBy,
			},
		},
		"spec": spec,
	}
}

// Secret carries what a workload reads as environment. The native shape: a
// workload cannot be handed an environment after it starts, so anything derived
// at runtime becomes a Secret the workload envFroms, and changing it rolls the
// workload rather than leaving it on a stale value.
func Secret(name string, values map[string]string, labels map[string]interface{}) Object {
	data := map[string]interface{}{}
	for _, k := range sortedKeys(values) {
		data[k] = values[k]
	}
	meta := map[string]interface{}{
		NameLabel:      name,
		ManagedByLabel: ManagedBy,
	}
	for k, v := range labels {
		meta[k] = v
	}
	return Object{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]interface{}{
			"name":   name,
			"labels": meta,
		},
		"type":       "Opaque",
		"stringData": data,
	}
}

func probe(p *Probe) map[string]interface{} {
	out := map[string]interface{}{}
	switch {
	case len(p.Exec) > 0:
		out["exec"] = map[string]interface{}{"command": p.Exec}
	case p.TCPPort > 0:
		out["tcpSocket"] = map[string]interface{}{"port": p.TCPPort}
	}
	if p.PeriodSeconds > 0 {
		out["periodSeconds"] = p.PeriodSeconds
	}
	if p.Failures > 0 {
		out["failureThreshold"] = p.Failures
	}
	if p.InitialDelay > 0 {
		out["initialDelaySeconds"] = p.InitialDelay
	}
	return out
}

func envList(env map[string]string) []interface{} {
	out := make([]interface{}, 0, len(env))
	for _, k := range sortedKeys(env) {
		out = append(out, map[string]interface{}{"name": k, "value": env[k]})
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// initContainer renders one pre-start step.
//
// Capabilities are added to a container that has none, and nothing else about
// it is privileged: writing egress rules needs NET_ADMIN and no more, and it
// needs it only until the rules are written.
func initContainer(ic InitContainer) map[string]interface{} {
	out := map[string]interface{}{
		"name":  Name(ic.Name, ServiceNameMax),
		"image": ic.Image,
	}
	if ic.PullPolicy != "" {
		out["imagePullPolicy"] = ic.PullPolicy
	}
	if len(ic.Command) > 0 {
		out["command"] = ic.Command
	}
	if len(ic.Env) > 0 {
		out["env"] = envList(ic.Env)
	}
	if len(ic.Mounts) > 0 {
		mounts := make([]interface{}, 0, len(ic.Mounts))
		for _, m := range ic.Mounts {
			vm := map[string]interface{}{"name": "workspace", "mountPath": m.Path}
			if m.SubPath != "" {
				vm["subPath"] = m.SubPath
			}
			if m.ReadOnly {
				vm["readOnly"] = true
			}
			mounts = append(mounts, vm)
		}
		out["volumeMounts"] = mounts
	}
	if len(ic.Capabilities) > 0 {
		caps := make([]interface{}, 0, len(ic.Capabilities))
		for _, c := range ic.Capabilities {
			caps = append(caps, c)
		}
		out["securityContext"] = map[string]interface{}{
			"capabilities": map[string]interface{}{"add": caps},
		}
	}
	return out
}
