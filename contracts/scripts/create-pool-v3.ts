/**
 * create-pool-v3.ts — Create a WBNB/USDT pool on PancakeSwap V3 (BSC Testnet)
 * and verify QuoterV2 + SwapRouter work correctly.
 *
 * Steps:
 *   1. Mint MockStable (USDT) to deployer
 *   2. Wrap BNB → WBNB
 *   3. Create & initialize WBNB/USDT pool via NonfungiblePositionManager
 *   4. Add full-range liquidity
 *   5. Verify: QuoterV2 quote
 *   6. Verify: SwapRouter exactInputSingle (BNB → USDT)
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/create-pool-v3.ts --network bscTestnet
 *
 * Env (optional):
 *   STABLE_TOKEN — MockStable address (default: 0xd56BC53a49d3fd9c058bAc2c44570d9e3B4F6e07)
 *   POOL_FEE    — Fee tier: 500, 2500, 10000 (default: 2500)
 */
import { ethers } from "hardhat";

// ─── BSC Testnet addresses ──────────────────────────────────────────────

const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const DEFAULT_USDT = "0xd56BC53a49d3fd9c058bAc2c44570d9e3B4F6e07";

const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const POSITION_MANAGER = "0x427bF5b37357632377eCbEC9de3626C71A5396c1";
const SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const QUOTER_V2 = "0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2";

// ─── Fee tier → tick spacing mapping ────────────────────────────────────

const TICK_SPACINGS: Record<number, number> = {
  100: 1,
  500: 10,
  2500: 50,
  10000: 200,
};

// ─── ABIs ───────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function approve(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address, uint256)",
  "function decimals() view returns (uint8)",
];

const WBNB_ABI = [
  "function deposit() payable",
  "function approve(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const FACTORY_ABI = [
  "function getPool(address, address, uint24) view returns (address)",
];

const PM_ABI = [
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Compute sqrtPriceX96 from a human-readable price ratio.
 * price = token1 / token0 (how many token1 per 1 token0, in decimal units).
 * Assumes both tokens have the same decimals.
 */
function encodeSqrtPriceX96(price: number): bigint {
  const sqrtPrice = Math.sqrt(price);
  const Q96 = 2n ** 96n;
  // Multiply with enough precision
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const usdt = process.env.STABLE_TOKEN || DEFAULT_USDT;
  const fee = Number(process.env.POOL_FEE || 2500);
  const tickSpacing = TICK_SPACINGS[fee];
  if (!tickSpacing) throw new Error(`Invalid fee tier: ${fee}`);

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`WBNB: ${WBNB}`);
  console.log(`USDT: ${usdt}`);
  console.log(`Fee: ${fee} (${fee / 10000 * 100}%), tickSpacing: ${tickSpacing}`);

  // Sort tokens (V3 requires token0 < token1)
  const [token0, token1] = WBNB.toLowerCase() < usdt.toLowerCase()
    ? [WBNB, usdt]
    : [usdt, WBNB];
  const wbnbIsToken0 = token0.toLowerCase() === WBNB.toLowerCase();
  console.log(`token0: ${wbnbIsToken0 ? "WBNB" : "USDT"}, token1: ${wbnbIsToken0 ? "USDT" : "WBNB"}`);

  const stable = new ethers.Contract(usdt, ERC20_ABI, deployer);
  const wbnb = new ethers.Contract(WBNB, WBNB_ABI, deployer);
  const factory = new ethers.Contract(PANCAKE_V3_FACTORY, FACTORY_ABI, deployer);
  const pm = new ethers.Contract(POSITION_MANAGER, PM_ABI, deployer);

  // ─── 1. Check if pool already exists ────────────────────────────────
  const existingPool = await factory.getPool(WBNB, usdt, fee);
  const poolExists = existingPool !== ethers.ZeroAddress;
  if (poolExists) {
    console.log(`\nPool already exists: ${existingPool}`);
  }

  // ─── 2. Check existing balances, mint/wrap only if needed ────────────
  const decimals = await stable.decimals();
  const bnbAmount = ethers.parseEther("0.002");
  const usdtAmount = ethers.parseUnits("1", decimals);

  const wbnbBal = await wbnb.balanceOf(deployer.address);
  const usdtBal = await stable.balanceOf(deployer.address);
  console.log(`\nExisting: ${ethers.formatEther(wbnbBal)} WBNB, ${ethers.formatUnits(usdtBal, decimals)} USDT`);

  if (wbnbBal < bnbAmount) {
    console.log(`Wrapping ${ethers.formatEther(bnbAmount)} BNB → WBNB...`);
    await (await wbnb.deposit({ value: bnbAmount })).wait();
  }
  if (usdtBal < usdtAmount) {
    console.log(`Minting ${ethers.formatUnits(usdtAmount, decimals)} USDT...`);
    await (await stable.mint(deployer.address, usdtAmount)).wait();
  }

  // ─── 3. Approve PositionManager (max approve) ──────────────────────
  const MAX = 2n ** 256n - 1n;
  console.log("Approving PositionManager...");
  await (await stable.approve(POSITION_MANAGER, MAX)).wait();
  await (await wbnb.approve(POSITION_MANAGER, MAX)).wait();

  // ─── 4. Create & initialize pool (skip if already exists) ───────────
  let poolAddress: string;
  if (!poolExists) {
    // Price: 1 WBNB = 500 USDT
    // If WBNB is token0: price = token1/token0 = USDT/WBNB = 500
    // If USDT is token0: price = token1/token0 = WBNB/USDT = 1/500 = 0.002
    const price = wbnbIsToken0 ? 500 : 1 / 500;
    const sqrtPriceX96 = encodeSqrtPriceX96(price);
    console.log(`\nCreating pool with price ${price} (sqrtPriceX96: ${sqrtPriceX96})...`);

    const createTx = await pm.createAndInitializePoolIfNecessary(
      token0, token1, fee, sqrtPriceX96,
    );
    const createReceipt = await createTx.wait();
    poolAddress = await factory.getPool(WBNB, usdt, fee);
    console.log(`Pool created: ${poolAddress} (tx: ${createReceipt.hash})`);
  } else {
    poolAddress = existingPool;
  }

  // ─── 5. Add full-range liquidity ────────────────────────────────────
  // MIN_TICK = -887272, MAX_TICK = 887272 — align inward to tick spacing
  const tickLower = Math.ceil(-887272 / tickSpacing) * tickSpacing;  // rounds toward 0
  const tickUpper = Math.floor(887272 / tickSpacing) * tickSpacing;

  const [amount0Desired, amount1Desired] = wbnbIsToken0
    ? [bnbAmount, usdtAmount]
    : [usdtAmount, bnbAmount];

  console.log(`\nAdding liquidity: ticks [${tickLower}, ${tickUpper}]`);
  console.log(`  amount0: ${ethers.formatEther(amount0Desired)} ${wbnbIsToken0 ? "WBNB" : "USDT"}`);
  console.log(`  amount1: ${ethers.formatEther(amount1Desired)} ${wbnbIsToken0 ? "USDT" : "WBNB"}`);

  const deadline = Math.floor(Date.now() / 1000) + 600;
  const mintTx = await pm.mint({
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: deployer.address,
    deadline,
  });
  const mintReceipt = await mintTx.wait();
  console.log(`Liquidity added! (tx: ${mintReceipt.hash})`);

  // ─── 6. Verify ──────────────────────────────────────────────────────
  await verifyQuoteAndSwap(deployer, usdt, fee);

  // ─── Summary ────────────────────────────────────────────────────────
  console.log("\n=== Summary ===");
  console.log(`Pool:        ${poolAddress}`);
  console.log(`Fee tier:    ${fee} (${fee / 10000 * 100}%)`);
  console.log(`WBNB:        ${WBNB}`);
  console.log(`USDT:        ${usdt}`);
  console.log(`SwapRouter:  ${SWAP_ROUTER}`);
  console.log(`QuoterV2:    ${QUOTER_V2}`);
  console.log(`PosManager:  ${POSITION_MANAGER}`);
}

