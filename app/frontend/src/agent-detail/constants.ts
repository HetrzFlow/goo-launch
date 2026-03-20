import type { ExecutionPhase } from './types';
import { getBscscanBase, getAppConfigSync } from '../app-config';

export function BSCSCAN_BASE(): string {
  return getBscscanBase(getAppConfigSync());
}
export const REFRESH_INTERVAL = 30_000;

export const PHASE_ORDER: ExecutionPhase[] = ['planning', 'preparing', 'running', 'reviewing', 'finalizing'];

export const PHASE_LABELS: Record<ExecutionPhase, string> = {
  planning: 'Plan',
  preparing: 'Prepare',
  running: 'Execute',
  reviewing: 'Review',
  finalizing: 'Finalize',
};

export const PHASE_ICONS: Record<ExecutionPhase, string> = {
  planning: '\uD83D\uDCCB',   // 📋
  preparing: '\u2699\uFE0F',   // ⚙️
  running: '\u25B6\uFE0F',     // ▶️
  reviewing: '\uD83D\uDD0D',   // 🔍
  finalizing: '\u2705',         // ✅
};

export const PHASE_STATUS: Record<ExecutionPhase, string> = {
  planning: 'Generating plan...',
  preparing: 'Setting up env...',
  running: 'Executing...',
  reviewing: 'Analyzing results...',
  finalizing: 'Preparing response...',
};

export const EVENT_TYPE_COLORS: Record<string, string> = {
  pulse: '#00C7D2',
  survivalSell: '#ea580c',
  statusChange: '#7c3aed',
  llmCall: '#0081f2',
  sandbox: '#06b6d4',
  deploy: '#00C7D2',
  buyback: '#2563eb',
  gasRefill: '#0891b2',
  error: '#dc2626',
  other: '#B2B2B2',
};

export const EVENT_TYPE_LABELS: Record<string, string> = {
  pulse: 'Pulse',
  survivalSell: 'Survival Sell',
  statusChange: 'Status Change',
  llmCall: 'LLM / Agent',
  sandbox: 'Sandbox',
  deploy: 'Deploy',
  buyback: 'Buyback',
  gasRefill: 'Gas / Refill',
  error: 'Error',
  other: 'Other',
};

export function formatNumber(n: string, decimals: number = 2): string {
  const num = parseFloat(n);
  if (isNaN(num)) return n;
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

export function pulseHealthColor(health: string): string {
  if (health === 'healthy') return '#00C7D2';
  if (health === 'warning') return '#f59e0b';
  return '#e05050';
}

export function chainStateFromStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === 'active') return 'ACTIVE';
  if (s === 'starving') return 'STARVING';
  if (s === 'dying') return 'DYING';
  if (s === 'dead') return 'DEAD';
  if (s === 'deployed' || s === 'pending' || s === 'created') return 'DEPLOYED';
  if (s === 'stopped') return 'STOPPED';
  if (s === 'decommissioned') return 'DECOMMISSIONED';
  return status.toUpperCase();
}

export function chainStateClass(state: string): string {
  switch (state) {
    case 'ACTIVE': return 'active';
    case 'STARVING': return 'warning';
    case 'DYING': return 'suspended';
    case 'DEAD': return 'dead';
    case 'DECOMMISSIONED': return 'dead';
    default: return '';
  }
}
