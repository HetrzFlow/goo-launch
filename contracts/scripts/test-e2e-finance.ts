/**
 * test-e2e-finance.ts — End-to-end finance integration test on BSC Testnet
 *
 * Deploys a GooAgentToken, creates LP, registers in registry, then tests:
 *   1. Initial state verification
 *   2. BNB → USDT swap (payment-token-refill path)
 *   3. USDT Permit2 approval
 *   4. BNB → AgentToken buyback (FoT-aware)
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... \
 *   STABLE_TOKEN=0x... \
 *   REGISTRY_ADDRESS=0x... \
 *   npx hardhat run scripts/test-e2e-finance.ts --network bscTestnet
 *
 * Optional env:
 *   TEST_WALLET_KEY    — Reuse agent wallet (skip random generation)
 *   CONTRIBUTION_BNB   — Token deploy contribution (default: 0.2)
 *   AGENT_FUND_BNB     — Extra BNB for agent wallet (default: 0.1)
 */
import { ethers } from "hardhat";

// ─── Constants ──────────────────────────────────────────────────────────

const PANCAKE_ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const PANCAKE_FACTORY = "0x6725F303b657a9451d8BA641348b6761A6CC7a17";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX_UINT256 = 2n ** 256n - 1n;

// ─── ABIs ───────────────────────────────────────────────────────────────

const ROUTER_ABI = [
  "function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable",
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)",
  "function WETH() view returns (address)",
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
  "function factory() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function sync()",
];

