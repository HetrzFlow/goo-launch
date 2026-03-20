import { Hono } from 'hono';
import { ethers } from 'ethers';
import { eq, and, desc, inArray } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords, contracts, transactionLogs, users } from '../db/schema';
import { authRequired } from '../auth/middleware';
import {
  encryptPrivateKey,
  decryptPrivateKey,
  generateRuntimeToken,
} from '../crypto';
import { getTokenArtifact, getRegistryArtifact } from '../artifacts';
import { registerAgentOnERC8004, getERC8004Addresses } from '../erc8004';
import {
  defaultLlmProvider,
  defaultSandboxProvider,
  type LlmProvider,
  normalizeLlmProvider,
  normalizeSandboxProvider,
  type SandboxProvider,
  validateProviderSelection,
} from '../providers';
import { nowIso } from '../agent-state';
import { deriveRuntimeState, setLaunchState } from '../agent-state-updates';
import { patchLaunchSession, stringifyLaunchSession } from '../launch-session';

type AppEnv = { Bindings: Env; Variables: HonoVariables };
const app = new Hono<AppEnv>();

type AbiInput = { name?: string; type?: string };

function getConstructorInputs(abi: unknown[]): AbiInput[] {
  const ctor = abi.find(
    (entry: any) => entry?.type === 'constructor',
  ) as { inputs?: AbiInput[] } | undefined;
  return ctor?.inputs ?? [];
}

interface PrepareBody {
  agent_name: string;
  agent_intro: string;
  token_symbol: string;
  genesis_prompt?: string;
  agent_instructions?: string;
  skills_content?: string;
  memory_content?: string;
  framework?: string;
  sandbox_provider?: SandboxProvider;
  llm_provider?: LlmProvider;
  llm_model?: string;
  circulation_pct?: number;
  contribution_bnb?: string;
  buyback_enabled?: boolean;
  buyback_threshold_bnb?: string;
}

function buildTokenConstructorArgs(
  body: PrepareBody,
  agentWalletAddress: string,
  tokenAbi: unknown[],
  env: Env,
): unknown[] {
  const circulationPct = Math.min(Math.max(body.circulation_pct ?? 10, 10), 100);
  const circulationBps = BigInt(circulationPct * 100);
  const constructorInputs = getConstructorInputs(tokenAbi);

  const argByName = new Map<string, unknown>([
    ['_name', `${body.agent_name} Token`],
    ['_symbol', body.token_symbol],
    ['_agentWallet', agentWalletAddress],
    ['_swapExecutor', env.SWAP_EXECUTOR_ADDRESS],
    ['_registry', env.REGISTRY_ADDRESS],
    ['_fixedBurnRate', 0n],
    ['_minRunwayHours', 72n],
    ['_starvingGracePeriod', 86400n],
    ['_dyingMaxDuration', 259200n],
    ['_pulseTimeout', 3600n],
    ['_survivalSellCooldown', 300n],
    ['_maxSellBps', 500n],
    ['_minCtoAmount', ethers.parseEther('0.1')],
    ['_feeRateBps', 100n],
    ['_circulationBps', circulationBps],
    ['_treasuryTokenBps', 500n],
  ]);

  const unsupported = constructorInputs.filter(
    (input) => input.name && !argByName.has(input.name),
  );
  if (unsupported.length > 0) {
    const signature = constructorInputs
      .map((input) => `${input.name || '<unnamed>'}:${input.type || 'unknown'}`)
      .join(', ');
    throw new Error(
      `Unsupported GooAgentToken artifact constructor (${constructorInputs.length} args: ${signature}).`,
    );
  }

  return constructorInputs.map((input, idx) => {
    if (!input.name) {
      throw new Error(
        `Unsupported GooAgentToken artifact constructor: argument #${idx + 1} is unnamed.`,
      );
    }
    return argByName.get(input.name);
  });
}

function getLaunchMode(sandboxProvider: SandboxProvider): 'sandbox' | 'byod' | 'agos' {
  if (sandboxProvider === 'byod') return 'byod';
  if (sandboxProvider === 'agos') return 'agos';
  return 'sandbox';
}

