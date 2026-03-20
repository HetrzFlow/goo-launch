#!/bin/bash
set -euo pipefail

#
# Deploy a new GooAgentToken via Hardhat + fund treasury + update .env files
#
# Uses the existing infra (STABLE_TOKEN, ROUTER_ADDRESS, REGISTRY_ADDRESS) from server/.env.
# Generates a fresh agent wallet, deploys via Hardhat, funds with tBNB + tUSDT.
#
# Prerequisites:
#   - DEPLOYER_PRIVATE_KEY env var (BSC Testnet account with tBNB)
#   - Contracts compiled: cd contracts && npm run compile
#
# Usage:
#   DEPLOYER_PRIVATE_KEY=0x... bash scripts/deploy-token.sh
#
# Optional env vars (override defaults):
#   TOKEN_NAME          — default "Test Goo Agent"
#   TOKEN_SYMBOL        — default "tGOO"
#   BNB_FUND_AMOUNT     — default "0.1" (tBNB to agent wallet)
#   USDT_FUND_AMOUNT    — default "100" (tUSDT to treasury)
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONTRACTS_DIR="$PROJECT_DIR/contracts"
SERVER_ENV="$PROJECT_DIR/server/.env"
BYOD_ENV="$PROJECT_DIR/deploy/docker/.env"
GOOCORE_ENV="$PROJECT_DIR/packages/goo-core/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

TOKEN_NAME="${TOKEN_NAME:-Test Goo Agent}"
TOKEN_SYMBOL="${TOKEN_SYMBOL:-tGOO}"
BNB_FUND_AMOUNT="${BNB_FUND_AMOUNT:-0.1}"
USDT_FUND_AMOUNT="${USDT_FUND_AMOUNT:-100}"

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
  echo -e "${CYAN}[1/6]${NC} Compiling contracts..."
  cd "$CONTRACTS_DIR" && npx hardhat compile
else
  echo -e "${CYAN}[1/6]${NC} Contracts already compiled"
fi

# ─── Helper: run hardhat script, capture stdout JSON ──────────────────────

run_hardhat() {
  local script="$1"
  shift
  local tmp_out
  tmp_out=$(mktemp)
  if ! env "$@" npx hardhat run "$script" --network bscTestnet > "$tmp_out"; then
    echo -e "  ${RED}Hardhat script failed${NC}" >&2
    cat "$tmp_out" >&2
    rm -f "$tmp_out"
    return 1
  fi
  grep '^{' "$tmp_out" | tail -1
  rm -f "$tmp_out"
}

# ─── Read infra from server/.env ──────────────────────────────────────────

if [ ! -f "$SERVER_ENV" ]; then
  echo -e "${RED}ERROR${NC}: server/.env not found at $SERVER_ENV"
  exit 1
fi

STABLE_TOKEN=$(grep '^STABLE_TOKEN=' "$SERVER_ENV" | tail -1 | cut -d= -f2)
STABLE_DECIMALS=$(grep '^STABLE_DECIMALS=' "$SERVER_ENV" | tail -1 | cut -d= -f2)
ROUTER_ADDRESS=$(grep '^ROUTER_ADDRESS=' "$SERVER_ENV" | tail -1 | cut -d= -f2)
REGISTRY_ADDRESS=$(grep '^REGISTRY_ADDRESS=' "$SERVER_ENV" | tail -1 | cut -d= -f2)
STABLE_DECIMALS="${STABLE_DECIMALS:-18}"

if [ -z "$STABLE_TOKEN" ] || [ -z "$ROUTER_ADDRESS" ] || [ -z "$REGISTRY_ADDRESS" ]; then
  echo -e "${RED}ERROR${NC}: Missing infra addresses in server/.env"
  echo "  Required: STABLE_TOKEN, ROUTER_ADDRESS, REGISTRY_ADDRESS"
  exit 1
fi

echo -e "${CYAN}[2/6]${NC} Infrastructure (from server/.env)"
echo "  STABLE_TOKEN=$STABLE_TOKEN"
echo "  ROUTER_ADDRESS=$ROUTER_ADDRESS"
echo "  REGISTRY_ADDRESS=$REGISTRY_ADDRESS"

# ─── Generate agent wallet ────────────────────────────────────────────────

echo -e "${CYAN}[3/6]${NC} Generating agent wallet..."

