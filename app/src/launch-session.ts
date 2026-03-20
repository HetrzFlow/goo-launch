export interface LaunchSessionDraftPayload {
  agent_name: string;
  agent_intro?: string;
  token_symbol: string;
  genesis_prompt?: string;
  agent_instructions?: string;
  skills_content?: string;
  memory_content?: string;
  framework?: string;
  sandbox_provider?: string;
  llm_provider?: string;
  circulation_pct?: number;
  contribution_bnb?: string;
  buyback_enabled?: boolean;
  buyback_threshold_bnb?: string;
}

export interface LaunchSession {
  version: 1;
  draftPayload?: LaunchSessionDraftPayload;
  prepared?: {
    agenter_id: string;
    agent_wallet: string;
    deploy_data: string;
    deploy_bnb: string;
    chain_id: number;
    lp_config: {
      router_address: string;
      lp_token_amount: string;
      lp_bnb_amount: string;
      circulation_pct?: number;
      contribution_bnb?: string;
    };
    sandbox_provider: string;
    llm_provider: string;
  };
  progress?: {
    deploy_tx_hash?: string;
    token_address?: string;
    approve_tx_hash?: string;
    liquidity_tx_hash?: string;
    deployer_address?: string;
  };
  lastError?: string | null;
  updatedAt: string;
}

export function parseLaunchSession(raw: string | null | undefined): LaunchSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LaunchSession;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function stringifyLaunchSession(session: LaunchSession): string {
  return JSON.stringify(session);
}

export function patchLaunchSession(
  raw: string | null | undefined,
  patch: Partial<LaunchSession>,
): string {
  const current = parseLaunchSession(raw) || { version: 1, updatedAt: new Date().toISOString() };
  const next: LaunchSession = {
    ...current,
    ...patch,
    prepared: patch.prepared === undefined ? current.prepared : patch.prepared,
    draftPayload: patch.draftPayload === undefined ? current.draftPayload : patch.draftPayload,
    progress: {
      ...(current.progress || {}),
      ...(patch.progress || {}),
    },
    updatedAt: patch.updatedAt || new Date().toISOString(),
  };
  return stringifyLaunchSession(next);
}
