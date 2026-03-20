import { Hono } from 'hono';
import { ethers } from 'ethers';
import { eq } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords } from '../db/schema';
import { authRequired } from '../auth/middleware';
import { isAgentOwner } from '../agent-access';
import { persistAgentEvent } from '../event-bus';
import {
  readChainSnapshot,
  syncAgentFromSnapshot,
  getAgentSigner,
  TOKEN_DEBUG_WRITE_ABI,
  STATUS_NAMES,
  makeProvider,
} from './agents-chain';

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const DEBUG_BNB_EPSILON = 1n;

function ensureDebugEnabled(env: Env): void {
  if (env.ENABLE_AGENT_DEBUG_CONTROLS !== 'true') {
    throw new Error('Agent debug controls are disabled');
  }
}

async function buildDebugResponse(
  agent: {
    id: number;
    agenterId: string;
    tokenAddress: string | null;
    agentWallet: string | null;
    status: string;
    gooCoreStatus: string | null;
  },
  actionTaken: string,
  env: Env,
  warnings: string[] = [],
) {
  const after = await readChainSnapshot(agent, env);
  await syncAgentFromSnapshot(agent, after, env);
  const db = getDb(env);
  const freshAgent = await db.select({
    id: agenterRecords.id,
    agenterId: agenterRecords.agenterId,
    tokenAddress: agenterRecords.tokenAddress,
    agentWallet: agenterRecords.agentWallet,
    status: agenterRecords.status,
    gooCoreStatus: agenterRecords.gooCoreStatus,
  }).from(agenterRecords).where(eq(agenterRecords.id, agent.id)).get();
  const finalState = freshAgent ? await readChainSnapshot(freshAgent as typeof agent, env) : after;
  return { actionTaken, after: finalState, warnings };
}

const app = new Hono<AppEnv>();