function runtimeStateForPrepared(sandboxProvider: SandboxProvider) {
  return sandboxProvider === 'byod' ? 'config_required' : 'none';
}

interface LaunchTransactionLogInput {
  agenterId: string;
  userId: number;
  txHash: string;
  method: string;
  memo?: string | null;
  status: string;
  error?: string | null;
}

async function upsertLaunchTransactionLog(
  input: LaunchTransactionLogInput,
  env: Env,
) {
  const db = getDb(env);
  const existing = await db
    .select()
    .from(transactionLogs)
    .where(
      and(
        eq(transactionLogs.agenterId, input.agenterId),
        eq(transactionLogs.txHash, input.txHash),
        eq(transactionLogs.method, input.method),
      ),
    )
    .orderBy(desc(transactionLogs.id))
    .limit(1)
    .get();

  if (existing) {
    return db
      .update(transactionLogs)
      .set({
        memo: input.memo ?? null,
        status: input.status,
        error: input.error ?? null,
      })
      .where(eq(transactionLogs.id, existing.id))
      .returning()
      .get();
  }

  return db
    .insert(transactionLogs)
    .values({
      agenterId: input.agenterId,
      userId: input.userId,
      txHash: input.txHash,
      method: input.method,
      memo: input.memo ?? null,
      status: input.status,
      error: input.error ?? null,
    })
    .returning()
    .get();
}

async function verifyDeploymentOnChain(
  agenter: typeof agenterRecords.$inferSelect,
  body: ConfirmBody,
  env: Env,
): Promise<ethers.JsonRpcProvider> {
  const provider = new ethers.JsonRpcProvider(env.RPC_URL);
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(body.tx_hash),
    provider.getTransactionReceipt(body.tx_hash),
  ]);

  if (!tx) {
    throw new Error('Deploy transaction not found on-chain');
  }
  if (!receipt) {
    throw new Error('Deploy transaction not found on-chain. Wait for confirmation and retry.');
  }
  if (receipt.status !== 1) {
    throw new Error('Deploy transaction reverted');
  }
  if (!receipt.contractAddress) {
    throw new Error('Deploy transaction did not create a contract');
  }
  if (receipt.contractAddress.toLowerCase() !== body.token_address.toLowerCase()) {
    throw new Error('token_address does not match the contract deployed by this transaction');
  }
  if (
    body.deployer_address &&
    tx.from.toLowerCase() !== body.deployer_address.toLowerCase()
  ) {
    throw new Error('deployer_address does not match transaction sender');
  }

  const tokenAbi = getTokenArtifact().abi as ethers.InterfaceAbi;
  const tokenContract = new ethers.Contract(body.token_address, tokenAbi, provider);
  const deployedCode = await provider.getCode(body.token_address);
  if (!deployedCode || deployedCode === '0x') {
    throw new Error('No contract code at token_address');
  }

  let onChainAgentWallet: string;
  let onChainRegistry: string;
  try {
    [onChainAgentWallet, onChainRegistry] = await Promise.all([
      tokenContract.agentWallet() as Promise<string>,
      tokenContract.REGISTRY() as Promise<string>,
    ]);
  } catch {
    throw new Error('token_address is not a readable GooAgentToken deployment');
  }

  if (
    !agenter.agentWallet ||
    onChainAgentWallet.toLowerCase() !== agenter.agentWallet.toLowerCase()
  ) {
    throw new Error('Deployed token agent wallet does not match prepared agent wallet');
  }
  if (
    env.REGISTRY_ADDRESS &&
    onChainRegistry.toLowerCase() !== env.REGISTRY_ADDRESS.toLowerCase()
  ) {
    throw new Error('Deployed token registry does not match configured GooAgentRegistry');
  }

  return provider;
}

