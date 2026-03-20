/**
 * AGOS Platform API Client
 *
 * Typed HTTP client for https://claw-api.agos.fun
 * Handles auth (SIWE JWT), agents, funding, wallets, deployments, and LLM proxy.
 */

const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgosResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AgosAgent {
  id: string;
  name: string;
  status: string;
  walletAddress: string;
  templateId: string | null;
  image: string | null;
  resourceClass: string;
  endpoint: string | null;
  gatewayToken: string | null;
  createdAt: string;
  updatedAt?: string;
  deployment?: AgosDeployment | null;
}

export interface AgosDeployment {
  id: string;
  status: string; // pending | provisioning | installing | running | failed | terminated
  publicIp: string | null;
  defaultPassword: string | null;
  region: string;
  plan: string;
  hourlyRateAiou: string;
  totalCostAiou: string;
  lastError: string | null;
  createdAt: string;
  updatedAt?: string;
  retryCount?: number;
}

export interface AgosBalance {
  availableBalance: string;
  frozenBalance: string;
  spentTotal: string;
}

export interface AgosCreateAgentResult {
  agent: AgosAgent;
  apiKey: string;
  minBalanceRequired: number;
  minInitialFund: number;
  setupFee: number;
}

export interface AgosFundChallenge {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    namespace: string;
    networkId: string;
    resource: string;
    payTo: string;
    asset: string;
    maxAmountRequired: string;
    extra: Record<string, unknown>;
  }>;
}

export interface AgosFundSettleResult {
  txHash: string;
  amount: string;
  from: string;
  to: string;
  status: string;
  deployTriggered: boolean;
}

