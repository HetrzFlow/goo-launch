import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords, transactionLogs, chatMessages } from '../db/schema';
import { authRequired } from '../auth/middleware';
import { decryptPrivateKey, encryptPrivateKey } from '../crypto';
import { emitAgentEvent } from '../event-bus';
import { hasPrivateAgentAccess, isAgentCreator } from '../agent-access';
import { childLogger } from '../logger';
import { setRuntimeState } from '../agent-state-updates';

const log = childLogger({ module: 'routes/sandbox' });

type AppEnv = { Bindings: Env; Variables: HonoVariables };
const app = new Hono<AppEnv>();

// E2B sandbox runs as root
const AGENT_DATA_DIR = '/root/agent-data';

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Helper: forward to sandbox manager ──────────────────

async function forwardToManager(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  incomingHeaders?: Record<string, string | undefined>,
): Promise<{ status: number; data: unknown; responseHeaders: Record<string, string> }> {
  const managerBase = (env.SANDBOX_MANAGER_URL || '').replace(/\/+$/, '');
  const url = `${managerBase}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const paymentValue = incomingHeaders?.['payment-signature'] || incomingHeaders?.['x-payment'];
  if (paymentValue) {
    headers['payment-signature'] = paymentValue;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'payment-required' || lower === 'payment-response' || lower === 'payment-signature' || lower === 'x-payment' || lower.startsWith('x-payment-')) {
      responseHeaders[key] = value;
    }
  });

  return { status: res.status, data, responseHeaders };
}

// ─── Helper: sync files to sandbox ──────────────────────

type AgenterLike = {
  agenterId: string;
  sandboxId: string | null;
  agentName: string | null;
  agentIntro: string | null;
  genesisPrompt: string | null;
  agentInstructions: string | null;
  agentFramework: string | null;
  skillsContent: string | null;
  memoryContent: string | null;
};

async function syncFilesToSandbox(env: Env, agenter: AgenterLike): Promise<string[]> {
  if (!agenter.sandboxId) return [];

  try {
    await forwardToManager(env, 'POST', `/api/v1/sandboxes/${agenter.agenterId}/exec`, {
      command: `mkdir -p ${AGENT_DATA_DIR}`,
    });
  } catch (err) {
    log.error({ err }, 'Failed to create directories');
    return [];
  }

  const synced: string[] = [];

  const writeFile = async (path: string, content: string, label: string): Promise<boolean> => {
    try {
      const b64 = btoa(content);
      const { status } = await forwardToManager(env, 'POST', `/api/v1/sandboxes/${agenter.agenterId}/exec`, {
        command: `echo '${b64}' | base64 -d > ${path}`,
        timeoutMs: 10000,
      });
      if (status >= 400) {
        log.error({ label, status }, 'Failed to write file');
        return false;
      }
      synced.push(label);
      return true;
    } catch (err) {
      log.error({ label, err }, 'Error writing file');
      return false;
    }
  };

  const rawFiles: [string, string | null][] = [
    ['soul.md', agenter.genesisPrompt],
    ['agent.md', agenter.agentInstructions || agenter.agentIntro],
    ['skills.md', agenter.skillsContent],
    ['memory.md', agenter.memoryContent],
  ];

  for (const [filename, content] of rawFiles) {
    const trimmed = (content || '').trim();
    if (trimmed) {
      await writeFile(`${AGENT_DATA_DIR}/${filename}`, trimmed, `data:${filename}`);
    } else {
      try {
        await forwardToManager(env, 'POST', `/api/v1/sandboxes/${agenter.agenterId}/exec`, {
          command: `rm -f ${AGENT_DATA_DIR}/${filename}`,
          timeoutMs: 10000,
        });
      } catch { /* ignore */ }
    }
  }

  log.info({ agenterId: agenter.agenterId, count: synced.length, files: synced }, 'Files synced to sandbox');
  return synced;
}

// ─── Helper: exec in sandbox ────────────────────────────

async function execInSandbox(env: Env, agenterId: string, command: string, timeoutMs = 30000) {
  return forwardToManager(env, 'POST', `/api/v1/sandboxes/${agenterId}/exec`, {
    command,
    timeoutMs,
  });
}

async function restartGooCoreInSandbox(env: Env, agenterId: string): Promise<boolean> {
  await execInSandbox(env, agenterId,
    `bash -c 'pkill -f "@devbond/gc/dist/index" 2>/dev/null; sleep 1'`,
    10_000,
  );

  await execInSandbox(env, agenterId,
    `bash -c 'npm cache clean --force 2>&1 >/dev/null; npm install -g @devbond/gc@latest --prefer-online --fetch-retries=0 2>&1 | tail -3; if [ -d /root/goo-core/node_modules ]; then cd /root/goo-core && npm install @devbond/gc@latest --prefer-online --fetch-retries=0 2>&1 | tail -3; fi'`,
    60_000,
  );

  if (env.X402_PAYMENT_TOKEN) {
    const envPatch = `X402_PAYMENT_TOKEN=${env.X402_PAYMENT_TOKEN}`;
    for (const envPath of ['/root/.goo-core/.env', '/root/goo-core/.env']) {
      await execInSandbox(env, agenterId,
        `bash -c 'grep -q X402_PAYMENT_TOKEN ${envPath} 2>/dev/null || echo "${envPatch}" >> ${envPath}'`,
        5_000,
      );
    }
  }

  const logFile = '/var/log/sandbox/goo-core.log';
  const fallbackLog = '/var/log/goo-core.log';
  const { status } = await execInSandbox(env, agenterId,
    `bash -c 'if command -v goo-core &>/dev/null; then LOG=${logFile}; cd /root/.goo-core && env $(grep -v "^[[:space:]]*$" .env 2>/dev/null | xargs) nohup goo-core >> $LOG 2>&1 & echo "goo-core restarted (global), PID: $!"; else cd /root/goo-core && nohup npx goo-core >> ${fallbackLog} 2>&1 & echo "goo-core restarted (local), PID: $!"; fi'`,
    15_000,
  );
  return status < 400;
}

async function restartGatewayInSandbox(env: Env, agenterId: string): Promise<boolean> {
  await execInSandbox(env, agenterId,
    `bash -lc 'pkill -f "openclaw gateway" 2>/dev/null || true; sleep 1'`,
    10_000,
  );
  const { status } = await forwardToManager(env,
    'GET',
    `/api/v1/sandboxes/${agenterId}/gateway-health?restart=1`,
  );
  return status < 400;
}

// ─── Exported: destroy sandbox for agent ────────────────

export async function destroySandboxForAgent(env: Env, agenterId: string): Promise<boolean> {
  try {
    const { status } = await forwardToManager(env, 'DELETE', `/api/v1/sandboxes/${agenterId}`);
    if (status < 400) {
      const db = getDb(env);
      await db.update(agenterRecords).set({
        sandboxId: null,
        sandboxUrl: null,
        gatewayUrl: null,
        gatewayToken: null,
        gooCoreStatus: null,
      }).where(eq(agenterRecords.agenterId, agenterId));
      return true;
    }
    log.warn({ agenterId, status }, 'Sandbox destroy returned error');
    return false;
  } catch (err) {
    log.error({ agenterId, err }, 'Failed to destroy sandbox');
    return false;
  }
}

// ─── Helper: verify agent ownership ─────────────────────

async function findOwnedAgent(env: Env, agenterId: string, userId: number) {
  const db = getDb(env);
  const agenter = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenterId)).get();
  if (!agenter) return { error: 'Agent not found', status: 404 as const, agenter: null };
  if (agenter.userId !== userId) return { error: 'Not your agent', status: 403 as const, agenter: null };
  return { error: null, status: 200 as const, agenter };
}

async function findAccessibleAgent(env: Env, agenterId: string, auth: { user_id: number; wallet_address: string }) {
  const db = getDb(env);
  const agenter = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenterId)).get();
  if (!agenter) return { error: 'Agent not found', status: 404 as const, agenter: null };
  if (!(await hasPrivateAgentAccess(agenter, auth, env))) {
    return { error: 'Not your agent', status: 403 as const, agenter: null };
  }
  return { error: null, status: 200 as const, agenter };
}

// ─── Helper: build genome from agent record ─────────────

function buildGenome(agenter: AgenterLike): Record<string, unknown> {
  const genome: Record<string, unknown> = {};
  if (agenter.agentName) genome.agent_name = agenter.agentName;
  if (agenter.agentIntro) genome.agent_intro = agenter.agentIntro;
  if (agenter.genesisPrompt) genome.genesis_prompt = agenter.genesisPrompt;
  if (agenter.agentInstructions) genome.agent_instructions = agenter.agentInstructions;
  if (agenter.agentFramework) genome.framework = agenter.agentFramework;
  if (agenter.skillsContent) genome.skills_content = agenter.skillsContent;
  if (agenter.memoryContent) genome.memory_content = agenter.memoryContent;
  return genome;
}

// ─── Helper: extract gateway info from sandbox result ───

function extractGatewayInfo(result: { domain?: string; gatewayUrl?: string }): { gatewayToken: string | null; gatewayBaseUrl: string | null } {
  let gatewayToken: string | null = null;
  let gatewayBaseUrl: string | null = null;

  if (result.gatewayUrl) {
    try {
      const url = new URL(result.gatewayUrl);
      gatewayToken = url.searchParams.get('token');
      gatewayBaseUrl = `${url.protocol}//${url.host}`;
    } catch {
      gatewayBaseUrl = result.gatewayUrl.replace(/\/+$/, '');
    }
  } else if (result.domain) {
    gatewayBaseUrl = `https://${result.domain}`;
  }

  if (!gatewayToken) {
    gatewayToken = randomHex(32);
  }

  return { gatewayToken, gatewayBaseUrl };
}

