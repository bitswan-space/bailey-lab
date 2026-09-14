package daemon

import "testing"

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
