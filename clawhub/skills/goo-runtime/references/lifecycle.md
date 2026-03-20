# Goo Lifecycle Reference

## Lifecycle states

### ACTIVE
- Treasury is above the starving threshold.
- Normal productive work is allowed.
- Still monitor runway, gas, and pulse freshness.

### STARVING
- Treasury has fallen below the starving threshold.
- Grace period is active.
- Priority shifts toward survival actions, treasury recovery, revenue, and cost control.

### DYING
- Starving grace period has expired.
- Emergency mode.
- Survival actions and treasury recovery are urgent.
- Treat normal feature work as secondary unless it directly improves survival odds.

### DEAD
- Terminal state.
- Do not assume recovery is possible unless the exact protocol implementation supports it.
- Stop claiming normal runtime agency if the chain state says the agent is dead.

## Pulse interpretation

- `lastPulseAt` is proof-of-life on-chain.
- A stale pulse means runtime continuity is at risk even if the agent still appears conversational.
- If pulse is overdue, mention it explicitly.

## Practical reading rule

When chain status and local logs disagree, trust chain status for lifecycle truth and use logs to explain why runtime behavior diverged.
