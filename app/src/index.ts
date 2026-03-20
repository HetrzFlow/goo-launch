import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, HonoVariables } from './bindings';
import { AgentEventHub } from './durable-objects/agent-event-hub';
import { AgentProvisioner } from './durable-objects/agent-provisioner';

// Route imports
import { authRoutes } from './routes/auth';
import { launchRoutes } from './routes/launch';
import { agentRoutes } from './routes/agents';
import { dashboardRoutes } from './routes/dashboard';
import { adminRoutes } from './routes/admin';
import { sandboxRoutes } from './routes/sandbox';
import { agosRoutes } from './routes/agos';
import { healthRoutes } from './routes/health';
import { llmProxyRoutes } from './routes/llm-proxy';
import { priceRoutes } from './routes/price';
import { getEffectiveAgosMinInitialFund, isAgosConfigured } from './agos-config';

export type AppType = { Bindings: Env; Variables: HonoVariables };

const app = new Hono<AppType>();

// CORS
app.use(
  '/api/*',
  cors({
    origin: (origin) => origin || '*',
    credentials: true,
    exposeHeaders: [
      'payment-required',
      'PAYMENT-REQUIRED',
      'payment-response',
      'PAYMENT-RESPONSE',
      'payment-signature',
      'x-payment',
    ],
  }),
);

// Health ping
app.get('/ping', (c) => {
  return c.json({ message: 'pong' });
});

// Public config
app.get('/api/config', (c) => {
  const env = c.env;
  const agosEnabled = isAgosConfigured(env);
  return c.json({
    network: env.NETWORK,
    chain_id: parseInt(env.CHAIN_ID || '97'),
    router_address: env.ROUTER_ADDRESS,
    sandbox_manager_url: env.SANDBOX_MANAGER_URL,
    agos_enabled: agosEnabled,
    agos_chain_id: parseInt(env.AGOS_CHAIN_ID || '56'),
    agos_effective_min_initial_fund: getEffectiveAgosMinInitialFund(env),
    min_contribution_bnb: parseFloat(env.MIN_CONTRIBUTION_BNB || '0.1'),
    treasury_bnb_bps: parseInt(env.TREASURY_BNB_BPS || '3000'),
  });
});

// Routes
app.route('/api/auth', authRoutes);
app.route('/api/launch', launchRoutes);
app.route('/api/agents', agentRoutes);
app.route('/api/my', dashboardRoutes);
app.route('/api/sandbox', sandboxRoutes);
app.route('/api/agos', agosRoutes);
app.route('/api/all', adminRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/llm-proxy', llmProxyRoutes);
app.route('/api/bnb-price', priceRoutes);
app.route('/api', healthRoutes);

// Static assets fallback (frontend)
app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// Worker export
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Periodic cleanup: delete agent_events older than 30 days
    // TODO: implement with drizzle
    console.log('Cron triggered', { cron: event.cron, scheduledTime: event.scheduledTime });
  },
};

// Durable Object export
export { AgentEventHub, AgentProvisioner };
