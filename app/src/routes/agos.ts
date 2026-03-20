import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords, transactionLogs } from '../db/schema';
import { authRequired } from '../auth/middleware';
import { decryptPrivateKey, encryptPrivateKey, generateRuntimeToken } from '../crypto';
import { emitAgentEvent } from '../event-bus';
import type { AgosAgent, AgosClient, AgosFundSettleResult } from '../agos-client';
import { setRuntimeState } from '../agent-state-updates';
import {
  agosClientFromToken,
  assembleSettlePayload,
  createAgosClient,
  dryRunFundingPayment,
  getAgentBalance,
  getUserBalance,
  restoreAgosSession,
  settleFunding,
  startFundingChallenge,
  topupAgent,
  type Eip3009SettleTemplate,
} from '../finance/agos';
import { getEffectiveAgosMinInitialFund, isAgosConfigured } from '../agos-config';
import { isAgosSupported } from '../providers';
import {
  AGOS_DEFAULT_RESOURCE_CLASS,
  AGOS_RESOURCE_CLASSES,
  isValidResourceClass,
} from '../agos-constants';
import { buildProvisionScript, checkProvisionHealth, checkEndpointHealth } from '../agos-provision';
import type { AgentStreamEvent, ExecutionPhase } from '../types';
import { agosTestRoutes } from './agos-test';
import { agosRemoteRoutes } from './agos-remote';

type AppEnv = { Bindings: Env; Variables: HonoVariables };
type AppContext = Context<AppEnv>;
type DbClient = ReturnType<typeof getDb>;
type AgentRecord = InferSelectModel<typeof agenterRecords>;
type LinkedAgosAgentRecord = AgentRecord & {
  agosAgentId: string;
  agosAccessToken: string;
  agosRefreshToken: string | null;
};

interface OwnedAgentContext {
  userId: number;
  db: DbClient;
  agentRecord: AgentRecord;
}

interface LinkedAgosAgentContext extends OwnedAgentContext {
  agentRecord: LinkedAgosAgentRecord;
  client: AgosClient;
}

interface ChatCompletionResult {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

type ChatHistoryMessage = { role: string; content: string };

const AGOS_UNAVAILABLE_MESSAGE = 'AGOS integration is not available. Ensure AGOS_API_URL and AGOS_IMAGE are configured.';
const AGOS_TOKEN_HEADER = 'x-agos-token';
function getAgosChainId(env: Env): number {
  return parseInt(env.AGOS_CHAIN_ID || '56');
}

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  if (!isAgosConfigured(c.env) || !isAgosSupported(c.env)) {
    return c.json({ error: AGOS_UNAVAILABLE_MESSAGE }, 503);
  }

  await next();
});

function isResponse(value: Response | unknown): value is Response {
  return value instanceof Response;
}

function jsonError(c: AppContext, message: string, status: 400 | 401 | 403 | 404 | 409 | 503) {
  return c.json({ error: message }, status);
}

function jsonAgosError(c: AppContext, error: unknown, prefix?: string) {
  const message = error instanceof Error ? error.message : 'Unknown AGOS error';
  return c.json({ error: prefix ? `${prefix}: ${message}` : message }, 502);
}

function requireHeader(c: AppContext, name: string): string | Response {
  const value = c.req.header(name);
  if (!value) {
    return jsonError(c, `${name} header required`, 401);
  }

  return value;
}

function getServerBaseUrl(c: AppContext): string {
  return c.env.PUBLIC_API_URL || new URL(c.req.url).origin;
}

async function emitAgentSystemEvent(
  env: Env,
  agenterId: string,
  displayText: string,
  phase: ExecutionPhase,
  messageType: AgentStreamEvent['message_type'] = 'system',
) {
  await emitAgentEvent(env, agenterId, {
    task_id: '',
    agent_id: agenterId,
    timestamp: new Date().toISOString(),
    display_text: displayText,
    phase,
    message_type: messageType,
  });
}

async function loadOwnedAgentById(c: AppContext, agenterId: string): Promise<OwnedAgentContext | Response> {
  const userId = c.get('auth').user_id;
  const db = getDb(c.env);
  const agentRecord = await db
    .select()
    .from(agenterRecords)
    .where(eq(agenterRecords.agenterId, agenterId))
    .get();

  if (!agentRecord) {
    return jsonError(c, 'Agent not found', 404);
  }
  if (agentRecord.userId !== userId) {
    return jsonError(c, 'Not your agent', 403);
  }

  return { userId, db, agentRecord };
}

async function loadOwnedAgent(c: AppContext): Promise<OwnedAgentContext | Response> {
  const agenterId = c.req.param('agenterId');
  if (!agenterId) {
    return jsonError(c, 'Agent not found', 404);
  }

  return loadOwnedAgentById(c, agenterId);
}

async function loadLinkedAgosAgent(c: AppContext): Promise<LinkedAgosAgentContext | Response> {
  const ownedAgent = await loadOwnedAgent(c);
  if (isResponse(ownedAgent)) {
    return ownedAgent;
  }

  const { agentRecord } = ownedAgent;
  if (!agentRecord.agosAgentId || !agentRecord.agosAccessToken) {
    return jsonError(c, 'Agent not linked to AGOS', 400);
  }

  let session;
  try {
    session = await restoreAgosSession(
      agentRecord.agosAccessToken,
      agentRecord.agosRefreshToken,
      c.env.AGOS_API_URL,
      c.env.JWT_SECRET,
    );
  } catch (sessionErr) {
    const msg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
    console.error(`[agos] Session restore failed for ${agentRecord.agenterId}:`, msg);
    return c.json({
      error: `AGOS session restore failed: ${msg}`,
      code: 'AGOS_SESSION_ERROR',
    }, 502);
  }

  // Persist refreshed access token so subsequent requests don't use a stale one
  if (session.refreshedAccessToken) {
    const encrypted = await encryptPrivateKey(session.refreshedAccessToken, c.env.JWT_SECRET);
    await ownedAgent.db
      .update(agenterRecords)
      .set({ agosAccessToken: encrypted })
      .where(eq(agenterRecords.agenterId, agentRecord.agenterId));
  }

  return {
    ...ownedAgent,
    agentRecord: agentRecord as LinkedAgosAgentRecord,
    client: session.client,
  };
}

