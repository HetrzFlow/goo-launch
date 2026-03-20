#!/bin/bash
# scripts/lib/common.sh — Shared helpers for Docker scripts
# Source this file; do not execute directly.

# ── Output helpers ──

_color_red='\033[0;31m'
_color_green='\033[0;32m'
_color_yellow='\033[0;33m'
_color_cyan='\033[0;36m'
_color_reset='\033[0m'

info()  { echo -e "${_color_cyan}[info]${_color_reset} $*"; }
ok()    { echo -e "${_color_green}[ok]${_color_reset} $*"; }
warn()  { echo -e "${_color_yellow}[warn]${_color_reset} $*" >&2; }
fail()  { echo -e "${_color_red}[error]${_color_reset} $*" >&2; exit 1; }

# ── Prerequisite checks ──

require_cmd() {
  local cmd="$1" hint="${2:-}"
  if ! command -v "$cmd" &>/dev/null; then
    fail "'$cmd' is not installed.${hint:+ $hint}"
  fi
}

check_docker() {
  require_cmd docker "Install Docker: https://docs.docker.com/get-docker/"

  # Verify the daemon is running
  if ! docker info &>/dev/null; then
    # Try with a capped API version — common on older Docker hosts
    export DOCKER_API_VERSION=1.43
    if ! docker info &>/dev/null; then
      fail "Docker daemon is not running. Start Docker and try again."
    fi
    warn "Negotiated DOCKER_API_VERSION=1.43 (your Docker daemon may be older than the client)."
  fi

  # docker compose (v2 plugin) check
  if ! docker compose version &>/dev/null; then
    fail "'docker compose' plugin not found. Install it: https://docs.docker.com/compose/install/"
  fi
}

check_port() {
  local port="$1" label="$2"
  if ss -tlnp 2>/dev/null | grep -q ":${port} " || \
     lsof -i ":${port}" &>/dev/null; then
    warn "Port ${port} (${label}) is already in use. The container may fail to bind."
  fi
}

# ── .env loading ──

declare -A _env_defaults

load_env_defaults() {
  local env_file="$1"
  _env_defaults=()
  if [ -f "$env_file" ]; then
    info "Found existing $env_file, loading defaults..."
    while IFS= read -r line; do
      # Skip comments and blank lines
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ -z "${line// /}" ]] && continue
      # Split on first '='
      local key="${line%%=*}"
      local value="${line#*=}"
      key="${key## }"; key="${key%% }"
      # Strip surrounding quotes
      value="${value## }"; value="${value%% }"
      value="${value#\"}"; value="${value%\"}"
      value="${value#\'}"; value="${value%\'}"
      [[ -n "$key" ]] && _env_defaults["$key"]="$value"
    done < "$env_file"
    echo ""
  fi
}

# ── Interactive prompts ──

ask() {
  local var_name="$1" prompt="$2" default="${3:-}"
  local existing="${_env_defaults[$var_name]:-$default}"
  local input
  if [ -n "$existing" ]; then
    read -rp "$prompt [$existing]: " input
    printf -v "$var_name" '%s' "${input:-$existing}"
  else
    read -rp "$prompt: " input
    printf -v "$var_name" '%s' "$input"
  fi
}

ask_secret() {
  local var_name="$1" prompt="$2" default="${3:-}"
  local existing="${_env_defaults[$var_name]:-$default}"
  local input
  if [ -n "$existing" ]; then
    local masked
    if [ ${#existing} -gt 10 ]; then
      masked="${existing:0:6}...${existing: -4}"
    else
      masked="****"
    fi
    read -rp "$prompt [$masked]: " input
    printf -v "$var_name" '%s' "${input:-$existing}"
  else
    read -rp "$prompt: " input
    printf -v "$var_name" '%s' "$input"
  fi
}

# ── Mode detection ──

# Prints whether the agent will run in server-backed or fallback mode.
# Args: $1 = GOO_SERVER_URL, $2 = mode label (e.g. "BYOD" or "AGOS")
print_mode() {
  local server_url="$1" label="$2"
  echo ""
  if [ -n "$server_url" ]; then
    info "Mode: server-backed (${label} reports to $server_url)"
  else
    info "Mode: standalone/fallback (no Goo Server configured)"
  fi
}

# ── Post-start smoke checks ──

smoke_check_container() {
  local container="$1" compose_file="$2"
  echo ""
  info "Running post-start checks..."

  # Check container is actually running
  local state
  state=$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || echo "missing")
  if [ "$state" != "running" ]; then
    warn "Container '$container' is not running (state: $state)."
    echo "  Check logs:  docker compose -f $compose_file logs"
    return 1
  fi
  ok "Container '$container' is running."

  # Show image info
  local image
  image=$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || echo "unknown")
  info "Image: $image"
}

smoke_check_gateway() {
  local port="$1" token="$2" max_wait="${3:-45}"
  info "Waiting for OpenClaw gateway on port ${port} (up to ${max_wait}s)..."
  local elapsed=0
  while [ $elapsed -lt "$max_wait" ]; do
    if curl -sf "http://127.0.0.1:${port}/healthz" -o /dev/null 2>/dev/null; then
      ok "Gateway is healthy."
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  warn "Gateway not healthy after ${max_wait}s. It may still be starting (container healthcheck start_period is 90s)."
  echo "  Check:  curl http://127.0.0.1:${port}/healthz"
  return 1
}

print_runtime_summary() {
  local label="$1" gateway_port="$2" token="$3" extra_label="${4:-}" extra_value="${5:-}"
  echo ""
  echo "========================================="
  echo "  ${label} Agent is running!"
  echo "========================================="
  echo ""
  echo "  OpenClaw Gateway: http://localhost:${gateway_port}/?token=${token}"
  if [ -n "$extra_label" ] && [ -n "$extra_value" ]; then
    printf '  %-18s %s\n' "$extra_label:" "$extra_value"
  fi
  echo ""
}
