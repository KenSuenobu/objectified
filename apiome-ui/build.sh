#!/usr/bin/env bash
#
# Builds the Docker image

BUILDPLATFORM="linux/amd64" DOCKER_REGISTRY="registry.apiome.dev" yarn docker:build:push

rm -f deploy-202*.sh docker-compose.deploy*.yml apiome-ui-*tar.gz
