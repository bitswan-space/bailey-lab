package cmd

import (
	"bufio"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const (
	ansiRed   = "\033[31m"
	ansiReset = "\033[0m"
)

var deploymentsLogsFollow bool
var deploymentsLogsLines int

var deploymentsLogsCmd = &cobra.Command{
	Use:   "logs DEPLOYMENT_ID",
	Short: "View deployment logs",
	Long:  "Show logs from a live-dev deployment. Without --follow, prints recent logs and exits.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		path := fmt.Sprintf("/deployments/%s/logs?lines=%d", deploymentID, deploymentsLogsLines)
		if deploymentsLogsFollow {
			path += "&follow=true"
		}

		resp, err := agentRequest("GET", path, nil)
		if err != nil {
			return fmt.Errorf("failed to get logs: %w", err)
		}
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

		// For non-follow mode: read lines with a timeout.
		// SSE streams never close, so we exit after 2s of no data.
		if !deploymentsLogsFollow {
			done := make(chan struct{})
			go func() {
				for scanner.Scan() {
					line := scanner.Text()
					printSSELogLine(line)
					// Reset timeout by signaling we got data
					select {
					case done <- struct{}{}:
					default:
					}
				}
				close(done)
			}()

			timeout := time.NewTimer(3 * time.Second)
			for {
				select {
				case _, ok := <-done:
					if !ok {
						return nil // stream ended
					}
					timeout.Reset(2 * time.Second)
				case <-timeout.C:
					return nil // no data for 2s, done
				}
			}
		}

		// Follow mode: stream until interrupted
		for scanner.Scan() {
			printSSELogLine(scanner.Text())
		}
		return scanner.Err()
	},
}

// printSSELogLine extracts the log line from SSE format and colors stderr red.
// SSE lines look like: "data: {"replica": 0, "line": "...", "stream": "stdout|stderr"}"
func printSSELogLine(line string) {
	if !strings.HasPrefix(line, "data: ") {
		return
	}
	data := line[6:]
	idx := strings.Index(data, `"line": "`)
	if idx < 0 {
		fmt.Println(data)
		return
	}
	rest := data[idx+9:]
	end := findClosingQuote(rest)
	if end < 0 {
		fmt.Println(data)
		return
	}
	logLine := rest[:end]
	logLine = strings.ReplaceAll(logLine, `\"`, `"`)
	logLine = strings.ReplaceAll(logLine, `\\`, `\`)

	if strings.Contains(data, `"stream": "stderr"`) {
		fmt.Println(ansiRed + logLine + ansiReset)
	} else {
		fmt.Println(logLine)
	}
}

func findClosingQuote(s string) int {
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' {
			i++ // skip escaped char
			continue
		}
		if s[i] == '"' {
			return i
		}
	}
	return -1
}

func init() {
	deploymentsLogsCmd.Flags().BoolVarP(&deploymentsLogsFollow, "follow", "f", false, "Follow log output (stream continuously)")
	deploymentsLogsCmd.Flags().IntVarP(&deploymentsLogsLines, "lines", "n", 100, "Number of log lines to show")
}
