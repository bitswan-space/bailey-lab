package dockerdriver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	yaml "gopkg.in/yaml.v3"
)

func TestScopedNames(t *testing.T) {
	if got := scopedPGRole("bp_acme"); got != "u_bp_acme" {
		t.Errorf("scopedPGRole = %q, want u_bp_acme", got)
	}
	if got := scopedROPGRole("bp_acme"); got != "ro_bp_acme" {
		t.Errorf("scopedROPGRole = %q, want ro_bp_acme", got)
	}
	// Capped at the 63-byte identifier limit (else Postgres would silently
	// truncate, desyncing the role we CREATE from the one the backend logs in as).
	long := strings.Repeat("a", 70)
	if got := scopedPGRole(long); len(got) != maxLabelLen {
		t.Errorf("scopedPGRole(len 70) = %d bytes, want %d", len(got), maxLabelLen)
	}
	if got := scopedROPGRole(long); len(got) != maxLabelLen {
		t.Errorf("scopedROPGRole(len 70) = %d bytes, want %d", len(got), maxLabelLen)
	}
	// gitops mirrors this derivation as ("ro_"+db)[:63] in data_explorer.py —
	// the truncation point must stay in sync on both sides.
	if got, want := scopedROPGRole(long), ("ro_" + long)[:maxLabelLen]; got != want {
		t.Errorf("scopedROPGRole(len 70) = %q, want prefix-truncated %q", got, want)
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

	// Garage bucket creds: server-minted, so the compiler only guarantees the
	// env_file EXISTS (empty placeholder) until the provisioner writes values.
	if err := ensureBucketCredsFile(dir, "dev", "bp-acme"); err != nil {
		t.Fatal(err)
	}
	path := bucketCredsPath(dir, "dev", "bp-acme")
	info, err = os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 || info.Size() != 0 {
		t.Errorf("placeholder = mode %v size %d, want 0600 empty", info.Mode().Perm(), info.Size())
	}
	if ak, sk := readBucketCreds(dir, "dev", "bp-acme"); ak != "" || sk != "" {
		t.Errorf("placeholder read as real creds: (%q,%q)", ak, sk)
	}
	// Provisioner writes Garage-issued material; reads round-trip it.
	if err := writeBucketCreds(dir, "dev", "bp-acme", "GK123", "s3cr3t"); err != nil {
		t.Fatal(err)
	}
	if ak, sk := readBucketCreds(dir, "dev", "bp-acme"); ak != "GK123" || sk != "s3cr3t" {
		t.Errorf("bucket creds = (%q,%q), want (GK123,s3cr3t)", ak, sk)
	}
	// ensureBucketCredsFile must never clobber real values.
	if err := ensureBucketCredsFile(dir, "dev", "bp-acme"); err != nil {
		t.Fatal(err)
	}
	if ak, _ := readBucketCreds(dir, "dev", "bp-acme"); ak != "GK123" {
		t.Errorf("ensureBucketCredsFile clobbered real creds: ak=%q", ak)
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
		// Role is created with a server-side connection cap so a runaway backend
		// pool can't exhaust the shared postgres server.
		`CREATE ROLE "u_bp_acme" LOGIN CONNECTION LIMIT 10 PASSWORD`,
		`ALTER ROLE "u_bp_acme" WITH LOGIN CONNECTION LIMIT 10 PASSWORD`,
		`GRANT ALL ON SCHEMA public TO "u_bp_acme"`,
		// Role must OWN its tables so backend migrations (DDL) work.
		`ALTER TABLE public.%I OWNER TO "u_bp_acme"`,
		`ALTER SEQUENCE public.%I OWNER TO "u_bp_acme"`,
		`REVOKE CONNECT ON DATABASE "bp_acme" FROM PUBLIC`,
		`GRANT CONNECT ON DATABASE "bp_acme" TO "u_bp_acme"`,
		// Read-only explorer twin: passwordless (local-socket exec only), capped,
		// SELECT-only — including future tables u_<db> creates.
		`CREATE ROLE "ro_bp_acme" LOGIN CONNECTION LIMIT 3`,
		`ALTER ROLE "ro_bp_acme" WITH LOGIN CONNECTION LIMIT 3 PASSWORD NULL`,
		`GRANT CONNECT ON DATABASE "bp_acme" TO "ro_bp_acme"`,
		`GRANT USAGE ON SCHEMA public TO "ro_bp_acme"`,
		`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "ro_bp_acme"`,
		`ALTER DEFAULT PRIVILEGES FOR ROLE "u_bp_acme" IN SCHEMA public GRANT SELECT ON TABLES TO "ro_bp_acme"`,
		"\x00-d\x00bp_acme\x00", // grants run connected to the BP's own database
		"\x00admin\x00",         // connects as the shared superuser
	} {
		if !strings.Contains(all, want) {
			t.Errorf("ensureBPRole did not issue %q.\nGot:\n%s", want, all)
		}
	}
}

// garageFakeExec swaps dockerExec for a scripted Garage json-api fake: it
// records argv (recordExec format) and returns canned JSON stdout per
// endpoint. `buckets` maps alias→id for ListBuckets/GetBucketInfo; `keys`
// seeds ListKeys; CreateKey mints GK<n> deterministically.
func garageFakeExec(t *testing.T, buckets map[string]string, keys []string) (*[]string, func()) {
	t.Helper()
	var calls []string
	nextKey := 0
	orig := dockerExec
	dockerExec = func(_ context.Context, container string, args ...string) (string, string, int) {
		calls = append(calls, container+"\x00"+strings.Join(args, "\x00"))
		if len(args) < 2 || args[0] != "/garage" || args[1] != "json-api" {
			return "", "", 0
		}
		endpoint := args[2]
		switch endpoint {
		case "ListBuckets":
			rows := make([]string, 0, len(buckets))
			for alias, id := range buckets {
				rows = append(rows, `{"id":"`+id+`","globalAliases":["`+alias+`"]}`)
			}
			return "[" + strings.Join(rows, ",") + "]", "", 0
		case "ListKeys":
			rows := make([]string, 0, len(keys))
			for _, k := range keys {
				rows = append(rows, `{"id":"`+k+`"}`)
			}
			return "[" + strings.Join(rows, ",") + "]", "", 0
		case "CreateKey":
			nextKey++
			return `{"accessKeyId":"GK` + strings.Repeat("0", 3) + string(rune('0'+nextKey)) + `","secretAccessKey":"sk-` + string(rune('0'+nextKey)) + `"}`, "", 0
		case "CreateBucket":
			return `{"id":"bid-new"}`, "", 0
		case "GetBucketInfo":
			return `{"id":"bid-existing"}`, "", 0
		case "AllowBucketKey":
			return `{}`, "", 0
		}
		return "", "unexpected endpoint " + endpoint, 1
	}
	return &calls, func() { dockerExec = orig }
}

// TestGarageConfigMountVolumeMode pins the shared-volume subpath of the
// garage.toml mount: on the volume the workspace root is workspaces/<ws>/ and
// `secrets` is a SIBLING of `gitops` — mounting workspaces/<ws>/gitops/secrets
// left the container un-startable (lstat: no such file or directory).
func TestGarageConfigMountVolumeMode(t *testing.T) {
	c := &compileState{workspaceName: "dev", volumeName: "bitswan", secretsDir: "/gitops/secrets"}
	n := infraNamesFor(c.secretsDir, c.workspaceName, "garage", "dev")
	m, ok := c.garageConfigMount(n).(map[string]interface{})
	if !ok {
		t.Fatalf("volume mode must produce a long-syntax mount, got %T", c.garageConfigMount(n))
	}
	vol, _ := m["volume"].(map[string]interface{})
	if got, want := vol["subpath"], "workspaces/dev/secrets/garage-dev.toml"; got != want {
		t.Errorf("subpath = %v, want %v", got, want)
	}
	if m["source"] != "bitswan" || m["target"] != "/etc/garage.toml" {
		t.Errorf("mount = %v", m)
	}
	// Bind mode: host path is <workspace-root-host>/secrets/<file>.
	c.volumeName = ""
	c.gitopsDirHost = "/host/workspaces/dev"
	if got, want := c.garageConfigMount(n), "/host/workspaces/dev/secrets/garage-dev.toml:/etc/garage.toml:ro"; got != want {
		t.Errorf("bind mount = %v, want %v", got, want)
	}
}

func TestReconcileGarageBuckets(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "garage-dev"),
		"GARAGE_ADMIN_TOKEN=tok\nS3_HOST=ws-garage-dev\nS3_PORT=9000\n")
	origRunning := containerRunning
	containerRunning = func(context.Context, string) bool { return true }
	defer func() { containerRunning = origRunning }()

	calls, restore := garageFakeExec(t, map[string]string{}, nil)
	defer restore()

	wctx := infradriver.WorkspaceContext{WorkspaceName: "ws", SecretsDir: dir}
	changed := reconcileGarageBuckets(context.Background(), wctx, "dev",
		map[string]bool{"bp-acme": true}, func(string, string) {})

	all := joined(*calls)
	// Cold path: _system key minted, BP key minted, bucket created, both granted.
	for _, want := range []string{
		`json-api\x00CreateKey\x00{"name":"_system"}`,
		`json-api\x00CreateKey\x00{"name":"bp-bp-acme"}`,
		`json-api\x00CreateBucket\x00{"globalAlias":"bp-acme"}`,
		`json-api\x00AllowBucketKey`,
	} {
		w := strings.ReplaceAll(want, `\x00`, "\x00")
		if !strings.Contains(all, w) {
			t.Errorf("reconcileGarageBuckets did not issue %q.\nGot:\n%s", w, all)
		}
	}
	// Both keys persisted with the Garage-issued material.
	if ak, sk := readBucketCreds(dir, "dev", systemKeyName); ak == "" || sk == "" {
		t.Error("_system creds not persisted")
	}
	bpAK, _ := readBucketCreds(dir, "dev", "bp-acme")
	if bpAK == "" {
		t.Error("bp-acme creds not persisted")
	}
	// The BP key was minted post-up (placeholder path) → convergence set.
	if len(changed) != 1 || changed[0] != bucketCredsPath(dir, "dev", "bp-acme") {
		t.Errorf("changed = %v, want the bp-acme creds path", changed)
	}

	// Warm path: bucket + keys exist server-side, real creds on disk →
	// zero create/grant execs beyond the two list calls.
	sysAK, _ := readBucketCreds(dir, "dev", systemKeyName)
	calls2, restore2 := garageFakeExec(t,
		map[string]string{"bp-acme": "bid-existing"}, []string{bpAK, sysAK})
	defer restore2()
	changed = reconcileGarageBuckets(context.Background(), wctx, "dev",
		map[string]bool{"bp-acme": true}, func(string, string) {})
	all2 := joined(*calls2)
	if strings.Contains(all2, "CreateKey") || strings.Contains(all2, "CreateBucket") ||
		strings.Contains(all2, "AllowBucketKey") {
		t.Errorf("warm path issued provisioning calls:\n%s", all2)
	}
	if len(changed) != 0 {
		t.Errorf("warm path changed = %v, want none", changed)
	}
}

// TestCompileScopedRegisteredBP exercises the registered-BP path the golden
// fixtures don't cover: a registered backend must attach its scoped dbcreds /
// garagecreds env files and must NOT attach the shared postgres/garage service
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
	if !strings.Contains(ef, "/secrets/garagecreds/dev/bp-acme") {
		t.Errorf("backend %s missing scoped garagecreds env_file; got: %v", svcName, doc.Services[svcName].EnvFile)
	}
	if strings.Contains(ef, "/secrets/postgres-dev") || strings.Contains(ef, "/secrets/garage-dev") {
		t.Errorf("backend %s still attaches the shared superuser/root secret; got: %v", svcName, doc.Services[svcName].EnvFile)
	}
}
