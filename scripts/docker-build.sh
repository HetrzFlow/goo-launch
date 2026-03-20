#!/bin/bash
# docker-build.sh — Build Docker image from source and start the container.
# Reads config from deploy/docker/.env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deploy/docker"
ENV_FILE="$DEPLOY_DIR/.env"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"

# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

check_docker

if [ ! -f "$ENV_FILE" ]; then
  fail "$ENV_FILE not found. Copy from .env.example and fill in your values."
fi

# Export all vars so docker compose can see them
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

DOCKER_IMAGE="${DOCKER_IMAGE:-hgamiui9/goo-agos:v0.1.2}"

info "Building image: $DOCKER_IMAGE"

cd "$ROOT_DIR"

docker build \
  -f deploy/docker/Dockerfile \
  --network host \
  --build-arg http_proxy="${HTTP_PROXY:-}" \
  --build-arg https_proxy="${HTTPS_PROXY:-}" \
  --build-arg all_proxy="${ALL_PROXY:-}" \
  --build-arg GC_VERSION="${GC_VERSION:-latest}" \
  -t "$DOCKER_IMAGE" \
  .

ok "Built: $DOCKER_IMAGE"

info "Starting container..."
docker compose -f "$COMPOSE_FILE" up -d

ok "Container started. Logs: docker compose -f $COMPOSE_FILE logs -f"
