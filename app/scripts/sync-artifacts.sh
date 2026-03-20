#!/usr/bin/env bash
# Sync compiled Hardhat artifacts from contracts/ into app/src/artifacts/
# Run automatically as part of `bun run build` / `bun run deploy`
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$APP_DIR")"

CONTRACTS_ARTIFACTS="$REPO_ROOT/contracts/artifacts/goo-contracts/src"
APP_ARTIFACTS="$APP_DIR/src/artifacts"

ARTIFACTS=(
  "GooAgentToken.sol/GooAgentToken.json"
  "GooAgentRegistry.sol/GooAgentRegistry.json"
)

updated=0
for artifact in "${ARTIFACTS[@]}"; do
  src="$CONTRACTS_ARTIFACTS/$artifact"
  dst="$APP_ARTIFACTS/$(basename "$artifact")"

  if [ ! -f "$src" ]; then
    echo "[sync-artifacts] WARNING: $src not found — run 'cd contracts && bun run compile' first"
    continue
  fi

  if [ ! -f "$dst" ] || ! diff -q "$src" "$dst" > /dev/null 2>&1; then
    cp "$src" "$dst"
    echo "[sync-artifacts] Updated $(basename "$artifact")"
    updated=$((updated + 1))
  fi
done

if [ "$updated" -eq 0 ]; then
  echo "[sync-artifacts] All artifacts up to date"
fi
