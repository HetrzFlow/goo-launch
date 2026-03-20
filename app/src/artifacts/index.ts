import GooAgentToken from './GooAgentToken.json';
import GooAgentRegistry from './GooAgentRegistry.json';

export function getTokenArtifact(): { abi: unknown[]; bytecode: string } {
  return { abi: GooAgentToken.abi, bytecode: GooAgentToken.bytecode };
}

export function getRegistryArtifact(): { abi: unknown[] } {
  return { abi: GooAgentRegistry.abi };
}
