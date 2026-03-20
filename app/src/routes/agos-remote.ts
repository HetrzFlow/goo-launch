import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords } from '../db/schema';
import { authRequired } from '../auth/middleware';
import { generateRuntimeToken } from '../crypto';
import { restoreAgosSession } from '../finance/agos';

type AppEnv = { Bindings: Env; Variables: HonoVariables };
type AppContext = Context<AppEnv>;

const GATEWAY_PORT = 18789; // control-server sits in front of gateway on the same port
const CONTROL_TIMEOUT = 65_000; // slightly above server-side 60s

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ControlEndpoint {
  publicIp: string;
  controlToken: string;
  /** HTTPS endpoint URL for routing control requests (avoids direct IP:port) */
  controlBaseUrl: string | null;
}

async function resolveControlEndpoint(
  c: AppContext,
): Promise<ControlEndpoint | Response> {
  const agenterId = c.req.param('agenterId');
  if (!agenterId) return c.json({ error: 'Agent not found' }, 404);

  const userId = c.get('auth').user_id;
  const db = getDb(c.env);
  const agentRecord = await db
    .select()
    .from(agenterRecords)
    .where(eq(agenterRecords.agenterId, agenterId))
    .get();

  if (!agentRecord) return c.json({ error: 'Agent not found' }, 404);
  if (agentRecord.userId !== userId) return c.json({ error: 'Not your agent' }, 403);
  if (agentRecord.sandboxProvider !== 'agos' || !agentRecord.agosAgentId) {
    return c.json({ error: 'Not an AGOS agent' }, 400);
  }

  // Resolve publicIp: try AGOS API first, fall back to gatewayUrl in DB
  let publicIp: string | null = null;

  if (agentRecord.agosAccessToken) {
    try {
      const session = await restoreAgosSession(
        agentRecord.agosAccessToken,
        agentRecord.agosRefreshToken,
        c.env.AGOS_API_URL,
        c.env.JWT_SECRET,
      );
      const agosAgent = await session.client.getAgent(agentRecord.agosAgentId);
      publicIp = agosAgent.deployment?.publicIp || null;
    } catch {
      // AGOS session expired or unavailable — fall back to gatewayUrl
    }
  }

  // Fall back: extract IP from gatewayUrl (ws://1.2.3.4:19789)
  if (!publicIp && agentRecord.gatewayUrl) {
    const match = agentRecord.gatewayUrl.match(/\/\/([\d.]+)/);
    if (match) publicIp = match[1];
  }

  if (!publicIp) {
    return c.json({
      error: 'Control server not available. The agent has no public IP. Redeploy this agent to enable remote management.',
    }, 503);
  }

  // Re-derive AGENT_RUNTIME_TOKEN (same as buildAgosRuntimeEnv).
  // Note: gatewayToken in DB stores OPENCLAW_GATEWAY_TOKEN which is different.
  const controlToken = await generateRuntimeToken(agentRecord.agenterId, c.env.JWT_SECRET);

  // If gatewayUrl is an HTTPS endpoint, route control requests through it instead of IP:port
  const controlBaseUrl = agentRecord.gatewayUrl?.startsWith('https://')
    ? agentRecord.gatewayUrl.replace(/\/+$/, '')
    : null;

  return { publicIp, controlToken, controlBaseUrl };
}

function isResponse(value: ControlEndpoint | Response): value is Response {
  return value instanceof Response;
}

