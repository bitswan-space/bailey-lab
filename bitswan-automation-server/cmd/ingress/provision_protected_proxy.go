package ingress

import (
	"fmt"
	"os"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

func newProvisionProtectedProxyCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "provision-protected-proxy",
		Short: "Deploy (or re-deploy) the shared bitswan-protected-proxy",
		Long: "Brings up the shared bitswan-protected-proxy (oauth2-proxy) that " +
			"authenticates every protected endpoint upstream of the daemon's access " +
			"gate. register does this automatically; use this to provision it on an " +
			"already-registered server (e.g. after upgrading the daemon). Idempotent. " +
			"Requires a configured domain and a reachable AOC.\n\n" +
			"Note: this does not start the ingress (Traefik). If the ingress isn't up " +
			"yet, run 'bitswan ingress init' first.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			if err := client.ProvisionProtectedProxy(); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			fmt.Println("Protected proxy provisioned; endpoints are now authenticated through Bailey.")
			return nil
		},
	}
}
