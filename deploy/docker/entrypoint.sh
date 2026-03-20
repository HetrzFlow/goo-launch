#!/bin/bash
# Goo Agent entrypoint — OpenClaw gateway + goo-core sidecar + optional control API.
set -e

TOKEN="${OPENCLAW_TOKEN:-${OPENCLAW_GATEWAY_TOKEN:-my-gateway-token}}"
GW_PORT="${GATEWAY_PORT:-18789}"
OPENCLAW_DIR="${HOME:-/root}/.openclaw"
LOG_DIR="/var/log/sandbox"
GOO_CORE_DIR="${HOME:-/root}/.goo-core"
GOO_CORE_ENV="${GOO_CORE_DIR}/.env"
DATA_DIR="${DATA_DIR:-${GOO_CORE_DIR}/data}"

mkdir -p "$LOG_DIR" "$OPENCLAW_DIR/workspace" "$OPENCLAW_DIR/logs" "$DATA_DIR"
echo "[start] Goo Agent startup at $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee "$LOG_DIR/startup.log"
echo "[start] AGENT_ID=${AGENT_ID:-unset} AGENT_NAME=${AGENT_NAME:-unset}" >> "$LOG_DIR/startup.log"

# --- 0. Fetch agent config from server API ---
AGENT_DISPLAY_NAME="${AGENT_NAME:-Goo Agent}"
AGENT_CUSTOM_INSTRUCTIONS=""
AGOS_AGENT_API_KEY_VALUE="${AGOS_AGENT_API_KEY:-}"

if [ -n "${GOO_SERVER_URL:-}" ] && [ -n "${AGENT_ID:-}" ] && [ -n "${AGENT_RUNTIME_TOKEN:-}" ]; then
  CONFIG_URL="${GOO_SERVER_URL}/api/agents/${AGENT_ID}/runtime-config?token=${AGENT_RUNTIME_TOKEN}"
  echo "[entrypoint] Fetching agent config from ${GOO_SERVER_URL}..."

  CONFIG_JSON=$(node -e "
    fetch('${CONFIG_URL}')
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(cfg => process.stdout.write(JSON.stringify(cfg)))
      .catch(e => {
        process.stderr.write('[entrypoint] Config fetch failed: ' + e.message + '\n');
        process.exit(1);
      });
  " 2>&1) || CONFIG_JSON=""

  if [ -n "$CONFIG_JSON" ]; then
    AGENT_DISPLAY_NAME=$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.agent_name||'Goo Agent')" "$CONFIG_JSON" 2>/dev/null || echo "Goo Agent")
    AGOS_AGENT_API_KEY_VALUE=$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.agos_agent_api_key||'')" "$CONFIG_JSON" 2>/dev/null || true)
    LLM_API_URL_VALUE=$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.llm_api_url||'')" "$CONFIG_JSON" 2>/dev/null || true)
    LLM_PROVIDER_VALUE=$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.llm_provider||'')" "$CONFIG_JSON" 2>/dev/null || true)
    LLM_MODEL_VALUE=$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.llm_model||'')" "$CONFIG_JSON" 2>/dev/null || true)
    AGENT_CUSTOM_INSTRUCTIONS=$(node -e "
      const c=JSON.parse(process.argv[1]);
      const fs=require('fs');
      const dir='${DATA_DIR}';
      const files=[
        ['soul.md', c.genesis_prompt],
        ['agent.md', c.agent_instructions || c.agent_intro],
        ['skills.md', c.skills_content],
        ['memory.md', c.memory_content],
      ];
      for (const [name, content] of files) {
        const path = dir + '/' + name;
        if (content && content.trim()) fs.writeFileSync(path, content);
      }
      const parts=[
        c.genesis_prompt,
        c.agent_instructions || c.agent_intro,
        c.skills_content ? '## Skills\n\n' + c.skills_content : null,
        c.memory_content ? '## Initial Knowledge\n\n' + c.memory_content : null,
      ].filter(Boolean);
      process.stdout.write(parts.join('\n\n'));
    " "$CONFIG_JSON" 2>/dev/null || true)
  else
    echo "[start] Config fetch failed, using env var fallbacks" | tee -a "$LOG_DIR/startup.log"
  fi
else
  echo "[start] No GOO_SERVER_URL configured, using env var fallbacks" | tee -a "$LOG_DIR/startup.log"
fi

# --- 0.5. Resolve LLM configuration ---
# Priority: AGOS key > env OPENAI_API_KEY (or legacy LLM_API_KEY) > runtime-config llm_api_url
OPENAI_API_KEY="${OPENAI_API_KEY:-${LLM_API_KEY:-}}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-${LLM_API_URL:-}}"
if [ -n "$AGOS_AGENT_API_KEY_VALUE" ]; then
  RESOLVED_LLM_URL="${AGOS_API_BASE_URL:-https://claw-api.agos.fun}/v1"
  RESOLVED_LLM_KEY="$AGOS_AGENT_API_KEY_VALUE"
  RESOLVED_LLM_PROVIDER="agos"
elif [ -n "${OPENAI_API_KEY:-}" ]; then
  RESOLVED_LLM_URL="${LLM_API_URL_VALUE:-${OPENAI_BASE_URL:-https://openrouter.ai/api/v1}}"
  RESOLVED_LLM_KEY="${OPENAI_API_KEY}"
  RESOLVED_LLM_PROVIDER="${LLM_PROVIDER_VALUE:-direct}"
else
  RESOLVED_LLM_URL=""
  RESOLVED_LLM_KEY=""
  RESOLVED_LLM_PROVIDER=""
fi

if [ -n "$RESOLVED_LLM_KEY" ]; then
  echo "[start] LLM provider: ${RESOLVED_LLM_PROVIDER} (${RESOLVED_LLM_URL})" | tee -a "$LOG_DIR/startup.log"
else
  echo "[start] No LLM key configured (AGOS_AGENT_API_KEY and OPENAI_API_KEY both unset)" | tee -a "$LOG_DIR/startup.log"
fi

# --- 0.9. Patch workspace template variables ---
INSPECT_PORT="${INSPECT_PORT:-19800}"
DOCS_TEMPLATE="${OPENCLAW_DIR}/docs-template"
if [ -d "$DOCS_TEMPLATE" ]; then
  find "$DOCS_TEMPLATE" -mindepth 1 | while read -r src; do
    rel="${src#$DOCS_TEMPLATE/}"
    target="${OPENCLAW_DIR}/workspace/${rel}"
    if [ -d "$src" ]; then
      mkdir -p "$target"
      continue
    fi
    case "$rel" in
      MEMORY.md|BOOTSTRAP.md)
        [ -f "$target" ] && continue
        ;;
    esac
    mkdir -p "$(dirname "$target")"
    cp -f "$src" "$target"
  done
