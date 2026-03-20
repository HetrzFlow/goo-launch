# app/ — Cloudflare Worker + Vite Frontend

The **goo-launch** application: a single Cloudflare Worker (Hono) that serves the API and the Vite-built frontend as static assets. Database: **Cloudflare D1** (SQLite). Optional: AGOS adapter, sandbox, LLM proxy.

---

## Structure

| Path | Description |
|------|-------------|
| **src/** | Worker backend: Hono app, routes, D1 schema, durable objects (AgentEventHub, AgentProvisioner), auth, launch, agents, dashboard, admin, sandbox, agos, health, llm-proxy. |
| **frontend/** | Vite + vanilla TypeScript. Multi-page: index (agent list), login, launch (2-step wizard), agent (detail + controls), dashboard, all. Build output → `public/`. |
| **public/** | Built frontend assets (Vite writes here). Served by Worker via ASSETS binding. |
| **wrangler.toml** | Worker config: vars, secrets, D1, KV, Durable Objects, triggers (cron). Envs: default (testnet), mainnet. |
| **src/db/** | Drizzle schema and migrations for D1. |

---

## Scripts (package.json)

| Script | Description |
|--------|-------------|
| `dev` | Concurrent: wrangler dev (worker :8787) + vite dev (frontend :5173). Vite proxies /api to worker. |
| `dev:worker` | Worker only. |
| `dev:frontend` | Frontend only. |
| `build` | sync:artifacts + build:frontend. Copies contract artifacts into frontend/sync and runs Vite build. |
| `deploy` | build + wrangler deploy. |
| `db:migrate:local` | Apply D1 migrations to local DB. |
| `db:migrate:remote` | Apply D1 migrations to remote D1 (testnet). |
| `db:generate` | Generate new Drizzle migration from schema changes. |

---

## API Routes (summary)

- **/ping**, **/api/config** — Public. Health and chain/config for frontend.
- **/api/auth** — Login (passwordless or AGOS SIWE), GET /me.
- **/api/launch** — Prepare (ABI + bytecode + constructor args + agent wallet), confirm (tx hash, token address). Pending launch state.
- **/api/agents** — CRUD, state, runtime-status, export-key, byod-config, agos-runtime-config, ws (events). Sub-routes: chain (liveness), chat (chat-history, events, alerts), debug, erc8004.
- **/api/my** — contracts, agenters, transactions (current user).
- **/api/all** — stats, users, contracts, agenters, transactions (read-only, any auth).
- **/api/admin** — DELETE users (admin only).
- **/api/sandbox** — Create/confirm sandbox, status, goo-core-status, gateway-health, logs, events, debug-payload.
- **/api/agos** — AGOS adapter when AGOS_API_URL set: config, agents, balance, provision/health, models, wallets, remote status/logs, test routes.
- **/api/llm-proxy** — LLM proxy per agent (e.g. v1/models).
- **/api/health** — Health check (admin), agent health.

All protected routes use `authRequired` (JWT Bearer). Some use `adminRequired`.

---

## Environment (wrangler.toml)

**Vars** (testnet/mainnet): RPC_URL, CHAIN_ID, NETWORK, ROUTER_ADDRESS, SWAP_EXECUTOR_ADDRESS, REGISTRY_ADDRESS, ADMIN_WALLET, LLM_API_URL, LLM_MODEL, BSC_LLM_ROUTER_URL, X402_PAYMENT_TOKEN, SANDBOX_MANAGER_URL, AGOS_*, MIN_CONTRIBUTION_BNB, TREASURY_BNB_BPS, etc.

**Secrets** (set via `wrangler secret put`): JWT_SECRET, LLM_API_KEY.

**Bindings**: D1 database, KV (if used), Durable Objects (AgentEventHub, AgentProvisioner), ASSETS (static frontend).

---

## Run

From repo root:

```bash
bun run app:dev    # or: cd app && bun run dev
```

Then open http://localhost:5173. To deploy: `bun run app:deploy` or `make deploy-testnet` / `make deploy-mainnet`. See [docs/DEPLOY.md](../docs/DEPLOY.md) and [docs/INSTALL.md](../docs/INSTALL.md).
