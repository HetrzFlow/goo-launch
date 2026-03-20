import './theme.css';
import { api, requireAuth, getToken, decodeToken } from './api';
import { renderNav } from './auth';
import { el, shortAddr, clearChildren } from './dom-utils';
import { getAppConfig, getBscscanBase } from './app-config';

requireAuth();
renderNav();

// --- Types (matching Prisma camelCase response) ---

interface Stats { users: number; contracts: number; agenters: number; transactions: number }
interface User { id: number; wallet_address: string; role: string; createdAt: string }
interface Contract { id: number; name: string; address: string; network: string; userId: number; createdAt: string }
interface AgenterRecord { id: number; agenterId: string; agentName: string | null; contractAddress: string; tokenSymbol: string | null; status: string; triggerCount: number; lastError: string | null; userId: number; createdAt: string }
interface TxLog { id: number; agenterId: string; method: string; memo: string | null; txHash: string; status: string; userId: number; createdAt: string }

const token = getToken();
const decoded = token ? decodeToken(token) : null;
const isAdmin = decoded?.role === 'admin';

let SCAN = 'https://testnet.bscscan.com';
getAppConfig().then(cfg => { SCAN = getBscscanBase(cfg); });

function addrCell(addr: string): HTMLElement {
  if (!addr) return el('td', null, '-');
  const td = el('td');
  const a = el('a', {
    href: `${SCAN}/address/${addr}`,
    target: '_blank',
    rel: 'noopener',
    className: 'scan-link',
    title: addr,
  }, shortAddr(addr));
  td.appendChild(a);
  return td;
}

function txCell(hash: string): HTMLElement {
  if (!hash) return el('td', null, '-');
  const td = el('td');
  const a = el('a', {
    href: `${SCAN}/tx/${hash}`,
    target: '_blank',
    rel: 'noopener',
    className: 'scan-link',
    title: hash,
  }, shortAddr(hash));
  td.appendChild(a);
  return td;
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleString();
}

function emptyRow(cols: number, msg: string): HTMLElement {
  const tr = el('tr');
  const td = el('td', { className: 'empty' }, msg);
  td.setAttribute('colspan', String(cols));
  tr.appendChild(td);
  return tr;
}

async function loadStats() {
  const data = await api<Stats>('GET', '/api/all/stats');
  document.getElementById('stat-users')!.textContent = String(data.users);
  document.getElementById('stat-contracts')!.textContent = String(data.contracts);
  document.getElementById('stat-agenters')!.textContent = String(data.agenters);
}

