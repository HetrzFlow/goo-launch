/**
 * AGOS shared constants
 *
 * Canonical resource classes, defaults, and runtime env var keys for AGOS integration.
 * Kept in sync across server/ and worker/ (no shared package yet).
 */

// ---------------------------------------------------------------------------
// Resource classes — Vultr VPS plans supported by AGOS
// ---------------------------------------------------------------------------

export const AGOS_RESOURCE_CLASSES = [
  { id: 'vc2-1c-1gb', label: '1 vCPU / 1 GB RAM', vcpu: 1, ramMb: 1024 },
  { id: 'vc2-1c-2gb', label: '1 vCPU / 2 GB RAM', vcpu: 1, ramMb: 2048 },
  { id: 'vc2-2c-4gb', label: '2 vCPU / 4 GB RAM', vcpu: 2, ramMb: 4096 },
] as const;

export type AgosResourceClassId = (typeof AGOS_RESOURCE_CLASSES)[number]['id'];

export const AGOS_RESOURCE_CLASS_IDS = new Set<string>(
  AGOS_RESOURCE_CLASSES.map(rc => rc.id),
);

export const AGOS_DEFAULT_RESOURCE_CLASS: AgosResourceClassId = 'vc2-1c-1gb';

export function isValidResourceClass(value: string): value is AgosResourceClassId {
  return AGOS_RESOURCE_CLASS_IDS.has(value);
}

// ---------------------------------------------------------------------------
// Runtime env var keys injected into AGOS agent containers
// ---------------------------------------------------------------------------

export const AGOS_RUNTIME_ENV_KEYS = [
  'GOO_SERVER_URL',
  'AGENT_ID',
  'AGENT_NAME',
  'AGENT_RUNTIME_TOKEN',
  'AGOS_API_BASE_URL',
  'CHAIN_ID',
  'RPC_URL',
  'TOKEN_ADDRESS',
  'WALLET_PRIVATE_KEY',
  'OPENCLAW_GATEWAY_TOKEN',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'LLM_MODEL',
  'ROUTER_ADDRESS',
  'REGISTRY_ADDRESS',
  'CONTROL_PORT',
] as const;
