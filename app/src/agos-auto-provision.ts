/**
 * AGOS Auto-Provision Pipeline
 *
 * After funding triggers a deployment, this pipeline:
 * 1. Polls AGOS API until deployment reaches 'running' state
 * 2. Builds and executes the provision script via SSH (Durable Object)
 * 3. Verifies container health
 *
 * Designed to run in `waitUntil` — does not block the response.
 * Emits progress events via WebSocket so the frontend can track.
 */

import type { Env } from './bindings';
import type { AgosClient } from './agos-client';
import { getDb } from './db';
import { agenterRecords, transactionLogs } from './db/schema';
import { eq } from 'drizzle-orm';
import { emitAgentEvent } from './event-bus';
import { decryptPrivateKey, encryptPrivateKey, generateRuntimeToken } from './crypto';
import { buildProvisionScript, checkProvisionHealth, checkEndpointHealth } from './agos-provision';
import { restoreAgosSession } from './finance/agos';
import { setRuntimeState } from './agent-state-updates';
import type { ExecutionPhase, AgentStreamEvent } from './types';

export interface AutoProvisionParams {
  /** DB row id (integer) — used for setRuntimeState */
  agentRecordId: number;
  /** Public agent identifier (string) */
  agenterId: string;
  agosAgentId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  encryptedPrivateKey: string;
  encryptedApiKey: string | null;
  agentName: string;
  tokenAddress: string;
  serverBaseUrl: string;
  userId: number;
  llmModel?: string | null;
}

const DEPLOY_POLL_INTERVAL = 8_000;   // 8s between polls
const DEPLOY_POLL_TIMEOUT = 600_000;  // 10 min max wait for AGOS deployment
const HEALTH_CHECK_RETRIES = 6;
const HEALTH_CHECK_INTERVAL = 5_000;

async function emitProgress(
  env: Env,
  agenterId: string,
  text: string,
  phase: ExecutionPhase = 'preparing',
  extra?: Record<string, unknown>,
) {
  await emitAgentEvent(env, agenterId, {
    task_id: '',
    agent_id: agenterId,
    timestamp: new Date().toISOString(),
    display_text: text,
    phase,
    message_type: 'system',
    ...extra,
  } as AgentStreamEvent).catch(() => {});
}

async function buildRuntimeEnv(
  params: AutoProvisionParams,
  env: Env,
): Promise<Record<string, string>> {
  const privateKey = await decryptPrivateKey(params.encryptedPrivateKey, env.JWT_SECRET);
  const runtimeToken = await generateRuntimeToken(params.agenterId, env.JWT_SECRET);
  const serverUrl = params.serverBaseUrl.replace(/\/+$/, '');

  const runtimeEnv: Record<string, string> = {
    GOO_SERVER_URL: serverUrl,
    AGENT_ID: params.agenterId,
    AGENT_NAME: params.agentName || '',
    AGENT_RUNTIME_TOKEN: runtimeToken,
    AGOS_API_BASE_URL: env.AGOS_API_URL.replace(/\/+$/, ''),
    CHAIN_ID: String(env.CHAIN_ID),
    RPC_URL: env.RPC_URL,
    TOKEN_ADDRESS: params.tokenAddress || '',
    WALLET_PRIVATE_KEY: privateKey,
    OPENCLAW_GATEWAY_TOKEN: await generateRuntimeToken(`${params.agenterId}:gateway`, env.JWT_SECRET),
    OPENAI_BASE_URL: `${serverUrl}/api/llm-proxy/${params.agenterId}`,
    OPENAI_API_KEY: runtimeToken,
    LLM_MODEL: params.llmModel || env.LLM_MODEL,
    ROUTER_ADDRESS: env.ROUTER_ADDRESS,
    REGISTRY_ADDRESS: env.REGISTRY_ADDRESS,
    CONTROL_PORT: '18789',
    OPENCLAW_MODEL: params.llmModel || env.LLM_MODEL || 'claude-sonnet-4-6',
  };

  if (params.encryptedApiKey) {
    try {
      runtimeEnv.AGOS_AGENT_API_KEY = await decryptPrivateKey(params.encryptedApiKey, env.JWT_SECRET);
    } catch { /* LLM will fall back to proxy */ }
  }

  return runtimeEnv;
}