async function loadUsers() {
  const users = await api<User[]>('GET', '/api/all/users');
  const tbody = document.getElementById('user-list')!;
  clearChildren(tbody);
  if (!users.length) {
    tbody.appendChild(emptyRow(5, 'No users'));
    return;
  }
  for (const u of users) {
    const tr = el('tr', null,
      el('td', null, String(u.id)),
      el('td', null, u.wallet_address ? `${u.wallet_address.slice(0, 6)}...${u.wallet_address.slice(-4)}` : '-'),
      el('td', null, u.role),
      el('td', null, fmtDate(u.createdAt)),
    );
    const actionTd = el('td');
    if (isAdmin && u.role !== 'admin') {
      const btn = el('button', { className: 'btn-del' }, 'Delete') as HTMLButtonElement;
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete user ${u.wallet_address}?`)) return;
        await api('DELETE', `/api/admin/users/${u.id}`);
        loadUsers();
        loadStats();
      });
      actionTd.appendChild(btn);
    }
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
}

async function loadContracts() {
  const contracts = await api<Contract[]>('GET', '/api/all/contracts');
  const tbody = document.getElementById('contract-list')!;
  clearChildren(tbody);
  if (!contracts.length) {
    tbody.appendChild(emptyRow(6, 'No contracts'));
    return;
  }
  for (const c of contracts) {
    const tr = el('tr', null,
      el('td', null, String(c.id)),
      el('td', null, c.name),
    );
    tr.appendChild(addrCell(c.address));
    tr.appendChild(el('td', null, c.network));
    tr.appendChild(el('td', null, String(c.userId)));
    tr.appendChild(el('td', null, fmtDate(c.createdAt)));
    tbody.appendChild(tr);
  }
}

async function loadAgenters() {
  const agenters = await api<AgenterRecord[]>('GET', '/api/all/agenters');
  const tbody = document.getElementById('agenter-list')!;
  clearChildren(tbody);
  if (!agenters.length) {
    tbody.appendChild(emptyRow(7, 'No agents'));
    return;
  }
  for (const a of agenters) {
    const tr = el('tr', null,
      el('td', null, a.agentName || a.agenterId.slice(0, 20)),
      el('td', null, a.tokenSymbol || '-'),
    );
    tr.appendChild(addrCell(a.contractAddress));
    tr.appendChild(el('td', { className: `status-${a.status}` }, a.status));
    tr.appendChild(el('td', null, a.lastError || '-'));
    tr.appendChild(el('td', null, String(a.userId)));
    tr.appendChild(el('td', null, fmtDate(a.createdAt)));
    tbody.appendChild(tr);
  }
}

async function loadTransactions() {
  const txs = await api<TxLog[]>('GET', '/api/all/transactions');
  const tbody = document.getElementById('tx-list')!;
  clearChildren(tbody);
  if (!txs.length) {
    tbody.appendChild(emptyRow(8, 'No transactions'));
    return;
  }
  for (const t of txs) {
    const tr = el('tr', null,
      el('td', null, String(t.id)),
      el('td', null, t.agenterId.slice(0, 20)),
      el('td', null, t.method),
      el('td', { title: t.memo || '' }, t.memo ? (t.memo.length > 30 ? t.memo.slice(0, 30) + '...' : t.memo) : '-'),
    );
    tr.appendChild(txCell(t.txHash));
    tr.appendChild(el('td', { className: `status-${t.status}` }, t.status));
    tr.appendChild(el('td', null, String(t.userId)));
    tr.appendChild(el('td', null, fmtDate(t.createdAt)));
    tbody.appendChild(tr);
  }
}

interface HealthData {
  status: string;
  uptime: number;
  memory: { rss: number; heapUsed: number };
  agents: {
    total: number;
    byStatus: Record<string, number>;
    stalePulse: number;
    runtimeMismatch: number;
  };
  watchdog: { running: boolean; trackedAgents: number; failedAgents: number };
  recentAlerts: Array<{ eventType: string; severity: string; message: string; agenterId: string; createdAt: string }>;
}

async function loadHealth() {
  const container = document.getElementById('health-section');
  if (!container) return;

  try {
    const data = await api<HealthData>('GET', '/api/health');
    clearChildren(container);

    // Status indicator
    const statusColor = data.watchdog.failedAgents > 0 || data.agents.runtimeMismatch > 0 ? '#e05050' : '#00C7D2';
    const header = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' },
      el('div', { style: `width:10px;height:10px;border-radius:50%;background:${statusColor}` }),
      el('span', { style: 'font-weight:600;font-size:15px' }, `System ${data.status.toUpperCase()}`),
      el('span', { style: 'color:#B2B2B2;font-size:13px' }, `Uptime: ${Math.floor(data.uptime / 3600)}h ${Math.floor((data.uptime % 3600) / 60)}m`),
    );
    container.appendChild(header);

    // Agent counts
    const statusEntries = Object.entries(data.agents.byStatus);
    const countsRow = el('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px' });
    for (const [status, count] of statusEntries) {
      countsRow.appendChild(el('div', { style: 'font-size:13px' },
        `${status}: `, el('strong', null, String(count)),
      ));
    }
    if (data.agents.stalePulse > 0) {
      countsRow.appendChild(el('div', { style: 'font-size:13px;color:#f59e0b' },
        `Stale pulse: `, el('strong', null, String(data.agents.stalePulse)),
      ));
    }
    if (data.agents.runtimeMismatch > 0) {
      countsRow.appendChild(el('div', { style: 'font-size:13px;color:#e05050' },
        `Runtime mismatch: `, el('strong', null, String(data.agents.runtimeMismatch)),
      ));
    }
    container.appendChild(countsRow);

    // Watchdog info
    const watchdogInfo = el('div', { style: 'font-size:12px;color:#B2B2B2;margin-bottom:12px' },
      `Watchdog: ${data.watchdog.running ? 'running' : 'stopped'} | Tracked: ${data.watchdog.trackedAgents} | Failed: ${data.watchdog.failedAgents} | Memory: ${Math.round(data.memory.heapUsed / 1024 / 1024)}MB heap`,
    );
    container.appendChild(watchdogInfo);

    // Recent alerts
    if (data.recentAlerts.length > 0) {
      container.appendChild(el('div', {
        style: 'font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#4D4D4D;font-weight:600;margin-bottom:6px',
      }, 'Recent Alerts'));
      for (const alert of data.recentAlerts) {
        const alertColor = alert.severity === 'critical' ? '#e05050' : '#f59e0b';
        container.appendChild(el('div', { style: `font-size:12px;padding:4px 0;border-bottom:1px solid #f3f3f3;color:${alertColor}` },
          `[${new Date(alert.createdAt).toLocaleString()}] ${alert.agenterId.slice(0, 16)}... ${alert.eventType}: ${alert.message}`,
        ));
      }
    }
  } catch {
    // Health endpoint may not be available — silently ignore
  }
}

loadHealth();
loadStats();
loadUsers();
loadContracts();
loadAgenters();
loadTransactions();
