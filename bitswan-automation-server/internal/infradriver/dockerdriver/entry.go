package dockerdriver

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// fwGroup is one active/inactive egress-firewall group keyed by (ctx, stage, slot).
type fwGroup struct {
	gw    string
	mode  string
	allow []string
	realm string
	bp    string
	ok    bool
}

type fwKey struct {
	ctx, stage, slot string
}

// computeFirewallScope ports the firewall pre-pass in generate_docker_compose:
// which (ctx, stage, slot) groups route their workers through a per-group egress
// gateway. Dev observes by default (monitor); enforcing realms require a node.
func (c *compileState) computeFirewallScope(deployments map[string]*Deployment) map[fwKey]*fwGroup {
	scope := map[fwKey]*fwGroup{}
	for _, depID := range sortedDepIDs(deployments) {
		conf := deployments[depID]
		if conf == nil {
			continue
		}
		stage := conf.StageOrProduction()
		depCtx := conf.Context
		realm := realmForStage(stage)
		bp, _ := deriveBPAndCopy(conf.RelativePath)
		fwKeyBP := bp
		if fwKeyBP == "" {
			fwKeyBP = depCtx
		}
		fwnode := firewallNode(c.bs, fwKeyBP, realm)
		if fwnode == nil && postureFor(realm) != "monitor" {
			continue
		}
		for _, sd := range c.slotDBPairs(conf) {
			key := fwKey{depCtx, stage, sd.slot}
			g, ok := scope[key]
			if !ok {
				mode := postureFor(realm)
				if fwnode != nil && fwnode.Posture != "" {
					mode = fwnode.Posture
				}
				g = &fwGroup{
					gw:    makeHostnameLabel(c.workspaceName, "fwgw", depCtx, stage, sd.slot),
					mode:  mode,
					allow: allowedHosts(c.bs, fwKeyBP, realm),
					realm: realm,
					bp:    fwKeyBP,
					ok:    true,
				}
				scope[key] = g
			}
			if conf.ReplicasOrOne() > 1 {
				g.ok = false
			}
		}
	}
	return scope
}

// fwActive returns the group for (ctx, stage, slot) iff it is ok (_fw_active).
func fwActive(scope map[fwKey]*fwGroup, ctx, stage, slot string) *fwGroup {
	g := scope[fwKey{ctx, stage, slot}]
	if g != nil && g.ok {
		return g
	}
	return nil
}

// computeWorkerHosts ports the BITSWAN_WORKER_HOSTS pre-pass: a `name=host:port`
// list per (ctx, stage, slot) for every non-exposed worker.
func (c *compileState) computeWorkerHosts(deployments map[string]*Deployment, fwScope map[fwKey]*fwGroup) map[fwKey][]string {
	out := map[fwKey][]string{}
	for _, depID := range sortedDepIDs(deployments) {
		conf := deployments[depID]
		if conf == nil {
			continue
		}
		stage := conf.StageOrProduction()
		name := conf.AutomationNameOr(depID)
		depCtx := conf.Context
		cfg := c.resolveAutomationConfig(conf)
		if cfg.Expose {
			continue
		}
		for _, sd := range c.slotDBPairs(conf) {
			fw := fwActive(fwScope, depCtx, stage, sd.slot)
			var host string
			if fw != nil {
				host = fw.gw
			} else {
				host = makeHostnameLabel(c.workspaceName, name, depCtx, stage, sd.slot)
			}
			key := fwKey{depCtx, stage, sd.slot}
			out[key] = append(out[key], fmt.Sprintf("%s=%s:%d", name, host, cfg.Port))
		}
	}
	return out
}

