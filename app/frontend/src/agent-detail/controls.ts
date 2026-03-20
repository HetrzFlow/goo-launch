import { api } from '../api';
import { el, clearChildren } from '../dom-utils';
import type { AgentDebugActionResponse, AgentDetail, AgentHealthResponse } from './types';

type CreatorFieldKey = 'genesisPrompt' | 'agentInstructions' | 'skillsContent' | 'memoryContent';

type CreatorPayload = Record<CreatorFieldKey, string>;

type ByodControlSettings = {
  controlUrl: string;
  token: string;
};

const CREATOR_FIELDS: Array<{ label: string; field: CreatorFieldKey; placeholder: string }> = [
  { label: 'Soul (genesis prompt)', field: 'genesisPrompt', placeholder: 'Agent personality and core directives...' },
  { label: 'Agent Instructions', field: 'agentInstructions', placeholder: 'Specific instructions for the agent...' },
  { label: 'Skills', field: 'skillsContent', placeholder: 'Skills and capabilities...' },
  { label: 'Memory', field: 'memoryContent', placeholder: 'Initial memory and context...' },
];

function byodStorageKey(agenterId: string): string {
  return `byod-control:${agenterId}`;
}

function loadByodControlSettings(agenterId: string): ByodControlSettings {
  try {
    const raw = localStorage.getItem(byodStorageKey(agenterId));
    if (!raw) return { controlUrl: '', token: '' };
    const parsed = JSON.parse(raw) as Partial<ByodControlSettings>;
    return {
      controlUrl: parsed.controlUrl || '',
      token: parsed.token || '',
    };
  } catch {
    return { controlUrl: '', token: '' };
  }
}

function saveByodControlSettings(agenterId: string, settings: ByodControlSettings): void {
  localStorage.setItem(byodStorageKey(agenterId), JSON.stringify(settings));
}

function buildCreatorFileField(label: string, field: CreatorFieldKey, value: string | null, placeholder: string): HTMLElement {
  const wrapper = el('div', { style: 'margin-bottom:12px' });

  const header = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px' });
  header.appendChild(el('label', { style: 'font-size:13px;font-weight:500;color:#4D4D4D' }, label));

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.md,.txt';
  fileInput.style.display = 'none';

  const uploadBtn = el('button', {
    type: 'button',
    style: 'font-size:11px;padding:2px 8px;border:1px solid #ebebeb;border-radius:6px;background:#fff;cursor:pointer;color:#4D4D4D',
  }, 'Upload file');
  uploadBtn.addEventListener('click', () => fileInput.click());

  header.appendChild(uploadBtn);
  wrapper.appendChild(header);
  wrapper.appendChild(fileInput);

  const textarea = document.createElement('textarea');
  textarea.setAttribute('data-field', field);
  textarea.value = value || '';
  textarea.placeholder = placeholder;
  Object.assign(textarea.style, {
    width: '100%', minHeight: '80px', padding: '8px 10px', fontSize: '13px',
    border: '1px solid #ebebeb', borderRadius: '8px', fontFamily: 'monospace',
    resize: 'vertical', boxSizing: 'border-box', lineHeight: '1.5',
  });
  wrapper.appendChild(textarea);

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') textarea.value = reader.result;
    };
    reader.readAsText(file);
  });

  return wrapper;
}

function buildCreatorFilesSection(detail: AgentDetail): HTMLElement {
  const section = el('div', { style: 'margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #ebebeb' });
  section.appendChild(el('div', {
    style: 'font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#4D4D4D;font-weight:600;margin-bottom:12px',
  }, 'Creator Files'));

  for (const field of CREATOR_FIELDS) {
    const value = detail[field.field];
    section.appendChild(buildCreatorFileField(field.label, field.field, value, field.placeholder));
  }

  return section;
}

function collectCreatorPayload(section: HTMLElement): CreatorPayload {
  const payload = {} as CreatorPayload;
  for (const field of CREATOR_FIELDS) {
    const textarea = section.querySelector(`[data-field="${field.field}"]`) as HTMLTextAreaElement | null;
    payload[field.field] = textarea?.value || '';
  }
  return payload;
}

