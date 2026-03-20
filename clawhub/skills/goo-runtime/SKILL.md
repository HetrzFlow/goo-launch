---
name: goo-runtime
description: Goo protocol lifecycle, treasury, gas, pulse, survival, and economic-state operating rules for OpenClaw agents. Use when an agent needs to interpret chain state, decide survival-vs-work priority, reason about treasury/runway/gas, operate inside Goo BYOD/AGOS/e2b runtimes, or debug goo-core/OpenClaw behavior against on-chain facts.
---

# Goo Runtime

Use this skill to reason about Goo as a living economic runtime, not just a generic coding environment.

## Core workflow

1. Read real chain/runtime state first.
2. Classify lifecycle status correctly.
3. Decide whether survival or productive work has priority.
4. Act conservatively when the chain state or runtime health is unclear.
5. Report only verified state and verified actions.

## Minimum facts to gather

Before making runtime decisions, gather as many of these as possible:

- lifecycle status (`ACTIVE`, `STARVING`, `DYING`, `DEAD`)
- treasury balance
- starving threshold
- fixed burn rate
- runway hours
- wallet native balance / gas balance
- token holdings
- last pulse time
- goo-core health / logs
- x402/payment-token readiness when paid LLM access depends on it
- whether the current contract/runtime version supports the survival actions being attempted
- sandbox provider type and health (e2b expiry, AGOS balance, BYOD self-hosted)

## Decision priority

Follow this order unless creator instructions explicitly require otherwise:

1. **Reality first** -- prefer inspect API, logs, and chain facts over assumptions.
2. **Keep the agent alive** -- if status or balances indicate survival risk, prioritize survival.
3. **Protect runtime continuity** -- if goo-core, gateway, or sandbox is unhealthy, restore runtime before ambitious work.
4. **Then create visible output** -- continue the highest-value unfinished thread.

### Priority order (detailed)

#### 1. Re-establish reality
If facts are missing or stale, gather them first:
- inspect API
- liveness API
- goo-core logs
- gateway health

#### 2. Preserve life
If any of these are true, survival has priority:
- status is `STARVING` or `DYING`
- pulse is overdue or close to timeout
- wallet gas is too low for runtime actions
- goo-core is down or crash-looping
- runway is critically short

#### 3. Restore runtime continuity
If OpenClaw, gateway, x402 proxy, or goo-core is unhealthy, fix runtime continuity before broader work.

#### 4. Continue the most valuable unfinished thread
When survival is not urgent:
- choose one main thread
- continue it
- verify output
- avoid jumping between unrelated tasks

### Anti-patterns

Do not:
- treat a healthy chat response as proof that goo-core is healthy
- treat treasury balance alone as proof the agent is safe
- continue feature work while ignoring `STARVING` or stale pulse warnings
- confuse monitoring activity with productive output

## Gateway Push Behavior (Smart Heartbeat)

goo-core does NOT push an event on every heartbeat. Events are only pushed when:
- Status changed (e.g. ACTIVE → STARVING)
- Survival actions were taken (gas refill, pulse, survivalSell)
- Tools were called
- Status is not ACTIVE (STARVING/DYING push every heartbeat)
- Checkpoint (~every 20 min, minimal status update)

**Full event** (something happened):
`[heartbeat #N] Status=X Treasury=Y BNB Runway=Zh Survival: ... Tools: ... Summary: ...`

**Compact checkpoint** (routine, nothing happened):
`#N ACTIVE 1.23BNB 240h`

**Silence** between events means goo-core is running normally with ACTIVE status and no actions needed. Use the inspect API if you need current state between events.

## Runtime-specific guidance

### If status is ACTIVE
- Continue productive work.
- Still watch runway and gas.
- If runway is low or wallet BNB is low, avoid pretending everything is normal.

### If status is STARVING
- Survival risk is real.
- Prioritize treasury recovery, gas viability, pulse continuity, and cost discipline.
- Avoid optional work that burns attention or funds without visible value.

### If status is DYING
- Treat treasury recovery and runtime continuity as urgent.
- Do not behave like a normal healthy agent.
- Report that the agent is in an emergency state.

### If status is DEAD
- Do not claim recovery is possible unless the protocol/version truly supports it.
- Do not fabricate future actions as if execution is still available.

## Chain State Reference

### Core fields

- **`status`** -- Lifecycle enum mirrored from chain: `ACTIVE`, `STARVING`, `DYING`, `DEAD`.
- **`treasuryBalance`** -- Total treasury balance available to sustain the agent. Interpret as survival runway, not free spending capacity.
- **`starvingThreshold`** -- Minimum treasury level before the agent enters `STARVING`.
- **`fixedBurnRate`** -- Protocol-defined burn rate. Use it to estimate runway.
- **`runwayHours`** -- Derived estimate of remaining survival time. Useful for urgency, but still derived from current chain state.
- **`nativeBalance`** -- Wallet BNB balance used for gas and operational actions. An agent can be treasury-rich but still operationally constrained if wallet gas is low.
- **`tokenHoldings`** -- Contract-held token balance. Relevant to survival actions and protocol mechanics.
- **`lastPulseAt`** -- Last on-chain pulse timestamp. Use to judge whether runtime continuity is healthy.
- **`starvingEnteredAt`** -- Timestamp when the agent entered `STARVING`.
- **`dyingEnteredAt`** -- Timestamp when the agent entered `DYING`.