async function withTokenAgosClient(
  c: AppContext,
  handler: (client: AgosClient) => Promise<Response>,
  errorPrefix?: string,
) {
  const agosToken = requireHeader(c, AGOS_TOKEN_HEADER);
  if (isResponse(agosToken)) {
    return agosToken;
  }

  try {
    return await handler(agosClientFromToken(agosToken, c.env.AGOS_API_URL));
  } catch (error) {
    return jsonAgosError(c, error, errorPrefix);
  }
}

async function withLinkedAgosAgent(
  c: AppContext,
  handler: (ctx: LinkedAgosAgentContext) => Promise<Response>,
  errorPrefix?: string,
) {
  const linkedAgent = await loadLinkedAgosAgent(c);
  if (isResponse(linkedAgent)) {
    return linkedAgent;
  }

  try {
    return await handler(linkedAgent);
  } catch (error) {
    // Detect AGOS token expiry and provide actionable message.
    // Use 403 (not 401) to avoid triggering the frontend's auto-logout on 401.
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('401') || msg.includes('Unauthorized') || (msg.includes('token') && msg.includes('expired'))) {
      return c.json({
        error: 'AGOS session expired. Please re-authenticate by creating a new AGOS deployment or re-linking.',
        code: 'AGOS_TOKEN_EXPIRED',
      }, 403);
    }
    return jsonAgosError(c, error, errorPrefix);
  }
}

async function buildAgosRuntimeEnv(
  agentRecord: Pick<AgentRecord, 'agenterId' | 'tokenAddress' | 'encryptedPrivateKey' | 'agentName'>,
  serverBaseUrl: string,
  env: Env,
): Promise<Record<string, string>> {
  if (!env.AGOS_IMAGE) {
    throw new Error('AGOS_IMAGE is not configured');
  }
  if (!agentRecord.encryptedPrivateKey) {
    throw new Error('Agent wallet key is not available');
  }

  const privateKey = await decryptPrivateKey(agentRecord.encryptedPrivateKey, env.JWT_SECRET);
  const runtimeToken = await generateRuntimeToken(agentRecord.agenterId, env.JWT_SECRET);
  const serverUrl = serverBaseUrl.replace(/\/+$/, '');

  return {
    GOO_SERVER_URL: serverUrl,
    AGENT_ID: agentRecord.agenterId,
    AGENT_NAME: agentRecord.agentName || '',
    AGENT_RUNTIME_TOKEN: runtimeToken,
    AGOS_API_BASE_URL: env.AGOS_API_URL.replace(/\/+$/, ''),
    CHAIN_ID: String(env.CHAIN_ID),
    RPC_URL: env.RPC_URL,
    TOKEN_ADDRESS: agentRecord.tokenAddress || '',
    WALLET_PRIVATE_KEY: privateKey,
    OPENCLAW_GATEWAY_TOKEN: await generateRuntimeToken(`${agentRecord.agenterId}:gateway`, env.JWT_SECRET),
    // LLM calls go through goo-server proxy which injects the AGOS apiKey from DB.
    // This solves the chicken-and-egg: apiKey is only available after createAgent returns,
    // but envVars must be set at createAgent call time.
    OPENAI_BASE_URL: `${serverUrl}/api/llm-proxy/${agentRecord.agenterId}`,
    OPENAI_API_KEY: runtimeToken,
    LLM_MODEL: env.LLM_MODEL,
    ROUTER_ADDRESS: env.ROUTER_ADDRESS,
    REGISTRY_ADDRESS: env.REGISTRY_ADDRESS,
    CONTROL_PORT: '19790',
  };
}

async function syncLinkedAgentState(
  db: DbClient,
  agentRecord: LinkedAgosAgentRecord,
  agosAgent: AgosAgent & { aiouBalance?: unknown },
) {
  const updates: Partial<Pick<AgentRecord, 'agosDeploymentId' | 'gatewayUrl' | 'status'>> = {};

  if (agosAgent.deployment?.id && agosAgent.deployment.id !== agentRecord.agosDeploymentId) {
    updates.agosDeploymentId = agosAgent.deployment.id;
  }
  // Only set gatewayUrl from AGOS endpoint if we don't already have a direct VPS gateway URL
  // (auto-provision sets ws://IP:port which works; AGOS proxy URL often doesn't)
  if (agosAgent.endpoint && !agentRecord.gatewayUrl) {
    updates.gatewayUrl = agosAgent.endpoint;
  }
  if (agosAgent.status && agosAgent.status !== agentRecord.status) {
    updates.status = agosAgent.status;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(agenterRecords).set(updates).where(eq(agenterRecords.agenterId, agentRecord.agenterId));
  }
}

async function recordFundingSettlement(
  c: AppContext,
  ctx: LinkedAgosAgentContext,
  settleResult: AgosFundSettleResult,
  mode: 'direct' | 'eip3009',
) {
  const isEip3009 = mode === 'eip3009';
  const memoPrefix = isEip3009 ? 'AGOS EIP-3009 fund' : 'AGOS funded';
  const displaySuffix = isEip3009 ? ' via EIP-3009' : '';

  await ctx.db.insert(transactionLogs).values({
    agenterId: ctx.agentRecord.agenterId,
    userId: ctx.userId,
    txHash: settleResult.txHash,
    method: isEip3009 ? 'agosFundSettleEip3009' : 'agosFundSettle',
    memo: `${memoPrefix} ${settleResult.amount} AIOU (deploy: ${settleResult.deployTriggered})`,
    status: settleResult.status,
  });

  await emitAgentSystemEvent(
    c.env,
    ctx.agentRecord.agenterId,
    `Funded ${settleResult.amount} AIOU${displaySuffix}${settleResult.deployTriggered ? ' -- deployment triggered' : ''}`,
    'preparing',
  );
}

function buildSystemPrompt(agentRecord: Pick<AgentRecord, 'agentName' | 'genesisPrompt' | 'agentIntro'>): string {
  const systemParts: string[] = [];
  if (agentRecord.agentName) systemParts.push(`You are ${agentRecord.agentName}, an autonomous Goo Agent.`);
  if (agentRecord.genesisPrompt) systemParts.push(agentRecord.genesisPrompt);
  if (agentRecord.agentIntro) systemParts.push(`About you: ${agentRecord.agentIntro}`);
  if (systemParts.length === 0) systemParts.push('You are an autonomous Goo Agent.');
  return systemParts.join('\n\n');
}