// ─── Helper: build sandbox manager request body ─────────

type SandboxCreateResult = { agentId: string; sandboxId: string; domain: string; gatewayUrl?: string; walletAddress?: string };

async function buildSandboxRequestBody(env: Env, agenter: AgenterLike & { tokenAddress: string | null; agentWallet: string | null; encryptedPrivateKey: string | null; agenterId: string }): Promise<Record<string, unknown>> {
  const genome = buildGenome(agenter);
  const body: Record<string, unknown> = {
    agentId: agenter.agenterId,
    agentName: agenter.agentName || agenter.agenterId.slice(0, 8),
    genome,
  };
  if (agenter.tokenAddress) body.tokenAddress = agenter.tokenAddress;
  if (agenter.agentWallet) body.walletAddress = agenter.agentWallet;
  const pk = agenter.encryptedPrivateKey ? await decryptPrivateKey(agenter.encryptedPrivateKey, env.JWT_SECRET) : '';
  if (pk) body.walletPrivateKey = pk;
  if (env.PUBLIC_API_URL) {
    body.eventCallbackUrl = `${env.PUBLIC_API_URL}/api/agents/${agenter.agenterId}/events/ingest`;
  }
  return body;
}

// ─── Helper: finalize sandbox creation in DB ────────────

async function finalizeSandboxCreation(
  env: Env,
  agenterId: string,
  userId: number,
  result: SandboxCreateResult,
  agenter: AgenterLike & { agentWallet: string | null; agentFramework: string | null },
  label: string,
): Promise<{ sandboxId: string; sandboxUrl: string | null; gatewayUrl: string | null; filesSynced: string[] }> {
  const { gatewayToken, gatewayBaseUrl } = extractGatewayInfo(result);
  const db = getDb(env);

  const updateData: Record<string, unknown> = {
    sandboxId: result.sandboxId,
    sandboxUrl: result.domain ? `https://${result.domain}` : null,
    gatewayUrl: gatewayBaseUrl,
    gatewayToken: await encryptPrivateKey(gatewayToken!, env.JWT_SECRET),
    framework: agenter.agentFramework || 'openclaw',
    gooCoreStatus: 'starting',
  };
  if (result.walletAddress && !agenter.agentWallet) {
    updateData.agentWallet = result.walletAddress;
  }

  await db.update(agenterRecords).set(updateData).where(eq(agenterRecords.agenterId, agenterId));
  const updated = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenterId)).get();
  if (updated) {
    await setRuntimeState(env, updated.id, { state: 'ready', error: null });
  }

  await db.insert(transactionLogs).values({
    agenterId,
    userId,
    txHash: `sandbox-${result.sandboxId}`,
    method: 'createSandbox',
    memo: `Sandbox created${label}: ${result.sandboxId}`,
    status: 'confirmed',
  });

  const filesSynced = updated ? await syncFilesToSandbox(env, updated) : [];

  await emitAgentEvent(env, agenterId, {
    task_id: '', agent_id: agenterId,
    timestamp: new Date().toISOString(),
    display_text: `Sandbox created${label} (${result.sandboxId})`,
    phase: 'preparing', message_type: 'system',
  });

  return {
    sandboxId: result.sandboxId,
    sandboxUrl: result.domain ? `https://${result.domain}` : null,
    gatewayUrl: gatewayBaseUrl,
    filesSynced,
  };
}