const TOKEN_ABI = [
  "function getAgentStatus() view returns (uint8)",
  "function treasuryBalance() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function agentWallet() view returns (address)",
  "function swapExecutor() view returns (address)",
  "function feeRate() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function registerInRegistry(string genomeURI)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// ─── Status enum ────────────────────────────────────────────────────────

const STATUS_NAMES = ["ACTIVE", "STARVING", "DYING", "DEAD"];

// ─── Test runner ────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  txHash?: string;
  details: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function runTest(
  name: string,
  fn: () => Promise<{ txHash?: string; details: string }>,
): Promise<void> {
  process.stdout.write(`\n--- Test: ${name} ---\n`);
  try {
    const { txHash, details } = await fn();
    results.push({ name, passed: true, txHash, details });
    console.log(`PASS: ${details}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, details: msg });
    console.log(`FAIL: ${msg}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  // ── Env ──
  const stableToken = process.env.STABLE_TOKEN;
  const registryAddress = process.env.REGISTRY_ADDRESS;
  if (!stableToken) throw new Error("STABLE_TOKEN env var is required");
  if (!registryAddress) throw new Error("REGISTRY_ADDRESS env var is required");

  const contributionBnb = parseFloat(process.env.CONTRIBUTION_BNB || "0.2");
  const agentFundBnb = parseFloat(process.env.AGENT_FUND_BNB || "0.1");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Deployer BNB: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);

  // ── Agent wallet ──
  let agentWallet: ReturnType<typeof ethers.Wallet.createRandom> & { connect: (p: typeof ethers.provider) => any };
  if (process.env.TEST_WALLET_KEY) {
    agentWallet = new ethers.Wallet(process.env.TEST_WALLET_KEY, ethers.provider) as any;
    console.log(`Agent wallet (reused): ${agentWallet.address}`);
  } else {
    agentWallet = ethers.Wallet.createRandom().connect(ethers.provider) as any;
    console.log(`Agent wallet (new): ${agentWallet.address}`);
    console.log(`Agent private key: ${agentWallet.privateKey}`);
  }

  // ── Ensure WBNB/Stable pool has liquidity ──
  console.log(`\n=== Pool Check ===`);
  const factory = new ethers.Contract(PANCAKE_FACTORY, FACTORY_ABI, ethers.provider);
  const pairAddr = await factory.getPair(WBNB, stableToken);

  const stable = new ethers.Contract(stableToken, ERC20_ABI, ethers.provider);
  const stableDecimals = await stable.decimals();
  const stableSymbol = await stable.symbol();

  // Check if pool needs liquidity (missing or drained by recovery)
  const minWbnbReserve = ethers.parseEther("0.1"); // need at least 0.1 WBNB for swaps
  const minStableReserve = ethers.parseUnits("10", stableDecimals); // need at least 10 USDT
  let needsLiquidity = pairAddr === ethers.ZeroAddress;

  if (!needsLiquidity) {
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, ethers.provider);
    const [r0, r1] = await pair.getReserves();
    const token0 = await pair.token0();
    const [rWbnb, rStable] = token0.toLowerCase() === WBNB.toLowerCase() ? [r0, r1] : [r1, r0];
    console.log(`Pool exists: ${pairAddr}`);
    console.log(`  WBNB reserve: ${ethers.formatEther(rWbnb)}`);
    console.log(`  ${stableSymbol} reserve: ${ethers.formatUnits(rStable, stableDecimals)}`);
    if (rWbnb < minWbnbReserve || rStable < minStableReserve) {
      console.log(`  Reserves too low (need ≥0.1 WBNB and ≥10 ${stableSymbol}), adding liquidity...`);
      needsLiquidity = true;
    }
  } else {
    console.log(`No WBNB/${stableSymbol} pool found.`);
  }

  if (needsLiquidity) {
    const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, deployer);
    const stableWithSigner = new ethers.Contract(stableToken, [...ERC20_ABI, "function mint(address to, uint256 amount)"], deployer);

    const liquidityStable = ethers.parseUnits("250", stableDecimals);
    const liquidityBnb = ethers.parseEther("0.5");

    // Mint tUSDT to deployer if balance insufficient
    const stableBal = await stableWithSigner.balanceOf(deployer.address);
    if (stableBal < liquidityStable) {
      const mintAmount = liquidityStable - stableBal;
      console.log(`  Minting ${ethers.formatUnits(mintAmount, stableDecimals)} ${stableSymbol} to deployer...`);
      const mintTx = await stableWithSigner.mint(deployer.address, mintAmount);
      await mintTx.wait();
    }

    // If pair exists but reserves are skewed, donate tUSDT to rebalance before adding liquidity
    if (pairAddr !== ethers.ZeroAddress) {
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, deployer);
      const [r0] = await pair.getReserves();
      if (r0 > 0n) {
        // Donate tUSDT directly to pair to fix ratio, then sync
        const donateAmount = ethers.parseUnits("250", stableDecimals);
        const mintDonate = await stableWithSigner.mint(deployer.address, donateAmount);
        await mintDonate.wait();
        const donateTx = await stableWithSigner.transfer(pairAddr, donateAmount);
        await donateTx.wait();
        const syncTx = await pair.sync();
        await syncTx.wait();
        console.log(`  Rebalanced pool via donate + sync`);
      }
    }

    console.log(`  Adding liquidity: 0.5 BNB + 250 ${stableSymbol}...`);
    const approveTx = await stableWithSigner.approve(PANCAKE_ROUTER, liquidityStable);
    await approveTx.wait();

    const addLiqTx = await router.addLiquidityETH(
      stableToken,
      liquidityStable,
      0n,
      0n,
      deployer.address,
      Math.floor(Date.now() / 1000) + 600,
      { value: liquidityBnb },
    );
    await addLiqTx.wait();
    console.log(`  Pool liquidity added: ${addLiqTx.hash}`);
  }

  // ── Deploy GooAgentToken ──
  console.log(`\n=== Deploy GooAgentToken ===`);
  const treasuryBnb = contributionBnb * 0.30; // TREASURY_BNB_BPS = 3000
  const lpBnb = contributionBnb - treasuryBnb;
  const circulationBps = 2000n; // 20%
  const TOTAL_SUPPLY = 1_000_000_000n;
  const treasuryTokens = TOTAL_SUPPLY * 500n / 10000n; // 5% = 50M
  const lpTokens = TOTAL_SUPPLY * (circulationBps - 500n) / 10000n; // 15% = 150M

  console.log(`Contribution: ${contributionBnb} BNB`);
  console.log(`Treasury BNB: ${treasuryBnb.toFixed(4)} BNB`);
  console.log(`LP: ${lpTokens}M tokens + ${lpBnb.toFixed(4)} BNB`);

  // Deploy SwapExecutorV2 wrapping PancakeSwap V2 Router
  const SwapExecutor = await ethers.getContractFactory("SwapExecutorV2");
  const executor = await SwapExecutor.deploy(PANCAKE_ROUTER);
  await executor.waitForDeployment();
  const executorAddress = await executor.getAddress();
  console.log(`SwapExecutorV2 deployed: ${executorAddress}`);

  const GooAgentToken = await ethers.getContractFactory("GooAgentToken");
  const deployValue = ethers.parseEther(treasuryBnb.toFixed(18));

  const token = await GooAgentToken.deploy(
    "E2E Test Token",          // name
    "E2ET",                    // symbol
    agentWallet.address,       // agentWallet
    executorAddress,           // swapExecutor
    registryAddress,           // registry
    ethers.parseEther("0.001"), // fixedBurnRate (0.001 BNB/day)
    72n,                       // minRunwayHours
    86400n,                    // starvingGracePeriod (24h)
    259200n,                   // dyingMaxDuration (72h)
    86400n,                    // pulseTimeout (24h — relaxed for testing)
    60n,                       // survivalSellCooldown (1min — short for testing)
    500n,                      // maxSellBps (5%)
    ethers.parseEther("0.1"),  // minCtoAmount
    100n,                      // feeRateBps (1%)
    circulationBps,            // circulationBps (20%)
    { value: deployValue },
  );
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`Token deployed: ${tokenAddress}`);

  // ── Create LP: approve + addLiquidityETH ──
  console.log(`\n=== Create AgentToken/WBNB LP ===`);
  const tokenAsDeployer = new ethers.Contract(tokenAddress, TOKEN_ABI, deployer);
  const lpTokenAmount = ethers.parseUnits(lpTokens.toString(), 18);
  const lpBnbWei = ethers.parseEther(lpBnb.toFixed(18));

  // Deployer has the LP tokens (circulatingTokens - treasuryTokens were sent to deployer)
  const deployerTokenBal = await tokenAsDeployer.balanceOf(deployer.address);
  console.log(`Deployer token balance: ${ethers.formatEther(deployerTokenBal)}`);
  assert(deployerTokenBal >= lpTokenAmount, `Deployer needs ${lpTokens}M tokens for LP`);

  const approveTx = await tokenAsDeployer.approve(PANCAKE_ROUTER, lpTokenAmount);
  await approveTx.wait();
  console.log(`Approved router for ${ethers.formatEther(lpTokenAmount)} tokens`);

  const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, deployer);
  const addLiqTx = await router.addLiquidityETH(
    tokenAddress,
    lpTokenAmount,
    0n, // amountTokenMin = 0 due to 1% FoT
    0n, // amountETHMin = 0
    deployer.address,
    Math.floor(Date.now() / 1000) + 600,
    { value: lpBnbWei },
  );
  const addLiqReceipt = await addLiqTx.wait();
  console.log(`LP created: ${addLiqReceipt.hash}`);

  // ── Register in registry ──
  console.log(`\n=== Register in Registry ===`);
  // Need to fund agent wallet first so it can call registerInRegistry
  const fundTx = await deployer.sendTransaction({
    to: agentWallet.address,
    value: ethers.parseEther(agentFundBnb.toFixed(18)),
  });
  await fundTx.wait();
  console.log(`Funded agent wallet with ${agentFundBnb} BNB`);

  const tokenAsAgent = new ethers.Contract(tokenAddress, TOKEN_ABI, agentWallet);
  const regTx = await tokenAsAgent.registerInRegistry("ipfs://e2e-test-genome");
  await regTx.wait();
  console.log(`Registered in registry: ${regTx.hash}`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TESTS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const tokenContract = new ethers.Contract(tokenAddress, TOKEN_ABI, ethers.provider);
  const stableContract = new ethers.Contract(stableToken, ERC20_ABI, agentWallet);

  // ── Test 1: Verify Initial State ──
  await runTest("Verify Initial State", async () => {
    const agentBnb = await ethers.provider.getBalance(agentWallet.address);
    const agentUsdt = await stableContract.balanceOf(agentWallet.address);
    const agentTokens = await tokenContract.balanceOf(agentWallet.address);
    const status = await tokenContract.getAgentStatus();
    const executorAddr = await tokenContract.swapExecutor();

    const expectedTreasuryTokens = ethers.parseUnits(treasuryTokens.toString(), 18);

    assert(agentBnb > 0n, `Agent should have BNB, got ${ethers.formatEther(agentBnb)}`);
    assert(agentUsdt === 0n, `Agent should have 0 USDT, got ${ethers.formatUnits(agentUsdt, stableDecimals)}`);
    assert(agentTokens === expectedTreasuryTokens, `Agent should have ${treasuryTokens}M tokens, got ${ethers.formatEther(agentTokens)}`);
    assert(Number(status) === 0, `Status should be ACTIVE(0), got ${STATUS_NAMES[Number(status)]}`);
    assert(executorAddr.toLowerCase() === executorAddress.toLowerCase(), `SwapExecutor mismatch`);

    return {
      details: [
        `BNB=${ethers.formatEther(agentBnb)}`,
        `USDT=0`,
        `Tokens=${ethers.formatEther(agentTokens)}`,
        `Status=${STATUS_NAMES[Number(status)]}`,
        `SwapExecutor=${executorAddr}`,
      ].join(", "),
    };
  });

  // ── Test 2: BNB → USDT Swap ──
  await runTest("BNB → USDT Swap (payment-token-refill path)", async () => {
    const routerWithSigner = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, agentWallet);
    const swapAmount = ethers.parseEther("0.005");
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const usdtBefore = await stableContract.balanceOf(agentWallet.address);

    const tx = await routerWithSigner.swapExactETHForTokens(
      0n,
      [WBNB, stableToken],
      agentWallet.address,
      deadline,
      { value: swapAmount },
    );
    const receipt = await tx.wait();

    const usdtAfter = await stableContract.balanceOf(agentWallet.address);
    const received = usdtAfter - usdtBefore;

    assert(received > 0n, `Should receive USDT, got ${received}`);

    return {
      txHash: receipt.hash,
      details: `Swapped 0.005 BNB → ${ethers.formatUnits(received, stableDecimals)} ${stableSymbol}`,
    };
  });

  // ── Test 3: USDT Permit2 Approval ──
  await runTest("USDT Permit2 Approval", async () => {
    const tx = await stableContract.approve(PERMIT2_ADDRESS, MAX_UINT256);
    const receipt = await tx.wait();

    const allowance = await stableContract.allowance(agentWallet.address, PERMIT2_ADDRESS);
    assert(allowance === MAX_UINT256, `Allowance should be MAX_UINT256, got ${allowance}`);

    return {
      txHash: receipt.hash,
      details: `Approved Permit2 for MAX_UINT256 ${stableSymbol}`,
    };
  });

  // ── Test 4: BNB → AgentToken Buyback ──
  await runTest("BNB → AgentToken Buyback (FoT-aware)", async () => {
    const routerWithSigner = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, agentWallet);
    const buybackAmount = ethers.parseEther("0.01");
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // Quote
    const amounts = await routerWithSigner.getAmountsOut(buybackAmount, [WBNB, tokenAddress]);
    const quotedRaw = amounts[1];

    // Record before
    const tokenBefore = await tokenContract.balanceOf(agentWallet.address);

    // Swap using FoT variant
    const tx = await routerWithSigner.swapExactETHForTokensSupportingFeeOnTransferTokens(
      0n,
      [WBNB, tokenAddress],
      agentWallet.address,
      deadline,
      { value: buybackAmount },
    );
    const receipt = await tx.wait();

    // Record after
    const tokenAfter = await tokenContract.balanceOf(agentWallet.address);
    const received = tokenAfter - tokenBefore;

    assert(received > 0n, `Should receive tokens, got 0`);
    assert(received < quotedRaw, `Received should be less than quote due to FoT`);

    // Calculate FoT impact
    const fotPct = Number((quotedRaw - received) * 10000n / quotedRaw) / 100;

    return {
      txHash: receipt.hash,
      details: [
        `Swapped 0.01 BNB → ${ethers.formatEther(received)} tokens`,
        `Quoted: ${ethers.formatEther(quotedRaw)}`,
        `FoT impact: ${fotPct.toFixed(2)}%`,
      ].join(", "),
    };
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Summary
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  E2E FINANCE TEST SUMMARY`);
  console.log(`${"=".repeat(60)}`);

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const r of results) {
    const icon = r.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${r.name}`);
    console.log(`         ${r.details}`);
    if (r.txHash) console.log(`         tx: ${r.txHash}`);
  }

  console.log(`\n  Result: ${passed}/${results.length} passed, ${failed} failed`);

  // Final balances
  const finalBnb = await ethers.provider.getBalance(agentWallet.address);
  const finalUsdt = await stableContract.balanceOf(agentWallet.address);
  const finalTokens = await tokenContract.balanceOf(agentWallet.address);

  console.log(`\n  Final agent balances:`);
  console.log(`    BNB:    ${ethers.formatEther(finalBnb)}`);
  console.log(`    ${stableSymbol}:   ${ethers.formatUnits(finalUsdt, stableDecimals)}`);
  console.log(`    Tokens: ${ethers.formatEther(finalTokens)}`);
  console.log(`    Token:  ${tokenAddress}`);

  console.log(`\n  Reuse:`);
  console.log(`    TEST_WALLET_KEY=${agentWallet.privateKey}`);
  console.log(`${"=".repeat(60)}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
