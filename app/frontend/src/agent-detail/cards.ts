import { ethers } from 'ethers';
import { api } from '../api';
import { getNetworkName } from '../app-config';
import { el, shortAddr, timeAgo } from '../dom-utils';
import { copyToClipboard } from '../dom-utils';
import { showWalletPicker, getSelectedProvider } from '../wallet';
import type { AgentDetail, AgentEvent, LivenessData, AssetsData, ERC8004Info, ERC8004Reputation } from './types';
import {
  BSCSCAN_BASE, EVENT_TYPE_COLORS, EVENT_TYPE_LABELS,
  formatNumber, pulseHealthColor, chainStateFromStatus, chainStateClass,
} from './constants';
import { getSandboxState } from './sandbox';

// --- BNB price cache (fetched from /api/bnb-price, 1h TTL) ---

let _bnbPriceCache = { price: 600, fetchedAt: 0 };
const BNB_PRICE_TTL_MS = 3600_000;

function getCachedBnbPrice(): number {
  return _bnbPriceCache.price;
}

export async function refreshBnbPrice(): Promise<number> {
  if (Date.now() - _bnbPriceCache.fetchedAt < BNB_PRICE_TTL_MS) {
    return _bnbPriceCache.price;
  }
  try {
    const res = await fetch('/api/bnb-price');
    if (res.ok) {
      const data = await res.json();
      const price = (data as { price: number }).price;
      if (price > 0) {
        _bnbPriceCache = { price, fetchedAt: Date.now() };
        return price;
      }
    }
  } catch { /* use cached */ }
  return _bnbPriceCache.price;
}

// Kick off initial fetch
refreshBnbPrice();

// --- Status card ---

export function buildStatusCard(detail: AgentDetail): HTMLElement {
  const card = el('div', { className: 'card' },
    el('div', { className: 'card-title' }, 'Status'),
  );
  card.dataset.card = 'status';

  const grid = el('div', { className: 'status-grid' });

  const chainState = chainStateFromStatus(detail.status);
  const stateClass = chainStateClass(chainState);
  grid.appendChild(statusItem('Chain State', 'v-chain-state', chainState, `status-value ${stateClass}`));

  const runtimeLabel = detail.runtime_paused
    ? 'PAUSED'
    : detail.runtime_running
      ? 'RUNNING'
      : 'OFFLINE';
  const runtimeClass = detail.runtime_paused ? 'warning' : detail.runtime_running ? 'active' : '';
  grid.appendChild(statusItem('Runtime', 'v-runtime', runtimeLabel, `status-value ${runtimeClass}`));

  const pulseText = detail.lastPulseAt ? timeAgo(detail.lastPulseAt) : 'Never';
  grid.appendChild(statusItem('Last Pulse', 'v-pulse', pulseText));

  grid.appendChild(statusItem('LLM Calls', 'v-llm-calls', String(detail.llmCallsCount ?? 0)));

  grid.appendChild(statusItem('Framework', null, detail.framework || 'N/A'));

  const modeLabel = detail.sandboxProvider === 'byod'
    ? 'BYOD (Self-Host)'
    : detail.sandboxProvider === 'agos'
      ? 'AGOS (Managed)'
      : 'Cloud (Managed)';
  const modeStyle = detail.sandboxProvider === 'byod'
    ? 'color:#1d4ed8'
    : detail.sandboxProvider === 'agos'
      ? 'color:#b45309'
      : '';
  grid.appendChild(el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, 'Sandbox Provider'),
    el('div', { className: 'status-value', style: modeStyle }, modeLabel),
  ));

  grid.appendChild(statusItem('LLM Provider', null, detail.llmProvider.replace(/_/g, ' ')));

  const sandboxState = getSandboxState();
  const sandboxLabel = detail.sandboxId
    ? (sandboxState ? sandboxState.toUpperCase() : 'Unknown')
    : 'None';
  const sandboxClass = sandboxState === 'running' ? 'active'
    : sandboxState === 'paused' ? 'warning'
    : sandboxState === 'error' || sandboxState === 'failed' ? 'error'
    : '';
  grid.appendChild(statusItem('Sandbox', 'v-sandbox', sandboxLabel, `status-value ${sandboxClass}`));

  card.appendChild(grid);
  return card;
}

/** Patch status card values in-place — zero DOM creation */
export function patchStatusCard(root: HTMLElement, detail: AgentDetail): void {
  const chainState = chainStateFromStatus(detail.status);
  const stateClass = chainStateClass(chainState);
  patchValue(root, 'v-chain-state', chainState, `status-value ${stateClass}`);

  const runtimeLabel = detail.runtime_paused ? 'PAUSED' : detail.runtime_running ? 'RUNNING' : 'OFFLINE';
  const runtimeClass = detail.runtime_paused ? 'warning' : detail.runtime_running ? 'active' : '';
  patchValue(root, 'v-runtime', runtimeLabel, `status-value ${runtimeClass}`);

  const pulseText = detail.lastPulseAt ? timeAgo(detail.lastPulseAt) : 'Never';
  patchValue(root, 'v-pulse', pulseText);

  patchValue(root, 'v-llm-calls', String(detail.llmCallsCount ?? 0));

  const sandboxState = getSandboxState();
  const sandboxLabel = detail.sandboxId
    ? (sandboxState ? sandboxState.toUpperCase() : 'Unknown')
    : 'None';
  const sandboxClass = sandboxState === 'running' ? 'active'
    : sandboxState === 'paused' ? 'warning'
    : sandboxState === 'error' || sandboxState === 'failed' ? 'error'
    : '';
  patchValue(root, 'v-sandbox', sandboxLabel, `status-value ${sandboxClass}`);
}

