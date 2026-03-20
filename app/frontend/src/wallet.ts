/**
 * Multi-wallet connector using EIP-6963 (primary) + legacy fallbacks.
 *
 * EIP-6963 solves the "wallet fights over window.ethereum" problem.
 * Each wallet announces itself via a custom event with its own provider,
 * so we can reliably list all installed wallets.
 */

import { el } from './dom-utils';
import { getAppConfig, getChainIdHex, getChainParams } from './app-config';

// --- EIP-6963 types ---

interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string; // data URI
  rdns: string; // reverse-dns identifier e.g. "io.metamask"
}

interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: any;
}

// --- EIP-6963 collection ---

const eip6963Providers: EIP6963ProviderDetail[] = [];

function onAnnounceProvider(event: any): void {
  const detail = event.detail as EIP6963ProviderDetail;
  if (!detail?.info?.uuid) return;
  // Deduplicate by uuid
  if (eip6963Providers.some(p => p.info.uuid === detail.info.uuid)) return;
  eip6963Providers.push(detail);
}

// Listen for wallet announcements
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', onAnnounceProvider);
  // Request wallets to announce themselves
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

// --- Fallback icons for known wallets (used when EIP-6963 icon is missing) ---

const FALLBACK_ICONS: Record<string, string> = {
  'io.metamask': `<svg viewBox="0 0 35 33" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M32.96 1L19.58 10.93l2.48-5.88L32.96 1z" fill="#E17726" stroke="#E17726" stroke-width=".25"/><path d="M2.66 1l13.24 10.02-2.36-5.97L2.66 1zM28.23 23.53l-3.55 5.44 7.6 2.09 2.18-7.4-6.23-.13zM.93 23.66l2.17 7.4 7.58-2.09-3.54-5.44-6.21.13z" fill="#E27625" stroke="#E27625" stroke-width=".25"/><path d="M10.35 14.51l-2.12 3.2 7.55.34-.25-8.13-5.18 4.59zM25.27 14.51l-5.27-4.68-.17 8.22 7.54-.34-2.1-3.2z" fill="#E27625" stroke="#E27625" stroke-width=".25"/><path d="M19.83 18.05l.44-7.56 1.99-5.38h-8.9l1.99 5.38.44 7.56.17 2.46.01 5.97h3.92l.02-5.97.17-2.46h-.25z" fill="#F5841F" stroke="#F5841F" stroke-width=".25"/></svg>`,
  'com.okex.wallet': `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" rx="8" fill="#000"/><path d="M23.59 15.2h-4.8a.4.4 0 0 0-.4.4v4.8c0 .22.18.4.4.4h4.8a.4.4 0 0 0 .4-.4v-4.8a.4.4 0 0 0-.4-.4zM17.59 21.2h-4.8a.4.4 0 0 0-.4.4v4.8c0 .22.18.4.4.4h4.8a.4.4 0 0 0 .4-.4v-4.8a.4.4 0 0 0-.4-.4zM29.59 21.2h-4.8a.4.4 0 0 0-.4.4v4.8c0 .22.18.4.4.4h4.8a.4.4 0 0 0 .4-.4v-4.8a.4.4 0 0 0-.4-.4zM17.59 9.2h-4.8a.4.4 0 0 0-.4.4v4.8c0 .22.18.4.4.4h4.8a.4.4 0 0 0 .4-.4V9.6a.4.4 0 0 0-.4-.4zM29.59 9.2h-4.8a.4.4 0 0 0-.4.4v4.8c0 .22.18.4.4.4h4.8a.4.4 0 0 0 .4-.4V9.6a.4.4 0 0 0-.4-.4zM23.59 27.2h-4.8a.4.4 0 0 0-.4.4v4.8c0 .22.18.4.4.4h4.8a.4.4 0 0 0 .4-.4v-4.8a.4.4 0 0 0-.4-.4z" fill="#fff"/></svg>`,
  'com.coinbase.wallet': `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" rx="8" fill="#0052FF"/><path fill-rule="evenodd" clip-rule="evenodd" d="M20 6C12.27 6 6 12.27 6 20s6.27 14 14 14 14-6.27 14-14S27.73 6 20 6zm-4.2 11.8a1.4 1.4 0 0 1 1.4-1.4h5.6a1.4 1.4 0 0 1 1.4 1.4v5.6a1.4 1.4 0 0 1-1.4 1.4h-5.6a1.4 1.4 0 0 1-1.4-1.4v-5.6z" fill="#fff"/></svg>`,
  'com.trustwallet.app': `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" rx="8" fill="#0500FF"/><path d="M20 8c3.4 3.3 7.2 4.5 11 4.4-.4 10.2-3.7 16.2-11 20.6C12.7 28.6 9.4 22.6 9 12.4c3.8.1 7.6-1.1 11-4.4z" fill="#fff"/></svg>`,
  'com.bitget.web3': `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" rx="8" fill="#000"/><path d="M11 13.5L17.5 20 11 26.5h5.25L20 22.75 23.75 26.5H29L22.5 20 29 13.5h-5.25L20 17.25 16.25 13.5H11z" fill="#00F0FF"/></svg>`,
  'com.binance.wallet': `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" rx="8" fill="#F3BA2F"/><path d="M20 10l2.94 2.94-5.88 5.88L14.12 15.88 20 10zm6.06 6.06l2.94 2.94-2.94 2.94-2.94-2.94 2.94-2.94zm-12.12 0L16.88 19l-2.94 2.94L11 19l2.94-2.94zM20 22.12L22.94 25.06 20 28l-2.94-2.94L20 22.12zM20 19l2.94 2.94L20 24.88l-2.94-2.94L20 19z" fill="#fff"/></svg>`,
  'com.binance.w3w': `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" rx="8" fill="#F3BA2F"/><path d="M20 10l2.94 2.94-5.88 5.88L14.12 15.88 20 10zm6.06 6.06l2.94 2.94-2.94 2.94-2.94-2.94 2.94-2.94zm-12.12 0L16.88 19l-2.94 2.94L11 19l2.94-2.94zM20 22.12L22.94 25.06 20 28l-2.94-2.94L20 22.12zM20 19l2.94 2.94L20 24.88l-2.94-2.94L20 19z" fill="#fff"/></svg>`,
  'app.phantom': `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" rx="8" fill="#AB9FF2"/><path d="M29.5 20.5c0 5.8-4.7 10.5-10.5 10.5S8.5 26.3 8.5 20.5 13.2 10 19 10s10.5 4.7 10.5 10.5z" fill="#fff"/><circle cx="16" cy="19" r="2" fill="#AB9FF2"/><circle cx="22" cy="19" r="2" fill="#AB9FF2"/></svg>`,
};

