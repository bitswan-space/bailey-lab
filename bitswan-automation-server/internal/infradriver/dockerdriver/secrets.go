package dockerdriver

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
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

// bpSecretEnvFilePath is <secrets>/bp/<slug>/<realm> (bp_secrets.env_file_path).
func bpSecretEnvFilePath(secretsDir, bp, stage string) string {
	return filepath.Join(secretsDir, "bp", sanitizeAutomationName(bp), realmForStage(stage))
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
	return key, nil
}

// decryptSecrets decrypts a base64(nonce + GCM ciphertext) blob to {KEY: value}
// (bp_secrets.decrypt_secrets). Returns nil if the blob is unreadable.
func decryptSecrets(secretsDir, blob string) map[string]string {
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

// materializeEnv (re)writes the stage's plaintext env file from decrypted
// values (non-empty only) and returns its path (bp_secrets.materialize_env).
func materializeEnv(secretsDir, bp, stage string, values map[string]string) (string, error) {
	path := bpSecretEnvFilePath(secretsDir, bp, stage)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
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
	return path, nil
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
