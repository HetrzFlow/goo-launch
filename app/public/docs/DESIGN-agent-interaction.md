# Design: Agent Interaction via goo-example UI

## Problem Statement

Currently the goo-example frontend cannot effectively interact with agents running in sandbox/BYOD environments:

1. **Chat doesn't go through OpenClaw** -- `/api/agents/:id/chat` calls the LLM API directly, bypassing the OpenClaw gateway inside the sandbox, so the agent has no context, memory, or tool-calling capabilities
2. **BYOD is completely disconnected** -- In BYOD mode, users self-host OpenClaw, and the goo-example UI cannot connect
3. **Sandbox state is invisible** -- The server has goo-core-status / restart-goo-core APIs, but the frontend doesn't call them
4. **OpenClaw gateway token is not persisted** -- The token generated during Cloud sandbox creation is not saved to DB, making subsequent authentication impossible
5. **Sandbox creation timing issue** -- `setupGooCoreInSandbox` is fire-and-forget, the gateway token is generated inside the function but not stored back, so the frontend cannot connect immediately after sandbox creation

---

## Critical Issue: Sandbox Creation Timing

### Current Flow (Problematic)

```
POST /api/sandbox/create
  │
  ├─ 1. forwardToManager → sandbox-manager → returns { sandboxId, domain, gatewayUrl }
  │     └─ gatewayUrl may contain token, but only stored in sandboxUrl (token not extracted separately)
  │
  ├─ 2. prisma.update → stores sandboxId + sandboxUrl (token may be in the URL but not independently usable)
  │
  ├─ 3. syncFilesToSandbox → sync soul.md/agent.md and other files
  │
  ├─ 4. setupGooCoreInSandbox (FIRE-AND-FORGET) ← root cause
  │     ├─ git clone goo-core + npm install (3 min!)
  │     ├─ write goo-core .env
  │     ├─ write openclaw.json (gateway auth config is written here)
  │     │   └─ auth: { mode: 'token' } — but where does the token come from?
  │     │      sandbox-manager's returned gatewayUrl contains the token
  │     │      but openclaw.json writes the gateway's internal config
  │     │      external access needs the token returned by sandbox-manager
  │     ├─ write system-prompt.txt
  │     └─ start goo-core sidecar
  │
  └─ 5. res.status(201) → returns to frontend
        └─ frontend gets sandbox_id, but:
           - OpenClaw is not configured yet (step 4 is still running)
           - gateway token is not saved to DB
           - cannot chat immediately
```

### Target Flow (After Fix)

```
POST /api/sandbox/create
  │
  ├─ 1. Pre-generate gatewayToken (for OpenClaw auth)
  │
  ├─ 2. forwardToManager → create sandbox
  │     └─ Pass in gatewayToken so sandbox-manager configures it into OpenClaw
  │        or: extract token from the returned gatewayUrl
  │
  ├─ 3. prisma.update → store sandboxId + sandboxUrl + gatewayUrl + gatewayToken
  │     └─ gateway connection info is immediately available
  │
  ├─ 4. syncFilesToSandbox → sync creator files
  │
  ├─ 5. injectOpenClawConfig (AWAIT, not fire-and-forget)
  │     ├─ write openclaw.json (with correct gateway auth + LLM provider config)
  │     ├─ write system-prompt.txt
  │     └─ set OPENCLAW_GATEWAY_TOKEN environment variable or write to config
  │     ⚡ Key: this step must complete before returning, to ensure OpenClaw config is correct
  │
  ├─ 6. installGooCoreInBackground (fire-and-forget is OK here)
  │     ├─ git clone goo-core + npm install
  │     ├─ write goo-core .env
  │     └─ start goo-core sidecar
  │     💡 goo-core being slow is fine, it doesn't affect chat functionality
  │
  └─ 7. res.status(201) → returns to frontend
        └─ frontend gets sandbox_id + gateway is available
           ✅ Can immediately chat via OpenClaw gateway
           ✅ goo-core is installing in the background (on-chain features available shortly)
```

**Core change: split `setupGooCoreInSandbox` into two steps**
1. `injectOpenClawConfig` -- **synchronous await**, only writes config files, completes in seconds
2. `installAndStartGooCore` -- **fire-and-forget**, slow operations like git clone + npm install

---

## Architecture Overview

