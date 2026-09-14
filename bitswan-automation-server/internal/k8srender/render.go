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
	ServiceNameMax  = 63
	WorkloadNameMax = 47

	LabelValueMax = 63

	ManagedByLabel     = "app.kubernetes.io/managed-by"
	ManagedBy          = "bitswan"
	NameLabel          = "app.kubernetes.io/name"
	WorkspaceLabel     = "bitswan.io/workspace"
	ContainerNameLabel = "bitswan.io/container-name"
)

var (
	notLabelSafe = regexp.MustCompile(`[^-A-Za-z0-9_.]`)
	notNameSafe  = regexp.MustCompile(`[^a-z0-9-]`)
	dashRun      = regexp.MustCompile(`-{2,}`)
)

type Object map[string]interface{}

type ObjectSet []Object

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

func HashHex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

type Mount struct {
	Path     string
	SubPath  string
	ReadOnly bool
}

type Port struct {
	Name string
	Port int
}

type Probe struct {
	TCPPort       int
	Exec          []string
	PeriodSeconds int
	Failures      int
	InitialDelay  int
}

type Workload struct {
	Name           string
	Workspace      string
	Image          string
	PullPolicy     string
	Command        []string
	Args           []string
	Env            map[string]string
	EnvFrom        []string
	Mounts         []Mount
	Ports          []Port
	Replicas       int
	RequestsMem    string
	Readiness      *Probe
	Labels         map[string]string
	Annotations    map[string]string
	ContainerName  string
	ServiceAccount string
	VolumeClaim    string
	InitContainers []InitContainer
}

type InitContainer struct {
	Name         string
	Image        string
	PullPolicy   string
	Command      []string
	Env          map[string]string
	Mounts       []Mount
	Capabilities []string
}

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

func PVC(name, size, storageClass string) Object {
	spec := map[string]interface{}{
		"accessModes": []interface{}{"ReadWriteOnce"},
		"resources": map[string]interface{}{
			"requests": map[string]interface{}{"storage": size},
		},
	}
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
