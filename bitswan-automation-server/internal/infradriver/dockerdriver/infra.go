package dockerdriver

import (
	"os"
	"path/filepath"
	"sort"
)

// Infra-service compose generation — port of the
// {postgres,garage,couchdb,kafka}_service.py `_generate_compose_dict` methods
// plus the InfraService base name computation and `_merge_infra_services`.
//
// Each service's names derive from (workspace_name, service_type, stage):
//   service_suffix    = "-<stage>" for non-production, "" for production
//   secrets_file_name = "<type><suffix>"
//   container_name    = "<ws>__<type><suffix>"
//   volume_name       = "<ws>-<type><suffix>-data"
// A service is emitted only when is_enabled() — its secrets file exists on the
// secrets volume.

func serviceSuffix(stage string) string {
	if stage == "production" || stage == "" {
		return ""
	}
	return "-" + stage
}

type infraNames struct {
	suffix        string
	secretsName   string
	secretsPath   string
	containerName string
	volumeName    string
	workspaceName string
}

func infraNamesFor(secretsDir, workspaceName, svcType, stage string) infraNames {
	suffix := serviceSuffix(stage)
	secretsName := svcType + suffix
	return infraNames{
		suffix:        suffix,
		secretsName:   secretsName,
		secretsPath:   filepath.Join(secretsDir, secretsName),
		containerName: workspaceName + "__" + svcType + suffix,
		volumeName:    workspaceName + "-" + svcType + suffix + "-data",
		workspaceName: workspaceName,
	}
}

// infraLabels are stamped on every infra service so the driver's workspace
// scoping permits gitops-initiated exec into them (snapshots/backups/copy-DB
// clone target postgres/minio/couchdb by container name).
func (n infraNames) infraLabels() map[string]interface{} {
	return map[string]interface{}{"gitops.workspace": n.workspaceName}
}

// infraEnabled reports is_enabled(): the service's secrets file exists.
func infraEnabled(secretsDir, svcType, stage string) bool {
	n := infraNamesFor(secretsDir, "", svcType, stage)
	_, err := os.Stat(n.secretsPath)
	return err == nil
}

// infraServiceSecretsName is the secrets file name a service dependency injects
// (InfraService.secrets_file_name) — used by _resolve_service_secrets.
func infraServiceSecretsName(svcType, stage string) string {
	return svcType + serviceSuffix(stage)
}

// isKnownInfraType reports whether svcType is a service the driver can
// generate compose for (the set generateInfraCompose dispatches on).
func isKnownInfraType(svcType string) bool {
	switch svcType {
	case "couchdb", "garage", "postgres", "kafka":
		return true
	}
	return false
}

// generateInfraCompose returns the {services, volumes, networks} compose dict
// for one (svc_type, stage) infra service. networks are left as the template's
// `["bitswan_network"]` (or a map carrying aliases) — _merge_infra_services
// rewrites them to the stage net. Returns nil for an unknown service type.
func generateInfraCompose(c *compileState, svcType, stage string) map[string]interface{} {
	n := infraNamesFor(c.secretsDir, c.workspaceName, svcType, stage)
	switch svcType {
	case "couchdb":
		return couchdbCompose(n)
	case "garage":
		return garageCompose(c, n)
	case "postgres":
		return postgresCompose(n)
	case "kafka":
		return kafkaCompose(c.secretsDir, n)
	default:
		return nil
	}
}

func couchdbCompose(n infraNames) map[string]interface{} {
	return map[string]interface{}{
		"services": map[string]interface{}{
			"couchdb" + n.suffix: map[string]interface{}{
				"image":          "couchdb:3.3",
				"container_name": n.containerName,
				"restart":        "unless-stopped",
				"env_file":       []interface{}{n.secretsPath},
				"volumes":        []interface{}{n.volumeName + ":/opt/couchdb/data"},
				"networks":       []interface{}{"bitswan_network"},
				"labels":         n.infraLabels(),
			},
		},
		"volumes": map[string]interface{}{n.volumeName: nil},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{"external": true},
		},
	}
}

const (
	garageImage        = "dxflrs/garage:v2.3.0"
	garageToolboxImage = "rclone/rclone:1.68"
)

// garageAlias is the underscore-free DNS alias S3 clients address the garage
// node by (`__` container names are invalid HTTP Host headers). It is the
// S3_HOST value gitops writes into the service secrets.
func garageAlias(n infraNames) string {
	return n.workspaceName + "-garage" + n.suffix
}

