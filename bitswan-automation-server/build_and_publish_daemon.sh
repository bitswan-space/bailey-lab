#!/bin/bash
set -euo pipefail

# The runtime image the automation-server daemon container runs. The daemon
# bind-mounts the host `bitswan` binary read-only, so this image supplies only the
# tooling around it — git, ssh-keygen, docker-cli, mkcert, restic. That split is
# why publishing it matters: a server can update its binary and still be missing
# something the image provides, which is how a backup came to fail with
# `exec: "restic": executable file not found in $PATH`.
#
# The name must match automationserverdaemon.DaemonRuntimeImage, which is what a
# server actually pulls. It previously read automation-server-daemon-runtime here
# — a name nothing consumed — so this script published an image no deployment ever
# used while the one they did use went stale.
IMAGE_TAG="bitswan/automation-server-runtime"

YEAR=$(date +%Y)
COMMIT_HASH=$(git rev-parse --short HEAD)
VERSION_TAG="$YEAR-${GITHUB_RUN_ID:-local}-git-$COMMIT_HASH"

docker build -t "$IMAGE_TAG:latest" -t "$IMAGE_TAG:$VERSION_TAG" .

docker push "$IMAGE_TAG:latest"
docker push "$IMAGE_TAG:$VERSION_TAG"

# A tag naming the image ID, so a manifest or a rollback can pin the exact
# artifact rather than a moving :latest.
IMAGE_ID=$(docker images --no-trunc -q "$IMAGE_TAG:latest" | sed 's/:/_/g')
docker tag "$IMAGE_TAG:latest" "$IMAGE_TAG:$IMAGE_ID"
docker push "$IMAGE_TAG:$IMAGE_ID"
