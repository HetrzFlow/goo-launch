/**
 * agos-auto-fund.ts — Server-side AIOU auto-funding for AGOS agents.
 *
 * Uses the agent wallet to swap BNB → USDT → AIOU on BSC Mainnet,
 * then signs EIP-3009 server-side and settles funding with AGOS.
 *
 * This runs in the Cloudflare Worker context (not goo-core).
 */

// ── BSC Mainnet Constants ───────────────────────────────────────────────

const BSC_MAINNET_RPC = 'https://bsc-dataseed.binance.org/';
const BSC_MAINNET_CHAIN_ID = 56;

const AIOU_TOKEN = '0xF6138EE4174e85017bD43989CaAF8bC2D39aa733';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

const PANCAKE_V3_ROUTER = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4';
const PANCAKE_V3_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

const FEE_TIERS = [500, 2500, 10_000] as const;
const BNB_BUFFER_BPS = 105n;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const QUOTER_ABI = [
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const SWAP_ROUTER_ABI = [
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
];

const AIOU_DEPOSIT_ABI = ['function deposit(address token, uint256 amount)'];

// ── Types ───────────────────────────────────────────────────────────────

export interface AutoFundResult {
  success: boolean;
  error?: string;
  steps: string[];
  funded_amount?: string;
}

export interface AutoFundOptions {
  agentPrivateKey: string;
  targetAiou?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function findBestFeeTierForOutput(
  quoter: import('ethers').Contract,
  tokenIn: string,
  tokenOut: string,
  amountOut: bigint,
): Promise<{ fee: number; amountIn: bigint }> {
  let bestFee = 2500;
  let bestIn = 0n;

  for (const fee of FEE_TIERS) {
    try {
      const result = await quoter.quoteExactOutputSingle.staticCall({
        tokenIn,
        tokenOut,
        amount: amountOut,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const amountIn: bigint = result[0];
      if (bestIn === 0n || amountIn < bestIn) {
        bestIn = amountIn;
        bestFee = fee;
      }
    } catch {
      // Pool doesn't exist for this fee tier
    }
  }

  return { fee: bestFee, amountIn: bestIn };
}

// ── Main ────────────────────────────────────────────────────────────────

/**
 * Swap BNB → USDT → AIOU on BSC Mainnet using the agent wallet.
 *
 * Returns AIOU balance available for funding (on-chain, not yet sent to AGOS).
 * The caller is responsible for the EIP-3009 funding step.
 */
export async function swapBnbToAiou(
  opts: AutoFundOptions,
): Promise<AutoFundResult> {
  const { ethers } = await import('ethers');
  const steps: string[] = [];
  const targetAiou = opts.targetAiou ?? '10';

  try {
    const provider = new ethers.JsonRpcProvider(BSC_MAINNET_RPC, BSC_MAINNET_CHAIN_ID);
    const wallet = new ethers.Wallet(opts.agentPrivateKey, provider);
    steps.push(`Agent wallet: ${wallet.address}`);

    // 1. Check on-chain AIOU balance
    const aiouContract = new ethers.Contract(AIOU_TOKEN, ERC20_ABI, provider);
    let aiouBalance: bigint = await aiouContract.balanceOf(wallet.address);
    steps.push(`AIOU balance: ${ethers.formatUnits(aiouBalance, 18)}`);

    const targetWei = ethers.parseUnits(targetAiou, 18);

    if (aiouBalance >= targetWei) {
      steps.push('Already have enough AIOU — skipping swap.');
      return { success: true, steps, funded_amount: ethers.formatUnits(aiouBalance, 18) };
    }

    // 2. Check USDT balance
    const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
    let usdtBalance: bigint = await usdtContract.balanceOf(wallet.address);
    steps.push(`USDT balance: ${ethers.formatUnits(usdtBalance, 18)}`);

    // 3. If USDT < target, swap BNB → USDT
    if (usdtBalance < targetWei) {
      const nativeBalance = await provider.getBalance(wallet.address);
      steps.push(`BNB balance: ${ethers.formatEther(nativeBalance)}`);

      const usdtDeficit = targetWei - usdtBalance;
      const quoter = new ethers.Contract(PANCAKE_V3_QUOTER, QUOTER_ABI, provider);

      const { fee, amountIn: quotedBnb } = await findBestFeeTierForOutput(
        quoter, WBNB_ADDRESS, USDT_ADDRESS, usdtDeficit,
      );

      if (quotedBnb === 0n) {
        return { success: false, error: 'No V3 liquidity for BNB→USDT', steps };
      }

      const maxBnb = (quotedBnb * BNB_BUFFER_BPS) / 100n;
      const gasBuffer = ethers.parseEther('0.005');

      if (nativeBalance < maxBnb + gasBuffer) {
        return {
          success: false,
          error: `Insufficient BNB. Need ~${ethers.formatEther(maxBnb)} + gas, have ${ethers.formatEther(nativeBalance)}`,
          steps,
        };
      }

      steps.push(`Swapping ~${ethers.formatEther(maxBnb)} BNB → ${ethers.formatUnits(usdtDeficit, 18)} USDT (fee tier: ${fee})...`);

      const router = new ethers.Contract(PANCAKE_V3_ROUTER, SWAP_ROUTER_ABI, wallet);
      const swapTx = await router.exactOutputSingle(
        {
          tokenIn: WBNB_ADDRESS,
          tokenOut: USDT_ADDRESS,
          fee,
          recipient: wallet.address,
          amountOut: usdtDeficit,
          amountInMaximum: maxBnb,
          sqrtPriceLimitX96: 0n,
        },
        { value: maxBnb },
      );
      const swapReceipt = await swapTx.wait();
      steps.push(`BNB→USDT tx: ${swapReceipt.hash}`);

      usdtBalance = await usdtContract.balanceOf(wallet.address);
      steps.push(`USDT after swap: ${ethers.formatUnits(usdtBalance, 18)}`);
    }

    // 4. Deposit USDT → AIOU (1:1 mint)
    const depositAmount = usdtBalance < targetWei ? usdtBalance : targetWei;
    if (depositAmount > 0n) {
      const allowance: bigint = await usdtContract.allowance(wallet.address, AIOU_TOKEN);
      if (allowance < depositAmount) {
        steps.push('Approving USDT for AIOU...');
        const approveTx = await usdtContract.approve(AIOU_TOKEN, ethers.MaxUint256);
        await approveTx.wait();
      }

      steps.push(`Depositing ${ethers.formatUnits(depositAmount, 18)} USDT → AIOU...`);
      const aiouMint = new ethers.Contract(AIOU_TOKEN, AIOU_DEPOSIT_ABI, wallet);
      const depositTx = await aiouMint.deposit(USDT_ADDRESS, depositAmount);
      const depositReceipt = await depositTx.wait();
      steps.push(`USDT→AIOU tx: ${depositReceipt.hash}`);
    }

    aiouBalance = await aiouContract.balanceOf(wallet.address);
    steps.push(`Final AIOU balance: ${ethers.formatUnits(aiouBalance, 18)}`);

    if (aiouBalance === 0n) {
      return { success: false, error: 'No AIOU available after swaps', steps };
    }

    return { success: true, steps, funded_amount: ethers.formatUnits(aiouBalance, 18) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg, steps };
  }
}

/**
 * Sign EIP-3009 transferWithAuthorization server-side with the agent wallet
 * and settle funding with AGOS.
 */
export async function signAndSettleEip3009(
  agentPrivateKey: string,
  challenge: import('../agos-client').AgosFundChallenge,
): Promise<{ signature: string; settlePayload: unknown }> {
  const { ethers } = await import('ethers');
  const { buildTransferWithAuthorization, assembleSettlePayload } = await import('./eip3009');

  const wallet = new ethers.Wallet(agentPrivateKey);

  const prepared = buildTransferWithAuthorization(challenge, {
    from: wallet.address,
  });

  const { domain, message } = prepared.typedData;

  // ethers v6 signTypedData doesn't want EIP712Domain in types
  const types = {
    TransferWithAuthorization: prepared.typedData.types.TransferWithAuthorization,
  };

  const signature = await wallet.signTypedData(
    domain,
    types,
    message,
  );

  return {
    signature,
    settlePayload: assembleSettlePayload(prepared, signature),
  };
}
