# Goo Runtime Compatibility Notes

## Common failure classes

### RPC/network failures
Symptoms:
- provider cannot detect network
- request timeout
- inspect/liveness unavailable

Check:
- RPC endpoint reachability from inside the runtime container/sandbox
- proxy settings if the environment requires them
- chain ID (`97` for BSC testnet in current testing)

### Env/config mismatch
Symptoms:
- expected token/model/RPC differs from actual runtime behavior
- gateway token in container differs from edited `.env`

Check:
- effective env inside container
- compose/env precedence
- generated goo-core `.env`
- patched `openclaw.json`

### Protocol/version mismatch
Symptoms:
- runtime attempts unsupported contract methods
- survival/gas flows revert
- runtime assumptions about treasury, buyback, or refill paths do not match deployed contracts

Examples:
- `withdrawToWallet` may not exist on older Goo contract versions (`Goo: V1 no withdrawToWallet`)
- a buyback or refill path may exist in code but not in the deployed protocol version

Response:
- report this as a protocol compatibility issue, not just a generic transaction failure
- avoid claiming the runtime logic is universally valid across all Goo versions
- prefer fallback guidance such as "disable this path for V1" or "branch behavior by contract capability" instead of retrying the same action blindly

### Gateway/API mismatch
Symptoms:
- `chat/completions` works but other assumed OpenAI-style endpoints do not
- gateway is healthy while model routing or tool behavior still differs from expectations

Response:
- validate the exact endpoint shape used by this runtime
- do not assume `/v1/models` or other convenience endpoints behave identically everywhere
- test the specific path the runtime truly relies on, not just generic OpenAI compatibility endpoints
