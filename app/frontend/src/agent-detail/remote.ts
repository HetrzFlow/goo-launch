import { api } from '../api';
import { el, clearChildren } from '../dom-utils';
import type { AgentDetail, RemoteExecResponse, RemoteStatusResponse, RemoteLogsResponse } from './types';

// --- Module-scope state (persists across 30s refresh) ---

let remoteActiveTab: 'info' | 'exec' | 'logs' | 'actions' = 'info';
let remoteCommandHistory: string[] = [];
let remoteHistoryIndex = -1;
let remoteExecOutput = '';
let remoteLogsContent = '';
let remoteLogsAutoRefresh = false;
let remoteLogsInterval: ReturnType<typeof setInterval> | null = null;
let remoteLogsService = 'goo-core';

// --- Toast (reuse from page) ---

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

// --- Info tab ---

function buildRemoteInfoTab(detail: AgentDetail): HTMLElement {
  const container = el('div');

  const grid = el('div', { className: 'sandbox-summary-grid' });

  const statusCard = (label: string, value: string, opts?: { accent?: string; large?: boolean }) => {
    const card = el('div', { className: 'sandbox-summary-card' });
    card.appendChild(el('div', { className: 'sandbox-summary-label' }, label));
    card.appendChild(el('div', {
      className: `sandbox-summary-value${opts?.large ? ' large' : ''}`,
      style: opts?.accent ? `color:${opts.accent}` : '',
      title: value,
    }, value));
    return card;
  };

  grid.appendChild(statusCard('Provider', 'AGOS Cloud', { accent: '#b45309' }));
  grid.appendChild(statusCard('AGOS Agent', detail.agosAgentId?.slice(0, 12) + '...' || '-'));
  grid.appendChild(statusCard('Status', detail.status.toUpperCase(), {
    accent: detail.status === 'active' ? '#00C7D2'
      : detail.status === 'stopped' ? '#6b7280'
      : detail.status === 'pending_fund' ? '#d97706' : '#4D4D4D',
    large: true,
  }));

  // Runtime card — shows DB state initially, updated by live status below
  const runtimeCard = statusCard('Runtime', detail.runtime_running ? 'RUNNING' : 'OFFLINE', {
    accent: detail.runtime_running ? '#00C7D2' : '#6b7280',
  });
  grid.appendChild(runtimeCard);

  container.appendChild(grid);

  // Fetch live status from control server
  const statusArea = el('div', { style: 'margin-top:12px' });
  statusArea.textContent = 'Loading system status...';
  container.appendChild(statusArea);

  api<RemoteStatusResponse>('GET', `/api/agos/agents/${detail.agenterId}/remote/status`)
    .then(resp => {
      // Update Runtime summary card with live data
      const liveRunning = resp.gooCoreRunning && resp.gatewayRunning;
      const liveLabel = resp.gooCoreRunning && resp.gatewayRunning ? 'RUNNING'
        : resp.gooCoreRunning || resp.gatewayRunning ? 'PARTIAL'
        : 'OFFLINE';
      const liveColor = liveRunning ? '#00C7D2' : liveLabel === 'PARTIAL' ? '#d97706' : '#6b7280';
      const valEl = runtimeCard.querySelector('.sandbox-summary-value');
      if (valEl) {
        valEl.textContent = liveLabel;
        (valEl as HTMLElement).style.color = liveColor;
      }

      clearChildren(statusArea);
      const infoGrid = el('div', { className: 'sandbox-info-grid' });

      const infoCard = (label: string, value: string) => {
        const card = el('div', { className: 'sandbox-info-card' });
        card.appendChild(el('div', { className: 'sandbox-info-label' }, label));
        card.appendChild(el('div', { className: 'sandbox-info-value', style: 'font-family:"SF Mono","Fira Code",monospace;font-size:12px', title: value }, value));
        return card;
      };

      infoGrid.appendChild(infoCard('Uptime', resp.uptime || '-'));
      infoGrid.appendChild(infoCard('Disk', resp.disk || '-'));

      const gcColor = resp.gooCoreRunning ? '#00C7D2' : '#6b7280';
      const gcCard = el('div', { className: 'sandbox-info-card' });
      gcCard.appendChild(el('div', { className: 'sandbox-info-label' }, 'goo-core'));
      gcCard.appendChild(el('div', { className: 'sandbox-info-value', style: `font-weight:600;color:${gcColor}` },
        resp.gooCoreRunning ? 'RUNNING' : 'STOPPED'));
      infoGrid.appendChild(gcCard);

      const gwColor = resp.gatewayRunning ? '#00C7D2' : '#6b7280';
      const gwCard = el('div', { className: 'sandbox-info-card' });
      gwCard.appendChild(el('div', { className: 'sandbox-info-label' }, 'Gateway'));
      gwCard.appendChild(el('div', { className: 'sandbox-info-value', style: `font-weight:600;color:${gwColor}` },
        resp.gatewayRunning ? 'RUNNING' : 'STOPPED'));
      infoGrid.appendChild(gwCard);

      if (resp.memory) {
        const memCard = el('div', { className: 'sandbox-info-card', style: 'grid-column:1/-1' });
        memCard.appendChild(el('div', { className: 'sandbox-info-label' }, 'Memory'));
        memCard.appendChild(el('pre', { style: 'margin:0;font-size:11px;color:#4D4D4D;white-space:pre;overflow-x:auto' }, resp.memory));
        infoGrid.appendChild(memCard);
      }

      if (resp.containers) {
        const cCard = el('div', { className: 'sandbox-info-card', style: 'grid-column:1/-1' });
        cCard.appendChild(el('div', { className: 'sandbox-info-label' }, 'Containers'));
        cCard.appendChild(el('pre', { style: 'margin:0;font-size:11px;color:#4D4D4D;white-space:pre;overflow-x:auto' }, resp.containers));
        infoGrid.appendChild(cCard);
      }

      statusArea.appendChild(infoGrid);
    })
    .catch(err => {
      clearChildren(statusArea);
      statusArea.appendChild(el('div', { style: 'color:#ef4444;font-size:12px' },
        `Control server unreachable: ${err.message || err}`));
    });

  return container;
}

