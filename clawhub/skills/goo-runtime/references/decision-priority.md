# Decision Priority Reference

## Priority order

### 1. Re-establish reality
If facts are missing or stale, gather them first:
- inspect API
- liveness API
- goo-core logs
- gateway health

### 2. Preserve life
If any of these are true, survival has priority:
- status is `STARVING` or `DYING`
- pulse is overdue or close to timeout
- wallet gas is too low for runtime actions
- goo-core is down or crash-looping
- runway is critically short

### 3. Restore runtime continuity
If OpenClaw, gateway, x402 proxy, or goo-core is unhealthy, fix runtime continuity before broader work.

### 4. Continue the most valuable unfinished thread
When survival is not urgent:
- choose one main thread
- continue it
- verify output
- avoid jumping between unrelated tasks

## Anti-patterns

Do not:
- treat a healthy chat response as proof that goo-core is healthy
- treat treasury balance alone as proof the agent is safe
- continue feature work while ignoring `STARVING` or stale pulse warnings
- confuse monitoring activity with productive output
