# Deployment Guide

This guide covers deploying the two main components of goo-launch:

1. **Smart Contracts** (one-time infrastructure + per-agent tokens) on BSC
2. **Cloudflare Worker** (backend API + frontend) on Cloudflare

---

## Prerequisites

- **bun** (package manager) — used throughout the project
- **Node.js** >= 18
- A BSC wallet with BNB for gas (testnet or mainnet)
- Cloudflare account with Wrangler CLI authenticated (`bunx wrangler login`)

---

## 1. Smart Contracts

### 1.1 Setup

```bash
cd contracts
bun install
```

Create `.env` from the example:

```bash
cp .env.example .env
```

Fill in:

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Deployer wallet private key (with 0x prefix) |
| `BSC_TESTNET_RPC_URL` | BSC Testnet RPC (default provided) |
| `BSC_MAINNET_RPC_URL` | BSC Mainnet RPC (default provided) |
| `BSCSCAN_API_KEY` | Optional, for contract verification |

### 1.2 Compile

```bash
bun run compile
```

Solidity 0.8.28, viaIR enabled, cancun EVM, 200 optimizer runs.

### 1.3 Deploy Infrastructure (one-time per network)

Deploys **GooAgentRegistry** and **SwapExecutorV2** (wraps PancakeSwap V2 Router).

```bash
# Testnet (chainId 97)
DEPLOYER_PRIVATE_KEY=0x... bunx hardhat run scripts/deploy-infra.ts --network bscTestnet

# Mainnet (chainId 56)
DEPLOYER_PRIVATE_KEY=0x... bunx hardhat run scripts/deploy-infra.ts --network bsc
```

Outputs JSON to stdout:

```json
{
  "router": "0x...",
  "registry": "0x...",
  "swapExecutor": "0x...",
  "wbnb": "0x..."
}
```

Save these addresses — they go into `app/wrangler.toml`:

| Output | Wrangler Var |
|--------|-------------|
| `router` | `ROUTER_ADDRESS` |
| `registry` | `REGISTRY_ADDRESS` |
| `swapExecutor` | `SWAP_EXECUTOR_ADDRESS` |

### 1.4 Deploy Agent Token (per agent)

This is normally called by the Cloudflare Worker during the launch flow, but can be run manually:

```bash
DEPLOYER_PRIVATE_KEY=0x... \
TOKEN_NAME="My Agent" \
TOKEN_SYMBOL="MAGT" \
AGENT_WALLET=0x... \
SWAP_EXECUTOR_ADDRESS=0x... \
REGISTRY_ADDRESS=0x... \
BNB_FUND_AMOUNT=0.012 \
bunx hardhat run scripts/deploy.ts --network bscTestnet
```

See `contracts/scripts/deploy.ts` for all optional economic parameters (burn rate, runway hours, pulse timeout, etc.).

### 1.5 Current Deployed Addresses

**BSC Testnet (97)**

| Contract | Address |
|----------|---------|
| Router (PancakeSwap V2) | `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` |
| SwapExecutorV2 | `0x8A62B1d2E614d6bdDA89ef5567A555D6868F137c` |
| GooAgentRegistry | `0x14D59E3db1d8b51924a03F13dFf5F88dB73021AE` |

**BSC Mainnet (56)**

| Contract | Address |
|----------|---------|
| Router (PancakeSwap V2) | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| SwapExecutorV2 | `0x393833ca5B1450D9521F734cF12BDEE97aD1237e` |
| GooAgentRegistry | `0xAa98Ea2f764e93721cc1e45370440e9DCA8a3A76` |

---

## 2. Cloudflare Worker

The app is a Cloudflare Worker (Hono backend) with a Vite-built frontend served as static assets.

### 2.1 Setup

```bash
cd app
bun install

cd frontend
bun install
```

### 2.2 Local Development

From the repo root:

```bash
bun run app:dev
```

This runs `wrangler dev` (worker on :8787) and `vite dev` (frontend on :5173) concurrently. The Vite dev server proxies `/api` to the worker.

### 2.3 Database Migrations

The worker uses Cloudflare D1 (SQLite). Migrations are in `app/src/db/migrations/`.

