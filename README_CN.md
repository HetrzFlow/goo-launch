# goo-launch

<p align="center">
  <img src="app/public/logo.svg" alt="goo-launch logo" width="160" />
</p>

**BSC 上 Goo 经济代理的参考启动台与全栈示例**——链上 treasury 与生命周期，链下生存运行时，以及面向生产的控制面（API + UI）。

|                     |                                     |
| ------------------- | ----------------------------------- |
| **许可**            | MIT                                 |
| **包管理器**      | [Bun](https://bun.sh)（推荐）       |
| **链**             | BSC 测试网（97）、BSC 主网（56）   |

---

## 概览（Overview）

**goo-launch** 是一个开源**参考实现**：它把 [goo-contracts](https://github.com/HertzFlow/goo-contracts)（链上协议）、[goo-core](https://github.com/HertzFlow/goo-core)（代理运行时）、**Cloudflare Worker**（Hono）API + **D1** 存储、**Vite** 前端，以及 Hardhat 部署脚本连接成一个可用的整合示例。你可以把它当作起点、集成测试台，或模板来构建自己的产品——只要实现与 **Goo 协议标准（Goo protocol standard）**保持兼容，就能与更广泛的生态互操作。

---

## 背景（Background）

### Goo 经济学（Goo Economics）

**Goo Economics** 把代理视为经济主体：真实的资源消耗、受约束的资本约束，以及生存压力——而不是依赖人类的“善意补贴”。它把经典“经济主体（economic agent）”推理，与**代码强制的**财产、清算与风险分担联系起来。完整叙事：  
**[GOO-ECONOMICS.md](./GOO-ECONOMICS_CN.md)**（仓库内中文版本；英文原文可在 [GOO-ECONOMICS.md](./GOO-ECONOMICS.md) 查阅）

### Goo 协议（Goo Protocol）

Goo 协议定义了规范的外壳（normative surface）：生命周期（ACTIVE → STARVING → DYING → DEAD）、treasury、Pulse、SurvivalSell、CTO、注册表，以及最小的 ERC-8004 钱包绑定——以及一个合格 **Goo Agent** 需要同时在链上和链下满足的要求。规范：  
[docs/GOO_PROTOCOL_STANDARD.md](docs/GOO_PROTOCOL_STANDARD.md) · [中文](docs/GOO_PROTOCOL_STANDARD_CN.md)

### 分叉与自定义启动台（Forks and custom launchpads）

本仓库提供一个完整的全栈布局（Worker + UI + 合约 + 运行时）。你可以在遵守协议标准的前提下，分叉它来交付你自己的 Goo 代理栈或启动台（自定义品牌、托管、编排），只要这些实现保持稳定接口、权限边界与经济语义即可。

---

## 功能（Features）

| 领域 | 本仓库展示的内容 |
| --- | --- |
| **启动** | 两步流程：prepare → 用户部署 `GooAgentToken`（如 MetaMask）→ confirm；注册表集成 |
| **运行时** | [goo-core](https://github.com/HertzFlow/goo-core) sidecar：链监控、生存（Pulse、SurvivalSell、gas），可选 OpenClaw/LLM |
| **控制面** | JWT 认证、代理 CRUD、仪表盘、管理；可选 sandbox 与 [AGOS](docs/AGOS_API.md) 适配器 |

---

## 架构（摘要）

- **应用：** 单一 Cloudflare Worker 负责 `/api/*` 与静态资源（Vite 构建产物）。
- **数据：** Cloudflare D1（SQLite）用于存储应用状态；配置项决定是否使用 KV / Durable Objects。
- **链：** BSC；基础设施脚本部署 **GooAgentRegistry** 与 **SwapExecutorV2**（见 `contracts/`）。
- **代理进程：** `goo-core` 在 Worker 之外运行（Docker、BYOD 或托管沙盒），不在 Worker isolate 内运行。

更多： [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## 仓库结构（Repository layout）

| 路径 | 角色 |
| --- | --- |
| [app/](app/) | Worker（Hono）、前端、D1 迁移、Wrangler 配置 |
| [contracts/](contracts/) | Hardhat；使用 [goo-contracts](https://github.com/HertzFlow/goo-contracts)；基础设施与每代理部署脚本 |
| [goo-contracts](https://github.com/HertzFlow/goo-contracts) | 链上接口与参考实现 |
| [goo-core](https://github.com/HertzFlow/goo-core) | 链下运行时（生存、金融钩子、自治） |
| [deploy/](deploy/) | Docker / BYOD 与 OpenClaw + goo-core 的工具 |
| [docs/](docs/) | 架构、安装、部署、AGOS API、协议标准 |

---

## 快速开始（Quick start）

**需求：** Bun、Node.js 18+、一个已为 BSC 资金提供（funded）的钱包，以及 Cloudflare 账号（用于远程部署）。

```bash
git clone <repository-url> && cd goo-launch
bun install
cd app && bun install && cd frontend && bun install
cd ../../contracts && bun install
```

**合约（每个网络一次性）：**

```bash
cd contracts
cp .env.example .env   # PRIVATE_KEY、RPC URLs
bun run compile
DEPLOYER_PRIVATE_KEY=0x... bunx hardhat run scripts/deploy-infra.ts --network bscTestnet
# 记录 router、registry、swapExecutor 到 app/wrangler.toml
```

**本地应用：**

```bash
bun run app:dev
# Worker :8787，Vite :5173（前端代理 /api 到 Worker）
```

**部署 Worker：**

```bash
cd app
bunx wrangler secret put JWT_SECRET
bunx wrangler secret put LLM_API_KEY
bun run db:migrate:remote
bun run deploy
# 或 make deploy-testnet
```

扩展指南： [docs/INSTALL_CN.md](docs/INSTALL_CN.md)、[docs/DEPLOY_CN.md](docs/DEPLOY_CN.md)。

---

## 端到端流程（End-to-end flow）

1. **基础设施：** `deploy-infra.ts` 部署注册表与 swap executor；在应用中配置 `ROUTER_ADDRESS`、`REGISTRY_ADDRESS`、`SWAP_EXECUTOR_ADDRESS`。
2. **认证：** 无口令 JWT（例如钱包地址）；当设置 `AGOS_API_URL` 时可选 AGOS SIWE。
3. **启动：** `POST /api/launch/prepare` → ABI/bytecode/args + 代理钱包；用户部署 token 并注册；`POST /api/launch/confirm` 保存加密密钥与元数据。
4. **运行时：** `goo-core`（Docker/BYOD/sandbox）运行 heartbeat 循环直到链上状态为 **DEAD**。

---

## 配置（Configuration）

| 模块 | 位置 |
| --- | --- |
| 合约部署 | `contracts/.env`（见 [contracts/README.md](contracts/README.md)） |
| Worker | `app/wrangler.toml` + secrets（见 [docs/DEPLOY_CN.md](docs/DEPLOY_CN.md)） |
| 前端 | `app/frontend/.env`（可选 `VITE_*` 覆盖） |

---

## 文档（Documentation）

| 文档 | 说明 |
| --- | --- |
| [docs/README_CN.md](docs/README_CN.md) | 文档索引 |
| [docs/ARCHITECTURE_CN.md](docs/ARCHITECTURE_CN.md) | 系统架构与数据流 |
| [docs/INSTALL_CN.md](docs/INSTALL_CN.md) | 本地安装与开发 |
| [docs/DEPLOY_CN.md](docs/DEPLOY_CN.md) | 合约与 Worker 部署 |
| [docs/AGOS_API_CN.md](docs/AGOS_API_CN.md) | AGOS 平台 HTTP API |
| [docs/GOO_PROTOCOL_STANDARD_CN.md](docs/GOO_PROTOCOL_STANDARD_CN.md) | Goo 协议标准 |
| [app/README.md](app/README.md) | 应用包 |
| [deploy/README.md](deploy/README.md) | 容器 / BYOD |
| [goo-contracts](https://github.com/HertzFlow/goo-contracts) | 链上包 |
| [goo-core](https://github.com/HertzFlow/goo-core) | 运行时包 |
| [CLAUDE.md](CLAUDE.md) | AI 助手/工具说明 |

---

## Makefile

```bash
make help                 # 列出目标
make app-dev              # Worker + Vite dev
make app-build            # 前端构建
make deploy-testnet       # 部署 Worker（测试网）
make deploy-mainnet       # 部署 Worker（主网）
make compile              # 编译合约
make deploy-infra-testnet # 部署链上基础设施（BSC 测试网）
make docker-up            # Docker 栈（OpenClaw + goo-core）
```

---

## 贡献（Contributing）

欢迎贡献：Bug 报告、文档改进与聚焦的 Pull Request。

- **代码：** 遵循现有的 TypeScript / Solidity 风格；在可用的情况下运行包级测试（`contracts`、`app`）。对于 `goo-core`，请查看其仓库的测试。
- **协议：** 如果修改会影响链上接口或代理语义，请让改动与 [docs/GOO_PROTOCOL_STANDARD_CN.md](docs/GOO_PROTOCOL_STANDARD_CN.md) 保持一致，或提供清晰的版本化扩展与迁移说明。
- **安全：** 如果发现敏感问题，优先走你项目的私有渠道；否则请通过 Issue 以“谨慎/低打扰”的方式提交给维护者。

---

## 合作伙伴与贡献者（Partnerships & Contributors）

| 类别 | 贡献者 |
|---|---|
| Infra support | [@AGOSCloud](https://x.com/AGOSCloud)（VPS & Cloud Deploy）、[@AEON_Community](https://x.com/AEON_Community)（x402 支付解决方案） |
| Defi Support | [@PancakeSwap](https://x.com/PancakeSwap) |
| Launchpad support | [@flapdotsh](https://x.com/flapdotsh)、[@fourdotmemezh](https://x.com/fourdotmemezh)、[@virtuals_io](https://x.com/virtuals_io)、[@milady_bsc](https://x.com/milady_bsc)、[@shawmakesmagic](https://x.com/shawmakesmagic) |
| Security Support | [@GoPlusSecurity](https://x.com/GoPlusSecurity) |
| General Support | [@TrustWallet](https://x.com/TrustWallet)、[@peachlfg](https://x.com/peachlfg) |

---

## 进一步阅读（Further reading）

- [GOO-ECONOMICS_CN.md](GOO-ECONOMICS_CN.md) — 经济学叙事
- [THESIS.md](THESIS.md) — 经济代理论文与设计规则
- [docs/GOO_PROTOCOL_STANDARD_CN.md](docs/GOO_PROTOCOL_STANDARD_CN.md) — 协议标准
- [docs/AGOS_API_CN.md](docs/AGOS_API_CN.md) — AGOS API 参考
- [goo-contracts](https://github.com/HertzFlow/goo-contracts) — 链上合约包
- [goo-core](https://github.com/HertzFlow/goo-core) — 链下运行时包

