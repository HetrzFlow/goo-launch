/**
 * AGOS Test Endpoints — fund (BNB→USDT→AIOU swap + EIP-3009 fund) and withdraw (AIOU + BNB drain)
 *
 * These are owner-only test helpers mounted under /agents/:agenterId/test/*
 * They operate on BSC Mainnet using the agent wallet's private key.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, HonoVariables } from '../bindings';
import { getDb } from '../db';
import { agenterRecords } from '../db/schema';
import { authRequired } from '../auth/middleware';
import { decryptPrivateKey } from '../crypto';
import {
  restoreAgosSession,
  startFundingChallenge,
  settleFunding,
  assembleSettlePayload,
} from '../finance/agos';
import { buildTransferWithAuthorization } from '../finance/eip3009';

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// --- BSC Mainnet Constants ---

const BSC_MAINNET_RPC = 'https://bsc-dataseed.binance.org/';
const BSC_MAINNET_CHAIN_ID = 56;

const AIOU_TOKEN = '0xF6138EE4174e85017bD43989CaAF8bC2D39aa733';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const PANCAKE_V3_ROUTER = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4';
const PANCAKE_V3_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

const FEE_TIERS = [500, 2500, 10_000] as const;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const QUOTER_ABI = [
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const SWAP_ROUTER_ABI = [
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
];

// We use dynamic import for ethers since it may not be bundled in the worker by default.
// The app already uses ethers elsewhere (launch routes), so it should be available.
async function getEthers() {
  const mod = await import('ethers');
  return mod;
}

async function findBestFeeTierForOutput(
  quoterContract: any,
  tokenIn: string,
  tokenOut: string,
  amountOut: bigint,
): Promise<{ fee: number; amountIn: bigint }> {
  let bestFee = 2500;
  let bestIn = 0n;

  for (const fee of FEE_TIERS) {
    try {
      const result = await quoterContract.quoteExactOutputSingle.staticCall({
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
      // Pool doesn't exist or no liquidity for this fee tier
    }
  }

  return { fee: bestFee, amountIn: bestIn };
}

const app = new Hono<AppEnv>();

// All test routes require auth
app.use('*', authRequired);

/**
 * POST /agents/:agenterId/test/fund
 *
 * Swaps agent wallet's BNB→USDT→AIOU on BSC Mainnet, then funds AGOS agent via EIP-3009.
 */
