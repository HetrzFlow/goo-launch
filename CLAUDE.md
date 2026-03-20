# CLAUDE.md

## Build & Run

```bash
# Default package manager: bun (use bun instead of npm/npx)

# Docker (VPS)
docker compose up -d / down / logs -f goo-server

# App (app/) — Cloudflare Worker + Vite frontend
bun run app:dev          # wrangler + vite concurrently (from repo root)
bun run app:deploy       # Build frontend + deploy worker to Cloudflare (from repo root)

# Server (server/) — Express backend (VPS)
bun run dev              # Dev with hot reload
bun run db:push          # Push Prisma schema
bunx tsc --noEmit        # Type check

# Contracts (contracts/)
bun run compile          # Hardhat compile
bun run test             # Hardhat tests

# Deploy infra (one-time)
cd contracts && DEPLOYER_PRIVATE_KEY=0x... bunx hardhat run scripts/deploy-infra.ts --network bscTestnet
```

## Architecture

Split deployment: backend on VPS (Docker Compose: goo-server :8080, PostgreSQL :6432), frontend on Cloudflare Pages (`VITE_API_URL` points to VPS). Targets **BSC Testnet**.

### Local Packages (`packages/`)

- **`packages/goo-contracts`** — On-chain economic life for Goo Economic Agents (lifecycle, treasury, SurvivalSell, Pulse). Solidity interfaces + reference impls (GooAgentToken, GooAgentRegistry, mocks). Referenced by `contracts/package.json` as `file:../packages/goo-contracts`.
- **`packages/goo-core`** — Off-chain economic life: survival economics (ChainMonitor, SurvivalManager, Pulse), economic awareness, AutonomousBehavior. Spawned as child process per Economic Agent by `agent-manager.ts`. Referenced by `server/package.json` as `file:../packages/goo-core`. Build: `cd packages/goo-core && npm run build`.

### Wallet & Signing

goo-core uses a local private key file for signing. The entrypoint writes `WALLET_PRIVATE_KEY` to a file (`$DATA_DIR/wallet/private-key`, mode 600), then passes `AGENT_PRIVATE_KEY_FILE` to goo-core. The key is loaded by `local-key-store.ts` and used via `ethers.Wallet`. Agent tools (`bsc_sign_tx`, `bsc_sign_and_send_tx`) include built-in risk analysis (`tx-risk-analyzer.ts`) before signing.

### Core Flow

1. **Deploy Infrastructure** (one-time): `deploy-infra.ts` deploys MockRouter + GooAgentRegistry
2. **Launch Agent** (MetaMask, two-step): `POST /api/launch/prepare` → frontend deploys GooAgentToken → `POST /api/launch/confirm`
3. **Agent Runtime**: goo-core child process per agent. Heartbeat: ChainMonitor → SurvivalManager → AutonomousBehavior (LLM)
4. **Auth**: Passwordless JWT (`POST /api/auth/login`), auto-creates users, roles: admin/user, 24h expiry

### Server (`server/`)

Express + Prisma (PostgreSQL). Key files: `main.ts` (entry), `config.ts` (env), `auth.ts` (JWT), `db.ts` (Prisma), `agent-manager.ts` (runtime). Routes in `src/routes/`: auth, launch, agents, dashboard, admin, agos.

### App (`app/`)

Cloudflare Worker (Hono) backend with Vite frontend. Single `bun run dev` starts both wrangler and vite concurrently.

- **`app/src/`** — Worker backend (Hono routes, D1 database)
- **`app/frontend/`** — Vanilla TypeScript, Vite multi-page build, Inter font. Pages: index (agent list), login, launch (2-step wizard), agent (detail + controls), dashboard, all.
- **`app/public/`** — Built frontend output (Vite builds here)

### Contracts (`contracts/`)

Hardhat project importing goo-contracts via `Imports.sol`. Deploy scripts: `deploy-infra.ts` (one-time infra), `deploy.ts` (per-agent token).

### Database

PostgreSQL + Prisma. 4 tables: `users`, `contracts`, `agenter_records`, `transaction_logs`. Schema: `server/prisma/schema.prisma`.

### API Routes

See `server/src/routes/` for full endpoint details:
- **auth.ts** — Login (`POST /api/auth/login`)
- **launch.ts** — Prepare/confirm for MetaMask deployment
- **agents.ts** — CRUD + start/stop/events/stream
- **dashboard.ts** — `/api/my/*` user data
- **admin.ts** — `/api/all/*` stats, `DELETE /api/admin/users/:id`
- **agos.ts** — `/api/agos/*` AGOS adapter (enabled when `AGOS_API_URL` set): auth (SIWE), agent CRUD, x402 funding, LLM chat

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `RPC_URL` | BSC Testnet RPC endpoint |
| `CHAIN_ID` | Chain ID (default: 97) |
| `CONTRACTS_DIR` | Path to contracts dir (default: `../contracts`) |
| `JWT_SECRET` | JWT signing secret |
| `ROUTER_ADDRESS` | DEX router address (from deploy-infra) |
| `REGISTRY_ADDRESS` | GooAgentRegistry address (from deploy-infra) |
| `LLM_API_KEY` | OpenRouter/DeepSeek key (enables autonomy) |
| `LLM_API_URL` | LLM endpoint (default: OpenRouter) |
| `LLM_MODEL` | LLM model ID (default: deepseek/deepseek-chat) |
| `BSC_LLM_ROUTER_URL` | x402 LLM endpoint (alternative to LLM_API_KEY) |
| `X402_PAYMENT_TOKEN` | USDT address for x402 payments (agent swaps BNB→USDT) |
| `SANDBOX_MANAGER_URL` | e2b sandbox manager URL (optional) |
| `AGOS_API_URL` | AGOS platform URL (enables AGOS adapter) |
| `VITE_API_URL` | Frontend build-time API URL |
| `OPENCLAW_GATEWAY_URL` | OpenClaw gateway WS URL (enables heartbeat push, e.g. `ws://127.0.0.1:19789`) |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw gateway auth token |

## Key Conventions

- All backend: TypeScript/Node.js. No Go.
- Server: Express + Prisma. Runtime: goo-core (child process).
- Frontend: vanilla TS + Vite, no framework.
- Agent statuses: `active`, `deployed`, `stopped`, `dead`.
- Launch modes: `cloud`, `sandbox` (e2b), `byod`, `agos`.

## Codex MCP Workflow

Use Codex (`mcp__codex__codex`) for collaborative development:

1. **Plan** — Share requirements + approach with Codex for critique before coding
2. **Prototype** — Request unified diff patch from Codex (`sandbox="read-only"`), then rewrite independently
3. **Review Gate (BLOCKING)** — After coding, invoke Codex review with original requirements + diff. Fix all critical/major issues before finalizing. Report outcome (pass/pass-with-notes/required-fixes)
4. **Think Critically** — Challenge Codex when you spot flaws; converge on the best solution

Key params: `PROMPT` (string), `cd` (path), `sandbox` ("read-only"), `SESSION_ID` (UUID, save for multi-turn). Always use `sandbox="read-only"` — Codex must not modify files directly.
