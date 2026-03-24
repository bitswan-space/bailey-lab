package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

type Requirement struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Status      string `json:"status"`
	Parent      string `json:"parent"`
}

var requirementsCmd = &cobra.Command{
	Use:   "requirements",
	Short: "Manage testable requirements for a business process",
}

// detectBusinessProcess finds the business process by looking for process.toml
// in the current directory or parent directories within the worktree.
func detectBusinessProcess(flag string) (string, error) {
	if flag != "" {
		return flag, nil
	}

	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get working directory: %w", err)
	}

	dir := cwd
	for {
		if _, err := os.Stat(filepath.Join(dir, "process.toml")); err == nil {
			for _, base := range []string{"/workspace/workspace", "/workspace/worktrees"} {
				if strings.HasPrefix(dir, base) {
					rel, err := filepath.Rel(base, dir)
					if err == nil {
						if base == "/workspace/worktrees" {
							parts := strings.SplitN(rel, "/", 2)
							if len(parts) == 2 {
								return parts[1], nil
							}
						}
						return rel, nil
					}
				}
			}
			return filepath.Base(dir), nil
		}

		parent := filepath.Dir(dir)
		if parent == dir || parent == "/" {
			break
		}
		dir = parent
	}

	return "", fmt.Errorf("no business process found (no process.toml in current directory or parents)")
}

// buildTree organizes flat requirements into a tree structure for display
func buildTree(reqs []Requirement) []treeNode {
	byID := make(map[string]*treeNode)
	for i := range reqs {
		byID[reqs[i].ID] = &treeNode{req: reqs[i]}
	}
	var roots []treeNode
	for i := range reqs {
		node := byID[reqs[i].ID]
		if reqs[i].Parent != "" {
			if parent, ok := byID[reqs[i].Parent]; ok {
				parent.children = append(parent.children, *node)
				continue
			}
		}
		roots = append(roots, *node)
	}
	return roots
}

type treeNode struct {
	req      Requirement
	children []treeNode
}

func printTree(nodes []treeNode, indent string) {
	for _, n := range nodes {
		status := strings.ToUpper(n.req.Status)
		fmt.Printf("%s%s [%s] %s\n", indent, n.req.ID, status, n.req.Description)
		if len(n.children) > 0 {
			printTree(n.children, indent+"  ")
		}
	}
}

var reqListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all requirements as a tree",
	RunE: func(cmd *cobra.Command, args []string) error {
		bp, err := detectBusinessProcess(reqBPFlag)
		if err != nil {
			return err
		}

		var reqs []Requirement
		if err := agentRequestJSON("GET", "/requirements/"+bp, nil, &reqs); err != nil {
			return fmt.Errorf("failed to list requirements: %w", err)
		}

		if len(reqs) == 0 {
			fmt.Println("No requirements found.")
			return nil
		}

		tree := buildTree(reqs)
		printTree(tree, "")
		return nil
	},
}

var reqAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Add a new requirement",
	RunE: func(cmd *cobra.Command, args []string) error {
		bp, err := detectBusinessProcess(reqBPFlag)
		if err != nil {
			return err
		}

		if reqText == "" {
			return fmt.Errorf("--text is required")
		}

		body := map[string]string{"text": reqText}
		if reqParent != "" {
			body["parent"] = reqParent
		}

		var req Requirement
		if err := agentRequestJSON("POST", "/requirements-add/"+bp, body, &req); err != nil {
			return fmt.Errorf("failed to add requirement: %w", err)
		}

		if req.Parent != "" {
			fmt.Printf("Added %s (child of %s): %s\n", req.ID, req.Parent, req.Description)
		} else {
			fmt.Printf("Added %s: %s\n", req.ID, req.Description)
		}
		return nil
	},
}

var reqUpdateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update a requirement's status or description",
	RunE: func(cmd *cobra.Command, args []string) error {
		bp, err := detectBusinessProcess(reqBPFlag)
		if err != nil {
			return err
		}

		if reqID == "" {
			return fmt.Errorf("--id is required")
		}

		body := map[string]string{}
		if reqStatus != "" {
			if reqStatus != "pass" && reqStatus != "fail" && reqStatus != "pending" {
				return fmt.Errorf("--status must be one of: pass, fail, pending")
			}
			body["status"] = reqStatus
		}
		if reqText != "" {
			body["text"] = reqText
		}

		var req Requirement
		if err := agentRequestJSON("PUT", "/requirements-update/"+bp+"/"+reqID, body, &req); err != nil {
			return fmt.Errorf("failed to update requirement: %w", err)
		}

		fmt.Printf("Updated %s (status: %s)\n", req.ID, req.Status)
		return nil
	},
}

var reqRemoveCmd = &cobra.Command{
	Use:   "remove",
	Short: "Remove a requirement",
	RunE: func(cmd *cobra.Command, args []string) error {
		bp, err := detectBusinessProcess(reqBPFlag)
		if err != nil {
			return err
		}

		if reqID == "" {
			return fmt.Errorf("--id is required")
		}

		if err := agentRequestJSON("DELETE", "/requirements-delete/"+bp+"/"+reqID, nil, nil); err != nil {
			return fmt.Errorf("failed to remove requirement: %w", err)
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
		bp, err := detectBusinessProcess(reqBPFlag)
		if err != nil {
			return err
		}

		var result struct {
			Status      string      `json:"status"`
			Message     string      `json:"message"`
			Requirement Requirement `json:"requirement"`
		}
		if err := agentRequestJSON("GET", "/requirements-next/"+bp, nil, &result); err != nil {
			return fmt.Errorf("failed to get next requirement: %w", err)
		}

		if result.Status == "all_passing" {
			fmt.Println("All requirements passing!")
			return nil
		}

		r := result.Requirement
		fmt.Printf("%s [%s]: %s\n", r.ID, strings.ToUpper(r.Status), r.Description)
		if r.Parent != "" {
			fmt.Printf("  Parent: %s\n", r.Parent)
		}
		return nil
	},
}

var reqOutputJSONCmd = &cobra.Command{
	Use:   "json",
	Short: "Output requirements as JSON",
	RunE: func(cmd *cobra.Command, args []string) error {
		bp, err := detectBusinessProcess(reqBPFlag)
		if err != nil {
			return err
		}

		var reqs []Requirement
		if err := agentRequestJSON("GET", "/requirements/"+bp, nil, &reqs); err != nil {
			return fmt.Errorf("failed to list requirements: %w", err)
		}

		data, err := json.MarshalIndent(reqs, "", "  ")
		if err != nil {
			return fmt.Errorf("failed to marshal requirements: %w", err)
		}
		fmt.Println(string(data))
		return nil
	},
}

var (
	reqBPFlag string
	reqText   string
	reqStatus string
	reqID     string
	reqParent string
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
	reqUpdateCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID")
	reqUpdateCmd.Flags().StringVar(&reqStatus, "status", "", "New status (pass|fail|pending)")
	reqUpdateCmd.Flags().StringVar(&reqText, "text", "", "Updated description")
	reqRemoveCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID to remove")
}
