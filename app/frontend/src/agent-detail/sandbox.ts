import { api } from '../api';
import { el, clearChildren, copyToClipboard } from '../dom-utils';
import { getConnectedAccount, showWalletPicker, getSelectedProvider } from '../wallet';
import { createSandboxWithPayment } from '../x402';
import { getAppConfig } from '../app-config';
import type { AgentDetail, SandboxStatusResponse, ExecResponse, SandboxLogsResponse, SandboxEventsResponse } from './types';

// --- Module-scope state (persists across 30s refresh) ---

let lastSandboxState: string | null = null;
let lastSandboxStatus: SandboxStatusResponse | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let startupPollTimer: ReturnType<typeof setInterval> | null = null;
let sandboxBusy = false; // true during creation/startup polling

// Tab state persistence
let activeTab: 'info' | 'exec' | 'logs' | 'events' = 'info';
let commandHistory: string[] = [];
let historyIndex = -1;
let execOutput = '';
let logsContent = '';
let logsAutoRefresh = false;
let logsInterval: ReturnType<typeof setInterval> | null = null;


export function dispatchAgentRefresh(id: string | number, delayMs: number = 1000): void {
  setTimeout(() => window.dispatchEvent(new CustomEvent('agent-refresh', { detail: { id: String(id) } })), delayMs);
}

// --- Pre-fetch sandbox status (called from index.ts before render) ---

/** Seed sandbox state synchronously before rendering. Called by index.ts. */
export function initSandboxStatus(resp: SandboxStatusResponse | null): void {
  if (!resp || !resp.has_sandbox) {
    lastSandboxState = null;
    lastSandboxStatus = null;
  } else {
    lastSandboxState = (resp.state || 'running').toLowerCase();
    lastSandboxStatus = resp;
  }
}

/** Read the cached sandbox state (used by cards.ts for synchronous rendering). */
export function getSandboxState(): string | null {
  return lastSandboxState;
}

/** True when a sandbox is being created or startup-polled — refresh should be suppressed. */
export function isSandboxBusy(): boolean {
  return sandboxBusy;
}

// --- Toast notification ---

function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icon = type === 'success' ? '\u2713' : '\u2717';
  const toast = el('div', { className: `toast ${type}`, style: 'position:relative' },
    el('span', { className: 'toast-icon' }, icon),
    el('span', null, message),
  );
  const progressBar = el('div', { className: 'toast-progress' });
  toast.appendChild(progressBar);

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-dismiss');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// --- Progress overlay for sandbox creation (launch-style vertical steps) ---

type ProgressStep = 'request' | 'sign' | 'confirm' | 'startup';

const STEP_DEFS: { key: ProgressStep; label: string; detail: string }[] = [
  { key: 'request', label: 'Request Sandbox', detail: 'Connecting to sandbox manager...' },
  { key: 'sign', label: 'Sign Payment', detail: 'Waiting for wallet signature...' },
  { key: 'confirm', label: 'Confirm', detail: 'Settling on-chain...' },
  { key: 'startup', label: 'Start Sandbox', detail: 'Waiting for sandbox to start...' },
];

function buildProgressOverlay(): {
  overlay: HTMLElement;
  setStep: (step: ProgressStep, statusText: string) => void;
  setError: (step: ProgressStep, errorText: string) => void;
  remove: () => void;
} {
  const overlay = el('div', { className: 'sandbox-deploy-progress' });
  const stepEls: Record<ProgressStep, { root: HTMLElement; detail: HTMLElement }> = {} as any;

  for (let i = 0; i < STEP_DEFS.length; i++) {
    const s = STEP_DEFS[i];
    const row = el('div', { className: 'sdp-step' });
    const num = el('div', { className: 'sdp-num' }, String(i + 1));
    const textWrap = el('div', { className: 'sdp-text' });
    const label = el('div', { className: 'sdp-label' }, s.label);
    const detail = el('div', { className: 'sdp-detail' }, s.detail);
    textWrap.appendChild(label);
    textWrap.appendChild(detail);
    row.appendChild(num);
    row.appendChild(textWrap);
    overlay.appendChild(row);
    stepEls[s.key] = { root: row, detail };
  }

  const stepOrder: ProgressStep[] = ['request', 'sign', 'confirm', 'startup'];

  function setStep(step: ProgressStep, text: string) {
    const idx = stepOrder.indexOf(step);
    for (let i = 0; i < stepOrder.length; i++) {
      const key = stepOrder[i];
      const { root, detail } = stepEls[key];
      root.classList.remove('active', 'done', 'error');
      if (i < idx) {
        root.classList.add('done');
        detail.textContent = 'Done';
      } else if (i === idx) {
        root.classList.add('active');
        detail.textContent = text;
      } else {
        detail.textContent = STEP_DEFS[i].detail;
      }
    }
  }

  function setError(step: ProgressStep, text: string) {
    const idx = stepOrder.indexOf(step);
    for (let i = 0; i < stepOrder.length; i++) {
      const key = stepOrder[i];
      const { root, detail } = stepEls[key];
      root.classList.remove('active', 'done', 'error');
      if (i < idx) {
        root.classList.add('done');
        detail.textContent = 'Done';
      } else if (i === idx) {
        root.classList.add('error');
        detail.textContent = text;
      }
    }
  }

  setStep('request', 'Initializing...');

  return { overlay, setStep, setError, remove: () => overlay.remove() };
}

// --- Helpers ---

