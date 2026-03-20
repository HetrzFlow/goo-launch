#!/usr/bin/env tsx
/**
 * Drain agent wallet — transfer BNB and (on mainnet) AIOU to a recipient.
 *
 * Usage:
 *   bunx tsx scripts/drain-wallet.ts --key <PRIVATE_KEY> --to <RECIPIENT> [--network mainnet|testnet] [--aiou <AIOU_TOKEN_ADDRESS>]
 *
 * Examples:
 *   # Testnet (BNB only)
 *   bunx tsx scripts/drain-wallet.ts --key 0xabc... --to 0xdef...
 *
 *   # Mainnet (BNB + AIOU)
 *   bunx tsx scripts/drain-wallet.ts --key 0xabc... --to 0xdef... --network mainnet --aiou 0x...
 */

import { ethers } from 'ethers';

// --- Config ---

const NETWORKS = {
  testnet: {
    rpc: 'https://data-seed-prebsc-1-s1.binance.org:8545',
    chainId: 97,
    explorer: 'https://testnet.bscscan.com',
    label: 'BSC Testnet',
  },
  mainnet: {
    rpc: 'https://bsc-rpc.publicnode.com',
    chainId: 56,
    explorer: 'https://bscscan.com',
    label: 'BSC Mainnet',
  },
} as const;

// Default AIOU token on BSC Mainnet
const DEFAULT_AIOU_ADDRESS = '0xF6138EE4174e85017bD43989CaAF8bC2D39aa733';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// --- Parse args ---

function parseArgs(): { key: string; to: string; network: 'testnet' | 'mainnet'; aiou?: string } {
  const args = process.argv.slice(2);
  let key = '', to = '', network: 'testnet' | 'mainnet' = 'testnet', aiou: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--key': key = args[++i] || ''; break;
      case '--to': to = args[++i] || ''; break;
      case '--network': network = (args[++i] || 'testnet') as 'testnet' | 'mainnet'; break;
      case '--aiou': aiou = args[++i] || ''; break;
      default:
        console.error(`Unknown arg: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!key || !to) {
    console.error('Usage: bunx tsx scripts/drain-wallet.ts --key <PRIVATE_KEY> --to <RECIPIENT> [--network mainnet|testnet] [--aiou <AIOU_TOKEN_ADDRESS>]');
    process.exit(1);
  }

  if (!['testnet', 'mainnet'].includes(network)) {
    console.error('--network must be "testnet" or "mainnet"');
    process.exit(1);
  }

  if (network === 'mainnet' && !aiou) {
    aiou = DEFAULT_AIOU_ADDRESS;
  }

  return { key, to, network, aiou };
}

// --- Main ---

async function main() {
  const { key, to, network, aiou } = parseArgs();
  const net = NETWORKS[network];

  const provider = new ethers.JsonRpcProvider(net.rpc, net.chainId);
  const wallet = new ethers.Wallet(key, provider);

  console.log(`\n  Network:   ${net.label}`);
  console.log(`  Wallet:    ${wallet.address}`);
  console.log(`  Recipient: ${to}\n`);

  // --- 1. Transfer AIOU (mainnet only, before BNB so we have gas) ---

  if (network === 'mainnet' && aiou) {
    console.log('--- AIOU Transfer ---');
    const token = new ethers.Contract(aiou, ERC20_ABI, wallet);

    const [balance, decimals, symbol] = await Promise.all([
      token.balanceOf(wallet.address) as Promise<bigint>,
      token.decimals() as Promise<number>,
      token.symbol() as Promise<string>,
    ]);

    const formatted = ethers.formatUnits(balance, decimals);
    console.log(`  ${symbol} balance: ${formatted}`);

    if (balance > 0n) {
      console.log(`  Transferring ${formatted} ${symbol} to ${to}...`);
      const tx = await token.transfer(to, balance);
      console.log(`  TX: ${net.explorer}/tx/${tx.hash}`);
      await tx.wait();
      console.log('  Confirmed.\n');
    } else {
      console.log('  No AIOU to transfer.\n');
    }
  }

  // --- 2. Transfer BNB (leave gas margin, send max) ---

  console.log('--- BNB Transfer ---');
  const bnbBalance = await provider.getBalance(wallet.address);
  console.log(`  BNB balance: ${ethers.formatEther(bnbBalance)}`);

  if (bnbBalance === 0n) {
    console.log('  No BNB to transfer.\n');
    return;
  }

  // Estimate gas cost for a simple transfer
  const gasPrice = (await provider.getFeeData()).gasPrice!;
  const gasLimit = 21000n;
  const gasCost = gasPrice * gasLimit;

  const sendAmount = bnbBalance - gasCost;
  if (sendAmount <= 0n) {
    console.log(`  BNB balance too low to cover gas (need ~${ethers.formatEther(gasCost)} BNB for gas).\n`);
    return;
  }

  console.log(`  Transferring ${ethers.formatEther(sendAmount)} BNB to ${to} (gas: ~${ethers.formatEther(gasCost)})...`);
  const tx = await wallet.sendTransaction({
    to,
    value: sendAmount,
    gasLimit,
    gasPrice,
  });
  console.log(`  TX: ${net.explorer}/tx/${tx.hash}`);
  await tx.wait();
  console.log('  Confirmed.\n');

  console.log('Done. Wallet drained.');
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
