#!/bin/bash
# docker-run.sh — Pull pre-built image from registry and start the container.
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

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

info "Pulling image and starting container..."

cd "$ROOT_DIR"

docker compose -f "$COMPOSE_FILE" pull
docker compose -f "$COMPOSE_FILE" up -d

ok "Container started. Logs: docker compose -f $COMPOSE_FILE logs -f"