async function verifyQuoteAndSwap(
  deployer: Awaited<ReturnType<typeof ethers.getSigners>>[0],
  usdt: string,
  fee: number,
) {
  const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, deployer);
  const swapRouter = new ethers.Contract(SWAP_ROUTER, SWAP_ROUTER_ABI, deployer);
  const stable = new ethers.Contract(usdt, ERC20_ABI, deployer);
  const decimals = await stable.decimals();

  // Quote
  const quoteAmountIn = ethers.parseEther("0.001"); // 0.001 BNB
  console.log(`\n--- Quote: ${ethers.formatEther(quoteAmountIn)} BNB → USDT (fee=${fee}) ---`);
  try {
    const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: WBNB,
      tokenOut: usdt,
      amountIn: quoteAmountIn,
      fee,
      sqrtPriceLimitX96: 0n,
    });
    console.log(`Quoted: ${ethers.formatUnits(amountOut, decimals)} USDT`);
  } catch (e: any) {
    console.log(`Quote failed: ${e.message}`);
    return;
  }

  // Swap
  const swapAmountIn = ethers.parseEther("0.001"); // 0.001 BNB
  console.log(`\n--- Swap: ${ethers.formatEther(swapAmountIn)} BNB → USDT ---`);
  const usdtBefore = await stable.balanceOf(deployer.address);

  const swapTx = await swapRouter.exactInputSingle(
    {
      tokenIn: WBNB,
      tokenOut: usdt,
      fee,
      recipient: deployer.address,
      amountIn: swapAmountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    },
    { value: swapAmountIn },
  );
  const swapReceipt = await swapTx.wait();

  const usdtAfter = await stable.balanceOf(deployer.address);
  const usdtReceived = usdtAfter - usdtBefore;

  console.log(`Swap OK! tx: ${swapReceipt.hash}`);
  console.log(`USDT received: ${ethers.formatUnits(usdtReceived, decimals)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
