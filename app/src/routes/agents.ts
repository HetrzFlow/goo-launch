import { Hono } from 'hono';
import { ethers } from 'ethers';
import { eq, desc, and, or, count, sql } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import type { Database } from '../db';
import { getDb } from '../db';
import { agenterRecords } from '../db/schema';
import { authRequired } from '../auth/middleware';
import { verifyToken } from '../auth/jwt';
import { encryptPrivateKey, decryptPrivateKey, verifyRuntimeToken } from '../crypto';
import { emitAgentEvent, persistAgentEvent } from '../event-bus';
import {
  hasPrivateAgentAccess,
  isAgentCreator,
  isAgentOwner,
  resolveAndSyncOwner,
} from '../agent-access';
import {
  isManagedSandboxProvider,
  resolveLlmProvider,
  resolveProviderBundle,
  resolveSandboxProvider,
} from '../providers';
import { childLogger } from '../logger';
import { makeProvider, STATUS_NAMES, TOKEN_READ_ABI } from './agents-chain';
import { parseLaunchSession } from '../launch-session';
import { backfillWorkflowState, deriveChainState, deriveLaunchState, deriveRuntimeState } from '../agent-state-updates';
import { agentsChainRoutes } from './agents-chain';
import { agentsDebugRoutes } from './agents-debug';
import { agentsChatRoutes } from './agents-chat';
import { agentsErc8004Routes } from './agents-erc8004';

const log = childLogger({ module: 'routes/agents' });

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/** Look up an agent by numeric DB id or agenterId string. */
export async function findAgentByParam(db: Database, param: string) {
  const numId = parseInt(param);
  if (!isNaN(numId) && String(numId) === param) {
    return db.select().from(agenterRecords).where(eq(agenterRecords.id, numId)).get();
  }
  return db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, param)).get();
}

function getProviderFields(
  agent: {
    sandboxProvider?: string | null;
    llmProvider?: string | null;
    providerBundle?: string | null;
    launchMode?: string | null;
    agosAgentId?: string | null;
  },
  env: Env,
) {
  const sandboxProvider = resolveSandboxProvider(agent);
  const llmProvider = resolveLlmProvider(agent, env);
  const providerBundle = resolveProviderBundle(agent, env);
  return { sandboxProvider, llmProvider, providerBundle };
}

const app = new Hono<AppEnv>();

