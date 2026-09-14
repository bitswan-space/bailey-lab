package k8sdriver

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/core"
	"github.com/bitswan-space/bitswan-workspaces/internal/k8srender"
)

func (c *compileState) resourceNames(bpSanitized, wtName, stage string, db int) map[string]string {
	if bpSanitized == "" {
		return nil
	}
	if wtName != "" && stage == "live-dev" {
		return core.CopyBPResourceNames(wtName, bpSanitized)
	}
	if core.LoadRegistry(c.ctx.SecretsDir).IsRegistered(bpSanitized, core.StageForDeployment(stage)) {
		return core.BPResourceNames(bpSanitized, db)
	}
	return nil
}

func (c *compileState) credentials(conf *core.Deployment, cfg core.AutomationConfig, bpSanitized, stage string, resources map[string]string) (secret map[string]string, inline map[string]string) {
	secret = map[string]string{}
	inline = map[string]string{}
	if bpSanitized == "" || cfg.Expose {
		return secret, inline
	}
	realm := core.RealmForStage(stage)

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

	for _, name := range core.ResolveServiceSecrets(cfg, stage) {
		if pgDB != "" && strings.HasPrefix(name, "postgres") {
			continue
		}
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

func credentialSecret(workload string, content map[string]string, labels map[string]interface{}) (string, k8srender.ObjectSet) {
	if len(content) == 0 {
		return "", nil
	}
	name := k8srender.Name(workload+"-env", k8srender.ServiceNameMax)
	return name, k8srender.ObjectSet{k8srender.Secret(name, content, labels)}
}
