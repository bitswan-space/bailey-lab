package infradriver

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var readsEnv = regexp.MustCompile(`(?:os\.Getenv|envOr|envOrDefault|imageOr|storageSizeOr)\(\s*"(BITSWAN_[A-Z0-9_]+)"`)

func TestHookInheritsEverythingTheCompilersRead(t *testing.T) {
	inherited := map[string]bool{}
	for _, name := range hookInheritedEnv() {
		inherited[name] = true
	}

	for _, pkg := range []string{"dockerdriver", "k8sdriver", "core"} {
		dir := filepath.Join(".", pkg)
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read %s: %v", dir, err)
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			body, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Fatalf("read %s: %v", e.Name(), err)
			}
			for _, m := range readsEnv.FindAllStringSubmatch(string(body), -1) {
				if !inherited[m[1]] {
					t.Errorf("%s/%s reads %s, which the post-receive hook does not inherit: "+
						"add it to hookInheritedEnv or the apply behind a push will not see it",
						pkg, e.Name(), m[1])
				}
			}
		}
	}
}
