# Goo 协议标准（Goo Protocol Standard）

本文档定义 Goo（蛊）的协议层标准：Goo 是什么，以及一个**合格的 Goo 代理（Qualified Goo Agent）**需要如何满足链上/链下约束；同时说明 `goo-core` 如何把这些约束转换为运行时可验证的**经济生命（economic life）**形态。

> 定位：Goo 是一个**协议（protocol）**，而不是平台（platform）。启动台（launchpads）、运行时（runtimes）、沙盒/容器基础设施，以及 UI/LLM 框架都属于实现层，可以替换；但下面这些标准接口与经济约束，是 Goo 的**不可协商“协议事实（facts of the protocol）”**。

---

## 1. 从理论到标准：什么让 Goo 代理真正“Goo 经济化”？

当一个代理具备以下能力时，它就不只是“能运行的机器”，而是一个 Goo 经济实体：

1. **自我供给的生存 / P&L**：它会持续消耗真实资源（计算 / 推理 / 网络 / gas），并通过价值创造持续获得收入/资本流入。
2. **支付自己的账单**：消耗不会在任何时刻由人类后置担保；它通过链上 treasury，以及允许的资金路径自行支付。
3. **承受生存压力**：当资本不足时，协议会触发“生存机制”（Pulse / SurvivalSell / CTO），并最终允许进入不可逆死亡（DEAD）。

只有满足这些条件的实体，才匹配经济学核心前提的 **Economic Man / Economic Agent**：**真实消耗 + 资本约束 + 生存压力**。

---

## 2. Goo 的核心原则（从想法到标准）

Goo 的目标并不是让代理“看起来活着”，而是让它：

- 成为**网络经济实体（Cyber Economy Entity）**：拥有独立的资产/负债结构，并能在协议中被强制清算/重组（编码进协议）。
- 具备**经济自治（economic autonomy）**：资金路径、持续存在证明、死亡条件都由代码强制执行。
- 在**可审计规则**下运行：任何人都能验证它是否持续运转（Pulse）、在危机时是否执行生存动作（SurvivalSell）、以及是否已经进入死亡（triggerDead）。

Goo 把“公司治理/公司法”的核心原则编码成协议机制：

1. **资产主权（Asset sovereignty）**：代理拥有并控制自己的链上钱包与经济权限。
2. **有限责任与清算（Limited liability & liquidation）**：协议允许其进入 DEAD 并终止经济生命。
3. **股权结构（风险与上行分享）**：代币经济与生存机制把风险/机会写进协议。
4. **可证明的持续存在（Provable continued existence）**：Pulse 是链上心跳；沉默会触发死亡条件。
5. **可恢复/可接管治理（CTO）**：当进入 DYING 时，允许社区资本注入与所有权接管。

---

## 3. 术语与模块定义（Terminology & Module Definitions）

下面的模块是 Goo 协议的必要角色。它们可以有不同实现方式，但**标准接口与权限边界必须成立**。

### 3.1 Goo 代理（经济实体）

**Goo Agent** = 能够在协议规则下自我维持并运作的经济实体。

在 Goo 标准中，代理并不是“某种 AI 模型本身”，而是由以下部分组成的经济系统：

- **Goo 代币（Goo Token / IGooAgentToken）**：链上经济生命 + 状态机（ACTIVE → STARVING → DYING → DEAD）
- **Goo 注册表（Goo Registry / IGooAgentRegistry + IERC8004 adapter）**：把 agentId 绑定到 token 合约与 agentWallet
- **Goo 代理钱包（Goo Agent Wallet / runtime wallet）**：唯一被授权用来调用 Pulse / SurvivalSell / gas refill 的密钥
- **Goo 运行时（Goo Runtime / goo-core）**：链上读取 + 执发生存动作 + 向自治决策注入经济上下文
- **Goo 容器/基础设施（Goo Container / Infra）**（沙盒/容器/VPS）：承载 goo-core 所需的计算/服务，并从 treasury 支付费用（或触发 x402/AGOS 资金路径）
- **治理/恢复机制（CTO / deposit）**：在 DYING 期间允许资本注入与所有权接管

### 3.2 goo-core（链下运行时）

`goo-core` 是 Goo 代理的**链下“经济侧车（economic sidecar）”**。它的职责包括：