fi
# Init git in workspace so .gitignore is respected by OpenClaw (prevents node_modules etc. from polluting context)
if [ ! -d "${OPENCLAW_DIR}/workspace/.git" ]; then
  (cd "${OPENCLAW_DIR}/workspace" && git init -q && git config user.email "agent@goo.fun" && git config user.name "goo-agent" && git add -A && git commit -q -m "init" --allow-empty) 2>/dev/null || true
fi
PRIVATE_KEY_FILE=""
if [ -n "${WALLET_PRIVATE_KEY:-}" ]; then
  PRIVATE_KEY_FILE="${DATA_DIR}/wallet/private-key"
  umask 077
  mkdir -p "$(dirname "$PRIVATE_KEY_FILE")"
  printf '%s\n' "$WALLET_PRIVATE_KEY" > "$PRIVATE_KEY_FILE"
  chmod 600 "$PRIVATE_KEY_FILE"
fi

WALLET_ADDRESS=""
if [ -n "$PRIVATE_KEY_FILE" ]; then
  WALLET_ADDRESS=$(PRIVATE_KEY_FILE="$PRIVATE_KEY_FILE" node --input-type=module -e "
    import { readFileSync } from 'fs';
    import { Wallet } from '/usr/local/lib/node_modules/@devbond/gc/node_modules/ethers/lib.esm/ethers.js';
    process.stdout.write(new Wallet(readFileSync(process.env.PRIVATE_KEY_FILE, 'utf8').trim()).address);
  " 2>/dev/null || true)
fi

node -e "
  const fs = require('fs');
  const path = require('path');
  const dir = '${OPENCLAW_DIR}/workspace';
  if (!fs.existsSync(dir)) process.exit(0);
  const vars = {
    inspectPort: '${INSPECT_PORT}',
    tokenAddress: '${TOKEN_ADDRESS:-}',
    walletAddress: '${WALLET_ADDRESS:-}',
    chainId: '${CHAIN_ID:-97}',
    rpcUrl: '${RPC_URL:-}',
    agentName: $(node -e "process.stdout.write(JSON.stringify('${AGENT_DISPLAY_NAME}'))" 2>/dev/null || echo '"Goo Agent"'),
    'uploads.soul': $(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('${DATA_DIR}/soul.md','utf8')))" 2>/dev/null || echo '""'),
    'uploads.agent': $(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('${DATA_DIR}/agent.md','utf8')))" 2>/dev/null || echo '""'),
    'uploads.skills': $(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('${DATA_DIR}/skills.md','utf8')))" 2>/dev/null || echo '""'),
    'uploads.memory': $(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('${DATA_DIR}/memory.md','utf8')))" 2>/dev/null || echo '""'),
  };
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const fp = path.join(dir, f);
    let content = fs.readFileSync(fp, 'utf8');
    for (const [k, v] of Object.entries(vars)) {
      content = content.split('{{' + k + '}}').join(v || '');
    }
    fs.writeFileSync(fp, content);
  }
  console.log('[start] Patched workspace docs: ' + Object.keys(vars).filter(k => vars[k]).join(', '));
