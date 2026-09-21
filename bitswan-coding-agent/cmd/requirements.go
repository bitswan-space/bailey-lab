package cmd

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// Requirement is one row of the BP's contract. Status is NOT part of the
// file: it is the verdict gitops produced by running the test, filled in from
// the server on read and never written back. A verdict that could be edited
// into a file is exactly what the CI model removes.
type Requirement struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Status      string `json:"status,omitempty"`
	Parent      string `json:"parent"`
	// Origin is "proposed" for a requirement the agent suggested and a human
	// has not accepted yet, empty otherwise. Unlike a verdict this IS contract
	// data — it says where the requirement came from, not whether it holds.
	Origin     string `json:"origin,omitempty"`
	Automation string `json:"automation,omitempty"`
	Runner     string `json:"runner,omitempty"`
	// Framework is "go" or "pytest". Needed per requirement (or per automation
	// in process.toml) when a BP mixes languages: the BP-wide framework would
	// otherwise be applied to every automation, and a pytest suite parsed as
	// `go test -json` output reports "no test" for tests that ran and passed.
	Framework string `json:"framework,omitempty"`
}

const requirementsFilename = "testable-requirements.toml"

var requirementsCmd = &cobra.Command{
	Use:   "requirements",
	Short: "Manage testable requirements for a business process",
}

// resolveRequirementsDir finds the business process directory containing
// process.toml, either from the flag or by walking up from cwd.
func resolveRequirementsDir(flag string) (string, error) {
	if flag != "" {
		// Flag is relative to the copy root
		cwd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		// Find the copy root
		for _, base := range []string{"/workspace/copies"} {
			if strings.HasPrefix(cwd, base+"/") {
				rest := cwd[len(base)+1:]
				parts := strings.SplitN(rest, "/", 2)
				wtRoot := filepath.Join(base, parts[0])
				dir := filepath.Join(wtRoot, flag)
				if _, err := os.Stat(filepath.Join(dir, "process.toml")); err == nil {
					return dir, nil
				}
			}
		}
		// Try as absolute or relative
		if _, err := os.Stat(filepath.Join(flag, "process.toml")); err == nil {
			return flag, nil
		}
		return "", fmt.Errorf("business process '%s' not found (no process.toml)", flag)
	}

	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get working directory: %w", err)
	}

	dir := cwd
	for {
		if _, err := os.Stat(filepath.Join(dir, "process.toml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir || parent == "/" {
			break
		}
		dir = parent
	}

	return "", fmt.Errorf("no business process found (no process.toml in current directory or parents)")
}

// --- Local file I/O ---

