#!/usr/bin/env bash
# Guest-side runner for the Kubernetes-namespace Bailey suite.
#
# Grows in step with the driver: right now it hands this checkout's images to
# k3s's containerd and reports what the cluster looks like, which is the signal
# needed while the seed manifest and namespace mode are being built.
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
# The kubelet pulls from containerd, which cannot see the docker image store, so
# every image a pod names has to be imported. imagePullPolicy stays Never for
# these, so a tag typo fails loudly instead of silently pulling from Docker Hub
# and testing code that is not in this checkout.
IMAGES=(
  bitswan/gitops-dev:latest
  bitswan/workspace-dashboard-dev:latest
  bitswan/coding-agent-dev:latest
  bitswan/egress-gateway-dev:latest
  bitswan/infra-driver-dev:latest
)
echo "=== the automation server as a self-contained image ==="
# The runtime image ships without the binary (a Docker host bind-mounts it); a
# pod has no host, so it is baked in and the tag names the version.
# `make console` first: the Server Console SPA is embedded into the binary with
# go:embed, and without it the gate serves an empty console — which looks exactly
# like a broken iframe rather than a missing build step.
( cd bitswan-automation-server && make console && go build -o bitswan . \
  && sudo docker build -q -f Dockerfile.k8s -t bitswan/automation-server:dev . )
mark "k8s: build the automation-server image"

sudo docker save "${IMAGES[@]}" bitswan/automation-server:dev \
  | sudo k3s ctr images import --digests=false -
mark "k8s: import images into containerd"

echo "=== bring up a Bailey in a namespace ==="
bash e2e/k8s/bringup-k8s.sh
mark "k8s: bringup"

sudo k3s ctr images ls -q | grep -c '^docker.io/bitswan/' || true
kubectl get node -o wide
kubectl -n kube-system get pods
tl_profile