export async function runAutoProvisionPipeline(
  env: Env,
  params: AutoProvisionParams,
): Promise<void> {
  const log = (msg: string) => console.log(`[auto-provision][${params.agenterId}] ${msg}`);

  try {
    await setRuntimeState(env, params.agentRecordId, { state: 'provisioning', error: null });
    await emitProgress(env, params.agenterId, 'Deployment triggered — waiting for AGOS VPS...', 'preparing', { provision_step: 'waiting_deploy' });

    // --- Phase 1: Poll AGOS until deployment is running ---
    log('Phase 1: Waiting for AGOS deployment...');
    let publicIp: string | null = null;
    let defaultPassword: string | null = null;
    let agosEndpoint: string | null = null;
    let deploymentStatus = 'unknown';
    const pollStart = Date.now();

    while (Date.now() - pollStart < DEPLOY_POLL_TIMEOUT) {
      await new Promise(r => setTimeout(r, DEPLOY_POLL_INTERVAL));

      let client: AgosClient;
      try {
        const session = await restoreAgosSession(
          params.encryptedAccessToken,
          params.encryptedRefreshToken,
          env.AGOS_API_URL,
          env.JWT_SECRET,
        );
        client = session.client;
      } catch (err) {
        log(`Session restore failed, retrying: ${(err as Error).message}`);
        continue;
      }

      try {
        const agosAgent = await client.getAgent(params.agosAgentId);
        deploymentStatus = agosAgent.deployment?.status || 'unknown';
        publicIp = agosAgent.deployment?.publicIp || null;
        defaultPassword = agosAgent.deployment?.defaultPassword || null;
        agosEndpoint = agosAgent.endpoint || null;

        log(`Deployment status: ${deploymentStatus}, IP: ${publicIp || 'none'}`);

        if (deploymentStatus === 'running' && publicIp) {
          await emitProgress(env, params.agenterId, `VPS ready (${publicIp}), provisioning...`, 'preparing', { provision_step: 'pulling' });
          break;
        }

        // AGOS may stay at 'installing' because its default container uses bridge
        // mode and the health check can't reach port 19789. If we have IP + password
        // and SSH is likely reachable, proceed with our own provision (which replaces
        // the AGOS container with --network host).
        if (deploymentStatus === 'installing' && publicIp && defaultPassword) {
          const elapsed = Math.round((Date.now() - pollStart) / 1000);
          if (elapsed >= 30) {
            log(`AGOS stuck at 'installing' for ${elapsed}s but IP+password available — proceeding with provision`);
            await emitProgress(env, params.agenterId, `VPS reachable (${publicIp}), taking over from AGOS...`, 'preparing', { provision_step: 'pulling' });
            break;
          }
        }

        if (deploymentStatus === 'failed') {
          const lastError = agosAgent.deployment?.lastError || 'unknown';
          throw new Error(`AGOS deployment failed: ${lastError}`);
        }

        // Still deploying — emit progress
        const elapsed = Math.round((Date.now() - pollStart) / 1000);
        const statusText = deploymentStatus === 'pending' ? 'Queued'
          : deploymentStatus === 'provisioning' ? 'Provisioning server'
          : deploymentStatus === 'installing' ? 'Installing software'
          : `Deploying (${deploymentStatus})`;
        await emitProgress(env, params.agenterId, `${statusText}... (${elapsed}s)`, 'preparing', { provision_step: 'waiting_deploy' });
      } catch (err) {
        if ((err as Error).message?.includes('deployment failed')) throw err;
        log(`Poll error (will retry): ${(err as Error).message}`);
      }
    }

    if (!publicIp) {
      throw new Error(`AGOS deployment did not become ready within ${DEPLOY_POLL_TIMEOUT / 1000}s (last status: ${deploymentStatus})`);
    }

    // --- Phase 2: Build and execute provision script ---
    log(`Phase 2: Provisioning VPS ${publicIp}...`);

    const runtimeEnv = await buildRuntimeEnv(params, env);
    const gwPort = '18789';
    const provision = buildProvisionScript({
      publicIp,
      password: defaultPassword || '',
      dockerImage: env.AGOS_IMAGE,
      envVars: runtimeEnv,
      gatewayPort: gwPort,
      agosEndpoint: agosEndpoint || undefined,
    });

    // Update DB with gateway URL
    const db = getDb(env);
    await db.update(agenterRecords).set({
      gatewayUrl: provision.gatewayUrl,
      gatewayToken: await encryptPrivateKey(runtimeEnv.OPENCLAW_GATEWAY_TOKEN, env.JWT_SECRET),
      status: 'active',
    }).where(eq(agenterRecords.agenterId, params.agenterId));

    await db.insert(transactionLogs).values({
      agenterId: params.agenterId,
      userId: params.userId,
      txHash: `auto-provision-${Date.now()}`,
      method: 'agosAutoProvision',
      memo: `Auto-provisioning VPS ${publicIp}`,
      status: 'confirmed',
    }).catch(() => {});

    // Dispatch SSH provision to Durable Object (if password available)
    if (defaultPassword) {
      await emitProgress(env, params.agenterId, `Pulling Docker image on VPS ${publicIp}...`, 'preparing', { provision_step: 'pulling' });

      const doId = env.AGENT_PROVISIONER.idFromName(params.agenterId);
      const stub = env.AGENT_PROVISIONER.get(doId);
      await stub.fetch(new Request('http://do/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agenterId: params.agenterId,
          host: publicIp,
          password: defaultPassword,
          script: provision.script,
          gatewayPort: gwPort,
        }),
      }));

      log('Provision dispatched to DO, waiting for health...');

      // --- Phase 3: Health check loop ---
      let healthy = false;
      for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
        await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL));
        // Try AGOS endpoint (nginx on port 80) first, fall back to direct IP:port
        const health = agosEndpoint
          ? await checkEndpointHealth(agosEndpoint)
          : await checkProvisionHealth(publicIp, gwPort);
        if (health.ok) {
          healthy = true;
          break;
        }
        log(`Health check ${i + 1}/${HEALTH_CHECK_RETRIES}: ${health.error}`);
      }

      if (healthy) {
        await emitProgress(env, params.agenterId, 'Agent is live!', 'running', { provision_step: 'live' });
        await setRuntimeState(env, params.agentRecordId, { state: 'ready', error: null });

      } else {
        await emitProgress(env, params.agenterId, 'Container started but health check pending — may take a moment.', 'running', { provision_step: 'live' });
        await setRuntimeState(env, params.agentRecordId, { state: 'ready', error: null });
      }

    } else {
      // No password — manual provision needed
      await emitProgress(env, params.agenterId, `VPS ready at ${publicIp} — manual provision needed (no SSH password).`, 'preparing', { provision_step: 'manual' });
      await setRuntimeState(env, params.agentRecordId, { state: 'ready', error: null });
    }

    log('Auto-provision pipeline complete.');
  } catch (err) {
    const message = (err as Error).message || 'Auto-provision failed';
    console.error(`[auto-provision][${params.agenterId}] Pipeline error:`, message);
    await emitProgress(env, params.agenterId, `Auto-provision failed: ${message}`, 'finalizing', { provision_step: 'error' });
    await setRuntimeState(env, params.agentRecordId, { state: 'error', error: message });
  }
}