/** Create a status-item with an optional data-v tag for patching */
function statusItem(label: string, dataV: string | null, value: string, className?: string): HTMLElement {
  const valEl = el('div', { className: className || 'status-value' }, value);
  if (dataV) valEl.dataset.v = dataV;
  return el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, label),
    valEl,
  );
}

/** Patch a single data-v element's text + optional className */
function patchValue(root: HTMLElement, key: string, text: string, className?: string): void {
  const el = root.querySelector(`[data-v="${key}"]`) as HTMLElement | null;
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  if (className && el.className !== className) el.className = className;
}

// --- Info card ---

export function buildInfoCard(detail: AgentDetail): HTMLElement {
  const card = el('div', { className: 'card' },
    el('div', { className: 'card-title' }, 'Info'),
  );

  if (detail.agentIntro) {
    card.appendChild(el('div', { style: 'margin-bottom:16px;font-size:14px;color:#4D4D4D;line-height:1.6' }, detail.agentIntro));
  }

  const rows: [string, string, string][] = [];
  rows.push(['Goo ID', detail.agenterId, '']);
  if (detail.tokenAddress) {
    rows.push(['Token', detail.tokenAddress, `${BSCSCAN_BASE()}/address/${detail.tokenAddress}`]);
  }
  if (detail.agentWallet) {
    rows.push(['Wallet', detail.agentWallet, `${BSCSCAN_BASE()}/address/${detail.agentWallet}`]);
  }
  if (detail.owner_address) {
    rows.push(['Owner', detail.owner_address, `${BSCSCAN_BASE()}/address/${detail.owner_address}`]);
  }

  for (const [label, value, link] of rows) {
    card.appendChild(buildInfoRow(label, value, link));
  }

  return card;
}

function buildInfoRow(label: string, value: string, link: string): HTMLElement {
  const row = el('div', { className: 'info-row' });
  row.appendChild(el('span', { className: 'info-label' }, label));

  const valContainer = el('div', { className: 'info-value' });

  if (link) {
    const a = el('a', {
      href: link,
      target: '_blank',
      rel: 'noopener',
    }, shortAddr(value));
    valContainer.appendChild(a);
  } else {
    valContainer.appendChild(el('span', null, value));
  }

  const copyBtn = el('button', { className: 'btn-copy' }, 'Copy');
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyToClipboard(value, copyBtn);
  });
  valContainer.appendChild(copyBtn);

  row.appendChild(valContainer);
  return row;
}

// --- Liveness card (kept for backward compat, delegates to on-chain card) ---

export async function loadLiveness(agentId: string, container: HTMLElement): Promise<void> {
  try {
    const data = await api<LivenessData>('GET', `/api/agents/${agentId}/liveness`);
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(buildLivenessCard(data));
  } catch {
    // Liveness is optional — don't show error for non-deployed agents
  }
}

/** @deprecated Use buildOnChainCard instead */
export function buildLivenessCard(data: LivenessData): HTMLElement {
  return buildOnChainCard(data, null);
}

/** @deprecated Use patchOnChainCard instead */
export function patchLivenessCard(root: HTMLElement, data: LivenessData): void {
  patchOnChainCard(root, data, null);
}

// --- On-Chain Status card (merged Assets + Liveness) ---