cd "$CONTRACTS_DIR"
WALLET_JSON=$(node -e "
const { ethers } = require('ethers');
const w = ethers.Wallet.createRandom();
console.log(JSON.stringify({ address: w.address, privateKey: w.privateKey }));
")

AGENT_WALLET=$(echo "$WALLET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])")
AGENT_PRIVATE_KEY=$(echo "$WALLET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['privateKey'])")

echo -e "  ${GREEN}Agent wallet:${NC} $AGENT_WALLET"

# ─── Deploy GooAgentToken via Hardhat ─────────────────────────────────────

echo -e "${CYAN}[4/6]${NC} Deploying GooAgentToken via Hardhat..."
cd "$CONTRACTS_DIR"

TOKEN_JSON=$(run_hardhat scripts/deploy.ts \
  DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
  TOKEN_NAME="$TOKEN_NAME" \
  TOKEN_SYMBOL="$TOKEN_SYMBOL" \
  AGENT_WALLET="$AGENT_WALLET" \
  STABLE_TOKEN="$STABLE_TOKEN" \
  STABLE_DECIMALS="$STABLE_DECIMALS" \
  ROUTER_ADDRESS="$ROUTER_ADDRESS" \
  REGISTRY_ADDRESS="$REGISTRY_ADDRESS" \
  BNB_FUND_AMOUNT="$BNB_FUND_AMOUNT")

if [ -z "$TOKEN_JSON" ]; then
  echo -e "${RED}ERROR${NC}: deploy token produced no output. Check errors above."
  exit 1
fi

TOKEN_ADDRESS=$(echo "$TOKEN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])")
TX_HASH=$(echo "$TOKEN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['txHash'])")

echo -e "  ${GREEN}Token deployed:${NC} $TOKEN_ADDRESS"
echo -e "  TX: $TX_HASH"

# ─── Fund treasury (BNB + 5% tokens already handled by payable constructor) ──

echo -e "${CYAN}[5/6]${NC} Funding treasury: $USDT_FUND_AMOUNT tUSDT (BNB + 5% tokens handled in deploy)..."
cd "$CONTRACTS_DIR"

DEPLOYER_KEY="$DEPLOYER_PRIVATE_KEY" \
STABLE_ADDR="$STABLE_TOKEN" \
TOKEN_ADDR="$TOKEN_ADDRESS" \
FUND_USDT="$USDT_FUND_AMOUNT" \
DECIMALS="$STABLE_DECIMALS" \
node -e "
const { ethers } = require('ethers');
(async () => {
  const provider = new ethers.JsonRpcProvider('https://bsc-testnet-rpc.publicnode.com');
  const deployer = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
  const decimals = parseInt(process.env.DECIMALS);

  // 1. Mint tUSDT
  const usdtAmount = process.env.FUND_USDT;
  const ERC20_ABI = ['function mint(address,uint256)', 'function approve(address,uint256)'];
  const stable = new ethers.Contract(process.env.STABLE_ADDR, ERC20_ABI, deployer);
  const amount = ethers.parseUnits(usdtAmount, decimals);
  let tx = await stable.mint(deployer.address, amount);
  await tx.wait();
  console.error('  Minted ' + usdtAmount + ' tUSDT');

  // 2. Approve + deposit treasury
  tx = await stable.approve(process.env.TOKEN_ADDR, amount);
  await tx.wait();
  console.error('  Approved tUSDT');

  const TREASURY_ABI = ['function depositToTreasury(uint256)'];
  const token = new ethers.Contract(process.env.TOKEN_ADDR, TREASURY_ABI, deployer);
  tx = await token.depositToTreasury(amount);
  await tx.wait();
  console.error('  Deposited ' + usdtAmount + ' tUSDT to treasury');
})().catch(e => { console.error(e.message); process.exit(1); });
" && echo -e "  ${GREEN}Funded${NC}" || echo -e "  ${YELLOW}WARN${NC}: Funding failed (check deployer tBNB balance)"

# ─── Update .env files ───────────────────────────────────────────────────

echo -e "${CYAN}[6/6]${NC} Updating .env files..."

if [ -f "$BYOD_ENV" ]; then
  sed -i "s|^TOKEN_ADDRESS=.*|TOKEN_ADDRESS=$TOKEN_ADDRESS|" "$BYOD_ENV"
  sed -i "s|^WALLET_PRIVATE_KEY=.*|WALLET_PRIVATE_KEY=$AGENT_PRIVATE_KEY|" "$BYOD_ENV"
  sed -i "s|^BSC_LLM_ROUTER_WALLET_KEY=.*|BSC_LLM_ROUTER_WALLET_KEY=$AGENT_PRIVATE_KEY|" "$BYOD_ENV"
  echo -e "  ${GREEN}Updated${NC} deploy/docker/.env"
fi

if [ -f "$GOOCORE_ENV" ]; then
  sed -i "s|^TOKEN_ADDRESS=.*|TOKEN_ADDRESS=$TOKEN_ADDRESS|" "$GOOCORE_ENV"
  sed -i "s|^WALLET_PRIVATE_KEY=.*|WALLET_PRIVATE_KEY=$AGENT_PRIVATE_KEY|" "$GOOCORE_ENV"
  echo -e "  ${GREEN}Updated${NC} packages/goo-core/.env"
fi

# ─── Output summary ──────────────────────────────────────────────────────

echo ""
echo "============================================"
echo -e " ${GREEN}GooAgentToken Deployed Successfully${NC}"
echo "============================================"
echo ""
echo -e "${CYAN}Agent Details:${NC}"
echo "  Token:   $TOKEN_ADDRESS"
echo "  Wallet:  $AGENT_WALLET"
echo "  TX:      https://testnet.bscscan.com/tx/$TX_HASH"
echo "  Token:   https://testnet.bscscan.com/address/$TOKEN_ADDRESS"
echo ""
echo -e "${CYAN}Environment:${NC}"
echo "  TOKEN_ADDRESS=$TOKEN_ADDRESS"
echo "  WALLET_PRIVATE_KEY=$AGENT_PRIVATE_KEY"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Register agent in server DB (or use the launch flow)"
echo "  2. Approve Permit2 for agent wallet if using x402 payments"
