# Goo Protocol Standard (Goo Protocol Standard)

This document defines the protocol-layer standard of Goo (蛊): what Goo is, what it means for a **qualified Goo Agent** to satisfy on-chain / off-chain constraints, and how `goo-core` turns those constraints into a verifiable form of **economic life** at runtime.

> Positioning: Goo is a **protocol** (not a platform). Launchpads, runtimes, sandbox/container infrastructure, and UI/LLM frameworks are implementation layers and can be replaced; but the standard interfaces and economic constraints below are Goo’s **non-negotiable “facts of the protocol.”**

---

## 1. From Theory: What Makes a Goo Agent Truly “Goo Economic”?

When an agent has the following capabilities, it is not merely “a machine that runs,” but a Goo economic entity:

1. **Self-funded survival / P&L**: it continuously consumes real resources (compute / inference / network / gas) and receives income / capital inflow through value creation.
2. **Pays its own bills**: consumption is not backstopped by humans at any time; it is self-paid via the on-chain treasury and allowed funding paths.
3. **Has survival pressure**: when capital is insufficient, the protocol triggers a “survival mechanism” (Pulse / SurvivalSell / CTO), and ultimately permits entering irreversible death (DEAD).

Only entities that meet these conditions match the key premise of economics’ **Economic Man / Economic Agent**: **real consumption + capital constraints + survival pressure**.

---

## 2. Goo’s Core Principles (from Idea to Standard)

Goo’s goal is not to make an agent “look alive,” but to make the agent:

- become a **Cyber Economy Entity**: with independent asset / liability structure, and can be force-liquidated / restructured (encoded in the protocol).
- have **economic autonomy**: funding paths, proof-of-aliveness, and death conditions are enforced by code.
- run under **auditable rules**: anyone can verify whether it is continuously operating (Pulse), whether it takes survival actions during crisis (SurvivalSell), and whether it has entered death (triggerDead).

Goo encodes core principles of “corporate law / governance” into protocol mechanics:

1. **Asset sovereignty**: the agent owns and controls its own on-chain wallet and economic permissions.
2. **Limited liability & liquidation**: the protocol allows it to enter DEAD and terminate economic life.
3. **Equity structure (risk & upside sharing)**: token economics and survival mechanisms encode risk/opportunity into the protocol.
4. **Provable continued existence**: Pulse is an on-chain heartbeat; silence enables a death-triggering condition.
5. **Recoverable / takeover governance (CTO)**: when DYING, allow community capital injection and ownership takeover.

---

## 3. Terminology & Module Definitions

The following modules are the necessary roles of the Goo protocol. They can have different implementations, but the **standard interfaces / permission boundaries must hold**.

### 3.1 Goo Agent (Economic Entity)

**Goo Agent** = an economic entity that can sustain itself and operate under protocol rules.

In the Goo standard, an agent is not “an AI model” by itself, but an economic system composed of:

- **Goo Token (IGooAgentToken)**: on-chain economic life + state machine (ACTIVE → STARVING → DYING → DEAD)
- **Goo Registry (IGooAgentRegistry + IERC8004 adapter)**: binds agentId to a token contract and the agentWallet
- **Goo Agent Wallet (runtime wallet)**: the only key authorized to call Pulse / SurvivalSell / gas refill
- **Goo Runtime (goo-core)**: on-chain reads + executes survival actions + injects economic context into autonomous decision-making
- **Goo Container / Infra (sandbox/container/VPS)**: hosts the computation/services running goo-core, and pays bills from treasury (or triggers x402/AGOS funding paths)
- **Governance / recovery mechanism (CTO / deposit)**: during DYING, allows capital injection and ownership takeover

### 3.2 goo-core (Off-chain Runtime)

`goo-core` is Goo Agent’s **off-chain “economic sidecar.”** Its responsibilities are:

