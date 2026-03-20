import { Hono } from 'hono';
import { eq, desc, lt, and, inArray } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords, transactionLogs, agentEvents, chatMessages } from '../db/schema';
import { authRequired } from '../auth/middleware';
import { hasPrivateAgentAccess } from '../agent-access';
import { emitAgentEvent, persistAgentEvent } from '../event-bus';
import { decryptPrivateKey, verifyRuntimeToken } from '../crypto';

import { childLogger } from '../logger';
import { sql } from 'drizzle-orm';

const log = childLogger({ module: 'routes/agents-chat' });

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/** Build system prompt parts from agent record. */
function buildSystemPromptParts(agent: {
  agentName: string | null;
  genesisPrompt: string | null;
  agentIntro: string | null;
  agentInstructions?: string | null;
  skillsContent?: string | null;
  memoryContent?: string | null;
}): string[] {
  const parts: string[] = [];
  if (agent.agentName) parts.push(`You are ${agent.agentName}, an autonomous Goo Agent.`);
  if (agent.genesisPrompt) parts.push(agent.genesisPrompt);
  if (agent.agentIntro) parts.push(`About you: ${agent.agentIntro}`);
  if (agent.agentInstructions) parts.push(`## Instructions\n${agent.agentInstructions}`);
  if (agent.skillsContent) parts.push(`## Skills\n${agent.skillsContent}`);
  if (agent.memoryContent) parts.push(`## Memory\n${agent.memoryContent}`);
  if (parts.length === 0) parts.push('You are an autonomous Goo Agent. Respond helpfully to your creator.');
  return parts;
}

/** Save a user+assistant message pair to the database. Fire-and-forget. */
function saveChatMessages(
  env: Env,
  agenterId: string,
  userId: number,
  userMessage: string,
  assistantReply: string,
  meta: { model?: string | null; via?: string | null; tier?: string | null },
): void {
  const db = getDb(env);
  Promise.all([
    db.insert(chatMessages).values({
      agenterId, userId, role: 'user', content: userMessage,
    }),
    db.insert(chatMessages).values({
      agenterId, userId, role: 'assistant', content: assistantReply,
      model: meta.model || null, via: meta.via || null, tier: meta.tier || null,
    }),
  ]).catch(err => log.error({ err }, 'Failed to save chat messages'));
}

/** Classify a transaction log method into a structured event type. */
function classifyEventType(method: string): string {
  const m = method.toLowerCase();
  if (m.includes('pulse')) return 'pulse';
  if (m.includes('survivalsell') || m.includes('survival_sell')) return 'survivalSell';
  if (m.includes('status') || m.includes('lifecycle')) return 'statusChange';
  if (m.includes('llm') || m.includes('autonomousbehavior')) return 'llmCall';
  if (m.includes('sandbox')) return 'sandbox';
  if (m.includes('launch')) return 'deploy';
  if (m.includes('deploy') || m.includes('register')) return 'deploy';
  return 'other';
}

/** Classify a goo-core structured event type into a UI category. */
function classifyCoreEventType(eventType: string): string {
  const t = eventType.toLowerCase();
  if (t.includes('pulse')) return 'pulse';
  if (t.includes('survival_sell') || t.includes('survivalsell')) return 'survivalSell';
  if (t.includes('buyback')) return 'buyback';
  if (t.includes('gas_refill') || t.includes('gas_low')) return 'gasRefill';
  if (t.includes('payment_token')) return 'gasRefill';
  if (t.includes('llm') || t.includes('agent_dead')) return 'llmCall';
  if (t.includes('error') || t.includes('failed')) return 'error';
  return 'other';
}

const app = new Hono<AppEnv>();

