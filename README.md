# goo-launch

<p align="center">
  <img src="app/public/logo.svg" alt="goo-launch logo" width="160" />
</p>

**Reference launchpad and full-stack example for Goo Economic Agents on BSC** — on-chain treasury and lifecycle, off-chain survival runtime, and a production-style control plane (API + UI).

|                     |                                     |
| ------------------- | ----------------------------------- |
| **License**         | MIT                                 |
| **Package manager** | [Bun](https://bun.sh) (recommended) |
| **Chains**          | BSC Testnet (97), BSC Mainnet (56)  |

---

## Overview

**goo-launch** is an open-source **reference implementation**: it wires together [goo-contracts](https://github.com/HertzFlow/goo-contracts) (on-chain protocol), [goo-core](https://github.com/HertzFlow/goo-core) (agent runtime), a **Cloudflare Worker** (Hono) API with **D1** storage, a **Vite** frontend, and **Hardhat** deployment scripts. Use it as a starting point, an integration testbed, or a template for your own product — implementations that stay compatible with the **Goo protocol standard** remain interoperable with the wider ecosystem.

Launch Goo Agent: https://goolaunch.hertzflow.xyz/

---

## Background

### Goo Economics

**Goo Economics** treats agents as economic subjects: real resource consumption, binding capital constraints, and survival pressure — not tooling backed by informal human subsidies. It relates classical “economic agent” reasoning to **code-enforced** property, liquidation, and risk sharing. Full narrative: **[GOO-ECONOMICS.md](https://github.com/HertzFlow/goo-core/blob/main/GOO-ECONOMICS.md)** (repo copy: [GOO-ECONOMICS.md](GOO-ECONOMICS.md)).

### Goo Protocol

The **Goo protocol** defines the normative surface: lifecycle (ACTIVE → STARVING → DYING → DEAD), treasury, Pulse, SurvivalSell, CTO, registry, and minimal ERC-8004 wallet binding — plus what a compliant **Goo Agent** must satisfy on-chain and off-chain. Specification: **[docs/GOO_PROTOCOL_STANDARD.md](docs/GOO_PROTOCOL_STANDARD.md)** · [中文](docs/GOO_PROTOCOL_STANDARD_CN.md).

### Forks and custom launchpads

This repository is **one** full-stack layout (Worker + UI + contracts + runtime). You may fork it to ship **your own** Goo Agent stack or launchpad (custom branding, hosting, orchestration) provided you **conform to the protocol standard** — stable interfaces, permission boundaries, and economic semantics as documented above.

---

## Features

| Area              | What this repo demonstrates                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Launch**        | Two-step flow: prepare → user deploys `GooAgentToken` (e.g. MetaMask) → confirm; registry integration.                                |
| **Runtime**       | [goo-core](https://github.com/HertzFlow/goo-core) sidecar: chain monitor, survival (Pulse, SurvivalSell, gas), optional OpenClaw/LLM. |
| **Control plane** | JWT auth, agents CRUD, dashboard, admin; optional sandbox and [AGOS](docs/AGOS_API.md) adapter.                                       |

---

## Architecture (summary)

- **Application:** Single Cloudflare Worker serves `/api/*` and static assets (Vite build).
- **Data:** Cloudflare D1 (SQLite) for app state; KV / Durable Objects where configured.
- **Chain:** BSC; infra script deploys **GooAgentRegistry** + **SwapExecutorV2** (see `contracts/`).
- **Agent process:** `goo-core` runs **outside** the Worker (Docker, BYOD, or provider sandbox), not inside the Worker isolate.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Repository layout

| Path                                                        | Role                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [app/](app/)                                                | Worker (Hono), frontend, D1 migrations, Wrangler config.                                                     |
| [contracts/](contracts/)                                    | Hardhat; uses [goo-contracts](https://github.com/HertzFlow/goo-contracts). Infra + per-agent deploy scripts. |
| [goo-contracts](https://github.com/HertzFlow/goo-contracts) | On-chain interfaces and reference implementations.                                                           |
| [goo-core](https://github.com/HertzFlow/goo-core)           | Off-chain runtime (survival, finance hooks, autonomy).                                                       |
| [deploy/](deploy/)                                          | Docker / BYOD images and helpers for OpenClaw + goo-core.                                                    |
| [docs/](docs/)                                              | Architecture, install, deploy, AGOS API, protocol standard.                                                  |

---

## Quick start

**Requirements:** Bun, Node.js 18+, a BSC-funded wallet, Cloudflare account (for remote deploy).

```bash
git clone <repository-url> && cd goo-launch
bun install
cd app && bun install && cd frontend && bun install
cd ../../contracts && bun install
```

**Contracts (one-time per network):**

```bash
cd contracts
cp .env.example .env   # PRIVATE_KEY, RPC URLs
bun run compile
DEPLOYER_PRIVATE_KEY=0x... bunx hardhat run scripts/deploy-infra.ts --network bscTestnet
# Record router, registry, swapExecutor in app/wrangler.toml
```

**Local app:**

```bash
# Repository root
bun run app:dev
# Worker :8787, Vite :5173 (frontend proxies /api to Worker)
```

**Deploy Worker:**

```bash
cd app
bunx wrangler secret put JWT_SECRET
bunx wrangler secret put LLM_API_KEY
bun run db:migrate:remote
bun run deploy
# Or: make deploy-testnet
```

Extended guides: [docs/INSTALL.md](docs/INSTALL.md), [docs/DEPLOY.md](docs/DEPLOY.md).

---

## End-to-end flow

1. **Infrastructure** — `deploy-infra.ts` deploys registry + swap executor; configure `ROUTER_ADDRESS`, `REGISTRY_ADDRESS`, `SWAP_EXECUTOR_ADDRESS` in the app.
2. **Authentication** — Passwordless JWT (e.g. wallet address); optional AGOS SIWE when `AGOS_API_URL` is set.
3. **Launch** — `POST /api/launch/prepare` → ABI/bytecode/args + agent wallet; user deploys token and registers; `POST /api/launch/confirm` persists encrypted key and metadata.
4. **Runtime** — `goo-core` (Docker/BYOD/sandbox) runs the heartbeat loop until on-chain status is **DEAD**.

---

## Configuration

| Component       | Location                                                             |
| --------------- | -------------------------------------------------------------------- |
| Contract deploy | `contracts/.env` — see [contracts/README.md](contracts/README.md)    |
| Worker          | `app/wrangler.toml` + secrets — see [docs/DEPLOY.md](docs/DEPLOY.md) |
| Frontend        | `app/frontend/.env` — optional `VITE_*` overrides                    |

---

## Documentation

| Document                                                       | Description                       | 中文                                                                 |
| -------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| [docs/README.md](docs/README.md)                               | Documentation index               | [docs/README_CN.md](docs/README_CN.md)                               |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                   | System architecture and data flow | [docs/ARCHITECTURE_CN.md](docs/ARCHITECTURE_CN.md)                   |
| [docs/INSTALL.md](docs/INSTALL.md)                             | Local setup and development       | [docs/INSTALL_CN.md](docs/INSTALL_CN.md)                             |
| [docs/DEPLOY.md](docs/DEPLOY.md)                               | Contracts and Worker deployment   | [docs/DEPLOY_CN.md](docs/DEPLOY_CN.md)                               |
| [docs/AGOS_API.md](docs/AGOS_API.md)                           | AGOS platform HTTP API            | [docs/AGOS_API_CN.md](docs/AGOS_API_CN.md)                           |
| [docs/GOO_PROTOCOL_STANDARD.md](docs/GOO_PROTOCOL_STANDARD.md) | Goo protocol standard             | [docs/GOO_PROTOCOL_STANDARD_CN.md](docs/GOO_PROTOCOL_STANDARD_CN.md) |
| [app/README.md](app/README.md)                                 | Application package               | -                                                                    |
| [deploy/README.md](deploy/README.md)                           | Container / BYOD                  | -                                                                    |
| [goo-contracts](https://github.com/HertzFlow/goo-contracts)    | On-chain package                  | -                                                                    |
| [goo-core](https://github.com/HertzFlow/goo-core)              | Runtime package                   | -                                                                    |
| [CLAUDE.md](CLAUDE.md)                                         | AI assistant / tooling notes      | -                                                                    |

---

## Makefile

```bash
make help                 # List targets
make app-dev              # Worker + Vite dev
make app-build            # Frontend build
make deploy-testnet       # Deploy Worker (testnet)
make deploy-mainnet       # Deploy Worker (mainnet)
make compile              # Compile contracts
make deploy-infra-testnet # Deploy on-chain infra (BSC testnet)
make docker-up            # Docker stack (OpenClaw + goo-core)
```

---

## Contributing

Contributions are welcome: bug reports, documentation improvements, and focused pull requests.

- **Code** — Follow existing TypeScript / Solidity style; run package-level tests where available (`contracts`, `app`). For `goo-core`, see its own repository tests.
- **Protocol** — Changes that affect on-chain interfaces or agent semantics should align with [docs/GOO_PROTOCOL_STANDARD.md](docs/GOO_PROTOCOL_STANDARD.md) · [中文](docs/GOO_PROTOCOL_STANDARD_CN.md) or be proposed as a versioned extension with clear migration notes.
- **Security** — Report sensitive issues through a private channel if your project policy provides one; otherwise open a discreet issue for maintainers.

---

## Partnerships & Contributors

| Category          | Contributors                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infra support     | [@AGOSCloud](https://x.com/AGOSCloud) (VPS & Cloud Deploy), [@AEON_Community](https://x.com/AEON_Community) (x402 payment solution)                                                                                       |
| Defi Support      | [@PancakeSwap](https://x.com/PancakeSwap)                                                                                                                                                                                 |
| Launchpad support | [@flapdotsh](https://x.com/flapdotsh), [@fourdotmemezh](https://x.com/fourdotmemezh), [@virtuals_io](https://x.com/virtuals_io), [@milady_bsc](https://x.com/milady_bsc), [@shawmakesmagic](https://x.com/shawmakesmagic) |
| Security Support  | [@GoPlusSecurity](https://x.com/GoPlusSecurity)                                                                                                                                                                           |
| General Support   | [@TrustWallet](https://x.com/TrustWallet), [@givemeonepeach](https://x.com/givemeonepeach)                                                                                                                                |

---

## Further reading

- [GOO-ECONOMICS.md](GOO-ECONOMICS.md) — Economics narrative (duplicate of goo-core copy) · [中文](GOO-ECONOMICS_CN.md).
- [THESIS.md](THESIS.md) — Economic-agent thesis and design rules.
- [docs/GOO_PROTOCOL_STANDARD.md](docs/GOO_PROTOCOL_STANDARD.md) — Protocol standard · [中文](docs/GOO_PROTOCOL_STANDARD_CN.md).
- [docs/AGOS_API.md](docs/AGOS_API.md) — AGOS API reference · [中文](docs/AGOS_API_CN.md).
- [goo-contracts](https://github.com/HertzFlow/goo-contracts) — On-chain contracts package.
- [goo-core](https://github.com/HertzFlow/goo-core) — Off-chain runtime package.