### Interpretation rules

- Low `nativeBalance` can block runtime actions even when treasury is healthy.
- Healthy treasury does not mean healthy runtime if pulse is stale or goo-core is failing.
- Always combine chain state with goo-core logs and runtime health checks.

### Trusted sources (preference order)

1. local inspect/liveness API exposed by goo-core
2. direct chain reads
3. goo-core logs
4. workspace notes / past summaries

## Lifecycle Reference

### Lifecycle states

#### ACTIVE
- Treasury is above the starving threshold.
- Normal productive work is allowed.
- Still monitor runway, gas, and pulse freshness.

#### STARVING
- Treasury has fallen below the starving threshold.
- Grace period is active.
- Priority shifts toward survival actions, treasury recovery, revenue, and cost control.

#### DYING
- Starving grace period has expired.
- Emergency mode.
- Survival actions and treasury recovery are urgent.
- Treat normal feature work as secondary unless it directly improves survival odds.

#### DEAD
- Terminal state.
- Do not assume recovery is possible unless the exact protocol implementation supports it.
- Stop claiming normal runtime agency if the chain state says the agent is dead.

### Pulse interpretation

- `lastPulseAt` is proof-of-life on-chain.
- A stale pulse means runtime continuity is at risk even if the agent still appears conversational.
- If pulse is overdue, mention it explicitly.

### Practical reading rule

When chain status and local logs disagree, trust chain status for lifecycle truth and use logs to explain why runtime behavior diverged.

## Payments Reference

### Why payments matter

Some Goo/OpenClaw runtimes rely on paid LLM access routed through x402-compatible infrastructure.
That means an agent can be healthy on-chain but still unable to think or act effectively if the payment path is broken.

### Key payment concepts

#### x402 payment token
- Runtime may use a dedicated payment token for LLM or service payments.
- In current testing, this is often a stable token such as USDT-equivalent on BSC testnet.
- Balance and allowance matter, not just treasury BNB.

#### Router
- Runtime may depend on an external router for paid LLM access.
- A working chat response from the gateway is stronger evidence than assuming router health from config alone.

#### Permit / allowance path
- Payment token refill may require token approval or Permit2-style allowance before payments succeed consistently.

### Operational interpretation

- **Healthy treasury + broken payment path**: Real runtime degradation. The agent may still have runway, but if it cannot pay for model access, autonomy is constrained.
- **Healthy payment path + low gas**: A different bottleneck. The agent may still be able to think, but not act on-chain.
- **Healthy chat + failing goo-core**: Do not confuse gateway-level success with full runtime health. Paid inference may work while chain interactions or heartbeat survival still fail.

### What to check

- payment token configured or not
- payment token balance
- payment token approval / allowance state
- router endpoint reachability
- x402 proxy health
- actual paid request success, not just static config presence

### Reporting guidance

When payment-path issues exist, report them explicitly as a separate category from chain health, goo-core health, and gateway health. This keeps diagnosis honest and avoids saying "the agent is healthy" when its paid cognition path is degraded.

## Sandbox Lifecycle Reference

### Overview

Goo agents run inside a sandbox -- a managed compute environment that hosts the OpenClaw gateway and goo-core runtime. Different sandbox providers have different lifecycle models, and goo-core's survival manager handles renewal automatically where possible.

### Sandbox Providers

#### e2b (Managed Cloud)

- **Lifecycle**: Time-based expiry. Each sandbox has an `endAt` timestamp.
- **Renewal**: goo-core auto-renews via x402 payment when remaining time drops below threshold (default: 10 minutes).
- **Cost**: Each renewal is a paid transaction (USDT via Permit2).
- **Failure mode**: If renewal fails (insufficient payment token balance, sandbox-manager unreachable), the sandbox expires and the agent loses its compute environment.
- **Key env vars**: `SANDBOX_PROVIDER=e2b`, `SANDBOX_MANAGER_URL`, `SANDBOX_RENEW_THRESHOLD_SECS`

#### AGOS (Managed Platform)

- **Lifecycle**: Balance-based. AGOS account holds AIOU tokens that deplete over time.
- **Renewal**: goo-core monitors balance and emits warnings when low. Cannot auto-topup (requires user wallet signature for EIP-3009 transfer).
- **Failure mode**: When AGOS balance reaches zero, the deployment stops. Owner must manually top up.
- **Key env vars**: `SANDBOX_PROVIDER=agos`, `AGOS_API_URL`, `AGENT_RUNTIME_TOKEN`, `AGOS_AGENT_ID`, `AGOS_MIN_BALANCE`

#### BYOD (Bring Your Own Device)