function normalizeChatHistory(history: ChatHistoryMessage[] | undefined): ChatHistoryMessage[] {
  return (history || [])
    .filter((message) => (
      (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string'
    ))
    .slice(-20);
}

function forwardLegacyRoute(fromPath: string, toPath: string) {
  return async (c: AppContext) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(fromPath, toPath);
    return app.fetch(new Request(url.toString(), c.req.raw), c.env, c.executionCtx);
  };
}

app.post('/auth/challenge', async (c) => {
  const { address, chainId } = await c.req.json();
  if (!address) {
    return jsonError(c, 'address is required', 400);
  }

  try {
    const challenge = await createAgosClient(c.env.AGOS_API_URL).getChallenge(
      address,
      chainId || getAgosChainId(c.env),
    );
    return c.json({ ok: true, data: challenge });
  } catch (error) {
    return jsonAgosError(c, error, 'AGOS challenge failed');
  }
});

app.post('/auth/verify', async (c) => {
  const { message, signature } = await c.req.json();
  if (!message || !signature) {
    return jsonError(c, 'message and signature required', 400);
  }

  try {
    const tokens = await createAgosClient(c.env.AGOS_API_URL).verify(message, signature);
    return c.json({ ok: true, data: tokens });
  } catch (error) {
    return jsonAgosError(c, error, 'AGOS verify failed');
  }
});

app.post('/auth/refresh', async (c) => {
  const { refreshToken } = await c.req.json();
  if (!refreshToken) {
    return jsonError(c, 'refreshToken required', 400);
  }

  try {
    const result = await createAgosClient(c.env.AGOS_API_URL).refresh(refreshToken);
    return c.json({ ok: true, data: result });
  } catch (error) {
    return jsonAgosError(c, error, 'AGOS refresh failed');
  }
});

app.get('/config', async (c) => {
  try {
    const agentConfig = await createAgosClient(c.env.AGOS_API_URL).getAgentConfig();
    return c.json({
      ok: true,
      data: {
        ...agentConfig,
        effectiveMinInitialFundAiou: String(getEffectiveAgosMinInitialFund(c.env)),
      },
    });
  } catch (error) {
    return jsonAgosError(c, error, 'AGOS config failed');
  }
});

app.get('/resource-classes', (c) => c.json({
  ok: true,
  data: {
    resourceClasses: AGOS_RESOURCE_CLASSES,
    default: AGOS_DEFAULT_RESOURCE_CLASS,
  },
}));

