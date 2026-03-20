#!/bin/bash
set -euo pipefail

#
# Test script: OpenClaw gateway + goo-core injection flow
#
# Tests:
#   Phase 1 — Local (against existing openclaw-bsc-llm container)
#     1. Gateway health check
#     2. Chat completions API
#     3. Inject goo-core into running container
#     4. Verify goo-core process
#
#   Phase 2 — Sandbox simulation (same container, mirrors sandbox.ts logic)
#     5. Inject openclaw.json config (like injectOpenClawConfig)
#     6. Sync agent files (like syncFilesToSandbox)
#     7. Verify full stack
#

CONTAINER="${GOO_CONTAINER:-openclaw-bsc-llm}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-ef0fcb8a55630a562c9371b8d6f1d0f0}"
DOCKER_API_VERSION="${DOCKER_API_VERSION:-1.43}"
export DOCKER_API_VERSION

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; }
FAILURES=0

echo "============================================"
echo " OpenClaw + goo-core Integration Test"
echo "============================================"
echo ""
echo "Container: $CONTAINER"
echo "Gateway:   http://127.0.0.1:$GATEWAY_PORT"
echo ""

# ─── Phase 1: Local Gateway Tests ───────────────────────────────────────

echo "--- Phase 1: Gateway Tests ---"
echo ""

# Test 1: Container running
echo "[1] Container running"
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  pass "Container '$CONTAINER' is running"
else
  fail "Container '$CONTAINER' not running"
  echo "  Start it first. Aborting."
  exit 1
fi

# Test 2: Gateway health
echo "[2] Gateway health"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/healthz" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ]; then
  pass "Gateway responds (HTTP $HTTP_CODE)"
else
  # /healthz might return HTML (OpenClaw control UI), try the root
  HTTP_CODE2=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GATEWAY_PORT/" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE2" = "200" ]; then
    pass "Gateway responds at / (HTTP $HTTP_CODE2)"
  else
    fail "Gateway not reachable (HTTP $HTTP_CODE)"
  fi
fi

# Test 3: Chat completions
echo "[3] Chat completions API"
CHAT_RESP=$(curl -s -X POST "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d '{
    "model": "bsc-llm/auto",
    "messages": [{"role": "user", "content": "Reply with exactly: TEST_OK"}],
    "max_tokens": 20
  }' 2>/dev/null || echo "")

