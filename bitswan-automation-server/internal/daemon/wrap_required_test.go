package daemon

import "testing"

// TestTheWrapIsRequiredInANamespace states the property the routing code has to
// hold: on Docker an absent auth proxy degrades to a bare route, because that
// is what a single-tier install is. In a namespace the proxy is a container of
// the same pod and is never legitimately absent, so degrading would put a
// workspace endpoint on the internet with nothing in front of it.
func TestTheWrapIsRequiredInANamespace(t *testing.T) {
	for _, declared := range []string{"kubernetes", "k8s", "Kubernetes", " K8S "} {
		if !wrapRequiredOn(parsePlatform(declared)) {
			t.Errorf("platform %q would publish an endpoint with no authentication in front of it", declared)
		}
	}
	for _, elsewhere := range []string{"", "docker", "Docker", "anything-else"} {
		if wrapRequiredOn(parsePlatform(elsewhere)) {
			t.Errorf("platform %q now requires the wrap; a single-tier Docker install would stop routing", elsewhere)
		}
	}
}
