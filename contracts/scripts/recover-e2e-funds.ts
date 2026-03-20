/**
 * recover-e2e-funds.ts — Recover BNB from E2E test artifacts
 *
 * Recovers funds from:
 *   1. Agent wallet → deployer (BNB, USDT, AgentTokens)
 *   2. AgentToken/WBNB LP → remove liquidity → deployer
 *   3. WBNB/Stable LP → remove liquidity → deployer (optional)
 *   4. Swap recovered tokens back to BNB (AgentToken→BNB, USDT→BNB)
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... \
 *   TEST_WALLET_KEY=0x... \
 *   TOKEN_ADDRESS=0x... \
 *   STABLE_TOKEN=0x... \
 *   npx hardhat run scripts/recover-e2e-funds.ts --network bscTestnet
 *
 * Optional env:
 *   RECOVER_STABLE_LP=true  — Also remove WBNB/Stable pool LP (default: false)
 */
import { ethers } from "hardhat";

// ─── Constants ──────────────────────────────────────────────────────────

const PANCAKE_ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const PANCAKE_FACTORY = "0x6725F303b657a9451d8BA641348b6761A6CC7a17";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";

// ─── ABIs ───────────────────────────────────────────────────────────────

const ROUTER_ABI = [
  "function removeLiquidityETHSupportingFeeOnTransferTokens(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) returns (uint amountETH)",
  "function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) returns (uint amountToken, uint amountETH)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)",
];

const PAIR_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];

// ─── Helpers ────────────────────────────────────────────────────────────

let totalRecovered = 0n;