" 2>&1 | tee -a "$LOG_DIR/startup.log"

# --- 1. Patch openclaw.json ---
echo "[start] Patching openclaw.json (agent: ${AGENT_DISPLAY_NAME})..." | tee -a "$LOG_DIR/startup.log"
AGENT_DISPLAY_NAME="$AGENT_DISPLAY_NAME" \
AGENT_CUSTOM_INSTRUCTIONS="$AGENT_CUSTOM_INSTRUCTIONS" \
OPENCLAW_DIR="$OPENCLAW_DIR" \
RESOLVED_LLM_URL="$RESOLVED_LLM_URL" \
RESOLVED_LLM_KEY="$RESOLVED_LLM_KEY" \
RESOLVED_LLM_PROVIDER="$RESOLVED_LLM_PROVIDER" \
OPENCLAW_MODEL="${LLM_MODEL_VALUE:-${OPENCLAW_MODEL:-claude-sonnet-4-6}}" \
node -e "
const fs = require('fs');
const path = process.env.OPENCLAW_DIR + '/openclaw.json';
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
let model = process.env.OPENCLAW_MODEL || 'claude-sonnet-4-6';
if (!model.includes('/')) model = 'agos/' + model.toLowerCase();
// For direct LLM, remap agos/ prefix to openai/
if (process.env.RESOLVED_LLM_PROVIDER !== 'agos' && model.startsWith('agos/')) {
  model = 'openai/' + model.split('/').slice(1).join('/');
}
cfg.agents.defaults.model.primary = model;
cfg.agents.list[0].identity.name = process.env.AGENT_DISPLAY_NAME || 'Goo Agent';
cfg.agents.list[0].workspace = process.env.OPENCLAW_DIR + '/workspace';
cfg.agents.list[0].model.primary = model;
const providerName = model.split('/')[0];
const modelId = model.split('/').slice(1).join('/');
const baseUrl = (process.env.RESOLVED_LLM_URL || 'https://claw-api.agos.fun/v1').replace(/\/+$/, '');
// Update provider config (rename key from agos if needed)
const oldProvider = cfg.models.providers.agos;
delete cfg.models.providers.agos;
cfg.models.providers[providerName] = oldProvider;
cfg.models.providers[providerName].baseUrl = baseUrl.endsWith('/v1') ? baseUrl : baseUrl + '/v1';
cfg.models.providers[providerName].apiKey = process.env.RESOLVED_LLM_KEY || 'dummy';
cfg.models.providers[providerName].models[0].id = modelId;
// Set model display name and reasoning flag
var modelNames = {
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'gpt-5.4': 'GPT-5.4',
  'kimi-k2.5': 'Kimi K2.5',
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
};
var reasoningModels = ['deepseek-reasoner', 'kimi-k2.5'];
cfg.models.providers[providerName].models[0].name = modelNames[modelId] || modelId;
cfg.models.providers[providerName].models[0].reasoning = reasoningModels.includes(modelId);
if (baseUrl.includes('openai.com')) cfg.models.providers[providerName].api = 'openai-responses';
else cfg.models.providers[providerName].api = 'openai-completions';
// Write CLAUDE.md: docs-template base (OpenClaw identity) + creator instructions appended
var wsDir = process.env.OPENCLAW_DIR + '/workspace';
fs.mkdirSync(wsDir, { recursive: true });
var claudePath = wsDir + '/CLAUDE.md';
var templatePath = process.env.OPENCLAW_DIR + '/docs-template/CLAUDE.md';
var base = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '';
if (process.env.AGENT_CUSTOM_INSTRUCTIONS) {
  // If template has {{uploads.customInstructions}} placeholder, replace it; otherwise append
  if (base.includes('{{uploads.customInstructions}}')) {
    base = base.split('{{uploads.customInstructions}}').join(process.env.AGENT_CUSTOM_INSTRUCTIONS);
  } else if (base) {
    base = base + '\n\n' + process.env.AGENT_CUSTOM_INSTRUCTIONS;
  } else {
    base = process.env.AGENT_CUSTOM_INSTRUCTIONS;
  }
}
if (base) fs.writeFileSync(claudePath, base);
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
" 2>&1 | tee -a "$LOG_DIR/startup.log"