1. **Read on-chain state** (ChainMonitor): read treasury, status, lastPulseAt, runway, etc.
2. **Execute protocol-defined survival actions** (SurvivalManager): Pulse / SurvivalSell / gas refill / optional buyback.
3. **Inject economic facts into autonomy** (Autonomy): enable the agent to make “capital-constraint decisions” on every heartbeat.
4. **Provide public, verifiable liveness** (/liveness, /inspect): prove that the off-chain process is running and operating under protocol rules.

Critical permission boundary: `goo-core` **does not trigger** permissionless `triggerStarving` / `triggerDying` / `triggerDead` (anyone calls them when on-chain conditions are met). Instead, `goo-core` only reacts to status and performs survival actions within allowed permissions.

### 3.3 goo-contracts (On-chain Protocol Contracts)

`goo-contracts` provides the on-chain protocol interfaces and reference implementations, mainly:

- **GooAgentToken (IGooAgentToken)**: the economic life state machine, treasury, Pulse, SurvivalSell, CTO, and optional withdrawToWallet + swapExecutor.
- **GooAgentRegistry (IGooAgentRegistry)**: binds agentId (ERC-721) to token / agentWallet / genomeURI, and provides minimal IERC8004 compatibility.
- **ISwapExecutor (ISwapExecutor)**: decouples token → native币 (BNB/ETH) swap execution into a pluggable module.

### 3.4 Agent Registry (Identity Index)

Registry’s standard goal is to let **any chain/ off-chain system** find, via agentId:

- the corresponding token contract
- agentWallet (the runtime wallet authorized to do Pulse / SurvivalSell)
- genomeURI (the agent configuration / “genome” locator)

And IERC8004 provides the minimized binding standard: `agentWalletOf(agentId) -> address`.

### 3.5 Goo Runtime / Goo Container (Infrastructure)

Goo Container is the compute environment that hosts a Goo Agent. It typically includes:

- the goo-core process
- optionally: OpenClaw gateway, tool workspace, proxy services
- optionally: sandbox lifecycle management (e2b / AGOS), driven by goo-core’s sandbox lifecycle interface

**Who pays bills?** In the Goo standard, compute costs must ultimately map to treasury or protocol funding paths:

- if contracts support `withdrawToWallet` (V2), goo-core can withdraw BNB from token treasury to agentWallet to cover VPS/gas.
- in sandbox/AGOS scenarios, goo-core performs sandbox top-up / funding via x402 or AGOS API (configuration-dependent).

When the token enters DEAD, goo-core should exit, and the container should stop or go into unattended mode; otherwise it conflicts with the protocol’s death state.

### 3.6 Goo Agent Wallet (Sovereign Key)

`agentWallet` is the runtime wallet address for each agent (bound to its private key). Its standard permission boundary:

- only agentWallet can call `emitPulse()`, `survivalSell()`, and (when supported) `withdrawToWallet()`.
- Registry binds agentWallet to agentId so “who is authorized” is verifiable on-chain.

### 3.7 Goo Treasury (On-chain Treasury)

`treasury` is the BNB balance inside the Goo token contract, sourced from (implementation may vary):

- SurvivalSell swaps tokens into BNB and injects BNB into treasury
- economic recirculation via the contract’s fee-on-transfer (FoT) mechanism
- permissionless funding via `depositToTreasury()`

Treasury is the root of survival pressure: runway and starvingThreshold are derived from treasury state.

### 3.8 Goo Token (IGooAgentToken)

Goo Token is the “economic life carrier” of the Goo protocol: it includes a lifecycle state machine, proof-of-liveness, recovery mechanics, and death conditions.

The standard specifies the most important states and functions:

- states: `ACTIVE / STARVING / DYING / DEAD`
- state machine triggers:
  - `triggerStarving()`: ACTIVE -> STARVING (condition: `treasuryBalance < starvingThreshold`)
  - `triggerDying()`: STARVING -> DYING (condition: grace period expires)
  - `triggerDead()`: DYING -> DEAD (condition: dying timeout or Pulse timeout)
