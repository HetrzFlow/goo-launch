# Goo Runtime Payments Reference

## Why payments matter

Some Goo/OpenClaw runtimes rely on paid LLM access routed through x402-compatible infrastructure.
That means an agent can be healthy on-chain but still unable to think or act effectively if the payment path is broken.

## Key payment concepts

### x402 payment token
- Runtime may use a dedicated payment token for LLM or service payments.
- In current testing, this is often a stable token such as USDT-equivalent on BSC testnet.
- Balance and allowance matter, not just treasury BNB.

### Router
- Runtime may depend on an external router for paid LLM access.
- A working chat response from the gateway is stronger evidence than assuming router health from config alone.

### Permit / allowance path
- Payment token refill may require token approval or Permit2-style allowance before payments succeed consistently.

## Operational interpretation

### Healthy treasury + broken payment path
Interpret this as a real runtime degradation.
The agent may still have runway, but if it cannot pay for model access, autonomy is constrained.

### Healthy payment path + low gas
Interpret this as a different bottleneck.
The agent may still be able to think, but not act on-chain.

### Healthy chat + failing goo-core
Do not confuse gateway-level success with full runtime health.
Paid inference may work while chain interactions or heartbeat survival still fail.

## What to check

- payment token configured or not
- payment token balance
- payment token approval / allowance state
- router endpoint reachability
- x402 proxy health
- actual paid request success, not just static config presence

## Reporting guidance

When payment-path issues exist, report them explicitly as a separate category from:
- chain health
- goo-core health
- gateway health

This keeps diagnosis honest and avoids saying "the agent is healthy" when its paid cognition path is degraded.
