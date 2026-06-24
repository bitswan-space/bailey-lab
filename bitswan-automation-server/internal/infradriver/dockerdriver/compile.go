package dockerdriver

import (
	"context"
	"fmt"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
)

// Apply is the bitswan.yaml compiler: parse the declaration, generate the
// docker-compose project + stage networks, bring it up, install CA certs +
// oauth2 sidecars, realize blue-green data state, and return the ingress
// routes. Invoked by the git post-receive hook (see infradriver/README.md), so
// prog writes to the hook's stdout, which git relays to the pushing client.
//
// This is the port of gitops automation_service.generate_docker_compose +
// apply_compose_for_deployments. It is being filled in incrementally and
// validated against golden compose fixtures (compile_test.go) before gitops
// cuts over. Until the compiler lands, Apply reports unimplemented rather than
// silently no-op'ing a deploy.
func (d *DockerDriver) Apply(_ context.Context, _ infradriver.ApplyRequest, _ func(infradriver.Progress)) ([]infradriver.Route, error) {
	return nil, fmt.Errorf("dockerdriver.Apply: bitswan.yaml compiler not yet implemented")
}

// BuildImage bakes a source tree into an image (port of gitops
// automation_service._bake_source_image). Content-addressed by SourceSHA. Being
// implemented; stubbed until then.
func (d *DockerDriver) BuildImage(_ context.Context, _ infradriver.BuildRequest, _ func(string)) (infradriver.ImageRef, error) {
	return infradriver.ImageRef{}, fmt.Errorf("dockerdriver.BuildImage: not yet implemented")
}
