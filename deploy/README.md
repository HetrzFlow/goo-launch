# deploy/ — Docker and BYOD

Docker and BYOD (Bring Your Own Device) setup for running a **Goo Agent** with OpenClaw (LLM gateway) and **goo-core** (economic sidecar) in a single container.

---

## Structure

| Path | Description |
|------|-------------|
| **docker/** | Main deployment. |
| **docker/docker-compose.yml** | Single service `goo-agent`: OpenClaw + goo-core, network_mode host. Env: AGOS_*, OPENCLAW_*, GOO_SERVER_URL, AGENT_ID, AGENT_RUNTIME_TOKEN, RPC_URL, TOKEN_ADDRESS, WALLET_PRIVATE_KEY, DATA_DIR, etc. Volumes: workspace, goo-core data, sandbox logs. |
| **docker/entrypoint.sh** | Entrypoint: fetch agent config from GOO_SERVER_URL (runtime-config API), write soul/agent/skills/memory and .env for goo-core, start OpenClaw gateway, start goo-core sidecar, optional control server. |
| **docker/goo-core-wrapper.sh** | Runs goo-core (from image or install): writes AGENT_PRIVATE_KEY_FILE, runs goo-core with env from .env. |
| **docker/control-server.mjs** | Optional HTTP control API (e.g. restart goo-core, status). |
| **docker/Dockerfile** | Image build (OpenClaw + goo-core deps, entrypoint). |
| **docker/.env.example** | Example env for docker-compose. |
| **docker/byod-setup.sh** | BYOD setup script: generate .env from template, instructions for running the container with user-supplied TOKEN_ADDRESS and WALLET_PRIVATE_KEY. |
| **docker/hooks/** | Optional hooks (e.g. chat-sync). |

---

## Usage

**With AGOS / goo-server:** Set GOO_SERVER_URL, AGENT_ID, AGENT_RUNTIME_TOKEN. The entrypoint fetches runtime config (soul, agent, skills, memory, LLM, keys) from the server and starts OpenClaw + goo-core.

**BYOD (self-hosted):** Use byod-setup.sh or manually set TOKEN_ADDRESS, WALLET_PRIVATE_KEY, RPC_URL, CHAIN_ID, OPENCLAW_GATEWAY_TOKEN, and optionally OPENAI_BASE_URL, OPENAI_API_KEY. No GOO_SERVER_URL needed; config is local.

**Run:**

```bash
cd deploy/docker
cp .env.example .env
# Edit .env: TOKEN_ADDRESS, WALLET_PRIVATE_KEY, OPENCLAW_GATEWAY_TOKEN, etc.
docker compose up -d
# Or from repo root:
make docker-up
```

**Makefile (repo root):** docker-build, docker-push, docker-run, docker-up, docker-down, docker-logs. See [Makefile](../Makefile).

---

## Requirements

- Docker (and Docker Compose). network_mode: host so the container shares the host network (gateway and goo-core ports visible on host).
- For server-fetched config: reachable GOO_SERVER_URL and valid AGENT_ID + AGENT_RUNTIME_TOKEN (from launch confirm or agent export-key).
- For BYOD: user must have TOKEN_ADDRESS and WALLET_PRIVATE_KEY (e.g. from launch confirm BYOD flow).

---

## See also

- [packages/goo-core/README.md](../packages/goo-core/README.md) — goo-core runtime.
- [docs/DEPLOY.md](../docs/DEPLOY.md) — Full deployment guide (contracts + Worker).
- [docs/INSTALL.md](../docs/INSTALL.md) — Local install and run.