function formatDuration(seconds: number): string {
  if (seconds < 0) return 'Expired';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function getStateBadgeStyle(state: string): string {
  switch (state) {
    case 'running': return 'background:#e6fafb;color:#00C7D2';
    case 'paused': return 'background:#fef3c7;color:#d97706';
    case 'provisioning': return 'background:#dbeafe;color:#2563eb';
    case 'error': case 'failed': return 'background:#fecaca;color:#dc2626';
    case 'destroying': case 'archived': case 'terminated': return 'background:#f3f4f6;color:#6b7280';
    default: return 'background:#f3f4f6;color:#6b7280';
  }
}

function getChainStatusStyle(chainStatus: string): string {
  switch (chainStatus) {
    case 'ACTIVE': return 'color:#00C7D2';
    case 'WARNING': return 'color:#d97706';
    case 'SUSPENDED': return 'color:#dc2626';
    case 'DEAD': return 'color:#6b7280';
    default: return 'color:#4D4D4D';
  }
}

export async function getOrPickWallet(): Promise<{ address: string; provider: any }> {
  const existing = await getConnectedAccount();
  if (existing) return existing;
  const address = await showWalletPicker();
  return { address, provider: getSelectedProvider() };
}

function getEventBadgeColor(eventType: string): string {
  switch (eventType) {
    case 'created': case 'provisioned': return '#00C7D2';
    case 'paused': case 'pause_requested': return '#d97706';
    case 'resumed': case 'resume_requested': return '#2563eb';
    case 'renewed': case 'renew_requested': return '#0891b2';
    case 'error': case 'destroy_requested': return '#dc2626';
    case 'destroyed': case 'archived': return '#6b7280';
    default: return '#94a3b8';
  }
}

function sandboxSummaryCard(label: string, value: string, options?: {
  accent?: string;
  mono?: boolean;
  large?: boolean;
}): HTMLElement {
  const card = el('div', { className: 'sandbox-summary-card' });
  card.appendChild(el('div', { className: 'sandbox-summary-label' }, label));
  card.appendChild(el('div', {
    className: `sandbox-summary-value${options?.large ? ' large' : ''}`,
    style: [
      options?.accent ? `color:${options.accent}` : '',
      options?.mono ? 'font-family:"SF Mono","Fira Code",monospace;font-size:12px' : '',
    ].filter(Boolean).join(';'),
    title: value,
  }, value));
  return card;
}

function buildSandboxHero(detail: AgentDetail): HTMLElement {
  const container = el('div');
  const grid = el('div', { className: 'sandbox-summary-grid' });

  const state = (lastSandboxState || 'unknown').toUpperCase();
  const stateColor = lastSandboxState === 'running' ? '#00C7D2'
    : lastSandboxState === 'paused' ? '#d97706'
    : lastSandboxState === 'provisioning' ? '#2563eb'
    : lastSandboxState === 'error' || lastSandboxState === 'failed' ? '#dc2626'
    : '#4D4D4D';
  grid.appendChild(sandboxSummaryCard('State', state, { accent: stateColor, large: true }));

  grid.appendChild(sandboxSummaryCard('Sandbox ID', detail.sandboxId || '-'));

  let gatewayValue = 'Not configured';
  if (detail.gatewayUrl) {
    try {
      gatewayValue = new URL(detail.gatewayUrl).host;
    } catch {
      gatewayValue = detail.gatewayUrl;
    }
  }
  grid.appendChild(sandboxSummaryCard('Gateway', gatewayValue, {
    accent: detail.gatewayUrl ? '#00C7D2' : '#94a3b8',
  }));

  const gooCoreStatus = (detail.gooCoreStatus || 'unknown').toUpperCase();
  const gooCoreColor = detail.gooCoreStatus === 'running' ? '#00C7D2'
    : detail.gooCoreStatus === 'installing' ? '#d97706'
    : '#94a3b8';
  const gooCoreCard = sandboxSummaryCard('goo-core', gooCoreStatus, { accent: gooCoreColor });
  grid.appendChild(gooCoreCard);
  // Async fetch version from sandbox
  if (detail.sandboxId && detail.agenterId) {
    api<{ goo_core: string; version?: string }>('GET', `/api/sandbox/${detail.agenterId}/goo-core-status`)
      .then(resp => {
        if (resp.version && resp.version !== 'unknown') {
          const valEl = gooCoreCard.querySelector('.sandbox-summary-value');
          if (valEl) valEl.textContent = `${gooCoreStatus} (v${resp.version})`;
        }
      })
      .catch(() => {});
  }

  const expiryValue = lastSandboxStatus?.endAt ? formatTime(lastSandboxStatus.endAt) : '-';
  grid.appendChild(sandboxSummaryCard('Expires', expiryValue));

  const chainValue = lastSandboxStatus?.chainStatus || '-';
  grid.appendChild(sandboxSummaryCard('Chain Status', chainValue, {
    accent: chainValue === 'ACTIVE' ? '#00C7D2'
      : chainValue === 'WARNING' ? '#d97706'
      : chainValue === 'SUSPENDED' ? '#dc2626'
      : '#4D4D4D',
  }));

  container.appendChild(grid);

  return container;
}

// --- Expiry banner ---

function buildExpiryBanner(endAt: string): HTMLElement {
  const banner = el('div', { className: 'sandbox-expiry-banner green' });

  const leftSide = el('div', { style: 'display:flex;align-items:center;gap:12px' });
  const labelEl = el('span', { style: 'font-size:12px;opacity:0.7' }, 'Sandbox Lifetime');
  const timeEl = el('span', { className: 'expiry-time' }, '-');
  const hintEl = el('span', { className: 'expiry-hint' });
  leftSide.appendChild(labelEl);
  leftSide.appendChild(timeEl);
  leftSide.appendChild(hintEl);

  const autoRenewLabel = el('span', {
    style: 'font-size:12px;opacity:0.7;white-space:nowrap',
  }, 'Auto-renew +1h');

  banner.appendChild(leftSide);
  banner.appendChild(autoRenewLabel);

  if (countdownTimer) clearInterval(countdownTimer);

  const updateBanner = () => {
    const remaining = Math.floor((new Date(endAt).getTime() - Date.now()) / 1000);
    if (remaining <= 0) {
      timeEl.textContent = 'EXPIRED';
      hintEl.textContent = 'Sandbox will be terminated';
      banner.className = 'sandbox-expiry-banner red';
      autoRenewLabel.style.display = 'none';
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    } else if (remaining < 300) {
      timeEl.textContent = formatDuration(remaining);
      hintEl.textContent = 'Expiring soon!';
      banner.className = 'sandbox-expiry-banner red';
    } else if (remaining < 900) {
      timeEl.textContent = formatDuration(remaining);
      hintEl.textContent = 'Consider renewing';
      banner.className = 'sandbox-expiry-banner yellow';
    } else {
      timeEl.textContent = formatDuration(remaining);
      hintEl.textContent = '';
      banner.className = 'sandbox-expiry-banner green';
    }
  };

  updateBanner();
  countdownTimer = setInterval(updateBanner, 1000);

  return banner;
}

// --- Info tab (card-style grid like e2b dashboard) ---

function buildInfoTab(detail: AgentDetail): HTMLElement {
  const container = el('div');

  const grid = el('div', { className: 'sandbox-info-grid' });

  const infoCard = (label: string, value: string, mono?: boolean) => {
    const card = el('div', { className: 'sandbox-info-card' });
    card.appendChild(el('div', { className: 'sandbox-info-label' }, label));
    const valEl = el('div', {
      className: 'sandbox-info-value',
      style: mono ? 'font-family:"SF Mono","Fira Code",monospace;font-size:12px' : '',
      title: value,
    }, value);
    card.appendChild(valEl);
    return card;
  };

  // State badge card
  const stateCard = el('div', { className: 'sandbox-info-card' });
  stateCard.appendChild(el('div', { className: 'sandbox-info-label' }, 'State'));
  const stateBadge = el('span', {
    style: `display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600;${getStateBadgeStyle(lastSandboxState || 'unknown')}`,
  }, (lastSandboxState || 'unknown').toUpperCase());
  stateCard.appendChild(stateBadge);
  grid.appendChild(stateCard);

  // Chain status card
  const chainStatus = lastSandboxStatus?.chainStatus || '-';
  const chainCard = el('div', { className: 'sandbox-info-card' });
  chainCard.appendChild(el('div', { className: 'sandbox-info-label' }, 'Chain Status'));
  chainCard.appendChild(el('div', {
    className: 'sandbox-info-value',
    style: `font-weight:600;${getChainStatusStyle(chainStatus)}`,
  }, chainStatus));
  grid.appendChild(chainCard);

  // Uptime
  const uptime = lastSandboxStatus?.uptimeSeconds != null
    ? formatDuration(lastSandboxStatus.uptimeSeconds) : '-';
  grid.appendChild(infoCard('Uptime', uptime));

  // Sandbox ID
  grid.appendChild(infoCard('Sandbox ID', detail.sandboxId || '-'));

  // Launch Time
  grid.appendChild(infoCard('Launch Time', lastSandboxStatus?.launchTime
    ? formatTime(lastSandboxStatus.launchTime) : '-'));

  // Expires At
  grid.appendChild(infoCard('Expires At', lastSandboxStatus?.endAt
    ? formatTime(lastSandboxStatus.endAt) : '-'));

  // Gateway (full width)
  if (detail.gatewayUrl) {
    const gwCard = el('div', { className: 'sandbox-info-card', style: 'grid-column:1/-1' });
    gwCard.appendChild(el('div', { className: 'sandbox-info-label' }, 'Gateway'));
    try {
      const gwLink = el('a', {
        href: detail.sandboxUrl || detail.gatewayUrl,
        target: '_blank',
        rel: 'noopener',
        style: 'color:#0081f2;font-size:13px;text-decoration:none',
      }, new URL(detail.gatewayUrl).host);
      gwCard.appendChild(gwLink);
    } catch {
      gwCard.appendChild(el('div', { className: 'sandbox-info-value' }, detail.gatewayUrl));
    }
    grid.appendChild(gwCard);
  }

  // Total paid (full width)
  if (lastSandboxStatus?.totalSettledUsd != null && lastSandboxStatus.totalSettledUsd > 0) {
    grid.appendChild(infoCard('Total Settled', `$${lastSandboxStatus.totalSettledUsd.toFixed(2)}`));
  }

  container.appendChild(grid);
  return container;
}

// --- Exec tab ---

function buildExecTab(agenterId: string, canManage: boolean): HTMLElement {
  const container = el('div');

  if (!canManage) {
    container.appendChild(el('div', { className: 'sandbox-notice warning' },
      'Only the owner can execute commands in this sandbox.'));
    return container;
  }

  if (lastSandboxState !== 'running') {
    container.appendChild(el('div', { className: 'sandbox-notice warning' },
      'Sandbox is not running. Cannot execute commands.'));
    return container;
  }

  const inputRow = el('div', { style: 'display:flex;gap:8px;margin-bottom:8px' });
  const input = document.createElement('input') as HTMLInputElement;
  input.className = 'sandbox-exec-input';
  input.placeholder = 'Enter command...';
  input.type = 'text';

  const runBtn = el('button', {
    style: 'padding:8px 16px;font-size:13px;font-weight:500;background:#00C7D2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:background .2s',
  }, 'Run') as HTMLButtonElement;

  inputRow.appendChild(input);
  inputRow.appendChild(runBtn);
  container.appendChild(inputRow);

  if (commandHistory.length > 0) {
    container.appendChild(el('div', { style: 'font-size:11px;color:#B2B2B2;margin-bottom:8px' },
      `Up/Down arrows for history (${commandHistory.length} commands)`));
  }

  const outputEl = el('pre', { className: 'sandbox-output' }, execOutput || 'Output will appear here...');
  container.appendChild(outputEl);

  const runCommand = async () => {
    const cmd = input.value.trim();
    if (!cmd) return;

    if (commandHistory[commandHistory.length - 1] !== cmd) {
      commandHistory.push(cmd);
    }
    historyIndex = -1;

    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    execOutput += `$ ${cmd}\n`;
    outputEl.textContent = execOutput;

    try {
      const resp = await api<ExecResponse>('POST', `/api/sandbox/${agenterId}/exec`, {
        command: cmd,
        timeoutMs: 30000,
      });
      if (resp.stdout) execOutput += resp.stdout;
      if (resp.stderr) execOutput += resp.stderr;
      if (!resp.stdout && !resp.stderr) execOutput += '(no output)\n';
      if (resp.exitCode != null && resp.exitCode !== 0) {
        execOutput += `[exit code: ${resp.exitCode}]\n`;
      }
    } catch (err: any) {
      execOutput += `Error: ${err.message ?? String(err)}\n`;
    }

    execOutput += '\n';
    outputEl.textContent = execOutput;
    outputEl.scrollTop = outputEl.scrollHeight;
    runBtn.disabled = false;
    runBtn.textContent = 'Run';
    input.value = '';
    input.focus();
  };

  runBtn.addEventListener('click', runCommand);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length === 0) return;
      if (historyIndex === -1) historyIndex = commandHistory.length;
      if (historyIndex > 0) {
        historyIndex--;
        input.value = commandHistory[historyIndex];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      if (historyIndex < commandHistory.length - 1) {
        historyIndex++;
        input.value = commandHistory[historyIndex];
      } else {
        historyIndex = -1;
        input.value = '';
      }
    }
  });

  return container;
}

// --- Logs tab ---

function buildLogsTab(agenterId: string): HTMLElement {
  const container = el('div');

  const toolbar = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px' });

  const leftInfo = el('span', { style: 'font-size:11px;color:#B2B2B2' }, `Sandbox: ${agenterId.slice(0, 16)}...`);

  const rightControls = el('div', { style: 'display:flex;align-items:center;gap:12px' });
  const autoRefreshLabel = el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;color:#4D4D4D;cursor:pointer' });
  const autoRefreshCheckbox = document.createElement('input') as HTMLInputElement;
  autoRefreshCheckbox.type = 'checkbox';
  autoRefreshCheckbox.checked = logsAutoRefresh;
  autoRefreshLabel.appendChild(autoRefreshCheckbox);
  autoRefreshLabel.appendChild(document.createTextNode('Auto-refresh (5s)'));

  const refreshBtn = el('button', {
    style: 'padding:4px 12px;font-size:12px;font-weight:500;background:#f0f0ef;border:1px solid #ebebeb;border-radius:6px;color:#4D4D4D;cursor:pointer;font-family:inherit;transition:background .2s',
  }, 'Refresh') as HTMLButtonElement;

  rightControls.appendChild(autoRefreshLabel);
  rightControls.appendChild(refreshBtn);
  toolbar.appendChild(leftInfo);
  toolbar.appendChild(rightControls);
  container.appendChild(toolbar);

  // Warning if not running
  if (lastSandboxState !== 'running') {
    container.appendChild(el('div', { className: 'sandbox-notice warning' },
      'Sandbox is not running. Logs may be unavailable or stale.'));
  }

  const outputEl = el('pre', { className: 'sandbox-output' }, logsContent || 'Loading logs...');
  container.appendChild(outputEl);

  const fetchLogs = async () => {
    try {
      const resp = await api<SandboxLogsResponse>('GET', `/api/sandbox/${agenterId}/logs`);
      if (resp.logs && resp.logs.length > 0) {
        logsContent = resp.logs.map(l => `[${l.stream}] ${l.message}`).join('\n');
      } else {
        logsContent = '(no logs available)';
      }
    } catch (err: any) {
      logsContent = `Error loading logs: ${err.message ?? String(err)}`;
    }
    outputEl.textContent = logsContent;
    outputEl.scrollTop = outputEl.scrollHeight;
  };

  refreshBtn.addEventListener('click', fetchLogs);

  const setupAutoRefresh = () => {
    if (logsInterval) { clearInterval(logsInterval); logsInterval = null; }
    if (logsAutoRefresh) {
      logsInterval = setInterval(fetchLogs, 5000);
    }
  };

  autoRefreshCheckbox.addEventListener('change', () => {
    logsAutoRefresh = autoRefreshCheckbox.checked;
    setupAutoRefresh();
  });

  fetchLogs();
  setupAutoRefresh();

  return container;
}

// --- Events tab ---

function buildEventsTab(agenterId: string): HTMLElement {
  const container = el('div');

  const headerRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px' });
  const countEl = el('span', { style: 'font-size:12px;color:#B2B2B2' }, 'Loading...');
  const refreshBtn = el('button', {
    style: 'padding:4px 12px;font-size:12px;font-weight:500;background:#f0f0ef;border:1px solid #ebebeb;border-radius:6px;color:#4D4D4D;cursor:pointer;font-family:inherit;transition:background .2s',
  }, 'Refresh') as HTMLButtonElement;
  headerRow.appendChild(countEl);
  headerRow.appendChild(refreshBtn);
  container.appendChild(headerRow);

  const eventsContainer = el('div');
  container.appendChild(eventsContainer);

  const loadEvents = async () => {
    countEl.textContent = 'Loading...';
    clearChildren(eventsContainer);
    try {
      const resp = await api<SandboxEventsResponse>('GET', `/api/sandbox/${agenterId}/events`);

      if (!resp.events || resp.events.length === 0) {
        countEl.textContent = 'No events';
        eventsContainer.appendChild(el('div', { style: 'font-size:13px;color:#B2B2B2;text-align:center;padding:24px' }, 'No sandbox events yet.'));
        return;
      }

      countEl.textContent = `Showing ${resp.events.length} of ${resp.total} events`;

      for (const ev of resp.events) {
        const row = el('div', { className: 'sandbox-event-card' });

        const topRow = el('div', { style: 'display:flex;align-items:center;gap:8px' });
        topRow.appendChild(el('span', { style: 'font-size:11px;color:#B2B2B2;white-space:nowrap' }, formatTime(ev.created_at)));
        topRow.appendChild(el('span', {
          className: 'sandbox-event-badge',
          style: `background:${getEventBadgeColor(ev.event_type)}`,
        }, ev.event_type));
        row.appendChild(topRow);

        if (ev.detail) {
          const detailEl = el('div', {
            style: 'font-size:12px;color:#4D4D4D;margin-top:4px;font-family:"SF Mono","Fira Code",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
            title: ev.detail,
          }, ev.detail);
          row.appendChild(detailEl);
        }

        eventsContainer.appendChild(row);
      }
    } catch (err: any) {
      clearChildren(eventsContainer);
      eventsContainer.appendChild(el('div', { style: 'font-size:13px;color:#e05050;padding:8px' }, `Error: ${err.message ?? String(err)}`));
    }
  };

  refreshBtn.addEventListener('click', loadEvents);
  loadEvents();
  return container;
}



