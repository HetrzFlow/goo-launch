import { api } from './api';
import type { ChainParams } from './wallet';

export interface AppConfig {
  network: 'testnet' | 'mainnet';
  chain_id: number;
  router_address: string;
  sandbox_manager_url: string;
  agos_enabled: boolean;
  agos_chain_id: number;
  agos_effective_min_initial_fund: number;
  min_contribution_bnb: number;
  treasury_bnb_bps: number;
}

const DEFAULT_CONFIG: AppConfig = {
  network: 'testnet',
  chain_id: 97,
  router_address: '',
  sandbox_manager_url: '',
  agos_enabled: false,
  agos_chain_id: 56,
  agos_effective_min_initial_fund: 10,
  min_contribution_bnb: 0.1,
  treasury_bnb_bps: 3000,
};

let cached: AppConfig | null = null;
let fetchPromise: Promise<AppConfig> | null = null;

export async function getAppConfig(): Promise<AppConfig> {
  if (cached) return cached;
  if (fetchPromise) return fetchPromise;
  fetchPromise = api<Partial<AppConfig>>('GET', '/api/config').then(cfg => {
    cached = { ...DEFAULT_CONFIG, ...cfg };
    return cached;
  }).catch(() => {
    cached = DEFAULT_CONFIG;
    return cached;
  });
  return fetchPromise;
}

export function getAppConfigSync(): AppConfig | null {
  return cached;
}

export function isTestnet(cfg?: AppConfig | null): boolean {
  const c = cfg ?? cached;
  return !c || c.network === 'testnet';
}

export function getNetworkName(cfg?: AppConfig | null): string {
  return isTestnet(cfg) ? 'BSC Testnet' : 'BSC Mainnet';
}

export function getBscscanBase(cfg?: AppConfig | null): string {
  return isTestnet(cfg) ? 'https://testnet.bscscan.com' : 'https://bscscan.com';
}

export function getChainIdHex(cfg?: AppConfig | null): string {
  const c = cfg ?? cached;
  const chainId = c?.chain_id ?? 97;
  return '0x' + chainId.toString(16);
}

export function getChainParams(cfg?: AppConfig | null): ChainParams {
  if (isTestnet(cfg)) {
    return {
      chainId: '0x61',
      chainName: 'BSC Testnet',
      nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
      rpcUrls: ['https://data-seed-prebsc-1-s1.binance.org:8545'],
      blockExplorerUrls: ['https://testnet.bscscan.com'],
    };
  }
  return {
    chainId: '0x38',
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.binance.org'],
    blockExplorerUrls: ['https://bscscan.com'],
  };
}
