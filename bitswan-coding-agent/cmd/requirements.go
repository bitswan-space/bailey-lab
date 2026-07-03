package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

type Requirement struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Status      string `json:"status"`
	Parent      string `json:"parent"`
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
		r := Requirement{Status: "pending"}
		r.ID = extractTomlString(block, "id")
		r.Description = extractTomlString(block, "description")
		r.Status = extractTomlString(block, "status")
		r.Parent = extractTomlString(block, "parent")
		if r.Status == "" {
			r.Status = "pending"
		}
		if r.ID != "" {
			reqs = append(reqs, r)
		}
	}
	return reqs
}

// extractTomlString extracts a string value for a key, handling all TOML string types:
// double-quoted ("..."), single-quoted ('...'), multi-line double ("""..."""),
// and multi-line single ('''...''').
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
		b.WriteString(fmt.Sprintf("status = %s\n", tomlQuote(r.Status)))
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

func nextReqID(reqs []Requirement, prefix string) string {
	maxNum := 0
	re := regexp.MustCompile(`\d+$`)
	for _, r := range reqs {
		if m := re.FindString(r.ID); m != "" {
			n := 0
			fmt.Sscanf(m, "%d", &n)
			if n > maxNum {
				maxNum = n
			}
		}
	}
	return fmt.Sprintf("%s%03d", prefix, maxNum+1)
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
		reqs, err := readRequirements(dir)
		if err != nil {
			return err
		}
		if len(reqs) == 0 {
			fmt.Println("No requirements found.")
			return nil
		}
		printTree(buildTree(reqs), "")
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
		status := reqAddStatus
		if status == "" {
			status = "pending"
		}
		prefix := "REQ-"
		if status == "proposed" {
			prefix = "AI-"
		}
		newReq := Requirement{
			ID:          nextReqID(reqs, prefix),
			Description: reqText,
			Status:      status,
			Parent:      reqParent,
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
	Short: "Update a requirement's status or description",
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
		found := false
		for i := range reqs {
			if reqs[i].ID == reqID {
				if reqStatus != "" {
					if reqStatus != "pass" && reqStatus != "fail" && reqStatus != "pending" && reqStatus != "retest" && reqStatus != "proposed" {
						return fmt.Errorf("--status must be one of: pass, fail, pending, retest, proposed")
					}
					reqs[i].Status = reqStatus
				}
				if reqText != "" {
					reqs[i].Description = reqText
				}
				found = true
				if err := writeRequirements(dir, reqs); err != nil {
					return err
				}
				fmt.Printf("Updated %s (status: %s)\n", reqs[i].ID, reqs[i].Status)
				break
			}
		}
		if !found {
			return fmt.Errorf("requirement %s not found", reqID)
		}
		return nil
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
	Long:  "Returns the first requirement in tree order that doesn't have status 'pass'.",
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, err := resolveRequirementsDir(reqBPFlag)
		if err != nil {
			return err
		}
		reqs, err := readRequirements(dir)
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

// execResult mirrors the JSON returned by gitops POST /agent/deployments/{id}/exec.
type execResult struct {
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"`
}

// liveDevSuffix is the deployment-ID suffix that identifies a BP's per-copy
// live-dev container: {automation}-copy-{copy}-{bp}-live-dev.
func liveDevSuffix(copy, bp string) string {
	return fmt.Sprintf("-copy-%s-%s-live-dev", copy, bp)
}

// resolveLiveDevDeployment finds the live-dev deployment to exec the tests in.
// An explicit --deployment wins (this is what the dashboard "Run" button passes).
// Otherwise it lists the copy's deployments and picks the single one belonging to
// this BP; if that is ambiguous (0 or >1, e.g. a BP with several automations) it
// errors and prints the candidates so the caller can pass --deployment.
func resolveLiveDevDeployment(deploymentFlag, bpDir string) (string, error) {
	if deploymentFlag != "" {
		return deploymentFlag, nil
	}
	copy, err := detectCopyOrFlag(copyFlag)
	if err != nil {
		return "", fmt.Errorf("cannot detect copy (pass --deployment): %w", err)
	}
	var deployments []deployment
	if err := agentRequestJSON("GET", fmt.Sprintf("/deployments?copy=%s", copy), nil, &deployments); err != nil {
		return "", err
	}
	bp := filepath.Base(bpDir)
	var matches []string
	for _, d := range deployments {
		if strings.HasSuffix(d.DeploymentID, liveDevSuffix(copy, bp)) {
			matches = append(matches, d.DeploymentID)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	var all []string
	for _, d := range deployments {
		all = append(all, d.DeploymentID)
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("could not auto-detect a live-dev deployment for BP %q in copy %q; pass --deployment <id>. Available: %s",
			bp, copy, strings.Join(all, ", "))
	}
	return "", fmt.Errorf("multiple live-dev deployments match BP %q; pass --deployment <id>. Candidates: %s",
		bp, strings.Join(matches, ", "))
}

// testCommand renders the runner template for a requirement into the shell
// command to exec. The requirement ID's hyphens become underscores
// (REQ-003 -> REQ_003) so the ID can appear in a test function/identifier name,
// and {id} in the template is replaced with that token; a template without {id}
// runs unchanged (e.g. a whole-suite runner).
func testCommand(runner, reqID string) []string {
	token := strings.ReplaceAll(reqID, "-", "_")
	return []string{"sh", "-c", strings.ReplaceAll(runner, "{id}", token)}
}

// execInDeployment runs command in the given live-dev container and returns its
// exit code + combined output.
func execInDeployment(deploymentID string, command []string) (*execResult, error) {
	var res execResult
	body := map[string]interface{}{"command": command}
	if err := agentRequestJSON("POST", fmt.Sprintf("/deployments/%s/exec", deploymentID), body, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

var reqTestCmd = &cobra.Command{
	Use:   "test",
	Short: "Run requirements' tests in the live-dev container and record pass/fail",
	Long: `Run the deterministic test for each requirement inside the BP's live-dev
container and write the verdict (pass/fail) back to testable-requirements.toml.

This is the mechanical counterpart to the "Write tests" agent flow: the agent
authors tests whose name carries the requirement ID (hyphens become underscores,
so REQ-003 -> REQ_003); this command runs them by that key and records the result.
No model is involved — the exit code of the test runner is the verdict.

CONVENTION
  A requirement's test is any test selected by the runner filter for its ID
  token. The default runner is pytest: ` + "`pytest -k <ID_TOKEN> -v`" + `. Override
  per-BP with --runner using a {id} placeholder, e.g.
    --runner "go test -run {id} ./..."

EXAMPLES
  bitswan-coding-agent requirements test                 # run every requirement
  bitswan-coding-agent requirements test --id REQ-003    # run one requirement
  bitswan-coding-agent requirements test --deployment backend-copy-dev1-shop-live-dev`,
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, err := resolveRequirementsDir(reqBPFlag)
		if err != nil {
			return err
		}
		reqs, err := readRequirements(dir)
		if err != nil {
			return err
		}
		if len(reqs) == 0 {
			fmt.Println("No requirements found.")
			return nil
		}

		// Select targets: one requirement (--id) or every non-proposed one.
		var targets []*Requirement
		if reqID != "" {
			for i := range reqs {
				if reqs[i].ID == reqID {
					targets = append(targets, &reqs[i])
				}
			}
			if len(targets) == 0 {
				return fmt.Errorf("requirement %s not found", reqID)
			}
		} else {
			for i := range reqs {
				if reqs[i].Status == "proposed" {
					continue // not accepted by a human yet
				}
				targets = append(targets, &reqs[i])
			}
			if len(targets) == 0 {
				fmt.Println("No testable requirements (all proposed).")
				return nil
			}
		}

		deploymentID, err := resolveLiveDevDeployment(reqTestDeployment, dir)
		if err != nil {
			return err
		}

		runner := reqTestRunner
		if runner == "" {
			runner = "pytest -k {id} -v"
		}

		passed, failed := 0, 0
		for _, r := range targets {
			res, err := execInDeployment(deploymentID, testCommand(runner, r.ID))
			if err != nil {
				return fmt.Errorf("exec test for %s: %w", r.ID, err)
			}
			if res.ExitCode == 0 {
				r.Status = "pass"
				passed++
				fmt.Printf("PASS %s\n", r.ID)
			} else {
				r.Status = "fail"
				failed++
				fmt.Printf("FAIL %s (exit %d)\n", r.ID, res.ExitCode)
				for _, line := range strings.Split(strings.TrimRight(res.Output, "\n"), "\n") {
					fmt.Printf("     %s\n", line)
				}
			}
		}

		if err := writeRequirements(dir, reqs); err != nil {
			return err
		}
		fmt.Printf("\n%d passed, %d failed (in %s)\n", passed, failed, deploymentID)
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
		reqs, err := readRequirements(dir)
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
	reqBPFlag    string
	reqText      string
	reqStatus    string
	reqAddStatus string
	reqID        string
	reqParent    string

	reqTestDeployment string
	reqTestRunner     string
)

func init() {
	requirementsCmd.PersistentFlags().StringVar(&reqBPFlag, "business-process", "", "Business process path (auto-detected from current directory if not set)")
	requirementsCmd.PersistentFlags().StringVar(&reqBPFlag, "bp", "", "Business process path (shorthand)")

	requirementsCmd.AddCommand(reqListCmd)
	requirementsCmd.AddCommand(reqAddCmd)
	requirementsCmd.AddCommand(reqUpdateCmd)
	requirementsCmd.AddCommand(reqRemoveCmd)
	requirementsCmd.AddCommand(reqNextCmd)
	requirementsCmd.AddCommand(reqTestCmd)
	requirementsCmd.AddCommand(reqOutputJSONCmd)

	reqAddCmd.Flags().StringVar(&reqText, "text", "", "Requirement description")
	reqAddCmd.Flags().StringVar(&reqParent, "parent", "", "Parent requirement ID (for creating sub-requirements)")
	reqAddCmd.Flags().StringVar(&reqAddStatus, "status", "pending", "Initial status (pending|proposed)")
	reqUpdateCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID")
	reqUpdateCmd.Flags().StringVar(&reqStatus, "status", "", "New status (pass|fail|pending|retest|proposed)")
	reqUpdateCmd.Flags().StringVar(&reqText, "text", "", "Updated description")
	reqRemoveCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID to remove")

	reqTestCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID to test (default: all non-proposed)")
	reqTestCmd.Flags().StringVar(&reqTestDeployment, "deployment", "", "Live-dev deployment ID to exec in (default: auto-detect from copy + BP)")
	reqTestCmd.Flags().StringVar(&reqTestRunner, "runner", "", "Test runner template; {id} is replaced with the requirement's ID token (default: \"pytest -k {id} -v\")")
	reqTestCmd.Flags().StringVar(&copyFlag, "copy", "", "Copy name (auto-detected from $PWD if omitted)")
}
