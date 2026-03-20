import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { contracts, agenterRecords, transactionLogs } from '../db/schema';
import { authRequired } from '../auth/middleware';

type AppEnv = { Bindings: Env; Variables: HonoVariables };
const app = new Hono<AppEnv>();

/** GET /api/my/contracts */
app.get('/contracts', authRequired, async (c) => {
  const db = getDb(c.env);
  const userId = c.get('auth').user_id;
  const rows = await db
    .select()
    .from(contracts)
    .where(eq(contracts.userId, userId))
    .orderBy(desc(contracts.createdAt));
  return c.json(rows);
});

/** GET /api/my/agenters */
app.get('/agenters', authRequired, async (c) => {
  const db = getDb(c.env);
  const userId = c.get('auth').user_id;
  const rows = await db
    .select()
    .from(agenterRecords)
    .where(eq(agenterRecords.userId, userId))
    .orderBy(desc(agenterRecords.createdAt));
  return c.json(rows);
});

/** GET /api/my/transactions */
app.get('/transactions', authRequired, async (c) => {
  const db = getDb(c.env);
  const userId = c.get('auth').user_id;
  const rows = await db
    .select()
    .from(transactionLogs)
    .where(eq(transactionLogs.userId, userId))
    .orderBy(desc(transactionLogs.createdAt))
    .limit(100);
  return c.json(rows);
});

export { app as dashboardRoutes };
