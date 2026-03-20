import { createMiddleware } from 'hono/factory';
import type { Env, HonoVariables } from '../bindings';
import { verifyToken } from './jwt';

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export const authRequired = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header required' }, 401);
  }

  const token = header.slice(7);
  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET);
    c.set('auth', payload);
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  await next();
});

export const adminRequired = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get('auth');
  if (!auth || auth.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403);
  }
  await next();
});