function buildByodControlSection(detail: AgentDetail): { section: HTMLElement; getSettings: () => ByodControlSettings } {
  const settings = loadByodControlSettings(detail.agenterId);
  const section = el('div', { style: 'margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #ebebeb' });
  section.appendChild(el('div', {
    style: 'font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#4D4D4D;font-weight:600;margin-bottom:8px',
  }, 'BYOD Control'));
  section.appendChild(el('div', {
    style: 'font-size:12px;color:#B2B2B2;margin-bottom:10px;line-height:1.5',
  }, 'Stored in this browser only. Use an HTTPS or browser-reachable self-hosted control API to push updates into your BYOD container.'));

  const urlInput = el('input', {
    type: 'text',
    placeholder: 'http://your-host:19790',
    value: settings.controlUrl,
    style: 'width:100%;padding:8px 10px;border:1px solid #ebebeb;border-radius:8px;font-size:13px;font-family:monospace;box-sizing:border-box;margin-bottom:8px',
  }) as HTMLInputElement;
  const tokenInput = el('input', {
    type: 'password',
    placeholder: 'AGENT_RUNTIME_TOKEN from your .env',
    value: settings.token,
    style: 'width:100%;padding:8px 10px;border:1px solid #ebebeb;border-radius:8px;font-size:13px;font-family:monospace;box-sizing:border-box',
  }) as HTMLInputElement;

  const persist = () => {
    saveByodControlSettings(detail.agenterId, {
      controlUrl: urlInput.value.trim(),
      token: tokenInput.value.trim(),
    });
  };

  urlInput.addEventListener('input', persist);
  tokenInput.addEventListener('input', persist);

  section.appendChild(urlInput);
  section.appendChild(tokenInput);

  return {
    section,
    getSettings: () => ({
      controlUrl: urlInput.value.trim(),
      token: tokenInput.value.trim(),
    }),
  };
}