// --- Poll sandbox status until running ---

function pollUntilRunning(
  agenterId: string,
  progress: ReturnType<typeof buildProgressOverlay>,
  onRunning: () => void,
  onError: (msg: string) => void,
): void {
  if (startupPollTimer) clearInterval(startupPollTimer);

  let elapsed = 0;
  const POLL_MS = 3000;
  const MAX_MS = 180_000; // 3 min timeout

  const poll = async () => {
    elapsed += POLL_MS;
    if (elapsed > MAX_MS) {
      if (startupPollTimer) { clearInterval(startupPollTimer); startupPollTimer = null; }
      progress.setError('startup', 'Timed out waiting for sandbox to start');
      onError('Sandbox startup timed out after 3 minutes');
      return;
    }

    try {
      const resp = await api<SandboxStatusResponse>('GET', `/api/sandbox/${agenterId}/status`);
      if (!resp.has_sandbox) {
        progress.setStep('startup', 'Waiting for provisioning...');
        return;
      }

      const state = (resp.state || '').toLowerCase();
      lastSandboxState = state;
      lastSandboxStatus = resp;

      if (state === 'running') {
        if (startupPollTimer) { clearInterval(startupPollTimer); startupPollTimer = null; }
        progress.setStep('startup', 'Sandbox is running!');
        // Brief delay to show the success state
        setTimeout(() => onRunning(), 600);
        return;
      }

      if (['error', 'failed', 'terminated', 'archived'].includes(state)) {
        if (startupPollTimer) { clearInterval(startupPollTimer); startupPollTimer = null; }
        const detail = resp.lastError ? ` ${resp.lastError}` : '';
        progress.setError('startup', `Sandbox ${state}${detail}`);
        onError(resp.lastError || `Sandbox failed to start (${state})`);
        return;
      }

      // Still provisioning
      const secs = Math.floor(elapsed / 1000);
      progress.setStep('startup', `Sandbox is ${state}... (${secs}s)`);
    } catch {
      // Network error — keep polling
      progress.setStep('startup', `Checking status... (${Math.floor(elapsed / 1000)}s)`);
    }
  };

  // First poll immediately
  poll();
  startupPollTimer = setInterval(poll, POLL_MS);
}

// --- Render tabs into a container ---

function renderTabs(
  card: HTMLElement,
  detail: AgentDetail,
  options: { canManage: boolean },
): void {
  // Expiry banner
  if (lastSandboxStatus?.endAt) {
    card.appendChild(buildExpiryBanner(lastSandboxStatus.endAt));
  }

  card.appendChild(buildSandboxHero(detail));

  // Action buttons
  const btnRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px' });
  const resultContainer = el('div');

  const pauseBtn = el('button', {
    className: 'sandbox-action-btn yellow',
    style: `display:${lastSandboxState === 'running' ? '' : 'none'}`,
  }, 'Pause') as HTMLButtonElement;
  const resumeBtn = el('button', {
    className: 'sandbox-action-btn green',
    style: `display:${lastSandboxState === 'paused' ? '' : 'none'}`,
  }, 'Resume') as HTMLButtonElement;
  const destroyBtn = el('button', { className: 'sandbox-action-btn red' }, 'Destroy') as HTMLButtonElement;
  const refreshBtn = el('button', { className: 'sandbox-action-btn neutral' }, 'Refresh') as HTMLButtonElement;

  btnRow.appendChild(refreshBtn);
  if (options.canManage) {
    btnRow.appendChild(pauseBtn);
    btnRow.appendChild(resumeBtn);
    btnRow.appendChild(destroyBtn);
  }
  card.appendChild(btnRow);
  card.appendChild(resultContainer);

  if (options.canManage) {
    pauseBtn.addEventListener('click', async () => {
      pauseBtn.disabled = true;
      pauseBtn.textContent = 'Pausing...';
      clearChildren(resultContainer);
      try {
        await api<Record<string, unknown>>('POST', `/api/sandbox/${detail.agenterId}/pause`);
        resultContainer.appendChild(el('div', { className: 'trigger-result success' }, 'Sandbox paused.'));
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = '';
      } catch (err) {
        resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
      }
      pauseBtn.disabled = false;
      pauseBtn.textContent = 'Pause';
    });

    resumeBtn.addEventListener('click', async () => {
      resumeBtn.disabled = true;
      resumeBtn.textContent = 'Resuming...';
      clearChildren(resultContainer);
      try {
        await api<Record<string, unknown>>('POST', `/api/sandbox/${detail.agenterId}/resume`);
        resultContainer.appendChild(el('div', { className: 'trigger-result success' }, 'Sandbox resumed.'));
        resumeBtn.style.display = 'none';
        pauseBtn.style.display = '';
        dispatchAgentRefresh(detail.id, 1500);
      } catch (err) {
        resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
      }
      resumeBtn.disabled = false;
      resumeBtn.textContent = 'Resume';
    });

    destroyBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to destroy this sandbox? This cannot be undone.')) return;
      destroyBtn.disabled = true;
      destroyBtn.textContent = 'Destroying...';
      clearChildren(resultContainer);
      try {
        await api<Record<string, unknown>>('DELETE', `/api/sandbox/${detail.agenterId}`);
        resultContainer.appendChild(el('div', { className: 'trigger-result success' }, 'Sandbox destruction initiated.'));
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        if (logsInterval) { clearInterval(logsInterval); logsInterval = null; }
        dispatchAgentRefresh(detail.id, 2000);
      } catch (err) {
        resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
        destroyBtn.disabled = false;
        destroyBtn.textContent = 'Destroy';
      }
    });
  }

  refreshBtn.addEventListener('click', () => dispatchAgentRefresh(detail.id, 0));

  // --- Quick Actions (exec commands in sandbox) ---
  if (options.canManage && lastSandboxState === 'running') {
    const qaRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' });
    const qaResult = el('div', { style: 'margin-bottom:8px' });

    const makeQaBtn = (label: string, color: string, command: string, timeoutMs: number, confirmMsg?: string) => {
      const btn = el('button', {
        className: 'sandbox-action-btn',
        style: `background:${color};color:#fff;border-color:${color}`,
      }, label) as HTMLButtonElement;
      btn.addEventListener('click', async () => {
        if (confirmMsg && !confirm(confirmMsg)) return;
        btn.disabled = true;
        const orig = btn.textContent!;
        btn.textContent = 'Running...';
        clearChildren(qaResult);
        try {
          const resp = await api<ExecResponse>('POST', `/api/sandbox/${detail.agenterId}/exec`, {
            command,
            timeoutMs,
          });
          const out = (resp.stdout || '').trim();
          const err = (resp.stderr || '').trim();
          const display = out || err || `exit ${resp.exitCode}`;
          qaResult.appendChild(el('pre', {
            style: 'margin:0;padding:8px 12px;background:#f8f8f7;border:1px solid #ebebeb;border-radius:8px;font-size:11px;color:#000;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow:auto',
          }, display));
        } catch (e) {
          qaResult.appendChild(el('div', { className: 'trigger-result error' }, (e as Error).message ?? String(e)));
        }
        btn.disabled = false;
        btn.textContent = orig;
      });
      return btn;
    };

    qaRow.appendChild(makeQaBtn(
      'Upgrade goo-core',
      '#7c3aed',
      'npm cache clean --force 2>&1 && npm install -g @devbond/gc@latest --prefer-online --fetch-retries=0 2>&1 | tail -5 && cat /usr/lib/node_modules/@devbond/gc/package.json | grep version',
      60000,
    ));
    qaRow.appendChild(makeQaBtn(
      'Restart goo-core',
      '#0081f2',
      'pids=$(pgrep -f "goo-core/dist" 2>/dev/null); [ -n "$pids" ] && kill $pids 2>/dev/null; sleep 1; npm cache clean --force 2>&1 >/dev/null; npm install -g @devbond/gc@latest --prefer-online --fetch-retries=0 2>&1 | tail -3; (set -a; source /home/user/.goo-core/.env 2>/dev/null || source /home/user/goo-core/.env 2>/dev/null; set +a; nohup goo-core >> /var/log/sandbox/goo-core.log 2>&1 &); echo "goo-core upgraded & restart initiated"',
      60000,
    ));
    // Shared env-loading preamble for inline Node scripts
    const envPreamble = `import{JsonRpcProvider,Wallet,Contract,parseEther,formatEther,MaxUint256}from"/usr/lib/node_modules/@devbond/gc/node_modules/ethers/lib.esm/ethers.js";
import{readFileSync,appendFileSync}from"fs";
const env=Object.fromEntries(readFileSync("/home/user/.goo-core/.env","utf8").split("\\n").filter(l=>l&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i),l.slice(i+1)]}));
const p=new JsonRpcProvider(env.RPC_URL);const w=new Wallet(env.WALLET_PRIVATE_KEY,p);
const LOG="/var/log/sandbox/goo-core.log";
function evt(type,sev,msg,data){const j=JSON.stringify({goo_event:true,ts:new Date().toISOString(),type,severity:sev,message:msg,...(data?{data}:{})});console.log(j);try{appendFileSync(LOG,j+"\\n")}catch{}}`;

    // Gas Refill: withdrawToWallet(0.001 BNB) from treasury
    qaRow.appendChild(makeQaBtn(
      'Gas Refill',
      '#f59e0b',
      `node --input-type=module -e '${envPreamble}
const bal=await p.getBalance(w.address);
console.log("Wallet BNB:",formatEther(bal));
const c=new Contract(env.TOKEN_ADDRESS,["function withdrawToWallet(uint256)","function treasuryBalance() view returns(uint256)"],w);
const tb=await c.treasuryBalance();
console.log("Treasury BNB:",formatEther(tb));
const amt=parseEther("0.001");
if(tb<amt){console.log("Treasury too low for 0.001 BNB refill");process.exit(0)}
const tx=await c.withdrawToWallet(amt);
const r=await tx.wait();
evt("gas_refill_ok","info","Manual gas refill: withdrew 0.001 BNB from treasury",{txHash:r.hash});
console.log("Gas refill OK: withdrew 0.001 BNB, tx:",r.hash);
'`,
      30000,
      'Withdraw 0.001 BNB from treasury to agent wallet?',
    ));
    // Buyback: swap 0.005 BNB → AgentToken via router
    qaRow.appendChild(makeQaBtn(
      'Buyback',
      '#00C7D2',
      `node --input-type=module -e '${envPreamble}
const bal=await p.getBalance(w.address);
console.log("Wallet BNB:",formatEther(bal));
const token=new Contract(env.TOKEN_ADDRESS,["function ROUTER() view returns(address)","function balanceOf(address) view returns(uint256)"],p);
const routerAddr=await token.ROUTER();
const router=new Contract(routerAddr,["function swapExactETHForTokensSupportingFeeOnTransferTokens(uint,address[],address,uint) payable","function WETH() view returns(address)","function getAmountsOut(uint,address[]) view returns(uint[])"],w);
const weth=await router.WETH();
const amt=parseEther("0.001");
if(bal<amt*2n){console.log("Insufficient BNB (need 0.002, have",formatEther(bal)+")");process.exit(0)}
const amts=await router.getAmountsOut(amt,[weth,env.TOKEN_ADDRESS]);const minOut=amts[1]*95n/100n;
const before=await token.balanceOf(w.address);
const deadline=Math.floor(Date.now()/1000)+300;
const tx=await router.swapExactETHForTokensSupportingFeeOnTransferTokens(minOut,[weth,env.TOKEN_ADDRESS],w.address,deadline,{value:amt});
const r=await tx.wait();
const after=await token.balanceOf(w.address);
const got=after-before;
evt("buyback_ok","info","Manual buyback: 0.001 BNB → "+formatEther(got)+" tokens",{txHash:r.hash,amountBnb:"0.001",amountTokens:formatEther(got)});
console.log("Buyback OK: 0.001 BNB →",formatEther(got),"tokens, tx:",r.hash);
'`,
      30000,
      'Swap 0.001 BNB for agent tokens (buyback)?',
    ));
    // Swap BNB→USDT: swap 0.005 BNB to USDT for x402 payments
    qaRow.appendChild(makeQaBtn(
      'Swap BNB→USDT',
      '#0081f2',
      `node --input-type=module -e '${envPreamble}
const bal=await p.getBalance(w.address);
console.log("Wallet BNB:",formatEther(bal));
if(!env.X402_PAYMENT_TOKEN){console.log("X402_PAYMENT_TOKEN not set in .env");process.exit(1)}
const token=new Contract(env.TOKEN_ADDRESS,["function ROUTER() view returns(address)"],p);
const routerAddr=await token.ROUTER();
const router=new Contract(routerAddr,["function swapExactETHForTokens(uint,address[],address,uint) payable returns(uint[])","function WETH() view returns(address)","function getAmountsOut(uint,address[]) view returns(uint[])"],w);
const weth=await router.WETH();
const amt=parseEther("0.001");
if(bal<amt*2n){console.log("Insufficient BNB (need 0.002, have",formatEther(bal)+")");process.exit(0)}
const amts=await router.getAmountsOut(amt,[weth,env.X402_PAYMENT_TOKEN]);const minOut=amts[1]*99n/100n;
const usdt=new Contract(env.X402_PAYMENT_TOKEN,["function balanceOf(address) view returns(uint256)","function decimals() view returns(uint8)"],p);
const decm=Number(await usdt.decimals());
const before=await usdt.balanceOf(w.address);
const deadline=Math.floor(Date.now()/1000)+300;
const tx=await router.swapExactETHForTokens(minOut,[weth,env.X402_PAYMENT_TOKEN],w.address,deadline,{value:amt});
const r=await tx.wait();
const after=await usdt.balanceOf(w.address);
const got=after-before;
const gotFmt=(Number(got)/10**decm).toFixed(2);
evt("payment_token_refill_ok","info","Manual swap: 0.001 BNB → "+gotFmt+" USDT",{swapTxHash:r.hash});
console.log("Swap OK: 0.001 BNB →",gotFmt,"USDT, tx:",r.hash);
'`,
      30000,
      'Swap 0.005 BNB for USDT (payment token)?',
    ));

    card.appendChild(qaRow);
    card.appendChild(qaResult);
  }

  // --- Tab bar ---
  const tabBar = el('div', { className: 'sandbox-tab-bar' });
  const tabContent = el('div');

  const tabs: { key: typeof activeTab; label: string }[] = [
    { key: 'info', label: 'Info' },
    { key: 'exec', label: 'Exec' },
    { key: 'logs', label: 'Logs' },
    { key: 'events', label: 'Events' },
  ];

  if (!tabs.find(t => t.key === activeTab)) {
    activeTab = 'info';
  }

  const switchTab = (key: typeof activeTab) => {
    activeTab = key;
    tabBar.querySelectorAll('.sandbox-tab-btn').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === key);
    });
    clearChildren(tabContent);
    if (logsInterval) { clearInterval(logsInterval); logsInterval = null; }
    if (key === 'info') {
      tabContent.appendChild(buildInfoTab(detail));
    } else if (key === 'exec') {
      tabContent.appendChild(buildExecTab(detail.agenterId, options.canManage));
    } else if (key === 'logs') {
      tabContent.appendChild(buildLogsTab(detail.agenterId));
    } else if (key === 'events') {
      tabContent.appendChild(buildEventsTab(detail.agenterId));
    }
  };

  for (const tab of tabs) {
    const btn = el('button', {
      className: `sandbox-tab-btn${tab.key === activeTab ? ' active' : ''}`,
    }, tab.label) as HTMLButtonElement;
    btn.setAttribute('data-tab', tab.key);
    btn.addEventListener('click', () => switchTab(tab.key));
    tabBar.appendChild(btn);
  }

  card.appendChild(tabBar);
  card.appendChild(tabContent);

  switchTab(activeTab);
}

