package infradriver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

// Client calls the driver's container primitives over its UNIX socket. Apply is
// NOT here — callers trigger it by pushing to the driver's git remote. gitops
// has its own (Python) equivalent of this client; the Go one is used by tests
// and by the daemon when it inspects containers itself.
type Client struct {
	http  *http.Client
	base  string
	token string // bearer token sent on every request when non-empty
}

// SetToken sets the shared bearer token sent on every request.
func (c *Client) SetToken(token string) { c.token = token }

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

// BuildImage builds a source image, streaming build log lines to prog, and
// returns the resulting image ref.
func (c *Client) BuildImage(ctx context.Context, req BuildRequest, prog func(string)) (ImageRef, error) {
	var img ImageRef
	err := c.stream(ctx, PathBuildImage, req, func(event string, data []byte) error {
		switch event {
		case EventLog:
			var l LogLine
			if err := json.Unmarshal(data, &l); err != nil {
				return err
			}
			if prog != nil {
				prog(l.Line)
			}
		case EventImage:
			if err := json.Unmarshal(data, &img); err != nil {
				return err
			}
		case EventError:
			return sseError(data)
		}
		return nil
	})
	return img, err
}

// ImageList returns the workspace's built images.
func (c *Client) ImageList(ctx context.Context, wctx WorkspaceContext) ([]Image, error) {
	var out ImageListResult
	if err := c.postJSON(ctx, PathImagesList, ListBody{Ctx: wctx}, &out); err != nil {
		return nil, err
	}
	return out.Images, nil
}

// ImageRemove deletes a workspace image by tag.
func (c *Client) ImageRemove(ctx context.Context, wctx WorkspaceContext, tag string) error {
	return c.postJSON(ctx, PathImagesRemove, ImageBody{Ctx: wctx, Tag: tag}, &OKResult{})
}

// ImageSBOM runs syft against a workspace image (driver-side) and returns the
// syft-json SBOM bytes.
func (c *Client) ImageSBOM(ctx context.Context, wctx WorkspaceContext, tag string) ([]byte, error) {
	body, _ := json.Marshal(ImageBody{Ctx: wctx, Tag: tag})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+PathImagesSBOM, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.auth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("%s: HTTP %d: %s", PathImagesSBOM, resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return io.ReadAll(resp.Body)
}

// ContainerInspect returns the raw `docker inspect` JSON for one container.
func (c *Client) ContainerInspect(ctx context.Context, wctx WorkspaceContext, container string) ([]byte, error) {
	body, _ := json.Marshal(ContainerBody{Ctx: wctx, Container: container})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+PathContainersInspect, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.auth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", PathContainersInspect, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// ContainerExec runs a command in a container, streaming in to stdin and
// delivering stdout/stderr chunks to out; returns the exit code.
func (c *Client) ContainerExec(ctx context.Context, wctx WorkspaceContext, spec ExecSpec, in io.Reader, out func(stderr bool, chunk []byte)) (int, error) {
	meta, _ := json.Marshal(ExecBody{Ctx: wctx, Spec: spec})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+PathContainersExec, in)
	if err != nil {
		return -1, err
	}
	req.Header.Set(HeaderExec, base64.StdEncoding.EncodeToString(meta))
	req.Header.Set("Content-Type", "application/octet-stream")
	c.auth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return -1, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return -1, fmt.Errorf("%s: HTTP %d", PathContainersExec, resp.StatusCode)
	}
	return readExecFrames(resp.Body, out)
}

// ContainerCopyOut archives a path from a container and returns the raw TAR
// stream (docker cp <c>:<path> -). The returned reader is the HTTP response
// body — the caller must Close it.
func (c *Client) ContainerCopyOut(ctx context.Context, wctx WorkspaceContext, container, path string) (io.ReadCloser, error) {
	body, _ := json.Marshal(CopyOutBody{Ctx: wctx, Container: container, Path: path})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+PathContainersCopyOut, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.auth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return nil, fmt.Errorf("%s: HTTP %d", PathContainersCopyOut, resp.StatusCode)
	}
	return resp.Body, nil
}

// ContainerCopyIn streams a TAR from r into a container path (docker cp -
// <c>:<path>). Metadata rides X-Bitswan-Copy so the body is the pure TAR.
func (c *Client) ContainerCopyIn(ctx context.Context, wctx WorkspaceContext, container, path string, r io.Reader) error {
	meta, _ := json.Marshal(CopyInBody{Ctx: wctx, Container: container, Path: path})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+PathContainersCopyIn, r)
	if err != nil {
		return err
	}
	req.Header.Set(HeaderCopy, base64.StdEncoding.EncodeToString(meta))
	req.Header.Set("Content-Type", "application/octet-stream")
	c.auth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", PathContainersCopyIn, resp.StatusCode)
	}
	return nil
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

func (c *Client) ContainerEvents(ctx context.Context, wctx WorkspaceContext, sink func(ContainerEvent)) error {
	return c.stream(ctx, PathContainersEvents, EventsBody{Ctx: wctx}, func(event string, data []byte) error {
		switch event {
		case EventContainerState:
			var e ContainerEvent
			if err := json.Unmarshal(data, &e); err != nil {
				return err
			}
			if sink != nil {
				sink(e)
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
	c.auth(req)
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

// auth adds the shared bearer token when configured.
func (c *Client) auth(req *http.Request) {
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
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
	c.auth(req)
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
