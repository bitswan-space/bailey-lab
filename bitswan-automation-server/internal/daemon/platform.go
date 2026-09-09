package daemon

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type platform int

const (
	platformDocker platform = iota
	platformKubernetes
)

const (
	platformEnv                = "BITSWAN_PLATFORM"
	k8sServiceAccountNamespace = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"

	protectedProxyDockerUpstream = "bitswan-protected-proxy:80"
	protectedProxyPodUpstream    = "127.0.0.1:4180"
	protectedProxyPodPingURL     = "http://127.0.0.1:4180/ping"
)

var (
	platformOnce     sync.Once
	resolvedPlatform platform
)

// currentPlatform reads the platform once. It is declared rather than detected:
// every probe below answers "is the thing I need running?" by asking Docker, and
// Docker being absent is indistinguishable from the thing being down. The
// difference matters because the callers treat "the auth proxy is down" as
// permission to register routes WITHOUT it — so a detected platform would turn a
// missing socket into publicly reachable, unauthenticated workspace endpoints.
func currentPlatform() platform {
	platformOnce.Do(func() {
		switch strings.ToLower(strings.TrimSpace(os.Getenv(platformEnv))) {
		case "kubernetes", "k8s":
			resolvedPlatform = platformKubernetes
		default:
			resolvedPlatform = platformDocker
		}
	})
	return resolvedPlatform
}

func onKubernetes() bool { return currentPlatform() == platformKubernetes }

// assertPlatform fails startup when the declared platform cannot be true, so a
// pod that lost its BITSWAN_PLATFORM never silently starts shelling out to a
// Docker socket that is not there, and a host never runs the namespace paths.
func assertPlatform() error {
	_, err := os.Stat(k8sServiceAccountNamespace)
	inCluster := err == nil
	switch {
	case onKubernetes() && !inCluster:
		return fmt.Errorf("%s=kubernetes but %s is missing: this is not a pod",
			platformEnv, k8sServiceAccountNamespace)
	case !onKubernetes() && inCluster:
		return fmt.Errorf("running in a pod but %s is unset: refusing to manage Docker from inside Kubernetes",
			platformEnv)
	}
	return nil
}

// protectedProxyUpstream is where authenticated traffic enters. On Docker the
// proxy is a container on the shared network; in a namespace it is a container
// in this pod, so it is loopback and unreachable from anywhere else — which is
// what the Docker topology wanted and could not have.
func protectedProxyUpstream() string {
	if onKubernetes() {
		return protectedProxyPodUpstream
	}
	return protectedProxyDockerUpstream
}

// protectedProxyAvailable reports whether the auth proxy is up. The callers use
// this to decide whether an endpoint can be published behind authentication at
// all, so on Kubernetes it must answer from the proxy itself rather than from
// the absence of Docker.
func protectedProxyAvailable() bool {
	if !onKubernetes() {
		return containerRunning("bitswan-protected-proxy")
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(protectedProxyPodPingURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode < 500
}

// mustWrapRoutes reports whether a route may only be registered behind the auth
// proxy. On Docker an absent proxy degrades to a bare route, which is how a
// single-tier workspace install works. In a namespace the proxy is part of the
// same pod as this daemon and is never legitimately absent, so its absence is a
// fault: registering the route anyway would publish a workspace endpoint with no
// authentication in front of it.
func mustWrapRoutes() bool { return onKubernetes() }

// workspaceIngressUpstream is the per-workspace Traefik. The Docker name
// contains a double underscore, which is not a legal DNS label, so the
// namespace's Service uses a single hyphen.
func workspaceIngressUpstream(workspaceName string) string {
	if onKubernetes() {
		return fmt.Sprintf("%s-traefik:80", workspaceName)
	}
	return fmt.Sprintf("%s__traefik:80", workspaceName)
}

// acmeBridgeEndpointFor is the HTTPREQ_ENDPOINT Traefik calls to publish a
// DNS-01 challenge. Same pod means loopback, which also takes the bridge off
// every other container's network.
func acmeBridgeEndpointFor() string {
	if onKubernetes() {
		return fmt.Sprintf("http://127.0.0.1:%d%s", docsPort, acmeBridgePath)
	}
	return fmt.Sprintf("http://bitswan-automation-server-daemon:%d%s", docsPort, acmeBridgePath)
}

// daemonGateUpstream is this daemon's gate, as an upstream for a published
// public endpoint.
func daemonGateUpstream() string {
	if onKubernetes() {
		return "127.0.0.1" + gateListenAddr
	}
	return daemonContainerName + gateListenAddr
}

// relayLocalTargetDefault is where relayed browser streams are spliced: this
// server's own Traefik, which holds the real wildcard certificate.
func relayLocalTargetDefault() string {
	if onKubernetes() {
		return "127.0.0.1:443"
	}
	return "traefik:443"
}
