package dockerdriver

import (
	"os"
	"path/filepath"
	"sort"
)

// Infra-service compose generation — port of the four
// {postgres,minio,couchdb,kafka}_service.py `_generate_compose_dict` methods
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
	}
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

// generateInfraCompose returns the {services, volumes, networks} compose dict
// for one (svc_type, stage) infra service. networks are left as the template's
// `["bitswan_network"]` — _merge_infra_services rewrites them to the stage net.
// Returns nil for an unknown service type.
func generateInfraCompose(secretsDir, workspaceName, svcType, stage string) map[string]interface{} {
	n := infraNamesFor(secretsDir, workspaceName, svcType, stage)
	switch svcType {
	case "couchdb":
		return couchdbCompose(n)
	case "minio":
		return minioCompose(n)
	case "postgres":
		return postgresCompose(secretsDir, n)
	case "kafka":
		return kafkaCompose(secretsDir, n)
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
			},
		},
		"volumes": map[string]interface{}{n.volumeName: nil},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{"external": true},
		},
	}
}

func minioCompose(n infraNames) map[string]interface{} {
	entry := map[string]interface{}{
		"image":          "minio/minio:latest",
		"container_name": n.containerName,
		"restart":        "unless-stopped",
		"command":        "server /data --console-address :9001",
		"env_file":       []interface{}{n.secretsPath},
		"volumes":        []interface{}{n.volumeName + "-data:/data"},
		"networks":       []interface{}{"bitswan_network"},
		"labels":         map[string]interface{}{},
	}
	return map[string]interface{}{
		"services": map[string]interface{}{"minio" + n.suffix: entry},
		"volumes":  map[string]interface{}{n.volumeName + "-data": nil},
		"networks": map[string]interface{}{
			"bitswan_network": map[string]interface{}{"external": true},
		},
	}
}

func postgresCompose(secretsDir string, n infraNames) map[string]interface{} {
	pgadmin := map[string]interface{}{
		"container_name": n.containerName + "-pgadmin",
		"restart":        "unless-stopped",
		"image":          "dpage/pgadmin4:latest",
		"env_file":       []interface{}{n.secretsPath},
		"volumes": []interface{}{
			filepath.Join(secretsDir, "pgadmin-servers.json") + ":/pgadmin4/servers.json:ro",
		},
		"networks": []interface{}{"bitswan_network"},
		"labels":   map[string]interface{}{},
	}
	return map[string]interface{}{
		"services": map[string]interface{}{
			"postgres" + n.suffix: map[string]interface{}{
				"image":          "postgres:16",
				"container_name": n.containerName,
				"restart":        "unless-stopped",
				"env_file":       []interface{}{n.secretsPath},
				"volumes":        []interface{}{n.volumeName + "-data:/var/lib/postgresql/data"},
				"networks":       []interface{}{"bitswan_network"},
			},
			"postgres" + n.suffix + "-pgadmin": pgadmin,
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
	}
	broker := map[string]interface{}{
		"image":          "confluentinc/cp-kafka:7.5.0",
		"container_name": n.containerName,
		"entrypoint":     []interface{}{"/bin/bash", "-c", kafkaEntrypointScript},
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
		if generateInfraCompose(c.secretsDir, c.workspaceName, p.svc, p.stage) == nil {
			continue // unknown service type
		}
		if !infraEnabled(c.secretsDir, p.svc, p.stage) {
			continue // declared but secrets file missing → not enabled
		}
		svcCompose := generateInfraCompose(c.secretsDir, c.workspaceName, p.svc, p.stage)
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
