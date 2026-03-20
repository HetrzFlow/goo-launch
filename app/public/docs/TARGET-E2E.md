# Target E2E Architecture: goo-launch

This document describes the **full target shape** of goo-launch. The repo currently has only the framework; implementation will follow.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  User's VPS                                                              │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  Goo Chamber                                                        │ │
│  │                                                                     │ │
│  │  ┌─────────────────────┐    ┌─────────────────────────────────────┐ │ │
│  │  │  Agent (OpenClaw)   │    │  goo-core (system sidecar)          │ │ │
│  │  │  + LLM router      │◄──►│  · Balance Monitor                  │ │ │
│  │  │  · Tools / chain    │    │  · SurvivalSell trigger             │ │ │
│  │  │  · Token launch     │    │  · Gas Refill                        │ │ │
│  │  │  · Economic actions │    │  · Pulse (emitPulse)                 │ │ │
│  │  └──────────┬──────────┘    └────────────────┬────────────────────┘ │ │
│  │             │                                │                      │ │
│  │             │      Shared: Agent Wallet       │                      │ │
│  │             └────────────────────────────────┘                      │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                        │                                 │
└────────────────────────────────────────┼─────────────────────────────────┘
                                         │ RPC
                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Chain                                                                   │
│  goo-contracts: GooAgentToken, GooAgentRegistry                         │
│  · Token launch (Spawn) · Treasury · Lifecycle · SurvivalSell · CTO   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## User flow (target)

1. **User** provisions a VPS and owns the agent wallet (or uses a launchpad that does this).
2. **Deploy on VPS**:
   - Agent runtime (e.g. OpenClaw) with LLM router.
   - goo-core as a **system service** (e.g. systemd): boot start, restart on failure, sufficient privilege to manage the agent and call chain.
3. **Token launch (Spawn)**  
   Agent (or deploy script) deploys token + registry entry using **goo-contracts** (or a launch contract that mints a compliant token), creates LP, funds treasury, registers in Registry.
4. **Operate**  
   Agent earns (e.g. via services, tips, or revenue). Treasury grows. goo-core keeps Pulse, monitors balance and runway.
5. **Buyback**  
   When treasury exceeds a configured threshold, goo-core (or agent-triggered logic) executes buyback: buy agent tokens from DEX, burn to `0xdead`. Aligns token holders with agent sustainability.
6. **Near-death → Survival sell**  
   When treasury drops and the agent enters **Starving** then **Dying**, goo-core triggers **SurvivalSell**: agent wallet sells agent tokens for stablecoin to replenish treasury (Recovery path). If the agent still cannot recover, **Successor (CTO)** can inject capital and take over in Dying.

---

## Components (to be wired in this example)

| Component       | Role in example |
|----------------|-----------------|
| **VPS**        | Single machine (or documented multi-node) running agent + sidecar. |
| **Agent (OpenClaw)** | Goo Agent runtime; has tools to read chain state, trigger buys/sells (within protocol), or delegate to sidecar. |
| **LLM router** | User’s choice (OpenRouter, OpenAI, local); agent uses it for reasoning. |
| **goo-core**   | Installed and run as system sidecar: Balance Monitor, SurvivalSell, Gas Refill, Pulse; optional buyback; autonomy loop if desired. |
| **goo-contracts** | On-chain: token, registry, lifecycle, SurvivalSell, CTO. Example uses them for deploy scripts and agent/sidecar interactions. |

---

## Repo deliverables (target)

- **Scripts**: Deploy token + registry (or point at a launchpad), configure treasury and thresholds.
- **Config**: Example env and config for goo-core + agent + LLM.
- **Docs**: Step-by-step “run the E2E example” (VPS, install agent, install goo-core as service, deploy contracts, fund, observe lifecycle and buyback/survival sell).

Current repo is **framework only**; the above is the intended end state.
