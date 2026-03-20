export type SandboxProvider = 'e2b' | 'byod' | 'agos';
export type LlmProvider = 'direct' | 'bsc_llm_router' | 'agos';
export type ProviderBundle = 'agos' | null;

type ProviderRecord = {
  sandboxProvider?: string | null;
  llmProvider?: string | null;
  providerBundle?: string | null;
  launchMode?: string | null;
  agosAgentId?: string | null;
};

const SANDBOX_PROVIDERS = new Set<SandboxProvider>(['e2b', 'byod', 'agos']);
const LLM_PROVIDERS = new Set<LlmProvider>(['direct', 'bsc_llm_router', 'agos']);

export function isAgosSupported(env: { NETWORK: string; AGOS_API_URL: string }): boolean {
  return Boolean(env.AGOS_API_URL);
}

export function defaultSandboxProvider(): SandboxProvider {
  return 'e2b';
}

export function defaultLlmProvider(env: { NETWORK: string; BSC_LLM_ROUTER_URL: string; LLM_API_KEY: string }): LlmProvider {
  if (env.NETWORK === 'testnet' && env.BSC_LLM_ROUTER_URL) return 'bsc_llm_router';
  if (env.BSC_LLM_ROUTER_URL && !env.LLM_API_KEY) return 'bsc_llm_router';
  return 'direct';
}

export function normalizeSandboxProvider(value?: string | null): SandboxProvider | null {
  if (!value) return null;
  return SANDBOX_PROVIDERS.has(value as SandboxProvider) ? value as SandboxProvider : null;
}

export function normalizeLlmProvider(value?: string | null): LlmProvider | null {
  if (!value) return null;
  return LLM_PROVIDERS.has(value as LlmProvider) ? value as LlmProvider : null;
}

export function resolveSandboxProvider(record: ProviderRecord): SandboxProvider {
  const explicit = normalizeSandboxProvider(record.sandboxProvider);
  if (explicit) return explicit;
  if (record.launchMode === 'byod') return 'byod';
  if (record.launchMode === 'agos' || record.agosAgentId) return 'agos';
  return 'e2b';
}

export function resolveLlmProvider(
  record: ProviderRecord,
  env: { NETWORK: string; BSC_LLM_ROUTER_URL: string; LLM_API_KEY: string },
): LlmProvider {
  const explicit = normalizeLlmProvider(record.llmProvider);
  if (explicit) return explicit;
  if (record.launchMode === 'agos' || record.agosAgentId) return 'agos';
  return defaultLlmProvider(env);
}

export function resolveProviderBundle(
  record: ProviderRecord,
  env: { NETWORK: string; BSC_LLM_ROUTER_URL: string; LLM_API_KEY: string },
): ProviderBundle {
  if (record.providerBundle === 'agos') return 'agos';
  const sandboxProvider = resolveSandboxProvider(record);
  const llmProvider = resolveLlmProvider(record, env);
  return sandboxProvider === 'agos' && llmProvider === 'agos' ? 'agos' : null;
}

export function validateProviderSelection(
  sandboxProvider: SandboxProvider,
  llmProvider: LlmProvider,
  env: { NETWORK: string; AGOS_API_URL: string },
): string | null {
  if ((sandboxProvider === 'agos') !== (llmProvider === 'agos')) {
    return 'AGOS must be selected for both sandbox_provider and llm_provider';
  }
  if ((sandboxProvider === 'agos' || llmProvider === 'agos') && !isAgosSupported(env)) {
    return 'AGOS is not available (AGOS_API_URL not configured)';
  }
  return null;
}

export function isManagedSandboxProvider(provider: SandboxProvider): boolean {
  return provider === 'e2b';
}

export function isByodProvider(provider: SandboxProvider): boolean {
  return provider === 'byod';
}

export function isAgosBundle(
  record: ProviderRecord,
  env: { NETWORK: string; BSC_LLM_ROUTER_URL: string; LLM_API_KEY: string },
): boolean {
  return resolveProviderBundle(record, env) === 'agos';
}

export function usesGatewayChat(
  record: ProviderRecord,
  env: { NETWORK: string; BSC_LLM_ROUTER_URL: string; LLM_API_KEY: string },
): boolean {
  return resolveLlmProvider(record, env) === 'bsc_llm_router';
}