function logRecovered(label: string, amount: bigint) {
  totalRecovered += amount;
  console.log(`  +${ethers.formatEther(amount)} BNB (${label})`);
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const testWalletKey = process.env.TEST_WALLET_KEY;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const stableToken = process.env.STABLE_TOKEN;
  const recoverStableLP = process.env.RECOVER_STABLE_LP === "true";

  if (!testWalletKey) throw new Error("TEST_WALLET_KEY is required (agent wallet private key)");
  if (!stableToken) throw new Error("STABLE_TOKEN is required");

  const [deployer] = await ethers.getSigners();
  const agentWallet = new ethers.Wallet(testWalletKey, ethers.provider);
  const factory = new ethers.Contract(PANCAKE_FACTORY, FACTORY_ABI, ethers.provider);

  const deployerBnbBefore = await ethers.provider.getBalance(deployer.address);

  console.log(`Deployer:     ${deployer.address}`);
  console.log(`Agent wallet: ${agentWallet.address}`);
  console.log(`Deployer BNB: ${ethers.formatEther(deployerBnbBefore)}`);
  if (tokenAddress) console.log(`Token:        ${tokenAddress}`);
  console.log(`Stable:       ${stableToken}`);

  const stable = new ethers.Contract(stableToken, ERC20_ABI, ethers.provider);
  const stableDecimals = await stable.decimals();
  const stableSymbol = await stable.symbol();

  // ═══════════════════════════════════════════════════════════════════════
  // Step 1: Sweep agent wallet → deployer
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n=== Step 1: Sweep Agent Wallet ===`);

  // 1a. Transfer USDT from agent wallet
  const agentUsdt = await stable.balanceOf(agentWallet.address);
  if (agentUsdt > 0n) {
    const stableWithAgent = new ethers.Contract(stableToken, ERC20_ABI, agentWallet);
    const tx = await stableWithAgent.transfer(deployer.address, agentUsdt);
    await tx.wait();
    console.log(`  Transferred ${ethers.formatUnits(agentUsdt, stableDecimals)} ${stableSymbol} → deployer`);
  } else {
    console.log(`  No ${stableSymbol} in agent wallet`);
  }

  // 1b. Transfer AgentTokens from agent wallet (if token address provided)
  if (tokenAddress) {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, agentWallet);
    const agentTokens = await tokenContract.balanceOf(agentWallet.address);
    if (agentTokens > 0n) {
      const tx = await tokenContract.transfer(deployer.address, agentTokens);
      await tx.wait();
      console.log(`  Transferred ${ethers.formatEther(agentTokens)} AgentTokens → deployer (1% FoT applied)`);
    } else {
      console.log(`  No AgentTokens in agent wallet`);
    }
  }

  // 1c. Sweep remaining BNB (leave gas for the tx itself)
  const agentBnb = await ethers.provider.getBalance(agentWallet.address);
  if (agentBnb > ethers.parseEther("0.001")) {
    const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 5_000_000_000n;
    const gasLimit = 21000n;
    const gasCost = gasPrice * gasLimit;
    const sendAmount = agentBnb - gasCost;

    if (sendAmount > 0n) {
      const tx = await agentWallet.sendTransaction({
        to: deployer.address,
        value: sendAmount,
        gasLimit,
      });
      await tx.wait();
      logRecovered("agent wallet BNB", sendAmount);
    }
  } else {
    console.log(`  Agent BNB too small to sweep (${ethers.formatEther(agentBnb)})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 2: Remove AgentToken/WBNB LP
  // ═══════════════════════════════════════════════════════════════════════
  if (tokenAddress) {
    console.log(`\n=== Step 2: Remove AgentToken/WBNB LP ===`);
    const tokenPairAddr = await factory.getPair(tokenAddress, WBNB);

    if (tokenPairAddr !== ethers.ZeroAddress) {
      const pair = new ethers.Contract(tokenPairAddr, PAIR_ABI, deployer);
      const lpBalance = await pair.balanceOf(deployer.address);

      if (lpBalance > 0n) {
        console.log(`  LP tokens: ${ethers.formatEther(lpBalance)}`);

        // Approve router to spend LP tokens
        const approveTx = await pair.approve(PANCAKE_ROUTER, lpBalance);
        await approveTx.wait();

        // Remove liquidity (FoT variant for AgentToken)
        const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, deployer);
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const bnbBefore = await ethers.provider.getBalance(deployer.address);

        const tx = await router.removeLiquidityETHSupportingFeeOnTransferTokens(
          tokenAddress,
          lpBalance,
          0n, // amountTokenMin
          0n, // amountETHMin
          deployer.address,
          deadline,
        );
        const receipt = await tx.wait();

        const bnbAfter = await ethers.provider.getBalance(deployer.address);
        const gasCost = receipt.gasUsed * (receipt.gasPrice ?? 0n);
        const bnbRecovered = bnbAfter - bnbBefore + gasCost;
        logRecovered("AgentToken/WBNB LP → BNB", bnbRecovered);

        // Check how many AgentTokens we got back
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, ethers.provider);
        const deployerTokens = await tokenContract.balanceOf(deployer.address);
        if (deployerTokens > 0n) {
          console.log(`  Got ${ethers.formatEther(deployerTokens)} AgentTokens back`);
        }
      } else {
        console.log(`  No LP tokens held by deployer`);
      }
    } else {
      console.log(`  No AgentToken/WBNB pair found`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 3: Swap recovered AgentTokens → BNB
  // ═══════════════════════════════════════════════════════════════════════
  if (tokenAddress) {
    console.log(`\n=== Step 3: Swap AgentTokens → BNB ===`);
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, deployer);
    const tokenBalance = await tokenContract.balanceOf(deployer.address);

    if (tokenBalance > 0n) {
      // Approve router
      const approveTx = await tokenContract.approve(PANCAKE_ROUTER, tokenBalance);
      await approveTx.wait();

      const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, deployer);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const bnbBefore = await ethers.provider.getBalance(deployer.address);

      const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
        tokenBalance,
        0n,
        [tokenAddress, WBNB],
        deployer.address,
        deadline,
      );
      const receipt = await tx.wait();

      const bnbAfter = await ethers.provider.getBalance(deployer.address);
      const gasCost = receipt.gasUsed * (receipt.gasPrice ?? 0n);
      const bnbRecovered = bnbAfter - bnbBefore + gasCost;
      logRecovered("AgentToken → BNB swap", bnbRecovered);
    } else {
      console.log(`  No AgentTokens to swap`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 4: Swap recovered USDT → BNB
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n=== Step 4: Swap ${stableSymbol} → BNB ===`);
  const deployerUsdt = await stable.balanceOf(deployer.address);

  if (deployerUsdt > 0n) {
    const stableWithDeployer = new ethers.Contract(stableToken, ERC20_ABI, deployer);
    const approveTx = await stableWithDeployer.approve(PANCAKE_ROUTER, deployerUsdt);
    await approveTx.wait();

    const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, deployer);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const bnbBefore = await ethers.provider.getBalance(deployer.address);

    const tx = await router.swapExactTokensForETH(
      deployerUsdt,
      0n,
      [stableToken, WBNB],
      deployer.address,
      deadline,
    );
    const receipt = await tx.wait();

    const bnbAfter = await ethers.provider.getBalance(deployer.address);
    const gasCost = receipt.gasUsed * (receipt.gasPrice ?? 0n);
    const bnbRecovered = bnbAfter - bnbBefore + gasCost;
    logRecovered(`${stableSymbol} → BNB swap`, bnbRecovered);
  } else {
    console.log(`  No ${stableSymbol} to swap`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 5 (optional): Remove WBNB/Stable LP
  // ═══════════════════════════════════════════════════════════════════════
  if (recoverStableLP) {
    console.log(`\n=== Step 5: Remove WBNB/${stableSymbol} LP ===`);
    const stablePairAddr = await factory.getPair(WBNB, stableToken);

    if (stablePairAddr !== ethers.ZeroAddress) {
      const pair = new ethers.Contract(stablePairAddr, PAIR_ABI, deployer);
      const lpBalance = await pair.balanceOf(deployer.address);

      if (lpBalance > 0n) {
        console.log(`  LP tokens: ${ethers.formatEther(lpBalance)}`);

        const approveTx = await pair.approve(PANCAKE_ROUTER, lpBalance);
        await approveTx.wait();

        const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, deployer);
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const bnbBefore = await ethers.provider.getBalance(deployer.address);

        const tx = await router.removeLiquidityETH(
          stableToken,
          lpBalance,
          0n,
          0n,
          deployer.address,
          deadline,
        );
        const receipt = await tx.wait();

        const bnbAfter = await ethers.provider.getBalance(deployer.address);
        const gasCost = receipt.gasUsed * (receipt.gasPrice ?? 0n);
        const bnbRecovered = bnbAfter - bnbBefore + gasCost;
        logRecovered(`WBNB/${stableSymbol} LP → BNB`, bnbRecovered);

        // Swap the recovered stable tokens too
        const stableAfter = await stable.balanceOf(deployer.address);
        if (stableAfter > 0n) {
          const stableWithDeployer = new ethers.Contract(stableToken, ERC20_ABI, deployer);
          const appTx = await stableWithDeployer.approve(PANCAKE_ROUTER, stableAfter);
          await appTx.wait();

          const bnbBefore2 = await ethers.provider.getBalance(deployer.address);
          const swapTx = await router.swapExactTokensForETH(
            stableAfter,
            0n,
            [stableToken, WBNB],
            deployer.address,
            deadline,
          );
          const swapReceipt = await swapTx.wait();

          const bnbAfter2 = await ethers.provider.getBalance(deployer.address);
          const gasCost2 = swapReceipt.gasUsed * (swapReceipt.gasPrice ?? 0n);
          const bnbRecovered2 = bnbAfter2 - bnbBefore2 + gasCost2;
          logRecovered(`recovered ${stableSymbol} → BNB`, bnbRecovered2);
        }
      } else {
        console.log(`  No LP tokens held by deployer`);
      }
    } else {
      console.log(`  No WBNB/${stableSymbol} pair found`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════
  const deployerBnbAfter = await ethers.provider.getBalance(deployer.address);
  const netChange = deployerBnbAfter - deployerBnbBefore;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  RECOVERY SUMMARY`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Deployer BNB before: ${ethers.formatEther(deployerBnbBefore)}`);
  console.log(`  Deployer BNB after:  ${ethers.formatEther(deployerBnbAfter)}`);
  console.log(`  Net change:          ${netChange >= 0n ? "+" : ""}${ethers.formatEther(netChange)} BNB`);
  console.log(`  (gas fees deducted from net change)`);

  // Check remaining balances
  const remainingAgentBnb = await ethers.provider.getBalance(agentWallet.address);
  const remainingStable = await stable.balanceOf(deployer.address);

  if (remainingAgentBnb > 0n) {
    console.log(`\n  Remaining in agent wallet: ${ethers.formatEther(remainingAgentBnb)} BNB (dust)`);
  }
  if (remainingStable > 0n) {
    console.log(`  Remaining ${stableSymbol}: ${ethers.formatUnits(remainingStable, stableDecimals)}`);
  }

  if (!recoverStableLP) {
    const stablePairAddr = await factory.getPair(WBNB, stableToken);
    if (stablePairAddr !== ethers.ZeroAddress) {
      const pair = new ethers.Contract(stablePairAddr, PAIR_ABI, ethers.provider);
      const stableLpBal = await pair.balanceOf(deployer.address);
      if (stableLpBal > 0n) {
        console.log(`\n  Note: WBNB/${stableSymbol} LP not recovered (${ethers.formatEther(stableLpBal)} LP tokens)`);
        console.log(`  Run with RECOVER_STABLE_LP=true to also recover pool liquidity`);
      }
    }
  }

  console.log(`${"=".repeat(60)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