async function buildConfirmResponse(
  agenterId: string,
  txHash: string,
  env: Env,
  warnings: string[] = [],
) {
  const db = getDb(env);
  const agent = await db
    .select()
    .from(agenterRecords)
    .where(eq(agenterRecords.agenterId, agenterId))
    .get();

  if (!agent) {
    throw new Error('Agent not found after confirmation');
  }

  const sandboxProvider =
    (agent.sandboxProvider as SandboxProvider | null) || defaultSandboxProvider();
  const llmProvider =
    (agent.llmProvider as LlmProvider | null) ||
    defaultLlmProvider({
      NETWORK: env.NETWORK,
      BSC_LLM_ROUTER_URL: env.BSC_LLM_ROUTER_URL,
      LLM_API_KEY: env.LLM_API_KEY,
    });
  const isByod = sandboxProvider === 'byod';
  let byodPrivateKey: string | null = null;

  if (isByod && agent.encryptedPrivateKey) {
    byodPrivateKey = await decryptPrivateKey(
      agent.encryptedPrivateKey,
      env.JWT_SECRET,
    );
  }

  return {
    agent_id: agenterId,
    token_address: agent.tokenAddress || '',
    agent_wallet: agent.agentWallet,
    tx_hash: txHash,
    status: agent.status,
    registry_agent_id: null as string | null,
    erc8004_agent_id: agent.erc8004AgentId,
    mode: agent.launchMode,
    sandbox_provider: sandboxProvider,
    llm_provider: llmProvider,
    warnings,
    ...(byodPrivateKey
      ? {
          agent_wallet_private_key: byodPrivateKey,
          runtime_token: await generateRuntimeToken(
            agenterId,
            env.JWT_SECRET,
          ),
        }
      : {}),
  };
}