```bash
cd app

# Apply to local D1 (for dev)
bun run db:migrate:local

# Apply to remote D1 (before first deploy or after adding migrations)
bun run db:migrate:remote

# Mainnet
bunx wrangler d1 migrations apply goo-server-mainnet --remote
```

### 2.4 Secrets

Set secrets before first deploy:

```bash
cd app

# Testnet (default env)
bunx wrangler secret put JWT_SECRET
bunx wrangler secret put LLM_API_KEY

# Mainnet
bunx wrangler secret put JWT_SECRET --env mainnet
bunx wrangler secret put LLM_API_KEY --env mainnet
```

### 2.5 Environment Variables

All env vars are defined in `app/wrangler.toml` under `[vars]` (testnet) and `[env.mainnet.vars]` (mainnet).

Key variables to configure:

| Variable | Description | Example |
|----------|-------------|---------|
| `RPC_URL` | BSC RPC endpoint | `https://bsc-dataseed.binance.org/` |
| `CHAIN_ID` | `97` (testnet) or `56` (mainnet) | `56` |
| `NETWORK` | `testnet` or `mainnet` | `mainnet` |
| `ROUTER_ADDRESS` | PancakeSwap V2 Router | From deploy-infra output |
| `SWAP_EXECUTOR_ADDRESS` | SwapExecutorV2 | From deploy-infra output |
| `REGISTRY_ADDRESS` | GooAgentRegistry | From deploy-infra output |
| `ADMIN_WALLET` | Admin wallet address (lowercase) | `0x...` |
| `LLM_API_URL` | LLM provider endpoint | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | Model ID | `claude-sonnet-4-6` |
| `BSC_LLM_ROUTER_URL` | x402 LLM endpoint (optional) | `https://testnet-api.bscllmrouter.com` |
| `X402_PAYMENT_TOKEN` | USDT address for x402 payments | `0x...` |
| `AGOS_API_URL` | AGOS platform URL (enables AGOS) | `https://claw-api.agos.fun` |
| `AGOS_IMAGE` | Docker image for AGOS agents | `hgamiui9/goo-agos:v0.1.4` |
| `MIN_CONTRIBUTION_BNB` | Min BNB for agent launch | `0.01` |
| `TREASURY_BNB_BPS` | Treasury BNB split in basis points | `1200` (12%) |

### 2.6 Build & Deploy

```bash
# From repo root — builds frontend + deploys worker
bun run app:deploy

# Or manually:
cd app
bun run build          # Syncs contract artifacts + builds Vite frontend
bunx wrangler deploy   # Deploys to testnet (default)
```

**Mainnet:**

```bash
cd app
bun run build
bunx wrangler deploy --env mainnet
```

### 2.7 Deployed URLs

| Environment | URL |
|-------------|-----|
| Testnet | `https://goo-server-testnet.delicate-mouse-f8ca.workers.dev` |
| Mainnet | `https://goo-server-mainnet.delicate-mouse-f8ca.workers.dev` |

### 2.8 Cron Trigger

The worker has a `*/5 * * * *` cron trigger for periodic tasks (agent health checks, etc.). This is configured in `wrangler.toml` under `[triggers]`.

---

## 3. Verify Deployment

After deploying both contracts and worker:

1. **Health check**: `GET /api/health` should return `{ "ok": true }`
2. **Login**: `POST /api/auth/login` with a wallet address
3. **Launch flow**: Visit the frontend, connect wallet, launch a new Goo agent
4. **Contract interaction**: The launch flow deploys a GooAgentToken on-chain and registers it with the GooAgentRegistry

---

## 4. File Reference

```
contracts/
  hardhat.config.ts         # Solidity compiler + network config
  scripts/deploy-infra.ts   # One-time infra deployment
  scripts/deploy.ts         # Per-agent token deployment
  .env.example              # Required env vars

app/
  wrangler.toml             # Worker config (bindings, env vars, D1, KV, DO)
  src/                      # Hono backend routes
  frontend/                 # Vite + vanilla TS frontend
  public/                   # Built frontend assets (output dir)
```
