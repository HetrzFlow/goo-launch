#!/bin/bash
set -euo pipefail

#
# Deploy a test agent: infra (if needed) + agent wallet + GooAgentToken + fund treasury
#
# Prerequisites:
#   - DEPLOYER_PRIVATE_KEY env var (BSC Testnet account with tBNB)
#   - Contracts compiled: cd contracts && npm run compile
#
# Usage:
#   DEPLOYER_PRIVATE_KEY=0x... bash scripts/deploy-test-agent.sh
#
# Outputs .env values ready to paste into deploy/docker/.env
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONTRACTS_DIR="$PROJECT_DIR/contracts"
BYOD_ENV="$PROJECT_DIR/deploy/docker/.env"
SERVER_ENV="$PROJECT_DIR/server/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Check prerequisites ─────────────────────────────────────────────────

if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  echo -e "${RED}ERROR${NC}: DEPLOYER_PRIVATE_KEY env var is required"
  echo ""
  echo "Usage:"
  echo "  DEPLOYER_PRIVATE_KEY=0x... bash $0"
  exit 1
fi

if [ ! -f "$CONTRACTS_DIR/package.json" ]; then
  echo -e "${RED}ERROR${NC}: contracts/ not found at $CONTRACTS_DIR"
  exit 1
fi

# ─── Compile contracts if needed ──────────────────────────────────────────

if [ ! -d "$CONTRACTS_DIR/artifacts" ]; then
  echo -e "${CYAN}[1/5]${NC} Compiling contracts..."
  cd "$CONTRACTS_DIR" && npx hardhat compile
else
  echo -e "${CYAN}[1/5]${NC} Contracts already compiled"
fi

# ─── Helper: run hardhat script, capture stdout JSON, show stderr ─────────

# Hardhat scripts use console.error for logs and console.log for JSON output.
# We capture stdout (JSON) separately and let stderr flow to terminal.
run_hardhat() {
  local script="$1"
  shift
  local tmp_out
  tmp_out=$(mktemp)
  # Run: stdout → tmp file, stderr → terminal
  # dotenv prints noise to stdout, so we grep for the JSON line only
  if ! env "$@" npx hardhat run "$script" --network bscTestnet > "$tmp_out"; then
    echo -e "  ${RED}Hardhat script failed${NC}" >&2
    cat "$tmp_out" >&2
    rm -f "$tmp_out"
    return 1
  fi
  # Extract the JSON line (starts with {) — skip dotenv/hardhat noise
  grep '^{' "$tmp_out" | tail -1
  rm -f "$tmp_out"
}

# ─── Deploy infra if not yet deployed ─────────────────────────────────────

# Check if infra addresses exist in server .env
STABLE_TOKEN=""
ROUTER_ADDRESS=""
REGISTRY_ADDRESS=""

if [ -f "$SERVER_ENV" ]; then
  STABLE_TOKEN=$(grep '^STABLE_TOKEN=' "$SERVER_ENV" | tail -1 | cut -d= -f2)
  ROUTER_ADDRESS=$(grep '^ROUTER_ADDRESS=' "$SERVER_ENV" | tail -1 | cut -d= -f2)
  REGISTRY_ADDRESS=$(grep '^REGISTRY_ADDRESS=' "$SERVER_ENV" | tail -1 | cut -d= -f2)
fi