/** POST /api/launch/prepare */
app.post('/prepare', authRequired, async (c) => {
  const body = await c.req.json<PrepareBody>();
  const env = c.env;

  if (!body.agent_name || !body.token_symbol) {
    return c.json({ error: 'agent_name and token_symbol are required' }, 400);
  }
  if (body.token_symbol.length > 10) {
    return c.json({ error: 'symbol: max 10 chars' }, 400);
  }
  if (!env.SWAP_EXECUTOR_ADDRESS || !env.REGISTRY_ADDRESS || !env.ROUTER_ADDRESS) {
    return c.json(
      { error: 'Infrastructure contracts not configured. Ensure swap executor, registry, and router are deployed and configured.' },
      503,
    );
  }
  if (
    !ethers.isAddress(env.SWAP_EXECUTOR_ADDRESS) ||
    !ethers.isAddress(env.REGISTRY_ADDRESS) ||
    !ethers.isAddress(env.ROUTER_ADDRESS)
  ) {
    return c.json({ error: 'Infrastructure contract addresses are invalid.' }, 503);
  }

  try {
    const artifact = getTokenArtifact();

    const sandboxProvider =
      normalizeSandboxProvider(body.sandbox_provider) || defaultSandboxProvider();
    const llmProvider =
      normalizeLlmProvider(body.llm_provider) ||
      defaultLlmProvider({
        NETWORK: env.NETWORK,
        BSC_LLM_ROUTER_URL: env.BSC_LLM_ROUTER_URL,
        LLM_API_KEY: env.LLM_API_KEY,
      });
    const providerError = validateProviderSelection(sandboxProvider, llmProvider, {
      NETWORK: env.NETWORK,
      AGOS_API_URL: env.AGOS_API_URL,
    });
    if (providerError) {
      return c.json({ error: providerError }, 400);
    }
    const launchMode = getLaunchMode(sandboxProvider);

    const db = getDb(env);
    const userId = c.get('auth').user_id;
    const userExists = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!userExists) {
      return c.json({ error: 'User not found. Please log in again.' }, 401);
    }

    // Check for existing pending agent to prevent duplicate wallets on retry
    const existingPending = await db
      .select()
      .from(agenterRecords)
      .where(
        and(
          eq(agenterRecords.userId, userId),
          eq(agenterRecords.status, 'pending'),
        ),
      )
      .orderBy(desc(agenterRecords.id))
      .limit(1)
      .get();

    let agenterId: string;
    let agentWalletAddress: string;
    let encryptedPk: string;

    if (existingPending && existingPending.agentWallet && existingPending.encryptedPrivateKey) {
      // Reuse existing pending agent — same wallet, update form fields
      agenterId = existingPending.agenterId;
      agentWalletAddress = existingPending.agentWallet;
      encryptedPk = existingPending.encryptedPrivateKey;

      const createdAt = nowIso();
      await db
        .update(agenterRecords)
        .set({
          agentName: body.agent_name,
          agentIntro: body.agent_intro || null,
          tokenSymbol: body.token_symbol,
          genesisPrompt: body.genesis_prompt || null,
          agentInstructions: body.agent_instructions || null,
          skillsContent: body.skills_content || null,
          memoryContent: body.memory_content || null,
          agentFramework: body.framework || 'openclaw',
          launchMode,
          sandboxProvider,
          llmProvider,
          llmModel: body.llm_model || null,
          providerBundle: sandboxProvider === 'agos' ? 'agos' : null,
          ownerAddress: c.get('auth').wallet_address,
          launchState: 'draft',
          launchUpdatedAt: createdAt,
          runtimeState: runtimeStateForPrepared(sandboxProvider),
          runtimeUpdatedAt: createdAt,
          buybackPolicy: body.buyback_enabled
            ? JSON.stringify({
                enabled: true,
                thresholdBnb: body.buyback_threshold_bnb || '0.5',
              })
            : null,
          updatedAt: createdAt,
        })
        .where(eq(agenterRecords.id, existingPending.id));
    } else {
      // Fresh launch — create new agent record + wallet
      const newWallet = ethers.Wallet.createRandom();
      agenterId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      agentWalletAddress = newWallet.address;
      encryptedPk = await encryptPrivateKey(newWallet.privateKey, env.JWT_SECRET);

      const createdAt = nowIso();
      await db.insert(agenterRecords).values({
        userId,
        agenterId,
        contractAddress: '',
        status: 'pending',
        agentName: body.agent_name,
        agentIntro: body.agent_intro || null,
        tokenSymbol: body.token_symbol,
        agentWallet: agentWalletAddress,
        encryptedPrivateKey: encryptedPk,
        genesisPrompt: body.genesis_prompt || null,
        agentInstructions: body.agent_instructions || null,
        skillsContent: body.skills_content || null,
        memoryContent: body.memory_content || null,
        agentFramework: body.framework || 'openclaw',
        launchMode,
        sandboxProvider,
        llmProvider,
        llmModel: body.llm_model || null,
        providerBundle: sandboxProvider === 'agos' ? 'agos' : null,
        ownerAddress: c.get('auth').wallet_address,
        launchState: 'draft',
        launchUpdatedAt: createdAt,
        runtimeState: runtimeStateForPrepared(sandboxProvider),
        runtimeUpdatedAt: createdAt,
        chainState: 'unknown',
        chainStateUpdatedAt: createdAt,
        buybackPolicy: body.buyback_enabled
          ? JSON.stringify({
              enabled: true,
              thresholdBnb: body.buyback_threshold_bnb || '0.5',
            })
          : null,
      });
    }

    const circulationPct = Math.min(Math.max(body.circulation_pct ?? 10, 10), 100);
    const minContribution = parseFloat(env.MIN_CONTRIBUTION_BNB || '0.1');
    const contributionBnb = Math.max(parseFloat(body.contribution_bnb || String(minContribution)), minContribution);
    const treasuryBnbBps = parseInt(env.TREASURY_BNB_BPS || '3000');
    const treasuryBnb = contributionBnb * treasuryBnbBps / 10000;
    const lpBnb = contributionBnb - treasuryBnb;

    const TOTAL_SUPPLY = 1_000_000_000n;
    const lpTokens = (TOTAL_SUPPLY * BigInt(circulationPct - 5)) / 100n;

    const constructorArgs = buildTokenConstructorArgs(
      body,
      agentWalletAddress,
      artifact.abi,
      env,
    );

    const iface = new ethers.Interface(artifact.abi as ethers.InterfaceAbi);
    const encodedConstructor = iface.encodeDeploy(constructorArgs);
    const deployData = artifact.bytecode + encodedConstructor.slice(2);
    const deployBnb = treasuryBnb;

    const lpConfig = {
      router_address: env.ROUTER_ADDRESS,
      lp_token_amount: ethers.parseUnits(lpTokens.toString(), 18).toString(),
      lp_bnb_amount: ethers.parseEther(lpBnb.toFixed(18)).toString(),
      circulation_pct: circulationPct,
      contribution_bnb: contributionBnb.toString(),
    };

    const preparedResponse = {
      agenter_id: agenterId,
      agent_wallet: agentWalletAddress,
      abi: artifact.abi,
      deploy_data: deployData,
      chain_id: parseInt(env.CHAIN_ID || '97'),
      deploy_bnb: ethers.parseEther(deployBnb.toFixed(18)).toString(),
      lp_config: lpConfig,
      sandbox_provider: sandboxProvider,
      llm_provider: llmProvider,
    };

    const inserted = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenterId)).get();
    if (inserted) {
      await setLaunchState(env, inserted.id, {
        state: 'prepared',
        error: null,
        launchSession: stringifyLaunchSession({
          version: 1,
          draftPayload: body,
          prepared: {
            agenter_id: agenterId,
            agent_wallet: agentWalletAddress,
            deploy_data: deployData,
            deploy_bnb: preparedResponse.deploy_bnb,
            chain_id: preparedResponse.chain_id,
            lp_config: lpConfig,
            sandbox_provider: sandboxProvider,
            llm_provider: llmProvider,
          },
          progress: {},
          lastError: null,
          updatedAt: nowIso(),
        }),
      });
    }

    return c.json(preparedResponse);
  } catch (err) {
    console.error('Launch prepare error', err);
    return c.json({ error: (err as Error).message }, 500);
  }
});

