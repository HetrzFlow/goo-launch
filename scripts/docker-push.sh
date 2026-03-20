#!/bin/bash
# docker-push.sh — Push a built Docker image to the registry.
# Reads DOCKER_IMAGE from deploy/docker/.env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/docker/.env"

# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

if [ ! -f "$ENV_FILE" ]; then
  fail "$ENV_FILE not found. Copy from .env.example and fill in your values."
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

DOCKER_IMAGE="${DOCKER_IMAGE:-hgamiui9/goo-agos:v0.1.2}"

info "Pushing: $DOCKER_IMAGE"
docker push "$DOCKER_IMAGE"
ok "Pushed: $DOCKER_IMAGE"
