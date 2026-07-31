package daemon

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"sort"
	"strings"
	"testing"
)

// Every second-factor verification must sit behind the brute-force throttle
// (issue #188). Enumerating the handlers by hand rots: #225 originally guarded
// only the JSON gate API and left the five server-rendered paths open, which is
// exactly the kind of gap a per-handler test suite doesn't notice.
//
// So assert the INVARIANT instead of the instances — the same trick as PR #204's
// router-introspection test for the {bp} ValidBp guard. Any function that
// compares a TOTP code or consumes a backup code must also reserve an attempt
// via mfaThrottleBegin. A new 2FA path added without a throttle fails here,
// whatever it's called and wherever it's routed.
//
// If a genuinely unthrottled verification is ever justified, add it to
// throttleExempt with the reason — deliberately noisy, so the decision is
// visible in review rather than implicit in an omission.
var throttleExempt = map[string]string{
	// none today
}

// verificationCalls are the code-comparison primitives. Calling one of these IS
// a second-factor verification attempt.
var verificationCalls = map[string]bool{
	"totp.Validate":       true,
	"dbConsumeBackupCode": true,
}

// reserveCall is the throttle's atomic check-and-reserve. A read-only
// pre-check (mfaThrottleState / mfaGateThrottlePrecheck) is NOT sufficient:
// it leaves the concurrency hole this test exists to prevent, so only the
// reserving call counts.
const reserveCall = "mfaThrottleBegin"

func callName(n ast.Node) string {
	call, ok := n.(*ast.CallExpr)
	if !ok {
		return ""
	}
	switch fn := call.Fun.(type) {
	case *ast.Ident:
		return fn.Name
	case *ast.SelectorExpr:
		if pkg, ok := fn.X.(*ast.Ident); ok {
			return pkg.Name + "." + fn.Sel.Name
		}
		return fn.Sel.Name
	}
	return ""
}

func TestEvery2FAVerificationIsThrottled(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatalf("parse package: %v", err)
	}

	type offender struct{ fn, pos, verif string }
	var offenders []offender
	checked := 0

	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					continue
				}
				var verifications []string
				reserves := false
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					name := callName(n)
					if verificationCalls[name] {
						verifications = append(verifications, name)
					}
					if name == reserveCall {
						reserves = true
					}
					return true
				})
				if len(verifications) == 0 {
					continue
				}
				checked++
				if reason, exempt := throttleExempt[fn.Name.Name]; exempt {
					t.Logf("exempt: %s (%s)", fn.Name.Name, reason)
					continue
				}
				if !reserves {
					offenders = append(offenders, offender{
						fn:    fn.Name.Name,
						pos:   fset.Position(fn.Pos()).String(),
						verif: strings.Join(verifications, ", "),
					})
				}
			}
		}
	}

	// Guard against the test silently passing because the scan found nothing
	// (a rename of the primitives, or a parse that matched no files).
	if checked == 0 {
		t.Fatalf("found no 2FA verification call sites — the scan is broken, not the code "+
			"(looking for calls to %v)", sortedKeys(verificationCalls))
	}

	if len(offenders) > 0 {
		sort.Slice(offenders, func(i, j int) bool { return offenders[i].fn < offenders[j].fn })
		var b strings.Builder
		b.WriteString("second-factor verification without a brute-force throttle (issue #188):\n")
		for _, o := range offenders {
			b.WriteString("  - " + o.fn + " calls " + o.verif + "\n    at " + o.pos + "\n")
		}
		b.WriteString("\nCall " + reserveCall + " to reserve an attempt before comparing the code, " +
			"and mfaThrottleReset on success. A read-only pre-check is not enough.")
		t.Fatal(b.String())
	}

	t.Logf("%d 2FA verification site(s) checked, all throttled", checked)
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