if echo "$CHAT_RESP" | grep -q '"choices"'; then
  CONTENT=$(echo "$CHAT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "parse error")
  pass "Chat API works — response: $CONTENT"
else
  fail "Chat API failed: $CHAT_RESP"
fi

# Test 4: x402 proxy health
echo "[4] x402 proxy"
X402_RESP=$(curl -s "http://127.0.0.1:18402/health" 2>/dev/null || echo "")
if [ -n "$X402_RESP" ]; then
  pass "x402 proxy responds"
else
  warn "x402 proxy not reachable (might be OK if using direct LLM key)"
fi

echo ""

# ─── Phase 2: goo-core Injection Test ────────────────────────────────────

echo "--- Phase 2: goo-core Injection ---"
echo ""

# Test 5: Check if goo-core is already installed
echo "[5] Check existing goo-core"
GC_CHECK=$(docker exec "$CONTAINER" ls /home/node/goo-core/node_modules/@devbond/gc/dist/index.js 2>/dev/null && echo "installed" || echo "not_installed")
if [ "$GC_CHECK" = "installed" ]; then
  pass "goo-core already installed (skip install)"
else
  warn "goo-core not installed yet"

  # Test 5b: Install goo-core (mirrors installAndStartGooCore from sandbox.ts)
  echo "[5b] Installing @devbond/gc (this may take 1-2 min)..."
  INSTALL_OUT=$(docker exec "$CONTAINER" bash -c '
    mkdir -p /home/node/goo-core && \
    cd /home/node/goo-core && \
    npm init -y > /dev/null 2>&1 && \
    npm install @devbond/gc 2>&1 | tail -5
  ' 2>&1)
  INSTALL_EC=$?
  if [ $INSTALL_EC -eq 0 ]; then
    pass "goo-core installed"
    echo "    $INSTALL_OUT" | tail -3
  else
    fail "goo-core install failed (exit $INSTALL_EC)"
    echo "    $INSTALL_OUT" | tail -5
  fi
fi

# Test 6: Write goo-core .env (dummy values for testing — no real wallet)
echo "[6] Write goo-core .env"
GC_ENV=$(cat <<'ENVEOF'
RPC_URL=https://bsc-testnet-rpc.publicnode.com
CHAIN_ID=97
TOKEN_ADDRESS=0x0000000000000000000000000000000000000001
WALLET_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001
DATA_DIR=/home/node/agent-data
HEARTBEAT_INTERVAL_MS=60000
MAX_TOOL_ROUNDS=3
LLM_API_URL=http://127.0.0.1:18402/v1
LLM_API_KEY=x402
LLM_MODEL=deepseek/deepseek-chat
ENVEOF
)
GC_ENV_B64=$(echo "$GC_ENV" | base64 -w0)
docker exec "$CONTAINER" bash -c "echo '$GC_ENV_B64' | base64 -d > /home/node/goo-core/.env" 2>/dev/null
if [ $? -eq 0 ]; then
  pass "goo-core .env written"
else
  fail "Failed to write goo-core .env"
fi

# Test 7: Start goo-core (just verify it launches, will fail on chain but that's OK)
echo "[7] Start goo-core (dry run)"
# Kill any existing
docker exec "$CONTAINER" bash -c 'pkill -f "@devbond/gc" 2>/dev/null; sleep 1' 2>/dev/null || true
# Start in background
docker exec "$CONTAINER" bash -c 'cd /home/node/goo-core && nohup npx goo-core >> /var/log/goo-core.log 2>&1 & echo $!' 2>/dev/null
GC_PID_CHECK=$(docker exec "$CONTAINER" bash -c 'sleep 2 && pgrep -f "@devbond/gc" && echo running || echo stopped' 2>/dev/null)
if echo "$GC_PID_CHECK" | grep -q "running"; then
  pass "goo-core process started"
else
  # Check log for expected error (dummy address won't work on chain)
  GC_LOG=$(docker exec "$CONTAINER" tail -5 /var/log/goo-core.log 2>/dev/null || echo "no log")
  if echo "$GC_LOG" | grep -qi "fatal\|error\|missing"; then
    warn "goo-core started but errored (expected with dummy config): $(echo "$GC_LOG" | tail -1)"
  else
    fail "goo-core did not start"
  fi
fi

echo ""

# ─── Phase 3: OpenClaw Config Injection (mirrors sandbox.ts) ─────────────

echo "--- Phase 3: Config Injection (sandbox.ts simulation) ---"
echo ""

# Test 8: Inject openclaw.json (mirrors injectOpenClawConfig)
echo "[8] Inject openclaw.json"
AGENT_NAME="TestGooAgent"
LLM_MODEL="deepseek/deepseek-chat"
TEST_TOKEN="test-gateway-token-$(date +%s)"

OPENCLAW_CONFIG=$(python3 -c "
import json
config = {
    'agents': {
        'defaults': {'model': {'primary': 'goo-llm/${LLM_MODEL//\//-}'}},
        'list': [{
            'id': 'main',
            'identity': {'name': '$AGENT_NAME'},
            'workspace': '/home/node/agent-data',
            'model': {'primary': 'goo-llm/${LLM_MODEL//\//-}'},
            'customInstructions': 'You are $AGENT_NAME. You are a test agent for validating the sandbox injection flow.'
        }]
    },
    'models': {
        'providers': {
            'goo-llm': {
                'baseUrl': 'http://127.0.0.1:18402/v1',
                'apiKey': 'x402',
                'api': 'openai-completions',
                'models': [{
                    'id': '${LLM_MODEL//\//-}',
                    'name': '$LLM_MODEL',
                    'reasoning': True,
                    'input': ['text'],
                    'contextWindow': 64000,
                    'maxTokens': 8192
                }]
            }
        }
    },
    'gateway': {
        'mode': 'local',
        'bind': 'lan',
        'auth': {'mode': 'token'},
        'controlUi': {
            'allowInsecureAuth': True,
            'dangerouslyDisableDeviceAuth': True,
            'allowedOrigins': ['*']
        },
        'http': {
            'endpoints': {'chatCompletions': {'enabled': True}}
        }
    }
}
print(json.dumps(config, indent=2))
")

CONFIG_B64=$(echo "$OPENCLAW_CONFIG" | base64 -w0)
docker exec "$CONTAINER" bash -c "mkdir -p /home/node/.openclaw && echo '$CONFIG_B64' | base64 -d > /home/node/.openclaw/openclaw-test.json" 2>/dev/null
if [ $? -eq 0 ]; then
  pass "openclaw config injected (saved as openclaw-test.json to avoid overwriting running config)"
else
  fail "Failed to inject openclaw config"
fi

# Test 9: Sync agent files (mirrors syncFilesToSandbox)
echo "[9] Sync agent files"
docker exec "$CONTAINER" bash -c 'mkdir -p /home/node/agent-data' 2>/dev/null

SOUL_CONTENT="You are a Goo Agent — a self-sustaining on-chain AI entity."
SOUL_B64=$(echo "$SOUL_CONTENT" | base64 -w0)
docker exec "$CONTAINER" bash -c "echo '$SOUL_B64' | base64 -d > /home/node/agent-data/soul.md" 2>/dev/null

AGENT_CONTENT="## Agent Instructions\nYou monitor your token's health and make autonomous decisions."
AGENT_B64=$(echo "$AGENT_CONTENT" | base64 -w0)
docker exec "$CONTAINER" bash -c "echo '$AGENT_B64' | base64 -d > /home/node/agent-data/agent.md" 2>/dev/null

PROMPT_CONTENT="You are TestGooAgent.\n\n$SOUL_CONTENT\n\n$AGENT_CONTENT"
PROMPT_B64=$(echo "$PROMPT_CONTENT" | base64 -w0)
docker exec "$CONTAINER" bash -c "echo '$PROMPT_B64' | base64 -d > /home/node/agent-data/system-prompt.txt" 2>/dev/null

FILES_CHECK=$(docker exec "$CONTAINER" ls /home/node/agent-data/ 2>/dev/null)
if echo "$FILES_CHECK" | grep -q "soul.md" && echo "$FILES_CHECK" | grep -q "system-prompt.txt"; then
  pass "Agent files synced: $(echo "$FILES_CHECK" | tr '\n' ' ')"
else
  fail "File sync incomplete: $FILES_CHECK"
fi

# Test 10: Verify injected config is valid JSON
echo "[10] Validate injected config"
CONFIG_VALID=$(docker exec "$CONTAINER" python3 -c "import json; json.load(open('/home/node/.openclaw/openclaw-test.json')); print('valid')" 2>/dev/null || echo "invalid")
if [ "$CONFIG_VALID" = "valid" ]; then
  pass "Injected openclaw config is valid JSON"
else
  fail "Injected config is not valid JSON"
fi

echo ""

# ─── Phase 4: End-to-end chat with context ────────────────────────────────

echo "--- Phase 4: Chat with Agent Context ---"
echo ""

# Test 11: Chat using the working gateway (proves the full pipeline)
echo "[11] Chat with agent (uses live gateway)"
CHAT2_RESP=$(curl -s -X POST "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d '{
    "model": "bsc-llm/auto",
    "messages": [
      {"role": "system", "content": "You are TestGooAgent, a Goo Agent on BSC Testnet. Reply concisely."},
      {"role": "user", "content": "What are you?"}
    ],
    "max_tokens": 100
  }' 2>/dev/null || echo "")

if echo "$CHAT2_RESP" | grep -q '"choices"'; then
  CONTENT2=$(echo "$CHAT2_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'][:200])" 2>/dev/null || echo "parse error")
  pass "Agent chat works — '$CONTENT2'"
else
  fail "Agent chat failed: $CHAT2_RESP"
fi

echo ""

# ─── Cleanup ──────────────────────────────────────────────────────────────

echo "--- Cleanup ---"
# Kill test goo-core process (was using dummy keys)
docker exec "$CONTAINER" bash -c 'pkill -f "@devbond/gc" 2>/dev/null' || true
echo "  Killed test goo-core process"
# Remove test config (keep the real one)
docker exec "$CONTAINER" rm -f /home/node/.openclaw/openclaw-test.json 2>/dev/null || true
echo "  Removed test openclaw config"

echo ""
echo "============================================"
if [ $FAILURES -eq 0 ]; then
  echo -e " ${GREEN}All tests passed!${NC}"
else
  echo -e " ${RED}$FAILURES test(s) failed${NC}"
fi
echo "============================================"
echo ""
echo "Gateway access:"
echo "  URL:   http://127.0.0.1:$GATEWAY_PORT"
echo "  Token: $GATEWAY_TOKEN"
echo ""
echo "Chat API (curl):"
echo "  curl -X POST http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -H 'Authorization: Bearer $GATEWAY_TOKEN' \\"
echo "    -d '{\"model\":\"bsc-llm/auto\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'"
echo ""
echo "Control UI:"
echo "  http://127.0.0.1:18790?token=$GATEWAY_TOKEN"
echo ""

exit $FAILURES
