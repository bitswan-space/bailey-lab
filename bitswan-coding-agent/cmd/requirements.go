package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

type Requirement struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Status      string `json:"status"`
	Notes       string `json:"notes"`
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

	// Walk up from cwd looking for process.toml, stopping at /workspace
	dir := cwd
	for {
		if _, err := os.Stat(filepath.Join(dir, "process.toml")); err == nil {
			// Found it — return relative path from the workspace root
			// The workspace root is typically /workspace/worktrees/<name> or /workspace/workspace
			for _, base := range []string{"/workspace/workspace", "/workspace/worktrees"} {
				if strings.HasPrefix(dir, base) {
					rel, err := filepath.Rel(base, dir)
					if err == nil {
						// For worktrees, strip the worktree name prefix
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
			// Fallback: just use the directory name
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

var reqListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all requirements",
	RunE: func(cmd *cobra.Command, args []string) error {
		bp, err := detectBusinessProcess(reqBPFlag)
		if err != nil {
			return err
		}

		var reqs []Requirement
		err = agentRequestJSON("GET", "/requirements/"+bp, nil, &reqs)
		if err != nil {
			return fmt.Errorf("failed to list requirements: %w", err)
		}

		if len(reqs) == 0 {
			fmt.Println("No requirements found.")
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tSTATUS\tDESCRIPTION\tNOTES")
		fmt.Fprintln(w, "--\t------\t-----------\t-----")
		for _, r := range reqs {
			status := strings.ToUpper(r.Status)
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", r.ID, status, r.Description, r.Notes)
		}
		w.Flush()
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
		var req Requirement
		err = agentRequestJSON("POST", "/requirements-add/"+bp, body, &req)
		if err != nil {
			return fmt.Errorf("failed to add requirement: %w", err)
		}

		fmt.Printf("Added requirement %s: %s\n", req.ID, req.Description)
		return nil
	},
}

var reqUpdateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update a requirement's status",
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
		if reqNotes != "" {
			body["notes"] = reqNotes
		}

		var req Requirement
		err = agentRequestJSON("PUT", "/requirements-update/"+bp+"/"+reqID, body, &req)
		if err != nil {
			return fmt.Errorf("failed to update requirement: %w", err)
		}

		fmt.Printf("Updated requirement %s (status: %s)\n", req.ID, req.Status)
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

		err = agentRequestJSON("DELETE", "/requirements-delete/"+bp+"/"+reqID, nil, nil)
		if err != nil {
			return fmt.Errorf("failed to remove requirement: %w", err)
		}

		fmt.Printf("Removed requirement %s\n", reqID)
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
		err = agentRequestJSON("GET", "/requirements/"+bp, nil, &reqs)
		if err != nil {
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
	reqNotes  string
)

func init() {
	requirementsCmd.PersistentFlags().StringVar(&reqBPFlag, "business-process", "", "Business process path (auto-detected from current directory if not set)")
	requirementsCmd.PersistentFlags().StringVar(&reqBPFlag, "bp", "", "Business process path (shorthand)")

	requirementsCmd.AddCommand(reqListCmd)
	requirementsCmd.AddCommand(reqAddCmd)
	requirementsCmd.AddCommand(reqUpdateCmd)
	requirementsCmd.AddCommand(reqRemoveCmd)
	requirementsCmd.AddCommand(reqOutputJSONCmd)

	reqAddCmd.Flags().StringVar(&reqText, "text", "", "Requirement description")
	reqUpdateCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID")
	reqUpdateCmd.Flags().StringVar(&reqStatus, "status", "", "New status (pass|fail|pending)")
	reqUpdateCmd.Flags().StringVar(&reqText, "text", "", "Updated description")
	reqUpdateCmd.Flags().StringVar(&reqNotes, "notes", "", "Notes")
	reqRemoveCmd.Flags().StringVar(&reqID, "id", "", "Requirement ID to remove")
}
