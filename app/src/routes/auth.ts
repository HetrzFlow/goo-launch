import { Hono } from 'hono';
import { ethers } from 'ethers';
import type { Env, HonoVariables } from '../bindings';
import { signToken } from '../auth/jwt';
import { authRequired } from '../auth/middleware';
import { storeNonce, getNonce, consumeNonce } from '../auth/nonce';
import { getDb } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const app = new Hono<AppEnv>();

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const RATE_LIMIT_WINDOW = 60; // seconds
const RATE_LIMIT_MAX = 10;

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `rate:nonce:${ip}`;
  const current = parseInt((await kv.get(key)) || '0', 10);
  if (current >= RATE_LIMIT_MAX) return false;
  await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  return true;
}

// POST /nonce - request a nonce for wallet signature login
app.post('/nonce', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const allowed = await checkRateLimit(c.env.NONCE_KV, ip);
  if (!allowed) {
    return c.json({ error: 'Too many nonce requests. Try again later.' }, 429);
  }

  const body = await c.req.json<{ wallet_address?: string }>();
  const walletAddress = body.wallet_address;
  if (!walletAddress || typeof walletAddress !== 'string' || !WALLET_RE.test(walletAddress)) {
    return c.json({ error: 'Valid wallet_address required (0x... 42 chars)' }, 400);
  }

  const normalized = walletAddress.toLowerCase();
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  await storeNonce(c.env.NONCE_KV, normalized, nonce);

  return c.json({ nonce });
});

// POST /login - verify wallet signature and issue JWT
app.post('/login', async (c) => {
  const body = await c.req.json<{ wallet_address?: string; signature?: string }>();
  const { wallet_address: walletAddress, signature } = body;

  if (!walletAddress || typeof walletAddress !== 'string' || !WALLET_RE.test(walletAddress)) {
    return c.json({ error: 'Valid wallet_address required (0x... 42 chars)' }, 400);
  }
  if (!signature || typeof signature !== 'string') {
    return c.json({ error: 'Signature required' }, 400);
  }

  const normalized = walletAddress.toLowerCase();

  const nonce = await getNonce(c.env.NONCE_KV, normalized);
  if (!nonce) {
    return c.json({ error: 'No nonce found. Request /api/auth/nonce first.' }, 400);
  }

  const message = `Sign in to Goo\n\nNonce: ${nonce}`;
  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    return c.json({ error: 'Invalid signature' }, 400);
  }

  if (recoveredAddress !== normalized) {
    return c.json({ error: 'Signature does not match wallet address' }, 400);
  }

  await consumeNonce(c.env.NONCE_KV, normalized);

  const db = getDb(c.env);
  let user = await db.select().from(users).where(eq(users.walletAddress, normalized)).get();
  if (!user) {
    user = await db.insert(users).values({ walletAddress: normalized }).returning().get();
  }

  const token = await signToken(
    { user_id: user.id, wallet_address: user.walletAddress, role: user.role },
    c.env.JWT_SECRET,
  );

  return c.json({
    token,
    user: { id: user.id, wallet_address: user.walletAddress, role: user.role },
  });
});

// GET /me - get current user info
app.get('/me', authRequired, async (c) => {
  const auth = c.get('auth');
  const db = getDb(c.env);
  const user = await db.select().from(users).where(eq(users.id, auth.user_id)).get();
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  return c.json({ id: user.id, wallet_address: user.walletAddress, role: user.role });
});

export { app as authRoutes };