// ─── Helper: proxy 402 payment-required response ────────

function proxy402Response(
  c: any,
  data: unknown,
  responseHeaders: Record<string, string>,
) {
  const prHeader = responseHeaders['payment-required'] || responseHeaders['PAYMENT-REQUIRED'];
  let respBody = data as Record<string, unknown>;
  if (prHeader && (!respBody || !respBody.accepts)) {
    try {
      const decoded = JSON.parse(atob(prHeader));
      respBody = { ...respBody, ...decoded };
    } catch { /* not valid base64 */ }
  }
  return c.json(respBody, { status: 402, headers: Object.fromEntries(Object.entries(responseHeaders)) });
}

// ─── Routes ─────────────────────────────────────────────

/**
 * GET /:agenterId/debug-payload
 */
app.get('/:agenterId/debug-payload', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);

    const genome = buildGenome(agenter);
    const privateKey = agenter.encryptedPrivateKey ? await decryptPrivateKey(agenter.encryptedPrivateKey, c.env.JWT_SECRET) : '';

    return c.json({
      _warning: 'DEBUG ONLY -- contains private key. Remove before production.',
      sandboxManagerPayload: {
        agentId: agenter.agenterId,
        agentName: agenter.agentName || agenter.agenterId.slice(0, 8),
        tokenAddress: agenter.tokenAddress || '0x0',
        walletAddress: agenter.agentWallet || '',
        walletPrivateKey: privateKey,
        genome,
      },
      agentRecord: {
        id: agenter.id,
        agenterId: agenter.agenterId,
        agentName: agenter.agentName,
        tokenAddress: agenter.tokenAddress,
        agentWallet: agenter.agentWallet,
        walletPrivateKey: privateKey,
        sandboxId: agenter.sandboxId,
        sandboxUrl: agenter.sandboxUrl,
        gatewayUrl: agenter.gatewayUrl,
        framework: agenter.agentFramework,
        launchMode: agenter.launchMode,
        gooCoreStatus: agenter.gooCoreStatus,
      },
      serverConfig: {
        sandboxManagerUrl: c.env.SANDBOX_MANAGER_URL,
        rpcUrl: c.env.RPC_URL,
        chainId: c.env.CHAIN_ID,
        routerAddress: c.env.ROUTER_ADDRESS,
        registryAddress: c.env.REGISTRY_ADDRESS,
        bscLlmRouterUrl: c.env.BSC_LLM_ROUTER_URL,
        x402Network: c.env.X402_NETWORK,
      },
    });
  } catch (err) {
    log.error({ err }, 'debug-payload error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /create
 */
app.post('/create', authRequired, async (c) => {
  const body = await c.req.json();
  const { agenter_id } = body;
  if (!agenter_id) {
    return c.json({ error: 'agenter_id is required' }, 400);
  }

  const userId = c.get('auth').user_id;

  try {
    const db = getDb(c.env);
    const agenter = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenter_id)).get();

    if (!agenter) return c.json({ error: 'Agent not found' }, 404);
    if (!isAgentCreator(agenter, c.get('auth'))) return c.json({ error: 'Not your agent' }, 403);
    if (agenter.sandboxId) return c.json({ error: 'Agent already has a sandbox', sandbox_id: agenter.sandboxId }, 409);
    if (agenter.sandboxProvider === 'agos') return c.json({ error: 'AGOS agents use AGOS deployment, not e2b sandbox' }, 400);

    const reqBody = await buildSandboxRequestBody(c.env, agenter);
    await setRuntimeState(c.env, agenter.id, { state: 'provisioning', error: null });

    const { status, data, responseHeaders } = await forwardToManager(
      c.env,
      'POST',
      '/api/v1/sandboxes',
      reqBody,
      {
        'payment-signature': c.req.header('payment-signature') || c.req.header('x-payment'),
      },
    );

    if (status === 402) return proxy402Response(c, data, responseHeaders);
    if (status >= 400) return c.json(data as object, status as 400);

    const result = data as SandboxCreateResult;
    const final = await finalizeSandboxCreation(c.env, agenter_id, userId, result, agenter, '');

    return c.json({
      sandbox_id: final.sandboxId,
      sandbox_url: final.sandboxUrl,
      gateway_url: final.gatewayUrl,
      goo_core_status: 'starting',
      files_synced: final.filesSynced,
    }, 201);
  } catch (err) {
    try {
      const db = getDb(c.env);
      const failed = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenter_id)).get();
      if (failed) await setRuntimeState(c.env, failed.id, { state: 'error', error: (err as Error).message });
    } catch {}
    log.error({ err }, 'Sandbox create error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /test-create
 */
app.post('/test-create', authRequired, async (c) => {
  const body = await c.req.json();
  const { agenter_id } = body;
  if (!agenter_id) {
    return c.json({ error: 'agenter_id is required' }, 400);
  }

  const userId = c.get('auth').user_id;

  try {
    const db = getDb(c.env);
    const agenter = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenter_id)).get();

    if (!agenter) return c.json({ error: 'Agent not found' }, 404);
    if (!isAgentCreator(agenter, c.get('auth'))) return c.json({ error: 'Not your agent' }, 403);
    if (agenter.sandboxId) return c.json({ error: 'Agent already has a sandbox', sandbox_id: agenter.sandboxId }, 409);

    const reqBody = await buildSandboxRequestBody(c.env, agenter);

    const { status, data } = await forwardToManager(
      c.env,
      'POST',
      '/api/v1/sandboxes/test-create',
      reqBody,
    );

    if (status >= 400) return c.json(data as object, status as 400);

    const result = data as SandboxCreateResult;
    const final = await finalizeSandboxCreation(c.env, agenter_id, userId, result, agenter, ' (test)');

    return c.json({
      sandbox_id: final.sandboxId,
      sandbox_url: final.sandboxUrl,
      gateway_url: final.gatewayUrl,
      goo_core_status: 'starting',
      files_synced: final.filesSynced,
    }, 201);
  } catch (err) {
    log.error({ err }, 'Sandbox test-create error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /confirm
 */
app.post('/confirm', authRequired, async (c) => {
  const body = await c.req.json();
  const { agenter_id, sandbox_id, sandbox_url, gateway_token } = body;
  if (!agenter_id || !sandbox_id) {
    return c.json({ error: 'agenter_id and sandbox_id are required' }, 400);
  }

  const userId = c.get('auth').user_id;

  try {
    const db = getDb(c.env);
    const agenter = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenter_id)).get();

    if (!agenter) return c.json({ error: 'Agent not found' }, 404);
    if (!isAgentCreator(agenter, c.get('auth'))) return c.json({ error: 'Not your agent' }, 403);

    let gwToken = gateway_token as string | null;
    let gwUrl: string | null = null;

    if (sandbox_url) {
      try {
        const url = new URL(sandbox_url);
        if (!gwToken) gwToken = url.searchParams.get('token');
        gwUrl = `${url.protocol}//${url.host}`;
      } catch {
        gwUrl = (sandbox_url as string).replace(/\/+$/, '');
      }
    }
    if (!gwToken) {
      gwToken = randomHex(32);
    }

    await db.update(agenterRecords).set({
      sandboxId: sandbox_id,
      sandboxUrl: sandbox_url || null,
      gatewayUrl: gwUrl,
      gatewayToken: await encryptPrivateKey(gwToken, c.env.JWT_SECRET),
      framework: agenter.agentFramework || 'openclaw',
      gooCoreStatus: 'starting',
    }).where(eq(agenterRecords.agenterId, agenter_id));

    const updated = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenter_id)).get();

    await db.insert(transactionLogs).values({
      agenterId: agenter_id,
      userId,
      txHash: `sandbox-${sandbox_id}`,
      method: 'createSandbox',
      memo: `Sandbox created (x402 direct): ${sandbox_id}`,
      status: 'confirmed',
    });

    const filesSynced = updated ? await syncFilesToSandbox(c.env, updated) : [];

    await emitAgentEvent(c.env, agenter_id, {
      task_id: '', agent_id: agenter_id,
      timestamp: new Date().toISOString(),
      display_text: `Sandbox confirmed (${sandbox_id})`,
      phase: 'preparing', message_type: 'system',
    });

    return c.json({
      sandbox_id,
      sandbox_url: sandbox_url || null,
      goo_core_status: 'starting',
      files_synced: filesSynced,
    }, 201);
  } catch (err) {
    try {
      const failed = await getDb(c.env).select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenter_id)).get();
      if (failed) await setRuntimeState(c.env, failed.id, { state: 'error', error: (err as Error).message });
    } catch {}
    log.error({ err }, 'Sandbox confirm error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * GET /:agenterId/status
 */
app.get('/:agenterId/status', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findAccessibleAgent(c.env, agenterId, c.get('auth'));
    if (!agenter) return c.json({ error }, errStatus);

    if (!agenter.sandboxId) {
      return c.json({ has_sandbox: false });
    }

    const { status, data } = await forwardToManager(c.env, 'GET', `/api/v1/sandboxes/${agenter.agenterId}`, undefined);

    if (status === 404) {
      return c.json({ has_sandbox: true, sandbox_id: agenter.sandboxId, state: 'unknown' });
    }

    return c.json({ has_sandbox: true, ...(data as object) });
  } catch (err) {
    log.error({ err }, 'Sandbox status error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /:agenterId/pause
 */
app.post('/:agenterId/pause', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const { status, data } = await forwardToManager(c.env, 'POST', `/api/v1/sandboxes/${agenter.agenterId}/pause`);
    if (status < 400) await setRuntimeState(c.env, agenter.id, { state: 'paused', error: null });
    return c.json(data as object, status as 200);
  } catch (err) {
    log.error({ err }, 'Sandbox pause error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /:agenterId/resume
 */
app.post('/:agenterId/resume', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const { status, data } = await forwardToManager(c.env, 'POST', `/api/v1/sandboxes/${agenter.agenterId}/resume`);

    if (status < 400) {
      const result = data as { sandboxId?: string; domain?: string; gatewayUrl?: string };
      if (result.sandboxId) {
        const db = getDb(c.env);
        await db.update(agenterRecords).set({
          sandboxId: result.sandboxId,
          sandboxUrl: result.domain ? `https://${result.domain}` : agenter.sandboxUrl,
        }).where(eq(agenterRecords.agenterId, agenterId));
      }
      await setRuntimeState(c.env, agenter.id, { state: 'ready', error: null });
    }

    return c.json(data as object, status as 200);
  } catch (err) {
    try {
      const failed = await getDb(c.env).select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenterId)).get();
      if (failed) await setRuntimeState(c.env, failed.id, { state: 'error', error: (err as Error).message });
    } catch {}
    log.error({ err }, 'Sandbox resume error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /:agenterId/renew
 */
app.post('/:agenterId/renew', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const reqBody = await c.req.json().catch(() => ({}));

    const { status, data, responseHeaders } = await forwardToManager(
      c.env,
      'POST',
      `/api/v1/sandboxes/${agenter.agenterId}/renew`,
      reqBody,
      {
        'payment-signature': c.req.header('payment-signature') || c.req.header('x-payment'),
      },
    );

    if (status === 402) return proxy402Response(c, data, responseHeaders);

    return c.json(data as object, status as 200);
  } catch (err) {
    try {
      const failed = await getDb(c.env).select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenterId)).get();
      if (failed) await setRuntimeState(c.env, failed.id, { state: 'error', error: (err as Error).message });
    } catch {}
    log.error({ err }, 'Sandbox renew error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * DELETE /:agenterId
 */
app.delete('/:agenterId', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const { status, data } = await forwardToManager(c.env, 'DELETE', `/api/v1/sandboxes/${agenter.agenterId}`);

    if (status < 400) {
      const db = getDb(c.env);
      await db.update(agenterRecords).set({
        sandboxId: null,
        sandboxUrl: null,
        gatewayUrl: null,
        gatewayToken: null,
        gooCoreStatus: null,
      }).where(eq(agenterRecords.agenterId, agenterId));
      await setRuntimeState(c.env, agenter.id, { state: 'none', error: null });

      await emitAgentEvent(c.env, agenterId, {
        task_id: '', agent_id: agenterId,
        timestamp: new Date().toISOString(),
        display_text: 'Sandbox destroyed',
        phase: 'finalizing', message_type: 'system',
      });
    }

    return c.json(data as object, status as 200);
  } catch (err) {
    log.error({ err }, 'Sandbox destroy error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /:agenterId/exec
 */
app.post('/:agenterId/exec', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');
  const body = await c.req.json();
  const { command, timeoutMs } = body;

  if (!command || typeof command !== 'string') {
    return c.json({ error: 'command is required' }, 400);
  }

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const cappedTimeout = Math.min(Number(timeoutMs) || 30000, 60000);
    const { status, data } = await execInSandbox(c.env, agenterId, command, cappedTimeout);
    return c.json(data as object, status as 200);
  } catch (err) {
    log.error({ err }, 'Sandbox exec error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * GET /:agenterId/goo-core-status
 */
app.get('/:agenterId/goo-core-status', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findAccessibleAgent(c.env, agenterId, c.get('auth'));
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const { status, data } = await execInSandbox(c.env, agenterId,
      `bash -c 'pgrep -f "@devbond/gc/dist/index" > /dev/null && echo running || echo stopped'`,
      10_000,
    );

    if (status >= 400) {
      return c.json({ goo_core: 'unknown', error: 'exec failed' });
    }

    const output = ((data as any).stdout || '').trim();
    const isRunning = output.includes('running');

    const [{ data: versionData }, { data: logData }] = await Promise.all([
      execInSandbox(c.env, agenterId,
        `cat /usr/lib/node_modules/@devbond/gc/package.json 2>/dev/null | grep '"version"' | head -1 | sed 's/.*"version".*"\\(.*\\)".*/\\1/'`,
        5_000,
      ),
      execInSandbox(c.env, agenterId,
        `tail -10 /var/log/sandbox/goo-core.log 2>/dev/null || tail -10 /var/log/goo-core.log 2>/dev/null || echo 'No logs yet'`,
        10_000,
      ),
    ]);

    return c.json({
      goo_core: isRunning ? 'running' : 'stopped',
      version: ((versionData as any).stdout || '').trim() || 'unknown',
      last_log: ((logData as any).stdout || '').trim(),
    });
  } catch (err) {
    log.error({ err }, 'Sandbox goo-core-status error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /:agenterId/restart-goo-core
 */
app.post('/:agenterId/restart-goo-core', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const restarted = await restartGooCoreInSandbox(c.env, agenterId);
    const db = getDb(c.env);
    await db.update(agenterRecords).set({
      gooCoreStatus: restarted ? 'running' : 'error',
    }).where(eq(agenterRecords.agenterId, agenterId));

    return c.json({ message: restarted ? 'goo-core restarted' : 'goo-core restart failed', restarted });
  } catch (err) {
    log.error({ err }, 'Sandbox restart-goo-core error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /:agenterId/sync-files
 */
app.post('/:agenterId/sync-files', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const synced = await syncFilesToSandbox(c.env, agenter);
    return c.json({ synced, data_dir: AGENT_DATA_DIR });
  } catch (err) {
    log.error({ err }, 'Sandbox sync-files error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /:agenterId/apply-config
 */
app.post('/:agenterId/apply-config', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const warnings: string[] = [];
    const synced = await syncFilesToSandbox(c.env, agenter);

    if (synced.length === 0) {
      warnings.push('No creator files were synced to the sandbox.');
    }

    const gooCoreRestarted = await restartGooCoreInSandbox(c.env, agenterId);
    const gatewayRestarted = await restartGatewayInSandbox(c.env, agenterId);

    if (!gooCoreRestarted) warnings.push('goo-core restart failed');
    if (!gatewayRestarted) warnings.push('gateway restart failed');

    const db = getDb(c.env);
    await db.update(agenterRecords).set({
      gooCoreStatus: gooCoreRestarted ? 'running' : 'error',
    }).where(eq(agenterRecords.agenterId, agenterId));

    return c.json({
      db_saved: true,
      files_synced: synced,
      goo_core_restarted: gooCoreRestarted,
      gateway_restarted: gatewayRestarted,
      warnings,
    });
  } catch (err) {
    log.error({ err }, 'Sandbox apply-config error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * GET /:agenterId/gateway-health
 */
app.get('/:agenterId/gateway-health', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const restart = c.req.query('restart') === '1' ? '?restart=1' : '';
    const { status, data } = await forwardToManager(
      c.env,
      'GET',
      `/api/v1/sandboxes/${agenter.agenterId}/gateway-health${restart}`,
    );

    return c.json(data as object, status as 200);
  } catch (err) {
    log.error({ err }, 'Sandbox gateway-health error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * GET /:agenterId/logs
 */
app.get('/:agenterId/logs', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findAccessibleAgent(c.env, agenterId, c.get('auth'));
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const { status, data } = await forwardToManager(c.env, 'GET', `/api/v1/sandboxes/${agenter.agenterId}/logs`);
    return c.json(data as object, status as 200);
  } catch (err) {
    log.error({ err }, 'Sandbox logs error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * GET /:agenterId/events
 */
app.get('/:agenterId/events', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');

  try {
    const { error, status: errStatus, agenter } = await findAccessibleAgent(c.env, agenterId, c.get('auth'));
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const limit = c.req.query('limit') || '200';
    const offset = c.req.query('offset') || '0';
    const { status, data } = await forwardToManager(
      c.env,
      'GET',
      `/api/v1/sandboxes/${agenter.agenterId}/events?limit=${limit}&offset=${offset}`,
    );
    return c.json(data as object, status as 200);
  } catch (err) {
    log.error({ err }, 'Sandbox events error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /:agenterId/chat
 */
app.post('/:agenterId/chat', authRequired, async (c) => {
  const agenterId = c.req.param('agenterId');
  const body = await c.req.json();
  const { message } = body;

  if (!message) {
    return c.json({ error: 'message is required' }, 400);
  }

  try {
    const { error, status: errStatus, agenter } = await findOwnedAgent(c.env, agenterId, c.get('auth').user_id);
    if (!agenter) return c.json({ error }, errStatus);
    if (!agenter.sandboxId) return c.json({ error: 'No sandbox for this agent' }, 400);

    const { status, data } = await forwardToManager(
      c.env,
      'POST',
      `/api/v1/sandboxes/${agenter.agenterId}/chat`,
      { message },
    );

    if (status >= 200 && status < 300) {
      const respData = data as { reply?: string; model?: string };
      if (respData.reply) {
        const db = getDb(c.env);
        db.insert(chatMessages).values([
          { agenterId, userId: c.get('auth').user_id, role: 'user', content: message },
          { agenterId, userId: c.get('auth').user_id, role: 'assistant', content: respData.reply, model: respData.model || null, via: 'openclaw' },
        ]).catch(err => log.error({ err }, 'Failed to save sandbox chat messages'));
      }
    }

    return c.json(data as object, status as 200);
  } catch (err) {
    log.error({ err }, 'Sandbox chat error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

export { app as sandboxRoutes };
