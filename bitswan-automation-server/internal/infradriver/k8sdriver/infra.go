package k8sdriver

import (
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
func (c *compileState) infraService(service, realm string) k8srender.ObjectSet {
	name := c.workspace + "__" + service + core.ServiceSuffix(realm)
	switch service {
	case "postgres":
		return c.postgres(name, realm)
	case "garage":
		return c.garage(name, realm)
	}
	return nil
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

	return statefulSet(statefulSetSpec{
		Name:      objName,
		Service:   svcName,
		Labels:    labels,
		Image:     imageOr("BITSWAN_GARAGE_IMAGE", "dxflrs/garage:v2.3.0"),
		Command:   []string{"/garage", "server"},
		Port:      3900,
		PortName:  "s3",
		MountPath: "/data",
		SubPath:   "data",
		Storage:   storageSizeOr("BITSWAN_K8S_GARAGE_STORAGE", "8Gi"),
		// The object store is ready when it answers, not when its process
		// starts: the provisioner mints keys and creates buckets against it, and
		// against a node that is still coming up those calls fail in ways that
		// read as permission problems.
		Readiness: &k8srender.Probe{TCPPort: 3900, PeriodSeconds: 3, Failures: 60},
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
	})
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
	VolumeClaim string
}

func statefulSet(s statefulSetSpec) k8srender.ObjectSet {
	selector := map[string]interface{}{k8srender.NameLabel: s.Service}

	container := map[string]interface{}{
		"name":  s.Service,
		"image": s.Image,
		"ports": []interface{}{
			map[string]interface{}{"name": s.PortName, "containerPort": s.Port},
		},
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
					"containers": []interface{}{container},
					"volumes": []interface{}{
						map[string]interface{}{"name": "tools", "emptyDir": map[string]interface{}{}},
					},
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
		k8srender.Service(s.Service, s.Labels, selector, []k8srender.Port{{Name: s.PortName, Port: s.Port}}),
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
