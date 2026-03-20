import type { Env } from './bindings';
import { getDb } from './db';
import { agentEvents } from './db/schema';
import type { AgentStreamEvent } from './types';

/**
 * Emit an event to all WebSocket clients connected to an agent's DO.
 */
export async function emitAgentEvent(
  env: Env,
  agentId: string,
  event: AgentStreamEvent,
): Promise<void> {
  const id = env.AGENT_EVENT_HUB.idFromName(agentId);
  const stub = env.AGENT_EVENT_HUB.get(id);
  await stub.fetch(new Request('http://do/emit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })).catch(() => {});
}

/**
 * Persist an agent event to D1 and broadcast via DO.
 */
export async function persistAgentEvent(
  env: Env,
  params: {
    agenterId: string;
    eventType: string;
    severity: 'info' | 'warn' | 'error' | 'critical';
    message: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const db = getDb(env);

  // DB write (best-effort)
  try {
    await db.insert(agentEvents).values({
      agenterId: params.agenterId,
      eventType: params.eventType,
      severity: params.severity,
      message: params.message,
      metadata: JSON.stringify(params.metadata || {}),
    });
  } catch (err) {
    console.error('Failed to persist event', { agenterId: params.agenterId, err });
  }

  // Broadcast to WebSocket clients
  await emitAgentEvent(env, params.agenterId, {
    task_id: '',
    agent_id: params.agenterId,
    timestamp: new Date().toISOString(),
    display_text: params.message,
    phase: 'running',
    message_type: params.severity === 'error' || params.severity === 'critical' ? 'result' : 'system',
  });

  // Webhook for error/critical
  if (
    (params.severity === 'error' || params.severity === 'critical') &&
    env.ALERT_WEBHOOK_URL
  ) {
    fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'goo-server',
        timestamp: new Date().toISOString(),
        agenterId: params.agenterId,
        eventType: params.eventType,
        severity: params.severity,
        message: params.message,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}
