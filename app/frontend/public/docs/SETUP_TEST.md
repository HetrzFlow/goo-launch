# Setup & Test Guide

Minimal steps to run the launchpad locally and verify the E2E flow. For detailed test cases (CN) see [TEST_GUIDE_CN.md](./TEST_GUIDE_CN.md).

---

## 1. Prerequisites

- Node.js ≥ 20, Docker (for backend), Git
- BSC Testnet RPC (e.g. `https://data-seed-prebsc-1-s1.binance.org:8545`)
- tBNB for deployer and agent wallet ([BSC Testnet Faucet](https://www.bnbchain.org/en/testnet-faucet))
- LLM: either `LLM_API_KEY` (OpenRouter/DeepSeek) or `BSC_LLM_ROUTER_URL` (x402)

---

## 2. Backend (Docker)

```bash
# Clone and install
git clone <repo> && cd goo-bsc
make compile   # contracts: npm install + hardhat compile

# One-time: deploy infra to BSC Testnet
DEPLOYER_PRIVATE_KEY=0x... make deploy-infra
# Set in server/.env: STABLE_TOKEN, ROUTER_ADDRESS, REGISTRY_ADDRESS

cp server/.env.example server/.env
# Edit server/.env: DATABASE_URL (default in compose), RPC_URL, CHAIN_ID=97,
#   JWT_SECRET, STABLE_TOKEN, ROUTER_ADDRESS, REGISTRY_ADDRESS,
#   LLM_API_KEY (or BSC_LLM_ROUTER_URL)

make up
make status    # Postgres + Server OK
curl -s http://localhost:8080/ping   # {"status":"ok"}
```

---

## 3. Frontend (local dev)

```bash
cd frontend && npm install && npm run dev
# Vite proxies /api to localhost:8080. Open http://localhost:5173
```

For production: set `VITE_API_URL` to your API base (e.g. Cloudflare Tunnel URL), then build and deploy to Cloudflare Pages (see repo Makefile `deploy-frontend`).

---

## 4. Auth

Login is wallet-based. From frontend: connect MetaMask (BSC Testnet) → request nonce → sign "Sign in to Goo\n\nNonce: …" → submit `wallet_address` + `signature` to `POST /api/auth/login`. Use the returned `token` as `Authorization: Bearer <token>`.

---

## 5. Launch Agent (2-step)

1. **Prepare:** `POST /api/launch/prepare` with `agent_name`, `agent_intro`, `token_symbol`, optional genome. Response includes token ABI, bytecode, constructor args.
2. **User on-chain:** Deploy GooAgentToken (MetaMask), then register in GooAgentRegistry. User pays gas in tBNB.
3. **Confirm:** `POST /api/launch/confirm` with `tx_hash`, `token_address`. Server starts goo-core for the agent.

Ensure agent wallet has tBNB for gas (server shows `agent_wallet` in confirm response; fund it if needed).

---

## 6. Verify Runtime

- Agent detail page: Start → status becomes active; Event Timeline shows Pulse/LLM.
- Backend logs: `make logs` → `[Agent:<id>]` heartbeat lines.
- Liveness API: `GET /api/agents/:id/liveness` (chain status + last pulse).

---

## 7. Test Commands (summary)

| Area | Command / check |
|------|------------------|
| Contracts | `cd contracts && npm run test` |
| goo-core | `cd packages/goo-core && npm run build && npm test` |
| Server | `npx tsc --noEmit` in server/ |
| E2E | Follow [TEST_GUIDE_CN.md](./TEST_GUIDE_CN.md) TC1–TC7 (same flow in EN). |

---

**See also:** [ARCHITECTURE.md](./ARCHITECTURE.md), [MODULES_SPEC.md](./MODULES_SPEC.md).
