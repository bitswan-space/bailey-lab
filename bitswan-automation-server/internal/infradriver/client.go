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

// Client calls the driver's container primitives over its UNIX socket. Apply is
// NOT here — callers trigger it by pushing to the driver's git remote. gitops
// has its own (Python) equivalent of this client; the Go one is used by tests
// and by the daemon when it inspects containers itself.
type Client struct {
	http *http.Client
	base string
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

// newClientFor builds a Client against an arbitrary base URL (tests).
func newClientFor(hc *http.Client, base string) *Client {
	return &Client{http: hc, base: strings.TrimRight(base, "/")}
}

// ContainerList returns the workspace's containers (optionally filtered).
func (c *Client) ContainerList(ctx context.Context, wctx WorkspaceContext, filter ContainerFilter) ([]Container, error) {
	var out ContainerListResult
	if err := c.postJSON(ctx, PathContainersList, ListBody{Ctx: wctx, Filter: filter}, &out); err != nil {
		return nil, err
	}
	return out.Containers, nil
}

// ContainerStop stops a container.
func (c *Client) ContainerStop(ctx context.Context, wctx WorkspaceContext, container string) error {
	return c.postJSON(ctx, PathContainersStop, ContainerBody{Ctx: wctx, Container: container}, &OKResult{})
}

// ContainerRestart restarts a container.
func (c *Client) ContainerRestart(ctx context.Context, wctx WorkspaceContext, container string) error {
	return c.postJSON(ctx, PathContainersRestart, ContainerBody{Ctx: wctx, Container: container}, &OKResult{})
}

// ContainerLogs streams a container's logs to sink until the stream ends.
func (c *Client) ContainerLogs(ctx context.Context, wctx WorkspaceContext, container string, tail int, follow bool, sink func(LogLine)) error {
	body := LogsBody{Ctx: wctx, Container: container, Tail: tail, Follow: follow}
	return c.stream(ctx, PathContainersLogs, body, func(event string, data []byte) error {
		switch event {
		case EventLog:
			var l LogLine
			if err := json.Unmarshal(data, &l); err != nil {
				return err
			}
			if sink != nil {
				sink(l)
			}
		case EventError:
			return sseError(data)
		}
		return nil
	})
}

func (c *Client) postJSON(ctx context.Context, path string, reqBody, out any) error {
	body, _ := json.Marshal(reqBody)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", path, resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// stream POSTs reqBody and dispatches each SSE frame to onFrame until the
// stream ends or onFrame returns an error (e.g. a terminal error frame).
func (c *Client) stream(ctx context.Context, path string, reqBody any, onFrame func(event string, data []byte) error) error {
	body, _ := json.Marshal(reqBody)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", path, resp.StatusCode)
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var event string
	var data bytes.Buffer
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
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
