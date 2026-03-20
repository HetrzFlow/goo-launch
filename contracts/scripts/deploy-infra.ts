/**
 * deploy-infra.ts — One-time deployment of shared infrastructure contracts.
 *
 * Deploys:
 *   1. GooAgentRegistry
 *   2. SwapExecutorV2
 *
 * Uses real PancakeSwap V2 router (no mock needed).
 *
 * Outputs JSON to stdout:
 *   { router, registry, swapExecutor, wbnb }
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy-infra.ts --network bscTestnet
 */
import { ethers } from "hardhat";

const NETWORKS: Record<string, { router: string; wbnb: string }> = {
  "97":  { router: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1", wbnb: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" },
  "56":  { router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.error(`[Infra] Deployer: ${deployer.address}`);
  console.error(`[Infra] Network: chainId=${network.chainId}`);

  const net = NETWORKS[network.chainId.toString()];
  if (!net) throw new Error(`Unsupported chainId: ${network.chainId}`);
  const routerAddr = net.router;
  console.error(`[Infra] Using PancakeSwap V2 Router: ${routerAddr}`);

  // 1. GooAgentRegistry (non-upgradeable)
  const Registry = await ethers.getContractFactory("GooAgentRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.error(`[Infra] GooAgentRegistry deployed: ${registryAddr}`);

  // 2. SwapExecutorV2 (wraps PancakeSwap V2 Router)
  const SwapExecutor = await ethers.getContractFactory("SwapExecutorV2");
  const executor = await SwapExecutor.deploy(routerAddr);
  await executor.waitForDeployment();
  const executorAddr = await executor.getAddress();
  console.error(`[Infra] SwapExecutorV2 deployed: ${executorAddr}`);

  // Output JSON for server to parse
  console.log(JSON.stringify({
    router: routerAddr,
    registry: registryAddr,
    swapExecutor: executorAddr,
    wbnb: net.wbnb,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
