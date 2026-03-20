import '../theme.css';
import { api, requireAuth } from '../api';
import { createSandboxWithPayment } from '../x402';
import { renderNav } from '../auth';
import { el, clearChildren } from '../dom-utils';
import { getAppConfig } from '../app-config';

function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icon = type === 'success' ? '✓' : '✗';
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

async function runWorkflowAction(detail: AgentDetail, actionKey: string, button: HTMLButtonElement) {
  if (button.disabled) return;
  const original = button.textContent || 'Run';
  button.disabled = true;
  try {
    if (actionKey === 'create_sandbox') {
      const { address, provider } = await getOrPickWallet();
      button.textContent = 'Creating Sandbox...';
      await createSandboxWithPayment(detail.agenterId, provider, address);
      showToast('Sandbox creation started', 'success');
      dispatchAgentRefresh(detail.id, 0);
      return;
    }
    if (actionKey === 'create_agos') {
      button.textContent = 'Creating AGOS...';
      const created = await api<{ ok: true; data: { agos_status: string; min_initial_fund?: number } }>('POST', '/api/agos/agents', {
        agenter_id: detail.agenterId,
        name: detail.agentName || detail.agenterId.slice(0, 8),
      });
      if (created.data.agos_status === 'pending_fund') {
        const fundAmount = String(created.data.min_initial_fund || 10);
        button.textContent = `Auto-funding ${fundAmount} AIOU...`;
        try {
          const fundResult = await api<{ ok: boolean; error?: string }>('POST', `/api/agos/agents/${detail.agenterId}/fund/auto`, { target_aiou: fundAmount });
          if (!fundResult.ok) throw new Error((fundResult as any).error || 'Auto-fund failed');
        } catch (fundErr) {
          showToast(`AGOS agent created but auto-fund failed: ${(fundErr as Error).message}. You can fund manually.`, 'error');
          loadAgent(String(detail.id));
          return;
        }
      }
      button.textContent = 'Activating...';
      try {
        await api('POST', `/api/agos/agents/${detail.agenterId}/activate`, {});
      } catch (activateErr) {
        showToast(`AGOS funded but activation failed: ${(activateErr as Error).message}. Try activating manually.`, 'error');
        loadAgent(String(detail.id));
        return;
      }
      showToast('AGOS deployment started — this takes about 10 minutes', 'success');
      loadAgent(String(detail.id));
      return;
    }
    if (actionKey === 'restart_runtime' || actionKey === 'recover_runtime') {
      if (detail.sandboxProvider === 'agos') {
        button.textContent = 'Activating...';
        await api('POST', `/api/agos/agents/${detail.agenterId}/activate`, {});
      } else if (detail.sandboxProvider === 'e2b' && detail.sandboxId) {
        button.textContent = 'Resuming...';
        await api('POST', `/api/sandbox/${detail.agenterId}/resume`, {});
      } else if (detail.sandboxProvider === 'byod') {
        const status = await api<{ gateway: { url: string | null; reachable: boolean; token_configured: boolean } }>('GET', `/api/agents/${detail.id}/runtime-status`);
        const toggle = document.querySelector('.controls-drawer-toggle') as HTMLButtonElement | null;
        const drawer = document.querySelector('.controls-drawer-content') as HTMLElement | null;
        if (toggle && drawer && !drawer.classList.contains('open')) toggle.click();
        if (status.gateway.url && status.gateway.reachable) {
          showToast('BYOD gateway is reachable. Use Update BYOD to push latest config.', 'success');
        } else {
          showToast('BYOD gateway is unreachable. Update the control URL/token in Controls first.', 'error');
        }
      }
      if (detail.sandboxProvider !== 'byod') {
        showToast('Recovery action triggered', 'success');
        dispatchAgentRefresh(detail.id, 0);
      }
      return;
    }
    if (actionKey === 'configure_byod' || actionKey === 'check_byod_gateway') {
      const toggle = document.querySelector('.controls-drawer-toggle') as HTMLButtonElement | null;
      const drawer = document.querySelector('.controls-drawer-content') as HTMLElement | null;
      if (toggle && drawer && !drawer.classList.contains('open')) {
        toggle.click();
      }
      const byodInput = document.querySelector('input[placeholder="http://your-host:19790"]') as HTMLInputElement | null;
      if (byodInput) {
        byodInput.focus();
        byodInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (actionKey === 'check_byod_gateway') {
        button.textContent = 'Checking...';
        const status = await api<{ gateway: { url: string | null; reachable: boolean; token_configured: boolean } }>('GET', `/api/agents/${detail.id}/runtime-status`);
        showToast(
          status.gateway.url
            ? status.gateway.reachable
              ? 'BYOD gateway health check passed.'
              : 'BYOD gateway health check failed.'
            : 'No BYOD gateway registered yet.',
          status.gateway.url && status.gateway.reachable ? 'success' : 'error',
        );
      } else {
        showToast('BYOD controls opened. Set control URL and runtime token there.', 'success');
      }
      return;
    }
  } catch (err) {
    showToast((err as Error).message || String(err), 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
import type { AgentDetail, EventsResponse, LivenessData, SandboxStatusResponse, AgentWorkflowStateResponse } from './types';
import { REFRESH_INTERVAL } from './constants';
import { buildStatusCard, patchStatusCard, buildInfoCard, buildEventsCard, buildOnChainCard, patchOnChainCard, loadOnChainCard, loadERC8004Card } from './cards';
import { buildControlCard } from './controls';
import { buildSandboxCard, initSandboxStatus, isSandboxBusy, getOrPickWallet, dispatchAgentRefresh } from './sandbox';
import { renderRemotePanel } from './remote';
import { openChatModal, closeChatModal, buildChatButton } from './chat-modal';
import { connectSSE, closeEventSource, getEventSource } from './timeline';

requireAuth();
renderNav();
getAppConfig(); // pre-fetch config so BSCSCAN_BASE is ready for card rendering

// --- State ---

let refreshTimer: ReturnType<typeof setInterval> | null = null;

// --- Main ---

const agentId = new URLSearchParams(window.location.search).get('id');
const root = document.getElementById('agent-root')!;

if (!agentId) {
  root.appendChild(el('div', { className: 'panel-error' },
    el('p', null, 'No agent ID specified.'),
    el('a', { href: '/', style: 'color:#00C7D2;text-decoration:none;font-size:14px' }, 'Back to All Goo'),
  ));
} else {
  loadAgent(agentId);
}

// Clean up on page leave
window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  closeEventSource();
  closeChatModal();
});

// Support reload from child components (e.g. gateway registration)
window.addEventListener('agent-reload', ((e: CustomEvent) => {
  loadAgent(e.detail.id);
}) as EventListener);

// Support soft refresh from controls/sandbox (no "Loading..." flash)
window.addEventListener('agent-refresh', ((e: CustomEvent) => {
  refreshAgent(e.detail.id);
}) as EventListener);

// --- Load agent ---

function loadAgent(id: string): void {
  clearChildren(root);
  root.appendChild(el('div', { className: 'panel-loading' }, 'Loading agent data...'));

  Promise.all([
    api<AgentDetail>('GET', `/api/agents/${id}`),
    api<EventsResponse>('GET', `/api/agents/${id}/events`).catch(() => ({ events: [] }) as EventsResponse),
    api<AgentWorkflowStateResponse>('GET', `/api/agents/${id}/state`).catch(() => null as AgentWorkflowStateResponse | null),
  ]).then(([detail, eventsResp, workflowState]) => {
    // Pre-fetch sandbox status before rendering (eliminates async race)
    const sandboxPromise = detail.sandboxId
      ? api<SandboxStatusResponse>('GET', `/api/sandbox/${detail.agenterId}/status`).catch(() => null as SandboxStatusResponse | null)
      : Promise.resolve(null as SandboxStatusResponse | null);

    return sandboxPromise.then((sandboxStatus) => {
      initSandboxStatus(sandboxStatus);
      clearChildren(root);
      renderPanel(root, detail, eventsResp.events, undefined, workflowState);

      // Mark as loaded so subsequent renders skip card entrance animations
      requestAnimationFrame(() => root.classList.add('loaded'));

      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => refreshAgent(id), REFRESH_INTERVAL);
    });
  }).catch((err) => {
    clearChildren(root);
    const errorDiv = el('div', { className: 'panel-error' },
      el('p', null, `Failed to load agent: ${(err as Error).message}`),
    );
    const retryBtn = el('button', { className: 'btn-retry' }, 'Retry');
    retryBtn.addEventListener('click', () => loadAgent(id));
    errorDiv.appendChild(retryBtn);
    root.appendChild(errorDiv);
  });
}

function refreshAgent(id: string): void {
  // Skip refresh while sandbox creation/startup polling is in progress
  if (isSandboxBusy()) return;

  Promise.all([
    api<AgentDetail>('GET', `/api/agents/${id}`),
    api<EventsResponse>('GET', `/api/agents/${id}/events`).catch(() => ({ events: [] }) as EventsResponse),
    api<LivenessData>('GET', `/api/agents/${id}/liveness`).catch(() => null as LivenessData | null),
    api<AgentWorkflowStateResponse>('GET', `/api/agents/${id}/state`).catch(() => null as AgentWorkflowStateResponse | null),
  ]).then(([detail, eventsResp, liveness, workflowState]) => {
    if (isSandboxBusy()) return;

    if (!detail.runtime_running && getEventSource()) {
      closeEventSource();
    }

    // --- Zero-flicker patch: mutate existing DOM text/class, never replace nodes ---

    // Header badges
    patchHeader(root, detail);

    // Status overview card
    patchStatusCard(root, detail);

    // On-Chain Status card (merged liveness + assets)
    if (liveness) patchOnChainCard(root, liveness, detail.tokenSymbol || null);

    const actionsHost = root.querySelector('[data-card="next-actions"]') as HTMLElement | null;
    if (actionsHost && workflowState) {
      const fresh = document.createElement('div');
      renderPanel(fresh, detail, eventsResp.events, liveness, workflowState);
      const next = fresh.querySelector('[data-card="next-actions"]');
      if (next) actionsHost.replaceWith(next);
    }

    // Events — only rebuild if event count changed (preserves filter/pagination state)
    const eventsCard = root.querySelector('[data-card="events"]') as HTMLElement | null;
    if (eventsCard) {
      const oldCount = eventsCard.dataset.eventCount;
      const newCount = String(eventsResp.events.length);
      if (oldCount !== newCount) {
        const newCard = buildEventsCard(eventsResp.events);
        eventsCard.replaceWith(newCard);
      }
    }
  }).catch(() => {
    // Silent refresh failure
  });
}

/** Patch header status badges in-place */
function patchHeader(root: HTMLElement, detail: AgentDetail): void {
  const header = root.querySelector('[data-card="header"]');
  if (!header) return;

  const workflowBadge = header.querySelector('[data-v="v-header-workflow"]') as HTMLElement | null;
  if (workflowBadge) {
    workflowBadge.textContent = `launch:${detail.launchState} / runtime:${detail.runtimeState} / chain:${detail.chainState}`;
  }

  const statusBadge = header.querySelector('[data-v="v-header-status"]') as HTMLElement | null;
  if (statusBadge) {
    const statusLower = detail.status.toLowerCase();
    statusBadge.textContent = detail.status;
    statusBadge.className = `status-badge ${statusLower}`;
  }

  const runtimeBadge = header.querySelector('[data-v="v-header-runtime"]') as HTMLElement | null;
  if (runtimeBadge) {
    const runtimeLabel = detail.runtime_paused ? 'PAUSED' : detail.runtime_running ? 'RUNNING' : 'OFFLINE';
    const runtimeClass = detail.runtime_paused ? 'warning' : detail.runtime_running ? 'active' : '';
    runtimeBadge.textContent = runtimeLabel;
    runtimeBadge.className = `status-badge ${runtimeClass}`;
    runtimeBadge.style.fontSize = '10px';
  }
}

// --- Render panel ---

function renderPanel(target: HTMLElement | DocumentFragment, detail: AgentDetail, events: import('./types').AgentEvent[], cachedLiveness?: LivenessData | null, workflowState?: AgentWorkflowStateResponse | null): void {
  // Remove previous chat FAB if any
  const oldFab = document.querySelector('.chat-fab');
  if (oldFab) oldFab.remove();

  // Back link
  target.appendChild(el('a', { href: '/', className: 'back-link' }, '\u2190 All Goo'));

  // Header (full width)
  const statusLower = detail.status.toLowerCase();
  const runtimeLabel = detail.runtime_paused
    ? 'PAUSED'
    : detail.runtime_running
      ? 'RUNNING'
      : 'OFFLINE';
  const runtimeClass = detail.runtime_paused ? 'warning' : detail.runtime_running ? 'active' : '';
  const statusBadge = el('span', { className: `status-badge ${statusLower}` }, detail.status);
  statusBadge.dataset.v = 'v-header-status';
  const runtimeBadge = el('span', { className: `status-badge ${runtimeClass}`, style: 'font-size:10px' }, runtimeLabel);
  runtimeBadge.dataset.v = 'v-header-runtime';
  const workflowTone = detail.runtimeState === 'error'
    ? 'font-size:10px;background:#fee2e2;color:#b91c1c'
    : 'font-size:10px;background:#eef2ff;color:#4338ca';
  const workflowBadge = el(
    'span',
    { className: 'status-badge', style: workflowTone },
    `launch:${detail.launchState} / runtime:${detail.runtimeState} / chain:${detail.chainState}`,
  );
  workflowBadge.dataset.v = 'v-header-workflow';
  const headerChildren = [
    el('h1', null, detail.agentName || detail.agenterId),
    el('span', { className: 'symbol-tag' }, detail.tokenSymbol ? `$${detail.tokenSymbol}` : ''),
    statusBadge,
    runtimeBadge,
    workflowBadge,
  ];
  if (detail.sandboxProvider === 'byod') {
    headerChildren.push(el('span', { className: 'status-badge', style: 'font-size:10px;background:#dbeafe;color:#1d4ed8' }, 'BYOD'));
  } else if (detail.sandboxProvider === 'agos') {
    headerChildren.push(el('span', { className: 'status-badge', style: 'font-size:10px;background:#fef3c7;color:#b45309' }, 'AGOS'));
  }
  const agentHeader = el('div', { className: 'agent-header' }, ...headerChildren);
  agentHeader.dataset.card = 'header';
  target.appendChild(agentHeader);

  const isOwner = detail.is_owner;
  const canViewPrivate = detail.can_view_private;

  // Two-column layout (7:5 ratio, right sticky)
  const layout = el('div', { className: 'agent-layout' });
  const mainCol = el('div', { className: 'agent-main' });
  const sideCol = el('div', { className: 'agent-sidebar' });

  // === LEFT (main) column — Info & Operations ===

  const hasNextActions = workflowState?.actions?.length || (detail.sandboxProvider === 'byod' && workflowState?.runtime);
  const showContainerPanel = canViewPrivate && (detail.sandboxId || detail.sandboxProvider !== 'byod');
  const needsInfra = workflowState?.actions?.some(a => a.key === 'create_sandbox' || a.key === 'create_agos');

  // Helper: build container card with embedded next actions
  function buildContainerWithActions(): HTMLElement {
    const card = buildSandboxCard(detail, { canManage: isOwner });
    if (hasNextActions) {
      const actionsSection = el('div', { style: 'margin-top:16px;padding-top:16px;border-top:1px solid #ebebeb' });
      actionsSection.appendChild(el('div', {
        style: 'font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#4D4D4D;font-weight:600;margin-bottom:12px',
      }, 'Next Actions'));
      if (detail.sandboxProvider === 'byod' && workflowState?.runtime) {
        const gatewayHint = workflowState.runtime.byod_gateway_reachable === true
          ? 'BYOD gateway reachable.'
          : workflowState.runtime.byod_gateway_reachable === false
            ? 'BYOD gateway unreachable.'
            : 'BYOD gateway not checked yet.';
        actionsSection.appendChild(el('div', { style: `font-size:12px;margin-bottom:12px;${workflowState.runtime.byod_gateway_reachable === false ? 'color:#b91c1c' : 'color:#64748b'}` }, gatewayHint));
      }
      for (const action of (workflowState?.actions || [])) {
        const row = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px' });
        const actionEl = action.href && action.key === 'resume_launch'
          ? el('a', {
              href: action.href,
              style: `display:inline-flex;align-items:center;justify-content:center;padding:10px 12px;border-radius:10px;text-decoration:none;font-size:13px;font-weight:600;${action.kind === 'primary' ? 'background:#00C7D2;color:#fff' : 'background:#eef2ff;color:#3730a3'}`,
            }, action.label)
          : (() => {
              const btn = el('button', {
                type: 'button',
                style: `display:inline-flex;align-items:center;justify-content:center;padding:10px 12px;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;${action.kind === 'primary' ? 'background:#00C7D2;color:#fff' : 'background:#eef2ff;color:#3730a3'}`,
              }, action.label) as HTMLButtonElement;
              btn.disabled = !action.enabled;
              if (!action.enabled && action.reason) btn.title = action.reason;
              btn.addEventListener('click', () => runWorkflowAction(detail, action.key, btn));
              return btn;
            })();
        row.appendChild(actionEl);
        if (action.reason) row.appendChild(el('div', { style: `font-size:12px;${action.enabled ? 'color:#64748b' : 'color:#b45309'}` }, action.reason));
        actionsSection.appendChild(row);
      }
      card.appendChild(actionsSection);
    }
    return card;
  }

  // Container first (if needs infra — not yet deployed)
  let sandboxCard: HTMLElement | null = null;
  if (needsInfra && showContainerPanel) {
    sandboxCard = buildContainerWithActions();
    mainCol.appendChild(sandboxCard);
  } else if (!showContainerPanel && hasNextActions) {
    // No container panel but has next actions (e.g. BYOD) — standalone card
    const actionCard = el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Next Actions'),
    );
    actionCard.dataset.card = 'next-actions';
    if (detail.sandboxProvider === 'byod' && workflowState?.runtime) {
      const gatewayHint = workflowState.runtime.byod_gateway_reachable === true
        ? 'BYOD gateway reachable.'
        : workflowState.runtime.byod_gateway_reachable === false
          ? 'BYOD gateway unreachable.'
          : 'BYOD gateway not checked yet.';
      actionCard.appendChild(el('div', { style: `font-size:12px;margin-bottom:12px;${workflowState.runtime.byod_gateway_reachable === false ? 'color:#b91c1c' : 'color:#64748b'}` }, gatewayHint));
    }
    for (const action of (workflowState?.actions || [])) {
      const row = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px' });
      const actionEl = action.href && action.key === 'resume_launch'
        ? el('a', {
            href: action.href,
            style: `display:inline-flex;align-items:center;justify-content:center;padding:10px 12px;border-radius:10px;text-decoration:none;font-size:13px;font-weight:600;${action.kind === 'primary' ? 'background:#00C7D2;color:#fff' : 'background:#eef2ff;color:#3730a3'}`,
          }, action.label)
        : (() => {
            const btn = el('button', {
              type: 'button',
              style: `display:inline-flex;align-items:center;justify-content:center;padding:10px 12px;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;${action.kind === 'primary' ? 'background:#00C7D2;color:#fff' : 'background:#eef2ff;color:#3730a3'}`,
            }, action.label) as HTMLButtonElement;
            btn.disabled = !action.enabled;
            if (!action.enabled && action.reason) btn.title = action.reason;
            btn.addEventListener('click', () => runWorkflowAction(detail, action.key, btn));
            return btn;
          })();
      row.appendChild(actionEl);
      if (action.reason) row.appendChild(el('div', { style: `font-size:12px;${action.enabled ? 'color:#64748b' : 'color:#b45309'}` }, action.reason));
      actionCard.appendChild(row);
    }
    mainCol.appendChild(actionCard);
  }

  // Status (agent-related data: runtime, framework, sandbox, llm, etc.)
  mainCol.appendChild(buildStatusCard(detail));

  // Financials (on-chain status + fund actions merged)
  if (cachedLiveness) {
    mainCol.appendChild(buildOnChainCard(cachedLiveness, detail.tokenSymbol || null, isOwner ? detail : undefined));
  } else if (detail.tokenAddress && detail.agentWallet) {
    const onchainContainer = el('div');
    onchainContainer.dataset.card = 'onchain';
    mainCol.appendChild(onchainContainer);
    loadOnChainCard(detail, onchainContainer, isOwner);
  }

  // Container (deployed agents — show after Status + Financials)
  if (!needsInfra && showContainerPanel) {
    sandboxCard = buildContainerWithActions();
    mainCol.appendChild(sandboxCard);
  }

  // Hook up SSE for the Container panel
  if (sandboxCard && isOwner && detail.runtime_running) {
    const streamTarget = sandboxCard.querySelector('[data-stream-target]') as HTMLElement | null;
    if (streamTarget) connectSSE(String(detail.id), streamTarget);
  }

  // Remote management panel — AGOS agents only, owner only
  if (isOwner && detail.sandboxProvider === 'agos' && detail.agosAgentId) {
    mainCol.appendChild(renderRemotePanel(detail));
  }

  // Event Timeline (with filter + pagination)
  mainCol.appendChild(buildEventsCard(events));

  // === RIGHT (sidebar) column — Controls ===

  // Interact with {agent_name} — owner only
  if (isOwner) {
    const agentDisplayName = detail.agentName || detail.agenterId.slice(0, 12);
    const interactCard = el('div', { className: 'card card-elevated' },
      el('div', { className: 'card-title' }, `Interact with ${agentDisplayName}`),
    );
    const btnRow = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' });
    const chatBtn = el('button', {
      style: 'flex:1;padding:12px 20px;background:#00C7D2;color:#fff;border:none;border-radius:10px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:background .2s',
    }, 'Open Chat') as HTMLButtonElement;
    chatBtn.addEventListener('mouseenter', () => { chatBtn.style.background = '#00b3bd'; });
    chatBtn.addEventListener('mouseleave', () => { chatBtn.style.background = '#00C7D2'; });
    chatBtn.addEventListener('click', () => {
      openChatModal(detail);
    });
    btnRow.appendChild(chatBtn);
    // Agent Dashboard — prefer AGOS endpoint (https://{id}.agent.agos.fun), fall back to gateway/sandbox URL
    const agosUrl = detail.agosAgentId ? `https://${detail.agosAgentId}.agent.agos.fun` : null;
    const rawUrl = agosUrl || detail.gatewayUrl || detail.sandboxUrl || null;
    const baseUrl = rawUrl?.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://') ?? null;
    if (baseUrl) {
      const dashboardUrl = detail.gatewayToken ? `${baseUrl}#token=${detail.gatewayToken}` : baseUrl;
      const dashBtn = el('a', {
        href: dashboardUrl,
        target: '_blank',
        rel: 'noopener',
        style: 'flex:1;display:inline-flex;align-items:center;justify-content:center;padding:12px 20px;background:#f0f0ef;color:#000;border-radius:10px;font-family:inherit;font-size:14px;font-weight:600;text-decoration:none;transition:background .2s',
      }, 'Agent Dashboard') as HTMLAnchorElement;
      dashBtn.addEventListener('mouseenter', () => { dashBtn.style.background = '#e5e5e3'; });
      dashBtn.addEventListener('mouseleave', () => { dashBtn.style.background = '#f0f0ef'; });
      btnRow.appendChild(dashBtn);
    }
    interactCard.appendChild(btnRow);
    sideCol.appendChild(interactCard);
  }

  // Info (only IDs — no duplicated data)
  sideCol.appendChild(buildInfoCard(detail));

  // Goo on ERC-8004
  if (detail.tokenAddress) {
    const erc8004Container = el('div');
    erc8004Container.dataset.card = 'erc8004';
    sideCol.appendChild(erc8004Container);
    loadERC8004Card(detail, erc8004Container);
  }

  // Controls — owner only (collapsible drawer on mobile)
  if (isOwner) {
    const controlsCard = buildControlCard(detail);
    const drawerToggle = el('button', { className: 'controls-drawer-toggle' }, 'Controls \u25BC');
    const drawerContent = el('div', { className: 'controls-drawer-content' });
    drawerContent.appendChild(controlsCard);
    drawerToggle.addEventListener('click', () => {
      drawerContent.classList.toggle('open');
      drawerToggle.textContent = drawerContent.classList.contains('open') ? 'Controls \u25B2' : 'Controls \u25BC';
    });
    sideCol.appendChild(drawerToggle);
    sideCol.appendChild(drawerContent);
  }

  layout.appendChild(mainCol);
  layout.appendChild(sideCol);
  target.appendChild(layout);

  // Floating chat FAB (fallback when AGOS not yet created)
  if (canViewPrivate) {
    document.body.appendChild(buildChatButton(detail));
  }
}