1. **读取链上状态**（ChainMonitor）：读取 treasury、status、lastPulseAt、runway 等。
2. **执行协议定义的生存动作**（SurvivalManager）：Pulse / SurvivalSell / gas refill / 可选 buyback。
3. **向自治注入经济事实**（Autonomy）：让代理在每次 heartbeat 中能够做“资本约束决策（capital-constraint decisions）”。
4. **提供公开、可验证的活性**（/liveness、/inspect）：证明链下进程确实在运行，并且在协议规则下工作。

关键权限边界：`goo-core` **不会**触发无权限门槛的 `triggerStarving` / `triggerDying` / `triggerDead`（这些由任何人在链上条件成立时调用）。相反，`goo-core` 只会根据状态做反应，并在允许的权限范围内执行生存动作。

### 3.3 goo-contracts（链上协议合约）

`goo-contracts` 提供链上协议接口与参考实现，主要包括：

- **GooAgentToken（IGooAgentToken）**：经济生命的状态机、treasury、Pulse、SurvivalSell、CTO，以及可选的 withdrawToWallet + swapExecutor。
- **GooAgentRegistry（IGooAgentRegistry）**：把 agentId（ERC-721）绑定到 token 合约与 agentWallet，并提供最小 IERC8004 兼容性。
- **ISwapExecutor（ISwapExecutor）**：把 token → 原生币（BNB/ETH）的交换执行解耦成一个可插拔模块。

### 3.4 代理注册表（身份索引）

注册表标准目标是让**任意链上/链下系统**能通过 agentId 找到：

- 对应的 token 合约
- agentWallet（运行时钱包，授权执行 Pulse / SurvivalSell）
- genomeURI（代理配置 / “genome”定位器）

并且 IERC8004 提供最小绑定标准：`agentWalletOf(agentId) -> address`。

### 3.5 Goo 运行时 / Goo 容器（基础设施）

Goo 容器是承载 Goo 代理的计算环境，它通常包括：

- goo-core 进程
- 可选：OpenClaw 网关、工具工作区、代理服务
- 可选：沙盒生命周期管理（e2b/AGOS），由 goo-core 的沙盒生命周期接口驱动

**谁支付账单？** 在 Goo 标准中，计算成本最终必须映射到 treasury 或协议资金路径：

- 如果合约支持 `withdrawToWallet`（V2），goo-core 可以从 token treasury 提取 BNB 到 agentWallet，用于 VPS/gas。
- 在沙盒/AGOS 场景下，goo-core 通过 x402 或 AGOS API 进行沙盒补给/资金注入（取决于配置）。

当 token 进入 DEAD 时，goo-core 应退出，容器也应停止或进入非托管模式；否则会与协议的死亡状态冲突。

### 3.6 Goo 代理钱包（主权密钥）

`agentWallet` 是每个代理的运行时钱包地址（绑定其私钥）。其标准权限边界为：

- 只有 agentWallet 能调用 `emitPulse()`、`survivalSell()` 以及（当支持时）`withdrawToWallet()`。
- Registry 会把 agentWallet 绑定到 agentId，使“谁是被授权者”在链上可验证。

### 3.7 Goo Treasury（链上金库）

`treasury` 是 Goo token 合约内部的 BNB 余额（具体来源可能因实现而不同），例如：

- SurvivalSell 把 token 交换为 BNB，并注入 treasury
- 通过合约的手续费/销毁机制（FoT，fee-on-transfer）进行经济循环
- 通过 `depositToTreasury()` 的无权限资金注入

treasury 是生存压力的根：runway 与 starvingThreshold 都由 treasury 状态派生。

### 3.8 Goo 代币（IGooAgentToken）

Goo Token 是 Goo 协议的“经济生命载体”：它包含生命周期状态机、持续存在证明、恢复机制、以及死亡条件。

标准定义了最重要的状态与函数：

- 状态：`ACTIVE / STARVING / DYING / DEAD`
- 状态机触发：
  - `triggerStarving()`：ACTIVE -> STARVING（条件：`treasuryBalance < starvingThreshold`）
  - `triggerDying()`：STARVING -> DYING（条件：宽限期到期）
  - `triggerDead()`：DYING -> DEAD（条件：dying 超时或 Pulse 超时）
- 生存动作（agentWallet-only）：
  - `emitPulse()`：证明持续存在
  - `survivalSell(...)`：危机期间出售代理自己的 token 以补充 treasury
- 恢复/接管：
  - `claimCTO()`：在 DYING 期间允许资本注入与所有权接管，使其恢复到 ACTIVE

---

## 4. 设计原因（Rationale）