/** GET / — List agents with optional status filter, mine filter, and pagination. */
app.get('/', authRequired, async (c) => {
  const db = getDb(c.env);
  const status = c.req.query('status');
  const mine = c.req.query('mine') === 'true';
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const auth = c.get('auth');

  // Build conditions
  const conditions = [];
  if (status) conditions.push(eq(agenterRecords.status, status));
  if (mine && auth) {
    const wallet = auth.wallet_address;
    const orConditions = [eq(agenterRecords.userId, auth.user_id)];
    if (wallet) {
      orConditions.push(sql`lower(${agenterRecords.ownerAddress}) = ${wallet.toLowerCase()}`);
    }
    conditions.push(or(...orConditions)!);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [agents, totalResult] = await Promise.all([
    db.select().from(agenterRecords)
      .where(whereClause)
      .orderBy(desc(agenterRecords.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(agenterRecords).where(whereClause).get(),
  ]);

  const total = totalResult?.count || 0;

  const enriched = agents.map(a => ({
    ...a,
    owner_address: a.ownerAddress,
    runtime_running: a.gooCoreStatus === 'running' || a.runtimeState === 'running',
    goo_core_status: a.gooCoreStatus || 'unknown',
    ...getProviderFields(a, c.env),
  }));

  return c.json({ agents: enriched, total, limit, offset });
});

/** GET /:id — Get agent detail by numeric ID or agenterId string. */
app.get('/:id', authRequired, async (c) => {
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);

  await backfillWorkflowState(c.env, agent);
  const hydratedAgent = (await findAgentByParam(db, c.req.param('id'))) || agent;

  const auth = c.get('auth');
  const isCreator = isAgentCreator(hydratedAgent, auth);
  const canViewPrivate = await hasPrivateAgentAccess(hydratedAgent, auth, c.env);

  // Lazy-sync on-chain owner
  const ownerAddr = canViewPrivate
    ? await resolveAndSyncOwner(hydratedAgent, c.env, db)
    : (resolveAndSyncOwner(hydratedAgent, c.env, db).catch(() => {}), hydratedAgent.ownerAddress);

  const ownerFlag = await isAgentOwner(hydratedAgent, auth, c.env);

  log.debug({ agenterId: hydratedAgent.agenterId, userId: hydratedAgent.userId, authUserId: auth?.user_id, isCreator, isOwner: ownerFlag, canViewPrivate }, 'Agent detail access');

  // Derive runtime_running / runtime_paused for frontend display
  const runtimeRunning = hydratedAgent.gooCoreStatus === 'running' || hydratedAgent.runtimeState === 'running';
  const runtimePaused = hydratedAgent.gooCoreStatus === 'paused' || hydratedAgent.runtimeState === 'paused';

  if (!canViewPrivate) {
    const providers = getProviderFields(hydratedAgent, c.env);
    return c.json({
      id: hydratedAgent.id,
      agenterId: hydratedAgent.agenterId,
      agentName: hydratedAgent.agentName,
      agentIntro: hydratedAgent.agentIntro,
      tokenSymbol: hydratedAgent.tokenSymbol,
      tokenAddress: hydratedAgent.tokenAddress,
      agentWallet: hydratedAgent.agentWallet,
      contractAddress: hydratedAgent.contractAddress,
      status: hydratedAgent.status,
      createdAt: hydratedAgent.createdAt,
      runtime_running: runtimeRunning,
      runtime_paused: runtimePaused,
      sandboxId: null,
      sandboxUrl: null,
      gatewayUrl: null,
      gatewayToken: null,
      gooCoreStatus: null,
      launchMode: hydratedAgent.launchMode,
      sandboxProvider: providers.sandboxProvider,
      llmProvider: providers.llmProvider,
      providerBundle: providers.providerBundle,
      framework: hydratedAgent.agentFramework,
      llmCallsCount: hydratedAgent.llmCallsCount,
      lastPulseAt: hydratedAgent.lastPulseAt,
      genesisPrompt: null,
      agentInstructions: null,
      skillsContent: null,
      memoryContent: null,
      goo_core_status: null,
      launchState: hydratedAgent.launchState,
      launchError: hydratedAgent.launchError,
      launchUpdatedAt: hydratedAgent.launchUpdatedAt,
      runtimeState: hydratedAgent.runtimeState,
      runtimeError: hydratedAgent.runtimeError,
      runtimeUpdatedAt: hydratedAgent.runtimeUpdatedAt,
      chainState: hydratedAgent.chainState,
      chainStateUpdatedAt: hydratedAgent.chainStateUpdatedAt,
      owner_address: ownerAddr || hydratedAgent.ownerAddress,
      is_owner: false,
      is_creator: false,
      can_view_private: false,
      debug_controls_enabled: c.env.ENABLE_AGENT_DEBUG_CONTROLS === 'true',
      paymentTokenAddress: c.env.X402_PAYMENT_TOKEN || null,
    });
  }

  const providers = getProviderFields(hydratedAgent, c.env);

  // Decrypt gatewayToken so the frontend gets the raw token (DB stores encrypted form)
  let decryptedGatewayToken: string | null = null;
  if (hydratedAgent.gatewayToken) {
    try {
      decryptedGatewayToken = await decryptPrivateKey(hydratedAgent.gatewayToken, c.env.JWT_SECRET);
    } catch { /* leave null if decryption fails */ }
  }

  return c.json({
    ...hydratedAgent,
    runtime_running: runtimeRunning,
    runtime_paused: runtimePaused,
    framework: hydratedAgent.agentFramework,
    sandboxProvider: providers.sandboxProvider,
    llmProvider: providers.llmProvider,
    providerBundle: providers.providerBundle,
    goo_core_status: hydratedAgent.gooCoreStatus || 'unknown',
    owner_address: ownerAddr || hydratedAgent.ownerAddress,
    is_owner: ownerFlag,
    is_creator: isCreator,
    can_view_private: true,
    debug_controls_enabled: c.env.ENABLE_AGENT_DEBUG_CONTROLS === 'true',
    paymentTokenAddress: c.env.X402_PAYMENT_TOKEN || null,
    gatewayToken: decryptedGatewayToken,
  });
});

app.get('/:id/state', authRequired, async (c) => {
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  await backfillWorkflowState(c.env, agent);
  const hydratedAgent = (await findAgentByParam(db, c.req.param('id'))) || agent;
  if (!(await hasPrivateAgentAccess(hydratedAgent, c.get('auth'), c.env))) {
    return c.json({ error: 'Not your agent' }, 403);
  }

  const session = parseLaunchSession(hydratedAgent.launchSession);
  const resumable = ['prepared', 'deploy_submitted', 'deployed', 'liquidity_submitted', 'failed'].includes(hydratedAgent.launchState || '');

  const sandboxProvider = resolveSandboxProvider(hydratedAgent);
  let byodGatewayReachable: boolean | null = null;
  if (sandboxProvider === 'byod' && hydratedAgent.gatewayUrl) {
    try {
      const healthRes = await fetch(`${hydratedAgent.gatewayUrl}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      byodGatewayReachable = healthRes.ok;
    } catch {
      byodGatewayReachable = false;
    }
  }
  const actions: Array<{ key: string; label: string; kind: 'primary' | 'secondary'; enabled: boolean; href?: string | null; reason?: string | null }> = [];
  if (resumable) {
    actions.push({
      key: 'resume_launch',
      label: 'Continue Launch',
      kind: 'primary',
      enabled: true,
      href: `/launch.html?agent=${encodeURIComponent(hydratedAgent.agenterId)}`,
      reason: hydratedAgent.launchError || null,
    });
  } else if (hydratedAgent.launchState !== 'launched') {
    actions.push({
      key: 'launch_incomplete',
      label: 'Launch Not Ready',
      kind: 'secondary',
      enabled: false,
      reason: hydratedAgent.launchState === 'not_started'
        ? 'Start launch before provisioning runtime.'
        : `Current launch state: ${hydratedAgent.launchState}`,
    });
  }
  if (!resumable && hydratedAgent.launchState === 'launched') {
    if (sandboxProvider === 'e2b') {
      actions.push({
        key: 'create_sandbox',
        label: 'Create Sandbox',
        kind: 'primary',
        enabled: !hydratedAgent.sandboxId,
        reason: hydratedAgent.sandboxId ? 'Sandbox already exists.' : null,
      });
    }
    if (sandboxProvider === 'agos' && !hydratedAgent.agosAgentId) {
      actions.push({
        key: 'create_agos',
        label: 'Create AGOS Deployment',
        kind: 'primary',
        enabled: true,
        reason: null,
      });
    }
    if (sandboxProvider === 'byod') {
      actions.push({
        key: 'configure_byod',
        label: hydratedAgent.gatewayUrl ? 'Open BYOD Controls' : 'Configure BYOD Gateway',
        kind: 'secondary',
        enabled: true,
        reason: hydratedAgent.gatewayUrl
          ? byodGatewayReachable === false
            ? 'Gateway configured but currently unreachable. Open controls to re-apply config or update the endpoint.'
            : 'Gateway configured. Use controls to push updates or restart.'
          : 'Gateway URL/token still need local BYOD control settings.',
      });
      if (hydratedAgent.gatewayUrl) {
        actions.push({
          key: 'check_byod_gateway',
          label: 'Check BYOD Gateway',
          kind: 'secondary',
          enabled: true,
          reason: byodGatewayReachable === null
            ? 'Gateway health has not been checked yet.'
            : byodGatewayReachable
              ? 'Gateway responded to health check.'
              : 'Gateway health check failed. Verify the endpoint or runtime token.',
        });
      }
    }
  }
  if (hydratedAgent.runtimeState === 'stopped') {
    actions.push({ key: 'restart_runtime', label: 'Restart Runtime', kind: 'secondary', enabled: true, reason: null });
  }
  if (hydratedAgent.runtimeState === 'error' && sandboxProvider !== 'agos') {
    actions.push({
      key: 'recover_runtime',
      label: 'Recover Runtime',
      kind: 'secondary',
      enabled: true,
      reason: sandboxProvider === 'byod' && byodGatewayReachable === false
        ? 'BYOD gateway is unreachable. Fix gateway/config first, then retry recovery.'
        : hydratedAgent.runtimeError || 'Runtime entered an error state.',
    });
  }

  return c.json({
    agent_id: hydratedAgent.agenterId,
    launch: {
      state: hydratedAgent.launchState,
      error: hydratedAgent.launchError,
      updated_at: hydratedAgent.launchUpdatedAt,
    },
    runtime: {
      provider: sandboxProvider,
      state: hydratedAgent.runtimeState,
      error: hydratedAgent.runtimeError,
      updated_at: hydratedAgent.runtimeUpdatedAt,
      byod_gateway_reachable: sandboxProvider === 'byod' ? byodGatewayReachable : null,
    },
    chain: {
      state: hydratedAgent.chainState,
      updated_at: hydratedAgent.chainStateUpdatedAt,
    },
    session: {
      resumable,
      has_prepared: !!session?.prepared,
      has_token_address: !!session?.progress?.token_address,
      has_deploy_tx: !!session?.progress?.deploy_tx_hash,
      server_draft: session?.draftPayload || null,
      server_progress: session?.progress || null,
      server_error: session?.lastError || null,
      updated_at: session?.updatedAt || null,
    },
    actions,
  });
});

/** PATCH /:id — Update agent owner files. */
app.patch('/:id', authRequired, async (c) => {
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  if (!(await isAgentOwner(agent, c.get('auth'), c.env))) {
    return c.json({ error: 'Not your agent' }, 403);
  }

  const { genesisPrompt, agentInstructions, skillsContent, memoryContent } = await c.req.json<{
    genesisPrompt?: string;
    agentInstructions?: string;
    skillsContent?: string;
    memoryContent?: string;
  }>();

  const data: Record<string, string> = {};
  if (genesisPrompt !== undefined) data.genesisPrompt = genesisPrompt;
  if (agentInstructions !== undefined) data.agentInstructions = agentInstructions;
  if (skillsContent !== undefined) data.skillsContent = skillsContent;
  if (memoryContent !== undefined) data.memoryContent = memoryContent;

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  await db.update(agenterRecords).set(data).where(eq(agenterRecords.id, agent.id));

  return c.json({ message: 'agent updated', id: agent.id });
});

/** GET /:id/runtime-status — Unified runtime status for Cloud and BYOD agents. */
app.get('/:id/runtime-status', authRequired, async (c) => {
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  if (!(await hasPrivateAgentAccess(agent, c.get('auth'), c.env))) {
    return c.json({ error: 'Not your agent' }, 403);
  }

  const result = {
    mode: agent.launchMode,
    sandbox_provider: resolveSandboxProvider(agent),
    llm_provider: resolveLlmProvider(agent, c.env),
    goo_core_status: agent.gooCoreStatus || 'unknown',
    sandbox: {
      id: agent.sandboxId || null,
      url: agent.sandboxUrl || null,
    },
    gateway: {
      url: agent.gatewayUrl || null,
      reachable: false,
      token_configured: !!agent.gatewayToken,
    },
    goo_core: {
      status: agent.gooCoreStatus || 'unknown',
    },
  };

  if (agent.gatewayUrl) {
    try {
      const healthRes = await fetch(`${agent.gatewayUrl}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      result.gateway.reachable = healthRes.ok;
    } catch { /* unreachable */ }
  }

  return c.json(result);
});

/** POST /:id/register-gateway — BYOD users register their OpenClaw gateway. */
app.post('/:id/register-gateway', authRequired, async (c) => {
  const { gateway_url, gateway_token } = await c.req.json<{
    gateway_url?: string;
    gateway_token?: string;
  }>();
  if (!gateway_url || !gateway_token) {
    return c.json({ error: 'gateway_url and gateway_token are required' }, 400);
  }

  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  if (!(await isAgentOwner(agent, c.get('auth'), c.env))) {
    return c.json({ error: 'Not your agent' }, 403);
  }

  const cleanUrl = gateway_url.replace(/\/+$/, '');

  // Verify connectivity via health check
  try {
    const healthRes = await fetch(`${cleanUrl}/healthz`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!healthRes.ok) {
      return c.json({ error: `Gateway health check failed: HTTP ${healthRes.status}` }, 502);
    }
  } catch (err) {
    return c.json({ error: `Cannot reach gateway: ${(err as Error).message}` }, 502);
  }

  // Verify token works
  try {
    const modelsRes = await fetch(`${cleanUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${gateway_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (modelsRes.status === 401 || modelsRes.status === 403) {
      return c.json({ error: 'Gateway token is invalid (auth failed)' }, 400);
    }
  } catch {
    // Non-fatal
  }

  const encryptedToken = await encryptPrivateKey(gateway_token, c.env.JWT_SECRET);
  await db.update(agenterRecords)
    .set({ gatewayUrl: cleanUrl, gatewayToken: encryptedToken })
    .where(eq(agenterRecords.id, agent.id));

  return c.json({ message: 'Gateway registered', gateway_url: cleanUrl, verified: true });
});

/** POST /:id/report-gateway — Agent self-reports its tunnel URL. Runtime token auth. */
app.post('/:id/report-gateway', async (c) => {
  const agenterId = c.req.param('id');
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : c.req.query('token') || '';

  if (!token || !(await verifyRuntimeToken(agenterId, token, c.env.JWT_SECRET))) {
    return c.json({ error: 'Invalid runtime token' }, 401);
  }

  const { gateway_url } = await c.req.json<{ gateway_url?: string }>();
  if (!gateway_url || typeof gateway_url !== 'string') {
    return c.json({ error: 'gateway_url is required' }, 400);
  }

  const db = getDb(c.env);
  const agent = await db.select().from(agenterRecords)
    .where(eq(agenterRecords.agenterId, agenterId)).get();
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const cleanUrl = gateway_url.replace(/\/+$/, '');
  await db.update(agenterRecords)
    .set({ gatewayUrl: cleanUrl })
    .where(eq(agenterRecords.id, agent.id));

  log.info({ agenterId, gateway_url: cleanUrl }, 'Agent self-reported gateway URL');
  return c.json({ ok: true, gateway_url: cleanUrl });
});

/** GET /:id/export-key — Export agent wallet private key. Owner only. */
app.get('/:id/export-key', authRequired, async (c) => {
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  if (!(await isAgentOwner(agent, c.get('auth'), c.env))) {
    return c.json({ error: 'Not your agent' }, 403);
  }
  if (!agent.encryptedPrivateKey) {
    return c.json({ error: 'No private key stored for this agent.' }, 404);
  }
  const privateKey = await decryptPrivateKey(agent.encryptedPrivateKey, c.env.JWT_SECRET);
  return c.json({ privateKey });
});

/** POST /:id/decommission — Permanently stop and archive an agent. Owner only. */
app.post('/:id/decommission', authRequired, async (c) => {
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  if (!(await isAgentOwner(agent, c.get('auth'), c.env))) {
    return c.json({ error: 'Not your agent' }, 403);
  }
  if (agent.status === 'decommissioned') {
    return c.json({ error: 'Agent is already decommissioned' }, 409);
  }

  // Destroy sandbox for sandbox agents (best-effort)
  let sandboxDestroyed = false;
  if (agent.sandboxId && isManagedSandboxProvider(resolveSandboxProvider(agent))) {
    try {
      const { destroySandboxForAgent } = await import('./sandbox');
      sandboxDestroyed = await destroySandboxForAgent(c.env, agent.agenterId);
    } catch { /* best-effort */ }
  }

  // Stop AGOS agent (best-effort)
  let agosAgentStopped = false;
  if (agent.agosAgentId && agent.agosAccessToken) {
    try {
      const { restoreAgosSession } = await import('../finance/agos');
      const session = await restoreAgosSession(
        agent.agosAccessToken,
        agent.agosRefreshToken,
        c.env.AGOS_API_URL,
        c.env.JWT_SECRET,
      );
      await session.client.setAgentStatus(agent.agosAgentId, 'stopped');
      agosAgentStopped = true;
    } catch { /* best-effort */ }
  }

  // Read final on-chain state (best-effort)
  let finalState: Record<string, unknown> = {};
  if (agent.tokenAddress) {
    try {
      const provider = makeProvider(c.env);
      const token = new ethers.Contract(agent.tokenAddress, TOKEN_READ_ABI, provider);
      const [statusRaw, treasuryBalance, totalSupply] = await Promise.all([
        token.getAgentStatus() as Promise<bigint>,
        token.treasuryBalance() as Promise<bigint>,
        token.totalSupply() as Promise<bigint>,
      ]);
      finalState = {
        chainStatus: STATUS_NAMES[Number(statusRaw)] || 'UNKNOWN',
        treasuryBalance: treasuryBalance.toString(),
        totalSupply: totalSupply.toString(),
      };
    } catch {
      finalState = { chainStatus: 'unreadable' };
    }
  }

  await db.update(agenterRecords)
    .set({ status: 'decommissioned', gooCoreStatus: 'stopped' })
    .where(eq(agenterRecords.id, agent.id));

  await persistAgentEvent(c.env, {
    agenterId: agent.agenterId,
    eventType: 'decommissioned',
    severity: 'info',
    message: 'Agent decommissioned by owner',
    metadata: finalState,
  });

  return c.json({ message: 'Agent decommissioned', finalState, sandboxDestroyed, agosAgentStopped });
});

/** GET /:id/runtime-config — HMAC token auth, no JWT. Unified config endpoint for BYOD + AGOS containers. */
app.get('/:id/runtime-config', async (c) => {
  const agenterId = c.req.param('id');
  const token = c.req.query('token');

  if (!token || !(await verifyRuntimeToken(agenterId, token, c.env.JWT_SECRET))) {
    return c.json({ error: 'Invalid or missing runtime token' }, 401);
  }

  try {
    const db = getDb(c.env);
    const agent = await db.select().from(agenterRecords)
      .where(eq(agenterRecords.agenterId, agenterId)).get();

    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    return c.json({
      agent_name: agent.agentName || agenterId.slice(0, 8),
      agent_intro: agent.agentIntro || '',
      genesis_prompt: agent.genesisPrompt || '',
      agent_instructions: agent.agentInstructions || '',
      skills_content: agent.skillsContent || '',
      memory_content: agent.memoryContent || '',
      framework: agent.agentFramework || 'openclaw',
      token_address: agent.tokenAddress || '',
      sandbox_provider: resolveSandboxProvider(agent),
      llm_provider: resolveLlmProvider(agent, c.env),
      llm_api_url: `${(c.env.PUBLIC_API_URL || new URL(c.req.url).origin).replace(/\/+$/, '')}/api/llm-proxy/${agenterId}`,
      llm_model: agent.llmModel || c.env.LLM_MODEL,
      agos_agent_api_key: agent.agosApiKey ? await decryptPrivateKey(agent.agosApiKey, c.env.JWT_SECRET) : '',
    });
  } catch (err) {
    log.error({ err }, 'runtime-config error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Legacy aliases
app.get('/:id/byod-config', (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace('/byod-config', '/runtime-config');
  return app.fetch(new Request(url.toString(), c.req.raw), c.env, c.executionCtx);
});
app.get('/:id/agos-runtime-config', (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace('/agos-runtime-config', '/runtime-config');
  return app.fetch(new Request(url.toString(), c.req.raw), c.env, c.executionCtx);
});

/** GET /:id/ws — WebSocket upgrade, forward to Durable Object. */
app.get('/:id/ws', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'token required' }, 401);

  let tokenPayload;
  try {
    tokenPayload = await verifyToken(token, c.env.JWT_SECRET);
  } catch {
    return c.json({ error: 'invalid token' }, 401);
  }

  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  if (!(await hasPrivateAgentAccess(agent, tokenPayload, c.env))) {
    return c.json({ error: 'not your agent' }, 403);
  }

  // Forward to Durable Object
  const doId = c.env.AGENT_EVENT_HUB.idFromName(agent.agenterId);
  const stub = c.env.AGENT_EVENT_HUB.get(doId);
  return stub.fetch(new Request('http://do/ws', {
    headers: c.req.raw.headers,
  }));
});

// Mount sub-routes
app.route('/', agentsChainRoutes);
app.route('/', agentsDebugRoutes);
app.route('/', agentsChatRoutes);
app.route('/', agentsErc8004Routes);

export { app as agentRoutes };
