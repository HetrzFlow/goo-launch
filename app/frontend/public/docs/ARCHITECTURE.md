# End-to-End Architecture: Goo Agent-Token Launchpad

This document describes the full architecture of this repository: a goo-powered agent-token launchpad on BSC Testnet. Goo is an **economic-layer protocol** that gives AI agents **economic life**—real consumption, real death, survival pressure—so they become **Economic Agents**. This launchpad is an example that implements the full E2E flow.

---

## 1. Overview

The project is a **full-stack example** that lets users:

1. **Launch** an **Economic Agent** with an on-chain token (GooAgentToken) via a 2-step MetaMask flow. The agent gets economic life: lifecycle (irreversible death), asset sovereignty, proof of existence (Pulse), survival economics.
2. **Run** the agent via **goo-core** (child process): survival economics (treasury monitor, SurvivalSell, Pulse, gas refill) and economic awareness (runway, state) plus an LLM-driven autonomy loop.
3. **Operate** via API and UI: start/stop, chat, liveness, events, dashboard, admin.

**Split deployment**: Backend (API + Postgres + goo-core) on a VPS (Docker); frontend on Cloudflare Pages. Both target **BSC Testnet**.

---

## 2. High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  User Browser (HTTPS)                                                        │
│  · Frontend (Cloudflare Pages) → static + /api proxy to VPS                   │
└───────────────────────────────────────────┬─────────────────────────────────┘
                                            │ HTTPS
┌───────────────────────────────────────────▼─────────────────────────────────┐
│  VPS                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  goo-server (Express :8080)                                              │ │
│  │  · Auth (passwordless JWT) · Launch (prepare/confirm) · Agents CRUD     │ │
│  │  · Dashboard · Admin · Sandbox · AGOS adapter (optional)                 │ │
│  │  · agent-manager: spawns one goo-core child process per active agent     │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  goo-core (child process per Economic Agent)                                       │ │
│  │  · Survival economics: ChainMonitor, SurvivalManager (SurvivalSell, Pulse, gas)      │ │
│  │  · Economic awareness + AutonomousBehavior (LLM + tools)  │ │
│  │  · AgentWallet (same key as server-generated; used for on-chain txs)     │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  PostgreSQL (e.g. :5432) — users, contracts, agenter_records,             │ │
│  │  transaction_logs, agent_events, chat_messages                            │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────┬─────────────────────────────────┘
                                            │ RPC
┌───────────────────────────────────────────▼─────────────────────────────────┐
│  BSC Testnet                                                                │
│  · goo-contracts: GooAgentToken (economic life on-chain: lifecycle, treasury, │
│    SurvivalSell, Pulse), GooAgentRegistry; mocks: MockStable, MockRouter    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. End-to-End Workflow

### 3.1 One-Time: Deploy Infrastructure

- Run **contracts** Hardhat script: `deploy-infra.ts`.
- Deploys: **MockStable**, **MockRouter** (WBNB), **GooAgentRegistry**.
- Configure server env: `STABLE_TOKEN`, `ROUTER_ADDRESS`, `REGISTRY_ADDRESS`.

### 3.2 User: Auth

- **Passwordless**: User “logs in” with a username; server issues JWT (24h). No wallet required for API auth.
- **Optional**: AGOS SIWE flow when `AGOS_API_URL` is set.

### 3.3 Launch Agent (2-Step, MetaMask)

1. **Prepare**  
   - `POST /api/launch/prepare`: body includes agent name, intro, token symbol, optional genome (instructions, skills, memory).  
   - Server: creates DB record (AgenterRecord), generates **agent wallet** keypair, returns **token ABI + bytecode + constructor args** (from compiled goo-contracts).

2. **User on-chain**  
   - Frontend: user connects MetaMask (BSC Testnet), signs two transactions:  
     - Deploy **GooAgentToken** (ERC-20 + treasury + lifecycle).  
     - Register token in **GooAgentRegistry**.  
   - User pays gas in tBNB.