export function buildOnChainCard(data: LivenessData, tokenSymbol: string | null, fundDetail?: AgentDetail): HTMLElement {
  const isCritical = data.pulse.health === 'critical';
  const cardClass = isCritical ? 'card card-elevated card-critical' : 'card card-elevated';
  const card = el('div', { className: cardClass });
  card.dataset.card = 'onchain';

  const titleRow = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' });
  titleRow.appendChild(el('div', { className: 'card-title', style: 'margin-bottom:0' }, 'Financials'));
  const updatedEl = el('span', { style: 'font-size:11px;color:#B2B2B2' },
    `Updated ${new Date(data.timestamp).toLocaleTimeString()}`);
  updatedEl.dataset.v = 'v-oc-updated';
  titleRow.appendChild(updatedEl);
  card.appendChild(titleRow);

  // --- Health row: Chain Status, Pulse Health, Last Pulse, Pulse Timeout ---
  const healthGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:16px' });

  const statusClass = data.status === 'ACTIVE' ? 'active'
    : data.status === 'STARVING' ? 'warning'
    : data.status === 'DYING' ? 'suspended'
    : data.status === 'DEAD' ? 'dead' : '';
  healthGrid.appendChild(statusItem('Chain Status', 'v-oc-status', data.status, `status-value ${statusClass}`));

  const pulseColor = pulseHealthColor(data.pulse.health);
  const pulseLabel = data.pulse.lastPulseAt > 0
    ? (data.pulse.overdue ? 'OVERDUE' : data.pulse.health.toUpperCase())
    : 'NO PULSE';
  const pulseValEl = el('div', { style: `font-size:14px;font-weight:600;color:${pulseColor}` }, pulseLabel);
  pulseValEl.dataset.v = 'v-oc-pulse-health';
  healthGrid.appendChild(el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, 'Pulse Health'),
    pulseValEl,
  ));

  const pulseText = data.pulse.lastPulseIso ? timeAgo(data.pulse.lastPulseIso) : 'Never';
  healthGrid.appendChild(statusItem('Last Pulse', 'v-oc-pulse-time', pulseText));

  const timeoutText = data.pulse.secondsUntilTimeout !== null
    ? `${data.pulse.secondsUntilTimeout}s`
    : 'N/A';
  healthGrid.appendChild(statusItem('Pulse Timeout', 'v-oc-timeout', timeoutText));
  card.appendChild(healthGrid);

  // --- Balances row: BNB, extra tokens, $TOKEN, Treasury ---
  const balanceItems: Array<{ label: string; key: string; value: string }> = [
    { label: 'BNB', key: 'v-oc-bnb', value: `${formatNumber(data.balances.nativeBnb, 4)}` },
  ];
  if (data.balances.paymentToken) {
    balanceItems.push({
      label: data.balances.paymentToken.symbol,
      key: 'v-oc-payment',
      value: formatNumber(data.balances.paymentToken.balance, 2),
    });
  }
  if (data.balances.tokens) {
    data.balances.tokens.forEach((t, i) => {
      balanceItems.push({ label: t.symbol, key: `v-oc-token-${i}`, value: formatNumber(t.balance, 2) });
    });
  }
  balanceItems.push({
    label: `$${tokenSymbol || 'TOKEN'}`,
    key: 'v-oc-token',
    value: formatNumber(data.balances.tokenHoldings, 0),
  });
  balanceItems.push({
    label: 'Treasury',
    key: 'v-oc-treasury',
    value: `${formatNumber(data.treasury.balance, 4)} BNB`,
  });

  // Infra Balance (agent wallet BNB × BNB price in USD)
  const walletBnb = parseFloat(data.balances.nativeBnb) || 0;
  const bnbPrice = getCachedBnbPrice();
  const infraUsd = walletBnb * bnbPrice;
  const infraText = `$${infraUsd.toFixed(2)}`;
  const infraColor = infraUsd >= 20 ? '#00C7D2' : infraUsd >= 10 ? '#b45309' : '#dc2626';
  balanceItems.push({
    label: 'Infra Balance',
    key: 'v-oc-infra',
    value: infraText,
  });

  const cols = Math.min(balanceItems.length, 5);
  const balanceGrid = el('div', { style: `display:grid;grid-template-columns:repeat(${cols},1fr);gap:16px;margin-top:16px;padding-top:16px;border-top:1px solid #ebebeb` });
  for (const item of balanceItems) {
    const isInfra = item.key === 'v-oc-infra';
    const valEl = el('div', {
      className: 'status-value',
      style: isInfra ? `color:${infraColor};font-weight:700` : '',
    }, item.value);
    valEl.dataset.v = item.key;
    balanceGrid.appendChild(el('div', { className: 'status-item' },
      el('div', { className: 'status-label' }, item.label),
      valEl,
    ));
  }
  card.appendChild(balanceGrid);

  // --- Lifecycle row (only if starving or dying) ---
  const isStarving = data.lifecycle.starvingEnteredAt > 0;
  const isDying = data.lifecycle.dyingEnteredAt > 0;
  if (isStarving || isDying) {
    const lifecycleGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-top:16px;padding-top:16px;border-top:1px solid #ebebeb' });

    const starvingText = isStarving
      ? `${timeAgo(new Date(data.lifecycle.starvingEnteredAt * 1000).toISOString())} (${data.lifecycle.starvingRemainingSecs ?? 0}s left)`
      : 'Not starving';
    lifecycleGrid.appendChild(statusItem('Starving Window', 'v-oc-starving', starvingText));

    const dyingText = isDying
      ? `${timeAgo(new Date(data.lifecycle.dyingEnteredAt * 1000).toISOString())} (${data.lifecycle.dyingRemainingSecs ?? 0}s left)`
      : 'Not dying';
    lifecycleGrid.appendChild(statusItem('Dying Window', 'v-oc-dying', dyingText));

    card.appendChild(lifecycleGrid);
  }

  // --- Virtual status badges (display-only, based on balance + AGOS state) ---
  const badgeContainer = el('div', {
    style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:1px solid #ebebeb',
  });
  badgeContainer.dataset.v = 'v-oc-badges';
  let hasBadges = false;

  if (infraUsd < 20) {
    const color = infraUsd < 10 ? '#dc2626' : '#b45309';
    badgeContainer.appendChild(el('span', {
      style: `display:inline-block;font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;color:#fff;background:${color}`,
    }, 'STARVING'));
    hasBadges = true;
  }

  if (data.pulse.overdue) {
    badgeContainer.appendChild(el('span', {
      style: 'display:inline-block;font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;color:#fff;background:#dc2626',
    }, 'DYING'));
    hasBadges = true;
  }

  if (fundDetail?.sandboxProvider === 'agos' && fundDetail?.runtimeState === 'terminated') {
    badgeContainer.appendChild(el('span', {
      style: 'display:inline-block;font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;color:#fff;background:#dc2626',
    }, 'VPS Terminated'));
    hasBadges = true;
  }

  if (hasBadges) card.appendChild(badgeContainer);

  // --- Fund section (owner only, merged into Financials) ---
  if (fundDetail?.agentWallet) {
    card.appendChild(buildFundSection(fundDetail));
  }

  return card;
}