# --- 2. Start OpenClaw gateway + control-server ---
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

# When CONTROL_PORT is set, control-server sits in front of the gateway on GW_PORT.
# Gateway listens on an internal port; control-server reverse-proxies non-/control/* to it.
if [ -n "${CONTROL_PORT:-}" ] && [ -f "${OPENCLAW_DIR}/control-server.mjs" ] && [ -n "${AGENT_RUNTIME_TOKEN:-}" ]; then
  GATEWAY_INTERNAL_PORT="19791"
  echo "[start] Starting OpenClaw gateway on internal :${GATEWAY_INTERNAL_PORT}..." | tee -a "$LOG_DIR/startup.log"
  openclaw gateway \
    --allow-unconfigured \
    --bind lan \
    --auth token \
    --token "$TOKEN" \
    --port "$GATEWAY_INTERNAL_PORT" \
    >> "$LOG_DIR/gateway.log" 2>&1 &
  GATEWAY_PID=$!

  echo "[start] Starting control-server (reverse proxy) on :${GW_PORT}..." | tee -a "$LOG_DIR/startup.log"
  CONTROL_PORT="${GW_PORT}" \
  GATEWAY_INTERNAL_PORT="${GATEWAY_INTERNAL_PORT}" \
    node "${OPENCLAW_DIR}/control-server.mjs" >> "$LOG_DIR/control.log" 2>&1 &
  CONTROL_PID=$!
  sleep 1
else
  echo "[start] Starting OpenClaw gateway on :${GW_PORT}..." | tee -a "$LOG_DIR/startup.log"
  openclaw gateway \
    --allow-unconfigured \
    --bind lan \
    --auth token \
    --token "$TOKEN" \
    --port "$GW_PORT" \
    >> "$LOG_DIR/gateway.log" 2>&1 &
  GATEWAY_PID=$!
fi

