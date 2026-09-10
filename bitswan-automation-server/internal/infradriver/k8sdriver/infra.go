package k8sdriver

import (
	"fmt"
	"os"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

func (c *compileState) infraService(service, realm string) (k8srender.ObjectSet, error) {
	name := c.workspace + "__" + service + core.ServiceSuffix(realm)
	switch service {
	case "postgres":
		return c.postgres(name, realm)
	case "garage":
		if c.volumeClaim() == "" {
			return nil, fmt.Errorf(
				"%s needs the workspace volume to read its configuration, and none is configured", name)
		}
		return c.garage(name, realm), nil
	}
	return nil, fmt.Errorf(
		"%q is declared as a service but the kubernetes driver cannot stand it up yet", service)
}

func (c *compileState) postgres(container, realm string) (k8srender.ObjectSet, error) {
	objName := k8srender.Name(container, k8srender.WorkloadNameMax)
	svcName := k8srender.Name(container, k8srender.ServiceNameMax)
	labels := c.infraLabels(svcName, container, realm)

	creds := map[string]string{"POSTGRES_DB": "postgres"}
	for k, v := range core.ServiceSecrets(c.ctx.SecretsDir, "postgres", realm) {
		if k == "POSTGRES_USER" || k == "POSTGRES_PASSWORD" {
			creds[k] = v
		}
	}
	if creds["POSTGRES_USER"] == "" || creds["POSTGRES_PASSWORD"] == "" {
		return nil, fmt.Errorf(
			"%s has no superuser credentials: gitops writes them beside the other secrets, "+
				"and inventing one here would be a password nobody chose", container)
	}
	secretName := objName + "-superuser"
	objs := k8srender.ObjectSet{k8srender.Secret(secretName, creds, c.infraSecretLabels(realm))}
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
		Readiness: &k8srender.Probe{
			Exec:          []string{"sh", "-c", `pg_isready -U "$POSTGRES_USER" -q`},
			PeriodSeconds: 5,
			Failures:      60,
		},
	})...)
	return objs, nil
}

func (c *compileState) garage(container, realm string) k8srender.ObjectSet {
	objName := k8srender.Name(container, k8srender.WorkloadNameMax)
	svcName := k8srender.Name(container, k8srender.ServiceNameMax)
	labels := c.infraLabels(svcName, container, realm)

	objs := garageServiceSecret(c, realm, objName)
	return append(objs, statefulSet(statefulSetSpec{
		Name:     objName,
		Service:  svcName,
		Labels:   labels,
		Image:    imageOr("BITSWAN_GARAGE_IMAGE", "dxflrs/garage:v2.3.0"),
		Command:  []string{"/garage", "server", "--single-node"},
		EnvFrom:  garageServiceEnv(c, realm, objName),
		Port:     garageS3Port,
		PortName: "s3",
		ExtraPorts: []k8srender.Port{
			{Name: "rpc", Port: 3901},
			{Name: "admin", Port: 3903},
		},
		MountPath:   "/data",
		SubPath:     "data",
		ExtraMounts: []k8srender.Mount{{Path: "/meta", SubPath: "meta"}},
		Storage:     storageSizeOr("BITSWAN_K8S_GARAGE_STORAGE", "8Gi"),
		Readiness:   &k8srender.Probe{TCPPort: garageS3Port, PeriodSeconds: 3, Failures: 60},
		Files: []k8srender.Mount{{
			Path:     "/etc/garage.toml",
			SubPath:  c.volumeSubPath("secrets/garage" + core.ServiceSuffix(realm) + ".toml"),
			ReadOnly: true,
		}},
		VolumeClaim: c.volumeClaim(),
		Sidecars: []sidecar{{
			Name:    "toolbox",
			Image:   imageOr("BITSWAN_GARAGE_TOOLBOX_IMAGE", "rclone/rclone:1.68"),
			Command: []string{"sleep", "infinity"},
		}},
	})...)
}

func garageServiceSecret(c *compileState, realm, objName string) k8srender.ObjectSet {
	values := core.ServiceSecrets(c.ctx.SecretsDir, "garage", realm)
	if len(values) == 0 {
		return nil
	}
	return k8srender.ObjectSet{k8srender.Secret(objName+"-service", values, c.infraSecretLabels(realm))}
}

func garageServiceEnv(c *compileState, realm, objName string) []string {
	if len(core.ServiceSecrets(c.ctx.SecretsDir, "garage", realm)) == 0 {
		return nil
	}
	return []string{objName + "-service"}
}

func (c *compileState) infraSecretLabels(realm string) map[string]interface{} {
	return map[string]interface{}{
		k8srender.WorkspaceLabel: k8srender.LabelValue(c.workspace),
		"gitops.realm":           realm,
	}
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