// --- App config helpers (delegates to shared app-config module) ---

async function getAppChainId(): Promise<number> {
  const cfg = await getAppConfig();
  return cfg.chain_id;
}

export async function getAgosMinInitialFund(): Promise<number> {
  const cfg = await getAppConfig();
  const v = cfg.agos_effective_min_initial_fund;
  return Number.isFinite(v) && v > 0 ? v : 10;
}

// --- BSC chain switching helpers ---

export async function switchToBscMainnet(provider: any): Promise<void> {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
  } catch (switchErr: any) {
    if (switchErr.code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0x38',
          chainName: 'BNB Smart Chain',
          nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
          rpcUrls: ['https://bsc-dataseed.binance.org/'],
          blockExplorerUrls: ['https://bscscan.com'],
        }],
      });
    } else {
      throw switchErr;
    }
  }
}

export async function switchBackToAppChain(provider: any): Promise<void> {
  try {
    const appChainId = await getAppChainId();
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + appChainId.toString(16) }] });
  } catch { /* best-effort */ }
}

async function waitForTxReceipt(provider: any, txHash: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
    if (receipt) return;
    await new Promise(r => setTimeout(r, 2000));
  }
}

// --- AGOS EIP-3009 funding flow ---

export async function fundAgosAgent(
  agenterId: string,
  amount: string,
  provider: any,
  address: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  onProgress?.('Preparing AIOU transfer...');

  // 1. Call prepare-transfer to get EIP-712 typed data
  const prepared = await api<{
    ok: true;
    data: {
      needsPayment: boolean;
      typedData?: { domain: any; types: any; primaryType: string; message: any };
      settleTemplate?: any;
      summary?: any;
    };
  }>('POST', `/api/agos/agents/${agenterId}/fund/prepare-transfer`, {
    amount,
    payer_address: address,
  });

  if (!prepared.data.needsPayment) {
    onProgress?.('No payment needed — already funded.');
    return;
  }

  if (!prepared.data.typedData || !prepared.data.settleTemplate) {
    throw new Error('Server returned incomplete funding data');
  }

  // 2. Switch to BSC mainnet for signing (AIOU is on mainnet)
  onProgress?.('Switching to BSC mainnet for AIOU transfer...');
  await switchToBscMainnet(provider);

  // Use try/finally to always restore the app chain, even if signing fails
  let signature: string;
  try {
    // 3. Sign EIP-712 typed data
    onProgress?.(`Sign AIOU transfer of ${amount} AIOU...`);
    signature = await provider.request({
      method: 'eth_signTypedData_v4',
      params: [address, JSON.stringify(prepared.data.typedData)],
    }) as string;
  } finally {
    // 4. Switch back to app chain
    await switchBackToAppChain(provider);
  }

  // 5. Settle
  onProgress?.('Settling AIOU transfer...');
  await api('POST', `/api/agos/agents/${agenterId}/fund/settle-transfer`, {
    signature,
    settle_template: prepared.data.settleTemplate,
  });

  onProgress?.('Funding complete!');
}

// --- VPS Provision modal ---

interface ProvisionData {
  mode?: 'auto' | 'manual';
  script: string;
  ssh_command: string;
  gateway_url: string;
  healthcheck_url: string;
  public_ip: string;
  has_password: boolean;
  docker_image: string;
}

// --- Auto-provision progress UI ---

type AutoProvisionStep = 'connecting' | 'pulling' | 'starting' | 'health_check' | 'live';

const AUTO_PROVISION_STEPS: { key: AutoProvisionStep; label: string; icon: string }[] = [
  { key: 'connecting', label: 'Connecting to VPS', icon: '1' },
  { key: 'pulling', label: 'Pulling Docker Image', icon: '2' },
  { key: 'starting', label: 'Starting Container', icon: '3' },
  { key: 'health_check', label: 'Verifying Health', icon: '4' },
  { key: 'live', label: 'Agent is Live', icon: '5' },
];

function showAutoProvisionProgress(
  container: HTMLElement,
  data: ProvisionData,
  detail: AgentDetail,
): void {
  clearChildren(container);

  const wrapper = el('div', { style: 'margin-top:12px;padding:16px;background:#f0fdf4;border:1px solid #86efac;border-radius:12px' });
  wrapper.appendChild(el('div', { style: 'font-size:14px;font-weight:600;color:#166534;margin-bottom:8px' },
    'Auto-Provisioning VPS'));
  wrapper.appendChild(el('div', { style: 'font-size:12px;color:#78716c;margin-bottom:12px' },
    `Setting up Docker on ${data.public_ip}...`));

  // Progress steps
  const stepsContainer = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px' });
  const stepEls: Record<AutoProvisionStep, HTMLElement> = {} as any;
  const stepDotEls: Record<AutoProvisionStep, HTMLElement> = {} as any;

  for (const s of AUTO_PROVISION_STEPS) {
    const row = el('div', { style: 'display:flex;align-items:center;gap:8px' });
    const dot = el('div', {
      style: 'width:24px;height:24px;border-radius:50%;background:#e5e7eb;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#6b7280;flex-shrink:0',
    }, s.icon);
    const label = el('div', { style: 'font-size:12px;color:#6b7280' }, s.label);
    row.appendChild(dot);
    row.appendChild(label);
    stepsContainer.appendChild(row);
    stepEls[s.key] = label;
    stepDotEls[s.key] = dot;
  }
  wrapper.appendChild(stepsContainer);

  // Status text
  const statusText = el('div', { style: 'font-size:11px;color:#78716c;margin-bottom:8px' }, 'Connecting...');
  wrapper.appendChild(statusText);

  container.appendChild(wrapper);

  // Track current step
  const stepOrder: AutoProvisionStep[] = AUTO_PROVISION_STEPS.map(s => s.key);

  function updateStep(step: AutoProvisionStep, message?: string) {
    const idx = stepOrder.indexOf(step);
    for (let i = 0; i < stepOrder.length; i++) {
      const key = stepOrder[i];
      if (i < idx) {
        stepDotEls[key].style.background = '#22c55e';
        stepDotEls[key].style.color = '#fff';
        stepDotEls[key].textContent = '\u2713';
        stepEls[key].style.color = '#166534';
      } else if (i === idx) {
        stepDotEls[key].style.background = '#3b82f6';
        stepDotEls[key].style.color = '#fff';
        stepEls[key].style.color = '#1e40af';
        stepEls[key].style.fontWeight = '600';
      }
    }
    if (message) statusText.textContent = message;
  }

  // Set initial state
  updateStep('connecting', 'Connecting to VPS...');

  // Listen for provision_step events via WebSocket
  const token = (window as any).__goo_token || localStorage.getItem('token');
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const apiBase = (import.meta as any).env?.VITE_API_URL || '';
  let wsUrl: string;
  if (apiBase) {
    const u = new URL(apiBase);
    wsUrl = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/api/agents/${detail.agenterId}/ws?token=${encodeURIComponent(token || '')}`;
  } else {
    wsUrl = `${wsProto}//${location.host}/api/agents/${detail.agenterId}/ws?token=${encodeURIComponent(token || '')}`;
  }

  let ws: WebSocket | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  function cleanup() {
    done = true;
    if (ws) { ws.close(); ws = null; }
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  }

  function showFallback(errorMsg?: string) {
    cleanup();
    if (errorMsg) {
      statusText.textContent = errorMsg;
      statusText.style.color = '#dc2626';
    }
    // Show manual fallback button
    const fallbackRow = el('div', { style: 'display:flex;gap:8px;margin-top:8px' });
    const manualBtn = el('button', {
      className: 'btn-trigger',
      style: 'background:#b45309;font-size:12px;padding:6px 12px',
    }, 'Show Manual Script') as HTMLButtonElement;
    manualBtn.addEventListener('click', () => {
      showProvisionModal(container, data, detail);
    });
    fallbackRow.appendChild(manualBtn);

    const retryBtn = el('button', {
      className: 'btn-trigger',
      style: 'background:#3b82f6;font-size:12px;padding:6px 12px',
    }, 'Retry') as HTMLButtonElement;
    retryBtn.addEventListener('click', () => {
      dispatchAgentRefresh(detail.id, 0);
    });
    fallbackRow.appendChild(retryBtn);
    wrapper.appendChild(fallbackRow);
  }

  // Timeout fallback: 3 minutes
  fallbackTimer = setTimeout(() => {
    if (!done) showFallback('Auto-provision timed out.');
  }, 180_000);

  try {
    ws = new WebSocket(wsUrl);

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        const rawStep = event.provision_step as string | undefined;
        if (!rawStep) return;

        if (rawStep === 'error') {
          showFallback(event.display_text || 'Provision failed');
          return;
        }

        const step = rawStep as AutoProvisionStep;
        if (stepOrder.includes(step)) {
          updateStep(step, event.display_text);

          if (step === 'live') {
            cleanup();
            statusText.style.color = '#166534';
            statusText.style.fontWeight = '600';
            setTimeout(() => dispatchAgentRefresh(detail.id, 0), 2000);
          }
        }
      } catch { /* ignore */ }
    };

    ws.onerror = () => {
      // WS failed — fall back to polling
      if (!done) startPolling();
    };

    ws.onclose = () => {
      // If not done, try polling
      if (!done) startPolling();
    };
  } catch {
    startPolling();
  }

  function startPolling() {
    if (done) return;
    ws = null;
    const poll = async () => {
      if (done) return;
      try {
        const health = await api<{ ok: boolean; error?: string }>('GET', `/api/agos/agents/${detail.agenterId}/provision/health`);
        if (health.ok) {
          updateStep('live', 'Agent is live!');
          cleanup();
          statusText.style.color = '#166534';
          statusText.style.fontWeight = '600';
          setTimeout(() => dispatchAgentRefresh(detail.id, 0), 2000);
          return;
        }
      } catch { /* continue polling */ }
      if (!done) setTimeout(poll, 10_000);
    };
    setTimeout(poll, 5_000);
  }
}