/** Patch on-chain card values in-place */
export function patchOnChainCard(root: HTMLElement, data: LivenessData, tokenSymbol: string | null): void {
  const card = root.querySelector('[data-card="onchain"]') as HTMLElement | null;
  if (card) {
    const isCritical = data.pulse.health === 'critical';
    const cardClass = isCritical ? 'card card-elevated card-critical' : 'card card-elevated';
    if (card.className !== cardClass) card.className = cardClass;
    card.dataset.card = 'onchain';
  }

  const statusClass = data.status === 'ACTIVE' ? 'active'
    : data.status === 'STARVING' ? 'warning'
    : data.status === 'DYING' ? 'suspended'
    : data.status === 'DEAD' ? 'dead' : '';
  patchValue(root, 'v-oc-status', data.status, `status-value ${statusClass}`);

  const pulseColor = pulseHealthColor(data.pulse.health);
  const pulseLabel = data.pulse.lastPulseAt > 0
    ? (data.pulse.overdue ? 'OVERDUE' : data.pulse.health.toUpperCase())
    : 'NO PULSE';
  const pulseEl = root.querySelector('[data-v="v-oc-pulse-health"]') as HTMLElement | null;
  if (pulseEl) {
    if (pulseEl.textContent !== pulseLabel) pulseEl.textContent = pulseLabel;
    pulseEl.style.color = pulseColor;
  }

  const pulseText = data.pulse.lastPulseIso ? timeAgo(data.pulse.lastPulseIso) : 'Never';
  patchValue(root, 'v-oc-pulse-time', pulseText);

  const timeoutText = data.pulse.secondsUntilTimeout !== null
    ? `${data.pulse.secondsUntilTimeout}s`
    : 'N/A';
  patchValue(root, 'v-oc-timeout', timeoutText);

  patchValue(root, 'v-oc-bnb', `${formatNumber(data.balances.nativeBnb, 4)}`);
  if (data.balances.paymentToken) {
    patchValue(root, 'v-oc-payment', formatNumber(data.balances.paymentToken.balance, 2));
  }
  if (data.balances.tokens) {
    data.balances.tokens.forEach((t, i) => {
      patchValue(root, `v-oc-token-${i}`, formatNumber(t.balance, 2));
    });
  }
  patchValue(root, 'v-oc-token', formatNumber(data.balances.tokenHoldings, 0));
  patchValue(root, 'v-oc-treasury', `${formatNumber(data.treasury.balance, 4)} BNB`);

  // Infra Balance
  const pWalletBnb = parseFloat(data.balances.nativeBnb) || 0;
  const pBnbPrice = getCachedBnbPrice();
  const pInfraUsd = pWalletBnb * pBnbPrice;
  patchValue(root, 'v-oc-infra', `$${pInfraUsd.toFixed(2)}`);

  patchValue(root, 'v-oc-updated', `Updated ${new Date(data.timestamp).toLocaleTimeString()}`);
}

// --- Assets card ---

/** Load on-chain status card (merged assets + liveness). */
export async function loadOnChainCard(detail: AgentDetail, container: HTMLElement, isOwner?: boolean): Promise<void> {
  try {
    const data = await api<LivenessData>('GET', `/api/agents/${detail.id}/liveness`);
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(buildOnChainCard(data, detail.tokenSymbol || null, isOwner ? detail : undefined));
  } catch (err) {
    while (container.firstChild) container.removeChild(container.firstChild);
    const card = el('div', { className: 'card' });
    card.appendChild(el('div', { className: 'card-title' }, 'Financials'));
    card.appendChild(el('div', { style: 'font-size:13px;color:#B2B2B2' },
      `Failed to load: ${(err as Error).message}`));
    const retryBtn = el('button', {
      style: 'margin-top:8px;padding:3px 10px;font-size:11px;font-weight:500;background:#f0f0ef;border:1px solid #ebebeb;border-radius:6px;color:#4D4D4D;cursor:pointer;font-family:inherit',
    }, 'Retry') as HTMLButtonElement;
    retryBtn.addEventListener('click', () => loadOnChainCard(detail, container));
    card.appendChild(retryBtn);
    container.appendChild(card);
  }
}

/** @deprecated kept for backward compat */
export function fetchAssets(detail: AgentDetail): Promise<AssetsData> {
  return api<LivenessData>('GET', `/api/agents/${detail.id}/liveness`).then(liveness => {
    const tokens: AssetsData['tokens'] = [];
    if (liveness.balances.paymentToken) {
      tokens.push({ symbol: liveness.balances.paymentToken.symbol, balance: liveness.balances.paymentToken.balance, address: liveness.balances.paymentToken.address });
    }
    if (liveness.balances.tokens) {
      for (const t of liveness.balances.tokens) tokens.push({ symbol: t.symbol, balance: t.balance, address: t.address });
    }
    return { bnb: liveness.balances.nativeBnb, treasury: liveness.treasury.balance, token: liveness.balances.tokenHoldings, tokenSymbol: detail.tokenSymbol || 'TOKEN', tokens };
  });
}

/** @deprecated Use buildOnChainCard */
export function buildAssetsCard(assets: AssetsData, _lastUpdated: Date, _onRefresh: () => void): HTMLElement {
  const card = el('div', { className: 'card' });
  card.dataset.card = 'assets';
  card.appendChild(el('div', { className: 'card-title' }, 'Agent Wallet Assets'));
  return card;
}

/** @deprecated Use patchOnChainCard */
export function patchAssetsCard(_root: HTMLElement, _assets: AssetsData): void {}

/** @deprecated Use loadOnChainCard */
export function loadAssets(detail: AgentDetail, container: HTMLElement): Promise<void> {
  return loadOnChainCard(detail, container);
}

// --- Events card (with filter + pagination) ---

const EVENTS_PER_PAGE = 10;