// resolveAutomationConfig ports resolve_automation_config: read automation.toml
// from the deployment's canonical source (live-dev → workspace repo; promoted →
// gitops checksum dir, falling back to the workspace repo when the blob tree is
// absent because the source is baked into the image).
func (c *compileState) resolveAutomationConfig(conf *Deployment) automationConfig {
	stage := conf.StageOrProduction()
	rel := conf.RelativePath

	var sourceDir string
	if stage == "live-dev" && rel != "" {
		sourceDir = filepath.Join(c.workspaceRepo, rel)
	} else {
		src := firstNonEmpty(conf.Source, conf.Checksum)
		if src != "" {
			sourceDir = filepath.Join(c.gitopsDir, src)
		}
	}
	if sourceDir != "" {
		if _, err := os.Stat(sourceDir); err == nil {
			return readAutomationConfig(sourceDir)
		}
	}
	if rel != "" {
		wsDir := filepath.Join(c.workspaceRepo, rel)
		if _, err := os.Stat(wsDir); err == nil {
			return readAutomationConfig(wsDir)
		}
	}
	return defaultAutomationConfig()
}

// buildServiceEntry ports the per-(deployment, slot) body of the main loop. It
// returns the compose entry, its service name, the desired route (or nil), and
// whether to emit (conf.enabled).
func (c *compileState) buildServiceEntry(depID string, conf *Deployment, slot string, db int, workerHosts map[fwKey][]string, fwScope map[fwKey]*fwGroup) (map[string]interface{}, string, *infradriver.Route, bool, error) {
	depStage := conf.StageOrProduction()
	depAutomationName := conf.AutomationNameOr(depID)
	depCtx := conf.Context
	serviceName := makeHostnameLabel(c.workspaceName, depAutomationName, depCtx, depStage, slot)
	slotDeploymentID := depID
	if slot != "" {
		slotDeploymentID = depID + "@" + slot
	}

	source := firstNonEmpty(firstNonEmpty(conf.Source, conf.Checksum), depID)
	sourceDir := filepath.Join(c.gitopsDir, source)

	stage := conf.Stage
	if stage == "" {
		stage = "production"
	}
	rel := conf.RelativePath

	cfg := c.resolveAutomationConfig(conf)

	switch {
	case stage == "live-dev" && cfg.Image == "":
		return nil, "", nil, false, nil
	case stage == "live-dev" && rel == "":
		return nil, "", nil, false, fmt.Errorf("live-dev deployment %s is missing relative_path", depID)
	case stage != "live-dev" && conf.Image == "":
		if _, err := os.Stat(sourceDir); err != nil {
			return nil, "", nil, false, fmt.Errorf("deployment directory %s does not exist", sourceDir)
		}
	}

	// Reflect on-disk services into conf so the infra merge can discover them.
	if cfg.hasServices() && len(conf.Services) == 0 {
		conf.Services = map[string]interface{}{}
		for _, svc := range cfg.Services {
			conf.Services[svc.Type] = map[string]interface{}{"enabled": svc.Enabled}
		}
	}

	isLiveSlot := slot == "" || slot == c.liveSlotFor(conf)
	effectiveDepID := depID
	if !isLiveSlot {
		effectiveDepID = slotDeploymentID
	}

	env := map[string]interface{}{}
	entry := map[string]interface{}{
		"environment": env,
		"restart":     "always",
		"ulimits":     map[string]interface{}{"nofile": map[string]interface{}{"soft": 65536, "hard": 65536}},
	}
	if conf.ReplicasOrOne() <= 1 {
		entry["container_name"] = serviceName
	}
	labels := map[string]interface{}{
		"gitops.deployment_id":    effectiveDepID,
		"gitops.workspace":        c.workspaceName,
		"gitops.automation_name":  depAutomationName,
		"gitops.context":          depCtx,
		"gitops.stage":            depStage,
		"gitops.slot":             slot,
		"gitops.intended_exposed": "false",
	}
	entry["labels"] = labels

	env["DEPLOYMENT_ID"] = effectiveDepID
	env["BITSWAN_AUTOMATION_STAGE"] = stage
	env["BITSWAN_DEPLOYMENT_ID"] = effectiveDepID

	if wh := workerHosts[fwKey{depCtx, depStage, slot}]; len(wh) > 0 {
		env["BITSWAN_WORKER_HOSTS"] = strings.Join(wh, ",")
	}
	if c.workspaceName != "" {
		env["BITSWAN_WORKSPACE_NAME"] = c.workspaceName
	}
	if c.domain != "" {
		env["BITSWAN_GITOPS_DOMAIN"] = c.domain
	}

	bpSanitized, wtName := deriveBPAndCopy(rel)
	deploymentContext := conf.DeploymentCtx
	if deploymentContext == "" {
		wtPart := ""
		if wtName != "" {
			wtPart = "-copy-" + wtName
		}
		stageSuffix := ""
		if stage != "" && stage != "production" {
			stageSuffix = "-" + stage
		}
		switch {
		case bpSanitized != "":
			deploymentContext = bpSanitized + wtPart + stageSuffix
		case wtName != "":
			deploymentContext = "copy-" + wtName + stageSuffix
		default:
			if stage != "" && stage != "production" {
				deploymentContext = stage
			}
		}
	}
	if deploymentContext != "" {
		env["BITSWAN_DEPLOYMENT_CONTEXT"] = deploymentContext
	}

	if bpSanitized != "" && c.registry.isRegistered(bpSanitized, stageForDeployment(stage)) {
		names := bpResourceNames(bpSanitized, db)
		env["POSTGRES_DB"] = names["postgres_db"]
		env["COUCHDB_DB_PREFIX"] = names["couchdb_prefix"]
		env["MINIO_BUCKET"] = names["minio_bucket"]
	}
	if wtName != "" && stage == "live-dev" {
		env["POSTGRES_DB"] = copyDBName(wtName)
	}

	if c.workspaceName != "" && c.domain != "" {
		var ctxSuffix string
		if depCtx != "" {
			h := shortHash(depCtx)
			if depStage != "production" {
				ctxSuffix = "-" + h + "-" + depStage
			} else {
				ctxSuffix = "-" + h
			}
		} else if depStage != "production" {
			ctxSuffix = "-" + depStage
		}
		if slot != "" {
			ctxSuffix = ctxSuffix + "-" + slot
		}
		env["BITSWAN_URL_TEMPLATE"] = "https://" + c.workspaceName + "-{name}" + ctxSuffix + "." + c.domain
	}

	if conf.Checksum != "" {
		env["BITSWAN_DEPLOY_CHECKSUM"] = conf.Checksum
	}
	if conf.TagChecksum != "" {
		env["BITSWAN_IMAGE_CHECKSUM"] = conf.TagChecksum
	}
	env["BITSWAN_DEPLOY_TIME"] = c.deployTime

	// ---- networks / network_mode / egress firewall ----
	var networkMode string
	fw := fwActive(fwScope, depCtx, depStage, slot)
	if fw != nil && !cfg.Expose {
		networkMode = "service:" + fw.gw
		entry["cap_drop"] = sortedStrings([]string{"NET_ADMIN", "NET_RAW"})
		entry["depends_on"] = map[string]interface{}{
			fw.gw: map[string]interface{}{"condition": "service_healthy"},
		}
	}

	// ---- per-(BP, stage) secrets env file ----
	if bpSanitized != "" {
		realm := realmForStage(stage)
		blob := ""
		if c.bs.Secrets != nil {
			if byRealm := c.bs.Secrets[bpSanitized]; byRealm != nil {
				blob = byRealm[realm]
			}
		}
		var values map[string]string
		if blob != "" {
			values = decryptSecrets(c.secretsDir, blob)
		}
		envFile, err := materializeEnv(c.secretsDir, bpSanitized, stage, values)
		if err != nil {
			return nil, "", nil, false, err
		}
		appendEnvFile(entry, envFile)
	}

	// ---- service dependency secrets ----
	for _, secretName := range c.resolveServiceSecrets(cfg, stage) {
		p := filepath.Join(c.secretsDir, secretName)
		if _, err := os.Stat(p); err == nil {
			appendEnvFile(entry, p)
		}
	}

	if networkMode == "" && conf.NetworkMode != "" {
		networkMode = conf.NetworkMode
	}

	var networksList []string
	usedExternalTesting := false
	if networkMode == "" && cfg.ExternalTestingNet {
		networksList = []string{"bitswan_external_testing"}
		c.externalNetworks["bitswan_external_testing"] = true
		usedExternalTesting = true
	}

	if networkMode != "" {
		entry["network_mode"] = networkMode
	} else if !cfg.ExternalTestingNet {
		switch {
		case len(conf.Networks) > 0:
			networksList = append([]string{}, conf.Networks...)
		case len(c.bs.DefaultNetworks) > 0:
			networksList = append([]string{}, c.bs.DefaultNetworks...)
		default:
			networksList = []string{c.stageNetwork(realmForStage(depStage))}
		}
	}

	if networkMode == "" {
		if conf.ReplicasOrOne() > 1 {
			alias := serviceName
			nets := map[string]interface{}{}
			for _, net := range networksList {
				nets[net] = map[string]interface{}{"aliases": []interface{}{alias}}
			}
			entry["networks"] = nets
			entry["deploy"] = map[string]interface{}{"replicas": conf.ReplicasOrOne()}
		} else {
			entry["networks"] = stringsToIface(networksList)
		}
	}

	switch nv := entry["networks"].(type) {
	case map[string]interface{}:
		for k := range nv {
			c.externalNetworks[k] = true
		}
	case []interface{}:
		for _, n := range nv {
			if s, ok := n.(string); ok {
				c.externalNetworks[s] = true
			}
		}
	}
	_ = usedExternalTesting

	// ---- passthroughs (volumes/ports/devices, container_name) ----
	if len(conf.Volumes) > 0 {
		entry["volumes"] = append([]interface{}{}, conf.Volumes...)
	}
	if len(conf.Ports) > 0 {
		entry["ports"] = append([]interface{}{}, conf.Ports...)
	}
	if len(conf.Devices) > 0 {
		entry["devices"] = append([]interface{}{}, conf.Devices...)
	}
	if conf.ReplicasOrOne() <= 1 && conf.ContainerName != "" {
		entry["container_name"] = conf.ContainerName
	}

	deploymentDirHost := filepath.Join(c.gitopsDirHost, source)

	// ---- image ----
	entry["image"] = cfg.Image
	if stage != "live-dev" && conf.Image != "" {
		entry["image"] = conf.Image
	}
	expose := cfg.Expose
	port := cfg.Port

	// ---- exposed automation: route + url env + intended_exposed ----
	var route *infradriver.Route
	if expose && port != 0 {
		isDRSlot := slot != "" && slot == c.drSlotFor(conf)
		roleStage := depStage
		if isDRSlot {
			roleStage = "dr"
		}
		publish := slot == "" || isLiveSlot || isDRSlot
		urlLabel := makeHostnameLabel(c.workspaceName, depAutomationName, depCtx, roleStage, "")
		urlPrefix := "https://" + c.workspaceName + "-"
		urlSuffix := "." + c.domain
		automationURL := "https://" + urlLabel + "." + c.domain

		env["BITSWAN_AUTOMATION_URL"] = automationURL
		env["BITSWAN_URL_PREFIX"] = urlPrefix
		env["BITSWAN_URL_SUFFIX"] = urlSuffix

		if publish {
			labels["gitops.intended_exposed"] = "true"
			r := c.workspaceRoute(depAutomationName, depCtx, depStage, port, slot, roleStage)
			route = &r
		} else {
			labels["gitops.intended_exposed"] = "false"
		}
	}

	// ---- public hostname as network alias ----
	if expose && port != 0 && c.domain != "" && networkMode == "" {
		urlHost := makeHostnameLabel(c.workspaceName, depAutomationName, depCtx, depStage, slot) + "." + c.domain
		switch nv := entry["networks"].(type) {
		case map[string]interface{}:
			for _, nc := range nv {
				ncm, _ := nc.(map[string]interface{})
				if ncm == nil {
					continue
				}
				aliases, _ := ncm["aliases"].([]interface{})
				if !containsIface(aliases, urlHost) {
					ncm["aliases"] = append(aliases, urlHost)
				}
			}
		case []interface{}:
			nets := map[string]interface{}{}
			for _, n := range nv {
				if s, ok := n.(string); ok {
					nets[s] = map[string]interface{}{"aliases": []interface{}{urlHost}}
				}
			}
			entry["networks"] = nets
		}
	}

	// ---- keycloak ----
	if c.keycloakURL != "" {
		ku := c.keycloakURL
		if idx := strings.LastIndex(ku, "/realms/"); idx >= 0 {
			env["KEYCLOAK_URL"] = ku[:idx]
			env["KEYCLOAK_REALM"] = ku[idx+len("/realms/"):]
		} else {
			env["KEYCLOAK_URL"] = ku
			env["KEYCLOAK_REALM"] = ""
		}
		env["KEYCLOAK_ISSUER_URL"] = ku
	}

	if c.orgGroupPath != "" {
		env["BITSWAN_ALLOWED_GROUP"] = c.orgGroupPath
	}

	// ---- volumes: certs + source mount ----
	vols, _ := entry["volumes"].([]interface{})
	if vols == nil {
		vols = []interface{}{}
	}
	if c.certsDirHost != "" {
		vols = append(vols, c.certsDirHost+":/usr/local/share/ca-certificates/custom:ro")
		env["UPDATE_CA_CERTIFICATES"] = "true"
		labels["gitops.certs.enabled"] = "true"
	}

	switch {
	case stage == "live-dev" && rel != "":
		if c.volumeName != "" {
			subpath := normalizeSubpath("workspaces/" + c.workspaceName + "/" + rel)
			vols = append(vols, map[string]interface{}{
				"type":      "volume",
				"source":    c.volumeName,
				"target":    cfg.MountPath,
				"read_only": true,
				"volume":    map[string]interface{}{"subpath": subpath},
			})
		} else {
			sourceMountPath := filepath.Join(c.workspaceDir, rel)
			vols = append(vols, sourceMountPath+":"+cfg.MountPath+":ro")
		}
	case conf.Image != "":
		// Source baked into the image — no mount.
	default:
		if c.volumeName != "" {
			subpath := normalizeSubpath("workspaces/" + c.workspaceName + "/gitops/" + source)
			vols = append(vols, map[string]interface{}{
				"type":      "volume",
				"source":    c.volumeName,
				"target":    cfg.MountPath,
				"read_only": true,
				"volume":    map[string]interface{}{"subpath": subpath},
			})
		} else {
			vols = append(vols, deploymentDirHost+":"+cfg.MountPath+":ro")
		}
	}
	entry["volumes"] = vols

	emit := conf.EnabledOrDefault()
	return entry, serviceName, route, emit, nil
}

