package dockerdriver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os/exec"
	"sort"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	yaml "gopkg.in/yaml.v3"
)

// The egress firewall splits a backend into a worker + a gateway, with the
// worker joining the gateway's network namespace via `network_mode:
// service:<gw>`. docker compose RECREATES such netns-sharing workers on EVERY
// `up` — its config-hash for them is unstable — so a full reconcile churns
// every egress worker in the workspace even when nothing about them changed.
//
// We keep the k8s-style model (gitops pushes full desired state; the driver
// reconciles against actual), but take over the egress workers' diff: compute a
// STABLE desired hash ourselves, stamp it on the container as a label, and on
// the next apply recreate a worker only when its hash changed (or its gateway
// was recreated, which invalidates the shared netns). Everything else rides the
// normal full `docker compose up`, which already reconciles minimally.

const egressHashLabel = "bitswan.egress.confighash"

// egressWorker is one `network_mode: service:<gateway>` service we reconcile
// ourselves rather than letting compose spuriously recreate it.
type egressWorker struct {
	name        string
	gateway     string
	desiredHash string
}

// prepareComposeForEgress parses the generated compose, finds the egress
// workers, and stamps each with a stable desired-config hash label (computed
// over the service definition MINUS that label, so it is idempotent across
// applies). Returns the rewritten YAML, the worker set, and the full service
// name list. On a parse error it returns the input unchanged with nil workers —
// the caller then falls back to a plain full `up`.
func prepareComposeForEgress(composeYAML string) (rewritten string, workers []egressWorker, allServices []string, err error) {
	var doc map[string]interface{}
	if e := yaml.Unmarshal([]byte(composeYAML), &doc); e != nil {
		return composeYAML, nil, nil, e
	}
	services, ok := doc["services"].(map[string]interface{})
	if !ok {
		return composeYAML, nil, nil, fmt.Errorf("compose has no services map")
	}
	for name, raw := range services {
		allServices = append(allServices, name)
		svc, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		nm, _ := svc["network_mode"].(string)
		if !strings.HasPrefix(nm, "service:") {
			continue
		}
		// Hash the definition as-is (the compiler never emits our label, so this
		// is the clean def), then stamp the label = that hash.
		hash := hashServiceDef(svc)
		labels, ok := svc["labels"].(map[string]interface{})
		if !ok {
			labels = map[string]interface{}{}
			svc["labels"] = labels
		}
		labels[egressHashLabel] = hash
		workers = append(workers, egressWorker{
			name:        name,
			gateway:     strings.TrimPrefix(nm, "service:"),
			desiredHash: hash,
		})
	}
	sort.Strings(allServices)
	out, e := yaml.Marshal(doc)
	if e != nil {
		return composeYAML, nil, nil, e
	}
	return string(out), workers, allServices, nil
}

// hashServiceDef is a stable content hash of a compose service definition.
// yaml.v3 marshals map keys sorted, so this is deterministic for an unchanged
// definition — unlike docker compose's own config-hash for netns-sharing
// services, which is what we're working around.
func hashServiceDef(svc map[string]interface{}) string {
	b, err := yaml.Marshal(svc)
	if err != nil {
		// A def that won't marshal can't be hashed stably; return a value that is
		// always treated as changed (recreated), never silently skipped.
		return "unmarshalable"
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// reconcileEgressAware brings the project up the k8s way while owning the egress
// workers' lifecycle: a full `up` for everything EXCEPT the egress workers, then
// recreate only the workers whose desired hash changed or whose gateway was
// recreated (a new gateway container = a new netns the worker must rejoin).
func reconcileEgressAware(ctx context.Context, wctx infradriver.WorkspaceContext, composePath string, workers []egressWorker, allServices []string, report func(step, msg string)) error {
	workerSet := make(map[string]bool, len(workers))
	gateways := map[string]bool{}
	for _, w := range workers {
		workerSet[w.name] = true
		gateways[w.gateway] = true
	}
	nonWorkers := make([]string, 0, len(allServices))
	for _, s := range allServices {
		if !workerSet[s] {
			nonWorkers = append(nonWorkers, s)
		}
	}

	// Gateway container ids BEFORE phase 1 — a changed id after means the
	// gateway was recreated and its workers must rejoin the new netns.
	gwBefore := inspectContainerIDs(ctx, gateways)

	// Phase 1: reconcile everything except the egress workers. Compose no-ops
	// unchanged services and recreates genuinely-changed ones (incl. gateways).
	report("compose_up", fmt.Sprintf("Reconciling %d service(s) (egress workers handled separately)...", len(nonWorkers)))
	if err := composeUpServices(ctx, wctx, composePath, nonWorkers, true /*removeOrphans*/, false /*noDeps*/, report); err != nil {
		return err
	}

	// Phase 2: diff the egress workers ourselves.
	gwAfter := inspectContainerIDs(ctx, gateways)
	var toRecreate []string
	for _, w := range workers {
		st := inspectEgressWorker(ctx, w.name)
		switch {
		case !st.exists || !st.running:
			toRecreate = append(toRecreate, w.name)
		case st.hash != w.desiredHash:
			toRecreate = append(toRecreate, w.name)
		case gwBefore[w.gateway] != gwAfter[w.gateway]:
			toRecreate = append(toRecreate, w.name)
		}
	}

	// Phase 3: recreate only the workers that actually need it. --no-deps: their
	// gateways are already up from phase 1, and we must not drag siblings in.
	if len(toRecreate) > 0 {
		report("compose_up", fmt.Sprintf("Recreating %d/%d egress worker(s): %s",
			len(toRecreate), len(workers), strings.Join(toRecreate, ", ")))
		if err := composeUpServices(ctx, wctx, composePath, toRecreate, false, true, report); err != nil {
			return err
		}
	} else {
		report("compose_up", fmt.Sprintf("All %d egress worker(s) already up to date — none recreated.", len(workers)))
	}
	return nil
}

// egressWorkerState is the running container facts the diff needs.
type egressWorkerState struct {
	exists  bool
	running bool
	hash    string // our stamped bitswan.egress.confighash label
}

func inspectEgressWorker(ctx context.Context, name string) egressWorkerState {
	out, err := exec.CommandContext(ctx, "docker", "inspect", "-f",
		`{{.State.Running}}|{{index .Config.Labels "`+egressHashLabel+`"}}`, name).Output()
	if err != nil {
		return egressWorkerState{} // not found
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "|", 2)
	st := egressWorkerState{exists: true}
	if len(parts) > 0 {
		st.running = parts[0] == "true"
	}
	if len(parts) > 1 {
		st.hash = parts[1]
	}
	return st
}

// inspectContainerIDs returns name→container-id for the given names (absent /
// not-yet-created names are simply omitted).
func inspectContainerIDs(ctx context.Context, names map[string]bool) map[string]string {
	ids := make(map[string]string, len(names))
	for n := range names {
		out, err := exec.CommandContext(ctx, "docker", "inspect", "-f", "{{.Id}}", n).Output()
		if err != nil {
			continue
		}
		ids[n] = strings.TrimSpace(string(out))
	}
	return ids
}