```
                        goo-example UI (frontend)
                              │
                    POST /api/agents/:id/chat
                              │
                      goo-example server
                         /          \
                        /            \
            [has gatewayUrl          [no gateway]
             + gatewayToken?]             \
                  /                    Direct LLM call
       Proxy to OpenClaw          (current behavior,
       gateway via server          stateless fallback)
              │
    ┌─────────┴─────────┐
    │                   │
  Cloud Sandbox      BYOD (registered URL)
  (sandbox-manager)  (user's VPS)
    │                   │
  OpenClaw :18789    OpenClaw :18789
  goo-core sidecar   goo-core sidecar
  x402-proxy         x402-proxy
```

---

## Design Decisions

### D1: Chat always goes through server proxy, never let frontend connect directly to OpenClaw

**Rationale:**
- OpenClaw gateway token is a sensitive credential and should not be exposed to the browser
- BYOD user's OpenClaw may be on a private network, frontend cannot connect directly
- Server proxy can uniformly handle authentication, logging, and rate limiting
- Avoids CORS issues

### D2: BYOD users register their endpoint URL via UI

**Rationale:**
- BYOD user's OpenClaw is on their own VPS; goo-example server needs the address to proxy
- Connectivity is verified during registration (calls `/healthz`)
- Users can update the URL at any time

### D3: OpenClaw gateway token is encrypted and stored in DB

**Rationale:**
- Cloud sandbox: extracted from the `gatewayUrl` returned by sandbox-manager
- BYOD: provided by the user during registration
- Server proxy needs the token as Bearer auth when chatting
- Reuses `encryptPrivateKey` / `decryptPrivateKey` for encrypted storage

### D4: Split sandbox setup into config injection (synchronous) + goo-core install (asynchronous)

**Rationale:**
- OpenClaw config writing is fast (exec writes files, completes in seconds), must complete before returning
- goo-core install is slow (git clone + npm install, 2-3 min), can run in background
- Users should be able to chat immediately after creating a sandbox (via OpenClaw gateway)
- goo-core is an on-chain economic sidecar, doesn't affect chat functionality, a few minutes delay is fine

---

## Schema Changes

```prisma
model AgenterRecord {
  // ... existing fields ...

  // New fields
  gatewayToken        String?  @map("gateway_token")       // OpenClaw gateway auth token (encrypted)
  gatewayUrl          String?  @map("gateway_url")          // OpenClaw HTTP gateway base URL
  gooCoreStatus       String?  @map("goo_core_status") @db.VarChar(16)  // running|stopped|installing|error
  // sandboxUrl remains — public-facing URL (for iframe/link to OpenClaw UI)
  // gatewayUrl — internal URL server uses to proxy chat (may differ from sandboxUrl)
}
```

---

## Server Changes

### 1. Split `setupGooCoreInSandbox`

