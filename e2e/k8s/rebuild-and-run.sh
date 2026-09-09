#!/usr/bin/env bash
# Rebuild what this checkout changed, hand it to the cluster, and run the suite.
#
# A file rather than a command typed through two layers of ssh: the escaping
# needed to nest quotes that deep has broken this three times, each time in a way
# that looked like a product failure — a grep pattern that became a filename, a
# verification that never ran, a launch that never happened.
set -euo pipefail
export PATH="$PATH:/usr/local/go/bin"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "=== build the binaries and images ==="
cd bitswan-automation-server
make console >/dev/null
go build -o bitswan .
sudo docker build -q -f Dockerfile.k8s -t bitswan/automation-server:dev . >/dev/null
sudo docker build -q -f Dockerfile.infra-driver.k8s -t bitswan/infra-driver-k8s:dev . >/dev/null
cd ..

echo "=== verify the images carry what this checkout added ==="
# `docker build` leaves the PREVIOUS tag in place when it fails, so "the build
# ran" and "the image is current" are different claims. This asserts the second.
sudo docker run --rm bitswan/infra-driver-k8s:dev \
  /usr/local/bin/infra-driver serve --help | grep -qE -- '--driver'
sudo docker run --rm --entrypoint sh bitswan/infra-driver-k8s:dev \
  -c 'command -v buildctl >/dev/null && command -v kubectl >/dev/null'
sudo docker run --rm --entrypoint sh bitswan/automation-server:dev \
  -c 'command -v kubectl >/dev/null'
echo IMAGES_VERIFIED

echo "=== hand them to containerd ==="
# The kubelet pulls from containerd and cannot see the docker image store.
for image in registry:2 moby/buildkit:v0.19.0-rootless; do
  sudo docker pull -q "$image" >/dev/null
done
sudo docker save \
  bitswan/automation-server:dev \
  bitswan/infra-driver-k8s:dev \
  bitswan/gitops-dev:latest \
  bitswan/workspace-dashboard-dev:latest \
  bitswan/coding-agent-dev:latest \
  registry:2 \
  moby/buildkit:v0.19.0-rootless \
  | sudo k3s ctr images import --digests=false - >/dev/null
echo IMPORTED

bash e2e/k8s/bringup-k8s.sh

cd e2e
rm -rf test-results
npx playwright test --reporter=list