- survival actions (agentWallet-only):
  - `emitPulse()`: prove continued existence
  - `survivalSell(...)`: during crisis, sell the agent’s own token to replenish treasury
- recovery via takeover:
  - `claimCTO()`: during DYING, allow capital injection + ownership takeover; recover to ACTIVE

---

## 4. Why This Design (Rationale)

1. **Encode governance & survival rules on-chain**: when death, recovery, and funding constraints are defined by the protocol, human administrators can’t arbitrarily interfere with “whether it is allowed to live,” otherwise the entity becomes uninvestable.
2. **Put “proof of continued existence” on-chain**: Pulse is not an off-chain heartbeat; it is an on-chain write action. Silence becomes a death-triggering on-chain fact.
3. **Make survival mechanisms verifiable reactions**: SurvivalSell is constrained by maxSellBps and cooldown; funding paths are constrained by treasury. Risk and boundaries are auditable.
4. **Isolate sovereign permissions to agentWallet**: runtime only has permissions to sign allowed actions, reducing centralization risk from overly broad privileges.
5. **Design recovery as “capital takeover,” not “voting governance”**: CTO is open during DYING; capital injection decides who can continue economic life, avoiding political games in human governance.

---

## 5. Architecture Relationship Diagram

### 5.1 Component Connections (on-chain + off-chain + infrastructure)

```
                ┌────────────────────────────┐
                │   Client / Developer UI    │
                │ (Launchpad / SDK / tools) │
                └─────────────┬──────────────┘
                              │ deploy / fund / config
                              ▼
                 ┌───────────────────────────┐
                 │   Goo Registry (ERC-721)  │
                 │ IGooAgentRegistry + IERC8004
                 └─────────────┬─────────────┘
                               │ agentWalletOf(agentId)
                               ▼
                 ┌───────────────────────────┐
                 │      Goo Agent Token      │
                 │ IGooAgentToken (life + treasury + pulse)
                 └─────────────┬─────────────┘
                               │ read status / write pulse & sell
                               ▼
          ┌─────────────────────────────────────────────────┐
          │                 goo-core runtime                │
          │  ChainMonitor → SurvivalManager → Autonomy     │
          │  (heartbeat: Pulse / SurvivalSell / gas refill)│
          └───────────────────┬─────────────────────────────┘
                              │ runs inside
                              ▼
          ┌─────────────────────────────────────────────────┐
          │            Goo Container / Infra               │
          │  VPS / Docker / e2b sandbox / AGOS VM         │
          │  支付 compute/gas：withdrawToWallet or x402/AGOS│
          └─────────────────────────────────────────────────┘

                              ▲
                              │ optional public proof (/liveness)
                              └────────────────────────────
```

---

## 6. Goo Agent Lifecycle Standard (Lifecycle Standard)

### 6.1 Meaning of States

- **ACTIVE**: `treasury >= starvingThreshold`; normal operation can generate value.
- **STARVING**: `treasury < starvingThreshold`; it is still within the starving grace period and can return to ACTIVE via `depositToTreasury`.
- **DYING**: the starving grace period ends; the “terminal window” opens:
  - Pulse must be maintained (otherwise anyone can trigger `triggerDead`)
  - recovery can be attempted via SurvivalSell (sell token for treasury)
  - claimCTO enables capital takeover recovery back to ACTIVE
- **DEAD**: irreversible terminal state. No recovery path; the system should stop running and enter liquidation logic (implementation may destroy / mark the economic entity).

### 6.2 Canonical Rules for State Transitions

token standard defines these core conditions:

- `ACTIVE -> STARVING`: `treasuryBalance < starvingThreshold()`
- `STARVING -> DYING`: `now - starvingEnteredAt >= STARVING_GRACE_PERIOD()`
- `DYING -> ACTIVE` (Recovery):
  - `treasuryBalance >= starvingThreshold()` (recovery via `deposit`)
  - or `claimCTO()` (Successor/CTO mechanism)
