package dockerdriver

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
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

// workerPortKey identifies one non-exposed worker's resolved listen port within
// a (ctx, stage, slot) scope.
type workerPortKey struct {
	ctx, stage, slot, name string
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
// list per (ctx, stage, slot) for every non-exposed worker, plus the listen
// port resolved for each worker (keyed by ctx/stage/slot/name) so the service
// builder can inject it as PORT.
//
// Workers in a firewalled group all share their gateway's single network
// namespace (network_mode: service:<gw>), so two that both bind the declared
// port collide — the first wins and the second dies with `[Errno 98] Address in
// use` (FastAPI crash-loops; Go's `air` supervisor survives the failed bind so
// the container stays Up but never serves). Hand each worker in a shared netns a
// distinct port: keep its declared port when free, else the next free one.
// Non-firewalled workers each own their netns and keep their declared port. The
// resolved port is advertised in BITSWAN_WORKER_HOSTS and injected as PORT so
// the routing entry and the actual listen port stay in sync.
func (c *compileState) computeWorkerHosts(deployments map[string]*Deployment, fwScope map[fwKey]*fwGroup) (map[fwKey][]string, map[workerPortKey]int) {
	out := map[fwKey][]string{}
	ports := map[workerPortKey]int{}
	usedByScope := map[fwKey]map[int]bool{}
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
			key := fwKey{depCtx, stage, sd.slot}
			fw := fwActive(fwScope, depCtx, stage, sd.slot)
			port := cfg.Port
			var host string
			if fw != nil {
				host = fw.gw
				// Shared netns — resolve a collision-free port within the scope.
				used := usedByScope[key]
				if used == nil {
					used = map[int]bool{}
					usedByScope[key] = used
				}
				for used[port] {
					port++
				}
				used[port] = true
			} else {
				host = makeHostnameLabel(c.workspaceName, name, depCtx, stage, sd.slot)
			}
			ports[workerPortKey{depCtx, stage, sd.slot, name}] = port
			out[key] = append(out[key], fmt.Sprintf("%s=%s:%d", name, host, port))
		}
	}
	return out, ports
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
func (c *compileState) buildServiceEntry(depID string, conf *Deployment, slot string, db int, workerHosts map[fwKey][]string, workerPorts map[workerPortKey]int, fwScope map[fwKey]*fwGroup) (map[string]interface{}, string, *infradriver.Route, bool, error) {
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
	// A non-exposed worker listens on the port resolved in the computeWorkerHosts
	// pre-pass (its declared port, or a collision-free one when it shares a
	// firewall gateway's netns with peers). Inject it as PORT — worker templates
	// honour it (uvicorn --port "$PORT", the go-worker's PORT env) — so the
	// advertised BITSWAN_WORKER_HOSTS entry and the actual listen port stay in
	// sync.
	if !cfg.Expose {
		if p, ok := workerPorts[workerPortKey{depCtx, depStage, slot, depAutomationName}]; ok {
			env["PORT"] = strconv.Itoa(p)
		}
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
	// A non-main copy's live-dev backend gets its OWN per-(copy, BP) namespaces
	// (database + bucket + couch prefix), isolated from other BPs in the copy and
	// from other copies. Unconditional (not gated on registration) — overrides
	// the dev per-BP names above for every BP in the copy.
	if wtName != "" && stage == "live-dev" && bpSanitized != "" {
		names := copyBPResourceNames(wtName, bpSanitized)
		env["POSTGRES_DB"] = names["postgres_db"]
		env["COUCHDB_DB_PREFIX"] = names["couchdb_prefix"]
		env["MINIO_BUCKET"] = names["minio_bucket"]
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
	// NOTE: we deliberately do NOT stamp a per-deploy wall-clock env (it used to
	// be BITSWAN_DEPLOY_TIME). Nothing reads it, and a value that changes every
	// deploy makes `docker compose up` see every container's config as changed —
	// so it RECREATES every container on every deploy, even a no-op re-deploy.
	// That was the dominant cost of deploy/promote AND the cause of the
	// post-"deployed" 404 (every app container restarts and must re-boot). With
	// it gone, compose recreates only the containers whose image/env/volumes
	// actually changed; unchanged ones keep serving with zero downtime.

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

	// ---- scoped per-BP database / bucket credentials ----
	// A scoped backend authenticates as its OWN Postgres role / MinIO user
	// (limited to its own database / bucket), generated and persisted by the
	// driver. The creds live in a per-resource env_file (only its path lands in
	// the compose; the values stay 0600 on the secrets volume). When scoped, the
	// shared postgres*/minio* service secrets are NOT attached below, so the
	// superuser/root never reaches the backend. A BP gets a per-resource name
	// (and thus scoping) either by being registered (per-stage) or by being a
	// non-main copy's live-dev backend — both set POSTGRES_DB / MINIO_BUCKET above.
	credRealm := realmForStage(stage)
	pgDB, _ := env["POSTGRES_DB"].(string)
	minioBucket, _ := env["MINIO_BUCKET"].(string)
	scopedPG := pgDB != ""
	scopedMinio := minioBucket != ""
	if scopedPG {
		if _, _, err := getOrCreateDBCreds(c.secretsDir, credRealm, pgDB); err != nil {
			return nil, "", nil, false, err
		}
		appendEnvFile(entry, dbCredsPath(c.secretsDir, credRealm, pgDB))
		// Carry the (non-secret) connection coordinates the shared postgres
		// service secret would have supplied, since it's no longer attached.
		if pg := serviceSecrets(c.secretsDir, "postgres", credRealm); pg != nil {
			for _, k := range []string{"POSTGRES_HOST", "POSTGRES_PORT"} {
				if v := pg[k]; v != "" {
					env[k] = v
				}
			}
		}
	}
	if scopedMinio {
		if _, _, err := getOrCreateBucketCreds(c.secretsDir, credRealm, minioBucket); err != nil {
			return nil, "", nil, false, err
		}
		appendEnvFile(entry, bucketCredsPath(c.secretsDir, credRealm, minioBucket))
		if mn := serviceSecrets(c.secretsDir, "minio", credRealm); mn != nil {
			for _, k := range []string{"MINIO_HOST", "MINIO_PORT"} {
				if v := mn[k]; v != "" {
					env[k] = v
				}
			}
		}
	}

	// ---- service dependency secrets ----
	for _, secretName := range c.resolveServiceSecrets(cfg, stage) {
		// A scoped backend has its own postgres/minio principal (above); never
		// attach the shared superuser/root service secret to it.
		if scopedPG && strings.HasPrefix(secretName, "postgres") {
			continue
		}
		if scopedMinio && strings.HasPrefix(secretName, "minio") {
			continue
		}
		p := filepath.Join(c.secretsDir, secretName)
		if _, err := os.Stat(p); err == nil {
			appendEnvFile(entry, p)
		}
	}

	var networksList []string
	usedExternalTesting := false
	if networkMode == "" && cfg.ExternalTestingNet {
		networksList = []string{"bitswan_external_testing"}
		c.externalNetworks["bitswan_external_testing"] = true
		usedExternalTesting = true
	}

	if networkMode != "" {
		// network_mode is only ever set by the compiler itself (the firewall
		// gateway worker pattern). It is NOT taken from the deployment record.
		entry["network_mode"] = networkMode
	} else if !cfg.ExternalTestingNet {
		// Automations always attach to their per-(workspace, realm) stage network.
		// The compiler owns this — the deployment record cannot inject networks or
		// network_mode (which would let it join bitswan_network and reach the
		// control plane, defeating the driver's whole purpose).
		networksList = []string{c.stageNetwork(realmForStage(depStage))}
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

	// NOTE: the deployment record deliberately CANNOT inject volumes / ports /
	// devices / container_name into the compose. The driver is a constraining
	// layer, not a passthrough executor — host bind-mounts, host port bindings
	// and device passthrough would defeat its entire purpose. The only volumes a
	// service gets are the named-volume subpaths the compiler constructs below;
	// container_name is the compiler-derived serviceName set earlier.

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
		// Egress enforcement is split into TWO containers so the firewall lives
		// OUTSIDE the worker's network namespace and cannot be bypassed by the
		// untrusted worker (which is root and may setuid at will):
		//
		//   <gw>        — the netns OWNER. The worker joins this netns
		//                 (network_mode: service:<gw>) with NET_ADMIN dropped.
		//                 It installs the egress rules (DNAT :443/:80 to the
		//                 proxy, with NO uid exemption) and then holds the netns.
		//                 No proxy runs here, so there is no privileged uid in
		//                 the worker's namespace to impersonate.
		//   <gw>-proxy  — the SNI/Host allow-list proxy, in its OWN container and
		//                 namespace on the stage network. It is never co-resident
		//                 with the worker, so the worker cannot reach or spoof it.
		proxy := g.gw + "-proxy"
		services[proxy] = map[string]interface{}{
			"image":          c.gatewayImage,
			"container_name": proxy,
			"restart":        "unless-stopped",
			"environment": map[string]interface{}{
				"BITSWAN_FW_ROLE":     "proxy",
				"BITSWAN_FW_MODE":     g.mode,
				"BITSWAN_FW_ALLOW":    strings.Join(g.allow, ","),
				"BITSWAN_FW_ATTEMPTS": fmt.Sprintf("/firewall/%s__%s%s.attempts.jsonl", g.bp, g.realm, slotTag),
			},
			"networks": map[string]interface{}{
				c.stageNetwork(g.realm): map[string]interface{}{"aliases": []interface{}{proxy}},
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
				"gitops.firewall_proxy": "true",
				"gitops.bp":             g.bp,
				"gitops.stage":          g.realm,
				"gitops.slot":           k.slot,
			},
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
				"BITSWAN_FW_ROLE":  "owner",
				"BITSWAN_FW_MODE":  g.mode,
				"BITSWAN_FW_PROXY": proxy,
			},
			// Install rules only once the proxy (the DNAT target) is up.
			"depends_on": map[string]interface{}{
				proxy: map[string]interface{}{"condition": "service_healthy"},
			},
			"healthcheck": map[string]interface{}{
				"test":         []interface{}{"CMD-SHELL", "test -f /tmp/fw-ready"},
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
		// Declare the stage network both join as external, or `docker compose up`
		// rejects the project ("undefined network <ws>-<realm>").
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
