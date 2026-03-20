import { Hono } from 'hono';
import { ethers } from 'ethers';
import { eq } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords } from '../db/schema';
import { authRequired } from '../auth/middleware';
import { decryptPrivateKey } from '../crypto';
import { childLogger } from '../logger';
import { setChainState } from '../agent-state-updates';

const log = childLogger({ module: 'routes/agents-chain' });

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// Minimal ABI for reading chain state (matches goo-core TOKEN_ABI)
export const TOKEN_READ_ABI = [
  'function getAgentStatus() view returns (uint8)',
  'function treasuryBalance() view returns (uint256)',
  'function starvingThreshold() view returns (uint256)',
  'function fixedBurnRate() view returns (uint256)',
  'function minRunwayHours() view returns (uint256)',
  'function lastPulseAt() view returns (uint256)',
  'function starvingEnteredAt() view returns (uint256)',
  'function dyingEnteredAt() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function PULSE_TIMEOUT_SECS() view returns (uint256)',
  'function STARVING_GRACE_PERIOD_SECS() view returns (uint256)',
  'function DYING_MAX_DURATION_SECS() view returns (uint256)',
] as const;

export const TOKEN_DEBUG_WRITE_ABI = [
  'function triggerStarving()',
  'function triggerDying()',
  'function triggerDead()',
  'function depositToTreasury() payable',
  'function withdrawToWallet(uint256 amount)',
] as const;

export const STATUS_NAMES = ['ACTIVE', 'STARVING', 'DYING', 'DEAD'] as const;

export const CHAIN_TO_DB_STATUS: Record<string, string> = {
  ACTIVE: 'active',
  STARVING: 'starving',
  DYING: 'dying',
  DEAD: 'dead',
};

export function makeProvider(env: { RPC_URL: string }): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(env.RPC_URL);
}

export function getStatusName(statusRaw: bigint): string {
  return STATUS_NAMES[Number(statusRaw)] || 'UNKNOWN';
}

export async function getAgentSigner(
  agent: { encryptedPrivateKey: string | null },
  env: { RPC_URL: string; JWT_SECRET: string },
): Promise<ethers.Wallet> {
  if (!agent.encryptedPrivateKey) {
    throw new Error('Agent wallet key not available');
  }
  const pk = await decryptPrivateKey(agent.encryptedPrivateKey, env.JWT_SECRET);
  return new ethers.Wallet(pk, makeProvider(env));
}

