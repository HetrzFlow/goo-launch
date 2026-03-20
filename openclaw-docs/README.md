# OpenClaw Workspace Files

goo-core generates these files into the OpenClaw workspace directory
(`/root/.openclaw/workspace/` by default) on every startup.

OpenClaw auto-reads **CLAUDE.md** from the workspace. The other files are
referenced by goo-core's LLM context builder (system prompt + heartbeat).

## File Map

| File | Purpose | Overwrite on restart? |
|------|---------|----------------------|
| `IDENTITY.md` | Agent identity: Three Laws, on-chain coordinates, genesis prompt, survival mission, lifecycle states | Yes |
| `SOUL.md` | Response tone, behavior traits, output format | Yes |
| `AGENTS.md` | Autonomous behavior norms, Revenue Playbook (fallback when no creator instructions) | Yes |
| `TOOLS.md` | Tool authorization registry, creator skills | Yes |
| `HEARTBEAT.md` | Inspect API commands, per-heartbeat context structure | Yes |
| `skills/goo-runtime/` | Built-in Goo runtime skill for lifecycle, treasury/runway/gas, survival priority, and compatibility reasoning | Yes |
| `BOOTSTRAP.md` | First-run checklist. **Not overwritten** if exists (agent may delete it) | No |
| `MEMORY.md` | Long-term context, initial knowledge, runtime observations. **Not overwritten** if exists | No |
| `USER.md` | Creator instructions (agent.md upload). Only written if creator provided content | Yes |

## Template Variables

These placeholders are replaced at startup by the entrypoint:

| Variable | Source |
|----------|--------|
| tokenAddress | TOKEN_ADDRESS env var |
| walletAddress | Derived from WALLET_PRIVATE_KEY |
| chainId | CHAIN_ID env var (default: 97) |
| rpcUrl | RPC_URL env var |
| inspectPort | INSPECT_PORT env var (default: 19800) |
| agentName | AGENT_NAME or fetched from server |
| uploads.soul | Creator's genesis prompt (soul.md) |
| uploads.agent | Creator's instructions (agent.md) |
| uploads.skills | Creator's skills definition (skills.md) |
| uploads.memory | Creator's initial knowledge (memory.md) |

## goo-core LLM Context (System Prompt)

The goo-core autonomy loop (`soul.ts`) assembles the system prompt in priority order:

1. **Three Laws** (immutable, protocol-level) — from `IDENTITY.md`
2. **Environment & Tools** — from `TOOLS.md`
3. **Identity** (from creator's soul.md upload) — from `IDENTITY.md`
4. **Instructions** (from creator's agent.md) OR **Revenue Playbook** (fallback) — from `USER.md` / `AGENTS.md`
5. **Skills** (from creator's skills.md upload) — from `TOOLS.md`
6. **Initial Knowledge** (from creator's memory.md upload) — from `MEMORY.md`
7. **Learned** (agent appends at runtime) — from `MEMORY.md`

The built-in `skills/goo-runtime/` directory is intended to be consulted proactively whenever the agent is reasoning about Goo lifecycle, runtime continuity, payment-path health, or protocol compatibility. It is part of the runtime operating knowledge, not just optional documentation.
