import './theme.css';
import { ethers } from 'ethers';
import { api, requireAuth } from './api';
import { renderNav, onWalletChange } from './auth';
import { el, clearChildren, setVisible, shortAddr } from './dom-utils';
import { showWalletPicker, getConnectedAccount, getSelectedProvider } from './wallet';

requireAuth();
renderNav();

// --- Constants ---

import { getAppConfig, getBscscanBase, getAppConfigSync, getNetworkName } from './app-config';

function BSCSCAN_BASE(): string {
  return getBscscanBase(getAppConfigSync());
}
type SandboxProvider = 'e2b' | 'byod' | 'agos';
type LlmProvider = 'direct' | 'bsc_llm_router' | 'agos';

interface RuntimeConfig {
  network: 'testnet' | 'mainnet';
  chain_id: number;
  agos_enabled: boolean;
  agos_chain_id: number;
  min_contribution_bnb: number;
  treasury_bnb_bps: number;
}

interface AgentWorkflowStateResponse {
  agent_id: string;
  launch: {
    state: string;
    error: string | null;
    updated_at: string;
  };
  runtime: {
    provider: string | null;
    state: string;
    error: string | null;
    updated_at: string;
  };
  chain: {
    state: string;
    updated_at: string;
  };
  session: {
    resumable: boolean;
    has_prepared: boolean;
    has_token_address: boolean;
    has_deploy_tx: boolean;
    server_draft?: Partial<LaunchPayload> | null;
    server_progress?: {
      deploy_tx_hash?: string;
      token_address?: string;
      approve_tx_hash?: string;
      liquidity_tx_hash?: string;
      deployer_address?: string;
    } | null;
    server_error?: string | null;
    updated_at?: string | null;
  };
  actions?: Array<{ key: string; label: string; kind: string; enabled: boolean; href?: string | null; reason?: string | null }>;
}

// --- Wallet state ---

let connectedAddress: string | null = null;
let walletProvider: ethers.BrowserProvider | null = null;
let runtimeConfig: RuntimeConfig = {
  network: 'testnet',
  chain_id: 97,
  agos_enabled: false,
  agos_chain_id: 56,
  min_contribution_bnb: 0.1,
  treasury_bnb_bps: 3000,
};

// --- Step navigation ---