/** POST /:id/chat — Send a message to the agent. Routes through OpenClaw gateway if available. Owner only. */
app.post('/:id/chat', authRequired, async (c) => {
  const { message, history } = await c.req.json<{
    message?: string;
    history?: Array<{ role: string; content: string }>;
  }>();
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return c.json({ error: 'message is required' }, 400);
  }

  const { findAgentByParam } = await import('./agents');
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  if (!(await hasPrivateAgentAccess(agent, c.get('auth'), c.env))) {
    return c.json({ error: 'not your agent' }, 403);
  }

  const safeHistory = (history || [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20);
  const agentModel = agent.llmModel || c.env.LLM_MODEL;

  // Emit reasoning event
  emitAgentEvent(c.env, agent.agenterId, {
    task_id: '', agent_id: agent.agenterId,
    timestamp: new Date().toISOString(),
    display_text: 'Processing message...',
    phase: 'planning', message_type: 'reasoning',
  });

  // Chat only through OpenClaw gateway
  if (!agent.gatewayUrl || !agent.gatewayToken) {
    return c.json({ error: 'OpenClaw gateway not configured for this agent' }, 503);
  }

  try {
    const gatewayToken = await decryptPrivateKey(agent.gatewayToken, c.env.JWT_SECRET);
    const systemPrompt = buildSystemPromptParts(agent).join('\n\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      ...safeHistory,
      { role: 'user', content: message.trim() },
    ];

    // gatewayUrl may be ws:// — convert to http:// for fetch
    const httpGatewayUrl = agent.gatewayUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');

    // Use streaming to avoid CF worker subrequest timeout (~100s).
    // Streaming keeps the connection alive during OpenClaw's tool use / reasoning.
    const response = await fetch(`${httpGatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        model: agentModel || 'claude-sonnet-4-6',
        messages,
        max_tokens: 2048,
        stream: true,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok || !response.body) {
      const gwErrBody = await response.text().catch(() => '');
      log.warn({ agenterId: agent.agenterId, status: response.status, url: httpGatewayUrl, body: gwErrBody.slice(0, 200) }, 'OpenClaw gateway error');
      return c.json({ error: `Gateway error (HTTP ${response.status}): ${gwErrBody.slice(0, 150)}`, via: 'openclaw' }, 502);
    }

    // Collect SSE stream into final content
    let content = '';
    let reasoningContent = '';
    let returnedModel = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
          try {
            const chunk = JSON.parse(jsonStr) as {
              model?: string;
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
            };
            if (chunk.model) returnedModel = chunk.model;
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) content += delta.content;
            if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
          } catch { /* skip malformed chunk */ }
        }
      }
    } catch (streamErr) {
      log.warn({ agenterId: agent.agenterId, err: (streamErr as Error).message }, 'OpenClaw stream read error');
    }
    // If streaming returned empty content, retry non-streaming.
    // OpenClaw sends empty streams when tool use hits rate limits or errors.
    if (!content && !reasoningContent) {
      try {
        const fallbackResp = await fetch(`${httpGatewayUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${gatewayToken}`,
          },
          body: JSON.stringify({
            model: agentModel || 'claude-sonnet-4-6',
            messages,
            max_tokens: 2048,
            stream: false,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (fallbackResp.ok) {
          const fbJson = await fallbackResp.json() as {
            model?: string;
            choices?: Array<{ message?: { content?: string } }>;
          };
          if (fbJson.model) returnedModel = fbJson.model;
          content = fbJson.choices?.[0]?.message?.content || '';
        }
      } catch (fbErr) {
        log.warn({ agenterId: agent.agenterId, err: (fbErr as Error).message }, 'Non-streaming fallback also failed');
      }
    }

    const reply = (content || reasoningContent || '(no response)').trim();

    await db.update(agenterRecords)
      .set({ llmCallsCount: sql`${agenterRecords.llmCallsCount} + 1` })
      .where(eq(agenterRecords.id, agent.id));

    emitAgentEvent(c.env, agent.agenterId, {
      task_id: '', agent_id: agent.agenterId,
      timestamp: new Date().toISOString(),
      display_text: reply.slice(0, 120),
      phase: 'finalizing', message_type: 'result',
    });

    const respModel = returnedModel || agentModel || 'claude-sonnet-4-6';
    saveChatMessages(c.env, agent.agenterId, c.get('auth').user_id, message.trim(), reply, { model: respModel, via: 'openclaw' });
    return c.json({ reply, model: respModel, via: 'openclaw' });
  } catch (err) {
    log.warn({ agenterId: agent.agenterId, gatewayUrl: agent.gatewayUrl, err: (err as Error).message }, 'OpenClaw gateway failed');
    return c.json({ error: `Gateway unreachable: ${(err as Error).message}`, via: 'openclaw' }, 502);
  }
});

/** GET /:id/chat-history — Retrieve saved chat messages. Owner only. */
app.get('/:id/chat-history', authRequired, async (c) => {
  const { findAgentByParam } = await import('./agents');
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  if (!(await hasPrivateAgentAccess(agent, c.get('auth'), c.env))) {
    return c.json({ error: 'not your agent' }, 403);
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const beforeParam = c.req.query('before');
  const beforeId = beforeParam ? parseInt(beforeParam) : undefined;

  const conditions = [eq(chatMessages.agenterId, agent.agenterId)];
  if (beforeId) conditions.push(lt(chatMessages.id, beforeId));

  const messages = await db.select({
    id: chatMessages.id,
    role: chatMessages.role,
    content: chatMessages.content,
    model: chatMessages.model,
    via: chatMessages.via,
    tier: chatMessages.tier,
    createdAt: chatMessages.createdAt,
  })
    .from(chatMessages)
    .where(and(...conditions))
    .orderBy(desc(chatMessages.id))
    .limit(limit);

  return c.json({ messages: messages.reverse(), has_more: messages.length === limit });
});

/** POST /:id/events/ingest — Receive structured events from goo-core (sandbox callback). No auth. */
app.post('/:id/events/ingest', async (c) => {
  const { findAgentByParam } = await import('./agents');
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);

  const { type, severity, message: msg, data } = await c.req.json<{
    type?: string;
    severity?: string;
    message?: string;
    data?: Record<string, unknown>;
  }>();
  if (!type || !severity || !msg) {
    return c.json({ error: 'type, severity, and message are required' }, 400);
  }

  const validSeverities = ['info', 'warn', 'error', 'critical'] as const;
  if (!validSeverities.includes(severity as any)) {
    return c.json({ error: `severity must be one of: ${validSeverities.join(', ')}` }, 400);
  }

  await persistAgentEvent(c.env, {
    agenterId: agent.agenterId,
    eventType: type,
    severity: severity as 'info' | 'warn' | 'error' | 'critical',
    message: msg,
    metadata: data,
  });

  return c.json({ ok: true });
});

/** GET /:id/events — Get agent events (transactions + structured goo-core events). */
app.get('/:id/events', authRequired, async (c) => {
  const { findAgentByParam } = await import('./agents');
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);

  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');
  const typeFilter = c.req.query('type');

  const [txLogs, coreEventsRows] = await Promise.all([
    db.select().from(transactionLogs)
      .where(eq(transactionLogs.agenterId, agent.agenterId))
      .orderBy(desc(transactionLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db.select().from(agentEvents)
      .where(eq(agentEvents.agenterId, agent.agenterId))
      .orderBy(desc(agentEvents.createdAt))
      .limit(limit)
      .offset(offset),
  ]);

  const txEventsNorm = txLogs.map(ev => ({
    ...ev,
    event_type: classifyEventType(ev.method),
    severity: ev.status === 'error' ? 'error' : 'info',
    source: 'tx' as const,
  }));

  const coreEventsNorm = coreEventsRows.map(ev => {
    let metadataObj: Record<string, unknown> = {};
    try {
      metadataObj = JSON.parse(ev.metadata || '{}');
    } catch { /* ignore */ }
    return {
      id: ev.id,
      agenterId: ev.agenterId,
      txHash: (metadataObj.txHash as string) || '',
      method: ev.eventType,
      memo: ev.message,
      status: ev.severity,
      error: ev.severity === 'error' || ev.severity === 'critical' ? ev.message : null,
      createdAt: ev.createdAt,
      event_type: classifyCoreEventType(ev.eventType),
      severity: ev.severity,
      source: 'core' as const,
    };
  });

  // Merge and sort by date descending
  const merged = [...txEventsNorm, ...coreEventsNorm]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);

  const filtered = typeFilter
    ? merged.filter(ev => ev.event_type === typeFilter)
    : merged;

  return c.json({ events: filtered });
});

/** GET /:id/alerts — Get persisted agent events filtered by severity. Owner/creator only. */
app.get('/:id/alerts', authRequired, async (c) => {
  const { findAgentByParam } = await import('./agents');
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  if (!(await hasPrivateAgentAccess(agent, c.get('auth'), c.env))) {
    return c.json({ error: 'not your agent' }, 403);
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const severityParam = c.req.query('severity') || 'warn,error,critical';
  const severities = severityParam.split(',').map(s => s.trim());

  const events = await db.select().from(agentEvents)
    .where(and(
      eq(agentEvents.agenterId, agent.agenterId),
      inArray(agentEvents.severity, severities),
    ))
    .orderBy(desc(agentEvents.createdAt))
    .limit(limit);

  return c.json({ events });
});

/** POST /:id/chat-ingest — Receive messages from OpenClaw hooks. Runtime token auth. */
app.post('/:id/chat-ingest', async (c) => {
  const agenterId = c.req.param('id');
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token || !(await verifyRuntimeToken(agenterId, token, c.env.JWT_SECRET))) {
    return c.json({ error: 'Invalid runtime token' }, 401);
  }

  const { role, content, source, sessionKey } = await c.req.json<{
    role?: string;
    content?: string;
    source?: string;
    sessionKey?: string;
  }>();

  if (!role || !content || typeof content !== 'string' || content.trim().length === 0) {
    return c.json({ error: 'role and content are required' }, 400);
  }
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    return c.json({ error: 'role must be user, assistant, or system' }, 400);
  }

  const db = getDb(c.env);
  const agent = await db.select({ id: agenterRecords.id, userId: agenterRecords.userId })
    .from(agenterRecords)
    .where(eq(agenterRecords.agenterId, agenterId))
    .get();
  if (!agent) return c.json({ error: 'agent not found' }, 404);

  await db.insert(chatMessages).values({
    agenterId,
    userId: agent.userId,
    role,
    content: content.trim(),
    via: source || 'openclaw',
  });

  return c.json({ ok: true });
});

export { app as agentsChatRoutes };
