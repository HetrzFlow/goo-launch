import './theme.css';
import { api, requireAuth } from './api';
import { renderNav } from './auth';
import { el, shortAddr, clearChildren } from './dom-utils';
import { getAppConfig, getBscscanBase } from './app-config';

requireAuth();
renderNav();

// --- Types (matching Prisma camelCase response) ---

interface Contract { id: number; name: string; address: string; network: string; createdAt: string }
interface AgenterRecord { agenterId: string; agentName: string | null; contractAddress: string; tokenSymbol: string | null; status: string; triggerCount: number; lastError: string | null }
interface TxLog { id: number; agenterId: string; method: string; memo: string | null; txHash: string; status: string; createdAt: string }

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

async function loadContracts() {
  const contracts = await api<Contract[]>('GET', '/api/my/contracts');
  const tbody = document.getElementById('contract-list')!;
  clearChildren(tbody);
  if (!contracts.length) {
    tbody.appendChild(emptyRow(5, 'No contracts yet'));
    return;
  }
  for (const c of contracts) {
    const tr = el('tr',null,
      el('td', null, String(c.id)),
      el('td', null, c.name),
    );
    tr.appendChild(addrCell(c.address));
    tr.appendChild(el('td', null, c.network));
    tr.appendChild(el('td', null, fmtDate(c.createdAt)));
    tbody.appendChild(tr);
  }
}

async function loadAgenters() {
  const agenters = await api<AgenterRecord[]>('GET', '/api/my/agenters');
  const tbody = document.getElementById('agenter-list')!;
  clearChildren(tbody);
  if (!agenters.length) {
    tbody.appendChild(emptyRow(5, 'No agents yet'));
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
    tbody.appendChild(tr);
  }
}

async function loadTransactions() {
  const txs = await api<TxLog[]>('GET', '/api/my/transactions');
  const tbody = document.getElementById('tx-list')!;
  clearChildren(tbody);
  if (!txs.length) {
    tbody.appendChild(emptyRow(6, 'No transactions yet'));
    return;
  }
  for (const t of txs) {
    const tr = el('tr', null,
      el('td', null, String(t.id)),
      el('td', null, t.method),
      el('td', { title: t.memo || '' }, t.memo ? (t.memo.length > 30 ? t.memo.slice(0, 30) + '...' : t.memo) : '-'),
    );
    tr.appendChild(txCell(t.txHash));
    tr.appendChild(el('td', { className: `status-${t.status}` }, t.status));
    tr.appendChild(el('td', null, fmtDate(t.createdAt)));
    tbody.appendChild(tr);
  }
}

loadContracts();
loadAgenters();
loadTransactions();