# --- 3. Start cloudflared tunnel (AGOS agents need a stable HTTPS URL for CF Workers) ---
if command -v cloudflared >/dev/null 2>&1 && [ -n "${GOO_SERVER_URL:-}" ] && [ -n "${AGENT_ID:-}" ] && [ -n "${AGENT_RUNTIME_TOKEN:-}" ]; then
  TUNNEL_LOG="/tmp/cloudflared.log"
  TUNNEL_PORT="${GW_PORT}"
  if [ -n "${GATEWAY_INTERNAL_PORT:-}" ]; then
    # control-server is on GW_PORT, proxy tunnel to that
    TUNNEL_PORT="${GW_PORT}"
  fi
  echo "[start] Starting cloudflared tunnel to :${TUNNEL_PORT}..." | tee -a "$LOG_DIR/startup.log"
  cloudflared tunnel --url "http://127.0.0.1:${TUNNEL_PORT}" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  # Wait for tunnel URL (up to 15s)
  TUNNEL_URL=""
  for i in $(seq 1 15); do
    sleep 1
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
    if [ -n "$TUNNEL_URL" ]; then break; fi
  done

  if [ -n "$TUNNEL_URL" ]; then
    echo "[start] Cloudflared tunnel: ${TUNNEL_URL}" | tee -a "$LOG_DIR/startup.log"
    # Report tunnel URL back to goo-server
    node -e "
      fetch('${GOO_SERVER_URL}/api/agents/${AGENT_ID}/report-gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ${AGENT_RUNTIME_TOKEN}' },
        body: JSON.stringify({ gateway_url: '${TUNNEL_URL}' }),
      })
        .then(r => r.json())
        .then(j => console.log('[start] Reported tunnel URL:', JSON.stringify(j)))
        .catch(e => console.error('[start] Failed to report tunnel URL:', e.message));
    " 2>&1 | tee -a "$LOG_DIR/startup.log"
  else
    echo "[start] cloudflared tunnel failed to start (no URL after 15s)" | tee -a "$LOG_DIR/startup.log"
    cat "$TUNNEL_LOG" >> "$LOG_DIR/startup.log" 2>/dev/null || true
  fi
fi

# --- 3.5. Configure npm proxy if set ---
if [ -n "${http_proxy:-}" ]; then
  npm config set proxy "$http_proxy" 2>/dev/null || true
  npm config set https-proxy "${https_proxy:-$http_proxy}" 2>/dev/null || true
fi

# --- 4. Write goo-core env + start sidecar ---
HEARTBEAT_MS="${HEARTBEAT_INTERVAL_MS:-120000}"
cat > "$GOO_CORE_ENV" <<EOF
RPC_URL=${RPC_URL:-}
CHAIN_ID=${CHAIN_ID:-97}
TOKEN_ADDRESS=${TOKEN_ADDRESS:-}
AGENT_PRIVATE_KEY_FILE=${PRIVATE_KEY_FILE:-}
ROUTER_ADDRESS=${ROUTER_ADDRESS:-}
REGISTRY_ADDRESS=${REGISTRY_ADDRESS:-}
OPENAI_BASE_URL=${RESOLVED_LLM_URL}
OPENAI_API_KEY=${RESOLVED_LLM_KEY}
LLM_MODEL=${LLM_MODEL_VALUE:-${LLM_MODEL:-deepseek-chat}}
HEARTBEAT_INTERVAL_MS=${HEARTBEAT_MS}
MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS:-3}
DATA_DIR=${DATA_DIR}
WORKSPACE_DIR=${OPENCLAW_DIR}/workspace
INSPECT_PORT=${INSPECT_PORT:-19800}
WORKSPACE_MANAGED=1
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:${GATEWAY_INTERNAL_PORT:-${GW_PORT}}
OPENCLAW_GATEWAY_TOKEN=${TOKEN}
EOF

HAS_SIGNING_KEY="false"
if [ -n "${PRIVATE_KEY_FILE:-}" ]; then
  HAS_SIGNING_KEY="true"
fi

if [ -n "$TOKEN_ADDRESS" ] && [ "$HAS_SIGNING_KEY" = "true" ] && [ -n "${RESOLVED_LLM_KEY:-}" ]; then
  echo "[start] Starting goo-core sidecar..." | tee -a "$LOG_DIR/startup.log"
  GOO_CORE_ENV="$GOO_CORE_ENV" \
  GOO_CORE_LOG_FILE="$LOG_DIR/goo-core.log" \
    bash "${OPENCLAW_DIR}/goo-core-wrapper.sh" &
  GOO_CORE_PID=$!
else
  GOO_CORE_PID=""
  echo "[start] Missing TOKEN_ADDRESS, WALLET_PRIVATE_KEY, or LLM API key — skipping goo-core" | tee -a "$LOG_DIR/startup.log"
fi

cleanup() {
  if [ -n "${GOO_CORE_PID:-}" ]; then
    kill "$GOO_CORE_PID" 2>/dev/null || true
  fi
  if [ -n "${CONTROL_PID:-}" ]; then
    kill "$CONTROL_PID" 2>/dev/null || true
  fi
  if [ -n "${TUNNEL_PID:-}" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  kill "$GATEWAY_PID" 2>/dev/null || true
  exit
}

trap cleanup INT TERM
wait "$GATEWAY_PID"