func readRequirements(dir string) ([]Requirement, error) {
	filePath := filepath.Join(dir, requirementsFilename)
	data, err := os.ReadFile(filePath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return parseRequirementsToml(string(data)), nil
}

func writeRequirements(dir string, reqs []Requirement) error {
	filePath := filepath.Join(dir, requirementsFilename)
	return os.WriteFile(filePath, []byte(serializeRequirementsToml(reqs)), 0644)
}

// parseRequirementsToml parses the [[requirement]] array-of-tables format.
// Handles both single-line (key = "value") and multi-line (key = """value""") strings.
func parseRequirementsToml(content string) []Requirement {
	var reqs []Requirement
	// Split on [[requirement]] headers
	blocks := regexp.MustCompile(`(?m)^\[\[requirement\]\]\s*$`).Split(content, -1)
	for _, block := range blocks {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		r := Requirement{}
		r.ID = extractTomlString(block, "id")
		r.Description = extractTomlString(block, "description")
		r.Parent = extractTomlString(block, "parent")
		r.Origin = extractTomlString(block, "origin")
		r.Automation = extractTomlString(block, "automation")
		r.Runner = extractTomlString(block, "runner")
		r.Framework = extractTomlString(block, "framework")
		// A `status` key left over from before verdicts moved out of the file
		// is read past and dropped on the next write. Nothing migrates it.
		if r.ID != "" {
			reqs = append(reqs, r)
		}
	}
	return reqs
}

// extractTomlString extracts a string value for a key, handling all TOML string types:
// double-quoted ("..."), single-quoted ('...'), multi-line double ("""..."""),
// and multi-line single (”'...”').
func extractTomlString(block, key string) string {
	escaped := regexp.QuoteMeta(key)

	// Try multi-line double-quoted: key = """..."""
	mlDblPattern := regexp.MustCompile(`(?ms)^` + escaped + `\s*=\s*"""(.*?)"""`)
	if m := mlDblPattern.FindStringSubmatch(block); m != nil {
		return m[1]
	}
	// Try multi-line single-quoted (literal): key = '''...'''
	mlSglPattern := regexp.MustCompile(`(?ms)^` + escaped + `\s*=\s*'''(.*?)'''`)
	if m := mlSglPattern.FindStringSubmatch(block); m != nil {
		return m[1]
	}
	// Try single-line double-quoted: key = "..."
	slDblPattern := regexp.MustCompile(`(?m)^` + escaped + `\s*=\s*"((?:[^"\\]|\\.)*)"`)
	if m := slDblPattern.FindStringSubmatch(block); m != nil {
		s := m[1]
		s = strings.ReplaceAll(s, `\"`, `"`)
		s = strings.ReplaceAll(s, `\\`, `\`)
		return s
	}
	// Try single-line single-quoted (literal): key = '...'
	// TOML literal strings have no escape sequences — content is verbatim
	slSglPattern := regexp.MustCompile(`(?m)^` + escaped + `\s*=\s*'([^']*)'`)
	if m := slSglPattern.FindStringSubmatch(block); m != nil {
		return m[1]
	}
	return ""
}

func serializeRequirementsToml(reqs []Requirement) string {
	var blocks []string
	for _, r := range reqs {
		var b strings.Builder
		b.WriteString("[[requirement]]\n")
		b.WriteString(fmt.Sprintf("id = %s\n", tomlQuote(r.ID)))
		b.WriteString(fmt.Sprintf("parent = %s\n", tomlQuote(r.Parent)))
		b.WriteString(fmt.Sprintf("description = %s\n", tomlQuote(r.Description)))
		if r.Origin != "" {
			b.WriteString(fmt.Sprintf("origin = %s\n", tomlQuote(r.Origin)))
		}
		if r.Automation != "" {
			b.WriteString(fmt.Sprintf("automation = %s\n", tomlQuote(r.Automation)))
		}
		if r.Runner != "" {
			b.WriteString(fmt.Sprintf("runner = %s\n", tomlQuote(r.Runner)))
		}
		if r.Framework != "" {
			b.WriteString(fmt.Sprintf("framework = %s\n", tomlQuote(r.Framework)))
		}
		blocks = append(blocks, b.String())
	}
	return strings.Join(blocks, "\n")
}

func tomlQuote(s string) string {
	if strings.ContainsAny(s, "\n\r") {
		return `"""` + s + `"""`
	}
	return strconv.Quote(s)
}

// idAlphabet is Crockford base32 without the letters it excludes (I, L, O, U):
// no pair a human can confuse when reading an id out of a test name.
const idAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// nextReqID mints an id no other copy can mint at the same time.
//
// This used to be max(numeric suffix)+1, which is deterministic and therefore
// collides by construction: two copies of the same BP both mint REQ-004, and
// merging them silently fuses two different requirements. Randomness makes the
// ids independent of each other's history.
func nextReqID(reqs []Requirement, prefix string) string {
	taken := map[string]bool{}
	for _, r := range reqs {
		taken[r.ID] = true
	}
	for attempt := 0; attempt < 100; attempt++ {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			break
		}
		suffix := make([]byte, 4)
		for i, v := range b {
			suffix[i] = idAlphabet[int(v)%len(idAlphabet)]
		}
		candidate := prefix + string(suffix)
		if !taken[candidate] {
			return candidate
		}
	}
	// 32^4 is ~1M: exhausting 100 draws means something is badly wrong.
	// Fall back to a time-based suffix rather than returning a duplicate.
	return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano()%1000000)
}

func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// --- Tree helpers ---

type treeNode struct {
	req      Requirement
	children []*treeNode
}

