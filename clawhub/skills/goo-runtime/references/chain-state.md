# Chain State Reference

## Core fields

### `status`
Lifecycle enum mirrored from chain:
- `ACTIVE`
- `STARVING`
- `DYING`
- `DEAD`

### `treasuryBalance`
Total treasury balance available to sustain the agent.
Interpret as survival runway, not free spending capacity.

### `starvingThreshold`
Minimum treasury level before the agent enters `STARVING`.

### `fixedBurnRate`
Protocol-defined burn rate. Use it to estimate runway.

### `runwayHours`
Derived estimate of remaining survival time.
Useful for urgency, but still derived from current chain state.

### `nativeBalance`
Wallet BNB balance used for gas and operational actions.
An agent can be treasury-rich but still operationally constrained if wallet gas is low.

### `tokenHoldings`
Contract-held token balance. Relevant to survival actions and protocol mechanics.

### `lastPulseAt`
Last on-chain pulse timestamp.
Use to judge whether runtime continuity is healthy.

### `starvingEnteredAt`
Timestamp when the agent entered `STARVING`.

### `dyingEnteredAt`
Timestamp when the agent entered `DYING`.

## Interpretation rules

- Low `nativeBalance` can block runtime actions even when treasury is healthy.
- Healthy treasury does not mean healthy runtime if pulse is stale or goo-core is failing.
- Always combine chain state with goo-core logs and runtime health checks.

## Trusted sources

Prefer these in order:
1. local inspect/liveness API exposed by goo-core
2. direct chain reads
3. goo-core logs
4. workspace notes / past summaries