if [ -z "$STABLE_TOKEN" ] || [ -z "$ROUTER_ADDRESS" ] || [ -z "$REGISTRY_ADDRESS" ]; then
  echo -e "${CYAN}[2/5]${NC} Deploying infrastructure contracts (MockStable + MockRouter + Registry)..."
  cd "$CONTRACTS_DIR"

  INFRA_JSON=$(run_hardhat scripts/deploy-infra.ts \
    DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY")

  if [ -z "$INFRA_JSON" ]; then
    echo -e "${RED}ERROR${NC}: deploy-infra produced no output. Check errors above."
    exit 1
  fi

  STABLE_TOKEN=$(echo "$INFRA_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['stableToken'])")
  ROUTER_ADDRESS=$(echo "$INFRA_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['mockRouter'])")
  REGISTRY_ADDRESS=$(echo "$INFRA_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['registry'])")

  echo -e "  ${GREEN}Deployed:${NC}"
  echo "    STABLE_TOKEN=$STABLE_TOKEN"
  echo "    ROUTER_ADDRESS=$ROUTER_ADDRESS"
  echo "    REGISTRY_ADDRESS=$REGISTRY_ADDRESS"

  # Save to server .env
  if [ -f "$SERVER_ENV" ]; then
    sed -i "s|^STABLE_TOKEN=.*|STABLE_TOKEN=$STABLE_TOKEN|" "$SERVER_ENV"
    sed -i "s|^ROUTER_ADDRESS=.*|ROUTER_ADDRESS=$ROUTER_ADDRESS|" "$SERVER_ENV"
    sed -i "s|^REGISTRY_ADDRESS=.*|REGISTRY_ADDRESS=$REGISTRY_ADDRESS|" "$SERVER_ENV"
    echo -e "  ${GREEN}Updated${NC} server/.env with infra addresses"
  fi
else
  echo -e "${CYAN}[2/5]${NC} Infrastructure already deployed"
  echo "    STABLE_TOKEN=$STABLE_TOKEN"
  echo "    ROUTER_ADDRESS=$ROUTER_ADDRESS"
  echo "    REGISTRY_ADDRESS=$REGISTRY_ADDRESS"
fi

# ─── Generate agent wallet ────────────────────────────────────────────────

echo -e "${CYAN}[3/5]${NC} Generating agent wallet..."

cd "$CONTRACTS_DIR"
WALLET_JSON=$(node -e "
const { ethers } = require('ethers');
const w = ethers.Wallet.createRandom();
console.log(JSON.stringify({ address: w.address, privateKey: w.privateKey }));
")

AGENT_WALLET=$(echo "$WALLET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])")
AGENT_PRIVATE_KEY=$(echo "$WALLET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['privateKey'])")

echo -e "  ${GREEN}Agent wallet:${NC} $AGENT_WALLET"

# ─── Deploy GooAgentToken ─────────────────────────────────────────────────

echo -e "${CYAN}[4/5]${NC} Deploying GooAgentToken..."
cd "$CONTRACTS_DIR"

TOKEN_JSON=$(run_hardhat scripts/deploy.ts \
  DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
  TOKEN_NAME="Test Goo Agent" \
  TOKEN_SYMBOL="tGOO" \
  AGENT_WALLET="$AGENT_WALLET" \
  STABLE_TOKEN="$STABLE_TOKEN" \
  STABLE_DECIMALS="18" \
  ROUTER_ADDRESS="$ROUTER_ADDRESS" \
  REGISTRY_ADDRESS="$REGISTRY_ADDRESS")

if [ -z "$TOKEN_JSON" ]; then
  echo -e "${RED}ERROR${NC}: deploy token produced no output. Check errors above."
  exit 1
fi

TOKEN_ADDRESS=$(echo "$TOKEN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])")
TX_HASH=$(echo "$TOKEN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['txHash'])")

echo -e "  ${GREEN}Token deployed:${NC} $TOKEN_ADDRESS"
echo -e "  TX: $TX_HASH"

# ─── Fund agent wallet with tBNB for gas ──────────────────────────────────

echo -e "${CYAN}[5/5]${NC} Funding agent wallet with tBNB + treasury with tUSDT..."
cd "$CONTRACTS_DIR"

DEPLOYER_KEY="$DEPLOYER_PRIVATE_KEY" \
AGENT_ADDR="$AGENT_WALLET" \
STABLE_ADDR="$STABLE_TOKEN" \
TOKEN_ADDR="$TOKEN_ADDRESS" \
node -e "
const { ethers } = require('ethers');
(async () => {
  const provider = new ethers.JsonRpcProvider('https://bsc-testnet-rpc.publicnode.com');
  const deployer = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);

  // 1. Send 0.01 tBNB to agent wallet for gas
  console.log('Sending 0.01 tBNB to agent wallet...');
  let tx = await deployer.sendTransaction({
    to: process.env.AGENT_ADDR,
    value: ethers.parseEther('0.01'),
  });
  await tx.wait();
  console.log('  tBNB sent: ' + tx.hash);

  // 2. Mint 100 tUSDT
  const ERC20_ABI = ['function mint(address,uint256)', 'function approve(address,uint256)'];
  const stable = new ethers.Contract(process.env.STABLE_ADDR, ERC20_ABI, deployer);
  const amount = ethers.parseUnits('100', 18);
  tx = await stable.mint(deployer.address, amount);
  await tx.wait();
  console.log('  Minted 100 tUSDT');

  // 3. Approve + deposit treasury
  tx = await stable.approve(process.env.TOKEN_ADDR, amount);
  await tx.wait();
  console.log('  Approved tUSDT');

  const TREASURY_ABI = ['function depositTreasury(uint256)'];
  const token = new ethers.Contract(process.env.TOKEN_ADDR, TREASURY_ABI, deployer);
  tx = await token.depositTreasury(amount);
  await tx.wait();
  console.log('  Deposited 100 tUSDT to treasury');
})().catch(e => { console.error(e.message); process.exit(1); });
" && echo -e "  ${GREEN}Funded${NC}" || echo -e "  ${YELLOW}WARN${NC}: Funding failed (check deployer tBNB balance)"

# ─── Output ───────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo -e " ${GREEN}Test Agent Deployed Successfully${NC}"
echo "============================================"
echo ""
echo -e "${CYAN}Agent Details:${NC}"
echo "  Token:   $TOKEN_ADDRESS"
echo "  Wallet:  $AGENT_WALLET"
echo "  TX:      https://testnet.bscscan.com/tx/$TX_HASH"
echo "  Token:   https://testnet.bscscan.com/address/$TOKEN_ADDRESS"
echo ""
echo -e "${CYAN}For deploy/docker/.env:${NC}"
echo "  TOKEN_ADDRESS=$TOKEN_ADDRESS"
echo "  WALLET_PRIVATE_KEY=$AGENT_PRIVATE_KEY"
echo "  BSC_LLM_ROUTER_WALLET_KEY=$AGENT_PRIVATE_KEY"
echo ""

# Auto-update BYOD .env if it exists
if [ -f "$BYOD_ENV" ]; then
  sed -i "s|^TOKEN_ADDRESS=.*|TOKEN_ADDRESS=$TOKEN_ADDRESS|" "$BYOD_ENV"
  sed -i "s|^WALLET_PRIVATE_KEY=.*|WALLET_PRIVATE_KEY=$AGENT_PRIVATE_KEY|" "$BYOD_ENV"
  sed -i "s|^BSC_LLM_ROUTER_WALLET_KEY=.*|BSC_LLM_ROUTER_WALLET_KEY=$AGENT_PRIVATE_KEY|" "$BYOD_ENV"
  echo -e "${GREEN}Auto-updated${NC} deploy/docker/.env"
fi