// garageCompose emits the object store (Garage — headless, no web console;
// the dashboard's Object Storage explorer is the UI) plus an rclone toolbox
// sidecar. The garage image is a single static binary, so ALL S3 data-plane
// work (snapshots, backups, explorer) execs into the toolbox instead.
func garageCompose(c *compileState, n infraNames) map[string]interface{} {
	metaVol := n.volumeName[:len(n.volumeName)-len("-data")] + "-meta"
	garage := map[string]interface{}{
		"image":          garageImage,
		"container_name": n.containerName,
		"restart":        "unless-stopped",
		// --single-node (v2.3+) auto-creates the one-node cluster layout on
		// first boot — no manual `garage layout assign/apply` bootstrap. The
		// image's Entrypoint is null, so the command must be the full argv.
		"command":  []interface{}{"/garage", "server", "--single-node"},
		"env_file": []interface{}{n.secretsPath},
		"volumes": []interface{}{
			metaVol + ":/meta",
			n.volumeName + ":/data",
			c.garageConfigMount(n),
		},
		// Map form so mergeInfraServices carries the alias onto the stage net.
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{
				"aliases": []interface{}{garageAlias(n)},
			},
		},
		"labels": n.infraLabels(),
		// Health is the readiness SIGNAL the driver waits on (docker health
		// events), not a poll. json-api runs the admin call in-process (no
		// shell/curl exists in the image); it exits nonzero until the node
		// serves, 0 once healthy.
		"healthcheck": map[string]interface{}{
			"test":           []interface{}{"CMD", "/garage", "json-api", "GetClusterHealth"},
			"interval":       "5s",
			"timeout":        "3s",
			"retries":        30,
			"start_period":   "15s",
			"start_interval": "250ms",
		},
	}
	toolbox := map[string]interface{}{
		"image":          garageToolboxImage,
		"container_name": n.containerName + "-toolbox",
		"restart":        "unless-stopped",
		// Idle by default; the driver/gitops exec rclone (and sh for scratch
		// dirs) into it on demand. The rclone image's entrypoint is rclone
		// itself, so it must be overridden to something that just waits.
		"entrypoint": []interface{}{"sleep", "infinity"},
		"networks":   []interface{}{"bitswan_network"},
		"labels":     n.infraLabels(),
	}
	return map[string]interface{}{
		"services": map[string]interface{}{
			"garage" + n.suffix:              garage,
			"garage" + n.suffix + "-toolbox": toolbox,
		},
		"volumes": map[string]interface{}{metaVol: nil, n.volumeName: nil},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{"external": true},
		},
	}
}

// garageConfigMount mounts the gitops-written garage<suffix>.toml (rpc secret,
// admin token, ports) at /etc/garage.toml — dual-mode like app source mounts
// (see the volume/bind switch in buildServiceEntry): volume subpath on
// shared-volume platforms, host bind otherwise.
func (c *compileState) garageConfigMount(n infraNames) interface{} {
	file := n.secretsName + ".toml"
	if c.volumeName != "" {
		subpath := normalizeSubpath("workspaces/" + c.workspaceName + "/gitops/secrets/" + file)
		return map[string]interface{}{
			"type":      "volume",
			"source":    c.volumeName,
			"target":    "/etc/garage.toml",
			"read_only": true,
			"volume":    map[string]interface{}{"subpath": subpath},
		}
	}
	return filepath.Join(c.gitopsDirHost, "secrets", file) + ":/etc/garage.toml:ro"
}

// Postgres runs headless: its former pgAdmin sidecar was replaced by the
// workspace-dashboard's read-only SQL explorer, so no admin-UI container and
// no ingress upstream exist for this service. Existing pgadmin containers are
// retired automatically by retireOrphanedContainers on the next apply.
func postgresCompose(n infraNames) map[string]interface{} {
	return map[string]interface{}{
		"services": map[string]interface{}{
			"postgres" + n.suffix: map[string]interface{}{
				"image":          "postgres:16",
				"container_name": n.containerName,
				"restart":        "unless-stopped",
				"env_file":       []interface{}{n.secretsPath},
				"volumes":        []interface{}{n.volumeName + "-data:/var/lib/postgresql/data"},
				"networks":       []interface{}{"bitswan_network"},
				"labels":         n.infraLabels(),
				// Readiness SIGNAL the driver waits on (docker health events),
				// not a poll. start_interval probes every 250ms during startup
				// so "healthy" fires ~250ms after Postgres accepts connections.
				// $$ so compose leaves the expansion to the CONTAINER shell
				// (which has POSTGRES_USER from the env_file) — a single $ is
				// interpolated at compose-parse time from the driver's env,
				// where it's unset, warning on every build/up.
				"healthcheck": map[string]interface{}{
					"test":           []interface{}{"CMD-SHELL", `pg_isready -U "$$POSTGRES_USER" -q`},
					"interval":       "5s",
					"timeout":        "3s",
					"retries":        30,
					"start_period":   "30s",
					"start_interval": "250ms",
				},
			},
		},
		"volumes": map[string]interface{}{n.volumeName + "-data": nil},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{"external": true},
		},
	}
}