export interface AgosAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AgosAgentConfig {
  minBalanceAiou: string;
  setupFeeAiou: string;
  minInitialFundAiou: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AgosClient {
  private baseUrl: string;
  private accessToken: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  // ---- low-level fetch ----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { auth?: string; rawResponse?: boolean },
  ): Promise<{ status: number; data: T; headers: Record<string, string> }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const token = opts?.auth ?? this.accessToken;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });

    // 402 returns x402 challenge — return raw
    if (res.status === 402 || opts?.rawResponse) {
      const data = await res.json().catch(() => ({})) as T;
      return { status: res.status, data, headers: responseHeaders };
    }

    let data: T;
    const rawText = await res.text();
    try {
      data = JSON.parse(rawText) as T;
    } catch {
      data = { ok: false, error: `HTTP ${res.status}: ${rawText.slice(0, 200) || res.statusText || 'Invalid JSON response'}` } as T;
    }
    if (!res.ok) {
      console.error(`[agos-client] ${method} ${path} → HTTP ${res.status}:`, rawText.slice(0, 500));
    }
    if (!res.ok && data && typeof data === 'object' && 'error' in data && typeof (data as any).error === 'string') {
      // Enrich generic error messages with HTTP status for debugging
      const errMsg = (data as any).error;
      if (!errMsg.includes(String(res.status))) {
        (data as any).error = `HTTP ${res.status}: ${errMsg}`;
      }
    }
    return { status: res.status, data, headers: responseHeaders };
  }

  // ---- Auth (SIWE) ----

  async getChallenge(address: string, chainId = 56): Promise<{ message: string; nonce: string }> {
    const { data } = await this.request<AgosResponse<{ message: string; nonce: string }>>(
      'POST', '/auth/challenge', { address, chainId },
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Failed to get challenge');
    return data.data;
  }

  async verify(message: string, signature: string): Promise<AgosAuthTokens> {
    const { data } = await this.request<AgosResponse<AgosAuthTokens>>(
      'POST', '/auth/verify', { message, signature },
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Verification failed');
    this.accessToken = data.data.accessToken;
    return data.data;
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const { data } = await this.request<AgosResponse<{ accessToken: string; expiresIn: number }>>(
      'POST', '/auth/refresh', { refreshToken },
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Refresh failed');
    this.accessToken = data.data.accessToken;
    return data.data;
  }

  // ---- Agent Config ----

  async getAgentConfig(): Promise<AgosAgentConfig> {
    const { data } = await this.request<AgosResponse<AgosAgentConfig>>('GET', '/agents/config');
    if (!data.ok || !data.data) throw new Error(data.error || 'Failed to get config');
    return data.data;
  }

  // ---- Agents ----

  async createAgent(opts: {
    name: string;
    templateId?: string;
    image?: string;
    resourceClass?: string;
    envVars?: Record<string, string>;
  }): Promise<AgosCreateAgentResult> {
    const { data } = await this.request<AgosResponse<AgosCreateAgentResult>>(
      'POST', '/agents', opts,
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Failed to create agent');
    return data.data;
  }

  async listAgents(): Promise<AgosAgent[]> {
    const { data } = await this.request<AgosResponse<AgosAgent[]>>('GET', '/agents');
    if (!data.ok || !data.data) throw new Error(data.error || 'Failed to list agents');
    return data.data;
  }

  async getAgent(agentId: string): Promise<AgosAgent & { aiouBalance?: AgosBalance }> {
    const { data } = await this.request<AgosResponse<AgosAgent & { aiouBalance?: AgosBalance }>>(
      'GET', `/agents/${agentId}`,
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Agent not found');
    return data.data;
  }

  async setAgentStatus(agentId: string, status: 'active' | 'stopped' | 'deleted'): Promise<{ agentId: string; status: string }> {
    const { data } = await this.request<AgosResponse<{ agentId: string; status: string }>>(
      'PATCH', `/agents/${agentId}/status`, { status },
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Failed to update status');
    return data.data;
  }

  async redeployAgent(agentId: string): Promise<{ agentId: string; status: string; message: string }> {
    const { data } = await this.request<AgosResponse<{ agentId: string; status: string; message: string }>>(
      'POST', `/agents/${agentId}/redeploy`, {},
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Redeploy failed');
    return data.data;
  }

  // ---- Funding (x402) ----

  async fundAgent(agentId: string, amount: string): Promise<{ status: number; challenge?: AgosFundChallenge }> {
    const { status, data } = await this.request<AgosFundChallenge>(
      'POST', `/agents/${agentId}/fund`, { amount }, { rawResponse: true },
    );
    if (status === 402) {
      return { status: 402, challenge: data };
    }
    return { status };
  }

  async settleFund(agentId: string, payload: unknown): Promise<AgosFundSettleResult> {
    const { status, data } = await this.request<AgosResponse<AgosFundSettleResult>>(
      'POST', `/agents/${agentId}/fund/settle`, payload,
    );
    const resp = data as AgosResponse<AgosFundSettleResult>;
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error || `Settlement failed (HTTP ${status})`);
    }
    return resp.data;
  }

  // ---- Wallets ----

  async getUserBalance(): Promise<AgosBalance> {
    const { data } = await this.request<AgosResponse<AgosBalance>>('GET', '/wallets/aiou/balance');
    if (!data.ok || !data.data) throw new Error(data.error || 'Failed to get balance');
    return data.data;
  }

  async getAgentBalance(agentId: string): Promise<AgosBalance> {
    const { data } = await this.request<AgosResponse<AgosBalance>>(
      'GET', `/agents/${agentId}/wallet/balance`,
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Failed to get agent balance');
    return data.data;
  }

  async topupAgent(agentId: string, amount: string, idempotencyKey: string): Promise<{ transferId: string; amount: string; status: string }> {
    const { data } = await this.request<AgosResponse<{ transferId: string; amount: string; status: string }>>(
      'POST', `/wallets/agents/${agentId}/topup`, { amount, idempotencyKey },
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Top-up failed');
    return data.data;
  }

  // ---- Deployments ----

  async getDeployment(deploymentId: string): Promise<AgosDeployment> {
    const { data } = await this.request<AgosResponse<AgosDeployment>>(
      'GET', `/deployments/${deploymentId}`,
    );
    if (!data.ok || !data.data) throw new Error(data.error || 'Deployment not found');
    return data.data;
  }

  // ---- LLM Proxy ----

  async chatCompletion(
    apiKey: string,
    body: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream?: boolean;
      max_tokens?: number;
      temperature?: number;
    },
  ): Promise<unknown> {
    const { data } = await this.request<unknown>(
      'POST', '/v1/chat/completions', body, { auth: apiKey },
    );
    return data;
  }

  async listModels(): Promise<{ data: Array<{ id: string; owned_by: string; promptPriceAiou: string; completionPriceAiou: string }> }> {
    const { data } = await this.request<{ data: Array<{ id: string; owned_by: string; promptPriceAiou: string; completionPriceAiou: string }> }>(
      'GET', '/v1/models',
    );
    return data;
  }
}

// ---------------------------------------------------------------------------
// Session — manages SIWE auth lifecycle (tokens + expiry + refresh)
// ---------------------------------------------------------------------------

export class AgosSession {
  private client: AgosClient;
  private tokens: AgosAuthTokens | null = null;
  private expiresAt = 0; // epoch ms

  constructor(client: AgosClient) {
    this.client = client;
  }

  get isAuthenticated(): boolean {
    return !!this.tokens && Date.now() < this.expiresAt;
  }

  get accessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  get refreshToken(): string | null {
    return this.tokens?.refreshToken ?? null;
  }

  /** Run full SIWE login: challenge → sign (via callback) → verify. */
  async login(
    address: string,
    signMessage: (message: string) => Promise<string>,
    chainId = 56,
  ): Promise<AgosAuthTokens> {
    const { message } = await this.client.getChallenge(address, chainId);
    const signature = await signMessage(message);
    const tokens = await this.client.verify(message, signature);
    this.setTokens(tokens);
    return tokens;
  }

  /** Restore a session from previously stored tokens (e.g. from DB). */
  restore(accessToken: string, refreshToken?: string, expiresIn?: number): void {
    this.tokens = {
      accessToken,
      refreshToken: refreshToken ?? '',
      expiresIn: expiresIn ?? 86400,
    };
    this.expiresAt = Date.now() + (this.tokens.expiresIn * 1000) - 60_000;
    this.client.setAccessToken(accessToken);
  }

  /** Refresh if tokens are expired or about to expire. Returns true if refreshed. */
  async ensureValid(): Promise<boolean> {
    if (!this.tokens) throw new Error('No AGOS session — call login() or restore() first');
    if (Date.now() < this.expiresAt) return false;
    if (!this.tokens.refreshToken) throw new Error('AGOS session expired and no refresh token');

    const result = await this.client.refresh(this.tokens.refreshToken);
    this.tokens = {
      ...this.tokens,
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    };
    this.expiresAt = Date.now() + (result.expiresIn * 1000) - 60_000;
    return true;
  }

  /** Get the underlying client (already has the token set). */
  getClient(): AgosClient {
    return this.client;
  }

  private setTokens(tokens: AgosAuthTokens): void {
    this.tokens = tokens;
    this.expiresAt = Date.now() + (tokens.expiresIn * 1000) - 60_000;
    this.client.setAccessToken(tokens.accessToken);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgosClient(agosApiUrl: string): AgosClient {
  return new AgosClient(agosApiUrl);
}

export function createAgosSession(agosApiUrl: string): AgosSession {
  return new AgosSession(new AgosClient(agosApiUrl));
}