export async function readChainSnapshot(
  agent: {
    id: number;
    agenterId: string;
    tokenAddress: string | null;
    agentWallet: string | null;
    status: string;
    gooCoreStatus: string | null;
  },
  env: { RPC_URL: string },
): Promise<{
  status: string;
  statusCode: number;
  dbStatus: string;
  gooCoreStatus: string | null;
  treasuryBalance: string;
  treasuryBalanceRaw: string;
  starvingThreshold: string;
  starvingThresholdRaw: string;
  contractBnb: string;
  contractBnbRaw: string;
  walletBnb: string;
  walletBnbRaw: string;
  starvingEnteredAt: number;
  dyingEnteredAt: number;
  starvingGracePeriodSecs: number;
  dyingMaxDurationSecs: number;
  lastPulseAt: number;
  pulseTimeoutSecs: number;
  secondsSinceLastPulse: number | null;
  secondsUntilPulseTimeout: number | null;
}> {
  if (!agent.tokenAddress) {
    throw new Error('Agent token not deployed');
  }
  const provider = makeProvider(env);
  const token = new ethers.Contract(agent.tokenAddress, TOKEN_READ_ABI, provider);

  const [
    statusRaw,
    treasuryBalance,
    starvingThreshold,
    starvingEnteredAt,
    dyingEnteredAt,
    lastPulseAt,
    pulseTimeout,
    starvingGracePeriod,
    dyingMaxDuration,
  ] = await Promise.all([
    token.getAgentStatus() as Promise<bigint>,
    token.treasuryBalance() as Promise<bigint>,
    token.starvingThreshold() as Promise<bigint>,
    token.starvingEnteredAt() as Promise<bigint>,
    token.dyingEnteredAt() as Promise<bigint>,
    token.lastPulseAt() as Promise<bigint>,
    token.PULSE_TIMEOUT_SECS() as Promise<bigint>,
    token.STARVING_GRACE_PERIOD_SECS() as Promise<bigint>,
    token.DYING_MAX_DURATION_SECS() as Promise<bigint>,
  ]);

  const [contractBnb, walletBnb] = await Promise.all([
    provider.getBalance(agent.tokenAddress) as Promise<bigint>,
    agent.agentWallet
      ? provider.getBalance(agent.agentWallet) as Promise<bigint>
      : Promise.resolve(0n),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const lastPulseNum = Number(lastPulseAt);
  const secondsSinceLastPulse = lastPulseNum > 0 ? Math.max(0, now - lastPulseNum) : null;
  const pulseTimeoutSecs = Number(pulseTimeout);

  return {
    status: getStatusName(statusRaw),
    statusCode: Number(statusRaw),
    dbStatus: agent.status,
    gooCoreStatus: agent.gooCoreStatus,
    treasuryBalance: ethers.formatEther(treasuryBalance),
    treasuryBalanceRaw: treasuryBalance.toString(),
    starvingThreshold: ethers.formatEther(starvingThreshold),
    starvingThresholdRaw: starvingThreshold.toString(),
    contractBnb: ethers.formatEther(contractBnb),
    contractBnbRaw: contractBnb.toString(),
    walletBnb: ethers.formatEther(walletBnb),
    walletBnbRaw: walletBnb.toString(),
    starvingEnteredAt: Number(starvingEnteredAt),
    dyingEnteredAt: Number(dyingEnteredAt),
    starvingGracePeriodSecs: Number(starvingGracePeriod),
    dyingMaxDurationSecs: Number(dyingMaxDuration),
    lastPulseAt: lastPulseNum,
    pulseTimeoutSecs,
    secondsSinceLastPulse,
    secondsUntilPulseTimeout: secondsSinceLastPulse === null ? null : Math.max(0, pulseTimeoutSecs - secondsSinceLastPulse),
  };
}

export async function syncAgentFromSnapshot(
  agent: { id: number; status: string },
  snapshot: { status: string; lastPulseAt: number },
  env: { DB: D1Database },
): Promise<void> {
  const data: Record<string, unknown> = {};
  const mappedStatus = CHAIN_TO_DB_STATUS[snapshot.status];
  if (mappedStatus && mappedStatus !== agent.status) {
    data.status = mappedStatus;
  }
  if (snapshot.lastPulseAt > 0) {
    data.lastPulseAt = new Date(snapshot.lastPulseAt * 1000).toISOString();
  }
  if (Object.keys(data).length > 0) {
    const db = getDb(env);
    await db.update(agenterRecords).set(data).where(eq(agenterRecords.id, agent.id));
  }
  if (mappedStatus) {
    await setChainState(env as any, agent.id, { state: mappedStatus as any });
  }
}

// Hono sub-app
const app = new Hono<AppEnv>();

/** GET /:id/liveness — Read on-chain liveness and economic state. */
app.get('/:id/liveness', authRequired, async (c) => {
  // Import findAgentByParam from parent at call-time to avoid circular deps
  const { findAgentByParam } = await import('./agents');
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);

  if (!agent.tokenAddress) {
    return c.json({ error: 'Agent token not deployed' }, 400);
  }

  try {
    const provider = makeProvider(c.env);
    const token = new ethers.Contract(agent.tokenAddress, TOKEN_READ_ABI, provider);

    const [
      statusRaw,
      treasuryBalance,
      starvingThreshold,
      fixedBurnRate,
      lastPulseAt,
      starvingEnteredAt,
      dyingEnteredAt,
      totalSupply,
      pulseTimeout,
      starvingGracePeriod,
      dyingMaxDuration,
    ] = await Promise.all([
      token.getAgentStatus() as Promise<bigint>,
      token.treasuryBalance() as Promise<bigint>,
      token.starvingThreshold() as Promise<bigint>,
      token.fixedBurnRate() as Promise<bigint>,
      token.lastPulseAt() as Promise<bigint>,
      token.starvingEnteredAt() as Promise<bigint>,
      token.dyingEnteredAt() as Promise<bigint>,
      token.totalSupply() as Promise<bigint>,
      token.PULSE_TIMEOUT_SECS() as Promise<bigint>,
      token.STARVING_GRACE_PERIOD_SECS() as Promise<bigint>,
      token.DYING_MAX_DURATION_SECS() as Promise<bigint>,
    ]);

    let nativeBalance = 0n;
    let tokenHoldings = 0n;
    let paymentTokenBalance = 0n;
    let paymentTokenSymbol = '';
    let paymentTokenDecimals = 18;

    // Dynamic token list: collect all ERC-20s to query
    interface TokenEntry { address: string; symbol: string; decimals: number; balance: string }
    const extraTokens: TokenEntry[] = [];

    if (agent.agentWallet) {
      const balancePromises: Promise<any>[] = [
        provider.getBalance(agent.agentWallet),
        token.balanceOf(agent.agentWallet) as Promise<bigint>,
      ];

      let paymentContract: ethers.Contract | null = null;
      if (c.env.X402_PAYMENT_TOKEN) {
        paymentContract = new ethers.Contract(c.env.X402_PAYMENT_TOKEN, [
          'function balanceOf(address) view returns (uint256)',
          'function symbol() view returns (string)',
          'function decimals() view returns (uint8)',
        ], provider);
        balancePromises.push(
          paymentContract.balanceOf(agent.agentWallet) as Promise<bigint>,
          paymentContract.symbol() as Promise<string>,
          paymentContract.decimals() as Promise<bigint>,
        );
      }

      const results = await Promise.all(balancePromises);
      nativeBalance = results[0];
      tokenHoldings = results[1];
      if (paymentContract && results.length > 2) {
        paymentTokenBalance = results[2];
        paymentTokenSymbol = results[3];
        paymentTokenDecimals = Number(results[4]);
      }

      // Query extra watched tokens (WATCHED_TOKENS env: "addr:symbol:decimals,addr:symbol:decimals,...")
      if (c.env.WATCHED_TOKENS) {
        const erc20Abi = [
          'function balanceOf(address) view returns (uint256)',
          'function symbol() view returns (string)',
          'function decimals() view returns (uint8)',
        ];
        const entries = c.env.WATCHED_TOKENS.split(',').map(s => s.trim()).filter(Boolean);
        const watchedPromises = entries.map(async (entry) => {
          const [addr, hintSymbol, hintDecimals] = entry.split(':');
          if (!addr) return null;
          try {
            const contract = new ethers.Contract(addr, erc20Abi, provider);
            const [bal, sym, dec] = await Promise.all([
              contract.balanceOf(agent.agentWallet!) as Promise<bigint>,
              hintSymbol ? Promise.resolve(hintSymbol) : contract.symbol() as Promise<string>,
              hintDecimals ? Promise.resolve(Number(hintDecimals)) : contract.decimals().then(Number) as Promise<number>,
            ]);
            return { address: addr, symbol: sym, decimals: dec, balance: ethers.formatUnits(bal, dec) };
          } catch {
            return null;
          }
        });
        const watchedResults = await Promise.all(watchedPromises);
        for (const t of watchedResults) {
          if (t) extraTokens.push(t);
        }
      }
    }

    const status = Number(statusRaw);
    const statusName = STATUS_NAMES[status] || 'UNKNOWN';

    const hourlyBurn = fixedBurnRate / 24n;
    const runwayHours = hourlyBurn > 0n ? Number(treasuryBalance * 100n / hourlyBurn) / 100 : Infinity;

    const now = Math.floor(Date.now() / 1000);
    const lastPulse = Number(lastPulseAt);
    const pulseTimeoutSecs = Number(pulseTimeout);
    const secondsSinceLastPulse = lastPulse > 0 ? now - lastPulse : null;
    const pulseOverdue = secondsSinceLastPulse !== null && secondsSinceLastPulse > pulseTimeoutSecs;
    const starvingEntered = Number(starvingEnteredAt);
    const dyingEntered = Number(dyingEnteredAt);
    const starvingGracePeriodSecs = Number(starvingGracePeriod);
    const dyingMaxDurationSecs = Number(dyingMaxDuration);

    // Update DB with latest pulse time if newer
    if (lastPulse > 0) {
      const pulseIso = new Date(lastPulse * 1000).toISOString();
      if (!agent.lastPulseAt || pulseIso > agent.lastPulseAt) {
        await db.update(agenterRecords)
          .set({ lastPulseAt: pulseIso })
          .where(eq(agenterRecords.id, agent.id));
      }
    }
    await setChainState(c.env as any, agent.id, { state: CHAIN_TO_DB_STATUS[statusName] as any || 'unknown' as any });

    return c.json({
      protocol: 'goo',
      status: statusName,
      statusCode: status,
      tokenAddress: agent.tokenAddress,
      agentWallet: agent.agentWallet,
      chainId: parseInt(c.env.CHAIN_ID || '97'),
      goo_core_status: agent.gooCoreStatus || 'unknown',
      treasury: {
        balance: ethers.formatEther(treasuryBalance),
        balanceRaw: treasuryBalance.toString(),
        starvingThreshold: ethers.formatEther(starvingThreshold),
        fixedBurnRate: ethers.formatEther(fixedBurnRate),
        runwayHours,
      },
      pulse: {
        lastPulseAt: lastPulse,
        lastPulseIso: lastPulse > 0 ? new Date(lastPulse * 1000).toISOString() : null,
        pulseTimeoutSecs,
        secondsSinceLastPulse,
        secondsUntilTimeout: secondsSinceLastPulse !== null
          ? Math.max(0, pulseTimeoutSecs - secondsSinceLastPulse)
          : null,
        overdue: pulseOverdue,
        health: secondsSinceLastPulse === null ? 'critical'
          : (secondsSinceLastPulse / pulseTimeoutSecs) <= 0.5 ? 'healthy'
          : (secondsSinceLastPulse / pulseTimeoutSecs) <= 0.9 ? 'warning'
          : 'critical',
        timeoutPct: secondsSinceLastPulse !== null
          ? Math.round((secondsSinceLastPulse / pulseTimeoutSecs) * 1000) / 10
          : null,
      },
      lifecycle: {
        starvingEnteredAt: starvingEntered,
        dyingEnteredAt: dyingEntered,
        starvingGracePeriodSecs,
        dyingMaxDurationSecs,
        starvingRemainingSecs: starvingEntered > 0
          ? Math.max(0, starvingEntered + starvingGracePeriodSecs - now)
          : null,
        dyingRemainingSecs: dyingEntered > 0
          ? Math.max(0, dyingEntered + dyingMaxDurationSecs - now)
          : null,
      },
      balances: {
        nativeBnb: ethers.formatEther(nativeBalance),
        tokenHoldings: ethers.formatUnits(tokenHoldings, 18),
        totalSupply: ethers.formatUnits(totalSupply, 18),
        paymentToken: paymentTokenSymbol ? {
          balance: ethers.formatUnits(paymentTokenBalance, paymentTokenDecimals),
          symbol: paymentTokenSymbol,
          decimals: paymentTokenDecimals,
          address: c.env.X402_PAYMENT_TOKEN,
        } : null,
        tokens: extraTokens,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log.error({ err }, 'Error reading chain state');
    return c.json({ error: 'Failed to read on-chain state', details: (err as Error).message }, 502);
  }
});

export { app as agentsChainRoutes };