async function forwardToControlServer(
  endpoint: ControlEndpoint,
  method: string,
  path: string,
  body?: unknown,
  timeout?: number,
): Promise<{ status: number; data: unknown }> {
  const url = endpoint.controlBaseUrl
    ? `${endpoint.controlBaseUrl}${path}`
    : `http://${endpoint.publicIp}:${GATEWAY_PORT}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${endpoint.controlToken}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout || CONTROL_TIMEOUT),
  });

  const data = await res.json().catch(() => ({ error: 'Invalid response from control server' }));
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /agents/:agenterId/remote/exec
app.post('/agents/:agenterId/remote/exec', authRequired, async (c) => {
  const endpoint = await resolveControlEndpoint(c);
  if (isResponse(endpoint)) return endpoint;

  const { command, timeoutMs } = await c.req.json();
  if (!command || typeof command !== 'string') {
    return c.json({ error: 'command is required' }, 400);
  }

  try {
    const result = await forwardToControlServer(
      endpoint, 'POST', '/control/exec',
      { command, timeoutMs },
    );
    return c.json(result.data, result.status as any);
  } catch (err) {
    return c.json({ error: `Control server unreachable: ${(err as Error).message}` }, 502);
  }
});

// GET /agents/:agenterId/remote/status
app.get('/agents/:agenterId/remote/status', authRequired, async (c) => {
  const endpoint = await resolveControlEndpoint(c);
  if (isResponse(endpoint)) return endpoint;

  try {
    const result = await forwardToControlServer(
      endpoint, 'GET', '/control/status',
    );
    return c.json(result.data, result.status as any);
  } catch (err) {
    return c.json({ error: `Control server unreachable: ${(err as Error).message}` }, 502);
  }
});

// GET /agents/:agenterId/remote/logs
app.get('/agents/:agenterId/remote/logs', authRequired, async (c) => {
  const endpoint = await resolveControlEndpoint(c);
  if (isResponse(endpoint)) return endpoint;

  const service = c.req.query('service') || 'goo-core';
  const lines = c.req.query('lines') || '100';

  try {
    const result = await forwardToControlServer(
      endpoint, 'GET', `/control/logs?service=${encodeURIComponent(service)}&lines=${encodeURIComponent(lines)}`,
    );
    return c.json(result.data, result.status as any);
  } catch (err) {
    return c.json({ error: `Control server unreachable: ${(err as Error).message}` }, 502);
  }
});

// POST /agents/:agenterId/remote/env
app.post('/agents/:agenterId/remote/env', authRequired, async (c) => {
  const endpoint = await resolveControlEndpoint(c);
  if (isResponse(endpoint)) return endpoint;

  const { vars, restart } = await c.req.json();
  if (!vars || typeof vars !== 'object') {
    return c.json({ error: 'vars (Record<string,string>) is required' }, 400);
  }

  try {
    const result = await forwardToControlServer(
      endpoint, 'POST', '/control/env',
      { vars, restart },
    );
    return c.json(result.data, result.status as any);
  } catch (err) {
    return c.json({ error: `Control server unreachable: ${(err as Error).message}` }, 502);
  }
});

// GET /agents/:agenterId/remote/env-check
app.get('/agents/:agenterId/remote/env-check', authRequired, async (c) => {
  const endpoint = await resolveControlEndpoint(c);
  if (isResponse(endpoint)) return endpoint;

  try {
    const result = await forwardToControlServer(
      endpoint, 'GET', '/control/env-check',
    );
    return c.json(result.data, result.status as any);
  } catch (err) {
    return c.json({ error: `Control server unreachable: ${(err as Error).message}` }, 502);
  }
});

// POST /agents/:agenterId/remote/restart-gateway
app.post('/agents/:agenterId/remote/restart-gateway', authRequired, async (c) => {
  const endpoint = await resolveControlEndpoint(c);
  if (isResponse(endpoint)) return endpoint;

  try {
    const result = await forwardToControlServer(
      endpoint, 'POST', '/control/restart-gateway',
      undefined, 15_000,
    );
    return c.json(result.data, result.status as any);
  } catch (err) {
    return c.json({ error: `Control server unreachable: ${(err as Error).message}` }, 502);
  }
});

// POST /agents/:agenterId/remote/restart-goo-core
app.post('/agents/:agenterId/remote/restart-goo-core', authRequired, async (c) => {
  const endpoint = await resolveControlEndpoint(c);
  if (isResponse(endpoint)) return endpoint;

  try {
    const result = await forwardToControlServer(
      endpoint, 'POST', '/control/restart-goo-core',
      undefined, 15_000,
    );
    return c.json(result.data, result.status as any);
  } catch (err) {
    return c.json({ error: `Control server unreachable: ${(err as Error).message}` }, 502);
  }
});

// POST /agents/:agenterId/remote/upgrade
app.post('/agents/:agenterId/remote/upgrade', authRequired, async (c) => {
  const endpoint = await resolveControlEndpoint(c);
  if (isResponse(endpoint)) return endpoint;

  try {
    const result = await forwardToControlServer(
      endpoint, 'POST', '/control/exec',
      { command: 'npm install -g @devbond/gc@latest 2>&1 && pkill -HUP -f "goo-core-wrapper" 2>/dev/null; echo "upgrade complete"', timeoutMs: 60000 },
    );
    return c.json(result.data, result.status as any);
  } catch (err) {
    return c.json({ error: `Control server unreachable: ${(err as Error).message}` }, 502);
  }
});

export { app as agosRemoteRoutes };
