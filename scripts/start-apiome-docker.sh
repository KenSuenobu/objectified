#!/usr/bin/env bash
#
# Root script for starting Apiome Docker images and keeping them up-to-date.
# Monitors the registry for new image versions every 5 minutes and redeploys
# when a newer image is available (Kubernetes-like rolling update without a cluster).
#
# Call from wrapper scripts with REGISTRY, IMAGE, ENV_FILE, PORT, etc. set as needed.
#
# Usage:
#   ./start-apiome-docker.sh           # Run in foreground (Ctrl+C to stop)
#   ./start-apiome-docker.sh --background   # Run in background, logs to $IMAGE.log

set -e

REGISTRY="${REGISTRY:-registry.apiome.dev}"
IMAGE="${IMAGE:-}"
ENV_FILE="${ENV_FILE:-}"
PORT="${PORT:-}"
CHECK_INTERVAL="${CHECK_INTERVAL:-300}"   # seconds (5 minutes)

if [[ -z "$IMAGE" ]] || [[ -z "$ENV_FILE" ]] || [[ -z "$PORT" ]]; then
  echo "Error: IMAGE, ENV_FILE, and PORT must be set (e.g. by a wrapper script)." >&2
  echo "  IMAGE=${IMAGE:-<unset>}" >&2
  echo "  ENV_FILE=${ENV_FILE:-<unset>}" >&2
  echo "  PORT=${PORT:-<unset>}" >&2
  exit 1
fi

LOG_FILE="${LOG_FILE:-$(dirname "$0")/${IMAGE}.log}"

# Full image reference
IMAGE_REF="${REGISTRY}/${IMAGE}:latest"

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}

# Performs full deploy: login, stop, rm, pull, run
deploy() {
  log "Deploying ${IMAGE_REF}..."
  docker login "$REGISTRY" -u "$DOCKER_USERNAME" -p "$DOCKER_PASSWORD"
  docker stop "$IMAGE" 2>/dev/null || true
  docker rm "$IMAGE" 2>/dev/null || true
  docker pull "$IMAGE_REF"
  docker run -d -p "$PORT:$PORT" --env-file "$ENV_FILE" --network host --name "$IMAGE" "$IMAGE_REF"
  log "Deployed ${IMAGE_REF} (container: $IMAGE, port: $PORT)."
}

# Check for image update and redeploy if newer image is available
check_and_update() {
  docker login "$REGISTRY" -u "$DOCKER_USERNAME" -p "$DOCKER_PASSWORD" 2>/dev/null || true
  docker pull "$IMAGE_REF" 2>/dev/null || true

  CURRENT_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$IMAGE" 2>/dev/null || true)
  LATEST_IMAGE_ID=$(docker image inspect "$IMAGE_REF" --format '{{.Id}}' 2>/dev/null || true)

  if [[ -z "$LATEST_IMAGE_ID" ]]; then
    log "Could not inspect ${IMAGE_REF}; skipping this cycle."
    return
  fi

  if [[ "$CURRENT_IMAGE_ID" != "$LATEST_IMAGE_ID" ]]; then
    log "Update detected (current: ${CURRENT_IMAGE_ID:-none}, latest: ${LATEST_IMAGE_ID}). Redeploying..."
    docker stop "$IMAGE" 2>/dev/null || true
    docker rm "$IMAGE" 2>/dev/null || true
    docker run -d -p "$PORT:$PORT" --env-file "$ENV_FILE" --network host --name "$IMAGE" "$IMAGE_REF"
    log "Redeploy complete."
  else
    log "No update (image ID: ${LATEST_IMAGE_ID})."
  fi
}

run_loop() {
  deploy
  while true; do
    sleep "$CHECK_INTERVAL"
    check_and_update
  done
}

main() {
  if [[ "${1:-}" == "--background" ]] || [[ "${1:-}" == "-b" ]]; then
    log "Starting in background; logging to ${LOG_FILE}"
    nohup "$0" >> "$LOG_FILE" 2>&1 &
    echo $! > "$(dirname "$0")/${IMAGE}.pid"
    echo "Monitor started in background (PID: $!). Log: $LOG_FILE"
    exit 0
  fi
  run_loop
}

main "$@"