```typescript
// sandbox.ts

/**
 * Inject OpenClaw configuration into sandbox. MUST await before returning to client.
 * Fast operation: just writes config files via exec.
 */
async function injectOpenClawConfig(
  agenter: AgenterRecord,
  gatewayToken: string,
): Promise<void> {
  const id = agenter.agenterId;
  const agentName = agenter.agentName || id.slice(0, 8);

  // Build system prompt
  const promptParts = [
    `You are ${agentName}.`,
    agenter.genesisPrompt,
    agenter.agentInstructions || agenter.agentIntro,
    agenter.skillsContent ? `## Skills\n\n${agenter.skillsContent}` : null,
    agenter.memoryContent ? `## Memory\n\n${agenter.memoryContent}` : null,
  ].filter(Boolean);

  // Determine LLM provider config
  const llmBaseUrl = config.bscLlmRouterUrl || config.llmApiUrl || 'https://openrouter.ai/api/v1';
  const llmApiKey = config.bscLlmRouterUrl ? 'x402' : (config.llmApiKey || 'dummy');
  const llmModel = config.llmModel || 'deepseek/deepseek-chat';

  const openclawConfig = {
    agents: {
      defaults: { model: { primary: `goo-llm/${llmModel.replace('/', '--')}` } },
      list: [{
        id: 'main',
        identity: { name: agentName },
        workspace: '/home/user/agent-data',
        model: { primary: `goo-llm/${llmModel.replace('/', '--')}` },
        customInstructions: promptParts.join('\n\n'),
      }],
    },
    models: {
      providers: {
        'goo-llm': {
          baseUrl: llmBaseUrl.replace(/\/$/, '') + (llmBaseUrl.includes('/v1') ? '' : '/v1'),
          apiKey: llmApiKey,
          api: 'openai-completions',
          models: [{
            id: llmModel.replace('/', '--'),
            name: llmModel,
            reasoning: true, input: ['text'],
            contextWindow: 64000, maxTokens: 8192,
          }],
        },
      },
    },
    gateway: {
      mode: 'local',
      bind: 'lan',
      auth: { mode: 'token' },
      controlUi: {
        allowInsecureAuth: true,
        dangerouslyDisableDeviceAuth: true,
        allowedOrigins: ['*'],  // ← added to allow iframe embed
      },
      http: {
        endpoints: { chatCompletions: { enabled: true } },
      },
    },
  };

  // Write openclaw.json
  const configB64 = Buffer.from(JSON.stringify(openclawConfig, null, 2)).toString('base64');
  await execInSandbox(id,
    `mkdir -p /home/user/.openclaw && echo '${configB64}' | base64 -d > /home/user/.openclaw/openclaw.json`,
  );

  // Write system-prompt.txt to workspace
  if (promptParts.length > 0) {
    const promptB64 = Buffer.from(promptParts.join('\n\n')).toString('base64');
    await execInSandbox(id, `echo '${promptB64}' | base64 -d > /home/user/agent-data/system-prompt.txt`);
  }

  // Set gateway token as environment variable for OpenClaw to use
  // (OpenClaw reads OPENCLAW_GATEWAY_TOKEN for auth)
  await execInSandbox(id,
    `echo 'export OPENCLAW_GATEWAY_TOKEN=${gatewayToken}' >> /home/user/.bashrc`,
  );

  console.log(`[Sandbox] OpenClaw config injected for ${id}`);
}

/**
 * Install goo-core and start sidecar. Fire-and-forget.
 * Slow operation: git clone + npm install can take 2-3 min.
 */
