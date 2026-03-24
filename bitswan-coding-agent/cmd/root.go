package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "bitswan-agent",
	Short: "BitSwan Coding Agent CLI",
	Long:  "CLI tool for BitSwan coding agents to interact with the workspace environment.",
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(requirementsCmd)
	rootCmd.AddCommand(logsCmd)
	rootCmd.AddCommand(restartCmd)
	rootCmd.AddCommand(buildAndRestartCmd)
	rootCmd.AddCommand(execCmd)
	rootCmd.AddCommand(vcsCmd)
	rootCmd.AddCommand(deploymentsCmd)
}
