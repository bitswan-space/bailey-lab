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
# The kubelet pulls from containerd and cannot see the docker image store. The
# base images matter as much as ours: an automation runs one directly in
# live-dev, and a deploy builds FROM one, so a guest that has them only in
# docker stalls on a rate-limited pull mid-chapter.
BASE_IMAGES=(
  postgres:16
  dxflrs/garage:v2.3.0
  node:24-alpine
  golang:1.25-alpine
  bitswan/pipeline-runtime-environment:latest
  busybox:1.36
)
for image in registry:2 moby/buildkit:v0.19.0-rootless "${BASE_IMAGES[@]}"; do
  sudo docker image inspect "$image" >/dev/null 2>&1 || sudo docker pull -q "$image" >/dev/null || true
done
present=()
for image in \
  bitswan/automation-server:dev \
  bitswan/infra-driver-k8s:dev \
  bitswan/gitops-dev:latest \
  bitswan/workspace-dashboard-dev:latest \
  bitswan/coding-agent-dev:latest \
  registry:2 \
  moby/buildkit:v0.19.0-rootless \
  "${BASE_IMAGES[@]}"; do
  sudo docker image inspect "$image" >/dev/null 2>&1 && present+=("$image")
done
# One image per archive. A single save of the whole set has failed the import
# with "content digest not found" — one image whose export containerd will not
# resolve takes the whole batch with it, and a half-imported set looks exactly
# like a stale image. Ours are load-bearing and fail the cycle; a base image
# that will not import is reported and left to be pulled.
TARBALL=/var/tmp/bitswan-image.tar
trap 'sudo rm -f "$TARBALL"' EXIT
import_failures=0
for image in "${present[@]}"; do
  sudo rm -f "$TARBALL"
  if sudo docker save -o "$TARBALL" "$image" &&
     sudo k3s ctr images import --digests=false "$TARBALL" >/dev/null 2>&1; then
    continue
  fi
  echo "IMPORT_FAILED $image"
  case "$image" in
    bitswan/automation-server:dev|bitswan/infra-driver-k8s:dev|bitswan/*-dev:latest)
      echo "that image is the one under test; refusing to run against whatever containerd already had" >&2
      exit 1
      ;;
  esac
  import_failures=$((import_failures + 1))
done
echo "IMPORTED $(( ${#present[@]} - import_failures )) of ${#present[@]}"

bash e2e/k8s/bringup-k8s.sh

cd e2e
rm -rf test-results
npx playwright test --reporter=list
