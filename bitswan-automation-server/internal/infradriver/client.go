package infradriver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
)

// Client speaks the HTTP/SSE contract to a driver over a UNIX socket. gitops
// has its own (Python) equivalent; this Go client is used by tests and by the
// daemon when it drives infra itself.
type Client struct {
	http *http.Client
	base string // dummy host; the UNIX socket dialer ignores it
}

// NewUnixClient dials the driver on the given UNIX socket path.
func NewUnixClient(socketPath string) *Client {
	return &Client{
		http: &http.Client{
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
				},
			},
		},
		base: "http://driver",
	}
}

// newClientFor builds a Client against an arbitrary base URL (used by tests with
// httptest.Server).
func newClientFor(hc *http.Client, base string) *Client {
	return &Client{http: hc, base: strings.TrimRight(base, "/")}
}

// Apply streams a compile+reconcile; prog receives each progress step; the
// realized routes are returned on success.
func (c *Client) Apply(ctx context.Context, req ApplyRequest, prog func(Progress)) ([]Route, error) {
	var routes []Route
	err := c.stream(ctx, PathApply, req, func(event string, data []byte) error {
		switch event {
		case EventProgress:
			var p Progress
			if err := json.Unmarshal(data, &p); err != nil {
				return err
			}
			if prog != nil {
				prog(p)
			}
		case EventDone:
			var res ApplyResult
			if err := json.Unmarshal(data, &res); err != nil {
				return err
			}
			routes = res.Routes
		case EventError:
			return sseError(data)
		}
		return nil
	})
	return routes, err
}

// Status fetches deployment state (non-streamed).
func (c *Client) Status(ctx context.Context, wctx WorkspaceContext, ids []string) ([]DeploymentState, error) {
	body, _ := json.Marshal(StatusBody{Ctx: wctx, DeploymentIDs: ids})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+PathStatus, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status: HTTP %d", resp.StatusCode)
	}
	var out DeploymentStatus
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.States, nil
}

// stream POSTs reqBody and dispatches each SSE frame to onFrame until the
// stream ends or onFrame returns an error (e.g. a terminal error frame).
func (c *Client) stream(ctx context.Context, path string, reqBody any, onFrame func(event string, data []byte) error) error {
	body, err := json.Marshal(reqBody)
	if err != nil {
		return err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", path, resp.StatusCode)
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // tolerate large compose/log frames
	var event string
	var data bytes.Buffer
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "": // frame boundary
			if event != "" {
				if err := onFrame(event, data.Bytes()); err != nil {
					return err
				}
			}
			event = ""
			data.Reset()
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	// flush a trailing frame with no terminating blank line
	if event != "" {
		return onFrame(event, data.Bytes())
	}
	return nil
}

func sseError(data []byte) error {
	var e ErrorResult
	if json.Unmarshal(data, &e) == nil && e.Error != "" {
		return fmt.Errorf("driver: %s", e.Error)
	}
	return fmt.Errorf("driver error")
}