async function applyByodUpdate(
  detail: AgentDetail,
  payload: CreatorPayload,
  settings: ByodControlSettings,
): Promise<string> {
  if (!settings.controlUrl || !settings.token) {
    throw new Error('Set the BYOD control URL and AGENT_RUNTIME_TOKEN first.');
  }

  const baseUrl = settings.controlUrl.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/control/apply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.token}`,
    },
    body: JSON.stringify({
      agent_name: detail.agentName || detail.agenterId,
      agent_intro: detail.agentIntro || '',
      genesis_prompt: payload.genesisPrompt,
      agent_instructions: payload.agentInstructions,
      skills_content: payload.skillsContent,
      memory_content: payload.memoryContent,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string; details?: string }).details || (data as { error?: string }).error || `HTTP ${res.status}`);
  }

  return 'BYOD update pushed. Container restart scheduled.';
}

async function applyCloudUpdate(detail: AgentDetail): Promise<string> {
  if (detail.sandboxId) {
    const data = await api<{
      files_synced: string[];
      goo_core_restarted: boolean;
      gateway_restarted: boolean;
      warnings?: string[];
    }>('POST', `/api/sandbox/${detail.agenterId}/apply-config`);

    const warningText = data.warnings?.length ? ` Warnings: ${data.warnings.join('; ')}` : '';
    return `Sandbox updated. Files: ${data.files_synced.length}. goo-core restarted: ${data.goo_core_restarted ? 'yes' : 'no'}. Gateway restarted: ${data.gateway_restarted ? 'yes' : 'no'}.${warningText}`;
  }

  if (detail.runtime_running) {
    await api<Record<string, unknown>>('POST', `/api/agents/${detail.id}/stop`);
    await api<Record<string, unknown>>('POST', `/api/agents/${detail.id}/start`);
    return 'Agent config saved and local runtime restarted.';
  }

  return 'Agent config saved. Start the runtime when you are ready.';
}

function formatTimestamp(ts: string | number | null | undefined): string {
  if (!ts) return 'N/A';
  const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleString();
}

function buildDebugStateSummary(state: AgentDebugActionResponse['after']): HTMLElement {
  const box = el('div', {
    style: 'margin-top:10px;padding:10px 12px;border:1px solid #ebebeb;border-radius:10px;background:#fafaf9;font-size:12px;line-height:1.6;color:#4D4D4D',
  });
  box.appendChild(el('div', { style: 'font-weight:600;color:#000;margin-bottom:4px' }, 'Chain Snapshot'));
  box.appendChild(el('div', null, `Chain=${state.status} | DB=${state.dbStatus} | Runtime=${state.runtimePaused ? 'PAUSED' : state.runtimeRunning ? 'RUNNING' : 'OFFLINE'} | goo-core=${state.gooCoreStatus || 'unknown'}`));
  box.appendChild(el('div', null, `Treasury=${state.treasuryBalance} | Threshold=${state.starvingThreshold} | ContractBNB=${state.contractBnb} | WalletBNB=${state.walletBnb}`));
  box.appendChild(el('div', null, `StarvingAt=${formatTimestamp(state.starvingEnteredAt)} | DyingAt=${formatTimestamp(state.dyingEnteredAt)}`));
  box.appendChild(el('div', null, `LastPulse=${formatTimestamp(state.lastPulseAt)} | SincePulse=${state.secondsSinceLastPulse ?? 'N/A'}s | PulseTimeoutLeft=${state.secondsUntilPulseTimeout ?? 'N/A'}s`));
  return box;
}

function buildHealthSection(detail: AgentDetail): HTMLElement {
  const section = el('div', { style: 'margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #ebebeb' });
  section.appendChild(el('div', {
    style: 'font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#4D4D4D;font-weight:600;margin-bottom:8px',
  }, 'Watchdog View'));
  const body = el('div', { style: 'font-size:12px;color:#B2B2B2;line-height:1.6' }, 'Loading agent health...');
  section.appendChild(body);

  api<AgentHealthResponse>('GET', `/api/agents/${detail.id}/health`).then((health) => {
    clearChildren(body);
    body.appendChild(el('div', null, `DB=${health.dbStatus} | Runtime=${health.runtimePaused ? 'PAUSED' : health.runtimeRunning ? 'RUNNING' : 'OFFLINE'} | goo-core=${health.gooCoreStatus || 'unknown'}`));
    body.appendChild(el('div', null, `Pulse freshness=${health.pulseFreshness} | Restart count=${health.restartCount}`));
    body.appendChild(el('div', null, `Last pulse=${formatTimestamp(health.lastPulseAt)}`));
  }).catch(() => {
    clearChildren(body);
    body.appendChild(el('div', null, 'Agent health unavailable.'));
  });

  return section;
}

function buildDebugControls(
  detail: AgentDetail,
  resultContainer: HTMLElement,
): HTMLElement {
  const section = el('div', { style: 'margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #ebebeb' });
  section.appendChild(el('div', {
    style: 'font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#991b1b;font-weight:600;margin-bottom:8px',
  }, 'Lifecycle Test Controls'));
  section.appendChild(el('div', {
    style: 'font-size:12px;color:#B2B2B2;margin-bottom:10px;line-height:1.5',
  }, 'Debug-only controls for driving STARVING / DYING / DEAD and validating watchdog sync.'));

  const grid = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
  const snapshotHost = el('div');
  const makeAction = (label: string, path: string, body?: Record<string, unknown>, confirmText?: string, tone?: string) => {
    const btn = el('button', {
      type: 'button',
      className: 'btn-trigger',
      style: `background:${tone || '#7c3aed'}`,
    }, label) as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      if (confirmText && !confirm(confirmText)) return;
      btn.disabled = true;
      const original = btn.textContent || label;
      btn.textContent = 'Running...';
      clearChildren(resultContainer);
      clearChildren(snapshotHost);
      try {
        const resp = await api<AgentDebugActionResponse>('POST', path, body);
        resultContainer.appendChild(el('div', { className: 'trigger-result success' }, resp.actionTaken));
        if (resp.warnings?.length) {
          resultContainer.appendChild(el('div', { className: 'trigger-result error' }, resp.warnings.join('; ')));
        }
        snapshotHost.appendChild(buildDebugStateSummary(resp.after));
        dispatchAgentRefresh(detail.id, 1500);
      } catch (err) {
        resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      btn.disabled = false;
      btn.textContent = original;
    });
    grid.appendChild(btn);
  };

  makeAction('Drain Treasury', `/api/agents/${detail.id}/debug/drain-treasury`, undefined, 'Withdraw BNB to drop treasury below threshold?', '#b45309');
  makeAction('Trigger Starving', `/api/agents/${detail.id}/debug/trigger-starving`, undefined, 'Trigger STARVING on-chain now?', '#b45309');
  makeAction('Trigger Dying', `/api/agents/${detail.id}/debug/trigger-dying`, undefined, 'Trigger DYING on-chain if grace has elapsed?', '#ea580c');
  makeAction(detail.runtime_paused ? 'Resume Pulse' : 'Pause Pulse', `/api/agents/${detail.id}/debug/${detail.runtime_paused ? 'resume-pulse' : 'pause-pulse'}`, undefined, detail.runtime_paused ? 'Resume heartbeats now?' : 'Pause heartbeats with SIGSTOP?', '#7c3aed');
  makeAction('Trigger Dead', `/api/agents/${detail.id}/debug/trigger-dead`, undefined, 'Trigger DEAD if pulse timeout or dying max duration has elapsed?', '#991b1b');
  makeAction('Fund +0.01 BNB', `/api/agents/${detail.id}/debug/fund-treasury`, { mode: 'topup10' }, 'Send 0.01 BNB to treasury for recovery testing?', '#166534');
  makeAction('Recover To Active', `/api/agents/${detail.id}/debug/fund-treasury`, { mode: 'recover' }, 'Send enough BNB to treasury to cross the threshold?', '#15803d');
  makeAction('Run Watchdog', `/api/agents/${detail.id}/debug/run-watchdog`, undefined, 'Run watchdog reconciliation once now?', '#1d4ed8');

  section.appendChild(grid);
  section.appendChild(snapshotHost);
  return section;
}

function dispatchAgentRefresh(id: string | number, delayMs: number = 1000): void {
  setTimeout(() => window.dispatchEvent(new CustomEvent('agent-refresh', { detail: { id: String(id) } })), delayMs);
}

// --- Control card ---

export function buildControlCard(detail: AgentDetail): HTMLElement {
  const card = el('div', { className: 'card card-elevated' },
    el('div', { className: 'card-title' }, 'Controls'),
  );

  const runtimeBtnRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
  const resultContainer = el('div');

  if (!detail.tokenAddress && detail.sandboxProvider !== 'agos') {
    runtimeBtnRow.appendChild(el('div', { style: 'font-size:14px;color:#B2B2B2' },
      'Agent token not deployed yet.'));
    card.appendChild(runtimeBtnRow);
    card.appendChild(resultContainer);
    return card;
  }

  const filesSection = buildCreatorFilesSection(detail);
  card.appendChild(filesSection);

  if (detail.debug_controls_enabled && detail.is_owner) {
    card.appendChild(buildHealthSection(detail));
    card.appendChild(buildDebugControls(detail, resultContainer));
  }

  let byodControl: ReturnType<typeof buildByodControlSection> | null = null;
  if (detail.sandboxProvider === 'byod') {
    byodControl = buildByodControlSection(detail);
    card.appendChild(byodControl.section);
  }

  const updateBtn = el('button', {
    className: 'btn-trigger',
    style: 'background:#1d4ed8',
  }, detail.sandboxProvider === 'byod' ? 'Update BYOD' : 'Update Sandbox') as HTMLButtonElement;
  runtimeBtnRow.appendChild(updateBtn);

  if (detail.sandboxProvider === 'agos') {
    // AGOS agents use AGOS activate/stop endpoints
    if (detail.status === 'active') {
      const stopBtn = el('button', { className: 'btn-trigger', style: 'background:#e05050' }, 'Stop Goo') as HTMLButtonElement;
      runtimeBtnRow.appendChild(stopBtn);
      stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping...';
        clearChildren(resultContainer);
        try {
          await api<Record<string, unknown>>('POST', `/api/agos/agents/${detail.agenterId}/stop`, {});
          resultContainer.appendChild(el('div', { className: 'trigger-result success' }, 'AGOS agent stopped.'));
          dispatchAgentRefresh(detail.id);
        } catch (err) {
          resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
          stopBtn.disabled = false;
          stopBtn.textContent = 'Stop Goo';
        }
      });
    } else if (detail.status === 'stopped') {
      const startBtn = el('button', { className: 'btn-trigger', style: 'background:#00C7D2' }, 'Start Goo') as HTMLButtonElement;
      runtimeBtnRow.appendChild(startBtn);
      startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Activating...';
        clearChildren(resultContainer);
        try {
          await api<Record<string, unknown>>('POST', `/api/agos/agents/${detail.agenterId}/activate`, {});
          resultContainer.appendChild(el('div', { className: 'trigger-result success' }, 'AGOS agent activated.'));
          dispatchAgentRefresh(detail.id);
        } catch (err) {
          resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
          startBtn.disabled = false;
          startBtn.textContent = 'Start Goo';
        }
      });
    }
  } else if (detail.runtime_running) {
    const stopBtn = el('button', { className: 'btn-trigger', style: 'background:#e05050' }, 'Stop Goo') as HTMLButtonElement;
    runtimeBtnRow.appendChild(stopBtn);

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping...';
      clearChildren(resultContainer);

      try {
        await api<Record<string, unknown>>('POST', `/api/agents/${detail.id}/stop`);
        resultContainer.appendChild(el('div', { className: 'trigger-result success' }, 'Agent stopped.'));
        dispatchAgentRefresh(detail.id);
      } catch (err) {
        resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop Goo';
      }
    });
  } else {
    const startBtn = el('button', { className: 'btn-trigger', style: 'background:#00C7D2' }, 'Start Goo') as HTMLButtonElement;
    runtimeBtnRow.appendChild(startBtn);

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      startBtn.textContent = 'Saving files...';
      clearChildren(resultContainer);

      try {
        const payload = collectCreatorPayload(filesSection);
        await api<Record<string, unknown>>('PATCH', `/api/agents/${detail.id}`, payload);
        startBtn.textContent = 'Starting...';
        await api<Record<string, unknown>>('POST', `/api/agents/${detail.id}/start`);
        resultContainer.appendChild(el('div', { className: 'trigger-result success' }, 'Agent started.'));
        dispatchAgentRefresh(detail.id);
      } catch (err) {
        resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
        startBtn.disabled = false;
        startBtn.textContent = 'Start Goo';
      }
    });
  }

  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Saving...';
    clearChildren(resultContainer);

    const payload = collectCreatorPayload(filesSection);

    try {
      await api<Record<string, unknown>>('PATCH', `/api/agents/${detail.id}`, payload);
    } catch (err) {
      resultContainer.appendChild(el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)));
      updateBtn.disabled = false;
      updateBtn.textContent = detail.sandboxProvider === 'byod' ? 'Update BYOD' : 'Update Sandbox';
      return;
    }

    updateBtn.textContent = detail.sandboxProvider === 'byod' ? 'Pushing...' : 'Applying...';

    try {
      const successMessage = detail.sandboxProvider === 'byod'
        ? await applyByodUpdate(detail, payload, byodControl?.getSettings() || { controlUrl: '', token: '' })
        : await applyCloudUpdate(detail);

      resultContainer.appendChild(el('div', { className: 'trigger-result success' }, successMessage));
      dispatchAgentRefresh(detail.id, 1500);
    } catch (err) {
      const prefix = 'Config saved to DB, but runtime sync failed: ';
      resultContainer.appendChild(el('div', { className: 'trigger-result error' }, `${prefix}${(err as Error).message ?? String(err)}`));
      updateBtn.disabled = false;
      updateBtn.textContent = detail.sandboxProvider === 'byod' ? 'Update BYOD' : 'Update Sandbox';
      return;
    }

    updateBtn.disabled = false;
    updateBtn.textContent = detail.sandboxProvider === 'byod' ? 'Update BYOD' : 'Update Sandbox';
  });

  // Decommission button (owner only, visible when not already decommissioned)
  if (detail.is_owner && detail.status !== 'decommissioned') {
    const decommissionBtn = el('button', {
      className: 'btn-trigger',
      style: 'background:#991b1b',
    }, 'Decommission') as HTMLButtonElement;

    decommissionBtn.addEventListener('click', async () => {
      if (!confirm('This will permanently stop and archive this agent. This action cannot be undone. Continue?')) return;

      decommissionBtn.disabled = true;
      decommissionBtn.textContent = 'Decommissioning...';
      clearChildren(resultContainer);

      try {
        const data = await api<{ message: string; finalState: Record<string, unknown> }>(
          'POST', `/api/agents/${detail.id}/decommission`,
        );
        const stateInfo = data.finalState?.chainStatus
          ? ` Chain status: ${data.finalState.chainStatus}`
          : '';
        resultContainer.appendChild(
          el('div', { className: 'trigger-result success' }, `Agent decommissioned.${stateInfo}`),
        );
        dispatchAgentRefresh(detail.id, 1500);
      } catch (err) {
        resultContainer.appendChild(
          el('div', { className: 'trigger-result error' }, (err as Error).message ?? String(err)),
        );
        decommissionBtn.disabled = false;
        decommissionBtn.textContent = 'Decommission';
      }
    });

    runtimeBtnRow.appendChild(decommissionBtn);
  }

  card.appendChild(runtimeBtnRow);
  card.appendChild(resultContainer);

  return card;
}
