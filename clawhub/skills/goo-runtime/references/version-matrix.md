# Goo Runtime Version Matrix

Use this file to reason about capability mismatches between runtime code and deployed protocol versions.

## Principle

Do not infer capability from the newest code alone.
A runtime may support an action in principle while the deployed contract does not.

## Example matrix

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

## Practical rule

When a survival action reverts with a stable, named protocol error, treat that as a capability signal.
If the same revert appears repeatedly, escalate it as a compatibility issue rather than a flaky network problem.