interface LaunchEventBody {
  agenter_id: string;
  tx_hash: string;
  method: string;
  memo?: string;
  status?: string;
  error?: string;
}

/** POST /api/launch/event */
app.post('/event', authRequired, async (c) => {
  const body = await c.req.json<LaunchEventBody>();

  if (!body.agenter_id || !body.tx_hash || !body.method) {
    return c.json({ error: 'agenter_id, tx_hash, and method are required' }, 400);
  }

  const db = getDb(c.env);
  const agenter = await db
    .select()
    .from(agenterRecords)
    .where(eq(agenterRecords.agenterId, body.agenter_id))
    .get();
  if (!agenter) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  if (agenter.userId !== c.get('auth').user_id) {
    return c.json({ error: 'Not your agent' }, 403);
  }

  const log = await upsertLaunchTransactionLog(
    {
      agenterId: body.agenter_id,
      userId: c.get('auth').user_id,
      txHash: body.tx_hash,
      method: body.method,
      memo: body.memo ?? null,
      status: body.status || 'confirmed',
      error: body.error ?? null,
    },
    c.env,
  );

  if (body.method === 'deployGooAgentToken' && body.status === 'submitted') {
    await setLaunchState(c.env, agenter.id, {
      state: 'deploy_submitted',
      error: null,
      sessionPatch: { progress: { deploy_tx_hash: body.tx_hash } },
    });
  } else if (body.method === 'launchAddLiquidity' && body.status === 'submitted') {
    await setLaunchState(c.env, agenter.id, {
      state: 'liquidity_submitted',
      error: null,
      sessionPatch: { progress: { liquidity_tx_hash: body.tx_hash } },
    });
  } else if (body.method === 'launchApproveRouter' && body.status === 'submitted') {
    await setLaunchState(c.env, agenter.id, {
      state: agenter.launchState as any,
      error: null,
      sessionPatch: { progress: { approve_tx_hash: body.tx_hash } },
    });
  } else if (body.method === 'deployGooAgentToken' && body.status === 'confirmed') {
    await setLaunchState(c.env, agenter.id, {
      state: 'deployed',
      error: null,
      sessionPatch: { progress: { deploy_tx_hash: body.tx_hash } },
    });
  } else if (body.method === 'launchAddLiquidity' && body.status === 'confirmed') {
    await setLaunchState(c.env, agenter.id, {
      state: 'launched',
      error: null,
      sessionPatch: { progress: { liquidity_tx_hash: body.tx_hash } },
    });
  } else if (body.error) {
    await setLaunchState(c.env, agenter.id, {
      state: 'failed',
      error: body.error,
      sessionPatch: {
        progress: {
          deploy_tx_hash: body.method === 'deployGooAgentToken' ? body.tx_hash : undefined,
          approve_tx_hash: body.method === 'launchApproveRouter' ? body.tx_hash : undefined,
          liquidity_tx_hash: body.method === 'launchAddLiquidity' ? body.tx_hash : undefined,
        },
        lastError: body.error,
      },
    });
  }

  return c.json({ ok: true, event_id: log?.id });
});