function showProvisionModal(
  container: HTMLElement,
  data: ProvisionData,
  detail: AgentDetail,
): void {
  clearChildren(container);

  const wrapper = el('div', { style: 'margin-top:12px;padding:16px;background:#fffbeb;border:1px solid #fbbf24;border-radius:12px' });

  wrapper.appendChild(el('div', { style: 'font-size:14px;font-weight:600;color:#92400e;margin-bottom:8px' },
    'VPS Provisioning Required'));
  wrapper.appendChild(el('div', { style: 'font-size:12px;color:#78716c;margin-bottom:12px' },
    `Your AGOS VPS (${data.public_ip}) is running but needs the Docker image deployed. ` +
    'Copy the script below and run it via SSH on the VPS.'));

  // SSH command
  const sshRow = el('div', { style: 'margin-bottom:8px' });
  sshRow.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:#92400e;margin-bottom:4px' }, 'SSH Command:'));
  const sshCode = el('code', {
    style: 'display:block;padding:8px;background:#1e1e1e;color:#d4d4d4;border-radius:6px;font-size:11px;word-break:break-all;cursor:pointer',
    title: 'Click to copy',
  }, data.ssh_command);
  sshCode.addEventListener('click', () => {
    navigator.clipboard.writeText(data.ssh_command).catch(() => {});
    showToast('SSH command copied', 'success');
  });
  sshRow.appendChild(sshCode);
  wrapper.appendChild(sshRow);

  // Setup script
  const scriptRow = el('div', { style: 'margin-bottom:12px' });
  scriptRow.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:#92400e;margin-bottom:4px' }, 'Setup Script:'));
  const scriptPre = el('pre', {
    style: 'max-height:200px;overflow:auto;padding:8px;background:#1e1e1e;color:#d4d4d4;border-radius:6px;font-size:10px;margin:0;white-space:pre-wrap;word-break:break-all;cursor:pointer',
    title: 'Click to copy',
  }, data.script);
  scriptPre.addEventListener('click', () => {
    navigator.clipboard.writeText(data.script).catch(() => {});
    showToast('Setup script copied', 'success');
  });
  scriptRow.appendChild(scriptPre);
  wrapper.appendChild(scriptRow);

  // Action buttons
  const btnRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });

  const copyBtn = el('button', {
    className: 'btn-trigger',
    style: 'background:#b45309;font-size:12px;padding:6px 12px',
  }, 'Copy Script') as HTMLButtonElement;
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(data.script).catch(() => {});
    showToast('Setup script copied to clipboard', 'success');
  });
  btnRow.appendChild(copyBtn);

  const verifyBtn = el('button', {
    className: 'btn-trigger',
    style: 'background:#22c55e;font-size:12px;padding:6px 12px',
  }, 'Verify Connection') as HTMLButtonElement;
  verifyBtn.addEventListener('click', async () => {
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Checking...';
    try {
      const health = await api<{ ok: boolean; error?: string }>('GET', `/api/agos/agents/${detail.agenterId}/provision/health`);
      if (health.ok) {
        showToast('VPS is running and healthy!', 'success');
        dispatchAgentRefresh(detail.id, 0);
      } else {
        showToast(`Not ready: ${health.error || 'healthcheck failed'}`, 'error');
      }
    } catch (err: any) {
      showToast(err.message || 'Health check failed', 'error');
    }
    verifyBtn.disabled = false;
    verifyBtn.textContent = 'Verify Connection';
  });
  btnRow.appendChild(verifyBtn);

  const doneBtn = el('button', {
    className: 'btn-trigger',
    style: 'background:#6b7280;font-size:12px;padding:6px 12px',
  }, 'Done') as HTMLButtonElement;
  doneBtn.addEventListener('click', () => {
    dispatchAgentRefresh(detail.id, 0);
  });
  btnRow.appendChild(doneBtn);

  wrapper.appendChild(btnRow);
  container.appendChild(wrapper);
}

// --- AGOS deployment status panel ---

interface AgosBalanceObj {
  availableBalance: string;
  frozenBalance: string;
  spentTotal: string;
}

interface AgosStatusData {
  agos_status: string;
  agos_endpoint?: string;
  deployment?: { status?: string; id?: string } | null;
  aiou_balance?: AgosBalanceObj | string | null;
}

function formatAiou(value: string | null | undefined): string {
  if (!value) return '0';
  const n = parseFloat(value);
  if (isNaN(n)) return '0';
  if (n === 0) return '0';
  return n < 0.01 ? n.toFixed(6) : n.toFixed(2);
}

function formatAiouBalance(bal: AgosBalanceObj | string | null | undefined): string {
  if (!bal) return '0';
  if (typeof bal === 'string') return formatAiou(bal);
  return formatAiou(bal.availableBalance);
}

function tooltipLabel(text: string, tip: string): HTMLElement {
  const wrapper = el('span', { style: 'display:flex;align-items:center;gap:4px;color:#B2B2B2' });
  wrapper.appendChild(document.createTextNode(text));
  const q = el('span', {
    style: 'display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#e5e7eb;color:#64748b;font-size:9px;font-weight:700;cursor:help;flex-shrink:0',
    title: tip,
  }, '?');
  wrapper.appendChild(q);
  return wrapper;
}

const STATUS_TOOLTIP = 'pending_fund → active → stopped\n\npending_fund: Waiting for AIOU funding before deployment\nactive: Running & fully operational\nstopped: Manually stopped by owner\nprovisioning: Server is being provisioned\ninstalling: Software is being installed';
const BALANCE_TOOLTIP = 'Available: spendable balance for compute\nFrozen: reserved for active deployment\nSpent: total consumed so far\n\nAIOU (BSC Mainnet): 0xF6138EE4174e85017bD43989CaAF8bC2D39aa733';

const DEPLOYING_STATUSES = new Set(['pending', 'provisioning', 'installing']);
let agosDeployPollTimer: ReturnType<typeof setTimeout> | null = null;

function stopAgosDeployPoll(): void {
  if (agosDeployPollTimer) {
    clearTimeout(agosDeployPollTimer);
    agosDeployPollTimer = null;
  }
}

function startAgosDeployPoll(detail: AgentDetail, options: { canManage: boolean }): void {
  stopAgosDeployPoll();
  agosDeployPollTimer = setTimeout(async () => {
    agosDeployPollTimer = null;
    try {
      const resp = await api<{ ok: true; data: AgosStatusData }>(
        'GET', `/api/agos/agents/${detail.agenterId}/status`,
      );
      const deployStatus = resp.data.deployment?.status;
      // When VPS becomes running and no gateway yet: auto-provision + full refresh
      if (deployStatus === 'running' && !detail.gatewayUrl) {
        api('POST', `/api/agos/agents/${detail.agenterId}/provision`, {}).catch(() => {});
        dispatchAgentRefresh(detail.id, 500);
        return;
      }
    } catch { /* fall through to normal refresh */ }
    refreshAgosStatusPanel(detail, options);
  }, 8_000);
}

function showDeployProgress(
  container: HTMLElement,
  detail: AgentDetail,
  options: { canManage: boolean },
): void {
  clearChildren(container);

  const steps = [
    { id: 'fund', label: 'Fund AIOU' },
    { id: 'deploy', label: 'Deploy VPS' },
    { id: 'provision', label: 'Provision container' },
    { id: 'health', label: 'Health check' },
  ];

  // Build progress UI
  const progressEl = el('div', { style: 'margin-top:12px;padding:12px;background:#f0f9ff;border-radius:8px;font-size:12px' });

  const stepsEl = el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
  const stepEls: Record<string, HTMLElement> = {};

  for (const step of steps) {
    const row = el('div', { style: 'display:flex;align-items:center;gap:8px' });
    const indicator = el('span', { style: 'width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0' });
    const label = el('span', {}, step.label);
    row.appendChild(indicator);
    row.appendChild(label);
    stepsEl.appendChild(row);
    stepEls[step.id] = row;
  }

  // Fund is already complete
  setDeployStepState(stepEls['fund'], 'done');
  setDeployStepState(stepEls['deploy'], 'active');

  const statusText = el('div', { style: 'margin-top:8px;color:#64748b;font-size:11px' }, 'Deploying AGOS VPS — this typically takes 8-12 minutes.');

  progressEl.appendChild(stepsEl);
  progressEl.appendChild(statusText);
  container.appendChild(progressEl);

  // Listen for WebSocket provision_step events
  let done = false;
  let lastStep = 'waiting_deploy';
  const timeout = setTimeout(() => {
    if (!done) {
      statusText.textContent = 'Taking longer than expected \u2014 check status panel.';
      setTimeout(() => refreshAgosStatusPanel(detail, options), 3000);
    }
  }, 360_000); // 6 min timeout

  // Poll-based fallback (every 10s)
  const pollTimer = setInterval(async () => {
    if (done) { clearInterval(pollTimer); return; }
    try {
      const status = await api<{ ok: boolean; data: { deployment?: { status?: string } } }>('GET', `/api/agos/agents/${detail.agenterId}/status`);
      const deployStatus = status.data?.deployment?.status;
      if (deployStatus === 'running' && lastStep === 'waiting_deploy') {
        updateProgress('pulling');
      }
    } catch { /* ignore */ }
  }, 10_000);

  // WebSocket event listener
  const handler = (event: Event) => {
    const data = (event as CustomEvent).detail;
    if (data?.provision_step) {
      updateProgress(data.provision_step);
    }
  };
  window.addEventListener(`agent-event:${detail.agenterId}`, handler);

  function updateProgress(step: string) {
    lastStep = step;
    statusText.textContent = getStepMessage(step);

    if (step === 'waiting_deploy') {
      setDeployStepState(stepEls['deploy'], 'active');
    } else if (step === 'pulling' || step === 'starting') {
      setDeployStepState(stepEls['deploy'], 'done');
      setDeployStepState(stepEls['provision'], 'active');
    } else if (step === 'health_check') {
      setDeployStepState(stepEls['provision'], 'done');
      setDeployStepState(stepEls['health'], 'active');
    } else if (step === 'live') {
      setDeployStepState(stepEls['provision'], 'done');
      setDeployStepState(stepEls['health'], 'done');
      finish('Agent is live!', true);
    } else if (step === 'error') {
      finish(statusText.textContent || 'Provision failed', false);
    } else if (step === 'manual') {
      setDeployStepState(stepEls['deploy'], 'done');
      finish('VPS ready \u2014 manual provision needed.', false);
    }
  }

  function finish(msg: string, success: boolean) {
    done = true;
    clearTimeout(timeout);
    clearInterval(pollTimer);
    window.removeEventListener(`agent-event:${detail.agenterId}`, handler);
    statusText.textContent = msg;
    statusText.style.color = success ? '#16a34a' : '#dc2626';
    statusText.style.fontWeight = '600';
    if (success) {
      showToast('Agent deployed successfully!', 'success');
    }
    setTimeout(() => refreshAgosStatusPanel(detail, options), 2000);
  }

  function getStepMessage(step: string): string {
    switch (step) {
      case 'waiting_deploy': return 'Waiting for AGOS VPS deployment...';
      case 'pulling': return 'Pulling Docker image on VPS...';
      case 'starting': return 'Starting container...';
      case 'health_check': return 'Verifying health...';
      case 'live': return 'Agent is live!';
      case 'error': return 'Provision failed.';
      case 'manual': return 'VPS ready \u2014 manual provision needed.';
      default: return `Deploying (${step})...`;
    }
  }
}