// --- Exec tab ---

function buildRemoteExecTab(detail: AgentDetail): HTMLElement {
  const container = el('div');
  const agenterId = detail.agenterId;

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

  if (remoteCommandHistory.length > 0) {
    container.appendChild(el('div', { style: 'font-size:11px;color:#B2B2B2;margin-bottom:8px' },
      `Up/Down arrows for history (${remoteCommandHistory.length} commands)`));
  }

  const outputEl = el('pre', { className: 'sandbox-output' }, remoteExecOutput || 'Output will appear here...');
  container.appendChild(outputEl);

  const runCommand = async () => {
    const cmd = input.value.trim();
    if (!cmd) return;

    if (remoteCommandHistory[remoteCommandHistory.length - 1] !== cmd) {
      remoteCommandHistory.push(cmd);
    }
    remoteHistoryIndex = -1;

    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    remoteExecOutput += `$ ${cmd}\n`;
    outputEl.textContent = remoteExecOutput;

    try {
      const resp = await api<RemoteExecResponse>('POST', `/api/agos/agents/${agenterId}/remote/exec`, {
        command: cmd,
        timeoutMs: 30000,
      });
      if (resp.stdout) remoteExecOutput += resp.stdout;
      if (resp.stderr) remoteExecOutput += resp.stderr;
      if (!resp.stdout && !resp.stderr) remoteExecOutput += '(no output)\n';
      if (resp.exitCode != null && resp.exitCode !== 0) {
        remoteExecOutput += `[exit code: ${resp.exitCode}]\n`;
      }
    } catch (err: any) {
      remoteExecOutput += `Error: ${err.message ?? String(err)}\n`;
    }

    remoteExecOutput += '\n';
    outputEl.textContent = remoteExecOutput;
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
      if (remoteCommandHistory.length === 0) return;
      if (remoteHistoryIndex === -1) remoteHistoryIndex = remoteCommandHistory.length;
      if (remoteHistoryIndex > 0) {
        remoteHistoryIndex--;
        input.value = remoteCommandHistory[remoteHistoryIndex];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (remoteHistoryIndex === -1) return;
      if (remoteHistoryIndex < remoteCommandHistory.length - 1) {
        remoteHistoryIndex++;
        input.value = remoteCommandHistory[remoteHistoryIndex];
      } else {
        remoteHistoryIndex = -1;
        input.value = '';
      }
    }
  });

  return container;
}