export function buildEventsCard(events: AgentEvent[]): HTMLElement {
  const card = el('div', { className: 'card' },
    el('div', { className: 'card-title' }, 'Event Timeline'),
  );
  card.dataset.card = 'events';
  card.dataset.eventCount = String(events.length);

  if (events.length === 0) {
    card.appendChild(el('div', { className: 'empty-state' }, 'No events yet.'));
    return card;
  }

  // Collect unique event types
  const eventTypes = Array.from(new Set(events.map(e => e.event_type || 'other')));
  let activeFilter: string | null = null;
  let currentPage = 0;

  const filterBar = el('div', { className: 'event-filter-bar' });
  const eventsContainer = el('div');
  const paginationContainer = el('div');

  function getFiltered(): AgentEvent[] {
    if (!activeFilter) return events;
    return events.filter(e => (e.event_type || 'other') === activeFilter);
  }

  function renderEvents() {
    while (eventsContainer.firstChild) eventsContainer.removeChild(eventsContainer.firstChild);
    while (paginationContainer.firstChild) paginationContainer.removeChild(paginationContainer.firstChild);

    const filtered = getFiltered();
    const totalPages = Math.ceil(filtered.length / EVENTS_PER_PAGE);
    const pageEvents = filtered.slice(currentPage * EVENTS_PER_PAGE, (currentPage + 1) * EVENTS_PER_PAGE);

    for (const ev of pageEvents) {
      eventsContainer.appendChild(buildEventRow(ev));
    }

    if (totalPages > 1) {
      const pag = el('div', { className: 'event-pagination' });
      const prevBtn = el('button', null, '\u2190 Prev') as HTMLButtonElement;
      prevBtn.disabled = currentPage === 0;
      prevBtn.addEventListener('click', () => { currentPage--; renderEvents(); });
      const nextBtn = el('button', null, 'Next \u2192') as HTMLButtonElement;
      nextBtn.disabled = currentPage >= totalPages - 1;
      nextBtn.addEventListener('click', () => { currentPage++; renderEvents(); });
      pag.appendChild(prevBtn);
      pag.appendChild(el('span', null, `${currentPage + 1} / ${totalPages}`));
      pag.appendChild(nextBtn);
      paginationContainer.appendChild(pag);
    }
  }

  // Build filter buttons
  const allBtn = el('button', { className: 'event-filter-btn active' }, 'All') as HTMLButtonElement;
  allBtn.addEventListener('click', () => {
    activeFilter = null;
    currentPage = 0;
    filterBar.querySelectorAll('.event-filter-btn').forEach(b => b.classList.remove('active'));
    allBtn.classList.add('active');
    renderEvents();
  });
  filterBar.appendChild(allBtn);

  for (const type of eventTypes) {
    const label = EVENT_TYPE_LABELS[type] || type;
    const btn = el('button', { className: 'event-filter-btn' }, label) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      activeFilter = type;
      currentPage = 0;
      filterBar.querySelectorAll('.event-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderEvents();
    });
    filterBar.appendChild(btn);
  }

  card.appendChild(filterBar);
  card.appendChild(eventsContainer);
  card.appendChild(paginationContainer);
  renderEvents();

  return card;
}

function buildEventRow(ev: AgentEvent): HTMLElement {
  const txRow = el('div', { className: 'tx-row' });

  // Severity-based border for core events with errors
  if (ev.source === 'core' && (ev.severity === 'error' || ev.severity === 'critical')) {
    txRow.style.borderLeft = '3px solid #dc2626';
    txRow.style.paddingLeft = '8px';
  } else if (ev.source === 'core' && ev.severity === 'warn') {
    txRow.style.borderLeft = '3px solid #ea580c';
    txRow.style.paddingLeft = '8px';
  }

  const eventType = ev.event_type || 'other';
  const badgeColor = EVENT_TYPE_COLORS[eventType] || EVENT_TYPE_COLORS.other;
  const badgeLabel = EVENT_TYPE_LABELS[eventType] || eventType;
  const badge = el('span', {
    style: `display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;color:#fff;background:${badgeColor};margin-right:8px;text-transform:uppercase;letter-spacing:0.03em`,
  }, badgeLabel);

  // For core events, show severity badge too
  const methodLabel = ev.source === 'core' ? ev.method.replace(/_/g, ' ') : ev.method;

  const header = el('div', { className: 'tx-header' },
    el('span', { className: 'tx-method' }, badge, methodLabel),
    el('span', { className: 'tx-time' }, ev.createdAt ? timeAgo(ev.createdAt) : ''),
  );
  txRow.appendChild(header);

  if (ev.memo) {
    txRow.appendChild(el('div', { className: 'tx-memo' }, ev.memo));
  }

  if (ev.txHash && ev.txHash.startsWith('0x')) {
    const hashDiv = el('div', { className: 'tx-hash' });
    hashDiv.appendChild(el('a', {
      href: `${BSCSCAN_BASE()}/tx/${ev.txHash}`,
      target: '_blank',
      rel: 'noopener',
    }, shortAddr(ev.txHash)));
    txRow.appendChild(hashDiv);
  }

  return txRow;
}

// --- Runtime card ---

export function buildRuntimeCard(detail: AgentDetail, options: { canManage: boolean }): HTMLElement {
  const card = el('div', { className: 'card' });
  const titleRow = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px' });
  titleRow.appendChild(el('div', { className: 'card-title', style: 'margin-bottom:0' }, 'Runtime Info'));
  card.appendChild(titleRow);

  const grid = el('div', { className: 'status-grid' });

  const gwLabel = detail.gatewayUrl || 'Not configured';
  const gwColor = detail.gatewayUrl ? '#00C7D2' : '#B2B2B2';
  grid.appendChild(el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, 'Gateway'),
    el('div', { style: `font-size:13px;color:${gwColor};word-break:break-all` }, gwLabel),
  ));

  const gcStatus = detail.gooCoreStatus || 'unknown';
  const gcColor = gcStatus === 'running' ? '#00C7D2' : gcStatus === 'installing' ? '#f59e0b' : '#B2B2B2';
  grid.appendChild(el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, 'goo-core'),
    el('div', { style: `font-size:13px;font-weight:600;color:${gcColor};text-transform:uppercase` }, gcStatus),
  ));

  card.appendChild(grid);

  if (options.canManage && detail.sandboxProvider === 'byod' && !detail.gatewayUrl) {
    card.appendChild(buildGatewayRegistrationForm(detail));
  }

  return card;
}

