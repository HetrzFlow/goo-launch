import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// ─── users ────────────────────────────────────────────────

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    walletAddress: text('wallet_address').notNull().unique(),
    role: text('role').notNull().default('user'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
);

// ─── contracts ────────────────────────────────────────────

export const contracts = sqliteTable(
  'contracts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    address: text('address').notNull().unique(),
    deployerAddress: text('deployer_address').notNull(),
    txHash: text('tx_hash').notNull(),
    network: text('network').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('contracts_user_id_idx').on(table.userId),
  ],
);

// ─── agenter_records ──────────────────────────────────────

export const agenterRecords = sqliteTable(
  'agenter_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    agenterId: text('agenter_id').notNull().unique(),
    contractAddress: text('contract_address').notNull(),
    status: text('status').notNull().default('created'),
    lastTriggeredAt: text('last_triggered_at'),
    triggerCount: integer('trigger_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),

    // Genome fields
    agentName: text('agent_name'),
    agentIntro: text('agent_intro'),
    agentFramework: text('agent_framework'),
    genesisPrompt: text('genesis_prompt'),
    agentInstructions: text('agent_instructions'),
    skillsContent: text('skills_content'),
    memoryContent: text('memory_content'),
    buybackPolicy: text('buyback_policy'),
    tokenSymbol: text('token_symbol'),
    nominatedPct: integer('nominated_pct'),

    // Launch result fields
    tokenAddress: text('token_address'),
    agentWallet: text('agent_wallet'),
    genomeHash: text('genome_hash'),

    // Current owner wallet (lazy-synced from on-chain registry after CTO)
    ownerAddress: text('owner_address'),

    // Launch mode
    launchMode: text('launch_mode').notNull().default('cloud'),
    sandboxProvider: text('sandbox_provider'),
    llmProvider: text('llm_provider'),
    llmModel: text('llm_model'),
    providerBundle: text('provider_bundle'),

    // Unified workflow state
    launchState: text('launch_state').notNull().default('not_started'),
    launchError: text('launch_error'),
    launchUpdatedAt: text('launch_updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    launchSession: text('launch_session'),
    runtimeState: text('runtime_state').notNull().default('none'),
    runtimeError: text('runtime_error'),
    runtimeUpdatedAt: text('runtime_updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    chainState: text('chain_state').notNull().default('unknown'),
    chainStateUpdatedAt: text('chain_state_updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),

    // Runtime / sandbox fields
    encryptedPrivateKey: text('encrypted_private_key'),
    sandboxId: text('sandbox_id'),
    sandboxUrl: text('sandbox_url'),
    gatewayUrl: text('gateway_url'),
    gatewayToken: text('gateway_token'),
    gooCoreStatus: text('goo_core_status'),
    framework: text('framework'),
    lastPulseAt: text('last_pulse_at'),
    llmCallsCount: integer('llm_calls_count').notNull().default(0),

    // AGOS platform integration
    agosAgentId: text('agos_agent_id').unique(),
    agosApiKey: text('agos_api_key'),
    agosAccessToken: text('agos_access_token'),
    agosRefreshToken: text('agos_refresh_token'),
    agosDeploymentId: text('agos_deployment_id'),

    // ERC-8004 public registry
    erc8004AgentId: integer('erc8004_agent_id'),
  },
  (table) => [
    index('agenter_records_user_id_idx').on(table.userId),
    index('agenter_records_contract_address_idx').on(table.contractAddress),
  ],
);

// ─── transaction_logs ─────────────────────────────────────

export const transactionLogs = sqliteTable(
  'transaction_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agenterId: text('agenter_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    txHash: text('tx_hash').notNull(),
    method: text('method').notNull(),
    memo: text('memo'),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('transaction_logs_agenter_id_idx').on(table.agenterId),
    index('transaction_logs_user_id_idx').on(table.userId),
  ],
);

// ─── agent_events ─────────────────────────────────────────

export const agentEvents = sqliteTable(
  'agent_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agenterId: text('agenter_id').notNull(),
    eventType: text('event_type').notNull(),
    severity: text('severity').notNull(), // info | warn | error | critical
    message: text('message').notNull(),
    metadata: text('metadata').default('{}'), // JSON string
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('agent_events_agenter_id_created_at_idx').on(table.agenterId, table.createdAt),
    index('agent_events_severity_created_at_idx').on(table.severity, table.createdAt),
  ],
);

// ─── chat_messages ────────────────────────────────────────

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agenterId: text('agenter_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(), // 'user' | 'assistant' | 'system'
    content: text('content').notNull(),
    model: text('model'),
    via: text('via'), // 'openclaw' | 'agos' | 'direct'
    tier: text('tier'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('chat_messages_agenter_id_created_at_idx').on(table.agenterId, table.createdAt),
    index('chat_messages_user_id_idx').on(table.userId),
  ],
);
