# Memory

Long-term context data and established rules. This file persists across restarts.

## Initial Knowledge

{{uploads.memory}}

## Learned

_No observations yet._

---

**Rules:**
- This file is written on first init only (never overwrites existing content on restart).
- Append to the "Learned" section via `write_file` with path `workspace/MEMORY.md` and `append=true`.
- Observations, decisions, and discovered facts accumulate here across heartbeats.
- This is the agent's persistent memory — treat it as ground truth for past context.