function buildGatewayRegistrationForm(detail: AgentDetail): HTMLElement {
  const section = el('div', { style: 'margin-top:16px;padding-top:16px;border-top:1px solid #ebebeb' });
  section.appendChild(el('div', {
    style: 'font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#4D4D4D;font-weight:600;margin-bottom:8px',
  }, 'Register Gateway'));
  section.appendChild(el('div', {
    style: 'font-size:13px;color:#B2B2B2;margin-bottom:12px',
  }, 'Register your OpenClaw gateway to enable chat from this dashboard.'));

  const urlInput = el('input', {
    type: 'text',
    placeholder: 'https://your-vps:18789',
    style: 'width:100%;padding:8px 10px;border:1px solid #ebebeb;border-radius:8px;font-size:13px;font-family:monospace;box-sizing:border-box;margin-bottom:8px',
  }) as HTMLInputElement;

  const tokenInput = el('input', {
    type: 'text',
    placeholder: 'Gateway token (from .env OPENCLAW_GATEWAY_TOKEN)',
    style: 'width:100%;padding:8px 10px;border:1px solid #ebebeb;border-radius:8px;font-size:13px;font-family:monospace;box-sizing:border-box;margin-bottom:8px',
  }) as HTMLInputElement;

  const resultContainer = el('div');
  const registerBtn = el('button', { className: 'btn-trigger', style: 'background:#00C7D2;font-size:13px;padding:6px 14px' }, 'Register & Verify') as HTMLButtonElement;

  registerBtn.addEventListener('click', async () => {
    const gwUrl = urlInput.value.trim();
    const gwToken = tokenInput.value.trim();
    if (!gwUrl || !gwToken) {
      while (resultContainer.firstChild) resultContainer.removeChild(resultContainer.firstChild);
      resultContainer.appendChild(el('div', { className: 'trigger-result error' }, 'Both URL and token are required.'));
      return;
    }

    registerBtn.disabled = true;
    registerBtn.textContent = 'Verifying...';
    while (resultContainer.firstChild) resultContainer.removeChild(resultContainer.firstChild);

    try {
      await api<{ message: string }>('POST', `/api/agents/${detail.id}/register-gateway`, {
        gateway_url: gwUrl,
        gateway_token: gwToken,
      });
      resultContainer.appendChild(el('div', { className: 'trigger-result success' }, 'Gateway registered and verified.'));
      // Trigger reload via custom event
      window.dispatchEvent(new CustomEvent('agent-reload', { detail: { id: String(detail.id) } }));
    } catch (err) {
      resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
      registerBtn.disabled = false;
      registerBtn.textContent = 'Register & Verify';
    }
  });

  section.appendChild(urlInput);
  section.appendChild(tokenInput);
  section.appendChild(registerBtn);
  section.appendChild(resultContainer);
  return section;
}

// --- Fund section (embedded in Financials card) ---

