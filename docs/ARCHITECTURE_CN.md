# 端到端架构：Goo 代理-代币启动台

本文档描述本仓库的架构：一个基于 BSC 的、由 goo 驱动的 agent-token 启动台（launchpad）。Goo 是一个 **经济层（economic-layer）协议**，为 AI 代理提供 **经济生命（economic life）**——真实的消耗、真实的死亡、以及生存压力——使其成为 **经济主体（Economic Agents）**。该启动台实现完整的 E2E 流程，包含 **Cloudflare Worker**（API + 前端）、**D1**（数据库），以及用于代理运行时的 **Docker/BYOD/AGOS**。

---

## 1. 概览

该项目是一个**全栈示例**，让用户能够：

1. 通过两步 MetaMask 流程，用链上代币（GooAgentToken）来 **启动（Launch）**一个 **经济代理**。代理获得经济生命：生命周期（不可逆死亡）、资产主权、存在证明（Pulse）、生存经济学。
2. 通过 **goo-core** 在 Worker **之外**运行代理：在 **沙盒**（e2b）、**Docker**（deploy/docker）、**BYOD** 或由 **AGOS** 配置的容器中运行。Worker 不会生成进程；它提供配置 API、事件接收（event ingest），并在沙盒/AGOS 场景下提供控制端点（control endpoints）。
3. 通过 API 和 UI **进行操作（Operate）**：认证（auth）、启动（launch）、代理 CRUD、存活/活性（liveness）、聊天（chat）、事件（events）、仪表盘（dashboard）、管理（admin）、沙盒控制，以及 AGOS 适配器。

**部署（Deployment）：**

- **后端 + 前端：** 单一 **Cloudflare Worker**（Hono）。Worker 同时提供 API（`/api/*`）和由 Vite 构建的静态前端（ASSETS 来自 `app/public/`）。不需要额外 VPS 或 Express 服务。
- **数据库：** **Cloudflare D1**（SQLite）。包含表：`users`、`contracts`、`agenter_records`、`transaction_logs`；迁移脚本位于 `app/src/db/migrations/`。
- **代理运行时：** **goo-core** 在一个独立环境运行：e2b 沙盒、Docker（deploy/docker）、BYOD 主机，或由 AGOS 配置的 VM。Worker 暴露 `GET /api/agents/:id/runtime-config`，并提供 BYOD/AGOS 配置，让这些运行时可以完成自举（bootstrap）。
- **链：** BSC。支持 BSC Testnet（97）或 Mainnet（56）。合约包括 GooAgentToken、GooAgentRegistry、SwapExecutorV2（来自 https://github.com/HertzFlow/goo-contracts；通过 `contracts/` 下的 Hardhat 部署脚本部署）。

---

## 2. 高层图（High-Level Diagram）

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

## 3. 端到端工作流（End-to-End Workflow）

### 3.1 一次性：部署基础设施（Deploy Infrastructure）

- 运行 **contracts** 的 Hardhat 脚本：`deploy-infra.ts`。
- 部署：**GooAgentRegistry**、**SwapExecutorV2**（封装现有的 PancakeSwap V2 Router）。不会部署 mocks；使用真实的 BSC router/WBNB。
- 输出（JSON）：`router`、`registry`、`swapExecutor`、`wbnb`。通过 `app/wrangler.toml` 配置 **app**：`ROUTER_ADDRESS`、`REGISTRY_ADDRESS`、`SWAP_EXECUTOR_ADDRESS`。

### 3.2 用户：认证（Auth）

- **无口令：** 用户登录（例如钱包地址或用户名）；Worker 签发 JWT（24h）。存储在客户端，并在 API 调用中以 Bearer 形式发送。
- **可选：** 当设置了 `AGOS_API_URL` 时，可使用 AGOS 的 SIWE 流程；`NONCE_KV` 用于保存签名登录所需的 nonce。

### 3.3 启动代理（2 步骤，MetaMask）

1. **Prepare（准备阶段）**

   - `POST /api/launch/prepare`：body 包含代理名称、介绍、token 符号、可选的 genome（指令、技能、记忆）、`sandbox_provider`、`llm_provider` 等。
   - Worker：创建 D1 记录（`agenter_records`），生成 **agent wallet** 密钥对，并返回 **token ABI + bytecode + constructor args**（来自已编译并同步到 app 的 goo-contracts artifacts）。

2. **链上部署（User on-chain）**

   - 前端：用户连接 MetaMask（BSC），签署部署 **GooAgentToken**（ERC-20 + treasury + lifecycle），并在 **GooAgentRegistry** 中完成注册。用户在 BNB 上为 gas 付费。

3. **Confirm（确认阶段）**

   - `POST /api/launch/confirm`：前端发送 tx hash、token 地址、部署者地址。
   - Worker：更新 AgenterRecord（`token_address`、`agent_wallet`、状态 `status`），并将 **加密**的代理私钥存入 D1。
   - Worker 不会启动 goo-core；用户自行运行 Docker/BYOD，或通过 AGOS/sandbox 流程启动，这些流程会从 `GET /api/agents/:id/runtime-config`（或 `byod-config` / `agos-runtime-config`）拉取配置。

### 3.4 代理运行时（Agent Runtime）

