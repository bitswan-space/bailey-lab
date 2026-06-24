package dockerdriver

import (
	"context"
	"fmt"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// BuildImage bakes a source tree into an image (port of gitops
// automation_service._bake_source_image): content-address by SourceSHA, cache
// hit returns immediately, else build `FROM BaseImage` + COPY the source to
// MountPath, tag, and return the ref. Streams build output to prog.
//
// Being implemented; stubbed until then.
func (d *DockerDriver) BuildImage(_ context.Context, _ infradriver.BuildRequest, _ func(string)) (infradriver.ImageRef, error) {
	return infradriver.ImageRef{}, fmt.Errorf("dockerdriver.BuildImage: not yet implemented")
}
