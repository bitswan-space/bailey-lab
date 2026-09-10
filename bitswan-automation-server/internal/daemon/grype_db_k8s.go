package daemon

import (
	"context"
	"fmt"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/k8sctl"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

const grypeDBSubPath = "grype-db"

const grypeDBJobName = "bitswan-grype-db-refresh"

func refreshGrypeDBK8s(ctx context.Context, image, claim string) error {
	if image == "" {
		return fmt.Errorf("no gitops image available to source grype from")
	}
	if claim == "" {
		return fmt.Errorf("no workspace volume to hold the vulnerability database")
	}

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
			"backoffLimit":            0,
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
							"name":            "refresh",
							"image":           image,
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