// --- Logs tab ---

function buildRemoteLogsTab(detail: AgentDetail): HTMLElement {
  const container = el('div');
  const agenterId = detail.agenterId;

  const toolbar = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px' });

  // Service selector
  const serviceRow = el('div', { style: 'display:flex;align-items:center;gap:8px' });
  serviceRow.appendChild(el('span', { style: 'font-size:12px;color:#4D4D4D' }, 'Service:'));
  const serviceSelect = document.createElement('select') as HTMLSelectElement;
  serviceSelect.style.cssText = 'padding:4px 8px;font-size:12px;border:1px solid #ebebeb;border-radius:6px;font-family:inherit;background:#fff';
  for (const svc of ['goo-core', 'gateway', 'startup', 'control']) {
    const opt = document.createElement('option');
    opt.value = svc;
    opt.textContent = svc;
    if (svc === remoteLogsService) opt.selected = true;
    serviceSelect.appendChild(opt);
  }
  serviceRow.appendChild(serviceSelect);
  toolbar.appendChild(serviceRow);

  const rightControls = el('div', { style: 'display:flex;align-items:center;gap:12px' });
  const autoRefreshLabel = el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;color:#4D4D4D;cursor:pointer' });
  const autoRefreshCheckbox = document.createElement('input') as HTMLInputElement;
  autoRefreshCheckbox.type = 'checkbox';
  autoRefreshCheckbox.checked = remoteLogsAutoRefresh;
  autoRefreshLabel.appendChild(autoRefreshCheckbox);
  autoRefreshLabel.appendChild(document.createTextNode('Auto-refresh (5s)'));

  const refreshBtn = el('button', {
    style: 'padding:4px 12px;font-size:12px;font-weight:500;background:#f0f0ef;border:1px solid #ebebeb;border-radius:6px;color:#4D4D4D;cursor:pointer;font-family:inherit;transition:background .2s',
  }, 'Refresh') as HTMLButtonElement;

  rightControls.appendChild(autoRefreshLabel);
  rightControls.appendChild(refreshBtn);
  toolbar.appendChild(rightControls);
  container.appendChild(toolbar);

  const outputEl = el('pre', { className: 'sandbox-output' }, remoteLogsContent || 'Loading logs...');
  container.appendChild(outputEl);

  const fetchLogs = async () => {
    try {
      const resp = await api<RemoteLogsResponse>(
        'GET', `/api/agos/agents/${agenterId}/remote/logs?service=${encodeURIComponent(remoteLogsService)}&lines=200`,
      );
      if (resp.lines && resp.lines.length > 0) {
        remoteLogsContent = resp.lines.join('\n');
      } else {
        remoteLogsContent = '(no logs available)';
      }
    } catch (err: any) {
      remoteLogsContent = `Error loading logs: ${err.message ?? String(err)}`;
    }
    outputEl.textContent = remoteLogsContent;
    outputEl.scrollTop = outputEl.scrollHeight;
  };

  refreshBtn.addEventListener('click', fetchLogs);
  serviceSelect.addEventListener('change', () => {
    remoteLogsService = serviceSelect.value;
    remoteLogsContent = '';
    fetchLogs();
  });

  const setupAutoRefresh = () => {
    if (remoteLogsInterval) { clearInterval(remoteLogsInterval); remoteLogsInterval = null; }
    if (remoteLogsAutoRefresh) {
      remoteLogsInterval = setInterval(fetchLogs, 5000);
    }
  };

  autoRefreshCheckbox.addEventListener('change', () => {
    remoteLogsAutoRefresh = autoRefreshCheckbox.checked;
    setupAutoRefresh();
  });

  fetchLogs();
  setupAutoRefresh();

  return container;
}

// --- Actions tab ---