const WALLET_ICON_GENERIC = `<svg viewBox="0 0 24 24" fill="none" stroke="#4D4D4D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z"/></svg>`;

const WALLET_SORT_ORDER = [
  'com.binance.wallet',
  'app.phantom',
  'io.metamask',
  'com.okex.wallet',
  'com.coinbase.wallet',
  'com.trustwallet.app',
  'com.bitget.web3',
] as const;

// --- Public detected wallet type ---

export interface DetectedWallet {
  id: string;       // rdns or legacy id
  name: string;
  icon: string;     // SVG string or data URI
  isDataUri: boolean;
  provider: any;    // null = not installed (show install link)
  installUrl?: string;
}

const PROMOTED_WALLETS: { id: string; name: string; installUrl: string; iconId?: string }[] = [
  { id: 'com.binance.wallet', name: 'Binance Wallet', installUrl: 'https://www.binance.com/en/web3wallet' },
];

// --- State ---

let selectedProvider: any = null;
const _accountChangeCallbacks: Array<(addr: string | null) => void> = [];

export function onAccountChanged(fn: (addr: string | null) => void): void {
  _accountChangeCallbacks.push(fn);
}

export function getSelectedProvider(): any {
  return selectedProvider;
}

/** User explicitly disconnected — persist flag so auto-connect skips on next load. */
let _userDisconnected = false;

