package daemon

import (
	"context"
	"fmt"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8sctl"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// The shared vulnerability database, in a namespace.
//
// The contract is the Docker one and does not change: the daemon owns the
// database, refreshes it once a day, and every workspace's gitops reads it
// read-only — so the download never lands on somebody's first interactive scan
// and no workspace can poison what the others scan against.
//
// What changes is the two Docker-shaped halves of it. The shared volume becomes
// a subdirectory of the workspace volume this daemon already holds, and the
// throwaway container becomes a Job. The Job still runs the PINNED GITOPS
// IMAGE, for the reason the Docker path does: grype's binary and its database
// schema have to match the grype the workspaces actually scan with, which
// baking a copy into this daemon's image would not guarantee.

// grypeDBSubPath is where the database lives on the workspace volume. A sibling
// of workspaces/, not inside one: there is a single database per Bailey.
const grypeDBSubPath = "grype-db"

// grypeDBJobName is fixed, so a refresh that is already running is visible and
// a finished one is replaced rather than accumulating.
const grypeDBJobName = "bitswan-grype-db-refresh"

// refreshGrypeDBK8s runs the refresh as a Job and waits for it.
//
// Best-effort by the same contract as the Docker path: a failure leaves the
// previous database in place, scans match against the last good one, and the
// caller retries on a backoff.
func refreshGrypeDBK8s(ctx context.Context, image, claim string) error {
	if image == "" {
		return fmt.Errorf("no gitops image available to source grype from")
	}
	if claim == "" {
		return fmt.Errorf("no workspace volume to hold the vulnerability database")
	}

	// A previous run, finished or wedged, would make this one a no-op.
	if err := k8sctl.Delete(ctx, "job", grypeDBJobName); err != nil {
		return fmt.Errorf("clear the previous refresh: %w", err)
	}

	if err := k8sctl.Apply(ctx, k8srender.ObjectSet{grypeDBJob(image, claim)}); err != nil {
		return fmt.Errorf("start the refresh: %w", err)
	}
	if err := k8sctl.WaitJob(ctx, grypeDBJobName, grypeDBRefreshTimeout); err != nil {
		return fmt.Errorf("grype db update (%s): %w", image, err)
	}
	return nil
}

// grypeDBRefreshTimeout is how long the download has. Generous: it is tens of
// seconds on a good link and minutes on a bad one, and giving up early would
// leave the Bailey with no database for the whole backoff.
const grypeDBRefreshTimeout = 15 * time.Minute

func grypeDBJob(image, claim string) k8srender.Object {
	return k8srender.Object{
		"apiVersion": "batch/v1",
		"kind":       "Job",
		"metadata": map[string]interface{}{
			"name": grypeDBJobName,
			"labels": map[string]interface{}{
				k8srender.NameLabel:      grypeDBJobName,
				k8srender.ManagedByLabel: k8srender.ManagedBy,
			},
		},
		"spec": map[string]interface{}{
			"backoffLimit": 0,
			// Cleaned up on its own so a daily refresh does not leave a year of
			// finished Jobs behind, but not so fast that the log is gone before
			// anyone can read why a refresh failed.
			"ttlSecondsAfterFinished": 3600,
			"template": map[string]interface{}{
				"metadata": map[string]interface{}{
					"labels": map[string]interface{}{
						k8srender.NameLabel:      grypeDBJobName,
						k8srender.ManagedByLabel: k8srender.ManagedBy,
					},
				},
				"spec": map[string]interface{}{
					"restartPolicy":                "Never",
					"automountServiceAccountToken": false,
					"containers": []interface{}{
						map[string]interface{}{
							"name":  "refresh",
							"image": image,
							// The same policy every other workload here runs
							// under. Without it Kubernetes defaults a :latest
							// tag to Always and goes to a registry for an image
							// that was built locally and never published —
							// which is a refresh stuck on ImagePullBackOff and
							// a Bailey that never gets a vulnerability
							// database.
							"imagePullPolicy": k8sPullPolicy(),
							"command":         []interface{}{"sh", "-c", grypeRefreshScript},
							"env": []interface{}{
								map[string]interface{}{"name": "GRYPE_DB_CACHE_DIR", "value": "/grype-db"},
							},
							"volumeMounts": []interface{}{
								map[string]interface{}{
									"name": "workspace", "mountPath": "/grype-db", "subPath": grypeDBSubPath,
								},
							},
						},
					},
					"volumes": []interface{}{
						map[string]interface{}{
							"name":                  "workspace",
							"persistentVolumeClaim": map[string]interface{}{"claimName": claim},
						},
					},
				},
			},
		},
	}
}