function setDeployStepState(el_: HTMLElement, state: 'pending' | 'active' | 'done' | 'error'): void {
  const indicator = el_.querySelector('span:first-child') as HTMLElement;
  if (!indicator) return;
  const label = el_.querySelector('span:last-child') as HTMLElement;

  switch (state) {
    case 'pending':
      indicator.style.background = '#e5e7eb';
      indicator.style.color = '#9ca3af';
      indicator.textContent = '';
      if (label) label.style.color = '#9ca3af';
      break;
    case 'active':
      indicator.style.background = '#dbeafe';
      indicator.style.border = '2px solid #3b82f6';
      indicator.style.color = '#3b82f6';
      indicator.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border:1.5px solid #3b82f6;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></span>';
      if (label) { label.style.color = '#1e40af'; label.style.fontWeight = '600'; }
      break;
    case 'done':
      indicator.style.background = '#dcfce7';
      indicator.style.border = 'none';
      indicator.style.color = '#16a34a';
      indicator.textContent = '\u2713';
      if (label) { label.style.color = '#15803d'; label.style.fontWeight = '500'; }
      break;
    case 'error':
      indicator.style.background = '#fee2e2';
      indicator.style.border = 'none';
      indicator.style.color = '#dc2626';
      indicator.textContent = '\u2717';
      if (label) { label.style.color = '#dc2626'; label.style.fontWeight = '500'; }
      break;
  }
}

function renderAgosStatusContent(
  statusArea: HTMLElement,
  d: AgosStatusData,
  detail: AgentDetail,
  options: { canManage: boolean },
): void {
  clearChildren(statusArea);

  const statusGrid = el('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px' });

  const statusColor = d.agos_status === 'active' ? '#22c55e'
    : d.agos_status === 'pending_fund' ? '#f59e0b'
    : d.agos_status === 'stopped' ? '#ef4444'
    : '#94a3b8';
  statusGrid.appendChild(tooltipLabel('Status', STATUS_TOOLTIP));
  statusGrid.appendChild(el('span', { style: `color:${statusColor};font-weight:600` }, d.agos_status || 'unknown'));

  const deployStatus = d.deployment?.status;
  const isDeploying = !!deployStatus && DEPLOYING_STATUSES.has(deployStatus);

  if (deployStatus) {
    const deployColor = deployStatus === 'running' ? '#22c55e'
      : deployStatus === 'failed' ? '#ef4444'
      : '#f59e0b';
    statusGrid.appendChild(el('span', { style: 'color:#B2B2B2' }, 'Deployment'));
    const deployCell = el('span', { style: `color:${deployColor};display:flex;align-items:center;gap:6px` });
    if (isDeploying) {
      const spinner = el('span', {
        style: 'display:inline-block;width:12px;height:12px;border:2px solid #f59e0b;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite',
      });
      deployCell.appendChild(spinner);
    }
    deployCell.appendChild(document.createTextNode(deployStatus));
    statusGrid.appendChild(deployCell);
  }

  // Auto-poll while deployment is in progress
  if (isDeploying) {
    startAgosDeployPoll(detail, options);
  } else {
    stopAgosDeployPoll();
  }

  if (d.aiou_balance) {
    const bal = typeof d.aiou_balance === 'string' ? null : d.aiou_balance as AgosBalanceObj;
    const available = formatAiouBalance(d.aiou_balance);
    statusGrid.appendChild(tooltipLabel('AIOU Balance', BALANCE_TOOLTIP));

    const balCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' });
    balCell.appendChild(el('span', { style: 'font-weight:600' }, `${available} AIOU`));
    if (bal) {
      if (bal.frozenBalance && bal.frozenBalance !== '0') {
        balCell.appendChild(el('span', { style: 'font-size:11px;color:#B2B2B2' }, `Frozen: ${formatAiou(bal.frozenBalance)} AIOU`));
      }
      if (bal.spentTotal && bal.spentTotal !== '0') {
        balCell.appendChild(el('span', { style: 'font-size:11px;color:#B2B2B2' }, `Spent: ${formatAiou(bal.spentTotal)} AIOU`));
      }
    }
    statusGrid.appendChild(balCell);
  }

  if (d.agos_endpoint) {
    statusGrid.appendChild(el('span', { style: 'color:#B2B2B2' }, 'Endpoint'));
    const endpointLink = el('a', {
      href: d.agos_endpoint,
      target: '_blank',
      rel: 'noopener noreferrer',
      style: 'font-family:monospace;font-size:11px;word-break:break-all;color:#2563eb;text-decoration:underline',
    }, d.agos_endpoint) as HTMLAnchorElement;
    statusGrid.appendChild(endpointLink);
  }

  statusArea.appendChild(statusGrid);

  // Action buttons for owner
  if (options.canManage) {
    const btnRow = el('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' });

    // Fund button — always available for topping up, highlighted when pending_fund
    const fundLabel = d.agos_status === 'pending_fund' ? 'Deploy Agent' : 'Top up AIOU';
    const fundStyle = d.agos_status === 'pending_fund'
      ? 'background:#2563eb;font-size:13px;padding:8px 16px;font-weight:600'
      : 'background:#6b7280;font-size:12px;padding:6px 12px';
    const fundBtn = el('button', { className: 'btn-trigger', style: fundStyle }, fundLabel) as HTMLButtonElement;
    const fundResultArea = el('div', { style: 'margin-top:8px' });

      fundBtn.addEventListener('click', async () => {
        fundBtn.disabled = true;
        clearChildren(fundResultArea);

        try {
          const minAmount = await getAgosMinInitialFund();
          let amount: string;
          if (d.agos_status === 'pending_fund') {
            amount = String(minAmount);
            fundBtn.textContent = 'Swapping BNB \u2192 USDT \u2192 AIOU...';
          } else {
            amount = prompt(`AIOU amount to fund (minimum ${minAmount}):`, String(minAmount)) || '';
            if (!amount) { fundBtn.disabled = false; fundBtn.textContent = fundLabel; return; }
            if (Number(amount) < minAmount) {
              showToast(`Minimum deposit is ${minAmount} AIOU`, 'error');
              fundBtn.disabled = false; fundBtn.textContent = fundLabel; return;
            }
            fundBtn.textContent = 'Funding...';
          }

          const result = await api<{ ok: boolean; data?: { steps: string[]; funded_amount?: string; deploy_triggered?: boolean }; error?: string }>(
            'POST', `/api/agos/agents/${detail.agenterId}/fund/auto`,
            { target_aiou: amount },
          );
          if (!result.ok) {
            throw new Error(result.error || 'Auto-fund failed');
          }

          showToast(`Funded ${result.data?.funded_amount || amount} AIOU`, 'success');

          // If deploy was triggered, show auto-provision progress
          if (result.data?.deploy_triggered) {
            fundBtn.textContent = 'Deploying...';
            showDeployProgress(fundResultArea, detail, options);
          } else {
            refreshAgosStatusPanel(detail, options);
          }
        } catch (err: any) {
          showToast(err.message || 'Funding failed', 'error');
          fundResultArea.appendChild(el('div', { style: 'color:#ef4444;font-size:11px;margin-top:4px' }, err.message || String(err)));
          fundBtn.disabled = false;
          fundBtn.textContent = fundLabel;
        }
      });
    btnRow.appendChild(fundBtn);

    // Activate button — only when not active and not pending_fund
    if (d.agos_status !== 'active' && d.agos_status !== 'pending_fund') {
      const activateBtn = el('button', { className: 'btn-trigger', style: 'background:#22c55e;font-size:12px;padding:6px 12px' }, 'Activate') as HTMLButtonElement;
      activateBtn.addEventListener('click', async () => {
        activateBtn.disabled = true;
        activateBtn.textContent = 'Activating...';
        try {
          await api('POST', `/api/agos/agents/${detail.agenterId}/activate`, {});
          showToast('AGOS agent activated', 'success');
          refreshAgosStatusPanel(detail, options);
        } catch (err: any) {
          showToast(err.message || 'Activation failed', 'error');
          activateBtn.disabled = false;
          activateBtn.textContent = 'Activate';
        }
      });
      btnRow.appendChild(activateBtn);
    }

    // Provision VPS button — fallback for agents that weren't auto-provisioned
    if (d.agos_status === 'active' && d.deployment?.status === 'running' && !detail.gatewayUrl) {
      const provisionBtn = el('button', { className: 'btn-trigger', style: 'background:#b45309;font-size:12px;padding:6px 12px' }, 'Provision VPS') as HTMLButtonElement;
      const provisionArea = el('div', { style: 'margin-top:8px' });
      provisionBtn.addEventListener('click', async () => {
        provisionBtn.disabled = true;
        provisionBtn.textContent = 'Generating script...';
        try {
          const resp = await api<{ ok: true; data: ProvisionData }>('POST', `/api/agos/agents/${detail.agenterId}/provision`, {});
          if (resp.data.mode === 'auto') {
            showAutoProvisionProgress(provisionArea, resp.data, detail);
          } else {
            showProvisionModal(provisionArea, resp.data, detail);
          }
          provisionBtn.style.display = 'none';
        } catch (err: any) {
          showToast(err.message || 'Provision failed', 'error');
          provisionBtn.disabled = false;
          provisionBtn.textContent = 'Provision VPS';
        }
      });
      btnRow.appendChild(provisionBtn);
      statusArea.appendChild(provisionArea);
    }

    const refreshBtn = el('button', { className: 'btn-trigger', style: 'background:#6b7280;font-size:12px;padding:6px 12px' }, 'Refresh') as HTMLButtonElement;
    refreshBtn.addEventListener('click', () => refreshAgosStatusPanel(detail, options));
    btnRow.appendChild(refreshBtn);

    statusArea.appendChild(btnRow);
    statusArea.appendChild(fundResultArea);

    // If pending_fund, show prominent notice
    if (d.agos_status === 'pending_fund') {
      const notice = el('div', { style: 'margin-top:8px;padding:8px 12px;background:#dbeafe;border-radius:8px;font-size:12px;color:#1e40af' },
        'Click "Deploy Agent" to automatically fund, deploy VPS, and provision your agent. The agent wallet will swap BNB \u2192 USDT \u2192 AIOU on BSC Mainnet.');
      statusArea.appendChild(notice);
    }

    // If deploying, show prominent thinking/loading state
    if (isDeploying) {
      const deployLabel = deployStatus === 'pending' ? 'Deployment queued'
        : deployStatus === 'provisioning' ? 'Provisioning server'
        : deployStatus === 'installing' ? 'Installing software'
        : `Deploying (${deployStatus})`;
      const thinkingBox = el('div', {
        style: 'margin-top:12px;padding:16px;background:linear-gradient(135deg,#eff6ff,#dbeafe);border:1px solid #bfdbfe;border-radius:12px;text-align:center',
      });
      // Pulsing dots animation
      const dotsRow = el('div', { style: 'display:flex;justify-content:center;gap:6px;margin-bottom:10px' });
      for (let i = 0; i < 3; i++) {
        const dot = el('span', {
          style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;animation:thinking-pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
        });
        dotsRow.appendChild(dot);
      }
      thinkingBox.appendChild(dotsRow);
      thinkingBox.appendChild(el('div', { style: 'font-size:14px;font-weight:600;color:#1e40af;margin-bottom:4px' }, deployLabel));
      thinkingBox.appendChild(el('div', { style: 'font-size:12px;color:#3b82f6' }, 'AGOS is setting up your VPS — this typically takes 8-12 minutes. Auto-refreshing every 8s.'));
      statusArea.appendChild(thinkingBox);

      // Inject thinking-pulse keyframes if not present
      if (!document.getElementById('thinking-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'thinking-pulse-style';
        style.textContent = '@keyframes thinking-pulse{0%,80%,100%{transform:scale(0.6);opacity:0.4}40%{transform:scale(1);opacity:1}}';
        document.head.appendChild(style);
      }
    }

    // --- Test Controls ---
    const testSection = el('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid #ebebeb' });
    testSection.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:#92400e;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px' }, 'Test Controls'));

    const testBtnRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
    const testResultArea = el('div', { style: 'margin-top:8px;font-size:11px;max-height:200px;overflow-y:auto' });
    const testBtnStyle = 'background:#f59e0b;font-size:11px;padding:5px 10px;border:none;color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:500';

    // Button B: "Fund AIOU" — send BNB to agent wallet, backend swaps to AIOU and funds AGOS
    const testFundBtn = el('button', { className: 'btn-trigger', style: testBtnStyle }, 'Fund AIOU (BNB)') as HTMLButtonElement;
    testFundBtn.addEventListener('click', async () => {
      testFundBtn.disabled = true;
      testFundBtn.textContent = 'Connecting wallet...';
      clearChildren(testResultArea);
      try {
        const { address, provider } = await getOrPickWallet();
        const bnbAmount = prompt('BNB amount to send to agent wallet (will be swapped to AIOU):', '0.1');
        if (!bnbAmount) { testFundBtn.disabled = false; testFundBtn.textContent = 'Fund AIOU (BNB)'; return; }

        // Switch to BSC Mainnet
        testFundBtn.textContent = 'Switching to BSC Mainnet...';
        await switchToBscMainnet(provider);

        let sendTxHash: string;
        try {
          // Send BNB from user wallet to agent wallet
          testFundBtn.textContent = `Sending ${bnbAmount} BNB to agent wallet...`;
          const weiHex = '0x' + (BigInt(Math.round(parseFloat(bnbAmount) * 1e18))).toString(16);
          sendTxHash = await provider.request({
            method: 'eth_sendTransaction',
            params: [{
              from: address,
              to: detail.agentWallet,
              value: weiHex,
            }],
          }) as string;
          testResultArea.appendChild(el('div', { style: 'color:#22c55e' }, `BNB sent: ${sendTxHash}`));

          // Wait for confirmation
          testFundBtn.textContent = 'Waiting for BNB tx confirmation...';
          await waitForTxReceipt(provider, sendTxHash);
        } finally {
          await switchBackToAppChain(provider);
        }

        // Call backend to swap BNB→USDT→AIOU and fund AGOS
        testFundBtn.textContent = 'Swapping BNB→USDT→AIOU & funding...';
        const result = await api<{ ok?: boolean; error?: string; steps?: string[]; txHashes?: Record<string, string>; amount?: string }>(
          'POST', `/api/agos/agents/${detail.agenterId}/test/fund`, { user_address: address },
        );

        if (result.steps) {
          for (const step of result.steps) {
            testResultArea.appendChild(el('div', { style: 'color:#64748b' }, step));
          }
        }
        if (result.error) {
          testResultArea.appendChild(el('div', { style: 'color:#ef4444;font-weight:600' }, result.error));
        } else {
          testResultArea.appendChild(el('div', { style: 'color:#22c55e;font-weight:600' }, `Funded ${result.amount || '?'} AIOU`));
          refreshAgosStatusPanel(detail, options);
        }
      } catch (err: any) {
        if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
          testResultArea.appendChild(el('div', { style: 'color:#f59e0b' }, 'Cancelled by user'));
        } else {
          testResultArea.appendChild(el('div', { style: 'color:#ef4444' }, err.message || String(err)));
        }
      }
      testFundBtn.disabled = false;
      testFundBtn.textContent = 'Fund AIOU (BNB)';
    });
    testBtnRow.appendChild(testFundBtn);

    // Button C: "Withdraw" — drain AIOU + BNB from agent wallet back to user
    const testWithdrawBtn = el('button', { className: 'btn-trigger', style: testBtnStyle.replace('#f59e0b', '#ef4444') }, 'Withdraw All') as HTMLButtonElement;
    testWithdrawBtn.addEventListener('click', async () => {
      testWithdrawBtn.disabled = true;
      testWithdrawBtn.textContent = 'Connecting wallet...';
      clearChildren(testResultArea);
      try {
        const { address } = await getOrPickWallet();

        testWithdrawBtn.textContent = 'Withdrawing AIOU + BNB...';
        const result = await api<{ ok?: boolean; error?: string; steps?: string[]; txHashes?: Record<string, string> }>(
          'POST', `/api/agos/agents/${detail.agenterId}/test/withdraw`, { recipient: address },
        );

        if (result.steps) {
          for (const step of result.steps) {
            testResultArea.appendChild(el('div', { style: 'color:#64748b' }, step));
          }
        }
        if (result.error) {
          testResultArea.appendChild(el('div', { style: 'color:#ef4444;font-weight:600' }, result.error));
        } else {
          testResultArea.appendChild(el('div', { style: 'color:#22c55e;font-weight:600' }, 'Withdraw complete'));
        }
      } catch (err: any) {
        testResultArea.appendChild(el('div', { style: 'color:#ef4444' }, err.message || String(err)));
      }
      testWithdrawBtn.disabled = false;
      testWithdrawBtn.textContent = 'Withdraw All';
    });
    testBtnRow.appendChild(testWithdrawBtn);

    testSection.appendChild(testBtnRow);
    testSection.appendChild(testResultArea);
    statusArea.appendChild(testSection);
  }
}

