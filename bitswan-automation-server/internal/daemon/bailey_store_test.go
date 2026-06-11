package daemon

import (
	"fmt"
	"os"
	"testing"
)

// TestMain pins HOME — and with it the bailey SQLite database — to a
// throwaway directory before any test runs. openBaileyDB latches the
// first HOME it sees (sync.Once), so this must happen before any test
// touches the ACL; individual tests that t.Setenv("HOME", ...) for
// config purposes don't move the database afterwards.
func TestMain(m *testing.M) {
	home, err := os.MkdirTemp("", "bailey-daemon-test-home-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "TestMain: %v\n", err)
		os.Exit(1)
	}
	os.Setenv("HOME", home)
	os.Setenv("SUDO_USER", "")
	if _, err := openBaileyDB(); err != nil {
		fmt.Fprintf(os.Stderr, "TestMain: open bailey.db: %v\n", err)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(home)
	os.Exit(code)
}
