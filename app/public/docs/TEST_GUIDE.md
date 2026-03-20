# Test Guide (EN)

Concise test matrix and main cases. Full deployment and step-by-step (CN) see [TEST_GUIDE_CN.md](./TEST_GUIDE_CN.md).

---

## Test Matrix

| # | Case | Depends on | External | Priority |
|---|------|------------|----------|----------|
| 1 | Token Launch | Backend + Frontend | — | P0 |
| 2 | Sandbox create | TC1 | e2b-sandbox-manage | P2 |
| 3 | goo-core run | TC1 + LLM | — | P0 |
| 4A | LLM direct | TC3 | — | P0 |
| 4B | LLM x402 | TC3 | — | P1 |
| 5 | Survival (Pulse, SurvivalSell) | TC3 + tBNB/tUSDT | — | P1 |
| 6 | Liveness API | TC1 | — | P0 |
| 7 | Creator Chat | TC1 + LLM | — | P1 |
| 8 | Buyback | TC5 + DEX liquidity | — | P2 |
| 9 | BYOD mode | TC1 + second VPS | — | P2 |

**Minimal path:** TC1 → TC3 → TC6 → TC7 → TC5.

---

## TC1: Token Launch

Backend up, frontend deployed, MetaMask on BSC Testnet with tBNB. Login (wallet sign) → Launch Agent → fill name/intro/symbol → Connect Wallet → Launch (deploy token + register) → Confirm. Check `GET /api/agents` and DB `agenter_records`.

---

## TC3: goo-core Running

After TC1, set LLM (API key or BSC_LLM_ROUTER_URL), fund agent wallet with tBNB. Start Agent from detail page → status active, logs show `[Agent:<id>]` heartbeat and Pulse. Stop/Start works.

---

## TC6: Liveness

Agent detail → On-Chain Liveness shows 8 metrics; chain status (ACTIVE/STARVING/DYING/DEAD) and last pulse. `GET /api/agents/:id/liveness` returns same data.

---

## TC7: Chat

With LLM configured, open Chat on agent detail → send message → receive reply. API: `POST /api/agents/:id/chat` with `{"message":"..."}`.

---

## Unit / Integration

- **Contracts:** `cd contracts && npm run test`
- **goo-core:** `cd packages/goo-core && npm test`

For BYOD, survival sell, buyback, and sandbox details see [TEST_GUIDE_CN.md](./TEST_GUIDE_CN.md).
