package dockerdriver

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestServiceContainerName(t *testing.T) {
	cases := []struct{ ws, svc, realm, want string }{
		{"acme", "postgres", "production", "acme__postgres"},
		{"acme", "postgres", "dev", "acme__postgres-dev"},
		{"acme", "minio", "staging", "acme__minio-staging"},
	}
	for _, c := range cases {
		if got := serviceContainerName(c.ws, c.svc, c.realm); got != c.want {
			t.Errorf("serviceContainerName(%q,%q,%q) = %q, want %q", c.ws, c.svc, c.realm, got, c.want)
		}
	}
}

func TestServiceSecrets(t *testing.T) {
	dir := t.TempDir()
	// production → no suffix; comments and blank lines ignored.
	if err := os.WriteFile(filepath.Join(dir, "postgres"), []byte("# header\nPOSTGRES_USER=admin\n\nPOSTGRES_DB=main\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "minio-dev"), []byte("MINIO_ROOT_USER=root\nMINIO_ROOT_PASSWORD=sekret\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	pg := serviceSecrets(dir, "postgres", "production")
	if pg["POSTGRES_USER"] != "admin" || pg["POSTGRES_DB"] != "main" {
		t.Fatalf("postgres secrets = %v", pg)
	}
	mn := serviceSecrets(dir, "minio", "dev")
	if mn["MINIO_ROOT_USER"] != "root" || mn["MINIO_ROOT_PASSWORD"] != "sekret" {
		t.Fatalf("minio-dev secrets = %v", mn)
	}
	// Missing file → nil (service not enabled).
	if serviceSecrets(dir, "couchdb", "production") != nil {
		t.Fatal("expected nil for missing secrets file")
	}
}

func TestProductionDBNumbers(t *testing.T) {
	one, two, three := 1, 2, 3
	// Default (no backups record) → [1,2].
	bs := &Bitswan{}
	if got := productionDBNumbers(bs, "x"); !reflect.DeepEqual(got, []int{1, 2}) {
		t.Errorf("default = %v, want [1 2]", got)
	}
	// Explicit slots → sorted unique db numbers.
	bs = &Bitswan{Backups: map[string]*BackupRec{
		"x": {Slots: map[string]*SlotRec{"blue": {DB: &three}, "green": {DB: &one}, "purple": {DB: &two}}},
	}}
	if got := productionDBNumbers(bs, "x"); !reflect.DeepEqual(got, []int{1, 2, 3}) {
		t.Errorf("explicit slots = %v, want [1 2 3]", got)
	}
}