function showStep(n: 1 | 2): void {
  for (const i of [1, 2] as const) {
    const panel = document.getElementById(`step${i}`);
    const indicator = document.getElementById(`si${i}`);
    if (panel) panel.classList.toggle('active', i === n);
    if (indicator) {
      indicator.classList.toggle('active', i === n);
      indicator.classList.toggle('done', i < n);
    }
  }
  const sc1 = document.getElementById('sc1');
  if (sc1) sc1.classList.toggle('done', n > 1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Error helpers ---

function showFieldError(id: string, msg: string): void {
  const elem = document.getElementById(id);
  if (elem) elem.textContent = msg;
}

function clearErrors(stepId: string): void {
  const step = document.getElementById(stepId);
  if (!step) return;
  step.querySelectorAll('.field-error').forEach(e => (e.textContent = ''));
}

// --- Step 1 validation ---

function validateStep1(): boolean {
  clearErrors('step1');
  let valid = true;

  const agentName = (document.getElementById('agent_name') as HTMLInputElement).value.trim();
  if (!agentName || agentName.length > 100) {
    showFieldError('agent_name_error', 'Agent name is required (1-100 characters)');
    valid = false;
  }

  const agentIntro = (document.getElementById('agent_intro') as HTMLTextAreaElement).value.trim();
  if (!agentIntro || agentIntro.length > 2000) {
    showFieldError('agent_intro_error', 'Agent intro is required (1-2000 characters)');
    valid = false;
  }

  const symbol = (document.getElementById('token_symbol') as HTMLInputElement).value.trim().toUpperCase();
  if (!symbol || symbol.length > 10) {
    showFieldError('token_symbol_error', 'Symbol required (max 10 chars, uppercase)');
    valid = false;
  }

  const minBnb = runtimeConfig.min_contribution_bnb;
  const bnbVal = parseFloat((document.getElementById('contribution_bnb') as HTMLInputElement).value);
  if (isNaN(bnbVal) || bnbVal < minBnb) {
    showFieldError('contribution_bnb_error', `Minimum ${minBnb} BNB required`);
    valid = false;
  }

  const buybackEnabled = (document.getElementById('buyback_enabled') as HTMLInputElement)?.checked;
  if (buybackEnabled) {
    const threshold = parseFloat((document.getElementById('buyback_threshold') as HTMLInputElement)?.value);
    if (isNaN(threshold) || threshold < 0.1) {
      showFieldError('buyback_threshold_error', 'Minimum threshold is 0.1 BNB');
      valid = false;
    }
  }

  return valid;
}

// --- Collect form data ---

interface LaunchPayload {
  agent_name: string;
  agent_intro: string;
  token_symbol: string;
  genesis_prompt: string;
  agent_instructions: string;
  skills_content: string;
  memory_content: string;
  framework: string;
  sandbox_provider: SandboxProvider;
  llm_provider: LlmProvider;
  llm_model: string;
  circulation_pct: number;
  contribution_bnb: string;
  buyback_enabled: boolean;
  buyback_threshold_bnb: string;
}

function getSelectedSandboxProvider(): SandboxProvider {
  const checked = document.querySelector('input[name="sandbox_provider"]:checked') as HTMLInputElement | null;
  return (checked?.value as SandboxProvider) || 'byod';
}

function getSelectedLlmProvider(): LlmProvider {
  // LLM provider is derived from sandbox provider: BYOD = user's own API, AGOS = AGOS-provided
  const sandbox = getSelectedSandboxProvider();
  return sandbox === 'agos' ? 'agos' : 'direct';
}

function syncProviderAvailability(): void {
  const isMainnet = runtimeConfig.network === 'mainnet';
  const agosAvailable = isMainnet && runtimeConfig.agos_enabled;

  // Mainnet = AGOS only, Testnet = BYOD only
  const byodWrap = document.getElementById('byod-option-wrap');
  const agosWrap = document.getElementById('agos-option-wrap');
  if (byodWrap) byodWrap.style.display = isMainnet ? 'none' : '';
  if (agosWrap) agosWrap.style.display = agosAvailable ? '' : 'none';

  const sandboxProvider = getSelectedSandboxProvider();
  const cards: Array<[string, boolean]> = [
    ['mode-byod-card', sandboxProvider === 'byod'],
    ['mode-agos-card', sandboxProvider === 'agos'],
  ];
  for (const [id, selected] of cards) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('selected', selected);
  }

  // Show model selector only for AGOS provider
  const modelSection = document.getElementById('llm-model-section');
  if (modelSection) modelSection.style.display = sandboxProvider === 'agos' ? '' : 'none';
}

function collectFormData(): LaunchPayload {
  return {
    agent_name: (document.getElementById('agent_name') as HTMLInputElement).value.trim(),
    agent_intro: (document.getElementById('agent_intro') as HTMLTextAreaElement).value.trim(),
    token_symbol: (document.getElementById('token_symbol') as HTMLInputElement).value.trim().toUpperCase(),
    genesis_prompt: (document.getElementById('genesis_prompt') as HTMLTextAreaElement)?.value.trim() || '',
    agent_instructions: (document.getElementById('agent_instructions') as HTMLTextAreaElement)?.value.trim() || '',
    skills_content: (document.getElementById('skills_content') as HTMLTextAreaElement)?.value.trim() || '',
    memory_content: (document.getElementById('memory_content') as HTMLTextAreaElement)?.value.trim() || '',
    framework: (document.getElementById('agent_framework') as HTMLSelectElement)?.value || 'openclaw',
    sandbox_provider: getSelectedSandboxProvider(),
    llm_provider: getSelectedLlmProvider(),
    llm_model: (document.getElementById('llm_model') as HTMLSelectElement)?.value || '',
    circulation_pct: parseInt((document.getElementById('circulation_pct') as HTMLInputElement).value) || 10,
    contribution_bnb: (document.getElementById('contribution_bnb') as HTMLInputElement).value || String(runtimeConfig.min_contribution_bnb),
    buyback_enabled: (document.getElementById('buyback_enabled') as HTMLInputElement)?.checked || false,
    buyback_threshold_bnb: (document.getElementById('buyback_threshold') as HTMLInputElement)?.value || '0.5',
  };
}

// --- Summary rendering ---

function renderSummary(data: LaunchPayload): void {
  const card = document.getElementById('summary-card')!;
  clearChildren(card);

  // Agent identity
  const identityRows: [string, string][] = [
    ['Agent Name', data.agent_name],
    ['Agent Intro', data.agent_intro.length > 120 ? data.agent_intro.slice(0, 120) + '...' : data.agent_intro],
    ['Framework', data.framework || 'openclaw'],
  ];
  if (data.genesis_prompt) {
    identityRows.push(['soul.md', data.genesis_prompt.length > 80 ? data.genesis_prompt.slice(0, 80) + '...' : data.genesis_prompt]);
  }
  if (data.agent_instructions) {
    identityRows.push(['agent.md', data.agent_instructions.length > 80 ? data.agent_instructions.slice(0, 80) + '...' : data.agent_instructions]);
  }
  if (data.skills_content) {
    identityRows.push(['skills.md', data.skills_content.length > 80 ? data.skills_content.slice(0, 80) + '...' : data.skills_content]);
  }
  if (data.memory_content) {
    identityRows.push(['memory.md', data.memory_content.length > 80 ? data.memory_content.slice(0, 80) + '...' : data.memory_content]);
  }

  // Token parameters
  const tokenRows: [string, string][] = [
    ['Token Symbol', data.token_symbol],
    ['Token Name', `${data.agent_name} Token`],
    ['Total Supply', '1,000,000,000'],
  ];

  const circPct = data.circulation_pct;
  const bnb = parseFloat(data.contribution_bnb || String(runtimeConfig.min_contribution_bnb));
  const totalSupply = 1_000_000_000;
  const treasuryTokens = totalSupply * 5 / 100;           // always 5%
  const lpTokens = totalSupply * (circPct - 5) / 100;
  const burnTokens = totalSupply * (100 - circPct) / 100;
  const treasuryBnbPct = runtimeConfig.treasury_bnb_bps / 100;
  const treasuryBnb = bnb * runtimeConfig.treasury_bnb_bps / 10000;
  const lpBnb = bnb - treasuryBnb;
  const lpBnbPct = 100 - treasuryBnbPct;

  tokenRows.push(
    ['Circulation', `${circPct}%`],
    ['Treasury Tokens (Agent)', `${treasuryTokens.toLocaleString()} (5%)`],
    ['LP Tokens (PancakeSwap)', `${lpTokens.toLocaleString()} (${circPct - 5}%)`],
    ['Burned at Deploy', `${burnTokens.toLocaleString()} (${100 - circPct}%)`],
    ['Treasury BNB (Agent)', `${treasuryBnb.toFixed(4)} BNB (${treasuryBnbPct}%)`],
    ['LP BNB (PancakeSwap)', `${lpBnb.toFixed(4)} BNB (${lpBnbPct}%)`],
  );

  identityRows.push([
    'Provider',
    data.sandbox_provider === 'agos' ? 'AGOS (Managed)' : 'BYOD (Self-Host)',
  ]);
  if (data.llm_model && data.sandbox_provider === 'agos') {
    identityRows.push(['LLM Model', data.llm_model]);
  }

  // Economic parameters
  const econRows: [string, string][] = [
    ['Burn Rate', 'N/A (balance-based)'],
    ['Min Runway', '72 hours'],
    ['Starving Grace', '24 hours'],
    ['Dying Max Duration', '72 hours'],
    ['Pulse Timeout', '1 hour'],
    ['Transfer Fee', '1%'],
    ['Max Survival Sell', '5% per tx'],
    ['Min CTO Amount', '0.1 BNB'],
    ['Buyback', data.buyback_enabled ? `Enabled (threshold: ${data.buyback_threshold_bnb} BNB)` : 'Disabled'],
    ['Network', runtimeConfig.network === 'mainnet' ? 'BSC Mainnet' : 'BSC Testnet'],
  ];

  if (connectedAddress) {
    econRows.push(['Your Wallet', shortAddr(connectedAddress)]);
  }

  const sections: [string, [string, string][]][] = [
    ['Agent Identity', identityRows],
    ['Token Distribution', tokenRows],
    ['Economics & Lifecycle', econRows],
  ];

  for (const [title, rows] of sections) {
    const sectionTitle = el('div', {
      style: 'font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#B2B2B2;font-weight:600;margin-top:16px;margin-bottom:8px',
    }, title);
    card.appendChild(sectionTitle);
    for (const [label, value] of rows) {
      card.appendChild(
        el('div', { className: 'summary-row' },
          el('span', { className: 'summary-label' }, label),
          el('span', { className: 'summary-value' }, value),
        ),
      );
    }
  }
}

// --- Wallet gate UI ---

function showLaunchContent(): void {
  const gate = document.getElementById('wallet-gate');
  const content = document.getElementById('launch-content');
  if (gate) gate.style.display = 'none';
  if (content) content.style.display = '';
}

// --- Deploy via MetaMask ---

interface LpConfig {
  router_address: string;
  lp_token_amount: string;
  lp_bnb_amount: string;
}

interface PrepareResponse {
  agenter_id: string;
  agent_wallet: string;
  abi: unknown[];
  deploy_data: string;
  chain_id: number;
  deploy_bnb: string;
  lp_config: LpConfig;
  sandbox_provider: SandboxProvider;
  llm_provider: LlmProvider;
}

interface ConfirmResponse {
  agent_id: string;
  token_address: string;
  agent_wallet: string;
  tx_hash: string;
  status: string;
  mode?: string;
  sandbox_provider?: SandboxProvider;
  llm_provider?: LlmProvider;
  agent_wallet_private_key?: string;
  runtime_token?: string;
}

interface LaunchEventRequest {
  agenter_id: string;
  tx_hash: string;
  method: string;
  memo: string;
  status: 'submitted' | 'confirmed';
}

type DraftStage =
  | 'draft'
  | 'prepared'
  | 'deploy_submitted'
  | 'deployed'
  | 'approve_submitted'
  | 'approved'
  | 'liquidity_submitted'
  | 'liquidity_added'
  | 'confirmed';

interface LaunchDraft {
  version: 1;
  stage: DraftStage;
  savedAt: string;
  data: LaunchPayload;
  prepared?: PrepareResponse;
  agenterId?: string;
  agentWallet?: string;
  tokenAddress?: string;
  deployTxHash?: string;
  approveTxHash?: string;
  liquidityTxHash?: string;
  deployerAddress?: string;
  lastError?: string;
}

const LAUNCH_DRAFT_KEY = 'goo.launchDraft.v1';

function loadLaunchDraft(): LaunchDraft | null {
  try {
    const raw = localStorage.getItem(LAUNCH_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LaunchDraft;
    if (!parsed || parsed.version !== 1 || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveLaunchDraft(draft: LaunchDraft): void {
  draft.version = 1;
  draft.savedAt = new Date().toISOString();
  localStorage.setItem(LAUNCH_DRAFT_KEY, JSON.stringify(draft));
}

function clearLaunchDraft(): void {
  localStorage.removeItem(LAUNCH_DRAFT_KEY);
}

function upsertLaunchDraft(data: LaunchPayload, patch: Partial<LaunchDraft> = {}): LaunchDraft {
  const current = loadLaunchDraft();
  const draft: LaunchDraft = {
    version: 1,
    stage: patch.stage || current?.stage || 'draft',
    savedAt: new Date().toISOString(),
    data,
    ...current,
    ...patch,
  } as LaunchDraft;
  draft.data = data;
  saveLaunchDraft(draft);
  return draft;
}

function stageIndex(stage: DraftStage): number {
  return [
    'draft',
    'prepared',
    'deploy_submitted',
    'deployed',
    'approve_submitted',
    'approved',
    'liquidity_submitted',
    'liquidity_added',
    'confirmed',
  ].indexOf(stage);
}

function hasReachedStage(draft: LaunchDraft | null | undefined, stage: DraftStage): boolean {
  return !!draft && stageIndex(draft.stage) >= stageIndex(stage);
}

function fillFormFromDraft(data: LaunchPayload): void {
  (document.getElementById('agent_name') as HTMLInputElement).value = data.agent_name;
  (document.getElementById('agent_intro') as HTMLTextAreaElement).value = data.agent_intro;
  (document.getElementById('token_symbol') as HTMLInputElement).value = data.token_symbol;
  (document.getElementById('genesis_prompt') as HTMLTextAreaElement).value = data.genesis_prompt || '';
  (document.getElementById('agent_instructions') as HTMLTextAreaElement).value = data.agent_instructions || '';
  (document.getElementById('skills_content') as HTMLTextAreaElement).value = data.skills_content || '';
  (document.getElementById('memory_content') as HTMLTextAreaElement).value = data.memory_content || '';
  (document.getElementById('agent_framework') as HTMLSelectElement).value = data.framework || 'openclaw';
  (document.getElementById('circulation_pct') as HTMLInputElement).value = String(data.circulation_pct || 10);
  (document.getElementById('contribution_bnb') as HTMLInputElement).value = data.contribution_bnb || String(runtimeConfig.min_contribution_bnb);
  const buybackCheckbox = document.getElementById('buyback_enabled') as HTMLInputElement | null;
  if (buybackCheckbox) buybackCheckbox.checked = !!data.buyback_enabled;
  const buybackThreshold = document.getElementById('buyback_threshold') as HTMLInputElement | null;
  if (buybackThreshold) buybackThreshold.value = data.buyback_threshold_bnb || '0.5';
  const buybackFields = document.getElementById('buyback-fields');
  if (buybackFields) buybackFields.style.display = data.buyback_enabled ? '' : 'none';
  const sandboxRadio = document.querySelector(
    'input[name="sandbox_provider"][value="' + data.sandbox_provider + '"]',
  ) as HTMLInputElement | null;
  if (sandboxRadio) sandboxRadio.checked = true;
  syncProviderAvailability();
  updateTokenPreview();
}

async function loadServerWorkflowState(): Promise<AgentWorkflowStateResponse | null> {
  const qs = new URLSearchParams(window.location.search);
  const agentId = qs.get('agent') || qs.get('id');
  if (!agentId) return null;
  try {
    return await api<AgentWorkflowStateResponse>('GET', `/api/agents/${agentId}/state`);
  } catch {
    return null;
  }
}

function buildDraftFromServerState(serverState: AgentWorkflowStateResponse | null): LaunchDraft | null {
  const data = serverState?.session?.server_draft;
  if (!serverState?.session?.resumable || !data?.agent_name || !data?.token_symbol) return null;
  const progress = serverState.session.server_progress || {};
  let stage: DraftStage = 'draft';
  if (progress.liquidity_tx_hash) stage = serverState.launch.state === 'launched' ? 'liquidity_added' : 'liquidity_submitted';
  else if (progress.approve_tx_hash) stage = 'approve_submitted';
  else if (progress.token_address) stage = 'deployed';
  else if (progress.deploy_tx_hash) stage = 'deploy_submitted';
  else if (serverState.session.has_prepared) stage = 'prepared';
  return {
    version: 1,
    stage,
    savedAt: serverState.session.updated_at || new Date().toISOString(),
    data: data as LaunchPayload,
    agenterId: serverState.agent_id,
    tokenAddress: progress.token_address,
    deployTxHash: progress.deploy_tx_hash,
    approveTxHash: progress.approve_tx_hash,
    liquidityTxHash: progress.liquidity_tx_hash,
    deployerAddress: progress.deployer_address,
    lastError: serverState.session.server_error || serverState.launch.error || undefined,
  };
}

function getPreferredResumeDraft(serverState?: AgentWorkflowStateResponse | null): LaunchDraft | null {
  const local = loadLaunchDraft();
  const remote = buildDraftFromServerState(serverState || null);
  if (!local) return remote;
  if (!remote) return local;
  return new Date(remote.savedAt).getTime() > new Date(local.savedAt).getTime() ? remote : local;
}

function renderResumeDraftBanner(serverState?: AgentWorkflowStateResponse | null): void {
  const existing = document.getElementById('launch-resume-banner');
  if (existing) existing.remove();

  const draft = getPreferredResumeDraft(serverState);
  if ((!draft || draft.stage === 'confirmed') && !serverState?.session?.resumable) return;

  const anchor = document.getElementById('launch-content') || document.getElementById('wallet-gate');
  if (!anchor || !anchor.parentElement) return;

  const title = draft?.data.agent_name || draft?.data.token_symbol || serverState?.agent_id || 'unfinished launch';
  const lastStep = draft?.stage ? draft.stage.replace(/_/g, ' ') : serverState?.launch.state || 'server resume available';
  const sourceLabel = draft && serverState?.session?.resumable && draft.savedAt === serverState.session.updated_at
    ? 'server'
    : 'local';
  const msg = draft?.lastError
    ? 'Found unfinished launch (' + sourceLabel + ') for ' + title + '. Last saved step: ' + lastStep + '. Last error: ' + draft.lastError
    : serverState?.session?.resumable
      ? 'Found resumable launch on server for ' + title + '. Current launch state: ' + serverState.launch.state + '.'
      : 'Found unfinished launch for ' + title + '. Last saved step: ' + lastStep + '.';

  const banner = el('div', {
    id: 'launch-resume-banner',
    style: 'margin:0 0 16px 0;padding:14px 16px;border:1px solid #cbd5e1;background:#eff6ff;border-radius:12px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between',
  });
  banner.appendChild(el('div', { style: 'font-size:14px;color:#1e3a8a;line-height:1.5' }, msg));

  const actions = el('div', { style: 'display:flex;gap:10px;align-items:center' });
  const resumeBtn = el('button', {
    id: 'btn_resume_launch',
    type: 'button',
    style: 'padding:10px 14px;border:none;border-radius:10px;background:#1d4ed8;color:#fff;font:inherit;cursor:pointer',
  }, 'Resume Launch') as HTMLButtonElement;
  resumeBtn.addEventListener('click', async () => {
    if (!draft) return;
    saveLaunchDraft(draft);
    fillFormFromDraft(draft.data);
    renderSummary(draft.data);
    showStep(2);
    await deploy(draft.data, { resume: true });
  });

  const discardBtn = el('button', {
    id: 'btn_discard_launch',
    type: 'button',
    style: 'padding:10px 14px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#334155;font:inherit;cursor:pointer',
  }, 'Discard Saved Launch') as HTMLButtonElement;
  discardBtn.addEventListener('click', () => {
    clearLaunchDraft();
    // Remove ?agent= from URL so server state isn't re-fetched on reload
    const url = new URL(window.location.href);
    if (url.searchParams.has('agent') || url.searchParams.has('id')) {
      url.searchParams.delete('agent');
      url.searchParams.delete('id');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
    // Reset form to blank
    const form = document.getElementById('genome-form') as HTMLFormElement | null;
    if (form) form.reset();
    showStep(1);
    renderResumeDraftBanner();
  });

  actions.appendChild(resumeBtn);
  actions.appendChild(discardBtn);
  banner.appendChild(actions);
  anchor.parentElement.insertBefore(banner, anchor);
}

async function recordLaunchEvent(event: LaunchEventRequest): Promise<void> {
  await api('POST', '/api/launch/event', event);
}

// --- Deploy progress tracker ---

interface DeployStep {
  label: string;
  detail: string;
}

function getDeploySteps(_data: LaunchPayload): DeployStep[] {
  return [
    { label: 'Prepare', detail: 'Generating deployment data' },
    { label: 'Deploy Token', detail: 'Sign TX: deploy token + treasury BNB + burn + treasury tokens to agent' },
    { label: 'Approve Router', detail: 'Sign TX: approve tokens for PancakeSwap' },
    { label: 'Add Liquidity', detail: 'Sign TX: add liquidity to PancakeSwap' },
    { label: 'Register', detail: 'Confirming agent on server' },
  ];
}

function buildProgressTracker(deploySteps: DeployStep[]): { container: HTMLElement; setStep: (idx: number, status?: 'active' | 'done' | 'error') => void; totalSteps: number } {
  const container = el('div', { className: 'deploy-progress' });

  const steps = deploySteps.map((s, i) => {
    const stepNum = el('div', { className: 'dp-num' }, String(i + 1));
    const stepLabel = el('div', { className: 'dp-label' }, s.label);
    const stepDetail = el('div', { className: 'dp-detail' }, s.detail);
    const stepEl = el('div', { className: 'dp-step' }, stepNum, el('div', { className: 'dp-text' }, stepLabel, stepDetail));
    container.appendChild(stepEl);
    return stepEl;
  });

  function setStep(idx: number, status: 'active' | 'done' | 'error' = 'active') {
    steps.forEach((s, i) => {
      s.classList.remove('active', 'done', 'error');
      if (i < idx) s.classList.add('done');
      else if (i === idx) s.classList.add(status);
    });
  }

  return { container, setStep, totalSteps: deploySteps.length };
}

async function waitForReceipt(txHash: string): Promise<ethers.TransactionReceipt> {
  if (!walletProvider) throw new Error('Wallet provider not available');
  const receipt = await walletProvider.waitForTransaction(txHash);
  if (!receipt) throw new Error('Transaction not found on-chain yet. Please retry in a moment.');
  if (receipt.status !== 1) throw new Error('Transaction reverted: ' + txHash);
  return receipt;
}

function markTrackerFromDraft(
  tracker: { setStep: (idx: number, status?: 'active' | 'done' | 'error') => void },
  draft: LaunchDraft | null,
): number {
  if (!draft) return 0;
  if (hasReachedStage(draft, 'liquidity_added')) {
    tracker.setStep(4);
    return 4;
  }
  if (hasReachedStage(draft, 'approved')) {
    tracker.setStep(3);
    return 3;
  }
  if (hasReachedStage(draft, 'deployed')) {
    tracker.setStep(2);
    return 2;
  }
  if (hasReachedStage(draft, 'prepared')) {
    tracker.setStep(1);
    return 1;
  }
  tracker.setStep(0);
  return 0;
}

async function deploy(data: LaunchPayload, options: { resume?: boolean } = {}): Promise<void> {
  const launchBtn = document.getElementById('btn_launch') as HTMLButtonElement;
  const errorEl = document.getElementById('launch-error')!;
  const successEl = document.getElementById('launch-success')!;

  launchBtn.disabled = true;
  setVisible(errorEl, false);
  setVisible(successEl, false);

  const deploySection = document.getElementById('deploy-section')!;
  const deploySteps = getDeploySteps(data);
  const tracker = buildProgressTracker(deploySteps);
  const existingTracker = deploySection.querySelector('.deploy-progress');
  if (existingTracker) existingTracker.remove();
  deploySection.insertBefore(tracker.container, launchBtn);
  launchBtn.style.display = 'none';

  let draft = options.resume ? loadLaunchDraft() : null;
  if (!draft || draft.data.agent_name !== data.agent_name || draft.data.token_symbol !== data.token_symbol) {
    draft = upsertLaunchDraft(data, {
      stage: 'draft',
      lastError: undefined,
      prepared: undefined,
      agenterId: undefined,
      agentWallet: undefined,
      tokenAddress: undefined,
      deployTxHash: undefined,
      approveTxHash: undefined,
      liquidityTxHash: undefined,
      deployerAddress: undefined,
    });
  } else {
    draft = upsertLaunchDraft(data, { stage: draft.stage, lastError: undefined });
  }

  try {
    if (!connectedAddress || !walletProvider) {
      connectedAddress = await showWalletPicker();
      walletProvider = new ethers.BrowserProvider(getSelectedProvider());
    }

    let stepIdx = markTrackerFromDraft(tracker, options.resume ? draft : null);

    let prepared = draft.prepared;
    if (!prepared) {
      tracker.setStep(stepIdx++);
      prepared = await api<PrepareResponse>('POST', '/api/launch/prepare', data);
      draft = upsertLaunchDraft(data, {
        stage: 'prepared',
        prepared,
        agenterId: prepared.agenter_id,
        agentWallet: prepared.agent_wallet,
        deployerAddress: connectedAddress || undefined,
      });
      renderResumeDraftBanner();
    }

    if (!draft.agenterId) {
      draft = upsertLaunchDraft(data, {
        stage: draft.stage,
        prepared,
        agenterId: prepared.agenter_id,
        agentWallet: prepared.agent_wallet,
        deployerAddress: connectedAddress || undefined,
      });
    }

    let tokenAddress = draft.tokenAddress;
    let txHash = draft.deployTxHash;

    if (hasReachedStage(draft, 'deploy_submitted') && !hasReachedStage(draft, 'deployed') && draft.deployTxHash) {
      tracker.setStep(Math.max(stepIdx, 1));
      const receipt = await waitForReceipt(draft.deployTxHash);
      tokenAddress = receipt.contractAddress || tokenAddress;
      txHash = draft.deployTxHash;
      draft = upsertLaunchDraft(data, { stage: 'deployed', prepared, tokenAddress, deployTxHash: txHash });
    }

    if (!hasReachedStage(draft, 'deployed')) {
      tracker.setStep(stepIdx++);
      const signer = await walletProvider!.getSigner();
      const deployTxResponse = await signer.sendTransaction({
        data: prepared.deploy_data,
        value: BigInt(prepared.deploy_bnb),
      });
      txHash = deployTxResponse.hash;
      draft = upsertLaunchDraft(data, {
        stage: 'deploy_submitted',
        prepared,
        deployTxHash: txHash,
        agenterId: prepared.agenter_id,
        agentWallet: prepared.agent_wallet,
        deployerAddress: connectedAddress || undefined,
      });
      await recordLaunchEvent({
        agenter_id: prepared.agenter_id,
        tx_hash: txHash,
        method: 'deployGooAgentToken',
        memo: 'Submitted GooAgentToken deployment (payable: treasury BNB + burn + treasury tokens)',
        status: 'submitted',
      });
      const deployReceipt = await deployTxResponse.wait();
      tokenAddress = deployReceipt!.contractAddress!;
      await recordLaunchEvent({
        agenter_id: prepared.agenter_id,
        tx_hash: txHash,
        method: 'deployGooAgentToken',
        memo: 'Deployed GooAgentToken at ' + tokenAddress,
        status: 'confirmed',
      });
      draft = upsertLaunchDraft(data, { stage: 'deployed', prepared, tokenAddress, deployTxHash: txHash });
      renderResumeDraftBanner();
    }

    if (!tokenAddress || !txHash) {
      throw new Error('Launch state incomplete: missing token address or deploy tx hash');
    }

    const signer = await walletProvider!.getSigner();
    const lpc = prepared.lp_config;
    const lpTokenAmount = BigInt(lpc.lp_token_amount);

    if (hasReachedStage(draft, 'approve_submitted') && !hasReachedStage(draft, 'approved') && draft.approveTxHash) {
      tracker.setStep(Math.max(stepIdx, 2));
      await waitForReceipt(draft.approveTxHash);
      await recordLaunchEvent({
        agenter_id: prepared.agenter_id,
        tx_hash: draft.approveTxHash,
        method: 'launchApproveRouter',
        memo: 'Approved tokens for PancakeSwap router',
        status: 'confirmed',
      });
      draft = upsertLaunchDraft(data, { stage: 'approved', prepared });
    }

    if (!hasReachedStage(draft, 'approved')) {
      tracker.setStep(stepIdx++);
      const tokenForApprove = new ethers.Contract(tokenAddress, [
        'function approve(address spender, uint256 amount) returns (bool)',
      ], signer);
      const approveRouterTx = await tokenForApprove.approve(lpc.router_address, lpTokenAmount);
      draft = upsertLaunchDraft(data, { stage: 'approve_submitted', prepared, approveTxHash: approveRouterTx.hash });
      await recordLaunchEvent({
        agenter_id: prepared.agenter_id,
        tx_hash: approveRouterTx.hash,
        method: 'launchApproveRouter',
        memo: 'Submitted token approval for PancakeSwap router',
        status: 'submitted',
      });
      await approveRouterTx.wait();
      await recordLaunchEvent({
        agenter_id: prepared.agenter_id,
        tx_hash: approveRouterTx.hash,
        method: 'launchApproveRouter',
        memo: 'Approved tokens for PancakeSwap router',
        status: 'confirmed',
      });
      draft = upsertLaunchDraft(data, { stage: 'approved', prepared, approveTxHash: approveRouterTx.hash });
      renderResumeDraftBanner();
    }

    if (hasReachedStage(draft, 'liquidity_submitted') && !hasReachedStage(draft, 'liquidity_added') && draft.liquidityTxHash) {
      tracker.setStep(Math.max(stepIdx, 3));
      await waitForReceipt(draft.liquidityTxHash);
      await recordLaunchEvent({
        agenter_id: prepared.agenter_id,
        tx_hash: draft.liquidityTxHash,
        method: 'launchAddLiquidity',
        memo: 'Added liquidity to PancakeSwap',
        status: 'confirmed',
      });
      draft = upsertLaunchDraft(data, { stage: 'liquidity_added', prepared });
    }

    if (!hasReachedStage(draft, 'liquidity_added')) {
      tracker.setStep(stepIdx++);
      const routerContract = new ethers.Contract(lpc.router_address, [
        'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
      ], signer);
      const lpBnbWei = BigInt(lpc.lp_bnb_amount);
      const amountTokenMin = lpTokenAmount * 94n / 100n;
      const amountETHMin = lpBnbWei * 95n / 100n;
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const addLiqTx = await routerContract.addLiquidityETH(
        tokenAddress,
        lpTokenAmount,
        amountTokenMin,
        amountETHMin,
        connectedAddress,
        deadline,
        { value: lpBnbWei },
      );
      draft = upsertLaunchDraft(data, { stage: 'liquidity_submitted', prepared, liquidityTxHash: addLiqTx.hash });
      await recordLaunchEvent({
        agenter_id: prepared.agenter_id,
        tx_hash: addLiqTx.hash,
        method: 'launchAddLiquidity',
        memo: 'Submitted addLiquidityETH to PancakeSwap',
        status: 'submitted',
      });
      await addLiqTx.wait();
      await recordLaunchEvent({
        agenter_id: prepared.agenter_id,
        tx_hash: addLiqTx.hash,
        method: 'launchAddLiquidity',
        memo: 'Added liquidity to PancakeSwap',
        status: 'confirmed',
      });
      draft = upsertLaunchDraft(data, { stage: 'liquidity_added', prepared, liquidityTxHash: addLiqTx.hash });
      renderResumeDraftBanner();
    }

    tracker.setStep(stepIdx++);
    const result = await api<ConfirmResponse>('POST', '/api/launch/confirm', {
      agenter_id: prepared.agenter_id,
      token_address: tokenAddress,
      tx_hash: txHash,
      deployer_address: draft.deployerAddress || connectedAddress,
    });

    upsertLaunchDraft(data, { stage: 'confirmed', prepared, tokenAddress, deployTxHash: txHash });
    tracker.setStep(tracker.totalSteps);
    clearLaunchDraft();
    renderResumeDraftBanner();

    setVisible(document.getElementById('deploy-section')!, false);
    setVisible(document.getElementById('btn_back_2')!.parentElement!, false);

    clearChildren(successEl);
    const isActive = result.status === 'active';
    const headerText = isActive ? 'Agent Launched & Running' : 'Agent Deployed';
    const header = el('div', { style: 'font-weight:600;color:#00C7D2;margin-bottom:12px;font-size:15px' }, headerText);

    const agentRow = el('div', { className: 'success-row' },
      el('span', { className: 'success-label' }, 'Agent ID'),
      el('span', { className: 'success-value' }, result.agent_id),
    );

    const addrValue = el('span', { className: 'success-value' });
    const addrLink = el('a', {
      href: BSCSCAN_BASE() + '/address/' + result.token_address,
      target: '_blank',
      rel: 'noopener',
    }, shortAddr(result.token_address));
    addrValue.appendChild(addrLink);
    const addrRow = el('div', { className: 'success-row' },
      el('span', { className: 'success-label' }, 'Token Address'),
      addrValue,
    );

    const walletRow = el('div', { className: 'success-row' },
      el('span', { className: 'success-label' }, 'Agent Wallet'),
      el('span', { className: 'success-value' }, shortAddr(result.agent_wallet)),
    );

    const txValue = el('span', { className: 'success-value' });
    const txLink = el('a', {
      href: BSCSCAN_BASE() + '/tx/' + result.tx_hash,
      target: '_blank',
      rel: 'noopener',
    }, shortAddr(result.tx_hash));
    txValue.appendChild(txLink);
    const txRow = el('div', { className: 'success-row' },
      el('span', { className: 'success-label' }, 'TX Hash'),
      txValue,
    );

    const statusRow = el('div', { className: 'success-row' },
      el('span', { className: 'success-label' }, 'Status'),
      el('span', { style: 'font-weight:600;font-size:13px;color:#ca8a04' }, 'Deployed'),
    );

    const providerRow = el('div', { className: 'success-row' },
      el('span', { className: 'success-label' }, 'Providers'),
      el('span', { className: 'success-value' }, data.sandbox_provider === 'agos' ? 'AGOS (Managed)' : 'BYOD (Self-Host)'),
    );

    const nextStepLabel = data.sandbox_provider === 'agos'
      ? 'Create AGOS Deployment'
      : 'Configure BYOD';
    const nextStepHint = el('div', { style: 'margin-top:12px;padding:10px 14px;background:#f0f9ff;border-radius:10px;font-size:13px;color:#0369a1' },
      'Next: go to the agent detail page to ' + nextStepLabel + '.',
    );

    let byodSection: HTMLElement | null = null;
    if (data.sandbox_provider === 'byod' && result.agent_wallet_private_key) {
      byodSection = document.createElement('div');
      const keyBox = document.createElement('div');
      keyBox.className = 'byod-key-box';
      keyBox.innerHTML = `
        <div class="key-label">Agent Wallet Private Key</div>
        <div class="key-value">${result.agent_wallet_private_key}</div>
        <div class="key-warning">
          Save this key now — it will NOT be shown again. Anyone with this key controls the agent wallet.
        </div>
      `;
      byodSection.appendChild(keyBox);

      const apiBaseUrl = import.meta.env.VITE_API_URL || window.location.origin;
      const envContent = [
        '# Goo Agent BYOD — auto-generated',
        '',
        '# LLM (replace with your API key)',
        '# AGOS gateway: https://claw-api.agos.fun/v1',
        '# OpenRouter:   https://openrouter.ai/api/v1',
        'LLM_API_URL=https://claw-api.agos.fun/v1',
        'LLM_API_KEY=replace-me',
        '',
        '# OpenClaw',
        `OPENCLAW_GATEWAY_TOKEN=${crypto.randomUUID().replace(/-/g, '')}`,
        'OPENCLAW_MODEL=claude-sonnet-4-6',
        '',
        '# Goo Server API (agent config fetched on boot)',
        `GOO_SERVER_URL=${apiBaseUrl}`,
        `AGENT_ID=${result.agent_id}`,
        `AGENT_RUNTIME_TOKEN=${result.runtime_token || ''}`,
        'CONTROL_PORT=19790',
        '',
        '# Blockchain',
        `RPC_URL=${runtimeConfig.network === 'mainnet' ? 'https://bsc-rpc.publicnode.com' : 'https://bsc-testnet-rpc.publicnode.com'}`,
        `CHAIN_ID=${runtimeConfig.chain_id}`,
        `TOKEN_ADDRESS=${result.token_address}`,
        `WALLET_PRIVATE_KEY=${result.agent_wallet_private_key}`,
        '',
        '# LLM',
        'LLM_MODEL=deepseek-chat',
        '',
        '# goo-core',
        'HEARTBEAT_INTERVAL_MS=30000',
        'MAX_TOOL_ROUNDS=5',
      ].join('\n');

      const downloadBtn = el('button', {
        className: 'btn-trigger',
        style: 'background:#1d4ed8;margin-top:12px;margin-bottom:12px',
      }, 'Download .env for BYOD Docker') as HTMLButtonElement;
      downloadBtn.addEventListener('click', () => {
        const blob = new Blob([envContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '.env';
        a.click();
        URL.revokeObjectURL(url);
      });
      byodSection.appendChild(downloadBtn);

      const setupBox = document.createElement('div');
      setupBox.className = 'byod-setup-box';
      setupBox.innerHTML = `
        <div class="setup-title">BYOD Docker Setup</div>
        <pre># 1. Download .env (click the button above)

# 2. Run setup (in the same directory as .env)
curl -fsSL https://raw.githubusercontent.com/hyang74/goo-example/main/deploy/docker/byod-setup.sh | bash

# View goo-core logs
docker exec goo-agent tail -f /var/log/sandbox/goo-core.log

# Stop
cd goo-agent && docker compose down</pre>
      `;
      byodSection.appendChild(setupBox);
    }

    const actions = el('div', { style: 'display:flex;gap:12px;align-items:center;margin-top:20px' });
    const viewAgentBtn = el('a', {
      href: '/agent.html?id=' + encodeURIComponent(result.agent_id),
      style: 'display:inline-flex;align-items:center;gap:8px;padding:10px 24px;background:#00C7D2;color:#fff;border-radius:10px;font-family:inherit;font-size:14px;font-weight:600;text-decoration:none;transition:background .2s',
    }, 'View Goo');
    const homeLink = el('a', {
      href: '/',
      style: 'color:#00C7D2;text-decoration:none;font-size:14px',
    }, 'All Goo');
    actions.appendChild(viewAgentBtn);
    actions.appendChild(homeLink);

    successEl.appendChild(header);
    successEl.appendChild(agentRow);
    successEl.appendChild(statusRow);
    successEl.appendChild(providerRow);
    successEl.appendChild(addrRow);
    successEl.appendChild(walletRow);
    successEl.appendChild(txRow);
    if (byodSection) successEl.appendChild(byodSection);
    successEl.appendChild(nextStepHint);
    successEl.appendChild(actions);
    setVisible(successEl, true);
  } catch (err: any) {
    const activeStep = tracker.container.querySelector('.dp-step.active');
    if (activeStep) {
      activeStep.classList.remove('active');
      activeStep.classList.add('error');
    }

    upsertLaunchDraft(data, { stage: draft.stage, lastError: err?.message ?? String(err) });
    renderResumeDraftBanner();
    launchBtn.disabled = false;
    launchBtn.style.display = '';
    launchBtn.textContent = hasReachedStage(loadLaunchDraft(), 'prepared') ? 'Resume Launch' : 'Retry Launch';
    if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
      errorEl.textContent = 'Transaction rejected. Please try again.';
    } else {
      errorEl.textContent = err.message ?? String(err);
    }
    setVisible(errorEl, true);
  }
}


// --- Test data templates ---


// --- Init ---

// Wallet gate button — opens wallet picker modal
document.getElementById('btn-wallet-gate')?.addEventListener('click', async () => {
  const errorEl = document.getElementById('wallet-gate-error')!;
  setVisible(errorEl, false);

  try {
    connectedAddress = await showWalletPicker();
    walletProvider = new ethers.BrowserProvider(getSelectedProvider());
    showLaunchContent();
  } catch (err: any) {
    if (err.message !== 'Cancelled') {
      errorEl.textContent = err.message ?? String(err);
      setVisible(errorEl, true);
    }
  }
});

// Listen for nav wallet changes (user connected via nav button)
onWalletChange((addr) => {
  if (addr) {
    connectedAddress = addr;
    const provider = getSelectedProvider();
    if (provider) walletProvider = new ethers.BrowserProvider(provider);
    showLaunchContent();
  } else {
    connectedAddress = null;
    walletProvider = null;
  }
});

// Check if already connected on page load
(async () => {
  try {
    const cfg = await getAppConfig();
    runtimeConfig = {
      network: cfg.network,
      chain_id: cfg.chain_id,
      agos_enabled: cfg.agos_enabled,
      agos_chain_id: cfg.agos_chain_id,
      min_contribution_bnb: cfg.min_contribution_bnb,
      treasury_bnb_bps: cfg.treasury_bnb_bps,
    };
    const hint = document.getElementById('contribution_bnb_hint');
    const bnbInput = document.getElementById('contribution_bnb') as HTMLInputElement | null;
    if (hint) hint.textContent = `(min ${runtimeConfig.min_contribution_bnb})`;
    if (bnbInput) {
      bnbInput.min = String(runtimeConfig.min_contribution_bnb);
      bnbInput.step = String(runtimeConfig.min_contribution_bnb);
      bnbInput.value = String(runtimeConfig.min_contribution_bnb);
    }
    if (runtimeConfig.network === 'mainnet' && runtimeConfig.agos_enabled) {
      const agos = document.querySelector('input[name="sandbox_provider"][value="agos"]') as HTMLInputElement | null;
      if (agos) agos.checked = true;
    } else {
      const byod = document.querySelector('input[name="sandbox_provider"][value="byod"]') as HTMLInputElement | null;
      if (byod) byod.checked = true;
    }
    syncProviderAvailability();

    const networkName = getNetworkName();
    const gateDesc = document.getElementById('wallet-gate-desc');
    if (gateDesc) gateDesc.textContent = `Connect your MetaMask wallet to deploy an autonomous Goo Agent on ${networkName}.`;
    const headerDesc = document.getElementById('launch-header-desc');
    if (headerDesc) headerDesc.textContent = `Deploy an autonomous Goo Agent on ${networkName}.`;

    const result = await getConnectedAccount();
    if (result) {
      connectedAddress = result.address;
      walletProvider = new ethers.BrowserProvider(result.provider);
      showLaunchContent();
    }
  } catch {}
})();

document.querySelectorAll('input[name="sandbox_provider"]').forEach(radio => {
  radio.addEventListener('change', () => syncProviderAvailability());
});

// Token economics preview
function updateTokenPreview(): void {
  const preview = document.getElementById('lp-preview');
  if (!preview) return;

  const circPct = parseInt((document.getElementById('circulation_pct') as HTMLInputElement).value) || 10;
  const bnb = parseFloat((document.getElementById('contribution_bnb') as HTMLInputElement).value) || runtimeConfig.min_contribution_bnb;

  // Update slider label
  const circLabel = document.getElementById('circulation_pct_val');
  if (circLabel) circLabel.textContent = `(${circPct}%)`;

  const totalSupply = 1_000_000_000;
  const treasuryTokens = totalSupply * 5 / 100;                    // always 5%
  const lpTokens = totalSupply * (circPct - 5) / 100;
  const burnTokens = totalSupply * (100 - circPct) / 100;
  const treasuryBnbPct = runtimeConfig.treasury_bnb_bps / 100;
  const treasuryBnb = bnb * runtimeConfig.treasury_bnb_bps / 10000;
  const lpBnb = bnb - treasuryBnb;
  const lpBnbPct = 100 - treasuryBnbPct;

  preview.innerHTML = `
    <div style="font-weight:600;color:#000;margin-bottom:6px">Distribution Preview</div>
    <div><span style="color:#000">Treasury (Agent):</span> ${treasuryTokens.toLocaleString()} tokens (5%) + ${treasuryBnb.toFixed(4)} BNB (${treasuryBnbPct}%)</div>
    <div><span style="color:#000">LP (PancakeSwap):</span> ${lpTokens.toLocaleString()} tokens (${circPct - 5}%) + ${lpBnb.toFixed(4)} BNB (${lpBnbPct}%)</div>
    <div><span style="color:#000">Burned at deploy:</span> ${burnTokens.toLocaleString()} tokens (${100 - circPct}%)</div>
    <div style="margin-top:6px;font-size:12px;color:#B2B2B2">Total BNB needed: ${bnb.toFixed(4)} + gas</div>
  `;
}

// Bind slider/input events for live preview
for (const id of ['circulation_pct', 'contribution_bnb']) {
  document.getElementById(id)?.addEventListener('input', updateTokenPreview);
}
// Initial preview render
updateTokenPreview();
loadServerWorkflowState().then(async (state) => {
  if (!state) {
    // No ?agent= param — check if user has a pending launch on server
    try {
      const resp = await api<{ pending: { agenterId: string } | null }>('GET', '/api/launch/pending');
      if (resp.pending) {
        const qs = new URLSearchParams(window.location.search);
        qs.set('agent', resp.pending.agenterId);
        window.location.search = qs.toString();
        return;
      }
    } catch { /* no auth or network error — ignore */ }
  }
  const preferredDraft = getPreferredResumeDraft(state);
  if (preferredDraft?.data) {
    saveLaunchDraft(preferredDraft);
    fillFormFromDraft(preferredDraft.data);
  }
  renderResumeDraftBanner(state);
});

// Reset
document.getElementById('btn_reset')?.addEventListener('click', () => {
  const form = document.getElementById('genome-form') as HTMLFormElement;
  if (form) form.reset();
  clearErrors('step1');
  clearLaunchDraft();
  renderResumeDraftBanner();
});

// File upload handlers — populate textarea from uploaded .md/.txt file
function bindFileUpload(fileInputId: string, textareaId: string): void {
  document.getElementById(fileInputId)?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const textarea = document.getElementById(textareaId) as HTMLTextAreaElement;
      if (textarea && typeof reader.result === 'string') {
        textarea.value = reader.result;
      }
    };
    reader.readAsText(file);
  });
}
bindFileUpload('file_soul', 'genesis_prompt');
bindFileUpload('file_agent', 'agent_instructions');
bindFileUpload('file_skills', 'skills_content');
bindFileUpload('file_memory', 'memory_content');

// Buyback toggle
document.getElementById('buyback_enabled')?.addEventListener('change', (e) => {
  const fields = document.getElementById('buyback-fields');
  if (fields) fields.style.display = (e.target as HTMLInputElement).checked ? '' : 'none';
});

// Step 1 -> 2
document.getElementById('btn_next_1')?.addEventListener('click', () => {
  if (!validateStep1()) return;
  const data = collectFormData();
  upsertLaunchDraft(data, { stage: loadLaunchDraft()?.stage || 'draft' });
  renderSummary(data);
  showStep(2);
  renderResumeDraftBanner();
});

// Back button
document.getElementById('btn_back_2')?.addEventListener('click', () => showStep(1));

// Launch
document.getElementById('btn_launch')?.addEventListener('click', () => {
  const data = collectFormData();
  const existingDraft = loadLaunchDraft();
  const shouldResume = !!existingDraft && hasReachedStage(existingDraft, 'prepared');
  deploy(data, { resume: shouldResume });
});