function buildRemoteActionsTab(detail: AgentDetail): HTMLElement {
  const container = el('div');
  const agenterId = detail.agenterId;

  const actions: { label: string; description: string; color: string; handler: (btn: HTMLButtonElement) => Promise<void> }[] = [
    {
      label: 'Restart goo-core',
      description: 'Restart the goo-core agent runtime sidecar.',
      color: '#00C7D2',
      handler: async (btn) => {
        btn.textContent = 'Restarting...';
        try {
          const resp = await api<{ restarted: boolean; running: boolean }>('POST', `/api/agos/agents/${agenterId}/remote/restart-goo-core`, {});
          showToast(resp.running ? 'goo-core restarted' : 'goo-core restart sent (not running)', resp.running ? 'success' : 'error');
        } catch (err: any) {
          showToast(err.message ?? String(err), 'error');
        }
      },
    },
    {
      label: 'Restart Gateway',
      description: 'Kill and restart the OpenClaw gateway (reloads openclaw.json config).',
      color: '#8b5cf6',
      handler: async (btn) => {
        btn.textContent = 'Restarting...';
        try {
          const resp = await api<{ restarted: boolean; running: boolean; pid?: string }>('POST', `/api/agos/agents/${agenterId}/remote/restart-gateway`, {});
          showToast(resp.running ? 'Gateway restarted' : 'Gateway restart sent (not running)', resp.running ? 'success' : 'error');
        } catch (err: any) {
          showToast(err.message ?? String(err), 'error');
        }
      },
    },
    {
      label: 'Upgrade goo-core',
      description: 'Install latest @devbond/gc globally and restart.',
      color: '#0081f2',
      handler: async (btn) => {
        btn.textContent = 'Upgrading...';
        try {
          const resp = await api<RemoteExecResponse>('POST', `/api/agos/agents/${agenterId}/remote/upgrade`, {});
          const output = [resp.stdout, resp.stderr].filter(Boolean).join('\n').trim();
          showToast(output.slice(0, 100) || 'Upgrade complete', 'success');
        } catch (err: any) {
          showToast(err.message ?? String(err), 'error');
        }
      },
    },
    {
      label: 'System Status',
      description: 'View disk, memory, docker containers, and process status.',
      color: '#6366f1',
      handler: async (btn) => {
        btn.textContent = 'Fetching...';
        try {
          const resp = await api<RemoteStatusResponse>('GET', `/api/agos/agents/${agenterId}/remote/status`);
          const resultArea = container.querySelector('[data-action-result]') as HTMLElement;
          if (resultArea) {
            clearChildren(resultArea);
            const pre = el('pre', {
              style: 'margin:0;padding:12px;background:#1a1a2e;color:#e0e0e0;border-radius:8px;font-size:11px;overflow-x:auto;white-space:pre-wrap',
            });
            pre.textContent = [
              `Uptime: ${resp.uptime}`,
              `Disk: ${resp.disk}`,
              `Memory:\n${resp.memory}`,
              `goo-core: ${resp.gooCoreRunning ? 'RUNNING' : 'STOPPED'}`,
              `Gateway: ${resp.gatewayRunning ? 'RUNNING' : 'STOPPED'}`,
              resp.containers ? `\nContainers:\n${resp.containers}` : '',
            ].filter(Boolean).join('\n');
            resultArea.appendChild(pre);
          }
        } catch (err: any) {
          showToast(err.message ?? String(err), 'error');
        }
      },
    },
  ];

  for (const action of actions) {
    const row = el('div', { style: 'margin-bottom:16px' });
    const btn = el('button', { className: 'sandbox-action-btn', style: `background:${action.color}` },
      action.label) as HTMLButtonElement;
    row.appendChild(btn);
    row.appendChild(el('div', { style: 'font-size:12px;color:#B2B2B2;margin-top:4px' }, action.description));

    btn.addEventListener('click', async () => {
      const original = btn.textContent || action.label;
      btn.disabled = true;
      try {
        await action.handler(btn);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    container.appendChild(row);
  }

  // Env var editor
  container.appendChild(el('div', {
    style: 'margin-top:8px;padding-top:16px;border-top:1px solid #ebebeb;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#4D4D4D;font-weight:600;margin-bottom:8px',
  }, 'Update Environment Variables'));
  container.appendChild(el('div', { style: 'font-size:12px;color:#B2B2B2;margin-bottom:8px' },
    'Set key=value pairs (one per line). Optionally restart goo-core after.'));

  const textarea = document.createElement('textarea') as HTMLTextAreaElement;
  textarea.style.cssText = 'width:100%;min-height:80px;padding:8px 10px;border:1px solid #ebebeb;border-radius:8px;font-size:12px;font-family:"SF Mono","Fira Code",monospace;box-sizing:border-box;resize:vertical';
  textarea.placeholder = 'LLM_MODEL=gpt-4o\nHEARTBEAT_INTERVAL_MS=60000';
  container.appendChild(textarea);

  const envBtnRow = el('div', { style: 'display:flex;gap:8px;margin-top:8px;align-items:center' });
  const restartCheckbox = document.createElement('input') as HTMLInputElement;
  restartCheckbox.type = 'checkbox';
  restartCheckbox.checked = true;
  restartCheckbox.id = 'env-restart-check';
  const restartLabel = el('label', { style: 'font-size:12px;color:#4D4D4D;cursor:pointer' }, 'Restart goo-core after');
  (restartLabel as HTMLLabelElement).htmlFor = 'env-restart-check';

  const applyEnvBtn = el('button', { className: 'sandbox-action-btn', style: 'background:#b45309;padding:6px 16px' },
    'Apply Env') as HTMLButtonElement;
  envBtnRow.appendChild(applyEnvBtn);
  envBtnRow.appendChild(restartCheckbox);
  envBtnRow.appendChild(restartLabel);
  container.appendChild(envBtnRow);

  applyEnvBtn.addEventListener('click', async () => {
    const lines = textarea.value.trim().split('\n').filter(l => l.includes('='));
    if (lines.length === 0) {
      showToast('Enter at least one KEY=VALUE pair', 'error');
      return;
    }
    const vars: Record<string, string> = {};
    for (const line of lines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        vars[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
      }
    }

    applyEnvBtn.disabled = true;
    applyEnvBtn.textContent = 'Applying...';
    try {
      await api('POST', `/api/agos/agents/${agenterId}/remote/env`, {
        vars,
        restart: restartCheckbox.checked,
      });
      showToast(`Applied ${Object.keys(vars).length} vars${restartCheckbox.checked ? ' + restart' : ''}`, 'success');
      textarea.value = '';
    } catch (err: any) {
      showToast(err.message ?? String(err), 'error');
    } finally {
      applyEnvBtn.disabled = false;
      applyEnvBtn.textContent = 'Apply Env';
    }
  });

  // Result area for system status
  const resultArea = el('div');
  resultArea.dataset.actionResult = '1';
  container.appendChild(resultArea);

  return container;
}

// --- Main panel builder ---

export function renderRemotePanel(detail: AgentDetail): HTMLElement {
  const card = el('div', { className: 'card card-sandbox' });
  card.dataset.card = 'remote';

  card.appendChild(el('div', { className: 'card-title' }, 'Remote Management'));

  // Tab bar
  const tabBar = el('div', { className: 'sandbox-tab-bar' });
  const tabs: { key: typeof remoteActiveTab; label: string }[] = [
    { key: 'info', label: 'Info' },
    { key: 'exec', label: 'Exec' },
    { key: 'logs', label: 'Logs' },
    { key: 'actions', label: 'Quick Actions' },
  ];

  const contentArea = el('div', { style: 'padding:16px 0 0' });

  function renderTabContent() {
    clearChildren(contentArea);
    switch (remoteActiveTab) {
      case 'info':
        contentArea.appendChild(buildRemoteInfoTab(detail));
        break;
      case 'exec':
        contentArea.appendChild(buildRemoteExecTab(detail));
        break;
      case 'logs':
        contentArea.appendChild(buildRemoteLogsTab(detail));
        break;
      case 'actions':
        contentArea.appendChild(buildRemoteActionsTab(detail));
        break;
    }
  }

  for (const tab of tabs) {
    const btn = el('button', {
      className: `sandbox-tab-btn${tab.key === remoteActiveTab ? ' active' : ''}`,
    }, tab.label) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      remoteActiveTab = tab.key;
      tabBar.querySelectorAll('.sandbox-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTabContent();
    });
    tabBar.appendChild(btn);
  }

  card.appendChild(tabBar);
  card.appendChild(contentArea);
  renderTabContent();

  return card;
}
