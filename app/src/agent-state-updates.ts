import { eq } from 'drizzle-orm';
import { agenterRecords } from './db/schema';
import { getDb } from './db';
import type { Env } from './bindings';
import type { ChainState, LaunchState, RuntimeState } from './agent-state';
import { nowIso } from './agent-state';
import { parseLaunchSession, patchLaunchSession } from './launch-session';

export async function setLaunchState(
  env: Env,
  agentId: number,
  input: {
    state: LaunchState;
    error?: string | null;
    launchSession?: string | null;
    sessionPatch?: Record<string, unknown>;
  },
) {
  const db = getDb(env);
  const existing = await db.select({ launchSession: agenterRecords.launchSession }).from(agenterRecords).where(eq(agenterRecords.id, agentId)).get();
  const nextSession = input.launchSession !== undefined
    ? input.launchSession
    : input.sessionPatch
      ? patchLaunchSession(existing?.launchSession, input.sessionPatch as any)
      : undefined;

  await db.update(agenterRecords).set({
    launchState: input.state,
    launchError: input.error ?? null,
    launchUpdatedAt: nowIso(),
    ...(nextSession !== undefined ? { launchSession: nextSession } : {}),
  }).where(eq(agenterRecords.id, agentId));
}

export async function setRuntimeState(
  env: Env,
  agentId: number,
  input: { state: RuntimeState; error?: string | null },
) {
  const db = getDb(env);
  await db.update(agenterRecords).set({
    runtimeState: input.state,
    runtimeError: input.error ?? null,
    runtimeUpdatedAt: nowIso(),
  }).where(eq(agenterRecords.id, agentId));
}

export async function setChainState(
  env: Env,
  agentId: number,
  input: { state: ChainState },
) {
  const db = getDb(env);
  await db.update(agenterRecords).set({
    chainState: input.state,
    chainStateUpdatedAt: nowIso(),
  }).where(eq(agenterRecords.id, agentId));
}

export function deriveRuntimeState(record: {
  sandboxProvider?: string | null;
  sandboxId?: string | null;
  gatewayUrl?: string | null;
  agosAgentId?: string | null;
  gooCoreStatus?: string | null;
  runtimeState?: string | null;
  runtimeError?: string | null;
}): RuntimeState {
  if (record.runtimeError) return 'error';
  if (record.gooCoreStatus === 'running') return 'running';
  if (record.gooCoreStatus === 'paused') return 'paused';
  // Preserve explicit 'running'/'paused' set by activate/provision flows
  // when gooCoreStatus hasn't been updated yet (e.g. AGOS/BYOD agents)
  if (record.runtimeState === 'running') return 'running';
  if (record.runtimeState === 'paused') return 'paused';
  if (record.runtimeState === 'stopped') return 'stopped';
  if (record.sandboxProvider === 'byod') {
    return record.gatewayUrl ? 'ready' : 'config_required';
  }
  if (record.sandboxProvider === 'agos') {
    return record.agosAgentId ? 'ready' : 'none';
  }
  if (record.sandboxId) return 'ready';
  return 'none';
}

export function deriveLaunchState(record: {
  launchState?: string | null;
  launchError?: string | null;
  tokenAddress?: string | null;
  contractAddress?: string | null;
  status?: string | null;
  sandboxId?: string | null;
  gatewayUrl?: string | null;
  agosAgentId?: string | null;
  sandboxProvider?: string | null;
  launchSession?: string | null;
}): LaunchState {
  if (record.launchError) return 'failed';
  const session = parseLaunchSession(record.launchSession);
  if (record.tokenAddress || record.contractAddress) return 'launched';
  if (session?.progress?.liquidity_tx_hash) return 'liquidity_submitted';
  if (session?.progress?.token_address || session?.progress?.deploy_tx_hash) return 'deployed';
  if (session?.prepared) return 'prepared';
  if (record.status === 'pending') return 'draft';
  return (record.launchState as LaunchState) || 'not_started';
}

export function deriveChainState(record: {
  chainState?: string | null;
  status?: string | null;
}): ChainState {
  if (record.chainState && record.chainState !== 'unknown') return record.chainState as ChainState;
  const status = (record.status || '').toLowerCase();
  if (status === 'active') return 'active';
  if (status === 'starving') return 'starving';
  if (status === 'dying') return 'dying';
  if (status === 'dead') return 'dead';
  return 'unknown';
}

export async function backfillWorkflowState(env: Env, agent: typeof agenterRecords.$inferSelect) {
  const nextLaunch = deriveLaunchState(agent);
  const nextRuntime = deriveRuntimeState(agent);
  const nextChain = deriveChainState(agent);
  const needsLaunch = !agent.launchState || agent.launchState === 'not_started' || agent.launchState !== nextLaunch;
  const needsRuntime = !agent.runtimeState || agent.runtimeState === 'none' || agent.runtimeState !== nextRuntime;
  const needsChain = !agent.chainState || agent.chainState === 'unknown' || agent.chainState !== nextChain;
  if (!needsLaunch && !needsRuntime && !needsChain) return;
  const db = getDb(env);
  await db.update(agenterRecords).set({
    ...(needsLaunch ? { launchState: nextLaunch, launchUpdatedAt: nowIso() } : {}),
    ...(needsRuntime ? { runtimeState: nextRuntime, runtimeUpdatedAt: nowIso() } : {}),
    ...(needsChain ? { chainState: nextChain, chainStateUpdatedAt: nowIso() } : {}),
  }).where(eq(agenterRecords.id, agent.id));
}
