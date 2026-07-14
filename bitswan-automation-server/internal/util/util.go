package util

import (
	"fmt"
	"os"
	"os/exec"
)

// RunCommandVerbose runs a command, optionally printing output to stdout/stderr.
// If verbose is true, the command's stdout and stderr are connected to the process's
// stdout and stderr so output is displayed in real time.
func RunCommandVerbose(cmd *exec.Cmd, verbose bool) error {
	if verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		fmt.Printf("Running command: %s\n", cmd.String())
	}
	return cmd.Run()
}