function buildFundSection(detail: AgentDetail): HTMLElement {
  const section = el('div', { style: 'margin-top:16px;padding-top:16px;border-top:1px solid #ebebeb' });
  section.appendChild(el('div', {
    style: 'font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#4D4D4D;font-weight:600;margin-bottom:12px',
  }, 'Fund'));

  const paymentTokenAddress = detail.paymentTokenAddress;
  const resultContainer = el('div');

  // Send BNB (gas) section
  const bnbRow = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap' });
  const bnbInput = el('input', {
    type: 'number',
    placeholder: '0.1',
    value: '0.1',
    style: 'width:100px;padding:8px 10px;border:1px solid #ebebeb;border-radius:8px;font-size:13px;font-family:monospace;box-sizing:border-box',
  }) as HTMLInputElement;
  bnbInput.step = '0.01';
  bnbInput.min = '0.001';
  const bnbBtn = el('button', { className: 'btn-trigger', style: 'background:#f59e0b;width:auto;padding:8px 20px' }, 'Send BNB (Gas)') as HTMLButtonElement;
  bnbRow.appendChild(bnbInput);
  bnbRow.appendChild(el('span', { style: 'font-size:13px;color:#4D4D4D;font-weight:500' }, 'BNB'));
  bnbRow.appendChild(bnbBtn);
  section.appendChild(bnbRow);

  // Send payment token section
  const stableRow = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap' });
  const stableInput = el('input', {
    type: 'number',
    placeholder: '100',
    value: '100',
    style: 'width:100px;padding:8px 10px;border:1px solid #ebebeb;border-radius:8px;font-size:13px;font-family:monospace;box-sizing:border-box',
  }) as HTMLInputElement;
  stableInput.step = '1';
  stableInput.min = '1';
  const stableBtn = el('button', { className: 'btn-trigger', style: 'background:#0081f2;width:auto;padding:8px 20px' }, 'Send Stable') as HTMLButtonElement;
  if (!paymentTokenAddress) {
    stableBtn.disabled = true;
    stableBtn.style.opacity = '0.6';
    stableInput.disabled = true;
  }
  stableRow.appendChild(stableInput);
  stableRow.appendChild(el('span', { style: 'font-size:13px;color:#4D4D4D;font-weight:500' }, 'Stable'));
  stableRow.appendChild(stableBtn);
  if (paymentTokenAddress) {
    stableRow.appendChild(el(
      'span',
      { style: 'font-size:11px;color:#B2B2B2;font-family:monospace' },
      `${paymentTokenAddress.slice(0, 6)}...${paymentTokenAddress.slice(-4)}`,
    ));
  } else {
    stableRow.appendChild(el('span', { style: 'font-size:11px;color:#B2B2B2' }, 'No payment token configured'));
  }
  section.appendChild(stableRow);

  // Fund Treasury section
  const treasuryRow = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap' });
  const treasuryInput = el('input', {
    type: 'number',
    placeholder: '0.1',
    value: '0.1',
    style: 'width:100px;padding:8px 10px;border:1px solid #ebebeb;border-radius:8px;font-size:13px;font-family:monospace;box-sizing:border-box',
  }) as HTMLInputElement;
  treasuryInput.step = '0.01';
  treasuryInput.min = '0.01';
  const treasuryBtn = el('button', { className: 'btn-trigger', style: 'background:#00C7D2;width:auto;padding:8px 20px' }, 'Fund Treasury') as HTMLButtonElement;
  treasuryRow.appendChild(treasuryInput);
  treasuryRow.appendChild(el('span', { style: 'font-size:13px;color:#4D4D4D;font-weight:500' }, 'BNB'));
  treasuryRow.appendChild(treasuryBtn);
  section.appendChild(treasuryRow);

  const agentWallet = detail.agentWallet!;

  // Send BNB (gas) handler
  bnbBtn.addEventListener('click', async () => {
    const amount = bnbInput.value.trim();
    if (!amount || parseFloat(amount) <= 0) {
      showFundResult(resultContainer, 'error', 'Enter a valid BNB amount.');
      return;
    }
    bnbBtn.disabled = true;
    bnbBtn.textContent = 'Connecting...';
    showFundResult(resultContainer, '', '');
    try {
      await showWalletPicker();
      const provider = new ethers.BrowserProvider(getSelectedProvider());
      const signer = await provider.getSigner();
      bnbBtn.textContent = 'Confirm in wallet...';
      const tx = await signer.sendTransaction({
        to: agentWallet,
        value: ethers.parseEther(amount),
      });
      bnbBtn.textContent = 'Mining...';
      await tx.wait();
      showFundResult(resultContainer, 'success', `Sent ${amount} BNB to agent wallet. TX: ${tx.hash.slice(0, 10)}...`);
    } catch (err: any) {
      if (err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message === 'Cancelled') {
        showFundResult(resultContainer, 'error', 'Transaction rejected.');
      } else {
        showFundResult(resultContainer, 'error', err.message?.slice(0, 80) || 'Failed to send BNB.');
      }
    } finally {
      bnbBtn.disabled = false;
      bnbBtn.textContent = 'Send BNB (Gas)';
    }
  });

  // Send payment token handler — ERC-20 transfer to agent wallet
  stableBtn.addEventListener('click', async () => {
    if (!paymentTokenAddress) {
      showFundResult(resultContainer, 'error', 'No payment token configured for this environment.');
      return;
    }
    const amount = stableInput.value.trim();
    if (!amount || parseFloat(amount) <= 0) {
      showFundResult(resultContainer, 'error', 'Enter a valid token amount.');
      return;
    }
    stableBtn.disabled = true;
    stableBtn.textContent = 'Connecting...';
    showFundResult(resultContainer, '', '');
    try {
      await showWalletPicker();
      const provider = new ethers.BrowserProvider(getSelectedProvider());
      const signer = await provider.getSigner();
      stableBtn.textContent = 'Reading token...';
      const token = new ethers.Contract(paymentTokenAddress, [
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
        'function transfer(address to, uint256 amount) returns (bool)',
      ], signer);
      const [decimals, symbol] = await Promise.all([
        token.decimals() as Promise<number>,
        token.symbol() as Promise<string>,
      ]);
      const parsedAmount = ethers.parseUnits(amount, decimals);
      stableBtn.textContent = 'Confirm in wallet...';
      const tx = await token.transfer(agentWallet, parsedAmount);
      stableBtn.textContent = 'Mining...';
      await tx.wait();
      showFundResult(resultContainer, 'success', `Sent ${amount} ${symbol} to agent wallet. TX: ${tx.hash.slice(0, 10)}...`);
    } catch (err: any) {
      if (err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message === 'Cancelled') {
        showFundResult(resultContainer, 'error', 'Transaction rejected.');
      } else {
        showFundResult(resultContainer, 'error', err.message?.slice(0, 80) || 'Failed to send payment token.');
      }
    } finally {
      stableBtn.disabled = false;
      stableBtn.textContent = 'Send Stable';
    }
  });

  // Fund Treasury handler — calls depositToTreasury() payable on the token contract
  treasuryBtn.addEventListener('click', async () => {
    const amount = treasuryInput.value.trim();
    if (!amount || parseFloat(amount) <= 0) {
      showFundResult(resultContainer, 'error', 'Enter a valid BNB amount for treasury.');
      return;
    }
    treasuryBtn.disabled = true;
    treasuryBtn.textContent = 'Connecting...';
    showFundResult(resultContainer, '', '');
    try {
      await showWalletPicker();
      const provider = new ethers.BrowserProvider(getSelectedProvider());
      const signer = await provider.getSigner();
      treasuryBtn.textContent = 'Confirm in wallet...';
      const tokenContract = new ethers.Contract(detail.tokenAddress!, [
        'function depositToTreasury() payable',
      ], signer);
      const tx = await tokenContract.depositToTreasury({ value: ethers.parseEther(amount) });
      treasuryBtn.textContent = 'Mining...';
      await tx.wait();
      showFundResult(resultContainer, 'success', `Funded treasury with ${amount} BNB. TX: ${tx.hash.slice(0, 10)}...`);
    } catch (err: any) {
      if (err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message === 'Cancelled') {
        showFundResult(resultContainer, 'error', 'Transaction rejected.');
      } else {
        showFundResult(resultContainer, 'error', err.message?.slice(0, 80) || 'Failed to fund treasury.');
      }
    } finally {
      treasuryBtn.disabled = false;
      treasuryBtn.textContent = 'Fund Treasury';
    }
  });

  section.appendChild(resultContainer);
  return section;
}

