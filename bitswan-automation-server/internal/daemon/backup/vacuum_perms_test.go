package backup

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	_ "modernc.org/sqlite"
)

func TestSqliteVacuumIntoIsOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.db")

	db, err := sql.Open("sqlite", "file:"+src)
	if err != nil {
		t.Fatalf("open src: %v", err)
	}
	if _, err := db.Exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('secret')"); err != nil {
		t.Fatalf("seed src: %v", err)
	}
	_ = db.Close()

	dst := filepath.Join(dir, "out.snapshot")
	old := syscall.Umask(0o022)
	defer syscall.Umask(old)

	if err := sqliteVacuumInto(context.Background(), src, dst); err != nil {
		t.Fatalf("sqliteVacuumInto: %v", err)
	}
	info, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("stat dst: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Errorf("snapshot mode %#o, want 0600", got)
	}
}