async function installAndStartGooCore(agenter: AgenterRecord): Promise<void> {
  const id = agenter.agenterId;

  // Update status
  await prisma.agenterRecord.update({
    where: { agenterId: id },
    data: { gooCoreStatus: 'installing' },
  });

  // 1. Install goo-core
  const { status: installStatus } = await execInSandbox(id,
    `bash -lc 'cd /home/user && if [ -d goo-core ]; then cd goo-core && git pull; else git clone https://github.com/bond/goo-core.git && cd goo-core; fi && npm install --production 2>&1 | tail -5'`,
    180_000,
  );
  if (installStatus >= 400) {
    await prisma.agenterRecord.update({
      where: { agenterId: id }, data: { gooCoreStatus: 'error' },
    });
    return;
  }

  // 2. Write goo-core .env
  const privateKey = agenter.encryptedPrivateKey ? decryptPrivateKey(agenter.encryptedPrivateKey) : '';
  const envLines = [
    `RPC_URL=${config.rpcUrl}`, `CHAIN_ID=${config.chainId}`,
    `TOKEN_ADDRESS=${agenter.tokenAddress || ''}`,
    `WALLET_PRIVATE_KEY=${privateKey}`,
    `DATA_DIR=/home/user/agent-data`,
    `HEARTBEAT_INTERVAL_MS=30000`, `MAX_TOOL_ROUNDS=5`,
  ];
  if (config.bscLlmRouterUrl) {
    envLines.push(`LLM_API_URL=${config.bscLlmRouterUrl}`, `LLM_API_KEY=x402`,
      `LLM_MODEL=${config.llmModel}`, `X402_NETWORK=${config.x402Network}`);
  } else if (config.llmApiKey) {
    envLines.push(`LLM_API_URL=${config.llmApiUrl}`, `LLM_API_KEY=${config.llmApiKey}`,
      `LLM_MODEL=${config.llmModel}`);
  }
  const envB64 = Buffer.from(envLines.join('\n')).toString('base64');
  await execInSandbox(id, `echo '${envB64}' | base64 -d > /home/user/goo-core/.env`);

  // 3. Start sidecar
  await execInSandbox(id,
    `bash -c 'cd /home/user/goo-core && nohup npx tsx src/index.ts >> /var/log/goo-core.log 2>&1 & echo "PID: $!"'`,
    15_000,
  );

  await prisma.agenterRecord.update({
    where: { agenterId: id }, data: { gooCoreStatus: 'running' },
  });
  console.log(`[Sandbox/goo-core] Installed and started for ${id}`);
}
```

### 2. Modify `POST /api/sandbox/create`

```typescript
router.post('/create', authRequired, async (req, res) => {
  // ... existing validation ...

  // 1. Create sandbox via manager
  const { status, data, responseHeaders } = await forwardToManager('POST', '/api/v1/sandboxes', {
    agentId: agenter.agenterId,
    agentName: agenter.agentName || agenter.agenterId.slice(0, 8),
    tokenAddress: agenter.tokenAddress || '0x0',
    walletAddress: agenter.agentWallet || '',
    walletPrivateKey: agenter.encryptedPrivateKey ? decryptPrivateKey(agenter.encryptedPrivateKey) : '',
    genome,
  }, paymentHeaders);

  // ... handle 402 / error ...

  const result = data as { agentId: string; sandboxId: string; domain: string; gatewayUrl?: string };

  // 2. Extract gateway token from URL or generate one
  let gatewayToken: string | null = null;
  let gatewayBaseUrl: string | null = null;

  if (result.gatewayUrl) {
    try {
      const url = new URL(result.gatewayUrl);
      gatewayToken = url.searchParams.get('token');
      gatewayBaseUrl = `${url.protocol}//${url.host}`;
    } catch {
      // gatewayUrl might not be a parseable URL, use as-is
      gatewayBaseUrl = result.gatewayUrl.replace(/\/+$/, '');
    }
  } else if (result.domain) {
    gatewayBaseUrl = `https://${result.domain}`;
  }

  // If no token from sandbox-manager, generate one and inject it
  if (!gatewayToken) {
    gatewayToken = crypto.randomBytes(32).toString('hex');
  }

  // 3. Persist ALL connection info immediately
  const updated = await prisma.agenterRecord.update({
    where: { agenterId: agenter_id },
    data: {
      sandboxId: result.sandboxId,
      sandboxUrl: result.domain ? `https://${result.domain}` : null,
      gatewayUrl: gatewayBaseUrl,
      gatewayToken: encryptPrivateKey(gatewayToken),  // encrypted
      framework: agenter.agentFramework || 'openclaw',
      gooCoreStatus: 'pending',  // will change to 'installing' then 'running'
    },
  });

  // 4. Sync creator files
  const filesSynced = await syncFilesToSandbox(updated);

  // 5. Inject OpenClaw config — AWAIT (fast, just writes files)
  try {
    await injectOpenClawConfig(updated, gatewayToken);
  } catch (err) {
    console.error(`[Sandbox] Config injection failed for ${agenter_id}:`, (err as Error).message);
    // Non-fatal but log it — chat won't work until config is injected
  }

  // 6. Install goo-core — FIRE AND FORGET (slow, 2-3 min)
  installAndStartGooCore(updated).catch(err => {
    console.error(`[Sandbox/goo-core] Install failed for ${agenter_id}:`, (err as Error).message);
  });

  // 7. Return — frontend can immediately start chatting via OpenClaw
  res.status(201).json({
    sandbox_id: result.sandboxId,
    sandbox_url: result.domain ? `https://${result.domain}` : null,
    gateway_ready: true,  // OpenClaw config is injected
    goo_core_status: 'installing',  // still installing in background
    files_synced: filesSynced,
  });
});
```

### 3. Modify `POST /api/agents/:id/chat`

```typescript
router.post('/:id/chat', authRequired, async (req, res) => {
  const { message, history } = req.body as {
    message?: string;
    history?: Array<{ role: string; content: string }>;
  };
  // ... validation ...

  const agent = await findAgentByParam(String(req.params.id));
  if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }

  // --- Route A: Through OpenClaw gateway (agent has context + tools) ---
  if (agent.gatewayUrl && agent.gatewayToken) {
    try {
      const gatewayToken = decryptPrivateKey(agent.gatewayToken);  // reuse decrypt

      // Build messages with optional history
      const systemPrompt = buildSystemPrompt(agent);
      const messages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...(history || []),
        { role: 'user', content: message!.trim() },
      ];

      const response = await fetch(`${agent.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({
          model: 'bsc-llm/auto',
          messages,
          max_tokens: 2048,
          stream: false,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        // Gateway unreachable or error — fallback to direct LLM
        console.warn(`[Chat] OpenClaw gateway returned ${response.status}, falling back to direct LLM`);
        // ... fall through to Route B ...
      } else {
        const data = await response.json();
        await prisma.agenterRecord.update({
          where: { id: agent.id },
          data: { llmCallsCount: { increment: 1 } },
        });

        res.json({
          reply: data.choices?.[0]?.message?.content || '(no response)',
          model: response.headers.get('x-bsc-llm-router-model') || config.llmModel,
          via: 'openclaw',
          tier: response.headers.get('x-bsc-llm-router-tier') || null,
        });
        return;
      }
    } catch (err) {
      console.warn(`[Chat] OpenClaw proxy failed:`, (err as Error).message);
      // Fall through to direct LLM
    }
  }

  // --- Route B: Direct LLM call (fallback, no agent context) ---
  const llmApiUrl = config.bscLlmRouterUrl || config.llmApiUrl;
  const llmApiKey = config.bscLlmRouterUrl ? 'x402' : config.llmApiKey;
  if (!llmApiKey) { res.status(503).json({ error: 'LLM not configured' }); return; }

  const systemParts = buildSystemPromptParts(agent);
  const messages = [
    { role: 'system', content: systemParts.join('\n\n') },
    ...(history || []),
    { role: 'user', content: message!.trim() },
  ];

  const response = await fetch(`${llmApiUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmApiKey}` },
    body: JSON.stringify({ model: config.llmModel, messages, max_tokens: 1024, temperature: 0.7 }),
    signal: AbortSignal.timeout(60000),
  });

  // ... existing error handling + response ...
  res.json({ reply, model: config.llmModel, via: 'direct' });
});
```

### 4. Add `POST /api/agents/:id/register-gateway`

```typescript
/** BYOD users register their self-hosted OpenClaw gateway. */
router.post('/:id/register-gateway', authRequired, async (req, res) => {
  const { gateway_url, gateway_token } = req.body;
  if (!gateway_url || !gateway_token) {
    res.status(400).json({ error: 'gateway_url and gateway_token are required' });
    return;
  }

  const agent = await findAgentByParam(String(req.params.id));
  if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }
  if (agent.userId !== req.auth!.user_id) {
    res.status(403).json({ error: 'Not your agent' }); return;
  }

  // Verify connectivity
  const cleanUrl = gateway_url.replace(/\/+$/, '');
  try {
    const healthRes = await fetch(`${cleanUrl}/healthz`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!healthRes.ok) {
      res.status(502).json({ error: `Gateway health check failed: HTTP ${healthRes.status}` });
      return;
    }
  } catch (err) {
    res.status(502).json({ error: `Cannot reach gateway: ${(err as Error).message}` });
    return;
  }

  // Verify token works by calling /v1/models
  try {
    const modelsRes = await fetch(`${cleanUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${gateway_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (modelsRes.status === 401 || modelsRes.status === 403) {
      res.status(400).json({ error: 'Gateway token is invalid (auth failed)' });
      return;
    }
  } catch {
    // Non-fatal — some gateways may not support /v1/models
  }

  await prisma.agenterRecord.update({
    where: { id: agent.id },
    data: {
      gatewayUrl: cleanUrl,
      gatewayToken: encryptPrivateKey(gateway_token),
    },
  });

  res.json({ message: 'Gateway registered', gateway_url: cleanUrl, verified: true });
});
```

### 5. Add `GET /api/agents/:id/runtime-status`

```typescript
/** Unified runtime status for both Cloud and BYOD agents. */
router.get('/:id/runtime-status', authRequired, async (req, res) => {
  const agent = await findAgentByParam(String(req.params.id));
  if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }

  const result: any = {
    mode: agent.launchMode,
    sandbox: { id: agent.sandboxId, url: agent.sandboxUrl, state: 'none' },
    gateway: { url: agent.gatewayUrl, reachable: false, token_configured: !!agent.gatewayToken },
    goo_core: { status: agent.gooCoreStatus || 'unknown', last_log: '' },
  };

  // Check gateway health
  if (agent.gatewayUrl) {
    try {
      const healthRes = await fetch(`${agent.gatewayUrl}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      result.gateway.reachable = healthRes.ok;
    } catch { /* unreachable */ }
  }

  // For cloud agents with sandbox: check sandbox state + goo-core via exec
  if (agent.sandboxId && config.sandboxManagerUrl) {
    try {
      const { status, data } = await forwardToManager(
        'GET', `/api/v1/sandboxes/${agent.agenterId}`,
      );
      if (status < 400) {
        result.sandbox.state = (data as any).state || 'running';
      }
    } catch { result.sandbox.state = 'unknown'; }

    // Check goo-core process
    try {
      const { data } = await execInSandbox(agent.agenterId,
        `bash -c 'pgrep -f "goo-core/src/index" > /dev/null && echo running || echo stopped'`,
        10_000,
      );
      const output = ((data as any).stdout || '').trim();
      result.goo_core.status = output.includes('running') ? 'running' : 'stopped';

      const { data: logData } = await execInSandbox(agent.agenterId,
        `tail -10 /var/log/goo-core.log 2>/dev/null || echo 'No logs yet'`,
        10_000,
      );
      result.goo_core.last_log = ((logData as any).stdout || '').trim();
    } catch { /* exec failed */ }
  }

  res.json(result);
});
```

---

## Frontend Changes

### 1. Agent Detail Page — Enhanced Chat Card

```
+-----------------------------------------------------+
| Chat with Agent                                      |
|-----------------------------------------------------|
| [OpenClaw Connected] or [Direct LLM (no context)]   |
|                                                      |
| ┌─────────────────────────────────────────────────┐  |
| │ Send a message to your agent.                   │  |
| │                                                 │  |
| │                    What's your treasury balance? │  |
| │                                                 │  |
| │ My treasury currently has 8.5 USDT with a burn  │  |
| │ rate of 1 USDT/day, giving me ~8.5 days of      │  |
| │ runway.                                         │  |
| │                    [gemini-2.5-flash · SIMPLE]   │  |
| └─────────────────────────────────────────────────┘  |
|                                                      |
| [________________ Type a message... _______________]  |
| [Send]                                               |
+-----------------------------------------------------+
```

**Changes to `buildChatCard`:**
- Display mode indicator (OpenClaw Connected / Direct LLM)
- Show model + tier below each agent reply
- Support conversation history (`chatHistory` array, sent with POST body)
- 120s timeout for OpenClaw (tool calls are slow)

### 2. Agent Detail Page — Runtime Status Card (NEW)

```
+-----------------------------------------------------+
| Runtime                                    [Refresh] |
|-----------------------------------------------------|
| Mode         │ Cloud (Managed)                       |
| Sandbox      │ sb-abc123  RUNNING                    |
| Gateway      │ https://abc.sandbox.io  ✓ reachable   |
| goo-core     │ RUNNING                               |
|-----------------------------------------------------|
| Last goo-core log:                                   |
| [Pulse] emitPulse tx: 0xa3f... (block 45231)        |
|-----------------------------------------------------|
| [Pause] [Resume] [Restart goo-core] [Destroy]       |
+-----------------------------------------------------+
```

**For BYOD agents without gateway registered:**

```
+-----------------------------------------------------+
| Runtime                                              |
|-----------------------------------------------------|
| Mode         │ BYOD (Self-Host)                      |
| Gateway      │ Not registered                        |
|-----------------------------------------------------|
| Register your OpenClaw gateway to enable chat:       |
|                                                      |
| Gateway URL:   [https://my-vps:18789_____________]   |
| Gateway Token: [paste from .env__________________]   |
|                                                      |
| [Register & Verify]                                  |
+-----------------------------------------------------+
```

### 3. Agent Detail Page — OpenClaw Terminal Embed (Optional)

```
+-----------------------------------------------------+
| OpenClaw Terminal                        [Open New ↗]|
|-----------------------------------------------------|
| ┌─────────────────────────────────────────────────┐  |
| │ <iframe src="{sandboxUrl}">                     │  |
| │                                                 │  |
| │   (OpenClaw control UI)                         │  |
| │                                                 │  |
| └─────────────────────────────────────────────────┘  |
+-----------------------------------------------------+
```

### 4. Launch Page — BYOD Success Enhancement

After the existing BYOD success page's Docker setup instructions, add:

```
+-----------------------------------------------------+
| Connect to goo-example                               |
|-----------------------------------------------------|
| After starting your agent, register the gateway     |
| so you can chat from this dashboard:                |
|                                                      |
| Gateway URL:   [https://________________:18789]      |
| Gateway Token: [_______________________________]     |
|                                                      |
| (Token is in your .env file as                      |
|  OPENCLAW_GATEWAY_TOKEN)                            |
|                                                      |
| [Register & Verify]                                  |
+-----------------------------------------------------+
```

---

## Chat History Design

### Client-side history (Phase 1)

```typescript
// agent-detail.ts
let chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

async function sendMessage(text: string): Promise<void> {
  chatHistory.push({ role: 'user', content: text });

  const resp = await api('POST', `/api/agents/${id}/chat`, {
    message: text,
    history: chatHistory.slice(-20),  // Cap at 20 messages
  });

  chatHistory.push({ role: 'assistant', content: resp.reply });
  // Render with model/tier metadata
}
```

- Simple, no DB changes needed
- History is lost on page refresh (acceptable)
- Optional: persist current session via `sessionStorage`

---

## Implementation Plan

### Phase 1: Sandbox Creation Fix + Chat Proxy (Core)

**Goal:** Chat is available immediately after sandbox creation; BYOD can register gateway

| Step | File | Change |
|------|------|--------|
| 1.1 | `prisma/schema.prisma` | Add `gatewayUrl`, `gatewayToken`, `gooCoreStatus` |
| 1.2 | `server/src/routes/sandbox.ts` | Split `setupGooCoreInSandbox` into `injectOpenClawConfig` (sync) + `installAndStartGooCore` (async) |
| 1.3 | `server/src/routes/sandbox.ts` | `POST /create` extracts gateway token, awaits config injection, fire-and-forget goo-core |
| 1.4 | `server/src/routes/agents.ts` | Modify `POST /:id/chat` -- prefer OpenClaw gateway, fallback to direct LLM |
| 1.5 | `server/src/routes/agents.ts` | Add `POST /:id/register-gateway` -- BYOD registration |
| 1.6 | `frontend/src/agent-detail.ts` | Chat card shows mode + model metadata + history |

### Phase 2: Runtime Status Dashboard

| Step | File | Change |
|------|------|--------|
| 2.1 | `server/src/routes/agents.ts` | Add `GET /:id/runtime-status` |
| 2.2 | `frontend/src/agent-detail.ts` | Runtime Status card |
| 2.3 | `frontend/src/agent-detail.ts` | BYOD gateway registration form |
| 2.4 | `frontend/src/agent-detail.ts` | goo-core restart / sandbox pause/resume buttons |

### Phase 3: OpenClaw UI Embed + Launch Flow

| Step | File | Change |
|------|------|--------|
| 3.1 | `frontend/src/agent-detail.ts` | iframe embed card |
| 3.2 | `frontend/src/launch.ts` | BYOD success page gateway registration |
| 3.3 | `deploy/byod/openclaw.json` | Add `allowedOrigins` |

### Phase 4 (Future): Streaming + Server-side History

- `stream: true` SSE support
- `chat_messages` table for persisting conversations
- Multi-agent persona selection

---

## Security Considerations

1. **Gateway token encrypted storage** -- Reuses `encryptPrivateKey` / `decryptPrivateKey`
2. **BYOD URL validation** -- Calls `/healthz` during registration to confirm it's an OpenClaw gateway
3. **Safe degradation when gateway is unreachable** -- Falls back to direct LLM, does not expose error details
4. **Rate limiting** -- Add rate limits to chat proxy to prevent abuse of OpenClaw gateway
5. **Token not exposed to frontend** -- All gateway communication happens server-side, frontend only sees `via: 'openclaw'`

---

## Open Questions

1. **Sandbox-manager `gatewayUrl` format** -- Does the returned URL always contain `?token=xxx`? Or is the token passed through other means? Extraction logic needs to be adjusted after confirmation.

2. **OpenClaw `customInstructions` field** -- Is it actually read? Alternative: write `CLAUDE.md` / `README.md` to the workspace.

3. **Whether token is lost after OpenClaw restart** -- Is writing `OPENCLAW_GATEWAY_TOKEN` to `.bashrc` sufficient? It may need to be written to the OpenClaw config file or an environment variable file.

4. **How OpenClaw starts in e2b sandbox** -- How is OpenClaw started in the e2b sandbox created by sandbox-manager? Is it pre-installed in the e2b template or installed via a setup script? This determines the token injection method.