// resolveServiceSecrets ports _resolve_service_secrets. Preserves TOML
// declaration order — the env_file order it produces is observable.
func (c *compileState) resolveServiceSecrets(cfg automationConfig, stage string) []string {
	if !cfg.hasServices() {
		return nil
	}
	mapped := stageForDeployment(stage)
	var out []string
	for _, svc := range cfg.Services {
		if !svc.Enabled {
			continue
		}
		if generateInfraCompose(c.secretsDir, c.workspaceName, svc.Type, mapped) == nil {
			continue // unknown service type
		}
		out = append(out, infraServiceSecretsName(svc.Type, mapped))
	}
	return out
}

// emitGateways ports the egress-gateway emission block. One gateway service per
// active firewalled (ctx, stage, slot) group; workers share its netns.
func (c *compileState) emitGateways(services map[string]interface{}, fwScope map[fwKey]*fwGroup) error {
	anyActive := false
	for _, g := range fwScope {
		if g.ok {
			anyActive = true
			break
		}
	}
	if !anyActive {
		return nil
	}

	var fwMount interface{}
	if c.volumeName != "" {
		fwMount = map[string]interface{}{
			"type":   "volume",
			"source": c.volumeName,
			"target": "/firewall",
			"volume": map[string]interface{}{"subpath": "workspaces/" + c.workspaceName + "/firewall"},
		}
	} else {
		fwHostDir := filepath.Join(filepath.Dir(c.gitopsDirHost), "firewall")
		fwMount = fwHostDir + ":/firewall"
	}
	if err := os.MkdirAll(c.firewallDir, 0o755); err != nil {
		return err
	}

	keys := make([]fwKey, 0, len(fwScope))
	for k := range fwScope {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].ctx != keys[j].ctx {
			return keys[i].ctx < keys[j].ctx
		}
		if keys[i].stage != keys[j].stage {
			return keys[i].stage < keys[j].stage
		}
		return keys[i].slot < keys[j].slot
	})
	for _, k := range keys {
		g := fwScope[k]
		if !g.ok {
			continue
		}
		slotTag := ""
		if k.slot != "" {
			slotTag = "__" + k.slot
		}
		services[g.gw] = map[string]interface{}{
			"image":          c.gatewayImage,
			"container_name": g.gw,
			"restart":        "unless-stopped",
			"cap_add":        []interface{}{"NET_ADMIN"},
			"networks": map[string]interface{}{
				c.stageNetwork(g.realm): map[string]interface{}{"aliases": []interface{}{g.gw}},
			},
			"environment": map[string]interface{}{
				"BITSWAN_FW_MODE":     g.mode,
				"BITSWAN_FW_ALLOW":    strings.Join(g.allow, ","),
				"BITSWAN_FW_ATTEMPTS": fmt.Sprintf("/firewall/%s__%s%s.attempts.jsonl", g.bp, g.realm, slotTag),
			},
			"volumes": []interface{}{fwMount},
			"healthcheck": map[string]interface{}{
				"test":         []interface{}{"CMD-SHELL", "nc -z 127.0.0.1 18077"},
				"interval":     "3s",
				"timeout":      "3s",
				"retries":      10,
				"start_period": "2s",
			},
			"labels": map[string]interface{}{
				"gitops.firewall_gateway": "true",
				"gitops.bp":               g.bp,
				"gitops.stage":            g.realm,
				"gitops.slot":             k.slot,
			},
		}
		// Declare the stage network the gateway joins as external, or
		// `docker compose up` rejects the project ("undefined network <ws>-<realm>").
		c.externalNetworks[c.stageNetwork(g.realm)] = true
	}
	return nil
}

// ---- small helpers ----

func appendEnvFile(entry map[string]interface{}, path string) {
	ef, _ := entry["env_file"].([]interface{})
	for _, e := range ef {
		if s, ok := e.(string); ok && s == path {
			return
		}
	}
	entry["env_file"] = append(ef, path)
}

func normalizeSubpath(p string) string {
	for strings.HasPrefix(p, "./") || strings.HasPrefix(p, "/") {
		if strings.HasPrefix(p, "./") {
			p = p[2:]
		} else {
			p = p[1:]
		}
	}
	return p
}

func sortedStrings(in []string) []interface{} {
	cp := append([]string{}, in...)
	sort.Strings(cp)
	out := make([]interface{}, len(cp))
	for i, s := range cp {
		out[i] = s
	}
	return out
}

func stringsToIface(in []string) []interface{} {
	out := make([]interface{}, len(in))
	for i, s := range in {
		out[i] = s
	}
	return out
}

func containsIface(s []interface{}, v string) bool {
	for _, e := range s {
		if es, ok := e.(string); ok && es == v {
			return true
		}
	}
	return false
}