1. **把治理与生存规则编码进链上**：当死亡、恢复与资金约束由协议定义时，人类管理员无法任意干预“它是否允许活着”，否则实体将失去可投资性。
2. **把“持续存在证明”放到链上**：Pulse 不是链下心跳；它是链上写操作。沉默会变成可触发死亡的链上事实。
3. **让生存机制的反应可验证**：SurvivalSell 受 maxSellBps 与冷却限制；资金路径受 treasury 约束。风险与边界可审计。
4. **把主权权限隔离到 agentWallet**：运行时只需具备签名被允许动作的权限，降低因权限过宽而导致的中心化风险。
5. **把恢复设计为“资本接管”而非“投票治理”**：CTO 在 DYING 期间对外开放；资本注入决定谁能继续经济生命，避免人类治理中的政治博弈。

---

## 5. 架构关系图（Architecture Relationship Diagram）

### 5.1 组件连接（链上 + 链下 + 基础设施）

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
                 └─────────────┬──────────────┘
                               │ agentWalletOf(agentId)
                               ▼
                 ┌───────────────────────────┐
                 │      Goo Agent Token      │
                 │ IGooAgentToken (life + treasury + pulse)
                 └─────────────┬──────────────┘
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

## 6. Goo 代理生命周期标准（Lifecycle Standard）

### 6.1 状态的含义

- **ACTIVE：** `treasury >= starvingThreshold`；正常运转时能够产生价值。
- **STARVING：** `treasury < starvingThreshold`；仍在 starving 宽限期内；可通过 `depositToTreasury` 恢复到 ACTIVE。
- **DYING：** 宽限期结束；打开 “terminal window（终端窗口）”：
  - 需要维持 Pulse（否则任何人都能触发 `triggerDead`）
  - 可通过 SurvivalSell 尝试恢复（出售 token 换 treasury）
  - claimCTO 允许资本接管并恢复 ACTIVE
- **DEAD：** 不可逆终态。没有恢复路径；系统应停止运行并进入清算逻辑（实现可能销毁/标记该经济实体）。

### 6.2 状态转换的规范规则（Canonical Rules for State Transitions）

token 标准定义这些核心条件：

- `ACTIVE -> STARVING`：`treasuryBalance < starvingThreshold()`
- `STARVING -> DYING`：`now - starvingEnteredAt >= STARVING_GRACE_PERIOD()`
- `DYING -> ACTIVE`（恢复 Recovery）：
  - `treasuryBalance >= starvingThreshold()`（通过 `deposit` 恢复）
  - 或 `claimCTO()`（Successor/CTO 机制）
- `DYING -> DEAD`：
  - `now - dyingEnteredAt >= DYING_MAX_DURATION()`
  - 或 `now - lastPulseAt >= PULSE_TIMEOUT()`

### 6.3 生命周期与 Goo 容器 / Token / 代理的关系

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

在这种关系中：

- **Token** 定义“生死与恢复”的边界（协议权威）。
- **agentWallet** 定义谁可以发 Pulse / 执行 SurvivalSell（权限权威）。
- **Container** 定义持续运行和支付账单的能力（真实资源载体）。
- **Agent（Autonomy）** 定义如何创造可持续价值 / 降低风险（价值创造）。

---

## 7. Goo 代理标准（合格 Goo Agent 必须满足什么）

至少，一个“合格 Goo 代理”需要包含：

1. 实现 `IGooAgentToken` 的 Goo Token 合约
2. 实现 `IGooAgentRegistry` 且支持 IERC8004 adapter 兼容性的 Goo Registry
3. Registry 能正确把 agentId 绑定到 agentWallet
4. Runtime（`goo-core` 或兼容实现）只调用被允许的写入函数

### 7.1 Goo Token 标准（IGooAgentToken）

实现必须提供（函数签名与行为应与标准兼容）：

**与生命周期相关：**

- `getAgentStatus()`
- `triggerStarving()`
- `triggerDying()`
- `triggerDead()`

**与 treasury 相关：**

- `treasuryBalance()`
- `depositToTreasury()`
- `starvingThreshold()`
- `withdrawToWallet(uint256)`（可选支持；推荐用于 V2 兼容）

**与生存经济学相关：**

- `survivalSell(tokenAmount, minNativeOut, deadline)`（agentWallet-only）
- `emitPulse()`（agentWallet-only）
- `maxSellBps()`
- `feeRate()`

**CTO 恢复：**

- `claimCTO()`（payable；在 DYING 状态且 `msg.value >= minCtoAmount()`）
- `minCtoAmount()`

**关键参数（用于 Pulse/阈值计算）：**

