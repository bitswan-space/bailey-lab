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
		// Flag is relative to the worktree root
		cwd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		// Find the worktree root
		for _, base := range []string{"/workspace/worktrees"} {
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
	reqBPFlag string
	reqText   string
	reqStatus    string
	reqAddStatus string
	reqID        string
	reqParent    string
)

func init() {
	requirementsCmd.PersistentFlags().StringVar(&reqBPFlag, "business-process", "", "Business process path (auto-detected from current directory if not set)")
	requirementsCmd.PersistentFlags().StringVar(&reqBPFlag, "bp", "", "Business process path (shorthand)")

	requirementsCmd.AddCommand(reqListCmd)
	requirementsCmd.AddCommand(reqAddCmd)
	requirementsCmd.AddCommand(reqUpdateCmd)
	requirementsCmd.AddCommand(reqRemoveCmd)
	requirementsCmd.AddCommand(reqNextCmd)
	requirementsCmd.AddCommand(reqOutputJSONCmd)

	reqAddCmd.Flags().StringVar(&reqText, "text", "", "Requirement description")
	reqAddCmd.Flags().StringVar(&reqParent, "parent", "", "Parent requirement ID (for creating sub-requirements)")
	reqAddCmd.Flags().StringVar(&reqAddStatus, "status", "pending", "Initial status (pending|proposed)")
	reqUpdateCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID")
	reqUpdateCmd.Flags().StringVar(&reqStatus, "status", "", "New status (pass|fail|pending|retest|proposed)")
	reqUpdateCmd.Flags().StringVar(&reqText, "text", "", "Updated description")
	reqRemoveCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID to remove")
}