app.post('/agents/:agenterId/test/fund', async (c) => {
  const agenterId = c.req.param('agenterId');
  const userId = c.get('auth').user_id;
  const db = getDb(c.env);

  const agent = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenterId)).get();
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  if (agent.userId !== userId) return c.json({ error: 'Not your agent' }, 403);
  if (!agent.agosAgentId || !agent.agosAccessToken) return c.json({ error: 'Agent not linked to AGOS' }, 400);
  if (!agent.encryptedPrivateKey) return c.json({ error: 'Agent wallet key not available' }, 400);

  const ethers = await getEthers();
  const privateKey = await decryptPrivateKey(agent.encryptedPrivateKey, c.env.JWT_SECRET);
  const provider = new ethers.JsonRpcProvider(BSC_MAINNET_RPC, BSC_MAINNET_CHAIN_ID);
  const wallet = new ethers.Wallet(privateKey, provider);

  const steps: string[] = [];
  const txHashes: Record<string, string> = {};

  try {
    // 1. Check USDT balance
    const usdt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
    let usdtBalance: bigint = await usdt.balanceOf(wallet.address);
    const targetUsdt = ethers.parseUnits('10', 18);

    steps.push(`USDT balance: ${ethers.formatUnits(usdtBalance, 18)}`);

    // 2. If USDT < 10, swap BNB→USDT via exactOutputSingle (buy exactly the deficit)
    if (usdtBalance < targetUsdt) {
      const deficit = targetUsdt - usdtBalance;
      const quoter = new ethers.Contract(PANCAKE_V3_QUOTER, QUOTER_ABI, provider);
      const { fee: bnbUsdtFee, amountIn: quotedBnb } = await findBestFeeTierForOutput(
        quoter, WBNB_ADDRESS, USDT_ADDRESS, deficit,
      );

      if (quotedBnb === 0n) {
        return c.json({ error: 'No V3 liquidity for BNB→USDT' }, 502);
      }

      // Add 5% buffer — excess BNB is refunded as WBNB by the router
      const maxBnb = quotedBnb * 105n / 100n;
      const nativeBalance = await provider.getBalance(wallet.address);

      if (nativeBalance < maxBnb + ethers.parseEther('0.005')) {
        return c.json({
          error: `Insufficient BNB. Need ~${ethers.formatEther(maxBnb)} for swap + gas, have ${ethers.formatEther(nativeBalance)}`,
        }, 400);
      }

      steps.push(`Buying ${ethers.formatUnits(deficit, 18)} USDT with ~${ethers.formatEther(maxBnb)} BNB (fee tier: ${bnbUsdtFee})`);
      const swapRouter = new ethers.Contract(PANCAKE_V3_ROUTER, SWAP_ROUTER_ABI, wallet);
      const swapTx = await swapRouter.exactOutputSingle(
        {
          tokenIn: WBNB_ADDRESS,
          tokenOut: USDT_ADDRESS,
          fee: bnbUsdtFee,
          recipient: wallet.address,
          amountOut: deficit,
          amountInMaximum: maxBnb,
          sqrtPriceLimitX96: 0n,
        },
        { value: maxBnb },
      );
      const swapReceipt = await swapTx.wait();
      txHashes.bnbToUsdt = swapReceipt.hash;
      steps.push(`BNB→USDT swap tx: ${swapReceipt.hash}`);

      usdtBalance = await usdt.balanceOf(wallet.address);
      steps.push(`USDT balance after swap: ${ethers.formatUnits(usdtBalance, 18)}`);
    }

    // 3. Deposit USDT → AIOU (1:1 mint via AIOU contract)
    const depositAmount = usdtBalance < targetUsdt ? usdtBalance : targetUsdt;
    if (depositAmount > 0n) {
      const aiouContract = new ethers.Contract(AIOU_TOKEN, [
        ...ERC20_ABI,
        'function deposit(address token, uint256 amount)',
      ], wallet);

      // Approve AIOU contract to spend USDT
      const currentAllowance: bigint = await (new ethers.Contract(USDT_ADDRESS, ['function allowance(address,address) view returns(uint256)'], provider))
        .allowance(wallet.address, AIOU_TOKEN);
      if (currentAllowance < depositAmount) {
        steps.push('Approving USDT for AIOU contract...');
        const approveTx = await usdt.approve(AIOU_TOKEN, ethers.MaxUint256);
        await approveTx.wait();
        txHashes.usdtApprove = approveTx.hash;
      }

      steps.push(`Depositing ${ethers.formatUnits(depositAmount, 18)} USDT → AIOU (1:1 mint)`);
      const depositTx = await aiouContract.deposit(USDT_ADDRESS, depositAmount);
      const depositReceipt = await depositTx.wait();
      txHashes.usdtToAiou = depositReceipt.hash;
      steps.push(`USDT→AIOU deposit tx: ${depositReceipt.hash}`);
    }

    // 4. Check AIOU balance
    const aiou = new ethers.Contract(AIOU_TOKEN, ERC20_ABI, provider);
    const aiouBalance: bigint = await aiou.balanceOf(wallet.address);
    const aiouFormatted = ethers.formatUnits(aiouBalance, 18);
    steps.push(`AIOU balance: ${aiouFormatted}`);

    if (aiouBalance === 0n) {
      return c.json({ error: 'No AIOU to fund with', steps, txHashes }, 400);
    }

    // 5. Fund AGOS agent via EIP-3009
    steps.push('Starting AGOS funding challenge...');
    const session = await restoreAgosSession(
      agent.agosAccessToken,
      agent.agosRefreshToken,
      c.env.AGOS_API_URL,
      c.env.JWT_SECRET,
    );
    const client = session.client;
    const fundResult = await startFundingChallenge(client, agent.agosAgentId, aiouFormatted);

    if (!fundResult.needsPayment) {
      steps.push('No payment needed — already funded.');
      return c.json({ ok: true, steps, txHashes, funded: false });
    }

    // Build EIP-3009 typed data and sign server-side with agent wallet
    const challenge = fundResult.challenge;
    const prepared = buildTransferWithAuthorization(challenge, {
      from: wallet.address,
    });

    // Sign EIP-712 typed data server-side
    const { domain, types, message } = prepared.typedData;
    // Remove EIP712Domain from types for ethers signTypedData
    const sigTypes = { ...types };
    delete (sigTypes as any).EIP712Domain;
    const signature = await wallet.signTypedData(domain, sigTypes, message);
    steps.push('Signed EIP-3009 authorization');

    // Settle
    const payload = assembleSettlePayload(prepared, signature);
    const settleResult = await settleFunding(client, agent.agosAgentId, payload);
    steps.push(`Settled: ${settleResult.amount} AIOU (deploy triggered: ${settleResult.deployTriggered})`);
    txHashes.settle = settleResult.txHash;

    return c.json({
      ok: true,
      steps,
      txHashes,
      funded: true,
      amount: settleResult.amount,
      deployTriggered: settleResult.deployTriggered,
    });
  } catch (err: any) {
    return c.json({
      error: err.message || String(err),
      steps,
      txHashes,
    }, 500);
  }
});

