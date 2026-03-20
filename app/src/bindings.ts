export interface Env {
  // D1 Database
  DB: D1Database;

  // KV Namespaces
  NONCE_KV: KVNamespace;

  // Durable Objects
  AGENT_EVENT_HUB: DurableObjectNamespace;
  AGENT_PROVISIONER: DurableObjectNamespace;

  // Static Assets
  ASSETS: Fetcher;

  // Secrets (set via `wrangler secret put`)
  JWT_SECRET: string;
  LLM_API_KEY: string;

  // Vars (set in wrangler.toml [vars])
  RPC_URL: string;
  CHAIN_ID: string;
  NETWORK: string;
  ROUTER_ADDRESS: string;
  SWAP_EXECUTOR_ADDRESS: string;
  REGISTRY_ADDRESS: string;
  LLM_API_URL: string;
  LLM_MODEL: string;
  BSC_LLM_ROUTER_URL: string;
  X402_NETWORK: string;
  X402_PAYMENT_TOKEN: string;
  ADMIN_WALLET: string;
  SANDBOX_MANAGER_URL: string;
  PUBLIC_API_URL: string;
  ENABLE_AGENT_DEBUG_CONTROLS: string;
  AGOS_API_URL: string;
  AGOS_IMAGE: string;
  AGOS_CHAIN_ID: string;
  AGOS_EFFECTIVE_MIN_INITIAL_FUND?: string;
  ALERT_WEBHOOK_URL: string;
  MIN_CONTRIBUTION_BNB: string;
  TREASURY_BNB_BPS: string;

  // Extra ERC-20 tokens to show in wallet assets (comma-separated "address:symbol:decimals")
  WATCHED_TOKENS?: string;

  // ERC-8004 (optional — auto-derived from CHAIN_ID if not set)
  ERC8004_IDENTITY_REGISTRY?: string;
  ERC8004_REPUTATION_REGISTRY?: string;
}

// Hono context variables (set by middleware)
export interface HonoVariables {
  auth: {
    user_id: number;
    wallet_address: string;
    role: string;
  };
}