export function clearSelectedProvider(): void {
  // Try to revoke wallet permissions so eth_accounts returns [] after refresh
  if (selectedProvider) {
    try {
      selectedProvider.request?.({
        method: 'wallet_revokePermissions',
        params: [{ eth_accounts: {} }],
      }).catch(() => {});
    } catch {}
  }
  selectedProvider = null;
  _userDisconnected = true;
  try { sessionStorage.setItem('goo.walletDisconnected', '1'); } catch {}
}

export function isUserDisconnected(): boolean {
  if (_userDisconnected) return true;
  try { return sessionStorage.getItem('goo.walletDisconnected') === '1'; } catch { return false; }
}

export function clearDisconnectedFlag(): void {
  _userDisconnected = false;
  try { sessionStorage.removeItem('goo.walletDisconnected'); } catch {}
}

// --- Detection: EIP-6963 first, legacy fallback ---

export function detectWallets(): DetectedWallet[] {
  const found: DetectedWallet[] = [];
  const seenProviders = new Set<any>();
  const seenIds = new Set<string>();

  // Helper: add wallet only if both provider ref and id are unseen
  function addWallet(id: string, name: string, icon: string, isDataUri: boolean, provider: any): boolean {
    if (seenProviders.has(provider) || seenIds.has(id)) return false;
    seenProviders.add(provider);
    seenIds.add(id);
    found.push({ id, name, icon, isDataUri, provider });
    return true;
  }

  // 1. EIP-6963 wallets (reliable, each wallet self-identifies)
  for (const detail of eip6963Providers) {
    if (seenProviders.has(detail.provider)) continue;

    const rdns = detail.info.rdns;
    const shouldForceFallbackIcon = rdns === 'app.phantom' || /phantom/i.test(detail.info.name);
    const icon = shouldForceFallbackIcon
      ? FALLBACK_ICONS['app.phantom']
      : (detail.info.icon || FALLBACK_ICONS[rdns] || WALLET_ICON_GENERIC);
    const isDataUri = icon.startsWith('data:');

    addWallet(rdns, detail.info.name, icon, isDataUri, detail.provider);
  }

  // 2. Legacy fallback: check dedicated globals that EIP-6963 might miss
  const w = window as any;

  // OKX often injects window.okxwallet separately
  if (w.okxwallet) {
    addWallet('com.okex.wallet', 'OKX Wallet', FALLBACK_ICONS['com.okex.wallet'], false, w.okxwallet);
  }

  // Trust Wallet dedicated global
  if (w.trustwallet) {
    addWallet('com.trustwallet.app', 'Trust Wallet', FALLBACK_ICONS['com.trustwallet.app'], false, w.trustwallet);
  }

  // Bitget dedicated global
  if (w.bitkeep?.ethereum) {
    addWallet('com.bitget.web3', 'Bitget Wallet', FALLBACK_ICONS['com.bitget.web3'], false, w.bitkeep.ethereum);
  }

  // Coinbase dedicated global
  if (w.coinbaseWalletExtension) {
    addWallet('com.coinbase.wallet', 'Coinbase Wallet', FALLBACK_ICONS['com.coinbase.wallet'], false, w.coinbaseWalletExtension);
  }

  // Binance Web3 Wallet (new: injects window.binancew3w.ethereum)
  if (w.binancew3w?.ethereum) {
    addWallet('com.binance.wallet', 'Binance Wallet', FALLBACK_ICONS['com.binance.wallet'], false, w.binancew3w.ethereum);
  }

  // Binance Chain Wallet (legacy: injects window.BinanceChain)
  if (w.BinanceChain) {
    addWallet('com.binance.wallet', 'Binance Wallet', FALLBACK_ICONS['com.binance.wallet'], false, w.BinanceChain);
  }

  // Phantom EVM (injects window.phantom.ethereum, sets isMetaMask=true)
  if (w.phantom?.ethereum) {
    addWallet('app.phantom', 'Phantom', FALLBACK_ICONS['app.phantom'], false, w.phantom.ethereum);
  }

  // 3. Last resort: window.ethereum.providers array (older multi-wallet shim)
  if (w.ethereum?.providers && Array.isArray(w.ethereum.providers)) {
    for (const p of w.ethereum.providers) {
      if (seenProviders.has(p)) continue;
      // Identify — order matters: check specific wallets before MetaMask
      // because Phantom and others set isMetaMask=true for compatibility
      let name = 'Browser Wallet';
      let id = 'unknown';
      let icon = WALLET_ICON_GENERIC;
      if (p.isPhantom) {
        name = 'Phantom'; id = 'app.phantom'; icon = FALLBACK_ICONS['app.phantom'];
      } else if (p.isOkxWallet) {
        name = 'OKX Wallet'; id = 'com.okex.wallet'; icon = FALLBACK_ICONS['com.okex.wallet'];
      } else if (p.isBitKeep) {
        name = 'Bitget Wallet'; id = 'com.bitget.web3'; icon = FALLBACK_ICONS['com.bitget.web3'];
      } else if (p.isCoinbaseWallet) {
        name = 'Coinbase Wallet'; id = 'com.coinbase.wallet'; icon = FALLBACK_ICONS['com.coinbase.wallet'];
      } else if (p.isTrust) {
        name = 'Trust Wallet'; id = 'com.trustwallet.app'; icon = FALLBACK_ICONS['com.trustwallet.app'];
      } else if (p.isBinanceChain) {
        name = 'Binance Wallet'; id = 'com.binance.wallet'; icon = FALLBACK_ICONS['com.binance.wallet'];
      } else if (p.isMetaMask) {
        name = 'MetaMask'; id = 'io.metamask'; icon = FALLBACK_ICONS['io.metamask'];
      }
      addWallet(id, name, icon, false, p);
    }
  }

  // 4. Absolute fallback: bare window.ethereum with no identifiers
  if (!found.length && w.ethereum) {
    found.push({
      id: 'generic',
      name: 'Browser Wallet',
      icon: WALLET_ICON_GENERIC,
      isDataUri: false,
      provider: w.ethereum,
    });
  }

  for (const promo of PROMOTED_WALLETS) {
    if (seenIds.has(promo.id)) continue;
    found.push({
      id: promo.id,
      name: promo.name,
      icon: FALLBACK_ICONS[promo.iconId || promo.id] || WALLET_ICON_GENERIC,
      isDataUri: false,
      provider: null,
      installUrl: promo.installUrl,
    });
  }

  found.sort((a, b) => {
    const aIndex = WALLET_SORT_ORDER.indexOf(a.id as typeof WALLET_SORT_ORDER[number]);
    const bIndex = WALLET_SORT_ORDER.indexOf(b.id as typeof WALLET_SORT_ORDER[number]);
    const aRank = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
    const bRank = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name);
  });

  return found;
}

