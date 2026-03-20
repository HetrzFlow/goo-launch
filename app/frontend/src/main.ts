import './theme.css';
import { api, requireAuth } from './api';
import { renderNav } from './auth';
import { el, text, shortAddr, timeAgo, clearChildren, setVisible } from './dom-utils';
import { getAppConfig, getBscscanBase } from './app-config';

requireAuth();
renderNav();

// --- Types ---

interface Agent {
  id: number;
  agenterId: string;
  agentName: string | null;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  agentWallet: string | null;
  status: string;
  launchMode: string;
  sandboxProvider: 'e2b' | 'byod' | 'agos';
  llmProvider: 'direct' | 'bsc_llm_router' | 'agos';
  createdAt: string;
  runtime_running: boolean;
  _mine?: boolean;
}

interface AgentsResponse {
  agents: Agent[];
  total: number;
}

// --- State ---

const PAGE_SIZE = 20;
let allAgents: Agent[] = [];
let mineAgents: Agent[] | null = null; // lazy-loaded
let agents: Agent[] = [];
let visibleCount = 0;
let activeFilter = 'all';

// --- Skeleton loading ---

function renderSkeletons(container: HTMLElement): void {
  clearChildren(container);
  for (let i = 0; i < 5; i++) {
    const row = el('div', { className: 'agent-row skeleton-row' },
      el('div', { className: 'skeleton-dot' }),
      el('div', { className: 'skeleton-body' },
        el('div', { className: 'skeleton-line', style: 'width:40%' }),
        el('div', { className: 'skeleton-line', style: 'width:65%' }),
      ),
      el('div', { className: 'skeleton-metrics' },
        el('div', { className: 'skeleton-line', style: 'width:50px' }),
      ),
    );
    container.appendChild(row);
  }
}

// --- Error / empty states ---

function renderError(container: HTMLElement, msg: string): void {
  clearChildren(container);
  const state = el('div', { className: 'list-state' },
    el('div', { className: 'list-state-icon' }, '!'),
    el('p', null, msg),
  );
  const retryBtn = el('button', { className: 'btn-retry' }, 'Retry');
  retryBtn.addEventListener('click', () => loadAgentList());
  state.appendChild(retryBtn);
  container.appendChild(state);
}

function renderEmpty(container: HTMLElement): void {
  clearChildren(container);
  const hint = el('p', { style: 'font-size:0.85rem;color:#808080;margin-top:0.5rem' });
  hint.appendChild(text('Be the first \u2014 click '));
  hint.appendChild(el('strong', null, 'Launch New Goo'));
  hint.appendChild(text(' above.'));

  container.appendChild(
    el('div', { className: 'list-state' },
      el('div', { className: 'list-state-icon' }, '0'),
      el('p', null, 'No Goo launched yet.'),
      hint,
    ),
  );
}

// --- Agent row rendering ---

let BSCSCAN_BASE = 'https://testnet.bscscan.com';
getAppConfig().then(cfg => { BSCSCAN_BASE = getBscscanBase(cfg); });

function buildAgentRow(agent: Agent): HTMLElement {
  const statusLower = agent.status.toLowerCase();
  const tokenAddr = agent.tokenAddress || '';
  const bscscanUrl = tokenAddr ? `${BSCSCAN_BASE}/address/${tokenAddr}` : '';

  const statusCol = el('div', { className: 'agent-status-col' },
    el('div', { className: `status-dot ${statusLower}` }),
  );

  const runtimeBadge = agent.runtime_running
    ? el('span', { className: 'status-badge active', style: 'font-size:10px;padding:1px 6px' }, 'RUNNING')
    : el('span', { className: 'status-badge', style: 'font-size:10px;padding:1px 6px;background:#f0f0ef;color:#94a3b8' }, 'OFFLINE');

  const modeBadge = agent.sandboxProvider === 'byod'
    ? el('span', { className: 'status-badge', style: 'font-size:10px;padding:1px 6px;background:#dbeafe;color:#1d4ed8' }, 'BYOD')
    : agent.sandboxProvider === 'agos'
      ? el('span', { className: 'status-badge', style: 'font-size:10px;padding:1px 6px;background:#fef3c7;color:#b45309' }, 'AGOS')
    : null;

  const ownerBadge = agent._mine
    ? el('span', { className: 'status-badge', style: 'font-size:10px;padding:1px 6px;background:#e6fafb;color:#00C7D2' }, 'OWNER')
    : null;

  const titleRow = el('div', { className: 'agent-title-row' },
    el('span', { className: 'agent-symbol' }, agent.tokenSymbol || '???'),
    el('span', { className: 'agent-name' }, agent.agentName || agent.agenterId),
    el('span', { className: `status-badge ${statusLower}` }, agent.status),
    runtimeBadge,
    ...(modeBadge ? [modeBadge] : []),
    ...(ownerBadge ? [ownerBadge] : []),
  );

  const walletAddr = agent.agentWallet || '';
  const metaRow = el('div', { className: 'agent-meta' },
    el('span', null, walletAddr ? `wallet ${shortAddr(walletAddr)}` : ''),
    el('span', { className: 'meta-sep' }, '\u00B7'),
    el('span', null, `launched ${timeAgo(agent.createdAt)}`),
  );

  const mainCol = el('div', { className: 'agent-main-col' }, titleRow, metaRow);

  const metricsCol = el('div', { className: 'agent-metrics-col' });
  if (bscscanUrl) {
    metricsCol.appendChild(
      el('a', {
        className: 'metric-link',
        href: bscscanUrl,
        target: '_blank',
        rel: 'noopener',
      }, 'BSCScan \u2192'),
    );
  }

  const row = el('div', { className: 'agent-row' }, statusCol, mainCol, metricsCol);
  row.dataset.status = agent.status;
  if (agent._mine) row.dataset.mine = '1';
  row.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) return;
    window.location.href = `/agent.html?id=${encodeURIComponent(agent.id)}`;
  });
  return row;
}

