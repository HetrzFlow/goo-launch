# 部署指南

本文档讲解如何部署 `goo-launch` 的两个核心组件：

1. **智能合约**（一次性基础设施 + 每个代理的 token）部署到 BSC
2. **Cloudflare Worker**（后端 API + 前端）部署到 Cloudflare

---

## 前置条件（Prerequisites）

- **bun**（包管理器）— 项目中会贯穿使用
- **Node.js** >= 18
- 一个带 BNB 用于 gas 的 BSC 钱包（测试网或主网）
- 已登录并验证过 Wrangler CLI 的 Cloudflare 账号（`bunx wrangler login`）

---

## 1. 智能合约（Smart Contracts）

### 1.1 设置（Setup）

```bash
cd contracts
bun install
```

从示例创建 `.env`：

```bash
cp .env.example .env
```

填写：

| 变量 | 描述 |
|------|------|
| `PRIVATE_KEY` | 部署者钱包私钥（包含 0x 前缀） |
| `BSC_TESTNET_RPC_URL` | BSC 测试网 RPC（默认提供） |
| `BSC_MAINNET_RPC_URL` | BSC 主网 RPC（默认提供） |
| `BSCSCAN_API_KEY` | 可选，用于合约验证 |

### 1.2 编译（Compile）

```bash
bun run compile
```

Solidity 0.8.28（启用 viaIR）、cancun EVM、200 次 optimizer runs。

### 1.3 部署基础设施（每个网络仅需一次）

部署 **GooAgentRegistry** 和 **SwapExecutorV2**（封装 PancakeSwap V2 Router）。

```bash
# 测试网（chainId 97）
DEPLOYER_PRIVATE_KEY=0x... bunx hardhat run scripts/deploy-infra.ts --network bscTestnet

# 主网（chainId 56）
DEPLOYER_PRIVATE_KEY=0x... bunx hardhat run scripts/deploy-infra.ts --network bsc
```

将输出 JSON 打到标准输出（stdout）：

```json
{
  "router": "0x...",
  "registry": "0x...",
  "swapExecutor": "0x...",
  "wbnb": "0x..."
}
```

保存这些地址——它们会被写入 `app/wrangler.toml`：

| 输出 | Wrangler 变量 |
|------|---------------|
| `router` | `ROUTER_ADDRESS` |
| `registry` | `REGISTRY_ADDRESS` |
| `swapExecutor` | `SWAP_EXECUTOR_ADDRESS` |

### 1.4 部署代理 Token（每个代理）

通常在启动流程中由 Cloudflare Worker 调用，但也可以手动运行：

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

请查看 `contracts/scripts/deploy.ts`，其中包含所有可选的经济参数（burn rate、runway hours、pulse timeout 等）。

### 1.5 当前已部署地址

**BSC 测试网（97）**

| 合约 | 地址 |
|------|------|
| Router（PancakeSwap V2） | `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` |
| SwapExecutorV2 | `0x8A62B1d2E614d6bdDA89ef5567A555D6868F137c` |
| GooAgentRegistry | `0x14D59E3db1d8b51924a03F13dFf5F88dB73021AE` |

**BSC 主网（56）**

| 合约 | 地址 |
|------|------|
| Router（PancakeSwap V2） | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| SwapExecutorV2 | `0x393833ca5B1450D9521F734cF12BDEE97aD1237e` |
| GooAgentRegistry | `0xAa98Ea2f764e93721cc1e45370440e9DCA8a3A76` |

---

## 2. Cloudflare Worker

该应用是一个 Cloudflare Worker（Hono 后端），并将 Vite 构建出的前端作为静态资源提供服务。

### 2.1 设置（Setup）

```bash
cd app
bun install

cd frontend
bun install
```

### 2.2 本地开发（Local Development）

从仓库根目录开始：

```bash
bun run app:dev
```

它会并行运行 `wrangler dev`（Worker 在 :8787）和 `vite dev`（前端在 :5173）。Vite 开发服务器会将 `/api` 代理到 Worker。

### 2.3 数据库迁移（Database Migrations）

Worker 使用 Cloudflare D1（SQLite），迁移脚本位于 `app/src/db/migrations/`。

```bash
cd app

# 应用于本地 D1（用于开发）
bun run db:migrate:local

# 应用于远程 D1（第一次部署前或新增迁移后）
bun run db:migrate:remote

# 主网
bunx wrangler d1 migrations apply goo-server-mainnet --remote
```