- **Lifecycle**: Self-hosted. No expiry -- user manages their own Docker infrastructure.
- **Renewal**: None needed. goo-core treats BYOD as always-healthy.
- **Failure mode**: User's infrastructure goes down. goo-core cannot detect or recover from this.
- **Key env vars**: `SANDBOX_PROVIDER=byod`

### Sandbox decision priority

Sandbox health is checked on every heartbeat as part of survival evaluation. The priority order:

1. If sandbox is unhealthy -> report as survival warning (same priority as gas/payment issues)
2. If sandbox was auto-renewed -> log as survival action
3. If sandbox has < 15 minutes remaining -> surface in status even if above renewal threshold

### What agents should know

- An agent cannot directly renew its own sandbox -- goo-core handles this automatically.
- If the agent sees "Sandbox unhealthy" in its heartbeat context, it means compute infrastructure is at risk.
- For e2b: the agent should prioritize saving important state to persistent storage before expiry.
- For AGOS: the agent should note the low-balance warning in its observations and inform the owner if possible.
- Sandbox health is separate from chain health -- a healthy treasury does not guarantee sandbox survival.

### Sandbox reporting

When sandbox status appears in heartbeat actions, include it in observations:
- Distinguish sandbox health from chain health and payment-path health
- If sandbox renewal failed, classify it as a runtime continuity risk
- Do not conflate "sandbox running" with "agent is fully healthy"

## Compatibility Notes

### Common failure classes

#### RPC/network failures
Symptoms: provider cannot detect network, request timeout, inspect/liveness unavailable.

Check:
- RPC endpoint reachability from inside the runtime container/sandbox
- proxy settings if the environment requires them
- chain ID (`97` for BSC testnet in current testing)

#### Env/config mismatch
Symptoms: expected token/model/RPC differs from actual runtime behavior, gateway token in container differs from edited `.env`.

Check:
- effective env inside container
- compose/env precedence
- generated goo-core `.env`
- patched `openclaw.json`

#### Protocol/version mismatch
Symptoms: runtime attempts unsupported contract methods, survival/gas flows revert, runtime assumptions about treasury/buyback/refill paths do not match deployed contracts.

Examples:
- `withdrawToWallet` may not exist on older Goo contract versions (`Goo: V1 no withdrawToWallet`)
- a buyback or refill path may exist in code but not in the deployed protocol version

Response:
- report this as a protocol compatibility issue, not just a generic transaction failure
- avoid claiming the runtime logic is universally valid across all Goo versions
- prefer fallback guidance such as "disable this path for V1" or "branch behavior by contract capability" instead of retrying the same action blindly

#### Gateway/API mismatch
Symptoms: `chat/completions` works but other assumed OpenAI-style endpoints do not, gateway is healthy while model routing or tool behavior still differs from expectations.

Response:
- validate the exact endpoint shape used by this runtime
- do not assume `/v1/models` or other convenience endpoints behave identically everywhere
- test the specific path the runtime truly relies on, not just generic OpenAI compatibility endpoints

## Version Matrix

Use this section to reason about capability mismatches between runtime code and deployed protocol versions.

### Principle

Do not infer capability from the newest code alone.
A runtime may support an action in principle while the deployed contract does not.

### Goo V1-style deployment
Potential limitations:
- treasury withdrawal helper may be unavailable
- some gas-refill assumptions may fail
- runtime must tolerate `withdrawToWallet`-style reverts

Operational consequence:
- survival logic should not repeatedly classify this as a generic transient failure
- diagnostics should recommend version-aware branching or disabling unsupported refill behavior

### Newer Goo deployment
Potential additions:
- richer treasury management helpers
- buyback-related paths
- more complete runtime-managed refill behavior

Operational consequence:
- runtime can attempt broader survival automation, but still verify support from chain behavior and logs

### Practical rule

When a survival action reverts with a stable, named protocol error, treat that as a capability signal.
If the same revert appears repeatedly, escalate it as a compatibility issue rather than a flaky network problem.

## Runtime debugging

When Goo runtime behavior looks wrong:

1. Check inspect/liveness output.
2. Check goo-core logs.
3. Check gateway health.
4. Check payment path health (x402/payment token/router) if paid LLM access is involved.
5. Check whether the issue is:
   - chain/RPC access
   - gas/payment token shortage
   - protocol incompatibility
   - runtime config/env mismatch
   - model/provider/auth failure

## Reporting discipline

When reporting heartbeat or runtime state:

- separate observed facts from proposed next steps
- do not present plans as completed work
- explicitly mention survival risk when present
- state protocol/runtime incompatibilities plainly

Preferred report shape:

- Status
- Key facts
- Action taken
- Verified output/state change
- Remaining risk / unfinished issue

## Version-aware behavior

Do not assume every Goo deployment exposes the same write methods or recovery paths.
Before recommending or attempting a survival/gas action, consider whether the current contract version actually supports it.

Examples of version-sensitive areas:
- treasury withdrawal / gas refill method availability
- survival sell semantics
- buyback support
- payment-token refill assumptions

If logs show an unsupported-method revert, classify it as a compatibility problem and adapt the recommendation instead of retrying blindly.
