#!/bin/bash
# byod-setup.sh — One-command BYOD agent setup.
# Downloads docker-compose.yml from the repo and starts the container.
#
# Usage:
#   1. Download .env from the launch wizard (or create manually)
#   2. Run: curl -fsSL https://raw.githubusercontent.com/hyang74/goo-example/main/deploy/docker/byod-setup.sh | bash
#
# Expects .env in the current directory.
set -euo pipefail

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()  { echo -e "${CYAN}[info]${RESET} $*"; }
ok()    { echo -e "${GREEN}[ok]${RESET} $*"; }
fail()  { echo -e "${RED}[error]${RESET} $*" >&2; exit 1; }

# ── Prereqs ──
command -v docker &>/dev/null || fail "Docker is not installed. Install: https://docs.docker.com/get-docker/"
docker info &>/dev/null 2>&1 || fail "Docker daemon is not running. Start Docker and try again."
docker compose version &>/dev/null 2>&1 || fail "'docker compose' plugin not found. Install: https://docs.docker.com/compose/install/"

# ── Locate .env ──
ENV_FILE="${1:-.env}"
if [ ! -f "$ENV_FILE" ]; then
  fail ".env not found in current directory. Download it from the launch wizard first."
fi

info "Using env file: $ENV_FILE"

# ── Create work directory ──
WORK_DIR="${GOO_DIR:-goo-agent}"
mkdir -p "$WORK_DIR"
cp "$ENV_FILE" "$WORK_DIR/.env"

# ── Download docker-compose.yml ──
REPO_RAW="https://raw.githubusercontent.com/hyang74/goo-example/main/deploy/docker"
COMPOSE_FILE="$WORK_DIR/docker-compose.yml"

info "Downloading docker-compose.yml..."
curl -fsSL "$REPO_RAW/docker-compose.yml" -o "$COMPOSE_FILE" || fail "Failed to download docker-compose.yml"

# ── Load env and start ──
set -a
# shellcheck source=/dev/null
source "$WORK_DIR/.env"
set +a

info "Pulling image and starting container..."
cd "$WORK_DIR"
docker compose pull
docker compose up -d

CONTAINER="${CONTAINER_NAME:-goo-agent}"

ok "Container started!"
echo ""
echo "========================================="
echo "  Goo Agent is running!"
echo "========================================="
echo ""
echo "  Logs:      docker compose -f $COMPOSE_FILE logs -f"
echo "  goo-core:  docker exec $CONTAINER tail -f /var/log/sandbox/goo-core.log"
echo "  Stop:      docker compose -f $COMPOSE_FILE down"
echo ""
