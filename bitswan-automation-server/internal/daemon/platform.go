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

func currentPlatform() platform {
	platformOnce.Do(func() { resolvedPlatform = parsePlatform(os.Getenv(platformEnv)) })
	return resolvedPlatform
}

func parsePlatform(v string) platform {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "kubernetes", "k8s":
		return platformKubernetes
	}
	return platformDocker
}

func onKubernetes() bool { return currentPlatform() == platformKubernetes }

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

func protectedProxyUpstream() string {
	if onKubernetes() {
		return protectedProxyPodUpstream
	}
	return protectedProxyDockerUpstream
}

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

func mustWrapRoutes() bool { return wrapRequiredOn(currentPlatform()) }

func wrapRequiredOn(p platform) bool { return p == platformKubernetes }

func workspaceIngressUpstream(workspaceName string) string {
	if onKubernetes() {
		return fmt.Sprintf("%s-traefik:80", workspaceName)
	}
	return fmt.Sprintf("%s__traefik:80", workspaceName)
}

func acmeBridgeEndpointFor() string {
	if onKubernetes() {
		return fmt.Sprintf("http://127.0.0.1:%d%s", docsPort, acmeBridgePath)
	}
	return fmt.Sprintf("http://bitswan-automation-server-daemon:%d%s", docsPort, acmeBridgePath)
}

func daemonGateUpstream() string {
	if onKubernetes() {
		return "127.0.0.1" + gateListenAddr
	}
	return daemonContainerName + gateListenAddr
}

func relayLocalTargetDefault() string {
	if onKubernetes() {
		return "127.0.0.1:443"
	}
	return "traefik:443"
}
