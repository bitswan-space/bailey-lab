package automationserverdaemon

import (
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// version is set at build time
var version = "dev"

// SetVersion sets the version for the daemon server and configures auto-update
func SetVersion(v string) {
	version = v
	// Set up version check callback so daemon.NewClient() can auto-update
	daemon.SetVersionCheck(v, Recreate)
}

func newRunCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "__run",
		Short:  "Run the automation server daemon (internal use only)",
		Hidden: true, // Hide from help as this is for internal use
		RunE: func(cmd *cobra.Command, args []string) error {
			server := daemon.NewServer(version)
			return server.Run()
		},
	}
}
