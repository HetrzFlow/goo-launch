import { Hono } from 'hono';
import { eq, desc, count, and, lt, inArray } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords, agentEvents } from '../db/schema';
import { authRequired, adminRequired } from '../auth/middleware';
import { hasPrivateAgentAccess } from '../agent-access';

type AppEnv = { Bindings: Env; Variables: HonoVariables };
const app = new Hono<AppEnv>();

const startTime = Date.now();

/** GET /health — System health overview. Admin only. */
app.get('/health', authRequired, adminRequired, async (c) => {
  const db = getDb(c.env);

  try {
    const [
      total,
      byStatusRaw,
      recentAlerts,
    ] = await Promise.all([
      db.select({ count: count() }).from(agenterRecords).get(),
      db
        .select({
          status: agenterRecords.status,
          count: count(),
        })
        .from(agenterRecords)
        .groupBy(agenterRecords.status),
      db
        .select()
        .from(agentEvents)
        .where(inArray(agentEvents.severity, ['error', 'critical']))
        .orderBy(desc(agentEvents.createdAt))
        .limit(10),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRaw) {
      byStatus[row.status] = row.count;
    }

    const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();
    const stalePulse = await db
      .select({ count: count() })
      .from(agenterRecords)
      .where(
        and(
          eq(agenterRecords.status, 'active'),
          lt(agenterRecords.lastPulseAt, twoHoursAgo),
        ),
      )
      .get();

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: (Date.now() - startTime) / 1000,
      agents: {
        total: total?.count ?? 0,
        byStatus,
        stalePulse: stalePulse?.count ?? 0,
      },
      recentAlerts,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/** GET /agents/:id/health — Per-agent health detail. Owner/creator only. */
app.get('/agents/:id/health', authRequired, async (c) => {
  const { findAgentByParam } = await import('./agents');
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));

  if (!agent) {
    return c.json({ error: 'agent not found' }, 404);
  }

  if (!(await hasPrivateAgentAccess(agent, c.get('auth'), c.env))) {
    return c.json({ error: 'not your agent' }, 403);
  }

  let pulseFreshness: 'healthy' | 'warning' | 'critical' | 'unknown' = 'unknown';
  if (agent.lastPulseAt) {
    const age = Date.now() - new Date(agent.lastPulseAt).getTime();
    if (age < 3600_000) pulseFreshness = 'healthy';
    else if (age < 7200_000) pulseFreshness = 'warning';
    else pulseFreshness = 'critical';
  }

  const recentEvents = await db
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.agenterId, agent.agenterId))
    .orderBy(desc(agentEvents.createdAt))
    .limit(20);

  return c.json({
    agenterId: agent.agenterId,
    dbStatus: agent.status,
    gooCoreStatus: agent.gooCoreStatus,
    lastPulseAt: agent.lastPulseAt,
    pulseFreshness,
    recentEvents,
  });
});

export { app as healthRoutes };
