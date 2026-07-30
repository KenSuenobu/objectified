#!/usr/bin/env bash
#
# Builds the Docker image

BUILDPLATFORM="linux/amd64" DOCKER_REGISTRY="registry.apiome.dev" yarn docker:build:push
rm -f deploy-*.sh
rm -f apiome-browse*tar.gz
rm -f docker-compose*deploy*yml
