package cmd

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// mustDaemonClient returns a connected daemon client or exits with a hint to
// start the daemon. Shared by all `bitswan bailey` subcommands.
func mustDaemonClient() *daemon.Client {
	client, err := daemon.NewClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
		os.Exit(1)
	}
	return client
}

// newBaileyCmd is the parent for Bailey security-gate operations.
func newBaileyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "bailey",
		Short: "Manage the Bailey security gate",
	}
	cmd.AddCommand(newDevicesCmd())
	cmd.AddCommand(newAccessCmd())
	return cmd
}

// newAccessCmd groups endpoint access-grant operations. This is an
// operator-only (CLI/socket) capability — the browser share UI stays
// least-privileged and never exposes blanket grants.
func newAccessCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "access",
		Short: "Manage Bailey endpoint access grants (operator-only)",
	}
	cmd.AddCommand(newAccessGrantCmd())
	cmd.AddCommand(newAccessRevokeCmd())
	cmd.AddCommand(newAccessListCmd())
	return cmd
}

func newAccessGrantCmd() *cobra.Command {
	var role string
	var asGroup bool
	c := &cobra.Command{
		Use:   "grant <host> <email-or-group>",
		Short: "Grant a user (or group) access to a protected endpoint",
		Long: "Grant a principal access to a protected endpoint by hostname — e.g.\n" +
			"  bitswan bailey access grant wraptest-dashboard.example.com alice@acme.com\n" +
			"Defaults to the least-privileged 'access' role; pass --role owner to add an owner.\n" +
			"Use --group to treat the principal as a Keycloak group path instead of an email.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client := mustDaemonClient()
			principalType := "email"
			if asGroup {
				principalType = "group"
			}
			if err := client.GrantAccess(args[0], args[1], principalType, role); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("Granted %s '%s' the '%s' role on '%s'.\n", principalType, args[1], role, args[0])
			return nil
		},
	}
	c.Flags().StringVar(&role, "role", "access", "role to grant: access or owner")
	c.Flags().BoolVar(&asGroup, "group", false, "treat the principal as a Keycloak group path instead of an email")
	return c
}

func newAccessRevokeCmd() *cobra.Command {
	var role string
	var asGroup bool
	c := &cobra.Command{
		Use:   "revoke <host> <email-or-group>",
		Short: "Revoke a user's (or group's) access grant on a protected endpoint",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client := mustDaemonClient()
			principalType := "email"
			if asGroup {
				principalType = "group"
			}
			if err := client.RevokeAccess(args[0], args[1], principalType, role); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("Revoked the '%s' role for %s '%s' on '%s'.\n", role, principalType, args[1], args[0])
			return nil
		},
	}
	c.Flags().StringVar(&role, "role", "access", "role to revoke: access or owner")
	c.Flags().BoolVar(&asGroup, "group", false, "treat the principal as a Keycloak group path instead of an email")
	return c
}

func newAccessListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list <host>",
		Short: "List the access grants on a protected endpoint",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client := mustDaemonClient()
			res, err := client.ListAccess(args[0])
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("Endpoint: %s\nOwner:    %s\n", res.Host, res.OwnerEmail)
			if len(res.Grants) == 0 {
				fmt.Println("No additional grants.")
				return nil
			}
			tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "PRINCIPAL\tTYPE\tROLE\tGRANTED BY")
			for _, g := range res.Grants {
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", g.PrincipalValue, g.PrincipalType, g.Role, g.GrantedBy)
			}
			tw.Flush()
			return nil
		},
	}
}

// newDevicesCmd groups device-trust operations.
func newDevicesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "devices",
		Short: "Manage device-trust requests for the Bailey gate",
	}
	cmd.AddCommand(newDevicesApproveCmd())
	cmd.AddCommand(newDevicesListCmd())
	return cmd
}

func newDevicesApproveCmd() *cobra.Command {
	var email string
	c := &cobra.Command{
		Use:     "approve <code>",
		Aliases: []string{"trust", "add"},
		Short:   "Approve a pending device-trust request by its 6-digit code",
		Long: "Approve a pending \"trust this device\" request by the 6-digit code shown on the\n" +
			"requesting device. This is the CLI equivalent of an admin approving the code in\n" +
			"the browser — the waiting device completes pairing on its next poll.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client := mustDaemonClient()

			approvedEmail, err := client.ApproveDevice(args[0], email)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			fmt.Printf("Approved device-trust request for '%s'. The device will be let in on its next poll.\n", approvedEmail)
			return nil
		},
	}
	c.Flags().StringVar(&email, "email", "", "restrict approval to this user's pending request")
	return c
}

func newDevicesListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls", "pending"},
		Short:   "List pending device-trust requests and their codes",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			client := mustDaemonClient()

			pending, err := client.ListPendingDevices()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}

			if len(pending) == 0 {
				fmt.Println("No pending device-trust requests.")
				return nil
			}

			tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "CODE\tEMAIL\tAGE\tSTATUS")
			for _, p := range pending {
				status := "waiting"
				if p.Approved {
					status = "approved"
				}
				fmt.Fprintf(tw, "%s\t%s\t%ds\t%s\n", p.Code, p.Email, p.AgeSec, status)
			}
			tw.Flush()
			return nil
		},
	}
}
