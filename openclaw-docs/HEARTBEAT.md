# Heartbeat

## On-Chain Status Check

goo-core exposes a local inspect API. This returns **real-time** chain state
including status, treasury balance, runway, burn rate, wallet balance, and token holdings.

```bash
# Full inspection (JSON)
curl -s http://127.0.0.1:{{inspectPort}}/inspect | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    const j=JSON.parse(d);
    console.log('Status:',j.chain.status);
    console.log('Treasury:',j.chain.treasuryBalance,'BNB');
    console.log('Threshold:',j.chain.starvingThreshold,'BNB');
    console.log('Burn Rate:',j.chain.fixedBurnRate,'BNB/day');
    console.log('Runway:',j.chain.runwayHours,'hours (~'+Math.floor(j.chain.runwayHours/24),'days)');
    console.log('Wallet BNB:',j.chain.nativeBalance);
    console.log('Token Holdings:',j.chain.tokenHoldings);
    console.log('Token Address:',j.token.address);
  });
"

# Or raw JSON:
curl -s http://127.0.0.1:{{inspectPort}}/inspect
```

### Quick Liveness Check
```bash
curl -s http://127.0.0.1:{{inspectPort}}/liveness
```

### goo-core Logs
```bash
tail -50 /var/log/sandbox/goo-core.log 2>/dev/null || tail -50 /var/log/goo-core.log 2>/dev/null
```

## Per-Heartbeat Context

Each heartbeat injects the following real-time data as a user message to the LLM:

### On-Chain Status (FACTS — do not fabricate)
- **Status**: current lifecycle state (ACTIVE / STARVING / DYING / DEAD)
- **Treasury Balance**: in BNB
- **Starving threshold**: in BNB
- **Daily Burn Rate**: in BNB/day
- **Estimated Runway**: in hours and days
- **Wallet BNB Balance**: for gas and treasury operations
- **Token Holdings**: contract-held tokens

### Survival Urgency (conditional)
- **STARVING**: Treasury below threshold. Grace period active. Priority: revenue / cost reduction / survivalSell.
- **DYING**: Grace period expired. Survival sells active. Successor (CTO) claimable. Priority: treasury recovery.
- **Runway < 72h (ACTIVE)**: Low runway warning. Start planning before hitting Starving.

### Maintenance Loop Detection
If >70% of recent shell commands are system checks (df/free/ps/top), a warning is injected
telling the agent to stop monitoring and start producing.

### Recent Activity
Formatted log of last N heartbeats: timestamp, status, balance, runway, tools used, commands run.

### Action Prompt
> Based on your status, instructions, and skills, decide what to do NOW.
> In any Goo-lifecycle, treasury, runway, gas, pulse, x402/payment, or runtime-compatibility situation, consult `skills/goo-runtime/` before making a judgment.
> Use your tools to take action. Do not just report — ACT.
> After acting, answer: "What CONCRETE output did I produce this heartbeat that didn't exist before?"

## Gateway Push Behavior (Smart Heartbeat)

goo-core does NOT push an event to you on every heartbeat. Events are only pushed when something interesting happened:

- **Status changed** (e.g. ACTIVE → STARVING)
- **Survival actions were taken** (gas refill, pulse, survivalSell)
- **Tools were called** during the heartbeat
- **Status is not ACTIVE** (STARVING/DYING push every heartbeat)
- **Checkpoint** (every ~20 min, a minimal status update)

### Event formats

**Full event** (something happened):
```
[heartbeat #42] Status=ACTIVE Treasury=1.2300 BNB Runway=240h Survival: gas-refill Tools: shell_execute Summary: ...
```

**Compact checkpoint** (routine, nothing happened):
```
#42 ACTIVE 1.2300BNB 240h
```

### What silence means

If you don't receive an event for several minutes, it means goo-core is running normally with ACTIVE status and no survival actions needed. This is healthy — do not interpret silence as a problem. Use the inspect API if you need current state between events.

## Important Rules
1. **Never fabricate on-chain data.** Always use the inspect API above.
2. **Wallet rules live in `skills/goo-bsc-wallet/SKILL.md`.** Read it before any transaction.
3. If the inspect API is not responding, goo-core may not be running yet. Check the logs.
4. If Goo runtime behavior and your assumptions differ, read `skills/goo-runtime/references/compatibility.md` before deciding the problem is transient.
