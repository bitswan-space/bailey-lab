package automationserverdaemon

import (
	"fmt"
	"os"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// newRegionCmd manages the server's region label shown on the overview
// identity card. With no argument it prints the current region; with an
// argument it sets it (writing the shared bailey.db the daemon reads live).
// `--clear` removes the override, reverting to the BITSWAN_REGION env var/none.
func newRegionCmd() *cobra.Command {
	var clear bool
	cmd := &cobra.Command{
		Use:   "region [value]",
		Short: "Get or set this server's region label",
		Long: "Show the server's region label, or set it. The region appears on the " +
			"Server overview. Admins can also set it from the console.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if clear {
				if err := daemon.SetRegion(""); err != nil {
					fmt.Fprintf(os.Stderr, "Error: %v\n", err)
					os.Exit(1)
				}
				fmt.Println("✓ Region cleared")
				return nil
			}
			if len(args) == 0 {
				if r := daemon.Region(); r != "" {
					fmt.Println(r)
				} else {
					fmt.Println("(no region set)")
				}
				return nil
			}
			if err := daemon.SetRegion(args[0]); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("✓ Region set to %q\n", args[0])
			return nil
		},
	}
	cmd.Flags().BoolVar(&clear, "clear", false, "Clear the region override")
	return cmd
}
