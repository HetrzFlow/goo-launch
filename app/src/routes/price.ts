import { Hono } from 'hono';
import type { Env, HonoVariables } from '../bindings';

type AppEnv = { Bindings: Env; Variables: HonoVariables };
const app = new Hono<AppEnv>();

const FALLBACK_BNB_PRICE = 600;
const CACHE_TTL_SECS = 3600; // 1 hour

/** GET /api/bnb-price — cached BNB/USDT price */
app.get('/', async (c) => {
  const cacheUrl = new URL(c.req.url);
  const cache = caches.default;

  const cached = await cache.match(cacheUrl);
  if (cached) {
    return cached;
  }

  let price = FALLBACK_BNB_PRICE;
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json<{ price: string }>();
      const parsed = parseFloat(data.price);
      if (parsed > 0) price = parsed;
    }
  } catch {
    // Binance unreachable — use fallback
  }

  const resp = new Response(JSON.stringify({ price }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECS}`,
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheUrl, resp.clone()));

  return resp;
});

export { app as priceRoutes };
