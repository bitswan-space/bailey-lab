package k8sdriver

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

func (d *K8sDriver) imageTagPrefix() string {
	if d.workspace == "" {
		return ""
	}
	return "internal/" + d.workspace + "-"
}

func registryInsecure() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("BITSWAN_K8S_REGISTRY_INSECURE"))) {
	case "1", "true", "yes":
		return true
	}
	return false
}

func registryScheme() string {
	if registryInsecure() {
		return "http://"
	}
	return "https://"
}

func registryBase() string {
	return registryScheme() + envOr("BITSWAN_K8S_REGISTRY", "bitswan-registry:5000")
}

var registryClient = &http.Client{Timeout: 30 * time.Second}

const (
	ociManifestType    = "application/vnd.oci.image.manifest.v1+json"
	dockerManifestType = "application/vnd.docker.distribution.manifest.v2+json"
	ociIndexType       = "application/vnd.oci.image.index.v1+json"
	dockerListType     = "application/vnd.docker.distribution.manifest.list.v2+json"
)

func registryRequest(ctx context.Context, method, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, registryBase()+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", strings.Join([]string{
		ociManifestType, dockerManifestType, ociIndexType, dockerListType,
	}, ", "))
	return registryClient.Do(req)
}

func registryJSON(ctx context.Context, path string, into interface{}) (http.Header, error) {
	resp, err := registryRequest(ctx, http.MethodGet, path)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, resp.Body)
		return resp.Header, fmt.Errorf("registry GET %s: HTTP %d", path, resp.StatusCode)
	}
	if into == nil {
		io.Copy(io.Discard, resp.Body)
		return resp.Header, nil
	}
	return resp.Header, json.NewDecoder(resp.Body).Decode(into)
}

type registryManifest struct {
	Config struct {
		Digest string `json:"digest"`
		Size   int64  `json:"size"`
	} `json:"config"`
	Layers []struct {
		Size int64 `json:"size"`
	} `json:"layers"`
}

func (d *K8sDriver) ImageList(ctx context.Context, _ infradriver.WorkspaceContext) ([]infradriver.Image, error) {
	var catalog struct {
		Repositories []string `json:"repositories"`
	}
	if _, err := registryJSON(ctx, "/v2/_catalog?n=1000", &catalog); err != nil {
		return []infradriver.Image{}, nil
	}

	prefix := d.imageTagPrefix()
	var images []infradriver.Image
	for _, repo := range catalog.Repositories {
		if prefix != "" && !strings.HasPrefix(repo, prefix) {
			continue
		}
		var tags struct {
			Tags []string `json:"tags"`
		}
		if _, err := registryJSON(ctx, "/v2/"+repo+"/tags/list?n=1000", &tags); err != nil {
			continue
		}
		for _, tag := range tags.Tags {
			images = append(images, d.describeImage(ctx, repo, tag))
		}
	}
	sort.Slice(images, func(i, j int) bool {
		if images[i].Created != images[j].Created {
			return images[i].Created > images[j].Created
		}
		return images[i].Tag < images[j].Tag
	})
	return images, nil
}

func (d *K8sDriver) describeImage(ctx context.Context, repo, tag string) infradriver.Image {
	img := infradriver.Image{Tag: repo + ":" + tag}

	var man registryManifest
	header, err := registryJSON(ctx, "/v2/"+repo+"/manifests/"+url.PathEscape(tag), &man)
	if err != nil {
		return img
	}
	img.ID = header.Get("Docker-Content-Digest")
	img.Size = man.Config.Size
	for _, layer := range man.Layers {
		img.Size += layer.Size
	}
	if man.Config.Digest != "" {
		var cfg struct {
			Created time.Time `json:"created"`
		}
		if _, err := registryJSON(ctx, "/v2/"+repo+"/blobs/"+man.Config.Digest, &cfg); err == nil {
			img.Created = cfg.Created.Unix()
		}
	}
	return img
}

func (d *K8sDriver) ImageRemove(ctx context.Context, _ infradriver.WorkspaceContext, tag string) error {
	if prefix := d.imageTagPrefix(); prefix != "" && !strings.HasPrefix(tag, prefix) {
		return fmt.Errorf("refused: image %q is not in workspace %q's namespace", tag, d.workspace)
	}
	repo, ref, ok := strings.Cut(tag, ":")
	if !ok {
		return fmt.Errorf("image %q has no tag", tag)
	}
	resp, err := registryRequest(ctx, http.MethodHead, "/v2/"+repo+"/manifests/"+url.PathEscape(ref))
	if err != nil {
		return fmt.Errorf("look up %s: %w", tag, err)
	}
	digest := resp.Header.Get("Docker-Content-Digest")
	resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if digest == "" {
		return fmt.Errorf("registry did not report a digest for %s", tag)
	}
	del, err := registryRequest(ctx, http.MethodDelete, "/v2/"+repo+"/manifests/"+digest)
	if err != nil {
		return fmt.Errorf("delete %s: %w", tag, err)
	}
	defer del.Body.Close()
	switch del.StatusCode {
	case http.StatusAccepted, http.StatusOK, http.StatusNotFound:
		return nil
	case http.StatusMethodNotAllowed:
		return fmt.Errorf("the registry refuses deletes: set REGISTRY_STORAGE_DELETE_ENABLED=true")
	}
	body, _ := io.ReadAll(io.LimitReader(del.Body, 2048))
	return fmt.Errorf("delete %s: HTTP %d: %s", tag, del.StatusCode, strings.TrimSpace(string(body)))
}

func (d *K8sDriver) ImageSBOM(ctx context.Context, _ infradriver.WorkspaceContext, tag string) ([]byte, error) {
	if prefix := d.imageTagPrefix(); prefix != "" && !strings.HasPrefix(tag, prefix) {
		return nil, fmt.Errorf("refused: image %q is not in workspace %q's namespace", tag, d.workspace)
	}
	cmd := exec.CommandContext(ctx, "syft", "registry:"+registryRef(tag), "-o", "syft-json")
	if registryInsecure() {
		cmd.Env = append(cmd.Environ(), "SYFT_REGISTRY_INSECURE_USE_HTTP=true")
	}
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("syft %s: %w: %s", tag, err, strings.TrimSpace(stderr.String()))
	}
	return []byte(stdout.String()), nil
}
