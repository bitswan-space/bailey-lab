package dockerdriver

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// imageTagPrefix is the namespace a workspace's built images live under
// (internal/<workspace>-…); used to scope list + remove to the workspace.
func (d *DockerDriver) imageTagPrefix() string {
	if d.workspace == "" {
		return ""
	}
	return "internal/" + d.workspace + "-"
}

// dockerImageLine is one row of `docker images --format json`.
type dockerImageLine struct {
	ID         string `json:"ID"`
	Repository string `json:"Repository"`
	Tag        string `json:"Tag"`
	CreatedAt  string `json:"CreatedAt"`
	Size       string `json:"Size"` // human ("123MB"); not surfaced numerically
}

// ImageList returns the workspace's built images (tagged internal/<ws>-…).
func (d *DockerDriver) ImageList(ctx context.Context, _ infradriver.WorkspaceContext) ([]infradriver.Image, error) {
	out, err := exec.CommandContext(ctx, "docker", "images", "--no-trunc", "--format", "{{json .}}").Output()
	if err != nil {
		return nil, fmt.Errorf("docker images: %w", err)
	}
	prefix := d.imageTagPrefix()
	var images []infradriver.Image
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var di dockerImageLine
		if err := json.Unmarshal([]byte(line), &di); err != nil {
			continue
		}
		if di.Repository == "<none>" || di.Tag == "<none>" {
			continue
		}
		tag := di.Repository + ":" + di.Tag
		// Scope to this workspace's namespace.
		if prefix != "" && !strings.HasPrefix(tag, prefix) {
			continue
		}
		images = append(images, infradriver.Image{ID: di.ID, Tag: tag})
	}
	return images, nil
}

// ImageRemove deletes an image by tag, refusing anything outside the
// workspace's namespace.
func (d *DockerDriver) ImageRemove(ctx context.Context, _ infradriver.WorkspaceContext, tag string) error {
	if prefix := d.imageTagPrefix(); prefix != "" && !strings.HasPrefix(tag, prefix) {
		return fmt.Errorf("refused: image %q is not in workspace %q's namespace", tag, d.workspace)
	}
	if out, err := exec.CommandContext(ctx, "docker", "image", "rm", "-f", tag).CombinedOutput(); err != nil {
		return fmt.Errorf("docker image rm %s: %w: %s", tag, err, strings.TrimSpace(string(out)))
	}
	return nil
}