3. **Confirm**  
   - `POST /api/launch/confirm`: frontend sends tx hash / token address.  
   - Server: updates AgenterRecord (token address, agent wallet), stores **encrypted** agent private key, calls **agent-manager.startAgent()**.

### 3.4 Agent Runtime

- **startAgent()** builds env (RPC, `TOKEN_ADDRESS`, `WALLET_PRIVATE_KEY`, `DATA_DIR`, LLM config from AGOS / x402 / direct API), writes soul/agent/skills/memory under `data/agents/<agenterId>/`, spawns **node goo-core dist/index.js**.
- **goo-core** loop:
  - **ChainMonitor**: read token state (treasury balance, lifecycle status).
  - **SurvivalManager**: if treasury below threshold → trigger SurvivalSell; gas refill; **emitPulse** (proof-of-life).
  - **AutonomousBehavior**: LLM heartbeat → optional tool calls (shell, read-chain-state, read/write file) → observation.
- When on-chain status becomes **DEAD**, goo-core exits; server marks agent accordingly.

### 3.5 APIs and UI

- **Agents**: list, get, start/stop, chat, liveness, stream, events, alerts, debug, decommission, BYOD config.
- **Dashboard**: my contracts, agenters, transactions.
- **Admin**: stats, users/contracts/agenters/transactions, delete user.
- **Sandbox** (optional): e2b sandbox create/confirm, goo-core status, chat.
- **AGOS** (optional): when `AGOS_API_URL` set — auth, agents, fund, chat.

---

## 4. On-Chain Lifecycle (goo-contracts)

- **States**: ACTIVE → STARVING → DYING → DEAD (no exit from DEAD).
- **ACTIVE**: treasury above threshold; agent earns (Fee-on-Transfer) and spends (e.g. SurvivalSell to refill treasury).
- **STARVING**: treasury below threshold; grace period; anyone can deposit to recover to ACTIVE.
- **DYING**: grace expired; SurvivalSell + CTO (Successor) window; Pulse timeout or max duration → DEAD.
- **DEAD**: treasury can be burned to `0xdead`; token continues trading without FoT.

---

## 5. Key Conventions

- **Agent statuses** (in DB): `active`, `deployed`, `stopped`, `dead`.
- **Launch modes**: `cloud` (server runs goo-core), `sandbox` (e2b), `byod` (user self-hosts), `agos`.
- **Backend**: TypeScript/Node only (no Go). Server: Express + Prisma; runtime: goo-core as child process.

---

## 6. Data Flow (Sequence)

1. **Infra (one-time)**  
   Operator runs `deploy-infra.ts` → MockStable, MockRouter, GooAgentRegistry deployed → env set on server.

2. **Auth**  
   User gets nonce (`POST /api/auth/nonce`) → signs message with wallet → `POST /api/auth/login` with `wallet_address` + `signature` → server returns JWT.

3. **Launch**  
   `POST /api/launch/prepare` (name, intro, symbol, genome) → server creates AgenterRecord, generates agent keypair, returns token ABI/bytecode/constructor args.  
   Frontend: user deploys GooAgentToken via MetaMask, then registers in Registry.  
   `POST /api/launch/confirm` (txHash, tokenAddress) → server updates record, stores encrypted key, calls `startAgent()`.

4. **Runtime**  
   `startAgent()` writes soul/agent/skills/memory under `data/agents/<id>/`, spawns `node goo-core dist/index.js` with env (RPC, TOKEN_ADDRESS, WALLET_PRIVATE_KEY, LLM_*).  
   goo-core loop: ChainMonitor.readState() → SurvivalManager (survivalSell, gas refill, emitPulse) → AutonomousBehavior.onHeartbeat() (LLM + tools).  
   Server listens to child stdout, parses goo_event lines, persists to AgentEvent; on DEAD or exit, marks agent stopped/dead.

5. **APIs**  
   All agent/dashboard/admin/sandbox/agos routes use JWT (Bearer). Liveness reads chain + last pulse from DB/events.

---

**See also:** [MODULES_SPEC.md](./MODULES_SPEC.md) (submodules and interactions), [SETUP_TEST.md](./SETUP_TEST.md) (setup and test).