// --- Network switch helpers ---

export interface ChainParams {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
}

/**
 * Switch the wallet to a specific chain. Adds the chain if unknown (4902).
 * Exported so any page can request a network switch when needed.
 */
export async function switchChain(provider: any, chainId: string, addParams?: ChainParams): Promise<void> {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (e: any) {
    if (e.code === 4902 && addParams) {
      await provider.request({ method: 'wallet_addEthereumChain', params: [addParams] });
    } else {
      throw e;
    }
  }
}

/** Pre-defined chain params for quick switching. */
export const CHAINS: Record<string, ChainParams> = {
  bscTestnet: {
    chainId: '0x61',
    chainName: 'BSC Testnet',
    nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
    rpcUrls: ['https://data-seed-prebsc-1-s1.binance.org:8545'],
    blockExplorerUrls: ['https://testnet.bscscan.com'],
  },
  bscMainnet: {
    chainId: '0x38',
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.binance.org'],
    blockExplorerUrls: ['https://bscscan.com'],
  },
};

// --- Connect with a specific provider ---

export async function connectWithProvider(provider: any): Promise<string> {
  // Use wallet_requestPermissions to force the account picker dialog.
  // eth_requestAccounts silently returns the previously authorized account
  // even after the user switches accounts in MetaMask.
  try {
    await provider.request({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }],
    });
  } catch (e: any) {
    // If wallet doesn't support wallet_requestPermissions, fall through
    if (e.code === 4001 || e.code === 'ACTION_REJECTED') throw e;
  }
  const accounts: string[] = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts.length) throw new Error('No accounts returned');
  selectedProvider = provider;
  clearDisconnectedFlag();

  // Listen for account changes (user switches account in wallet extension)
  if (provider.on) {
    // Remove any previous listener to avoid duplicates
    provider.removeAllListeners?.('accountsChanged');
    provider.on('accountsChanged', (accounts: string[]) => {
      if (accounts.length) {
        _accountChangeCallbacks.forEach(fn => fn(accounts[0]));
      } else {
        // User disconnected from wallet side
        selectedProvider = null;
        _accountChangeCallbacks.forEach(fn => fn(null));
      }
    });
  }

  // Auto-switch to the correct chain based on backend config
  try {
    const cfg = await getAppConfig();
    const targetChainHex = getChainIdHex(cfg);
    const currentChainHex: string = await provider.request({ method: 'eth_chainId' });
    if (currentChainHex.toLowerCase() !== targetChainHex.toLowerCase()) {
      await switchChain(provider, targetChainHex, getChainParams(cfg));
    }
  } catch { /* best-effort, don't block login if switch fails */ }

  return accounts[0];
}

