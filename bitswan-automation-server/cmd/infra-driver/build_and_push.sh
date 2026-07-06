#!/bin/bash
# Build + publish the infra-driver image, matching the versioned scheme used by
# gitops/workspace-dashboard/coding-agent: three tags on the -staging repo
# (:latest, :$YEAR-$RUNID-git-$HASH, :$IMAGE_ID). The version tag is what
# dockerhub.ResolveInfraDriverImage(staging) pins.
# Run from the bitswan-automation-server module root (build context = ".").
set -euo pipefail
YEAR=$(date +%Y)
COMMIT_HASH=$(git rev-parse --short HEAD)
IMAGE_TAG="bitswan/infra-driver-staging"

docker build -t $IMAGE_TAG:latest -t $IMAGE_TAG:$YEAR-${GITHUB_RUN_ID}-git-$COMMIT_HASH -f ./cmd/infra-driver/Dockerfile .

docker push $IMAGE_TAG:latest
docker push $IMAGE_TAG:$YEAR-${GITHUB_RUN_ID}-git-$COMMIT_HASH

# Push a tag with the image ID
IMAGE_ID=$(docker images --no-trunc -q $IMAGE_TAG:latest | sed 's/:/_/g')
docker tag $IMAGE_TAG:latest $IMAGE_TAG:$IMAGE_ID
docker push $IMAGE_TAG:$IMAGE_ID
