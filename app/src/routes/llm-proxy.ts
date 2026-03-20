import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords } from '../db/schema';
import { decryptPrivateKey, verifyRuntimeToken } from '../crypto';
import { childLogger } from '../logger';

const log = childLogger({ module: 'routes/llm-proxy' });

type AppEnv = { Bindings: Env; Variables: HonoVariables };
const app = new Hono<AppEnv>();

/**
 * OpenAI-compatible LLM proxy for AGOS agents.
 *
 * The AGOS apiKey is only available after POST /agents (createAgent),
 * but envVars are set at creation time — chicken-and-egg problem.
 *
 * Solution: container sets OPENAI_BASE_URL = goo-server/api/llm-proxy/:agenterId
 * and OPENAI_API_KEY = AGENT_RUNTIME_TOKEN. This proxy forwards to AGOS
 * using the stored agosApiKey from the DB.
 *
 * POST /api/llm-proxy/:agenterId/v1/chat/completions
 *   Auth: Bearer <AGENT_RUNTIME_TOKEN>
 *   Body: OpenAI-compatible chat completion request
 */
app.post('/:agenterId/v1/chat/completions', async (c) => {
  const agenterId = c.req.param('agenterId');
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');

  if (!token || !(await verifyRuntimeToken(agenterId, token, c.env.JWT_SECRET))) {
    return c.json({ error: { message: 'Invalid or missing runtime token', type: 'auth_error' } }, 401);
  }

  try {
    const db = getDb(c.env);
    const agent = await db.select().from(agenterRecords)
      .where(eq(agenterRecords.agenterId, agenterId)).get();

    if (!agent) {
      return c.json({ error: { message: 'Agent not found', type: 'not_found' } }, 404);
    }
    if (!agent.agosApiKey) {
      return c.json({ error: { message: 'Agent has no AGOS API key', type: 'config_error' } }, 400);
    }

    const agosApiKey = await decryptPrivateKey(agent.agosApiKey, c.env.JWT_SECRET);
    const agosUrl = c.env.AGOS_API_URL.replace(/\/+$/, '');

    // Forward the request body as-is to AGOS LLM gateway
    const body = await c.req.text();

    const response = await fetch(`${agosUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agosApiKey}`,
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });

    // Stream or return the response as-is (preserves SSE streaming)
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    log.error({ err, agenterId }, 'LLM proxy error');
    return c.json({
      error: { message: (err as Error).message, type: 'proxy_error' },
    }, 502);
  }
});

/** GET /api/llm-proxy/:agenterId/v1/models — proxy model list */
app.get('/:agenterId/v1/models', async (c) => {
  const agenterId = c.req.param('agenterId');
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');

  if (!token || !(await verifyRuntimeToken(agenterId, token, c.env.JWT_SECRET))) {
    return c.json({ error: { message: 'Invalid or missing runtime token', type: 'auth_error' } }, 401);
  }

  try {
    const agosUrl = c.env.AGOS_API_URL.replace(/\/+$/, '');
    const response = await fetch(`${agosUrl}/v1/models`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    log.error({ err }, 'LLM proxy models error');
    return c.json({ error: { message: (err as Error).message, type: 'proxy_error' } }, 502);
  }
});

export { app as llmProxyRoutes };
