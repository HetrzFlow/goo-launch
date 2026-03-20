#!/bin/bash
# Run the preinstalled goo-core binary using the generated env file.
set -e

LOG_FILE="${GOO_CORE_LOG_FILE:-/var/log/sandbox/goo-core.log}"
ENV_FILE="${GOO_CORE_ENV:-${HOME:-/root}/.goo-core/.env}"
DATA_DIR="${DATA_DIR:-${HOME:-/root}/.goo-core/data}"
AUTO_UPDATE_GOO_CORE="${AUTO_UPDATE_GOO_CORE:-1}"
GOO_CORE_VERSION="${GOO_CORE_VERSION:-latest}"

mkdir -p "$DATA_DIR"
mkdir -p "$(dirname "$LOG_FILE")"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

if [ "$AUTO_UPDATE_GOO_CORE" = "1" ]; then
  echo "[goo-core] Updating @devbond/gc@${GOO_CORE_VERSION}..."
  npm install -g "@devbond/gc@${GOO_CORE_VERSION}" --prefer-online --fetch-retries=0 >> "$LOG_FILE" 2>&1
fi

echo "[goo-core] Starting installed goo-core..."
exec goo-core >> "$LOG_FILE" 2>&1