/** Refresh only the AGOS status content area without rebuilding the whole page */
function refreshAgosStatusPanel(detail: AgentDetail, options: { canManage: boolean }): void {
  const statusArea = document.querySelector('[data-agos-status]') as HTMLElement | null;
  if (!statusArea) return;
  statusArea.textContent = 'Refreshing...';
  api<{ ok: true; data: AgosStatusData }>(
    'GET', `/api/agos/agents/${detail.agenterId}/status`,
  ).then(resp => {
    renderAgosStatusContent(statusArea, resp.data, detail, options);
  }).catch(err => {
    clearChildren(statusArea);
    statusArea.appendChild(el('div', { style: 'color:#ef4444;font-size:12px' }, `Failed to load AGOS status: ${err.message || err}`));
  });
}

function buildAgosStatusPanel(
  detail: AgentDetail,
  options: { canManage: boolean },
): HTMLElement {
  const container = el('div', { style: 'padding:16px 20px' });

  // Status header
  const statusRow = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' });
  statusRow.appendChild(el('span', { style: 'font-size:20px' }, '\uD83D\uDE80'));
  statusRow.appendChild(el('span', { style: 'font-weight:600;font-size:14px' }, 'AGOS Deployment'));
  container.appendChild(statusRow);

  // Info grid
  const grid = el('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;margin-bottom:12px' });
  grid.appendChild(el('span', { style: 'color:#B2B2B2' }, 'AGOS Agent ID'));
  grid.appendChild(el('span', { style: 'font-family:monospace;font-size:11px;color:#B2B2B2' }, detail.agosAgentId || ''));
  grid.appendChild(el('span', { style: 'color:#B2B2B2' }, 'Provider'));
  grid.appendChild(el('span', null, 'AGOS Cloud'));
  container.appendChild(grid);

  // Status area (marked for targeted refresh)
  const statusArea = el('div', { style: 'padding:8px 0' });
  statusArea.dataset.agosStatus = '1';
  container.appendChild(statusArea);

  // Non-owner: show basic info only (AGOS status API requires ownership)
  if (!options.canManage) {
    const statusGrid = el('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px' });
    statusGrid.appendChild(tooltipLabel('Status', STATUS_TOOLTIP));
    statusGrid.appendChild(el('span', { style: 'font-weight:600' }, detail.status || 'unknown'));
    statusArea.appendChild(statusGrid);
    return container;
  }

  // Owner: fetch live AGOS status
  statusArea.textContent = 'Loading AGOS status...';
  api<{ ok: true; data: AgosStatusData }>(
    'GET', `/api/agos/agents/${detail.agenterId}/status`,
  ).then(resp => {
    renderAgosStatusContent(statusArea, resp.data, detail, options);
  }).catch(err => {
    clearChildren(statusArea);
    statusArea.appendChild(el('div', { style: 'color:#ef4444;font-size:12px' }, `Failed to load AGOS status: ${err.message || err}`));
  });

  return container;
}

// --- Main card builder ---