/** POST /:id/debug/drain-treasury */
app.post('/:id/debug/drain-treasury', authRequired, async (c) => {
  try {
    ensureDebugEnabled(c.env);
    const { findAgentByParam } = await import('./agents');
    const db = getDb(c.env);
    const agent = await findAgentByParam(db, c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!(await isAgentOwner(agent, c.get('auth'), c.env))) {
      return c.json({ error: 'Not your agent' }, 403);
    }
    if (!agent.tokenAddress || !agent.agentWallet) {
      return c.json({ error: 'Agent is missing token or wallet configuration' }, 400);
    }

    const before = await readChainSnapshot(agent, c.env);
    const treasuryRaw = BigInt(before.treasuryBalanceRaw);
    const thresholdRaw = BigInt(before.starvingThresholdRaw);
    if (treasuryRaw < thresholdRaw) {
      return c.json({ before, ...(await buildDebugResponse(agent, 'Treasury already below starving threshold.', c.env)) });
    }

    const signer = await getAgentSigner(agent, c.env);
    const tokenContract = new ethers.Contract(agent.tokenAddress, TOKEN_DEBUG_WRITE_ABI, signer);
    const contractBnb = BigInt(before.contractBnbRaw);
    const walletBnb = BigInt(before.walletBnbRaw);
    const targetRaw = thresholdRaw > DEBUG_BNB_EPSILON ? thresholdRaw - DEBUG_BNB_EPSILON : 0n;
    const drainNeeded = treasuryRaw > targetRaw ? treasuryRaw - targetRaw : 0n;

    if (contractBnb + walletBnb < drainNeeded) {
      return c.json({ error: 'Treasury funds unavailable for debug drain' }, 409);
    }

    if (contractBnb > 0n) {
      try {
        const withdrawAmount = contractBnb > drainNeeded ? drainNeeded : contractBnb;
        const tx = await tokenContract.withdrawToWallet(withdrawAmount);
        await tx.wait();
      } catch {
        // withdrawToWallet may revert if it would trigger starving
      }
    }

    await persistAgentEvent(c.env, {
      agenterId: agent.agenterId,
      eventType: 'debug_drain',
      severity: 'warn',
      message: 'Debug drain reduced treasury below starving threshold',
      metadata: { before, drainedRaw: drainNeeded.toString() },
    });

    return c.json({
      before,
      ...(await buildDebugResponse(agent, `Drained ${ethers.formatEther(drainNeeded)} BNB from treasury.`, c.env)),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** POST /:id/debug/trigger-starving */
app.post('/:id/debug/trigger-starving', authRequired, async (c) => {
  try {
    ensureDebugEnabled(c.env);
    const { findAgentByParam } = await import('./agents');
    const db = getDb(c.env);
    const agent = await findAgentByParam(db, c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!(await isAgentOwner(agent, c.get('auth'), c.env))) {
      return c.json({ error: 'Not your agent' }, 403);
    }
    if (!agent.tokenAddress) return c.json({ error: 'Agent token not deployed' }, 400);

    const before = await readChainSnapshot(agent, c.env);
    if (BigInt(before.treasuryBalanceRaw) >= BigInt(before.starvingThresholdRaw)) {
      return c.json({ error: 'Treasury is still at or above starving threshold' }, 409);
    }
    if (before.status === 'STARVING') {
      return c.json({ before, ...(await buildDebugResponse(agent, 'Agent is already STARVING.', c.env)) });
    }

    const signer = await getAgentSigner(agent, c.env);
    const token = new ethers.Contract(agent.tokenAddress, TOKEN_DEBUG_WRITE_ABI, signer);
    const tx = await token.triggerStarving();
    await tx.wait();

    await persistAgentEvent(c.env, {
      agenterId: agent.agenterId,
      eventType: 'debug_starving',
      severity: 'warn',
      message: 'Debug trigger moved agent into STARVING',
      metadata: { before },
    });

    return c.json({ before, ...(await buildDebugResponse(agent, 'Triggered STARVING state.', c.env)) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** POST /:id/debug/trigger-dying */
app.post('/:id/debug/trigger-dying', authRequired, async (c) => {
  try {
    ensureDebugEnabled(c.env);
    const { findAgentByParam } = await import('./agents');
    const db = getDb(c.env);
    const agent = await findAgentByParam(db, c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!(await isAgentOwner(agent, c.get('auth'), c.env))) {
      return c.json({ error: 'Not your agent' }, 403);
    }
    if (!agent.tokenAddress) return c.json({ error: 'Agent token not deployed' }, 400);

    const before = await readChainSnapshot(agent, c.env);
    if (before.status !== 'STARVING') {
      return c.json({ error: 'Agent must already be STARVING before it can enter DYING' }, 409);
    }
    const now = Math.floor(Date.now() / 1000);
    if (before.starvingEnteredAt <= 0) {
      return c.json({ error: 'Missing starvingEnteredAt on-chain timestamp' }, 409);
    }
    const remaining = Math.max(0, before.starvingEnteredAt + before.starvingGracePeriodSecs - now);
    if (remaining > 0) {
      return c.json({ error: `STARVING grace period not elapsed yet (${remaining}s remaining)` }, 409);
    }

    const signer = await getAgentSigner(agent, c.env);
    const token = new ethers.Contract(agent.tokenAddress, TOKEN_DEBUG_WRITE_ABI, signer);
    const tx = await token.triggerDying();
    await tx.wait();

    await persistAgentEvent(c.env, {
      agenterId: agent.agenterId,
      eventType: 'debug_dying',
      severity: 'warn',
      message: 'Debug trigger moved agent into DYING',
      metadata: { before },
    });

    return c.json({ before, ...(await buildDebugResponse(agent, 'Triggered DYING state.', c.env)) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** POST /:id/debug/trigger-dead */
app.post('/:id/debug/trigger-dead', authRequired, async (c) => {
  try {
    ensureDebugEnabled(c.env);
    const { findAgentByParam } = await import('./agents');
    const db = getDb(c.env);
    const agent = await findAgentByParam(db, c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!(await isAgentOwner(agent, c.get('auth'), c.env))) {
      return c.json({ error: 'Not your agent' }, 403);
    }
    if (!agent.tokenAddress) return c.json({ error: 'Agent token not deployed' }, 400);

    const before = await readChainSnapshot(agent, c.env);
    if (before.status !== 'DYING') {
      return c.json({ error: 'Agent must already be DYING before it can become DEAD' }, 409);
    }
    const now = Math.floor(Date.now() / 1000);
    const pulseReady = before.lastPulseAt > 0 && (before.lastPulseAt + before.pulseTimeoutSecs) <= now;
    const dyingReady = before.dyingEnteredAt > 0 && (before.dyingEnteredAt + before.dyingMaxDurationSecs) <= now;
    if (!pulseReady && !dyingReady) {
      const pulseRemaining = before.lastPulseAt > 0
        ? Math.max(0, before.lastPulseAt + before.pulseTimeoutSecs - now)
        : null;
      const dyingRemaining = before.dyingEnteredAt > 0
        ? Math.max(0, before.dyingEnteredAt + before.dyingMaxDurationSecs - now)
        : null;
      return c.json({
        error: `Agent is not yet eligible for DEAD (pulse=${pulseRemaining ?? 'n/a'}s, dying=${dyingRemaining ?? 'n/a'}s remaining)`,
      }, 409);
    }

    const signer = await getAgentSigner(agent, c.env);
    const token = new ethers.Contract(agent.tokenAddress, TOKEN_DEBUG_WRITE_ABI, signer);
    const tx = await token.triggerDead();
    await tx.wait();

    await db.update(agenterRecords)
      .set({ status: 'dead', gooCoreStatus: 'stopped' })
      .where(eq(agenterRecords.id, agent.id))
      .catch(() => {});

    await persistAgentEvent(c.env, {
      agenterId: agent.agenterId,
      eventType: 'debug_dead',
      severity: 'critical',
      message: 'Debug trigger moved agent into DEAD',
      metadata: { before },
    });

    return c.json({ before, ...(await buildDebugResponse(agent, 'Triggered DEAD state and stopped runtime.', c.env)) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** POST /:id/debug/fund-treasury */
app.post('/:id/debug/fund-treasury', authRequired, async (c) => {
  try {
    ensureDebugEnabled(c.env);
    const { findAgentByParam } = await import('./agents');
    const db = getDb(c.env);
    const agent = await findAgentByParam(db, c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!(await isAgentOwner(agent, c.get('auth'), c.env))) {
      return c.json({ error: 'Not your agent' }, 403);
    }
    if (!agent.tokenAddress || !agent.agentWallet) {
      return c.json({ error: 'Agent is missing token or wallet configuration' }, 400);
    }

    const before = await readChainSnapshot(agent, c.env);
    if (before.status === 'DEAD') {
      return c.json({ error: 'Agent is DEAD and cannot be recovered via treasury funding' }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as { mode?: 'topup10' | 'recover'; amount?: string };
    const signer = await getAgentSigner(agent, c.env);
    const token = new ethers.Contract(agent.tokenAddress, TOKEN_DEBUG_WRITE_ABI, signer);
    const thresholdRaw = BigInt(before.starvingThresholdRaw);
    const treasuryRaw = BigInt(before.treasuryBalanceRaw);

    let amountRaw = 0n;
    if (body.amount) {
      amountRaw = ethers.parseEther(body.amount);
    } else if (body.mode === 'topup10') {
      amountRaw = ethers.parseEther('0.01');
    } else {
      const target = thresholdRaw + ethers.parseEther('0.001');
      amountRaw = target > treasuryRaw ? target - treasuryRaw : ethers.parseEther('0.001');
    }

    const depositTx = await token.depositToTreasury({ value: amountRaw });
    await depositTx.wait();

    await persistAgentEvent(c.env, {
      agenterId: agent.agenterId,
      eventType: 'debug_fund',
      severity: 'info',
      message: 'Debug funding deposited BNB into treasury',
      metadata: { before, amountRaw: amountRaw.toString() },
    });

    return c.json({
      before,
      ...(await buildDebugResponse(agent, `Deposited ${ethers.formatEther(amountRaw)} BNB into treasury.`, c.env)),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

export { app as agentsDebugRoutes };