// --- Filter tabs ---

function updateFilterCounts(): void {
  const counts: Record<string, number> = { all: allAgents.length };
  for (const a of allAgents) {
    counts[a.status] = (counts[a.status] || 0) + 1;
  }
  if (mineAgents !== null) counts.mine = mineAgents.length;
  for (const key of ['all', 'mine', 'active', 'deployed', 'stopped', 'dead']) {
    const badge = document.getElementById(`fc-${key.toLowerCase()}`);
    if (badge) badge.textContent = counts[key] ? String(counts[key]) : '';
  }
}

function applyFilter(): void {
  const container = document.getElementById('agent-list-container')!;
  const rows = container.querySelectorAll<HTMLElement>('.agent-row');
  rows.forEach(row => {
    if (activeFilter === 'all') {
      row.style.display = '';
    } else if (activeFilter === 'mine') {
      const isMine = row.dataset.mine === '1';
      row.style.display = isMine ? '' : 'none';
    } else {
      row.style.display = row.dataset.status === activeFilter ? '' : 'none';
    }
  });
}

// --- Render list ---

function renderAgentList(): void {
  const container = document.getElementById('agent-list-container')!;
  const loadMoreBtn = document.getElementById('btn-load-more')!;

  if (agents.length === 0) {
    renderEmpty(container);
    setVisible(loadMoreBtn, false);
    return;
  }

  clearChildren(container);
  const toShow = agents.slice(0, visibleCount);
  for (const agent of toShow) {
    container.appendChild(buildAgentRow(agent));
  }

  setVisible(loadMoreBtn, visibleCount < agents.length);
  applyFilter();
  updateFilterCounts();
}

// --- Data fetching ---

async function loadAgentList(): Promise<void> {
  const container = document.getElementById('agent-list-container')!;
  const loadMoreBtn = document.getElementById('btn-load-more')!;
  renderSkeletons(container);
  setVisible(loadMoreBtn, false);

  try {
    const [allResp, mineResp] = await Promise.all([
      api<AgentsResponse>('GET', '/api/agents?limit=100'),
      api<AgentsResponse>('GET', '/api/agents?limit=100&mine=true'),
    ]);
    allAgents = allResp.agents;
    mineAgents = mineResp.agents;
    const mineIds = new Set(mineAgents.map(a => a.id));
    // Tag agents with mine flag for client-side filtering
    agents = allAgents.map(a => ({ ...a, _mine: mineIds.has(a.id) }));
    visibleCount = Math.min(PAGE_SIZE, agents.length);
    renderAgentList();
  } catch (err) {
    console.error('Failed to load agents:', err);
    renderError(container, `Failed to load: ${(err as Error).message ?? String(err)}`);
  }
}

// --- Init ---

// Filter tab clicks
const filterBar = document.querySelector('.filter-bar');
if (filterBar) {
  filterBar.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.filter-tab') as HTMLElement | null;
    if (!tab) return;
    filterBar.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeFilter = tab.dataset.filter || 'all';
    applyFilter();
  });
}

// Load more
document.getElementById('btn-load-more')?.addEventListener('click', () => {
  visibleCount = Math.min(visibleCount + PAGE_SIZE, agents.length);
  renderAgentList();
});

// Boot
loadAgentList();
