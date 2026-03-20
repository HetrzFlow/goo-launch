import { ethers } from 'ethers';
import { eq } from 'drizzle-orm';
import type { Database } from './db';
import { childLogger } from './logger';

const log = childLogger({ module: 'agent-access' });

const REGISTRY_READ_ABI = [
  'function agentIdByToken(address tokenContract) view returns (uint256)',
  'function agentOwnerOf(uint256 agentId) view returns (address)',
] as const;

function normalizeAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    return ethers.getAddress(address).toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}

export async function isCurrentOnchainAgentOwner(
  agent: { agenterId: string; tokenAddress: string | null },
  walletAddress: string | null | undefined,
  env: { RPC_URL: string; REGISTRY_ADDRESS: string },
): Promise<boolean> {
  const viewer = normalizeAddress(walletAddress);
  if (!viewer || !agent.tokenAddress || !env.REGISTRY_ADDRESS) {
    return false;
  }

  try {
    const provider = new ethers.JsonRpcProvider(env.RPC_URL);
    const registry = new ethers.Contract(env.REGISTRY_ADDRESS, REGISTRY_READ_ABI, provider);
    const agentId = await registry.agentIdByToken(agent.tokenAddress) as bigint;
    if (agentId === 0n) {
      return false;
    }

    const owner = await registry.agentOwnerOf(agentId) as string;
    return normalizeAddress(owner) === viewer;
  } catch (err) {
    log.warn({ agenterId: agent.agenterId, err }, 'Failed to resolve on-chain owner');
    return false;
  }
}

export async function resolveAndSyncOwner(
  agent: { id: number; agenterId: string; tokenAddress: string | null; ownerAddress: string | null },
  env: { RPC_URL: string; REGISTRY_ADDRESS: string },
  db: Database,
): Promise<string | null> {
  if (!agent.tokenAddress || !env.REGISTRY_ADDRESS) return agent.ownerAddress;

  try {
    const provider = new ethers.JsonRpcProvider(env.RPC_URL);
    const registry = new ethers.Contract(env.REGISTRY_ADDRESS, REGISTRY_READ_ABI, provider);
    const agentId = await registry.agentIdByToken(agent.tokenAddress) as bigint;
    if (agentId === 0n) return agent.ownerAddress;

    const owner = await registry.agentOwnerOf(agentId) as string;
    const checksummed = ethers.getAddress(owner);

    // Skip sync if the on-chain owner is the token contract itself.
    // This happens when registerInRegistry() is called by the token contract (msg.sender = tokenContract),
    // so the registry records the token contract as "owner" — not the human creator.
    if (agent.tokenAddress && normalizeAddress(checksummed) === normalizeAddress(agent.tokenAddress)) {
      return agent.ownerAddress;
    }

    // Lazy sync: update DB if owner changed
    const currentStored = normalizeAddress(agent.ownerAddress);
    if (currentStored !== checksummed.toLowerCase()) {
      // Dynamic import to avoid circular dependency — schema must exist
      const { agenterRecords } = await import('./db/schema');
      await db.update(agenterRecords).set({ ownerAddress: checksummed }).where(eq(agenterRecords.id, agent.id));
    }

    return checksummed;
  } catch (err) {
    log.warn({ agenterId: agent.agenterId, err }, 'Failed to resolve owner');
    return agent.ownerAddress;
  }
}

export async function isAgentOwner(
  agent: { id: number; agenterId: string; userId: number; tokenAddress: string | null; ownerAddress: string | null },
  auth: { user_id: number; wallet_address: string } | null | undefined,
  env: { RPC_URL: string; REGISTRY_ADDRESS: string },
): Promise<boolean> {
  if (!auth) return false;
  // Fast path: check DB ownerAddress first
  if (agent.ownerAddress && normalizeAddress(agent.ownerAddress) === normalizeAddress(auth.wallet_address)) {
    return true;
  }
  // DB creator check (pre-CTO or ownerAddress not yet synced)
  if (agent.userId === auth.user_id) {
    return true;
  }
  // Slow path: check on-chain
  return isCurrentOnchainAgentOwner(agent, auth.wallet_address, env);
}

export async function hasPrivateAgentAccess(
  agent: { agenterId: string; userId: number; tokenAddress: string | null; ownerAddress: string | null },
  auth: { user_id: number; wallet_address: string } | null | undefined,
  env: { RPC_URL: string; REGISTRY_ADDRESS: string },
): Promise<boolean> {
  if (!auth) return false;
  if (agent.userId === auth.user_id) return true;
  // Check DB ownerAddress (set at launch time to the creator's wallet)
  if (agent.ownerAddress && normalizeAddress(agent.ownerAddress) === normalizeAddress(auth.wallet_address)) return true;
  return isCurrentOnchainAgentOwner(agent, auth.wallet_address, env);
}

export function isAgentCreator(
  agent: { userId: number },
  auth: { user_id: number } | null | undefined,
): boolean {
  return !!auth && agent.userId === auth.user_id;
}
