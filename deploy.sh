#!/bin/bash
set -ex
cd $(dirname "${BASH_SOURCE[0]}")

# Install dependencies
yarn

# Build
yarn run build

# Build image
VERSION=$(printf "%05d" $BUILDKITE_BUILD_NUMBER)_$(date +%Y-%m-%d)_$(git rev-parse --short HEAD)
docker build -t sourcegraph/lang-typescript:$VERSION .

# Upload to Docker Hub
docker push sourcegraph/lang-typescript:$VERSION
docker tag sourcegraph/lang-typescript:$VERSION sourcegraph/lang-typescript:latest
docker push sourcegraph/lang-typescript:latest
docker tag sourcegraph/lang-typescript:$VERSION sourcegraph/lang-typescript:insiders
docker push sourcegraph/lang-typescript:insiders