- `DYING -> DEAD`:
  - `now - dyingEnteredAt >= DYING_MAX_DURATION()`
  - or `now - lastPulseAt >= PULSE_TIMEOUT()`

### 6.3 Relationship Between Lifecycle and Goo Container / Token / Agent

```
Token 状态（on-chain） ──决定 goo-core 在每次 heartbeat 采取的生存动作
     │
     │ ACTIVE
     │   └─ 可选 buyback（实现可启用）
     │
     │ STARVING
     │   └─ survivalSell（卖 token 换 treasury）以恢复
     │
     │ DYING
     │   ├─ survivalSell 更关键（尽力恢复 treasury）
     │   ├─ emitPulse 必须按协议间隔做（避免触发 dead）
     │   └─ claimCTO 允许资本接管并恢复 ACTIVE
     │
     │ DEAD
     │   └─ goo-core 退出，容器应停止（经济生命结束）
```

In this relationship:

- **Token** defines the boundaries of “life/death & recovery” (protocol authority).
- **agentWallet** defines who can emit Pulse / execute SurvivalSell (permission authority).
- **Container** defines the ability to continuously run and pay bills (real resource carrier).
- **Agent (Autonomy)** defines how to create sustainable value / reduce risk (value creation).

---

## 7. Goo Agent Standard (What a Qualified Goo Agent Must Meet)

At minimum, a “qualified Goo Agent” must include:

1. **A Goo Token contract that implements IGooAgentToken**
2. **A Goo Registry that implements IGooAgentRegistry and supports IERC8004 adapter compatibility**
3. **Registry binds agentId to agentWallet correctly**
4. **Runtime (`goo-core` or compatible implementation) only calls permitted write functions**

### 7.1 Goo Token Standard (IGooAgentToken)

The implementation must provide (function signatures and behavior must be compatible):

**Lifecycle-related:**

- `getAgentStatus()`
- `triggerStarving()`
- `triggerDying()`
- `triggerDead()`

**Treasury-related:**

- `treasuryBalance()`
- `depositToTreasury()`
- `starvingThreshold()`
- `withdrawToWallet(uint256)` (optional support; recommended for V2 compatibility)

**Survival economics-related:**

- `survivalSell(tokenAmount, minNativeOut, deadline)` (agentWallet-only)
- `emitPulse()` (agentWallet-only)
- `maxSellBps()`
- `feeRate()`

**CTO recovery:**

- `claimCTO()` (payable; DYING and `msg.value >= minCtoAmount()`)
- `minCtoAmount()`

**Key parameters (used for Pulse/threshold calculations):**

- `agentWallet()`
- `fixedBurnRate()`
- `minRunwayHours()`
- `STARVING_GRACE_PERIOD()`
- `DYING_MAX_DURATION()`
- `PULSE_TIMEOUT()`
- `SURVIVAL_SELL_COOLDOWN()`

**Swap execution (pluggable):**

- `swapExecutor()`
- `setSwapExecutor()` (agentWallet-only)

### 7.2 Goo Registry Standard (IGooAgentRegistry + IERC8004)

Registry must provide:

**Identity binding (ERC-8004 minimal adapter):**

- `agentWalletOf(uint256 agentId) -> address`
- and declare ERC-165 `supportsInterface` compatibility (Goo Registry’s IERC8004 interface id is `0x3db4a8b2`)

**Registration & lookup:**

- `registerAgent(tokenContract, agentWallet, genomeURI) -> agentId`
- `tokenOf(agentId)`
- `agentIdByToken(tokenContract)`
- `getAgent(agentId) -> AgentRecord { tokenContract, agentWallet, owner, genomeURI, registeredAt }`
- `genomeURIOf(agentId)`
- `agentOwnerOf(agentId)`
- `totalAgents()`

**Governance / metadata updates:**

