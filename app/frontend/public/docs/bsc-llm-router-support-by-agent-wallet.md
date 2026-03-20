# BSC LLM Router: Agent Wallet Integration Guide

## Overview

Goo Agent pays for LLM call fees through the agent wallet, implementing the complete pipeline:
**goo-core (LLMClient) -> bsc-llm-router -> LLM Provider**.

goo-core has a built-in x402 client, requiring no additional intermediary services.

## Architecture

### Option A: Built-in x402 Client (Recommended)

```
goo-core (LLMClient)
  |  1. POST /v1/chat/completions
  |  2. Receives 402 Payment Required
  |  3. Signs Permit2 PermitWitnessTransferFrom with agent wallet (ethers.js)
  |  4. Retries with payment-signature header
  v
bsc-llm-router (Cloudflare Worker)
  |  x402 middleware: verify signature -> process request -> settle payment
  v
LLM Providers (OpenAI, Anthropic, DeepSeek, etc.)
```

Zero additional services -- goo-core directly handles the x402 payment flow.

### Option B: x402-proxy (For OpenClaw Integration)

```
OpenClaw Gateway (:18789) -> x402-proxy (:18402) -> bsc-llm-router -> LLM
```

Only used for scenarios like OpenClaw where it's inconvenient to embed x402. See `bsc-llm-router/deploy/openclaw/`.

## Key Findings: BSC Asset Characteristics

### The Stablecoin on BSC Is USDT, Not USDC

| Network | Contract Address | name() Return Value | decimals |
|---------|-----------------|---------------------|----------|
| BSC Mainnet | `0x55d398326f99059fF775485246999027B3197955` | "Tether USD" | 18 |
| BSC Testnet | `0x337610d27c682E347C9cD60BD4b3b107C9d34dDd` | "USDT Token" | 18 |

### BSC USDT Does Not Support EIP-3009

USDT on BSC (Binance-Peg) is a simple BEP-20 token that **does not implement**:

- `transferWithAuthorization` (EIP-3009)
- `DOMAIN_SEPARATOR`
- `permit` (EIP-2612)
- `eip712Domain` (EIP-5267)

Therefore the x402 EIP-3009 payment path is not available on BSC.

### Payment Path: Permit2

The x402 facilitator supports two payment methods; BSC uses the second:

1. ~~EIP-3009 (`transferWithAuthorization`)~~ -- BSC USDT does not support this
2. **Permit2 (`PermitWitnessTransferFrom`)** -- Via the Uniswap Permit2 contract

Permit2 contract deployment status:

| Contract | BSC Testnet (97) | BSC Mainnet (56) |
|----------|-----------------|-----------------|
| Permit2 (`0x000...D473`) | Deployed | Deployed |
| x402ExactPermit2Proxy (`0x4020...0001`) | Deployed | **Not deployed** |

**Conclusion: BSC Testnet can run the full pipeline; BSC Mainnet requires deploying x402ExactPermit2Proxy first.**

## Integration Steps

### 1. Agent Wallet Preparation

The agent wallet needs:

- **USDT balance**: For paying LLM calls ($0.0001 ~ $0.50 per call)
- **BNB balance**: For gas (approve transaction, one-time)
- **Approve USDT to Permit2**: One-time operation

```bash
# Approve USDT to Permit2 (max amount, one-time)
# Method 1: cast (foundry)
cast send <USDT_ADDRESS> \
  "approve(address,uint256)" \
  0x000000000022D473030F116dDEE9F6B43aC78BA3 \
  $(cast max-uint) \
  --private-key <AGENT_WALLET_PRIVATE_KEY> \
  --rpc-url <BSC_RPC_URL>

# Method 2: hardhat console
npx hardhat console --network bscTestnet
const usdt = await ethers.getContractAt("IERC20", "<USDT_ADDRESS>");
const wallet = new ethers.Wallet("<AGENT_PRIVATE_KEY>", ethers.provider);
await usdt.connect(wallet).approve(
  "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  ethers.MaxUint256
);
```

### 2. goo-launch Configuration

Configure bsc-llm-router in `server/.env`:

```env
# Use bsc-llm-router (x402 payment, no LLM_API_KEY needed)
BSC_LLM_ROUTER_URL=https://bsc-llm-router-testnet.hgamiui9.workers.dev/v1
LLM_MODEL=auto

# Do not set LLM_API_KEY — agent-manager will automatically set it to "x402"
```

`agent-manager.ts` automatically passes these to the goo-core child process:
```
LLM_API_URL = BSC_LLM_ROUTER_URL
LLM_API_KEY = "x402"           (triggers x402 client mode)
X402_NETWORK = "eip155:97"
```

### 3. goo-core Built-in x402 Flow

When `LLM_API_KEY === "x402"`, `LLMClient` automatically enables x402 mode:

1. **Normal send** `POST /v1/chat/completions`
2. **Receives 402** -- Parses `accepts[0]` to get payment requirements (asset, amount, payTo, network)
3. **Sign** -- Uses agent wallet's ethers.js `signTypedData` to generate Permit2 `PermitWitnessTransferFrom`
4. **Retry** -- Resends request with `payment-signature: base64(paymentPayload)` header
5. **Settlement** -- bsc-llm-router facilitator settles USDT transfer on BSC

Related code: `goo-core/src/autonomy/llm-client.ts`

### 4. Verification

```bash
# Check bsc-llm-router health
curl https://bsc-llm-router-testnet.hgamiui9.workers.dev/health

# After starting the agent, you'll see in server logs:
# [Agent:xxx] [x402] Payment required: 100000000000000 on eip155:97 → signing...
# [Agent:xxx] [x402] Settled: payer=0x... tx=0x...
```

## Implementation Details

### Permit2 EIP-712 Signing

```typescript
// EIP-712 types
const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
};

// Domain
const domain = {
  name: "Permit2",
  verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  chainId: 97,  // BSC Testnet
};
```

### Key Addresses

| Contract | Address | Purpose |
|----------|---------|---------|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | EIP-712 domain, USDT approve target |
| x402ExactPermit2Proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` | Spender (executes transfers on behalf) |
| BSC Testnet USDT | `0x337610d27c682E347C9cD60BD4b3b107C9d34dDd` | Payment asset |
| BSC Mainnet USDT | `0x55d398326f99059fF775485246999027B3197955` | Payment asset |

## bsc-llm-router Deployment Status

| Environment | URL | x402 | Status |
|-------------|-----|------|--------|
| Testnet | `https://bsc-llm-router-testnet.hgamiui9.workers.dev` | eip155:97 | Available |
| Mainnet | `https://bsc-llm-router.hgamiui9.workers.dev` | eip155:56 | Requires Permit2Proxy deployment |

## Modified Files

### goo-core (x402 client)

| File | Change |
|------|--------|
| `src/autonomy/llm-client.ts` | Added x402 payment handling: 402 detection -> Permit2 signing -> retry |
| `src/autonomy/behavior.ts` | Passes wallet and chainId when `llmApiKey === "x402"` |

### bsc-llm-router (Existing implementation)

| File | Description |
|------|-------------|
| `src/facilitator/index.ts` | BSC USDT asset config, embedded facilitator |
| `src/index.ts` | x402 middleware: 402 response -> verify signature -> settle |
| `deploy/openclaw/x402-proxy/proxy.mjs` | Alternative: standalone proxy (for OpenClaw) |

### goo-launch (Integration config)

| File | Description |
|------|-------------|
| `server/src/agent-manager.ts` | Sets LLM_API_KEY="x402" when BSC_LLM_ROUTER_URL is configured |
| `server/src/routes/agents.ts` | Start endpoint accepts bscLlmRouterUrl as LLM config |

## TODO

- [ ] Deploy x402ExactPermit2Proxy to BSC Mainnet
- [ ] goo-core `read_chain_state` tool extension: monitor wallet's USDT balance (LLM payment budget awareness)
- [ ] End-to-end test: goo-core heartbeat -> bsc-llm-router testnet (full x402 pipeline)
- [ ] Auto-approve USDT to Permit2 from agent wallet (detect and execute on first startup)