// --- Auto-detect already connected ---

export async function getConnectedAccount(): Promise<{ address: string; provider: any } | null> {
  // If user explicitly disconnected this session, don't auto-reconnect
  if (isUserDisconnected()) return null;

  const wallets = detectWallets();
  for (const w of wallets) {
    if (!w.provider) continue;
    try {
      const accounts: string[] = await w.provider.request({ method: 'eth_accounts' });
      if (accounts.length) {
        selectedProvider = w.provider;
        return { address: accounts[0], provider: w.provider };
      }
    } catch {}
  }
  return null;
}

// --- Wallet picker modal ---

let currentModal: HTMLElement | null = null;

export function closeWalletModal(): void {
  if (currentModal) {
    currentModal.remove();
    currentModal = null;
  }
}

/**
 * Show a wallet picker modal. Returns a promise that resolves with the
 * connected address, or rejects if the user cancels.
 */
export function showWalletPicker(): Promise<string> {
  closeWalletModal();

  // Re-request EIP-6963 in case new wallets loaded since page init
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  // Small delay to let late wallets announce before rendering
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      _renderPicker(resolve, reject);
    }, 50);
  });
}

function _renderPicker(
  resolve: (addr: string) => void,
  reject: (err: Error) => void,
): void {
  const wallets = detectWallets();

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:9999;display:flex;align-items:center;justify-content:center';
  currentModal = backdrop;

  // Modal
  const modal = document.createElement('div');
  modal.style.cssText = 'background:#fff;border-radius:20px;padding:28px 24px;width:360px;max-width:calc(100vw - 48px);box-shadow:0 20px 60px rgba(0,0,0,0.15)';

  // Header
  const header = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:20px' },
    el('h3', { style: 'font-size:18px;font-weight:600;color:#000;margin:0' }, 'Connect Wallet'),
  );
  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:4px;color:#B2B2B2;font-size:20px;line-height:1';
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', () => { closeWalletModal(); reject(new Error('Cancelled')); });
  header.appendChild(closeBtn);
  modal.appendChild(header);

  if (!wallets.length) {
    const empty = el('div', { style: 'text-align:center;padding:24px 0' },
      el('div', { style: 'font-size:14px;color:#4D4D4D;margin-bottom:8px' }, 'No wallet detected'),
      el('div', { style: 'font-size:13px;color:#B2B2B2;line-height:1.6' }, 'Install a browser wallet (MetaMask, Binance, Phantom, OKX, Coinbase, Trust, Bitget) to continue.'),
    );
    modal.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px';

    for (const w of wallets) {
      const btn = document.createElement('button');
      btn.style.cssText = 'display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;background:#f8f8f7;border:1px solid #ebebeb;border-radius:12px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:500;color:#000;transition:border-color .15s,background .15s';

      // Icon: either a data URI <img> or inline SVG
      const iconWrap = document.createElement('span');
      iconWrap.style.cssText = 'width:32px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:8px;overflow:hidden';
      if (w.isDataUri) {
        const img = document.createElement('img');
        img.src = w.icon;
        img.alt = w.name;
        img.style.cssText = 'width:32px;height:32px;object-fit:contain';
        iconWrap.appendChild(img);
      } else {
        iconWrap.innerHTML = w.icon;
        const svg = iconWrap.querySelector('svg');
        if (svg) { svg.style.width = '32px'; svg.style.height = '32px'; }
      }

      const label = document.createTextNode(w.name);
      const isInstalled = w.provider !== null;
      const trailingEl = isInstalled
        ? el('span', { style: 'margin-left:auto;color:#B2B2B2;font-size:16px' }, '\u203A')
        : el('span', { style: 'margin-left:auto;color:#B2B2B2;font-size:11px;white-space:nowrap' }, 'Install');

      btn.appendChild(iconWrap);
      btn.appendChild(label);
      btn.appendChild(trailingEl);

      btn.addEventListener('mouseenter', () => { btn.style.borderColor = '#d0d0d0'; btn.style.background = '#fff'; });
      btn.addEventListener('mouseleave', () => { btn.style.borderColor = '#ebebeb'; btn.style.background = '#f8f8f7'; });

      btn.addEventListener('click', async () => {
        if (!isInstalled) {
          if (w.installUrl) window.open(w.installUrl, '_blank', 'noopener');
          return;
        }

        // Disable all buttons
        list.querySelectorAll('button').forEach(b => {
          (b as HTMLButtonElement).disabled = true;
          b.style.opacity = '0.5';
          b.style.cursor = 'not-allowed';
        });
        btn.style.opacity = '1';
        btn.style.cursor = 'wait';
        const spinner = el('span', { style: 'margin-left:auto;color:#B2B2B2;font-size:12px' }, 'Connecting...');
        btn.replaceChild(spinner, trailingEl);

        try {
          const address = await connectWithProvider(w.provider);
          closeWalletModal();
          resolve(address);
        } catch (err: any) {
          // Re-enable buttons
          list.querySelectorAll('button').forEach(b => {
            (b as HTMLButtonElement).disabled = false;
            b.style.opacity = '1';
            b.style.cursor = 'pointer';
          });
          btn.replaceChild(trailingEl, spinner);
          trailingEl.textContent = '\u203A';

          // Show error below this button
          const existingErr = btn.parentElement?.querySelector('.wallet-pick-err');
          if (existingErr) existingErr.remove();
          const errMsg = document.createElement('div');
          errMsg.className = 'wallet-pick-err';
          errMsg.style.cssText = 'font-size:12px;color:#e05050;padding:4px 16px 0;';
          errMsg.textContent = err.code === 4001 || err.code === 'ACTION_REJECTED'
            ? 'Connection rejected' : (err.message || 'Connection failed');
          btn.insertAdjacentElement('afterend', errMsg);
          setTimeout(() => errMsg.remove(), 4000);
        }
      });

      list.appendChild(btn);
    }
    modal.appendChild(list);
  }

  // Backdrop click to close
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { closeWalletModal(); reject(new Error('Cancelled')); }
  });

  // ESC to close
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeWalletModal(); reject(new Error('Cancelled')); document.removeEventListener('keydown', onEsc); }
  };
  document.addEventListener('keydown', onEsc);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}