// kafkaEntrypointScript is KAFKA_ENTRYPOINT_SCRIPT with the compose-escaped
// `$$KAFKA_ADMIN_PASSWORD` (docker-compose collapses `$$` to `$` at runtime).
const kafkaEntrypointScript = `cat > /etc/kafka/kafka_server_jaas.conf <<JAASEOF
KafkaServer {
   org.apache.kafka.common.security.plain.PlainLoginModule required
   username="admin"
   password="$$KAFKA_ADMIN_PASSWORD"
   user_admin="$$KAFKA_ADMIN_PASSWORD";
};

Client {
   org.apache.kafka.common.security.plain.PlainLoginModule required
   username="admin"
   password="$$KAFKA_ADMIN_PASSWORD"
   user_admin="$$KAFKA_ADMIN_PASSWORD";
};
JAASEOF
exec /etc/confluent/docker/run
`

func kafkaCompose(secretsDir string, n infraNames) map[string]interface{} {
	clusterID := readKafkaClusterID(secretsDir, n.suffix)
	uiContainer := n.containerName + "-ui"
	ui := map[string]interface{}{
		"container_name": uiContainer,
		"restart":        "always",
		"image":          "provectuslabs/kafka-ui:latest",
		"environment": map[string]interface{}{
			"DYNAMIC_CONFIG_ENABLED":                        "true",
			"AUTH_TYPE":                                     "LOGIN_FORM",
			"SPRING_SECURITY_USER_NAME":                     "admin",
			"SERVER_SERVLET_CONTEXTPATH":                    "/kafka",
			"KAFKA_CLUSTERS_0_NAME":                         "local-cluster",
			"KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS":             n.containerName + ":9092",
			"KAFKA_CLUSTERS_0_PROPERTIES_SECURITY_PROTOCOL": "SASL_PLAINTEXT",
			"KAFKA_CLUSTERS_0_PROPERTIES_SASL_MECHANISM":    "PLAIN",
		},
		"env_file": []interface{}{n.secretsPath},
		"networks": []interface{}{"bitswan_network"},
		"labels":   n.infraLabels(),
	}
	broker := map[string]interface{}{
		"image":          "confluentinc/cp-kafka:7.5.0",
		"container_name": n.containerName,
		"entrypoint":     []interface{}{"/bin/bash", "-c", kafkaEntrypointScript},
		"labels":         n.infraLabels(),
		"environment": map[string]interface{}{
			"KAFKA_NODE_ID":                                  1,
			"KAFKA_PROCESS_ROLES":                            "broker,controller",
			"KAFKA_CONTROLLER_QUORUM_VOTERS":                 "1@" + n.containerName + ":9094",
			"KAFKA_CONTROLLER_LISTENER_NAMES":                "CONTROLLER",
			"KAFKA_LISTENERS":                                "SASL_PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9094",
			"KAFKA_ADVERTISED_LISTENERS":                     "SASL_PLAINTEXT://" + n.containerName + ":9092",
			"KAFKA_LISTENER_SECURITY_PROTOCOL_MAP":           "CONTROLLER:PLAINTEXT,SASL_PLAINTEXT:SASL_PLAINTEXT",
			"KAFKA_INTER_BROKER_LISTENER_NAME":               "SASL_PLAINTEXT",
			"KAFKA_SASL_ENABLED_MECHANISMS":                  "PLAIN",
			"KAFKA_SASL_MECHANISM_INTER_BROKER_PROTOCOL":     "PLAIN",
			"KAFKA_OPTS":                                     "-Djava.security.auth.login.config=/etc/kafka/kafka_server_jaas.conf",
			"KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR":         1,
			"KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR": 1,
			"KAFKA_TRANSACTION_STATE_LOG_MIN_ISR":            1,
			"KAFKA_AUTO_CREATE_TOPICS_ENABLE":                "true",
			"CLUSTER_ID":                                     clusterID,
		},
		"volumes":  []interface{}{n.volumeName + ":/var/lib/kafka/data"},
		"env_file": []interface{}{n.secretsPath},
		"restart":  "unless-stopped",
		"networks": []interface{}{"bitswan_network"},
	}
	return map[string]interface{}{
		"version": "3",
		"services": map[string]interface{}{
			"kafka" + n.suffix + "-ui": ui,
			"kafka" + n.suffix:         broker,
		},
		"volumes": map[string]interface{}{n.volumeName: nil},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{"external": true},
		},
	}
}

