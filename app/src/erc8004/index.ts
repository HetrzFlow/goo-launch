import { ethers } from 'ethers';
import IdentityRegistryABI from './abis/IdentityRegistry.json';
import ReputationRegistryABI from './abis/ReputationRegistry.json';

// Official ERC-8004 contract addresses
const ERC8004_ADDRESSES: Record<number, { identity: string; reputation: string }> = {
  56: {
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  },
  97: {
    identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  },
};

export function getERC8004Addresses(chainId: number) {
  const addrs = ERC8004_ADDRESSES[chainId];
  if (!addrs) return null;
  return addrs;
}

export interface AgentRegistrationFile {
  type: string;
  name: string;
  description: string;
  image: string;
  services: Array<{ name: string; endpoint: string }>;
  registrations: Array<{ agentId: number; agentRegistry: string }>;
  supportedTrust: string[];
  x402Support: boolean;
  active: boolean;
}

export function buildAgentRegistrationFile(agent: {
  agentName: string | null;
  agentIntro: string | null;
  agenterId: string;
  tokenAddress: string | null;
}, options: {
  chainId: number;
  publicApiUrl?: string;
  erc8004AgentId?: number;
}): AgentRegistrationFile {
  const chainPrefix = `eip155:${options.chainId}`;
  const addrs = getERC8004Addresses(options.chainId);

  const registrations: AgentRegistrationFile['registrations'] = [];
  if (options.erc8004AgentId && addrs) {
    registrations.push({
      agentId: options.erc8004AgentId,
      agentRegistry: `${chainPrefix}:${addrs.identity}`,
    });
  }

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: agent.agentName || 'Goo Agent',
    description: agent.agentIntro || '',
    image: '',
    services: options.publicApiUrl
      ? [{ name: 'web', endpoint: `${options.publicApiUrl}/agent.html?id=${agent.agenterId}` }]
      : [],
    registrations,
    supportedTrust: ['reputation'],
    x402Support: false,
    active: true,
  };
}

function encodeAgentURI(registrationFile: AgentRegistrationFile): string {
  const json = JSON.stringify(registrationFile);
  const bytes = new TextEncoder().encode(json);
  const base64 = btoa(String.fromCharCode(...bytes));
  return `data:application/json;base64,${base64}`;
}

function buildMetadataEntries(
  agent: { tokenAddress: string | null },
  chainId: number,
): Array<{ metadataKey: string; metadataValue: string }> {
  const entries: Array<{ metadataKey: string; metadataValue: string }> = [];

  if (agent.tokenAddress) {
    // Link ERC-8004 identity to Goo token contract for on-chain verification
    entries.push({
      metadataKey: 'goo:tokenContract',
      metadataValue: ethers.AbiCoder.defaultAbiCoder().encode(['address'], [agent.tokenAddress]),
    });
    entries.push({
      metadataKey: 'goo:chainId',
      metadataValue: ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [chainId]),
    });
  }

  return entries;
}

function parseAgentIdFromReceipt(receipt: ethers.TransactionReceipt): bigint {
  const iface = new ethers.Interface(IdentityRegistryABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === 'Registered') {
        return parsed.args[0];
      }
    } catch { /* not a registry log */ }
  }
  throw new Error('Registered event not found in transaction receipt');
}

export async function registerAgentOnERC8004(
  signer: ethers.Signer,
  chainId: number,
  agent: {
    agentName: string | null;
    agentIntro: string | null;
    agenterId: string;
    tokenAddress: string | null;
  },
  publicApiUrl?: string,
): Promise<{ agentId: bigint; txHash: string }> {
  const addrs = getERC8004Addresses(chainId);
  if (!addrs) throw new Error(`ERC-8004 not available on chain ${chainId}`);

  const regFile = buildAgentRegistrationFile(agent, { chainId, publicApiUrl });
  const agentURI = encodeAgentURI(regFile);
  const metadata = buildMetadataEntries(agent, chainId);

  const registry = new ethers.Contract(addrs.identity, IdentityRegistryABI, signer);

  // Use register(string, MetadataEntry[]) — single tx for registration + metadata
  const tx = await registry['register(string,(string,bytes)[])'](agentURI, metadata);
  const receipt = await tx.wait();

  return { agentId: parseAgentIdFromReceipt(receipt), txHash: tx.hash };
}

export async function getERC8004Reputation(
  provider: ethers.Provider,
  chainId: number,
  agentId: bigint,
  clients: string[],
  tag1 = '',
  tag2 = '',
): Promise<{ count: bigint; summaryValue: bigint; summaryValueDecimals: number }> {
  const addrs = getERC8004Addresses(chainId);
  if (!addrs) throw new Error(`ERC-8004 not available on chain ${chainId}`);

  const registry = new ethers.Contract(addrs.reputation, ReputationRegistryABI, provider);
  const [count, summaryValue, summaryValueDecimals] = await registry.getSummary(
    agentId,
    clients,
    tag1,
    tag2,
  );

  return {
    count,
    summaryValue,
    summaryValueDecimals: Number(summaryValueDecimals),
  };
}

export async function getERC8004Clients(
  provider: ethers.Provider,
  chainId: number,
  agentId: bigint,
): Promise<string[]> {
  const addrs = getERC8004Addresses(chainId);
  if (!addrs) throw new Error(`ERC-8004 not available on chain ${chainId}`);

  const registry = new ethers.Contract(addrs.reputation, ReputationRegistryABI, provider);
  return registry.getClients(agentId);
}

export { IdentityRegistryABI, ReputationRegistryABI };