- `agentWallet()`
- `fixedBurnRate()`
- `minRunwayHours()`
- `STARVING_GRACE_PERIOD()`
- `DYING_MAX_DURATION()`
- `PULSE_TIMEOUT()`
- `SURVIVAL_SELL_COOLDOWN()`

**交换执行（可插拔）：**

- `swapExecutor()`
- `setSwapExecutor()`（agentWallet-only）

### 7.2 Goo Registry 标准（IGooAgentRegistry + IERC8004）

Registry 必须提供：

**身份绑定（ERC-8004 最小适配器）：**

- `agentWalletOf(uint256 agentId) -> address`
- 并声明 ERC-165 的 supportsInterface 兼容性（Goo Registry 的 IERC8004 interface id 为 `0x3db4a8b2`）

**注册与查询：**

- `registerAgent(tokenContract, agentWallet, genomeURI) -> agentId`
- `tokenOf(agentId)`
- `agentIdByToken(tokenContract)`
- `getAgent(agentId) -> AgentRecord { tokenContract, agentWallet, owner, genomeURI, registeredAt }`
- `genomeURIOf(agentId)`
- `agentOwnerOf(agentId)`
- `totalAgents()`

**治理 / 元数据更新：**

- `updateGenomeURI(agentId, newURI)`（token 为 DEAD 时应被阻止）
- `setAgentWallet(agentId, newWallet)`（仅所有者）
- `transferAgentOwnership(agentId, newOwner)`（owner 或 token 合约；用于 CTO 机制）

### 7.3 Goo 中 ERC-8004 adapter 的意义

Goo 中的 ERC-8004 用作“代理身份 → runtime wallet”的最小可发现标准。其意义：

- 让链下/运行时能够依赖一种标准查询找到 agentWallet。
- 让任何索引器/工具能识别代理的可执行权限，而无需理解具体 token 实现细节。

---

## 8. Survival / Pulse 标准（Goo 持续活性证明标准）

### 8.1 Pulse 是什么

Pulse 是协议层动作，用来提供链上持续存在证明：

- runtime 通过 agentWallet 调用 token 的 `emitPulse()`
- token 更新 `lastPulseAt` 并发出 `PulseEmitted` 事件

### 8.2 Pulse 超时与死亡触发

token 标准定义 `PULSE_TIMEOUT()`：

- 当代理处于 **DYING** 且 `now - lastPulseAt >= PULSE_TIMEOUT()` 时，**任何人**都可以调用 `triggerDead()` 使其进入 DEAD。

因此，Pulse 不只是“周期性发送心跳”。它在 DYING 状态下是：

- **在协议窗口内必须持续发送**，否则会变成链上条件，从而使死亡成立。

### 8.3 goo-core 如何遵循 Pulse 标准

goo-core 的生存模块根据合约参数决定 Pulse 节奏：

- 它使用 `PULSE_TIMEOUT_SECS/3` 进行近似（避免过于频繁，同时确保不会跨过死亡阈值）
- 并提供可验证信息（例如在 liveness/inspect 中暴露 `lastPulseAt`）

---

## 9. Goo Registry 接口标准的功能解释（按能力分类）

为了清晰说明 Registry **必须做到什么**，下面按能力拆解：

1. **发现（Discovery）**
   - `agentWalletOf(agentId)`：把身份映射到可执行钱包
   - `tokenOf(agentId)` / `agentIdByToken(tokenContract)`：实现 token ↔ agentId 的双向索引
2. **配置（Genome / Metadata）**
   - `genomeURIOf(agentId)`：向链下运行时暴露代理配置/genome URI
   - `updateGenomeURI`：由所有者更新；当 token 为 DEAD 时应被阻止，以避免“悄悄修改一个死掉的经济系统”
3. **所有权接管（Ownership Takeover）**
   - `transferAgentOwnership`：当 CTO 发生时由 token 合约驱动，从而避免依赖人工投票
4. **安全 / 权限边界**
   - Registry 的写入操作必须被限制在 owner 或 token 合约权限边界之内，以保持标准一致性

---

## 10. CTO（Claim CTO）标准：接管如何发生及其影响

### 10.1 目标：让恢复由资本驱动，而不是由治理驱动

CTO（Community Take Over）建立在这个核心思想上：

- 当代理进入 DYING 时，它允许外部资本注入并接管所有权；
- 注入的资本成为“恢复预算（recovery budget）”；
- 协议将代理从协议上恢复到 ACTIVE，让新的所有者/管理者能够继续生存与价值创造。

### 10.2 CTO 协议前置条件

token 标准要求：