func buildTree(reqs []Requirement) []*treeNode {
	byID := make(map[string]*treeNode)
	for i := range reqs {
		byID[reqs[i].ID] = &treeNode{req: reqs[i]}
	}
	var roots []*treeNode
	for i := range reqs {
		node := byID[reqs[i].ID]
		if reqs[i].Parent != "" {
			if parent, ok := byID[reqs[i].Parent]; ok {
				parent.children = append(parent.children, node)
				continue
			}
		}
		roots = append(roots, node)
	}
	return roots
}

func printTree(nodes []*treeNode, indent string) {
	for _, n := range nodes {
		status := strings.ToUpper(n.req.Status)
		fmt.Printf("%s%s [%s] %s\n", indent, n.req.ID, status, n.req.Description)
		if len(n.children) > 0 {
			printTree(n.children, indent+"  ")
		}
	}
}

// dfsNextNonPassing returns the deepest non-passing requirement (children before
// parents) along with the full path from root. This ensures leaf requirements
// are fulfilled before their parents.
func dfsNextNonPassing(reqs []Requirement) (*Requirement, []Requirement) {
	byID := make(map[string]*Requirement)
	children := map[string][]string{"": {}}
	for i := range reqs {
		r := &reqs[i]
		byID[r.ID] = r
		children[r.Parent] = append(children[r.Parent], r.ID)
	}

	// Returns (deepest non-passing requirement, path from root to it)
	var dfs func(string, []Requirement) (*Requirement, []Requirement)
	dfs = func(parentID string, path []Requirement) (*Requirement, []Requirement) {
		for _, id := range children[parentID] {
			r := byID[id]
			currentPath := append(append([]Requirement{}, path...), *r)

			// Always recurse into children first (deepest leaf wins)
			if kids, ok := children[id]; ok && len(kids) > 0 {
				if found, foundPath := dfs(id, currentPath); found != nil {
					return found, foundPath
				}
			}

			// No non-passing children — check this node itself
			if r.Status != "pass" {
				return r, currentPath
			}
		}
		return nil, nil
	}

	return dfs("", nil)
}

// --- Commands ---

var reqListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all requirements as a tree",
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, err := resolveRequirementsDir(reqBPFlag)
		if err != nil {
			return err
		}
		reqs, state, err := readRequirementsWithVerdicts(dir)
		if err != nil {
			return err
		}
		if len(reqs) == 0 {
			fmt.Println("No requirements found.")
			return nil
		}
		printTree(buildTree(reqs), "")
		if state != nil {
			fmt.Printf("\n%s (%s)\n", state.HeadSubject, shortSHA(state.HeadSHA))
			if state.Stale {
				fmt.Println("The code changed after this run — these verdicts are out of date.")
			}
		}
		return nil
	},
}

var reqAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Add a new requirement",
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, err := resolveRequirementsDir(reqBPFlag)
		if err != nil {
			return err
		}
		if reqText == "" {
			return fmt.Errorf("--text is required")
		}
		reqs, err := readRequirements(dir)
		if err != nil {
			return err
		}
		// The AI- prefix makes a proposal recognisable at a glance; `origin` is
		// what the tooling actually reads, so accepting one never has to
		// renumber an id that tests already refer to.
		prefix := "REQ-"
		origin := ""
		if reqPropose {
			prefix = "AI-"
			origin = "proposed"
		}
		newReq := Requirement{
			ID:          nextReqID(reqs, prefix),
			Description: reqText,
			Parent:      reqParent,
			Origin:      origin,
		}
		reqs = append(reqs, newReq)
		if err := writeRequirements(dir, reqs); err != nil {
			return err
		}
		if newReq.Parent != "" {
			fmt.Printf("Added %s (child of %s): %s\n", newReq.ID, newReq.Parent, newReq.Description)
		} else {
			fmt.Printf("Added %s: %s\n", newReq.ID, newReq.Description)
		}
		return nil
	},
}

var reqUpdateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update a requirement's description",
	Long: `Change what a requirement says.

There is no --status: a verdict is produced by running the test and nothing
else can set one. Use ` + "`requirements test`" + ` to run them.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, err := resolveRequirementsDir(reqBPFlag)
		if err != nil {
			return err
		}
		if reqID == "" {
			return fmt.Errorf("--id is required")
		}
		if reqText == "" {
			return fmt.Errorf("--text is required")
		}
		reqs, err := readRequirements(dir)
		if err != nil {
			return err
		}
		for i := range reqs {
			if reqs[i].ID == reqID {
				reqs[i].Description = reqText
				if err := writeRequirements(dir, reqs); err != nil {
					return err
				}
				fmt.Printf("Updated %s: %s\n", reqs[i].ID, reqs[i].Description)
				return nil
			}
		}
		return fmt.Errorf("requirement %s not found", reqID)
	},
}

var reqRemoveCmd = &cobra.Command{
	Use:   "remove",
	Short: "Remove a requirement",
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, err := resolveRequirementsDir(reqBPFlag)
		if err != nil {
			return err
		}
		if reqID == "" {
			return fmt.Errorf("--id is required")
		}
		reqs, err := readRequirements(dir)
		if err != nil {
			return err
		}
		var filtered []Requirement
		for _, r := range reqs {
			if r.ID != reqID {
				filtered = append(filtered, r)
			}
		}
		if err := writeRequirements(dir, filtered); err != nil {
			return err
		}
		fmt.Printf("Removed %s\n", reqID)
		return nil
	},
}

var reqNextCmd = &cobra.Command{
	Use:   "next",
	Short: "Get the next non-passing requirement",
	Long: `Returns the deepest requirement in tree order that is not passing.

"Not passing" includes a requirement whose test has not been written yet, so
this walks you through the contract from the leaves up.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, err := resolveRequirementsDir(reqBPFlag)
		if err != nil {
			return err
		}
		reqs, _, err := readRequirementsWithVerdicts(dir)
		if err != nil {
			return err
		}
		r, path := dfsNextNonPassing(reqs)
		if r == nil {
			fmt.Println("All requirements passing!")
			return nil
		}

		// Show the path from root to the target requirement
		if len(path) > 1 {
			fmt.Println("Path:")
			for i, ancestor := range path[:len(path)-1] {
				indent := strings.Repeat("  ", i)
				fmt.Printf("%s%s: %s\n", indent, ancestor.ID, ancestor.Description)
			}
			fmt.Println()
		}

		fmt.Printf("Next: %s [%s]\n", r.ID, strings.ToUpper(r.Status))
		fmt.Printf("  %s\n", r.Description)
		return nil
	},
}

// --- Test state: gitops owns running tests and their verdicts ---
//
// The CLI used to exec the tests itself and write the verdict back into the
// contract file. It does neither now. gitops runs them — it holds the docker
// socket, the live-dev deployment map and the copies checkout, so it is the
// only place that can wake an instance, exec in it and read the contract in
// one operation — and keeps the verdicts in memory for the current commit.
// The CLI is a client of that, so the agent and the dashboard can never
// disagree about a result.

type reqTestResult struct {
	ID              string `json:"id"`
	Description     string `json:"description"`
	Verdict         string `json:"verdict"`
	Output          string `json:"output"`
	DeploymentID    string `json:"deployment_id"`
	Automation      string `json:"automation"`
	PreviousVerdict string `json:"previous_verdict"`
}

type reqTestState struct {
	RunID        string          `json:"run_id"`
	Status       string          `json:"status"`
	HeadSHA      string          `json:"head_sha"`
	HeadSubject  string          `json:"head_subject"`
	Stale        bool            `json:"stale"`
	Green        bool            `json:"green"`
	Error        string          `json:"error"`
	Counts       map[string]int  `json:"counts"`
	Requirements []reqTestResult `json:"requirements"`
}

// bpAndCopy resolves the (business process, copy) pair the requirement
// commands address.
func bpAndCopy(dir string) (string, string, error) {
	bp := filepath.Base(dir)
	copyName, err := detectCopyOrFlag(copyFlag)
	if err != nil {
		return "", "", fmt.Errorf("cannot determine which copy this business process is in: %w", err)
	}
	return bp, copyName, nil
}