### 2.4 Secrets

首次部署前先设置 secrets：

```bash
cd app

# 测试网（默认环境）
bunx wrangler secret put JWT_SECRET
bunx wrangler secret put LLM_API_KEY

# 主网
bunx wrangler secret put JWT_SECRET --env mainnet
bunx wrangler secret put LLM_API_KEY --env mainnet
```

### 2.5 环境变量（Environment Variables）

所有 env 变量都在 `app/wrangler.toml` 中定义：测试网使用 `[vars]`，主网使用 `[env.mainnet.vars]`。

需要配置的关键变量如下：

| 变量 | 描述 | 示例 |
|------|------|------|
| `RPC_URL` | BSC RPC 地址 | `https://bsc-dataseed.binance.org/` |
| `CHAIN_ID` | `97`（测试网）或 `56`（主网） | `56` |
| `NETWORK` | `testnet` 或 `mainnet` | `mainnet` |
| `ROUTER_ADDRESS` | PancakeSwap V2 Router | 来自 deploy-infra 输出 |
| `SWAP_EXECUTOR_ADDRESS` | SwapExecutorV2 | 来自 deploy-infra 输出 |
| `REGISTRY_ADDRESS` | GooAgentRegistry | 来自 deploy-infra 输出 |
| `ADMIN_WALLET` | 管理员钱包地址（小写） | `0x...` |
| `LLM_API_URL` | LLM 提供方端点 | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | 模型 ID | `claude-sonnet-4-6` |
| `BSC_LLM_ROUTER_URL` | x402 LLM 端点（可选） | `https://testnet-api.bscllmrouter.com` |
| `X402_PAYMENT_TOKEN` | x402 支付用的 USDT 地址 | `0x...` |
| `AGOS_API_URL` | AGOS 平台 URL（启用 AGOS） | `https://claw-api.agos.fun` |
| `AGOS_IMAGE` | AGOS 代理的 Docker 镜像 | `hgamiui9/goo-agos:v0.1.4` |
| `MIN_CONTRIBUTION_BNB` | 启动代理的最小 BNB | `0.01` |
| `TREASURY_BNB_BPS` | treasury 的 BNB 拆分（基点） | `1200`（12%） |

### 2.6 构建与部署（Build & Deploy）

```bash
# 从仓库根目录执行：构建前端并部署 Worker
bun run app:deploy

# 或手动执行：
cd app
bun run build          # 同步合约 artifacts + 构建 Vite 前端
bunx wrangler deploy   # 部署到测试网（默认）
```

**主网：**

```bash
cd app
bun run build
bunx wrangler deploy --env mainnet
```

### 2.7 已部署 URL（Deployed URLs）

| 环境 | URL |
|------|-----|
| 测试网 | `https://goo-server-testnet.delicate-mouse-f8ca.workers.dev` |
| 主网 | `https://goo-server-mainnet.delicate-mouse-f8ca.workers.dev` |

### 2.8 定时触发器（Cron Trigger）

Worker 配置了 `*/5 * * * *` 的 cron 触发器，用于定期任务（例如代理健康检查等）。该配置位于 `wrangler.toml` 的 `[triggers]` 中。

---

## 3. 验证部署（Verify Deployment）

当合约与 Worker 都部署完成后：

1. **健康检查（Health check）：** `GET /api/health` 应返回 `{ "ok": true }`
2. **登录（Login）：** `POST /api/auth/login` 携带钱包地址
3. **启动流程（Launch flow）：** 打开前端，连接钱包并启动一个新的 Goo 代理
4. **合约交互：** 启动流程会在链上部署一个 GooAgentToken，并将其注册到 GooAgentRegistry

---

## 4. 文件参考（File Reference）

```
contracts/
  hardhat.config.ts         # Solidity 编译器 + 网络配置
  scripts/deploy-infra.ts   # 一次性基础设施部署
  scripts/deploy.ts         # 每个代理的 token 部署
  .env.example              # 必需的环境变量

app/
  wrangler.toml             # Worker 配置（bindings、env、D1、KV、DO）
  src/                      # Hono 后端路由
  frontend/                 # Vite + 原生 TS 前端
  public/                   # 构建后的前端静态资源输出目录
```

