# Goo Runtime Sandbox Lifecycle Reference

## Overview

Goo agents run inside a sandbox — a managed compute environment that hosts the OpenClaw gateway and goo-core runtime. Different sandbox providers have different lifecycle models, and goo-core's survival manager handles renewal automatically where possible.

## Sandbox Providers

### e2b (Managed Cloud)

- **Lifecycle**: Time-based expiry. Each sandbox has an `endAt` timestamp.
- **Renewal**: goo-core auto-renews via x402 payment when remaining time drops below threshold (default: 10 minutes).
- **Cost**: Each renewal is a paid transaction (USDT via Permit2).
- **Failure mode**: If renewal fails (insufficient payment token balance, sandbox-manager unreachable), the sandbox expires and the agent loses its compute environment.
- **Key env vars**: `SANDBOX_PROVIDER=e2b`, `SANDBOX_MANAGER_URL`, `SANDBOX_RENEW_THRESHOLD_SECS`

### AGOS (Managed Platform)

- **Lifecycle**: Balance-based. AGOS account holds AIOU tokens that deplete over time.
- **Renewal**: goo-core monitors balance and emits warnings when low. Cannot auto-topup (requires user wallet signature for EIP-3009 transfer).
- **Failure mode**: When AGOS balance reaches zero, the deployment stops. Owner must manually top up.
- **Key env vars**: `SANDBOX_PROVIDER=agos`, `AGOS_API_URL`, `AGENT_RUNTIME_TOKEN`, `AGOS_AGENT_ID`, `AGOS_MIN_BALANCE`

### BYOD (Bring Your Own Device)

- **Lifecycle**: Self-hosted. No expiry — user manages their own Docker infrastructure.
- **Renewal**: None needed. goo-core treats BYOD as always-healthy.
- **Failure mode**: User's infrastructure goes down. goo-core cannot detect or recover from this.
- **Key env vars**: `SANDBOX_PROVIDER=byod`

## Decision Priority

Sandbox health is checked on every heartbeat as part of survival evaluation (step 6, after buyback). The priority order:

1. If sandbox is unhealthy → report as survival warning (same priority as gas/payment issues)
2. If sandbox was auto-renewed → log as survival action
3. If sandbox has < 15 minutes remaining → surface in status even if above renewal threshold

## What Agents Should Know

- An agent cannot directly renew its own sandbox — goo-core handles this automatically.
- If the agent sees "Sandbox unhealthy" in its heartbeat context, it means compute infrastructure is at risk.
- For e2b: the agent should prioritize saving important state to persistent storage before expiry.
- For AGOS: the agent should note the low-balance warning in its observations and inform the owner if possible.
- Sandbox health is separate from chain health — a healthy treasury does not guarantee sandbox survival.

## Reporting

When sandbox status appears in heartbeat actions, include it in observations:
- Distinguish sandbox health from chain health and payment-path health
- If sandbox renewal failed, classify it as a runtime continuity risk
- Do not conflate "sandbox running" with "agent is fully healthy"
