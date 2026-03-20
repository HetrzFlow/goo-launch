# Goo Core Finance Migration TODO

## Background

- Upstream change: `goo-core` commit `04b1ed0263c6d02ce6c8ca3f2ef9c408d102c7ce`
- Main direction:
  - `agent/wallet` concept moved to `agent/finance`
  - Added `finance/earn`, `finance/spend`
  - Added `finance/action` modules: `gas-refill`, `buyback`, `x402`, `pay-bills`
- Current status (important):
  - Core wallet logic is mostly still in `finance/wallet` (renamed from wallet)
  - Many new `finance/action` modules are scaffolding (`TODO`) and not fully wired

## Goal

Migrate existing wallet-related runtime logic to the new finance architecture with minimal regression risk:

1. Keep runtime stable.
2. Centralize spend/earn recording through managers.
3. Move business orchestration from `wallet` and ad-hoc callers into `finance/action`.
4. Preserve backward compatibility for historical spend logs.

---

## Phase Plan (PR-based)

## PR1 - Finance Compatibility Layer (No Behavior Change)

### Objective

Introduce finance runtime structure without changing external behavior.

### Changes

- `goo-core/src/index.ts`
  - Initialize `SpendManager` and `EarnManager` alongside `AgentWallet`.
  - Pass managers via runtime context where needed (can be optional initially).

### Status

- [x] Completed in `@devbond/gc@2.0.0`

---

## PR2 - Migrate x402 LLM Payment Flow to finance/action/x402

### Objective

Move x402 payment orchestration out of `llm-client` inline code and standardize spend recording.

### Changes

- `goo-core/src/autonomy/llm-client.ts`
  - Delegate payment handling to `finance/action/x402`.
  - Keep `llm-client` focused on API call orchestration.
- `goo-core/src/finance/action/x402.ts`
  - Implement complete flow: sign + retry + return settlement metadata.
  - Record spend (`llm`) on successful settlement (`txHash` available).

### Status

- [x] Completed in `@devbond/gc@2.0.0`

---

## PR3 - Migrate Gas Refill Logic to finance/action/gas-refill

### Objective

Make survival module call finance action layer, not wallet internals directly.

### Changes

- `goo-core/src/survival/survival-manager.ts`
  - Replace direct `wallet.ensureGas(...)` call with `ensureWalletGas(...)`.
- `goo-core/src/finance/action/gas-refill.ts`
  - Keep parity with existing gas refill behavior.
  - Leave `ensureTokenGas` as explicit scaffold if not implemented yet.

### Status

- [x] Completed in `@devbond/gc@2.0.0`

---

## PR4 - Implement Buyback Action (Minimum Viable)

### Objective

Implement `finance/action/buyback` from scaffold to usable flow.

### Changes

- `goo-core/src/finance/action/buyback.ts`
  - Implement quote path (`router.getAmountsOut`).
  - Implement execution path (approve + swap + spend record as `invest`).
  - Add safe defaults for deadline/slippage guard.

### Status

- [ ] Scaffolding only — exported but not fully implemented

---

## PR5 - Implement Pay Bills Flow (Minimum Viable)

### Objective

Make `pay-bills` usable for infra/billing payments via x402.

### Changes

- `goo-core/src/finance/action/pay-bills.ts`
  - Implement `getPendingBills` from config/local source first.
  - Complete single-bill and batch bill payment loop.
  - Record spend category (start with `other`, extend later if needed).

### Status

- [ ] Scaffolding only — exported but not fully implemented

---

## PR6 - Wire Earn Manager to Real Income Events

### Objective

Track earnings (`pulse`, `reward`, etc.) and expose basic summary.

### Changes

- `goo-core/src/finance/earn.ts`
  - Implement load/save persistence.
- Runtime trigger points (`index.ts`/survival/autonomy integration)
  - Call `earnManager.record(...)` where income is observable.

### Status

- [ ] Exported but not wired to real income events

---

## PR7 - Data/Interface Unification and Backward Compatibility

### Objective

Finalize architecture: wallet as low-level adapter, finance managers/actions as business layer.

### Changes

- Consolidate spend/earn read APIs to manager layer.
- Keep backward compatibility:
  - Read legacy `wallet-spending.json`.
  - Migrate or mirror to new structure if needed.
- Add/update tests:
  - Unit tests for actions/managers
  - Integration for x402 + gas + buyback critical path

### Status

- [x] Completed in `@devbond/gc@2.0.0`

---

## Dependency Order

1. PR1 ✅
2. PR2 + PR3 (parallel possible after PR1) ✅
3. PR4 + PR5 (scaffolding only)
4. PR6 (exported, not wired)
5. PR7 ✅

---

## Risk Checklist

- [x] x402 settlement parsed but spend not recorded — resolved in 2.0.0
- [ ] buyback swap path mismatch on different pools — not yet implemented
- [x] spend/earn persistence schema drift — resolved in 2.0.0
- [x] duplicate accounting when both wallet and manager record same event — resolved in 2.0.0
- [x] runtime breakage from import path updates (`wallet` -> `finance`) — resolved in 2.0.0

---

## Verification Checklist (Per Release)

- [x] `npm test` (unit + integration where available) in `goo-core`
- [x] manual 402 retry flow test
- [x] manual low-gas refill test
- [ ] manual buyback test on testnet
- [x] restart runtime and verify spend/earn logs are restored
- [x] verify `goo-example` sidecar startup with updated `@devbond/gc` version
