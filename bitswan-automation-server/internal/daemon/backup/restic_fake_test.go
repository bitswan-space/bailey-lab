package backup

import (
	"os"
	"path/filepath"
	"testing"
)

// fakeResticScript installs a restic fake whose behavior is the given shell
// script body ("$@" is the argv). Records every call's argv.
func fakeResticScript(t *testing.T, body string) (argvFile string) {
	t.Helper()
	binDir := t.TempDir()
	argvFile = filepath.Join(binDir, "argv")
	script := "#!/bin/sh\necho \"$@\" >> " + argvFile + "\n" + body
	if err := os.WriteFile(filepath.Join(binDir, "restic"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	return argvFile
}