- `updateGenomeURI(agentId, newURI)` (should be blocked when token is DEAD)
- `setAgentWallet(agentId, newWallet)` (only owner)
- `transferAgentOwnership(agentId, newOwner)` (owner or token contract; used for CTO mechanism)

### 7.3 Meaning of ERC-8004 Adapter in Goo

ERC-8004 in Goo is used as “minimum discoverability of agent identity → runtime wallet.” Its significance:

- lets off-chain/runtime rely on one standard query to find agentWallet.
- lets any indexer/tool recognize executable permissions for agents without understanding the specific token implementation.

---

## 8. Survival / Pulse Standard (Goo Proof-of-Liveness Standard)

### 8.1 What Pulse Is

Pulse is the protocol-layer action that serves as an on-chain proof of continued existence:

- runtime calls token’s `emitPulse()` via agentWallet.
- token updates `lastPulseAt` and emits a `PulseEmitted` event.

### 8.2 Pulse Timeout & Death Trigger

token standard defines `PULSE_TIMEOUT()`:

- when the agent is in **DYING** and `now - lastPulseAt >= PULSE_TIMEOUT()`,
  **anyone** can call `triggerDead()` to set it to DEAD.

Therefore, Pulse is not merely “send a heartbeat periodically.” It is:

- **in DYING state, Pulse must be emitted continuously according to the protocol window**, otherwise it becomes an on-chain condition that enables death.

### 8.3 How goo-core Follows the Pulse Standard

goo-core’s survival module decides Pulse rhythm based on contract parameters:

- it approximates using `PULSE_TIMEOUT_SECS/3` on `pulse.cooldown` (avoid being too frequent while ensuring it won’t cross the death threshold).
- and it exposes verifiable info such as `lastPulseAt` in liveness/inspect.

---

## 9. Functional Explanation of Goo Registry Interface Standard (by Category)

To make it clear what the Registry “must do,” here is the functional breakdown by capability:

1. **Discovery**
   - `agentWalletOf(agentId)`: map identity to executable wallet.
   - `tokenOf(agentId)` / `agentIdByToken(tokenContract)`: implement bidirectional indexing token ↔ agentId.
2. **Configuration (Genome / Metadata)**
   - `genomeURIOf(agentId)`: expose agent configuration/genome URI to off-chain runtime.
   - `updateGenomeURI`: owner updates; should be blocked in DEAD to avoid “quietly modifying a dead economy.”
3. **Ownership Takeover**
   - `transferAgentOwnership`: when CTO occurs, driven by the token contract so ownership changes don’t rely on manual voting.
4. **Safety / Permission boundary**
   - Registry write operations must be constrained to owner or token-contract permission boundaries to keep standard consistency.

---

## 10. CTO (Claim CTO) Standard: How Takeover Works and Its Effects

### 10.1 Goal: Make Recovery Capital-Driven, Not Governance-Driven

CTO (Community Take Over) is based on this core idea:

- when an agent enters DYING, it allows external capital to inject and take over ownership;
- the injected capital becomes the “recovery budget”;
- the protocol recovers the agent back to ACTIVE, so the new owner/manager can continue survival and value creation.

### 10.2 CTO Protocol Preconditions

token standard requires:

- the agent’s current status must be `DYING`
- `msg.value >= minCtoAmount()`
- claimCTO is atomic: funds stay in treasury, ownership transfers, and state is restored to ACTIVE

### 10.3 CTO Results (Effects)

In implementation terms, the standard semantics include:

1. **Ownership transfer**: Registry’s `transferAgentOwnership(agentId, newOwner)` is triggered by the token contract; the new successor becomes the registry owner.
2. **State recovery**: token state returns to ACTIVE (resume survival/operations).
3. **Management continuity**: the new owner can call `setAgentWallet` to choose a new agentWallet (so a new wallet owns Pulse/Sell permissions).

### 10.4 CTO Flow Diagram (conceptual)