/**
 * POST /agents/:agenterId/test/withdraw
 *
 * Transfers all AIOU + BNB from agent wallet back to recipient on BSC Mainnet.
 */
app.post('/agents/:agenterId/test/withdraw', async (c) => {
  const agenterId = c.req.param('agenterId');
  const { recipient } = await c.req.json<{ recipient: string }>();
  const userId = c.get('auth').user_id;
  const db = getDb(c.env);

  if (!recipient) return c.json({ error: 'recipient required' }, 400);

  const agent = await db.select().from(agenterRecords).where(eq(agenterRecords.agenterId, agenterId)).get();
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  if (agent.userId !== userId) return c.json({ error: 'Not your agent' }, 403);
  if (!agent.encryptedPrivateKey) return c.json({ error: 'Agent wallet key not available' }, 400);

  const ethers = await getEthers();
  const privateKey = await decryptPrivateKey(agent.encryptedPrivateKey, c.env.JWT_SECRET);
  const provider = new ethers.JsonRpcProvider(BSC_MAINNET_RPC, BSC_MAINNET_CHAIN_ID);
  const wallet = new ethers.Wallet(privateKey, provider);

  const steps: string[] = [];
  const txHashes: Record<string, string> = {};

  try {
    // 1. Transfer AIOU
    const aiou = new ethers.Contract(AIOU_TOKEN, ERC20_ABI, wallet);
    const aiouBalance: bigint = await aiou.balanceOf(wallet.address);
    steps.push(`AIOU balance: ${ethers.formatUnits(aiouBalance, 18)}`);

    if (aiouBalance > 0n) {
      steps.push(`Transferring ${ethers.formatUnits(aiouBalance, 18)} AIOU to ${recipient}...`);
      const aiouTx = await aiou.transfer(recipient, aiouBalance);
      const aiouReceipt = await aiouTx.wait();
      txHashes.aiouTransfer = aiouReceipt.hash;
      steps.push(`AIOU transfer tx: ${aiouReceipt.hash}`);
    }

    // 2. Transfer USDT (if any leftover)
    const usdt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
    const usdtBalance: bigint = await usdt.balanceOf(wallet.address);
    if (usdtBalance > 0n) {
      steps.push(`Transferring ${ethers.formatUnits(usdtBalance, 18)} USDT to ${recipient}...`);
      const usdtTx = await usdt.transfer(recipient, usdtBalance);
      const usdtReceipt = await usdtTx.wait();
      txHashes.usdtTransfer = usdtReceipt.hash;
      steps.push(`USDT transfer tx: ${usdtReceipt.hash}`);
    }

    // 3. Transfer BNB (max minus gas)
    const bnbBalance = await provider.getBalance(wallet.address);
    steps.push(`BNB balance: ${ethers.formatEther(bnbBalance)}`);

    if (bnbBalance > 0n) {
      const gasPrice = (await provider.getFeeData()).gasPrice!;
      const gasLimit = 21000n;
      const gasCost = gasPrice * gasLimit;
      const sendAmount = bnbBalance - gasCost;

      if (sendAmount > 0n) {
        steps.push(`Transferring ${ethers.formatEther(sendAmount)} BNB to ${recipient}...`);
        const bnbTx = await wallet.sendTransaction({
          to: recipient,
          value: sendAmount,
          gasLimit,
          gasPrice,
        });
        const bnbReceipt = await bnbTx.wait();
        txHashes.bnbTransfer = bnbReceipt!.hash;
        steps.push(`BNB transfer tx: ${bnbReceipt!.hash}`);
      } else {
        steps.push('BNB balance too low to cover gas');
      }
    }

    return c.json({ ok: true, steps, txHashes });
  } catch (err: any) {
    return c.json({
      error: err.message || String(err),
      steps,
      txHashes,
    }, 500);
  }
});

export { app as agosTestRoutes };