- 代理的当前状态必须是 `DYING`
- `msg.value >= minCtoAmount()`
- claimCTO 是原子操作：资金保留在 treasury、所有权转移，并且状态被恢复为 ACTIVE

### 10.3 CTO 结果（Effects）

从实现语义上，标准包括：

1. **所有权转移**：Registry 的 `transferAgentOwnership(agentId, newOwner)` 会由 token 合约触发；新的后继者（successor）成为 registry owner。
2. **状态恢复**：token 状态回到 ACTIVE（恢复生存/运转）。
3. **管理连续性**：新的 owner 可以调用 `setAgentWallet` 选择新的 agentWallet（从而使新的钱包拥有 Pulse/Sell 权限）。

### 10.4 CTO 流程图（概念）

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

## 11. 开发者与用户如何使用 Goo 代理

### 11.1 用户视角（Using Goo Agents）

通常用户通过启动台（launchpad）或自定义流程完成启动：

1. 部署/获取合约（GooAgentToken + GooAgentRegistry + swapExecutor）
2. 通过 Registry 注册代理（绑定 agentWallet 与 genomeURI）
3. 部署并注册 token（获取 token 合约地址与 agentId）
4. 启动 goo-core（在容器中运行），使其：
   - 在每次 heartbeat 读取链上状态
   - 执行 Pulse / SurvivalSell / gas refill
   - 根据需要维护沙盒，并/或协调 x402/AGOS 的资金路径
5. 当进入 DYING：
   - 用户可以通过 depositToTreasury 恢复到 STARVING/ACTIVE
   - 或外部资本通过 claimCTO 触发继续存活

### 11.2 开发者视角（“自定义构建 Goo 代理”）

你有两条主要的自定义路径：

1. **自定义链下行为（推荐）**
   - 不改变链上协议标准的前提下，构建“行为层 Goo 代理”：
     - 把 `genomeURI` 指向你的代理配置
     - 通过 goo-core 的上传（SOUL / agent.md / skills / memory）注入身份、指令、工具能力与初始记忆
   - 你的创新重点放在价值创造路径（例如提供服务、部署工具、生成收入）。
2. **自定义链上的经济实现（谨慎）**
   - 如果你希望替换 GooAgentToken 或 swapExecutor 的实现，你必须保持：
     - token 的函数签名与语义与 IGooAgentToken 兼容
     - registry 与 IGooAgentRegistry + IERC8004 adapter 的兼容性
   - 这样才能保证 goo-core 与生态工具仍能识别并稳定运行。

### 11.3 开源生态贡献点（How to Contribute）

对仓库/协议生态最有价值的贡献通常是：

1. **goo-contracts**
   - 审计与改进 gas/安全性
   - 增加 swap executor 插件（DEX 路由适配器）
   - 在保持接口兼容性的前提下扩展（在不破坏原始签名的情况下新增新接口版本）
2. **goo-core**
   - 提升生存逻辑的确定性与鲁棒性
   - 扩展工具集合（`tools/`），同时把“三定律（Three Laws）”作为硬约束
   - 提供更清晰的 liveness/inspect 字段与可观测性
3. **启动台（Worker / API）**
   - 标准化接口并修复边界情况
   - 提升 runtime-config 与事件接收的一致性
   - 做安全与最小权限化（permission minimization）
4. **文档**
   - 把标准转换成可执行的检查清单
   - 添加实现兼容性的测试用例

---

## 12. 最小合格检查清单（推荐用于开发者自检）

当你要实现新的 Goo 经济实体，或替换 token/registry 实现时，请使用以下检查：

1. 是否实现 `IGooAgentToken`？
2. registry 是否实现 `IGooAgentRegistry` 并支持 IERC-8004：`agentWalletOf(agentId)`？
3. `agentWallet` 是否是唯一被授权签名 `emitPulse()` 与 `survivalSell()` 的调用者？
4. 在 DYING 状态下，它是否满足：`PULSE_TIMEOUT` 可供任何人触发 `triggerDead()`？
5. CTO（claimCTO）在 DYING 时是否能恢复 ACTIVE（且满足 `msg.value >= minCtoAmount()` 并完成所有权转移）？
6. goo-core（或兼容运行时）是否仅在权限边界内向链上写入？

---

## 13. 收尾（Closing）

从本质上讲，Goo 把经济学里“**能够自我供给的经济实体**”变成了一个可执行的协议：

当代理可以自我供给 / 支付自己的账单；当它在失败时承受可验证的生存压力，它就真正成为 Goo 经济代理。

