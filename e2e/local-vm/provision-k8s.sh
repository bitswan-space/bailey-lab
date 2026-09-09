#!/usr/bin/env bash
# Provision a guest for the Kubernetes-namespace Bailey suite: everything the
# Docker suite needs (provision.sh), plus a single-node k3s.
#
# Docker stays installed and is used for exactly one thing: BUILDING the
# workspace-service images. k3s pulls from its own containerd, so the images are
# handed over with `docker save | k3s ctr images import` (run-k8s-e2e.sh). The
# assertion that a Bailey is really running on the Kubernetes driver is made
# against the cluster (assert-shape.sh), not against the absence of a binary.
#
# The domain stays bs-e2e.localhost, deliberately: the walkthrough's screenshots
# are compared against the Docker run's, and a different domain would change
# every capture that shows a hostname. provision.sh already points *.localhost at
# 127.0.0.1 for the browser; the CoreDNS override below is what makes the same
# name resolve to the ingress from INSIDE a pod, where 127.0.0.1 is the pod.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_IP="${E2E_VM_IP:-192.168.122.90}"
DOMAIN="${E2E_DOMAIN:-bs-e2e.localhost}"
K3S_VERSION="${K3S_VERSION:-v1.31.5+k3s1}"

bash "$HERE/provision.sh"

echo "=== k3s registry mirror for the in-namespace registry ==="
# The kubelet resolves image references through the NODE's resolver, not cluster
# DNS, so a Service name is unresolvable to it. containerd trusts localhost
# registries over plain HTTP, so the in-namespace registry is published on a
# NodePort and mirrored here. Written before k3s starts: it is read at startup.
mkdir -p /etc/rancher/k3s
cat > /etc/rancher/k3s/registries.yaml <<YAML
mirrors:
  "bitswan-registry:5000":
    endpoint: ["http://127.0.0.1:30500"]
configs:
  "bitswan-registry:5000":
    tls:
      insecure_skip_verify: true
YAML

echo "=== CoreDNS override: ${DOMAIN} resolves to the ingress from inside pods ==="
# .localhost answers 127.0.0.1 for the browser on the node, which is right there
# and wrong in a pod. Answer the Bailey's own names with the node IP instead, so
# oauth2-proxy's issuer checks, the daemon's endpoint self-check and anything
# else that dials a Bailey hostname from a pod reach the ingress.
mkdir -p /var/lib/rancher/k3s/server/manifests
cat > /var/lib/rancher/k3s/server/manifests/coredns-custom.yaml <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom
  namespace: kube-system
data:
  bitswan.server: |
    ${DOMAIN}:53 {
      errors
      template IN A ${DOMAIN} {
        match "^([^.]+\\.)*${DOMAIN//./\\.}\\.\$"
        answer "{{ .Name }} 60 IN A ${NODE_IP}"
      }
      template IN AAAA ${DOMAIN} {
        match "^([^.]+\\.)*${DOMAIN//./\\.}\\.\$"
        rcode NOERROR
      }
    }
    test:53 {
      errors
      forward . ${NODE_IP}
    }
YAML

echo "=== k3s ==="
if ! command -v k3s >/dev/null; then
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server \
    --node-name=bitswan-k8s \
    --node-ip="$NODE_IP" \
    --write-kubeconfig-mode=644 \
    --disable=traefik \
    --kubelet-arg=image-gc-high-threshold=95 \
    --kubelet-arg=image-gc-low-threshold=90 \
    --kubelet-arg='eviction-hard=imagefs.available<2%,nodefs.available<2%'
fi

# k3s ships its own Traefik; the Bailey brings the Traefik it manages itself
# (file provider, HTTP API off), so the bundled one is disabled above or it would
# contend for the node's :80/:443. servicelb, local-path and metrics-server stay:
# the ingress needs a LoadBalancer Service, the PVCs need a default class, and
# the walkthrough's Containers chapter reads live memory.
echo "=== wait for the node ==="
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
for i in $(seq 1 60); do
  kubectl get node bitswan-k8s >/dev/null 2>&1 && break
  sleep 2
done
kubectl wait --for=condition=Ready node/bitswan-k8s --timeout=180s
kubectl -n kube-system rollout status deploy/coredns --timeout=180s || true

echo "=== cluster ready ==="
kubectl get node -o wide
kubectl version --short 2>/dev/null || kubectl version
