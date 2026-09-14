#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_IP="${E2E_VM_IP:-192.168.122.90}"
DOMAIN="${E2E_DOMAIN:-bs-e2e.localhost}"
K3S_VERSION="${K3S_VERSION:-v1.31.5+k3s1}"

bash "$HERE/provision.sh"

echo "=== k3s registry mirror for the in-namespace registry ==="
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