func testStatePath(action, bp, copyName string) string {
	return fmt.Sprintf("/processes/%s/tests%s?copy=%s",
		url.PathEscape(bp), action, url.QueryEscape(copyName))
}

func fetchTestState(bp, copyName string) (*reqTestState, error) {
	var state *reqTestState
	if err := agentRequestJSON("GET", testStatePath("", bp, copyName), nil, &state); err != nil {
		return nil, err
	}
	return state, nil
}

func triggerTestRun(bp, copyName string, ids []string, failedOnly bool) (*reqTestState, error) {
	var state *reqTestState
	body := map[string]interface{}{"failed_only": failedOnly}
	if len(ids) > 0 {
		body["ids"] = ids
	}
	path := testStatePath("/run", bp, copyName)
	if err := agentRequestJSON("POST", path, body, &state); err != nil {
		return nil, err
	}
	return state, nil
}

// applyVerdicts fills each requirement's Status in from the server's state.
// A requirement the server has no verdict for reads as "unknown" — nobody has
// judged it, which is a different thing from a test waiting to run.
func applyVerdicts(reqs []Requirement, state *reqTestState) []Requirement {
	byID := map[string]string{}
	if state != nil {
		for _, r := range state.Requirements {
			byID[r.ID] = r.Verdict
		}
	}
	for i := range reqs {
		if v, ok := byID[reqs[i].ID]; ok && v != "" {
			reqs[i].Status = v
		} else {
			reqs[i].Status = "unknown"
		}
	}
	return reqs
}

// readRequirementsWithVerdicts is what the read-only commands use: the
// contract from the file, the verdicts from gitops. A server that cannot be
// reached is not fatal — the contract is still worth printing.
func readRequirementsWithVerdicts(dir string) ([]Requirement, *reqTestState, error) {
	reqs, err := readRequirements(dir)
	if err != nil {
		return nil, nil, err
	}
	bp, copyName, err := bpAndCopy(dir)
	if err != nil {
		return applyVerdicts(reqs, nil), nil, nil
	}
	state, err := fetchTestState(bp, copyName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not read test state from gitops: %v\n", err)
		return applyVerdicts(reqs, nil), nil, nil
	}
	return applyVerdicts(reqs, state), state, nil
}

func printTestState(state *reqTestState) {
	if state == nil {
		fmt.Println("No test state yet.")
		return
	}
	for _, r := range state.Requirements {
		label := strings.ToUpper(r.Verdict)
		where := ""
		if r.Automation != "" {
			where = " (" + r.Automation + ")"
		}
		fmt.Printf("%-8s %s%s %s\n", label, r.ID, where, r.Description)
		if r.Output != "" {
			for _, line := range strings.Split(strings.TrimRight(r.Output, "\n"), "\n") {
				fmt.Printf("         %s\n", line)
			}
		}
	}
	c := state.Counts
	fmt.Printf("\n%d passed, %d failed, %d blocked, %d without a test\n",
		c["pass"], c["fail"], c["blocked"], c["no_test"])
	if state.Stale {
		fmt.Println("NOTE: the code changed after this run — the results are out of date.")
	}
}

