package dockerdriver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	yaml "gopkg.in/yaml.v3"
)

func TestScopedNames(t *testing.T) {
	if got := scopedPGRole("bp_acme"); got != "u_bp_acme" {
		t.Errorf("scopedPGRole = %q, want u_bp_acme", got)
	}
	if got := scopedMinioUser("bp-acme"); got != "u-bp-acme" {
		t.Errorf("scopedMinioUser = %q, want u-bp-acme", got)
	}
	// Capped at the 63-byte identifier limit (else Postgres would silently
	// truncate, desyncing the role we CREATE from the one the backend logs in as).
	long := strings.Repeat("a", 70)
	if got := scopedPGRole(long); len(got) != maxLabelLen {
		t.Errorf("scopedPGRole(len 70) = %d bytes, want %d", len(got), maxLabelLen)
	}
}

func TestGetOrCreateCredsStable(t *testing.T) {
	dir := t.TempDir()

	u1, p1, err := getOrCreateDBCreds(dir, "dev", "bp_acme")
	if err != nil {
		t.Fatal(err)
	}
	if u1 != "u_bp_acme" || p1 == "" {
		t.Fatalf("db creds = (%q,%q)", u1, p1)
	}
	// Stable across calls (the persisted value is the single source of truth).
	u2, p2, _ := getOrCreateDBCreds(dir, "dev", "bp_acme")
	if u2 != u1 || p2 != p1 {
		t.Errorf("db creds not stable: (%q,%q) then (%q,%q)", u1, p1, u2, p2)
	}
	// Different (realm, resource) → different password.
	_, pStaging, _ := getOrCreateDBCreds(dir, "staging", "bp_acme")
	_, pOther, _ := getOrCreateDBCreds(dir, "dev", "bp_other")
	if pStaging == p1 || pOther == p1 {
		t.Error("expected distinct passwords per (realm, resource)")
	}
	// Persisted 0600 as a KEY=VALUE env file the compiler can attach.
	info, err := os.Stat(dbCredsPath(dir, "dev", "bp_acme"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("cred file mode = %v, want 0600", info.Mode().Perm())
	}

	ak, sk, err := getOrCreateBucketCreds(dir, "dev", "bp-acme")
	if err != nil {
		t.Fatal(err)
	}
	if ak != "u-bp-acme" || sk == "" {
		t.Fatalf("bucket creds = (%q,%q)", ak, sk)
	}
	ak2, sk2, _ := getOrCreateBucketCreds(dir, "dev", "bp-acme")
	if ak2 != ak || sk2 != sk {
		t.Errorf("bucket creds not stable")
	}
}

// recordExec swaps dockerExec for a recorder, returning the captured commands
// (each as "container\x00arg1\x00arg2...") and a restore func.
func recordExec(t *testing.T) (*[]string, func()) {
	t.Helper()
	var calls []string
	orig := dockerExec
	dockerExec = func(_ context.Context, container string, args ...string) (string, string, int) {
		calls = append(calls, container+"\x00"+strings.Join(args, "\x00"))
		return "", "", 0
	}
	return &calls, func() { dockerExec = orig }
}

func joined(calls []string) string { return strings.Join(calls, "\n") }

func TestEnsureBPRoleCommands(t *testing.T) {
	dir := t.TempDir()
	calls, restore := recordExec(t)
	defer restore()

	if err := ensureBPRole(context.Background(), "ws__postgres-dev", "admin", dir, "dev", "bp_acme"); err != nil {
		t.Fatal(err)
	}
	all := joined(*calls)
	for _, want := range []string{
		`CREATE ROLE "u_bp_acme" LOGIN PASSWORD`,
		`GRANT ALL ON SCHEMA public TO "u_bp_acme"`,
		`REVOKE CONNECT ON DATABASE "bp_acme" FROM PUBLIC`,
		`GRANT CONNECT ON DATABASE "bp_acme" TO "u_bp_acme"`,
		"\x00-d\x00bp_acme\x00", // grants run connected to the BP's own database
		"\x00admin\x00",         // connects as the shared superuser
	} {
		if !strings.Contains(all, want) {
			t.Errorf("ensureBPRole did not issue %q.\nGot:\n%s", want, all)
		}
	}
}

func TestEnsureBPMinioUserCommands(t *testing.T) {
	dir := t.TempDir()
	calls, restore := recordExec(t)
	defer restore()

	if err := ensureBPMinioUser(context.Background(), "ws__minio-dev", "root", "rootpw", dir, "dev", "bp-acme"); err != nil {
		t.Fatal(err)
	}
	all := joined(*calls)
	for _, want := range []string{
		"mc\x00admin\x00user\x00add\x00local\x00u-bp-acme\x00",
		"mc\x00admin\x00policy\x00create\x00local\x00u-bp-acme\x00",
		"mc\x00admin\x00policy\x00attach\x00local\x00u-bp-acme\x00--user\x00u-bp-acme",
		"arn:aws:s3:::bp-acme",
		"arn:aws:s3:::bp-acme/*",
	} {
		if !strings.Contains(all, want) {
			t.Errorf("ensureBPMinioUser did not issue %q.\nGot:\n%s", want, all)
		}
	}
}

// TestCompileScopedRegisteredBP exercises the registered-BP path the golden
// fixtures don't cover: a registered backend must attach its scoped dbcreds /
// miniocreds env files and must NOT attach the shared postgres/minio service
// secrets (the superuser/root must not reach it).
func TestCompileScopedRegisteredBP(t *testing.T) {
	sc := loadScenario(t, "dev")
	root := t.TempDir()
	wctx := buildTree(t, root, sc)
	// Register the BP "acme" at the dev realm.
	mustWrite(t, filepath.Join(wctx.SecretsDir, "bp-databases.json"),
		`{"version":1,"bps":{"acme":{"stages":{"dev":{}}}}}`)

	setEnv(t, "BITSWAN_GITOPS_DIR_HOST", wctx.GitopsDir)
	setEnv(t, "BITSWAN_WORKSPACE_REPO_DIR", filepath.Join(root, "workspace-repo"))
	unsetEnv(t, "KEYCLOAK_URL")
	unsetEnv(t, "BITSWAN_VOLUME_NAME")
	unsetEnv(t, "BITSWAN_CERTS_DIR")

	bs, err := parseBitswanYAML([]byte(sc.BitswanYAML))
	if err != nil {
		t.Fatal(err)
	}
	gotYAML, _, _, err := compile(wctx, bs)
	if err != nil {
		t.Fatal(err)
	}

	var doc struct {
		Services map[string]struct {
			EnvFile     []string               `yaml:"env_file"`
			Environment map[string]interface{} `yaml:"environment"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal([]byte(gotYAML), &doc); err != nil {
		t.Fatal(err)
	}

	// Find the registered backend service (POSTGRES_DB = bp_acme).
	var svcName string
	for name, svc := range doc.Services {
		if svc.Environment["POSTGRES_DB"] == "bp_acme" {
			svcName = name
			break
		}
	}
	if svcName == "" {
		t.Fatalf("no service with POSTGRES_DB=bp_acme found in:\n%s", gotYAML)
	}
	ef := strings.Join(doc.Services[svcName].EnvFile, "\n")
	if !strings.Contains(ef, "/secrets/dbcreds/dev/bp_acme") {
		t.Errorf("backend %s missing scoped dbcreds env_file; got: %v", svcName, doc.Services[svcName].EnvFile)
	}
	if !strings.Contains(ef, "/secrets/miniocreds/dev/bp-acme") {
		t.Errorf("backend %s missing scoped miniocreds env_file; got: %v", svcName, doc.Services[svcName].EnvFile)
	}
	if strings.Contains(ef, "/secrets/postgres-dev") || strings.Contains(ef, "/secrets/minio-dev") {
		t.Errorf("backend %s still attaches the shared superuser/root secret; got: %v", svcName, doc.Services[svcName].EnvFile)
	}
}
