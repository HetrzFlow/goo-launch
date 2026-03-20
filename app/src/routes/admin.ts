import { Hono } from 'hono';
import { eq, desc, count } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { users, contracts, agenterRecords, transactionLogs } from '../db/schema';
import { authRequired, adminRequired } from '../auth/middleware';

type AppEnv = { Bindings: Env; Variables: HonoVariables };
const app = new Hono<AppEnv>();

/** GET /stats */
app.get('/stats', authRequired, async (c) => {
  const db = getDb(c.env);
  const [userCount, contractCount, agenterCount, txCount] = await Promise.all([
    db.select({ count: count() }).from(users).get(),
    db.select({ count: count() }).from(contracts).get(),
    db.select({ count: count() }).from(agenterRecords).get(),
    db.select({ count: count() }).from(transactionLogs).get(),
  ]);
  return c.json({
    users: userCount?.count ?? 0,
    contracts: contractCount?.count ?? 0,
    agenters: agenterCount?.count ?? 0,
    transactions: txCount?.count ?? 0,
  });
});

/** GET /users */
app.get('/users', authRequired, async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  return c.json(rows);
});

/** GET /contracts */
app.get('/contracts', authRequired, async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(contracts).orderBy(desc(contracts.createdAt));
  return c.json(rows);
});

/** GET /agenters */
app.get('/agenters', authRequired, async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(agenterRecords).orderBy(desc(agenterRecords.createdAt));
  return c.json(rows);
});

/** GET /transactions */
app.get('/transactions', authRequired, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(transactionLogs)
    .orderBy(desc(transactionLogs.createdAt))
    .limit(200);
  return c.json(rows);
});

/** DELETE /users/:id */
app.delete('/users/:id', authRequired, adminRequired, async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'invalid user id' }, 400);
  }
  const db = getDb(c.env);
  try {
    await db.delete(users).where(eq(users.id, id));
    return c.json({ deleted: true });
  } catch {
    return c.json({ error: 'user not found' }, 404);
  }
});

export { app as adminRoutes };
