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
// LOGIN role and each bucket its OWN Garage access key, so a backend can touch
// only its own database/bucket — not every other BP's on the shared
// per-(workspace,realm) server. No shared superuser/admin credential is ever
// attached to a scoped backend.
//
// Credentials are keyed by (realm, resource-name) where resource-name is the
// exact POSTGRES_DB / S3_BUCKET the compiler assigns the backend (so dev,
// staging, each blue-green slot DB, and per-(copy×BP) live-dev DB each get
// their own principal with no special-casing), persisted 0600 on the shared
// secrets volume.
//
// Postgres keeps the original flow: the driver GENERATES the password at
// compile time and later imposes it server-side. Garage inverts it: access
// keys can only be minted server-side (CreateKey; ImportKey with custom ids
// is forbidden upstream), so the compiler only guarantees the env_file EXISTS
// (empty placeholder on first-ever apply) and the key material is written by
// ensureGarageKeysPrecompile / the post-up provisioner, which then re-ups any
// backend that was compiled against a placeholder.

// scopedPGRole is the Postgres LOGIN role name for a database: u_<db>, capped at
// the 63-byte identifier limit (Postgres silently truncates longer names, which
// would desync the CREATE from the name the backend authenticates as — so cap
// here, consistently, for both).
func scopedPGRole(dbName string) string {
	return truncate("u_"+dbName, maxLabelLen)
}

// scopedROPGRole is the read-only explorer role for a database: ro_<db>, capped
// like scopedPGRole. It has NO password and NO creds file: it is only ever used
// via `docker exec psql -U ro_<db>` over the container's trust-authenticated
// local socket, so a password would only add a network-usable credential that
// shouldn't exist. Pathological case: for db names ≥61 bytes the blue-green
// `_1`/`_2` suffix falls past the 63-byte cap and both slots truncate to the
// same ro_ role — harmless (same BP, both its own DBs, SELECT-only).
func scopedROPGRole(dbName string) string {
	return truncate("ro_"+dbName, maxLabelLen)
}

// generatePassword returns a URL-safe random secret with no '=' padding (so it's
// safe unquoted in SQL/env).
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
	return filepath.Join(secretsDir, "garagecreds", realm, bucket)
}

// systemKeyName is the pseudo-bucket the per-realm full-access Garage key is
// stored under (backups/snapshots/explorer fallback; granted on every bucket
// the provisioner ensures). Real bucket names start "bp-"/"copy-", never "_".
const systemKeyName = "_system"

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
	// gitops (uid 1000) reads and rewrites these creds too — see ownForGitops.
	ownForGitops(filepath.Join(secretsDir, "dbcreds"), filepath.Dir(path), path)
	return user, password, nil
}

// readBucketCreds returns the Garage-issued (accessKey, secretKey) for a
// bucket, or ("", "") when the file is absent or still a placeholder.
func readBucketCreds(secretsDir, realm, bucket string) (accessKey, secretKey string) {
	vals := readEnvFile(bucketCredsPath(secretsDir, realm, bucket))
	if vals == nil || vals["S3_SECRET_KEY"] == "" {
		return "", ""
	}
	return vals["S3_ACCESS_KEY"], vals["S3_SECRET_KEY"]
}

// writeBucketCreds persists key material Garage just minted (CreateKey).
func writeBucketCreds(secretsDir, realm, bucket, accessKey, secretKey string) error {
	path := bucketCredsPath(secretsDir, realm, bucket)
	if err := writeEnvFile(path, map[string]string{
		"S3_ACCESS_KEY": accessKey,
		"S3_SECRET_KEY": secretKey,
	}); err != nil {
		return err
	}
	// gitops (uid 1000) reads these creds too — see ownForGitops.
	ownForGitops(filepath.Join(secretsDir, "garagecreds"), filepath.Dir(path), path)
	return nil
}

// ensureBucketCredsFile guarantees the creds env_file EXISTS at compile time:
// on the first-ever apply the garage container isn't up yet, so no key can be
// minted — an empty 0600 placeholder keeps `compose up` happy and the post-up
// provisioner mints the real key, rewrites the file and re-ups the backend
// (writeEnvFile drops empty values, so a placeholder is just an empty file;
// readEnvFile returns nil for it, which is the placeholder test).
func ensureBucketCredsFile(secretsDir, realm, bucket string) error {
	path := bucketCredsPath(secretsDir, realm, bucket)
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	if err := writeEnvFile(path, nil); err != nil {
		return err
	}
	ownForGitops(filepath.Join(secretsDir, "garagecreds"), filepath.Dir(path), path)
	return nil
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
