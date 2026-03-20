# goo-launch 安装与设置

本文档包含：如何安装、如何在本地运行 app 和合约，以及本地部署/运行的步骤。生产部署请参阅 [DEPLOY_CN.md](./DEPLOY_CN.md)。

---

## 1. 前置条件（Prerequisites）

- **bun** — 项目默认包管理器（也可以用 npm/pnpm 以及等价命令替代）
- **Node.js** >= 18
- **Git**
- 用于合约部署与代理启动的 **BSC 钱包**（测试网/主网 BNB）
- **Cloudflare 账号** — 用于部署 Worker（仅本地开发可选）

---

## 2. 克隆与安装

```bash
git clone <repo-url>
cd goo-launch
bun install
```

**App（Worker + 前端）：**

```bash
cd app
bun install
cd frontend
bun install
cd ../..
```

**合约（Contracts）：**

```bash
cd contracts
bun install
cd ..
```

**依赖库（goo-contracts、goo-core）：** 本仓库将其作为依赖消费。上游来源：

- `goo-contracts`: https://github.com/HertzFlow/goo-contracts
- `goo-core`: https://github.com/HertzFlow/goo-core

如果你需要在本地构建 `goo-core`（例如自托管代理）：

```bash
git clone https://github.com/HertzFlow/goo-core
cd goo-core
bun install && bun run build
cd ..
```

---

## 3. 合约设置（Contracts setup）

```bash
cd contracts
cp .env.example .env
```

编辑 `.env`：

| 变量 | 描述 |
|------|------|
| `PRIVATE_KEY` 或 `DEPLOYER_PRIVATE_KEY` | 部署者钱包私钥（0x 前缀） |
| `BSC_TESTNET_RPC_URL` | BSC 测试网 RPC（示例中的默认值） |
| `BSC_MAINNET_RPC_URL` | BSC 主网 RPC（可选） |
| `BSCSCAN_API_KEY` | 可选，用于合约验证 |

```bash
bun run compile
bun run test
```

---

## 4. App 设置（Worker + 前端）

**本地开发（不部署）：**

从仓库根目录开始：

```bash
bun run app:dev
```

- Worker 在 **8787** 端口运行（wrangler dev）。
- Vite 前端在 **5173** 端口运行；它会将 `/api` 代理到 Worker。
- 打开 `http://localhost:5173` 使用 UI。

**本地 D1（SQLite）：** Wrangler 使用本地 D1 数据库。应用迁移（migrations）：

```bash
cd app
bun run db:migrate:local
```

**环境：** Worker 配置在 `app/wrangler.toml`（`[vars]`）中。对本地开发来说默认值可能就够了；如果你希望使用完整的启动流程，至少设置 `RPC_URL`、`CHAIN_ID`、`ROUTER_ADDRESS`、`REGISTRY_ADDRESS`、`SWAP_EXECUTOR_ADDRESS`。你也可以直接从 `deploy-infra` 输出复制，或使用 [DEPLOY_CN.md](./DEPLOY_CN.md) 中给出的测试网默认值。

---

## 5. 部署基础设施（每个网络仅需一次）

在启动代理之前，需要部署 Registry 和 SwapExecutor：

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=0x... bunx hardhat run scripts/deploy-infra.ts --network bscTestnet
```

保存打印出来的地址，并写入 `app/wrangler.toml`：

- `router` → 在 wrangler 中不直接使用；SwapExecutor 会封装它。
- `registry` → `REGISTRY_ADDRESS`
- `swapExecutor` → `SWAP_EXECUTOR_ADDRESS`
- 如果应用需要（用于展示或配置），可以选择性地设置 `ROUTER_ADDRESS`。

---

## 6. 运行（摘要）

| 目标 | 命令 |
|------|------|
| App dev（worker + frontend） | `bun run app:dev` 或 `make app-dev` |
| 仅前端 | `cd app/frontend && bun run dev` 或 `make app-dev-frontend` |
| 仅 Worker | `cd app && bun run dev:worker` 或 `make app-dev-worker` |
| 编译合约 | `cd contracts && bun run compile` 或 `make compile` |
| 合约测试 | `cd contracts && bunx hardhat test` 或 `make test-contracts` |
| 部署 Worker（测试网） | `cd app && bun run deploy` 或 `make deploy-testnet` |
| 部署 Worker（主网） | `cd app && bunx wrangler deploy --env mainnet` 或 `make deploy-mainnet` |
| Docker（OpenClaw + goo-core） | `make docker-up`（见 [deploy/README.md](../deploy/README.md)） |

---

## 7. 验证（Verify）

1. **健康检查（Health）：** 当 app 正在运行时：
   - `curl http://localhost:8787/ping` 或
   - `curl http://localhost:8787/api/health`
2. **配置（Config）：** `curl http://localhost:8787/api/config` — 应返回 `chain_id`、`router_address` 等。
3. **登录（Login）：** `POST /api/auth/login`，body 为 `{ "wallet_address": "0x..." }`（如果启用了 AGOS SIWE 则按其流程）— 应返回一个 JWT。
4. **启动（Launch）：** 打开 UI 在 `http://localhost:5173` 连接钱包并完成启动流程（需要已部署基础设施并设置 wrangler vars）。

---

## 8. 疑难排查（Troubleshooting）

- **合约编译失败：** 确认 `contracts/` 中配置了一个有效的 `goo-contracts` 依赖，然后在 `contracts/` 下运行 `bun install` + `bun run compile`。
- **Worker 启动失败：** 检查 `app/wrangler.toml` 的绑定（D1、KV 等），并确认迁移已应用（`bun run db:migrate:local`）。
- **前端无法访问 API：** 确保使用 `bun run app:dev`（让 Vite 将 `/api` 代理到 Worker）；或在 `app/frontend/vite.config.ts` 中为 Vite 配置代理到 Worker 地址。
- **启动失败：** 确认 `wrangler.toml` 中设置了 `ROUTER_ADDRESS`、`REGISTRY_ADDRESS`、`SWAP_EXECUTOR_ADDRESS`，并且 `deploy-infra` 与 `CHAIN_ID` 使用的是同一网络（测试网/主网）。

