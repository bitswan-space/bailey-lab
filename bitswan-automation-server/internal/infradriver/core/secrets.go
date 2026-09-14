package core

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Per-(BP, stage) secrets. The compiler decrypts a stage's blob from
// bitswan.yaml and (re)materializes the plaintext env file the container loads,
// then references it from the compose `env_file`. Ports app/services/bp_secrets.py.

const (
	aesKeyBytes   = 32
	aesNonceBytes = 12
)

// The gitops container writes this same secrets volume as uid 1000 (user1000)
// while the driver runs as root, and BP creation auto-deploys — so the driver
// usually touches a BP's secrets paths first. A dir it leaves root-owned locks
// gitops out of every later secret write for that BP (EACCES → the dashboard's
// "Apply" 502s), and a root-owned 0600 file (.aes-key, db/bucket creds) is
// silently unreadable to gitops. Hand everything the driver creates here to
// the gitops user.

// BPSecretEnvFilePath is <secrets>/bp/<slug>/<realm> (bp_secrets.env_file_path).
func BPSecretEnvFilePath(secretsDir, bp, stage string) string {
	return filepath.Join(secretsDir, "bp", SanitizeAutomationName(bp), RealmForStage(stage))
}

// loadAESKey reads (or creates) the workspace-local AES key on the secrets
// volume (bp_secrets._load_key). 0600, never in git.
func loadAESKey(secretsDir string) ([]byte, error) {
	path := filepath.Join(secretsDir, ".aes-key")
	if data, err := os.ReadFile(path); err == nil && len(data) == aesKeyBytes {
		return data, nil
	}
	if err := os.MkdirAll(secretsDir, 0o755); err != nil {
		return nil, err
	}
	key := make([]byte, aesKeyBytes)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, key, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	OwnForGitops(secretsDir, path)
	return key, nil
}

// DecryptSecrets decrypts a base64(nonce + GCM ciphertext) blob to {KEY: value}
// (bp_secrets.decrypt_secrets). Returns nil if the blob is unreadable.
func DecryptSecrets(secretsDir, blob string) map[string]string {
	if blob == "" {
		return nil
	}
	key, err := loadAESKey(secretsDir)
	if err != nil {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(blob)
	if err != nil || len(raw) < aesNonceBytes {
		return nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil
	}
	pt, err := gcm.Open(nil, raw[:aesNonceBytes], raw[aesNonceBytes:], nil)
	if err != nil {
		return nil
	}
	var data map[string]interface{}
	if err := json.Unmarshal(pt, &data); err != nil {
		return nil
	}
	out := map[string]string{}
	for k, v := range data {
		out[k] = stringify(v)
	}
	return out
}

// MaterializeEnv (re)writes the stage's plaintext env file from decrypted
// values (non-empty only) and returns its path (bp_secrets.materialize_env).
func MaterializeEnv(secretsDir, bp, stage string, values map[string]string) (string, error) {
	path := BPSecretEnvFilePath(secretsDir, bp, stage)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	OwnForGitops(filepath.Join(secretsDir, "bp"), filepath.Dir(path))
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		v := values[k]
		if strings.TrimSpace(v) != "" {
			b.WriteString(k)
			b.WriteString("=")
			b.WriteString(v)
			b.WriteString("\n")
		}
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", err
	}
	OwnForGitops(path)
	return path, nil
}

// SecretsContentHash is a stable, workspace-keyed digest of the NON-EMPTY,
// sorted KEY=VALUE content materialized into the env file — identical inputs
// under the same workspace key → identical hash. It is folded into a service
// label so a secret-only change (same image, same env_file path) still changes
// the service config and `docker compose up` recreates the container; without
// it compose keys recreation off the config alone and never reloads changed
// env_file CONTENTS. The digest is an HMAC under the workspace AES key, never a
// bare hash of the values: the label is readable by anyone who can list
// containers, and a bare hash of a short secret is a guess-and-compare oracle.
// No content, or no key to hash it under, ⇒ "" (no label, so secret-less
// services never churn).
func SecretsContentHash(secretsDir string, values map[string]string) string {
	stream := secretsContentStream(values)
	if stream == "" {
		return ""
	}
	key, err := loadAESKey(secretsDir)
	if err != nil || len(key) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(stream))
	return hex.EncodeToString(mac.Sum(nil))[:16]
}

func secretsContentStream(values map[string]string) string {
	if len(values) == 0 {
		return ""
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		v := values[k]
		if strings.TrimSpace(v) == "" {
			continue
		}
		b.WriteString(k)
		b.WriteString("=")
		b.WriteString(v)
		b.WriteString("\n")
	}
	return b.String()
}

func stringify(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

// ServiceSuffix is what a non-production realm adds to an infra service's name.
func ServiceSuffix(stage string) string {
	if stage == "production" || stage == "" {
		return ""
	}
	return "-" + stage
}

// InfraServiceSecretsName is the secrets file a declared service dependency
// contributes to a workload's environment.
func InfraServiceSecretsName(svcType, stage string) string {
	return svcType + ServiceSuffix(stage)
}

// IsKnownInfraType reports whether a declared service is one a driver can
// actually stand up.
func IsKnownInfraType(svcType string) bool {
	switch svcType {
	case "couchdb", "garage", "postgres", "kafka":
		return true
	}
	return false
}

// ResolveServiceSecrets is the secrets files a workload's declared service
// dependencies contribute, in declaration order — the order is observable,
// because a later file overrides an earlier one.
func ResolveServiceSecrets(cfg AutomationConfig, stage string) []string {
	if !cfg.HasServices() {
		return nil
	}
	mapped := StageForDeployment(stage)
	var out []string
	for _, svc := range cfg.Services {
		if !svc.Enabled || !IsKnownInfraType(svc.Type) {
			continue
		}
		out = append(out, InfraServiceSecretsName(svc.Type, mapped))
	}
	return out
}