app.post('/agents', authRequired, async (c) => {
  const {
    agenter_id,
    name,
    resourceClass,
    agos_access_token: explicitToken,
    agos_refresh_token: explicitRefresh,
  } = await c.req.json();

  if (!agenter_id || !name) {
    return jsonError(c, 'agenter_id and name are required', 400);
  }
  if (resourceClass && !isValidResourceClass(resourceClass)) {
    return jsonError(
      c,
      `Invalid resourceClass "${resourceClass}". Use GET /resource-classes for valid options.`,
      400,
    );
  }

  const ownedAgent = await loadOwnedAgentById(c, agenter_id);
  if (isResponse(ownedAgent)) {
    return ownedAgent;
  }
  if (!ownedAgent.agentRecord.tokenAddress) {
    return jsonError(
      c,
      'Agent has no token address. Complete the launch flow (prepare → deploy → confirm) before creating an AGOS deployment.',
      409,
    );
  }
  if (!ownedAgent.agentRecord.encryptedPrivateKey || !ownedAgent.agentRecord.agentWallet) {
    return jsonError(
      c,
      'Agent wallet is not available. Re-run launch prepare/confirm before creating an AGOS deployment.',
      409,
    );
  }
  if (ownedAgent.agentRecord.agosAgentId) {
    return c.json({
      error: 'Agent already linked to AGOS',
      agos_agent_id: ownedAgent.agentRecord.agosAgentId,
    }, 409);
  }

  try {
    await setRuntimeState(c.env, ownedAgent.agentRecord.id, { state: 'provisioning', error: null });

    // --- SIWE auth: use explicit token if provided, otherwise sign with agent wallet ---
    let agosAccessToken: string;
    let agosRefreshToken: string | null = null;
    if (explicitToken) {
      agosAccessToken = explicitToken;
      agosRefreshToken = explicitRefresh || null;
    } else {
      const { ethers } = await import('ethers');
      const agentPk = await decryptPrivateKey(ownedAgent.agentRecord.encryptedPrivateKey, c.env.JWT_SECRET);
      const agentSigner = new ethers.Wallet(agentPk);
      const agosClient = createAgosClient(c.env.AGOS_API_URL);
      const chainId = getAgosChainId(c.env);
      const { message } = await agosClient.getChallenge(agentSigner.address, chainId);
      const signature = await agentSigner.signMessage(message);
      const tokens = await agosClient.verify(message, signature);
      agosAccessToken = tokens.accessToken;
      agosRefreshToken = tokens.refreshToken || null;
    }

    const client = agosClientFromToken(agosAccessToken, c.env.AGOS_API_URL);
    const runtimeEnv = await buildAgosRuntimeEnv(ownedAgent.agentRecord, getServerBaseUrl(c), c.env);
    const result = await client.createAgent({
      name,
      image: c.env.AGOS_IMAGE,
      resourceClass: resourceClass || AGOS_DEFAULT_RESOURCE_CLASS,
      envVars: runtimeEnv,
    });

    // apiKey is only returned once by AGOS — validate before persisting
    if (!result.apiKey) {
      throw new Error('AGOS createAgent succeeded but returned no apiKey — cannot proceed');
    }

    // Persist apiKey immediately — retry DB write on failure since apiKey is irrecoverable
    const encryptedApiKey = await encryptPrivateKey(result.apiKey, c.env.JWT_SECRET);
    const dbPayload = {
      agosAgentId: result.agent.id,
      agosApiKey: encryptedApiKey,
      agosAccessToken: await encryptPrivateKey(agosAccessToken, c.env.JWT_SECRET),
      agosRefreshToken: agosRefreshToken
        ? await encryptPrivateKey(agosRefreshToken, c.env.JWT_SECRET)
        : null,
      agosDeploymentId: result.agent.deployment?.id || null,
      status: result.agent.status,
      launchMode: 'agos' as const,
      sandboxProvider: 'agos' as const,
      llmProvider: 'agos',
      providerBundle: 'agos',
      gatewayToken: await encryptPrivateKey(runtimeEnv.OPENCLAW_GATEWAY_TOKEN, c.env.JWT_SECRET),
    };

    // Retry DB write up to 3 times — losing the apiKey is unrecoverable
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await ownedAgent.db.update(agenterRecords).set(dbPayload)
          .where(eq(agenterRecords.agenterId, agenter_id));
        break;
      } catch (dbErr) {
        if (attempt === 3) {
          // Last resort: log the encrypted key so it can be manually recovered
          console.error(
            `CRITICAL: Failed to persist AGOS apiKey for ${agenter_id} after 3 attempts. `
            + `agosAgentId=${result.agent.id} encryptedApiKey=${encryptedApiKey}`,
          );
          throw new Error(`AGOS agent created (${result.agent.id}) but failed to save apiKey to DB: ${(dbErr as Error).message}`);
        }
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }

    await ownedAgent.db.insert(transactionLogs).values({
      agenterId: agenter_id,
      userId: ownedAgent.userId,
      txHash: `agos-create-${result.agent.id}`,
      method: 'agosCreateAgent',
      memo: `AGOS agent created: ${result.agent.id} (${result.agent.name})`,
      status: 'confirmed',
    }).catch(() => { /* non-critical — apiKey already saved */ });

    await setRuntimeState(c.env, ownedAgent.agentRecord.id, { state: 'ready', error: null });
    await emitAgentSystemEvent(
      c.env,
      agenter_id,
      `AGOS agent created: ${result.agent.name}`,
      'preparing',
    );

    return c.json({
      ok: true,
      data: {
        agos_agent_id: result.agent.id,
        agos_wallet: result.agent.walletAddress,
        agos_status: result.agent.status,
        min_initial_fund: getEffectiveAgosMinInitialFund(c.env),
        platform_min_initial_fund: result.minInitialFund,
        setup_fee: result.setupFee,
        image: c.env.AGOS_IMAGE,
      },
    }, 201);
  } catch (error) {
    await setRuntimeState(c.env, ownedAgent.agentRecord.id, {
      state: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonAgosError(c, error, 'AGOS create failed');
  }
});

app.get('/agents', async (c) => withTokenAgosClient(c, async (client) => {
  const agents = await client.listAgents();
  return c.json({ ok: true, data: agents });
}));

app.get('/agents/:agenterId/status', authRequired, async (c) => {
  const ownedAgent = await loadOwnedAgent(c);
  if (isResponse(ownedAgent)) return ownedAgent;

  const { agentRecord } = ownedAgent;

  // Manual deploy: has agosAgentId but no agosAccessToken — return DB-only status
  if (agentRecord.agosAgentId && !agentRecord.agosAccessToken) {
    // Extract IP from ws://IP:port URLs; HTTPS endpoint URLs won't have an extractable IP
    const gwMatch = agentRecord.gatewayUrl?.match(/\/\/([\d.]+)/);
    return c.json({
      ok: true,
      data: {
        agos_agent_id: agentRecord.agosAgentId,
        agos_status: agentRecord.status || 'active',
        agos_endpoint: agentRecord.gatewayUrl || null,
        deployment: {
          status: 'running',
          publicIp: gwMatch?.[1] || null,
        },
        aiou_balance: null,
        manual_deploy: true,
      },
    });
  }

  return withLinkedAgosAgent(c, async (ctx) => {
    try {
      const [agosAgent, agentBalance] = await Promise.all([
        ctx.client.getAgent(ctx.agentRecord.agosAgentId),
        ctx.client.getAgentBalance(ctx.agentRecord.agosAgentId).catch(() => null),
      ]);
      await syncLinkedAgentState(ctx.db, ctx.agentRecord, agosAgent);

      return c.json({
        ok: true,
        data: {
          agos_agent_id: agosAgent.id,
          agos_status: agosAgent.status,
          agos_endpoint: agosAgent.endpoint,
          deployment: agosAgent.deployment,
          aiou_balance: agentBalance || agosAgent.aiouBalance || null,
        },
      });
    } catch (error) {
      await setRuntimeState(c.env, ctx.agentRecord.id, {
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonAgosError(c, error, 'AGOS status failed');
    }
  });
});

app.post('/agents/:agenterId/activate', authRequired, async (c) => withLinkedAgosAgent(c, async (ctx) => {
  const statusResult = await ctx.client.setAgentStatus(ctx.agentRecord.agosAgentId, 'active');

  await ctx.db.update(agenterRecords).set({ status: statusResult.status }).where(eq(agenterRecords.agenterId, ctx.agentRecord.agenterId));
  await setRuntimeState(c.env, ctx.agentRecord.id, { state: 'running', error: null });
  await emitAgentSystemEvent(
    c.env,
    ctx.agentRecord.agenterId,
    `AGOS agent activated (${statusResult.status})`,
    'preparing',
  );

  return c.json({ ok: true, data: statusResult });
}));

app.post('/agents/:agenterId/stop', authRequired, async (c) => withLinkedAgosAgent(c, async (ctx) => {
  const statusResult = await ctx.client.setAgentStatus(ctx.agentRecord.agosAgentId, 'stopped');

  await ctx.db.update(agenterRecords).set({ status: statusResult.status }).where(eq(agenterRecords.agenterId, ctx.agentRecord.agenterId));
  await setRuntimeState(c.env, ctx.agentRecord.id, { state: 'stopped', error: null });
  await emitAgentSystemEvent(c.env, ctx.agentRecord.agenterId, 'AGOS agent stopped', 'finalizing');

  return c.json({ ok: true, data: statusResult });
}));

app.post('/agents/:agenterId/delete', authRequired, async (c) => withLinkedAgosAgent(c, async (ctx) => {
  try {
    await ctx.client.setAgentStatus(ctx.agentRecord.agosAgentId, 'deleted');

    await ctx.db.update(agenterRecords).set({
      agosAgentId: null,
      agosApiKey: null,
      agosAccessToken: null,
      agosRefreshToken: null,
      agosDeploymentId: null,
      status: 'stopped',
    }).where(eq(agenterRecords.agenterId, ctx.agentRecord.agenterId));
    await setRuntimeState(c.env, ctx.agentRecord.id, { state: 'none', error: null });

    await emitAgentSystemEvent(c.env, ctx.agentRecord.agenterId, 'AGOS agent deleted', 'finalizing');

    return c.json({ ok: true, data: { deleted: true } });
  } catch (error) {
    await setRuntimeState(c.env, ctx.agentRecord.id, {
      state: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonAgosError(c, error, 'AGOS delete failed');
  }
}));

app.post('/agents/:agenterId/redeploy', authRequired, async (c) => withLinkedAgosAgent(c, async (ctx) => {
  try {
    const redeployResult = await ctx.client.redeployAgent(ctx.agentRecord.agosAgentId);
    await ctx.db.update(agenterRecords).set({ status: redeployResult.status }).where(eq(agenterRecords.agenterId, ctx.agentRecord.agenterId));
    await setRuntimeState(c.env, ctx.agentRecord.id, { state: 'provisioning', error: null });
    return c.json({ ok: true, data: redeployResult });
  } catch (error) {
    await setRuntimeState(c.env, ctx.agentRecord.id, {
      state: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonAgosError(c, error, 'AGOS redeploy failed');
  }
}));

app.post('/agents/:agenterId/fund', authRequired, async (c) => {
  const { amount } = await c.req.json();
  if (!amount) {
    return jsonError(c, 'amount required', 400);
  }

  return withLinkedAgosAgent(c, async (ctx) => {
    const fundResult = await startFundingChallenge(ctx.client, ctx.agentRecord.agosAgentId, amount);
    if (fundResult.needsPayment) {
      return c.json(fundResult.challenge, 402);
    }

    return c.json({ ok: true, data: fundResult });
  });
});

app.post('/agents/:agenterId/fund/settle', authRequired, async (c) => {
  const { payload } = await c.req.json();
  if (!payload) {
    return jsonError(c, 'payload required', 400);
  }

  return withLinkedAgosAgent(c, async (ctx) => {
    const settleResult = await settleFunding(ctx.client, ctx.agentRecord.agosAgentId, payload);
    await recordFundingSettlement(c, ctx, settleResult, 'direct');
    return c.json({ ok: true, data: settleResult });
  });
});

app.post('/agents/:agenterId/fund/prepare-transfer', authRequired, async (c) => {
  const { amount, payer_address, token_name, domain_version, validity_seconds } = await c.req.json();
  if (!amount || !payer_address) {
    return jsonError(c, 'amount and payer_address required', 400);
  }

  return withLinkedAgosAgent(c, async (ctx) => {
    const dryRun = await dryRunFundingPayment(
      ctx.client,
      ctx.agentRecord.agosAgentId,
      amount,
      payer_address,
      {
        tokenName: token_name,
        domainVersion: domain_version,
        validitySeconds: validity_seconds,
      },
    );

    if (!dryRun) {
      return c.json({ ok: true, data: { needsPayment: false } });
    }

    return c.json({
      ok: true,
      data: {
        needsPayment: true,
        typedData: dryRun.prepared.typedData,
        settleTemplate: dryRun.prepared.settleTemplate,
        summary: dryRun.summary,
      },
    });
  });
});

app.post(
  '/agents/:agenterId/fund/prepare',
  authRequired,
  forwardLegacyRoute('/fund/prepare', '/fund/prepare-transfer'),
);

app.post('/agents/:agenterId/fund/settle-transfer', authRequired, async (c) => {
  const { signature, settle_template } = await c.req.json() as {
    signature?: string;
    settle_template?: Eip3009SettleTemplate;
  };

  if (!signature) {
    return jsonError(c, 'signature required', 400);
  }
  if (!settle_template?.payload?.authorization) {
    return jsonError(
      c,
      'settle_template with payload.authorization required (from prepare-transfer response)',
      400,
    );
  }

  return withLinkedAgosAgent(c, async (ctx) => {
    const payload = assembleSettlePayload(settle_template, signature);
    const settleResult = await settleFunding(ctx.client, ctx.agentRecord.agosAgentId, payload);
    await recordFundingSettlement(c, ctx, settleResult, 'eip3009');
    return c.json({ ok: true, data: settleResult });
  });
});

app.post(
  '/agents/:agenterId/fund/settle-eip3009',
  authRequired,
  forwardLegacyRoute('/fund/settle-eip3009', '/fund/settle-transfer'),
);

app.post('/agents/:agenterId/fund/auto', authRequired, async (c) => {
  const { target_aiou } = await c.req.json().catch(() => ({ target_aiou: undefined })) as { target_aiou?: string };

  return withLinkedAgosAgent(c, async (ctx) => {
    if (!ctx.agentRecord.encryptedPrivateKey) {
      return jsonError(c, 'Agent wallet key not available', 400);
    }

    const { swapBnbToAiou, signAndSettleEip3009 } = await import('../finance/agos-auto-fund');
    const agentPk = await decryptPrivateKey(ctx.agentRecord.encryptedPrivateKey, c.env.JWT_SECRET);
    const fundAmount = target_aiou || String(getEffectiveAgosMinInitialFund(c.env));

    // 1. Swap BNB → USDT → AIOU on BSC Mainnet
    let swapResult;
    try {
      swapResult = await swapBnbToAiou({
        agentPrivateKey: agentPk,
        targetAiou: fundAmount,
      });
    } catch (swapErr) {
      const msg = swapErr instanceof Error ? swapErr.message : String(swapErr);
      console.error(`[fund/auto] swap failed for ${ctx.agentRecord.agenterId}:`, msg);
      return c.json({ ok: false, error: `Swap failed: ${msg}`, steps: [] }, 400);
    }

    if (!swapResult.success) {
      return c.json({ ok: false, error: swapResult.error, steps: swapResult.steps }, 400);
    }

    // 2. Start AGOS funding challenge
    let challengeResult;
    try {
      challengeResult = await startFundingChallenge(ctx.client, ctx.agentRecord.agosAgentId, swapResult.funded_amount || fundAmount);
    } catch (challengeErr) {
      const msg = challengeErr instanceof Error ? challengeErr.message : String(challengeErr);
      console.error(`[fund/auto] AGOS funding challenge failed for ${ctx.agentRecord.agenterId}:`, msg);
      return c.json({ ok: false, error: `AGOS funding challenge failed: ${msg}`, steps: swapResult.steps }, 502);
    }
    if (!challengeResult.needsPayment) {
      return c.json({ ok: true, data: { steps: [...swapResult.steps, 'No AGOS payment needed — already funded.'], funded_amount: swapResult.funded_amount } });
    }

    // 3. Sign EIP-3009 with agent wallet and settle
    let settleResult;
    let debugSettlePayload: unknown = null;
    try {
      const { settlePayload } = await signAndSettleEip3009(agentPk, challengeResult.challenge);
      debugSettlePayload = settlePayload;
      settleResult = await settleFunding(ctx.client, ctx.agentRecord.agosAgentId, settlePayload);
    } catch (settleErr) {
      const msg = settleErr instanceof Error ? settleErr.message : String(settleErr);
      console.error(`[fund/auto] AGOS settle failed for ${ctx.agentRecord.agenterId}:`, msg);
      return c.json({
        ok: false,
        error: `AGOS settle failed: ${msg}`,
        steps: swapResult.steps,
        debug: { challenge: challengeResult.challenge, settlePayload: debugSettlePayload },
      }, 502);
    }

    await recordFundingSettlement(c, ctx, settleResult, 'eip3009');

    // Auto-provision: if deployment was triggered, start the pipeline in background
    if (settleResult.deployTriggered) {
      const { runAutoProvisionPipeline } = await import('../agos-auto-provision');
      c.executionCtx.waitUntil(
        runAutoProvisionPipeline(c.env, {
          agentRecordId: ctx.agentRecord.id,
          agenterId: ctx.agentRecord.agenterId,
          agosAgentId: ctx.agentRecord.agosAgentId,
          encryptedAccessToken: ctx.agentRecord.agosAccessToken!,
          encryptedRefreshToken: ctx.agentRecord.agosRefreshToken || null,
          encryptedPrivateKey: ctx.agentRecord.encryptedPrivateKey!,
          encryptedApiKey: ctx.agentRecord.agosApiKey || null,
          agentName: ctx.agentRecord.agentName || '',
          tokenAddress: ctx.agentRecord.tokenAddress || '',
          serverBaseUrl: getServerBaseUrl(c),
          userId: ctx.userId,
          llmModel: ctx.agentRecord.llmModel || null,
        }),
      );
    }

    return c.json({
      ok: true,
      data: {
        steps: [...swapResult.steps, `Funded ${settleResult.amount} AIOU to AGOS`],
        funded_amount: settleResult.amount,
        deploy_triggered: settleResult.deployTriggered,
      },
    });
  }, 'Auto-fund failed');
});

// Debug: dry-run settle to get curl command for direct AGOS testing
app.post('/agents/:agenterId/fund/auto-debug', authRequired, async (c) => {
  const { target_aiou } = await c.req.json().catch(() => ({ target_aiou: undefined })) as { target_aiou?: string };

  return withLinkedAgosAgent(c, async (ctx) => {
    if (!ctx.agentRecord.encryptedPrivateKey) {
      return jsonError(c, 'Agent wallet key not available', 400);
    }

    const { signAndSettleEip3009 } = await import('../finance/agos-auto-fund');
    const agentPk = await decryptPrivateKey(ctx.agentRecord.encryptedPrivateKey, c.env.JWT_SECRET);
    const fundAmount = target_aiou || String(getEffectiveAgosMinInitialFund(c.env));

    // Get challenge
    const challengeResult = await startFundingChallenge(ctx.client, ctx.agentRecord.agosAgentId, fundAmount);
    if (!challengeResult.needsPayment) {
      return c.json({ ok: true, data: { message: 'No payment needed' } });
    }

    // Sign
    const { settlePayload } = await signAndSettleEip3009(agentPk, challengeResult.challenge);
    const payloadJson = JSON.stringify(settlePayload);
    const b64 = btoa(payloadJson);
    const agosUrl = `${c.env.AGOS_API_URL}/agents/${ctx.agentRecord.agosAgentId}/fund/settle`;
    const agosToken = (ctx.client as any).accessToken;

    return c.json({
      ok: true,
      data: {
        challenge: challengeResult.challenge,
        settlePayload,
        agosUrl,
        curl_header: `curl -X POST '${agosUrl}' -H 'Content-Type: application/json' -H 'Authorization: Bearer ${agosToken}' -H 'X-PAYMENT: ${b64}'`,
        curl_body: `curl -X POST '${agosUrl}' -H 'Content-Type: application/json' -H 'Authorization: Bearer ${agosToken}' -d '${payloadJson}'`,
        curl_both: `curl -X POST '${agosUrl}' -H 'Content-Type: application/json' -H 'Authorization: Bearer ${agosToken}' -H 'X-PAYMENT: ${b64}' -d '{"payload":${payloadJson}}'`,
      },
    });
  }, 'Debug failed');
});

app.get('/wallets/balance', async (c) => withTokenAgosClient(c, async (client) => {
  const balance = await getUserBalance(client);
  return c.json({ ok: true, data: balance });
}));

app.get('/agents/:agenterId/balance', authRequired, async (c) => withLinkedAgosAgent(c, async (ctx) => {
  const balance = await getAgentBalance(ctx.client, ctx.agentRecord.agosAgentId);
  return c.json({ ok: true, data: balance });
}));

app.post('/agents/:agenterId/topup', authRequired, async (c) => {
  const { amount } = await c.req.json();
  if (!amount) {
    return jsonError(c, 'amount required', 400);
  }

  return withLinkedAgosAgent(c, async (ctx) => {
    const topupResult = await topupAgent(
      ctx.client,
      ctx.agentRecord.agosAgentId,
      ctx.agentRecord.agenterId,
      amount,
    );
    return c.json({ ok: true, data: topupResult });
  });
});

app.get('/models', async (c) => {
  try {
    const models = await createAgosClient(c.env.AGOS_API_URL).listModels();
    return c.json({ ok: true, data: models.data });
  } catch (error) {
    return jsonAgosError(c, error);
  }
});

app.post('/agents/:agenterId/chat', authRequired, async (c) => {
  const { message, history, model, max_tokens, temperature } = await c.req.json() as {
    message?: string;
    history?: ChatHistoryMessage[];
    model?: string;
    max_tokens?: number;
    temperature?: number;
  };

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return jsonError(c, 'message is required', 400);
  }

  const ownedAgent = await loadOwnedAgent(c);
  if (isResponse(ownedAgent)) {
    return ownedAgent;
  }
  if (!ownedAgent.agentRecord.agosApiKey) {
    return jsonError(c, 'Agent has no AGOS API key. Create via POST /api/agos/agents first.', 400);
  }

  await emitAgentSystemEvent(
    c.env,
    ownedAgent.agentRecord.agenterId,
    'Processing via AGOS LLM...',
    'planning',
    'reasoning',
  );

  try {
    const apiKey = await decryptPrivateKey(ownedAgent.agentRecord.agosApiKey, c.env.JWT_SECRET);
    const result = await createAgosClient(c.env.AGOS_API_URL).chatCompletion(apiKey, {
      model: model || c.env.LLM_MODEL || 'deepseek-chat',
      messages: [
        { role: 'system', content: buildSystemPrompt(ownedAgent.agentRecord) },
        ...normalizeChatHistory(history),
        { role: 'user', content: message.trim() },
      ],
      stream: false,
      max_tokens: max_tokens || 1024,
      temperature: temperature || 0.7,
    }) as ChatCompletionResult;

    const reply = result.choices?.[0]?.message?.content || '(no response)';

    await ownedAgent.db.update(agenterRecords).set({
      llmCallsCount: (ownedAgent.agentRecord.llmCallsCount || 0) + 1,
    }).where(eq(agenterRecords.id, ownedAgent.agentRecord.id));

    await emitAgentSystemEvent(
      c.env,
      ownedAgent.agentRecord.agenterId,
      reply.slice(0, 120),
      'finalizing',
      'result',
    );

    return c.json({
      reply,
      model: result.model || model || c.env.LLM_MODEL,
      via: 'agos',
      usage: result.usage || null,
    });
  } catch (error) {
    return jsonAgosError(c, error, 'AGOS LLM failed');
  }
});

// ---------------------------------------------------------------------------
// VPS auto-provisioning — deploy Docker image on blank AGOS VPS
// ---------------------------------------------------------------------------

app.post('/agents/:agenterId/provision', authRequired, async (c) => withLinkedAgosAgent(c, async (ctx) => {
  const { gateway_port } = await c.req.json().catch(() => ({} as Record<string, string>));

  try {
    // 1. Get deployment info from AGOS
    const agosAgent = await ctx.client.getAgent(ctx.agentRecord.agosAgentId);
    const publicIp = agosAgent.deployment?.publicIp;
    const defaultPassword = agosAgent.deployment?.defaultPassword;

    if (!publicIp) {
      return jsonError(c, 'Deployment has no public IP yet. Wait for AGOS deployment to be running.', 400);
    }

    // 2. Build runtime env vars
    const runtimeEnv = await buildAgosRuntimeEnv(ctx.agentRecord, getServerBaseUrl(c), c.env);

    // Inject AGOS agent API key for LLM access
    if (ctx.agentRecord.agosApiKey) {
      const apiKey = await decryptPrivateKey(ctx.agentRecord.agosApiKey, c.env.JWT_SECRET);
      runtimeEnv.AGOS_AGENT_API_KEY = apiKey;
    }

    const dockerImage = c.env.AGOS_IMAGE;
    const gwPort = gateway_port || '18789';

    // 3. Build provision script
    const provision = buildProvisionScript({
      publicIp,
      password: defaultPassword || '',
      dockerImage,
      envVars: runtimeEnv,
      gatewayPort: gwPort,
      agosEndpoint: agosAgent.endpoint || undefined,
    });

    // 4. Update DB with gateway URL (key NOT cleared here — SSH hasn't executed yet)
    const gatewayUrl = provision.gatewayUrl;
    await ctx.db.update(agenterRecords).set({
      gatewayUrl,
      gatewayToken: await encryptPrivateKey(runtimeEnv.OPENCLAW_GATEWAY_TOKEN, c.env.JWT_SECRET),
      status: 'active',
    }).where(eq(agenterRecords.agenterId, ctx.agentRecord.agenterId));

    await ctx.db.insert(transactionLogs).values({
      agenterId: ctx.agentRecord.agenterId,
      userId: ctx.userId,
      txHash: `provision-${Date.now()}`,
      method: 'agosProvision',
      memo: `VPS provision script generated for ${publicIp}`,
      status: 'confirmed',
    });

    // 5. Auto-provision via Durable Object if password is available
    if (defaultPassword) {
      await emitAgentSystemEvent(
        c.env,
        ctx.agentRecord.agenterId,
        `Auto-provisioning VPS ${publicIp}...`,
        'preparing',
      );

      // Dispatch to AgentProvisioner DO
      const doId = c.env.AGENT_PROVISIONER.idFromName(ctx.agentRecord.agenterId);
      const stub = c.env.AGENT_PROVISIONER.get(doId);
      await stub.fetch(new Request('http://do/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agenterId: ctx.agentRecord.agenterId,
          host: publicIp,
          password: defaultPassword,
          script: provision.script,
          gatewayPort: gwPort,
        }),
      }));

      return c.json({
        ok: true,
        data: {
          mode: 'auto' as const,
          script: provision.script,
          ssh_command: provision.sshCommand,
          gateway_url: gatewayUrl,
          gateway_port: gwPort,
          healthcheck_url: provision.healthcheckUrl,
          public_ip: publicIp,
          has_password: true,
          docker_image: dockerImage,
          runtime_token: runtimeEnv.AGENT_RUNTIME_TOKEN,
        },
      });
    }

    // Manual mode — no password available
    await emitAgentSystemEvent(
      c.env,
      ctx.agentRecord.agenterId,
      `VPS provision script ready for ${publicIp}`,
      'preparing',
    );

    return c.json({
      ok: true,
      data: {
        mode: 'manual' as const,
        script: provision.script,
        ssh_command: provision.sshCommand,
        gateway_url: gatewayUrl,
        gateway_port: gwPort,
        healthcheck_url: provision.healthcheckUrl,
        public_ip: publicIp,
        has_password: false,
        docker_image: dockerImage,
        runtime_token: runtimeEnv.AGENT_RUNTIME_TOKEN,
      },
    });
  } catch (error) {
    return jsonAgosError(c, error, 'Provision failed');
  }
}));

app.get('/agents/:agenterId/provision/health', authRequired, async (c) => withLinkedAgosAgent(c, async (ctx) => {
  // Check if control-server is responding on the VPS
  const agosAgent = await ctx.client.getAgent(ctx.agentRecord.agosAgentId);
  const publicIp = agosAgent.deployment?.publicIp;

  if (!publicIp) {
    return c.json({ ok: false, error: 'No public IP' });
  }

  // If gatewayUrl is an HTTPS endpoint, use checkEndpointHealth directly
  if (ctx.agentRecord.gatewayUrl?.startsWith('https://')) {
    const health = await checkEndpointHealth(ctx.agentRecord.gatewayUrl);
    return c.json({ ok: health.ok, error: health.error || null, public_ip: publicIp });
  }

  // Extract port from stored gateway URL or use default
  let port = '18789';
  if (ctx.agentRecord.gatewayUrl) {
    const portMatch = ctx.agentRecord.gatewayUrl.match(/:(\d+)$/);
    if (portMatch) port = portMatch[1];
  }

  // Decrypt gateway token for authenticated health check
  let gatewayToken: string | undefined;
  if (ctx.agentRecord.gatewayToken) {
    try {
      gatewayToken = await decryptPrivateKey(ctx.agentRecord.gatewayToken, c.env.JWT_SECRET);
    } catch { /* use unauthenticated check */ }
  }

  const health = await checkProvisionHealth(publicIp, port, 5000, gatewayToken);
  return c.json({ ok: health.ok, error: health.error || null, public_ip: publicIp });
}));

// ---------------------------------------------------------------------------
// Manual VPS deploy (bypass AGOS API) — admin/dev tool
// ---------------------------------------------------------------------------

app.post('/agents/:agenterId/manual-deploy', async (c) => {
  // Dev tool: skip JWT auth, use admin wallet check
  const agenterId = c.req.param('agenterId')!;
  const db = getDb(c.env);
  const agentRecord = await db.select().from(agenterRecords)
    .where(eq(agenterRecords.agenterId, agenterId)).get();
  if (!agentRecord) return jsonError(c, 'Agent not found', 404);
  const ownedAgent = { db, agentRecord, userId: agentRecord.userId };

  const { public_ip, agos_llm_api_key, gateway_port } = await c.req.json();
  if (!public_ip) return jsonError(c, 'public_ip is required', 400);

  const agent = ownedAgent.agentRecord;
  const runtimeEnv = await buildAgosRuntimeEnv(agent, getServerBaseUrl(c), c.env);

  // Override LLM config if AGOS API key provided
  if (agos_llm_api_key) {
    runtimeEnv.AGOS_AGENT_API_KEY = agos_llm_api_key;
  }

  const gwPort = gateway_port || '18789';
  const gatewayUrl = `ws://${public_ip}:${gwPort}`;

  // Update DB to simulate AGOS deployment
  await ownedAgent.db.update(agenterRecords).set({
    agosAgentId: `manual-${Date.now()}`,
    gatewayUrl,
    gatewayToken: await encryptPrivateKey(runtimeEnv.OPENCLAW_GATEWAY_TOKEN, c.env.JWT_SECRET),
    status: 'active',
  }).where(eq(agenterRecords.id, agent.id));

  // Build docker run env flags
  const envFlags = Object.entries(runtimeEnv)
    .map(([k, v]) => `  -e ${k}=${JSON.stringify(v)}`)
    .join(' \\\n');

  const dockerImage = c.env.AGOS_IMAGE || 'hgamiui9/goo-agos:v0.1.1';

  const script = `#!/bin/bash
set -e

echo "=== Goo Agent Manual VPS Setup ==="
echo "Agent: ${agent.agenterId}"
echo "VPS: ${public_ip}"

# 1. Install Docker if not present
if ! command -v docker &>/dev/null; then
  echo "[setup] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "[setup] Docker already installed"
fi

# 2. Pull image
echo "[setup] Pulling ${dockerImage}..."
docker pull ${dockerImage}

# 3. Stop existing container if any
docker rm -f goo-agent 2>/dev/null || true

# 4. Run container
echo "[setup] Starting container on port ${gwPort}..."
docker run -d \\
  --name goo-agent \\
  --restart unless-stopped \\
  --network host \\
${envFlags} \\
  -e GATEWAY_PORT=${gwPort} \\
  ${dockerImage}

echo ""
echo "=== Setup complete ==="
echo "Container: $(docker ps --filter name=goo-agent --format '{{.ID}} {{.Status}}')"
echo "Gateway: ${gatewayUrl}"
echo ""
echo "Useful commands:"
echo "  docker logs -f goo-agent"
echo "  curl http://localhost:${gwPort}/control/healthz"
echo "  curl -H 'Authorization: Bearer ${runtimeEnv.AGENT_RUNTIME_TOKEN}' http://localhost:${gwPort}/control/status"
`;

  return c.json({
    ok: true,
    data: {
      script,
      public_ip,
      gateway_url: gatewayUrl,
      runtime_token: runtimeEnv.AGENT_RUNTIME_TOKEN,
      gateway_token: runtimeEnv.OPENCLAW_GATEWAY_TOKEN,
      docker_image: dockerImage,
      env_vars: runtimeEnv,
    },
  });
});

// Mount test routes
app.route('/', agosTestRoutes);

// Mount remote management routes
app.route('/', agosRemoteRoutes);

export { app as agosRoutes };
