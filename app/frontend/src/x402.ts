/**
 * x402 payment integration for sandbox creation.
 *
 * Uses Permit2 PermitWitnessTransferFrom flow (same as bsc-llm-router playground).
 * Works with any ERC20 token — no EIP-3009 required.
 *
 * All requests go through the goo-launch server proxy (/api/sandbox/create)
 * which forwards payment headers to the sandbox-manager Worker.
 *
 * Flow:
 * 1. POST /api/sandbox/create → proxy → sandbox-manager → 402
 * 2. Parse payment requirements, ensure correct network & Permit2 allowance
 * 3. Sign Permit2 PermitWitnessTransferFrom via EIP-712
 * 4. POST /api/sandbox/create with x-payment header → proxy → sandbox-manager → 201
 */
import { getToken } from './api';

type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

const API_BASE = import.meta.env.VITE_API_URL || '';

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const MAX_UINT256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

/** Paid request timeout: 3 minutes (settlement can take 60-120s). */
const PAID_REQUEST_TIMEOUT_MS = 180_000;

/** Network configs keyed by x402 network ID (eip155:<chainId>). */
const NETWORK_CONFIG: Record<string, { chainIdHex: string; chainId: number; permit2Proxy: string; label: string }> = {
  'eip155:97': {
    chainIdHex: '0x61',
    chainId: 97,
    permit2Proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
    label: 'BSC Testnet',
  },
  'eip155:56': {
    chainIdHex: '0x38',
    chainId: 56,
    permit2Proxy: '0xB2A41bF765E13FC0cC36D934f462812Bf5f5d95e',
    label: 'BSC Mainnet',
  },
};

interface PaymentRequired {
  x402Version: number;
  resource: { url: string; description: string };
  accepts: Array<{
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
  }>;
}

// --- Network helpers ---

/**
 * Ensure the wallet is connected to the correct BSC network.
 * Prompts wallet_switchEthereumChain; if chain is unknown, adds it.
 */
async function ensureNetwork(
  provider: WalletProvider,
  networkId: string,
): Promise<void> {
  const net = NETWORK_CONFIG[networkId];
  if (!net) throw new Error(`Unsupported payment network: ${networkId}`);

  const currentChainHex = await provider.request({ method: 'eth_chainId' }) as string;
  if (parseInt(currentChainHex, 16) === net.chainId) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: net.chainIdHex }],
    });
  } catch (err: any) {
    // 4902 = chain not added to wallet
    if (err.code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: net.chainIdHex,
          chainName: net.label,
          nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
          rpcUrls: net.chainId === 56
            ? ['https://bsc-dataseed.bnbchain.org']
            : ['https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
          blockExplorerUrls: net.chainId === 56
            ? ['https://bscscan.com']
            : ['https://testnet.bscscan.com'],
        }],
      });
    } else {
      throw err;
    }
  }
}

/**
 * Parse a 402 response. Tries the payment-required header (base64), then
 * raw JSON header, then response body (server proxy merges requirements into body).
 */
async function parsePaymentRequired(res: Response): Promise<PaymentRequired | null> {
  // Try header (both cases — some CORS configs are case-sensitive)
  const headerVal = res.headers.get('payment-required') || res.headers.get('PAYMENT-REQUIRED');
  if (headerVal) {
    try { return JSON.parse(atob(headerVal)); } catch { /* not base64 */ }
    try { return JSON.parse(headerVal); } catch { /* not raw JSON */ }
  }
  // Body fallback: server proxy merges payment requirements into the response body
  try {
    const body = await res.json();
    if (body?.accepts) return body as PaymentRequired;
    if (body?.x402Version) return body as PaymentRequired;
  } catch { /* no body */ }
  return null;
}

// --- Permit2 helpers ---

async function checkAndApprovePermit2(
  provider: WalletProvider,
  walletAddress: string,
  tokenAddress: string,
  requiredAmount: string,
): Promise<void> {
  const allowData = '0xdd62ed3e'
    + walletAddress.slice(2).toLowerCase().padStart(64, '0')
    + PERMIT2_ADDRESS.slice(2).toLowerCase().padStart(64, '0');

  const allowResult = await provider.request({
    method: 'eth_call',
    params: [{ to: tokenAddress, data: allowData }, 'latest'],
  }) as string;

  if (BigInt(allowResult) < BigInt(requiredAmount)) {
    // Approve Permit2 to spend token
    const approveData = '0x095ea7b3'
      + PERMIT2_ADDRESS.slice(2).toLowerCase().padStart(64, '0')
      + MAX_UINT256;

    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: walletAddress, to: tokenAddress, data: approveData }],
    }) as string;

    // Wait for confirmation
    for (let i = 0; i < 60; i++) {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt) return;
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Permit2 approval tx not confirmed after 120s');
  }
}

