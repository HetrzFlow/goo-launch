/**
 * create-pool-v2.ts — Create a WBNB/MockStable pool on PancakeSwap V2 (BSC Testnet)
 * and verify swap functionality.
 *
 * Steps:
 *   1. Mint MockStable to deployer
 *   2. Create WBNB/MockStable pair on PancakeSwap V2 Factory (or reuse existing)
 *   3. Add liquidity via PancakeSwap V2 Router (addLiquidityETH)
 *   4. Verify swap: MockStable -> BNB via swapExactTokensForETHSupportingFeeOnTransferTokens
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... STABLE_TOKEN=0x... npx hardhat run scripts/create-pool-v2.ts --network bscTestnet
 */
import { ethers } from "hardhat";

// ─── PancakeSwap V2 BSC Testnet addresses ──────────────────────────────
const PANCAKE_FACTORY = "0x6725F303b657a9451d8BA641348b6761A6CC7a17";
const PANCAKE_ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";

// ─── ABIs (only what we need) ───────────────────────────────────────────
const FACTORY_ABI = [
  "function createPair(address tokenA, address tokenB) external returns (address pair)",
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
];

const ROUTER_ABI = [
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function mint(address to, uint256 amount) external",
  "function decimals() external view returns (uint8)",
];

async function main() {
  const stableToken = process.env.STABLE_TOKEN;
  if (!stableToken) {
    throw new Error("STABLE_TOKEN env var is required (MockStable address)");
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const stable = new ethers.Contract(stableToken, ERC20_ABI, deployer);
  const factory = new ethers.Contract(PANCAKE_FACTORY, FACTORY_ABI, deployer);
  const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, deployer);

  const decimals = await stable.decimals();
  console.log(`MockStable: ${stableToken} (decimals: ${decimals})`);

  // ─── 1. Mint MockStable to deployer ───────────────────────────────────
  const mintAmount = ethers.parseUnits("100", decimals); // 100 USDT
  console.log(`\nMinting ${ethers.formatUnits(mintAmount, decimals)} MockStable to deployer...`);
  const mintTx = await stable.mint(deployer.address, mintAmount);
  await mintTx.wait();
  console.log(`Minted. Balance: ${ethers.formatUnits(await stable.balanceOf(deployer.address), decimals)}`);

  // ─── 2. Create or get existing pair ───────────────────────────────────
  let pairAddress = await factory.getPair(stableToken, WBNB);
  if (pairAddress === ethers.ZeroAddress) {
    console.log("\nCreating WBNB/MockStable pair...");
    const createTx = await factory.createPair(stableToken, WBNB);
    await createTx.wait();
    pairAddress = await factory.getPair(stableToken, WBNB);
    console.log(`Pair created: ${pairAddress}`);
  } else {
    console.log(`\nPair already exists: ${pairAddress}`);
  }

  // ─── 3. Add liquidity ─────────────────────────────────────────────────
  // Liquidity: 100 USDT + 0.2 BNB (sets initial price ~500 USDT/BNB)
  const tokenAmount = ethers.parseUnits("100", decimals);
  const ethAmount = ethers.parseEther("0.2"); // 0.2 BNB
  const deadline = Math.floor(Date.now() / 1000) + 600;

  console.log(`\nApproving router for ${ethers.formatUnits(tokenAmount, decimals)} MockStable...`);
  const approveTx = await stable.approve(PANCAKE_ROUTER, tokenAmount);
  await approveTx.wait();

  console.log(`Adding liquidity: ${ethers.formatUnits(tokenAmount, decimals)} USDT + ${ethers.formatEther(ethAmount)} BNB...`);
  const addLiqTx = await router.addLiquidityETH(
    stableToken,
    tokenAmount,
    0, // amountTokenMin (accept any slippage for testnet)
    0, // amountETHMin
    deployer.address,
    deadline,
    { value: ethAmount },
  );
  const addLiqReceipt = await addLiqTx.wait();
  console.log(`Liquidity added! tx: ${addLiqReceipt.hash}`);

  // ─── 4. Verify swap: MockStable -> BNB ────────────────────────────────
  const swapAmount = ethers.parseUnits("10", decimals); // 10 USDT
  console.log(`\nVerifying swap: ${ethers.formatUnits(swapAmount, decimals)} MockStable -> BNB...`);

  const approveSwapTx = await stable.approve(PANCAKE_ROUTER, swapAmount);
  await approveSwapTx.wait();

  const balanceBefore = await ethers.provider.getBalance(deployer.address);

  const swapTx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
    swapAmount,
    0, // amountOutMin (accept any for test)
    [stableToken, WBNB],
    deployer.address,
    deadline,
  );
  const swapReceipt = await swapTx.wait();

  const balanceAfter = await ethers.provider.getBalance(deployer.address);
  const gasCost = swapReceipt.gasUsed * swapReceipt.gasPrice;
  const bnbReceived = balanceAfter - balanceBefore + gasCost;

  console.log(`Swap successful! tx: ${swapReceipt.hash}`);
  console.log(`BNB received: ~${ethers.formatEther(bnbReceived)} BNB`);

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log("\n=== Summary ===");
  console.log(`MockStable:       ${stableToken}`);
  console.log(`PancakeSwap V2 Router: ${PANCAKE_ROUTER}`);
  console.log(`PancakeSwap V2 Factory: ${PANCAKE_FACTORY}`);
  console.log(`WBNB:             ${WBNB}`);
  console.log(`Pair:             ${pairAddress}`);
  console.log(`\nUse ROUTER_ADDRESS=${PANCAKE_ROUTER} when deploying agents for real swap support.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