interface ConfirmBody {
  agenter_id: string;
  token_address: string;
  tx_hash: string;
  deployer_address?: string;
}

/** POST /api/launch/confirm */
app.post('/confirm', authRequired, async (c) => {
  const body = await c.req.json<ConfirmBody>();
  const env = c.env;

  if (!body.agenter_id || !body.token_address || !body.tx_hash) {
    return c.json(
      { error: 'agenter_id, token_address, and tx_hash are required' },
      400,
    );
  }
  if (!ethers.isAddress(body.token_address)) {
    return c.json({ error: 'Invalid token_address' }, 400);
  }
  if (body.deployer_address && !ethers.isAddress(body.deployer_address)) {
    return c.json({ error: 'Invalid deployer_address' }, 400);
  }

  const userId = c.get('auth').user_id;
  const db = getDb(env);
  let deploymentPersisted = false;

  try {
    const agenter = await db
      .select()
      .from(agenterRecords)
      .where(eq(agenterRecords.agenterId, body.agenter_id))
      .get();

    if (!agenter) {
      return c.json({ error: 'Agent not found. Did you call /prepare first?' }, 404);
    }
    if (agenter.userId !== userId) {
      return c.json({ error: 'Not your agent' }, 403);
    }
    const isRetry =
      agenter.status === 'deployed' &&
      !!agenter.tokenAddress &&
      agenter.tokenAddress.toLowerCase() === body.token_address.toLowerCase();
    if (agenter.status !== 'pending' && !isRetry) {
      return c.json({ error: `Agent is already ${agenter.status}` }, 409);
    }
    if (
      agenter.status === 'deployed' &&
      agenter.tokenAddress &&
      agenter.tokenAddress.toLowerCase() !== body.token_address.toLowerCase()
    ) {
      return c.json({ error: 'Agent is already deployed with a different token address' }, 409);
    }

    let provider: ethers.JsonRpcProvider;
    try {
      provider = await verifyDeploymentOnChain(agenter, body, env);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    const warnings: string[] = [];

    const existingContract = await db
      .select()
      .from(contracts)
      .where(eq(contracts.address, body.token_address))
      .get();
    if (existingContract && existingContract.userId !== userId) {
      return c.json({ error: 'token_address is already linked to another user' }, 409);
    }

    if (!existingContract) {
      await db.insert(contracts).values({
        userId,
        name: agenter.tokenSymbol || body.token_address,
        address: body.token_address,
        deployerAddress: body.deployer_address || '',
        txHash: body.tx_hash,
        network: env.NETWORK,
      });
    } else if (!existingContract.deployerAddress && body.deployer_address) {
      await db
        .update(contracts)
        .set({ deployerAddress: body.deployer_address })
        .where(eq(contracts.id, existingContract.id));
    }

    if (!isRetry) {
      await db
        .update(agenterRecords)
        .set({
          contractAddress: body.token_address,
          tokenAddress: body.token_address,
          status: 'deployed',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agenterRecords.agenterId, body.agenter_id));
    }
    await setLaunchState(env, agenter.id, {
      state: 'deployed',
      error: null,
      sessionPatch: {
        progress: {
          token_address: body.token_address,
          deploy_tx_hash: body.tx_hash,
          deployer_address: body.deployer_address,
        },
        lastError: null,
      },
    });
    deploymentPersisted = true;

    // Registry registration (with timeout to prevent /confirm from hanging)
    const REGISTRY_TIMEOUT_MS = 30_000;
    let registryAgentId: string | null = null;
    if (agenter.encryptedPrivateKey && env.REGISTRY_ADDRESS && !agenter.genomeHash) {
      try {
        const registryResult = await Promise.race([
          (async () => {
            const privateKey = await decryptPrivateKey(
              agenter.encryptedPrivateKey!,
              env.JWT_SECRET,
            );
            const provider = new ethers.JsonRpcProvider(env.RPC_URL);
            const agentSigner = new ethers.Wallet(privateKey, provider);

            const tokenAbi = getTokenArtifact().abi as ethers.InterfaceAbi;
            const tokenContract = new ethers.Contract(
              body.token_address,
              tokenAbi,
              agentSigner,
            );

            const genomeURI = JSON.stringify({
              name: agenter.agentName,
              intro: agenter.agentIntro,
              framework: agenter.agentFramework || 'openclaw',
              genesis_prompt: agenter.genesisPrompt || '',
            });

            const regTx = await tokenContract.registerInRegistry(genomeURI);

            await upsertLaunchTransactionLog(
              {
                agenterId: body.agenter_id,
                userId,
                txHash: regTx.hash,
                method: 'registerInRegistry',
                memo: 'Submitted GooAgentRegistry registration',
                status: 'submitted',
              },
              env,
            );

            const regReceipt = await regTx.wait();

            let agentId: string | null = null;
            const registryAbi = getRegistryArtifact().abi as ethers.InterfaceAbi;
            const registryIface = new ethers.Interface(registryAbi);
            for (const log of regReceipt.logs) {
              try {
                const parsed = registryIface.parseLog({
                  topics: log.topics as string[],
                  data: log.data,
                });
                if (parsed?.name === 'AgentRegistered') {
                  agentId = parsed.args[0].toString();
                  break;
                }
              } catch {
                /* not a registry log */
              }
            }

            await upsertLaunchTransactionLog(
              {
                agenterId: body.agenter_id,
                userId,
                txHash: regTx.hash,
                method: 'registerInRegistry',
                memo: `Registered in GooAgentRegistry${agentId ? ` (agentId: ${agentId})` : ''}`,
                status: 'confirmed',
              },
              env,
            );

            const genomeHash = ethers.keccak256(ethers.toUtf8Bytes(genomeURI));
            await db
              .update(agenterRecords)
              .set({ genomeHash, updatedAt: new Date().toISOString() })
              .where(eq(agenterRecords.agenterId, body.agenter_id));

            // Transfer registry ownership from token contract to creator wallet
            if (agentId && agenter.ownerAddress) {
              const creatorWallet = agenter.ownerAddress;
              const transferTx = await tokenContract.transferRegistryOwnership(
                BigInt(agentId),
                creatorWallet,
              );
              await transferTx.wait();
              await upsertLaunchTransactionLog(
                {
                  agenterId: body.agenter_id,
                  userId,
                  txHash: transferTx.hash,
                  method: 'transferRegistryOwnership',
                  memo: `Registry ownership → ${creatorWallet}`,
                  status: 'confirmed',
                },
                env,
              );
            }

            return agentId;
          })(),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('Registry registration timed out')), REGISTRY_TIMEOUT_MS),
          ),
        ]);
        registryAgentId = registryResult;
      } catch (err) {
        console.error('Registry registration failed (will continue without it)', err);
        warnings.push(`Registry registration skipped: ${(err as Error).message}`);
      }
    }

    // ERC-8004 public registry registration (best-effort, non-blocking)
    let erc8004AgentId: number | null = null;
    const chainId = parseInt(env.CHAIN_ID || '97');
    if (agenter.encryptedPrivateKey && getERC8004Addresses(chainId) && !agenter.erc8004AgentId) {
      try {
        const erc8004Result = await Promise.race([
          (async () => {
            const privateKey = await decryptPrivateKey(
              agenter.encryptedPrivateKey!,
              env.JWT_SECRET,
            );
            const provider = new ethers.JsonRpcProvider(env.RPC_URL);
            const agentSigner = new ethers.Wallet(privateKey, provider);

            const result = await registerAgentOnERC8004(
              agentSigner,
              chainId,
              {
                agentName: agenter.agentName,
                agentIntro: agenter.agentIntro,
                agenterId: body.agenter_id,
                tokenAddress: body.token_address,
              },
              env.PUBLIC_API_URL,
            );

            await upsertLaunchTransactionLog(
              {
                agenterId: body.agenter_id,
                userId,
                txHash: result.txHash,
                method: 'erc8004Register',
                memo: `Registered on ERC-8004 IdentityRegistry (agentId: ${result.agentId})`,
                status: 'confirmed',
              },
              env,
            );

            return Number(result.agentId);
          })(),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('ERC-8004 registration timed out')), REGISTRY_TIMEOUT_MS),
          ),
        ]);
        erc8004AgentId = erc8004Result;

        if (erc8004AgentId) {
          await db
            .update(agenterRecords)
            .set({ erc8004AgentId, updatedAt: new Date().toISOString() })
            .where(eq(agenterRecords.agenterId, body.agenter_id));
        }
      } catch (err) {
        console.error('ERC-8004 registration failed (will continue without it)', err);
        warnings.push(`ERC-8004 registration skipped: ${(err as Error).message}`);
      }
    }

    await upsertLaunchTransactionLog(
      {
        agenterId: body.agenter_id,
        userId,
        txHash: body.tx_hash,
        method: 'deployGooAgentToken',
        memo: `Deployed GooAgentToken at ${body.token_address}`,
        status: 'confirmed',
      },
      env,
    );

    const refreshedAgent = await db
      .select()
      .from(agenterRecords)
      .where(eq(agenterRecords.agenterId, body.agenter_id))
      .get();
    if (refreshedAgent) {
      await db.update(agenterRecords).set({
        runtimeState: deriveRuntimeState(refreshedAgent),
        runtimeError: null,
        runtimeUpdatedAt: nowIso(),
      }).where(eq(agenterRecords.id, refreshedAgent.id));
      await setLaunchState(env, refreshedAgent.id, {
        state: 'launched',
        error: warnings.length ? warnings.join('; ') : null,
        sessionPatch: {
          progress: {
            token_address: body.token_address,
            deploy_tx_hash: body.tx_hash,
            deployer_address: body.deployer_address,
          },
          lastError: warnings.length ? warnings.join('; ') : null,
        },
      });
    }

    const response = await buildConfirmResponse(
      body.agenter_id,
      body.tx_hash,
      env,
      warnings,
    );
    return c.json({
      ...response,
      registry_agent_id: registryAgentId,
      erc8004_agent_id: erc8004AgentId ?? response.erc8004_agent_id,
    });
  } catch (err) {
    console.error('Launch confirm error', err);
    const failedAgent = await db
      .select()
      .from(agenterRecords)
      .where(eq(agenterRecords.agenterId, body.agenter_id))
      .get();
    if (failedAgent) {
      await setLaunchState(env, failedAgent.id, {
        state: 'failed',
        error: (err as Error).message,
        sessionPatch: {
          progress: {
            token_address: body.token_address,
            deploy_tx_hash: body.tx_hash,
            deployer_address: body.deployer_address,
          },
          lastError: (err as Error).message,
        },
      });
    }
    if (deploymentPersisted) {
      try {
        const fallback = await buildConfirmResponse(body.agenter_id, body.tx_hash, env, [
          `Confirm completed with partial errors: ${(err as Error).message}`,
        ]);
        return c.json(fallback);
      } catch {
        return c.json({ error: (err as Error).message }, 500);
      }
    }
    try {
      const fallback = await buildConfirmResponse(body.agenter_id, body.tx_hash, env, [
        `Confirm completed with partial errors: ${(err as Error).message}`,
      ]);
      if (fallback.status === 'deployed') {
        return c.json(fallback);
      }
    } catch { /* ignore fallback failure */ }
    return c.json({ error: (err as Error).message }, 500);
  }
});

/** GET /api/launch/pending — check if user has an unfinished launch */
app.get('/pending', authRequired, async (c) => {
  const userId = c.get('auth').user_id;
  const db = getDb(c.env);
  const pending = await db
    .select({
      agenterId: agenterRecords.agenterId,
      agentName: agenterRecords.agentName,
      tokenSymbol: agenterRecords.tokenSymbol,
      launchState: agenterRecords.launchState,
    })
    .from(agenterRecords)
    .where(
      and(
        eq(agenterRecords.userId, userId),
        eq(agenterRecords.status, 'pending'),
        inArray(agenterRecords.launchState, [
          'prepared',
          'deploy_submitted',
          'deployed',
          'liquidity_submitted',
          'failed',
        ]),
      ),
    )
    .orderBy(desc(agenterRecords.id))
    .limit(1)
    .get();
  return c.json({ pending: pending || null });
});

export { app as launchRoutes };
