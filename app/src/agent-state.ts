export const LAUNCH_STATES = [
  'not_started',
  'draft',
  'prepared',
  'deploy_submitted',
  'deployed',
  'liquidity_submitted',
  'launched',
  'runtime_pending',
  'completed',
  'failed',
  'abandoned',
] as const;

export const RUNTIME_STATES = [
  'none',
  'config_required',
  'provisioning',
  'ready',
  'starting',
  'running',
  'paused',
  'stopped',
  'degraded',
  'error',
] as const;

export const CHAIN_STATES = [
  'unknown',
  'active',
  'starving',
  'dying',
  'dead',
] as const;

export type LaunchState = typeof LAUNCH_STATES[number];
export type RuntimeState = typeof RUNTIME_STATES[number];
export type ChainState = typeof CHAIN_STATES[number];

export function nowIso(): string {
  return new Date().toISOString();
}