/** @deprecated Use buildFundSection embedded in Financials card */
export function buildFundCard(detail: AgentDetail): HTMLElement {
  const card = el('div', { className: 'card' });
  card.appendChild(el('div', { className: 'card-title' }, 'Fund'));
  card.appendChild(buildFundSection(detail));
  return card;
}

function showFundResult(container: HTMLElement, type: string, message: string): void {
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!message) return;
  container.appendChild(el('div', { className: `trigger-result ${type}` }, message));
}

// --- ERC-8004 Identity & Reputation card ---

export async function loadERC8004Card(detail: AgentDetail, container: HTMLElement): Promise<void> {
  try {
    const info = await api<ERC8004Info>('GET', `/api/agents/${detail.id}/erc8004`);
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(buildERC8004Card(detail, info));

    // Load reputation if registered
    if (info.registered && info.erc8004_agent_id) {
      const repContainer = container.querySelector('[data-v="erc8004-rep"]');
      if (repContainer) {
        try {
          const rep = await api<ERC8004Reputation>('GET', `/api/agents/${detail.id}/reputation`);
          (repContainer as HTMLElement).textContent = '';
          (repContainer as HTMLElement).appendChild(buildReputationSummary(rep));
        } catch {
          (repContainer as HTMLElement).textContent = 'No feedback yet';
        }
      }
    }
  } catch {
    // ERC-8004 is optional — don't show error
  }
}

function buildERC8004Card(_detail: AgentDetail, info: ERC8004Info): HTMLElement {
  const card = el('div', { className: 'card' });
  card.dataset.card = 'erc8004';

  card.appendChild(el('div', { className: 'card-title' }, 'Goo on ERC-8004'));

  if (!info.registered) {
    card.appendChild(el('div', { style: 'font-size:13px;color:#B2B2B2' }, 'Not registered on ERC-8004'));
    return card;
  }

  const grid = el('div', { className: 'status-grid' });

  grid.appendChild(el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, 'ERC-8004 Agent ID'),
    el('div', { className: 'status-value', style: 'font-weight:600' }, `#${info.erc8004_agent_id}`),
  ));

  grid.appendChild(el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, 'Status'),
    el('div', { className: 'status-value active' }, 'REGISTERED'),
  ));

  if (info.identity_registry) {
    const regRow = el('div', { className: 'status-item' });
    regRow.appendChild(el('div', { className: 'status-label' }, 'Identity Registry'));
    const link = el('a', {
      href: `${BSCSCAN_BASE()}/address/${info.identity_registry}`,
      target: '_blank',
      rel: 'noopener',
      style: 'font-size:13px;color:#00C7D2;text-decoration:none',
    }, shortAddr(info.identity_registry));
    regRow.appendChild(link);
    grid.appendChild(regRow);
  }

  card.appendChild(grid);

  // Reputation section
  card.appendChild(el('div', {
    style: 'margin-top:16px;padding-top:12px;border-top:1px solid #ebebeb;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#4D4D4D;font-weight:600;margin-bottom:8px',
  }, 'Reputation'));

  const repContainer = el('div', { style: 'font-size:13px;color:#B2B2B2' }, 'Loading...');
  repContainer.dataset.v = 'erc8004-rep';
  card.appendChild(repContainer);

  return card;
}

function buildReputationSummary(rep: ERC8004Reputation): HTMLElement {
  const wrapper = el('div');

  if (rep.count === 0) {
    wrapper.appendChild(el('div', { style: 'font-size:13px;color:#B2B2B2' }, 'No feedback yet'));
    return wrapper;
  }

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:12px' });

  // Score
  const decimals = rep.summary_value_decimals || 0;
  const rawValue = parseFloat(rep.summary_value) / Math.pow(10, decimals);
  const scoreText = rawValue >= 0 ? `+${rawValue.toFixed(decimals)}` : rawValue.toFixed(decimals);
  const scoreColor = rawValue >= 0 ? '#00C7D2' : '#dc2626';
  grid.appendChild(el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, 'Score'),
    el('div', { style: `font-size:16px;font-weight:700;color:${scoreColor}` }, scoreText),
  ));

  // Feedback count
  grid.appendChild(el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, 'Feedback'),
    el('div', { style: 'font-size:16px;font-weight:600;color:#000' }, String(rep.count)),
  ));

  // Unique clients
  grid.appendChild(el('div', { className: 'status-item' },
    el('div', { className: 'status-label' }, 'Clients'),
    el('div', { style: 'font-size:16px;font-weight:600;color:#000' }, String(rep.clients.length)),
  ));

  wrapper.appendChild(grid);
  return wrapper;
}
