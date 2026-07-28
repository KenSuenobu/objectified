#!/usr/bin/env bash
# Build the official multi-architecture apiome-mock image (#4742, PMR-1.2).
#
# The portable runtime is meant to run wherever a team's CI and laptops live, which in practice
# means both linux/amd64 and linux/arm64. Every layer supports both: the uv builder image and the
# python:3.12-slim-bookworm runtime publish both architectures, and every wheel the runtime
# installs (psycopg[binary], grpcio, pydantic-core, uvloop, httptools) ships manylinux builds for
# both. Adding an architecture is a matter of extending PLATFORMS.
#
# Usage:
#   apiome-mock/scripts/build-image.sh ghcr.io/apiome/apiome-mock:0.3.0            # build only
#   apiome-mock/scripts/build-image.sh --push ghcr.io/apiome/apiome-mock:0.3.0     # build + push
#
# Environment:
#   PLATFORMS   Comma-separated target platforms (default: linux/amd64,linux/arm64)
#
# Notes:
#   * A multi-platform build cannot be loaded into the local Docker image store; without --push it
#     builds and discards, which is exactly what a CI "does it still build everywhere" job wants.
#     To get a locally runnable image, pass a single platform: PLATFORMS=linux/amd64 ... --load
#   * Requires docker buildx (bundled with Docker Desktop and modern Docker Engine).

set -euo pipefail

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
OUTPUT="--output=type=image"

if [[ "${1:-}" == "--push" ]]; then
  OUTPUT="--push"
  shift
elif [[ "${1:-}" == "--load" ]]; then
  OUTPUT="--load"
  shift
fi

TAG="${1:-apiome-mock:dev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is required for multi-architecture builds." >&2
  exit 1
fi

echo "Building ${TAG} for ${PLATFORMS}"
docker buildx build \
  --platform "${PLATFORMS}" \
  --file "${REPO_ROOT}/apiome-mock/Dockerfile" \
  --tag "${TAG}" \
  ${OUTPUT} \
  "${REPO_ROOT}"
