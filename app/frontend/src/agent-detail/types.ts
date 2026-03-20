export interface AgentDetail {
  id: number;
  agenterId: string;
  agentName: string | null;
  agentIntro: string | null;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  agentWallet: string | null;
  contractAddress: string;
  status: string;
  createdAt: string;
  runtime_running: boolean;
  runtime_paused: boolean;
  sandboxId: string | null;
  sandboxUrl: string | null;
  gatewayUrl: string | null;
  gatewayToken: string | null;
  gooCoreStatus: string | null;
  framework: string | null;
  lastPulseAt: string | null;
  launchState: string;
  launchError: string | null;
  launchUpdatedAt: string;
  runtimeState: string;
  runtimeError: string | null;
  runtimeUpdatedAt: string;
  chainState: string;
  chainStateUpdatedAt: string;
  launchMode: string;
  sandboxProvider: 'e2b' | 'byod' | 'agos';
  llmProvider: 'direct' | 'bsc_llm_router' | 'agos';
  providerBundle: 'agos' | null;
  agosAgentId: string | null;
  erc8004AgentId: number | null;
  llmCallsCount: number;
  genesisPrompt: string | null;
  agentInstructions: string | null;
  skillsContent: string | null;
  memoryContent: string | null;
  owner_address: string | null;
  is_owner: boolean;
  is_creator: boolean;
  can_view_private: boolean;
  debug_controls_enabled: boolean;
  paymentTokenAddress: string | null;
}

export interface AgentStateAction {
  key: string;
  label: string;
  kind: 'primary' | 'secondary';
  enabled: boolean;
  href?: string | null;
  reason?: string | null;
}

export interface AgentWorkflowStateResponse {
  agent_id: string;
  launch: {
    state: string;
    error: string | null;
    updated_at: string;
  };
  runtime: {
    provider: string | null;
    state: string;
    error: string | null;
    updated_at: string;
    byod_gateway_reachable?: boolean | null;
  };
  chain: {
    state: string;
    updated_at: string;
  };
  session: {
    resumable: boolean;
    has_prepared: boolean;
    has_token_address: boolean;
    has_deploy_tx: boolean;
  };
  actions: AgentStateAction[];
}

export interface ChatMessageRecord {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  via: string | null;
  tier: string | null;
  createdAt: string;
}

export interface ChatHistoryResponse {
  messages: ChatMessageRecord[];
  has_more: boolean;
}

export interface AgentEvent {
  txHash: string;
  method: string;
  memo: string | null;
  status: string;
  createdAt: string;
  event_type: string;
  severity?: string;
  source?: 'tx' | 'core';
}

export interface EventsResponse {
  events: AgentEvent[];
}

export interface LivenessData {
  status: string;
  statusCode: number;
  runtime_running: boolean;
  treasury: {
    balance: string;
    balanceRaw?: string;
    starvingThreshold: string;
    fixedBurnRate: string;
    runwayHours: number;
  };
  pulse: {
    lastPulseAt: number;
    lastPulseIso: string | null;
    pulseTimeoutSecs: number;
    secondsSinceLastPulse: number | null;
    secondsUntilTimeout: number | null;
    overdue: boolean;
    health: 'healthy' | 'warning' | 'critical';
    timeoutPct: number | null;
  };
  lifecycle: {
    starvingEnteredAt: number;
    dyingEnteredAt: number;
    starvingGracePeriodSecs: number;
    dyingMaxDurationSecs: number;
    starvingRemainingSecs: number | null;
    dyingRemainingSecs: number | null;
  };
  balances: {
    nativeBnb: string;
    tokenHoldings: string;
    totalSupply: string;
    paymentToken: {
      balance: string;
      symbol: string;
      decimals: number;
      address: string;
    } | null;
    tokens?: Array<{
      address: string;
      symbol: string;
      decimals: number;
      balance: string;
    }>;
  };
  timestamp: string;
}

export type ExecutionPhase = 'planning' | 'preparing' | 'running' | 'reviewing' | 'finalizing';

export interface StreamEvent {
  task_id: string;
  agent_id: string;
  session_id?: string;
  timestamp: string;
  step_id?: string;
  display_text: string;
  phase: ExecutionPhase;
  message_type: 'reasoning' | 'execution' | 'result' | 'system';
  debug_payload?: unknown;
}

export interface SandboxStatusResponse {
  has_sandbox: boolean;
  agentId?: string;
  agentName?: string;
  sandboxId?: string;
  state?: string;
  lastError?: string | null;
  domain?: string;
  chainStatus?: string;
  launchTime?: string;
  uptimeSeconds?: number;
  endAt?: string;
  totalSettledUsd?: number;
  /** legacy alias */
  sandbox_id?: string;
}

export interface ChatResponse {
  reply: string;
  model?: string;
  via?: 'openclaw' | 'direct' | 'agos';
  tier?: string | null;
  exitCode?: number;
  gatewayDown?: boolean;
}

export interface TokenBalance {
  symbol: string;
  balance: string;
  address?: string;
}

export interface AssetsData {
  bnb: string;
  treasury: string;
  token: string;
  tokenSymbol: string;
  /** All additional ERC-20 token balances (payment token + watched tokens) */
  tokens: TokenBalance[];
}

export interface AgentHealthResponse {
  agenterId: string;
  dbStatus: string;
  gooCoreStatus: string | null;
  runtimeRunning: boolean;
  runtimePaused: boolean;
  lastPulseAt: string | null;
  pulseFreshness: 'healthy' | 'warning' | 'critical' | 'unknown';
  restartCount: number;
  recentEvents: Array<{
    id: number;
    eventType: string;
    severity: string;
    message: string;
    createdAt: string;
  }>;
}

export interface AgentDebugChainState {
  status: string;
  statusCode: number;
  dbStatus: string;
  gooCoreStatus: string | null;
  runtimeRunning: boolean;
  runtimePaused: boolean;
  treasuryBalance: string;
  treasuryBalanceRaw: string;
  starvingThreshold: string;
  starvingThresholdRaw: string;
  contractBnb: string;
  contractBnbRaw: string;
  walletBnb: string;
  walletBnbRaw: string;
  starvingEnteredAt: number;
  dyingEnteredAt: number;
  starvingGracePeriodSecs: number;
  dyingMaxDurationSecs: number;
  lastPulseAt: number;
  pulseTimeoutSecs: number;
  secondsSinceLastPulse: number | null;
  secondsUntilPulseTimeout: number | null;
}

export interface AgentDebugActionResponse {
  before?: AgentDebugChainState | null;
  after: AgentDebugChainState;
  actionTaken: string;
  warnings: string[];
}

export interface ExecResponse {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface ERC8004Info {
  erc8004_agent_id: number | null;
  registered: boolean;
  chain_id: number;
  identity_registry: string | null;
  reputation_registry: string | null;
}

export interface ERC8004Reputation {
  erc8004_agent_id: number;
  count: number;
  summary_value: string;
  summary_value_decimals: number;
  clients: string[];
}

export interface RemoteExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RemoteStatusResponse {
  disk: string;
  memory: string;
  uptime: string;
  containers: string | null;
  gooCoreRunning: boolean;
  gatewayRunning: boolean;
}

export interface RemoteLogsResponse {
  lines: string[];
}

export interface SandboxLogsResponse {
  logs: Array<{ stream: string; message: string }>;
}

export interface SandboxEventsResponse {
  events: Array<{ id: number; event_type: string; detail?: string; created_at: string }>;
  total: number;
}
