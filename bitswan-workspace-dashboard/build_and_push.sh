#!/bin/bash

# Get Year and Commit Hash
YEAR=$(date +%Y)
COMMIT_HASH=$(git rev-parse --short HEAD)
IMAGE_TAG="bitswan/workspace-dashboard-staging"
IMAGE_TAG_PROD="bitswan/workspace-dashboard"

# Build and push Docker images
docker build -t $IMAGE_TAG:latest -t $IMAGE_TAG:$YEAR-${GITHUB_RUN_ID}-git-$COMMIT_HASH -t $IMAGE_TAG_PROD:latest -t $IMAGE_TAG_PROD:$YEAR-${GITHUB_RUN_ID}-git-$COMMIT_HASH -f ./Dockerfile .

docker push $IMAGE_TAG:latest
docker push $IMAGE_TAG:$YEAR-${GITHUB_RUN_ID}-git-$COMMIT_HASH

docker push $IMAGE_TAG_PROD:latest
docker push $IMAGE_TAG_PROD:$YEAR-${GITHUB_RUN_ID}-git-$COMMIT_HASH

# Push a tag with the image ID
IMAGE_ID=$(docker images --no-trunc -q $IMAGE_TAG:latest | sed 's/:/_/g')
docker tag $IMAGE_TAG:latest $IMAGE_TAG:$IMAGE_ID
docker push $IMAGE_TAG:$IMAGE_ID

docker tag $IMAGE_TAG_PROD:latest $IMAGE_TAG_PROD:$IMAGE_ID
docker push $IMAGE_TAG_PROD:$IMAGE_ID