// readKafkaClusterID reads the persisted cluster id from the kafka secrets file
// (KafkaService._read_cluster_id reads KAFKA_CLUSTER_ID from the env file).
// An absent id yields "" (the live daemon generates+persists one on first run;
// pure compile generation has no side effects, matching the gitops behavior of
// reusing what is on disk).
func readKafkaClusterID(secretsDir, suffix string) string {
	path := filepath.Join(secretsDir, "kafka"+suffix)
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range splitLines(string(data)) {
		if k, v, ok := splitEnvLine(line); ok && (k == "KAFKA_CLUSTER_ID" || k == "CLUSTER_ID") {
			return v
		}
	}
	return ""
}

// mergeInfraServices merges enabled infra services for every (svc_type, stage)
// declared by a deployment into the compose dict, pinning each onto the stage
// network and collecting volumes/networks. Returns the merged service names.
// Port of automation_service._merge_infra_services.
func mergeInfraServices(c *compileState, services map[string]interface{}, deployments map[string]*Deployment) []string {
	merged := []string{}

	// Collect unique (svc_type, mapped_stage) pairs.
	type pair struct{ svc, stage string }
	seenSet := map[pair]bool{}
	for _, dep := range deployments {
		if dep == nil || len(dep.Services) == 0 {
			continue
		}
		mappedStage := stageForDeployment(dep.StageOrProduction())
		for svcType, raw := range dep.Services {
			if svcEnabled(raw) {
				seenSet[pair{svcType, mappedStage}] = true
			}
		}
	}
	// Deterministic order.
	seen := make([]pair, 0, len(seenSet))
	for p := range seenSet {
		seen = append(seen, p)
	}
	sort.Slice(seen, func(i, j int) bool {
		if seen[i].svc != seen[j].svc {
			return seen[i].svc < seen[j].svc
		}
		return seen[i].stage < seen[j].stage
	})

	for _, p := range seen {
		if !isKnownInfraType(p.svc) {
			continue // unknown service type
		}
		if !infraEnabled(c.secretsDir, p.svc, p.stage) {
			continue // declared but secrets file missing → not enabled
		}
		svcCompose := generateInfraCompose(c, p.svc, p.stage)
		stageNet := c.stageNetwork(realmForStage(p.stage))

		svcServices, _ := svcCompose["services"].(map[string]interface{})
		// Stable name order so merge is deterministic.
		names := make([]string, 0, len(svcServices))
		for name := range svcServices {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if _, exists := services[name]; exists {
				continue
			}
			entry, _ := svcServices[name].(map[string]interface{})
			// Preserve any DNS aliases the template set, then pin to stage net.
			var aliases []interface{}
			if netsDict, ok := entry["networks"].(map[string]interface{}); ok {
				for _, nc := range netsDict {
					if ncm, ok := nc.(map[string]interface{}); ok {
						if a, ok := ncm["aliases"].([]interface{}); ok {
							aliases = append(aliases, a...)
						}
					}
				}
			}
			if len(aliases) > 0 {
				entry["networks"] = map[string]interface{}{stageNet: map[string]interface{}{"aliases": aliases}}
			} else {
				entry["networks"] = []interface{}{stageNet}
			}
			services[name] = entry
			merged = append(merged, name)
		}

		// Merge volumes.
		if svcVolumes, ok := svcCompose["volumes"].(map[string]interface{}); ok && len(svcVolumes) > 0 {
			for vol, vc := range svcVolumes {
				if _, exists := c.volumes[vol]; !exists {
					c.volumes[vol] = vc
				}
			}
		}

		// Stage net is external; collect any external nets the template declared.
		c.externalNetworks[stageNet] = true
		if svcNets, ok := svcCompose["networks"].(map[string]interface{}); ok {
			for netName, nc := range svcNets {
				if ncm, ok := nc.(map[string]interface{}); ok {
					if ext, _ := ncm["external"].(bool); ext {
						c.externalNetworks[netName] = true
					}
				}
			}
		}
	}
	return merged
}

// svcEnabled mirrors the Python: a dict service uses get("enabled", True), a
// scalar uses its truthiness.
func svcEnabled(raw interface{}) bool {
	switch t := raw.(type) {
	case map[string]interface{}:
		if v, ok := t["enabled"]; ok {
			b, _ := v.(bool)
			return b
		}
		return true
	case bool:
		return t
	case nil:
		return false
	default:
		return true
	}
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func splitEnvLine(line string) (string, string, bool) {
	line = trimSpace(line)
	if line == "" || line[0] == '#' {
		return "", "", false
	}
	for i := 0; i < len(line); i++ {
		if line[i] == '=' {
			return line[:i], line[i+1:], true
		}
	}
	return "", "", false
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r' || s[start] == '\n') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\r' || s[end-1] == '\n') {
		end--
	}
	return s[start:end]
}