async function createX402Payment(
  provider: WalletProvider,
  walletAddress: string,
  paymentRequired: PaymentRequired,
): Promise<object> {
  const reqs = paymentRequired.accepts[0];

  // Resolve Permit2 proxy from network ID (not hardcoded)
  const net = NETWORK_CONFIG[reqs.network];
  if (!net) throw new Error(`Unsupported payment network: ${reqs.network}`);
  const permit2Proxy = net.permit2Proxy;

  const now = Math.floor(Date.now() / 1000);

  const nonce = BigInt(
    '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join(''),
  ).toString();

  const deadline = (now + (reqs.maxTimeoutSeconds || 300)).toString();
  const validAfter = (now - 600).toString();

  const permit2Auth = {
    from: walletAddress,
    permitted: { token: reqs.asset, amount: reqs.amount },
    spender: permit2Proxy,
    nonce,
    deadline,
    witness: { to: reqs.payTo, validAfter },
  };

  const typedData = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      PermitWitnessTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'witness', type: 'Witness' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      Witness: [
        { name: 'to', type: 'address' },
        { name: 'validAfter', type: 'uint256' },
      ],
    },
    primaryType: 'PermitWitnessTransferFrom',
    domain: {
      name: 'Permit2',
      chainId: net.chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    message: {
      permitted: { token: reqs.asset, amount: reqs.amount },
      spender: permit2Proxy,
      nonce,
      deadline,
      witness: { to: reqs.payTo, validAfter },
    },
  });

  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [walletAddress, typedData],
  }) as string;

  return {
    x402Version: 2,
    scheme: 'exact',
    network: reqs.network,
    payload: {
      signature,
      permit2Authorization: permit2Auth,
    },
    resource: paymentRequired.resource,
    accepted: reqs,
  };
}

// --- Shared x402 payment flow ---

/**
 * Execute the full x402 payment flow:
 * 1. POST to `url` (no payment) — may return 402
 * 2. Parse payment requirements, ensure correct network + Permit2 allowance
 * 3. Sign Permit2 PermitWitnessTransferFrom via EIP-712
 * 4. Retry with payment-signature header (3-minute timeout for settlement)
 */
async function x402PaidRequest<T>(
  url: string,
  reqBody: string,
  walletProvider: WalletProvider,
  walletAddress: string,
  onStatus?: (msg: string) => void,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Step 1: Initial request — may return 402
  onStatus?.('Requesting sandbox...');
  const res = await fetch(url, { method: 'POST', headers, body: reqBody });

  if (res.status !== 402) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // Step 2: Parse payment requirements (with fallbacks)
  const paymentRequired = await parsePaymentRequired(res);
  if (!paymentRequired?.accepts?.length) {
    throw new Error('402 but no payment requirements found (CORS or proxy issue)');
  }

  const reqs = paymentRequired.accepts[0];

  // Step 3: Ensure wallet is on the correct BSC network
  onStatus?.('Switching network...');
  await ensureNetwork(walletProvider, reqs.network);

  // Step 4: Ensure Permit2 allowance
  onStatus?.('Checking token allowance...');
  await checkAndApprovePermit2(walletProvider, walletAddress, reqs.asset, reqs.amount);

  // Step 5: Sign Permit2 payment (prompts wallet)
  onStatus?.('Sign payment in wallet...');
  const paymentPayload = await createX402Payment(walletProvider, walletAddress, paymentRequired);
  const paymentHeader = btoa(JSON.stringify(paymentPayload));

  // Step 6: Retry with payment header (3-minute timeout for on-chain settlement)
  onStatus?.('Sending payment...');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAID_REQUEST_TIMEOUT_MS);
  try {
    const paidRes = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'payment-signature': paymentHeader },
      body: reqBody,
      signal: controller.signal,
    });
    const paidData = await paidRes.json();
    if (!paidRes.ok) throw new Error(paidData.error || `Payment failed: HTTP ${paidRes.status}`);
    return paidData;
  } catch (e: any) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('Request timed out after 3 minutes. The sandbox may still be created — check the list.');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Public API ---

/**
 * Create a sandbox with x402 Permit2 payment support.
 */
export async function createSandboxWithPayment(
  agenterId: string,
  walletProvider: WalletProvider,
  walletAddress: string,
  onStatus?: (msg: string) => void,
): Promise<{ sandbox_id?: string; sandbox_url?: string }> {
  const url = `${API_BASE}/api/sandbox/create`;
  const body = JSON.stringify({ agenter_id: agenterId });
  return x402PaidRequest(url, body, walletProvider, walletAddress, onStatus);
}

/**
 * Renew a sandbox with x402 Permit2 payment support.
 */
export async function renewSandboxWithPayment(
  agenterId: string,
  walletProvider: WalletProvider,
  walletAddress: string,
  onStatus?: (msg: string) => void,
): Promise<{ message: string }> {
  const url = `${API_BASE}/api/sandbox/${agenterId}/renew`;
  return x402PaidRequest(url, '{}', walletProvider, walletAddress, onStatus);
}
