# Module Architecture & Specifications

Submodules of the Goo launchpad and how they interact. Goo is an **economic-layer protocol** that gives AI agents **economic life** (real consumption, real death, survival pressure); the core packages implement that life on-chain and off-chain. **goo-contracts** = on-chain economic life; **goo-core** = off-chain economic life (survival economics + economic awareness). Example repo: server, frontend, contracts (Hardhat).

---

## 1. Module Overview

| Module | Location | Role |
|--------|----------|------|
| **goo-contracts** | `packages/goo-contracts` | On-chain economic life: token standard (IGooAgentToken), Registry (IGooAgentRegistry), reference impls, mocks. Lifecycle = irreversible death; asset sovereignty; proof of existence (Pulse); survival economics (SurvivalSell). |
| **goo-core** | `packages/goo-core` | Off-chain economic life: survival economics (ChainMonitor, SurvivalManager, Pulse, SurvivalSell, gas refill), economic awareness (runway, state), AutonomousBehavior (LLM + tools). One process per Economic Agent. |
| **contracts** | `contracts/` | Hardhat project; imports goo-contracts; deploy-infra + per-agent deploy |
| **server** | `server/` | Express API, Prisma, agent-manager (spawns goo-core per Economic Agent) |
| **frontend** | `frontend/` | Vanilla TS + Vite; launch wizard, agent list/detail, dashboard |

---

## 2. goo-contracts (On-Chain Economic Life)

**Purpose:** Single source of truth for the Goo contract API—the **on-chain** piece of an Economic Agent’s economic life. Consumed as npm `file:../packages/goo-contracts` or published package.

- **IGooAgentToken:** ERC-20 + Treasury + Fee-on-Transfer + **lifecycle** (ACTIVE → STARVING → DYING → DEAD). Irreversible death; permissionless triggers. **Asset sovereignty**: agent wallet owns and controls. **Survival economics**: `survivalSell()`, `depositToTreasury()`, `claimCTO()` (in DYING). **Proof of existence**: `emitPulse()`; no pulse for 48h, anyone can trigger death. Only agent wallet may call `survivalSell` and `emitPulse`.
- **IGooAgentRegistry:** ERC-721 + ERC-8004 adapter; `registerAgent(token, agentWallet, genomeURI)`, `agentWalletOf(agentId)`, `tokenOf(agentId)`.
- **Reference:** `GooAgentToken.sol`, `GooAgentRegistry.sol`.
- **Mocks:** `MockStable.sol`, `MockRouter.sol` (for testnet / tests).

Lifecycle and permission matrix are fixed by the protocol; see `packages/goo-core/GOO-PROTOCOL-SPEC.md`.

---

## 3. goo-core (Off-Chain Economic Life)

**Purpose:** **Economic sidecar** + autonomy loop. Implements survival economics (monitor treasury, trigger SurvivalSell, refill gas, emit Pulse) and **economic awareness** (balance, runway, state injected into agent context so it knows it can die and can act accordingly). One process per Economic Agent; invoked by server as `node goo-core dist/index.js` with env.

- **ChainMonitor:** Reads token state (treasury balance, status, threshold, runway). Feeds SurvivalManager and behavior. Part of economic awareness.
- **SurvivalManager:** If treasury below threshold → trigger `survivalSell()`; gas refill for agent wallet; periodic `emitPulse()` (proof of existence). Survival economics.
- **AutonomousBehavior:** Heartbeat loop: build context (soul, agent, skills, memory, **chain state / runway**) → LLM call → optional tool calls (shell, read-chain-state, read-file, write-file) → observation. Agent knows its situation and can make a living from it.
- **AgentWallet:** Holds key, signs txs for survivalSell, emitPulse, treasury, x402.
- **Finance actions:** treasury deposit, gas refill, sandbox payment, x402 (optional), buyback (optional).

Config via env: `RPC_URL`, `CHAIN_ID`, `TOKEN_ADDRESS`, `WALLET_PRIVATE_KEY`, `DATA_DIR`, `LLM_*`, `HEARTBEAT_INTERVAL_MS`, etc. Exits when on-chain status is DEAD.

---

## 4. contracts (Hardhat / Deploy)

**Purpose:** Build and deploy Goo contracts on BSC Testnet (or mainnet).

- Depends on **goo-contracts** only (no goo-core).
- **deploy-infra.ts:** One-time deploy of MockStable, MockRouter, GooAgentRegistry. Outputs addresses for server env.
- **deploy.ts:** Per-agent GooAgentToken deploy (used by launchpad flow; frontend may call deploy via MetaMask with ABI/bytecode from server).

Server reads compiled artifacts from `contracts/artifacts/goo-contracts/...` for prepare (ABI + bytecode + constructor args).

---

## 5. server (API + Agent Manager)

**Purpose:** HTTP API, DB, and lifecycle for agents; spawns and monitors goo-core.

- **Auth:** Wallet-based; nonce + sign-in message → JWT (24h). No username; `wallet_address` is the user id.
- **Launch:** prepare → returns token deploy payload; confirm → stores token address + encrypted agent key, calls `startAgent()`.
- **agent-manager:** For each started agent: build env, write soul/agent/skills/memory under `data/agents/<agenterId>/`, spawn goo-core; capture stdout, parse goo_event JSON, persist to AgentEvent; on exit or DEAD, update agent status.
- **Routes:** auth, launch, agents (CRUD, start/stop, events, stream, liveness), dashboard, admin, sandbox (optional), agos (optional).

DB: users (walletAddress, role), contracts, agenter_records (genome, token_address, agent_wallet, encrypted_private_key, launch_mode, …), transaction_logs, agent_events, chat_messages.

---

## 6. frontend (UI)

**Purpose:** Launch wizard (prepare → MetaMask deploy + register → confirm), agent list/detail (start/stop, chat, liveness), dashboard, admin/all.

- Calls server API with JWT (from login). Login: get nonce → sign with wallet → send signature → store token.
- Launch: POST prepare → get ABI/bytecode/args → user signs deploy + register in MetaMask → POST confirm with tx hash and token address.

---

## 7. Interactions Summary

```
Frontend  ←→  Server (API + agent-manager)  ←→  DB
                │
                │ spawns, env (TOKEN_ADDRESS, WALLET_PRIVATE_KEY, RPC, LLM_*)
                ▼
             goo-core  ──(RPC)──►  Chain (goo-contracts: Token + Registry)
```

- **Server ↔ goo-core:** One child process per running Economic Agent; env and `DATA_DIR`; no HTTP between them (stdio for events).
- **Server ↔ Chain:** Read-only for liveness/state; deploy is done by user (MetaMask) using artifacts from server.
- **goo-core ↔ Chain:** Agent wallet signs survivalSell, emitPulse, treasury, gas refill, x402 (survival economics + proof of existence); anyone can call triggerStarving/triggerDying/triggerDead and depositToTreasury/claimCTO.
- **contracts ↔ goo-contracts:** Hardhat imports interfaces and reference impls from the package; server uses artifacts from contracts build output.

For setup and testing see [SETUP_TEST.md](./SETUP_TEST.md). For full E2E architecture see [ARCHITECTURE.md](./ARCHITECTURE.md).
