# goo-example Installation & Setup

Prerequisites, install steps, and how to run the app and contracts locally. For deployment to production, see [DEPLOY.md](./DEPLOY.md).

---

## 1. Prerequisites

- **bun** — default package manager (or use npm/pnpm with equivalent commands)
- **Node.js** >= 18
- **Git**
- **BSC wallet** with testnet/mainnet BNB for contract deployment and agent launch
- **Cloudflare account** — for deploying the Worker (optional for local-only dev)

---

## 2. Clone and install

```bash
git clone <repo-url>
cd goo-example
bun install
```

**App (Worker + frontend):**

```bash
cd app
bun install
cd frontend
bun install
cd ../..
```

**Contracts:**

```bash
cd contracts
bun install
cd ..
```

**Libraries (goo-contracts, goo-core):** This repo consumes them as dependencies. Upstream sources:

- `goo-contracts`: https://github.com/HertzFlow/goo-contracts
- `goo-core`: https://github.com/HertzFlow/goo-core

If you need to build `goo-core` locally (e.g. for self-hosted agents):

```bash
git clone https://github.com/HertzFlow/goo-core
cd goo-core
bun install && bun run build
cd ..
```

---

## 3. Contracts setup

```bash
cd contracts
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` or `DEPLOYER_PRIVATE_KEY` | Deployer wallet private key (0x prefix) |
| `BSC_TESTNET_RPC_URL` | BSC Testnet RPC (default in example) |
| `BSC_MAINNET_RPC_URL` | BSC Mainnet RPC (optional) |
| `BSCSCAN_API_KEY` | Optional, for contract verification |

```bash
bun run compile
bun run test
```

---

## 4. App setup (Worker + frontend)

**Local dev (no deploy):**

From repo root:

```bash
bun run app:dev
```

- Worker runs on port **8787** (wrangler dev).
- Vite frontend runs on port **5173**; it proxies `/api` to the worker.
- Open `http://localhost:5173` for the UI.

**Local D1 (SQLite):** Wrangler uses a local D1 database. Apply migrations:

```bash
cd app
bun run db:migrate:local
```

**Environment:** Worker config is in `app/wrangler.toml` (`[vars]`). For local dev, defaults may be enough; set at least `RPC_URL`, `CHAIN_ID`, `ROUTER_ADDRESS`, `REGISTRY_ADDRESS`, `SWAP_EXECUTOR_ADDRESS` if you want to use the full launch flow. Copy from deploy-infra output or use testnet defaults from [DEPLOY.md](./DEPLOY.md).

---

## 5. Deploy infrastructure (one-time per network)

Before launching agents, deploy Registry and SwapExecutor:

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=0x... bunx hardhat run scripts/deploy-infra.ts --network bscTestnet
```

Save the printed addresses and put them in `app/wrangler.toml`:

- `router` → not used directly in wrangler; SwapExecutor wraps it.
- `registry` → `REGISTRY_ADDRESS`
- `swapExecutor` → `SWAP_EXECUTOR_ADDRESS`
- Optionally set `ROUTER_ADDRESS` if the app uses it for display or config.

---

## 6. Run (summary)

| Goal | Command |
|------|---------|
| App dev (worker + frontend) | `bun run app:dev` or `make app-dev` |
| Frontend only | `cd app/frontend && bun run dev` or `make app-dev-frontend` |
| Worker only | `cd app && bun run dev:worker` or `make app-dev-worker` |
| Compile contracts | `cd contracts && bun run compile` or `make compile` |
| Contract tests | `cd contracts && bunx hardhat test` or `make test-contracts` |
| Deploy worker (testnet) | `cd app && bun run deploy` or `make deploy-testnet` |
| Deploy worker (mainnet) | `cd app && bunx wrangler deploy --env mainnet` or `make deploy-mainnet` |
| Docker (OpenClaw + goo-core) | `make docker-up` (see [deploy/README.md](../deploy/README.md)) |

---

## 7. Verify

1. **Health:** `curl http://localhost:8787/ping` or `curl http://localhost:8787/api/health` (when app is running).
2. **Config:** `curl http://localhost:8787/api/config` — should return chain_id, router_address, etc.
3. **Login:** `POST /api/auth/login` with body `{ "wallet_address": "0x..." }` (or AGOS SIWE if enabled) — should return a JWT.
4. **Launch:** Use the UI at `http://localhost:5173` to connect wallet and go through the launch flow (requires infra deployed and wrangler vars set).

---

## 8. Troubleshooting

- **Contract compile fails:** Ensure `contracts/` has a valid `goo-contracts` dependency configured and run `bun install` + `bun run compile` in `contracts/`.
- **Worker fails to start:** Check `app/wrangler.toml` bindings (D1, KV, etc.) and that migrations were applied (`bun run db:migrate:local`).
- **Frontend can’t reach API:** Ensure you use `bun run app:dev` so Vite proxies `/api` to the worker; or set Vite’s proxy in `app/frontend/vite.config.ts` to the worker URL.
- **Launch fails:** Ensure ROUTER_ADDRESS, REGISTRY_ADDRESS, SWAP_EXECUTOR_ADDRESS are set in wrangler.toml and that deploy-infra was run on the same network (testnet/mainnet) as CHAIN_ID.