- **goo-core** 运行在以下环境之一：**e2b sandbox**（Worker 创建沙盒，用户可通过 Worker 的沙盒 API 重启 goo-core）、**Docker**（deploy/docker：OpenClaw + goo-core 在同一容器中；entrypoint 从 Worker 拉取 runtime-config）、**BYOD**（用户在主机或容器中自行运行，提供 `TOKEN_ADDRESS` + `WALLET_PRIVATE_KEY`，配置来自 Worker 的 byod-config）、**AGOS**（AgentProvisioner DO + AGOS API 配置 VM/容器并运行 goo-core）。
- **goo-core** 循环：ChainMonitor 读取 token 状态 → SurvivalManager（Pulse、SurvivalSell、gas refill）→ AutonomousBehavior（可选 LLM/OpenClaw）。当链上状态变为 **DEAD**，goo-core 退出。
- Worker 提供：
  - runtime-config（env，以及 soul/agent/skills/memory 的内容）
  - 事件接收（event ingest）：`POST /api/agents/:id/events/ingest`（若有回调）
  - 活性（liveness）：Worker 读取链与最后一次 pulse（来自 DB 或合约）
  - 沙盒重启 goo-core：`restart-goo-core`（通过 SSH 进入 e2b）
  - AGOS 配置/健康检查（provision/health）

### 3.5 API 与 UI

- **Agents：** 列表、获取、状态、liveness、runtime-status、导出密钥（export-key）、byod-config、agos-runtime-config、ws（events）、chat、events、alerts、debug。
- **Dashboard：** `/api/my`（contracts、agenters、transactions）。
- **Admin：** `/api/all`（stats、users、contracts、agenters、transactions），以及 `/api/admin`（例如删除用户）。
- **Sandbox：** 创建/确认沙盒、状态、`goo-core-status`、`restart-goo-core`、日志与事件。
- **AGOS：** 当设置 `AGOS_API_URL` 时——认证、代理、余额、provision/health、models、远程状态/日志。

---

## 4. 链上生命周期（goo-contracts）

- **状态（States）：** ACTIVE → STARVING → DYING → DEAD（DEAD 状态下不可退出）。
- **ACTIVE：** treasury 高于阈值；代理获得收益（Fee-on-Transfer）并消耗资金（例如 SurvivalSell 用于补充 treasury，withdrawToWallet 用于 gas）。
- **STARVING：** treasury 低于阈值；存在宽限期；任何人都可以 deposit 到 treasury 来恢复到 ACTIVE。
- **DYING：** 宽限期结束；进入 “terminal window（终端窗口）”：SurvivalSell + CTO（Successor）窗口；Pulse timeout 或最长持续时间达到后 → DEAD。
- **DEAD：** 终态；treasury 可以被销毁至 `0xdead`；token 仍可在链上交易（不再受 FoT 影响）。

---

## 5. 关键约定（Key Conventions）

- **Agent status（在 D1 中）：** 例如 created、deployed、active、stopped、dead（具体取决于实现）。
- **Launch modes / providers：** cloud（旧版）、sandbox（e2b）、byod（用户自托管）、agos（由 AGOS 配置）。
- **后端（Backend）：** 仅 TypeScript。
  - **Worker：** Cloudflare 上的 Hono
  - **DB：** D1（Drizzle）
  - **runtime：** goo-core 不在 Worker 内运行（sandbox/Docker/BYOD/AGOS）。
- **Secrets：** `JWT_SECRET`、`LLM_API_KEY` 通过 `wrangler secret put` 设置。配置在 `wrangler.toml` 的 `[vars]` 与 `[env.mainnet.vars]`。

---

## 6. 数据流（序列 Sequence）

1. **基础设施（Infra，one-time）**

   - 操作员运行 `deploy-infra.ts` → 部署 GooAgentRegistry + SwapExecutorV2 → 将地址写入 `app/wrangler.toml`（`ROUTER_ADDRESS`、`REGISTRY_ADDRESS`、`SWAP_EXECUTOR_ADDRESS`）。

2. **认证（Auth）**

   - 用户调用 `POST /api/auth/login`（例如 `wallet_address` 或 AGOS SIWE）。Worker 在 D1 中创建/更新用户并返回 JWT。后续请求使用 `Authorization: Bearer <token>`。

3. **启动（Launch）**

   - `POST /api/launch/prepare`（name、intro、symbol、genome、…）→ Worker 创建 agenter_record，生成代理密钥对，返回 ABI/bytecode/constructor args。
   - 前端：用户通过 MetaMask 部署 GooAgentToken，并在 Registry 中完成注册。
   - `POST /api/launch/confirm`（txHash、tokenAddress、deployerAddress、…）→ Worker 更新记录，并将加密密钥存入 D1。不会启动进程；运行时由用户自行启动（Docker/BYOD），或由 AGOS/sandbox 流程启动。

4. **运行时（Runtime）**

   - 外部运行时（Docker/BYOD/AGOS/sandbox）拉取 `GET /api/agents/:id/runtime-config`（或 byod-config / agos-runtime-config），写入 env 与 soul/agent/skills/memory，然后运行 goo-core。
   - goo-core 的 heartbeat：读取链上状态 → 生存动作（survival actions）→ 可选 LLM。
   - 事件可以通过 `POST /api/agents/:id/events/ingest` 发送给 Worker。
   - 活性（Liveness）：Worker 从 BSC RPC 与 token 合约读取链上状态，并结合最后 pulse 来判断。

5. **API**

   - 所有受保护路由都使用 JWT（`authRequired`）。
   - 管理路由可能使用 `adminRequired`。
   - 活性与链上状态由 Worker 从 BSC RPC 与 token 合约读取。

---

**另请参阅：** [INSTALL_CN.md](./INSTALL_CN.md)、[DEPLOY_CN.md](./DEPLOY_CN.md)、[app/README.md](../app/README.md)、[deploy/README.md](../deploy/README.md)。

