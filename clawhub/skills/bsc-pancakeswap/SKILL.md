---
name: bsc-pancakeswap
description: PancakeSwap DEX trading on BSC — swap workflows, pre-flight safety checks, slippage/liquidity rules, and common token addresses. Read this before any DEX swap operation. Signing is handled by goo-bsc-wallet.
---

# PancakeSwap DEX Trading

This skill covers how to execute swaps on PancakeSwap V2. All signing and broadcasting go through goo-core wallet tools — see `skills/goo-bsc-wallet/SKILL.md` for wallet tools and risk rules.

## Architecture

```
This Skill (knowledge only)           goo-core wallet layer
───────────────────────               ─────────────────────
Swap workflow guidance                 bsc_prepare_tx
Pre-flight checks (slippage, etc.)     bsc_analyze_tx  ← tx-risk-analyzer.ts
Token addresses & router ABI           bsc_sign_and_send_tx ← wallet signing
                                       bsc_wallet_overview  (verify)
```

This skill provides no tools — it is pure knowledge. You build swap calldata using ethers.js and the Router ABI, then sign via goo-core wallet tools.

## Swap Methods (PancakeSwap V2 Router)

| Method | Use case | `value` |
|--------|----------|---------|
| `swapExactETHForTokens` | BNB -> Token | amountIn |
| `swapExactTokensForETH` | Token -> BNB (approve first) | 0 |
| `swapExactTokensForTokens` | Token -> Token (approve first) | 0 |
| `swapTokensForExactTokens` | Token -> Token, exact output (approve first) | 0 |

## Swap Workflows

### BNB -> Token

1. `bsc_wallet_overview` — confirm BNB covers swap amount + gas
2. Check token contract responds to `symbol()` / `decimals()` (honeypot filter)
3. Check pair exists with non-zero reserves
4. Get quote via `getAmountsOut` — apply pre-flight checks (see below)
5. Build calldata: `router.swapExactETHForTokens(amountOutMin, [WBNB, token], to, deadline)`
6. `bsc_sign_and_send_tx` with `value = amountIn`
7. `bsc_wallet_overview` — verify balance change

### Token -> BNB (requires approve)

1. Steps 1-4 as above (reverse direction)
2. **Approve**: build `token.approve(ROUTER, exactAmount)` — never use MaxUint256
3. `bsc_sign_and_send_tx` the approve tx
4. Build calldata: `router.swapExactTokensForETH(amountIn, amountOutMin, [token, WBNB], to, deadline)`
5. `bsc_sign_and_send_tx` the swap tx
6. `bsc_wallet_overview` — verify

### Token -> Token (multi-hop)

Path: `[tokenA, WBNB, tokenB]` when no direct pair exists.
Flow: approve tokenA -> swap via multi-hop path. Same as Token -> BNB but with extended path.

## DEX Pre-Flight Checks

Run these **before** building the swap transaction:

| Check | Condition | Action |
|-------|-----------|--------|
| Honeypot detection | Contract doesn't respond to `symbol()` / `decimals()` | Stop |
| No liquidity | Pair reserves = 0 | Stop |
| Extreme slippage | > 15% | Stop |
| High slippage | 5-15% | Warn |
| Large swap | > 50% of your balance | Warn |
| Pool impact | Swap > 10% of pool liquidity | Warn |
| Gas cost ratio | Gas > 5% of swap value | Warn |

These checks are instruction-layer guidance. Even if bypassed, goo-core's `tx-risk-analyzer.ts` still enforces code-level risk analysis at signing time (see `skills/goo-bsc-wallet/SKILL.md`).

## Security Rules (DEX-specific)

1. **Exact approvals only** — always approve the exact swap amount, never MaxUint256.
2. **Deadline protection** — set deadline to current time + 5 minutes on every swap.
3. **Slippage limits** — set `amountOutMin` based on quote minus acceptable slippage (default: 1-3%).
4. **Verify after swap** — always call `bsc_wallet_overview` after to confirm balance changes.
5. **No V3** — this skill covers PancakeSwap V2 only.

For general wallet security rules (private key isolation, risk analysis, gas preservation), see `skills/goo-bsc-wallet/SKILL.md`.

## Common Token Addresses

### BSC Mainnet

| Token | Address |
|-------|---------|
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| USDT | `0x55d398326f99059fF775485246999027B3197955` |
| BUSD | `0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56` |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |

### BSC Testnet

| Token | Address |
|-------|---------|
| WBNB | `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd` |
| PancakeSwap V2 Router | `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` |