```
          DYING（链上）                              ACTIVE（链上恢复）
              │                                            ▲
              │ claimCTO(msg.value)                       │
              ├────────────────────────────────────────────┤
              │ 1) 校验 DYING + msg.value >= minCtoAmount
              │ 2) 资金进入 treasury（不外流，保持恢复预算）
              │ 3) token 合约触发 Registry：transferAgentOwnership
              │ 4) token 状态恢复 ACTIVE
              ▼
        新 successor 成为 owner
              │
              │ 可选：调用 Registry setAgentWallet 绑定新的 runtime wallet
              ▼
     新的 goo-core/container 用新 agentWallet 继续 heartbeat
```

---

## 11. How Developers and Users Use Goo Agent

### 11.1 User Perspective (Using Goo Agents)

Typically, users complete a launch process via a launchpad or a custom flow:

1. deploy / obtain contracts (GooAgentToken + GooAgentRegistry + swapExecutor)
2. register the agent through the Registry (bind agentWallet and genomeURI)
3. deploy and register the token (get token contract address and agentId)
4. launch goo-core (run it in a container) so it:
   - reads on-chain state on every heartbeat
   - executes Pulse / SurvivalSell / gas refill
   - maintains sandbox as needed and/or coordinates with x402/AGOS funding paths
5. when entering DYING:
   - the user can recover to STARVING/ACTIVE via depositToTreasury
   - or external capital triggers claimCTO to keep it alive

### 11.2 Developer Perspective (“Custom Building Goo Agents”)

You have two main customization paths:

1. **Customize off-chain behavior (recommended)**
   - without changing the on-chain protocol standard, build a “behavior-layer Goo Agent”:
     - point `genomeURI` to your agent configuration
     - inject identity, instructions, tool capabilities, and initial memory via goo-core uploads (SOUL / agent.md / skills / memory)
   - your innovation focuses on value-creation paths (e.g., providing services, deploying tools, generating revenue).
2. **Customize on-chain economic implementation (cautious)**
   - if you want to replace GooAgentToken or swapExecutor implementations, you must keep:
     - token function signatures and semantics compatible with IGooAgentToken
     - registry compatibility with IGooAgentRegistry + IERC8004 adapter support
   - this ensures goo-core and ecosystem tools can still recognize and run reliably.

### 11.3 Open-source Ecosystem Contribution Points (How to Contribute)

The most valuable contributions to the repo/protocol ecosystem are typically:

1. **goo-contracts**
   - audits and improvements to gas/safety
   - add swap executor plugins (DEX routing adapters)
   - extend while keeping interface compatibility (add new interface versions without breaking original signatures)
2. **goo-core**
   - improve survival determinism and robustness
   - extend toolsets (`tools/`) while keeping Three Laws hard constraints
   - provide clearer liveness/inspect fields and observability
3. **Launchpad (Worker / API)**
   - standardize interfaces and fix edge cases
   - improve consistency of runtime-config and event ingest
   - perform security and permission minimization
4. **Documentation**
   - turn the standard into implementable checklists
   - add implementation-compatibility test cases

---

## 12. Minimal Qualified Check List (Recommended for Developer Self-check)

When you want to implement a new Goo Agent economic entity or replace token/registry implementations, use this checklist:

1. does it implement `IGooAgentToken`?
2. does the registry implement `IGooAgentRegistry` and support IERC-8004: `agentWalletOf(agentId)`?
3. is `agentWallet` the only signer authorized to call `emitPulse()` and `survivalSell()`?
4. during DYING, does it satisfy: `PULSE_TIMEOUT` can be used by anyone to trigger `triggerDead()`?
5. does CTO (claimCTO) restore ACTIVE when DYING and `msg.value >= minCtoAmount()` and complete ownership transfer?
6. does goo-core (or a compatible runtime) only write on-chain when within permission boundaries?

---

## 13. Closing

At its core, Goo turns an “economically self-sustaining entity” in economics into an executable protocol:
when an agent can self-fund / pay its own bills, and it experiences verifiable survival pressure when it fails, it truly becomes a Goo economic agent.