var reqTestCmd = &cobra.Command{
	Use:   "test",
	Short: "Run the requirement tests and wait for the verdicts",
	Long: `Ask gitops to run this business process's requirement tests, then wait for
the verdicts and print them.

You usually do not need this. Tests run automatically on every commit — commit
your work and the run starts by itself. Use this to force a re-run without
making a commit (a flaky test, or a container that was down).

HOW A TEST IS FOUND
  A requirement's test is the test whose NAME carries the requirement's id with
  hyphens turned into underscores, so REQ-7QX4 is tested by, say,
  ` + "`def test_REQ_7QX4_totals()`" + ` or ` + "`func TestREQ_7QX4_Totals(t *testing.T)`" + `.
  The verdict comes from the test report, never from an exit code: a runner
  that matched no test reports "no test", not a pass.

WHERE IT RUNS
  Inside the business process's live-dev container. A business process with
  more than one automation must say which one, in its process.toml:

    [testing]
    automation = "backend"      # required when there is more than one
    framework  = "go"           # or "pytest"

  A single requirement can override either with its own ` + "`automation`" + ` /
  ` + "`runner`" + ` key in testable-requirements.toml.

EXIT CODE
  Non-zero when any requirement failed or was blocked, so this can gate a
  script.

EXAMPLES
  bitswan-coding-agent requirements test
  bitswan-coding-agent requirements test --id REQ-7QX4
  bitswan-coding-agent requirements test --failed`,
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, err := resolveRequirementsDir(reqBPFlag)
		if err != nil {
			return err
		}
		bp, copyName, err := bpAndCopy(dir)
		if err != nil {
			return err
		}

		var ids []string
		if reqID != "" {
			ids = append(ids, reqID)
		}
		if _, err := triggerTestRun(bp, copyName, ids, reqTestFailedOnly); err != nil {
			return err
		}

		deadline := time.Now().Add(time.Duration(reqTestWaitSeconds) * time.Second)
		var state *reqTestState
		for {
			time.Sleep(2 * time.Second)
			state, err = fetchTestState(bp, copyName)
			if err != nil {
				return err
			}
			if state == nil || state.Status != "running" {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("tests still running after %ds; check `requirements list`",
					reqTestWaitSeconds)
			}
		}

		printTestState(state)
		if state != nil && state.Error != "" {
			return fmt.Errorf("test run failed: %s", state.Error)
		}
		if state != nil {
			if n := state.Counts["fail"] + state.Counts["blocked"]; n > 0 {
				return fmt.Errorf("%d requirement(s) not passing", n)
			}
		}
		return nil
	},
}

var reqOutputJSONCmd = &cobra.Command{
	Use:   "json",
	Short: "Output requirements as JSON",
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, err := resolveRequirementsDir(reqBPFlag)
		if err != nil {
			return err
		}
		reqs, _, err := readRequirementsWithVerdicts(dir)
		if err != nil {
			return err
		}
		data, err := json.MarshalIndent(reqs, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	},
}

var (
	reqBPFlag  string
	reqText    string
	reqID      string
	reqParent  string
	reqPropose bool

	reqTestFailedOnly  bool
	reqTestWaitSeconds int
)

func init() {
	requirementsCmd.PersistentFlags().StringVar(&reqBPFlag, "business-process", "", "Business process path (auto-detected from current directory if not set)")
	requirementsCmd.PersistentFlags().StringVar(&reqBPFlag, "bp", "", "Business process path (shorthand)")
	// Every requirement command now reads verdicts from gitops, so all of them
	// need to know which copy they are in — not just `test`.
	requirementsCmd.PersistentFlags().StringVar(&copyFlag, "copy", "", "Copy name (auto-detected from $PWD if omitted)")

	requirementsCmd.AddCommand(reqListCmd)
	requirementsCmd.AddCommand(reqAddCmd)
	requirementsCmd.AddCommand(reqUpdateCmd)
	requirementsCmd.AddCommand(reqRemoveCmd)
	requirementsCmd.AddCommand(reqNextCmd)
	requirementsCmd.AddCommand(reqTestCmd)
	requirementsCmd.AddCommand(reqOutputJSONCmd)

	reqAddCmd.Flags().StringVar(&reqText, "text", "", "Requirement description")
	reqAddCmd.Flags().StringVar(&reqParent, "parent", "", "Parent requirement ID (for creating sub-requirements)")
	reqAddCmd.Flags().BoolVar(&reqPropose, "proposed", false, "Propose this requirement for the user to accept, instead of adding it outright")
	reqUpdateCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID")
	reqUpdateCmd.Flags().StringVar(&reqText, "text", "", "Updated description")
	reqRemoveCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID to remove")

	reqTestCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID to test (default: all of them)")
	reqTestCmd.Flags().BoolVar(&reqTestFailedOnly, "failed", false, "Re-run only what failed last time")
	reqTestCmd.Flags().IntVar(&reqTestWaitSeconds, "wait", 900, "Seconds to wait for the run to finish")
}
