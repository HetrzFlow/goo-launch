/**
 * deploy.ts — Deploy a GooAgentToken for a new agent.
 *
 * Reads from environment:
 *   DEPLOYER_PRIVATE_KEY   — Deployer wallet private key
 *   TOKEN_NAME             — Token name (e.g. "MyAgent Token")
 *   TOKEN_SYMBOL           — Token symbol (e.g. "MAGT")
 *   AGENT_WALLET           — Agent runtime wallet address (receives agent actions)
 *   SWAP_EXECUTOR_ADDRESS  — SwapExecutor address (deployed by deploy-infra)
 *   REGISTRY_ADDRESS       — GooAgentRegistry address (deployed by deploy-infra)
 *
 * Economic parameters (optional, sensible defaults):
 *   FIXED_BURN_RATE        — Daily burn in BNB (default: 0.001 BNB/day)
 *   MIN_RUNWAY_HOURS       — Hours for starving threshold (default: 72)
 *   STARVING_GRACE_PERIOD  — Seconds before Starving→Dying (default: 86400 = 24h)
 *   DYING_MAX_DURATION     — Seconds before Dying→Dead (default: 259200 = 72h)
 *   PULSE_TIMEOUT          — Seconds between required pulses (default: 3600 = 1h)
 *   SURVIVAL_SELL_COOLDOWN — Min seconds between sells (default: 300 = 5min)
 *   MAX_SELL_BPS           — Max % per sell in basis points (default: 500 = 5%)
 *   MIN_CTO_AMOUNT         — Min BNB for CTO (default: 0.1 BNB)
 *   FEE_RATE_BPS           — Transfer fee in bps (default: 100 = 1%)
 *   CIRCULATION_BPS        — % of supply in circulation in bps (default: 1000 = 10%)
 *
 * Outputs JSON to stdout:
 *   { address, txHash, agentWallet }
 */
import { ethers } from "hardhat";

function envOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.error(`[Deploy] Deployer: ${deployer.address}`);

  // Required env vars
  const tokenName = process.env.TOKEN_NAME;
  const tokenSymbol = process.env.TOKEN_SYMBOL;
  const agentWallet = process.env.AGENT_WALLET;
  const swapExecutorAddress = process.env.SWAP_EXECUTOR_ADDRESS;
  const registryAddress = process.env.REGISTRY_ADDRESS;

  if (!tokenName || !tokenSymbol) {
    throw new Error("TOKEN_NAME and TOKEN_SYMBOL are required");
  }
  if (!agentWallet) {
    throw new Error("AGENT_WALLET is required");
  }
  if (!swapExecutorAddress || !registryAddress) {
    throw new Error("SWAP_EXECUTOR_ADDRESS, REGISTRY_ADDRESS are required (run deploy-infra first)");
  }

  // Economic parameters with sensible defaults
  const fixedBurnRate = ethers.parseEther(envOrDefault("FIXED_BURN_RATE", "0")); // 0 = balance-based status
  const minRunwayHours = BigInt(envOrDefault("MIN_RUNWAY_HOURS", "72"));
  const starvingGracePeriod = BigInt(envOrDefault("STARVING_GRACE_PERIOD", "86400"));  // 24h
  const dyingMaxDuration = BigInt(envOrDefault("DYING_MAX_DURATION", "259200"));       // 72h
  const pulseTimeout = BigInt(envOrDefault("PULSE_TIMEOUT", "3600"));                   // 1h
  const survivalSellCooldown = BigInt(envOrDefault("SURVIVAL_SELL_COOLDOWN", "300"));   // 5min
  const maxSellBps = BigInt(envOrDefault("MAX_SELL_BPS", "500"));                       // 5%
  const minCtoAmount = ethers.parseEther(envOrDefault("MIN_CTO_AMOUNT", "0.1"));       // 0.1 BNB
  const feeRateBps = BigInt(envOrDefault("FEE_RATE_BPS", "100"));                       // 1%
  const circulationBps = BigInt(envOrDefault("CIRCULATION_BPS", "1000"));               // 10%

  console.error(`[Deploy] Token: ${tokenName} (${tokenSymbol})`);
  console.error(`[Deploy] Agent wallet: ${agentWallet}`);
  console.error(`[Deploy] Infra: swapExecutor=${swapExecutorAddress}, registry=${registryAddress}`);

  // BNB to forward to agent wallet during deploy (treasury BNB)
  const bnbFundAmount = envOrDefault("BNB_FUND_AMOUNT", "0.03"); // 30% of 0.1 BNB default
  const deployValue = ethers.parseEther(bnbFundAmount);

  const GooAgentToken = await ethers.getContractFactory("GooAgentToken");
  const token = await GooAgentToken.deploy(
    tokenName,
    tokenSymbol,
    agentWallet,
    swapExecutorAddress,
    registryAddress,
    fixedBurnRate,
    minRunwayHours,
    starvingGracePeriod,
    dyingMaxDuration,
    pulseTimeout,
    survivalSellCooldown,
    maxSellBps,
    minCtoAmount,
    feeRateBps,
    circulationBps,
    { value: deployValue },
  );
  await token.waitForDeployment();

  const address = await token.getAddress();
  const deployTx = token.deploymentTransaction();
  const txHash = deployTx?.hash || "";

  console.error(`[Deploy] GooAgentToken deployed: ${address} (tx: ${txHash})`);

  // Output JSON for server to parse
  console.log(JSON.stringify({ address, txHash, agentWallet }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
