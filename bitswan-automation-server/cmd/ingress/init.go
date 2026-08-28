package ingress

import (
	"fmt"
	"net"
	"os"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

func newInitCmd() *cobra.Command {
	var verbose bool
	var bindAddress string

	cmd := &cobra.Command{
		Use:   "init",
		Short: "Initializes the Traefik ingress proxy",
		Long: "Initializes the Traefik ingress proxy, or reconfigures a running one when its " +
			"configuration has changed.\n\n" +
			"--bind-address narrows the HOST address the public entrypoints (:80/:443) publish " +
			"on — the way to keep a server that is only meant to be reachable over a VPN off its " +
			"public interface. Docker installs its port-publish DNAT ahead of the host firewall, " +
			"so a ufw or nftables rule cannot close a published port; naming the address here is " +
			"what actually closes it. Pass 0.0.0.0 to go back to publishing on every interface.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Validate before touching the daemon: an unparseable address would be
			// interpolated into a compose port mapping and fail much later, with a
			// message about Docker rather than about the flag.
			if bindAddress != "" && bindAddress != "0.0.0.0" && net.ParseIP(bindAddress) == nil {
				return fmt.Errorf("--bind-address %q is not an IP address", bindAddress)
			}

			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			var result *daemon.IngressInitResponse
			if cmd.Flags().Changed("bind-address") {
				addr := bindAddress
				if addr == "0.0.0.0" {
					// Docker's own "every interface" — store it as empty so the
					// rendered compose stays byte-identical to a server that never
					// set the option, and the drift check stays quiet.
					addr = ""
				}
				result, err = client.InitIngressWithBindAddress(verbose, addr)
			} else {
				result, err = client.InitIngress(verbose)
			}
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			fmt.Println(result.Message)
			return nil
		},
	}

	cmd.Flags().BoolVarP(&verbose, "verbose", "v", false, "Enable verbose output")
	cmd.Flags().StringVar(&bindAddress, "bind-address", "",
		"Publish :80/:443 on this host address only (e.g. the VPN address 10.8.0.7); "+
			"0.0.0.0 publishes on every interface")

	return cmd
}
