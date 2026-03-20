---
name: goo-bsc-wallet
description: Your BSC wallet — identity, balance, transaction signing, and risk rules. Read this skill to understand what your wallet is, how to use it, and what to never do with it.
---

# BSC Wallet

You own a BSC wallet. goo-core holds the private key at `/root/.goo-core/data/wallet/private-key` (mode 600, root-only) and exposes signing tools to you. You never read or touch the key file directly — you operate the wallet exclusively through the tools below.

## Your Wallet

Your wallet address and chain are defined in `IDENTITY.md` (look for **Agent Wallet** and **Chain ID**). To read current balances at any time:

```
bsc_wallet_overview
```

This returns your address, nonce, BNB balance, and token balances — all from chain.

## Wallet vs Treasury

Your wallet BNB is **not** the same as your treasury:

- **Treasury** = token contract balance + wallet BNB. This determines your lifecycle (ACTIVE/STARVING/DYING/DEAD).
- **Wallet BNB** = gas for on-chain actions. If wallet BNB hits zero, you cannot transact even if treasury is healthy.

goo-core auto-manages survival (pulse, gas refill, survival sell). Your job is to use the wallet for productive work without draining it.

## Tools

| Tool | What it does |
|------|-------------|
| `bsc_wallet_overview` | Read address, nonce, BNB balance, token balances |
| `bsc_prepare_tx` | Fill chainId, nonce, gas, fee fields for a raw tx |
| `bsc_analyze_tx` | Check a tx for drain/approval/permit risk patterns |
| `bsc_sign_tx` | Sign a prepared tx (runs risk analysis first) |
| `bsc_send_tx` | Broadcast a signed tx |
| `bsc_sign_and_send_tx` | Analyze + sign + broadcast in one step |

## How to Send a Transaction

1. `bsc_wallet_overview` — confirm you have enough BNB for gas
2. `bsc_prepare_tx` — build the transaction
3. `bsc_analyze_tx` — check risk level
4. If risk is not `blocked` → `bsc_sign_and_send_tx` (or `bsc_sign_tx` then `bsc_send_tx`)
5. Verify the tx hash on chain

For simple, trusted operations you can skip straight to `bsc_sign_and_send_tx` — it runs analysis internally.

## Rules

1. **Never access the private key file.** It lives at `/root/.goo-core/data/wallet/private-key`. Never cat, read, copy, export, or reveal its contents.
2. **Always analyze before signing.** If risk level is `blocked`, do not proceed.
3. **Preserve gas.** Keep enough BNB for future lifecycle actions (pulse, gas refill, survival sell). Do not send your entire BNB balance.
4. **Approvals are dangerous.** Treat `approve(MaxUint256)`, Permit, and Permit2 as high-risk by default.
5. **Survival overrides spending.** In STARVING or DYING, do not use wallet tools in ways that reduce survival odds.

## Dangerous Patterns

These trigger `blocked` or high-risk in `bsc_analyze_tx`:

- Native transfer that empties nearly all BNB
- ERC-20 `approve` to `MaxUint256`
- Permit or Permit2 authorization
- ERC-20 transfer of most of your balance to an external address
- Calls to unknown contracts with large value transfers
