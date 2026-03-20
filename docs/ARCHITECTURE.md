# End-to-End Architecture: Goo Agent-Token Launchpad

This document describes the architecture of this repository: a goo-powered agent-token launchpad on BSC. Goo is an **economic-layer protocol** that gives AI agents **economic life**—real consumption, real death, survival pressure—so they become **Economic Agents**. This launchpad implements the full E2E flow using a **Cloudflare Worker** (API + frontend), **D1** (database), and **Docker/BYOD/AGOS** for agent runtime.

---

## 1. Overview

The project is a **full-stack example** that lets users:

1. **Launch** an **Economic Agent** with an on-chain token (GooAgentToken) via a 2-step MetaMask flow. The agent gets economic life: lifecycle (irreversible death), asset sovereignty, proof of existence (Pulse), survival economics.
2. **Run** the agent via **goo-core** outside the Worker: in a **sandbox** (e2b), **Docker** (deploy/docker), **BYOD**, or **AGOS**-provisioned container. The Worker does not spawn processes; it provides config APIs, event ingest, and (for sandbox/AGOS) control endpoints.
3. **Operate** via API and UI: auth, launch, agents CRUD, liveness, chat, events, dashboard, admin, sandbox controls, AGOS adapter.

**Deployment:**

- **Backend + frontend:** A single **Cloudflare Worker** (Hono). The Worker serves both the API (`/api/*`) and the Vite-built static frontend (ASSETS from `app/public/`). No separate VPS or Express server.
- **Database:** **Cloudflare D1** (SQLite). Tables: users, contracts, agenter_records, transaction_logs; migrations in `app/src/db/migrations/`.
- **Agent runtime:** **goo-core** runs in a separate environment: e2b sandbox, Docker (deploy/docker), BYOD host, or AGOS-provisioned VM. The Worker exposes `GET /api/agents/:id/runtime-config` and BYOD/AGOS config so those runtimes can bootstrap.
- **Chain:** BSC Testnet (97) or Mainnet (56). Contracts: GooAgentToken, GooAgentRegistry, SwapExecutorV2 (from https://github.com/HertzFlow/goo-contracts; deployed via `contracts/` Hardhat scripts).

---

## 2. High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  User Browser (HTTPS)                                                        │
│  · Same origin: Worker serves static frontend (/) and API (/api/*)           │
└───────────────────────────────────────────┬─────────────────────────────────┘
                                            │
┌───────────────────────────────────────────▼─────────────────────────────────┐
│  Cloudflare Worker (Hono)                                                    │
│  · /ping, /api/config (public)                                              │
│  · /api/auth (login, me)                                                     │
│  · /api/launch (prepare, confirm, pending)                                  │
│  · /api/agents (CRUD, state, liveness, runtime-status, byod-config,         │
│                 agos-runtime-config, events, chat, ws)                      │
│  · /api/my (contracts, agenters, transactions)                              │
│  · /api/all, /api/admin                                                     │
│  · /api/sandbox (create, confirm, status, goo-core-status, restart-goo-core) │
│  · /api/agos (config, agents, balance, provision, models, …)               │
│  · /api/llm-proxy, /api/health                                               │
│  · ASSETS → app/public (Vite build)                                          │
│  Bindings: D1 (DB), KV (NONCE_KV), Durable Objects (AgentEventHub,          │
│             AgentProvisioner)                                                │
└───────────────────────────────────────────┬─────────────────────────────────┘
                                            │
┌───────────────────────────────────────────▼─────────────────────────────────┐
│  Cloudflare D1 (SQLite)                                                      │
│  · users, contracts, agenter_records, transaction_logs                      │
│  · Agent events / chat persisted via routes                                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  Agent runtime (outside Worker)                                               │
│  · e2b sandbox, or deploy/docker (OpenClaw + goo-core), or BYOD, or AGOS      │
│  · goo-core: ChainMonitor → SurvivalManager (Pulse, SurvivalSell, gas)       │
│              → AutonomousBehavior (optional LLM/OpenClaw)                    │
│  · Fetches config from Worker: GET /api/agents/:id/runtime-config            │
│  · Pushes events to Worker: POST /api/agents/:id/events/ingest (if callback)  │
│  · Sandbox: Worker can restart goo-core via SSH to sandbox                    │
└───────────────────────────────────────────┬─────────────────────────────────┘
                                            │ RPC
┌───────────────────────────────────────────▼─────────────────────────────────┐
│  BSC (Testnet / Mainnet)                                                     │
│  · GooAgentToken (lifecycle, treasury, SurvivalSell, Pulse, withdrawToWallet)│
│  · GooAgentRegistry (agentId ↔ token ↔ agentWallet)                         │
│  · SwapExecutorV2 (wraps PancakeSwap V2 Router)                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. End-to-End Workflow

### 3.1 One-Time: Deploy Infrastructure

- Run **contracts** Hardhat script: `deploy-infra.ts`.
- Deploys: **GooAgentRegistry**, **SwapExecutorV2** (wraps existing PancakeSwap V2 Router). Does not deploy mocks; uses live BSC router/WBNB.
- Output (JSON): `router`, `registry`, `swapExecutor`, `wbnb`. Configure **app** via `app/wrangler.toml`: `ROUTER_ADDRESS`, `REGISTRY_ADDRESS`, `SWAP_EXECUTOR_ADDRESS`.

### 3.2 User: Auth

- **Passwordless:** User logs in (e.g. wallet address or username); Worker issues JWT (24h). Stored in client; sent as Bearer on API calls.
- **Optional:** When `AGOS_API_URL` is set, AGOS SIWE flow is available; NONCE_KV stores nonces for sign-in.

### 3.3 Launch Agent (2-Step, MetaMask)

1. **Prepare**  
   - `POST /api/launch/prepare`: body includes agent name, intro, token symbol, optional genome (instructions, skills, memory), sandbox_provider, llm_provider, etc.  
   - Worker: creates D1 record (agenter_records), generates **agent wallet** keypair, returns **token ABI + bytecode + constructor args** (from compiled goo-contracts artifacts synced to app).

2. **User on-chain**  
   - Frontend: user connects MetaMask (BSC), signs deployment of **GooAgentToken** (ERC-20 + treasury + lifecycle) and registration in **GooAgentRegistry**. User pays gas in BNB.

3. **Confirm**  
   - `POST /api/launch/confirm`: frontend sends tx hash, token address, deployer address.  
   - Worker: updates AgenterRecord (token_address, agent_wallet, status), stores **encrypted** agent private key in D1. Worker does **not** start goo-core; the user runs Docker/BYOD or uses AGOS/sandbox, which pull config from `GET /api/agents/:id/runtime-config` (or byod-config / agos-runtime-config).

### 3.4 Agent Runtime

- **goo-core** runs in one of: **e2b sandbox** (Worker creates sandbox, user can restart goo-core via Worker’s sandbox API), **Docker** (deploy/docker: OpenClaw + goo-core in one container; entrypoint fetches runtime-config from Worker), **BYOD** (user runs container or host with TOKEN_ADDRESS + WALLET_PRIVATE_KEY; config from Worker’s byod-config), **AGOS** (AgentProvisioner DO + AGOS API provision VM/container with goo-core).
- **goo-core** loop: ChainMonitor reads token state → SurvivalManager (Pulse, SurvivalSell, gas refill) → AutonomousBehavior (optional LLM/OpenClaw). When on-chain status is DEAD, goo-core exits.
- **Worker** provides: runtime-config (env, soul/agent/skills/memory content), event ingest (`POST /api/agents/:id/events/ingest`), liveness (Worker reads chain + last pulse), sandbox restart-goo-core (SSH into e2b), AGOS provision/health.

### 3.5 APIs and UI

- **Agents:** list, get, state, liveness, runtime-status, export-key, byod-config, agos-runtime-config, ws (events), chat, events, alerts, debug.
- **Dashboard:** /api/my (contracts, agenters, transactions).
- **Admin:** /api/all (stats, users, contracts, agenters, transactions), /api/admin (e.g. delete user).
- **Sandbox:** create/confirm sandbox, status, goo-core-status, restart-goo-core, logs, events.
- **AGOS:** when `AGOS_API_URL` set — auth, agents, balance, provision/health, models, remote status/logs.

---

## 4. On-Chain Lifecycle (goo-contracts)

- **States:** ACTIVE → STARVING → DYING → DEAD (no exit from DEAD).
- **ACTIVE:** Treasury above threshold; agent earns (Fee-on-Transfer) and spends (e.g. SurvivalSell to refill treasury, withdrawToWallet for gas).
- **STARVING:** Treasury below threshold; grace period; anyone can deposit to recover to ACTIVE.
- **DYING:** Grace expired; SurvivalSell + CTO (Successor) window; Pulse timeout or max duration → DEAD.
- **DEAD:** Terminal; treasury can be burned to 0xdead; token continues trading without FoT.

---

## 5. Key Conventions

- **Agent statuses** (in D1): e.g. created, deployed, active, stopped, dead (implementation-specific).
- **Launch modes / providers:** cloud (legacy), sandbox (e2b), byod (user self-hosts), agos (AGOS-provisioned).
- **Backend:** TypeScript only. **Worker:** Hono on Cloudflare; **DB:** D1 (Drizzle); **runtime:** goo-core runs outside the Worker (sandbox/Docker/BYOD/AGOS).
- **Secrets:** JWT_SECRET, LLM_API_KEY set via `wrangler secret put`. Config in `wrangler.toml` under `[vars]` and `[env.mainnet.vars]`.

---

## 6. Data Flow (Sequence)

1. **Infra (one-time)**  
   Operator runs `deploy-infra.ts` → GooAgentRegistry + SwapExecutorV2 deployed → addresses written to `app/wrangler.toml` (ROUTER_ADDRESS, REGISTRY_ADDRESS, SWAP_EXECUTOR_ADDRESS).

2. **Auth**  
   User calls `POST /api/auth/login` (e.g. wallet_address or AGOS SIWE). Worker creates/updates user in D1, returns JWT. Subsequent requests use `Authorization: Bearer <token>`.

3. **Launch**  
   `POST /api/launch/prepare` (name, intro, symbol, genome, …) → Worker creates agenter_record, generates agent keypair, returns ABI/bytecode/constructor args.  
   Frontend: user deploys GooAgentToken via MetaMask, registers in Registry.  
   `POST /api/launch/confirm` (txHash, tokenAddress, deployerAddress, …) → Worker updates record, stores encrypted key in D1. No process spawned; runtime is started by user (Docker/BYOD) or by AGOS/sandbox flow.

4. **Runtime**  
   External runtime (Docker/BYOD/AGOS/sandbox) fetches `GET /api/agents/:id/runtime-config` (or byod-config / agos-runtime-config), writes env and soul/agent/skills/memory, runs goo-core. goo-core heartbeat: read chain → survival actions → optional LLM. Events can be sent to Worker via `POST /api/agents/:id/events/ingest`. Liveness: Worker reads chain state and last pulse (from DB or contract).

5. **APIs**  
   All protected routes use JWT (authRequired). Admin routes may use adminRequired. Liveness and chain state are read by the Worker from BSC RPC and token contract.

---

**See also:** [INSTALL.md](./INSTALL.md), [DEPLOY.md](./DEPLOY.md), [app/README.md](../app/README.md), [deploy/README.md](../deploy/README.md).
