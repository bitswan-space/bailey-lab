package k8sdriver

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheKubernetesPackagesCarryNoComments(t *testing.T) {
	for _, pkg := range []string{".", "../../k8srender", "../../k8sctl"} {
		fset := token.NewFileSet()
		pkgs, err := parser.ParseDir(fset, pkg, nil, parser.ParseComments)
		if err != nil {
			t.Fatalf("parse %s: %v", pkg, err)
		}
		for _, p := range pkgs {
			for name, file := range p.Files {
				for _, group := range file.Comments {
					for _, c := range group.List {
						body := strings.TrimSpace(strings.TrimPrefix(
							strings.TrimSuffix(strings.TrimPrefix(c.Text, "/*"), "*/"), "//"))
						if isDirective(body) {
							continue
						}
						pos := fset.Position(c.Pos())
						t.Errorf("%s:%d: %s\n\tthis codebase puts its reasoning in names, "+
							"commit messages and pull requests, never in the source",
							relOrAbs(name), pos.Line, firstLine(body))
					}
				}
			}
		}
	}
}

func isDirective(text string) bool {
	for _, prefix := range []string{"go:", "nolint", "lint:", "+build", "line "} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return false
}

func firstLine(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	if len(line) > 70 {
		line = line[:70] + "…"
	}
	return line
}

func relOrAbs(path string) string {
	if wd, err := os.Getwd(); err == nil {
		if rel, err := filepath.Rel(wd, path); err == nil {
			return rel
		}
	}
	return path
}
