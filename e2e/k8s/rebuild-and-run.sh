#!/usr/bin/env bash
set -uo pipefail
set -e
export PATH="$PATH:/usr/local/go/bin"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ln -sfn "$(readlink -f /proc/$$/fd/1)" /tmp/current-run.log 2>/dev/null || true

echo "=== build the binaries and images ==="
cd bitswan-automation-server
make console >/dev/null
go build -o bitswan .
sudo docker build -q -f Dockerfile.k8s -t bitswan/automation-server:dev . >/dev/null
sudo docker build -q -f Dockerfile.infra-driver.k8s -t bitswan/infra-driver-k8s:dev . >/dev/null
sudo docker build -q -f cmd/egress-gateway/Dockerfile -t bitswan/egress-gateway-dev:latest . >/dev/null
cd ..

sudo docker build -q -f bitswan-gitops/Dockerfile -t bitswan/gitops-dev:latest . >/dev/null

echo "=== verify the images carry what this checkout added ==="
sudo docker run --rm bitswan/infra-driver-k8s:dev \
  /usr/local/bin/infra-driver serve --help | grep -qE -- '--driver'
sudo docker run --rm --entrypoint sh bitswan/infra-driver-k8s:dev \
  -c 'command -v buildctl >/dev/null && command -v kubectl >/dev/null && command -v syft >/dev/null'
sudo docker run --rm --entrypoint sh bitswan/automation-server:dev \
  -c 'command -v kubectl >/dev/null'
sudo docker run --rm --entrypoint sh bitswan/egress-gateway-dev:latest \
  -c 'grep -q BITSWAN_FW_HOLD /entrypoint.sh'
sudo docker run --rm --entrypoint sh bitswan/gitops-dev:latest \
  -c 'grep -q BITSWAN_INGRESS_TOKEN /src/app/utils.py'
echo IMAGES_VERIFIED

echo "=== hand them to containerd ==="
BASE_IMAGES=(
  docker.io/library/postgres:16
  docker.io/dxflrs/garage:v2.3.0
  docker.io/library/node:24-alpine
  docker.io/library/golang:1.25-alpine
  docker.io/bitswan/pipeline-runtime-environment:latest
  docker.io/library/busybox:1.36
  docker.io/rclone/rclone:1.68
  docker.io/library/registry:2
  docker.io/moby/buildkit:v0.19.0-rootless
  docker.io/gomods/athens:latest
  docker.io/verdaccio/verdaccio:6
)
for image in "${BASE_IMAGES[@]}"; do
  sudo k3s ctr images pull --platform linux/amd64 "$image" >/dev/null 2>&1 \
    || echo "PREPULL_FAILED $image"
done
present=()
for image in \
  bitswan/automation-server:dev \
  bitswan/infra-driver-k8s:dev \
  bitswan/gitops-dev:latest \
  bitswan/workspace-dashboard-dev:latest \
  bitswan/coding-agent-dev:latest \
  bitswan/egress-gateway-dev:latest; do
  sudo docker image inspect "$image" >/dev/null 2>&1 && present+=("$image")
done
TARBALL=/var/tmp/bitswan-image.tar
trap 'sudo rm -f "$TARBALL"' EXIT
for image in "${present[@]}"; do
  sudo rm -f "$TARBALL"
  if sudo docker save -o "$TARBALL" "$image" &&
     sudo k3s ctr images import --digests=false "$TARBALL" >/dev/null 2>&1; then
    continue
  fi
  echo "IMPORT_FAILED $image"
  echo "that image is one this checkout builds; refusing to run against whatever containerd already had" >&2
  exit 1
done
echo "IMPORTED ${#present[@]}"

bash e2e/k8s/bringup-k8s.sh

cd e2e
rm -rf test-results
rm -rf manual/build/shots
set +e
npx playwright test --reporter=list
suite=$?

cd ..
bash e2e/k8s/assert-shape.sh
shape=$?
set -e

exit $(( suite || shape ))

