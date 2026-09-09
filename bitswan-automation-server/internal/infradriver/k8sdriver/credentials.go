package k8sdriver

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

// What a business process authenticates as.
//
// On Docker these arrive as a list of env_file paths on the compose service:
// the process's own decrypted secrets, then its per-resource database and
// bucket credentials, then whatever its declared service dependencies
// contribute — each file overriding the one before it, and the service's own
// `environment` block overriding all of them.
//
// Kubernetes has no env_file. The same files are read in the same order, merged
// with the same precedence into one Secret, and referenced with envFrom; the
// container's inline env still wins, which is what `environment` does on
// compose. So the resolution is identical and only the delivery differs.

// resourceNames is the per-process database, bucket and document-store names,
// or nothing when this process has no namespace of its own.
func (c *compileState) resourceNames(bpSanitized, wtName, stage string, db int) map[string]string {
	if bpSanitized == "" {
		return nil
	}
	// A non-main copy's live-dev backend gets its own per-(copy, process)
	// namespaces, isolated from other processes in the copy and from other
	// copies — unconditionally, not only when registered.
	if wtName != "" && stage == "live-dev" {
		return core.CopyBPResourceNames(wtName, bpSanitized)
	}
	if core.LoadRegistry(c.ctx.SecretsDir).IsRegistered(bpSanitized, core.StageForDeployment(stage)) {
		return core.BPResourceNames(bpSanitized, db)
	}
	return nil
}

// credentials resolves everything a workload's environment gets from files, and
// returns it as the content of one Secret plus the non-secret coordinates that
// belong inline.
//
// A frontend gets none of it: the process's secrets belong to the code that
// talks to the database, and a frontend is served to a browser.
func (c *compileState) credentials(conf *core.Deployment, cfg core.AutomationConfig, bpSanitized, stage string, resources map[string]string) (secret map[string]string, inline map[string]string) {
	secret = map[string]string{}
	inline = map[string]string{}
	if bpSanitized == "" || cfg.Expose {
		return secret, inline
	}
	realm := core.RealmForStage(stage)

	// The process's own declared secrets, materialized from the encrypted blob
	// in the declaration.
	var values map[string]string
	if c.bs.Secrets != nil {
		if byRealm := c.bs.Secrets[bpSanitized]; byRealm != nil {
			if blob := byRealm[realm]; blob != "" {
				values = core.DecryptSecrets(c.ctx.SecretsDir, blob)
			}
		}
	}
	if path, err := core.MaterializeEnv(c.ctx.SecretsDir, bpSanitized, stage, values); err == nil {
		mergeEnvFile(secret, path)
	}

	// Its own database role, and its own bucket key — never the superuser and
	// never the admin token. A process with a database of its own gets the
	// shared service secret's coordinates copied in, because that secret, which
	// carries the superuser, is deliberately not attached.
	pgDB := resources["postgres_db"]
	s3Bucket := resources["s3_bucket"]
	if pgDB != "" {
		if _, _, err := core.GetOrCreateDBCreds(c.ctx.SecretsDir, realm, pgDB); err == nil {
			mergeEnvFile(secret, core.DbCredsPath(c.ctx.SecretsDir, realm, pgDB))
		}
		if pg := core.ServiceSecrets(c.ctx.SecretsDir, "postgres", realm); pg != nil {
			for _, k := range []string{"POSTGRES_HOST", "POSTGRES_PORT"} {
				if v := pg[k]; v != "" {
					inline[k] = v
				}
			}
		}
	}
	if s3Bucket != "" {
		if err := core.EnsureBucketCredsFile(c.ctx.SecretsDir, realm, s3Bucket); err == nil {
			mergeEnvFile(secret, core.BucketCredsPath(c.ctx.SecretsDir, realm, s3Bucket))
		}
		c.copyS3Coordinates(inline, realm)
	}

	// Declared service dependencies, in declaration order.
	for _, name := range core.ResolveServiceSecrets(cfg, stage) {
		if pgDB != "" && strings.HasPrefix(name, "postgres") {
			continue
		}
		// The garage service secret carries the admin token and must never
		// reach a workload. A process with no bucket of its own gets the shared
		// full-access key instead.
		if strings.HasPrefix(name, "garage") {
			if s3Bucket == "" {
				if err := core.EnsureBucketCredsFile(c.ctx.SecretsDir, realm, core.SystemKeyName); err == nil {
					mergeEnvFile(secret, core.BucketCredsPath(c.ctx.SecretsDir, realm, core.SystemKeyName))
				}
				c.copyS3Coordinates(inline, realm)
			}
			continue
		}
		mergeEnvFile(secret, filepath.Join(c.ctx.SecretsDir, name))
	}

	// The host a coordinate names is a Docker container name, which is not a
	// legal DNS name here. The Service is named the way the compiler names
	// everything, so the coordinate is rewritten to match rather than the
	// Service being named something Kubernetes would reject.
	for _, k := range []string{"POSTGRES_HOST", "S3_HOST"} {
		if v := inline[k]; v != "" {
			inline[k] = k8srender.Name(v, k8srender.ServiceNameMax)
		}
	}
	return secret, inline
}

func (c *compileState) copyS3Coordinates(inline map[string]string, realm string) {
	if g := core.ServiceSecrets(c.ctx.SecretsDir, "garage", realm); g != nil {
		for _, k := range []string{"S3_HOST", "S3_PORT"} {
			if v := g[k]; v != "" {
				inline[k] = v
			}
		}
	}
}

// mergeEnvFile folds a file's assignments into dst, later winning — the
// precedence a list of env_file entries has on compose.
func mergeEnvFile(dst map[string]string, path string) {
	if path == "" {
		return
	}
	if _, err := os.Stat(path); err != nil {
		return
	}
	for k, v := range core.ReadEnvFile(path) {
		dst[k] = v
	}
}

// credentialSecret renders the merged content as a Secret named for the
// workload, or nothing when there is nothing to deliver.
func credentialSecret(workload string, content map[string]string) (string, k8srender.ObjectSet) {
	if len(content) == 0 {
		return "", nil
	}
	name := k8srender.Name(workload+"-env", k8srender.ServiceNameMax)
	return name, k8srender.ObjectSet{k8srender.Secret(name, content)}
}
