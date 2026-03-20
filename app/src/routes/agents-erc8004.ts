import { Hono } from 'hono';
import { ethers } from 'ethers';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { authRequired } from '../auth/middleware';
import { findAgentByParam } from './agents';
import { getERC8004Addresses, getERC8004Reputation, getERC8004Clients } from '../erc8004';

type AppEnv = { Bindings: Env; Variables: HonoVariables };
const app = new Hono<AppEnv>();

/** GET /:id/erc8004 — ERC-8004 registration info for an agent. */
app.get('/:id/erc8004', authRequired, async (c) => {
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);

  const chainId = parseInt(c.env.CHAIN_ID || '97');
  const addrs = getERC8004Addresses(chainId);

  return c.json({
    erc8004_agent_id: agent.erc8004AgentId || null,
    registered: !!agent.erc8004AgentId,
    chain_id: chainId,
    identity_registry: addrs?.identity || null,
    reputation_registry: addrs?.reputation || null,
  });
});

/** GET /:id/reputation — Fetch ERC-8004 reputation summary. */
app.get('/:id/reputation', authRequired, async (c) => {
  const db = getDb(c.env);
  const agent = await findAgentByParam(db, c.req.param('id'));
  if (!agent) return c.json({ error: 'agent not found' }, 404);

  if (!agent.erc8004AgentId || typeof agent.erc8004AgentId !== 'number') {
    return c.json({
      error: 'Agent not registered on ERC-8004',
      erc8004_agent_id: null,
    }, 404);
  }

  const chainId = parseInt(c.env.CHAIN_ID || '97');
  const addrs = getERC8004Addresses(chainId);
  if (!addrs) {
    return c.json({ error: `ERC-8004 not available on chain ${chainId}` }, 503);
  }

  try {
    const provider = new ethers.JsonRpcProvider(c.env.RPC_URL);
    const agentId = BigInt(agent.erc8004AgentId);
    const tag1 = c.req.query('tag1') || '';
    const tag2 = c.req.query('tag2') || '';

    // Get all clients who have given feedback
    const clients = await getERC8004Clients(provider, chainId, agentId);

    if (clients.length === 0) {
      return c.json({
        erc8004_agent_id: agent.erc8004AgentId,
        count: 0,
        summary_value: '0',
        summary_value_decimals: 0,
        clients: [],
      });
    }

    const summary = await getERC8004Reputation(provider, chainId, agentId, clients, tag1, tag2);

    return c.json({
      erc8004_agent_id: agent.erc8004AgentId,
      count: Number(summary.count),
      summary_value: summary.summaryValue.toString(),
      summary_value_decimals: summary.summaryValueDecimals,
      clients,
    });
  } catch (err) {
    console.error('ERC-8004 reputation fetch error', err);
    return c.json({ error: (err as Error).message }, 500);
  }
});

export { app as agentsErc8004Routes };
