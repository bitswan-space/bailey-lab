package k8sdriver

import (
	"fmt"
	"os"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// infraService renders the shared services a business process asks for, one set
// per stage.
//
// A StatefulSet rather than a Deployment, for the reason a database wants one:
// the volume belongs to the object rather than to a pod, so it survives the
// workload being replaced, and the pod's name is derived from the object's — it
// is always <name>-0 — which is what makes an exec-based backup or a psql
// provisioning step able to find it without a lookup.
func (c *compileState) infraService(service, realm string) (k8srender.ObjectSet, error) {
	name := c.workspace + "__" + service + core.ServiceSuffix(realm)
	switch service {
	case "postgres":
		return c.postgres(name, realm), nil
	case "garage":
		// Garage reads its config off the workspace volume. Rendering the mount
		// without the volume produces a pod the API server rejects for a reason
		// that names neither the setting nor the service.
		if c.volumeClaim() == "" {
			return nil, fmt.Errorf(
				"%s needs the workspace volume to read its configuration, and none is configured", name)
		}
		return c.garage(name, realm), nil
	}
	return nil, fmt.Errorf(
		"%q is declared as a service but the kubernetes driver cannot stand it up yet", service)
}

func (c *compileState) postgres(container, realm string) k8srender.ObjectSet {
	objName := k8srender.Name(container, k8srender.WorkloadNameMax)
	svcName := k8srender.Name(container, k8srender.ServiceNameMax)
	labels := c.infraLabels(svcName, container, realm)

	// The superuser comes from the service secrets gitops writes, because the
	// coordinates a business process is handed come from that same file: a
	// password generated here instead would mean the database and the things
	// told how to reach it disagree. A workspace that has no such file yet gets
	// a stable generated one, so a first apply still stands the database up.
	creds := map[string]string{
		"POSTGRES_USER":     "postgres",
		"POSTGRES_PASSWORD": stableSecret("postgres", container),
		"POSTGRES_DB":       "postgres",
	}
	for k, v := range core.ServiceSecrets(c.ctx.SecretsDir, "postgres", realm) {
		if k == "POSTGRES_USER" || k == "POSTGRES_PASSWORD" {
			creds[k] = v
		}
	}
	secretName := objName + "-superuser"
	objs := k8srender.ObjectSet{k8srender.Secret(secretName, creds)}
	objs = append(objs, statefulSet(statefulSetSpec{
		Name:      objName,
		Service:   svcName,
		Labels:    labels,
		Image:     imageOr("BITSWAN_POSTGRES_IMAGE", "postgres:16"),
		Port:      5432,
		PortName:  "postgres",
		EnvFrom:   []string{secretName},
		MountPath: "/var/lib/postgresql/data",
		SubPath:   "pgdata",
		Storage:   storageSizeOr("BITSWAN_K8S_POSTGRES_STORAGE", "8Gi"),
		// pg_isready, with the fast first probe the compose healthcheck uses so
		// a cold start is noticed the moment it finishes rather than up to a
		// whole interval later.
		Readiness: &k8srender.Probe{
			Exec:          []string{"sh", "-c", `pg_isready -U "$POSTGRES_USER" -q`},
			PeriodSeconds: 5,
			Failures:      60,
		},
	})...)
	return objs
}

func (c *compileState) garage(container, realm string) k8srender.ObjectSet {
	objName := k8srender.Name(container, k8srender.WorkloadNameMax)
	svcName := k8srender.Name(container, k8srender.ServiceNameMax)
	labels := c.infraLabels(svcName, container, realm)

	objs := garageServiceSecret(c, realm, objName)
	return append(objs, statefulSet(statefulSetSpec{
		Name:    objName,
		Service: svcName,
		Labels:  labels,
		Image:   imageOr("BITSWAN_GARAGE_IMAGE", "dxflrs/garage:v2.3.0"),
		// --single-node creates the one-node cluster layout on first boot.
		// Without it the process starts, listens, and answers every request
		// with "Layout not ready" — an object store that is up and refuses
		// everything, which reads as a credentials problem.
		Command: []string{"/garage", "server", "--single-node"},
		// The same service secrets the Docker service takes as an env_file.
		// The config file carries the rpc secret and the admin token, but the
		// tooling that execs in reads them from the environment.
		EnvFrom: garageServiceEnv(c, realm, objName),
		// The ports the config file actually binds, not the defaults: a client
		// is handed S3_PORT out of the same secrets gitops wrote that config
		// from, so a Service publishing anything else is a coordinate pointing
		// at nothing.
		Port:     garageS3Port,
		PortName: "s3",
		ExtraPorts: []k8srender.Port{
			{Name: "rpc", Port: 3901},
			{Name: "admin", Port: 3903},
		},
		MountPath: "/data",
		SubPath:   "data",
		// The metadata lives on the volume too. Left in the container's writable
		// layer it survives exactly until the pod is replaced, and then the
		// store comes back knowing about none of its own buckets.
		ExtraMounts: []k8srender.Mount{{Path: "/meta", SubPath: "meta"}},
		Storage:     storageSizeOr("BITSWAN_K8S_GARAGE_STORAGE", "8Gi"),
		// The object store is ready when it answers, not when its process
		// starts: the provisioner mints keys and creates buckets against it, and
		// against a node that is still coming up those calls fail in ways that
		// read as permission problems.
		Readiness: &k8srender.Probe{TCPPort: garageS3Port, PeriodSeconds: 3, Failures: 60},
		// Garage reads its RPC secret, admin token and ports from a file gitops
		// writes beside the other secrets. Without it the process exits on its
		// first line — it has no defaults to fall back on — so this mount is
		// what makes the object store start at all.
		Files: []k8srender.Mount{{
			Path:     "/etc/garage.toml",
			SubPath:  c.volumeSubPath("secrets/garage" + core.ServiceSuffix(realm) + ".toml"),
			ReadOnly: true,
		}},
		VolumeClaim: c.volumeClaim(),
		// The rclone sidecar. Snapshot and restore move bucket contents by
		// exec'ing rclone somewhere, and Garage's own image is a single static
		// binary with no shell and no rclone in it. On Docker that somewhere is
		// a sibling container; here it is a second container in the same pod,
		// which is the same thing with one fewer object and a shared lifecycle.
		Sidecars: []sidecar{{
			Name:    "toolbox",
			Image:   imageOr("BITSWAN_GARAGE_TOOLBOX_IMAGE", "rclone/rclone:1.68"),
			Command: []string{"sleep", "infinity"},
		}},
	})...)
}

// garageServiceSecret carries the object store's own credentials, the ones the
// Docker service takes as an env_file. Nothing when gitops has not written them
// yet, which is a workspace whose object store has not been enabled.
func garageServiceSecret(c *compileState, realm, objName string) k8srender.ObjectSet {
	values := core.ServiceSecrets(c.ctx.SecretsDir, "garage", realm)
	if len(values) == 0 {
		return nil
	}
	return k8srender.ObjectSet{k8srender.Secret(objName+"-service", values)}
}

func garageServiceEnv(c *compileState, realm, objName string) []string {
	if len(core.ServiceSecrets(c.ctx.SecretsDir, "garage", realm)) == 0 {
		return nil
	}
	return []string{objName + "-service"}
}

func (c *compileState) infraLabels(svcName, container, realm string) map[string]interface{} {
	return map[string]interface{}{
		k8srender.NameLabel:          svcName,
		k8srender.ManagedByLabel:     k8srender.ManagedBy,
		k8srender.WorkspaceLabel:     k8srender.LabelValue(c.workspace),
		k8srender.ContainerNameLabel: k8srender.LabelValue(container),
		"gitops.realm":               realm,
	}
}

type statefulSetSpec struct {
	Name        string
	Service     string
	Labels      map[string]interface{}
	Image       string
	Command     []string
	Port        int
	PortName    string
	EnvFrom     []string
	MountPath   string
	SubPath     string
	Storage     string
	Readiness   *k8srender.Probe
	Files       []k8srender.Mount
	ExtraPorts  []k8srender.Port
	ExtraMounts []k8srender.Mount
	VolumeClaim string
	Sidecars    []sidecar
}

// sidecar is a second container in an infra service's pod: a tool the main
// image does not carry, kept alive so something can be exec'd into it.
type sidecar struct {
	Name    string
	Image   string
	Command []string
}

func statefulSet(s statefulSetSpec) k8srender.ObjectSet {
	selector := map[string]interface{}{k8srender.NameLabel: s.Service}

	container := map[string]interface{}{
		"name":         s.Service,
		"image":        s.Image,
		"ports":        containerPorts(s),
		"volumeMounts": containerMounts(s),
	}
	if len(s.Command) > 0 {
		container["command"] = s.Command
	}
	if len(s.EnvFrom) > 0 {
		refs := make([]interface{}, 0, len(s.EnvFrom))
		for _, n := range s.EnvFrom {
			refs = append(refs, map[string]interface{}{
				"secretRef": map[string]interface{}{"name": n},
			})
		}
		container["envFrom"] = refs
	}
	if s.Readiness != nil {
		container["readinessProbe"] = probeMap(s.Readiness)
	}

	sts := k8srender.Object{
		"apiVersion": "apps/v1",
		"kind":       "StatefulSet",
		"metadata": map[string]interface{}{
			"name":   s.Name,
			"labels": s.Labels,
		},
		"spec": map[string]interface{}{
			"replicas":    1,
			"serviceName": s.Service,
			"selector":    map[string]interface{}{"matchLabels": selector},
			"template": map[string]interface{}{
				"metadata": map[string]interface{}{"labels": s.Labels},
				"spec": map[string]interface{}{
					"automountServiceAccountToken": false,
					// A snapshot has to read bytes out of these, and `docker cp` has
					// no counterpart here: kubectl's copy is exec plus tar, and
					// neither Garage's static binary nor a slim database image ships
					// one. A static busybox is staged into a volume of its own, where
					// it shadows nothing in the image.
					"initContainers": []interface{}{
						map[string]interface{}{
							"name":    "stage-tools",
							"image":   imageOr("BITSWAN_TOOLS_IMAGE", "busybox:1.36"),
							"command": []interface{}{"cp", "/bin/busybox", toolsDir + "/busybox"},
							"volumeMounts": []interface{}{
								map[string]interface{}{"name": "tools", "mountPath": toolsDir},
							},
						},
					},
					"containers": statefulSetContainers(s, container),
					"volumes":    podVolumes(s),
				},
			},
			// The claim belongs to the object, so replacing the workload keeps
			// the data — the same promise `docker rm` makes by leaving a named
			// volume behind.
			"volumeClaimTemplates": []interface{}{
				map[string]interface{}{
					"metadata": map[string]interface{}{"name": "data"},
					"spec": map[string]interface{}{
						"accessModes": []interface{}{"ReadWriteOnce"},
						"resources": map[string]interface{}{
							"requests": map[string]interface{}{"storage": s.Storage},
						},
					},
				},
			},
		},
	}

	return k8srender.ObjectSet{
		sts,
		k8srender.Service(s.Service, s.Labels, selector,
			append([]k8srender.Port{{Name: s.PortName, Port: s.Port}}, s.ExtraPorts...)),
	}
}

func probeMap(p *k8srender.Probe) map[string]interface{} {
	out := map[string]interface{}{}
	if len(p.Exec) > 0 {
		out["exec"] = map[string]interface{}{"command": p.Exec}
	} else if p.TCPPort > 0 {
		out["tcpSocket"] = map[string]interface{}{"port": p.TCPPort}
	}
	if p.PeriodSeconds > 0 {
		out["periodSeconds"] = p.PeriodSeconds
	}
	if p.Failures > 0 {
		out["failureThreshold"] = p.Failures
	}
	return out
}

func imageOr(env, fallback string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	return fallback
}

func storageSizeOr(env, fallback string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	return fallback
}

func envOr(env, fallback string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	return fallback
}

// stableSecret derives a password from the workspace's own secret material so it
// is the same on every apply — a fresh one each time would lock the database out
// of itself on the second reconcile — without being a constant anyone can guess.
func stableSecret(purpose, scope string) string {
	seed := os.Getenv("BITSWAN_INFRA_DRIVER_TOKEN")
	if seed == "" {
		seed = "bitswan"
	}
	return k8srender.LabelValue(purpose + "-" + hashHex(seed + "/" + scope)[:24])
}

func hashHex(s string) string {
	return k8srender.HashHex(s)
}

// containerMounts is the data volume, the staged tools, and any single files
// this service reads out of the workspace volume.
func containerMounts(s statefulSetSpec) []interface{} {
	out := []interface{}{
		map[string]interface{}{"name": "data", "mountPath": s.MountPath, "subPath": s.SubPath},
		map[string]interface{}{"name": "tools", "mountPath": toolsDir},
	}
	for _, m := range s.ExtraMounts {
		out = append(out, map[string]interface{}{
			"name": "data", "mountPath": m.Path, "subPath": m.SubPath,
		})
	}
	for _, f := range s.Files {
		m := map[string]interface{}{"name": "workspace", "mountPath": f.Path}
		if f.SubPath != "" {
			m["subPath"] = f.SubPath
		}
		if f.ReadOnly {
			m["readOnly"] = true
		}
		out = append(out, m)
	}
	return out
}

func podVolumes(s statefulSetSpec) []interface{} {
	out := []interface{}{
		map[string]interface{}{"name": "tools", "emptyDir": map[string]interface{}{}},
	}
	if len(s.Files) > 0 && s.VolumeClaim != "" {
		out = append(out, map[string]interface{}{
			"name":                  "workspace",
			"persistentVolumeClaim": map[string]interface{}{"claimName": s.VolumeClaim},
		})
	}
	return out
}

// statefulSetContainers is the service and whatever tooling it needs beside it.
func statefulSetContainers(s statefulSetSpec, main map[string]interface{}) []interface{} {
	out := []interface{}{main}
	for _, sc := range s.Sidecars {
		c := map[string]interface{}{
			"name":  sc.Name,
			"image": sc.Image,
			"volumeMounts": []interface{}{
				map[string]interface{}{"name": "tools", "mountPath": toolsDir},
			},
		}
		if len(sc.Command) > 0 {
			c["command"] = sc.Command
		}
		out = append(out, c)
	}
	return out
}

// garageS3Port is where the config gitops writes binds the S3 API.
const garageS3Port = 9000

func containerPorts(s statefulSetSpec) []interface{} {
	out := []interface{}{
		map[string]interface{}{"name": s.PortName, "containerPort": s.Port},
	}
	for _, p := range s.ExtraPorts {
		out = append(out, map[string]interface{}{"name": p.Name, "containerPort": p.Port})
	}
	return out
}