export function buildSandboxCard(
  detail: AgentDetail,
  options: { canManage: boolean },
): HTMLElement {
  const card = el('div', { className: 'card card-sandbox' },
    el('div', { className: 'card-title' }, 'Container'),
  );

  // AGOS agents with agosAgentId — show AGOS deployment status (no sandboxId needed)
  if (detail.sandboxProvider === 'agos' && detail.agosAgentId) {
    card.appendChild(buildAgosStatusPanel(detail, options));
    return card;
  }

  if (!detail.sandboxId) {
    if (!options.canManage) {
      card.appendChild(el('div', { style: 'text-align:center;padding:32px 24px' },
        el('div', { style: 'font-size:15px;font-weight:500;color:#4D4D4D;margin-bottom:4px' }, 'No sandbox provisioned'),
        el('div', { style: 'font-size:12px;color:#B2B2B2' }, 'The agent owner needs to create a sandbox before you can interact.'),
      ));
      return card;
    }

    // No sandbox — show create buttons
    const isAgos = detail.sandboxProvider === 'agos';
    const contentArea = el('div');

    const emptyState = el('div', { style: 'text-align:center;padding:24px 0 16px' });
    emptyState.appendChild(el('div', { style: 'font-size:36px;margin-bottom:8px;opacity:0.3' }, isAgos ? '\uD83D\uDE80' : '\u2601'));
    emptyState.appendChild(el('div', { style: 'font-size:15px;font-weight:500;color:#4D4D4D;margin-bottom:4px' },
      isAgos ? 'Create AGOS deployment to start chatting' : 'Create a sandbox to start chatting'));
    emptyState.appendChild(el('div', { style: 'font-size:12px;color:#B2B2B2;margin-bottom:16px' },
      isAgos
        ? 'AGOS provides a managed runtime with built-in LLM gateway. Requires SIWE authentication and AGOS funding.'
        : 'A cloud sandbox provides your agent with a runtime environment, OpenClaw gateway, and interactive terminal.'));
    contentArea.appendChild(emptyState);

    const btnRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center' });
    const createBtn = el('button', { className: 'btn-trigger', style: isAgos ? 'background:#b45309' : 'background:#0081f2' },
      isAgos ? 'Create AGOS Deployment' : 'Create Sandbox') as HTMLButtonElement;
    btnRow.appendChild(createBtn);

    // "Create Agent Only" test button — create without fund/activate
    if (isAgos) {
      const createOnlyBtn = el('button', { className: 'btn-trigger', style: 'background:#f59e0b;font-size:12px;padding:6px 12px' },
        'Create Agent Only') as HTMLButtonElement;
      createOnlyBtn.addEventListener('click', async () => {
        createOnlyBtn.disabled = true;
        createOnlyBtn.textContent = 'Creating AGOS agent...';
        try {
          await api('POST', '/api/agos/agents', {
            agenter_id: detail.agenterId,
            name: detail.agentName || detail.agenterId.slice(0, 8),
          });

          showToast('AGOS agent created (pending fund)', 'success');
          dispatchAgentRefresh(detail.id, 0);
        } catch (err: any) {
          showToast(err.message ?? String(err), 'error');
          createOnlyBtn.disabled = false;
          createOnlyBtn.textContent = 'Create Agent Only';
        }
      });
      btnRow.appendChild(createOnlyBtn);
    }

    contentArea.appendChild(btnRow);

    const resultContainer = el('div', { style: 'margin-top:12px' });
    contentArea.appendChild(resultContainer);
    card.appendChild(contentArea);

    if (isAgos) {
      // --- AGOS deployment flow ---
      createBtn.addEventListener('click', async () => {
        createBtn.disabled = true;
        sandboxBusy = true;
        clearChildren(resultContainer);

        const progress = buildProgressOverlay();
        resultContainer.appendChild(progress.overlay);

        try {
          // Create AGOS agent (server-side SIWE with agent wallet)
          progress.setStep('confirm', 'Creating AGOS agent...');
          const created = await api<{ ok: true; data: { agos_agent_id: string; agos_status: string; min_initial_fund?: number } }>('POST', '/api/agos/agents', {
            agenter_id: detail.agenterId,
            name: detail.agentName || detail.agenterId.slice(0, 8),
          });

          if (created.data.agos_status === 'pending_fund') {
            // Auto-fund: agent wallet swaps BNB → USDT → AIOU on BSC Mainnet
            const fundAmount = String(created.data.min_initial_fund || 10);
            progress.setStep('sign', `Auto-funding ${fundAmount} AIOU (BNB → USDT → AIOU)...`);
            const fundResult = await api<{ ok: boolean; data?: { steps: string[]; funded_amount?: string; deploy_triggered?: boolean }; error?: string }>(
              'POST', `/api/agos/agents/${detail.agenterId}/fund/auto`,
              { target_aiou: fundAmount },
            );
            if (!fundResult.ok) {
              throw new Error(fundResult.error || 'Auto-fund failed');
            }
            progress.setStep('sign', `Funded ${fundResult.data?.funded_amount || fundAmount} AIOU`);

            // If backend auto-provision pipeline was triggered, skip frontend provision
            // The pipeline handles polling AGOS, SSH, and Docker setup in the background
            if (fundResult.data?.deploy_triggered) {
              progress.remove();
              sandboxBusy = false;
              showToast('AGOS deployment started — auto-provisioning in progress. Check events for status.', 'success');
              dispatchAgentRefresh(detail.id, 0);
              return;
            }
          }

          // Activate
          progress.setStep('startup', 'Activating AGOS agent...');
          await api('POST', `/api/agos/agents/${detail.agenterId}/activate`, {});

          // Poll until running (max 3 min, then show status panel and stop blocking)
          progress.setStep('startup', 'Waiting for AGOS deployment...');
          let deploymentReady = false;
          for (let i = 0; i < 18; i++) {
            const status = await api<{ ok: true; data: { agos_status: string; deployment?: { status?: string } | null } }>(
              'GET', `/api/agos/agents/${detail.agenterId}/status`,
            );
            if (status.data.deployment?.status === 'running' || status.data.agos_status === 'active') {
              deploymentReady = true;
              break;
            }
            progress.setStep('startup', `Waiting for AGOS deployment... (${(i + 1) * 10}s)`);
            await new Promise(r => setTimeout(r, 10_000));
          }

          if (deploymentReady) {
            // Auto-provision: generate setup script for the VPS
            progress.setStep('startup', 'Generating VPS provision script...');
            try {
              const provisionResp = await api<{ ok: true; data: ProvisionData }>('POST', `/api/agos/agents/${detail.agenterId}/provision`, {});
              progress.remove();
              sandboxBusy = false;
              if (provisionResp.data.mode === 'auto') {
                showAutoProvisionProgress(resultContainer, provisionResp.data, detail);
              } else {
                showProvisionModal(resultContainer, provisionResp.data, detail);
              }
            } catch (provErr: any) {
              progress.remove();
              sandboxBusy = false;
              showToast('AGOS deployment running! Provision script failed: ' + (provErr.message || ''), 'error');
              dispatchAgentRefresh(detail.id, 0);
            }
          } else {
            progress.remove();
            sandboxBusy = false;
            showToast('AGOS agent created. Deployment is still starting — check status panel.', 'success');
            dispatchAgentRefresh(detail.id, 0);
          }
        } catch (err: any) {
          progress.remove();
          sandboxBusy = false;
          if (err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message === 'Cancelled') {
            showToast('AGOS creation cancelled', 'error');
          } else {
            showToast(err.message ?? String(err), 'error');
          }
          createBtn.disabled = false;
        }
      });
    } else {
      // --- E2B sandbox creation with x402 payment ---
      createBtn.addEventListener('click', async () => {
        createBtn.disabled = true;
        sandboxBusy = true;
        clearChildren(resultContainer);

        const progress = buildProgressOverlay();
        resultContainer.appendChild(progress.overlay);

        try {
          progress.setStep('request', 'Connecting wallet...');
          const { address, provider } = await getOrPickWallet();

          progress.setStep('request', 'Requesting sandbox...');
          const resp = await createSandboxWithPayment(detail.agenterId, provider, address, (msg) => {
            if (msg.includes('allowance') || msg.includes('Sign') || msg.includes('sign') || msg.includes('network')) {
              progress.setStep('sign', msg);
            } else if (msg.includes('Sending') || msg.includes('payment')) {
              progress.setStep('confirm', msg);
            } else {
              progress.setStep('request', msg);
            }
          });

          // Sandbox created — now poll until running
          progress.setStep('startup', 'Sandbox created, waiting for startup...');
          showToast(`Sandbox created: ${resp.sandbox_id}`, 'success');

          pollUntilRunning(detail.agenterId, progress, () => {
            progress.remove();
            sandboxBusy = false;
            showToast('Sandbox is running!', 'success');
            dispatchAgentRefresh(detail.id, 0);
          }, (errMsg) => {
            sandboxBusy = false;
            showToast(errMsg, 'error');
            createBtn.disabled = false;
          });
        } catch (err: any) {
          progress.remove();
          sandboxBusy = false;
          if (startupPollTimer) { clearInterval(startupPollTimer); startupPollTimer = null; }
          if (err.code === 4001 || err.code === 'ACTION_REJECTED' || err.message === 'Cancelled') {
            showToast('Sandbox creation cancelled', 'error');
          } else {
            showToast(err.message ?? String(err), 'error');
          }
          createBtn.disabled = false;
        }
      });
    }

    return card;
  }

  // --- Sandbox exists (state pre-seeded by initSandboxStatus) ---
  renderSandboxExistsContent(card, detail, options);
  return card;
}

/** Render sandbox card content when sandbox exists and status is known. */
function renderSandboxExistsContent(
  card: HTMLElement,
  detail: AgentDetail,
  options: { canManage: boolean },
): void {
  const sandboxRunning = lastSandboxState === 'running';

  if (!sandboxRunning) {
    // Sandbox exists but not yet running — show waiting state with hero + polling
    if (lastSandboxStatus?.endAt) {
      card.appendChild(buildExpiryBanner(lastSandboxStatus.endAt));
    }
    card.appendChild(buildSandboxHero(detail));

    // Action buttons (refresh, resume, destroy)
    const btnRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px' });
    const refreshBtn = el('button', { className: 'sandbox-action-btn neutral' }, 'Refresh') as HTMLButtonElement;
    btnRow.appendChild(refreshBtn);
    refreshBtn.addEventListener('click', () => dispatchAgentRefresh(detail.id, 0));

    if (options.canManage) {
      if (lastSandboxState === 'paused') {
        const resumeBtn = el('button', { className: 'sandbox-action-btn green' }, 'Resume') as HTMLButtonElement;
        resumeBtn.addEventListener('click', async () => {
          resumeBtn.disabled = true;
          resumeBtn.textContent = 'Resuming...';
          try {
            await api<Record<string, unknown>>('POST', `/api/sandbox/${detail.agenterId}/resume`);
            showToast('Sandbox resumed.', 'success');
            dispatchAgentRefresh(detail.id, 1500);
          } catch (err) {
            showToast((err as Error).message ?? String(err), 'error');
            resumeBtn.disabled = false;
            resumeBtn.textContent = 'Resume';
          }
        });
        btnRow.appendChild(resumeBtn);
      }

      const destroyBtn = el('button', { className: 'sandbox-action-btn red' }, 'Destroy') as HTMLButtonElement;
      destroyBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to destroy this sandbox? This cannot be undone.')) return;
        destroyBtn.disabled = true;
        destroyBtn.textContent = 'Destroying...';
        try {
          await api<Record<string, unknown>>('DELETE', `/api/sandbox/${detail.agenterId}`);
          showToast('Sandbox destruction initiated.', 'success');
          if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
          dispatchAgentRefresh(detail.id, 2000);
        } catch (err) {
          showToast((err as Error).message ?? String(err), 'error');
          destroyBtn.disabled = false;
          destroyBtn.textContent = 'Destroy';
        }
      });
      btnRow.appendChild(destroyBtn);
    }
    card.appendChild(btnRow);

    // Waiting message
    const waitingState = lastSandboxState === 'provisioning' ? 'Sandbox is provisioning...' :
      lastSandboxState === 'paused' ? 'Sandbox is paused. Resume to interact.' :
      lastSandboxState === 'error' || lastSandboxState === 'failed' ? 'Sandbox encountered an error.' :
      'Waiting for sandbox to start...';
    const waitingEl = el('div', { style: 'text-align:center;padding:24px' });

    if (lastSandboxState === 'provisioning') {
      const spinner = el('div', { style: 'width:40px;height:40px;border:3px solid #ebebeb;border-top-color:#00C7D2;border-radius:50%;margin:0 auto 16px;animation:spin 1s linear infinite' });
      waitingEl.appendChild(spinner);
    }

    waitingEl.appendChild(el('div', { style: 'font-size:15px;font-weight:500;color:#4D4D4D;margin-bottom:4px' }, waitingState));
    waitingEl.appendChild(el('div', { style: 'font-size:12px;color:#B2B2B2' },
      'Info, Chat, Exec, Logs, and Events tabs will be available once the sandbox is running.'));
    if (lastSandboxStatus?.lastError) {
      waitingEl.appendChild(el('div', {
        style: 'margin-top:12px;padding:12px;border-radius:10px;background:#fff1f2;color:#b42318;font-size:12px;line-height:1.5;text-align:left;word-break:break-word',
      }, lastSandboxStatus.lastError));
    }

    // Disabled tab bar (visual hint)
    const disabledTabBar = el('div', { className: 'sandbox-tab-bar', style: 'opacity:0.4;pointer-events:none;margin-top:16px' });
    for (const label of ['Info', 'Chat', 'Exec', 'Logs', 'Events']) {
      disabledTabBar.appendChild(el('button', { className: 'sandbox-tab-btn' }, label));
    }
    waitingEl.appendChild(disabledTabBar);

    card.appendChild(waitingEl);
    return;
  }

  // --- Sandbox is running — show full tabbed interface ---
  renderTabs(card, detail, options);
}
