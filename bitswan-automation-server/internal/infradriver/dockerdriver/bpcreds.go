package dockerdriver

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Per-BP scoped service credentials. Each BP database gets its OWN Postgres
// LOGIN role and each bucket its OWN MinIO user, so a backend can touch only its
// own database/bucket — not every other BP's on the shared per-(workspace,realm)
// server. The shared superuser/root is no longer attached to a scoped backend.
//
// Credentials are keyed by (realm, resource-name) where resource-name is the
// exact POSTGRES_DB / MINIO_BUCKET the compiler assigns the backend (so dev,
// staging, each blue-green slot DB, and per-(copy×BP) live-dev DB each get their
// own principal with no special-casing). The generated material is the single
// source of truth, persisted 0600 on the shared secrets volume and read by BOTH
// the compiler (to inject into the backend's env) and the provisioner (to CREATE
// the role/user with the same password). The driver owns this end-to-end; gitops
// is not involved.

// scopedPGRole is the Postgres LOGIN role name for a database: u_<db>, capped at
// the 63-byte identifier limit (Postgres silently truncates longer names, which
// would desync the CREATE from the name the backend authenticates as — so cap
// here, consistently, for both).
func scopedPGRole(dbName string) string {
	return truncate("u_"+dbName, maxLabelLen)
}

// scopedMinioUser is the MinIO access key (user) for a bucket: u-<bucket>.
func scopedMinioUser(bucket string) string {
	return "u-" + bucket
}

// generatePassword returns a URL-safe random secret with no '=' padding (so it's
// safe unquoted in SQL/env and as a MinIO secret key).
func generatePassword() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return strings.TrimRight(base64.URLEncoding.EncodeToString(b), "="), nil
}

// dbCredsPath / bucketCredsPath are the per-resource KEY=VALUE env files on the
// secrets volume. They double as the compose env_file (the compiler appends the
// path; only the path lands in the generated YAML, values stay on disk).
func dbCredsPath(secretsDir, realm, dbName string) string {
	return filepath.Join(secretsDir, "dbcreds", realm, dbName)
}

func bucketCredsPath(secretsDir, realm, bucket string) string {
	return filepath.Join(secretsDir, "miniocreds", realm, bucket)
}

// getOrCreateDBCreds returns the scoped Postgres role + password for a database,
// generating and persisting them on first use and reusing them thereafter. The
// role name is derived (u_<db>); only the password is random. Idempotent and
// stable across deploys.
func getOrCreateDBCreds(secretsDir, realm, dbName string) (user, password string, err error) {
	user = scopedPGRole(dbName)
	path := dbCredsPath(secretsDir, realm, dbName)
	if vals := readEnvFile(path); vals != nil && vals["POSTGRES_PASSWORD"] != "" {
		return user, vals["POSTGRES_PASSWORD"], nil
	}
	password, err = generatePassword()
	if err != nil {
		return "", "", err
	}
	if err := writeEnvFile(path, map[string]string{
		"POSTGRES_USER":     user,
		"POSTGRES_PASSWORD": password,
	}); err != nil {
		return "", "", err
	}
	return user, password, nil
}

// getOrCreateBucketCreds returns the scoped MinIO access/secret key for a bucket,
// generating and persisting them on first use and reusing them thereafter.
func getOrCreateBucketCreds(secretsDir, realm, bucket string) (accessKey, secretKey string, err error) {
	accessKey = scopedMinioUser(bucket)
	path := bucketCredsPath(secretsDir, realm, bucket)
	if vals := readEnvFile(path); vals != nil && vals["MINIO_SECRET_KEY"] != "" {
		return accessKey, vals["MINIO_SECRET_KEY"], nil
	}
	secretKey, err = generatePassword()
	if err != nil {
		return "", "", err
	}
	if err := writeEnvFile(path, map[string]string{
		"MINIO_ACCESS_KEY": accessKey,
		"MINIO_SECRET_KEY": secretKey,
	}); err != nil {
		return "", "", err
	}
	return accessKey, secretKey, nil
}

// readEnvFile parses a KEY=VALUE file into a map, or returns nil if absent.
// (serviceSecrets reads by service-type+realm; this reads an arbitrary path.)
func readEnvFile(path string) map[string]string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		k, v, _ := strings.Cut(line, "=")
		out[k] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// writeEnvFile atomically writes a KEY=VALUE file (0600, sorted keys), creating
// parent dirs. Mirrors materializeEnv's tmp+rename pattern.
func writeEnvFile(path string, values map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		if strings.TrimSpace(values[k]) != "" {
			fmt.Fprintf(&b, "%s=%s\n", k, values[k])
		}
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
