#!/usr/bin/env bash
set -euo pipefail
export PATH="$PATH:/usr/local/go/bin"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
source /repo/e2e/local-vm/timeline.sh
tl_begin
cd /repo

echo "=== build this checkout's images ==="
./build-dev-images.sh
mark "k8s: build dev images"

echo "=== hand the images to k3s containerd ==="
IMAGES=(
  bitswan/gitops-dev:latest
  bitswan/workspace-dashboard-dev:latest
  bitswan/coding-agent-dev:latest
  bitswan/egress-gateway-dev:latest
  bitswan/infra-driver-dev:latest
)
echo "=== the automation server as a self-contained image ==="
( cd bitswan-automation-server && make console && go build -o bitswan . \
  && sudo docker build -q -f Dockerfile.k8s -t bitswan/automation-server:dev . )
mark "k8s: build the automation-server image"

sudo docker build -q -f bitswan-automation-server/Dockerfile.infra-driver.k8s \
  -t bitswan/infra-driver-k8s:dev bitswan-automation-server
mark "k8s: build the infra-driver image"

sudo docker save "${IMAGES[@]}" bitswan/automation-server:dev bitswan/infra-driver-k8s:dev \
  | sudo k3s ctr images import --digests=false -
mark "k8s: import images into containerd"

echo "=== bring up a Bailey in a namespace ==="
bash e2e/k8s/bringup-k8s.sh
mark "k8s: bringup"

sudo k3s ctr images ls -q | grep -c '^docker.io/bitswan/' || true
kubectl get node -o wide
kubectl -n kube-system get pods
tl_profile
